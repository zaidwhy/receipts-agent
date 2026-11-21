// Latency experiment: the same 5 fresh pricing questions under different settings.
//   tsx evals/latency.ts <label>            run the 5 questions with the current environment and append to evals/latency-runs.json
//   tsx evals/latency.ts --report           write evals/LATENCY.md from everything in that file
// Settings come from the environment: SPECULATIVE_SEARCH=1, COMPACT_PROMPT=1, LLM_MODEL=..., WEB_MODE=live|record|replay,
// FIXTURES_DIR=fixtures/latency, LAT_REPEATS=3 (each question that many times; use it in replay, where it costs nothing).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { liveUsage } from "../src/fixtures.ts";
import { evalConfig, runConversation } from "./harness.ts";
import { percentile } from "./report.ts";

export const QUESTIONS = [
  "How much does the Supabase Pro plan cost per month?",
  "What does the Neon Launch plan cost?",
  "How much is Vercel Pro per user per month?",
  "What is the price of the Render Professional workspace plan?",
  "How much does Cloudflare Workers Paid cost per month?",
];

export interface Sample {
  question: string;
  firstTokenMs: number | null;
  totalMs: number;
  round1Ms: number | null; // the model's first call: planning the search
  round2FirstTokenMs: number | null; // the model's second call: time to the first word of the answer
  searchMs: number;
  readMs: number;
  speculative: string;
  sources: number;
  anchoredClaims: number;
  answerChars: number;
  error: string | null;
}

export interface LatencyRun {
  label: string;
  model: string;
  webMode: string;
  speculative: boolean;
  compact: boolean;
  at: string;
  samples: Sample[];
  tavily: { searches: number; extractCalls: number; extractUrls: number };
}

const file = fileURLToPath(new URL("./latency-runs.json", import.meta.url));
const load = (): LatencyRun[] => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as LatencyRun[]) : []);

async function measure(label: string): Promise<void> {
  const config = evalConfig();
  const repeats = Number(process.env.LAT_REPEATS ?? 1);
  const before = { ...liveUsage };
  const samples: Sample[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const question of QUESTIONS) {
      const run = await runConversation(config, { turns: [question], seeded: false });
      const last = run.last;
      const rounds = last.timings?.llm_rounds ?? [];
      const sources = last.events.find((event) => event.type === "sources");
      samples.push({
        question,
        firstTokenMs: last.firstTokenMs,
        totalMs: last.totalMs,
        round1Ms: rounds[0]?.duration_ms ?? null,
        round2FirstTokenMs: rounds[1]?.ttft_ms ?? null,
        searchMs: last.timings?.search_ms ?? 0,
        readMs: last.timings?.read_ms ?? 0,
        speculative: last.timings?.speculative ?? "off",
        sources: sources && sources.type === "sources" ? sources.sources.length : 0,
        anchoredClaims: (run.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE anchored = 1").get() as { n: number }).n,
        answerChars: last.answer.length,
        error: last.error,
      });
      const sample = samples[samples.length - 1] as Sample;
      console.log(`${label} | ${question.slice(0, 40)} | first token ${sample.firstTokenMs} total ${sample.totalMs} round1 ${sample.round1Ms} spec ${sample.speculative}${sample.error ? ` ERROR ${sample.error}` : ""}`);
    }
  }
  const run: LatencyRun = {
    label,
    model: config.llmModel,
    webMode: config.webMode,
    speculative: config.speculativeSearch,
    compact: config.compactPrompt,
    at: new Date().toISOString(),
    samples,
    tavily: { searches: liveUsage.searches - before.searches, extractCalls: liveUsage.extractCalls - before.extractCalls, extractUrls: liveUsage.extractUrls - before.extractUrls },
  };
  writeFileSync(file, JSON.stringify([...load(), run], null, 2) + "\n");
}

const median = (values: (number | null)[]) => percentile(values.flatMap((value) => (value === null ? [] : [value])), 50);
const fmt = (value: number | null) => (value === null ? "-" : String(value));

