// Web search behind a port. live talks to Tavily, record does the same and saves
// fixtures, replay answers from saved fixtures only.
import type { WebMode } from "./config.ts";
import { readFixture, writeFixture } from "./fixtures.ts";
import { createLogger } from "./log.ts";

const log = createLogger("search");

export const SEARCH_TIMEOUT_MS = 4000;

export interface SearchRequest {
  query: string;
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  // Ask Tavily to drop results whose publish date it cannot place inside the range. Discovery needs
  // this so an old article cannot pose as news.
  filterByPublishedDate?: boolean;
}

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  publishedDate: string | null;
}

export interface SearchOutcome {
  results: SearchResult[];
  timedOut: boolean;
}

export interface SearchPort {
  search(request: SearchRequest): Promise<SearchOutcome>;
}

export interface SearchOptions {
  mode: WebMode;
  tavilyApiKey: string | undefined;
  fixturesDir: string;
}

export function createSearch(options: SearchOptions): SearchPort {
  const live = createLiveSearch(options.tavilyApiKey);
  if (options.mode === "live") return live;
  if (options.mode === "record") {
    return {
      async search(request) {
        const outcome = await live.search(request);
        // A timeout is not a real answer, so it is never saved as a fixture.
        if (!outcome.timedOut) writeFixture(options.fixturesDir, "search", fixtureRequest(request), outcome);
        return outcome;
      },
    };
  }
  return {
    async search(request) {
      return readFixture<SearchOutcome>(options.fixturesDir, "search", fixtureRequest(request));
    },
  };
}

// Fixed property order so the hash does not depend on how the caller built the object.
export function fixtureRequest(request: SearchRequest) {
  const base = { query: request.query, start_date: request.startDate ?? null, end_date: request.endDate ?? null };
  // Added only when set, so the hash of every request made without it stays what it was.
  return request.filterByPublishedDate ? { ...base, filter_by_published_date: true } : base;
}

interface TavilySearchResponse {
  results?: { url: string; title?: string; content?: string; published_date?: string }[];
}

function createLiveSearch(apiKey: string | undefined): SearchPort {
  async function callTavily(request: SearchRequest): Promise<Response> {
    const body: Record<string, unknown> = {
      query: request.query,
      search_depth: "basic",
      max_results: 5,
      include_published_date: true,
    };
    if (request.startDate) body.start_date = request.startDate;
    if (request.endDate) body.end_date = request.endDate;
    if (request.filterByPublishedDate) body.filter_by_published_date = true;
    return fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  }

  return {
    async search(request) {
      if (!apiKey) throw new Error("TAVILY_API_KEY is not set");
      try {
        let response = await callTavily(request);
        if (response.status === 429) {
          // One backoff, then give up and let the caller say so.
          log.warn("rate limited, retrying once", { query: request.query });
          await new Promise((resolve) => setTimeout(resolve, 1000));
          response = await callTavily(request);
        }
        if (!response.ok) {
          throw new Error(`Tavily search failed with HTTP ${response.status}`);
        }
        const data = (await response.json()) as TavilySearchResponse;
        const results = (data.results ?? []).map((item) => ({
          url: item.url,
          title: item.title ?? item.url,
          snippet: item.content ?? "",
          publishedDate: toIsoDate(item.published_date),
        }));
        return { results, timedOut: false };
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          log.warn("search timed out", { query: request.query });
          return { results: [], timedOut: true };
        }
        throw error;
      }
    },
  };
}

// Tavily sends dates like "Thu, 05 Nov 2026 12:54:51 GMT"; the database stores ISO.
// Anything that does not parse is dropped rather than guessed.
export function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
