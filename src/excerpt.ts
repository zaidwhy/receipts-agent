// The model gets a short excerpt of each page, not the whole page: fewer tokens
// means a faster first word. The snapshot keeps the full text, and every piece
// of an excerpt is a verbatim slice of that text, so a quote copied from an
// excerpt still anchors in the snapshot.
export const EXCERPT_CAP_CHARS = 2500;
const MAX_LINE_CHARS = 300;
const NEIGHBOUR_REACH = 2; // lines on each side of a price that may be its label ("### Pro", "/ month")
const LABEL_MAX_CHARS = 80;
export const GAP = "[...]"; // stands in for page text that was left out of an excerpt

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "what", "how", "does", "much", "that", "this", "from", "are", "vs", "per", "was", "has", "have", "its", "can", "you", "your", "about",
]);

// Words that mean the question is about money, so lines holding an amount matter.
const PRICE_WORDS = new Set(["price", "prices", "pricing", "cost", "costs", "plan", "plans", "paid", "pay", "fee", "fees", "cheapest", "subscription", "monthly", "month"]);
const AMOUNT = /[$€£₹]\s?\d|\d\s?(?:usd|eur|gbp|inr)\b/i;

export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((word) => word.length >= 3 && !STOP_WORDS.has(word)))];
}

// Scores each line by the distinct query words it contains. For a question about money a line with an
// amount counts extra, and so do the short lines next to it, because a pricing page puts "$25" on a
// line of its own under a plan name. Short, dense lines win over long prose. Lines are then taken best
// first until the cap is full and put back in page order. Same input, same output.
export function excerptFor(pageText: string, query: string, cap: number = EXCERPT_CAP_CHARS): string {
  if (pageText.length <= cap) return pageText;

  const terms = queryTerms(query);
  const aboutMoney = terms.some((term) => PRICE_WORDS.has(term));
  const lines = usableLines(pageText);

  const hasAmount = lines.map((line) => aboutMoney && AMOUNT.test(line.text));
  const scored = lines.map((line, index) => {
    const lower = line.text.toLowerCase();
    let score = terms.filter((term) => lower.includes(term)).length;
    if (hasAmount[index]) score += 1;
    const nearAmount = hasAmount.slice(Math.max(0, index - NEIGHBOUR_REACH), index + NEIGHBOUR_REACH + 1).some(Boolean);
    if (!hasAmount[index] && nearAmount && line.text.length <= LABEL_MAX_CHARS) score += 1;
    return { ...line, index, score, priority: score / (1 + line.text.length / 100) };
  });
  const ranked = scored.filter((item) => item.score > 0).sort((a, b) => b.priority - a.priority || a.index - b.index);

  // Each line is costed with room for a gap marker in front of it.
  const costOf = (item: { text: string }) => item.text.length + 1 + GAP.length + 1;
  const chosen: typeof scored = [];
  let used = 0;
  for (const item of ranked) {
    if (used + costOf(item) > cap) continue;
    chosen.push(item);
    used += costOf(item);
  }
  // Nothing matched any term: the top of the page is the best guess.
  if (chosen.length === 0) {
    for (const item of scored) {
      if (used + costOf(item) > cap) break;
      chosen.push(item);
      used += costOf(item);
    }
  }

  chosen.sort((a, b) => a.index - b.index);
  const out: string[] = [];
  chosen.forEach((item, position) => {
    const before = chosen[position - 1];
    // Lines that were next to each other on the page stay next to each other. Anything else gets a
    // marker, so the model cannot copy a quote across text that was left out.
    if (before && !(item.seq === before.seq + 1 && !before.cut)) out.push(GAP);
    out.push(item.text);
  });
  return out.join("\n");
}

interface PageLine {
  text: string;
  seq: number; // position among the page's non-blank lines, so neighbours can be told from gaps
  cut: boolean; // the line was shortened, so what follows it is not its continuation
}

function usableLines(pageText: string): PageLine[] {
  const seen = new Set<string>();
  const lines: PageLine[] = [];
  pageText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .forEach((full, seq) => {
      if (!/[\p{L}\p{N}]/u.test(full)) return; // bare bullets like "*" or "|---|"
      const cut = full.length > MAX_LINE_CHARS; // one huge line must not use up the whole budget
      const text = cut ? full.slice(0, MAX_LINE_CHARS) : full;
      if (seen.has(text)) return; // tables repeat the same cell many times; once is enough
      seen.add(text);
      lines.push({ text, seq, cut });
    });
  return lines;
}
