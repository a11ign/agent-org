// @ts-check
// BUTTONS FROM THE WATCHER'S SIDE (a11ign/a11ign#3423): what `runWatch` hands the provider, what `later` does to the next tick, and the whole loop from a drawn
// button to the press that answers it, over the REAL Telegram provider (a fetch that records the wire), the real inbound and the real answers.
//
// POSITIVE CONTROLS: every "no reminder" below sits beside the same timeline with no press, where the reminder IS sent; and the keyboard assertions beside a request
// that has no options, where Approve is drawn instead, so neither is a source that draws nothing.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { actionData, createInbound } from "./inbound.ts";
import { createAnswers, requestActions } from "./answers.ts";
import { createFakeProvider } from "./fake-provider.ts";
import { createLedger, readLedgerLines } from "./ledger.ts";
import { createSecret } from "./secret.ts";
import { createTelegramProvider } from "./providers/telegram/send.ts";
import { NEEDS_CHAIRMAN } from "./sources/requests.ts";
import { runWatch } from "./watch.ts";

const REPO = "a11ign/a11ign";
const ROW = 3423;
const KEY = `request:${REPO}#${ROW}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.parse("2026-10-04T09:00:00Z");
const CHAIRMAN = Object.freeze({ userId: 4242, chatId: 4242 });
const LONDON = null;

const REQUIRED = [
  "What is happening: the buttons are not drawn", "Ask: pick one", "Only you because: it is a publish decision", "Checked: 09:00Z, gh api printed false",
  "How long: two minutes", "Unblocks: the next row",
];
const WITH_OPTIONS = [...REQUIRED, "Recommend: A, publish now", "Trade-off: A costs a day"].join("\n");
const WITHOUT_OPTIONS = [...REQUIRED, "Not the chairman's Claude session because: it is a decision only he can make"].join("\n");

/** @param {boolean} options @returns {Record<string, unknown>} a labelled row whose newest brief is complete */
function row(options: boolean): Record<string, unknown> {
  const head = options ? "**ceo — BRIEF for the chairman: decide.**\n<!-- chairman-options: A=publish now; B=hold -->" : "**ceo — BRIEF for the chairman: decide.**";
  return {
    number: ROW, title: "Publish decision", url: `https://github.com/${REPO}/issues/${ROW}`,
    comments: [{ body: `${head}\n${options ? WITH_OPTIONS : WITHOUT_OPTIONS}`, createdAt: "2026-10-04T08:00:00Z", authorAssociation: "MEMBER" }],
  };
}

/** @param {Record<string, unknown>[]} rows @returns {any} a reader that only answers the label read the request source makes */
function reader(rows: Record<string, unknown>[]): any {
  return {
    issuesLabelled: async (query: any) => (query.label === NEEDS_CHAIRMAN ? rows : []),
    issueComments: async () => [], mergedPullsSince: async () => [], redPulls: async () => [],
  };
}

/** The in-memory provider, with message ids a Telegram chat would give (a press names its message by an integer). */
function numericProvider() {
  const inner = createFakeProvider({ capabilities: { edit: false, pin: false } });
  let next = 500;
  return { ...inner, async send(message: any) { await inner.send(message); next += 1; return { messageRef: String(next), silent: false }; } };
}

