// Recheck, lane B: "did any of these vendors ship something big since T?" Each vendor's own
// feed is read (no model call: dated items after T are events), and one date-filtered web
// search adds what the feed missed. An event needs a date after T from the vendor's own
// domain; anything else is listed as unconfirmed.
import type { WebMode } from "./config.ts";
import type { Database } from "./db.ts";
import { hasFixture, readFixture, writeFixture } from "./fixtures.ts";
import { createLogger } from "./log.ts";
import { runLimited, RECHECK_CONCURRENCY } from "./recheck.ts";
import type { SearchPort, SearchResult } from "./search.ts";

const log = createLogger("discovery");

export const FEED_TIMEOUT_MS = 3000;
export const FEED_PATHS = ["/changelog/rss.xml", "/changelog/feed.xml", "/blog/rss.xml", "/rss.xml", "/feed", "/feed.xml", "/atom.xml", "/blog/feed"];
const FEED_RETRY_DAYS = 7; // a vendor with no feed found is probed again after this long
const MAX_FEED_ITEMS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export type EventKind = "pricing" | "launch" | "acquisition" | "shutdown";

export interface EventRow {
  entity: string;
  title: string;
  url: string;
  publishedAt: string | null; // null: the source gave no date, so it may predate T
  kind: EventKind;
  source: "feed" | "search";
  confirmed: boolean;
}

export interface DiscoveryResult {
  events: EventRow[];
  minorCount: number; // items after T that matched no kind
  feedsChecked: number; // feeds that were found and read
  feedsUnreachable: number; // a feed was known, but did not answer this time
  entitiesWithoutFeed: number; // no vendor domain, or no feed at any of the usual paths
  searchesFailed: number;
}

export interface FeedPort {
  get(url: string, timeoutMs: number): Promise<string | null>; // the body, or null for any failure
}

export interface DiscoveryDeps {
  db: Database;
  search: SearchPort;
  feeds: FeedPort;
  now: () => Date;
}

// live reads the network; record does too and keeps every feed it found; replay answers from those
// saved feeds and treats everything else as not found, which is what a vendor with no feed looks like.
export function createFeedPort(mode: WebMode, fixturesDir = "fixtures/web"): FeedPort {
  const live: FeedPort = {
    async get(url, timeoutMs) {
      try {
        const response = await fetch(url, {
          headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
        });
        return response.ok ? await response.text() : null;
      } catch {
        return null;
      }
    },
  };
  if (mode === "live") return live;
  if (mode === "record") {
    return {
      async get(url, timeoutMs) {
        const body = await live.get(url, timeoutMs);
        if (body !== null && looksLikeFeed(body)) writeFixture(fixturesDir, "feed", { url }, { body });
        return body;
      },
    };
  }
  return {
    async get(url) {
      if (!hasFixture(fixturesDir, "feed", { url })) return null;
      return readFixture<{ body: string }>(fixturesDir, "feed", { url }).body;
    },
  };
}

export interface EntityRow {
  id: number;
  name: string;
  domain: string | null;
  feedUrl: string | null;
  feedCheckedAt: string | null;
}

// Entities a turn discussed (its shortlist, including ones with no claim) and/or entities named directly.
export function loadEntities(db: Database, selector: { turnIds?: number[]; names?: string[] }): EntityRow[] {
  const ids = new Set<number>();
  const byTurn = db.prepare("SELECT entity_id AS id FROM turn_entities WHERE turn_id = ?");
  // A question's entities are stored under the answer that follows it, so both ids are looked up.
  for (const turnId of selector.turnIds ?? []) {
    for (const id of [turnId, turnId + 1]) for (const row of byTurn.all(id) as { id: number }[]) ids.add(row.id);
  }
  const byName = db.prepare("SELECT id FROM entities WHERE name = ? COLLATE NOCASE");
  for (const name of selector.names ?? []) {
    for (const row of byName.all(name.trim()) as { id: number }[]) ids.add(row.id);
  }
  const load = db.prepare("SELECT id, name, domain, feed_url, feed_checked_at FROM entities WHERE id = ?");
  return [...ids]
    .sort((a, b) => a - b)
    .flatMap((id) => {
      const row = load.get(id) as { id: number; name: string; domain: string | null; feed_url: string | null; feed_checked_at: string | null } | undefined;
      return row ? [{ id: row.id, name: row.name, domain: row.domain, feedUrl: row.feed_url, feedCheckedAt: row.feed_checked_at }] : [];
    });
}

