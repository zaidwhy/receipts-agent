import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { insertTurn, recentTurns } from "../src/db.ts";
import { describeRecall, recall } from "../src/memory.ts";
import { loadSnapshotText } from "../src/receipts.ts";
import { clearDemoHistory, describeSeed, pickPriceQuotes, planSeed, seedDemoHistory, type SeedFixture, type SeedPage } from "../src/seed.ts";
import { count, memoryDb, offlineDeps, replayConfig, ScriptedLlm, startApp } from "./helpers.ts";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-11-21T10:00:00Z"); // a Saturday

const ACME_PAGE = ["# Pricing", "### Starter", "$29 / user / month", "Billed annually", "Credits: get up to $500 in credits", "### Pro", "$59 / user / month"].join("\n");

function page(entity: string, text: string | null, day: "monday" | "tuesday" = "monday"): SeedPage {
  const live = `https://www.${entity.toLowerCase()}.com/pricing`;
  return {
    entity,
    day,
    liveUrl: live,
    cutoff: "2026-11-16T04:30:00.000Z",
    lookup: "test",
    capture: text === null ? null : { timestamp: "20261114225809", archiveUrl: `https://web.archive.org/web/20261114225809/${live}`, extractor: "tavily-basic", text },
    miss: text === null ? "no capture at or before the cutoff" : null,
  };
}

const fixture: SeedFixture = {
  recordedAt: NOW.toISOString(),
  timeZone: TZ,
  pages: [page("Acme", ACME_PAGE), page("Bolt", null), page("Neon", "Free $0 per month\nLaunch $19 / month", "tuesday")],
};

test("the seed dates its turns from the clock: last Monday, last Tuesday and the most recent past 3 November", () => {
  const plan = planSeed(NOW, TZ);
  assert.equal(plan.monday.toISOString(), "2026-11-16T04:30:00.000Z"); // Monday 16 Nov 10:00 in India
  assert.equal(plan.tuesday.toISOString(), "2026-11-17T04:30:00.000Z");
  assert.equal(plan.nov3.toISOString(), "2026-11-03T04:30:00.000Z");
  // Before 3 November the most recent one is last year's; on 3 November itself it is also last year's.
  assert.equal(planSeed(new Date("2026-10-20T10:00:00Z"), TZ).nov3.toISOString(), "2025-11-03T04:30:00.000Z");
  assert.equal(planSeed(new Date("2026-11-03T10:00:00Z"), TZ).nov3.toISOString(), "2025-11-03T04:30:00.000Z");
});

