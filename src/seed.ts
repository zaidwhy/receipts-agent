// Demo history: three past conversations dated relative to the clock, so a reviewer who starts
// with an empty database can ask "has any of that changed since Monday?". Every page behind a
// seeded claim is a real Internet Archive capture (see scripts/record-seed.ts); no price here
// is typed by hand. A page with no capture gets no claims and shows up as unanchored.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { storeClaims, type ReceiptClaim, type SnapshotRef } from "./claims.ts";
import { insertTurn, type Database } from "./db.ts";
import { normalizeText, anchorQuote, saveSnapshot } from "./receipts.ts";
import { resolveDates } from "./temporal.ts";

export const SEED_FIXTURE_PATH = fileURLToPath(new URL("../fixtures/seed/captures.json", import.meta.url));
const HOUR_MS = 60 * 60 * 1000;
const ANSWER_DELAY_MS = 8000;
const SEED_HOUR = 10; // the local hour the seeded questions were "asked"
export const ARCHIVE_PREFIX = "https://web.archive.org/";

export type SeedDay = "monday" | "tuesday";

export interface SeedCapture {
  timestamp: string; // the capture's own time, YYYYMMDDHHMMSS in UTC
  archiveUrl: string; // the URL the text was read from
  extractor: "tavily-basic" | "fetch";
  text: string;
}

// One page per entity. A page with no capture keeps the reason in `miss`.
export interface SeedPage {
  entity: string;
  day: SeedDay;
  liveUrl: string;
  cutoff: string; // ISO instant: only captures at or before it were eligible
  lookup: string; // how the capture was found
  capture: SeedCapture | null;
  miss: string | null;
}

export interface SeedFixture {
  recordedAt: string;
  timeZone: string;
  pages: SeedPage[];
}

export function loadSeedFixture(path: string = SEED_FIXTURE_PATH): SeedFixture {
  return JSON.parse(readFileSync(path, "utf8")) as SeedFixture;
}

export interface SeedPlan {
  monday: Date; // when the CRM shortlist was asked
  tuesday: Date; // when Postgres hosting was asked
  nov3: Date; // when the 3 November question was asked
}

// "last Monday", "last Tuesday" and the most recent past 3 November, as the resolver in temporal.ts
// understands them, so the seed and a user's own "on Monday" can never disagree.
export function planSeed(now: Date, timeZone: string): SeedPlan {
  const dayStart = (phrase: string): Date => {
    const found = resolveDates(phrase, now, timeZone).find((reference) => reference.start !== null);
    if (!found?.start) throw new Error(`could not resolve "${phrase}" to a date`);
    return new Date(found.start);
  };
  let nov3 = dayStart("3 November");
  // Asked on 3 November itself, the resolver says today; "past" means the year before.
  if (nov3.getTime() + 24 * HOUR_MS > now.getTime()) {
    nov3 = dayStart(`3 November ${nov3.getUTCFullYear() - 1}`);
  }
  const at = (start: Date) => new Date(start.getTime() + SEED_HOUR * HOUR_MS);
  return { monday: at(dayStart("last Monday")), tuesday: at(dayStart("last Tuesday")), nov3: at(nov3) };
}

const AMOUNT = /[$€£₹]\s?\d[\d,]*(?:\.\d+)?/;
const PLAN_WORD = /\b(starter|professional|pro|enterprise|basic|standard|essentials?|growth|team|business|premium|plus|free|scale|unlimited|lite|ultimate|advanced|solo|individual)\b/i;
const PERIOD_WORD = /\b(month|mo|user|seat|year|annual|annually|billed)\b/i;
const NOT_A_PLAN_PRICE = /(credits?|additional|api|up to|save|discount|off)/i;
const ZERO_AMOUNT = /[$€£₹]\s?0(?![\d.,]*[1-9])/;
const MAX_QUOTE_CHARS = 400; // a markdown link carries its whole URL inside the line

export interface PickedQuote {
  quote: string;
  claimText: string;
}

