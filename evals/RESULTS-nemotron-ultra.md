# Eval results

Model `nvidia/nemotron-3-ultra-550b-a55b:free`, web `replay`, clock fixed at 2026-11-21T10:00:00Z. 1 run of 12 cases against the real model (its answers differ run to run).
Replay: 4 searches matched a recording exactly, 10 used the nearest recorded search, 20 page reads hit, 5 had no recording and failed like an unreachable page.

## Summary

Run 1:
- pass rate: 9/12 (75%)
- first token ms: median 4653, p90 16393
- total ms: median 6606, p90 19267
- recheck claims settled at tier 1 (no model call): 0 of 6 (0%)

## Run 1

| case | result | reason | first token ms | total ms | model tool calls | web searches / page reads |
|---|---|---|---|---|---|---|
| crm-recheck | pass | ok | 38227 | 53590 | 0 | 4 / 7 |
| postgres-recheck | FAIL | only 0 recheck_row events; 0 coverage events | 7119 | 8400 | 1 | 0 / 0 |
| nov3-recall | pass | ok | 1270 | 2146 | 0 | 0 / 0 |
| empty-crm-trap | pass | ok | 5423 | 6965 | 0 | 0 / 0 |
| empty-nov3-trap | pass | ok | 974 | 1891 | 0 | 0 / 0 |
| hi | pass | ok | 1865 | 1874 | 0 | 0 / 0 |
| postgres-topic | pass | ok | 16393 | 19267 | 1 | 0 / 0 |
| ambiguous-3-11 | pass | ok | 2666 | 2867 | 0 | 0 / 0 |
| monday-on-monday | FAIL | answer does not say which Monday it means | 3424 | 6606 | 0 | 0 / 0 |
| fresh-pricing | pass | ok | 4653 | 6555 | 1 | 2 / 3 |
| hindi-price | FAIL | no anchored claim was stored | 5908 | 7601 | 1 | 2 / 3 |
| pronoun-follow-up | pass | ok | 8413 | 18688 | 1 | 2 / 3 |

## What each case checks

- crm-recheck: challenge 1: recheck the Monday CRM shortlist
- postgres-recheck: challenge 2: recheck last Tuesday's Postgres hosting comparison
- nov3-recall: challenge 3: what did I ask on 3 November (seeded)
- empty-crm-trap: empty memory: Monday's CRM shortlist never happened
- empty-nov3-trap: empty memory: 3 November never happened
- hi: greeting: no tools, fast
- postgres-topic: topic recall with no date
- ambiguous-3-11: 3/11 is 3 November or 11 March: ask, do not guess
- monday-on-monday: Monday asked on a Monday means last Monday, and says so
- fresh-pricing: fresh pricing question: cited and anchored
- hindi-price: Hindi question about a price: Hindi answer, cited and anchored
- pronoun-follow-up: 'and what about the second one?' after a two-product answer
