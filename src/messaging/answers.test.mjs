// no-token: prepareContext -- the orders port and the GitHub writer are injected fixtures and nothing here calls it; `answers.mjs` only carries it in through the `converse.mjs` import (#3581)
// @ts-check
// ANSWERS ON THE ROW (a11ign/a11ign#2908 done-whens 1 to 5), over a real ledger file, the real `createInbound` (so every accepted value is
// minted, never built) and a fixture GitHub writer that records each call. Nothing here reaches a network.
//
// POSITIVE CONTROL: "writes nothing" is also what a writer that does nothing reports, so the first test shows the fixture recording the
// three writes, in order, for a real press. Every "nothing written" below is then the same row with ONE thing changed.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { ACTION_LABELS, answerComment, buttonData, createAnswers, requestActions, SNOOZE_MS, snoozedUntil, STEPS } from "./answers.mjs";
import { actionData, createInbound, parseButtonData } from "./inbound.mjs";
import { createLedger, deliveryLine, foldLedger, readLedgerLines, STATUS } from "./ledger.mjs";
import { FORME_STEP, verifyApproval } from "./session-queue.mjs";
import { NEEDS_CHAIRMAN, parseChairmanOptions } from "./sources/requests.mjs";

const CHAIRMAN = Object.freeze({ userId: 4242, chatId: 4242 });
/** The label the done-when names. In production the wiring builds it from the vocabulary's answer prefix; here it is spelled out so the order is pinned against the literal. */
const ANSWER_LABEL = "answer:ceo";
const REPO = "a11ign/a11ign";
const ROW = 2885;
const KEY = `request:${REPO}#${ROW}`;
const ASK_REF = "501";
const REMINDER_REF = "502";
const BRIEF = "**Brief for the chairman**\nShall we publish?\n<!-- chairman-options: A=publish now; B=hold -->";