const scratch = mkdtempSync(join(tmpdir(), "messaging-watch-buttons-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextLedger = 0;

/** A watcher over one ledger file on a clock the test owns. @param {{ rows: Record<string, unknown>[], provider: any }} input */
function watcher({ rows, provider }: { rows: Record<string, unknown>[]; provider: any; }) {
  let at = START;
  const path = join(scratch, `ledger-${nextLedger += 1}.jsonl`);
  const ledger = () => createLedger({ path, now: () => at });
  return {
    path, ledger, provider,
    advance: (/** @type {number} */ ms: number) => { at += ms; },
    now: () => at,
    pass: () => runWatch({ github: reader(rows), provider, ledger: ledger(), now: () => at, repo: REPO, summary: LONDON }),
    lines: () => readLedgerLines(path),
  };
}

/** The chairman's press under bot message `messageId`. @param {number} id @param {string} data @param {string} messageId */
const press = (id: number, data: string, messageId: string) => ({
  update_id: id, callback_query: { id: `cbq-${id}`, from: { id: CHAIRMAN.userId }, data, message: { message_id: Number(messageId), chat: { id: CHAIRMAN.chatId, type: "private" } } },
});

/** @param {ReturnType<typeof watcher>} w @param {Record<string, any>} github @returns {{ press: (data: string, id: number) => Promise<any> }} the listener's half, over the same ledger */
function listener(w: ReturnType<typeof watcher>, github: Record<string, any>): { press: (data: string, id: number) => Promise<any>; } {
  const inbound = createInbound({ ledger: w.ledger(), chairman: CHAIRMAN });
  const answers = createAnswers({ ledger: w.ledger(), github: /** @type {import("./answers.ts").GithubWriter} */ (github), chairman: CHAIRMAN, answerLabel: "answer:ceo", now: w.now });
  return {
    async press(data, id) {
      const messageId = w.lines().find((line) => line.key === KEY && line.status === "sent")?.providerMessageId;
      const handled = /** @type {any} */ (inbound.handle(press(id, data, messageId)));
      assert.equal(handled.action, "forward", JSON.stringify(handled));
      return answers.answer(handled.accepted);
    },
  };
}

/** @returns {Record<string, any>} a writer over one row that is asking, recording nothing it must not */
function rowWriter(): Record<string, any> {
  const labels = new Set(["ready", NEEDS_CHAIRMAN]);
  return {
    readRow: async () => ({ state: "OPEN", labels: [...labels], comments: /** @type {any[]} */ (row(true).comments) }),
    comment: async () => {}, removeLabel: async (/** @type {any} */ _row: any, /** @type {string} */ label: string) => { labels.delete(label); }, addLabel: async (/** @type {any} */ _row: any, /** @type {string} */ label: string) => { labels.add(label); },
  };
}

describe("a request carries its buttons to the provider", () => {
  test("options, then Explain more and Later; with no options, Approve; and the control: both are sent", async () => {
    const withOptions = watcher({ rows: [row(true)], provider: numericProvider() });
    await withOptions.pass();
    assert.deepEqual(withOptions.provider.sent[0].actions, requestActions([{ id: "A", label: "publish now" }, { id: "B", label: "hold" }]));
    assert.deepEqual(withOptions.provider.sent[0].actions.map((action: any) => action.data), ["ans:A", "ans:B", "act:explain", "act:later"]);

    const without = watcher({ rows: [row(false)], provider: numericProvider() });
    await without.pass();
    assert.deepEqual(without.provider.sent[0].actions.map((action: any) => action.data), ["act:approve", "act:explain", "act:later"]);
  });

  test("a request that stopped asking becomes a cleared notice with no keyboard", async () => {
    const rows = [row(true)];
    const w = watcher({ rows, provider: numericProvider() });
    await w.pass();
    rows.length = 0;
    w.advance(HOUR);
    await w.pass();
    const cleared = w.provider.sent.at(-1);
    assert.match(cleared.text, /^Cleared: /);
    assert.equal(cleared.actions, undefined);
  });
});

describe("later holds the reminders back for 24 hours, and not longer", () => {
  test("the control: with no press, the reminder is sent a day on", async () => {
    const w = watcher({ rows: [row(true)], provider: numericProvider() });
    await w.pass();
    w.advance(DAY + HOUR);
    await w.pass();
    assert.deepEqual(w.lines().filter((line) => line.key === KEY).map((line) => line.kind), ["first", "reminder"]);
  });

  test("after Later the day-on reminder is not sent, the row's label is untouched, and the reminder comes once the snooze has run out", async () => {
    const w = watcher({ rows: [row(true)], provider: numericProvider() });
    await w.pass();
    w.advance(10 * HOUR);
    const result = await listener(w, rowWriter()).press(actionData("later"), 1);
    assert.equal(result.reason, "snoozed");
    w.advance(15 * HOUR);
    await w.pass();
    assert.deepEqual(w.lines().filter((line) => line.key === KEY).map((line) => line.kind), ["first"], "25 hours after the ask, 15 after the press: nothing sent");
    w.advance(10 * HOUR);
    await w.pass();
    assert.deepEqual(w.lines().filter((line) => line.key === KEY).map((line) => line.kind), ["first", "reminder"], "25 hours after the press: the reminder");
  });

  test("a request that clears during the snooze is still told as cleared", async () => {
    const rows = [row(true)];
    const w = watcher({ rows, provider: numericProvider() });
    await w.pass();
    await listener(w, rowWriter()).press(actionData("later"), 1);
    rows.length = 0;
    w.advance(HOUR);
    await w.pass();
    assert.equal(w.lines().filter((line) => line.key === KEY).at(-1)?.kind, "cleared");
  });
});

describe("the whole loop, over the real Telegram provider: drawn, pressed, answered", () => {
  test("the keyboard on the wire is what the inbound accepts, and a press on it resolves the request", async () => {
    /** @type {Record<string, any>[]} */
    const wire: Record<string, any>[] = [];
    const fetchImpl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ url: string, /** @type {{ body: string }} */ init: { body: string; }) => {
      wire.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 700 } }), headers: { get: () => null } };
    }));
    const real = createTelegramProvider({ token: createSecret("123456789:AAFk3x9Q-test_token_value_ZZ"), chatId: CHAIRMAN.chatId, fetch: fetchImpl, log: () => {}, sleep: async () => {} });
    // One request on the wire is what this test counts, so it runs without the asks' record: its pinned list is a message of its own (a11ign/a11ign#4745).
    const provider = { ...real, capabilities: { ...real.capabilities, edit: false, pin: false } };
    const w = watcher({ rows: [row(true)], provider });
    await w.pass();
    assert.equal(wire.length, 1);
    const keyboard = wire[0].body.reply_markup.inline_keyboard;
    assert.deepEqual(keyboard.map((/** @type {any[]} */ buttons: any[]) => buttons[0].callback_data), ["ans:A", "ans:B", "act:explain", "act:later"]);

    const github = rowWriter();
    const result = await listener(w, github).press(keyboard[0][0].callback_data, 1);
    assert.equal(result.reason, "answered");
    assert.equal(result.clearKeyboard, "700");
    const steps = w.lines().filter((line) => line.direction === "answer" && ["comment", "remove-label", "set-answer"].includes(line.step)).map((line) => line.step);
    assert.deepEqual(steps, ["comment", "remove-label", "set-answer"], "the ledger's answer lines");
  });
});
