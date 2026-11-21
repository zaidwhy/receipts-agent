// One chat turn: look up past conversation when the user points at it, recheck earlier
// answers when the user asks whether they still hold, ask the model, run web_search,
// recall or recheck if it asks (at most 4 rounds), stream the answer, then turn the
// receipts block into stored claims.
import { createReceiptsFilter, parseReceipts, storeClaims, type SnapshotRef, type StoreClaimsResult } from "./claims.ts";
import { describeToday, type Clock } from "./clock.ts";
import { insertTurn, recentTurns, type Database } from "./db.ts";
import type { ChatMessage, LlmClient, ToolCall } from "./llm.ts";
import { createLogger } from "./log.ts";
import type { ReaderPort } from "./reader.ts";
import { saveSnapshot } from "./receipts.ts";
import type { SearchPort } from "./search.ts";
import type { FeedPort } from "./discovery.ts";
import { describeRecall, recall, refersToPastConversation, RECALL_TOOL, runRecall } from "./memory.ts";
import { asksAboutChange, parseRecheckArguments, RECHECK_TOOL, runRecheck, type RecheckEvent, type RecheckOutput } from "./recheck-tool.ts";
import { resolveDates, type DateReference } from "./temporal.ts";
import { eligibleForSpeculation, startSpeculation } from "./speculative.ts";
import { runWebSearch, WEB_SEARCH_TOOL, type Source } from "./tools.ts";

const log = createLogger("conversation");

export const MAX_TOOL_ROUNDS = 4;
const HISTORY_TURNS = 12;
const MAX_FORCED_RECALLS = 3;

export interface ConversationDeps {
  llm: LlmClient;
  search: SearchPort;
  reader: ReaderPort;
  feeds: FeedPort;
  db: Database;
  clock: Clock;
  speculativeSearch?: boolean; // SPECULATIVE_SEARCH=1: search the raw message while the model plans
  compactPrompt?: boolean; // COMPACT_PROMPT=1: a shorter first prompt, web_search only, for plain fresh questions
}

export interface CitedSource {
  n: number;
  title: string;
  url: string;
}

export type TurnEvent =
  | { type: "status"; text: string }
  | { type: "token"; text: string }
  | { type: "sources"; sources: CitedSource[] }
  | RecheckEvent;

// Where the time of one turn went, in milliseconds. Measured, not tuned.
export interface TurnTimings {
  thinking_emitted_ms: number; // from the request arriving to the first "thinking" status
  recall_ms: number | null; // the recall the code ran before the model
  recheck_ms: number | null; // the recheck the code ran before the model, plus any the model asked for
  recheck_lane_a_ms: number | null; // re-reading the cited pages
  recheck_lane_b_ms: number | null; // feeds and dated search
  llm_rounds: { ttft_ms: number | null; duration_ms: number }[]; // per model call; ttft is null when the round streamed no text
  search_ms: number; // summed over web_search calls
  read_ms: number; // summed over page reads; direct reads overlap the searches
  total_ms: number;
  speculative: "off" | "skipped" | "hit" | "miss"; // skipped: the flag was on but the message was not eligible
  compact_prompt: boolean;
}

export interface TurnResult {
  answer: string;
  assistantTurnId: number;
  claims: StoreClaimsResult;
  timings: TurnTimings;
}

// Words that mean the answer may lie in the earlier conversation, so the compact prompt must not be used.
const MEMORY_WORDS = /\b(we|our|my|earlier|before|remind|previous|ago|since|changed|updates?|again)\b/i;

export function wantsCompactPrompt(message: string, references: DateReference[]): boolean {
  return eligibleForSpeculation(message, references) && !MEMORY_WORDS.test(message);
}

