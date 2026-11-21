# Latency experiment

The same 5 fresh pricing questions (no date, no pronoun), each on an empty database. Medians over the samples listed. "live" and "record" go to the real web; "replay" reads the recording made by the live baseline, so web time is about zero and only the model's own times mean anything.

| setting | web | model | samples | first token ms (median) | total ms (median) | round 1 ms | round 2 first token ms | search ms | read ms | sources | anchored claims | speculation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline-live | record | anthropic/claude-haiku-5.5 | 5 | 6233 | 7847 | 1944 | 2976 | 1184 | 667 | 3 | 2 | off |
| speculative-live | record | anthropic/claude-haiku-5.5 | 5 | 5655 | 7240 | 1919 | 3134 | 0 | 0 | 2 | 2 | 5 hit / 0 miss / 0 skipped |
| speculative-live-2 | record | anthropic/claude-haiku-5.5 | 5 | 4470 | 5794 | 1796 | 2302 | 0 | 0 | 2 | 1 | 5 hit / 0 miss / 0 skipped |
| baseline-live-2 | record | anthropic/claude-haiku-5.5 | 5 | 6964 | 8715 | 1721 | 2999 | 1564 | 1832 | 3 | 2 | off |

## Per question, live runs (total ms)

| question | baseline-live | speculative-live | speculative-live-2 | baseline-live-2 |
|---|---|---|---|---|
| How much does the Supabase Pro plan cost per month? | 6793 | 5467 (hit) | 5345 (hit) | 6609 |
| What does the Neon Launch plan cost? | 9354 | 7398 (hit) | 6210 (hit) | 9261 |
| How much is Vercel Pro per user per month? | 7050 | 7240 (hit) | 5106 (hit) | 6861 |
| What is the price of the Render Professional workspace plan? | 9674 | 6843 (hit) | 5794 (hit) | 8715 |
| How much does Cloudflare Workers Paid cost per month? | 7847 | 7376 (hit) | 6838 (hit) | 10486 |

## Speculative search (SPECULATIVE_SEARCH=1)

- hit rate: 10 of 10 (100%); the bar was 30%
- paired saving in total time, baseline minus speculative, median over 10 pairs: 1755 ms; the bar was 800 ms
- every paired saving, sorted: -190, 471, 1264, 1326, 1755, 1956, 2831, 2921, 3051, 3648 ms
- verdict by the stated bars: keep

## Not measured

- The compact first prompt (COMPACT_PROMPT=1) and a second model (google/gemini-3.8-flash on OpenRouter) were meant to be compared in replay, where only the model's own time counts. Those runs could not finish: the OpenRouter key reached its total limit of $0.10 (HTTP 403) partway through. The failed samples were discarded, so there are no numbers for either, and both stay off. The default model is unchanged.
- Round 1 (the model planning its search) is 1.7 to 2.3 s in every live run above, so the baseline spends about 2 s of each turn before any web work starts; that is the time speculative search overlaps.

## Tavily calls per run

- baseline-live: 10 searches, 10 extract calls (15 URLs)
- speculative-live: 5 searches, 6 extract calls (11 URLs)
- speculative-live-2: 5 searches, 6 extract calls (11 URLs)
- baseline-live-2: 10 searches, 10 extract calls (15 URLs)
