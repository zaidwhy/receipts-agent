# Eval results

Model `nvidia/nemotron-3.5-super-vl:free`, web `replay`, clock fixed at 2026-11-21T10:00:00Z. 1 run of 12 cases against the real model (its answers differ run to run).
Replay: 6 searches matched a recording exactly, 8 used the nearest recorded search, 25 page reads hit, 6 had no recording and failed like an unreachable page.

## Summary

Run 1:
- pass rate: 9/12 (75%)
- first token ms: median 6048, p90 22477
- total ms: median 7967, p90 28743
- recheck claims settled at tier 1 (no model call): 0 of 12 (0%)

## Run 1

| case | result | reason | first token ms | total ms | model tool calls | web searches / page reads |
|---|---|---|---|---|---|---|
| crm-recheck | pass | ok | 88724 | 97235 | 1 | 8 / 10 |
| postgres-recheck | pass | ok | 22477 | 24586 | 0 | 3 / 6 |
| nov3-recall | pass | ok | 2884 | 3842 | 0 | 0 / 0 |
| empty-crm-trap | pass | ok | 6048 | 6644 | 0 | 0 / 0 |
| empty-nov3-trap | pass | ok | 2602 | 3200 | 0 | 0 / 0 |
| hi | FAIL | total 2834 ms is not under 2500 | 2797 | 2834 | 0 | 0 / 0 |
| postgres-topic | pass | ok | 17143 | 23644 | 1 | 0 / 0 |
| ambiguous-3-11 | pass | ok | 14340 | 27872 | 2 | 0 / 0 |
| monday-on-monday | pass | ok | 9735 | 10837 | 0 | 0 / 0 |
| fresh-pricing | FAIL | no anchored claim was stored | 3687 | 5175 | 1 | 2 / 3 |
| hindi-price | pass | ok | 6811 | 7967 | 1 | 2 / 3 |
| pronoun-follow-up | FAIL | searched, but not for supabase | 2607 | 28743 | 1 | 2 / 3 |

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