export function buildSystemPrompt(today: string, references: DateReference[] = [], compact = false): string {
  if (compact) return buildCompactPrompt(today);
  return [
    `You are a research assistant with three tools: web_search for the web, recall for the earlier conversation and recheck for whether earlier answers still hold. Today is ${today}.`,
    "",
    "When to search:",
    "- Greetings, thanks and chit-chat: answer directly, never call a tool.",
    "- Anything that can change (prices, plan limits, versions, availability, launches) or that you are unsure of: call web_search.",
    "- Write every query so it makes sense alone. Use the conversation to replace words like \"it\", \"them\" or \"the cheaper one\" with the real names.",
    "- Use 2 to 4 queries that look at different angles. Set start_date only when the user asks what is new or recent.",
    "- For prices or plans of named products, put each vendor's official pricing page in urls (for example https://supabase.com/pricing). Prefer those pages over blogs and review sites.",
    "- Each source is an excerpt of its page; [...] marks text that was left out. If an excerpt does not show what you need, say so rather than guess.",
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
    "entities lists every product or company the answer discusses, even one with no checkable claim. kind is one of price, limit, version, date, availability, launch. source is the [n] of the page. quote must be copied word for word from that page's excerpt, from one stretch with no [...] inside it. Give at most 6 claims, only for facts you stated in the answer. If there are no entities and no claims, leave the block out.",
    "",
    "Rechecking:",
    "- A recheck result shows the user a table (claim, then, now, status) above your answer, so do not copy it. Lead with what changed, then what is unchanged, then what could not be checked.",
    "- Say \"source unchanged\", never \"still true\": a page that reads the same says nothing about the world. Name any claim marked changed with its old and new value, and cite its source.",
    "- A claim marked context changed, reworded or cannot tell is not a clean pass: say so in a few words. A lead from search is from a different source than the page checked; say that when you mention it.",
    "- Never say nothing changed when any source was unreachable or any claim was undecided. Say what was not checked.",
    "- A recheck result has no [n] numbers. Name a page by its domain instead of inventing a number.",
    "- Events listed as unconfirmed or undated are not announcements: call them unconfirmed or possibly older.",
    "- In a turn that only reports a recheck, leave out the receipts block unless you also searched.",
    "- recheck(turn_ids, entities, since) runs a recheck yourself; turn_ids come from recall. It re-reads earlier sources and looks for what shipped since, and costs a few seconds.",
    "",
    "Memory:",
    "- recall(start, end, topic) returns the questions the user asked and the answers given before, with each stored fact's source, age in days and whether it has expired. Use it when the user points at something asked or said earlier. If the message already shows a recall result, use it; call recall again only for a different range or topic.",
    "- If recall finds nothing, say plainly that there is no record for that date, give the nearest dates it returned, and ask whether to search fresh or offer to. Never invent or guess a past conversation.",
    "- When you restate a recalled fact marked expired, say how old it is and that it needs rechecking before you rely on it. Do not say you rechecked it.",
    ...dateHints(references),
  ].join("\n");
}

