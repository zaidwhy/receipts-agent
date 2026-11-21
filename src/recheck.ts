// Recheck, lane A: for claims stored earlier, read the cited pages again and say what
// the source says now. Cheap checks first: an identical page costs no model call, a page
// that differs but still holds the quote costs one call per page, and only a lost quote
// or a doubtful read goes to the full comparison. An anchor miss never means "changed".
import type { Clock } from "./clock.ts";
import type { Database } from "./db.ts";
import { excerptFor } from "./excerpt.ts";
import type { LlmClient } from "./llm.ts";
import { createLogger } from "./log.ts";
import type { Extractor, Page, ReaderPort, ReadFailure } from "./reader.ts";
import { loadSnapshotText, normalizeText, saveSnapshot } from "./receipts.ts";
import type { SearchPort } from "./search.ts";

const log = createLogger("recheck");

export const RECHECK_CONCURRENCY = 4;
export const CONTEXT_RADIUS_CHARS = 600;
// A plain fetch shorter than this is a shell page (script tags, a cookie banner), so it says nothing about the real page.
export const SUBSTANTIAL_TEXT_CHARS = 2000;
export const MODEL_TIMEOUT_MS = 30000;
const LEAD_SNIPPET_CHARS = 200;

export type RecheckStatus = "source_unchanged" | "changed" | "context_changed" | "reworded" | "cannot_tell" | "could_not_verify";
export type RecheckTier = 1 | 2 | 3 | 4;

export interface StoredClaim {
  id: number;
  entity: string;
  text: string;
  kind: string;
  quote: string;
  anchored: boolean;
  snapshotHash: string | null;
  url: string | null; // the page the claim was read from; null when no page was stored
  extractor: string | null;
}

export interface RecheckRow {
  claimId: number;
  entity: string;
  claim: string;
  then: string; // the quote as it stood when the page was first read
  now: string | null; // what the page says now; null when nothing could be read
  sourceUrl: string | null;
  status: RecheckStatus;
  tier: RecheckTier;
  note: string | null;
  lead: SearchLead | null;
}

// A lead comes from a web search, not from the page that was checked, and is always labelled that way.
export interface SearchLead {
  title: string;
  url: string;
  snippet: string;
}

export interface RecheckDeps {
  db: Database;
  reader: ReaderPort;
  search: SearchPort;
  llm: LlmClient;
  clock: Clock;
}

export interface ClaimRecheckResult {
  rows: RecheckRow[];
  pagesChecked: number;
  pagesUnreachable: number;
  llmCalls: number;
  readsCompared: number; // anchored quotes that both reads could be asked about
  readsAgreed: number;
  pricingOnly: boolean; // every claim was a price, so the coverage line can say "pricing pages"
}

// Claims for the answers to these questions (or answer turns) and/or about these entities.
export function loadClaims(db: Database, selector: { turnIds?: number[]; entities?: string[] }): StoredClaim[] {
  // A question's claims are stored under the answer that follows it, so both ids are looked up.
  const turnIds = [...new Set((selector.turnIds ?? []).flatMap((id) => [id, id + 1]))];
  const names = [...new Set((selector.entities ?? []).map((name) => name.trim().toLowerCase()).filter((name) => name !== ""))];
  if (turnIds.length === 0 && names.length === 0) return [];

  const conditions: string[] = [];
  const values: (number | string)[] = [];
  if (turnIds.length > 0) {
    conditions.push(`claims.turn_id IN (${turnIds.map(() => "?").join(", ")})`);
    values.push(...turnIds);
  }
  if (names.length > 0) {
    conditions.push(`lower(entities.name) IN (${names.map(() => "?").join(", ")})`);
    values.push(...names);
  }
  const rows = db
    .prepare(
      `SELECT claims.id AS id, entities.name AS entity, claims.text AS text, claims.kind AS kind, claims.quote AS quote,
              claims.anchored AS anchored, claims.snapshot_hash AS snapshot_hash, snapshots.url AS url, snapshots.extractor AS extractor
       FROM claims
       LEFT JOIN entities ON entities.id = claims.entity_id
       LEFT JOIN snapshots ON snapshots.hash = claims.snapshot_hash
       WHERE ${conditions.join(" OR ")} ORDER BY claims.id`,
    )
    .all(...values) as {
    id: number;
    entity: string | null;
    text: string;
    kind: string;
    quote: string;
    anchored: number;
    snapshot_hash: string | null;
    url: string | null;
    extractor: string | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    entity: row.entity ?? "unknown",
    text: row.text,
    kind: row.kind,
    quote: row.quote,
    anchored: row.anchored === 1,
    snapshotHash: row.snapshot_hash,
    url: row.url,
    extractor: row.extractor,
  }));
}

