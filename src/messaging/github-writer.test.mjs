// @ts-check
// THE GITHUB WRITER AND THE WIRING (a11ign/a11ign#3062 done-whens 2 and 3): `createGithubWriter` against a fixture `gh` that records its argv, and
// a stream of updates through the REAL inbound core, the real answers, the real writer and `listen.mjs`'s forwarder, with a fake Telegram.
// Nothing here reaches a network or runs `gh`.
//
// POSITIVE CONTROLS: "resolves when the label is absent" is also what a writer that swallows every failure reports, so the same call with a
// DIFFERENT failure is asserted to throw; "pages past 100" is also what a reader that was only ever given one page reports, so the fixture holds
// 250 comments and the newest brief is the 250th.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { buttonData, createAnswers } from "./answers.mjs";
import { createGithubWriter } from "./github-writer.mjs";
import { createInbound } from "./inbound.mjs";
import { createLedger, deliveryLine, STATUS } from "./ledger.mjs";
import { createConverse } from "./converse.mjs";
import { createForwarder } from "./listen.mjs";
import { runListener } from "./providers/telegram/poll.mjs";
import { latestBrief, NEEDS_CHAIRMAN } from "./sources/requests.mjs";

const REPO = "a11ign/a11ign";
const CHAIRMAN = Object.freeze({ userId: 4242, chatId: 4242 });
const ANSWER_LABEL = "answer:ceo";
const brief = (/** @type {string} */ question) => `**Brief for the chairman**\n${question}\n<!-- chairman-options: A=publish now; B=hold -->`;

const scratch = mkdtempSync(join(tmpdir(), "messaging-github-writer-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * A fixture `gh api`: records every argv and serves REST shaped like GitHub's (lowercase state, `created_at`, `author_association`), applying the
 * writes to `rows`. `--paginate` is the platform's, so the fixture answers it with every comment, as `gh` does after following the pages.
 *
 * @param {Map<number, {state: string, labels: string[], comments: {body: string, created_at: string, author_association: string}[]}>} rows
 * @param {{fail?: (argv: readonly string[]) => Error | null}} [options]
 */
function fixtureGh(rows, { fail = () => null } = {}) {
  /** @type {(readonly string[])[]} */
  const calls = [];
  /** @param {readonly string[]} argv @returns {Promise<string>} */
  async function run(argv) {
    calls.push(argv);
    const failure = fail(argv);
    if (failure !== null) throw failure;
    const [, ...rest] = argv;
    const method = rest[0] === "--method" ? rest[1] : "GET";
    const path = /** @type {string} */ (rest.find((token) => token.startsWith("repos/")));
    const [, number, tail, label] = /** @type {RegExpMatchArray} */ (path.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)(?:\/(comments|labels)(?:\/(.+))?)?$/));
    const row = /** @type {NonNullable<ReturnType<typeof rows.get>>} */ (rows.get(Number(number)));
    if (method === "GET" && tail === undefined) return `${JSON.stringify({ state: row.state, labels: row.labels })}\n`;
    if (method === "GET") return row.comments.map((comment) => JSON.stringify({ body: comment.body, createdAt: comment.created_at, authorAssociation: comment.author_association })).join("\n");
    if (tail === "comments") row.comments.push({ body: String(rest.find((token) => token.startsWith("body="))).slice("body=".length), created_at: "2026-10-02T12:00:00Z", author_association: "MEMBER" });
    else if (method === "DELETE") row.labels = row.labels.filter((existing) => existing !== decodeURIComponent(label));
    else row.labels.push(String(rest.find((token) => token.startsWith("labels[]="))).slice("labels[]=".length));
    return "";
  }
  return { run, calls };
}

/** @param {number} count @returns {{body: string, created_at: string, author_association: string}[]} `count` comments, the newest a brief of its own */
function manyComments(count) {
  return Array.from({ length: count }, (_, index) => ({
    body: index === count - 1 ? brief("The newest ask") : `comment ${index}`,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
    author_association: index === count - 1 ? "OWNER" : "NONE",
  }));
}

