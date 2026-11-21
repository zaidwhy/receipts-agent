// SQLite through the built-in node:sqlite module (no native dependency).
// Every statement uses ? placeholders; values never get glued into SQL text.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "./log.ts";

const log = createLogger("db");

export type Database = DatabaseSync;

const SCHEMA_VERSION = 1;

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  createTables(db);
  // Recall's topic search uses FTS5 when this SQLite build has it, plain LIKE otherwise.
  log.info(`topic search: ${topicSearchMode(db) === "fts5" ? "FTS5" : "LIKE fallback (this SQLite has no FTS5)"}`);
  return db;
}

export type TopicSearchMode = "fts5" | "like";

export function topicSearchMode(db: Database): TopicSearchMode {
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'turns_fts'").get();
  return row ? "fts5" : "like";
}

// Turns are only ever inserted, never edited or deleted, so one insert trigger keeps the index current.
function createTopicIndex(db: Database): void {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(text, content='turns', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS turns_fts_insert AFTER INSERT ON turns BEGIN
        INSERT INTO turns_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);
  } catch {
    // No FTS5 in this build; topicSearchMode reports "like" because the table is missing.
  }
}

// "IF NOT EXISTS" makes this safe to run on every start.
function createTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      text TEXT NOT NULL,
      asked_at TEXT NOT NULL,   -- UTC ISO time
      tz TEXT NOT NULL,         -- IANA zone the user was in
      topic_tags TEXT           -- filled by the memory step
    );
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT,
      feed_url TEXT,
      feed_checked_at TEXT      -- when feed discovery last ran, so a miss is not probed on every question
    );
    CREATE TABLE IF NOT EXISTS turn_entities (
      turn_id INTEGER NOT NULL REFERENCES turns(id),
      entity_id INTEGER NOT NULL REFERENCES entities(id),
      PRIMARY KEY (turn_id, entity_id)
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      hash TEXT PRIMARY KEY,    -- sha256 of the normalised text
      url TEXT NOT NULL,
      final_url TEXT NOT NULL,
      text_gz BLOB NOT NULL,
      fetched_at TEXT NOT NULL,
      published_at TEXT,
      extractor TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ok', 'truncated'))
    );
    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY,
      turn_id INTEGER NOT NULL REFERENCES turns(id),
      entity_id INTEGER REFERENCES entities(id),
      text TEXT NOT NULL,
      kind TEXT NOT NULL,
      volatility INTEGER,       -- days the claim stays fresh; NULL means it never expires
      snapshot_hash TEXT REFERENCES snapshots(hash),
      quote TEXT NOT NULL,
      prefix TEXT,
      suffix TEXT,
      anchored INTEGER NOT NULL CHECK (anchored IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS rechecks (
      claim_id INTEGER NOT NULL REFERENCES claims(id),
      checked_at TEXT NOT NULL,
      tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 4),
      status TEXT NOT NULL,
      new_snapshot_hash TEXT REFERENCES snapshots(hash),
      new_value TEXT,           -- what the page says now, when it changed
      note TEXT                 -- why: reads disagreed, a lead from another source, the model's one-line reason
    );
    CREATE TABLE IF NOT EXISTS events (
      entity_id INTEGER NOT NULL REFERENCES entities(id),
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      published_at TEXT,        -- NULL for an undated item
      kind TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('feed', 'search')),
      confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
      UNIQUE (entity_id, url)
    );
  `);
  createTopicIndex(db);
  const row = db.prepare("SELECT version FROM schema_version").get();
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
}

export interface Turn {
  id: number;
  role: "user" | "assistant";
  text: string;
  askedAt: string;
  tz: string;
}

export function insertTurn(db: Database, role: Turn["role"], text: string, askedAt: string, tz: string): number {
  const result = db
    .prepare("INSERT INTO turns (role, text, asked_at, tz) VALUES (?, ?, ?, ?)")
    .run(role, text, askedAt, tz);
  return Number(result.lastInsertRowid);
}

// Oldest first, so the result can be sent to the model as-is.
export function recentTurns(db: Database, limit: number): Turn[] {
  const rows = db
    .prepare("SELECT id, role, text, asked_at, tz FROM turns ORDER BY id DESC LIMIT ?")
    .all(limit) as { id: number; role: Turn["role"]; text: string; asked_at: string; tz: string }[];
  return rows.reverse().map((row) => ({ id: row.id, role: row.role, text: row.text, askedAt: row.asked_at, tz: row.tz }));
}
