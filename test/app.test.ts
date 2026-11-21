import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import type { LlmEvent } from "../src/llm.ts";
import { memoryDb, offlineDeps, parseSse, replayConfig, ScriptedLlm, startApp } from "./helpers.ts";

const neverCalled = new ScriptedLlm([
  () => {
    throw new Error("the model must not be called");
  },
]);

test("/health with no environment lists the missing keys", async () => {
  const config = loadConfig({});
  const app = await startApp(config, offlineDeps(neverCalled, memoryDb()));
  try {
    const health = await (await fetch(`${app.url}/health`)).json();
    assert.equal(health.ok, false);
    assert.equal(health.mode, "live");
    assert.equal(health.node, process.version);
    assert.deepEqual(health.missing_keys, ["TAVILY_API_KEY", "LLM_API_KEY"]);
  } finally {
    await app.close();
  }
});

test("/health in replay mode with an LLM key has nothing missing", async () => {
  const app = await startApp(replayConfig(), offlineDeps(neverCalled, memoryDb()));
  try {
    const health = await (await fetch(`${app.url}/health`)).json();
    assert.deepEqual(health, { ok: true, node: process.version, mode: "replay", missing_keys: [] });
  } finally {
    await app.close();
  }
});

test("/chat without keys says which variable is missing", async () => {
  const app = await startApp(loadConfig({}), offlineDeps(neverCalled, memoryDb()));
  try {
    const response = await fetch(`${app.url}/chat`, { method: "POST", body: JSON.stringify({ message: "hi" }) });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /TAVILY_API_KEY, LLM_API_KEY/);
  } finally {
    await app.close();
  }
});

test("/chat rejects a 5000 character message and names the field and the limit", async () => {
  const app = await startApp(replayConfig(), offlineDeps(neverCalled, memoryDb()));
  try {
    const response = await fetch(`${app.url}/chat`, { method: "POST", body: JSON.stringify({ message: "x".repeat(5000) }) });
    assert.equal(response.status, 400);
    const { error } = await response.json();
    assert.match(error, /message/);
    assert.match(error, /4000/);
    assert.equal(neverCalled.requests.length, 0);
  } finally {
    await app.close();
  }
});

test("/chat rejects an empty message and a body that is not JSON", async () => {
  const app = await startApp(replayConfig(), offlineDeps(neverCalled, memoryDb()));
  try {
    const empty = await fetch(`${app.url}/chat`, { method: "POST", body: JSON.stringify({ message: "   " }) });
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /message is required/);

    const notJson = await fetch(`${app.url}/chat`, { method: "POST", body: "hello" });
    assert.equal(notJson.status, 400);
  } finally {
    await app.close();
  }
});

test("/chat rejects a body over 16 KB", async () => {
  const app = await startApp(replayConfig(), offlineDeps(neverCalled, memoryDb()));
  try {
    const body = JSON.stringify({ message: "hi", padding: "x".repeat(20 * 1024) });
    const response = await fetch(`${app.url}/chat`, { method: "POST", body });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /16384 bytes/);
  } finally {
    await app.close();
  }
});

test("GET / serves the chat page and unknown paths are 404", async () => {
  const app = await startApp(replayConfig(), offlineDeps(neverCalled, memoryDb()));
  try {
    const page = await fetch(`${app.url}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>minimi agent<\/title>/);
    assert.equal((await fetch(`${app.url}/nope`)).status, 404);
  } finally {
    await app.close();
  }
});

test("/chat streams status, token, sources and done events for a cited answer", async () => {
  const receipts = JSON.stringify([
    { text: "Launch costs $19 per month", kind: "price", entity: "AcmeDB", source: 1, quote: "Launch | $19 / month" },
  ]);
  const llm = new ScriptedLlm([
    () => [{ type: "tool_call", call: { id: "c1", name: "web_search", arguments: JSON.stringify({ queries: ["AcmeDB pricing plans"] }) } }],
    () =>
      ["Launch is $19 per month [1].\n\n```rec", "eipts\n" + receipts + "\n```"].map((text): LlmEvent => ({ type: "token", text })),
  ]);
  const db = memoryDb();
  const app = await startApp(replayConfig(), offlineDeps(llm, db));
  try {
    const response = await fetch(`${app.url}/chat`, {
      method: "POST",
      body: JSON.stringify({ message: "How much is AcmeDB?", timezone: "Europe/Berlin" }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    const events = parseSse(await response.text());
    const names = events.map((e) => e.event);
    assert.equal(names[0], "status");
    assert.equal(names.at(-1), "done");
    assert.ok(names.indexOf("status") < names.indexOf("token"));
    assert.ok(names.indexOf("token") < names.indexOf("sources"));
    assert.ok(names.indexOf("sources") < names.indexOf("done"));

    const shown = events.filter((e) => e.event === "token").map((e) => e.data.text).join("");
    assert.equal(shown, "Launch is $19 per month [1].");
    assert.ok(!JSON.stringify(events).includes("receipts"));
    assert.equal(events.find((e) => e.event === "sources")?.data.sources[0].url, "https://www.acmedb.dev/pricing");
  } finally {
    await app.close();
  }
});

test("a model failure reaches the browser as an error event", async () => {
  const llm = new ScriptedLlm([
    () => {
      throw new Error("upstream model returned HTTP 401");
    },
  ]);
  const app = await startApp(replayConfig(), offlineDeps(llm, memoryDb()));
  try {
    const response = await fetch(`${app.url}/chat`, { method: "POST", body: JSON.stringify({ message: "hi" }) });
    const events = parseSse(await response.text());
    const error = events.find((e) => e.event === "error");
    assert.match(error?.data.message, /HTTP 401/);
    assert.ok(!events.some((e) => e.event === "done"));
  } finally {
    await app.close();
  }
});
