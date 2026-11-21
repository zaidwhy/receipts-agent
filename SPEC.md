# minimi chat agent: design spec (locked 2026-11-21, after two Fable reviews)

The working spec written before the code; DESIGN.md is the one-page summary with measured results.

## Thesis
Every answer is a receipt, so "is it still true?" is a diff of what the source said then against what it says now, plus a dated search for what is new, and the agent tells you exactly what it could not check.

## Pre-build checks (run 2026-11-21)
- Node v24.17.0: `node:sqlite` DatabaseSync create/insert/select works. PASS.
- Tavily docs: search has `start_date`/`end_date`, `time_range`, `include_published_date`, `filter_by_published_date`; extract takes up to 20 URLs, `extract_depth: advanced` ("tables and embedded content"), returns `failed_results` even on HTTP 200, failed URLs not charged. Free tier 1,000 credits/month, 100 RPM. Docs never say extract renders JavaScript. Keyless call returned 401, so a key is required.
- Raw fetch of pricing pages (curl, browser UA): neon.com/pricing and supabase.com/pricing have dollar figures in the HTML; hubspot.com/pricing/sales has none (client-rendered); pipedrive.com/en/pricing returns 403. So "unanchored" and "could not verify" are common real paths, not edge cases.
- OpenRouter tool-calling models live: anthropic/claude-haiku-5.5 ($0.10/$0.50 per M), google/gemini-3.8-flash, anthropic/claude-sonnet-5.5.

- Live probe with keys (2026-11-21): Tavily extract got prices from all 4 pages, including HubSpot (client-rendered) and Pipedrive (403 to plain fetch); basic and advanced returned identical text in ~740 ms each, so use basic (half the credits). Search with start_date returned `published_date` as RFC 1123 strings; top 5 for "Neon Postgres pricing change" were all third-party blogs, none from neon.com. LLM (OpenRouter, claude-haiku-5.5) answered in 2312 ms for a 5-token reply.
- Open risk: identical output for basic vs advanced may mean Tavily served a cached copy. A recheck that reads a cache can report "source unchanged" for a page that changed. Before trusting recheck, measure: edit-detect test against a page we control, or compare Tavily text with plain fetch where plain fetch works; if cached, recheck prefers plain fetch and records the extractor.

## Refinements (2026-11-21, after the checks)
1. Reader: Tavily extract (advanced) first, plain fetch fallback; `extractor` recorded per snapshot; recheck uses the same extractor that made the snapshot.
2. Claims only for checkable facts: price, plan limit, version, date, availability, launch. Prose is not a claim. Fewer, sharper receipts.
3. Each turn stores its entity set ("the shortlist"), so "any of them" resolves to five named entities without the model guessing.
4. Recheck streams one row per entity as each finishes; the coverage line closes the table.
5. No web framework: node:http + Server-Sent Events + one static HTML page with vanilla TS. Fewer moving parts, every line explainable. `npm run dev` = tsx watch.
6. LLM through one OpenAI-compatible client (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`); default OpenRouter + anthropic/claude-haiku-5.5. A reviewer with only an OpenAI key changes two lines of .env.
7. Search and reader sit behind a port with `live | record | replay` modes from the first commit, so tests and evals run with no keys.

## Verify before building
1. `node:sqlite` stable on the pinned Node version.
2. Search provider returns published dates and supports date filters.
3. Its extract endpoint returns prices from JS-rendered pricing pages.

## Search quality (judged first)
Query rewriting from conversation; 2-4 parallel queries; real page content not snippets; vendor sources preferred, domains deduped; conflicts reported; status line within ~300 ms; short answers first.

## Receipts
- Snapshots: cleaned text of cited pages only, content-hashed, gzipped, capped 200 KB. Same extractor for first read and recheck.
- Claims: emitted structurally in the same generation as the answer; anchored by quote + prefix + suffix (W3C TextQuoteSelector style). Thin text or a price claim with no digits = unanchored, recheck falls back to re-search.
- Recheck tiers (lane A): page hash equal -> "source unchanged", zero LLM; quote matches but page differs -> LLM reads diff hunks only; quote lost -> LLM compares old vs new sections; fetch fail/404 -> "could not verify" then re-search. Anchor miss never means "changed". Say "source unchanged", never "still true".
- Discovery (lane B, "shipped something big"): per entity find changelog/blog/RSS once; feed items after T are events with no LLM call; plus one date-filtered search from T. Event counts only with a dated source after T; undated listed as "undated, may predate". "Big" = pricing, plan structure, major release, acquisition, shutdown; confirmed only from the vendor's own domain with a kind matched in the title; anything else is "unconfirmed".
- Coverage line on every recheck: "checked N pricing pages, M changelogs; K unreachable".
- Shelf life: claim volatility class (price: days, feature: weeks, static: never); recall returns age; expired claims rechecked before restating.
- Time: asked_at, fetched_at, nullable published_at. Never invent a date.

## Memory and time
Single tool loop: `web_search`, `recall(date_range, topic)`. Temporal resolver in code with injectable clock; browser sends IANA zone; store UTC; echo resolved date ("Tuesday 17 Nov"). If the resolver finds a memory reference, code runs recall before the model. No date -> recall by topic newest first, list matches with dates. Date with no record -> say so, offer nearest dates. Empty memory -> "I have no record of that", never invent.

## Speculative search
Behind a flag, gated in code (no temporal reference, no pronouns). Cut if measured hit rate < 30%; report the number either way.

## First five minutes
No keys: boots, UI names the missing variable. Timeouts: search 4 s, page 5 s, answer with what arrived and say what timed out. Rate limit: one backoff, then fewer queries, say so. Non-English: reply in user's language, English topic tags stored for recall. "hi": no tools, under 1 s.

## Modules
conversation, temporal, clock, memory, search, reader, receipts, recheck, discovery, claims, replay (record/replay fixtures for evals, demo and video), evals.

## Tables
- turns: id, role, text, asked_at, tz, topic_tags
- entities: id, name, domain, feed_url
- snapshots: hash, url, final_url, text_gz, fetched_at, published_at, extractor, status
- claims: id, turn_id, entity_id, text, volatility, snapshot_hash, quote, prefix, suffix
- rechecks: claim_id, checked_at, tier, status, new_snapshot_hash
- events: entity_id, title, url, published_at, kind
- schema_version

## Seed
`npm run seed` + "load demo history" button, labelled demo data, backdated relative to the clock (CRM shortlist on Monday, Postgres hosting on Tuesday, a 3 Nov question).

## Considered and rejected (DESIGN.md)
Embeddings for recall (dates + FTS suffice); separate router; re-search as recheck (cannot prove unchanged); own headless browser; trusting snippets; speculative search (with measured number); knowledge graph, vector DB, multi-agent, background scheduler. Another week: proactive watch items (minimi's own product shape).

## Build order -> verify
Day 1
1. Loop, search, reader, streaming -> a fresh question is cited in under 8 s.
2. Claims and snapshots -> every claim's quote anchors in its snapshot.
3. Temporal and memory -> clock-injected tests for "Monday", "last Tuesday", "3 November".
Day 2
4. Recheck tiers -> edited fixture flips unchanged to changed; 404 gives could-not-verify.
5. Discovery -> fixture feed yields only items after T.
6. Seed, replay, guards -> clean clone boots with no keys.
7. Evals -> 12 cases, latency and cheap-path share printed.
