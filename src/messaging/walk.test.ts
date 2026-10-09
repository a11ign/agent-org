// no-token: prepareContext -- the orders port, the readers and the GitHub writer are injected fixtures and nothing here calls it; `listen.mjs` only carries it in through the `converse.mjs` import (#3581)
// @ts-check
// THE WALK-THROUGH (a11ign/a11ign#3425, chairman point 3), through the real path: the real watcher sends the brief's first step, the real `createInbound` mints each press, the real `createAnswers`
// routes it, and the real `createForwarder` sends what comes back and tells the ledger the new message's ref. The fixtures are the provider, the GitHub writer, the liaison's queue and the readers.
//
// POSITIVE CONTROLS: "does NOT advance" is also what a walk that never advances reports, so the first test shows the same walk advancing on a Done whose read shows it, and every refusal below is that
// walk with ONE thing changed. "Verification is a read, not an echo of Done" is test (2): a reader that returns the wrong value stops the walk, and the same press with the right value moves it.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { createAnswers } from "./answers.mjs";
import { actionData, createInbound } from "./inbound.mjs";
import { createForwarder } from "./listen.mjs";
import { createLedger, readLedgerLines } from "./ledger.mjs";
import { walkPosition } from "./walk.mjs";
import { NEEDS_CHAIRMAN, observeRequests, parseSteps, readWalk, requestEvent } from "./sources/requests.mjs";
import { runWatch } from "./watch.mjs";

const CHAIRMAN = Object.freeze({ userId: 4242, chatId: 4242 });
const REPO = "a11ign/a11ign";
const ROW = 3601;
const KEY = `request:${REPO}#${ROW}`;
const FIRST_REF = "701";
const FIRST_UPDATE = 1;

const BRIEF_HEAD = [
  "**Brief for the chairman**",
  "What is happening: worker-6 is off and the lab cannot use it.",
  "Ask: switch worker-6 on and plug its cable in.",
  "Only you because: it is a power button in a room.",
  "Checked: it was off at the last poll.",
  "How long: two minutes.",
  "Unblocks: worker-6 is serving on its address again",
  "Not the chairman's Claude session because: it is a machine, not a session.",
];
const THREE_STEPS = [
  "Steps:",
  "1. Press the power button on worker-6.",
  "   Verify: {{unit:worker-6.state}} is active",
  "2. Plug the cable into the blue port.",
  "3. Wait for the light to go green.",
  "   Verify: {{fleet.workers-up}} contains worker-6",
];
const BRIEF = [...BRIEF_HEAD, ...THREE_STEPS].join("\n");