export function renderLatency(runs: LatencyRun[]): string {
  const lines = [
    "# Latency experiment",
    "",
    "The same 5 fresh pricing questions (no date, no pronoun), each on an empty database. Medians over the samples listed. \"live\" and \"record\" go to the real web; \"replay\" reads the recording made by the live baseline, so web time is about zero and only the model's own times mean anything.",
    "",
    "| setting | web | model | samples | first token ms (median) | total ms (median) | round 1 ms | round 2 first token ms | search ms | read ms | sources | anchored claims | speculation |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const run of runs) {
    const s = run.samples;
    const spec = run.speculative ? `${s.filter((x) => x.speculative === "hit").length} hit / ${s.filter((x) => x.speculative === "miss").length} miss / ${s.filter((x) => x.speculative === "skipped").length} skipped` : "off";
    const sources = median(s.map((x) => x.sources));
    const anchored = median(s.map((x) => x.anchoredClaims));
    lines.push(
      `| ${run.label} | ${run.webMode} | ${run.model} | ${s.length} | ${fmt(median(s.map((x) => x.firstTokenMs)))} | ${fmt(median(s.map((x) => x.totalMs)))} | ${fmt(median(s.map((x) => x.round1Ms)))} | ${fmt(median(s.map((x) => x.round2FirstTokenMs)))} | ${fmt(median(s.map((x) => x.searchMs)))} | ${fmt(median(s.map((x) => x.readMs)))} | ${fmt(sources)} | ${fmt(anchored)} | ${spec} |`,
    );
  }
  lines.push("", "## Per question, live runs (total ms)", "", "| question | " + runs.filter((r) => r.webMode !== "replay").map((r) => r.label).join(" | ") + " |", "|---|" + runs.filter((r) => r.webMode !== "replay").map(() => "---").join("|") + "|");
  for (const question of QUESTIONS) {
    const cells = runs.filter((r) => r.webMode !== "replay").map((run) => {
      const sample = run.samples.find((x) => x.question === question);
      return sample ? `${sample.totalMs}${sample.speculative === "hit" ? " (hit)" : sample.speculative === "miss" ? " (miss)" : ""}` : "-";
    });
    lines.push(`| ${question} | ${cells.join(" | ")} |`);
  }
  lines.push(...speculationSection(runs));
  lines.push(
    "",
    "## Not measured",
    "",
    "- The compact first prompt (COMPACT_PROMPT=1) and a second model (google/gemini-3.8-flash on OpenRouter) were meant to be compared in replay, where only the model's own time counts. Those runs could not finish: the OpenRouter key reached its total limit of $0.10 (HTTP 403) partway through. The failed samples were discarded, so there are no numbers for either, and both stay off. The default model is unchanged.",
    "- Round 1 (the model planning its search) is 1.7 to 2.3 s in every live run above, so the baseline spends about 2 s of each turn before any web work starts; that is the time speculative search overlaps.",
  );
  lines.push("", "## Tavily calls per run", "");
  for (const run of runs) if (run.webMode !== "replay") lines.push(`- ${run.label}: ${run.tavily.searches} searches, ${run.tavily.extractCalls} extract calls (${run.tavily.extractUrls} URLs)`);
  lines.push("");
  return lines.join("\n");
}

// Pairs "baseline-live" with "speculative-live" and "baseline-live-2" with "speculative-live-2": the same question, same session of the day.
function speculationSection(runs: LatencyRun[]): string[] {
  const savings: number[] = [];
  let hits = 0;
  let speculated = 0;
  for (const speculative of runs.filter((run) => run.label.startsWith("speculative-live"))) {
    const baseline = runs.find((run) => run.label === speculative.label.replace("speculative", "baseline"));
    if (!baseline) continue;
    for (const sample of speculative.samples) {
      const before = baseline.samples.find((other) => other.question === sample.question);
      if (!before) continue;
      savings.push(before.totalMs - sample.totalMs);
      speculated += 1;
      if (sample.speculative === "hit") hits += 1;
    }
  }
  if (savings.length === 0) return [];
  const rate = Math.round((100 * hits) / speculated);
  const saved = percentile(savings, 50);
  const keep = rate >= 30 && (saved ?? 0) >= 800;
  return [
    "",
    "## Speculative search (SPECULATIVE_SEARCH=1)",
    "",
    `- hit rate: ${hits} of ${speculated} (${rate}%); the bar was 30%`,
    `- paired saving in total time, baseline minus speculative, median over ${savings.length} pairs: ${saved} ms; the bar was 800 ms`,
    `- every paired saving, sorted: ${[...savings].sort((a, b) => a - b).join(", ")} ms`,
    `- verdict by the stated bars: ${keep ? "keep" : "leave off"}`,
  ];
}

const arg = process.argv[2];
if (arg === "--report") {
  writeFileSync(fileURLToPath(new URL("./LATENCY.md", import.meta.url)), renderLatency(load()));
  console.log("wrote evals/LATENCY.md");
} else if (arg) {
  await measure(arg);
} else {
  console.error("usage: tsx evals/latency.ts <label> | --report");
  process.exit(1);
}
