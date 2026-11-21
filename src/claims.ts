// Claims are checkable facts (a price, a limit, a version...) that the model lists
// at the end of its answer in a fenced block tagged "receipts". This file hides
// that block from the user, parses it, and stores each claim with its anchor.
import type { Database } from "./db.ts";
import { createLogger } from "./log.ts";
import { anchorQuote } from "./receipts.ts";

const log = createLogger("claims");

const MARKER = "```receipts";
const FENCE = "```";

export const CLAIM_KINDS = ["price", "limit", "version", "date", "availability", "launch"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export interface ReceiptClaim {
  text: string;
  kind: ClaimKind;
  entity: string;
  source: number; // the [n] the model cited
  quote: string; // copied from the cited page
}

// Days a claim stays fresh. null means it never expires.
export function volatilityDays(kind: ClaimKind): number | null {
  switch (kind) {
    case "price":
    case "limit":
    case "availability":
      return 7;
    case "version":
    case "launch":
      return 30;
    case "date":
      return null;
  }
}

// Splits a finished answer into the text the user sees and the raw JSON inside the receipts block.
export function splitReceiptsBlock(raw: string): { visible: string; blockText: string | null } {
  const start = raw.indexOf(MARKER);
  if (start === -1) return { visible: raw, blockText: null };
  const afterMarker = raw.slice(start + MARKER.length);
  const close = afterMarker.indexOf(FENCE);
  // A block the model never closed (cut off) is still hidden from the user.
  const blockText = close === -1 ? afterMarker : afterMarker.slice(0, close);
  return { visible: raw.slice(0, start).trimEnd(), blockText };
}

export const MAX_TURN_ENTITIES = 20;

export interface ParsedReceipts {
  visibleText: string;
  claims: ReceiptClaim[];
  entities: string[]; // every product the answer discusses, with or without a checkable claim
  invalidCount: number; // entries that were in the block but not usable
}

export function parseReceipts(raw: string): ParsedReceipts {
  const { visible, blockText } = splitReceiptsBlock(raw);
  if (blockText === null) return { visibleText: visible, claims: [], entities: [], invalidCount: 0 };

  let entries: unknown;
  try {
    entries = JSON.parse(blockText);
  } catch {
    log.warn("receipts block was not valid JSON");
    return { visibleText: visible, claims: [], entities: [], invalidCount: 1 };
  }
  // Two shapes are accepted: the bare array of claims, and {"entities": [...], "claims": [...]}.
  let claimEntries: unknown = entries;
  let entityNames: unknown = [];
  if (typeof entries === "object" && entries !== null && !Array.isArray(entries)) {
    ({ claims: claimEntries = [], entities: entityNames = [] } = entries as Record<string, unknown>);
  }
  if (!Array.isArray(claimEntries)) {
    log.warn("receipts block had no claims array");
    return { visibleText: visible, claims: [], entities: [], invalidCount: 1 };
  }

  const claims: ReceiptClaim[] = [];
  let invalidCount = 0;
  for (const entry of claimEntries) {
    const claim = toClaim(entry);
    if (claim) claims.push(claim);
    else invalidCount += 1;
  }
  if (invalidCount > 0) log.warn("some receipts entries were unusable", { invalidCount });
  return { visibleText: visible, claims, entities: cleanEntityNames(entityNames), invalidCount };
}

function cleanEntityNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") continue;
    const name = item.trim();
    if (!names.some((existing) => existing.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return names.slice(0, MAX_TURN_ENTITIES);
}

function toClaim(entry: unknown): ReceiptClaim | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { text, kind, entity, source, quote } = entry as Record<string, unknown>;
  if (typeof text !== "string" || text.trim() === "") return null;
  if (typeof entity !== "string" || entity.trim() === "") return null;
  if (typeof quote !== "string") return null;
  if (typeof source !== "number" || !Number.isInteger(source)) return null;
  if (typeof kind !== "string" || !CLAIM_KINDS.includes(kind as ClaimKind)) return null;
  return { text, kind: kind as ClaimKind, entity: entity.trim(), source, quote };
}

// Feed this the streamed text. It returns only the part that is safe to show,
// so the receipts block never flashes on screen before it is recognised.
export function createReceiptsFilter() {
  let full = "";
  let shown = 0;

  function safeEnd(): number {
    const start = full.indexOf(MARKER);
    if (start !== -1) return full.slice(0, start).trimEnd().length;
    // Hold back a tail that could be the beginning of the marker, plus trailing blanks before it.
    let held = 0;
    for (let length = MARKER.length - 1; length > 0; length -= 1) {
      if (full.endsWith(MARKER.slice(0, length))) {
        held = length;
        break;
      }
    }
    return full.slice(0, full.length - held).trimEnd().length;
  }

  return {
    push(chunk: string): string {
      full += chunk;
      const end = Math.max(safeEnd(), shown);
      const out = full.slice(shown, end);
      shown = end;
      return out;
    },
    // Call once when the stream ends; returns whatever was still held back.
    finish(): string {
      const visible = splitReceiptsBlock(full).visible;
      const out = visible.slice(shown);
      shown = Math.max(shown, visible.length);
      return out;
    },
  };
}

// What storeClaims needs to know about each cited page.
export interface SnapshotRef {
  hash: string;
  text: string;
  url: string;
}

export interface StoreClaimsResult {
  stored: number;
  anchored: number;
  unanchored: number;
}

export function storeClaims(
  db: Database,
  input: { turnId: number; claims: ReceiptClaim[]; entities?: string[]; snapshots: Map<number, SnapshotRef> },
): StoreClaimsResult {
  const result: StoreClaimsResult = { stored: 0, anchored: 0, unanchored: 0 };
  const insert = db.prepare(
    `INSERT INTO claims (turn_id, entity_id, text, kind, volatility, snapshot_hash, quote, prefix, suffix, anchored)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const linkEntity = db.prepare("INSERT OR IGNORE INTO turn_entities (turn_id, entity_id) VALUES (?, ?)");

  db.exec("BEGIN");
  try {
    for (const name of input.entities ?? []) linkEntity.run(input.turnId, findOrCreateEntity(db, name, null));
    for (const claim of input.claims) {
      const snapshot = input.snapshots.get(claim.source);
      const anchor = snapshot ? anchorQuote(snapshot.text, claim.quote) : null;
      const entityId = findOrCreateEntity(db, claim.entity, snapshot ? domainOf(snapshot.url) : null);
      linkEntity.run(input.turnId, entityId);
      // A claim that does not anchor is still stored; recheck decides what to do with it later.
      insert.run(
        input.turnId,
        entityId,
        claim.text,
        claim.kind,
        volatilityDays(claim.kind),
        snapshot?.hash ?? null,
        claim.quote,
        anchor?.prefix ?? null,
        anchor?.suffix ?? null,
        anchor ? 1 : 0,
      );
      result.stored += 1;
      if (anchor) result.anchored += 1;
      else result.unanchored += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  log.info("claims stored", { anchored: result.anchored, unanchored: result.unanchored });
  return result;
}

function findOrCreateEntity(db: Database, name: string, domain: string | null): number {
  // A domain is kept only when it looks like the vendor's own, never a blog that mentions the vendor.
  const vendorDomain = domain && looksLikeVendorDomain(domain, name) ? domain : null;
  const existing = db.prepare("SELECT id, domain FROM entities WHERE name = ? COLLATE NOCASE").get(name) as
    | { id: number; domain: string | null }
    | undefined;
  if (existing) {
    // The vendor's own page may only show up in a later turn; fill the gap then.
    if (existing.domain === null && vendorDomain) {
      db.prepare("UPDATE entities SET domain = ? WHERE id = ?").run(vendorDomain, existing.id);
    }
    return existing.id;
  }
  const created = db.prepare("INSERT INTO entities (name, domain) VALUES (?, ?)").run(name, vendorDomain);
  return Number(created.lastInsertRowid);
}

// "neon.com" for "Neon", "supabase.com" for "Supabase"; "jetadmin.io" is not Supabase's.
// Names under 3 letters are too short to match a hostname safely ("Go" is inside "google.com").
export function looksLikeVendorDomain(hostname: string, entityName: string): boolean {
  const name = entityName.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return name.length >= 3 && hostname.toLowerCase().includes(name);
}

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// The "shortlist" of a turn: every product the answer discussed.
export function entitiesForTurn(db: Database, turnId: number): string[] {
  const rows = db
    .prepare(
      `SELECT entities.name AS name FROM turn_entities
       JOIN entities ON entities.id = turn_entities.entity_id
       WHERE turn_entities.turn_id = ? ORDER BY turn_entities.rowid`,
    )
    .all(turnId) as { name: string }[];
  return rows.map((row) => row.name);
}