export async function recheckClaims(deps: RecheckDeps, claims: StoredClaim[], emit: (row: RecheckRow) => void = () => {}): Promise<ClaimRecheckResult> {
  const result: ClaimRecheckResult = {
    rows: [],
    pagesChecked: 0,
    pagesUnreachable: 0,
    llmCalls: 0,
    readsCompared: 0,
    readsAgreed: 0,
    pricingOnly: claims.length > 0 && claims.every((claim) => claim.kind === "price"),
  };
  const publish = (row: RecheckRow) => {
    result.rows.push(row);
    emit(row);
  };

  // One read per page and extractor, however many claims point at it.
  const pages = new Map<string, StoredClaim[]>();
  const withoutPage: StoredClaim[] = [];
  for (const claim of claims) {
    if (!claim.url) {
      withoutPage.push(claim);
      continue;
    }
    const key = `${claim.extractor ?? ""}|${claim.url}`;
    pages.set(key, [...(pages.get(key) ?? []), claim]);
  }

  const jobs: (() => Promise<void>)[] = [...pages.values()].map((pageClaims) => async () => {
    for (const row of await recheckPage(deps, pageClaims, result)) publish(row);
  });
  if (withoutPage.length > 0) {
    jobs.push(async () => {
      for (const claim of withoutPage) publish(await couldNotVerify(deps, claim, "no page was stored for this claim"));
    });
  }
  await runLimited(jobs, RECHECK_CONCURRENCY);

  log.info("recheck reads", { compared: result.readsCompared, agreed: result.readsAgreed });
  return result;
}

interface PendingClaim {
  claim: StoredClaim;
  tier: 2 | 3;
  oldContext: string;
  newContext: string;
  secondRead: string | null; // excerpt from the plain fetch, only for claims where the two reads disagreed
}

