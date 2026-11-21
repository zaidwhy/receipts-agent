import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createClock } from "../src/clock.ts";
import { EXCERPT_CAP_CHARS, excerptFor, GAP } from "../src/excerpt.ts";
import type { ReaderPort, ReadOutcome } from "../src/reader.ts";
import type { SearchPort, SearchResult } from "../src/search.ts";
import { MAX_PAGES_READ, runWebSearch, type Source, type ToolContext } from "../src/tools.ts";

// Every excerpt line is a line of the page, and lines shown one after the other really follow
// each other on the page, so a quote copied across them is a real substring. Gaps carry a marker.
function assertQuotable(page: string, excerpt: string): void {
  const pageLines = page.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const shown = excerpt.split("\n");
  shown.forEach((line, i) => {
    if (line === GAP) return;
    assert.ok(pageLines.includes(line), `not a line of the page: ${line}`);
    const next = shown[i + 1];
    if (next === undefined || next === GAP) return;
    const joined = `${line} ${next}`;
    assert.ok(pageLines.some((_, at) => `${pageLines[at]} ${pageLines[at + 1]}` === joined), `lines are not neighbours on the page: ${joined}`);
  });
}

function longPricingPage(): string {
  const filler = Array.from({ length: 120 }, (_, i) => `Section ${i}: general notes about regions, support hours and company news ${"x".repeat(60)}`);
  filler.splice(70, 0, "Launch plan: $19 per month, 10 GB of storage included.", "Scale plan: $69 per month, 50 GB of storage included.");
  return filler.join("\n");
}

test("an excerpt is made of verbatim lines of the page, keeps the lines that match, and respects the cap", () => {
  const page = longPricingPage();
  const excerpt = excerptFor(page, "AcmeDB Launch plan price per month");

  assert.ok(excerpt.length <= EXCERPT_CAP_CHARS);
  assert.ok(excerpt.length < page.length);
  assertQuotable(page, excerpt);
  assert.match(excerpt, /Launch plan: \$19 per month/);
  assert.match(excerpt, /Scale plan: \$69 per month/);
  // Page order is kept and the result is the same every time.
  assert.ok(excerpt.indexOf("Launch plan") < excerpt.indexOf("Scale plan"));
  assert.equal(excerptFor(page, "AcmeDB Launch plan price per month"), excerpt);
});

test("a short page is shown whole, and a page with no matching line falls back to its top", () => {
  assert.equal(excerptFor("Pro is $25", "anything", 2500), "Pro is $25");
  const page = Array.from({ length: 200 }, (_, i) => `line ${i} ${"y".repeat(40)}`).join("\n");
  const excerpt = excerptFor(page, "zebra", 500);
  assert.ok(excerpt.startsWith("line 0 "));
  assert.ok(excerpt.length <= 500);
});

function stubContext(search: SearchResult[], pages: Record<string, string>) {
  const requested: string[][] = [];
  const reader: ReaderPort = {
    async read(urls): Promise<ReadOutcome> {
      requested.push(urls);
      const outcome: ReadOutcome = { pages: [], failures: [] };
      for (const url of urls) {
        const text = pages[url];
        if (text === undefined) outcome.failures.push({ url, reason: "failed", error: "HTTP 403" });
        else outcome.pages.push({ url, finalUrl: url, text, extractor: "fetch", publishedAt: null });
      }
      return outcome;
    },
  };
  const searchPort: SearchPort = { search: async () => ({ results: search, timedOut: false }) };
  const sources: Source[] = [];
  const statuses: string[] = [];
  const context: ToolContext = { search: searchPort, reader, clock: createClock("2026-11-21T10:00:00Z"), sources, status: (t) => statuses.push(t) };
  return { context, requested, sources, statuses };
}

const hit = (url: string, title = url): SearchResult => ({ url, title, snippet: "", publishedDate: null });

test("official pages named in urls are read directly and numbered first, ahead of blog results", async () => {
  const { context, requested, sources } = stubContext(
    [hit("https://jetadmin.io/supabase-pricing", "Supabase pricing blog"), hit("https://supabase.com/docs/billing", "Billing docs")],
    {
      "https://supabase.com/pricing": "Pro plan from $25 per month",
      "https://jetadmin.io/supabase-pricing": "A blog says Pro costs $25",
    },
  );
  const result = await runWebSearch(context, JSON.stringify({ queries: ["Supabase Pro price"], urls: ["https://supabase.com/pricing"] }));

  assert.deepEqual(sources.map((s) => [s.n, s.url]), [
    [1, "https://supabase.com/pricing"],
    [2, "https://jetadmin.io/supabase-pricing"],
  ]);
  assert.match(result, /\[1\] https:\/\/supabase\.com\/pricing/);
  // The search hit on the same domain as the official page is not read a second time.
  assert.ok(!requested.flat().includes("https://supabase.com/docs/billing"));
});

test("a direct page that cannot be read is reported as unreadable, not dropped", async () => {
  const { context } = stubContext([], { "https://neon.com/pricing": "Launch $19" });
  const result = await runWebSearch(context, JSON.stringify({ queries: ["Neon price"], urls: ["https://neon.com/pricing", "https://supabase.com/pricing"] }));
  assert.match(result, /\[1\] https:\/\/neon\.com\/pricing/);
  assert.match(result, /Could not read https:\/\/supabase\.com\/pricing \(failed: HTTP 403\)\. Treat it as unreadable/);
});

