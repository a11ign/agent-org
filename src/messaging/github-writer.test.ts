// @ts-check
// THE GITHUB WRITER AND THE WIRING (a11ign/a11ign#3062 done-whens 2 and 3): `createGithubWriter` over the fake code host's rows, and a stream of updates through the REAL inbound core, the real answers, the real writer and
// `listen.ts`'s forwarder, with the in-memory provider's listen loop. Nothing here reaches a network or runs `gh`.
//
// A11-160, step 8: the writer's four calls are the code host's operations now (`readRowAsync`, `commentOnRowAsync`, `removeLabelAsync`, `addLabelAsync`), and these cases run on the fake code host's world: the row, its labels
// and its comments (with the author association of each) are SEEDED, and what the writer is held to is what it returns and what it leaves in the row. The argument lists, `--paginate` and the 404 that says `Label does not exist`
// are GitHub's words and are held beside the operations (`plugins/github/rows/messaging-rows.test.ts`, moved from this file).
//
// POSITIVE CONTROLS: "resolves when the label is absent" is also what a writer that swallows every failure reports, so the same call with a REFUSED removal is asserted to throw; "pages past 100" is also what a reader that was
// only ever given one page reports, so the world holds 250 comments and the newest brief is the 250th.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";

import { buttonData, createAnswers } from "./answers.ts";
import { createGithubWriter } from "./github-writer.ts";
import { createInbound } from "./inbound.ts";
import { createLedger, deliveryLine, STATUS } from "./ledger.ts";
import { createConverse } from "./converse.ts";
import { createForwarder } from "./listen.ts";
import { createFakeProvider } from "./fake-provider.ts";
import { latestBrief, NEEDS_CHAIRMAN } from "./sources/requests.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { fakeRow, type FakeRow } from "../plugins/fakes/code-host-rows.ts";
import { watchedRows } from "../plugins/fakes/watched-rows.test.support.ts";

const REPO = "a11ign/a11ign";
const CHAIRMAN = Object.freeze({ userId: 4242, chatId: 4242 });
const ANSWER_LABEL = "answer:ceo";
const brief = (/** @type {string} */ question: string) => `**Brief for the chairman**\n${question}\n<!-- chairman-options: A=publish now; B=hold -->`;

const scratch = mkdtempSync(join(tmpdir(), "messaging-github-writer-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => forgetActivation());

/** The fake code host in place, its tracker the repository the chairman's rows live in; `rows` are seeded into its world. */
function world(rows: Record<number, Partial<FakeRow>> = {}) {
  const host = createFakeCodeHost();
  host.rowsWorld.repo = REPO;
  for (const [number, over] of Object.entries(rows)) host.rowsWorld.rows.set(Number(number), fakeRow(host.rowsWorld, Number(number), over));
  return host;
}

/** @param {number} count @returns {FakeRow["comments"]} `count` comments, the newest a brief of its own, by an owner */
function manyComments(count: number): FakeRow["comments"] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    body: index === count - 1 ? brief("The newest ask") : `comment ${index}`,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
    association: index === count - 1 ? "OWNER" : "NONE",
  }));
}

