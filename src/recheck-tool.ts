// The recheck tool: runs lane A (re-read the cited pages) and lane B (what shipped since T)
// side by side, streams each row as it finishes, and writes up the result for the model.
// It is also run by code, before the model writes, when the user asks whether something changed.
import type { Database } from "./db.ts";
import { describeCoverage, discoverEvents, loadEntities, type Coverage, type EventRow, type FeedPort } from "./discovery.ts";
import type { ToolDefinition } from "./llm.ts";
import { loadClaims, recheckClaims, type RecheckDeps, type RecheckRow, type RecheckStatus } from "./recheck.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 30;

export interface RecheckToolDeps extends RecheckDeps {
  feeds: FeedPort;
}

// The shapes sent to the browser as Server-Sent Events.
export interface RecheckRowPayload {
  entity: string;
  claim: string;
  then: string;
  now: string | null;
  source_url: string | null;
  status: RecheckStatus;
  tier: number;
  note: string | null;
  lead: { title: string; url: string } | null;
}

export interface EventRowPayload {
  entity: string;
  title: string;
  url: string;
  published_at: string | null;
  kind: string;
  confirmed: boolean;
  source: "feed" | "search";
}

export type RecheckEvent =
  | { type: "recheck_row"; data: RecheckRowPayload }
  | { type: "event_row"; data: EventRowPayload }
  | { type: "coverage"; data: Coverage & { line: string } };

export interface RecheckOutput {
  text: string; // what the model reads
  coverage: Coverage;
  rows: RecheckRow[];
  events: EventRow[];
  laneAMs: number;
  laneBMs: number;
}

export interface RecheckInput {
  turnIds?: number[];
  entities?: string[];
  since?: Date;
}

export const RECHECK_TOOL: ToolDefinition = {
  name: "recheck",
  description:
    "Check whether things said earlier still hold: re-reads the pages the earlier answers cited and looks in each vendor's changelog and " +
    "in dated news for what shipped since. Give turn_ids (from recall) and/or entities. Optional since (ISO date) is where 'what is new' starts; " +
    "it defaults to when the earliest of those answers was given. The result is shown to the user as a table, so summarise it instead of copying it.",
  parameters: {
    type: "object",
    properties: {
      turn_ids: { type: "array", items: { type: "number" }, description: "turnId values returned by recall." },
      entities: { type: "array", items: { type: "string" }, description: "Product or company names." },
      since: { type: "string", description: "Optional ISO date or date-time." },
    },
  },
};

const CHANGE_WORDS = /\b(changed|still (correct|true|right)|since|any updates?|anything new|shipped)\b/i;

// True when the message asks whether things moved on, so a recheck is worth running.
export function asksAboutChange(message: string): boolean {
  return CHANGE_WORDS.test(message);
}

export function parseRecheckArguments(raw: string): { input: RecheckInput } | { error: string } {
  let args: unknown;
  try {
    args = JSON.parse(raw || "{}");
  } catch {
    return { error: "Invalid arguments: not valid JSON. Call recheck again with turn_ids and/or entities." };
  }
  const { turn_ids, entities, since } = (args ?? {}) as { turn_ids?: unknown; entities?: unknown; since?: unknown };
  const turnIds = Array.isArray(turn_ids) ? turn_ids.filter((id): id is number => Number.isInteger(id)) : [];
  const names = Array.isArray(entities) ? entities.filter((name): name is string => typeof name === "string" && name.trim() !== "") : [];
  if (turnIds.length === 0 && names.length === 0) return { error: "Invalid arguments: give turn_ids and/or entities to recheck." };
  const input: RecheckInput = { turnIds, entities: names };
  if (since !== undefined) {
    const parsed = typeof since === "string" ? new Date(since) : new Date(NaN);
    if (Number.isNaN(parsed.getTime())) return { error: "Invalid arguments: since must be an ISO date like 2026-11-17." };
    input.since = parsed;
  }
  return { input };
}

