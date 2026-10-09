// @ts-check
// THE "DO IT FOR ME" BUTTON IS DRAWN (a11ign/a11ign#3982, the gap under #3431 Done-when 3). `answers.ts` handled a `forme` press and no keyboard carried
// one, so no brief could ask for it. A brief that NAMES the act it would do (`Do it for me: <the act>`) now draws a fourth button; a brief that names none draws
// none, because a press would then OK an unnamed act and D1 (#3427) is that the OK is for a stated act.
//
// This calls the SHIPPED `parseChairmanAct`, `requestActions`, the real watcher and the real answers: nothing is a copy.
// POSITIVE CONTROLS: the same request WITHOUT the act line draws the keyboard it always drew (so the button is the new line's doing and not every keyboard's),
// and a request with too many options for the button carries no keyboard at all (so the room check is a check and not a constant).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { actionData, createInbound } from "./inbound.ts";
import { createAnswers, requestActions } from "./answers.ts";
import { createLedger, readLedgerLines } from "./ledger.ts";
import { FORME_STEP } from "./session-queue.ts";
import { NEEDS_CHAIRMAN, parseChairmanAct } from "./sources/requests.ts";
import { runWatch } from "./watch.ts";

const REPO = "a11ign/a11ign";
const ROW = 3982;
const KEY = `request:${REPO}#${ROW}`;
const START = Date.parse("2026-10-07T09:00:00Z");
const CHAIRMAN = Object.freeze({ userId: 4242, chatId: 4242 });
const FORME_DATA = actionData("forme");
const ACT = "Do it for me: add the first-publish token to the queue for your own session";

const REQUIRED = [
  "What is happening: the publish token is not set", "Ask: say whether I may set it", "Only you because: the token is his to authorise", "Checked: 09:00Z, gh api printed false",
  "How long: two minutes", "Unblocks: the first publish",
];
const NOT_HIS_CLAUDE = "Not the chairman's Claude session because: it is a decision only he can make";

/** @param {{ act?: boolean, options?: number }} shape @returns {Record<string, unknown>} a labelled row whose newest brief is complete */
function row({ act = false, options = 0 }: { act?: boolean; options?: number; } = {}): Record<string, unknown> {
  const ids = Array.from({ length: options }, (_, at) => String.fromCharCode(65 + at));
  const block = options > 0 ? `\n<!-- chairman-options: ${ids.map((id) => `${id}=choice ${id}`).join("; ")} -->` : "";
  const tail = options > 0 ? ["Recommend: A", "Trade-off: A costs a day"] : [NOT_HIS_CLAUDE];
  const body = `**ceo — BRIEF for the chairman: decide.**${block}\n${[...REQUIRED, ...tail, ...(act ? [ACT] : [])].join("\n")}`;
  return { number: ROW, title: "Set the token", url: `https://github.com/${REPO}/issues/${ROW}`, comments: [{ body, createdAt: "2026-10-07T08:00:00Z", authorAssociation: "MEMBER" }] };
}

/** @returns {any} a recording provider with the message ids a Telegram chat would give (a press names its message by an integer); inline, because the acceptance command is a bare `node --test` and cannot load `fake-provider.ts` */
function numericProvider(): any {
  /** @type {Record<string, any>[]} */
  const sent: Record<string, any>[] = [];
  return {
    id: "recording", sent,
    capabilities: { silent: true, buttons: true, replies: true, conversation: true, maxText: 4096 },
    async send(message: any) { sent.push({ text: message.text, actions: message.actions }); return { messageRef: String(500 + sent.length), silent: false }; },
    async poll() { return { updates: [], cursor: 0 }; },
  };
}