// The same rules for a plain question about the web, without the memory and recheck sections: fewer
// tokens before the model's first move.
function buildCompactPrompt(today: string): string {
  return [
    `You are a research assistant with one tool, web_search. Today is ${today}.`,
    "",
    "- Greetings, thanks and chit-chat: answer directly, never call a tool.",
    "- Anything that can change (prices, plan limits, versions, availability, launches) or that you are unsure of: call web_search with 2 to 4 self-contained queries about different angles, and put each named vendor's official pricing page in urls (for example https://supabase.com/pricing). Do not write any text before calling a tool.",
    "- Each source is an excerpt of its page; [...] marks text that was left out. If an excerpt does not show what you need, say so rather than guess.",
    "- Short answer first, then only the details that matter, in the user's language. Cite sources inline as [n], using only the numbers shown in the tool results. If sources disagree, say so. Never invent a fact.",
    "",
    "Receipts: when your answer names products or states checkable facts (price, limit, version, date, availability, launch), end the answer with a fenced block tagged receipts holding a JSON object, and say nothing about the block:",
    "```receipts",
    '{"entities": ["Acme", "Other Co"], "claims": [{"text": "Pro plan costs $19 per month", "kind": "price", "entity": "Acme", "source": 1, "quote": "Pro $19 / month"}]}',
    "```",
    "entities lists every product or company the answer discusses. kind is one of price, limit, version, date, availability, launch. source is the [n] of the page. quote must be copied word for word from that page's excerpt, from one stretch with no [...] inside it. At most 6 claims, only for facts you stated. If there are none, leave the block out.",
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
  input: { message: string; timezone: string; startedAt?: number }, // startedAt: performance.now() when the request arrived
  emit: (event: TurnEvent) => void,
): Promise<TurnResult> {
  const { db, clock } = deps;
  const turnStarted = performance.now();
  const timings: TurnTimings = {
    thinking_emitted_ms: 0,
    recall_ms: null,
    recheck_ms: null,
    recheck_lane_a_ms: null,
    recheck_lane_b_ms: null,
    llm_rounds: [],
    search_ms: 0,
    read_ms: 0,
    total_ms: 0,
    speculative: "off",
    compact_prompt: false,
  };
  const elapsed = (since: number) => Math.round(performance.now() - since);
  // First thing: the user sees activity before any model or network call starts.
  emit({ type: "status", text: "thinking" });
  timings.thinking_emitted_ms = elapsed(input.startedAt ?? turnStarted);
  const history = recentTurns(db, HISTORY_TURNS);
  const now = clock.now();
  const userTurnId = insertTurn(db, "user", input.message, now.toISOString(), input.timezone);
  const references = resolveDates(input.message, now, input.timezone);

  const compact = deps.compactPrompt === true && wantsCompactPrompt(input.message, references);
  timings.compact_prompt = compact;
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(describeToday(now, input.timezone), references, compact) },
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
    timings: { searchMs: 0, readMs: 0 },
    speculation: undefined as ReturnType<typeof startSpeculation> | undefined,
    speculationOutcome: undefined as "hit" | "miss" | undefined,
  };
  // Started now, before the model is called, so its search and reads run during the model's first round.
  if (deps.speculativeSearch) {
    if (eligibleForSpeculation(input.message, references)) toolContext.speculation = startSpeculation({ search: deps.search, reader: deps.reader }, input.message);
    else timings.speculative = "skipped";
  }
  const recheckDeps = { db, reader: deps.reader, search: deps.search, llm: deps.llm, clock, feeds: deps.feeds };

  const recallOptions = { timeZone: input.timezone, beforeTurnId: userTurnId };

  // "What did I ask on Tuesday?" is answered from memory, so the lookup happens here, before the
  // model is called. It is shown to the model as a finished recall call; the model decides what to do next.
  if (refersToPastConversation(input.message)) {
    const forced = references.filter((reference) => reference.start !== null && reference.end !== null).slice(0, MAX_FORCED_RECALLS);
    const calls: ToolCall[] = [];
    const results: string[] = [];
    const recalledTurnIds: number[] = [];
    const recallStarted = performance.now();
    for (const reference of forced) {
      const where = reference.label?.startsWith("week") ? `during ${reference.label}` : `on ${reference.label}`;
      emit({ type: "status", text: `looking up what you asked ${where}` });
      const range = { start: reference.start as string, end: reference.end as string };
      calls.push({ id: `recall_${calls.length + 1}`, name: "recall", arguments: JSON.stringify({ start: range.start, end: range.end }) });
      const recalled = recall(db, { range }, now, recallOptions);
      recalledTurnIds.push(...recalled.found.map((turn) => turn.turnId));
      results.push(describeRecall(recalled, { range }, reference.label ?? undefined));
    }
    timings.recall_ms = elapsed(recallStarted);
    if (calls.length > 0) {
      messages.push({ role: "assistant", content: "", toolCalls: calls });
      calls.forEach((call, index) => messages.push({ role: "tool", toolCallId: call.id, content: results[index] as string }));
    }

    // "Has any of that changed since earlier?" is answered from fresh reads, so the recheck runs here too,
    // before the model writes. T is where the recalled range starts.
    if (recalledTurnIds.length > 0 && asksAboutChange(input.message)) {
      const since = new Date(Math.min(...forced.map((reference) => new Date(reference.start as string).getTime())));
      emit({ type: "status", text: "rechecking what you asked about" });
      const recheckStarted = performance.now();
      const output = await runRecheck(recheckDeps, { turnIds: recalledTurnIds, since }, (event) => emit(event));
      timings.recheck_ms = elapsed(recheckStarted);
      if (output) {
        recordRecheckTimings(timings, output);
        const call: ToolCall = { id: "recheck_1", name: "recheck", arguments: JSON.stringify({ turn_ids: recalledTurnIds, since: since.toISOString() }) };
        messages.push({ role: "assistant", content: "", toolCalls: [call] });
        messages.push({ role: "tool", toolCallId: call.id, content: output.text });
      }
    }
  }

  // The model's own recheck call: the same work the code runs, with its rows streamed too.
  async function runRecheckTool(rawArguments: string): Promise<string> {
    const parsed = parseRecheckArguments(rawArguments);
    if ("error" in parsed) return parsed.error;
    emit({ type: "status", text: "rechecking earlier sources" });
    const started = performance.now();
    const output = await runRecheck(recheckDeps, parsed.input, (event) => emit(event));
    timings.recheck_ms = (timings.recheck_ms ?? 0) + elapsed(started);
    if (!output) return "Nothing to recheck: no stored claims or entities match those turn_ids or entities.";
    recordRecheckTimings(timings, output);
    return output.text;
  }

  let rawAnswer = "";
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    // The last round offers no tool, which forces the model to answer with what it has.
    const toolsAllowed = round < MAX_TOOL_ROUNDS;
    const filter = createReceiptsFilter();
    let text = "";
    const calls: ToolCall[] = [];
    const roundStarted = performance.now();
    let firstTokenMs: number | null = null;

    for await (const event of deps.llm.streamChat({ messages, tools: toolsAllowed ? (compact ? [WEB_SEARCH_TOOL] : [WEB_SEARCH_TOOL, RECALL_TOOL, RECHECK_TOOL]) : undefined })) {
      if (event.type === "token") {
        firstTokenMs ??= elapsed(roundStarted);
        text += event.text;
        const visible = filter.push(event.text);
        if (visible) emit({ type: "token", text: visible });
      } else {
        calls.push(event.call);
      }
    }
    const rest = filter.finish();
    if (rest) emit({ type: "token", text: rest });
    timings.llm_rounds.push({ ttft_ms: firstTokenMs, duration_ms: elapsed(roundStarted) });

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
      } else if (call.name === "recheck") {
        result = await runRecheckTool(call.arguments);
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

  timings.search_ms = Math.round(toolContext.timings.searchMs);
  timings.read_ms = Math.round(toolContext.timings.readMs);
  if (toolContext.speculationOutcome) timings.speculative = toolContext.speculationOutcome;
  else if (timings.speculative === "off" && deps.speculativeSearch) timings.speculative = "miss"; // eligible, but the model never searched
  timings.total_ms = elapsed(input.startedAt ?? turnStarted);
  log.info("turn timings", { ...timings });
  return { answer: parsed.visibleText, assistantTurnId, claims, timings };
}

function recordRecheckTimings(timings: TurnTimings, output: RecheckOutput): void {
  timings.recheck_lane_a_ms = (timings.recheck_lane_a_ms ?? 0) + output.laneAMs;
  timings.recheck_lane_b_ms = (timings.recheck_lane_b_ms ?? 0) + output.laneBMs;
}
