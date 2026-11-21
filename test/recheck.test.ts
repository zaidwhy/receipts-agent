import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createClock } from "../src/clock.ts";
import type { Database } from "../src/db.ts";
import type { LlmEvent } from "../src/llm.ts";
import { loadClaims, recheckClaims, RECHECK_CONCURRENCY, type RecheckDeps, type RecheckRow } from "../src/recheck.ts";
import { count, FakeReader, FakeSearch, memoryDb, ScriptedLlm, seedExchange, type RecordedRequest } from "./helpers.ts";

const URL_A = "https://www.acmedb.dev/pricing";
const PAGE_V1 = "Acme pricing. Free $0. Pro $19 / month. Team $99 / month. Contact sales for more.";

function seedPricing(db: Database, options: { page?: string; url?: string; quote?: string; extractor?: string; entity?: string } = {}): void {
  seedExchange(db, {
    question: "What does AcmeDB Pro cost?",
    answer: "Pro is $19 per month.",
    askedAt: "2026-11-21T04:00:00.000Z",
    entities: [options.entity ?? "AcmeDB"],
    claims: [
      {
        text: "AcmeDB Pro costs $19 per month",
        kind: "price",
        entity: options.entity ?? "AcmeDB",
        quote: options.quote ?? "Pro $19 / month",
        url: options.url ?? URL_A,
        page: options.page ?? PAGE_V1,
        fetchedAt: "2026-11-21T04:00:04.000Z",
        extractor: options.extractor,
      },
    ],
  });
}

const reply = (results: object[]): LlmEvent[] => [{ type: "token", text: JSON.stringify({ results }) }];
const promptOf = (request: RecordedRequest) => request.messages.map((m) => m.content).join("\n");

function depsFor(db: Database, reader: FakeReader, llm: ScriptedLlm, search = new FakeSearch()): RecheckDeps {
  return { db, reader, search, llm, clock: createClock("2026-11-21T10:00:00Z") };
}

async function run(db: Database, deps: RecheckDeps): Promise<{ rows: RecheckRow[]; llmCalls: number; pagesChecked: number; pagesUnreachable: number }> {
  return recheckClaims(deps, loadClaims(db, { entities: ["AcmeDB"] }));
}

test("an identical page is reported as source unchanged by tier 1 with no model call", async () => {
  const db = memoryDb();
  seedPricing(db);
  const llm = new ScriptedLlm([() => reply([])]);
  const result = await run(db, depsFor(db, new FakeReader(() => PAGE_V1), llm));

  assert.equal(llm.requests.length, 0);
  assert.equal(result.llmCalls, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.status, "source_unchanged");
  assert.equal(result.rows[0]?.tier, 1);
  assert.equal(result.rows[0]?.now, "Pro $19 / month");
  assert.equal(count(db, "rechecks"), 1);
  assert.equal(count(db, "snapshots"), 1); // the same text is stored once
});

test("a price edited from $19 to $24 is reported as changed with the new value", async () => {
  const db = memoryDb();
  seedPricing(db);
  const edited = PAGE_V1.replace("Pro $19 / month", "Pro $24 / month");
  const llm = new ScriptedLlm([
    (request) => {
      assert.match(promptOf(request), /Pro \$19 \/ month/); // old context is shown
      assert.match(promptOf(request), /Pro \$24 \/ month/); // so is the new excerpt
      return reply([{ id: 1, status: "changed", new_value: "Pro $24 / month", note: "Pro went from $19 to $24" }]);
    },
  ]);
  const result = await run(db, depsFor(db, new FakeReader(() => edited), llm));

  assert.equal(llm.requests.length, 1);
  assert.equal(result.rows[0]?.status, "changed");
  assert.equal(result.rows[0]?.tier, 3); // the quote is gone, so tier 3 read it
  assert.equal(result.rows[0]?.now, "Pro $24 / month");
  assert.equal(count(db, "snapshots"), 2); // the new page is kept as a new snapshot
  const stored = db.prepare("SELECT status, new_value FROM rechecks").get() as { status: string; new_value: string };
  assert.deepEqual({ ...stored }, { status: "changed", new_value: "Pro $24 / month" });
});

test("a quote that is still there but under a Legacy plans heading is context changed", async () => {
  const db = memoryDb();
  seedPricing(db, { quote: "Pro $19" });
  const moved = "Acme pricing. Pro $29 / month. Legacy plans (no longer sold): Pro $19 / month, Team $99 / month.";
  const llm = new ScriptedLlm([
    (request) => {
      assert.match(promptOf(request), /Legacy plans/);
      return reply([{ id: 1, status: "context_changed", note: "The $19 plan is listed under Legacy plans" }]);
    },
  ]);
  const result = await run(db, depsFor(db, new FakeReader(() => moved), llm));

  assert.equal(result.rows[0]?.status, "context_changed");
  assert.equal(result.rows[0]?.tier, 2);
  assert.equal(llm.requests.length, 1);
});