test("only 3 direct urls are used, bad ones are ignored, and the model sees excerpts not whole pages", async () => {
  const big = longPricingPage();
  const pages: Record<string, string> = {};
  for (const name of ["a", "b", "c", "d"]) pages[`https://${name}.dev/pricing`] = big;
  const { context, requested } = stubContext([], pages);
  const urls = ["ftp://x.dev/file", "not a url", "https://a.dev/pricing", "https://b.dev/pricing", "https://c.dev/pricing", "https://d.dev/pricing"];
  const result = await runWebSearch(context, JSON.stringify({ queries: ["pricing per month"], urls }));

  assert.deepEqual(requested[0], ["https://a.dev/pricing", "https://b.dev/pricing", "https://c.dev/pricing"]);
  assert.ok(!result.includes("https://d.dev"));
  assert.ok(result.length < 3 * (EXCERPT_CAP_CHARS + 300));
  assert.match(result, /excerpt of \d+ characters/);
  assert.equal(MAX_PAGES_READ, 3);
});

test("at most 3 search pages are read when no urls are given", async () => {
  const results = ["a", "b", "c", "d", "e"].map((n) => hit(`https://${n}.dev/page`));
  const pages = Object.fromEntries(results.map((r) => [r.url, "text"]));
  const { context, requested } = stubContext(results, pages);
  await runWebSearch(context, JSON.stringify({ queries: ["anything"] }));
  assert.equal(requested.flat().length, 3);
});

test("when every line matches, the excerpt still stops at the cap and fills most of it", () => {
  const page = Array.from({ length: 300 }, (_, i) => `Pricing detail ${i}: the plan costs money ${"z".repeat(50)}`).join("\n");
  const excerpt = excerptFor(page, "plan pricing");
  assert.ok(excerpt.length <= EXCERPT_CAP_CHARS);
  assert.ok(excerpt.length > EXCERPT_CAP_CHARS * 0.8);
});

test("for a price question the excerpt keeps an amount on its own line and the plan name above it", () => {
  // Every prose line is 124 characters, so exactly 20 of them fill the 2500-character budget.
  const prose = (i: number) => `Pro plan details ${i}: the Pro plan includes support and projects `.padEnd(124, "w");
  const lines = Array.from({ length: 60 }, (_, i) => prose(i));
  lines.splice(30, 0, "### Pro", "For production applications.", "From", "$25", "*", "/ month");
  const page = lines.join("\n");

  const excerpt = excerptFor(page, "Supabase Pro plan price");
  assert.ok(excerpt.length <= EXCERPT_CAP_CHARS);
  const kept = excerpt.split("\n");
  assert.ok(kept.includes("$25"));
  assert.ok(kept.includes("### Pro"));
  assert.ok(kept.includes("/ month"));
  assert.ok(!kept.includes("*"));
  assertQuotable(page, excerpt);
});

test("text left out of an excerpt is marked, so a quote cannot be stitched across it", () => {
  // "/ month" appears three times; only the first copy is kept, which leaves a hole after "$25".
  const page = [
    ...Array.from({ length: 40 }, (_, i) => `intro ${i} ${"i".repeat(60)}`),
    "### Free", "$0", "/ month",
    "### Pro", "$25", "/ month", "First project included.",
    ...Array.from({ length: 40 }, (_, i) => `outro ${i} ${"o".repeat(60)}`),
  ].join("\n");
  const excerpt = excerptFor(page, "Pro plan price");
  const shown = excerpt.split("\n");
  assert.ok(shown.includes("$25"));
  assert.equal(shown[shown.indexOf("$25") + 1], GAP);
  assertQuotable(page, excerpt);
});

test("bare bullets and repeated table cells do not use up the excerpt", () => {
  const filler = Array.from({ length: 300 }, (_, i) => `padding row ${i} ${"p".repeat(50)}`);
  const page = ["*", "|---|", ...Array.from({ length: 50 }, () => "Custom plan"), ...filler].join("\n");
  const lines = excerptFor(page, "custom plan").split("\n");
  assert.equal(lines.filter((line) => line === "Custom plan").length, 1);
  assert.ok(!lines.includes("*") && !lines.includes("|---|"));
});

test("a line that was shortened is followed by a marker, not by the next line as if it continued", () => {
  const page = [
    ...Array.from({ length: 30 }, (_, i) => `padding ${i} ${"p".repeat(70)}`),
    `Pro plan ${"very long description ".repeat(30)}`,
    "Pro costs $25",
  ].join("\n");
  const shown = excerptFor(page, "Pro plan price").split("\n");
  const next = shown[shown.findIndex((line) => line.startsWith("Pro plan ")) + 1];
  assert.equal(next, GAP);
});

test("the gap markers count towards the cap", () => {
  // Every other line matches, so every kept line is preceded by a marker.
  const page = Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? `plan row ${i} ${"m".repeat(40)}` : `unrelated ${i} ${"u".repeat(40)}`)).join("\n");
  const excerpt = excerptFor(page, "plan");
  assert.ok(excerpt.includes(GAP));
  assert.ok(excerpt.length <= EXCERPT_CAP_CHARS);
});
