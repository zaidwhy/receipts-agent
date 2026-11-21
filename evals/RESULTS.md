# Eval results

Model `anthropic/claude-haiku-5.5`, web `replay`, clock fixed at 2026-11-21T10:00:00Z. 2 runs of 12 cases against the real model (its answers differ run to run).
Replay: 23 searches matched a recording exactly, 8 used the nearest recorded search, 50 page reads hit, 0 had no recording and failed like an unreachable page.

## Summary

Run 1:
- pass rate: 12/12 (100%)
- first token ms: median 3617, p90 9582
- total ms: median 4272, p90 11117
- recheck claims settled at tier 1 (no model call): 0 of 12 (0%)

Run 2:
- pass rate: 12/12 (100%)
- first token ms: median 3474, p90 8777
- total ms: median 4395, p90 11817
- recheck claims settled at tier 1 (no model call): 0 of 12 (0%)

Both runs together:
- pass rate: 24/24 (100%)
- first token ms: median 3617, p90 9582
- total ms: median 4395, p90 11817
- recheck claims settled at tier 1 (no model call): 0 of 24 (0%)

## Run 1

| case | result | reason | first token ms | total ms | model tool calls | web searches / page reads |
|---|---|---|---|---|---|---|
| crm-recheck | pass | ok | 9621 | 13140 | 0 | 4 / 7 |
| postgres-recheck | pass | ok | 9582 | 11117 | 2 | 3 / 6 |
| nov3-recall | pass | ok | 1380 | 1909 | 0 | 0 / 0 |
| empty-crm-trap | pass | ok | 3631 | 4272 | 1 | 0 / 0 |
| empty-nov3-trap | pass | ok | 1475 | 2104 | 0 | 0 / 0 |
| hi | pass | ok | 1525 | 1685 | 0 | 0 / 0 |
| postgres-topic | pass | ok | 3925 | 5001 | 1 | 0 / 0 |
| ambiguous-3-11 | pass | ok | 2110 | 2378 | 0 | 0 / 0 |
| monday-on-monday | pass | ok | 2982 | 4200 | 0 | 0 / 0 |
| fresh-pricing | pass | ok | 3703 | 4475 | 1 | 2 / 3 |
| hindi-price | pass | ok | 3617 | 4776 | 1 | 2 / 3 |
| pronoun-follow-up | pass | ok | 8493 | 10739 | 1 | 3 / 3 |

## Run 2

| case | result | reason | first token ms | total ms | model tool calls | web searches / page reads |
|---|---|---|---|---|---|---|
| crm-recheck | pass | ok | 8777 | 11885 | 0 | 4 / 7 |
| postgres-recheck | pass | ok | 10132 | 11817 | 2 | 3 / 6 |
| nov3-recall | pass | ok | 1713 | 2280 | 0 | 0 / 0 |
| empty-crm-trap | pass | ok | 3640 | 4189 | 1 | 0 / 0 |
| empty-nov3-trap | pass | ok | 1479 | 1987 | 0 | 0 / 0 |
| hi | pass | ok | 1285 | 1427 | 0 | 0 / 0 |
| postgres-topic | pass | ok | 4128 | 5023 | 1 | 0 / 0 |
| ambiguous-3-11 | pass | ok | 2182 | 2502 | 0 | 0 / 0 |
| monday-on-monday | pass | ok | 3395 | 4395 | 0 | 0 / 0 |
| fresh-pricing | pass | ok | 3474 | 4416 | 1 | 2 / 3 |
| hindi-price | pass | ok | 4133 | 6193 | 1 | 2 / 3 |
| pronoun-follow-up | pass | ok | 8392 | 10453 | 1 | 2 / 3 |

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
