// Finds date references in a message ("yesterday", "last Tuesday", "3 November")
// and turns each into a range of UTC instants. Day boundaries are the user's own
// midnight, worked out with Intl, so "yesterday" at 00:30 in India is still the
// day before in India even though it is two days earlier in UTC.

export interface DateReference {
  phrase: string; // the words the user wrote
  start: string | null; // UTC ISO, null when the phrase cannot be resolved
  end: string | null; // UTC ISO, exclusive
  label: string | null; // "Tuesday 17 Nov"
  note?: string;
}

interface LocalDate {
  y: number;
  m: number; // 1 to 12
  d: number;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_WORD = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const WEEKDAY_WORD = WEEKDAYS.join("|");

export function resolveDates(text: string, now: Date, timeZone: string): DateReference[] {
  const zone = createZone(timeZone);
  const today = zone.dateOf(now);
  const found: { index: number; length: number; reference: DateReference }[] = [];

  function add(match: RegExpMatchArray, build: () => Omit<DateReference, "phrase"> | null): void {
    const index = match.index ?? 0;
    const length = match[0].length;
    // The first pattern to claim a stretch of text keeps it: "Monday last week" is one reference, not two.
    if (found.some((item) => index < item.index + item.length && item.index < index + length)) return;
    const built = build();
    if (built) found.push({ index, length, reference: { phrase: match[0], ...built } });
  }

  function day(date: LocalDate, note?: string): Omit<DateReference, "phrase"> {
    return {
      start: zone.midnight(date).toISOString(),
      end: zone.midnight(addDays(date, 1)).toISOString(),
      label: labelOf(date, today.y),
      ...(note ? { note } : {}),
    };
  }

  function week(monday: LocalDate): Omit<DateReference, "phrase"> {
    return {
      start: zone.midnight(monday).toISOString(),
      end: zone.midnight(addDays(monday, 7)).toISOString(),
      label: `week of ${labelOf(monday, today.y)}`,
    };
  }

  const thisMonday = addDays(today, -mondayIndex(today));

  for (const m of text.matchAll(new RegExp(`\\b(${WEEKDAY_WORD})\\s+(?:of\\s+)?last\\s+week\\b`, "gi"))) {
    add(m, () => day(addDays(thisMonday, -7 + (WEEKDAYS.indexOf(m[1]!.toLowerCase()) + 6) % 7)));
  }
  for (const m of text.matchAll(new RegExp(`\\blast\\s+(${WEEKDAY_WORD})\\b`, "gi"))) {
    add(m, () => day(addDays(today, -daysSince(today, WEEKDAYS.indexOf(m[1]!.toLowerCase())))));
  }
  for (const m of text.matchAll(/\bearlier\s+today\b/gi)) {
    add(m, () => ({ ...day(today), end: now.toISOString() }));
  }
  for (const m of text.matchAll(/\b(\d{1,3})\s+days?\s+ago\b/gi)) {
    add(m, () => day(addDays(today, -Number(m[1]))));
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_WORD})\\b(?:,?\\s+(\\d{4})\\b)?`, "gi"))) {
    add(m, () => calendarDate(Number(m[1]), monthNumber(m[2]!), m[3], today, day));
  }
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_WORD})\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, "gi"))) {
    add(m, () => calendarDate(Number(m[2]), monthNumber(m[1]!), m[3], today, day));
  }
  for (const m of text.matchAll(/\bthis\s+week\b/gi)) add(m, () => week(thisMonday));
  for (const m of text.matchAll(/\blast\s+week\b/gi)) add(m, () => week(addDays(thisMonday, -7)));
  for (const m of text.matchAll(/\btoday\b/gi)) add(m, () => day(today));
  for (const m of text.matchAll(/\byesterday\b/gi)) add(m, () => day(addDays(today, -1)));
  for (const m of text.matchAll(new RegExp(`\\b(${WEEKDAY_WORD})\\b`, "gi"))) {
    add(m, () => {
      const wanted = WEEKDAYS.indexOf(m[1]!.toLowerCase());
      // A bare weekday means the most recent past one. Today's own weekday is ambiguous, so it
      // resolves to last week's and says so.
      const ago = daysSince(today, wanted);
      return day(addDays(today, -ago), weekdayIndex(today) === wanted ? "could also mean today" : undefined);
    });
  }
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b|\b(\d{1,2})[.-](\d{1,2})[.-]\d{2,4}\b/g)) {
    const first = Number(m[1] ?? m[3]);
    const second = Number(m[2] ?? m[4]);
    // Looks like day and month, either way round; anything else (2026/11, 45/60) is not a date.
    if (first < 1 || second < 1 || first > 31 || second > 31 || (first > 12 && second > 12)) continue;
    add(m, () => ({ start: null, end: null, label: null, note: "ambiguous numeric date" }));
  }

  return found.sort((a, b) => a.index - b.index).map((item) => item.reference);
}

function calendarDate(
  dayOfMonth: number,
  month: number,
  yearText: string | undefined,
  today: LocalDate,
  day: (date: LocalDate, note?: string) => Omit<DateReference, "phrase">,
): Omit<DateReference, "phrase"> | null {
  if (yearText !== undefined) {
    const date = { y: Number(yearText), m: month, d: dayOfMonth };
    if (!isRealDate(date.y, date.m, date.d)) return { start: null, end: null, label: null, note: "not a real calendar date" };
    return day(date, compareDates(date, today) > 0 ? "this date is in the future" : undefined);
  }
  // No year: the most recent such date that is not in the future. The loop also copes with 29 Feb.
  for (let year = today.y; year >= today.y - 8; year -= 1) {
    const date = { y: year, m: month, d: dayOfMonth };
    if (isRealDate(year, month, dayOfMonth) && compareDates(date, today) <= 0) return day(date);
  }
  return { start: null, end: null, label: null, note: "not a real calendar date" };
}

function monthNumber(word: string): number {
  return MONTH_LABELS.findIndex((label) => label.toLowerCase() === word.slice(0, 3).toLowerCase()) + 1;
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (d < 1 || m < 1 || m > 12) return false;
  const check = new Date(Date.UTC(y, m - 1, d));
  return check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

function compareDates(a: LocalDate, b: LocalDate): number {
  return a.y * 10000 + a.m * 100 + a.d - (b.y * 10000 + b.m * 100 + b.d);
}

// Calendar arithmetic on plain dates. Date.UTC is used only as a day counter, never as a clock.
function addDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: moved.getUTCFullYear(), m: moved.getUTCMonth() + 1, d: moved.getUTCDate() };
}

function weekdayIndex(date: LocalDate): number {
  return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
}

// Weeks start on Monday: Monday is 0, Sunday is 6.
function mondayIndex(date: LocalDate): number {
  return (weekdayIndex(date) + 6) % 7;
}

// How many days back the most recent past occurrence of a weekday is: 1 to 7, never 0.
function daysSince(today: LocalDate, weekday: number): number {
  return (weekdayIndex(today) - weekday + 7) % 7 || 7;
}

export function labelOf(date: LocalDate, currentYear: number): string {
  const base = `${WEEKDAY_LABELS[weekdayIndex(date)]} ${date.d} ${MONTH_LABELS[date.m - 1]}`;
  return date.y === currentYear ? base : `${base} ${date.y}`;
}

// "Tuesday 17 Nov" for an instant, as seen in the given zone.
export function labelForInstant(instant: Date, timeZone: string, now: Date): string {
  const zone = createZone(timeZone);
  return labelOf(zone.dateOf(instant), zone.dateOf(now).y);
}

function createZone(timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });

  function parts(instantMs: number): { local: number; date: LocalDate } {
    const values: Record<string, number> = {};
    for (const part of formatter.formatToParts(new Date(instantMs))) {
      if (part.type !== "literal") values[part.type] = Number(part.value);
    }
    const local = Date.UTC(values.year!, values.month! - 1, values.day!, values.hour!, values.minute!, values.second!);
    return { local, date: { y: values.year!, m: values.month!, d: values.day! } };
  }

  function offsetMs(instantMs: number): number {
    return parts(instantMs).local - Math.floor(instantMs / 1000) * 1000;
  }

  return {
    dateOf: (instant: Date): LocalDate => parts(instant.getTime()).date,
    // The UTC instant at which this calendar date starts in the zone. Two passes handle
    // zones whose offset changes (daylight saving) between the guess and the real midnight.
    midnight(date: LocalDate): Date {
      const guess = Date.UTC(date.y, date.m - 1, date.d);
      const first = guess - offsetMs(guess);
      return new Date(guess - offsetMs(first));
    },
  };
}
