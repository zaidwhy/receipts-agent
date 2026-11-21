import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorQuote, loadSnapshotText, saveSnapshot, SNAPSHOT_TEXT_CAP_BYTES } from "../src/receipts.ts";
import { count, memoryDb } from "./helpers.ts";

const when = "2026-11-21T10:00:00.000Z";

test("saving the same text twice stores one snapshot", () => {
  const db = memoryDb();
  const first = saveSnapshot(db, "https://a.dev/pricing", "https://a.dev/pricing", "Pro costs $19 per month", "fetch", when);
  const second = saveSnapshot(db, "https://a.dev/pricing", "https://a.dev/pricing", "Pro costs $19 per month", "fetch", when);
  assert.equal(first.alreadyStored, false);
  assert.equal(second.alreadyStored, true);
  assert.equal(first.hash, second.hash);
  assert.equal(count(db, "snapshots"), 1);
});

test("text that differs only in whitespace and unicode form gets the same hash", () => {
  const db = memoryDb();
  const plain = saveSnapshot(db, "u", "u", "Pro costs $19 per month", "fetch", when);
  const messy = saveSnapshot(db, "u", "u", "  Pro   costs\n\n$19\tper month ", "fetch", when);
  const fullWidth = saveSnapshot(db, "u", "u", "Pro costs $１９ per month", "fetch", when); // full-width digits
  assert.equal(messy.hash, plain.hash);
  assert.equal(fullWidth.hash, plain.hash);
  assert.equal(count(db, "snapshots"), 1);
});

test("anchoring a quote returns it with 32 characters of context on each side", () => {
  const page =
    "Plans and pricing for teams of every size. The Launch plan is $19 / month and includes ten gigabytes of storage for all projects.";
  const anchor = anchorQuote(page, "Launch plan is $19 / month");
  assert.ok(anchor);
  assert.equal(anchor.exact, "Launch plan is $19 / month");
  assert.equal(anchor.prefix, "ng for teams of every size. The ".slice(-32));
  assert.equal(anchor.prefix.length, 32);
  assert.equal(anchor.suffix, " and includes ten gigabytes of s");
  assert.equal(anchor.suffix.length, 32);
});

test("a quote matches even when the page spacing differs from what the model copied", () => {
  const anchor = anchorQuote("Launch   plan\nis $19 / month", "Launch plan is $19 / month");
  assert.ok(anchor);
});

test("a quote that is not on the page does not anchor", () => {
  assert.equal(anchorQuote("The Launch plan is $19 / month", "Launch plan is $25 / month"), null);
  assert.equal(anchorQuote("The Launch plan is $19 / month", "   "), null);
});

test("a 300 KB page is cut to the 200 KB cap and marked truncated", () => {
  const db = memoryDb();
  const huge = "word ".repeat(60_000); // 300,000 bytes
  const saved = saveSnapshot(db, "u", "u", huge, "fetch", when);
  assert.equal(saved.truncated, true);
  assert.ok(Buffer.byteLength(saved.text) <= SNAPSHOT_TEXT_CAP_BYTES);
  assert.ok(Buffer.byteLength(saved.text) > SNAPSHOT_TEXT_CAP_BYTES - 10);

  const row = db.prepare("SELECT status FROM snapshots WHERE hash = ?").get(saved.hash) as { status: string };
  assert.equal(row.status, "truncated");
  assert.equal(loadSnapshotText(db, saved.hash), saved.text);
});

test("a short page is stored whole and marked ok", () => {
  const db = memoryDb();
  const saved = saveSnapshot(db, "u", "u", "short page", "fetch", when);
  assert.equal(saved.truncated, false);
  const row = db.prepare("SELECT status, extractor FROM snapshots WHERE hash = ?").get(saved.hash) as {
    status: string;
    extractor: string;
  };
  assert.deepEqual({ ...row }, { status: "ok", extractor: "fetch" });
});

test("a price quote anchors even when the page splits the currency sign from the number", () => {
  const anchor = anchorQuote("Sales Hub Professional | $ 168 | per seat per month", "Professional | $168 | per seat");
  assert.ok(anchor);
});
