import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createReceiptsFilter, entitiesForTurn, looksLikeVendorDomain, parseReceipts, storeClaims, volatilityDays, type SnapshotRef } from "../src/claims.ts";
import { insertTurn } from "../src/db.ts";
import { saveSnapshot } from "../src/receipts.ts";
import { count, memoryDb } from "./helpers.ts";

const sampleAnswer = [
  "Launch costs $19 per month [1] and Scale costs $69 per month [1].",
  "",
  "```receipts",
  JSON.stringify([
    { text: "Launch costs $19 per month", kind: "price", entity: "AcmeDB", source: 1, quote: "Launch | $19 / month" },
    { text: "Scale costs $69 per month", kind: "price", entity: "AcmeDB", source: 1, quote: "Scale plan is sixty-nine dollars" },
  ]),
  "```",
].join("\n");

test("the receipts block is removed from the text the user sees", () => {
  const parsed = parseReceipts(sampleAnswer);
  assert.equal(parsed.visibleText, "Launch costs $19 per month [1] and Scale costs $69 per month [1].");
  assert.equal(parsed.claims.length, 2);
  assert.equal(parsed.invalidCount, 0);
});

test("an answer without a block has no claims and is shown whole", () => {
  const parsed = parseReceipts("Hello! How can I help?");
  assert.equal(parsed.visibleText, "Hello! How can I help?");
  assert.deepEqual(parsed.claims, []);
});

test("an unclosed or broken block is still hidden and nothing crashes", () => {
  const cutOff = parseReceipts('Answer [1].\n\n```receipts\n[{"text": "x"');
  assert.equal(cutOff.visibleText, "Answer [1].");
  assert.deepEqual(cutOff.claims, []);
});

test("entries with a bad kind or a missing quote are counted, not stored", () => {
  const parsed = parseReceipts(
    'ok\n```receipts\n[{"text":"a","kind":"mood","entity":"X","source":1,"quote":"q"},{"text":"b","kind":"price","entity":"X","source":1}]\n```',
  );
  assert.equal(parsed.claims.length, 0);
  assert.equal(parsed.invalidCount, 2);
});

test("claims are stored with anchors, and a quote that is not on the page is kept as unanchored", () => {
  const db = memoryDb();
  const page = "# AcmeDB Pricing | Plan | Price | | Launch | $19 / month | 10 GB included | Scale | $69 / month |";
  const saved = saveSnapshot(db, "https://acmedb.dev/pricing", "https://acmedb.dev/pricing", page, "tavily-basic", "2026-11-21T10:00:00Z");
  const snapshots = new Map<number, SnapshotRef>([[1, { hash: saved.hash, text: saved.text, url: "https://www.acmedb.dev/pricing" }]]);
  const turnId = insertTurn(db, "assistant", "answer", "2026-11-21T10:00:00Z", "UTC");

  const result = storeClaims(db, { turnId, claims: parseReceipts(sampleAnswer).claims, snapshots });

  assert.deepEqual(result, { stored: 2, anchored: 1, unanchored: 1 });
  assert.equal(count(db, "claims"), 2);
  const rows = db
    .prepare("SELECT text, kind, volatility, snapshot_hash, quote, prefix, suffix, anchored FROM claims ORDER BY id")
    .all() as any[];
  assert.equal(rows[0].anchored, 1);
  assert.equal(rows[0].prefix, "meDB Pricing | Plan | Price | | "); // the 32 characters before the quote
  assert.equal(rows[0].suffix, " | 10 GB included | Scale | $69 ");
  assert.equal(rows[0].volatility, 7);
  assert.equal(rows[1].anchored, 0);
  assert.equal(rows[1].snapshot_hash, saved.hash); // kept with its snapshot and quote
  assert.equal(rows[1].quote, "Scale plan is sixty-nine dollars");
  assert.equal(rows[1].prefix, null);
});

test("a claim that cites a page that was never read is stored as unanchored with no snapshot", () => {
  const db = memoryDb();
  const turnId = insertTurn(db, "assistant", "answer", "2026-11-21T10:00:00Z", "UTC");
  const result = storeClaims(db, { turnId, claims: parseReceipts(sampleAnswer).claims, snapshots: new Map() });
  assert.deepEqual(result, { stored: 2, anchored: 0, unanchored: 2 });
  const row = db.prepare("SELECT snapshot_hash FROM claims LIMIT 1").get() as { snapshot_hash: string | null };
  assert.equal(row.snapshot_hash, null);
});

test("the entities of a turn are the names its claims are about, listed once", () => {
  const db = memoryDb();
  const turnId = insertTurn(db, "assistant", "answer", "2026-11-21T10:00:00Z", "UTC");
  const claims = parseReceipts(sampleAnswer).claims;
  claims[1] = { ...claims[1]!, entity: "acmedb" }; // same entity, different case
  storeClaims(db, { turnId, claims, snapshots: new Map() });
  assert.deepEqual(entitiesForTurn(db, turnId), ["AcmeDB"]);
  assert.equal(count(db, "entities"), 1);
});

