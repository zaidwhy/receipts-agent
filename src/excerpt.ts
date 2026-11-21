// The model gets a short excerpt of each page, not the whole page: fewer tokens
// means a faster first word. The snapshot keeps the full text, and every piece
// of an excerpt is a verbatim slice of that text, so a quote copied from an
// excerpt still anchors in the snapshot.
export const EXCERPT_CAP_CHARS = 2500;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "what", "how", "does", "much", "that", "this", "from", "are", "vs", "per", "was", "has", "have", "its", "can", "you", "your", "about",
]);

export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((word) => word.length >= 3 && !STOP_WORDS.has(word)))];
}

// Picks the paragraphs (lines) that share the most distinct terms with the query,
// then puts them back in page order. Same input, same output.
export function excerptFor(pageText: string, query: string, cap: number = EXCERPT_CAP_CHARS): string {
  if (pageText.length <= cap) return pageText;

  const terms = queryTerms(query);
  const paragraphs = pageText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    // One huge line must not use up the whole budget.
    .map((line) => (line.length >= cap ? line.slice(0, cap - 1) : line));

  const scored = paragraphs.map((text, index) => {
    const lower = text.toLowerCase();
    return { text, index, score: terms.filter((term) => lower.includes(term)).length };
  });
  // Best score first; on a tie the earlier paragraph wins.
  const ranked = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);

  const chosen: typeof scored = [];
  let used = 0;
  for (const item of ranked) {
    const cost = item.text.length + 1;
    if (used + cost > cap) continue;
    chosen.push(item);
    used += cost;
  }
  // Nothing matched any term: the top of the page is the best guess.
  if (chosen.length === 0) {
    for (const item of scored) {
      const cost = item.text.length + 1;
      if (used + cost > cap) break;
      chosen.push(item);
      used += cost;
    }
  }
  return chosen
    .sort((a, b) => a.index - b.index)
    .map((item) => item.text)
    .join("\n");
}
