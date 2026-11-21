import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn, MAX_TOOL_ROUNDS, type TurnEvent } from "../src/conversation.ts";
import type { LlmEvent } from "../src/llm.ts";
import { createSearch } from "../src/search.ts";
import { loadSnapshotText } from "../src/receipts.ts";
import { count, memoryDb, offlineDeps, replayConfig, ScriptedLlm, type RecordedRequest } from "./helpers.ts";

const searchCall: LlmEvent = {
  type: "tool_call",
  call: { id: "call_1", name: "web_search", arguments: JSON.stringify({ queries: ["AcmeDB pricing plans"] }) },
};

// The answer arrives in awkward chunks on purpose: the receipts marker is split across two of them.
function answerChunks(): LlmEvent[] {
  const receipts = JSON.stringify([
    { text: "Launch costs $19 per month", kind: "price", entity: "AcmeDB", source: 1, quote: "Launch | $19 / month" },
    { text: "Scale costs $60 per month", kind: "price", entity: "AcmeDB", source: 1, quote: "Scale | $60 / month" },
  ]);
  const pieces = [
    "AcmeDB Launch costs $19 per month [1]. ",
    "Reviewers say setup is quick [2].",
    "\n\n``",
    "`receipts\n",
    receipts,
    "\n```",
  ];
  return pieces.map((text) => ({ type: "token", text }));
}

test("a full turn offline: searches, reads, answers with citations, and stores claims", async () => {
  const db = memoryDb();
  const llm = new ScriptedLlm([() => [searchCall], () => answerChunks()]);
  const events: TurnEvent[] = [];

  const result = await runTurn(offlineDeps(llm, db), { message: "How much is AcmeDB?", timezone: "Asia/Kolkata" }, (event) => events.push(event));

  // What the user sees.
  const shown = events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("");
  assert.equal(shown, "AcmeDB Launch costs $19 per month [1]. Reviewers say setup is quick [2].");
  assert.equal(result.answer, shown);

  const statuses = events.filter((e) => e.type === "status").map((e) => (e as { text: string }).text);
  assert.deepEqual(statuses, ["searching 1 query", "reading acmedb.dev/pricing", "reading blog.example.org/acmedb-review"]);

  // The vendor page is [1] even though the search ranked the blog first.
  const sourcesEvent = events.find((e) => e.type === "sources");
  assert.ok(sourcesEvent && sourcesEvent.type === "sources");
  assert.deepEqual(
    sourcesEvent.sources.map((s) => [s.n, s.url]),
    [
      [1, "https://www.acmedb.dev/pricing"],
      [2, "https://blog.example.org/acmedb-review"],
    ],
  );

  // What was stored: one claim anchored in the cited page, one that is not on the page.
  assert.deepEqual(result.claims, { stored: 2, anchored: 1, unanchored: 1 });
  const claims = db.prepare("SELECT text, anchored, snapshot_hash FROM claims ORDER BY id").all() as any[];
  assert.equal(claims[0].anchored, 1);
  assert.equal(claims[1].anchored, 0);
  assert.equal(count(db, "snapshots"), 2);
  assert.match(loadSnapshotText(db, claims[0].snapshot_hash) ?? "", /Launch \| \$19 \/ month/);

  // Both turns are saved, the answer without the receipts block.
  const turns = db.prepare("SELECT role, text, tz FROM turns ORDER BY id").all() as any[];
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant"]);
  assert.equal(turns[1].text, shown);
  assert.equal(turns[0].tz, "Asia/Kolkata");
});

test("the model is told today's date and is given the page text it can quote", async () => {
  const db = memoryDb();
  const llm = new ScriptedLlm([() => [searchCall], () => answerChunks()]);
  await runTurn(offlineDeps(llm, db), { message: "How much is AcmeDB?", timezone: "UTC" }, () => {});

  const first = llm.requests[0] as RecordedRequest;
  const system = first.messages[0];
  assert.ok(system && system.role === "system");
  assert.match(system.content, /Today is Saturday, 21 November 2026/);

  const second = llm.requests[1] as RecordedRequest;
  const toolMessage = second.messages.find((m) => m.role === "tool");
  assert.ok(toolMessage && toolMessage.role === "tool");
  assert.match(toolMessage.content, /\[1\] AcmeDB Pricing - https:\/\/www\.acmedb\.dev\/pricing/);
  assert.match(toolMessage.content, /Launch \| \$19 \/ month/);
});

