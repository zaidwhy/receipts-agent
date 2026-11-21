import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, describeCoverage, discoverEvents, FEED_PATHS, loadEntities, parseFeed, type DiscoveryDeps, type FeedPort } from "../src/discovery.ts";
import type { Database } from "../src/db.ts";
import type { SearchResult } from "../src/search.ts";
import { count, FakeSearch, memoryDb, seedExchange } from "./helpers.ts";

const NOW = new Date("2026-11-21T10:00:00Z");
const SINCE = new Date("2026-11-17T00:00:00Z");

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Acme changelog</title>
  <item><title>Introducing Autoscaling v2</title><link>https://acmedb.dev/changelog/autoscaling-v2</link><pubDate>Wed, 18 Nov 2026 09:00:00 GMT</pubDate></item>
  <item><title><![CDATA[New pricing & plans for teams]]></title><link>https://acmedb.dev/changelog/new-pricing</link><pubDate>Fri, 20 Nov 2026 09:00:00 GMT</pubDate></item>
  <item><title>Pricing update for the Launch plan</title><link>https://acmedb.dev/changelog/old-pricing</link><pubDate>Mon, 02 Nov 2026 09:00:00 GMT</pubDate></item>
  <item><title>Fixed a typo in the docs</title><link>https://acmedb.dev/changelog/typo</link><pubDate>Thu, 19 Nov 2026 09:00:00 GMT</pubDate></item>
  <item><title>Sunsetting the v1 API</title><link>https://acmedb.dev/changelog/sunset</link></item>
</channel></rss>`;

class FakeFeeds implements FeedPort {
  requested: string[] = [];
  constructor(private bodies: Record<string, string>) {}
  async get(url: string): Promise<string | null> {
    this.requested.push(url);
    return this.bodies[url] ?? null;
  }
}

function seedEntity(db: Database, name = "AcmeDB", url = "https://www.acmedb.dev/pricing"): void {
  seedExchange(db, {
    question: `What does ${name} cost?`,
    answer: "Pro is $19.",
    askedAt: "2026-11-17T04:00:00.000Z",
    entities: [name],
    claims: [{ text: `${name} Pro $19`, kind: "price", entity: name, quote: "Pro $19", url, page: `${name} Pro $19 per month`, fetchedAt: "2026-11-17T04:00:04.000Z" }],
  });
}

const deps = (db: Database, feeds: FeedPort, search = new FakeSearch()): DiscoveryDeps => ({ db, feeds, search, now: () => NOW });
const result = (url: string, title: string, snippet = "", publishedDate: string | null = "2026-11-19T00:00:00.000Z"): SearchResult => ({ url, title, snippet, publishedDate });

test("a feed yields only items after T, an undated item is labelled, and a minor item is counted not listed", async () => {
  const db = memoryDb();
  seedEntity(db);
  const feeds = new FakeFeeds({ "https://acmedb.dev/changelog/rss.xml": RSS });
  const found = await discoverEvents(deps(db, feeds), loadEntities(db, { names: ["AcmeDB"] }), SINCE);

  const titles = found.events.map((event) => event.title);
  assert.deepEqual(titles, ["Introducing Autoscaling v2", "New pricing & plans for teams", "Sunsetting the v1 API"]);
  assert.ok(!titles.includes("Pricing update for the Launch plan")); // 2 Nov is before T
  assert.equal(found.minorCount, 1); // the typo fix
  assert.deepEqual(found.events.map((event) => event.kind), ["launch", "pricing", "shutdown"]);
  const undated = found.events.find((event) => event.title.startsWith("Sunsetting"));
  assert.equal(undated?.publishedAt, null);
  assert.equal(found.events[0]?.publishedAt, "2026-11-18T09:00:00.000Z");
  assert.ok(found.events.every((event) => event.source === "feed" && event.confirmed));
  assert.equal(found.feedsChecked, 1);
  assert.equal(count(db, "events"), 3);
});

test("the feed is found by trying every usual path at once, and remembered", async () => {
  const db = memoryDb();
  seedEntity(db);
  const feeds = new FakeFeeds({ "https://acmedb.dev/blog/rss.xml": RSS, "https://acmedb.dev/feed": "<html>not a feed</html>" });
  await discoverEvents(deps(db, feeds), loadEntities(db, { names: ["AcmeDB"] }), SINCE);
  assert.deepEqual(feeds.requested, FEED_PATHS.map((path) => `https://acmedb.dev${path}`));
  const row = db.prepare("SELECT feed_url FROM entities WHERE name = 'AcmeDB'").get() as { feed_url: string };
  assert.equal(row.feed_url, "https://acmedb.dev/blog/rss.xml");

  // The second time only the stored feed is read.
  feeds.requested = [];
  const again = await discoverEvents(deps(db, feeds), loadEntities(db, { names: ["AcmeDB"] }), SINCE);
  assert.deepEqual(feeds.requested, ["https://acmedb.dev/blog/rss.xml"]);
  assert.equal(again.events.length, 3);
});

