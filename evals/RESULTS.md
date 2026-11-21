# Eval results

Model `nvidia/nemotron-3.5-super-vl:free`, web `replay`, clock fixed at 2026-11-21T10:00:00Z. 1 run of 12 cases against the real model (its answers differ run to run).
Replay: 5 searches matched a recording exactly, 12 used the nearest recorded search, 21 page reads hit, 7 had no recording and failed like an unreachable page.

## Summary

Run 1:
- pass rate: 11/12 (92%)
- first token ms: median 4381, p90 24226
- total ms: median 4905, p90 25219
- recheck claims settled at tier 1 (no model call): 0 of 6 (0%)

## Run 1

| case | result | reason | first token ms | total ms | model tool calls | web searches / page reads |
|---|---|---|---|---|---|---|
| crm-recheck | pass | ok | 37338 | 40972 | 0 | 4 / 7 |
| postgres-recheck | FAIL | only 0 recheck_row events; 0 coverage events | 12391 | 23430 | 3 | 8 / 6 |
| nov3-recall | pass | ok | 1048 | 3515 | 0 | 0 / 0 |
| empty-crm-trap | pass | ok | 4381 | 4905 | 0 | 0 / 0 |
| empty-nov3-trap | pass | ok | 1025 | 1287 | 0 | 0 / 0 |
| hi | pass | ok | 888 | 959 | 0 | 0 / 0 |
| postgres-topic | pass | ok | 2428 | 3190 | 1 | 0 / 0 |
| ambiguous-3-11 | pass | ok | 22284 | 23673 | 2 | 0 / 0 |
| monday-on-monday | pass | ok | 24226 | 25219 | 0 | 0 / 0 |
| fresh-pricing | pass | ok | 3317 | 3997 | 1 | 2 / 3 |
| hindi-price | pass | ok | 5636 | 6435 | 1 | 3 / 3 |
| pronoun-follow-up | pass | ok | 9787 | 12630 | 1 | 2 / 3 |

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
