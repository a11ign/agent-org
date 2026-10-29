// no-token: gh -- herdr, the tracker and the clock are all injected; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionsOf } from "./ticket-decisions.ts";
import { AnswerNotDelivered } from "./pool.ts";
import { ANSWER_CHARS } from "./pool-answer.ts";
import { WHO_CHARS } from "./answer-decision.ts";
import { answerFixture } from "./pool-answer-fixture.ts";
import { descriptionHash } from "./ticket-read.ts";
import { logOf } from "./queue/run-log.ts";

const QUESTION = "Which wording should the round cap use: keep the current one, or the shorter one?";
const ASKED = { kind: "needs-human", reason: QUESTION, escalation: "reserved" };
/** The question as the board holds it (A11-257): the card names the escalation-list item first, and the Decisions entry records the question as held. */
const HELD = `reserved to the person \u2014 ${QUESTION}`;
const ENTRY = `## Decisions (the chairman, 2026-10-25)\n\n* **Question:** ${HELD}\n* **Answer:** Keep the current wording.\n`;

test("A11-250: an answered Needs-you question lands in the ticket's Decisions, written before the run is told, and the run is told", async () => {
  const made = answerFixture();
  await made.endsOn(ASKED);
  assert.equal(made.entry("NBF-1").phase, "finished");
  assert.equal(made.entry("NBF-1").workspace, "w1", "the run is parked on its question");

  const done = await made.pool.answer("NBF-1", { answer: "Keep the current wording.", who: "the chairman" });

  assert.deepEqual(done, { written: true, delivered: true });
  assert.equal(made.held.description, `Fix the toast.\n\n${ENTRY}`, "the ticket ends with the entry: the heading, the run's question and the answer as given");
  assert.equal(made.writes.length, 1);
  assert.ok(decisionsOf(made.held.description)?.includes("* **Answer:** Keep the current wording."), "the reviewer's reader (decisionsOf) finds the answer in the ticket");
  const [prompt] = made.prompts();
  assert.ok(made.prompts().length === 1 && prompt.includes("w1:p1"), "one message, to the run's agent at its pane (A11-279)");
  assert.ok(made.writes[0].herdrCallsBefore <= made.herdr.calls.indexOf(prompt), "the ticket was written before the run was told");
  const message = prompt[prompt.length - 1];
  assert.match(message, /A person answered your question/);
  assert.ok(message.includes(`> ${HELD}`) && message.includes("> Keep the current wording."), "the message quotes both");
  assert.ok(message.includes("`## Decisions (the chairman, 2026-10-25)`") && message.includes("https://linear.app/x/NBF-1"), "and says where the ticket records them");
  assert.match(message, /link the ticket's Decisions entry that records it/);
});

test("A11-250: the run's own copy of the ticket moves on with the write, so a review after the answer is briefed with the decision", async () => {
  const made = answerFixture();
  await made.endsOn(ASKED);
  await made.pool.answer("NBF-1", { answer: "Keep the current wording.", who: "the chairman" });
  const entry = made.entry("NBF-1");
  assert.equal(entry.ticket.description, made.held.description);
  assert.equal(entry.briefedAgainst?.hash, descriptionHash(made.held.description));
  assert.ok(decisionsOf(entry.ticket.description)?.includes("Keep the current wording."), "decisionsOf, which the reviewer's brief reads from this copy, holds the answer");
  assert.deepEqual(logOf(made.store.get(), "NBF-1").filter((event) => event.kind === "answered").map((event) => (event as { by?: string }).by), ["answer"]);
});

test("A11-250: a second answer in the same section merges under the heading; the entry is headed with the tracker's name for the key's person when no name is given", async () => {
  const made = answerFixture({ description: "Fix the toast.\n\n## Decisions (the chairman, 2026-10-25)\n\n* **Round cap:** three.\n" });
  await made.endsOn(ASKED);
  await made.pool.answer("NBF-1", { answer: "Keep it.", who: "the chairman" });
  assert.equal(made.held.description.match(/^## Decisions/gm)?.length, 1, "one section");
  assert.ok(made.held.description.endsWith("* **Round cap:** three.\n\n* **Question:** " + HELD + "\n* **Answer:** Keep it.\n"));
  const named = answerFixture();
  await named.endsOn(ASKED);
  await named.pool.answer("NBF-1", { answer: "Keep it." });
  assert.match(named.held.description, /^## Decisions \(Dana Beck, 2026-10-25\)$/m);
  const nobody = answerFixture({ viewer: null });
  await nobody.endsOn(ASKED);
  await nobody.pool.answer("NBF-1", { answer: "Keep it." });
  assert.match(nobody.held.description, /^## Decisions \(a person, 2026-10-25\)$/m);
});

test("A11-250: a ticket the tracker refuses to write sends the run nothing, and the run's copy of the ticket is as it was", async () => {
  const made = answerFixture();
  await made.endsOn(ASKED);
  made.control.refuseWrite = "Linear refused the update";
  await assert.rejects(made.pool.answer("NBF-1", { answer: "Keep it.", who: "the chairman" }), /NBF-1's Decisions could not be written \(Linear refused the update\): nothing was sent to the run/);
  assert.equal(made.prompts().length, 0);
  assert.equal(made.held.description, "Fix the toast.");
  assert.equal(made.entry("NBF-1").ticket.description, "Fix the toast.", "the entry keeps the text it had");
});

test("A11-250: an answer herdr will not take is in the ticket and says so (502 in the route); sending it again writes nothing twice and tells the run", async () => {
  const made = answerFixture();
  await made.endsOn(ASKED);
  made.control.refuseMessage = "agent_blocked";
  await assert.rejects(made.pool.answer("NBF-1", { answer: "Keep it.", who: "the chairman" }), (error: unknown) => error instanceof AnswerNotDelivered && /answer is in the ticket, but herdr would not take it to the run \(agent_blocked\)/.test(error.message));
  assert.equal(made.writes.length, 1, "the ticket has the entry");
  assert.equal(logOf(made.store.get(), "NBF-1").some((event) => event.kind === "answered"), false, "the run is not logged as told");
  made.control.refuseMessage = null;
  assert.deepEqual(await made.pool.answer("NBF-1", { answer: "Keep it.", who: "the chairman" }), { written: true, delivered: true });
  assert.equal(made.writes.length, 1, "the same answer is not written again");
  assert.equal(made.held.description.match(/\* \*\*Answer:\*\*/g)?.length, 1);
  assert.equal(made.prompts().length, 1, "and was sent (the refused attempt never reached herdr)");
});

test("A11-250: a run whose workspace is gone is not waiting: the answer is in the ticket, and the route says nothing was sent", async () => {
  const made = answerFixture();
  await made.endsOn(ASKED);
  await made.pool.close("NBF-1");
  assert.equal(made.entry("NBF-1").workspace, undefined);
  const done = await made.pool.answer("NBF-1", { answer: "Keep it.", who: "the chairman" });
  assert.equal(done.written, true);
  assert.equal(done.delivered, false);
  assert.match(done.why ?? "", /no workspace open or is no longer waiting, so nothing is waiting for the answer: it is in the ticket/);
  assert.equal(made.prompts().length, 0);
  assert.ok(made.held.description.includes("* **Answer:** Keep it."));
});

test("A11-250: a run that is not waiting on a person is refused, naming why, and nothing is written", async () => {
  const cases: { outcome: Record<string, unknown> | null; message: RegExp }[] = [
    { outcome: { kind: "checked", reason: "nothing to change" }, message: /NBF-1 is not waiting on a person: its run ended checked/ },
    { outcome: { kind: "ready-pr", prs: [{ repo: "a/b", url: "https://github.com/a/b/pull/1" }], reason: "done" }, message: /not waiting on a person: its run ended ready-pr/ },
  ];
  for (const { outcome, message } of cases) {
    const made = answerFixture();
    await made.endsOn(outcome as Record<string, unknown>);
    await assert.rejects(made.pool.answer("NBF-1", { answer: "Keep it." }), message);
    assert.equal(made.writes.length, 0);
    assert.equal(made.prompts().length, 0);
  }
  const running = answerFixture();
  await running.pool.tick();
  await assert.rejects(running.pool.answer("NBF-1", { answer: "Keep it." }), /NBF-1 is still running, not waiting on a person/);
  const queued = answerFixture();
  await assert.rejects(queued.pool.answer("NBF-1", { answer: "Keep it." }), /NBF-1 is queued, not waiting on a person/);
  await assert.rejects(queued.pool.answer("NBF-9", { answer: "Keep it." }), /NBF-9 is not on the board/);
  assert.equal(queued.writes.length + running.writes.length, 0);
});

test("A11-250: an outcome file the board could not read is no question, and a settled ticket has none waiting", async () => {
  const unreadable = answerFixture();
  await unreadable.endsOn({ kind: "merged" });
  assert.equal(unreadable.entry("NBF-1").outcome?.kind, "needs-human");
  await assert.rejects(unreadable.pool.answer("NBF-1", { answer: "Keep it." }), /NBF-1's outcome file could not be read, so there is no question to answer/);
  const settled = answerFixture();
  await settled.endsOn(ASKED);
  settled.store.set({ ...settled.store.get(), entries: settled.store.get().entries.map((e) => ({ ...e, trackerState: "completed" })) });
  await assert.rejects(settled.pool.answer("NBF-1", { answer: "Keep it." }), /NBF-1's ticket is completed in the tracker, so nothing waits for an answer/);
  assert.equal(unreadable.writes.length + settled.writes.length, 0);
});

test("A11-250: an empty answer, one over the limit, a name of two lines or too long, and a tracker that cannot edit a ticket are all refused before anything is written", async () => {
  const made = answerFixture();
  await made.endsOn(ASKED);
  await assert.rejects(made.pool.answer("NBF-1", { answer: "  \n " }), /the answer is empty/);
  await assert.rejects(made.pool.answer("NBF-1", { answer: "x".repeat(ANSWER_CHARS + 1) }), /the answer is over 4000 characters/);
  await assert.rejects(made.pool.answer("NBF-1", { answer: "ok", who: "a\nb" }), /who is one line of at most 60 characters/);
  await assert.rejects(made.pool.answer("NBF-1", { answer: "ok", who: "w".repeat(WHO_CHARS + 1) }), /who is one line of at most 60 characters/);
  await assert.rejects(made.pool.answer("NBF-1", { answer: "ok", who: " " }), /who is one line/);
  assert.equal(made.writes.length + made.prompts().length, 0);
  const without = answerFixture({ withoutUpdate: true });
  await without.endsOn(ASKED);
  await assert.rejects(without.pool.answer("NBF-1", { answer: "ok" }), /this tracker cannot edit NBF-1's text, so the answer cannot be recorded, and nothing is sent to the run/);
  assert.equal(without.prompts().length, 0);
});

test("A11-250: an answer with an unclosed code fence is closed, so the entries after it stay readable to decisionsOf", async () => {
  const made = answerFixture();
  await made.endsOn(ASKED);
  await made.pool.answer("NBF-1", { answer: "Use this:\n```\nkeep()", who: "the chairman" });
  assert.equal(made.held.description.split("\n").filter((line) => line.trim().startsWith("```")).length % 2, 0, "every fence the entry opens it closes");
  assert.ok(decisionsOf(made.held.description)?.includes("keep()"));
});

test("A11-250: two answers for one ticket are not taken at once", async () => {
  const made = answerFixture();
  await made.endsOn(ASKED);
  const first = made.pool.answer("NBF-1", { answer: "Keep it.", who: "the chairman" });
  await assert.rejects(made.pool.answer("NBF-1", { answer: "Change it.", who: "the chairman" }), /an answer to NBF-1 is being written/);
  await first;
  assert.equal(made.writes.length, 1);
});

test("A11-250: a run briefed with an older text keeps it, so an edit made meanwhile is still a change to the run; the entry is in the run's copy of the ticket all the same", async () => {
  const made = answerFixture();
  await made.endsOn(ASKED);
  const briefed = made.entry("NBF-1").briefedAgainst;
  made.held.description = "Fix the toast, and the tooltip.";
  await made.pool.answer("NBF-1", { answer: "Keep it.", who: "the chairman" });
  assert.equal(made.entry("NBF-1").briefedAgainst?.hash, briefed?.hash, "the baseline is what the run was briefed with");
  assert.ok(made.entry("NBF-1").ticket.description.includes("and the tooltip.") && made.entry("NBF-1").ticket.description.includes("* **Answer:** Keep it."));
});

test("A11-250: the same question answered one way, then another, then the first way again is written the third time", async () => {
  const made = answerFixture();
  await made.endsOn(ASKED);
  for (const answer of ["Keep it.", "Change it.", "Keep it."]) await made.pool.answer("NBF-1", { answer, who: "the chairman" });
  assert.equal(made.writes.length, 3);
  assert.ok(made.held.description.endsWith("* **Answer:** Keep it.\n"));
});