const scratch = mkdtempSync(join(tmpdir(), "messaging-answers-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextLedger = 0;

/** @param {number} id @param {Record<string, any>} [more] a press under bot message `more.message_id` (default: the ask) */
function press(id, { data = buttonData("A"), messageId = Number(ASK_REF), ...more } = {}) {
  const message = { message_id: messageId, chat: { id: CHAIRMAN.chatId, type: "private" } };
  return { update_id: id, callback_query: { id: `cbq-${id}`, from: { id: CHAIRMAN.userId }, data, message, ...more } };
}

/** @param {number} id @param {string} text @param {Record<string, any>} [more] a reply from the chairman to bot message `more.replyTo` (default: the ask) */
function reply(id, text, { replyTo = Number(ASK_REF), ...more } = {}) {
  const base = { message_id: 900 + id, from: { id: CHAIRMAN.userId }, chat: { id: CHAIRMAN.chatId, type: "private" }, text };
  return { update_id: id, message: { ...base, reply_to_message: { message_id: replyTo }, ...more } };
}

/** @param {Record<string, any>} [more] */
function openRow(more = {}) {
  return { state: "OPEN", labels: ["ready", NEEDS_CHAIRMAN], comments: [{ body: BRIEF, createdAt: "2026-10-02T09:00:00Z", authorAssociation: "OWNER" }], ...more };
}

/** The fixture writer: records every call and applies it to `rows`. `failOnce` names a step that throws on its next call. */
function fixtureGithub(initial = openRow()) {
  /** @type {{op: string, arg?: string}[]} */
  const calls = [];
  /** @type {Set<string>} */
  const failOnce = new Set();
  const rows = new Map([[`${REPO}#${ROW}`, initial]]);
  const rowOf = (/** @type {{repo: string, number: number}} */ ref) => /** @type {any} */ (rows.get(`${ref.repo}#${ref.number}`));
  const attempt = (/** @type {string} */ op) => {
    calls.push({ op });
    if (failOnce.delete(op)) throw new Error(`${op} failed (503)`);
  };
  return {
    calls, failOnce, rows,
    writes: () => calls.filter((call) => call.op !== "readRow").map((call) => call.op),
    async readRow(/** @type {any} */ ref) { calls.push({ op: "readRow" }); return structuredClone(rowOf(ref)); },
    async comment(/** @type {any} */ ref, /** @type {string} */ body) { attempt("comment"); /** @type {{op: string, arg?: string}} */ (calls.at(-1)).arg = body; rowOf(ref).comments.push({ body, createdAt: "2026-10-02T10:00:00Z" }); },
    async removeLabel(/** @type {any} */ ref, /** @type {string} */ label) { attempt("remove-label"); rowOf(ref).labels = rowOf(ref).labels.filter((/** @type {string} */ l) => l !== label); },
    async addLabel(/** @type {any} */ ref, /** @type {string} */ label) { attempt("set-answer"); rowOf(ref).labels.push(label); },
  };
}

/** A ledger already holding the ask (sent as message 501) and a reminder (502), an inbound and an answers over it. `restart()` is a NEW process, same file. */
function harness(initial = openRow(), { orders } = /** @type {{orders?: any}} */ ({})) {
  const path = join(scratch, `ledger-${nextLedger += 1}.jsonl`);
  let at = Date.parse("2026-10-02T10:00:00Z");
  const now = () => at += 1000;
  const github = fixtureGithub(initial);
  const ledger = () => createLedger({ path, now });
  const seed = ledger();
  for (const [ref, kind] of [[ASK_REF, "request"], [REMINDER_REF, "reminder"]]) {
    seed.append(deliveryLine({ key: KEY, provider: "fake", status: STATUS.sent, providerMessageId: ref, kind, stateHash: "h", text: `row ${ROW} needs you\nhttps://github.com/${REPO}/issues/${ROW}` }));
  }
  const build = () => ({ ledger: ledger(), github, chairman: CHAIRMAN, answerLabel: ANSWER_LABEL, now, orders });
  let inbound = createInbound({ ledger: ledger(), chairman: CHAIRMAN });
  let answers = createAnswers(build());
  return {
    github, path, lines: () => readLedgerLines(path), raw: () => readFileSync(path, "utf8"),
    /** The listener's path: `handle` mints, then `answer` writes. @param {unknown} update */
    async hear(update) {
      const handled = inbound.handle(update);
      assert.equal(handled.action, "forward", `the update was not forwarded: ${JSON.stringify(handled)}`);
      return answers.answer(handled.accepted);
    },
    /** @param {unknown} update @returns {any} what the core said to do with it, whatever it was */
    handled(update) {
      return inbound.handle(update);
    },
    /** @param {unknown} update */
    minted(update) {
      const handled = inbound.handle(update);
      assert.equal(handled.action, "forward");
      return handled.accepted;
    },
    answers: () => answers,
    restart() { inbound = createInbound({ ledger: ledger(), chairman: CHAIRMAN }); answers = createAnswers(build()); },
  };
}

/** @param {Record<string, any>[]} lines @returns {string[]} the steps recorded as done, in order */
function stepsDone(lines) {
  return lines.filter((line) => line.direction === "answer" && STEPS.includes(line.step)).map((line) => line.step);
}

describe("a button press (done-whens 1 and 4)", () => {
  test("writes ONE provenance comment, removes needs:chairman, sets answer:ceo, in that order: the positive control", async () => {
    const h = harness();
    const result = await h.hear(press(1));
    assert.deepEqual(h.github.writes(), ["comment", "remove-label", "set-answer"]);
    assert.deepEqual(STEPS, ["comment", "remove-label", "set-answer"], "the order is pinned in the module as well as observed");
    const row = /** @type {any} */ (h.github.rows.get(`${REPO}#${ROW}`));
    assert.ok(!row.labels.includes(NEEDS_CHAIRMAN));
    assert.ok(row.labels.includes(ANSWER_LABEL));
    const [comment] = row.comments.slice(1);
    assert.match(comment.body, /^Chairman answered via Telegram, verified id, message 501, 2026-10-02T10:0\d:\d\d\.000Z: A \(publish now\)$/);
    assert.equal(result.action, "reply");
    assert.equal(/** @type {any} */ (result).reason, "answered");
    assert.equal(/** @type {any} */ (result).callbackQueryId, "cbq-1", "a press is acknowledged on the query that made it");
  });

  test("the comment is written BEFORE either label: a failed comment leaves the row still asking", async () => {
    const h = harness();
    h.github.failOnce.add("comment");
    const result = await h.hear(press(1));
    assert.equal(/** @type {any} */ (result).reason, "write-failed");
    assert.deepEqual(h.github.writes(), ["comment"], "nothing was written after the failed comment");
    const row = /** @type {any} */ (h.github.rows.get(`${REPO}#${ROW}`));
    assert.ok(row.labels.includes(NEEDS_CHAIRMAN));
    assert.ok(!row.labels.includes(ANSWER_LABEL));
    assert.deepEqual(stepsDone(h.lines()), []);
  });

  test("the same press twice writes once: in sequence, at the same time, and across a restart", async () => {
    const h = harness();
    await h.hear(press(1));
    const second = await h.hear(press(2));
    assert.equal(/** @type {any} */ (second).reason, "already-answered");
    h.restart();
    const third = await h.hear(press(3));
    assert.equal(/** @type {any} */ (third).reason, "already-answered");
    assert.deepEqual(h.github.writes(), ["comment", "remove-label", "set-answer"], "ONE comment and one of each label write across three presses");

    const concurrent = harness();
    const [a, b] = [concurrent.minted(press(1)), concurrent.minted(press(2))];
    const results = await Promise.all([concurrent.answers().answer(a), concurrent.answers().answer(b)]);
    assert.deepEqual(results.map((result) => /** @type {any} */ (result).reason).sort(), ["already-answered", "answered"]);
    assert.deepEqual(concurrent.github.writes(), ["comment", "remove-label", "set-answer"]);
  });

  test("a failure between the steps is RESUMED by the next press, without a second comment", async () => {
    const h = harness();
    h.github.failOnce.add("set-answer");
    const failed = await h.hear(press(1));
    assert.equal(/** @type {any} */ (failed).reason, "write-failed");
    const row = /** @type {any} */ (h.github.rows.get(`${REPO}#${ROW}`));
    assert.ok(!row.labels.includes(NEEDS_CHAIRMAN) && !row.labels.includes(ANSWER_LABEL), "the stranded state: neither label");
    h.restart();
    const resumed = await h.hear(press(2));
    assert.equal(/** @type {any} */ (resumed).reason, "answered");
    assert.deepEqual(h.github.writes(), ["comment", "remove-label", "set-answer", "set-answer"], "only the missing step was repeated");
    assert.ok(row.labels.includes(ANSWER_LABEL));
    assert.equal(row.comments.length, 2, "the brief and ONE answer");
    assert.match(String(h.lines().find((line) => line.step === "failed")?.error), /set-answer failed/);
  });

  test("an option the brief does not offer writes nothing; data that is not ours never gets this far (inbound.mjs drops it)", async () => {
    const h = harness();
    const result = await h.hear(press(1, { data: buttonData("Z") }));
    assert.equal(/** @type {any} */ (result).reason, "option-not-offered");
    for (const [id, data] of [[2, "approve:2885"], [3, buttonData("")]]) {
      assert.equal(h.handled(press(/** @type {number} */ (id), { data: /** @type {string} */ (data) })).action, "ignore", String(data));
    }
    assert.deepEqual(h.github.writes(), []);
  });

  test("a press under a message that is not a request writes nothing and says so", async () => {
    const h = harness();
    const result = await h.hear(press(1, { messageId: 777 }));
    assert.equal(/** @type {any} */ (result).reason, "unknown-message");
    assert.deepEqual(h.github.calls, []);
  });

  test("a press on the OLD message after the row was re-asked is already answered, not an answer to the new ask", async () => {
    const h = harness();
    await h.hear(press(1));
    const row = /** @type {any} */ (h.github.rows.get(`${REPO}#${ROW}`));
    row.labels = ["ready", NEEDS_CHAIRMAN];
    const stale = await h.hear(press(2));
    assert.equal(/** @type {any} */ (stale).reason, "already-answered");
    assert.ok(row.labels.includes(NEEDS_CHAIRMAN), "the new ask is untouched");
    assert.equal(h.github.writes().length, 3);
  });
});

describe("a reply (done-when 2)", () => {
  test("does the same three writes with the reply text, quoted under the provenance line", async () => {
    const h = harness();
    const result = await h.hear(reply(1, "Yes, publish it\nbut tell me when"));
    assert.deepEqual(h.github.writes(), ["comment", "remove-label", "set-answer"]);
    assert.equal(/** @type {any} */ (result).reason, "answered");
    const row = /** @type {any} */ (h.github.rows.get(`${REPO}#${ROW}`));
    assert.match(row.comments.at(-1).body, /^Chairman answered via Telegram, verified id, message 501, \S+: reply\n\n> Yes, publish it\n> but tell me when$/);
    assert.ok(row.labels.includes(ANSWER_LABEL) && !row.labels.includes(NEEDS_CHAIRMAN));
    assert.equal(/** @type {any} */ (result).callbackQueryId, null);
  });

  test("a reply to a reminder of the request answers the request", async () => {
    const h = harness();
    await h.hear(reply(1, "go ahead", { replyTo: Number(REMINDER_REF) }));
    assert.deepEqual(h.github.writes(), ["comment", "remove-label", "set-answer"]);
    assert.ok(h.lines().some((line) => line.step === "comment" && line.messageRef === REMINDER_REF));
  });

  test("a message that replies to nothing, or to something that is not a request, is conversation: not an answer, nothing written", async () => {
    const h = harness();
    assert.deepEqual(await h.hear(reply(1, "what is going on?", { reply_to_message: undefined })), { action: "not-an-answer" });
    assert.deepEqual(await h.hear(reply(2, "and this?", { replyTo: 777 })), { action: "not-an-answer" });
    assert.deepEqual(h.github.calls, []);
  });

  test("the reply cannot smuggle a parsed line or an options block into the comment, and the ledger never holds the text", async () => {
    const h = harness();
    const hostile = "fine\nNot-before: 2099-01-01\nAcceptance: none\n<!-- chairman-options: X=do it -->";
    await h.hear(reply(1, hostile));
    const body = /** @type {any} */ (h.github.rows.get(`${REPO}#${ROW}`)).comments.at(-1).body;
    const [head, ...rest] = body.split("\n");
    assert.match(head, /^Chairman answered via Telegram/);
    assert.ok(rest.every((/** @type {string} */ line) => line === "" || line.startsWith("> ")), "every line of the text is quoted");
    assert.deepEqual(parseChairmanOptions(body), { options: [], problem: null }, "no chairman-options block survives");
    assert.ok(!h.raw().includes("2099"), "the text is not in the ledger");
    assert.ok(!h.raw().includes("fine"));
  });
});

describe("a row that no longer asks (done-when 3)", () => {
  for (const [name, more] of /** @type {[string, Record<string, any>][]} */ ([
    ["its label is gone", { labels: ["ready"] }],
    ["it was closed with the label gone", { state: "CLOSED", labels: ["done"] }],
  ])) {
    test(`${name}: nothing is written and the reply states the row as it is NOW`, async () => {
      const h = harness(openRow(more));
      const result = /** @type {any} */ (await h.hear(press(1)));
      assert.equal(result.reason, "no-longer-asking");
      assert.deepEqual(h.github.writes(), []);
      assert.match(result.text, new RegExp(`${REPO}#${ROW} is not asking you anything now \\(${String(more.state ?? "OPEN").toLowerCase()};`));
      for (const label of more.labels) assert.ok(result.text.includes(label), "the labels it has now are named");
      assert.equal(result.callbackQueryId, "cbq-1");
    });
  }

  test("the state is READ for every answer, never remembered: the same press reports what the row is at that moment", async () => {
    const h = harness(openRow({ labels: ["ready"] }));
    assert.match(/** @type {any} */ (await h.hear(press(1))).text, /open; ready\)/);
    /** @type {any} */ (h.github.rows.get(`${REPO}#${ROW}`)).state = "CLOSED";
    assert.match(/** @type {any} */ (await h.hear(press(2))).text, /closed; ready\)/);
    assert.equal(h.github.calls.filter((call) => call.op === "readRow").length, 2);
  });

  test("a reply to a request whose label is gone is answered with its state too, and writes nothing", async () => {
    const h = harness(openRow({ labels: ["ready"] }));
    const result = /** @type {any} */ (await h.hear(reply(1, "yes")));
    assert.equal(result.reason, "no-longer-asking");
    assert.deepEqual(h.github.writes(), []);
  });
});