describe("the writer over the code host's rows (done-when 2)", () => {
  const ROW = { repo: REPO, number: 3062 };

  test("each of the three writes is the code host's operation for that row, and the row is changed", async () => {
    const host = world({ 3062: { labels: ["ready", NEEDS_CHAIRMAN] } });
    const watched = watchedRows(host);
    substituteCodeHost(watched.host);
    const writer = createGithubWriter();
    await writer.comment(ROW, "hello\n> quoted");
    await writer.removeLabel(ROW, NEEDS_CHAIRMAN);
    await writer.addLabel(ROW, ANSWER_LABEL);
    assert.deepEqual(watched.calls.map(({ op, request }) => [op, request.repo, request.number, request.body ?? request.label]), [
      ["commentOnRowAsync", REPO, 3062, "hello\n> quoted"], ["removeLabelAsync", REPO, 3062, NEEDS_CHAIRMAN], ["addLabelAsync", REPO, 3062, ANSWER_LABEL],
    ]);
    const row = host.rowsWorld.rows.get(3062)!;
    assert.deepEqual(row.labels, ["ready", ANSWER_LABEL]);
    assert.deepEqual(row.comments.map(({ body }) => body), ["hello\n> quoted"]);
  });

  test("readRow returns the shape answers reads: state, label names and each comment's body, createdAt and authorAssociation", async () => {
    substituteCodeHost(world({ 3062: { labels: ["ready", NEEDS_CHAIRMAN], comments: manyComments(2) } }));
    const read = await createGithubWriter().readRow(ROW);
    assert.deepEqual(read.labels, ["ready", NEEDS_CHAIRMAN]);
    assert.equal(read.state, "open");
    assert.deepEqual(read.comments.map(({ body, authorAssociation }) => ({ body, authorAssociation })), [
      { body: "comment 0", authorAssociation: "NONE" }, { body: brief("The newest ask"), authorAssociation: "OWNER" },
    ]);
    assert.equal(read.comments[1].createdAt, "2026-10-01T00:00:01.000Z");
  });

  test("readRow of a closed row says so: the state is the row's own", async () => {
    substituteCodeHost(world({ 3062: { state: "CLOSED" }, 3063: {} }));
    assert.equal((await createGithubWriter().readRow(ROW)).state, "closed");
    assert.equal((await createGithubWriter().readRow({ repo: REPO, number: 3063 })).state, "open", "CONTROL: an open row reads open");
  });

  test("readRow reads past 100 comments: 250 are returned and the newest brief is the 250th (the paging is the operation's: messaging-rows.test.ts)", async () => {
    substituteCodeHost(world({ 3062: { labels: [NEEDS_CHAIRMAN], comments: manyComments(250) } }));
    const read = await createGithubWriter().readRow(ROW);
    assert.equal(read.comments.length, 250);
    assert.equal(latestBrief(read.comments)?.body, brief("The newest ask"));
  });

  test("removeLabel resolves when the label is already absent (a resumed answer repeats it), and a REFUSED removal is thrown as it was refused", async () => {
    const host = world({ 3062: { labels: [] } });
    substituteCodeHost(host);
    await createGithubWriter().removeLabel(ROW, NEEDS_CHAIRMAN);
    for (const refusal of [Object.assign(new Error("Command failed: gh api"), { stderr: "gh: Not Found (HTTP 404)" }), Object.assign(new Error("Command failed: gh api"), { stderr: "gh: Service Unavailable (HTTP 503)" }), new Error("spawn gh ENOENT")]) {
      host.rowsWorld.failures.set("removeLabelAsync", refusal);
      await assert.rejects(createGithubWriter().removeLabel(ROW, NEEDS_CHAIRMAN), refusal);
    }
  });

  test("a row the code host cannot reach is a rejection of the call, for each of the four", async () => {
    substituteCodeHost(world({ 3062: {} }));
    const writer = createGithubWriter();
    const absent = { repo: REPO, number: 9999 };
    await assert.rejects(writer.readRow(absent), /holds no row/);
    await assert.rejects(writer.comment(absent, "x"), /holds no row/);
    await assert.rejects(writer.removeLabel(absent, "x"), /holds no row/);
    await assert.rejects(writer.addLabel(absent, "x"), /holds no row/);
    assert.deepEqual((await writer.readRow(ROW)).comments, [], "CONTROL: the row it holds reads");
  });
});

const ASK_A = { message: 501, row: 2885 };
const ASK_B = { message: 601, row: 2886 };

