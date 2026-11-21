// The web_search tool: run the model's queries in parallel, pick a few distinct
// pages (official pages the model named first, then vendor sites), read them, and
// hand an excerpt of each back numbered so the model can cite [n].
import type { Clock } from "./clock.ts";
import { excerptFor } from "./excerpt.ts";
import type { ToolDefinition } from "./llm.ts";
import { createLogger } from "./log.ts";
import type { Extractor, ReaderPort, ReadOutcome } from "./reader.ts";
import type { SearchPort, SearchResult } from "./search.ts";
import type { Speculation } from "./speculative.ts";
import { queryTerms } from "./excerpt.ts";

const log = createLogger("tools");

export const MAX_QUERIES = 4;
export const MAX_PAGES_READ = 3;
export const MAX_DIRECT_URLS = 3;
const SPECULATION_MATCH_SHARE = 0.5;

export const WEB_SEARCH_TOOL: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web and read the top pages. Pass 1 to 4 self-contained queries that cover different angles " +
    "(no pronouns, name the product or company in every query). Returns numbered sources with an excerpt of each page. " +
    "For prices or plans of named products, also pass each vendor's official pricing page in urls.",
  parameters: {
    type: "object",
    properties: {
      queries: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: MAX_QUERIES,
        description: "Self-contained search queries.",
      },
      start_date: {
        type: "string",
        description: "Optional YYYY-MM-DD. Only for questions about what is new or recent: ignore results older than this.",
      },
      urls: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_DIRECT_URLS,
        description:
          "Optional official pages you already know, e.g. https://supabase.com/pricing. They are read directly and ranked first.",
      },
    },
    required: ["queries"],
  },
};

// A page the model can cite. Numbers are stable for the whole turn.
export interface Source {
  n: number;
  title: string;
  url: string;
  finalUrl: string;
  text: string;
  extractor: Extractor;
  fetchedAt: string;
  publishedAt: string | null;
}

export interface ToolContext {
  search: SearchPort;
  reader: ReaderPort;
  clock: Clock;
  sources: Source[]; // grows across tool calls in one turn
  status: (text: string) => void;
  // Milliseconds spent, summed over the turn. Direct page reads run beside the searches, so the two overlap.
  timings?: { searchMs: number; readMs: number };
  // A search and two page reads started before the model chose its queries (SPECULATIVE_SEARCH=1).
  speculation?: Promise<Speculation | null>;
  speculationOutcome?: "hit" | "miss"; // set by the first web_search of the turn
}

export async function runWebSearch(context: ToolContext, rawArguments: string): Promise<string> {
  const parsed = parseArguments(rawArguments);
  if ("error" in parsed) return parsed.error;
  const { queries, startDate, urls } = parsed;

  const notes: string[] = [];
  const readTime = context.clock.now().toISOString();

  // Only the first web_search of a turn can use the guess; after that it is spent.
  const guess = context.speculation ? await context.speculation : null;
  const speculating = context.speculation !== undefined;
  context.speculation = undefined;
  if (guess && speculationMatches(guess, queries, urls)) {
    context.speculationOutcome = "hit";
    context.status("using pages already found");
    // The model's own queries are skipped: the guess stands in for them. Official pages it named that the
    // guess did not read are still read, beside nothing else, so they cost one read.
    const covered = new Set(guess.pages.map((page) => domainOf(page.url)));
    const extra = await readPages(context, urls.filter((url) => !covered.has(domainOf(url))));
    const titles = new Map(guess.results.map((result) => [result.url, { url: result.url, title: result.title, snippet: "", publishedDate: result.publishedDate }]));
    return describePages(context, [{ pages: guess.pages, failures: [] }, extra], titles, queries.join(" "), readTime, notes, urls.length + guess.pages.length === 0);
  }
  if (speculating) context.speculationOutcome = "miss";

  context.status(`searching ${queries.length} ${queries.length === 1 ? "query" : "queries"}`);

  // Official pages are read while the searches run, so they cost no extra waiting.
  const direct = readPages(context, urls);

  const searchStarted = performance.now();
  const perQuery = await Promise.all(
    queries.map(async (query) => {
      try {
        const outcome = await context.search.search({ query, startDate });
        if (outcome.timedOut) notes.push(`Search timed out for "${query}".`);
        return outcome.results;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn("search failed", { query, message });
        notes.push(`Search failed for "${query}": ${message}`);
        return [];
      }
    }),
  );

  if (context.timings) context.timings.searchMs += performance.now() - searchStarted;

  // A search hit on a domain the model already named adds nothing, so it is skipped.
  const directDomains = new Set(urls.map(domainOf));
  const picked = choosePages(perQuery, queries, Math.max(1, MAX_PAGES_READ - urls.length), directDomains);
  const searched = readPages(context, picked.map((result) => result.url));

  const titles = new Map(picked.map((result) => [result.url, result]));
  return describePages(context, await Promise.all([direct, searched]), titles, queries.join(" "), readTime, notes, picked.length + urls.length === 0);
}

