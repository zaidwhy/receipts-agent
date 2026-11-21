import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { toIsoDate } from "../src/search.ts";

test("Tavily's RFC 1123 dates are stored as ISO", () => {
  assert.equal(toIsoDate("Thu, 05 Nov 2026 12:54:51 GMT"), "2026-11-05T12:54:51.000Z");
});

test("a missing or unreadable date becomes null, never a guess", () => {
  assert.equal(toIsoDate(undefined), null);
  assert.equal(toIsoDate("sometime last spring"), null);
});