test("claim lifetimes follow the kind of fact", () => {
  assert.equal(volatilityDays("price"), 7);
  assert.equal(volatilityDays("limit"), 7);
  assert.equal(volatilityDays("availability"), 7);
  assert.equal(volatilityDays("version"), 30);
  assert.equal(volatilityDays("launch"), 30);
  assert.equal(volatilityDays("date"), null);
});

test("streaming never shows the receipts block, even when the marker is split across chunks", () => {
  const filter = createReceiptsFilter();
  const chunks = ["Launch is $19 [1].", "\n\n", "``", "`rec", 'eipts\n[{"te', 'xt":"x"}]\n', "```"];
  let shown = "";
  for (const chunk of chunks) {
    shown += filter.push(chunk);
    assert.ok(!shown.includes("`"), `a backtick leaked into: ${JSON.stringify(shown)}`);
  }
  shown += filter.finish();
  assert.equal(shown, "Launch is $19 [1].");
});

test("streaming an answer with no block shows every character, including a lone backtick", () => {
  const filter = createReceiptsFilter();
  let shown = "";
  for (const chunk of ["Use the `", "pricing` page", " (see [1]).  "]) shown += filter.push(chunk);
  shown += filter.finish();
  assert.equal(shown, "Use the `pricing` page (see [1]).  ");
});

test("the object form lists the shortlist; the bare array still works", () => {
  const claim = { text: "Pro is $25", kind: "price", entity: "Supabase", source: 1, quote: "$25" };
  const object = parseReceipts("a\n```receipts\n" + JSON.stringify({ entities: ["Neon", " Supabase ", "neon", 7], claims: [claim] }) + "\n```");
  assert.deepEqual(object.entities, ["Neon", "Supabase"]);
  assert.equal(object.claims.length, 1);

  const bare = parseReceipts("a\n```receipts\n" + JSON.stringify([claim]) + "\n```");
  assert.equal(bare.claims.length, 1);
  assert.deepEqual(bare.entities, []);

  const noClaims = parseReceipts('a\n```receipts\n{"entities": ["Neon"]}\n```');
  assert.deepEqual(noClaims.entities, ["Neon"]);
  assert.equal(noClaims.invalidCount, 0);
});

test("a name discussed without a claim is still in the turn's entity set", () => {
  const db = memoryDb();
  const turnId = insertTurn(db, "assistant", "answer", "2026-11-21T10:00:00Z", "UTC");
  const claims = parseReceipts(sampleAnswer).claims;
  storeClaims(db, { turnId, claims, entities: ["AcmeDB", "Pipedrive", "HubSpot"], snapshots: new Map() });
  assert.deepEqual(entitiesForTurn(db, turnId), ["AcmeDB", "Pipedrive", "HubSpot"]);
  assert.equal(count(db, "entities"), 3);
});

test("an entity only gets a domain that looks like the vendor's own", () => {
  assert.equal(looksLikeVendorDomain("supabase.com", "Supabase"), true);
  assert.equal(looksLikeVendorDomain("neon.com", "Neon"), true);
  assert.equal(looksLikeVendorDomain("www.pipedrive.com", "Pipe-Drive"), true);
  assert.equal(looksLikeVendorDomain("jetadmin.io", "Supabase"), false);
  assert.equal(looksLikeVendorDomain("google.com", "Go"), false);

  const db = memoryDb();
  const blog = saveSnapshot(db, "https://jetadmin.io/blog", "https://jetadmin.io/blog", "Pro $25 per month", "fetch", "2026-11-21T10:00:00Z");
  const turnId = insertTurn(db, "assistant", "answer", "2026-11-21T10:00:00Z", "UTC");
  const claim = { text: "Pro is $25", kind: "price" as const, entity: "Supabase", source: 1, quote: "Pro $25" };
  storeClaims(db, { turnId, claims: [claim], snapshots: new Map([[1, { hash: blog.hash, text: blog.text, url: "https://jetadmin.io/blog" }]]) });
  const domainOf = () => (db.prepare("SELECT domain FROM entities WHERE name = 'Supabase'").get() as { domain: string | null }).domain;
  assert.equal(domainOf(), null);

  // A later turn reads the vendor's own page: the gap is filled, not left null forever.
  const official = saveSnapshot(db, "https://supabase.com/pricing", "https://supabase.com/pricing", "Pro from $25 / month", "fetch", "2026-11-22T10:00:00Z");
  const later = insertTurn(db, "assistant", "answer", "2026-11-22T10:00:00Z", "UTC");
  storeClaims(db, { turnId: later, claims: [{ ...claim, quote: "Pro from $25" }], snapshots: new Map([[1, { hash: official.hash, text: official.text, url: "https://supabase.com/pricing" }]]) });
  assert.equal(domainOf(), "supabase.com");
});