// Numbers each page that was read, adds it to the turn's sources and writes the excerpt the model reads.
function describePages(
  context: ToolContext,
  outcomes: ReadOutcome[],
  titles: Map<string, SearchResult>,
  query: string,
  readTime: string,
  notes: string[],
  nothingToRead: boolean,
): string {
  const lines: string[] = [];
  for (const outcome of outcomes) {
    for (const page of outcome.pages) {
      const hit = titles.get(page.url);
      const source = addSource(context.sources, {
        title: hit?.title ?? page.url,
        url: page.url,
        finalUrl: page.finalUrl,
        text: page.text,
        extractor: page.extractor,
        fetchedAt: readTime,
        publishedAt: page.publishedAt ?? hit?.publishedDate ?? null,
      });
      const published = source.publishedAt ? `published ${source.publishedAt}` : "publish date unknown";
      const excerpt = excerptFor(source.text, query);
      const shown = excerpt.length < source.text.length ? `excerpt of ${source.text.length} characters` : "full text";
      lines.push(`[${source.n}] ${source.title} - ${source.url} (${published}; ${shown})`);
      lines.push(excerpt);
      lines.push("");
    }
    for (const failure of outcome.failures) {
      notes.push(`Could not read ${failure.url} (${failure.reason}: ${failure.error}). Treat it as unreadable.`);
    }
  }
  if (lines.length === 0) lines.push(nothingToRead ? "No pages found." : "No page could be read.");
  return [...lines, ...notes].join("\n");
}

// The guess counts when the model named one of the pages' sites itself, or planned a query that shares
// at least half its words with the user's message.
export function speculationMatches(speculation: Speculation, queries: string[], urls: string[]): boolean {
  const pageDomains = new Set(speculation.pages.map((page) => domainOf(page.url)));
  if (urls.some((url) => pageDomains.has(domainOf(url)))) return true;
  const asked = new Set(queryTerms(speculation.query));
  return queries.some((query) => {
    const planned = queryTerms(query);
    if (planned.length === 0) return false;
    return planned.filter((word) => asked.has(word)).length / planned.length >= SPECULATION_MATCH_SHARE;
  });
}

// A reader that throws is reported as every page failing, so one bad call never hides the other.
async function readPages(context: ToolContext, urls: string[]): Promise<ReadOutcome> {
  if (urls.length === 0) return { pages: [], failures: [] };
  for (const url of urls) context.status(`reading ${shortUrl(url)}`);
  const started = performance.now();
  try {
    return await context.reader.read(urls);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("reader failed", { message });
    return { pages: [], failures: urls.map((url) => ({ url, reason: "failed" as const, error: message })) };
  } finally {
    if (context.timings) context.timings.readMs += performance.now() - started;
  }
}

function parseArguments(raw: string): { queries: string[]; startDate?: string; urls: string[] } | { error: string } {
  let args: unknown;
  try {
    args = JSON.parse(raw || "{}");
  } catch {
    return { error: "Invalid arguments: not valid JSON. Call web_search again with a queries array." };
  }
  const { queries, start_date, urls } = (args ?? {}) as { queries?: unknown; start_date?: unknown; urls?: unknown };
  if (
    !Array.isArray(queries) ||
    queries.length < 1 ||
    queries.length > MAX_QUERIES ||
    !queries.every((query) => typeof query === "string" && query.trim() !== "")
  ) {
    return { error: `Invalid arguments: queries must be 1 to ${MAX_QUERIES} non-empty strings.` };
  }
  const startDate = typeof start_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(start_date) ? start_date : undefined;
  return { queries: queries as string[], startDate, urls: cleanUrls(urls) };
}

// Only http(s) links, at most three, no repeats; anything else is ignored.
function cleanUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const kept: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    try {
      const parsed = new URL(item.trim());
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
      if (!kept.includes(parsed.href)) kept.push(parsed.href);
    } catch {
      // not a URL
    }
    if (kept.length === MAX_DIRECT_URLS) break;
  }
  return kept;
}

// Round-robin across queries so every query gets its best result considered,
// one page per domain, vendor domains first.
export function choosePages(perQuery: SearchResult[][], queries: string[], limit: number = MAX_PAGES_READ, skipDomains: Set<string> = new Set()): SearchResult[] {
  const interleaved: SearchResult[] = [];
  const longest = Math.max(0, ...perQuery.map((results) => results.length));
  for (let rank = 0; rank < longest; rank += 1) {
    for (const results of perQuery) {
      const result = results[rank];
      if (result) interleaved.push(result);
    }
  }

  const seenDomains = new Set<string>();
  const distinct: SearchResult[] = [];
  for (const result of interleaved) {
    const domain = domainOf(result.url);
    if (!domain || seenDomains.has(domain) || skipDomains.has(domain)) continue;
    seenDomains.add(domain);
    distinct.push(result);
  }

  const wanted = queries.join(" ").toLowerCase();
  const vendors = distinct.filter((result) => isVendorDomain(domainOf(result.url), wanted));
  const others = distinct.filter((result) => !vendors.includes(result));
  return [...vendors, ...others].slice(0, limit);
}

// A vendor site is one whose name appears in the queries: "neon.com" for "neon pricing".
export function isVendorDomain(domain: string, queryText: string): boolean {
  const parts = domain.split(".");
  parts.pop(); // top-level domain
  if (parts.length > 1 && ["co", "com", "org", "net", "gov", "ac"].includes(parts[parts.length - 1] ?? "")) parts.pop();
  const name = parts[parts.length - 1] ?? "";
  return name.length >= 3 && queryText.includes(name);
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const short = parsed.hostname.replace(/^www\./, "") + (parsed.pathname === "/" ? "" : parsed.pathname);
    return short.length > 60 ? short.slice(0, 57) + "..." : short;
  } catch {
    return url;
  }
}

// The same page found by two searches keeps one number.
function addSource(sources: Source[], fields: Omit<Source, "n">): Source {
  const existing = sources.find((source) => source.url === fields.url);
  if (existing) return existing;
  const source = { n: sources.length + 1, ...fields };
  sources.push(source);
  return source;
}
