import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Database } from "../src/db.ts";
import { runTurn, type TurnEvent } from "../src/conversation.ts";
import type { LlmEvent } from "../src/llm.ts";
import { asksAboutChange } from "../src/recheck-tool.ts";
import { FakeReader, FakeSearch, memoryDb, offlineDeps, parseSse, replayConfig, ScriptedLlm, seedExchange, startApp, type PageAnswer, type RecordedRequest } from "./helpers.ts";
import type { FeedPort } from "../src/discovery.ts";

// The test clock is Saturday 21 Nov 2026, 15:30 in India. The seeded question was asked at 09:30 that day.
const zone = "Asia/Kolkata";
const PAGE = "Acme pricing. Free $0. Pro $19 / month. Team $99 / month.";
const RSS = `<rss><channel><item><title>Introducing branching</title><link>https://acmedb.dev/changelog/branching</link><pubDate>Sat, 21 Nov 2026 06:00:00 GMT</pubDate></item></channel></rss>`;

function seeded(): Database {
  const db = memoryDb();
  seedExchange(db, {
    question: "What does AcmeDB Pro cost?",
    answer: "Pro is $19 per month.",
    askedAt: "2026-11-21T04:00:00.000Z",
    entities: ["AcmeDB", "OtherDB"],
    claims: [
      { text: "AcmeDB Pro costs $19 per month", kind: "price", entity: "AcmeDB", quote: "Pro $19 / month", url: "https://www.acmedb.dev/pricing", page: PAGE, fetchedAt: "2026-11-21T04:00:04.000Z" },
    ],
  });
  return db;
}

const feedsWith = (bodies: Record<string, string>): FeedPort => ({ get: async (url) => bodies[url] ?? null });
const say = (text: string): LlmEvent[] => [{ type: "token", text }];

function depsWith(llm: ScriptedLlm, db: Database, page: (url: string) => PageAnswer = () => PAGE) {
  const reader = new FakeReader((url) => page(url));
  return { reader, deps: { ...offlineDeps(llm, db), reader, search: new FakeSearch(), feeds: feedsWith({ "https://acmedb.dev/changelog/rss.xml": RSS }) } };
}

const types = (events: TurnEvent[]) => events.map((event) => event.type);

test("asking whether something changed since earlier today rechecks before the model writes", async () => {
  const db = seeded();
  const events: TurnEvent[] = [];
  let seenBeforeModel: string[] = [];
  const llm = new ScriptedLlm([
    () => {
      seenBeforeModel = types(events);
      return say("Source unchanged for the Pro price. AcmeDB shipped branching.");
    },
  ]);
  const { deps, reader } = depsWith(llm, db);

  await runTurn(deps, { message: "Has any of that changed since I asked earlier today?", timezone: zone }, (e) => events.push(e));

  assert.ok(seenBeforeModel.includes("recheck_row"));
  assert.ok(seenBeforeModel.includes("event_row"));
  assert.equal(seenBeforeModel.at(-1), "coverage"); // the coverage line closes the table
  assert.equal(llm.requests.length, 1); // the recheck itself needed no model call
  assert.equal(reader.calls.length, 1);

  const row = events.find((e) => e.type === "recheck_row");
  assert.ok(row && row.type === "recheck_row");
  assert.equal(row.data.status, "source_unchanged");
  assert.equal(row.data.tier, 1);
  assert.equal(row.data.entity, "AcmeDB");
  assert.equal(row.data.source_url, "https://www.acmedb.dev/pricing");

  const event = events.find((e) => e.type === "event_row");
  assert.ok(event && event.type === "event_row");
  assert.equal(event.data.title, "Introducing branching");
  assert.equal(event.data.kind, "launch");
  assert.equal(event.data.confirmed, true);

  const coverage = events.find((e) => e.type === "coverage");
  assert.ok(coverage && coverage.type === "coverage");
  // OtherDB was on the shortlist but no page of its own was ever read, so it has no vendor domain to look at.
  assert.equal(coverage.data.line, "checked 1 pricing page, 1 changelog; no changelog found for 1; 0 model calls");

  // The model sees it as a finished recheck call, after the recall.
  const first = llm.requests[0] as RecordedRequest;
  const calls = first.messages.flatMap((m) => (m.role === "assistant" && m.toolCalls ? m.toolCalls.map((c) => c.name) : []));
  assert.deepEqual(calls, ["recall", "recheck"]);
  const tool = first.messages.filter((m) => m.role === "tool").at(-1);
  assert.ok(tool && tool.role === "tool");
  assert.match(tool.content, /status: source unchanged \(tier 1\)/);
  assert.match(tool.content, /Introducing branching/);
});

test("the recheck window starts where the recalled range starts, so older feed items are left out", async () => {
  const db = seeded();
  const oldItem = RSS.replace("Sat, 21 Nov 2026 06:00:00 GMT", "Fri, 20 Nov 2026 06:00:00 GMT"); // before the start of 21 Nov in India
  const llm = new ScriptedLlm([() => say("ok")]);
  const events: TurnEvent[] = [];
  const base = depsWith(llm, db);
  await runTurn({ ...base.deps, feeds: feedsWith({ "https://acmedb.dev/changelog/rss.xml": oldItem }) }, { message: "Has any of that changed since I asked earlier today?", timezone: zone }, (e) => events.push(e));
  assert.ok(!events.some((e) => e.type === "event_row"));
});

