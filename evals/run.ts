// `npm run eval`: runs every case against the real model and writes evals/RESULTS.md.
//   EVAL_RUNS=2 npm run eval          replay the recorded web (default mode)
//   WEB_MODE=record npm run eval      hit the real web once and save fixtures/web/*.json
//   EVAL_ONLY=hi,crm-recheck ...      run only those case ids (RESULTS.md is not rewritten)
//   EVAL_SHOW=1 ...                   also print each answer
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { liveUsage, resetReplayStats, replayStats } from "../src/fixtures.ts";
import { CASES } from "./cases.ts";
import { EVAL_NOW, evalConfig, runConversation } from "./harness.ts";
import { renderReport, resultOf, type CaseResult } from "./report.ts";

const config = evalConfig();
if (!config.llmApiKey) {
  console.error("LLM_API_KEY is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
const runCount = Number(process.env.EVAL_RUNS ?? 1);
const only = process.env.EVAL_ONLY?.split(",").map((id) => id.trim());
const cases = only ? CASES.filter((testCase) => only.includes(testCase.id)) : CASES;

resetReplayStats();
const runs: CaseResult[][] = [];
for (let run = 1; run <= runCount; run += 1) {
  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const conversation = await runConversation(config, testCase);
    if (process.env.EVAL_SHOW) console.log(`--- ${testCase.id}
${conversation.last.answer}
---`);
    const result = resultOf(testCase, conversation);
    results.push(result);
    console.log(`run ${run} ${result.passed ? "pass" : "FAIL"} ${testCase.id} first token ${result.firstTokenMs ?? "-"} ms, total ${result.totalMs} ms${result.passed ? "" : `: ${result.reasons.join("; ")}`}`);
  }
  runs.push(results);
}

const replay =
  config.webMode === "replay"
    ? `Replay: ${replayStats.searchExact} searches matched a recording exactly, ${replayStats.searchNearest} used the nearest recorded search, ${replayStats.pageHit} page reads hit, ${replayStats.pageMiss} had no recording and failed like an unreachable page.`
    : `Web mode ${config.webMode}: nothing was replayed.`;
const out = fileURLToPath(new URL("./RESULTS.md", import.meta.url));
mkdirSync(dirname(out), { recursive: true });
if (!only && config.webMode === "replay") {
  writeFileSync(out, renderReport(runs, { model: config.llmModel, webMode: config.webMode, now: EVAL_NOW, replay }));
  console.log(`wrote ${out}`);
}

if (config.webMode !== "replay") console.log(`Tavily calls: ${liveUsage.searches} searches, ${liveUsage.extractCalls} extract calls for ${liveUsage.extractUrls} URLs`);