async function recheckPage(deps: RecheckDeps, claims: StoredClaim[], totals: ClaimRecheckResult): Promise<RecheckRow[]> {
  const first = claims[0] as StoredClaim;
  const url = first.url as string;
  const extractor = asExtractor(first.extractor);

  // A Tavily read may be a cached copy, so the same page is also read plainly, side by side.
  const [primary, plain] = await Promise.all([
    readOne(deps.reader, url, extractor),
    extractor === "tavily-basic" ? readOne(deps.reader, url, "fetch") : Promise.resolve(null),
  ]);

  if (!primary.page) {
    totals.pagesUnreachable += 1;
    const reason = primary.failure ? `${primary.failure.reason}: ${primary.failure.error}` : "no text returned";
    return Promise.all(claims.map((claim) => couldNotVerify(deps, claim, reason)));
  }
  totals.pagesChecked += 1;

  const readAt = deps.clock.now().toISOString();
  const saved = saveSnapshot(deps.db, url, primary.page.finalUrl, primary.page.text, primary.page.extractor, readAt, primary.page.publishedAt ?? undefined);
  const newText = saved.text;
  const plainText = plain?.page ? normalizeText(plain.page.text) : null;
  const plainIsSubstantial = plainText !== null && plainText.length > SUBSTANTIAL_TEXT_CHARS;

  const rows: RecheckRow[] = [];
  const pending: PendingClaim[] = [];
  for (const claim of claims) {
    const oldText = claim.snapshotHash ? loadSnapshotText(deps.db, claim.snapshotHash) : null;
    const anchoredNow = claim.anchored && locate(newText, claim.quote) !== -1;

    let disagree = false;
    if (anchoredNow && plainIsSubstantial) {
      totals.readsCompared += 1;
      if (looseIncludes(plainText, claim.quote)) totals.readsAgreed += 1;
      else disagree = true;
    }

    const sameHash = claim.snapshotHash === saved.hash;
    if (claim.anchored && sameHash && !disagree) {
      rows.push(finish(deps, claim, url, 1, "source_unchanged", saved.hash, null, null));
      continue;
    }

    if (claim.anchored && anchoredNow && !disagree) {
      pending.push({ claim, tier: 2, oldContext: oldContextFor(claim, oldText), newContext: contextAround(newText, claim.quote), secondRead: null });
    } else {
      // Quote lost, never anchored, or the two reads disagree: the model compares old context with an excerpt chosen by the claim's words.
      const search = `${claim.text} ${claim.quote}`;
      pending.push({
        claim,
        tier: 3,
        oldContext: oldContextFor(claim, oldText),
        newContext: excerptFor(newText, search, 1500),
        secondRead: disagree && plainText ? excerptFor(plainText, search, 1000) : null,
      });
    }
  }

  if (pending.length > 0) {
    totals.llmCalls += 1;
    const verdicts = await judgePage(deps.llm, url, pending, newText);
    for (const item of pending) {
      const verdict = verdicts.get(item.claim.id) ?? { status: "cannot_tell" as const, newValue: null, note: "the model gave no verdict for this claim" };
      const disagreeNote = item.secondRead ? "The two reads of the page disagree: the first had this quote, a plain fetch did not. " : "";
      const note = `${disagreeNote}${verdict.note ?? ""}`.trim() || null;
      rows.push(finish(deps, item.claim, url, item.tier, verdict.status, saved.hash, verdict.newValue, note));
    }
  }
  // Rows come out in the order the claims were asked about.
  return rows.sort((a, b) => claims.findIndex((c) => c.id === a.claimId) - claims.findIndex((c) => c.id === b.claimId));
}

function oldContextFor(claim: StoredClaim, oldText: string | null): string {
  if (!oldText) return "(the page text from then was not kept)";
  return claim.anchored && locate(oldText, claim.quote) !== -1 ? contextAround(oldText, claim.quote) : excerptFor(oldText, claim.text, 1200);
}