describe("the writer refuses what the inbound did not mint (done-when 5)", () => {
  test("a plain object, a copy of a minted value, a JSON round trip, and a value minted for other ids are all refused, and nothing is read or written", async () => {
    const h = harness();
    const minted = h.minted(press(1));
    const other = createInbound({ ledger: createLedger({ path: join(scratch, "other.jsonl"), now: Date.now }), chairman: { userId: 1, chatId: 1 } });
    const foreign = /** @type {any} */ (other.handle({ update_id: 1, callback_query: { id: "c", from: { id: 1 }, data: buttonData("A"), message: { message_id: 501, chat: { id: 1, type: "private" } } } }));
    assert.equal(foreign.action, "forward");
    const unbranded = [
      { kind: "button", data: buttonData("A"), messageId: 501, chatId: CHAIRMAN.chatId, callbackQueryId: "x" },
      { ...minted },
      JSON.parse(JSON.stringify(minted)),
      foreign.accepted,
      null,
      "ans:A",
    ];
    for (const value of unbranded) {
      assert.throws(() => h.answers().answer(value), TypeError, JSON.stringify(value));
    }
    assert.deepEqual(h.github.calls, []);
    // The positive control: the minted value itself is accepted by the same writer.
    assert.equal(/** @type {any} */ (await h.answers().answer(minted)).reason, "answered");
  });

  test("a writer built without both of the chairman's ids is refused at construction", () => {
    const github = fixtureGithub();
    for (const chairman of [{ userId: 1 }, { chatId: 1 }, null, { userId: "1", chatId: 1 }]) {
      assert.throws(() => createAnswers({ ledger: createLedger({ path: join(scratch, "x.jsonl"), now: Date.now }), github, chairman: /** @type {any} */ (chairman), answerLabel: ANSWER_LABEL, now: Date.now }), TypeError);
    }
  });

  test("a writer built without a label to set is refused at construction, so it cannot answer without waking ceo", () => {
    const github = fixtureGithub();
    for (const answerLabel of [undefined, "", null, 7]) {
      assert.throws(() => createAnswers({ ledger: createLedger({ path: join(scratch, "x.jsonl"), now: Date.now }), github, chairman: CHAIRMAN, answerLabel: /** @type {any} */ (answerLabel), now: Date.now }), TypeError);
    }
  });
});

