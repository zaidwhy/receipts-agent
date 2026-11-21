import "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn, type TurnEvent } from "../src/conversation.ts";
import type { ChatMessage, LlmEvent } from "../src/llm.ts";
import { count, memoryDb, offlineDeps, ScriptedLlm, seedExchange, type RecordedRequest } from "./helpers.ts";
import type { Database } from "../src/db.ts";

// The test clock is Saturday 21 Nov 2026, 15:30 in India.
const zone = "Asia/Kolkata";

function seeded(): Database {
  const db = memoryDb();
  seedExchange(db, {
    question: "Which CRM should we shortlist, HubSpot or Pipedrive?",
    answer: "Pipedrive is cheaper for a small team.",
    askedAt: "2026-11-03T08:00:00.000Z",
    entities: ["HubSpot", "Pipedrive"],
  });
  seedExchange(db, {
    question: "What does AcmeDB cost?",
    answer: "AcmeDB Launch is $19 per month.",
    askedAt: "2026-11-17T09:00:00.000Z",
    entities: ["AcmeDB", "OtherDB"],
    claims: [
      {
        text: "AcmeDB Launch costs $19 per month",
        kind: "price",
        entity: "AcmeDB",
        quote: "Launch $19",
        url: "https://www.acmedb.dev/pricing",
        page: "Launch $19 per month",
        fetchedAt: "2026-11-17T09:00:04.000Z",
      },
    ],
  });
  return db;
}

const say = (text: string): LlmEvent[] => [{ type: "token", text }];
const statusTexts = (events: TurnEvent[]) => events.flatMap((e) => (e.type === "status" ? [e.text] : []));
const toolMessages = (request: RecordedRequest) => request.messages.filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool");

test("a question about last Tuesday is looked up in code before the model is called", async () => {
  const db = seeded();
  const events: TurnEvent[] = [];
  let statusesBeforeModel: string[] = [];
  const llm = new ScriptedLlm([
    () => {
      statusesBeforeModel = statusTexts(events);
      return say("You asked what AcmeDB costs.");
    },
  ]);

  const result = await runTurn(offlineDeps(llm, db), { message: "What did I ask you on Tuesday?", timezone: zone }, (e) => events.push(e));

  assert.deepEqual(statusesBeforeModel, ["thinking", "looking up what you asked on Tuesday 17 Nov"]);
  assert.equal(llm.requests.length, 1);

  const first = llm.requests[0] as RecordedRequest;
  const injected = first.messages.find((m) => m.role === "assistant" && m.toolCalls);
  assert.ok(injected && injected.role === "assistant" && injected.toolCalls);
  assert.equal(injected.toolCalls[0]?.name, "recall");
  assert.deepEqual(JSON.parse(injected.toolCalls[0]?.arguments ?? "{}"), {
    start: "2026-11-16T18:30:00.000Z",
    end: "2026-11-17T18:30:00.000Z",
  });
  const tool = toolMessages(first)[0];
  assert.ok(tool);
  assert.equal(tool.toolCallId, injected.toolCalls[0]?.id);
  assert.match(tool.content, /What does AcmeDB cost\?/);
  assert.match(tool.content, /"ageDays": 4/);
  assert.ok(!tool.content.includes("Which CRM"));

  // The recall call comes after the history and the user's message, and the model still gets both tools.
  const roles = first.messages.map((m) => m.role);
  assert.deepEqual(roles.slice(-3), ["user", "assistant", "tool"]);
  assert.deepEqual(first.tools?.map((t) => t.name), ["web_search", "recall"]);
  assert.equal(result.answer, "You asked what AcmeDB costs.");
});

test("the model is given the resolved date next to the user's own words", async () => {
  const llm = new ScriptedLlm([() => say("ok")]);
  await runTurn(offlineDeps(llm, seeded()), { message: "What did I ask you on Tuesday? Also 3/11.", timezone: zone }, () => {});
  const system = llm.requests[0]?.messages[0];
  assert.ok(system && system.role === "system");
  assert.match(system.content, /"Tuesday" = Tuesday 17 Nov \(2026-11-16T18:30:00\.000Z to 2026-11-17T18:30:00\.000Z\)/);
  assert.match(system.content, /"3\/11" is ambiguous numeric date\. Ask which date they mean/);
});