export async function discoverEvents(
  deps: DiscoveryDeps,
  entities: EntityRow[],
  since: Date,
  emit: (event: EventRow) => void = () => {},
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { events: [], minorCount: 0, feedsChecked: 0, feedsUnreachable: 0, entitiesWithoutFeed: 0, searchesFailed: 0 };
  const insert = deps.db.prepare(
    "INSERT OR IGNORE INTO events (entity_id, title, url, published_at, kind, source, confirmed) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  await runLimited(
    entities.map((entity) => async () => {
      const found = await discoverForEntity(deps, entity, since, result);
      for (const event of found) {
        insert.run(entity.id, event.title, event.url, event.publishedAt, event.kind, event.source, event.confirmed ? 1 : 0);
        result.events.push(event);
        emit(event);
      }
    }),
    RECHECK_CONCURRENCY,
  );
  log.info("discovery done", { entities: entities.length, events: result.events.length, minor: result.minorCount });
  return result;
}

async function discoverForEntity(deps: DiscoveryDeps, entity: EntityRow, since: Date, totals: DiscoveryResult): Promise<EventRow[]> {
  // Without the vendor's own domain there is nowhere to look for a feed and no way to tell its site from a blog.
  if (!entity.domain) {
    totals.entitiesWithoutFeed += 1;
    return [];
  }
  const [feedEvents, searchEvents] = await Promise.all([
    feedLane(deps, entity, entity.domain, since, totals),
    searchLane(deps, entity, entity.domain, since, totals),
  ]);
  const seen = new Set(feedEvents.map((event) => event.url));
  return [...feedEvents, ...searchEvents.filter((event) => !seen.has(event.url))];
}

async function feedLane(deps: DiscoveryDeps, entity: EntityRow, domain: string, since: Date, totals: DiscoveryResult): Promise<EventRow[]> {
  const found = await findFeed(deps, entity, domain);
  if (found.state === "none") {
    totals.entitiesWithoutFeed += 1;
    return [];
  }
  if (found.state === "unreachable") {
    totals.feedsUnreachable += 1;
    return [];
  }
  totals.feedsChecked += 1;

  const events: EventRow[] = [];
  for (const item of parseFeed(found.body)) {
    if (item.date !== null && new Date(item.date).getTime() <= since.getTime()) continue; // older than T
    const kind = classify(item.title);
    if (!kind) {
      totals.minorCount += 1;
      continue;
    }
    // Undated items are kept, with a null date, so the answer can say "undated, may predate".
    events.push({ entity: entity.name, title: item.title, url: item.link, publishedAt: item.date, kind, source: "feed", confirmed: true });
  }
  return events;
}

type FeedFound = { state: "found"; body: string } | { state: "none" } | { state: "unreachable" };

async function findFeed(deps: DiscoveryDeps, entity: EntityRow, domain: string): Promise<FeedFound> {
  if (entity.feedUrl) {
    const body = await deps.feeds.get(entity.feedUrl, FEED_TIMEOUT_MS);
    return body && looksLikeFeed(body) ? { state: "found", body } : { state: "unreachable" };
  }
  const probedAt = entity.feedCheckedAt ? new Date(entity.feedCheckedAt).getTime() : null;
  if (probedAt !== null && deps.now().getTime() - probedAt < FEED_RETRY_DAYS * DAY_MS) return { state: "none" };

  const candidates = FEED_PATHS.map((path) => `https://${domain}${path}`);
  const bodies = await Promise.all(candidates.map((url) => deps.feeds.get(url, FEED_TIMEOUT_MS)));
  const index = bodies.findIndex((body) => body !== null && looksLikeFeed(body));
  deps.db
    .prepare("UPDATE entities SET feed_url = ?, feed_checked_at = ? WHERE id = ?")
    .run(index === -1 ? null : (candidates[index] as string), deps.now().toISOString(), entity.id);
  return index === -1 ? { state: "none" } : { state: "found", body: bodies[index] as string };
}

function looksLikeFeed(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes("<rss") || lower.includes("<feed");
}

export interface FeedItem {
  title: string;
  link: string;
  date: string | null; // ISO, or null when the item has no date or one that does not parse
}

// Not a full XML parser: it reads <item> (RSS) and <entry> (Atom) blocks, which is all a feed needs here.
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const match of xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)) {
    const block = match[0];
    const title = textOf(block, "title");
    const link = linkOf(block);
    if (!title || !link) continue;
    items.push({ title, link, date: dateOf(block) });
    if (items.length === MAX_FEED_ITEMS) break;
  }
  return items;
}