test("seeded claims quote the archive capture, dated by the capture and not by the seed", () => {
  const db = memoryDb();
  const report = seedDemoHistory(db, { fixture, now: NOW, timeZone: TZ });
  assert.equal(report.turns, 6);
  assert.equal(count(db, "turns"), 6);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM turns WHERE demo = 1").get() as { n: number }).n, 6);

  const claims = db
    .prepare(
      `SELECT claims.quote AS quote, claims.anchored AS anchored, snapshots.hash AS hash, snapshots.fetched_at AS fetched_at,
              snapshots.final_url AS final_url, snapshots.url AS url, snapshots.extractor AS extractor
       FROM claims JOIN snapshots ON snapshots.hash = claims.snapshot_hash
       WHERE claims.entity_id = (SELECT id FROM entities WHERE name = 'Acme')`,
    )
    .all() as any[];
  assert.ok(claims.length >= 1);
  for (const claim of claims) {
    assert.equal(claim.anchored, 1);
    assert.ok((loadSnapshotText(db, claim.hash) ?? "").includes(claim.quote.replace(/\s+/g, " ")));
    assert.equal(claim.fetched_at, "2026-11-14T22:58:09.000Z");
    assert.equal(claim.url, "https://www.acme.com/pricing");
    assert.match(claim.final_url, /^https:\/\/web\.archive\.org\/web\/20261114225809\//);
    assert.equal(claim.extractor, "tavily-basic");
  }
  // The paid plan beats the credits line, and every amount comes from the page text.
  assert.ok(claims.some((claim) => /Starter|Pro/.test(claim.quote)));
  assert.ok(!claims.some((claim) => claim.quote.includes("credits")));
});

test("a page with no capture leaves its entity in the shortlist with no claims, and the log says so", () => {
  const db = memoryDb();
  const report = seedDemoHistory(db, { fixture, now: NOW, timeZone: TZ });
  const bolt = db.prepare("SELECT COUNT(*) AS n FROM claims WHERE entity_id = (SELECT id FROM entities WHERE name = 'Bolt')").get() as { n: number };
  assert.equal(bolt.n, 0);
  const inShortlist = db.prepare("SELECT COUNT(*) AS n FROM turn_entities WHERE entity_id = (SELECT id FROM entities WHERE name = 'Bolt')").get() as { n: number };
  assert.equal(inShortlist.n, 1);
  assert.match(describeSeed(report), /Bolt .*NO USABLE CAPTURE \(no capture at or before the cutoff\)/);
});

test("running the seed again replaces demo turns only, and never a user's turn", () => {
  const db = memoryDb();
  seedDemoHistory(db, { fixture, now: NOW, timeZone: TZ });
  insertTurn(db, "user", "my own question about Acme", "2026-11-18T05:00:00.000Z", TZ);
  insertTurn(db, "assistant", "my own answer", "2026-11-18T05:00:05.000Z", TZ);
  const again = seedDemoHistory(db, { fixture, now: NOW, timeZone: TZ });
  assert.equal(again.replacedTurns, 6);
  assert.equal(count(db, "turns"), 8);
  assert.equal(recentTurns(db, 12).length, 2); // demo turns are memory, not part of the running chat
  assert.equal(recentTurns(db, 12)[0]?.text, "my own question about Acme");
  assert.equal(count(db, "snapshots"), 2); // Acme and Neon, not doubled
});

test("recall marks seeded turns as demo history, and a topic search still finds them after a re-seed", () => {
  const db = memoryDb();
  seedDemoHistory(db, { fixture, now: NOW, timeZone: TZ });
  seedDemoHistory(db, { fixture, now: NOW, timeZone: TZ }); // deleting turns must keep the search index right
  const found = recall(db, { topic: "Postgres" }, NOW, { timeZone: TZ });
  assert.equal(found.found.length, 1);
  assert.equal(found.found[0]?.demo, true);
  assert.match(describeRecall(found, { topic: "Postgres" }), /\(demo history\)/);
});

test("pickPriceQuotes picks verbatim lines and never types a price", () => {
  const picked = pickPriceQuotes(ACME_PAGE, "Acme");
  assert.ok(picked.length >= 1);
  for (const { quote } of picked) assert.ok(ACME_PAGE.replace(/\n/g, " ").includes(quote));
  assert.deepEqual(pickPriceQuotes("No prices on this page at all", "Acme"), []);
});

test("Load demo history over HTTP seeds, and /history shows the demo turns with their tag", async () => {
  const db = memoryDb();
  const app = await startApp(replayConfig(), offlineDeps(new ScriptedLlm([() => []]), db), () => fixture);
  try {
    const response = await fetch(`${app.url}/seed`, { method: "POST", body: JSON.stringify({ timezone: TZ }) });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.report.turns, 6);
    const history = (await (await fetch(`${app.url}/history`)).json()).turns;
    assert.equal(history.length, 6);
    assert.ok(history.every((turn: { demo: boolean }) => turn.demo));
    assert.deepEqual(
      history.map((turn: { asked_at: string }) => turn.asked_at.slice(0, 10)),
      ["2026-11-03", "2026-11-03", "2026-11-16", "2026-11-16", "2026-11-17", "2026-11-17"],
    );
  } finally {
    await app.close();
  }
});

test("a server without a seed fixture says so instead of seeding nothing", async () => {
  const app = await startApp(replayConfig(), offlineDeps(new ScriptedLlm([() => []]), memoryDb()));
  try {
    const response = await fetch(`${app.url}/seed`, { method: "POST", body: "{}" });
    assert.equal(response.status, 501);
  } finally {
    await app.close();
  }
});

test("clearing demo history drops the archive copies it made but keeps a page a user's claim cites", () => {
  const db = memoryDb();
  seedDemoHistory(db, { fixture, now: NOW, timeZone: TZ });
  assert.equal(count(db, "snapshots"), 2);
  clearDemoHistory(db);
  assert.equal(count(db, "snapshots"), 0);
  assert.equal(count(db, "claims"), 0);

  seedDemoHistory(db, { fixture, now: NOW, timeZone: TZ });
  // A user's own claim cites the same page text; it is real work and survives a re-seed.
  const hash = (db.prepare("SELECT snapshot_hash AS h FROM claims LIMIT 1").get() as { h: string }).h;
  const turn = insertTurn(db, "assistant", "mine", "2026-11-18T05:00:00.000Z", TZ);
  db.prepare("INSERT INTO claims (turn_id, text, kind, snapshot_hash, quote, anchored) VALUES (?, 'mine', 'price', ?, 'q', 0)").run(turn, hash);
  clearDemoHistory(db);
  assert.equal(count(db, "snapshots"), 1);
});
