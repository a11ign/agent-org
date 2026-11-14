// no-token: gh -- herdr, the tracker, the answerer's model and the clock are all injected; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { herdrName } from "./pool.ts";
import { answerFixture } from "./pool-answer-fixture.ts";
import { interventionsView } from "./queue/interventions.ts";
import { logOf } from "./queue/run-log.ts";
import { decisionsOf } from "./ticket-decisions.ts";

// A11-438: a question whose answer is already written down is answered before the run is parked for a person.
const QUESTION = "Which repository does this change belong in: agent-org or a11y-witness?";
/** The question as the worker writes it: it names no item of the escalation list, so the board marks it off the list. */
const ASKED = { kind: "needs-human", reason: QUESTION };
const HELD = `Off the escalation list: ${QUESTION}`;
const PARENT = { key: "NBF-0", description: "Epic: every child of this epic lands in agent-org.\n\n**Repository:** agent-org" };
const ON = { autoAnswer: true };
const SURE = JSON.stringify({ answer: "agent-org", confidence: 0.97, sources: ["the parent ticket NBF-0"] });

/** An answerer that answers `reply` and records each prompt and model it was asked with. */
function answering(reply: string | Error) {
  const asked: { prompt: string; model: string }[] = [];
  const answerer = async (prompt: string, model: string): Promise<string> => {
    asked.push({ prompt, model });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { asked, answerer };
}

/** Let the answer the pool started in the background settle. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
}

/** A run of NBF-1, with `reply` as the model's, that ends on `outcome` and is let settle. */
async function asking(reply: string | Error, { tickets = ON as Readonly<Record<string, unknown>>, outcome = ASKED as Record<string, unknown> } = {}) {
  const model = answering(reply);
  const made = answerFixture({ parent: PARENT, tickets, answerer: model.answerer });
  await made.endsOn(outcome);
  await settled();
  return { ...made, ...model };
}

test("A11-438: with the key on, a question the parent ticket settles is answered from it above the threshold, and the run carries on with the parent ticket shown as its source", async () => {
  const made = await asking(SURE);
  const entry = made.entry("NBF-1");
  assert.equal(entry.phase, "running", "the run is not parked: it carries on");
  assert.deepEqual(entry.autoAnswer, { question: HELD, answer: "agent-org", confidence: 0.97, sources: [{ label: "the parent ticket NBF-0", url: "https://linear.app/x/NBF-0" }], at: made.entry("NBF-1").autoAnswer?.at });
  assert.equal(made.asked.length, 1);
  assert.equal(made.asked[0].model, "haiku", "the cheap model by default");
  assert.ok(made.asked[0].prompt.includes(PARENT.description) && made.asked[0].prompt.includes(`<source label="the parent ticket NBF-0">`), "the model is given the parent ticket under its label");
  const message = made.prompts().at(-1)?.at(-1) ?? "";
  assert.match(message, /answered your question automatically/);
  assert.ok(message.includes("> agent-org") && message.includes("the parent ticket NBF-0 (https://linear.app/x/NBF-0)"), "the run is sent the answer with its source");
  assert.match(message, /Decisions made without a person/);
  assert.equal(decisionsOf(made.held.description), null, "nothing is written into the ticket's Decisions: no person decided it");
  const events = logOf(made.store.get(), "NBF-1");
  assert.equal(events.some((event) => event.kind === "needs-you"), false, "it never went to Needs you");
  assert.deepEqual(events.filter((event) => event.kind === "auto-answered").map((event) => (event as { sources?: readonly string[] }).sources), [["the parent ticket NBF-0"]]);
});

test("A11-438: the run's old outcome is not read again once it is answered, and an agent still idle before it takes the answer is not ended for having no outcome", async () => {
  const made = await asking(SURE);
  await made.pool.tick();
  await settled();
  assert.equal(made.asked.length, 1, "the question is not asked twice");
  assert.equal(made.entry("NBF-1").phase, "running", "idle with its old outcome marked stale, it is still running");
  made.status.set(herdrName("NBF-1"), "working");
  await made.pool.tick();
  assert.equal(made.entry("NBF-1").phase, "running");
});

test("A11-438: a question the model answers below the threshold is parked for a person, as today", async () => {
  const made = await asking(JSON.stringify({ answer: "agent-org", confidence: 0.6, sources: ["the parent ticket NBF-0"] }));
  const entry = made.entry("NBF-1");
  assert.equal(entry.phase, "finished");
  assert.equal(entry.workspace, "w1", "parked on its question, as the board parks one");
  assert.deepEqual(entry.outcome, { kind: "needs-human", reason: HELD });
  assert.equal(entry.autoAnswer, undefined);
  assert.equal(made.prompts().length, 0, "the run is sent nothing");
  assert.equal(logOf(made.store.get(), "NBF-1").filter((event) => event.kind === "needs-you").length, 1, "it went to Needs you once");
});

test("A11-438: an answer that cites none of its sources, a reply that cannot be read and a model that fails each park the question for a person", async () => {
  for (const reply of [JSON.stringify({ answer: "agent-org", confidence: 0.99, sources: ["what I remember"] }), "I think agent-org.", new Error("claude exited 1")]) {
    const made = await asking(reply);
    assert.equal(made.entry("NBF-1").phase, "finished", String(reply));
    assert.equal(made.entry("NBF-1").outcome?.kind, "needs-human");
    assert.equal(made.prompts().length, 0);
  }
});

test("A11-438: with the key off, as by default, nothing is asked and the question is parked for a person", async () => {
  const made = await asking(SURE, { tickets: {} });
  assert.equal(made.asked.length, 0);
  assert.equal(made.entry("NBF-1").phase, "finished");
  assert.equal(made.entry("NBF-1").outcome?.kind, "needs-human");
});

test("A11-438: a question under an item the answerer may not take, such as outward-facing, reaches a person without the model being asked", async () => {
  const made = await asking(SURE, { outcome: { kind: "needs-human", reason: "Post the release note?", escalation: "outward" } });
  assert.equal(made.asked.length, 0);
  assert.equal(made.entry("NBF-1").phase, "finished");
});

test("A11-438: a run that asks the same question again after its automatic answer is parked for a person", async () => {
  const made = await asking(SURE);
  made.status.set(herdrName("NBF-1"), "working");
  await made.pool.tick();
  await made.endsOn(ASKED);
  await settled();
  assert.equal(made.asked.length, 1, "the model is not asked the same question twice");
  assert.equal(made.entry("NBF-1").phase, "finished");
  assert.equal(made.entry("NBF-1").outcome?.kind, "needs-human");
});

test("A11-438: a person overrules an automatic answer through the answer route: it is written in the ticket's Decisions, and the run carries on with the person's answer", async () => {
  const made = await asking(SURE);
  const done = await made.pool.answer("NBF-1", { answer: "a11y-witness: this change is the witness's.", who: "the chairman" });
  assert.deepEqual(done, { written: true, delivered: true });
  assert.ok(decisionsOf(made.held.description)?.includes(`* **Question:** ${HELD}`) && made.held.description.includes("* **Answer:** a11y-witness: this change is the witness's."), "the person's answer is in the ticket's Decisions, under the question the automatic answer answered");
  const message = made.prompts().at(-1)?.at(-1) ?? "";
  assert.match(message, /A person overruled the automatic answer to your question/);
  assert.ok(message.includes("> a11y-witness: this change is the witness's."), "the run is sent the person's answer");
  const entry = made.entry("NBF-1");
  assert.equal(entry.phase, "running", "the run carries on");
  assert.equal(entry.autoAnswer?.overruledAt !== undefined, true, "the card says it was overruled");
  await assert.rejects(made.pool.answer("NBF-1", { answer: "agent-org after all." }), /not waiting on a person/, "an answer overrules once: a second needs a new question");
});

test("A11-438: the day's tally counts the automatic answer and a person's answer apart, and neither as a person-intervention", async () => {
  const made = await asking(SURE);
  await made.pool.answer("NBF-1", { answer: "a11y-witness.", who: "the chairman" });
  const today = interventionsView(made.store.get(), made.entry("NBF-1").autoAnswer?.at ?? 0).days.at(-1);
  assert.deepEqual({ autoAnswers: today?.autoAnswers, personAnswers: today?.personAnswers, total: today?.total }, { autoAnswers: 1, personAnswers: 1, total: 0 });
});

test("A11-438: once a person answers a later question of the run, its automatic answer stands and an answer while the run goes on is refused as before", async () => {
  const made = await asking(SURE);
  made.status.set(herdrName("NBF-1"), "working");
  await made.pool.tick();
  await made.endsOn({ kind: "needs-human", reason: "Name the new setting?", escalation: "outward" });
  await settled();
  assert.equal(made.entry("NBF-1").phase, "finished", "a new question, parked for a person");
  await made.pool.answer("NBF-1", { answer: "Call it autoAnswer.", who: "the chairman" });
  assert.ok(made.held.description.includes("Name the new setting?"), "the ordinary answer answers the new question");
  assert.notEqual(made.entry("NBF-1").autoAnswer?.closedAt, undefined, "the automatic answer is closed, not overruled");
  assert.equal(made.entry("NBF-1").autoAnswer?.overruledAt, undefined);
  made.status.set(herdrName("NBF-1"), "working");
  await made.pool.tick();
  await assert.rejects(made.pool.answer("NBF-1", { answer: "a11y-witness." }), /not waiting on a person/, "nothing is left to overrule");
});

test("A11-438: an overrule herdr will not take to the run is still recorded as the person's, with the answer in the ticket", async () => {
  const made = await asking(SURE);
  made.control.refuseMessage = "agent_blocked";
  await assert.rejects(made.pool.answer("NBF-1", { answer: "a11y-witness.", who: "the chairman" }), /answer is in the ticket/);
  assert.ok(made.held.description.includes("* **Answer:** a11y-witness."));
  assert.notEqual(made.entry("NBF-1").autoAnswer?.overruledAt, undefined, "the card says it was overruled");
});
