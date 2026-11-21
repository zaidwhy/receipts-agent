// The HTTP layer: static page, /health, and POST /chat which streams Server-Sent Events.
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { resolveTimezone } from "./clock.ts";
import { missingKeys, type Config } from "./config.ts";
import { runTurn, type ConversationDeps } from "./conversation.ts";
import { turnsForDisplay } from "./db.ts";
import { createLogger } from "./log.ts";
import { seedDemoHistory, type SeedFixture } from "./seed.ts";

const log = createLogger("app");

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_MESSAGE_CHARS = 4000;

export interface AppDeps {
  config: Config;
  conversation: ConversationDeps;
  publicDir: string;
  loadSeed?: () => SeedFixture; // the recorded captures behind "Load demo history"; absent means the button reports so
}

export function createApp(deps: AppDeps): Server {
  return createServer((request, response) => {
    handle(deps, request, response).catch((error: unknown) => {
      log.error("request failed", { message: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) sendJson(response, 500, { error: "internal error" });
      else response.end();
    });
  });
}

async function handle(deps: AppDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = (request.url ?? "/").split("?")[0];

  if (request.method === "GET" && path === "/") {
    const page = await readFile(join(deps.publicDir, "index.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }

  if (request.method === "GET" && path === "/health") {
    const missing = missingKeys(deps.config);
    // ok means "ready to answer", so it is false while a key is missing.
    sendJson(response, 200, { ok: missing.length === 0, node: process.version, mode: deps.config.webMode, missing_keys: missing });
    return;
  }

  // Everything stored, in the order it happened, so a reload shows the memory and marks demo turns.
  if (request.method === "GET" && path === "/history") {
    sendJson(response, 200, { turns: historyPayload(deps) });
    return;
  }

  if (request.method === "POST" && path === "/seed") {
    await handleSeed(deps, request, response);
    return;
  }

  if (request.method === "POST" && path === "/chat") {
    await handleChat(deps, request, response);
    return;
  }

  sendJson(response, 404, { error: "not found" });
}

function historyPayload(deps: AppDeps) {
  return turnsForDisplay(deps.conversation.db, 200).map((turn) => ({ role: turn.role, text: turn.text, asked_at: turn.askedAt, demo: turn.demo }));
}

async function handleSeed(deps: AppDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!deps.loadSeed) {
    sendJson(response, 501, { error: "this server has no demo history to load" });
    return;
  }
  const body = await readBody(request, MAX_BODY_BYTES);
  let timezone: unknown;
  try {
    timezone = (JSON.parse(body ?? "{}") as { timezone?: unknown }).timezone;
  } catch {
    timezone = undefined; // an empty or odd body just means "use UTC"
  }
  const report = seedDemoHistory(deps.conversation.db, {
    fixture: deps.loadSeed(),
    now: deps.conversation.clock.now(),
    timeZone: resolveTimezone(timezone),
  });
  sendJson(response, 200, { report, turns: historyPayload(deps) });
}

async function handleChat(deps: AppDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const startedAt = performance.now();
  const missing = missingKeys(deps.config);
  if (missing.length > 0) {
    sendJson(response, 503, { error: `Missing environment variable(s): ${missing.join(", ")}. Copy .env.example to .env and fill them in.` });
    return;
  }

  const body = await readBody(request, MAX_BODY_BYTES);
  if (body === null) {
    response.setHeader("Connection", "close");
    sendJson(response, 413, { error: `request body is too large: the limit is ${MAX_BODY_BYTES} bytes` });
    return;
  }

  let payload: { message?: unknown; timezone?: unknown };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    sendJson(response, 400, { error: "request body must be JSON like {\"message\": \"...\"}" });
    return;
  }
  if (typeof payload.message !== "string" || payload.message.trim() === "") {
    sendJson(response, 400, { error: "message is required and must be a non-empty string" });
    return;
  }
  if (payload.message.length > MAX_MESSAGE_CHARS) {
    sendJson(response, 400, {
      error: `message is too long: the limit is ${MAX_MESSAGE_CHARS} characters, you sent ${payload.message.length}`,
    });
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  response.socket?.setNoDelay(true);
  const send = (event: string, data: unknown) => {
    if (!response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await runTurn(
      deps.conversation,
      { message: payload.message, timezone: resolveTimezone(payload.timezone), startedAt },
      (event) => {
        if (event.type === "status") send("status", { text: event.text });
        else if (event.type === "token") send("token", { text: event.text });
        else if (event.type === "sources") send("sources", { sources: event.sources });
        else send(event.type, event.data); // recheck_row, event_row, coverage
      },
    );
    send("done", { timings: result.timings });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("turn failed", { message });
    send("error", { message });
  }
  response.end();
}

// Returns null as soon as the body passes the limit. The rest is thrown away.
function readBody(request: IncomingMessage, limitBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (tooLarge) return;
      if (size > limitBytes) {
        tooLarge = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}
