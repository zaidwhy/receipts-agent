// Page reader behind a port. live tries Tavily extract first and falls back to a
// plain fetch for any URL Tavily could not return. Each page records which
// extractor produced its text, because a later recheck must use the same one.
import type { WebMode } from "./config.ts";
import { readFixture, writeFixture } from "./fixtures.ts";
import { createLogger } from "./log.ts";
import { toIsoDate } from "./search.ts";

const log = createLogger("reader");

export const PAGE_TIMEOUT_MS = 5000;
// Even when Tavily used up the whole budget, the fetch fallback gets this long.
const FALLBACK_MIN_MS = 2000;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export type Extractor = "tavily-basic" | "fetch";

export interface Page {
  url: string;
  finalUrl: string;
  text: string;
  extractor: Extractor;
  publishedAt: string | null;
}

export interface ReadFailure {
  url: string;
  reason: "failed" | "timeout";
  error: string;
}

export interface ReadOutcome {
  pages: Page[];
  failures: ReadFailure[];
}

export interface ReaderPort {
  read(urls: string[]): Promise<ReadOutcome>;
}

export interface ReaderOptions {
  mode: WebMode;
  tavilyApiKey: string | undefined;
  fixturesDir: string;
}

type PageFixture = { ok: true; page: Page } | { ok: false; reason: "failed"; error: string };

export function createReader(options: ReaderOptions): ReaderPort {
  const live = createLiveReader(options.tavilyApiKey);
  if (options.mode === "live") return live;

  if (options.mode === "record") {
    return {
      async read(urls) {
        const outcome = await live.read(urls);
        // One fixture per URL so a replayed question can read any subset of them.
        for (const page of outcome.pages) {
          writeFixture(options.fixturesDir, "page", { url: page.url }, { ok: true, page } satisfies PageFixture);
        }
        for (const failure of outcome.failures) {
          if (failure.reason === "timeout") continue; // timeouts are not repeatable, so not recorded
          const fixture: PageFixture = { ok: false, reason: "failed", error: failure.error };
          writeFixture(options.fixturesDir, "page", { url: failure.url }, fixture);
        }
        return outcome;
      },
    };
  }

  return {
    async read(urls) {
      const outcome: ReadOutcome = { pages: [], failures: [] };
      for (const url of urls) {
        const fixture = readFixture<PageFixture>(options.fixturesDir, "page", { url });
        if (fixture.ok) outcome.pages.push(fixture.page);
        else outcome.failures.push({ url, reason: "failed", error: fixture.error });
      }
      return outcome;
    },
  };
}

interface TavilyExtractResponse {
  results?: { url: string; raw_content?: string; published_date?: string }[];
  failed_results?: { url: string; error?: string }[];
}

function createLiveReader(apiKey: string | undefined): ReaderPort {
  return {
    async read(urls) {
      const startedAt = Date.now();
      const pages = new Map<string, Page>();
      const failures = new Map<string, ReadFailure>();

      // Step 1: Tavily extract for all URLs in one request.
      try {
        const extracted = await tavilyExtract(urls, apiKey);
        for (const item of extracted.results ?? []) {
          if (!item.raw_content?.trim()) continue; // empty text is retried by plain fetch below
          pages.set(item.url, {
            url: item.url,
            finalUrl: item.url,
            text: item.raw_content,
            extractor: "tavily-basic",
            publishedAt: toIsoDate(item.published_date),
          });
        }
        // Tavily reports failures inside a 200 response, so check this list too.
        for (const item of extracted.failed_results ?? []) {
          failures.set(item.url, { url: item.url, reason: "failed", error: item.error ?? "Tavily could not extract" });
        }
      } catch (error) {
        const timedOut = isTimeout(error);
        const message = timedOut ? "Tavily extract timed out" : errorMessage(error);
        log.warn("tavily extract did not return", { message });
        for (const url of urls) {
          failures.set(url, { url, reason: timedOut ? "timeout" : "failed", error: message });
        }
      }

      // Step 2: plain fetch for every URL Tavily did not return text for.
      const missing = urls.filter((url) => !pages.has(url));
      const budget = Math.max(PAGE_TIMEOUT_MS - (Date.now() - startedAt), FALLBACK_MIN_MS);
      const fetched = await Promise.all(missing.map((url) => fetchPage(url, budget)));
      for (const result of fetched) {
        if ("page" in result) {
          pages.set(result.page.url, result.page);
        } else {
          failures.set(result.failure.url, result.failure);
        }
      }

      return {
        pages: urls.flatMap((url) => pages.get(url) ?? []),
        failures: urls.flatMap((url) => (pages.has(url) ? [] : (failures.get(url) ?? []))),
      };
    },
  };
}

async function tavilyExtract(urls: string[], apiKey: string | undefined): Promise<TavilyExtractResponse> {
  if (!apiKey) throw new Error("TAVILY_API_KEY is not set");
  const response = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ urls: urls.slice(0, 20), extract_depth: "basic", format: "markdown" }),
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Tavily extract failed with HTTP ${response.status}`);
  return (await response.json()) as TavilyExtractResponse;
}

async function fetchPage(url: string, timeoutMs: number): Promise<{ page: Page } | { failure: ReadFailure }> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { failure: { url, reason: "failed", error: `HTTP ${response.status}` } };
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("html") && !type.includes("text")) {
      return { failure: { url, reason: "failed", error: `unsupported content type ${type || "unknown"}` } };
    }
    const text = htmlToText(await response.text());
    if (!text) return { failure: { url, reason: "failed", error: "page had no readable text" } };
    return { page: { url, finalUrl: response.url || url, text, extractor: "fetch", publishedAt: null } };
  } catch (error) {
    if (isTimeout(error)) return { failure: { url, reason: "timeout", error: "page fetch timed out" } };
    return { failure: { url, reason: "failed", error: errorMessage(error) } };
  }
}

// Not a full parser: drop code and style blocks, turn tags into spaces, decode common entities.
export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withBreaks = withoutBlocks.replace(/<\/(p|div|li|tr|h[1-6]|section|article)>|<br\s*\/?>/gi, "\n");
  const withoutTags = withBreaks.replace(/<[^>]+>/g, " ");
  const decoded = withoutTags
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&"); // last, so "&amp;lt;" becomes "&lt;" and not "<"
  return decoded
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
