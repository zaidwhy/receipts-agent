import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { topicSearchMode, type Database } from "../src/db.ts";
import { describeRecall, parseRecallArguments, recall, refersToPastConversation, TOPIC_RESULT_LIMIT } from "../src/memory.ts";
import { storeClaims } from "../src/claims.ts";
import { memoryDb, seedExchange } from "./helpers.ts";

// "Now" is Saturday 21 Nov 2026, 15:30 in India.
const now = new Date("2026-11-21T10:00:00Z");
const zone = "Asia/Kolkata";

function seeded(): Database {
  const db = memoryDb();
  seedExchange(db, {
    question: "Which CRM should we shortlist, HubSpot or Pipedrive?",
    answer: "Pipedrive is cheaper for a small team.",
    askedAt: "2026-11-03T08:00:00.000Z",
    entities: ["HubSpot", "Pipedrive"],
    claims: [
      {
        text: "Pipedrive Essential costs $14 per user per month",
        kind: "price",
        entity: "Pipedrive",
        quote: "Essential $14",
        url: "https://www.pipedrive.com/en/pricing",
        page: "Essential $14 per user per month",
        fetchedAt: "2026-11-03T08:00:03.000Z",
      },
      {
        text: "Pipedrive launched its AI assistant on 3 Nov",
        kind: "date",
        entity: "Pipedrive",
        quote: "AI assistant",
        url: "https://www.pipedrive.com/en/blog",
        page: "We launched the AI assistant today",
        fetchedAt: "2026-11-03T08:00:03.000Z",
      },
    ],
  });
  seedExchange(db, {
    question: "What does AcmeDB cost?",
    answer: "AcmeDB Launch is $19 per month.",
    askedAt: "2026-11-17T09:00:00.000Z",
    entities: ["AcmeDB", "OtherDB"],
    claims: [
      {
        text: "AcmeDB Launch costs $19 per month",
        kind: "price",
        entity: "AcmeDB",
        quote: "Launch $19",
        url: "https://www.acmedb.dev/pricing",
        page: "Launch $19 per month",
        fetchedAt: "2026-11-17T09:00:04.000Z",
      },
    ],
  });
  return db;
}

// Tuesday 17 Nov and Tuesday 3 Nov as India sees them.
const tuesday17 = { start: "2026-11-16T18:30:00.000Z", end: "2026-11-17T18:30:00.000Z" };
const tuesday3 = { start: "2026-11-02T18:30:00.000Z", end: "2026-11-03T18:30:00.000Z" };

test("recall by date range returns the question, answer, entity set and claims with source and age", () => {
  const result = recall(seeded(), { range: tuesday17 }, now, { timeZone: zone });

  assert.equal(result.found.length, 1);
  const turn = result.found[0]!;
  assert.equal(turn.question, "What does AcmeDB cost?");
  assert.equal(turn.answer, "AcmeDB Launch is $19 per month.");
  assert.equal(turn.askedAtLocal, "Tuesday 17 Nov, 14:30");
  assert.deepEqual(turn.entities, ["AcmeDB", "OtherDB"]);
  assert.deepEqual(turn.claims, [
    {
      text: "AcmeDB Launch costs $19 per month",
      kind: "price",
      entity: "AcmeDB",
      sourceUrl: "https://www.acmedb.dev/pricing",
      fetchedAt: "2026-11-17T09:00:04.000Z",
      ageDays: 4,
      expired: false,
    },
  ]);
});

test("a price claim older than its shelf life is expired, a date claim never is", () => {
  const turn = recall(seeded(), { range: tuesday3 }, now, { timeZone: zone }).found[0]!;
  const price = turn.claims.find((claim) => claim.kind === "price")!;
  const date = turn.claims.find((claim) => claim.kind === "date")!;
  assert.equal(price.ageDays, 18);
  assert.equal(price.expired, true);
  assert.equal(date.ageDays, 18);
  assert.equal(date.expired, false);
});

test("recall by topic finds a turn by a word that only its answer contains", () => {
  const db = seeded();
  const result = recall(db, { topic: "cheaper" }, now, { timeZone: zone });
  assert.deepEqual(result.found.map((turn) => turn.question), ["Which CRM should we shortlist, HubSpot or Pipedrive?"]);
  // Every word of the topic must be in the question or its answer.
  assert.equal(recall(db, { topic: "cheaper acmedb" }, now).found.length, 0);
  assert.equal(recall(db, { topic: "pipedrive cheaper" }, now).found.length, 1);
});

