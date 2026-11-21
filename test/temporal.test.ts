import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDates } from "../src/temporal.ts";

// 2026-11-16 is a Monday, 2026-11-18 a Wednesday, 2026-11-21 a Saturday.
const wednesday = new Date("2026-11-18T12:00:00Z");
const monday = new Date("2026-11-16T12:00:00Z");
const saturday = new Date("2026-11-21T10:00:00Z");

function only(text: string, now: Date, zone = "UTC") {
  const found = resolveDates(text, now, zone);
  assert.equal(found.length, 1, `expected one reference in "${text}", got ${JSON.stringify(found)}`);
  return found[0]!;
}

test("a bare weekday on a Wednesday means the Monday just gone", () => {
  const ref = only("What did I ask on Monday?", wednesday);
  assert.equal(ref.phrase, "Monday");
  assert.equal(ref.start, "2026-11-16T00:00:00.000Z");
  assert.equal(ref.end, "2026-11-17T00:00:00.000Z");
  assert.equal(ref.label, "Monday 16 Nov");
  assert.equal(ref.note, undefined);
});

test("a bare weekday that is today's weekday resolves to last week and says it could mean today", () => {
  const ref = only("Monday", monday);
  assert.equal(ref.start, "2026-11-09T00:00:00.000Z");
  assert.equal(ref.label, "Monday 9 Nov");
  assert.equal(ref.note, "could also mean today");
});

test("last Tuesday on a Saturday is the Tuesday of that week", () => {
  const ref = only("the shortlist from last Tuesday", saturday);
  assert.equal(ref.phrase, "last Tuesday");
  assert.equal(ref.label, "Tuesday 17 Nov");
  assert.equal(ref.start, "2026-11-17T00:00:00.000Z");
});

test("a weekday plus last week is that day in the previous Monday-to-Sunday week", () => {
  const ref = only("Monday last week", saturday);
  assert.equal(ref.phrase, "Monday last week");
  assert.equal(ref.label, "Monday 9 Nov");
  assert.equal(only("Sunday last week", saturday).label, "Sunday 15 Nov");
});

test("3 November asked on 21 Nov 2026 is this year, and asked on 1 Nov 2026 is last year", () => {
  const thisYear = only("the question I asked on 3 November", new Date("2026-11-21T10:00:00Z"));
  assert.equal(thisYear.start, "2026-11-03T00:00:00.000Z");
  assert.equal(thisYear.label, "Tuesday 3 Nov");

  const lastYear = only("the question I asked on 3 November", new Date("2026-11-01T10:00:00Z"));
  assert.equal(lastYear.start, "2025-11-03T00:00:00.000Z");
  assert.equal(lastYear.label, "Monday 3 Nov 2025");
});

test("the date is not in the future when asked on that very day", () => {
  assert.equal(only("3 November", new Date("2026-11-03T08:00:00Z")).start, "2026-11-03T00:00:00.000Z");
});

test("month and day spellings all give the same date, with or without a year", () => {
  for (const text of ["3 November", "November 3", "3 Nov", "Nov 3rd", "3rd of November", "Nov. 3"]) {
    assert.equal(only(text, saturday).start, "2026-11-03T00:00:00.000Z", text);
  }
  assert.equal(only("3 Nov 2024", saturday).start, "2024-11-03T00:00:00.000Z");
  assert.equal(only("November 3, 2024", saturday).start, "2024-11-03T00:00:00.000Z");
  assert.equal(only("Nov 3 2024", saturday).label, "Sunday 3 Nov 2024");
});

test("29 February with no year goes back to the last leap year; 31 November is not a date", () => {
  assert.equal(only("29 Feb", saturday).start, "2024-02-29T00:00:00.000Z");
  const bad = only("31 November", saturday);
  assert.equal(bad.start, null);
  assert.equal(bad.note, "not a real calendar date");
});

test("yesterday at 00:30 in India on 22 Nov is 21 Nov in India, not 20 Nov", () => {
  // 00:30 IST on 22 Nov is 19:00 UTC on 21 Nov.
  const now = new Date("2026-11-21T19:00:00Z");
  const ref = only("what did I ask yesterday", now, "Asia/Kolkata");
  assert.equal(ref.label, "Saturday 21 Nov");
  assert.equal(ref.start, "2026-11-20T18:30:00.000Z");
  assert.equal(ref.end, "2026-11-21T18:30:00.000Z");

  // The same instant read in UTC is still 21 Nov, so yesterday there is 20 Nov.
  assert.equal(only("yesterday", now, "UTC").label, "Friday 20 Nov");
});

test("a day that is 25 hours long (daylight saving ends) still starts and ends at local midnight", () => {
  const ref = only("yesterday", new Date("2026-11-02T15:00:00Z"), "America/New_York");
  assert.equal(ref.start, "2026-11-01T04:00:00.000Z");
  assert.equal(ref.end, "2026-11-02T05:00:00.000Z");
});

test("3/11 is returned as ambiguous with no range", () => {
  const ref = only("what did I ask on 3/11?", saturday);
  assert.equal(ref.phrase, "3/11");
  assert.equal(ref.note, "ambiguous numeric date");
  assert.equal(ref.start, null);
  assert.equal(ref.end, null);
  assert.equal(only("on 3.11.2026", saturday).note, "ambiguous numeric date");
});

test("things that are not dates are left alone", () => {
  assert.deepEqual(resolveDates("The price went from 2026/11 to version 1.5 with 45/60 seats and 25/30 points, may the best win", saturday, "UTC"), []);
});

test("today, earlier today, N days ago, this week and last week", () => {
  const today = only("today", saturday);
  assert.equal(today.start, "2026-11-21T00:00:00.000Z");
  assert.equal(today.end, "2026-11-22T00:00:00.000Z");

  const earlier = only("earlier today", saturday);
  assert.equal(earlier.start, "2026-11-21T00:00:00.000Z");
  assert.equal(earlier.end, "2026-11-21T10:00:00.000Z"); // up to now, not the rest of the day

  assert.equal(only("5 days ago", saturday).start, "2026-11-16T00:00:00.000Z");

  const thisWeek = only("this week", saturday);
  assert.equal(thisWeek.start, "2026-11-16T00:00:00.000Z");
  assert.equal(thisWeek.end, "2026-11-23T00:00:00.000Z");
  assert.equal(thisWeek.label, "week of Monday 16 Nov");

  const lastWeek = only("last week", saturday);
  assert.equal(lastWeek.start, "2026-11-09T00:00:00.000Z");
  assert.equal(lastWeek.end, "2026-11-16T00:00:00.000Z");
});

test("several references in one message come back in the order written", () => {
  const found = resolveDates("compare yesterday with 3 November and Monday", saturday, "UTC");
  assert.deepEqual(found.map((r) => r.phrase), ["yesterday", "3 November", "Monday"]);
});

test("a calendar date that starts before a clock change in an eastern zone gets the right midnight", () => {
  // Sydney's clocks go back at 3am on 5 April 2026, so midnight that day is still UTC+11.
  const ref = only("5 April 2026", saturday, "Australia/Sydney");
  assert.equal(ref.start, "2026-04-04T13:00:00.000Z");
  assert.equal(ref.end, "2026-04-05T14:00:00.000Z");
});
