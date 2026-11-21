// Runs conversations against the real model with the web in replay (or record) mode, on a fixed
// clock and an in-memory database, and keeps what an observer could see: events, timings, tool calls.
import { createClock } from "../src/clock.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { runTurn, type ConversationDeps, type TurnEvent, type TurnTimings } from "../src/conversation.ts";
import { openDatabase, type Database } from "../src/db.ts";
import { createFeedPort } from "../src/discovery.ts";
import { loadEnvIfPresent } from "../src/env.ts";
import { createLlmClient, type LlmClient, type ToolCall } from "../src/llm.ts";
import { createReader, type ReaderPort } from "../src/reader.ts";
import { loadSeedFixture, seedDemoHistory } from "../src/seed.ts";
import { createSearch, type SearchPort } from "../src/search.ts";

export const EVAL_TZ = "Asia/Kolkata";
// A Saturday; the seed's "last Monday" and "last Tuesday" are 16 and 17 November from here.
export const EVAL_NOW = "2026-11-21T10:00:00Z";

export interface TurnRun {
  message: string;
  answer: string;
  events: TurnEvent[];
  firstTokenMs: number | null;
  totalMs: number;
  modelToolCalls: ToolCall[];
  searchCalls: number;
  readCalls: number;
  timings: TurnTimings | null;
  error: string | null;
}

export interface CaseRun {
  turns: TurnRun[];
  last: TurnRun;
  db: Database;
}

export interface CaseSetup {
  turns: string[]; // the last one is the one that is measured and checked
  seeded: boolean;
  now?: string; // ISO instant; default EVAL_NOW
}

export function evalConfig(): Config {
  loadEnvIfPresent();
  return loadConfig({ ...process.env, WEB_MODE: process.env.WEB_MODE ?? "replay" });
}

// The same ports the server builds, wrapped so calls can be counted.
export function buildDeps(config: Config, options: { now: string; db: Database; llm?: LlmClient }): { deps: ConversationDeps; counts: { search: number; read: number }; modelCalls: ToolCall[] } {
  const web = { mode: config.webMode, tavilyApiKey: config.tavilyApiKey, fixturesDir: config.fixturesDir };
  const counts = { search: 0, read: 0 };
  const modelCalls: ToolCall[] = [];
  const search = createSearch(web);
  const reader = createReader(web);
  const llm = options.llm ?? createLlmClient({ baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, model: config.llmModel });

  const countingSearch: SearchPort = {
    search(request) {
      counts.search += 1;
      return search.search(request);
    },
  };
  const countingReader: ReaderPort = {
    read(urls, readOptions) {
      counts.read += urls.length;
      return reader.read(urls, readOptions);
    },
  };
  const watchingLlm: LlmClient = {
    async *streamChat(request) {
      for await (const event of llm.streamChat(request)) {
        if (event.type === "tool_call") modelCalls.push(event.call);
        yield event;
      }
    },
  };
  return {
    deps: { llm: watchingLlm, search: countingSearch, reader: countingReader, feeds: createFeedPort(config.webMode, config.fixturesDir), db: options.db, clock: createClock(options.now), speculativeSearch: config.speculativeSearch, compactPrompt: config.compactPrompt },
    counts,
    modelCalls,
  };
}

export async function runConversation(config: Config, setup: CaseSetup): Promise<CaseRun> {
  const now = setup.now ?? EVAL_NOW;
  const db = openDatabase(":memory:");
  if (setup.seeded) seedDemoHistory(db, { fixture: loadSeedFixture(), now: new Date(now), timeZone: EVAL_TZ });
  const { deps, counts, modelCalls } = buildDeps(config, { now, db });

  const turns: TurnRun[] = [];
  for (const message of setup.turns) {
    const events: TurnEvent[] = [];
    const before = { search: counts.search, read: counts.read, calls: modelCalls.length };
    const started = performance.now();
    let firstTokenMs: number | null = null;
    let answer = "";
    let timings: TurnTimings | null = null;
    let error: string | null = null;
    try {
      const result = await runTurn(deps, { message, timezone: EVAL_TZ, startedAt: started }, (event) => {
        if (event.type === "token") firstTokenMs ??= Math.round(performance.now() - started);
        events.push(event);
      });
      answer = result.answer;
      timings = result.timings;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    turns.push({
      message,
      answer,
      events,
      firstTokenMs,
      totalMs: Math.round(performance.now() - started),
      modelToolCalls: modelCalls.slice(before.calls),
      searchCalls: counts.search - before.search,
      readCalls: counts.read - before.read,
      timings,
      error,
    });
  }
  return { turns, last: turns[turns.length - 1] as TurnRun, db };
}
