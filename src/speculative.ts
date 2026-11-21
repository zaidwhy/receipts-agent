// Speculative search (flag SPECULATIVE_SEARCH=1): while the model is still deciding which queries to
// run, search the user's own words and read the top two pages. If the model then asks for something
// close to that, the answer is already waiting; if not, the work is thrown away.
import { queryTerms } from "./excerpt.ts";
import { createLogger } from "./log.ts";
import type { Page, ReaderPort } from "./reader.ts";
import type { SearchPort } from "./search.ts";
import { choosePages } from "./tools.ts";
import type { DateReference } from "./temporal.ts";
import { refersToPastConversation } from "./memory.ts";

const log = createLogger("speculative");

export const SPECULATIVE_PAGES = 2;
const MIN_TERMS = 3; // "hi" and "thanks a lot" are not questions worth a search

// Words that point back at something said earlier. A message with one cannot be searched as written.
const POINTS_BACK = /\b(it|its|them|they|their|that|those|this|these|he|she|him|her|the (first|second|third|last|other|former|latter|same) one|the (cheaper|cheapest|other|same|former|latter))\b/i;

export function eligibleForSpeculation(message: string, references: DateReference[]): boolean {
  if (references.length > 0) return false; // a date means the answer lives in memory
  if (POINTS_BACK.test(message) || refersToPastConversation(message)) return false;
  return queryTerms(message).length >= MIN_TERMS;
}

export interface Speculation {
  query: string;
  results: { url: string; title: string; publishedDate: string | null }[];
  pages: Page[];
  searchMs: number;
  readMs: number;
}

// Never throws: a failed guess is just no guess.
export function startSpeculation(deps: { search: SearchPort; reader: ReaderPort }, message: string): Promise<Speculation | null> {
  return (async () => {
    try {
      const searchStarted = performance.now();
      const outcome = await deps.search.search({ query: message });
      const searchMs = Math.round(performance.now() - searchStarted);
      const picked = choosePages([outcome.results], [message], SPECULATIVE_PAGES);
      if (picked.length === 0) return null;
      const readStarted = performance.now();
      const read = await deps.reader.read(picked.map((result) => result.url));
      const readMs = Math.round(performance.now() - readStarted);
      return {
        query: message,
        results: picked.map((result) => ({ url: result.url, title: result.title, publishedDate: result.publishedDate })),
        pages: read.pages,
        searchMs,
        readMs,
      };
    } catch (error) {
      log.warn("speculation failed", { message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  })();
}
