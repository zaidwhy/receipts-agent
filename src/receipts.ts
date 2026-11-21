// Snapshots: the cleaned text of a cited page, kept so a later check can compare
// what the page said then with what it says now. Anchors: where in that text a
// claim's quote sits, stored as the quote plus 32 characters on each side.
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Database } from "./db.ts";

export const SNAPSHOT_TEXT_CAP_BYTES = 200 * 1024;
const ANCHOR_CONTEXT_CHARS = 32;

// Unicode form NFKC and single spaces, so layout changes do not change the hash.
export function normalizeText(text: string): string {
  // The "$ 168" rule: extracted markdown sometimes puts a space after the currency sign,
  // while the model copies "$168". Joining them keeps price quotes matchable.
  return text.normalize("NFKC").replace(/\s+/g, " ").replace(/([$€£₹]) (?=\d)/g, "$1").trim();
}

export interface SavedSnapshot {
  hash: string;
  text: string; // the normalised, possibly truncated text that was stored
  truncated: boolean;
  alreadyStored: boolean;
}

export function saveSnapshot(
  db: Database,
  url: string,
  finalUrl: string,
  text: string,
  extractor: string,
  fetchedAt: string,
  publishedAt?: string,
): SavedSnapshot {
  const normalized = normalizeText(text);
  const { text: stored, truncated } = capToBytes(normalized, SNAPSHOT_TEXT_CAP_BYTES);
  // Hashing the stored text (not the original) means the hash always matches what is in the row.
  const hash = createHash("sha256").update(stored).digest("hex");

  const existing = db.prepare("SELECT hash FROM snapshots WHERE hash = ?").get(hash);
  if (existing) return { hash, text: stored, truncated, alreadyStored: true };

  db.prepare(
    `INSERT INTO snapshots (hash, url, final_url, text_gz, fetched_at, published_at, extractor, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(hash, url, finalUrl, gzipSync(Buffer.from(stored, "utf8")), fetchedAt, publishedAt ?? null, extractor, truncated ? "truncated" : "ok");
  return { hash, text: stored, truncated, alreadyStored: false };
}

export function loadSnapshotText(db: Database, hash: string): string | null {
  const row = db.prepare("SELECT text_gz FROM snapshots WHERE hash = ?").get(hash) as { text_gz: Uint8Array } | undefined;
  if (!row) return null;
  return gunzipSync(row.text_gz).toString("utf8");
}

function capToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  // Cutting in the middle of a multi-byte character leaves a replacement character; drop it.
  const cut = bytes.subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
  return { text: cut, truncated: true };
}

export interface Anchor {
  exact: string;
  prefix: string;
  suffix: string;
}

// Returns null when the quote is not in the page. Both sides are normalised first.
export function anchorQuote(snapshotText: string, quote: string): Anchor | null {
  const page = normalizeText(snapshotText);
  const exact = normalizeText(quote);
  if (exact === "") return null;
  const start = page.indexOf(exact);
  if (start === -1) return null;
  const end = start + exact.length;
  return {
    exact,
    prefix: page.slice(Math.max(0, start - ANCHOR_CONTEXT_CHARS), start),
    suffix: page.slice(end, end + ANCHOR_CONTEXT_CHARS),
  };
}