function finish(
  deps: RecheckDeps,
  claim: StoredClaim,
  url: string | null,
  tier: RecheckTier,
  status: RecheckStatus,
  newHash: string | null,
  newValue: string | null,
  note: string | null,
  lead: SearchLead | null = null,
): RecheckRow {
  deps.db.prepare(
    "INSERT INTO rechecks (claim_id, checked_at, tier, status, new_snapshot_hash, new_value, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(claim.id, deps.clock.now().toISOString(), tier, status, newHash, newValue, note);
  const showsQuote = status === "source_unchanged" || status === "context_changed";
  return {
    claimId: claim.id,
    entity: claim.entity,
    claim: claim.text,
    then: claim.quote,
    now: newValue ?? (showsQuote ? claim.quote : null),
    sourceUrl: url,
    status,
    tier,
    note,
    lead,
  };
}

// Tier 4: the page could not be read. A search for the claim gives a lead, never a verdict.
async function couldNotVerify(deps: RecheckDeps, claim: StoredClaim, reason: string): Promise<RecheckRow> {
  let lead: SearchLead | null = null;
  try {
    const outcome = await deps.search.search({ query: claim.text });
    const hit = outcome.results.find((result) => result.url !== claim.url) ?? null;
    if (hit) lead = { title: hit.title, url: hit.url, snippet: hit.snippet.slice(0, LEAD_SNIPPET_CHARS) };
  } catch (error) {
    log.warn("lead search failed", { message: error instanceof Error ? error.message : String(error) });
  }
  const label = lead
    ? `Lead from a different source (a web search, not the page checked): "${lead.title}", ${lead.url}`
    : "No lead found by web search either.";
  return finish(deps, claim, claim.url, 4, "could_not_verify", null, null, `Could not read the page (${reason}). ${label}`, lead);
}

interface Verdict {
  status: RecheckStatus;
  newValue: string | null;
  note: string | null;
}

const TIER_STATUSES: Record<2 | 3, RecheckStatus[]> = {
  2: ["source_unchanged", "changed", "context_changed"],
  3: ["changed", "reworded", "cannot_tell"],
};

// One model call for every claim on the page that needs reading.
async function judgePage(llm: LlmClient, url: string, pending: PendingClaim[], newText: string): Promise<Map<number, Verdict>> {
  const verdicts = new Map<number, Verdict>();
  const fail = (note: string) => {
    for (const item of pending) verdicts.set(item.claim.id, { status: "cannot_tell", newValue: null, note });
    return verdicts;
  };

  let reply: string;
  try {
    reply = await askModel(llm, JUDGE_SYSTEM, judgePrompt(url, pending));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("recheck model call failed", { message });
    return fail(`the model call failed (${message})`);
  }

  const parsed = parseVerdicts(reply);
  if (!parsed) return fail("the model's reply was not valid JSON");

  for (const entry of parsed) {
    const item = pending.find((candidate) => candidate.claim.id === entry.id);
    if (!item) continue;
    if (!TIER_STATUSES[item.tier].includes(entry.status)) {
      verdicts.set(item.claim.id, { status: "cannot_tell", newValue: null, note: `the model answered "${entry.status}", which does not apply here` });
      continue;
    }
    // A new value counts only if it is on the page. Otherwise the model may have made it up.
    if (entry.status === "changed" && (!entry.newValue || !looseIncludes(newText, entry.newValue))) {
      verdicts.set(item.claim.id, { status: "cannot_tell", newValue: null, note: "the model reported a change but its new value is not on the page" });
      continue;
    }
    verdicts.set(item.claim.id, { status: entry.status, newValue: entry.status === "changed" ? entry.newValue : null, note: entry.note });
  }
  return verdicts;
}

const JUDGE_SYSTEM =
  "You compare what a web page said earlier with what it says now, claim by claim. Reply with JSON only, no prose, no code fence.";

function judgePrompt(url: string, pending: PendingClaim[]): string {
  const blocks = pending.map((item) => {
    const allowed = TIER_STATUSES[item.tier].join(", ");
    const lines = [
      `Claim ${item.claim.id} (allowed statuses: ${allowed})`,
      `Claim: ${item.claim.text}`,
      `Quote from then: ${item.claim.quote}`,
      "Page text from then:",
      `<<<${item.oldContext}>>>`,
      item.tier === 2 ? "Page text around the same quote now:" : "Excerpt of the page now (chosen by the claim's words; [...] marks text left out):",
      `<<<${item.newContext}>>>`,
    ];
    if (item.secondRead) {
      lines.push(
        "A second read of the page, by plain fetch, did not contain the quote. Either the first read was stale or the page renders differently. Say cannot_tell unless the text shows the fact changed.",
        "Excerpt from the second read:",
        `<<<${item.secondRead}>>>`,
      );
    }
    return lines.join("\n");
  });
  return [
    `Page: ${url}`,
    "",
    "For each claim give a status:",
    "- source_unchanged: the page now states the same fact. You say nothing about whether the fact is true in the world.",
    "- changed: the page now states a different value. Put it in new_value, copied word for word from the page text now.",
    "- context_changed: the quote is still on the page but now sits under a heading or label for old, legacy, discontinued or previous offers, so it may no longer be the current one.",
    "- reworded: the page states the same fact in other words.",
    "- cannot_tell: the text does not let you decide. Prefer this to guessing.",
    "Use only the statuses allowed for that claim.",
    "",
    'Reply as {"results": [{"id": 1, "status": "changed", "new_value": "$24 / month", "note": "one short sentence"}]}. new_value only for changed.',
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

function parseVerdicts(reply: string): { id: number; status: RecheckStatus; newValue: string | null; note: string | null }[] | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  const known: RecheckStatus[] = ["source_unchanged", "changed", "context_changed", "reworded", "cannot_tell"];
  const verdicts: { id: number; status: RecheckStatus; newValue: string | null; note: string | null }[] = [];
  for (const entry of results) {
    const { id, status, new_value, note } = (entry ?? {}) as Record<string, unknown>;
    if (typeof id !== "number" || typeof status !== "string" || !known.includes(status as RecheckStatus)) continue;
    verdicts.push({
      id,
      status: status as RecheckStatus,
      newValue: typeof new_value === "string" && new_value.trim() !== "" ? new_value.trim() : null,
      note: typeof note === "string" && note.trim() !== "" ? note.trim().slice(0, 300) : null,
    });
  }
  return verdicts;
}

async function askModel(llm: LlmClient, system: string, user: string): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no reply in ${MODEL_TIMEOUT_MS / 1000} s`)), MODEL_TIMEOUT_MS);
  });
  const collect = (async () => {
    let text = "";
    for await (const event of llm.streamChat({ messages: [{ role: "system", content: system }, { role: "user", content: user }] })) {
      if (event.type === "token") text += event.text;
    }
    return text;
  })();
  try {
    return await Promise.race([collect, timeout]);
  } finally {
    clearTimeout(timer);
    collect.catch(() => {}); // a late failure after the timeout must not become an unhandled rejection
  }
}

async function readOne(reader: ReaderPort, url: string, extractor: Extractor | undefined): Promise<{ page: Page | null; failure: ReadFailure | null }> {
  try {
    const outcome = await reader.read([url], extractor ? { extractor } : undefined);
    const page = outcome.pages.find((candidate) => candidate.url === url) ?? outcome.pages[0] ?? null;
    return { page, failure: page ? null : (outcome.failures[0] ?? null) };
  } catch (error) {
    return { page: null, failure: { url, reason: "failed", error: error instanceof Error ? error.message : String(error) } };
  }
}

function asExtractor(value: string | null): Extractor | undefined {
  return value === "tavily-basic" || value === "fetch" ? value : undefined;
}

// Index of the quote in already-normalised page text, or -1.
function locate(text: string, quote: string): number {
  const exact = normalizeText(quote);
  return exact === "" ? -1 : text.indexOf(exact);
}

function contextAround(text: string, quote: string): string {
  const exact = normalizeText(quote);
  const start = text.indexOf(exact);
  if (start === -1) return "";
  const from = Math.max(0, start - CONTEXT_RADIUS_CHARS);
  const to = Math.min(text.length, start + exact.length + CONTEXT_RADIUS_CHARS);
  return `${from > 0 ? "[...] " : ""}${text.slice(from, to)}${to < text.length ? " [...]" : ""}`;
}

// Letters, digits and currency signs only, lower case. Markdown and plain-text readers lay the same
// page out differently ("| $19 |" against "$19"), so two reads are compared on their content alone.
function squash(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}$€£₹]/gu, "");
}

function looseIncludes(haystack: string, needle: string): boolean {
  const wanted = squash(needle);
  return wanted !== "" && squash(haystack).includes(wanted);
}

export async function runLimited(jobs: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      await job?.();
    }
  });
  await Promise.all(workers);
}
