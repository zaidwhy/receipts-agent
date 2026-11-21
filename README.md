# minimi agent

Every answer is a receipt, so "is it still true?" is a diff of what the source said then against what it says now, plus a dated search for what is new, and the agent tells you exactly what it could not check.

Status: the chat loop with web search, page reading, streaming, and receipt storage (claims anchored in page snapshots) is built. Recheck, discovery and memory are not yet.

## Run it

Needs Node 22.13 or newer (it uses the built-in `node:sqlite`).

```
npm install
npm run dev
```

Open http://localhost:3000. Without keys the server still starts and the page tells you which variable is missing.

## Keys

Copy `.env.example` to `.env` and fill in:

- `TAVILY_API_KEY` for web search and page extraction.
- `LLM_API_KEY` for the model. By default it talks to OpenRouter with `anthropic/claude-haiku-5.5`; set `LLM_BASE_URL` and `LLM_MODEL` to use any other OpenAI-compatible endpoint.

`WEB_MODE=replay` answers from the saved pages in `fixtures/web/` and needs no Tavily key.

## Checks

```
npm test
npm run typecheck
```