test("a greeting is answered with no search, no snapshot and no claim", async () => {
  const db = memoryDb();
  const throwingSearch = {
    search: async () => {
      throw new Error("search must not run for a greeting");
    },
  };
  const llm = new ScriptedLlm([() => [{ type: "token", text: "Hi! Ask me about any " }, { type: "token", text: "product or price." }]]);
  const events: TurnEvent[] = [];

  const result = await runTurn({ ...offlineDeps(llm, db), search: throwingSearch }, { message: "hi", timezone: "UTC" }, (e) => events.push(e));

  assert.equal(result.answer, "Hi! Ask me about any product or price.");
  assert.equal(llm.requests.length, 1);
  assert.deepEqual(events.map((e) => e.type), ["token", "token"]);
  assert.equal(count(db, "snapshots"), 0);
  assert.equal(count(db, "claims"), 0);
});

test("the model gets at most 4 tool rounds, then is made to answer without tools", async () => {
  const db = memoryDb();
  const llm = new ScriptedLlm([
    () => [searchCall],
    () => [searchCall],
    () => [searchCall],
    () => [searchCall],
    () => [{ type: "token", text: "Here is what I found." }],
  ]);

  const result = await runTurn(offlineDeps(llm, db), { message: "How much is AcmeDB?", timezone: "UTC" }, () => {});

  assert.equal(MAX_TOOL_ROUNDS, 4);
  assert.equal(llm.requests.length, 5);
  assert.ok(llm.requests.slice(0, 4).every((r) => r.tools?.[0]?.name === "web_search"));
  assert.equal(llm.requests[4]?.tools, undefined);
  assert.equal(result.answer, "Here is what I found.");
});

test("if the model asks for a search with bad arguments it is told, and no search runs", async () => {
  const db = memoryDb();
  const bad: LlmEvent = { type: "tool_call", call: { id: "c", name: "web_search", arguments: JSON.stringify({ queries: [] }) } };
  const llm = new ScriptedLlm([() => [bad], () => [{ type: "token", text: "Sorry, I could not search." }]]);

  await runTurn(offlineDeps(llm, db), { message: "price?", timezone: "UTC" }, () => {});

  const toolMessage = llm.requests[1]?.messages.find((m) => m.role === "tool");
  assert.ok(toolMessage && toolMessage.role === "tool");
  assert.match(toolMessage.content, /queries must be 1 to 4/);
});

test("replay mode fails loudly for a request that has no fixture", async () => {
  const config = replayConfig();
  const search = createSearch({ mode: "replay", tavilyApiKey: undefined, fixturesDir: config.fixturesDir });
  await assert.rejects(() => search.search({ query: "a question nobody recorded" }), /no fixture for search request/);
});

test("a search that errors is reported to the model instead of crashing the turn", async () => {
  const db = memoryDb();
  const unknownQuery: LlmEvent = {
    type: "tool_call",
    call: { id: "c", name: "web_search", arguments: JSON.stringify({ queries: ["a question nobody recorded"] }) },
  };
  const llm = new ScriptedLlm([() => [unknownQuery], () => [{ type: "token", text: "I could not look that up." }]]);

  const result = await runTurn(offlineDeps(llm, db), { message: "?", timezone: "UTC" }, () => {});

  const toolMessage = llm.requests[1]?.messages.find((m) => m.role === "tool");
  assert.ok(toolMessage && toolMessage.role === "tool");
  assert.match(toolMessage.content, /Search failed for "a question nobody recorded"/);
  assert.equal(result.answer, "I could not look that up.");
});

test("only pages the answer cites get a snapshot", async () => {
  const db = memoryDb();
  const onlyFirst: LlmEvent[] = [{ type: "token", text: "Launch costs $19 per month [1]." }];
  const llm = new ScriptedLlm([() => [searchCall], () => onlyFirst]);

  await runTurn(offlineDeps(llm, db), { message: "How much is AcmeDB?", timezone: "UTC" }, () => {});

  const urls = db.prepare("SELECT url FROM snapshots").all() as { url: string }[];
  assert.deepEqual(urls.map((row) => row.url), ["https://www.acmedb.dev/pricing"]);
});