test("an unreachable page is said to be unreachable in what the model reads, so it cannot claim nothing changed", async () => {
  const db = seeded();
  const llm = new ScriptedLlm([() => say("I could not check the page.")]);
  const { deps } = depsWith(llm, db, () => ({ error: "HTTP 404" }));
  const events: TurnEvent[] = [];

  await runTurn(deps, { message: "Is that still correct, since I asked earlier today?", timezone: zone }, (e) => events.push(e));

  const row = events.find((e) => e.type === "recheck_row");
  assert.ok(row && row.type === "recheck_row");
  assert.equal(row.data.status, "could_not_verify");
  assert.equal(row.data.tier, 4);
  const tool = (llm.requests[0] as RecordedRequest).messages.filter((m) => m.role === "tool").at(-1);
  assert.ok(tool && tool.role === "tool");
  assert.match(tool.content, /Do not say nothing changed/);
  assert.match(tool.content, /1 unreachable/);
});

test("without a word about change there is no recheck, and no page is read", async () => {
  const db = seeded();
  const llm = new ScriptedLlm([() => say("You asked what AcmeDB Pro costs.")]);
  const { deps, reader } = depsWith(llm, db);
  const events: TurnEvent[] = [];
  await runTurn(deps, { message: "What did I ask you earlier today?", timezone: zone }, (e) => events.push(e));
  assert.equal(reader.calls.length, 0);
  assert.ok(!types(events).includes("recheck_row"));
  assert.ok(!types(events).includes("coverage"));
});

test("a change question about a day with no record does not recheck", async () => {
  const db = seeded();
  const llm = new ScriptedLlm([() => say("I have no record of Monday.")]);
  const { deps, reader } = depsWith(llm, db);
  await runTurn(deps, { message: "Has anything changed since I asked on Monday?", timezone: zone }, () => {});
  assert.equal(reader.calls.length, 0);
});

test("the model can call recheck itself with the turn id from recall", async () => {
  const db = seeded();
  const events: TurnEvent[] = [];
  const call: LlmEvent = { type: "tool_call", call: { id: "c1", name: "recheck", arguments: JSON.stringify({ turn_ids: [1] }) } };
  const llm = new ScriptedLlm([() => [call], () => say("Source unchanged.")]);
  const { deps } = depsWith(llm, db);

  await runTurn(deps, { message: "Please double-check the AcmeDB price.", timezone: zone }, (e) => events.push(e));

  assert.ok(types(events).includes("recheck_row"));
  const tool = (llm.requests[1] as RecordedRequest).messages.filter((m) => m.role === "tool").at(-1);
  assert.ok(tool && tool.role === "tool");
  assert.match(tool.content, /source unchanged/);
});

test("a recheck call with nothing to check says so, and a bad call is told what to fix", async () => {
  const db = memoryDb();
  const calls: LlmEvent[] = [
    { type: "tool_call", call: { id: "c1", name: "recheck", arguments: JSON.stringify({ turn_ids: [99] }) } },
    { type: "tool_call", call: { id: "c2", name: "recheck", arguments: "{}" } },
  ];
  const llm = new ScriptedLlm([() => calls, () => say("Nothing to check.")]);
  const { deps } = depsWith(llm, db);
  await runTurn(deps, { message: "Please double-check.", timezone: zone }, () => {});
  const results = (llm.requests[1] as RecordedRequest).messages.filter((m) => m.role === "tool").map((m) => (m.role === "tool" ? m.content : ""));
  assert.match(results[0] ?? "", /Nothing to recheck/);
  assert.match(results[1] ?? "", /give turn_ids and\/or entities/);
});

test("the prompt tells the model to lead with changes and never say nothing changed over an unchecked source", async () => {
  const llm = new ScriptedLlm([() => say("ok")]);
  await runTurn(offlineDeps(llm, memoryDb()), { message: "hi", timezone: "UTC" }, () => {});
  const system = llm.requests[0]?.messages[0];
  assert.ok(system && system.role === "system");
  assert.match(system.content, /Lead with what changed, then what is unchanged, then what could not be checked/);
  assert.match(system.content, /Never say nothing changed when any source was unreachable/);
  assert.match(system.content, /never \\?"still true\\?"/);
  assert.match(system.content, /no \[n\] numbers\. Name a page by its domain/);
});

test("which messages ask about change", () => {
  for (const yes of ["Has anything changed since I asked?", "Is that still correct?", "is it still true", "any update on Neon?", "anything new from Supabase", "did they ship it? what shipped", "Has the price changed"]) {
    assert.ok(asksAboutChange(yes), yes);
  }
  for (const no of ["What does Neon cost?", "What did I ask earlier today?", "Compare Neon and Supabase", "hi"]) {
    assert.ok(!asksAboutChange(no), no);
  }
});

test("the done event carries the timing breakdown", async () => {
  const db = seeded();
  const llm = new ScriptedLlm([() => say("Source unchanged.")]);
  const { deps } = depsWith(llm, db);
  const app = await startApp(replayConfig(), deps);
  try {
    const response = await fetch(`${app.url}/chat`, { method: "POST", body: JSON.stringify({ message: "Has any of that changed since I asked earlier today?", timezone: zone }) });
    const events = parseSse(await response.text());
    const done = events.at(-1);
    assert.equal(done?.event, "done");
    const timings = done?.data.timings;
    assert.equal(typeof timings.thinking_emitted_ms, "number");
    assert.equal(typeof timings.recall_ms, "number");
    assert.equal(typeof timings.recheck_ms, "number");
    assert.equal(typeof timings.recheck_lane_a_ms, "number");
    assert.equal(timings.llm_rounds.length, 1);
    assert.equal(typeof timings.llm_rounds[0].ttft_ms, "number");
    assert.ok(timings.total_ms >= timings.recheck_ms);
    assert.ok(events.some((e) => e.event === "recheck_row" && e.data.status === "source_unchanged"));
    assert.ok(events.some((e) => e.event === "coverage" && /^checked 1 pricing page/.test(e.data.line)));
  } finally {
    await app.close();
  }
});
