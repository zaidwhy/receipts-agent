// Recall: what the user asked and what was answered in earlier turns, found by
// date range, by topic, or both. Nothing here talks to the web or the model.
import { entitiesForTurn } from "./claims.ts";
import { topicSearchMode, type Database, type TopicSearchMode } from "./db.ts";
import { queryTerms } from "./excerpt.ts";
import type { ToolDefinition } from "./llm.ts";
import { labelForInstant } from "./temporal.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
export const TOPIC_RESULT_LIMIT = 5;
export const RANGE_RESULT_LIMIT = 10;

export interface RecallQuery {
  range?: { start: string; end: string }; // UTC ISO, end exclusive
  topic?: string;
}

export interface RecallOptions {
  timeZone?: string; // how dates are shown; default UTC
  beforeTurnId?: number; // only turns older than this one, so the current question never recalls itself
  topicSearch?: TopicSearchMode; // override the detected mode (used by tests)
}

export interface RecalledClaim {
  text: string;
  kind: string;
  entity: string | null;
  sourceUrl: string | null;
  fetchedAt: string | null; // when the source page was read; null when no page was read
  ageDays: number; // counted from fetchedAt, or from the answer when no page was read
  expired: boolean; // older than the shelf life of its kind
}

export interface RecalledTurn {
  turnId: number; // the question's id, which the recheck tool takes
  askedAt: string; // UTC ISO
  askedAtLocal: string; // "Tuesday 17 Nov, 14:05" in the user's zone
  question: string;
  demo: boolean; // made by the seed, not by a real conversation
  answer: string | null; // null when the turn failed and was never answered
  entities: string[];
  claims: RecalledClaim[];
}

export interface RecallResult {
  found: RecalledTurn[];
  omitted: number; // matches beyond the limit
  nearest: string[]; // dates of the closest recorded turns before and after an empty range
  topicSearch: TopicSearchMode;
}

interface TurnRow {
  id: number;
  text: string;
  asked_at: string;
  demo: number;
}

export function recall(db: Database, query: RecallQuery, now: Date, options: RecallOptions = {}): RecallResult {
  const timeZone = options.timeZone ?? "UTC";
  const mode = options.topicSearch ?? topicSearchMode(db);
  const before = options.beforeTurnId ?? Number.MAX_SAFE_INTEGER;

  let pool = db
    .prepare("SELECT id, text, asked_at, demo FROM turns WHERE role = 'user' AND id < ? ORDER BY id")
    .all(before) as unknown as TurnRow[];

  const terms = query.topic ? queryTerms(query.topic) : [];
  if (terms.length > 0) {
    const hits = topicUserIds(db, terms, mode);
    // The index finds turns with any of the words; a recalled turn must have all of them,
    // counting the question and its answer together.
    pool = pool.filter((turn) => hits.has(turn.id) && hasAllTerms(`${turn.text} ${answerOf(db, turn.id)?.text ?? ""}`, terms));
  }

  const range = query.range;
  const inRange = range ? pool.filter((turn) => turn.asked_at >= range.start && turn.asked_at < range.end) : pool;
  // A date question reads best oldest first; a topic question wants the most recent matches.
  const ordered = range ? inRange : [...inRange].reverse();
  const limit = range ? RANGE_RESULT_LIMIT : TOPIC_RESULT_LIMIT;
  const chosen = ordered.slice(0, limit);

  const nearest: string[] = [];
  if (range && inRange.length === 0) {
    const earlier = pool.filter((turn) => turn.asked_at < range.start).at(-1);
    const later = pool.find((turn) => turn.asked_at >= range.end);
    for (const turn of [earlier, later]) {
      if (turn) nearest.push(labelForInstant(new Date(turn.asked_at), timeZone, now));
    }
  }

  return {
    found: chosen.map((turn) => describeTurn(db, turn, now, timeZone)),
    omitted: Math.max(0, ordered.length - chosen.length),
    nearest,
    topicSearch: mode,
  };
}