function textOf(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (!match) return null;
  const withoutCdata = (match[1] as string).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const cleaned = decodeEntities(withoutCdata.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return cleaned === "" ? null : cleaned;
}

function linkOf(block: string): string | null {
  // Atom: <link rel="alternate" href="..."/>; a link with no rel is the page too.
  for (const match of block.matchAll(/<link\b([^>]*)>/gi)) {
    const attributes = match[1] as string;
    const href = /href=["']([^"']+)["']/i.exec(attributes)?.[1];
    const rel = /rel=["']([^"']+)["']/i.exec(attributes)?.[1];
    if (href && (!rel || rel === "alternate")) return decodeEntities(href);
  }
  return textOf(block, "link") ?? textOf(block, "guid");
}

function dateOf(block: string): string | null {
  for (const tag of ["pubDate", "published", "updated", "dc:date"]) {
    const text = textOf(block, tag);
    if (!text) continue;
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&"); // last, so "&amp;lt;" ends as "&lt;"
}

// First kind with a matching rule wins, in this order. "GA" is an acronym only in capitals, so it is its own case-sensitive rule.
const KIND_RULES: [EventKind, RegExp[]][] = [
  ["pricing", [/\b(price|prices|pricing|plan|plans|billing|tier|tiers)\b/i]],
  ["launch", [/\b(launch\w*|introducing|now available|general availability|releas\w+)\b/i, /\bGA\b/]],
  ["acquisition", [/\b(acquir\w+|acquisition|joins|merger)\b/i]],
  ["shutdown", [/\b(shut ?down|sunset\w*|deprecat\w*|end of life)\b/i]],
];

export function classify(text: string): EventKind | null {
  for (const [kind, patterns] of KIND_RULES) {
    if (patterns.some((pattern) => pattern.test(text))) return kind;
  }
  return null;
}

async function searchLane(deps: DiscoveryDeps, entity: EntityRow, domain: string, since: Date, totals: DiscoveryResult): Promise<EventRow[]> {
  let results: SearchResult[];
  try {
    const outcome = await deps.search.search({
      query: `${entity.name} pricing OR launch OR release`,
      startDate: since.toISOString().slice(0, 10),
      filterByPublishedDate: true,
    });
    if (outcome.timedOut) {
      totals.searchesFailed += 1;
      return [];
    }
    results = outcome.results.slice(0, 5);
    log.info("discovery search", { entity: entity.name, results: results.length, dated: results.filter((result) => result.publishedDate !== null).length });
  } catch (error) {
    log.warn("discovery search failed", { entity: entity.name, message: error instanceof Error ? error.message : String(error) });
    totals.searchesFailed += 1;
    return [];
  }

  const events: EventRow[] = [];
  for (const result of results) {
    const date = result.publishedDate;
    if (date !== null && new Date(date).getTime() <= since.getTime()) continue;
    // Title only: a snippet is a window of page text, and one stray "launch" in it made a docs page a launch.
    const kind = classify(result.title);
    if (!kind) {
      totals.minorCount += 1;
      continue;
    }
    // Confirmed needs the vendor's own domain; a title-matched result from anyone else is a lead, not an announcement.
    const confirmed = isVendorHost(hostOf(result.url), domain);
    events.push({ entity: entity.name, title: result.title, url: result.url, publishedAt: date, kind, source: "search", confirmed });
  }
  return events;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isVendorHost(host: string, vendorDomain: string): boolean {
  return host === vendorDomain || host.endsWith(`.${vendorDomain}`);
}

export interface Coverage {
  pages_checked: number;
  pages_unreachable: number;
  feeds_checked: number;
  entities_without_feed: number;
  feeds_unreachable: number;
  searches_failed: number;
  llm_calls: number;
  pricing_only: boolean; // every claim rechecked was a price
}

// "checked 5 pricing pages, 4 changelogs; 1 unreachable; 0 model calls"
export function describeCoverage(coverage: Coverage): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const page = coverage.pricing_only ? "pricing page" : "page";
  const parts = [`checked ${plural(coverage.pages_checked, page, `${page}s`)}, ${plural(coverage.feeds_checked, "changelog", "changelogs")}`];
  const unreachable = coverage.pages_unreachable + coverage.feeds_unreachable;
  if (unreachable > 0) parts.push(`${unreachable} unreachable`);
  if (coverage.entities_without_feed > 0) parts.push(`no changelog found for ${coverage.entities_without_feed}`);
  if (coverage.searches_failed > 0) parts.push(`${plural(coverage.searches_failed, "search", "searches")} failed`);
  parts.push(plural(coverage.llm_calls, "model call", "model calls"));
  return parts.join("; ");
}
