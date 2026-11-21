// Records the seed fixture once: for each pricing page, the Internet Archive capture closest
// before the date the seeded question was "asked", read through the same reader the app uses.
// Run: npx tsx scripts/record-seed.ts   (needs TAVILY_API_KEY; the result is committed)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createClock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import { loadEnvIfPresent } from "../src/env.ts";
import { createReader } from "../src/reader.ts";
import { captureInstant, planSeed, SEED_FIXTURE_PATH, type SeedCapture, type SeedDay, type SeedFixture, type SeedPage } from "../src/seed.ts";

loadEnvIfPresent();
const config = loadConfig(process.env);
const timeZone = process.env.SEED_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const now = createClock().now();
const plan = planSeed(now, timeZone);

const PAGES: { entity: string; day: SeedDay; path: string }[] = [
  { entity: "HubSpot", day: "monday", path: "hubspot.com/pricing/sales" },
  { entity: "Pipedrive", day: "monday", path: "pipedrive.com/en/pricing" },
  { entity: "Salesforce", day: "monday", path: "salesforce.com/sales/pricing/" },
  { entity: "Zoho", day: "monday", path: "zoho.com/crm/zohocrm-pricing.html" },
  { entity: "Attio", day: "monday", path: "attio.com/pricing" },
  { entity: "Neon", day: "tuesday", path: "neon.com/pricing" },
  { entity: "Supabase", day: "tuesday", path: "supabase.com/pricing" },
  { entity: "Render", day: "tuesday", path: "render.com/pricing" },
];

const stamp = (date: Date) => date.toISOString().replace(/[-:T]/g, "").slice(0, 14);

interface Found {
  timestamp: string;
  original: string;
  lookup: string;
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

// The availability API returns the closest capture on either side; one after the cutoff would be a
// page the seeded answer could not have read, so then the CDX index gives the last one before it.
async function findCapture(path: string, cutoff: Date): Promise<Found | null> {
  const available = await getJson(`https://archive.org/wayback/available?url=${encodeURIComponent(path)}&timestamp=${stamp(cutoff).slice(0, 8)}`);
  const closest = available?.archived_snapshots?.closest;
  if (closest?.available && closest.timestamp <= stamp(cutoff)) {
    return { timestamp: closest.timestamp, original: closest.url.replace(/^https?:\/\/web\.archive\.org\/web\/\d+\//, ""), lookup: "wayback/available" };
  }
  const rows: string[][] = await getJson(
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(path)}&to=${stamp(cutoff)}&output=json&limit=-1&filter=statuscode:200`,
  );
  const last = rows[rows.length - 1];
  if (!last || last[1] === "timestamp") return null;
  return {
    timestamp: last[1] as string,
    original: last[2] as string,
    lookup: closest?.available ? `cdx (available API returned ${closest.timestamp}, after the cutoff)` : "cdx (available API returned nothing)",
  };
}

const reader = createReader({ mode: "live", tavilyApiKey: config.tavilyApiKey, fixturesDir: "unused" });

async function readCapture(found: Found): Promise<SeedCapture | { error: string }> {
  const archiveUrl = `https://web.archive.org/web/${found.timestamp}/${found.original}`;
  const viaTavily = await reader.read([archiveUrl], { extractor: "tavily-basic" });
  const tavilyPage = viaTavily.pages[0];
  if (tavilyPage && tavilyPage.text.length >= 1500) {
    return { timestamp: found.timestamp, archiveUrl, extractor: "tavily-basic", text: tavilyPage.text };
  }
  const rawUrl = `https://web.archive.org/web/${found.timestamp}id_/${found.original}`;
  const viaFetch = await reader.read([rawUrl], { extractor: "fetch" });
  const fetched = viaFetch.pages[0];
  if (fetched) return { timestamp: found.timestamp, archiveUrl: rawUrl, extractor: "fetch", text: fetched.text };
  const why = [...viaTavily.failures, ...viaFetch.failures].map((failure) => failure.error).join("; ");
  return { error: `tavily gave ${tavilyPage ? `${tavilyPage.text.length} chars` : "nothing"}; fetch failed: ${why || "no text"}` };
}

const pages: SeedPage[] = [];
for (const spec of PAGES) {
  const cutoff = spec.day === "monday" ? plan.monday : plan.tuesday;
  const base = { entity: spec.entity, day: spec.day, cutoff: cutoff.toISOString() };
  const found = await findCapture(spec.path, cutoff);
  if (!found) {
    pages.push({ ...base, liveUrl: `https://${spec.path}`, lookup: "none", capture: null, miss: "no capture at or before the cutoff" });
    console.log(`${spec.entity}: no capture before ${base.cutoff}`);
    continue;
  }
  const liveUrl = found.original.replace(/^http:/, "https:");
  const read = await readCapture(found);
  // A capture of a page that is drawn by script holds no prices (HubSpot's does not), so it cannot back a claim.
  if (!("error" in read) && !/[$€£₹]\s?\d/.test(read.text)) {
    pages.push({ ...base, liveUrl, lookup: found.lookup, capture: null, miss: `capture ${found.timestamp} exists but its text has no price (${read.extractor} gave ${read.text.length} characters)` });
    console.log(`${spec.entity}: capture ${found.timestamp} has no price in its text`);
    continue;
  }
  if ("error" in read) {
    pages.push({ ...base, liveUrl, lookup: found.lookup, capture: null, miss: `capture ${found.timestamp} could not be read: ${read.error}` });
    console.log(`${spec.entity}: capture ${found.timestamp} unreadable: ${read.error}`);
    continue;
  }
  pages.push({ ...base, liveUrl, lookup: found.lookup, capture: read, miss: null });
  console.log(`${spec.entity}: ${captureInstant(found.timestamp)} via ${found.lookup}; ${read.extractor}, ${read.text.length} chars`);
}

const fixture: SeedFixture = { recordedAt: now.toISOString(), timeZone, pages };
mkdirSync(dirname(SEED_FIXTURE_PATH), { recursive: true });
writeFileSync(SEED_FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${SEED_FIXTURE_PATH}`);
