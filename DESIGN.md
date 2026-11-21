# Design

**Thesis.** Every answer is a receipt. "Is it still true?" is then a diff of what the source said against what it says now, plus a dated search for what is new, and the agent says exactly what it could not check.

## How it works

One tool loop (`conversation.ts`) on an OpenAI-compatible model, with web search as the only way out to the world. Two internal tools sit beside it: `recall` reads past turns, `recheck` re-reads past sources.

1. **Answer with receipts.** `web_search` runs 2-4 model-written queries in parallel, plus up to 3 vendor URLs the model names (a pricing question reads `supabase.com/pricing`, not a blog). Pages are read through Tavily extract, plain fetch as fallback. The model sees an excerpt of each page; the full text is stored as a content-hashed snapshot. In the same generation as the answer the model emits a hidden `receipts` block: each checkable fact (price, limit, version, date, availability, launch) with a verbatim quote, anchored into the snapshot by exact quote + prefix + suffix (the W3C TextQuoteSelector idea).
2. **Dates in code, not in the model.** `temporal.ts` turns "last Tuesday", "Monday", "3 November" into exact ranges in the user's time zone. "Monday" asked on a Monday and "3/11" are flagged as ambiguous instead of guessed.
3. **Memory by time and topic.** When a message points at a past conversation ("what did I ask you on..."), code runs `recall` before the model speaks. No record means the answer says so and names the nearest dates; it never invents a past conversation.
4. **Recheck in tiers, cheapest first.** Same extractor and identical page hash: "source unchanged", zero model calls. Page changed but the quote still anchors: the model reads only the context around it (catches a price that survived under a "legacy plans" heading). Quote gone: the model compares old and new sections and must quote the new value from the new page, or answer "cannot tell". Unreachable: "could not verify", never "unchanged".
5. **What shipped since T.** Recheck only covers pages the agent read; news lives on pages it never saw. So per vendor it finds a changelog or RSS feed once, keeps dated items after T, and runs one date-filtered search. Only the vendor's own domain counts as confirmed.
6. **Coverage, always.** Every recheck ends with a line like `checked 4 pricing pages, 2 changelogs; no changelog found for 3; 4 model calls`.

Storage is built-in `node:sqlite` (no native build on a reviewer's machine), UI is one HTML page over Server-Sent Events, no framework: the status line ("reading neon.com/pricing") arrives in under 100 ms.

## Why

The three example questions are all "you told me X at time T, is X still true?". A plain search agent can only re-search and compare by feel; it cannot prove that nothing changed, and it cannot know what it told you. Keeping the receipt turns both into lookups and diffs. minimi's product catches promises people forget; this agent treats its own answers as promises it can be held to.

## Measured (evals/RESULTS*.md, evals/LATENCY.md)

12 eval cases (the three examples, two empty-memory traps, "hi", Hindi, ambiguous dates, a pronoun follow-up), real model, recorded web. The model is one env line, so the same suite ran on three:

| Model | Pass | First token median / p90 |
|---|---|---|
| `anthropic/claude-haiku-5.5` (paid) | 24/24 over two runs | 3.6 s / 9.6 s |
| `nvidia/nemotron-3.5-super-vl:free` (default) | 11/12 | 4.4 s / 24.2 s |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 9/12 | 4.7 s / 16.4 s |

- The default is free so anyone can run it with a zero-credit OpenRouter key; Haiku is faster and steadier. Both free models failed the Postgres recheck for the same reason: "Last Tuesday we compared..." did not match the code's list of past-conversation phrases, and unlike Haiku they did not call `recall` on their own. The trigger now matches "I/we/you" plus a talking-or-deciding verb (unit-tested; the free-model re-run hit OpenRouter's 50-requests-a-day free cap, so it is not re-measured).
- The pronoun case is flaky on Haiku in a third partial run ("the second one" read in question order, not answer order).
- Fresh live pricing questions on Haiku: 6.2-7.0 s median to first token.
- Same-day recheck: 3/3 claims settled at tier 1, zero model calls, and Tavily and a direct fetch agreed on 3/3 quotes (the stale-cache risk did not show). Archive-backed demo history: 0% tier 1, because a months-old page never hash-matches today's. The cheap path pays off on repeat checks, not on old ones.
- Live CRM demo on archive history: it caught a real pricing change. Attio's 8 Nov 2026 archive copy says "Pro $ 99 79 per user/month"; the live page on 22 Nov says "Pro $ 125 100 mo/workspace, Includes 1 user. Add users for $99 $79 /mo each" and adds an Ultra plan (checked by hand against both pages). It also produced one false positive: Pipedrive's CA$ prefix vanished between a Canadian capture and today's page and was reported as a change. The verdict check now downgrades "changed" to "reworded" when the old quote and the new value hold the same amounts (tested on fixtures; the live demo has not been re-run since).

## Considered and rejected

- **Embeddings for recall.** The questions are about dates and named products; SQL ranges plus FTS5 answer them exactly.
- **A router before the model.** A misrouted factual question is a wrong answer; one loop with forced recall in code was simpler and safer.
- **Re-search as recheck.** It cannot prove "unchanged", only fail to find a change.
- **Trusting search snippets.** Pricing snippets were stale or third-party; the top 5 results for "Neon pricing change" were all blogs.
- **Speculative search on by default.** Searching the raw question during the model's planning hit 10/10 and saved 1.76 s median, but cut sources from 3 to 2 and anchored claims from 2 to 1.5. Off by default (`SPECULATIVE_SEARCH=1`) until evals pass on that path.
- **Invented demo data.** Seeded history uses real Internet Archive captures with their real dates, tagged `demo`.
- Vector DB, knowledge graph, multi-agent, own headless browser: more parts, no answer they improve.

## With another week

- **Watch items:** when it answers a pricing question, offer to recheck on a date and bring it up unprompted next session. That is minimi's own product shape.
- Region-aware prices: store currency and region per claim, so a regional copy of a page is its own variant instead of an amounts-only heuristic.
- Product scope for multi-product vendors (Zoho CRM vs Zoho Billing) so a vendor-domain event about the wrong product is not "confirmed".
- Turn speculative search on behind an eval gate, and stream the answer while recheck rows are still arriving.
- A live edit-detection test against a page I control, to measure tier 2 and 3 outside fixtures.