// Picks up to `limit` price lines from a page: a line with an amount, preferably also a plan name and
// a billing period. A line that is only an amount takes the short plan-name line above it. Same text,
// same picks, and every pick is a verbatim stretch of the page, so it anchors.
export function pickPriceQuotes(pageText: string, entity: string, limit = 2): PickedQuote[] {
  const lines = pageText.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const candidates: { index: number; quote: string; score: number; amount: string }[] = [];
  lines.forEach((line, index) => {
    const amount = AMOUNT.exec(line)?.[0];
    if (!amount || line.length > MAX_QUOTE_CHARS) return;
    let quote = line;
    const before = lines[index - 1];
    if (!PLAN_WORD.test(line) && before && before.length <= 60 && PLAN_WORD.test(before) && !AMOUNT.test(before)) {
      quote = `${before} ${line}`;
    }
    const amounts = quote.match(new RegExp(AMOUNT, "g"))?.length ?? 1;
    // A plan name near the start and a billing period make a plan price; credits, add-ons, free tiers and
    // lines with several amounts are weaker evidence of what the plan costs.
    const planAtStart = /^[^A-Za-z]{0,8}(?:\w+\s+){0,1}/.exec(quote)?.[0] ?? "";
    const score =
      (PLAN_WORD.test(quote) ? 2 : 0) +
      (PLAN_WORD.test(quote.slice(0, 25)) || PLAN_WORD.test(planAtStart) ? 1.5 : 0) +
      (PERIOD_WORD.test(quote) ? 1 : 0) -
      (NOT_A_PLAN_PRICE.test(quote) ? 2 : 0) -
      (ZERO_AMOUNT.test(quote) ? 1.5 : 0) -
      Math.max(0, amounts - 1) * 0.5 -
      quote.length / 200;
    candidates.push({ index, quote, score, amount: normalizeText(amount) });
  });

  const ranked = [...candidates].sort((a, b) => b.score - a.score || a.index - b.index);
  const picked: typeof candidates = [];
  for (const candidate of ranked) {
    if (picked.length === limit) break;
    // Two picks from one stretch of the page, or with the same amount, would be one fact twice.
    if (picked.some((other) => Math.abs(other.index - candidate.index) < 3 || other.amount === candidate.amount)) continue;
    if (!anchorQuote(pageText, candidate.quote)) continue;
    picked.push(candidate);
  }
  return picked
    .sort((a, b) => a.index - b.index)
    .map((item) => ({ quote: item.quote, claimText: `${entity}: ${describeQuote(item.quote)}` }));
}

