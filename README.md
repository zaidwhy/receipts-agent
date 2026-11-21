# minimi agent

Every answer is a receipt, so "is it still true?" is a diff of what the source said then against what it says now, plus a dated search for what is new, and the agent tells you exactly what it could not check.

## Quickstart

Needs Node 22.13 or newer (it uses the built-in `node:sqlite`).

```
npm install
cp .env.example .env     # then fill in TAVILY_API_KEY and LLM_API_KEY
npm run dev              # http://localhost:3000
```

- `TAVILY_API_KEY`: web search and page reading (https://tavily.com, the free tier is enough).
- `LLM_API_KEY`: the model. It talks to OpenRouter with `anthropic/claude-haiku-5.5` by default; set `LLM_BASE_URL` and `LLM_MODEL` for any other OpenAI-compatible endpoint.

Without keys the server still starts, `/health` lists the missing ones and the page shows a setup card.

## Try it

Click **Load demo history** (or run `npm run seed`). It adds three past conversations tagged `demo`, dated from today's clock: a CRM shortlist "last Monday", Postgres hosting "last Tuesday" and a question on the most recent past 3 November. The prices in them come from real Internet Archive copies of the vendors' pricing pages (dates in `fixtures/seed/captures.json`), so a recheck compares an old page with today's.

Then ask:

1. `On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?` A table of each earlier claim against the page now, new events, and a coverage line saying what could not be checked.
2. `What did I ask you on 3 November?` Answered from memory, no web.
3. `How much does the Supabase Pro plan cost per month?` A fresh answer with `[n]` citations; the facts are stored with a quote anchored in the page.

Ask question 1 on a fresh database without loading the demo history and the answer is "I have no record of that", not an invention.

## Checks

```
npm test            # unit and conversation tests, no keys needed
npm run typecheck
npm run eval        # 12 cases against the real model, web replayed from fixtures/web; writes evals/RESULTS.md
```

`WEB_MODE=record npm run eval` refreshes the web fixtures (spends Tavily credits). Results and the latency experiment are in `evals/RESULTS.md` and `evals/LATENCY.md`.
