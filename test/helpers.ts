// Shared test setup. Import this first in every test file so logs stay quiet.
process.env.LOG_LEVEL = "silent";

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, type AppDeps } from "../src/app.ts";
import { storeClaims, type ReceiptClaim, type SnapshotRef } from "../src/claims.ts";
import { createClock } from "../src/clock.ts";
import { loadConfig, type Config } from "../src/config.ts";
import type { ConversationDeps } from "../src/conversation.ts";
import { createFeedPort } from "../src/discovery.ts";
import { insertTurn, openDatabase, type Database } from "../src/db.ts";
import type { ChatMessage, LlmClient, LlmEvent, ToolDefinition } from "../src/llm.ts";
import { createReader, type ReaderPort, type ReadOptions, type ReadOutcome } from "../src/reader.ts";
import { saveSnapshot } from "../src/receipts.ts";
import { createSearch, type SearchOutcome, type SearchPort, type SearchRequest, type SearchResult } from "../src/search.ts";

export function memoryDb(): Database {
  return openDatabase(":memory:");
}

type CountedTable = "turns" | "snapshots" | "claims" | "entities" | "rechecks" | "events";

// Fixed statements, so no SQL is ever built from a variable.
const countStatements: Record<CountedTable, string> = {
  turns: "SELECT COUNT(*) AS n FROM turns",
  snapshots: "SELECT COUNT(*) AS n FROM snapshots",
  claims: "SELECT COUNT(*) AS n FROM claims",
  entities: "SELECT COUNT(*) AS n FROM entities",
  rechecks: "SELECT COUNT(*) AS n FROM rechecks",
  events: "SELECT COUNT(*) AS n FROM events",
};

export function count(db: Database, table: CountedTable): number {
  const row = db.prepare(countStatements[table]).get() as { n: number };
  return row.n;
}

// Config that has every key, in replay mode, reading the committed fixtures.
export function replayConfig(): Config {
  return loadConfig({ WEB_MODE: "replay", LLM_API_KEY: "test-key", FIXTURES_DIR: "fixtures/web" });
}

export interface RecordedRequest {
  messages: ChatMessage[];
  tools: ToolDefinition[] | undefined;
}

// A model that plays back a script: each call to streamChat uses the next entry.
export class ScriptedLlm implements LlmClient {
  requests: RecordedRequest[] = [];
  constructor(private script: ((request: RecordedRequest) => LlmEvent[])[]) {}

  async *streamChat(request: { messages: ChatMessage[]; tools?: ToolDefinition[] }): AsyncIterable<LlmEvent> {
    const recorded = { messages: [...request.messages], tools: request.tools };
    this.requests.push(recorded);
    const step = this.script[this.requests.length - 1] ?? this.script[this.script.length - 1];
    if (!step) throw new Error("ScriptedLlm has no script");
    for (const event of step(recorded)) yield event;
  }
}

export function offlineDeps(llm: LlmClient, db: Database): ConversationDeps {
  const config = replayConfig();
  const web = { mode: config.webMode, tavilyApiKey: undefined, fixturesDir: config.fixturesDir };
  return {
    llm,
    db,
    search: createSearch(web),
    reader: createReader(web),
    feeds: createFeedPort("replay"),
    clock: createClock("2026-11-21T10:00:00Z"),
  };
}

export async function startApp(
  config: Config,
  conversation: ConversationDeps,
  loadSeed?: AppDeps["loadSeed"],
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createApp({ config, conversation, publicDir: "public", loadSeed });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function parseSse(body: string): { event: string; data: any }[] {
  return body
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "null";
      return { event, data: JSON.parse(data) };
    });
}

export interface SeedClaim {
  text: string;
  kind: ReceiptClaim["kind"];
  entity: string;
  quote: string;
  url: string;
  page: string;
  fetchedAt: string;
  extractor?: string; // how the page was read; "fetch" unless a test needs Tavily
}

// One past question and its answer, backdated, with the claims the answer would have stored.
export function seedExchange(
  db: Database,
  seed: { question: string; answer: string; askedAt: string; tz?: string; entities?: string[]; claims?: SeedClaim[] },
): { questionId: number; answerId: number } {
  const tz = seed.tz ?? "Asia/Kolkata";
  const questionId = insertTurn(db, "user", seed.question, seed.askedAt, tz);
  const answeredAt = new Date(new Date(seed.askedAt).getTime() + 5000).toISOString();
  const answerId = insertTurn(db, "assistant", seed.answer, answeredAt, tz);
  const snapshots = new Map<number, SnapshotRef>();
  const claims: ReceiptClaim[] = (seed.claims ?? []).map((claim, index) => {
    const saved = saveSnapshot(db, claim.url, claim.url, claim.page, claim.extractor ?? "fetch", claim.fetchedAt);
    snapshots.set(index + 1, { hash: saved.hash, text: saved.text, url: claim.url });
    return { text: claim.text, kind: claim.kind, entity: claim.entity, source: index + 1, quote: claim.quote };
  });
  storeClaims(db, { turnId: answerId, claims, entities: seed.entities, snapshots });
  return { questionId, answerId };
}

// A reader that answers from a function, so a test decides what each extractor returns for each URL.
// A string is the page text; { error } is a failed read; undefined is a failed read with no message.
export type PageAnswer = string | { error: string } | undefined;

export class FakeReader implements ReaderPort {
  calls: { url: string; extractor: string | undefined }[] = [];
  active = 0;
  peak = 0;
  constructor(private answer: (url: string, extractor: string | undefined) => PageAnswer) {}

  async read(urls: string[], options?: ReadOptions): Promise<ReadOutcome> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    await new Promise((resolve) => setTimeout(resolve, 5)); // lets concurrent reads overlap
    this.active -= 1;
    const outcome: ReadOutcome = { pages: [], failures: [] };
    for (const url of urls) {
      this.calls.push({ url, extractor: options?.extractor });
      const answer = this.answer(url, options?.extractor);
      if (typeof answer === "string") {
        outcome.pages.push({ url, finalUrl: url, text: answer, extractor: options?.extractor ?? "fetch", publishedAt: null });
      } else {
        outcome.failures.push({ url, reason: "failed", error: answer?.error ?? "no text" });
      }
    }
    return outcome;
  }
}

// A search port that returns the same results for every query and remembers the queries.
export class FakeSearch implements SearchPort {
  queries: SearchRequest[] = [];
  constructor(private results: SearchResult[] = []) {}
  async search(request: SearchRequest): Promise<SearchOutcome> {
    this.queries.push(request);
    return { results: this.results, timedOut: false };
  }
}
