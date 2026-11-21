// Record and replay helpers shared by search.ts and reader.ts.
// A fixture is one JSON file named after a hash of the request, so the same
// request always finds the same file.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FixtureKind = "search" | "page" | "feed";

// What replay did, so an eval can say how much of a run came from exact fixtures.
export const replayStats = { searchExact: 0, searchNearest: 0, pageHit: 0, pageMiss: 0 };

// Tavily calls made in this process, so a run can say roughly how many credits it spent.
export const liveUsage = { searches: 0, extractCalls: 0, extractUrls: 0 };

export function resetReplayStats(): void {
  replayStats.searchExact = 0;
  replayStats.searchNearest = 0;
  replayStats.pageHit = 0;
  replayStats.pageMiss = 0;
}

export function fixturePath(dir: string, kind: FixtureKind, request: object): string {
  const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 16);
  return join(dir, `${kind}-${hash}.json`);
}

export function writeFixture(dir: string, kind: FixtureKind, request: object, response: object): void {
  mkdirSync(dir, { recursive: true });
  const file = fixturePath(dir, kind, request);
  writeFileSync(file, JSON.stringify({ request, response }, null, 2) + "\n");
}

// A miss is an error on purpose: silently returning nothing would hide a stale fixture set.
export function readFixture<T>(dir: string, kind: FixtureKind, request: object): T {
  const file = fixturePath(dir, kind, request);
  if (!existsSync(file)) {
    throw new Error(
      `replay mode has no fixture for ${kind} request ${JSON.stringify(request)} (expected ${file}). ` +
        `Run once with WEB_MODE=record to create it.`,
    );
  }
  const saved = JSON.parse(readFileSync(file, "utf8")) as { response: T };
  return saved.response;
}

export function hasFixture(dir: string, kind: FixtureKind, request: object): boolean {
  return existsSync(fixturePath(dir, kind, request));
}

// A real model words its queries a little differently on every run, so replay with a live model would
// miss exact fixtures. The recorded search with the same date filters and the most words in common
// (at least half of both sets) stands in for it. No such search is still a loud miss.
export function readNearestSearchFixture<T>(dir: string, request: { query: string; start_date: string | null; end_date: string | null; filter_by_published_date?: boolean }, terms: (query: string) => string[]): T | null {
  if (!existsSync(dir)) return null;
  const wanted = new Set(terms(request.query));
  let best: { score: number; response: T } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("search-") || !name.endsWith(".json")) continue;
    const saved = JSON.parse(readFileSync(join(dir, name), "utf8")) as { request: typeof request; response: T };
    const other = saved.request;
    if (other.start_date !== request.start_date || other.end_date !== request.end_date) continue;
    if (Boolean(other.filter_by_published_date) !== Boolean(request.filter_by_published_date)) continue;
    const theirs = new Set(terms(other.query));
    const shared = [...wanted].filter((word) => theirs.has(word)).length;
    const score = shared / Math.max(wanted.size, theirs.size, 1);
    if (score >= 0.5 && (!best || score > best.score)) best = { score, response: saved.response };
  }
  return best?.response ?? null;
}
