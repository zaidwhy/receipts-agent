// One chat turn: ask the model, run web_search if it asks (at most 4 rounds),
// stream the answer, then turn the receipts block into stored claims.
import { createReceiptsFilter, parseReceipts, storeClaims, type SnapshotRef, type StoreClaimsResult } from "./claims.ts";
import { describeToday, type Clock } from "./clock.ts";
import { insertTurn, recentTurns, type Database } from "./db.ts";
import type { ChatMessage, LlmClient, ToolCall } from "./llm.ts";
import { createLogger } from "./log.ts";
import type { ReaderPort } from "./reader.ts";
import { saveSnapshot } from "./receipts.ts";
import type { SearchPort } from "./search.ts";
import { runWebSearch, WEB_SEARCH_TOOL, type Source } from "./tools.ts";

const log = createLogger("conversation");

export const MAX_TOOL_ROUNDS = 4;
const HISTORY_TURNS = 12;

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

export function buildSystemPrompt(today: string): string {
  return [
    `You are a research assistant with one tool, web_search. Today is ${today}.`,
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
  ].join("\n");
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
  insertTurn(db, "user", input.message, clock.now().toISOString(), input.timezone);

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(describeToday(clock.now(), input.timezone)) },
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

  let rawAnswer = "";
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    // The last round offers no tool, which forces the model to answer with what it has.
    const toolsAllowed = round < MAX_TOOL_ROUNDS;
    const filter = createReceiptsFilter();
    let text = "";
    const calls: ToolCall[] = [];

    for await (const event of deps.llm.streamChat({ messages, tools: toolsAllowed ? [WEB_SEARCH_TOOL] : undefined })) {
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
      const result =
        call.name === "web_search" ? await runWebSearch(toolContext, call.arguments) : `Unknown tool "${call.name}".`;
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