test("the same fact with other parts of the page moved is source unchanged by tier 2", async () => {
  const db = memoryDb();
  seedPricing(db);
  const llm = new ScriptedLlm([() => reply([{ id: 1, status: "source_unchanged", note: "same price" }])]);
  const result = await run(db, depsFor(db, new FakeReader(() => PAGE_V1 + " New banner: webinar on Friday."), llm));

  assert.equal(result.rows[0]?.status, "source_unchanged");
  assert.equal(result.rows[0]?.tier, 2);
  assert.equal(llm.requests.length, 1);
});

test("a new value that is not on the page is not reported as a change", async () => {
  const db = memoryDb();
  seedPricing(db);
  const edited = PAGE_V1.replace("Pro $19 / month", "Pro $24 / month");
  const llm = new ScriptedLlm([() => reply([{ id: 1, status: "changed", new_value: "Pro $99 / month" }])]);
  const result = await run(db, depsFor(db, new FakeReader(() => edited), llm));

  assert.equal(result.rows[0]?.status, "cannot_tell");
  assert.equal(result.rows[0]?.now, null);
});

test("the same amount under another currency label is reworded, not changed", async () => {
  const db = memoryDb();
  seedPricing(db, { quote: "Starting from CA$16", page: "Acme add-ons. Projects: Starting from CA$16. Contact sales." });
  const regional = "Acme add-ons. Projects: Starting from $16. Contact sales.";
  const llm = new ScriptedLlm([() => reply([{ id: 1, status: "changed", new_value: "Starting from $16" }])]);
  const result = await run(db, depsFor(db, new FakeReader(() => regional), llm));

  assert.equal(result.rows[0]?.status, "reworded");
  assert.equal(result.rows[0]?.now, null);
});

test("a model reply that is not JSON leaves the claim as cannot tell", async () => {
  const db = memoryDb();
  seedPricing(db);
  const llm = new ScriptedLlm([() => [{ type: "token", text: "Looks the same to me." }]]);
  const result = await run(db, depsFor(db, new FakeReader(() => PAGE_V1 + " Extra."), llm));
  assert.equal(result.rows[0]?.status, "cannot_tell");
});

test("a 404 is could not verify, with a lead from search labelled as a different source", async () => {
  const db = memoryDb();
  seedPricing(db);
  const search = new FakeSearch([{ url: "https://blog.example.com/acme-pricing", title: "Acme pricing explained", snippet: "Pro is $24 now.", publishedDate: null }]);
  const llm = new ScriptedLlm([() => reply([])]);
  const result = await run(db, depsFor(db, new FakeReader(() => ({ error: "HTTP 404" })), llm, search));

  const row = result.rows[0];
  assert.equal(row?.status, "could_not_verify");
  assert.equal(row?.tier, 4);
  assert.equal(row?.now, null);
  assert.equal(row?.lead?.url, "https://blog.example.com/acme-pricing");
  assert.match(row?.note ?? "", /HTTP 404/);
  assert.match(row?.note ?? "", /different source/);
  assert.equal(search.queries[0]?.query, "AcmeDB Pro costs $19 per month");
  assert.equal(llm.requests.length, 0);
  assert.equal(result.pagesUnreachable, 1);
  assert.equal(result.pagesChecked, 0);
});

test("when the Tavily read has the quote and a long plain fetch does not, the claim goes to tier 3, not source unchanged", async () => {
  const db = memoryDb();
  seedPricing(db, { extractor: "tavily-basic" });
  const filler = "Plain page about databases and hosting and teams. ".repeat(60);
  const reader = new FakeReader((_url, extractor) => (extractor === "fetch" ? filler + " Pro $24 / month." : PAGE_V1)); // Tavily still shows the old text
  const llm = new ScriptedLlm([
    (request) => {
      assert.match(promptOf(request), /second read/i);
      return reply([{ id: 1, status: "cannot_tell", note: "the reads differ" }]);
    },
  ]);
  const result = await recheckClaims(depsFor(db, reader, llm), loadClaims(db, { entities: ["AcmeDB"] }));

  assert.equal(result.rows[0]?.status, "cannot_tell");
  assert.equal(result.rows[0]?.tier, 3);
  assert.match(result.rows[0]?.note ?? "", /two reads .* disagree/i);
  assert.equal(result.readsCompared, 1);
  assert.equal(result.readsAgreed, 0);
  assert.deepEqual(reader.calls.map((call) => call.extractor).sort(), ["fetch", "tavily-basic"]);
});

test("when the plain fetch shows the same quote in other formatting, the reads agree and tier 1 holds", async () => {
  const db = memoryDb();
  seedPricing(db, { extractor: "tavily-basic" });
  const filler = "Plain page about databases and hosting and teams. ".repeat(60);
  const reader = new FakeReader((_url, extractor) => (extractor === "fetch" ? `${filler}\n| Pro |\n| $19 / month |` : PAGE_V1));
  const llm = new ScriptedLlm([() => reply([])]);
  const result = await recheckClaims(depsFor(db, reader, llm), loadClaims(db, { entities: ["AcmeDB"] }));

  assert.equal(result.rows[0]?.tier, 1);
  assert.equal(result.rows[0]?.status, "source_unchanged");
  assert.equal(result.readsCompared, 1);
  assert.equal(result.readsAgreed, 1);
  assert.equal(llm.requests.length, 0);
});