/** The chairman's press under bot message 501, a reply to bot message 601, and a message that replies to nothing. */
/** @type {any[]} */
const updates: any[] = [
  { update_id: 1, callback_query: { id: "cbq-1", from: { id: CHAIRMAN.userId }, data: buttonData("A"), message: { message_id: ASK_A.message, chat: { id: CHAIRMAN.chatId, type: "private" } } } },
  { update_id: 2, message: { message_id: 902, from: { id: CHAIRMAN.userId }, chat: { id: CHAIRMAN.chatId, type: "private" }, text: "hold it until Monday", reply_to_message: { message_id: ASK_B.message } } },
  { update_id: 3, message: { message_id: 903, from: { id: CHAIRMAN.userId }, chat: { id: CHAIRMAN.chatId, type: "private" }, text: "how is the queue today?" } },
];

/**
 * @param {any[]} stream
 * @param {(parts: {ledger: any, say: (text: string) => void}) => (accepted: Readonly<Record<string, any>>) => Promise<unknown> | void} [consumer] what takes what is not an answer: a recorder unless a test passes the real one
 * @returns {Promise<{events: string[], rows: Map<number, any>}>} what happened, in order
 */
async function listen(stream: any[], consumer: (parts: { ledger: any; say: (text: string) => void; }) => (accepted: Readonly<Record<string, any>>) => Promise<unknown> | void = ({ say }) => (accepted) => say(`converse ${accepted.text}`)): Promise<{ events: string[]; rows: Map<number, any>; }> {
  const host = world(Object.fromEntries([ASK_A, ASK_B].map(({ row }) => [row, { labels: ["ready", NEEDS_CHAIRMAN], comments: [{ ...manyComments(1)[0], body: brief(`Ask ${row}`) }] }])));
  /** @type {string[]} */
  const events: string[] = [];
  // Only the writes are events: the reads are the answer's own business and the order of the WRITES is the design.
  for (const [operation, say] of [["commentOnRowAsync", ({ number }: any) => `row ${number} comment`], ["removeLabelAsync", ({ number, label }: any) => `row ${number} remove ${label}`],
    ["addLabelAsync", ({ number, label }: any) => `row ${number} add ${label}`]] as const) {
    const done = host.rows![operation].bind(host.rows);
    (host.rows as any)[operation] = (request: any) => { events.push(say(request)); return done(request); };
  }
  substituteCodeHost(host);
  const writer = createGithubWriter();
  const rows = host.rowsWorld.rows;
  let at = Date.parse("2026-10-02T10:00:00Z");
  const now = () => at += 1000;
  const ledger = createLedger({ path: join(scratch, `ledger-${Math.random().toString(36).slice(2)}.jsonl`), now });
  for (const { message, row } of [ASK_A, ASK_B]) {
    ledger.append(deliveryLine({ key: `request:${REPO}#${row}`, provider: "fake", status: STATUS.sent, providerMessageId: String(message), kind: "request", stateHash: "h" }));
  }
  const answers = createAnswers({ ledger, github: writer, chairman: CHAIRMAN, answerLabel: ANSWER_LABEL, now });
  const send = async (/** @type {{text: string}} */ { text }: { text: string; }) => { events.push(`send ${text}`); return { messageRef: "1" }; };
  const consume = consumer({ ledger, say: (text) => events.push(text) });
  // The forwarder's converse port reports nothing, and the real `converse` reports an outcome: the wrapper drops it, as the forwarder does.
  const onForward = createForwarder({ answers, send, converse: async (accepted) => { await consume(accepted); }, log: (line) => events.push(`log ${line}`) });
  const provider = createFakeProvider();
  stream.forEach((update) => provider.receive(update));
  await provider.listen({ inbound: createInbound({ ledger, chairman: CHAIRMAN }), offsets: { read: () => undefined, write: () => {} }, chairman: CHAIRMAN, onForward, sleep: async () => {} });
  return { events, rows };
}