describe("the writer over `gh` (done-when 2)", () => {
  const ROW = { repo: REPO, number: 3062 };

  test("each of the four calls is one `gh api` with the argv a person would type, and the row is changed", async () => {
    /** @type {Parameters<typeof fixtureGh>[0]} */
    const rows = new Map([[3062, { state: "open", labels: ["ready", NEEDS_CHAIRMAN], comments: [] }]]);
    const gh = fixtureGh(rows);
    const writer = createGithubWriter({ run: gh.run });
    await writer.comment(ROW, "hello\n> quoted");
    await writer.removeLabel(ROW, NEEDS_CHAIRMAN);
    await writer.addLabel(ROW, ANSWER_LABEL);
    assert.deepEqual(gh.calls, [
      ["api", "--method", "POST", `repos/${REPO}/issues/3062/comments`, "-f", "body=hello\n> quoted"],
      ["api", "--method", "DELETE", `repos/${REPO}/issues/3062/labels/needs%3Achairman`],
      ["api", "--method", "POST", `repos/${REPO}/issues/3062/labels`, "-f", `labels[]=${ANSWER_LABEL}`],
    ]);
    assert.deepEqual(rows.get(3062)?.labels, ["ready", ANSWER_LABEL]);
    assert.equal(rows.get(3062)?.comments[0].body, "hello\n> quoted");
  });

  test("readRow returns the shape answers reads: state, label names and each comment's body, createdAt and authorAssociation", async () => {
    const rows = new Map([[3062, { state: "open", labels: ["ready", NEEDS_CHAIRMAN], comments: manyComments(2) }]]);
    const read = await createGithubWriter({ run: fixtureGh(rows).run }).readRow(ROW);
    assert.deepEqual(read.labels, ["ready", NEEDS_CHAIRMAN]);
    assert.equal(read.state, "open");
    assert.deepEqual(read.comments.map(({ body, authorAssociation }) => ({ body, authorAssociation })), [
      { body: "comment 0", authorAssociation: "NONE" }, { body: brief("The newest ask"), authorAssociation: "OWNER" },
    ]);
    assert.equal(read.comments[1].createdAt, "2026-10-01T00:00:01.000Z");
  });

  test("readRow pages past 100 comments: 250 are read, the newest brief is the 250th, and the call asks `gh` to paginate", async () => {
    const rows = new Map([[3062, { state: "open", labels: [NEEDS_CHAIRMAN], comments: manyComments(250) }]]);
    const gh = fixtureGh(rows);
    const read = await createGithubWriter({ run: gh.run }).readRow(ROW);
    assert.equal(read.comments.length, 250);
    assert.equal(latestBrief(read.comments)?.body, brief("The newest ask"));
    const commentsCall = /** @type {readonly string[]} */ (gh.calls.find((argv) => argv.some((token) => token.endsWith("/comments"))));
    assert.ok(commentsCall.includes("--paginate"), `argv was ${JSON.stringify(commentsCall)}: without --paginate gh returns the OLDEST thirty`);
  });

  test("removeLabel resolves when the label is already absent, and ONLY then: any other failure is thrown", async () => {
    const rows = new Map([[3062, { state: "open", labels: [], comments: [] }]]);
    const absent = Object.assign(new Error("Command failed: gh api"), { stderr: 'gh: Label does not exist (HTTP 404)\n{"message":"Label does not exist"}' });
    await createGithubWriter({ run: fixtureGh(rows, { fail: () => absent }).run }).removeLabel(ROW, NEEDS_CHAIRMAN);
    for (const other of [
      Object.assign(new Error("Command failed: gh api"), { stderr: "gh: Not Found (HTTP 404)" }),
      Object.assign(new Error("Command failed: gh api"), { stderr: "gh: Service Unavailable (HTTP 503)" }),
      new Error("spawn gh ENOENT"),
    ]) {
      await assert.rejects(createGithubWriter({ run: fixtureGh(rows, { fail: () => other }).run }).removeLabel(ROW, NEEDS_CHAIRMAN), other);
    }
  });

  test("a repository or number that is not a row builds no path and runs nothing", async () => {
    const gh = fixtureGh(new Map());
    const writer = createGithubWriter({ run: gh.run });
    for (const row of [{ repo: "a11ign/a11ign/../../user", number: 1 }, { repo: "a11ign", number: 1 }, { repo: REPO, number: 0 }, { repo: REPO, number: 1.5 }]) {
      await assert.rejects(writer.comment(row, "x"), TypeError);
    }
    assert.deepEqual(gh.calls, []);
  });
});