test("a short plain fetch (a shell page) is not trusted over the Tavily read", async () => {
  const db = memoryDb();
  seedPricing(db, { extractor: "tavily-basic" });
  const reader = new FakeReader((_url, extractor) => (extractor === "fetch" ? "Loading... enable JavaScript" : PAGE_V1));
  const result = await recheckClaims(depsFor(db, reader, new ScriptedLlm([() => reply([])])), loadClaims(db, { entities: ["AcmeDB"] }));
  assert.equal(result.rows[0]?.tier, 1);
  assert.equal(result.readsCompared, 0);
});

test("a claim that never anchored skips tiers 1 and 2 even when the page is identical", async () => {
  const db = memoryDb();
  seedPricing(db, { quote: "this wording is not on the page" });
  const llm = new ScriptedLlm([() => reply([{ id: 1, status: "reworded", note: "same price, other words" }])]);
  const result = await run(db, depsFor(db, new FakeReader(() => PAGE_V1), llm));

  assert.equal(llm.requests.length, 1);
  assert.equal(result.rows[0]?.tier, 3);
  assert.equal(result.rows[0]?.status, "reworded");
});

test("claims on one page share one model call, and one read", async () => {
  const db = memoryDb();
  seedExchange(db, {
    question: "Acme plans?",
    answer: "Pro $19, Team $99.",
    askedAt: "2026-11-21T04:00:00.000Z",
    entities: ["AcmeDB"],
    claims: ["Pro $19 / month", "Team $99 / month"].map((quote) => ({
      text: `AcmeDB ${quote}`,
      kind: "price" as const,
      entity: "AcmeDB",
      quote,
      url: URL_A,
      page: PAGE_V1,
      fetchedAt: "2026-11-21T04:00:04.000Z",
    })),
  });
  const reader = new FakeReader(() => PAGE_V1 + " Banner.");
  const llm = new ScriptedLlm([
    () =>
      reply([
        { id: 1, status: "source_unchanged" },
        { id: 2, status: "source_unchanged" },
      ]),
  ]);
  const result = await run(db, depsFor(db, reader, llm));

  assert.equal(llm.requests.length, 1);
  assert.equal(result.llmCalls, 1);
  assert.equal(reader.calls.length, 1);
  assert.deepEqual(result.rows.map((row) => row.claimId), [1, 2]);
});

test("pages are read at most four at a time", async () => {
  const db = memoryDb();
  // Each page has its own text, because a snapshot is stored once per text.
  for (let i = 1; i <= 6; i += 1) seedPricing(db, { url: `https://v${i}.example.com/pricing`, page: `${PAGE_V1} Vendor ${i}.` });
  const reader = new FakeReader((url) => `${PAGE_V1} Vendor ${/v(\d)\./.exec(url)?.[1]}.`);
  const result = await run(db, depsFor(db, reader, new ScriptedLlm([() => reply([])])));
  assert.equal(result.rows.length, 6);
  assert.equal(RECHECK_CONCURRENCY, 4);
  assert.ok(reader.peak <= 4, `peak concurrent reads was ${reader.peak}`);
  assert.ok(reader.peak > 1, "reads should overlap");
});

test("claims are found by question id (through the answer that follows it) or by entity name", () => {
  const db = memoryDb();
  seedPricing(db);
  seedPricing(db, { entity: "OtherDB", url: "https://other.example.com/pricing" });
  assert.equal(loadClaims(db, { turnIds: [1] }).length, 1); // question 1, answer 2
  assert.equal(loadClaims(db, { turnIds: [1] })[0]?.entity, "AcmeDB");
  assert.equal(loadClaims(db, { entities: ["otherdb"] }).length, 1);
  assert.equal(loadClaims(db, { turnIds: [1], entities: ["OtherDB"] }).length, 2);
  assert.equal(loadClaims(db, {}).length, 0);
});

test("a price claim worded without price words still shows the model the price lines of a long new page", async () => {
  const db = memoryDb();
  seedExchange(db, {
    question: "What does AcmeDB cost?",
    answer: "Starting from $16.",
    askedAt: "2026-11-21T04:00:00.000Z",
    entities: ["AcmeDB"],
    claims: [
      { text: "AcmeDB: Starting from $16", kind: "price", entity: "AcmeDB", quote: "Starting from $16", url: URL_A, page: "Starting from $16 for the first plan", fetchedAt: "2026-11-21T04:00:04.000Z" },
    ],
  });
  const navigation = Array.from({ length: 300 }, (_, index) => `Menu item ${index} about products and teams`).join("\n");
  const newPage = `${navigation}\nGrowth plan $24 / month per seat\n${navigation.replace(/Menu/g, "Footer")}`;
  const llm = new ScriptedLlm([() => reply([])]);
  await run(db, depsFor(db, new FakeReader(() => newPage), llm));
  assert.match(promptOf(llm.requests[0] as RecordedRequest), /Growth plan \$24 \/ month/);
});