// User-turn ids whose question or answer has any of the words. Terms are letters and digits only,
// so neither the FTS query nor the LIKE pattern can be broken by what the user typed.
function topicUserIds(db: Database, terms: string[], mode: TopicSearchMode): Set<number> {
  const rowIds: number[] = [];
  if (mode === "fts5") {
    const match = terms.map((term) => `"${term}"*`).join(" OR ");
    for (const row of db.prepare("SELECT rowid AS id FROM turns_fts WHERE turns_fts MATCH ?").all(match) as { id: number }[]) {
      rowIds.push(row.id);
    }
  } else {
    const statement = db.prepare("SELECT id FROM turns WHERE text LIKE ?");
    for (const term of terms) {
      for (const row of statement.all(`%${term}%`) as { id: number }[]) rowIds.push(row.id);
    }
  }

  const userIds = new Set<number>();
  for (const id of rowIds) {
    const row = db.prepare("SELECT role FROM turns WHERE id = ?").get(id) as { role: string } | undefined;
    if (row?.role === "user") {
      userIds.add(id);
    } else if (row) {
      // An answer matched: credit the question it answers.
      const asked = db.prepare("SELECT id FROM turns WHERE role = 'user' AND id < ? ORDER BY id DESC LIMIT 1").get(id) as { id: number } | undefined;
      if (asked) userIds.add(asked.id);
    }
  }
  return userIds;
}

function hasAllTerms(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.every((term) => lower.includes(term));
}

// The assistant turn stored right after a question, unless another question came first.
function answerOf(db: Database, userTurnId: number): { id: number; text: string; asked_at: string } | null {
  const row = db
    .prepare(
      `SELECT id, text, asked_at FROM turns
       WHERE role = 'assistant' AND id > ?1
         AND id < COALESCE((SELECT MIN(id) FROM turns WHERE role = 'user' AND id > ?1), 9007199254740991)
       ORDER BY id LIMIT 1`,
    )
    .get(userTurnId) as { id: number; text: string; asked_at: string } | undefined;
  return row ?? null;
}

function describeTurn(db: Database, turn: TurnRow, now: Date, timeZone: string): RecalledTurn {
  const answer = answerOf(db, turn.id);
  const claims = answer ? claimsOf(db, answer.id, answer.asked_at, now) : [];
  return {
    turnId: turn.id,
    askedAt: turn.asked_at,
    askedAtLocal: localTime(new Date(turn.asked_at), timeZone, now),
    question: turn.text,
    demo: turn.demo === 1,
    answer: answer?.text ?? null,
    entities: answer ? entitiesForTurn(db, answer.id) : [],
    claims,
  };
}

function claimsOf(db: Database, answerTurnId: number, answeredAt: string, now: Date): RecalledClaim[] {
  const rows = db
    .prepare(
      `SELECT claims.text AS text, claims.kind AS kind, claims.volatility AS volatility,
              entities.name AS entity, snapshots.url AS source_url, snapshots.fetched_at AS fetched_at
       FROM claims
       LEFT JOIN entities ON entities.id = claims.entity_id
       LEFT JOIN snapshots ON snapshots.hash = claims.snapshot_hash
       WHERE claims.turn_id = ? ORDER BY claims.id`,
    )
    .all(answerTurnId) as {
    text: string;
    kind: string;
    volatility: number | null;
    entity: string | null;
    source_url: string | null;
    fetched_at: string | null;
  }[];
  return rows.map((row) => {
    const age = now.getTime() - new Date(row.fetched_at ?? answeredAt).getTime();
    return {
      text: row.text,
      kind: row.kind,
      entity: row.entity,
      sourceUrl: row.source_url,
      fetchedAt: row.fetched_at,
      ageDays: Math.max(0, Math.floor(age / DAY_MS)),
      expired: row.volatility !== null && age > row.volatility * DAY_MS,
    };
  });
}