describe("a stream of updates through the listener's wiring (done-when 3)", () => {
  const ASK_A = { message: 501, row: 2885 };
  const ASK_B = { message: 601, row: 2886 };

  /** The chairman's press under bot message 501, a reply to bot message 601, and a message that replies to nothing. */
  /** @type {any[]} */
  const updates = [
    { update_id: 1, callback_query: { id: "cbq-1", from: { id: CHAIRMAN.userId }, data: buttonData("A"), message: { message_id: ASK_A.message, chat: { id: CHAIRMAN.chatId, type: "private" } } } },
    { update_id: 2, message: { message_id: 902, from: { id: CHAIRMAN.userId }, chat: { id: CHAIRMAN.chatId, type: "private" }, text: "hold it until Monday", reply_to_message: { message_id: ASK_B.message } } },
    { update_id: 3, message: { message_id: 903, from: { id: CHAIRMAN.userId }, chat: { id: CHAIRMAN.chatId, type: "private" }, text: "how is the queue today?" } },
  ];

  /**
   * @param {any[]} stream
   * @param {(parts: {ledger: any, say: (text: string) => void}) => (accepted: Readonly<Record<string, any>>) => Promise<unknown> | void} [consumer] what takes what is not an answer: a recorder unless a test passes the real one
   * @returns {Promise<{events: string[], rows: Map<number, any>}>} what happened, in order
   */
  async function listen(stream, consumer = ({ say }) => (accepted) => say(`converse ${accepted.text}`)) {
    const rows = new Map([ASK_A, ASK_B].map(({ row }) => [row, { state: "open", labels: ["ready", NEEDS_CHAIRMAN], comments: [{ ...manyComments(1)[0], body: brief(`Ask ${row}`) }] }]));
    /** @type {string[]} */
    const events = [];
    const gh = fixtureGh(rows);
    const writer = createGithubWriter({
      // Only the writes are events: the reads are the answer's own business and the order of the WRITES is the design.
      run: async (argv) => {
        if (argv.includes("--method")) events.push(`gh ${argv[2]} ${argv[3].replace(/^repos\/[^/]+\/[^/]+\/issues\//, "")}`);
        return gh.run(argv);
      },
    });
    let at = Date.parse("2026-10-02T10:00:00Z");
    const now = () => at += 1000;
    const ledger = createLedger({ path: join(scratch, `ledger-${Math.random().toString(36).slice(2)}.jsonl`), now });
    for (const { message, row } of [ASK_A, ASK_B]) {
      ledger.append(deliveryLine({ key: `request:${REPO}#${row}`, provider: "fake", status: STATUS.sent, providerMessageId: String(message), kind: "request", stateHash: "h" }));
    }
    const answers = createAnswers({ ledger, github: writer, chairman: CHAIRMAN, answerLabel: ANSWER_LABEL, now });
    const send = async (/** @type {{text: string}} */ { text }) => { events.push(`send ${text}`); return { messageRef: "1" }; };
    const consume = consumer({ ledger, say: (text) => events.push(text) });
    // The forwarder's converse port reports nothing, and the real `converse` reports an outcome: the wrapper drops it, as the forwarder does.
    const onForward = createForwarder({ answers, send, converse: async (accepted) => { await consume(accepted); }, log: (line) => events.push(`log ${line}`) });
    const stop = new AbortController();
    let served = false;
    const provider = {
      /** @param {number | undefined} cursor */
      async poll(cursor) {
        if (served) { stop.abort(); return { updates: [], cursor }; }
        served = true;
        return { updates: stream, cursor: 4 };
      },
      async answerCallbackQuery() {}, async leaveChat() {}, async deleteMessage() {}, async send() {},
    };
    await runListener({
      provider: /** @type {any} */ (provider), inbound: createInbound({ ledger, chairman: CHAIRMAN }), offsets: { path: "", read: () => undefined, write: () => {} },
      chairman: CHAIRMAN, onForward, sleep: async () => {}, signal: stop.signal,
    });
    return { events, rows };
  }

  test("a press, a reply and a plain message produce the row writes, the two replies and one pass-through, in that order", async () => {
    const { events, rows } = await listen(updates);
    assert.deepEqual(events, [
      "gh POST 2885/comments", "gh DELETE 2885/labels/needs%3Achairman", "gh POST 2885/labels", "send Recorded on a11ign/a11ign#2885: ceo has it.",
      "gh POST 2886/comments", "gh DELETE 2886/labels/needs%3Achairman", "gh POST 2886/labels", "send Recorded on a11ign/a11ign#2886: ceo has it.",
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
      const send = async (/** @type {{text: string}} */ { text }) => { say(`send ${text}`); return { messageRef: "2" }; };
      return createConverse({ chairman: CHAIRMAN, queuePath, ledger, send, agents: () => LIAISON_MID_TURN }).forward;
    });
    assert.deepEqual(events.filter((event) => event.startsWith("send Recorded")), ["send Recorded on a11ign/a11ign#2885: ceo has it.", "send Recorded on a11ign/a11ign#2886: ceo has it."]);
    assert.equal(events.at(-1), "send Got it, looking.");
    const queued = existsSync(queuePath) ? readFileSync(queuePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    assert.deepEqual(queued.map((entry) => entry.session), ["liaison"], "one order, for the liaison, and the answered reply was not queued");
    assert.match(queued[0].prompt, /how is the queue today\?/);
    assert.doesNotMatch(queued[0].prompt, /hold it until Monday/);
  });

  test("the control: the same stream with the reply's target removed writes nothing for it and passes it through, so a value without the target fails above", async () => {
    const { events } = await listen([updates[0], { update_id: 2, message: { ...updates[1].message, reply_to_message: undefined } }, updates[2]]);
    assert.deepEqual(events.filter((event) => event.startsWith("converse")), ["converse hold it until Monday", "converse how is the queue today?"]);
    assert.equal(events.filter((event) => event.startsWith("gh ")).length, 3, "only the press wrote to a row");
  });

  test("a GitHub failure is said to the chairman and the forwarder does not throw; nothing is passed through", async () => {
    /** @type {string[]} */
    const events = [];
    const failing = { async answer() { throw new Error("gh api: HTTP 503"); } };
    const forward = createForwarder({ answers: failing, send: async ({ text }) => { events.push(`send ${text}`); }, converse: () => { events.push("converse"); }, log: (line) => events.push(`log ${line}`) });
    await forward({ updateId: 9 });
    assert.equal(events.length, 2, events.join("\n"));
    assert.match(events[0], /^log messaging:listen: update 9 could not be answered: gh api: HTTP 503$/);
    assert.match(events[1], /^send Could not reach GitHub to record that\./);
  });
});
