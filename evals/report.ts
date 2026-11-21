// Turns results into evals/RESULTS.md: a table per run, then the summary over all runs.
import type { EvalCase } from "./cases.ts";
import type { CaseRun } from "./harness.ts";

export interface CaseResult {
  id: string;
  what: string;
  passed: boolean;
  reasons: string[];
  firstTokenMs: number | null;
  totalMs: number;
  toolCalls: number; // the model's own tool calls in the measured turn
  searches: number;
  reads: number;
  recheckTiers: number[]; // the tier of every recheck row streamed in the measured turn
}

export function resultOf(testCase: EvalCase, run: CaseRun): CaseResult {
  const reasons = testCase.check(run);
  const rows = run.last.events.flatMap((event) => (event.type === "recheck_row" ? [event.data.tier] : []));
  return {
    id: testCase.id,
    what: testCase.what,
    passed: reasons.length === 0,
    reasons,
    firstTokenMs: run.last.firstTokenMs,
    totalMs: run.last.totalMs,
    toolCalls: run.last.modelToolCalls.length,
    searches: run.last.searchCalls,
    reads: run.last.readCalls,
    recheckTiers: rows,
  };
}

// Nearest-rank percentile: the smallest value with at least p percent of the values at or below it.
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

export interface Summary {
  cases: number;
  passed: number;
  firstTokenMedian: number | null;
  firstTokenP90: number | null;
  totalMedian: number | null;
  totalP90: number | null;
  recheckClaims: number;
  tierOneClaims: number;
}

export function summarize(results: CaseResult[]): Summary {
  const firstTokens = results.flatMap((result) => (result.firstTokenMs === null ? [] : [result.firstTokenMs]));
  const tiers = results.flatMap((result) => result.recheckTiers);
  return {
    cases: results.length,
    passed: results.filter((result) => result.passed).length,
    firstTokenMedian: percentile(firstTokens, 50),
    firstTokenP90: percentile(firstTokens, 90),
    totalMedian: percentile(results.map((result) => result.totalMs), 50),
    totalP90: percentile(results.map((result) => result.totalMs), 90),
    recheckClaims: tiers.length,
    tierOneClaims: tiers.filter((tier) => tier === 1).length,
  };
}

const ms = (value: number | null) => (value === null ? "-" : `${value}`);

function summaryLines(summary: Summary): string[] {
  const share = summary.recheckClaims === 0 ? "n/a (no recheck rows)" : `${summary.tierOneClaims} of ${summary.recheckClaims} (${Math.round((100 * summary.tierOneClaims) / summary.recheckClaims)}%)`;
  return [
    `- pass rate: ${summary.passed}/${summary.cases} (${Math.round((100 * summary.passed) / summary.cases)}%)`,
    `- first token ms: median ${ms(summary.firstTokenMedian)}, p90 ${ms(summary.firstTokenP90)}`,
    `- total ms: median ${ms(summary.totalMedian)}, p90 ${ms(summary.totalP90)}`,
    `- recheck claims settled at tier 1 (no model call): ${share}`,
  ];
}

export function renderReport(runs: CaseResult[][], meta: { model: string; webMode: string; now: string; replay: string }): string {
  const lines = [
    "# Eval results",
    "",
    `Model \`${meta.model}\`, web \`${meta.webMode}\`, clock fixed at ${meta.now}. ${runs.length} run${runs.length === 1 ? "" : "s"} of ${runs[0]?.length ?? 0} cases against the real model (its answers differ run to run).`,
    meta.replay,
    "",
    "## Summary",
    "",
  ];
  runs.forEach((results, index) => {
    lines.push(`Run ${index + 1}:`, ...summaryLines(summarize(results)), "");
  });
  if (runs.length > 1) lines.push("Both runs together:", ...summaryLines(summarize(runs.flat())), "");

  runs.forEach((results, index) => {
    lines.push(`## Run ${index + 1}`, "", "| case | result | reason | first token ms | total ms | model tool calls | web searches / page reads |", "|---|---|---|---|---|---|---|");
    for (const result of results) {
      const reason = result.passed ? "ok" : result.reasons.join("; ").replace(/\|/g, "/");
      lines.push(`| ${result.id} | ${result.passed ? "pass" : "FAIL"} | ${reason} | ${ms(result.firstTokenMs)} | ${result.totalMs} | ${result.toolCalls} | ${result.searches} / ${result.reads} |`);
    }
    lines.push("");
  });
  lines.push("## What each case checks", "");
  for (const result of runs[0] ?? []) lines.push(`- ${result.id}: ${result.what}`);
  lines.push("");
  return lines.join("\n");
}
