// One chat turn: look up past conversation when the user points at it, ask the model,
// run web_search or recall if it asks (at most 4 rounds), stream the answer, then turn
// the receipts block into stored claims.
import { createReceiptsFilter, parseReceipts, storeClaims, type SnapshotRef, type StoreClaimsResult } from "./claims.ts";
import { describeToday, type Clock } from "./clock.ts";
import { insertTurn, recentTurns, type Database } from "./db.ts";
import type { ChatMessage, LlmClient, ToolCall } from "./llm.ts";
import { createLogger } from "./log.ts";
import type { ReaderPort } from "./reader.ts";
import { saveSnapshot } from "./receipts.ts";
import type { SearchPort } from "./search.ts";
import { describeRecall, recall, refersToPastConversation, RECALL_TOOL, runRecall } from "./memory.ts";
import { resolveDates, type DateReference } from "./temporal.ts";
import { runWebSearch, WEB_SEARCH_TOOL, type Source } from "./tools.ts";

const log = createLogger("conversation");

export const MAX_TOOL_ROUNDS = 4;
const HISTORY_TURNS = 12;
const MAX_FORCED_RECALLS = 3;

export interface ConversationDeps {
  llm: LlmClient;
  search: SearchPort;
  reader: ReaderPort;
  db: Database;
  clock: Clock;
}

export interface CitedSource {
  n: number;
  title: string;
  url: string;
}

export type TurnEvent =
  | { type: "status"; text: string }
  | { type: "token"; text: string }
  | { type: "sources"; sources: CitedSource[] };

export interface TurnResult {
  answer: string;
  assistantTurnId: number;
  claims: StoreClaimsResult;
}

export function buildSystemPrompt(today: string, references: DateReference[] = []): string {
  return [
    `You are a research assistant with two tools: web_search for the web and recall for the earlier conversation. Today is ${today}.`,
    "",
    "When to search:",
    "- Greetings, thanks and chit-chat: answer directly, never call a tool.",
    "- Anything that can change (prices, plan limits, versions, availability, launches) or that you are unsure of: call web_search.",
    "- Write every query so it makes sense alone. Use the conversation to replace words like \"it\", \"them\" or \"the cheaper one\" with the real names.",
    "- Use 2 to 4 queries that look at different angles. Set start_date only when the user asks what is new or recent.",
    "- For prices or plans of named products, put each vendor's official pricing page in urls (for example https://supabase.com/pricing). Prefer those pages over blogs and review sites.",
    "- Each source is an excerpt of its page. If an excerpt does not show what you need, say so rather than guess.",
    "- Do not write any text before calling a tool.",
    "",
    "How to answer:",
    "- Short answer first, then only the details that matter. Reply in the user's language.",
    "- Cite sources inline as [n], using only the numbers shown in the tool results.",
    "- If sources disagree, say so and name both. If no source states something, or a page could not be read, say that. Never invent a fact.",
    "",
    "Receipts: when your answer names products or states checkable facts (price, limit, version, date, availability, launch), end the answer with a fenced block tagged receipts holding a JSON object, and say nothing about the block:",
    "```receipts",
    '{"entities": ["Acme", "Other Co"], "claims": [{"text": "Pro plan costs $19 per month", "kind": "price", "entity": "Acme", "source": 1, "quote": "Pro $19 / month"}]}',
    "```",
    "entities lists every product or company the answer discusses, even one with no checkable claim. kind is one of price, limit, version, date, availability, launch. source is the [n] of the page. quote must be copied word for word from that page's excerpt. Give at most 6 claims, only for facts you stated in the answer. If there are no entities and no claims, leave the block out.",
    "",
    "Memory:",
    "- recall(start, end, topic) returns the questions the user asked and the answers given before, with each stored fact's source, age in days and whether it has expired. Use it when the user points at something asked or said earlier. If the message already shows a recall result, use it; call recall again only for a different range or topic.",
    "- If recall finds nothing, say plainly that there is no record for that date, give the nearest dates it returned, and ask whether to search fresh or offer to. Never invent or guess a past conversation.",
    "- When you restate a recalled fact marked expired, say how old it is and that it needs rechecking before you rely on it. Do not say you rechecked it.",
    ...dateHints(references),
  ].join("\n");
}

// Tells the model what the user's date words mean, in the user's own days, in their own words.
function dateHints(references: DateReference[]): string[] {
  if (references.length === 0) return [];
  const lines = ["", "Dates in the user's message, resolved in their time zone (keep their own words when you answer; range ends are exclusive):"];
  for (const reference of references) {
    if (reference.start === null) {
      lines.push(`- "${reference.phrase}" is ${reference.note ?? "not resolvable"}. Ask which date they mean before relying on it.`);
    } else {
      const note = reference.note ? `; ${reference.note}` : "";
      lines.push(`- "${reference.phrase}" = ${reference.label} (${reference.start} to ${reference.end}${note})`);
    }
  }
  return lines;
}