test("no feed anywhere is counted as without a feed, and not probed again within a week", async () => {
  const db = memoryDb();
  seedEntity(db);
  const feeds = new FakeFeeds({});
  const first = await discoverEvents(deps(db, feeds), loadEntities(db, { names: ["AcmeDB"] }), SINCE);
  assert.equal(first.entitiesWithoutFeed, 1);
  assert.equal(first.feedsChecked, 0);
  assert.equal(feeds.requested.length, FEED_PATHS.length);

  feeds.requested = [];
  const second = await discoverEvents(deps(db, feeds), loadEntities(db, { names: ["AcmeDB"] }), SINCE);
  assert.equal(second.entitiesWithoutFeed, 1);
  assert.equal(feeds.requested.length, 0);
});

test("a stored feed that stops answering is unreachable, not silently empty", async () => {
  const db = memoryDb();
  seedEntity(db);
  db.prepare("UPDATE entities SET feed_url = 'https://acmedb.dev/feed.xml'").run();
  const found = await discoverEvents(deps(db, new FakeFeeds({})), loadEntities(db, { names: ["AcmeDB"] }), SINCE);
  assert.equal(found.feedsUnreachable, 1);
  assert.equal(found.entitiesWithoutFeed, 0);
});

test("an entity with no vendor domain has no feed to look at and no search is spent on it", async () => {
  const db = memoryDb();
  seedEntity(db, "Wobble", "https://blog.example.com/wobble"); // the page is not the vendor's own, so no domain is kept
  const search = new FakeSearch();
  const found = await discoverEvents(deps(db, new FakeFeeds({}), search), loadEntities(db, { names: ["Wobble"] }), SINCE);
  assert.equal(found.entitiesWithoutFeed, 1);
  assert.equal(search.queries.length, 0);
});

test("the search asks for results since T with the date filter, and sorts them into confirmed and unconfirmed", async () => {
  const db = memoryDb();
  seedEntity(db);
  const search = new FakeSearch([
    result("https://acmedb.dev/blog/launch-branching", "AcmeDB launches database branching"), // vendor's own domain
    result("https://techdaily.example/acme-raises-prices", "AcmeDB raises Pro plan price for startups", "pricing change"), // two blogs agree, still not the vendor
    result("https://newsbytes.example/acme-pro-price-startups", "Startups hit as AcmeDB raises Pro plan price"),
    result("https://lonely.example/acme-rumor", "AcmeDB acquisition rumour"), // one blog, nobody confirms
    result("https://random.example/acme-lunch", "AcmeDB team lunch photos"), // matches no kind
  ]);
  const found = await discoverEvents(deps(db, new FakeFeeds({}), search), loadEntities(db, { names: ["AcmeDB"] }), SINCE);

  assert.deepEqual(search.queries, [{ query: "AcmeDB pricing OR launch OR release", startDate: "2026-11-17", filterByPublishedDate: true }]);
  const byUrl = new Map(found.events.map((event) => [event.url, event]));
  assert.equal(byUrl.get("https://acmedb.dev/blog/launch-branching")?.confirmed, true);
  assert.equal(byUrl.get("https://techdaily.example/acme-raises-prices")?.confirmed, false);
  assert.equal(byUrl.get("https://newsbytes.example/acme-pro-price-startups")?.confirmed, false);
  assert.equal(byUrl.get("https://lonely.example/acme-rumor")?.confirmed, false);
  assert.equal(byUrl.get("https://lonely.example/acme-rumor")?.kind, "acquisition");
  assert.ok(!byUrl.has("https://random.example/acme-lunch"));
  assert.equal(found.minorCount, 1);
  assert.ok(found.events.every((event) => event.source === "search"));
});

test("a vendor docs page whose snippet says launch is not a launch: the title decides", async () => {
  const db = memoryDb();
  seedEntity(db);
  const search = new FakeSearch([
    result("https://acmedb.dev/docs/config-formats", "Configuration formats | AcmeDB Docs", "Supported file formats. Since the launch of branching you can also use TOML."),
    result("https://acmedb.dev/docs/regions", "Regions | AcmeDB Docs", "Plans differ by region."),
  ]);
  const found = await discoverEvents(deps(db, new FakeFeeds({}), search), loadEntities(db, { names: ["AcmeDB"] }), SINCE);
  assert.deepEqual(found.events, []);
  assert.equal(found.minorCount, 2);
});

