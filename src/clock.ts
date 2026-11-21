// Every "what time is it" in the app goes through a Clock so tests and demos can fix it.
export interface Clock {
  now(): Date;
}

// Order of precedence: explicit argument, AGENT_NOW env variable, real time.
export function createClock(fixedIso: string | undefined = process.env.AGENT_NOW): Clock {
  const fixed = fixedIso?.trim();
  if (!fixed) return { now: () => new Date() };
  const instant = new Date(fixed);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`AGENT_NOW is not a valid ISO date-time: "${fixed}"`);
  }
  return { now: () => new Date(instant) };
}

// The browser sends an IANA zone name; anything Intl does not know falls back to UTC.
export function resolveTimezone(candidate: unknown): string {
  if (typeof candidate !== "string" || candidate === "") return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate });
    return candidate;
  } catch {
    return "UTC";
  }
}

// "Saturday 21 November 2026" as the user sees it in their own zone.
export function describeToday(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);
}
