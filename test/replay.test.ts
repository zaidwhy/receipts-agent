import "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFeedPort } from "../src/discovery.ts";
import { fixtureRequest } from "../src/search.ts";
import { replayStats, resetReplayStats, writeFixture } from "../src/fixtures.ts";
import { createReader } from "../src/reader.ts";
import { createSearch } from "../src/search.ts";

function withDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "minimi-replay-"));
  // craft-guard: allow test-force because this is rmSync removing a temp folder, not a forced browser click
  return work(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const outcome = (url: string) => ({ results: [{ url, title: "Supabase Pricing", snippet: "", publishedDate: null }], timedOut: false });

test("replay answers a slightly reworded query from the closest recorded search, and counts it", () =>
  withDir(async (dir) => {
    resetReplayStats();
    writeFixture(dir, "search", fixtureRequest({ query: "Supabase Pro plan price per month" }), outcome("https://supabase.com/pricing"));
    const search = createSearch({ mode: "replay", tavilyApiKey: undefined, fixturesDir: dir });

    const exact = await search.search({ query: "Supabase Pro plan price per month" });
    const reworded = await search.search({ query: "Supabase Pro pricing per month plan" });
    assert.equal(reworded.results[0]?.url, "https://supabase.com/pricing");
    assert.deepEqual(exact, reworded);
    assert.equal(replayStats.searchExact, 1);
    assert.equal(replayStats.searchNearest, 1);

    // A different topic, or the same words under a different date filter, is still a loud miss.
    await assert.rejects(() => search.search({ query: "Postgres hosting comparison" }), /no fixture for search request/);
    await assert.rejects(() => search.search({ query: "Supabase Pro plan price per month", startDate: "2026-11-16" }), /no fixture for search request/);
  }));

test("replay fails one unrecorded page, not the whole read, and a recheck read has its own recording", () =>
  withDir(async (dir) => {
    resetReplayStats();
    const page = { url: "https://supabase.com/pricing", finalUrl: "https://supabase.com/pricing", text: "Pro $25", extractor: "tavily-basic", publishedAt: null };
    writeFixture(dir, "page", { url: page.url }, { ok: true, page });
    writeFixture(dir, "page", { url: page.url, extractor: "fetch" }, { ok: true, page: { ...page, text: "Pro $30", extractor: "fetch" } });
    const reader = createReader({ mode: "replay", tavilyApiKey: undefined, fixturesDir: dir });

    const read = await reader.read([page.url, "https://render.com/pricing"]);
    assert.deepEqual(read.pages.map((found) => found.text), ["Pro $25"]);
    assert.equal(read.failures.length, 1);
    assert.equal(read.failures[0]?.url, "https://render.com/pricing");

    const recheck = await reader.read([page.url], { extractor: "fetch" });
    assert.equal(recheck.pages[0]?.text, "Pro $30");
    assert.equal(replayStats.pageMiss, 1);
  }));

test("replay finds a feed that was recorded and treats every other address as no feed", () =>
  withDir(async (dir) => {
    writeFixture(dir, "feed", { url: "https://neon.com/blog/rss.xml" }, { body: "<rss><channel></channel></rss>" });
    const feeds = createFeedPort("replay", dir);
    assert.equal(await feeds.get("https://neon.com/blog/rss.xml", 1000), "<rss><channel></channel></rss>");
    assert.equal(await feeds.get("https://neon.com/feed", 1000), null);
  }));
