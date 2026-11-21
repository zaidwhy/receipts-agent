// Record and replay helpers shared by search.ts and reader.ts.
// A fixture is one JSON file named after a hash of the request, so the same
// request always finds the same file.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FixtureKind = "search" | "page";

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
