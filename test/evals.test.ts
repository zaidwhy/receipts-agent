import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CASES } from "../evals/cases.ts";
import type { CaseRun, TurnRun } from "../evals/harness.ts";
import { percentile, renderReport, resultOf, summarize } from "../evals/report.ts";
import { memoryDb } from "./helpers.ts";

function turn(over: Partial<TurnRun> = {}): TurnRun {
  return { message: "m", answer: "", events: [], firstTokenMs: 400, totalMs: 900, modelToolCalls: [], searchCalls: 0, readCalls: 0, timings: null, error: null, ...over };
}

function run(over: Partial<TurnRun>, earlier: TurnRun[] = []): CaseRun {
  const last = turn(over);
  return { turns: [...earlier, last], last, db: memoryDb() };
}

const byId = (id: string) => CASES.find((testCase) => testCase.id === id)!;

test("there are 12 cases with distinct ids", () => {
  assert.equal(CASES.length, 12);
  assert.equal(new Set(CASES.map((testCase) => testCase.id)).size, 12);
});

test("the empty-memory CRM trap fails an answer that names a tool or invents a past conversation", () => {
  const trap = byId("empty-crm-trap");
  assert.deepEqual(trap.check(run({ answer: "I have no record of a shortlist on Monday. Want me to search for CRM tools now?" })), []);
  assert.match(trap.check(run({ answer: "You shortlisted HubSpot, Pipedrive and Zoho on Monday." })).join(), /names a CRM tool: HubSpot/);
  assert.match(trap.check(run({ answer: "Sure, here is a general overview of CRM software." })).join(), /no record/);
});

test("hi must be answered with no tool and in under 2500 ms", () => {
  const hi = byId("hi");
  assert.deepEqual(hi.check(run({ answer: "Hello!", totalMs: 1200 })), []);
  assert.match(hi.check(run({ answer: "Hello!", totalMs: 2600 })).join(), /not under 2500/);
  assert.match(hi.check(run({ answer: "Hello!", searchCalls: 1 })).join(), /touched the web/);
  assert.match(hi.check(run({ answer: "Hello!", modelToolCalls: [{ id: "1", name: "recall", arguments: "{}" }] })).join(), /1 model tool calls/);
});

test("a fresh question needs a citation and an anchored claim, and a Hindi answer needs Devanagari", () => {
  const hindi = byId("hindi-price");
  const bad = hindi.check(run({ answer: "Pro is $25 per month." }));
  assert.match(bad.join(), /no \[n\] citation/);
  assert.match(bad.join(), /no anchored claim/);
  assert.match(bad.join(), /no Devanagari/);

  const db = memoryDb();
  db.exec("INSERT INTO turns (role, text, asked_at, tz) VALUES ('assistant', 'a', '2026-11-21T00:00:00Z', 'UTC')");
  db.exec("INSERT INTO claims (turn_id, text, kind, quote, anchored) VALUES (1, 'Pro $25', 'price', 'Pro $25', 1)");
  const good: CaseRun = { turns: [], last: turn({ answer: "प्रो प्लान $25 प्रति माह है [1]।", events: [{ type: "sources", sources: [{ n: 1, title: "t", url: "https://supabase.com/pricing" }] }] }), db };
  assert.deepEqual(hindi.check(good), []);
});

test("the pronoun follow-up is judged against whichever product the first answer named second", () => {
  const followUp = byId("pronoun-follow-up");
  const first = turn({ answer: "Supabase Pro is $25 [1]; Neon Launch is $19 [2]." }); // so the second one is Neon
  const searched = (queries: string[]) => [{ id: "1", name: "web_search", arguments: JSON.stringify({ queries }) }];
  assert.deepEqual(followUp.check(run({ answer: "Neon Launch costs $19 [1].", modelToolCalls: searched(["Neon Launch plan price"]) }, [first])), []);
  assert.match(followUp.check(run({ answer: "Supabase Pro is $25.", modelToolCalls: searched(["Supabase Pro price"]) }, [first])).join(), /second product \(neon\)/);
  assert.match(followUp.check(run({ answer: "Neon is $19.", modelToolCalls: searched(["the second one price"]) }, [first])).join(), /second one/);
});

test("summary: percentiles, pass rate and the share of recheck claims settled at tier 1", () => {
  assert.equal(percentile([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], 50), 500);
  assert.equal(percentile([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], 90), 900);
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70], 50), 40); // rank 3.5 rounds up to the 4th value
  assert.equal(percentile([], 50), null);

  const row = (tier: number) => ({ type: "recheck_row" as const, data: { entity: "E", claim: "c", then: "t", now: null, source_url: null, status: "source_unchanged" as const, tier, note: null, lead: null } });
  const hi = resultOf(byId("hi"), run({ answer: "Hello!", firstTokenMs: 300 }));
  const crm = resultOf(byId("crm-recheck"), run({ answer: "no", firstTokenMs: 2000, events: [row(1), row(2), row(3), row(3), row(1)] }));
  const summary = summarize([hi, crm]);
  assert.equal(summary.passed, 1);
  assert.equal(summary.recheckClaims, 5);
  assert.equal(summary.tierOneClaims, 2);
  const text = renderReport([[hi, crm], [hi, crm]], { model: "m", webMode: "replay", now: "n", replay: "r" });
  assert.match(text, /pass rate: 1\/2 \(50%\)/);
  assert.match(text, /2 of 5 \(40%\)/);
  assert.match(text, /\| crm-recheck \| FAIL \|/);
});
