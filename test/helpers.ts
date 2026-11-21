// Shared test setup. Import this first in every test file so logs stay quiet.
process.env.LOG_LEVEL = "silent";

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { createClock } from "../src/clock.ts";
import { loadConfig, type Config } from "../src/config.ts";
import type { ConversationDeps } from "../src/conversation.ts";
import { openDatabase, type Database } from "../src/db.ts";
import type { ChatMessage, LlmClient, LlmEvent, ToolDefinition } from "../src/llm.ts";
import { createReader } from "../src/reader.ts";
import { createSearch } from "../src/search.ts";

export function memoryDb(): Database {
  return openDatabase(":memory:");
}

type CountedTable = "turns" | "snapshots" | "claims" | "entities";

// Fixed statements, so no SQL is ever built from a variable.
const countStatements: Record<CountedTable, string> = {
  turns: "SELECT COUNT(*) AS n FROM turns",
  snapshots: "SELECT COUNT(*) AS n FROM snapshots",
  claims: "SELECT COUNT(*) AS n FROM claims",
  entities: "SELECT COUNT(*) AS n FROM entities",
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
    clock: createClock("2026-11-21T10:00:00Z"),
  };
}

export async function startApp(config: Config, conversation: ConversationDeps): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createApp({ config, conversation, publicDir: "public" });
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