function localTime(instant: Date, timeZone: string, now: Date): string {
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
  return `${labelForInstant(instant, timeZone, now)}, ${clock}`;
}

export const RECALL_TOOL: ToolDefinition = {
  name: "recall",
  description:
    "Look up past conversation: what the user asked and what you answered, with the facts (claims) stored then, " +
    "their source, age and whether they have expired. Give a date range, a topic, or both. " +
    "Use it when the user refers to something asked or said before.",
  parameters: {
    type: "object",
    properties: {
      start: { type: "string", description: "Optional ISO date-time, start of the range (inclusive)." },
      end: { type: "string", description: "Optional ISO date-time, end of the range (exclusive)." },
      topic: { type: "string", description: "Optional words to look for in the questions and answers." },
    },
  },
};

const PAST_REFERENCE = /\b(i asked|did i ask|you said|you told|did you say|did you tell|we shortlisted|we discussed|did we discuss|we talked|did we talk|last time|earlier|my question)\b/i;

// True when the message is about the earlier conversation, not just about a date.
export function refersToPastConversation(message: string): boolean {
  return PAST_REFERENCE.test(message);
}

export function parseRecallArguments(raw: string, now: Date): { query: RecallQuery } | { error: string } {
  let args: unknown;
  try {
    args = JSON.parse(raw || "{}");
  } catch {
    return { error: "Invalid arguments: not valid JSON. Call recall again with start, end and/or topic." };
  }
  const { start, end, topic } = (args ?? {}) as { start?: unknown; end?: unknown; topic?: unknown };
  const query: RecallQuery = {};
  if (typeof topic === "string" && topic.trim() !== "") query.topic = topic.trim().slice(0, 200);

  if (start !== undefined || end !== undefined) {
    const from = start === undefined ? new Date(0) : typeof start === "string" ? new Date(start) : new Date(NaN);
    const to = end === undefined ? now : typeof end === "string" ? new Date(end) : new Date(NaN);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return { error: "Invalid arguments: start and end must be ISO date-times like 2026-11-17T00:00:00Z." };
    }
    if (from >= to) return { error: "Invalid arguments: start must be before end." };
    query.range = { start: from.toISOString(), end: to.toISOString() };
  }
  return { query };
}

// The text the model reads. An empty result says so in words, so it cannot be mistaken for a memory.
export function describeRecall(result: RecallResult, query: RecallQuery, rangeLabel?: string): string {
  const range = rangeLabel ? `for ${rangeLabel}` : query.range ? `between ${query.range.start} and ${query.range.end}` : "";
  const topic = query.topic ? `about "${query.topic}"` : "";
  const what = [range, topic].filter((part) => part !== "").map((part) => ` ${part}`).join("");
  if (result.found.length === 0) {
    const nearest =
      result.nearest.length > 0
        ? ` The nearest recorded dates are: ${result.nearest.join(" and ")}.`
        : " The conversation memory has nothing close to it.";
    return `No record of any conversation${what}.${nearest} Do not invent or guess a past conversation.`;
  }
  const count = `${result.found.length} past question${result.found.length === 1 ? "" : "s"}`;
  const more = result.omitted > 0 ? ` (${result.omitted} more not shown)` : "";
  // The marker is in the data itself, so the model cannot present seeded history as a real conversation.
  const marked = result.found.map(({ demo, ...turn }) => (demo ? { ...turn, history: "(demo history)" } : turn));
  const demoNote = result.found.some((turn) => turn.demo) ? " Entries marked (demo history) are sample data loaded for a demo: say so when you mention them." : "";
  return `Recalled ${count}${what}${more}.${demoNote}\n${JSON.stringify(marked, null, 1)}`;
}

export function runRecall(db: Database, now: Date, options: RecallOptions, rawArguments: string): string {
  const parsed = parseRecallArguments(rawArguments, now);
  if ("error" in parsed) return parsed.error;
  return describeRecall(recall(db, parsed.query, now, options), parsed.query);
}
