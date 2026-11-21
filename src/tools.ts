// The web_search tool: run the model's queries in parallel, pick a few distinct
// pages (vendor sites first), read them in full, and hand the text back numbered
// so the model can cite [n].
import type { Clock } from "./clock.ts";
import type { ToolDefinition } from "./llm.ts";
import { createLogger } from "./log.ts";
import type { Extractor, ReaderPort } from "./reader.ts";
import type { SearchPort, SearchResult } from "./search.ts";

const log = createLogger("tools");

export const MAX_QUERIES = 4;
export const MAX_PAGES_READ = 4;
// How much of each page the model sees. The full text is still what gets stored.
const MAX_PAGE_CHARS_FOR_MODEL = 8000;

export const WEB_SEARCH_TOOL: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web and read the top pages. Pass 1 to 4 self-contained queries that cover different angles " +
    "(no pronouns, name the product or company in every query). Returns numbered sources with page text.",
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
}

export async function runWebSearch(context: ToolContext, rawArguments: string): Promise<string> {
  const parsed = parseArguments(rawArguments);
  if ("error" in parsed) return parsed.error;
  const { queries, startDate } = parsed;

  context.status(`searching ${queries.length} ${queries.length === 1 ? "query" : "queries"}`);
  const notes: string[] = [];
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

  const chosen = choosePages(perQuery, queries);
  if (chosen.length === 0) {
    return ["No pages found.", ...notes].join("\n");
  }

  for (const result of chosen) context.status(`reading ${shortUrl(result.url)}`);
  const readTime = context.clock.now().toISOString();
  let outcome;
  try {
    outcome = await context.reader.read(chosen.map((result) => result.url));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("reader failed", { message });
    return [`Could not read any page: ${message}`, ...notes].join("\n");
  }

  const lines: string[] = [];
  for (const page of outcome.pages) {
    const result = chosen.find((item) => item.url === page.url);
    const source = addSource(context.sources, {
      title: result?.title ?? page.url,
      url: page.url,
      finalUrl: page.finalUrl,
      text: page.text,
      extractor: page.extractor,
      fetchedAt: readTime,
      publishedAt: page.publishedAt ?? result?.publishedDate ?? null,
    });
    const published = source.publishedAt ? `published ${source.publishedAt}` : "publish date unknown";
    lines.push(`[${source.n}] ${source.title} - ${source.url} (${published})`);
    lines.push(source.text.slice(0, MAX_PAGE_CHARS_FOR_MODEL));
    lines.push("");
  }
  for (const failure of outcome.failures) {
    notes.push(`Could not read ${failure.url} (${failure.reason}: ${failure.error}).`);
  }
  if (lines.length === 0) lines.push("No page could be read.");
  return [...lines, ...notes].join("\n");
}

function parseArguments(raw: string): { queries: string[]; startDate?: string } | { error: string } {
  let args: unknown;
  try {
    args = JSON.parse(raw || "{}");
  } catch {
    return { error: "Invalid arguments: not valid JSON. Call web_search again with a queries array." };
  }
  const { queries, start_date } = (args ?? {}) as { queries?: unknown; start_date?: unknown };
  if (
    !Array.isArray(queries) ||
    queries.length < 1 ||
    queries.length > MAX_QUERIES ||
    !queries.every((query) => typeof query === "string" && query.trim() !== "")
  ) {
    return { error: `Invalid arguments: queries must be 1 to ${MAX_QUERIES} non-empty strings.` };
  }
  const startDate = typeof start_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(start_date) ? start_date : undefined;
  return { queries: queries as string[], startDate };
}

// Round-robin across queries so every query gets its best result considered,
// one page per domain, vendor domains first.
export function choosePages(perQuery: SearchResult[][], queries: string[]): SearchResult[] {
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
    if (!domain || seenDomains.has(domain)) continue;
    seenDomains.add(domain);
    distinct.push(result);
  }

  const wanted = queries.join(" ").toLowerCase();
  const vendors = distinct.filter((result) => isVendorDomain(domainOf(result.url), wanted));
  const others = distinct.filter((result) => !vendors.includes(result));
  return [...vendors, ...others].slice(0, MAX_PAGES_READ);
}

// A vendor site is one whose name appears in the queries: "neon.com" for "neon pricing".
export function isVendorDomain(domain: string, queryText: string): boolean {
  const parts = domain.split(".");
  parts.pop(); // top-level domain
  if (parts.length > 1 && ["co", "com", "org", "net", "gov", "ac"].includes(parts[parts.length - 1] ?? "")) parts.pop();
  const name = parts[parts.length - 1] ?? "";
  return name.length >= 3 && queryText.includes(name);
}

function domainOf(url: string): string {
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