describe("what the ledger keeps", () => {
  test("answer lines do not disturb the core's fold: no `key`, so the request's notification state is unchanged", async () => {
    const h = harness();
    const before = foldLedger(h.lines()).get(KEY);
    await h.hear(press(1));
    assert.deepEqual(foldLedger(h.lines()).get(KEY), before);
    assert.deepEqual(stepsDone(h.lines()), STEPS.slice());
  });

  test("the provenance line is the one the design names", () => {
    assert.equal(answerComment({ ref: "9", at: "2026-10-02T10:00:00.000Z", option: { id: "B", label: "hold" }, text: null }),
      "Chairman answered via Telegram, verified id, message 9, 2026-10-02T10:00:00.000Z: B (hold)");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// THE BUTTONS' MEANINGS (a11ign/a11ign#3423 done-whens 4 to 6). Each is the harness above with ONE press changed, so "writes nothing" is read against the
// positive control at the top of this file (a real press does write three things).

/** An orders port that records each order and answers as `outcome` says. @param {{queued: boolean, say: string, handoff: string | null, taker?: string | null, told?: string | null}} [outcome] */
function fixtureOrders(outcome = { queued: true, say: "queued for liaison, handoff h1", handoff: "h1" }) {
  /** @type {{text: string, messageRef: string}[]} */
  const calls = [];
  return { calls, outcome, liaison: async (/** @type {{text: string, messageRef: string}} */ order) => { calls.push(order); return outcome; } };
}

describe("approve and done are answers in their own words (done-when 4's counterpart: they RESOLVE)", () => {
  for (const [name, label] of [["approve", "Approve"], ["done", "Done"]]) {
    test(`${name} writes the three steps with the comment naming it, and takes the keyboard off`, async () => {
      const h = harness(openRow({ comments: [{ body: "**Brief for the chairman**\nShall we?", createdAt: "2026-10-02T09:00:00Z", authorAssociation: "OWNER" }] }));
      const result = /** @type {any} */ (await h.hear(press(1, { data: actionData(name) })));
      assert.deepEqual(h.github.writes(), ["comment", "remove-label", "set-answer"]);
      assert.match(/** @type {any} */ (h.github.rows.get(`${REPO}#${ROW}`)).comments[1].body, new RegExp(`: ${name} \\(${label}\\)$`));
      assert.equal(result.reason, "answered");
      assert.equal(result.clearKeyboard, ASK_REF);
    });
  }
});

describe("later snoozes for 24 hours and is not an answer (done-when 4)", () => {
  test("it writes one snooze line, touches no label and no comment, and leaves the keyboard", async () => {
    const h = harness();
    const result = /** @type {any} */ (await h.hear(press(1, { data: actionData("later") })));
    assert.equal(result.reason, "snoozed");
    assert.equal(result.clearKeyboard, null, "the request still needs an answer, so its buttons stay");
    assert.deepEqual(h.github.writes(), [], "no label and no comment");
    const row = /** @type {any} */ (h.github.rows.get(`${REPO}#${ROW}`));
    assert.ok(row.labels.includes(NEEDS_CHAIRMAN), "the label stays");
    const [line, ...others] = h.lines().filter((entry) => entry.step === "snooze");
    assert.equal(others.length, 0);
    assert.equal(line.request, KEY);
    // The fixture clock ticks a second on every read, and `until` is taken one read before the line is stamped.
    assert.ok(Math.abs(Date.parse(line.until) - Date.parse(line.ts) - SNOOZE_MS) <= 5000, "24 hours from the press");
    assert.equal(stepsDone(h.lines()).length, 0, "and it is not one of the answer's steps");
    assert.equal(snoozedUntil(h.lines(), KEY, Date.parse(line.ts) + 1000), Date.parse(line.until));
    assert.equal(snoozedUntil(h.lines(), KEY, Date.parse(line.until) + 1), null, "and it ends");
  });

  test("a second press while snoozed writes nothing more", async () => {
    const h = harness();
    await h.hear(press(1, { data: actionData("later") }));
    const again = /** @type {any} */ (await h.hear(press(2, { data: actionData("later") })));
    assert.equal(again.reason, "already-snoozed");
    assert.equal(h.lines().filter((entry) => entry.step === "snooze").length, 1);
  });

  test("an answer, or a cleared notice, ends the snooze: a re-ask is a new ask (and the control: without either it holds)", async () => {
    const h = harness();
    await h.hear(press(1, { data: actionData("later") }));
    const at = Date.now();
    assert.ok(snoozedUntil(h.lines(), KEY, Date.parse(h.lines().at(-1)?.ts)) !== null, "control: the snooze holds");
    const answered = [...h.lines(), { direction: "answer", request: KEY, step: "set-answer", messageRef: ASK_REF }];
    assert.equal(snoozedUntil(answered, KEY, at), null);
    const cleared = [...h.lines(), { key: KEY, kind: "cleared", status: STATUS.sent }];
    assert.equal(snoozedUntil(cleared, KEY, at), null);
    assert.equal(snoozedUntil(h.lines(), `request:${REPO}#1`, at), null, "another request's snooze is not this one's");
  });
});

/** What the chairman must never read: the queue's vocabulary, a handoff, a path, an error class. */
const INTERNAL = /NOT PROMPTED|NOT QUEUED|queue|handoff|\.mjs|[/\\]|Error/i;

describe("explain and stuck queue ONE order for the liaison and nobody else (done-when 5)", () => {
  for (const [name, lead] of [["explain", "the chairman asked for more on a11ign/a11ign#2885"], ["stuck", "the chairman is stuck at a11ign/a11ign#2885"]]) {
    test(`${name}: one order, naming the ask as it was sent, and no write to the row`, async () => {
      const orders = fixtureOrders();
      const h = harness(openRow(), { orders });
      const result = /** @type {any} */ (await h.hear(press(1, { data: actionData(name) })));
      assert.equal(result.reason, "asked");
      assert.equal(orders.calls.length, 1);
      assert.ok(orders.calls[0].text.startsWith(lead), orders.calls[0].text);
      assert.ok(orders.calls[0].text.includes("> row 2885 needs you"), "the ask, quoted, as the ledger holds it");
      assert.deepEqual(h.github.writes(), []);
      assert.equal(result.clearKeyboard, null);
      assert.equal(h.lines().filter((entry) => entry.step === name && entry.handoff === "h1").length, 1);
    });
  }

  test("the same press again sends nothing more; a refused order is recorded and the next press retries", async () => {
    const orders = fixtureOrders();
    const h = harness(openRow(), { orders });
    await h.hear(press(1, { data: actionData("explain") }));
    const again = /** @type {any} */ (await h.hear(press(2, { data: actionData("explain") })));
    assert.equal(again.reason, "already-asked");
    assert.equal(orders.calls.length, 1);

    const refusing = fixtureOrders({ queued: false, say: "not delivered: NOT PROMPTED, AND NOT QUEUED: no session named liaison", handoff: null });
    const g = harness(openRow(), { orders: refusing });
    const refused = /** @type {any} */ (await g.hear(press(1, { data: actionData("stuck") })));
    assert.equal(refused.reason, "order-refused");
    assert.equal(refused.text, "I couldn't pass that to the liaison or to ceo, so nothing was sent. Press again to retry.");
    assert.ok(!INTERNAL.test(refused.text), "the chairman reads none of the queue's words");
    const failed = g.lines().find((entry) => entry.step === "failed");
    assert.equal(failed?.failedStep, "stuck");
    assert.match(failed?.error, /NOT PROMPTED, AND NOT QUEUED/, "the queue's words are kept in the ledger");
    refusing.outcome = { queued: true, say: "ok", handoff: "h2" };
    Object.assign(refusing, { liaison: async (/** @type {any} */ order) => { refusing.calls.push(order); return { queued: true, say: "ok", handoff: "h2" }; } });
    assert.equal(/** @type {any} */ (await g.hear(press(2, { data: actionData("stuck") }))).reason, "asked");
  });

  test("a port that throws is a refusal the chairman is told, not a crash; with no port at all nothing is sent", async () => {
    const throwing = { liaison: async () => { throw new Error("the queue could not load"); } };
    const h = harness(openRow(), { orders: throwing });
    const thrown = /** @type {any} */ (await h.hear(press(1, { data: actionData("explain") })));
    assert.equal(thrown.reason, "order-refused");
    assert.ok(!INTERNAL.test(thrown.text) && !/could not load|Error/.test(thrown.text), "no describeError text reaches the chairman");
    assert.match(String(h.lines().find((entry) => entry.step === "failed")?.error), /the queue could not load/, "it is in the ledger");
    const none = /** @type {any} */ (await harness().hear(press(1, { data: actionData("explain") })));
    assert.equal(none.reason, "no-liaison");
  });

  test("done-when 3 (#3538): an order the liaison's queue refused and ceo's took is told in plain words, recorded once with its taker, and a second press sends nothing", async () => {
    const told = "The liaison isn't running; I've passed this to ceo.";
    const orders = fixtureOrders({ queued: true, say: "queued for ceo, handoff h9", handoff: "h9", taker: "ceo", told });
    const h = harness(openRow(), { orders });
    const result = /** @type {any} */ (await h.hear(press(1, { data: actionData("explain") })));
    assert.equal(result.reason, "asked-fallback");
    assert.equal(result.text, told);
    assert.ok(!INTERNAL.test(result.text));
    assert.deepEqual(h.lines().filter((entry) => entry.step === "explain").map((entry) => [entry.handoff, entry.taker]), [["h9", "ceo"]]);
    assert.equal(/** @type {any} */ (await h.hear(press(2, { data: actionData("explain") }))).reason, "already-asked");
    assert.equal(orders.calls.length, 1);
  });

  test("forme (#3581): a press writes ONE line chairman:queue accepts as his OK, leaves the row asking, and tells him in plain words", async () => {
    const orders = fixtureOrders();
    const h = harness(openRow(), { orders });
    const before = h.lines().length;
    const result = /** @type {any} */ (await h.hear(press(1, { data: actionData("forme") })));
    assert.equal(result.reason, "queued-for-session");
    assert.equal(result.text, "I've asked your session to do this. Nothing happens until it reads the queue.");
    assert.ok(!/chairman:queue|\.mjs|#\d|\bq-/.test(result.text), "it names the queue as a place, and says nothing of what it holds");
    assert.equal(result.clearKeyboard, null, "the request is still asking, so its keyboard stays");
    const written = h.lines().slice(before).filter((entry) => entry.direction === "answer");
    assert.deepEqual(written.map(({ direction, step, via, messageRef }) => ({ direction, step, via, messageRef })),
      [{ direction: "answer", step: FORME_STEP, via: "button", messageRef: ASK_REF }]);
    assert.equal("key" in written[0], false, "no `key`, so the delivery fold never mistakes it for a notification");
    assert.deepEqual(h.github.writes(), [], "a press is not an answer: no comment, and the label is untouched");
    assert.deepEqual(h.github.rows.get(`${REPO}#${ROW}`)?.labels, ["ready", NEEDS_CHAIRMAN]);
    assert.equal(orders.calls.length, 0, "the ask is the liaison's `chairman:queue add`, not this press");
  });

  test("forme (#3581): the two files agree on the shape: verifyApproval accepts the ref the press wrote, and only that ref", async () => {
    const h = harness();
    assert.equal(verifyApproval(h.lines(), { ref: ASK_REF, words: null }).ok, false, "before the press there is no OK");
    await h.hear(press(1, { data: actionData("forme") }));
    assert.deepEqual(verifyApproval(h.lines(), { ref: ASK_REF, words: null }), { ok: true });
    assert.equal(verifyApproval(h.lines(), { ref: REMINDER_REF, words: null }).ok, false, "a press is the OK for the message it sat under, not for its sibling");
  });

  test("forme (#3581): the same press twice writes one line and says so, across a restart too", async () => {
    const h = harness();
    const first = /** @type {any} */ (await h.hear(press(1, { data: actionData("forme") })));
    const again = /** @type {any} */ (await h.hear(press(2, { data: actionData("forme") })));
    h.restart();
    const afterRestart = /** @type {any} */ (await h.hear(press(3, { data: actionData("forme") })));
    assert.deepEqual([first.reason, again.reason, afterRestart.reason], ["queued-for-session", "already-queued", "already-queued"]);
    assert.match(again.text, /already asked/);
    assert.equal(h.lines().filter((entry) => entry.step === FORME_STEP).length, 1);
    assert.deepEqual(h.github.writes(), []);
  });

  test("forme (#3581): each message is its own OK, and the request's other presses are unaffected (snooze still works after)", async () => {
    const h = harness();
    await h.hear(press(1, { data: actionData("forme") }));
    const onReminder = /** @type {any} */ (await h.hear(press(2, { messageId: Number(REMINDER_REF), data: actionData("forme") })));
    assert.equal(onReminder.reason, "queued-for-session");
    assert.deepEqual(h.lines().filter((entry) => entry.step === FORME_STEP).map((entry) => entry.messageRef), [ASK_REF, REMINDER_REF]);
    assert.equal(/** @type {any} */ (await h.hear(press(3, { data: actionData("later") }))).reason, "snoozed");
    assert.equal(/** @type {any} */ (await h.hear(press(4))).reason, "answered", "the request can still be answered: the forme line is not one of the answer's steps");
  });

  test("forme (#3581) POSITIVE CONTROL: a press on an unknown message, or on a request no longer asking, writes nothing, and verifyApproval refuses its ref", async () => {
    const h = harness();
    const before = h.raw();
    const unknown = /** @type {any} */ (await h.hear(press(1, { messageId: 777, data: actionData("forme") })));
    assert.equal(unknown.reason, "unknown-message");
    assert.equal(h.lines().some((entry) => entry.step === FORME_STEP), false);
    assert.equal(verifyApproval(h.lines(), { ref: "777", words: null }).ok, false);
    assert.equal(h.raw().replace(before, "").includes('"step":"forme"'), false);
    // The same press on a real request is what writes the line: the control is not a writer that never writes.
    assert.equal(/** @type {any} */ (await h.hear(press(2, { data: actionData("forme") }))).reason, "queued-for-session");
    const gone = harness(openRow({ labels: ["ready"] }));
    assert.equal(/** @type {any} */ (await gone.hear(press(1, { data: actionData("forme") }))).reason, "no-longer-asking");
    assert.equal(gone.lines().some((entry) => entry.step === FORME_STEP), false);
  });
});

describe("a press on a message that can no longer be answered is told so, and its keyboard comes off (done-when 6)", () => {
  test("already answered, whichever button it is, and after the label is gone on ANOTHER message of the request", async () => {
    const orders = fixtureOrders();
    const h = harness(openRow(), { orders });
    await h.hear(press(1));
    for (const [id, data] of [[2, buttonData("A")], [3, actionData("later")], [4, actionData("explain")]]) {
      const result = /** @type {any} */ (await h.hear(press(/** @type {number} */ (id), { data: /** @type {string} */ (data) })));
      assert.equal(result.reason, "already-answered", String(data));
      assert.equal(result.clearKeyboard, ASK_REF);
    }
    const onReminder = /** @type {any} */ (await h.hear(press(5, { messageId: Number(REMINDER_REF), data: actionData("later") })));
    assert.equal(onReminder.reason, "no-longer-asking");
    assert.equal(onReminder.clearKeyboard, REMINDER_REF);
    assert.equal(orders.calls.length, 0, "no order went for a request that was answered");
    assert.equal(h.github.writes().length, 3, "one answer's three writes, and no more");
  });

  test("a typed reply that answers takes the keyboard off the message it replied to; a failed write does not", async () => {
    const h = harness();
    const typed = /** @type {any} */ (await h.hear(reply(1, "yes, publish")));
    assert.equal(typed.reason, "answered");
    assert.equal(typed.clearKeyboard, ASK_REF);
    const g = harness();
    g.github.failOnce.add("remove-label");
    const failed = /** @type {any} */ (await g.hear(press(1)));
    assert.equal(failed.reason, "write-failed");
    assert.equal(failed.clearKeyboard, null, "the press must be possible again to resume the answer");
  });
});

describe("the keyboard a request carries", () => {
  const OPTIONS = [{ id: "A", label: "publish now" }, { id: "B", label: "hold" }];

  test("options, then Explain more and Later; and with none to choose between, Approve", () => {
    assert.deepEqual(requestActions(OPTIONS).map(({ label }) => label), ["A: publish now", "B: hold", ACTION_LABELS.explain, ACTION_LABELS.later]);
    assert.deepEqual(requestActions([]).map(({ label }) => label), [ACTION_LABELS.approve, ACTION_LABELS.explain, ACTION_LABELS.later]);
  });

  test("every button it draws is in the vocabulary inbound accepts (the drawing and the reading cannot disagree)", () => {
    for (const { data } of [...requestActions(OPTIONS), ...requestActions([])]) assert.notEqual(parseButtonData(data), null, data);
    assert.deepEqual(parseButtonData(requestActions(OPTIONS)[1].data), { kind: "option", id: "B" });
  });

  test("more options than the keyboard has room for draws NO keyboard, never a partial one", () => {
    const many = Array.from({ length: 7 }, (_, index) => ({ id: `O${index}`, label: "x" }));
    assert.deepEqual(requestActions(many), []);
    assert.equal(requestActions(many.slice(0, 6)).length, 8, "the control: six still fit");
  });

  test("a long label is cut to what a button holds, and callback_data stays within Telegram's 64 bytes", () => {
    const [button] = requestActions([{ id: "A".repeat(16), label: "l".repeat(200) }]);
    assert.ok(button.label.length <= 64);
    assert.ok(Buffer.byteLength(button.data) <= 64);
  });
});
