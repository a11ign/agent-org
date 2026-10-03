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

import { answerComment, buttonData, createAnswers, STEPS } from "./answers.mjs";
import { createInbound } from "./inbound.mjs";
import { createLedger, deliveryLine, foldLedger, readLedgerLines, STATUS } from "./ledger.mjs";
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
    async comment(/** @type {any} */ ref, /** @type {string} */ body) { attempt("comment"); (calls.at(-1) ?? {}).arg = body; rowOf(ref).comments.push({ body, createdAt: "2026-10-02T10:00:00Z" }); },
    async removeLabel(/** @type {any} */ ref, /** @type {string} */ label) { attempt("remove-label"); rowOf(ref).labels = rowOf(ref).labels.filter((/** @type {string} */ l) => l !== label); },
    async addLabel(/** @type {any} */ ref, /** @type {string} */ label) { attempt("set-answer"); rowOf(ref).labels.push(label); },
  };
}

/** A ledger already holding the ask (sent as message 501) and a reminder (502), an inbound and an answers over it. `restart()` is a NEW process, same file. */
function harness(initial = openRow()) {
  const path = join(scratch, `ledger-${nextLedger += 1}.jsonl`);
  let at = Date.parse("2026-10-02T10:00:00Z");
  const now = () => at += 1000;
  const github = fixtureGithub(initial);
  const ledger = () => createLedger({ path, now });
  const seed = ledger();
  for (const [ref, kind] of [[ASK_REF, "request"], [REMINDER_REF, "reminder"]]) {
    seed.append(deliveryLine({ key: KEY, provider: "fake", status: STATUS.sent, providerMessageId: ref, kind, stateHash: "h" }));
  }
  const build = () => ({ ledger: ledger(), github, chairman: CHAIRMAN, answerLabel: ANSWER_LABEL, now });
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
    assert.match(h.lines().find((line) => line.step === "failed").error, /set-answer failed/);
  });

  test("an option the brief does not offer (or data that is not ours) writes nothing", async () => {
    const h = harness();
    for (const [id, data] of [[1, buttonData("Z")], [2, "approve:2885"], [3, buttonData("")]]) {
      const result = await h.hear(press(/** @type {number} */ (id), { data: /** @type {string} */ (data) }));
      assert.equal(/** @type {any} */ (result).reason, "option-not-offered", String(data));
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
