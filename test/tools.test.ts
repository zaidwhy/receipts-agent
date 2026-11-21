import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createClock } from "../src/clock.ts";
import { EXCERPT_CAP_CHARS, excerptFor } from "../src/excerpt.ts";
import type { ReaderPort, ReadOutcome } from "../src/reader.ts";
import type { SearchPort, SearchResult } from "../src/search.ts";
import { MAX_PAGES_READ, runWebSearch, type Source, type ToolContext } from "../src/tools.ts";

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
  const pageLines = new Set(page.split("\n"));
  for (const line of excerpt.split("\n")) assert.ok(pageLines.has(line), `not a line of the page: ${line}`);
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
  assert.ok(excerpt.length > EXCERPT_CAP_CHARS * 0.9);
});