const scratch = mkdtempSync(join(tmpdir(), "messaging-forme-button-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextLedger = 0;

/** One watcher pass over one ledger file. @param {Record<string, unknown>} asking @returns {Promise<{ sent: any, path: string, ledger: () => any }>} */
async function watched(asking: Record<string, unknown>): Promise<{ sent: any; path: string; ledger: () => any; }> {
  const path = join(scratch, `ledger-${nextLedger += 1}.jsonl`);
  const ledger = () => createLedger({ path, now: () => START });
  const provider = numericProvider();
  const github = {
    issuesLabelled: async (query: any) => (query.label === NEEDS_CHAIRMAN ? [asking] : []),
    issueComments: async () => [], mergedPullsSince: async () => [], redPulls: async () => [],
  };
  await runWatch({ github, provider, ledger: ledger(), now: () => START, repo: REPO, summary: null });
  return { sent: provider.sent[0], path, ledger };
}

/** @param {any} sent @returns {string[]} the callback data of the keyboard the provider was handed */
const dataOf = (sent: any): string[] => (sent.actions ?? []).map((action: any) => action.data);

describe("the brief names the act in one line", () => {
  test("parseChairmanAct reads the line, in any markup the other lines allow, and says nothing for a brief without one", () => {
    assert.equal(parseChairmanAct("Ask: x\nDo it for me: add the token"), "add the token");
    assert.equal(parseChairmanAct("**Do it for me:** add `the` token"), "add the token", "markup is not part of the act");
    assert.equal(parseChairmanAct("- Do it for me: add the token\nUnblocks: y"), "add the token", "the next line is not the act");
    assert.equal(parseChairmanAct("Ask: x\nUnblocks: y"), null, "a brief that names no act");
    assert.equal(parseChairmanAct("Do it for me:   \nUnblocks: y"), null, "a label with no act after it names none");
    assert.equal(parseChairmanAct("Ask: please do it for me: whatever"), null, "the label is a line's start and not a phrase inside one");
  });
});

describe("a keyboard carries the button only when the brief names the act", () => {
  test("requestActions: Approve, Explain more, Later, then Do it for me, whose data is actionData(forme)", () => {
    const withAct = requestActions([], "add the token");
    assert.deepEqual(withAct.map((action) => action.data), ["act:approve", "act:explain", "act:later", FORME_DATA]);
    assert.equal(withAct.at(-1)?.label, "Do it for me");
    assert.deepEqual(requestActions([]).map((action) => action.data), ["act:approve", "act:explain", "act:later"], "control: no act, no button");
    assert.deepEqual(requestActions([{ id: "A", label: "x" }], null).map((action) => action.data), ["ans:A", "act:explain", "act:later"]);
  });

  test("POSITIVE CONTROL: an act and too many options for the button carries NO keyboard, and the same options without the act still do", () => {
    const options = ["A", "B", "C", "D", "E", "F"].map((id) => ({ id, label: id }));
    assert.deepEqual(requestActions(options, "add the token"), [], "six options leave no room for a third fixed button: all or nothing");
    assert.equal(requestActions(options).length, 8, "control: six options with no act fill the keyboard, so the refusal above is the button's doing");
    assert.equal(requestActions(options.slice(0, 5), "add the token").length, 8, "five options and the button fit");
  });

  test("the watcher draws it from the brief, and the brief without the line draws the keyboard it always drew", async () => {
    const named = await watched(row({ act: true }));
    assert.deepEqual(dataOf(named.sent), ["act:approve", "act:explain", "act:later", FORME_DATA]);
    const unnamed = await watched(row());
    assert.deepEqual(dataOf(unnamed.sent), ["act:approve", "act:explain", "act:later"]);
  });

  test("the act is in the message he reads, so the OK a press gives is for a stated act", async () => {
    const named = await watched(row({ act: true }));
    assert.match(named.sent.text, /^Do it for me: add the first-publish token to the queue for your own session$/m);
    assert.doesNotMatch((await watched(row())).sent.text, /Do it for me/);
  });

  test("a brief with options carries the button after Later, and one with too many carries no keyboard", async () => {
    assert.deepEqual(dataOf((await watched(row({ act: true, options: 2 }))).sent), ["ans:A", "ans:B", "act:explain", "act:later", FORME_DATA]);
    assert.equal((await watched(row({ act: true, options: 6 }))).sent.actions, undefined, "no keyboard, not one missing the button");
    assert.equal((await watched(row({ options: 6 }))).sent.actions?.length, 8, "control: six options with no act are drawn");
  });
});

describe("the button that is drawn is the button that works", () => {
  test("the press its data carries reaches doItForMe and writes the one ledger line, once", async () => {
    const { sent, path, ledger } = await watched(row({ act: true }));
    const drawn = sent.actions.find((action: any) => action.label === "Do it for me");
    const inbound = createInbound({ ledger: ledger(), chairman: CHAIRMAN });
    const labels = new Set(["ready", NEEDS_CHAIRMAN]);
    const github = /** @type {import("./answers.ts").GithubWriter} */ (/** @type {unknown} */ ({
      readRow: async () => ({ state: "OPEN", labels: [...labels], comments: /** @type {any[]} */ (row({ act: true }).comments) }),
      comment: async () => {}, removeLabel: async () => {}, addLabel: async () => {},
    }));
    const answers = createAnswers({ ledger: ledger(), github, chairman: CHAIRMAN, answerLabel: "answer:ceo", now: () => START });
    const messageId = readLedgerLines(path).find((line) => line.key === KEY && line.status === "sent")?.providerMessageId;
    const update = (/** @type {number} */ id: number) => ({
      update_id: id, callback_query: { id: `cbq-${id}`, from: { id: CHAIRMAN.userId }, data: drawn.data, message: { message_id: Number(messageId), chat: { id: CHAIRMAN.chatId, type: "private" } } },
    });
    const handled = /** @type {any} */ (inbound.handle(update(1)));
    assert.equal(handled.action, "forward", JSON.stringify(handled));
    assert.equal(/** @type {any} */ (await answers.answer(handled.accepted)).reason, "queued-for-session");
    const written = readLedgerLines(path).filter((line) => line.direction === "answer" && line.step === FORME_STEP);
    assert.deepEqual(written.map(({ via, messageRef }) => ({ via, messageRef })), [{ via: "button", messageRef: messageId }]);
    assert.equal(labels.has(NEEDS_CHAIRMAN), true, "a press is a request and not an answer: the row is still asking");
  });
});