const scratch = mkdtempSync(join(tmpdir(), "messaging-walk-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextLedger = 0;

/** @param {string} body @returns {any} a row as `gh issue list` returns it, labelled and holding one org brief */
function row(body: string = BRIEF): any {
  return { number: ROW, title: "worker-6 is off", url: `https://github.com/${REPO}/issues/${ROW}`, comments: [{ body, createdAt: "2026-10-05T08:00:00Z", authorAssociation: "OWNER" }] };
}

/** @param {number} id @param {string} data @param {number} messageId a button press under bot message `messageId` */
function press(id: number, data: string, messageId: number) {
  return { update_id: id, callback_query: { id: `cbq-${id}`, from: { id: CHAIRMAN.userId }, data, message: { message_id: messageId, chat: { id: CHAIRMAN.chatId, type: "private" } } } };
}

/** The readers: each fact is what the test says it is NOW, and every other kind of read throws, so a verify that read something it did not name fails loudly. */
function fixtureReaders() {
  const facts = { unit: /** @type {string | Error} */ ("active"), up: ["worker-6", "worker-2"] };
  const refuse = (/** @type {string} */ kind: string) => async () => { throw new Error(`the fixture has no reader for ${kind}`); };
  return {
    facts,
    readers: /** @type {any} */ ({
      issue: refuse("issue"), pr: refuse("pr"), run: refuse("run"), ready: refuse("ready"), lastMerge: refuse("last-merge"), comment: refuse("comment"), gate: refuse("gate"), release: refuse("release"),
      async unit() { if (facts.unit instanceof Error) throw facts.unit; return { state: facts.unit }; },
      async fleet() { return { up: facts.up, down: [], polledAt: Date.parse("2026-10-05T09:55:00Z") }; },
    }),
  };
}

/** The writer: records each write and applies it to the one row. `failOnce` names a write that throws on its next call. */
function fixtureGithub(/** @type {string} */ body: string) {
  const labels = ["ready", NEEDS_CHAIRMAN];
  /** @type {string[]} */
  const writes: string[] = [];
  /** @type {Set<string>} */
  const failOnce: Set<string> = new Set();
  const attempt = (/** @type {string} */ op: string) => {
    if (failOnce.delete(op)) throw new Error(`${op} failed (503)`);
    writes.push(op);
  };
  return {
    labels, writes, failOnce,
    async readRow() { return { state: "OPEN", labels: [...labels], comments: row(body).comments }; },
    async comment() { attempt("comment"); },
    async removeLabel(/** @type {any} */ _row: any, /** @type {string} */ label: string) { attempt("remove-label"); labels.splice(0, labels.length, ...labels.filter((name) => name !== label)); },
    async addLabel(/** @type {any} */ _row: any, /** @type {string} */ label: string) { attempt("set-answer"); labels.push(label); },
  };
}

/**
 * The listener as it stands: a ledger, a provider that records what the chairman would have received, the real inbound, answers and forwarder. The first message is sent by the REAL watcher over a
 * fixture reader, so it is the message the chairman gets. `restart()` is a new process over the same ledger file; `failSendOnce()` makes the provider's next send throw.
 *
 * @param {{ body?: string, readers?: any }} [options] `readers: null` builds a listener with none, as one that could not read would be
 */
async function harness({ body = BRIEF, readers }: { body?: string; readers?: any; } = {}) {
  const path = join(scratch, `ledger-${nextLedger += 1}.jsonl`);
  let at = Date.parse("2026-10-05T10:00:00Z");
  const now = () => at += 1000;
  const fixture = fixtureReaders();
  const github = fixtureGithub(body);
  /** @type {{ messageRef: string, text: string, actions: any[] | undefined }[]} */
  const sent: { messageRef: string; text: string; actions: any[] | undefined; }[] = [];
  let refs = Number(FIRST_REF) - 1;
  let failing = false;
  const provider = {
    id: "fake", capabilities: { silent: true, buttons: true, replies: true, conversation: true, maxText: 4096 },
    async send(/** @type {{ text: string, actions?: any[] }} */ message: { text: string; actions?: any[]; }) {
      if (failing) { failing = false; throw new Error("telegram is down"); }
      refs += 1;
      sent.push({ messageRef: String(refs), text: message.text, actions: message.actions });
      return { messageRef: String(refs), silent: false };
    },
  };
  /** @type {string[]} */
  const orders: string[] = [];
  /** @type {string[]} */
  const cleared: string[] = [];
  /** @type {string[]} */
  const conversation: string[] = [];
  const ledger = () => createLedger({ path, now });
  const build = () => {
    const answers = createAnswers({
      ledger: ledger(), github, chairman: CHAIRMAN, answerLabel: "answer:ceo", now, readers: readers === null ? undefined : (readers ?? fixture.readers),
      orders: { liaison: async ({ text }) => { orders.push(text); return { queued: true, say: "queued", handoff: "h-1" }; } },
    });
    const send = (message: any) => provider.send(message);
    return {
      inbound: createInbound({ ledger: ledger(), chairman: CHAIRMAN }),
      forward: createForwarder({ answers, send, converse: (accepted) => { conversation.push(String(accepted.text)); }, log: () => {}, clearKeyboard: async (ref) => { cleared.push(ref); } }),
    };
  };
  let listener = build();
  const reader = {
    async issuesLabelled() { return [row(body)]; },
    async issueComments() { return row(body).comments; },
  };
  await runWatch({ github: reader, provider, ledger: ledger(), now, repo: REPO, summary: null });
  return {
    path, sent, orders, cleared, conversation, facts: fixture.facts, github,
    lines: () => readLedgerLines(path),
    walkLines: () => readLedgerLines(path).filter((line) => line.direction === "walk"),
    confirmed: () => readLedgerLines(path).filter((line) => line.direction === "walk" && line.event === "confirmed").map((line) => line.step),
    restart() { listener = build(); },
    failSendOnce() { failing = true; },
    /** @param {string} name a button word @param {number} messageId @param {number} id */
    async push(name: string, messageId: number, id: number) {
      const handled = listener.inbound.handle(press(id, actionData(name), messageId));
      assert.equal(handled.action, "forward", `the press was not forwarded: ${JSON.stringify(handled)}`);
      await listener.forward(handled.accepted);
    },
    /** @param {number} id @param {string} text @param {number} replyTo */
    async say(id: number, text: string, replyTo: number) {
      const update = { update_id: id, message: { message_id: 900 + id, from: { id: CHAIRMAN.userId }, chat: { id: CHAIRMAN.chatId, type: "private" }, text, reply_to_message: { message_id: replyTo } } };
      const handled = listener.inbound.handle(update);
      assert.equal(handled.action, "forward");
      await listener.forward(handled.accepted);
    },
    last: () => /** @type {{ messageRef: string, text: string, actions: any[] | undefined }} */ (sent.at(-1)),
  };
}

/** @param {any[] | undefined} actions @returns {string[]} the words of a keyboard, in order */
const wordsOf = (actions: any[] | undefined): string[] => (actions ?? []).map((action) => action.data.replace(/^act:/, ""));

describe("the brief's steps are read (the walk's input)", () => {
  test("a Steps: list yields its steps, each with the Verify that follows it, and the Unblocks line", () => {
    const { walk, problem } = readWalk(BRIEF);
    assert.equal(problem, null);
    assert.deepEqual(walk?.steps.map((step) => step.text), ["Press the power button on worker-6.", "Plug the cable into the blue port.", "Wait for the light to go green."]);
    assert.deepEqual(walk?.steps.map((step) => step.verify), [
      { read: "{{unit:worker-6.state}}", compare: "is", expected: "active" }, null, { read: "{{fleet.workers-up}}", compare: "contains", expected: "worker-6" },
    ]);
    assert.equal(walk?.unblocks, "worker-6 is serving on its address again");
  });

  test("the positive control: a brief with no Steps is not a procedure, and the same brief with one is", () => {
    assert.deepEqual(readWalk(BRIEF_HEAD.join("\n")), { walk: null, problem: null });
    assert.notEqual(readWalk(BRIEF).walk, null);
  });

  test("the list ends at the first line that is not part of it, so Unblocks may follow the steps", () => {
    const { steps } = parseSteps(["Steps:", "1. First.", "2. Second,", "   continued here.", "Unblocks: the thing"].join("\n"));
    assert.deepEqual(steps.map((step) => step.text), ["First.", "Second, continued here."]);
  });

  test("one step that cannot be read yields NO steps and a reason, never the steps around it", () => {
    for (const [why, lines, reason] of /** @type {[string, string[], RegExp][]} */ ([
      ["a Verify that is not a check", ["Steps:", "1. First.", "   Verify: it is on"], /is not "\{\{placeholder\} ?\} is\|contains/],
      ["a Verify that is not in the vocabulary", ["Steps:", "1. First.", "   Verify: {{nothing.here}} is on"], /not a placeholder of the checked-facts vocabulary/],
      ["two Verify lines", ["Steps:", "1. First.", "   Verify: {{ready.count}} is 1", "   Verify: {{ready.count}} is 2"], /two Verify lines/],
      ["no step under the header", ["Steps:", "Unblocks: x"], /no step under it/],
    ])) {
      const parsed = parseSteps(lines.join("\n"));
      assert.deepEqual(parsed.steps, [], why);
      assert.match(String(parsed.problem), reason, why);
    }
  });

  test("a procedure and a choice are not both: steps beside an options block, or an unreadable list, send no alert and say why", () => {
    const both = requestEvent({ repo: REPO, row: row(`${BRIEF}\nRecommend: A\nTrade-off: it is slower\n<!-- chairman-options: A=yes; B=no -->`), now: 1 });
    assert.equal(both.event, null);
    assert.match(String(both.problem), /^alert not sent: steps: a brief is a procedure or a choice, not both$/);
    const unreadable = requestEvent({ repo: REPO, row: row([...BRIEF_HEAD, "Steps:", "1. First.", "   Verify: whatever"].join("\n")), now: 1 });
    assert.equal(unreadable.event, null);
    assert.match(String(unreadable.problem), /^alert not sent: steps: /);
  });

  test("the step shown is the ledger's position, and the position is NOT part of the ask's state", () => {
    const first = requestEvent({ repo: REPO, row: row(), now: 1, position: 1 });
    const third = requestEvent({ repo: REPO, row: row(), now: 1, position: 3 });
    assert.match(String(first.event?.text), /\nStep 1 of 3: Press the power button on worker-6\.$/);
    assert.match(String(third.event?.text), /\nStep 3 of 3: Wait for the light to go green\.$/);
    assert.equal(first.event?.state, third.event?.state, "a step advancing is the ask being worked, never an update of it");
    assert.deepEqual(observeRequests({ repo: REPO, rows: [row()], openKeys: [], now: 1 }).walks, { [KEY]: true });
  });
});

describe("(1) a three-step procedure sends step 1 only; Done sends step 2", () => {
  test("the first message is the brief and step 1, under Done / Stuck / Explain more, and nothing of steps 2 and 3", async () => {
    const h = await harness();
    assert.equal(h.sent.length, 1);
    const [first] = h.sent;
    assert.match(first.text, /^What is happening: worker-6 is off/);
    assert.match(first.text, /Step 1 of 3: Press the power button on worker-6\./);
    assert.doesNotMatch(first.text, /blue port|light to go green|Step 2/, "later steps are not sent until the one before is confirmed");
    assert.deepEqual(wordsOf(first.actions), ["done", "stuck", "explain"]);
    assert.deepEqual(first.actions?.map((action) => action.label), ["Done", "Stuck", "Explain more"]);
    assert.equal(first.messageRef, FIRST_REF);
  });

  test("Done reads the step, says what it read with the time, then sends step 2 under the same three buttons", async () => {
    const h = await harness();
    await h.push("done", Number(FIRST_REF), FIRST_UPDATE);
    assert.equal(h.sent.length, 2);
    assert.match(h.last().text, /^That shows, thanks\.\nI read: active\n\nas of \d\d:\d\dZ\n\nStep 2 of 3: Plug the cable into the blue port\.$/);
    assert.deepEqual(wordsOf(h.last().actions), ["done", "stuck", "explain"]);
    assert.deepEqual(h.cleared, [FIRST_REF], "the old step's keyboard is taken off, so a second press cannot happen");
    assert.deepEqual(h.confirmed(), [1]);
    assert.equal(walkPosition(h.lines(), KEY), 2);
    assert.deepEqual(h.github.writes, [], "a step is not the answer: nothing is written to the row until the last one");
    assert.ok(h.walkLines().every((line) => line.walk === `walk:${KEY}` && line.key === undefined), "a walk line is keyed `walk:<request key>` and carries no `key` the core's fold could read");
    assert.deepEqual(h.walkLines().map((line) => [line.event, line.step]), [["confirmed", 1], ["shown", 2]]);
  });
});

describe("(2) verification is a read, and not an echo of Done", () => {
  test("a Done whose read shows something else says it cannot see it and does NOT advance; Done, Stuck and Later are offered", async () => {
    const h = await harness();
    h.facts.unit = "inactive";
    await h.push("done", Number(FIRST_REF), FIRST_UPDATE);
    assert.match(h.last().text, /^I can't see it yet\.\nI read: inactive\n\nas of \d\d:\d\dZ$/);
    assert.deepEqual(wordsOf(h.last().actions), ["done", "stuck", "later"]);
    assert.deepEqual(h.confirmed(), [], "the walk did not move");
    assert.equal(walkPosition(h.lines(), KEY), 1);
    assert.deepEqual(h.walkLines().map((line) => [line.event, line.step]), [["unseen", 1], ["shown", 1]]);
    // THE CONTROL: the same press, the same message, the right value, and the walk moves.
    h.facts.unit = "active";
    await h.push("done", Number(h.last().messageRef), FIRST_UPDATE + 1);
    assert.match(h.last().text, /^That shows, thanks\.\nI read: active\n\nas of \d\d:\d\dZ\n\nStep 2 of 3:/);
    assert.deepEqual(h.confirmed(), [1]);
  });

  test("a read that cannot be made does not advance either, and states nothing about it", async () => {
    const h = await harness();
    h.facts.unit = new Error("systemd did not answer");
    await h.push("done", Number(FIRST_REF), FIRST_UPDATE);
    assert.match(h.last().text, /^I can't see it: I couldn't read it just now\.\nCould not check, so not stated: \[unit:worker-6\.state\]\.\n\nas of \d\d:\d\dZ$/);
    assert.deepEqual(h.confirmed(), []);
    assert.deepEqual(wordsOf(h.last().actions), ["done", "stuck", "later"]);
  });

  test("a read that shows it advances and states the checked fact with its `as of`; `contains` reads a list", async () => {
    const h = await harness();
    await h.push("done", Number(FIRST_REF), FIRST_UPDATE);
    await h.push("done", Number(h.last().messageRef), FIRST_UPDATE + 1);
    h.facts.up = ["worker-2"];
    await h.push("done", Number(h.last().messageRef), FIRST_UPDATE + 2);
    assert.match(h.last().text, /^I can't see it yet\.\nI read: worker-2 \(fleet-watch poll \d+m ago\)\n\nas of /, "worker-6 is not in the list, so the step 3 read does not show it");
    h.facts.up = ["worker-6", "worker-2"];
    await h.push("done", Number(h.last().messageRef), FIRST_UPDATE + 3);
    assert.match(h.last().text, /^That shows, thanks\.\nI read: worker-6, worker-2 \(fleet-watch poll \d+m ago\)\n\nas of /);
  });
});

describe("(3) Stuck orders the liaison once and holds the step", () => {
  test("one order naming the step, a second press is told it already has it, and the walk has not moved", async () => {
    const h = await harness();
    await h.push("stuck", Number(FIRST_REF), FIRST_UPDATE);
    assert.equal(h.orders.length, 1);
    assert.match(h.orders[0], /^the chairman is stuck at step 1 of 3 of a11ign\/a11ign#3601:\n\n> /);
    assert.match(h.orders[0], /Step 1 of 3: Press the power button on worker-6\./);
    assert.match(h.last().text, /^Told the liaison you are stuck at a11ign\/a11ign#3601\.$/);
    await h.push("stuck", Number(FIRST_REF), FIRST_UPDATE + 1);
    assert.equal(h.orders.length, 1, "the second press ordered nothing");
    assert.match(h.last().text, /^The liaison already has that/);
    assert.deepEqual(h.confirmed(), [], "stuck holds the step");
    assert.equal(h.github.writes.length, 0);
  });

  test("once per STEP, not per message: a step re-sent after a read that did not show it is not ordered a second time", async () => {
    const h = await harness();
    h.facts.unit = "inactive";
    await h.push("done", Number(FIRST_REF), FIRST_UPDATE);
    const resent = Number(h.last().messageRef);
    await h.push("stuck", Number(FIRST_REF), FIRST_UPDATE + 1);
    await h.push("stuck", resent, FIRST_UPDATE + 2);
    assert.equal(h.orders.length, 1);
  });

  test("the positive control: Stuck on the NEXT step is a new order, and it names that step", async () => {
    const h = await harness();
    await h.push("stuck", Number(FIRST_REF), FIRST_UPDATE);
    await h.push("done", Number(FIRST_REF), FIRST_UPDATE + 1);
    await h.push("stuck", Number(h.last().messageRef), FIRST_UPDATE + 2);
    assert.equal(h.orders.length, 2);
    assert.match(h.orders[1], /stuck at step 2 of 3 /);
    assert.match(h.orders[1], /Plug the cable into the blue port\./);
  });
});

describe("(4) the last verified step answers the row and sends the Unblocks line", () => {
  test("the three writes in the answers path's order, then the closing message; the label is NOT removed before", async () => {
    const h = await harness();
    await h.push("done", Number(FIRST_REF), FIRST_UPDATE);
    await h.push("done", Number(h.last().messageRef), FIRST_UPDATE + 1);
    assert.ok(h.github.labels.includes(NEEDS_CHAIRMAN), "two steps confirmed and the row is still asking");
    await h.push("done", Number(h.last().messageRef), FIRST_UPDATE + 2);
    assert.deepEqual(h.github.writes, ["comment", "remove-label", "set-answer"]);
    assert.ok(!h.github.labels.includes(NEEDS_CHAIRMAN));
    assert.ok(h.github.labels.includes("answer:ceo"));
    assert.match(h.last().text, /^That shows, thanks\.\nI read: worker-6, worker-2 .*\n\nThat was the last step\. This unblocks: worker-6 is serving on its address again\nRecorded on the row: ceo has it\.$/s);
    assert.equal(h.last().actions, undefined, "the closing message asks nothing");
    assert.deepEqual(h.confirmed(), [1, 2, 3]);
  });

  test("a failed label write leaves the walk on its last step, and the next Done finishes it without writing twice", async () => {
    const h = await harness();
    await h.push("done", Number(FIRST_REF), FIRST_UPDATE);
    await h.push("done", Number(h.last().messageRef), FIRST_UPDATE + 1);
    const lastStep = Number(h.last().messageRef);
    h.github.failOnce.add("remove-label");
    await h.push("done", lastStep, FIRST_UPDATE + 2);
    assert.match(h.last().text, /Could not finish writing to a11ign\/a11ign#3601 \(at remove-label\)\. Press Done again to retry/);
    assert.deepEqual(h.confirmed(), [1, 2], "the last step is confirmed only once the row is answered");
    await h.push("done", lastStep, FIRST_UPDATE + 3);
    assert.deepEqual(h.github.writes, ["comment", "remove-label", "set-answer"], "the comment was not written a second time");
    assert.deepEqual(h.confirmed(), [1, 2, 3]);
  });
});

describe("(5) the ledger is the state: a restart resumes, and a double Done writes once", () => {
  test("a new process over the same ledger carries on from the step the ledger holds", async () => {
    const h = await harness();
    await h.push("done", Number(FIRST_REF), FIRST_UPDATE);
    const step2 = Number(h.last().messageRef);
    h.restart();
    await h.push("done", step2, FIRST_UPDATE + 1);
    assert.match(h.last().text, /^Thanks\. I can't check that one from here, so I'm taking your word for it\.\n\nStep 3 of 3:/);
    assert.deepEqual(h.confirmed(), [1, 2]);
    assert.equal(walkPosition(h.lines(), KEY), 3);
  });

  test("a double Done, in sequence, at once, and across a restart, writes ONE confirmed line", async () => {
    const h = await harness();
    await h.push("done", Number(FIRST_REF), FIRST_UPDATE);
    await h.push("done", Number(FIRST_REF), FIRST_UPDATE + 1);
    assert.match(h.last().text, /^That step was already confirmed\. Nothing was written again\.$/);
    h.restart();
    await h.push("done", Number(FIRST_REF), FIRST_UPDATE + 2);
    await Promise.all([h.push("done", Number(FIRST_REF), FIRST_UPDATE + 3), h.push("done", Number(FIRST_REF), FIRST_UPDATE + 4)]);
    assert.deepEqual(h.confirmed(), [1], "one line however many presses");
    assert.equal(h.sent.filter((message) => message.text.includes("Step 2 of 3")).length, 1, "step 2 was sent once; every other press was told it was already confirmed");
    assert.equal(h.sent.filter((message) => message.text.startsWith("That step was already confirmed")).length, 4);
  });

  test("a send that failed after the step was confirmed is made again by the next Done on the old message", async () => {
    const h = await harness();
    h.failSendOnce();
    await assert.rejects(() => h.push("done", Number(FIRST_REF), FIRST_UPDATE), /telegram is down/);
    assert.deepEqual(h.confirmed(), [1]);
    assert.equal(h.sent.length, 1, "step 2 never reached the chairman");
    await h.push("done", Number(FIRST_REF), FIRST_UPDATE + 1);
    assert.match(h.last().text, /^That step was already confirmed\. Nothing was written again\.\n\nStep 2 of 3: Plug the cable into the blue port\.$/);
    assert.deepEqual(wordsOf(h.last().actions), ["done", "stuck", "explain"]);
    assert.deepEqual(h.confirmed(), [1], "the walk was not confirmed twice");
    await h.push("done", Number(h.last().messageRef), FIRST_UPDATE + 2);
    assert.deepEqual(h.confirmed(), [1, 2], "the re-sent message is a step message like any other");
  });
});

describe("(6) a step with no Verify says it cannot check", () => {
  test("it is confirmed on Done alone, and says so; the line records that no read decided it", async () => {
    const h = await harness();
    await h.push("done", Number(FIRST_REF), FIRST_UPDATE);
    await h.push("done", Number(h.last().messageRef), FIRST_UPDATE + 1);
    assert.match(h.last().text, /I can't check that one from here/);
    assert.doesNotMatch(h.last().text, /as of|I read:/, "no fact is stated for a step nothing read");
    const [confirmedTwo] = h.walkLines().filter((line) => line.event === "confirmed" && line.step === 2);
    assert.equal(confirmedTwo.verified, false);
    assert.equal(h.walkLines().find((line) => line.event === "confirmed" && line.step === 1)?.verified, true);
  });
});

describe("what a walk is not", () => {
  test("a typed reply under a step is conversation for the liaison and never the answer", async () => {
    const h = await harness();
    await h.say(10, "it is on now", Number(FIRST_REF));
    assert.deepEqual(h.conversation, ["it is on now"]);
    assert.deepEqual(h.github.writes, []);
    assert.ok(h.github.labels.includes(NEEDS_CHAIRMAN));
    assert.deepEqual(h.confirmed(), []);
  });

  test("a listener with no readers refuses a procedure, and writes nothing: Done is never taken unread", async () => {
    const h = await harness({ readers: null });
    await h.push("done", Number(FIRST_REF), FIRST_UPDATE);
    assert.match(h.last().text, /^I cannot read a step back from here, so I cannot walk you through this\. Nothing was written\.$/);
    assert.deepEqual(h.github.writes, []);
    assert.deepEqual(h.walkLines(), []);
  });

  test("a button that is not part of a walk writes nothing", async () => {
    const h = await harness();
    await h.push("approve", Number(FIRST_REF), FIRST_UPDATE);
    assert.match(h.last().text, /^That is not one of the buttons of this walk-through\. Nothing was written\.$/);
    assert.deepEqual(h.github.writes, []);
  });

  test("a brief with no Steps is answered as it always was: Done resolves it, and the positive control for every refusal above", async () => {
    const h = await harness({ body: BRIEF_HEAD.join("\n") });
    await h.push("done", Number(FIRST_REF), FIRST_UPDATE);
    assert.deepEqual(h.github.writes, ["comment", "remove-label", "set-answer"]);
    assert.deepEqual(h.walkLines(), []);
  });
});