export async function runTurn(
  deps: ConversationDeps,
  input: { message: string; timezone: string },
  emit: (event: TurnEvent) => void,
): Promise<TurnResult> {
  const { db, clock } = deps;
  // First thing: the user sees activity before any model or network call starts.
  emit({ type: "status", text: "thinking" });
  const history = recentTurns(db, HISTORY_TURNS);
  const now = clock.now();
  const userTurnId = insertTurn(db, "user", input.message, now.toISOString(), input.timezone);
  const references = resolveDates(input.message, now, input.timezone);

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(describeToday(now, input.timezone), references) },
    ...history.map((turn): ChatMessage => ({ role: turn.role, content: turn.text })),
    { role: "user", content: input.message },
  ];

  const sources: Source[] = [];
  const toolContext = {
    search: deps.search,
    reader: deps.reader,
    clock,
    sources,
    status: (text: string) => emit({ type: "status", text }),
  };

  const recallOptions = { timeZone: input.timezone, beforeTurnId: userTurnId };

  // "What did I ask on Tuesday?" is answered from memory, so the lookup happens here, before the
  // model is called. It is shown to the model as a finished recall call; the model decides what to do next.
  if (refersToPastConversation(input.message)) {
    const forced = references.filter((reference) => reference.start !== null && reference.end !== null).slice(0, MAX_FORCED_RECALLS);
    const calls: ToolCall[] = [];
    const results: string[] = [];
    for (const reference of forced) {
      const where = reference.label?.startsWith("week") ? `during ${reference.label}` : `on ${reference.label}`;
      emit({ type: "status", text: `looking up what you asked ${where}` });
      const range = { start: reference.start as string, end: reference.end as string };
      calls.push({ id: `recall_${calls.length + 1}`, name: "recall", arguments: JSON.stringify({ start: range.start, end: range.end }) });
      results.push(describeRecall(recall(db, { range }, now, recallOptions), { range }, reference.label ?? undefined));
    }
    if (calls.length > 0) {
      messages.push({ role: "assistant", content: "", toolCalls: calls });
      calls.forEach((call, index) => messages.push({ role: "tool", toolCallId: call.id, content: results[index] as string }));
    }
  }

  let rawAnswer = "";
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    // The last round offers no tool, which forces the model to answer with what it has.
    const toolsAllowed = round < MAX_TOOL_ROUNDS;
    const filter = createReceiptsFilter();
    let text = "";
    const calls: ToolCall[] = [];

    for await (const event of deps.llm.streamChat({ messages, tools: toolsAllowed ? [WEB_SEARCH_TOOL, RECALL_TOOL] : undefined })) {
      if (event.type === "token") {
        text += event.text;
        const visible = filter.push(event.text);
        if (visible) emit({ type: "token", text: visible });
      } else {
        calls.push(event.call);
      }
    }
    const rest = filter.finish();
    if (rest) emit({ type: "token", text: rest });

    if (calls.length === 0 || !toolsAllowed) {
      rawAnswer = text;
      break;
    }

    log.info("tool round", { round: round + 1, tools: calls.map((call) => call.name) });
    messages.push({ role: "assistant", content: text, toolCalls: calls });
    for (const call of calls) {
      let result: string;
      if (call.name === "web_search") {
        result = await runWebSearch(toolContext, call.arguments);
      } else if (call.name === "recall") {
        emit({ type: "status", text: "looking through earlier conversation" });
        result = runRecall(db, now, recallOptions, call.arguments);
      } else {
        result = `Unknown tool "${call.name}".`;
      }
      messages.push({ role: "tool", toolCallId: call.id, content: result });
    }
  }

  const parsed = parseReceipts(rawAnswer);
  const assistantTurnId = insertTurn(db, "assistant", parsed.visibleText, clock.now().toISOString(), input.timezone);

  // Only pages the answer actually cites (inline [n] or in a claim) get a snapshot.
  const cited = new Set<number>();
  for (const match of parsed.visibleText.matchAll(/\[(\d+)\]/g)) cited.add(Number(match[1]));
  for (const claim of parsed.claims) cited.add(claim.source);

  const snapshots = new Map<number, SnapshotRef>();
  const citedSources: CitedSource[] = [];
  for (const source of sources) {
    if (!cited.has(source.n)) continue;
    const saved = saveSnapshot(
      db,
      source.url,
      source.finalUrl,
      source.text,
      source.extractor,
      source.fetchedAt,
      source.publishedAt ?? undefined,
    );
    snapshots.set(source.n, { hash: saved.hash, text: saved.text, url: source.url });
    citedSources.push({ n: source.n, title: source.title, url: source.url });
  }

  const claims = storeClaims(db, { turnId: assistantTurnId, claims: parsed.claims, entities: parsed.entities, snapshots });
  if (citedSources.length > 0) emit({ type: "sources", sources: citedSources });
  return { answer: parsed.visibleText, assistantTurnId, claims };
}
