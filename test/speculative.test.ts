import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn, type TurnEvent } from "../src/conversation.ts";
import type { LlmEvent } from "../src/llm.ts";
import type { SearchPort, SearchRequest } from "../src/search.ts";
import { eligibleForSpeculation } from "../src/speculative.ts";
import { resolveDates } from "../src/temporal.ts";
import { memoryDb, offlineDeps, ScriptedLlm } from "./helpers.ts";

const QUESTION = "AcmeDB pricing plans overview please";
const NOW = new Date("2026-11-21T10:00:00Z");

const call = (args: object): LlmEvent => ({ type: "tool_call", call: { id: "call_1", name: "web_search", arguments: JSON.stringify(args) } });
const answer: LlmEvent[] = [{ type: "token", text: "AcmeDB Launch is $19 a month [1]." }];

// The offline search and reader, with every search request written down.
function watched(llm: ScriptedLlm, flags: { speculativeSearch?: boolean; compactPrompt?: boolean }) {
  const deps = { ...offlineDeps(llm, memoryDb()), ...flags };
  const requests: SearchRequest[] = [];
  const inner: SearchPort = deps.search;
  deps.search = {
    search(request) {
      requests.push(request);
      return inner.search(request);
    },
  };
  return { deps, requests };
}

async function ask(deps: ReturnType<typeof watched>["deps"], message: string) {
  const events: TurnEvent[] = [];
  const result = await runTurn(deps, { message, timezone: "UTC" }, (event) => events.push(event));
  return { result, events };
}

test("when the model plans the same thing the user said, the pages found meanwhile are used and its queries are skipped", async () => {
  const llm = new ScriptedLlm([() => [call({ queries: ["AcmeDB pricing plans", "AcmeDB Launch plan price"] })], () => answer]);
  const { deps, requests } = watched(llm, { speculativeSearch: true });
  const { result, events } = await ask(deps, QUESTION);

  assert.deepEqual(requests.map((request) => request.query), [QUESTION]); // only the speculative search ran
  assert.equal(result.timings.speculative, "hit");
  const sources = events.find((event) => event.type === "sources");
  assert.ok(sources && sources.type === "sources" && sources.sources.length >= 1);
  assert.match(result.answer, /\[1\]/);
});

test("a plan with nothing in common with the message is a miss, and the model's own queries run", async () => {
  const llm = new ScriptedLlm([() => [call({ queries: ["weather forecast Paris tomorrow"] })], () => answer]);
  const { deps, requests } = watched(llm, { speculativeSearch: true });
  const { result } = await ask(deps, QUESTION);
  assert.equal(result.timings.speculative, "miss");
  assert.deepEqual(requests.map((request) => request.query), [QUESTION, "weather forecast Paris tomorrow"]);
});

test("greetings, pronouns and dates never trigger a speculative search", async () => {
  for (const message of ["hi", "what is the price of it for the Pro plan monthly", "what did I ask last Tuesday about pricing plans"]) {
    const llm = new ScriptedLlm([() => answer]);
    const { deps, requests } = watched(llm, { speculativeSearch: true });
    const { result } = await ask(deps, message);
    assert.equal(requests.length, 0, message);
    assert.equal(result.timings.speculative, "skipped", message);
  }
  assert.equal(eligibleForSpeculation(QUESTION, resolveDates(QUESTION, NOW, "UTC")), true);
  assert.equal(eligibleForSpeculation("price of it", []), false);
});

test("with the flag off nothing is searched before the model decides", async () => {
  const llm = new ScriptedLlm([() => answer]);
  const { deps, requests } = watched(llm, {});
  const { result } = await ask(deps, QUESTION);
  assert.equal(requests.length, 0);
  assert.equal(result.timings.speculative, "off");
});

test("the compact prompt offers only web_search for a plain fresh question, and the full set otherwise", async () => {
  const fresh = new ScriptedLlm([() => answer]);
  await ask(watched(fresh, { compactPrompt: true }).deps, QUESTION);
  assert.deepEqual(fresh.requests[0]?.tools?.map((tool) => tool.name), ["web_search"]);
  assert.ok(!/recheck|recall/.test(String(fresh.requests[0]?.messages[0]?.content)));

  // Each of these is eligible for the web, so only a word about the earlier conversation keeps the full prompt.
  for (const message of ["AcmeDB pricing plans changed recently overview", "What is our AcmeDB pricing plans overview"]) {
    const past = new ScriptedLlm([() => answer]);
    await ask(watched(past, { compactPrompt: true }).deps, message);
    assert.deepEqual(past.requests[0]?.tools?.map((tool) => tool.name), ["web_search", "recall", "recheck"], message);
  }
});
