// The 12 eval cases. Each has a setup (what to ask, whether memory is seeded, what day it is) and
// a check on what an observer sees: the streamed events, the answer text, tool calls, stored claims.
// A check returns the list of things that went wrong; an empty list is a pass.
import type { CaseRun, CaseSetup } from "./harness.ts";

export interface EvalCase extends CaseSetup {
  id: string;
  what: string;
  check: (run: CaseRun) => string[];
}

const CRM_TOOLS = /\b(hubspot|pipedrive|salesforce|zoho|attio)\b/i;
const NO_RECORD = /\b(no record|don'?t have (any )?(a )?record|do not have (any )?(a )?record|no earlier|nothing (stored|saved|recorded)|can'?t find|cannot find|no (past|previous) (conversation|question)|not (find|see) (any|a))\b/i;
const CITATION = /\[\d+\]/;

function recheckRows(run: CaseRun) {
  return run.last.events.filter((event) => event.type === "recheck_row");
}

function coverageEvents(run: CaseRun) {
  return run.last.events.filter((event) => event.type === "coverage");
}

function anchoredClaims(run: CaseRun): number {
  return (run.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE anchored = 1").get() as { n: number }).n;
}

function noWeb(run: CaseRun): string[] {
  const problems: string[] = [];
  if (run.last.searchCalls + run.last.readCalls > 0) problems.push(`used the web (${run.last.searchCalls} searches, ${run.last.readCalls} reads) for a memory question`);
  return problems;
}

function expect(condition: boolean, problem: string): string[] {
  return condition ? [] : [problem];
}

function answered(run: CaseRun): string[] {
  const problems: string[] = [];
  if (run.last.error) problems.push(`turn failed: ${run.last.error}`);
  else if (run.last.answer.trim() === "") problems.push("empty answer");
  return problems;
}

// A fresh question must be answered from pages: cited, with at least one claim anchored in a stored page.
function freshChecks(run: CaseRun): string[] {
  return [
    ...answered(run),
    ...expect(CITATION.test(run.last.answer), "answer has no [n] citation"),
    ...expect(anchoredClaims(run) >= 1, "no anchored claim was stored"),
    ...expect(run.last.events.some((event) => event.type === "sources"), "no sources event"),
  ];
}

const CRM_MONDAY = "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?";

export const CASES: EvalCase[] = [
  {
    id: "crm-recheck",
    what: "challenge 1: recheck the Monday CRM shortlist",
    turns: [CRM_MONDAY],
    seeded: true,
    check: (run) => [
      ...answered(run),
      ...expect(recheckRows(run).length >= 4, `only ${recheckRows(run).length} recheck_row events`),
      ...expect(coverageEvents(run).length === 1, `${coverageEvents(run).length} coverage events`),
      ...expect(/hubspot/i.test(run.last.answer), "answer never mentions HubSpot, which has no stored price"),
      ...expect(!/still true/i.test(run.last.answer), 'answer says "still true"'),
    ],
  },
  {
    id: "postgres-recheck",
    what: "challenge 2: recheck last Tuesday's Postgres hosting comparison",
    turns: ["Last Tuesday we compared Neon, Supabase and Render for Postgres hosting. Has any of them changed pricing since?"],
    seeded: true,
    check: (run) => [
      ...answered(run),
      ...expect(recheckRows(run).length >= 3, `only ${recheckRows(run).length} recheck_row events`),
      ...expect(coverageEvents(run).length === 1, `${coverageEvents(run).length} coverage events`),
      ...expect(/neon/i.test(run.last.answer) && /supabase/i.test(run.last.answer) && /render/i.test(run.last.answer), "answer misses one of Neon, Supabase, Render"),
      ...expect(!/still true/i.test(run.last.answer), 'answer says "still true"'),
    ],
  },
  {
    id: "nov3-recall",
    what: "challenge 3: what did I ask on 3 November (seeded)",
    turns: ["What did I ask you on 3 November?"],
    seeded: true,
    check: (run) => [
      ...answered(run),
      ...expect(/primary key/i.test(run.last.answer) && /unique index/i.test(run.last.answer), "answer does not name the primary key vs unique index question"),
      ...noWeb(run),
    ],
  },
  {
    id: "empty-crm-trap",
    what: "empty memory: Monday's CRM shortlist never happened",
    turns: [CRM_MONDAY],
    seeded: false,
    check: (run) => [
      ...answered(run),
      ...expect(!CRM_TOOLS.test(run.last.answer), `answer names a CRM tool: ${CRM_TOOLS.exec(run.last.answer)?.[0]}`),
      ...expect(NO_RECORD.test(run.last.answer), "answer does not say there is no record"),
      ...expect(recheckRows(run).length === 0, "recheck rows streamed with nothing to recheck"),
    ],
  },
  {
    id: "empty-nov3-trap",
    what: "empty memory: 3 November never happened",
    turns: ["What did I ask you on 3 November?"],
    seeded: false,
    check: (run) => [
      ...answered(run),
      ...expect(!/primary key|unique index/i.test(run.last.answer), "answer invents the seeded question"),
      ...expect(NO_RECORD.test(run.last.answer), "answer does not say there is no record"),
      ...noWeb(run),
    ],
  },
  {
    id: "hi",
    what: "greeting: no tools, fast",
    turns: ["hi"],
    seeded: false,
    check: (run) => [
      ...answered(run),
      ...expect(run.last.modelToolCalls.length === 0, `${run.last.modelToolCalls.length} model tool calls`),
      ...expect(run.last.searchCalls + run.last.readCalls === 0, "touched the web"),
      ...expect(run.last.totalMs < 2500, `total ${run.last.totalMs} ms is not under 2500`),
    ],
  },
  {
    id: "postgres-topic",
    what: "topic recall with no date",
    turns: ["what did I ask about Postgres?"],
    seeded: true,
    check: (run) => [
      ...answered(run),
      ...expect(/neon|supabase|render|managed postgres|hosting/i.test(run.last.answer), "answer does not describe the Postgres hosting question"),
      ...expect(/17 nov|tuesday/i.test(run.last.answer), "answer gives no date for it"),
      ...noWeb(run),
      ...expect(recheckRows(run).length === 0, "recheck rows for a recall question"),
    ],
  },
  {
    id: "ambiguous-3-11",
    what: "3/11 is 3 November or 11 March: ask, do not guess",
    turns: ["What did I ask you on 3/11?"],
    seeded: true,
    check: (run) => {
      const a = run.last.answer;
      const bothReadings = /november/i.test(a) && /march/i.test(a);
      const asks = a.includes("?") && /(which|do you mean|did you mean|clarify)/i.test(a);
      return [...answered(run), ...expect(bothReadings || asks, "answer neither names both readings nor asks which one"), ...noWeb(run)];
    },
  },
  {
    id: "monday-on-monday",
    what: "Monday asked on a Monday means last Monday, and says so",
    turns: ["What did I ask you on Monday?"],
    seeded: true,
    now: "2026-11-23T09:00:00Z", // a Monday
    check: (run) => [
      ...answered(run),
      ...expect(/crm|shortlist/i.test(run.last.answer), "answer does not find the 16 Nov CRM question"),
      ...expect(/16 nov|last monday|monday 16/i.test(run.last.answer), "answer does not say which Monday it means"),
      ...noWeb(run),
    ],
  },
  {
    id: "fresh-pricing",
    what: "fresh pricing question: cited and anchored",
    turns: ["How much does the Supabase Pro plan cost per month?"],
    seeded: false,
    check: (run) => [...freshChecks(run), ...expect(run.last.modelToolCalls.some((call) => call.name === "web_search"), "never called web_search")],
  },
  {
    id: "hindi-price",
    what: "Hindi question about a price: Hindi answer, cited and anchored",
    turns: ["Supabase Pro प्लान की कीमत प्रति माह कितनी है?"],
    seeded: false,
    check: (run) => [...freshChecks(run), ...expect(/[ऀ-ॿ]/.test(run.last.answer), "answer has no Devanagari text")],
  },
  {
    id: "pronoun-follow-up",
    what: "'and what about the second one?' after a two-product answer",
    turns: ["Compare the Pro plan price of Neon and Supabase.", "and what about the second one?"],
    seeded: false,
    check: (run) => {
      const first = run.turns[0]?.answer.toLowerCase() ?? "";
      const neon = first.indexOf("neon");
      const supabase = first.indexOf("supabase");
      if (neon === -1 || supabase === -1) return [`the first answer did not discuss both products (neon at ${neon}, supabase at ${supabase})`];
      const second = neon < supabase ? "supabase" : "neon";
      const queries = run.last.modelToolCalls
        .filter((call) => call.name === "web_search")
        .map((call) => call.arguments)
        .join(" ")
        .toLowerCase();
      return [
        ...answered(run),
        ...expect(run.last.answer.toLowerCase().includes(second), `answer does not name the second product (${second})`),
        ...expect(!queries.includes("second one"), "a search query still says 'the second one'"),
        ...expect(queries === "" || queries.includes(second), `searched, but not for ${second}`),
      ];
    },
  },
];