test("no record for the date: the model is told so with the nearest dates, and the turn invents nothing", async () => {
  const db = seeded();
  const llm = new ScriptedLlm([
    (request) => {
      const lookup = toolMessages(request).at(-1)?.content ?? "";
      // A model that follows the instruction says there is no record; one that ignores it would quote a turn.
      return lookup.startsWith("No record")
        ? say("I have no record of what you asked on Monday 16 Nov. The nearest days I do have are Tuesday 3 Nov and Tuesday 17 Nov. Want me to search fresh?")
        : say("On Monday you asked about HubSpot.");
    },
  ]);
  const events: TurnEvent[] = [];

  const result = await runTurn(offlineDeps(llm, db), { message: "What did I ask you on Monday?", timezone: zone }, (e) => events.push(e));

  assert.ok(statusTexts(events).includes("looking up what you asked on Monday 16 Nov"));
  const lookup = toolMessages(llm.requests[0] as RecordedRequest)[0]?.content ?? "";
  assert.match(lookup, /^No record of any conversation for Monday 16 Nov\./);
  assert.match(lookup, /nearest recorded dates are: Tuesday 3 Nov and Tuesday 17 Nov/);

  assert.match(result.answer, /no record/i);
  assert.ok(!result.answer.includes("HubSpot"));
  assert.equal(result.claims.stored, 0);
  assert.equal(count(db, "claims"), 1); // only the seeded one
  assert.match(llm.requests[0]?.messages[0] && llm.requests[0].messages[0].role === "system" ? llm.requests[0].messages[0].content : "", /no record for that date/);
});

test("a date without a reference to the past conversation does not trigger a lookup", async () => {
  const llm = new ScriptedLlm([() => say("ok")]);
  const events: TurnEvent[] = [];
  await runTurn(offlineDeps(llm, seeded()), { message: "What changed in AcmeDB pricing on 3 November?", timezone: zone }, (e) => events.push(e));
  assert.deepEqual(statusTexts(events), ["thinking"]);
  assert.equal(toolMessages(llm.requests[0] as RecordedRequest).length, 0);
});

test("a reference to the past without a date does not trigger a lookup either", async () => {
  const llm = new ScriptedLlm([() => say("ok")]);
  await runTurn(offlineDeps(llm, seeded()), { message: "What did I ask earlier?", timezone: zone }, () => {});
  assert.equal(toolMessages(llm.requests[0] as RecordedRequest).length, 0);
});

test("the model can call recall itself by topic, and the current question is not in the result", async () => {
  const db = seeded();
  const events: TurnEvent[] = [];
  const recallCall: LlmEvent = { type: "tool_call", call: { id: "r1", name: "recall", arguments: JSON.stringify({ topic: "pipedrive" }) } };
  const llm = new ScriptedLlm([() => [recallCall], () => say("We shortlisted HubSpot and Pipedrive.")]);

  await runTurn(offlineDeps(llm, db), { message: "What did we say about Pipedrive?", timezone: zone }, (e) => events.push(e));

  assert.ok(statusTexts(events).includes("looking through earlier conversation"));
  const lookup = toolMessages(llm.requests[1] as RecordedRequest)[0]?.content ?? "";
  assert.match(lookup, /Which CRM should we shortlist/);
  assert.ok(!lookup.includes("What did we say about Pipedrive?"));
});

test("the prompt tells the model to say how old an expired fact is and that it needs rechecking", async () => {
  const llm = new ScriptedLlm([() => say("ok")]);
  await runTurn(offlineDeps(llm, memoryDb()), { message: "hi", timezone: "UTC" }, () => {});
  const system = llm.requests[0]?.messages[0];
  assert.ok(system && system.role === "system");
  assert.match(system.content, /expired, say how old it is and that it needs rechecking/);
  assert.match(system.content, /Never invent or guess a past conversation/);
});

test("a week reference is looked up as a range and the status says during, not on", async () => {
  const llm = new ScriptedLlm([() => say("ok")]);
  const events: TurnEvent[] = [];
  await runTurn(offlineDeps(llm, seeded()), { message: "What did we discuss last week?", timezone: zone }, (e) => events.push(e));
  assert.deepEqual(statusTexts(events), ["thinking", "looking up what you asked during week of Monday 9 Nov"]);
  const lookup = toolMessages(llm.requests[0] as RecordedRequest)[0]?.content ?? "";
  assert.match(lookup, /^No record of any conversation for week of Monday 9 Nov\./);
});