// A readable version of a quote: markdown link syntax and heading marks dropped.
function describeQuote(quote: string): string {
  const plain = quote
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*|_`>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 140 ? `${plain.slice(0, 137)}...` : plain;
}

export function captureInstant(timestamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(timestamp);
  if (!m) throw new Error(`not a Wayback timestamp: ${timestamp}`);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
}

function shortDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}

function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

export interface SeedReport {
  turns: number;
  claims: number;
  unanchored: number;
  pages: { entity: string; url: string; capturedAt: string | null; miss: string | null; claims: number }[];
  replacedTurns: number;
}

// Removes the seed's turns and everything that hangs off them. User turns are never touched.
export function clearDemoHistory(db: Database): number {
  const found = db.prepare("SELECT COUNT(*) AS n FROM turns WHERE demo = 1").get() as { n: number };
  if (found.n === 0) return 0;
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM rechecks WHERE claim_id IN (SELECT claims.id FROM claims JOIN turns ON turns.id = claims.turn_id WHERE turns.demo = 1)");
    db.exec("DELETE FROM claims WHERE turn_id IN (SELECT id FROM turns WHERE demo = 1)");
    db.exec("DELETE FROM turn_entities WHERE turn_id IN (SELECT id FROM turns WHERE demo = 1)");
    db.exec("DELETE FROM turns WHERE demo = 1");
    // Archive copies are the seed's own snapshots; one still cited by a claim or a recheck stays.
    db.prepare(
      `DELETE FROM snapshots WHERE final_url LIKE ? AND hash NOT IN (SELECT snapshot_hash FROM claims WHERE snapshot_hash IS NOT NULL)
         AND hash NOT IN (SELECT new_snapshot_hash FROM rechecks WHERE new_snapshot_hash IS NOT NULL)`,
    ).run(`${ARCHIVE_PREFIX}%`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return found.n;
}

interface Conversation {
  askedAt: Date;
  question: string;
  intro: string;
  entities: string[]; // the shortlist, in order
  pages: SeedPage[]; // one per entity, same order; empty for a conversation with no sources
  closing: string;
}

// Replaces the demo turns with fresh ones dated from `now`. Idempotent.
export function seedDemoHistory(db: Database, options: { fixture: SeedFixture; now: Date; timeZone: string }): SeedReport {
  const { fixture, now, timeZone } = options;
  const plan = planSeed(now, timeZone);
  const pagesFor = (day: SeedDay) => fixture.pages.filter((page) => page.day === day);

  const conversations: Conversation[] = [
    {
      askedAt: plan.nov3,
      question: "What is the difference between a primary key and a unique index?",
      intro:
        "A primary key identifies each row: it is unique, cannot be NULL and a table has only one. A unique index also stops duplicates, but a table can have many and, in most SQL databases, a column in it may hold NULL.",
      entities: [],
      pages: [],
      closing: "",
    },
    {
      askedAt: plan.monday,
      question: "Which 5 CRM tools should we shortlist for a 20-person sales team? Include what each costs.",
      intro: "Shortlist for a 20-person sales team, with each price taken from the vendor's own pricing page as it stood when this was answered:",
      entities: pagesFor("monday").map((page) => page.entity),
      pages: pagesFor("monday"),
      closing: "Prices change often, so recheck before you buy.",
    },
    {
      askedAt: plan.tuesday,
      question: "Which managed Postgres host should we use for a small SaaS? Compare Neon, Supabase and Render on price.",
      intro: "Managed Postgres options for a small SaaS, with each price taken from the vendor's own pricing page as it stood when this was answered:",
      entities: pagesFor("tuesday").map((page) => page.entity),
      pages: pagesFor("tuesday"),
      closing: "Prices change often, so recheck before you commit.",
    },
  ];

  const replacedTurns = clearDemoHistory(db);
  const report: SeedReport = { turns: 0, claims: 0, unanchored: 0, pages: [], replacedTurns };

  for (const conversation of conversations) {
    const askedAt = conversation.askedAt.toISOString();
    const claims: ReceiptClaim[] = [];
    const snapshots = new Map<number, SnapshotRef>();
    const lines: string[] = [];

    for (const page of conversation.pages) {
      const found = { entity: page.entity, url: page.liveUrl, capturedAt: page.capture ? captureInstant(page.capture.timestamp) : null, miss: page.miss, claims: 0 };
      if (!page.capture) {
        lines.push(`- ${page.entity}: no archived copy of its pricing page was available, so I have no checked price for it.`);
        report.pages.push(found);
        continue;
      }
      const quotes = pickPriceQuotes(page.capture.text, page.entity);
      if (quotes.length === 0) {
        found.miss = "the capture shows no price line";
        lines.push(`- ${page.entity}: its archived pricing page shows no price I could quote.`);
        report.pages.push(found);
        continue;
      }
      const saved = saveSnapshot(db, page.liveUrl, page.capture.archiveUrl, page.capture.text, page.capture.extractor, found.capturedAt as string);
      const source = snapshots.size + 1;
      snapshots.set(source, { hash: saved.hash, text: saved.text, url: page.liveUrl });
      for (const picked of quotes) claims.push({ text: picked.claimText, kind: "price", entity: page.entity, source, quote: picked.quote });
      found.claims = quotes.length;
      lines.push(...quotes.map((picked) => `- ${picked.claimText} (${hostOf(page.liveUrl)}, page copy of ${shortDate(found.capturedAt as string)})`));
      report.pages.push(found);
    }

    const answer = conversation.pages.length === 0 ? conversation.intro : [conversation.intro, ...lines, "", conversation.closing].join("\n");
    insertTurn(db, "user", conversation.question, askedAt, timeZone, true);
    const answerId = insertTurn(db, "assistant", answer, new Date(conversation.askedAt.getTime() + ANSWER_DELAY_MS).toISOString(), timeZone, true);
    const stored = storeClaims(db, { turnId: answerId, claims, entities: conversation.entities, snapshots });
    report.turns += 2;
    report.claims += stored.stored;
    report.unanchored += stored.unanchored;
  }
  return report;
}

// What `npm run seed` prints: one line per page, misses included.
export function describeSeed(report: SeedReport): string {
  const lines = [`Seeded ${report.turns} demo turns and ${report.claims} claims (${report.unanchored} unanchored); replaced ${report.replacedTurns} older demo turns.`];
  for (const page of report.pages) {
    const when = page.capturedAt ? `capture of ${page.capturedAt}` : `NO USABLE CAPTURE (${page.miss ?? "unknown"})`;
    lines.push(`  ${page.entity.padEnd(11)} ${page.url}  ${when}  claims: ${page.claims}`);
  }
  return lines.join("\n");
}