test("topic matches come newest first and stop at 5, saying how many were left out", () => {
  const db = memoryDb();
  for (let day = 1; day <= 7; day += 1) {
    seedExchange(db, { question: `Widget question number ${day}`, answer: "Widgets are fine.", askedAt: `2026-11-0${day}T09:00:00.000Z` });
  }
  const result = recall(db, { topic: "widget" }, now);
  assert.equal(result.found.length, TOPIC_RESULT_LIMIT);
  assert.deepEqual(result.found.map((turn) => turn.question), [7, 6, 5, 4, 3].map((n) => `Widget question number ${n}`));
  assert.equal(result.omitted, 2);
});

test("FTS5 and the LIKE fallback find the same turns", () => {
  const db = seeded();
  assert.equal(topicSearchMode(db), "fts5");
  for (const topic of ["pipedrive", "pipe", "acmedb pricing", "launch", "nothing like this"]) {
    const viaFts = recall(db, { topic }, now, { topicSearch: "fts5" }).found.map((turn) => turn.question);
    const viaLike = recall(db, { topic }, now, { topicSearch: "like" }).found.map((turn) => turn.question);
    assert.deepEqual(viaFts, viaLike, topic);
  }
  assert.equal(recall(db, { topic: "pipedrive" }, now, { topicSearch: "like" }).topicSearch, "like");
});

test("odd characters in a topic cannot break the search or the database", () => {
  const db = seeded();
  for (const topic of ['"; DROP TABLE turns; --', 'pipedrive" OR "', "NEAR( ) * ^ :", "%_%", "pipedrive not near and or"]) {
    assert.doesNotThrow(() => recall(db, { topic }, now), topic);
    assert.doesNotThrow(() => recall(db, { topic }, now, { topicSearch: "like" }), topic);
  }
  assert.equal(recall(db, { topic: "pipedrive" }, now).found.length, 1);
});

test("an empty range returns no turns and the dates of the nearest turns on each side", () => {
  const wednesday11 = { start: "2026-11-10T18:30:00.000Z", end: "2026-11-11T18:30:00.000Z" };
  const result = recall(seeded(), { range: wednesday11 }, now, { timeZone: zone });
  assert.deepEqual(result.found, []);
  assert.deepEqual(result.nearest, ["Tuesday 3 Nov", "Tuesday 17 Nov"]);

  // Before everything: only the later side exists. Empty memory: neither.
  const early = recall(seeded(), { range: { start: "2026-10-01T00:00:00.000Z", end: "2026-10-02T00:00:00.000Z" } }, now, { timeZone: zone });
  assert.deepEqual(early.nearest, ["Tuesday 3 Nov"]);
  assert.deepEqual(recall(memoryDb(), { range: wednesday11 }, now).nearest, []);
});

test("the current question is never recalled as an earlier one", () => {
  const db = seeded();
  const { questionId } = seedExchange(db, { question: "What did we say about Pipedrive?", answer: "", askedAt: "2026-11-21T09:59:00.000Z" });
  const result = recall(db, { topic: "pipedrive" }, now, { beforeTurnId: questionId });
  assert.deepEqual(result.found.map((turn) => turn.question), ["Which CRM should we shortlist, HubSpot or Pipedrive?"]);
});

test("a question whose answer was never stored comes back with no answer", () => {
  const db = memoryDb();
  seedExchange(db, { question: "Unanswered one", answer: "x", askedAt: "2026-11-05T09:00:00.000Z" });
  db.prepare("DELETE FROM turns WHERE role = 'assistant'").run();
  const turn = recall(db, {}, now).found[0]!;
  assert.equal(turn.answer, null);
  assert.deepEqual(turn.claims, []);
});