describe("a stream of updates through the listener's wiring (done-when 3)", () => {
  test("a press, a reply and a plain message produce the row writes, the two replies and one pass-through, in that order", async () => {
    const { events, rows } = await listen(updates);
    assert.deepEqual(events, [
      "row 2885 comment", "row 2885 remove needs:chairman", "row 2885 add answer:ceo", "send Recorded on a11ign/a11ign#2885: ceo has it.",
      "row 2886 comment", "row 2886 remove needs:chairman", "row 2886 add answer:ceo", "send Recorded on a11ign/a11ign#2886: ceo has it.",
      "converse how is the queue today?",
    ]);
    for (const row of [2885, 2886]) assert.deepEqual(rows.get(row).labels, ["ready", ANSWER_LABEL], `row ${row} is answered and ceo is woken`);
    assert.match(rows.get(2885).comments.at(-1).body, /A \(publish now\)/, "the press wrote the option the row offered");
    assert.match(rows.get(2886).comments.at(-1).body, /> hold it until Monday/, "the reply wrote the chairman's words, quoted");
  });

  // THE LIAISON IS MID-TURN HERE ON PURPOSE (a11ign/a11ign#3536). `converse` types into an IDLE seat (`promptOrQueue`), and this test drives the REAL port, whose herdr is the host's: an idle
  // roster entry named `liaison` would be a live prompt to the real liaison seat from every run of this suite. A working one is queued, to this test's temp file, and herdr is never called.
  const LIAISON_MID_TURN = [{ label: "liaison", status: "working" }];

  test("with row 10's real `converse` taking the pass-through, the plain message is queued for the liaison and the chairman is told so", async () => {
    const queuePath = join(scratch, `queue-${Math.random().toString(36).slice(2)}`);
    const { events } = await listen(updates, ({ ledger, say }) => {
      const send = async (/** @type {{text: string}} */ { text }: { text: string; }) => { say(`send ${text}`); return { messageRef: "2" }; };
      return createConverse({ chairman: CHAIRMAN, queuePath, ledger, send, agents: () => LIAISON_MID_TURN }).forward;
    });
    assert.deepEqual(events.filter((event) => event.startsWith("send Recorded")), ["send Recorded on a11ign/a11ign#2885: ceo has it.", "send Recorded on a11ign/a11ign#2886: ceo has it."]);
    assert.equal(events.at(-1), "send Got it, looking.");
    const queued = existsSync(queuePath) ? readFileSync(queuePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    assert.deepEqual(queued.map((entry) => entry.session), ["liaison"], "one order, for the liaison, and the answered reply was not queued");
    assert.match(queued[0].prompt, /how is the queue today\?/);
    assert.doesNotMatch(queued[0].prompt, /hold it until Monday/);
  });
});

describe("a stream of updates through the listener's wiring (done-when 3)", () => {
  test("the control: the same stream with the reply's target removed writes nothing for it and passes it through, so a value without the target fails above", async () => {
    const { events } = await listen([updates[0], { update_id: 2, message: { ...updates[1].message, reply_to_message: undefined } }, updates[2]]);
    assert.deepEqual(events.filter((event) => event.startsWith("converse")), ["converse hold it until Monday", "converse how is the queue today?"]);
    assert.equal(events.filter((event) => event.startsWith("row ")).length, 3, "only the press wrote to a row");
  });

  test("a GitHub failure is said to the chairman and the forwarder does not throw; nothing is passed through", async () => {
    /** @type {string[]} */
    const events: string[] = [];
    const failing = { async answer() { throw new Error("gh api: HTTP 503"); } };
    const forward = createForwarder({ answers: failing, send: async ({ text }) => { events.push(`send ${text}`); }, converse: () => { events.push("converse"); }, log: (line) => events.push(`log ${line}`) });
    await forward({ updateId: 9 });
    assert.equal(events.length, 2, events.join("\n"));
    assert.match(events[0], /^log messaging:listen: update 9 could not be answered: gh api: HTTP 503$/);
    assert.match(events[1], /^send Could not reach GitHub to record that\./);
  });
});