export async function runRecheck(deps: RecheckToolDeps, input: RecheckInput, emit: (event: RecheckEvent) => void = () => {}): Promise<RecheckOutput | null> {
  const claims = loadClaims(deps.db, { turnIds: input.turnIds, entities: input.entities });
  const entities = loadEntities(deps.db, { turnIds: input.turnIds, names: input.entities });
  if (claims.length === 0 && entities.length === 0) return null;

  const now = deps.clock.now();
  const sinceGiven = input.since !== undefined;
  const since = input.since ?? defaultSince(deps.db, input, claims.map((claim) => claim.id)) ?? new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * DAY_MS);

  const timed = async <T>(work: Promise<T>): Promise<{ value: T; ms: number }> => {
    const start = performance.now();
    const value = await work;
    return { value, ms: Math.round(performance.now() - start) };
  };

  const [laneA, laneB] = await Promise.all([
    timed(
      recheckClaims(deps, claims, (row) =>
        emit({
          type: "recheck_row",
          data: {
            entity: row.entity,
            claim: row.claim,
            then: row.then,
            now: row.now,
            source_url: row.sourceUrl,
            status: row.status,
            tier: row.tier,
            note: row.note,
            lead: row.lead ? { title: row.lead.title, url: row.lead.url } : null,
          },
        }),
      ),
    ),
    timed(
      discoverEvents({ db: deps.db, search: deps.search, feeds: deps.feeds, now: () => deps.clock.now() }, entities, since, (event) =>
        emit({
          type: "event_row",
          data: { entity: event.entity, title: event.title, url: event.url, published_at: event.publishedAt, kind: event.kind, confirmed: event.confirmed, source: event.source },
        }),
      ),
    ),
  ]);

  const coverage: Coverage = {
    pages_checked: laneA.value.pagesChecked,
    pages_unreachable: laneA.value.pagesUnreachable,
    feeds_checked: laneB.value.feedsChecked,
    entities_without_feed: laneB.value.entitiesWithoutFeed,
    feeds_unreachable: laneB.value.feedsUnreachable,
    searches_failed: laneB.value.searchesFailed,
    llm_calls: laneA.value.llmCalls,
    pricing_only: laneA.value.pricingOnly,
  };
  emit({ type: "coverage", data: { ...coverage, line: describeCoverage(coverage) } });

  return {
    text: describeForModel(laneA.value.rows, laneB.value.events, laneB.value.minorCount, coverage, since, sinceGiven),
    coverage,
    rows: laneA.value.rows,
    events: laneB.value.events,
    laneAMs: laneA.ms,
    laneBMs: laneB.ms,
  };
}

// When the earlier answers were given: the earliest of the asked questions, or of the answers behind the claims.
function defaultSince(db: Database, input: RecheckInput, claimIds: number[]): Date | null {
  const times: string[] = [];
  const turnTime = db.prepare("SELECT asked_at FROM turns WHERE id = ?");
  for (const id of input.turnIds ?? []) {
    const row = turnTime.get(id) as { asked_at: string } | undefined;
    if (row) times.push(row.asked_at);
  }
  if (times.length === 0) {
    const claimTime = db.prepare("SELECT turns.asked_at AS asked_at FROM claims JOIN turns ON turns.id = claims.turn_id WHERE claims.id = ?");
    for (const id of claimIds) {
      const row = claimTime.get(id) as { asked_at: string } | undefined;
      if (row) times.push(row.asked_at);
    }
  }
  if (times.length === 0) return null;
  return new Date(times.sort()[0] as string);
}

export const STATUS_WORDS: Record<RecheckStatus, string> = {
  source_unchanged: "source unchanged",
  changed: "changed",
  context_changed: "context changed",
  reworded: "reworded",
  cannot_tell: "cannot tell",
  could_not_verify: "could not verify",
};

function describeForModel(rows: RecheckRow[], events: EventRow[], minorCount: number, coverage: Coverage, since: Date, sinceGiven: boolean): string {
  const lines: string[] = [`Recheck finished. "What is new" counts from ${since.toISOString()}${sinceGiven ? "" : " (when the earlier answer was given)"}.`, ""];

  lines.push(`Earlier claims, read again (${rows.length}):`);
  if (rows.length === 0) lines.push("- none had a stored source page");
  for (const row of rows) {
    const parts = [`- [${row.entity}] ${row.claim} | then: "${row.then}" | status: ${STATUS_WORDS[row.status]} (tier ${row.tier})`];
    if (row.now && row.status !== "source_unchanged") parts.push(`now: "${row.now}"`);
    if (row.sourceUrl) parts.push(`source: ${row.sourceUrl}`);
    if (row.note) parts.push(`note: ${row.note}`);
    lines.push(parts.join(" | "));
  }

  lines.push("", "Events since then (feeds and dated search):");
  const dated = events.filter((event) => event.publishedAt !== null);
  const undated = events.filter((event) => event.publishedAt === null);
  if (events.length === 0) lines.push("- none found");
  for (const event of dated) {
    lines.push(`- [${event.entity}] ${event.kind}: ${event.title} | ${event.publishedAt} | ${event.confirmed ? "confirmed" : "unconfirmed (one source that is not the vendor's)"} | ${event.url}`);
  }
  for (const event of undated) lines.push(`- [${event.entity}] ${event.kind}: ${event.title} | undated, may predate the period | ${event.url}`);
  if (minorCount > 0) lines.push(`- ${minorCount} other item${minorCount === 1 ? "" : "s"} were minor (no pricing, launch, acquisition or shutdown) and are not listed`);

  const unreachable = coverage.pages_unreachable + coverage.feeds_unreachable;
  const unchecked = rows.filter((row) => row.status === "could_not_verify" || row.status === "cannot_tell").length;
  lines.push("", `Coverage: ${describeCoverage(coverage)}.`);
  if (unreachable > 0 || unchecked > 0 || coverage.searches_failed > 0) {
    lines.push(`Not everything could be checked (${unreachable} unreachable, ${unchecked} claim${unchecked === 1 ? "" : "s"} undecided, ${coverage.searches_failed} failed search${coverage.searches_failed === 1 ? "" : "es"}). Do not say nothing changed.`);
  }
  if (coverage.entities_without_feed > 0) lines.push(`No changelog was found for ${coverage.entities_without_feed} vendor${coverage.entities_without_feed === 1 ? "" : "s"}, so launches there are not covered.`);
  return lines.join("\n");
}