test("recall tool arguments are checked and an empty result says there is no record", () => {
  assert.deepEqual(parseRecallArguments("{}", now), { query: {} });
  assert.deepEqual(parseRecallArguments('{"topic": " pricing "}', now), { query: { topic: "pricing" } });
  const ranged = parseRecallArguments('{"start": "2026-11-17T00:00:00Z"}', now);
  assert.deepEqual(ranged, { query: { range: { start: "2026-11-17T00:00:00.000Z", end: now.toISOString() } } });
  assert.match((parseRecallArguments('{"start": "yesterday"}', now) as { error: string }).error, /ISO date-times/);
  assert.match((parseRecallArguments('{"start": "2026-11-18T00:00:00Z", "end": "2026-11-17T00:00:00Z"}', now) as { error: string }).error, /before end/);
  assert.match((parseRecallArguments("not json", now) as { error: string }).error, /not valid JSON/);

  const empty = describeRecall({ found: [], omitted: 0, nearest: ["Tuesday 3 Nov"], topicSearch: "fts5" }, {}, "Monday 16 Nov");
  assert.match(empty, /^No record of any conversation for Monday 16 Nov\. The nearest recorded dates are: Tuesday 3 Nov\./);
  assert.match(empty, /Do not invent/);
});

test("only messages about the earlier conversation count as memory references", () => {
  for (const text of ["What did I ask you earlier today?", "you told me on Monday", "we shortlisted five tools", "last time we talked", "Tell me again what was said earlier", "Did I ask about Neon?", "What did we discuss last week?", "did you say that?", "my question on Tuesday", "Last Tuesday we compared Neon, Supabase and Render", "On Monday we narrowed it down to three", "the CRM you recommended on Friday", "what we looked at yesterday", "the plan I picked last week"]) {
    assert.equal(refersToPastConversation(text), true, text);
  }
  for (const text of ["What does Neon cost on Monday?", "What changed on 3 November?", "hi", "We need a CRM for 20 people", "I used Neon last week, is it cheaper now?"]) {
    assert.equal(refersToPastConversation(text), false, text);
  }
});

test("a turn exactly at the start of a range is in it, one exactly at the end is not", () => {
  const db = memoryDb();
  seedExchange(db, { question: "At the start", answer: "a", askedAt: "2026-11-10T00:00:00.000Z" });
  seedExchange(db, { question: "At the end", answer: "b", askedAt: "2026-11-11T00:00:00.000Z" });
  const result = recall(db, { range: { start: "2026-11-10T00:00:00.000Z", end: "2026-11-11T00:00:00.000Z" } }, now);
  assert.deepEqual(result.found.map((turn) => turn.question), ["At the start"]);
});

test("the nearest dates are the closest turn before and the closest turn after", () => {
  const db = memoryDb();
  for (const [name, day] of [["a", "01"], ["b", "02"], ["c", "03"], ["d", "08"], ["e", "09"]] as const) {
    seedExchange(db, { question: `Question ${name}`, answer: "x", askedAt: `2026-11-${day}T09:00:00.000Z` });
  }
  const result = recall(db, { range: { start: "2026-11-05T00:00:00.000Z", end: "2026-11-06T00:00:00.000Z" } }, now);
  assert.deepEqual(result.nearest, ["Tuesday 3 Nov", "Sunday 8 Nov"]);
});

test("a claim with no source page is aged from the answer, and has no fetch date", () => {
  const db = memoryDb();
  const { answerId } = seedExchange(db, { question: "Q", answer: "A", askedAt: "2026-11-07T09:00:00.000Z" });
  storeClaims(db, { turnId: answerId, claims: [{ text: "Launch is $19", kind: "price", entity: "AcmeDB", source: 1, quote: "$19" }], snapshots: new Map() });
  const claim = recall(db, {}, now).found[0]!.claims[0]!;
  assert.equal(claim.fetchedAt, null);
  assert.equal(claim.sourceUrl, null);
  assert.equal(claim.ageDays, 14);
  assert.equal(claim.expired, true);
});

test("a claim's age counts from when its page was read, not from when the question was asked", () => {
  const db = memoryDb();
  seedExchange(db, {
    question: "Q",
    answer: "A",
    askedAt: "2026-11-01T09:00:00.000Z",
    claims: [{ text: "Launch is $19", kind: "price", entity: "AcmeDB", quote: "$19", url: "https://acmedb.dev/p", page: "$19", fetchedAt: "2026-11-14T09:00:00.000Z" }],
  });
  const claim = recall(db, {}, now).found[0]!.claims[0]!;
  assert.equal(claim.ageDays, 7);
});