test("a search result published before T, or beyond the first five, is not an event", async () => {
  const db = memoryDb();
  seedEntity(db);
  const search = new FakeSearch([
    result("https://oldnews.example/acme-launch", "AcmeDB launch", "", "2026-11-01T00:00:00.000Z"),
    result("https://acmedb.dev/a", "AcmeDB launches A"),
    result("https://acmedb.dev/b", "AcmeDB launches B"),
    result("https://acmedb.dev/c", "AcmeDB launches C"),
    result("https://acmedb.dev/d", "AcmeDB launches D"),
    result("https://acmedb.dev/e", "AcmeDB launches E"),
  ]);
  const found = await discoverEvents(deps(db, new FakeFeeds({}), search), loadEntities(db, { names: ["AcmeDB"] }), SINCE);
  assert.deepEqual(found.events.map((event) => event.url), ["https://acmedb.dev/a", "https://acmedb.dev/b", "https://acmedb.dev/c", "https://acmedb.dev/d"]);
});

test("a page found by both the feed and the search is one event", async () => {
  const db = memoryDb();
  seedEntity(db);
  const feeds = new FakeFeeds({ "https://acmedb.dev/changelog/rss.xml": RSS });
  const search = new FakeSearch([result("https://acmedb.dev/changelog/autoscaling-v2", "Introducing Autoscaling v2")]);
  const found = await discoverEvents(deps(db, feeds, search), loadEntities(db, { names: ["AcmeDB"] }), SINCE);
  assert.equal(found.events.filter((event) => event.url === "https://acmedb.dev/changelog/autoscaling-v2").length, 1);
  assert.equal(found.events.length, 3);
});

test("a failing search is counted, not hidden", async () => {
  const db = memoryDb();
  seedEntity(db);
  const failing = { search: async () => Promise.reject(new Error("HTTP 400")) };
  const found = await discoverEvents({ db, feeds: new FakeFeeds({}), search: failing, now: () => NOW }, loadEntities(db, { names: ["AcmeDB"] }), SINCE);
  assert.equal(found.searchesFailed, 1);
});

test("an Atom entry is read with its alternate link and its published date", () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Release 2.0</title>
    <link rel="self" href="https://x.example/self"/><link rel="alternate" href="https://x.example/r2"/>
    <updated>2026-11-19T10:00:00Z</updated></entry></feed>`;
  assert.deepEqual(parseFeed(atom), [{ title: "Release 2.0", link: "https://x.example/r2", date: "2026-11-19T10:00:00.000Z" }]);
});

test("titles are sorted into kinds by keyword, first matching kind wins", () => {
  assert.equal(classify("New pricing for Pro"), "pricing");
  assert.equal(classify("Billing changes"), "pricing");
  assert.equal(classify("Introducing branches"), "launch");
  assert.equal(classify("Postgres 18 is now available"), "launch");
  assert.equal(classify("Autoscaling is GA"), "launch");
  assert.equal(classify("We are acquiring Foo"), "acquisition");
  assert.equal(classify("Deprecating the v1 API"), "shutdown");
  assert.equal(classify("Sunset of legacy plans"), "pricing"); // "plans" is checked first
  assert.equal(classify("Fixed a typo"), null);
  assert.equal(classify("Gaining speed"), null); // "ga" inside a word
  assert.equal(classify("Meet Ga from support"), null); // "GA" counts only in capitals
  assert.equal(classify("Planetary scale"), null);
});

test("the coverage line says what was checked and what was not", () => {
  const base = { pages_checked: 5, pages_unreachable: 1, feeds_checked: 4, entities_without_feed: 0, feeds_unreachable: 0, searches_failed: 0, llm_calls: 0, pricing_only: true };
  assert.equal(describeCoverage(base), "checked 5 pricing pages, 4 changelogs; 1 unreachable; 0 model calls");
  assert.equal(
    describeCoverage({ ...base, pages_checked: 1, feeds_checked: 1, pages_unreachable: 0, feeds_unreachable: 1, entities_without_feed: 2, llm_calls: 1, pricing_only: false }),
    "checked 1 page, 1 changelog; 1 unreachable; no changelog found for 2; 1 model call",
  );
});
