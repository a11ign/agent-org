// no-token: clearBeforeOrder -- the real queue is driven only through queueOrLose (an append to a temp file); nothing here clears or prompts a session
// @ts-check
// CONVERSATION IN (a11ign/a11ign#2909 done-whens 1-4): an accepted chairman message is acknowledged AT ONCE, then becomes ONE queue entry for the `liaison`;
// nothing in `src/messaging/` queues for anyone else; `resolveSender` never yields the chairman.
//
// **THE CHAIRMAN REVERSED #3416'S "CEO IS NOT THE FALLBACK" (his order of 2026-10-04 19:55Z, a11ign/a11ign#3538).** A message the liaison's queue refuses, for ANY reason,
// is queued for `ceo` with a line saying why, and the chairman is told in plain words (no queue text, handoff, path or error class); only when `ceo`'s queue refuses too is it
// lost, and he is told that and asked to send it again. The tests that pinned the old rule ("... and ceo is NOT the fallback", "the queue's own words, verbatim") are
// rewritten below, not deleted: each now pins what replaced it.
//
// **TWO QUEUES, SAID OUT LOUD.** `prompt-session.mjs` reads the project's declaration when it is imported, so it cannot load in a bare checkout of
// this repository. The module under test loads the REAL queue on first use; this file therefore runs every behavioural case against
//   * `fake`: a port that writes the same entry shape and prints the same kind of refusal, always available, and
//   * `real`: `prompt-session.mjs`'s own `queueOrLose` over a real queue file, run when the host's declaration can be found (`AGENT_ORG_HOST`, else
//     the primary checkout's `host.json` where this host keeps it). When it cannot load, the `real` cases are SKIPPED WITH THE REFUSAL AS THE REASON,
//     and the "real queue loaded" test below says which of the two this run was: a skip that fires always would be a check that never runs.
// The fixtures that look like secrets are not needed here: the classifier is `inbound.mjs`'s and `inbound.test.mjs`'s.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ACKNOWLEDGEMENT, CHAIRMAN_SENDER, FALLBACK_RECIPIENT, PASSED_REFUSED, PASSED_SEAT_ABSENT, RECIPIENT, SOURCE_LINE, buttonOrderText, createConverse, notReached, provenanceText } from "./converse.mjs";
import { createFakeProvider } from "./fake-provider.ts";
import { createInbound } from "./inbound.mjs";
import { createLedger, readLedgerLines } from "./ledger.mjs";

// Where this host keeps the project declaration the real queue reads at import. Set BEFORE the first import of it, once, for this process.
const HOST_FILE = join(homedir(), "repos", "a11y-witness", ".agent-org", "host.json");
if (!process.env.AGENT_ORG_HOST && existsSync(HOST_FILE)) process.env.AGENT_ORG_HOST = HOST_FILE;

const CHAIRMAN = Object.freeze({ userId: 4242, chatId: 4242 });
const OTHER_CHAIRMAN = Object.freeze({ userId: 4243, chatId: 4243 });
const ROSTER = [{ label: "liaison", status: "idle" }, { label: "ceo", status: "idle" }, { label: "worker-7", status: "idle" }, { label: "reviewer-3", status: "idle" }];
const DEEP = 10;
const START = Date.parse("2026-10-02T10:00:00Z");

const scratch = mkdtempSync(join(tmpdir(), "messaging-converse-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextDir = 0;

/** @returns {Promise<{ port: any } | { reason: string }>} the real queue's pieces, or why it would not load here */
async function loadReal() {
  try {
    const [session, wake] = await Promise.all([import("../prompt-session.mjs"), import("../wake.mjs")]);
    return { port: { session, wake } };
  } catch (error) {
    return { reason: `the real queue cannot load here: ${String(/** @type {Error} */ (error).message).split("\n")[0]}` };
  }
}
const real = await loadReal();

/** @param {string} path @param {number} count a queue already holding `count` orders for `session` (the liaison unless said) @param {string} [session] */
function fillQueue(path, count, session = RECIPIENT) {
  for (let index = 0; index < count; index += 1) {
    const prompt = `earlier order ${index}`;
    const id = `handoff/${session}/${createHash("sha256").update(prompt).digest("hex").slice(0, 8)}`;
    appendFileSync(path, `${JSON.stringify({ id, session, prompt, queuedAt: START - 60_000, decision: false })}\n`);
  }
}

/** @param {string} path @returns {Record<string, any>[]} what the queue file holds */
function entries(path) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

/**
 * The fake queue port: what `queueOrLose` does that the module relies on, and nothing more. An unknown session and a deep queue are refused with
 * a message on stderr and an exit code; anything else is appended and reported QUEUED.
 */
const EXIT = { OK: 0, REFUSED: 1, QUEUED: 2 };
const fakeQueue = {
  EXIT,
  STANCE: /** @type {const} */ ({ DECISION: "decision", FYI: "fyi", UNDECLARED: "undeclared" }),
  attributed: (/** @type {string} */ text, /** @type {string | null} */ sender) => `Sent to you by \`${sender}\`:\n\n${text}`,
  handoffId: (/** @type {string} */ session, /** @type {string} */ prompt) => `handoff/${session}/${createHash("sha256").update(prompt).digest("hex").slice(0, 8)}`,
  readHandoffs: /** @type {(path: string) => any[]} */ (entries),
  queueOrLose(/** @type {Record<string, any>} */ { label, text, path, agents, sender }) {
    if (!agents?.some((/** @type {{label: string}} */ agent) => agent.label === label)) {
      process.stderr.write(`NOT PROMPTED, AND NOT QUEUED: no session named "${label}". Fix the name and run it again.\n`);
      return EXIT.REFUSED;
    }
    const waiting = entries(path).filter((entry) => entry.session === label).length;
    if (waiting >= DEEP) {
      process.stderr.write(`NOT PROMPTED, AND NOT QUEUED: "${label}" already has ${waiting} order(s) waiting.\nYOUR REPORT, UNCHANGED:\n${text}\n`);
      return EXIT.REFUSED;
    }
    const prompt = fakeQueue.attributed(text, sender);
    appendFileSync(path, `${JSON.stringify({ id: fakeQueue.handoffId(label, prompt), session: label, prompt, queuedAt: START, decision: false })}\n`);
    process.stderr.write("QUEUED\n");
    return EXIT.QUEUED;
  },
};

/** @param {number} id @param {Record<string, any>} [more] */
function chairmanUpdate(id, more = {}) {
  return { update_id: id, message: { message_id: 100 + id, from: { id: CHAIRMAN.userId }, chat: { id: CHAIRMAN.chatId, type: "private" }, text: "why did the merge queue stall?", ...more } };
}

/**
 * The queue, watched: what it printed on its own stderr is read HERE, independently of the module, so "sent unchanged" compares the chairman's phone with the queue's
 * own words and not with the module's idea of them. `queue` undefined is the module's default, the real port, which is not watched.
 * @param {Record<string, any> | undefined} queue
 */
function recordingQueue(queue, events = /** @type {string[]} */ ([])) {
  let words = "";
  if (!queue) return { port: undefined, words: () => words };
  const port = /** @type {import("./converse.mjs").QueuePort} */ ({
    ...queue,
    queueOrLose(/** @type {Record<string, any>} */ order) {
      events.push("queue");
      const original = process.stderr.write;
      words = "";
      process.stderr.write = /** @type {any} */ ((/** @type {any} */ chunk) => { words += String(chunk); return true; });
      try {
        return queue.queueOrLose(order);
      } finally {
        process.stderr.write = original;
        process.stderr.write(words);
      }
    },
  });
  return { port, words: () => words };
}

/** One run: an inbound over a real ledger, the module over a queue file, a fake provider as the chairman's phone. `queue` undefined is the REAL port. */
function harness({ queue, roster = ROSTER, send } = /** @type {Record<string, any>} */ ({})) {
  nextDir += 1;
  const dir = join(scratch, `run-${nextDir}`);
  const ledgerPath = join(dir, "ledger.jsonl");
  const queuePath = join(dir, "queue");
  const provider = createFakeProvider();
  const clock = { at: START };
  const ledger = createLedger({ path: ledgerPath, now: () => (clock.at += 1000) });
  const inbound = createInbound({ ledger, chairman: CHAIRMAN });
  /** What happened, in order: `send` for each message to the chairman, `queue` for each write attempt. The ack-before-write assertions read it. */
  const events = /** @type {string[]} */ ([]);
  const said = recordingQueue(queue, events);
  const tellChairman = send ?? ((/** @type {any} */ message) => provider.send(message));
  const converse = createConverse({ chairman: CHAIRMAN, queuePath, ledger, send: (message) => { events.push(`send: ${message.text}`); return tellChairman(message); }, agents: () => roster, now: () => clock.at, queue: said.port });
  /** @param {unknown} update @returns {any} the accepted value `handle` minted for it */
  const accept = (update) => {
    const action = inbound.handle(update);
    assert.equal(action.action, "forward", `the fixture update must be forwarded by the inbound core (it said ${action.action})`);
    return /** @type {any} */ (action).accepted;
  };
  return { queuePath, provider, clock, converse, accept, events, said: said.words, ledgerLines: () => readLedgerLines(ledgerPath), queued: () => entries(queuePath) };
}

/** @param {Record<string, any>} queue @param {string} label */
function cases(queue, label) {
  const ready = (/** @type {Record<string, any>} */ more = {}) => harness({ queue, ...more });

  test("done-when 1, and the POSITIVE CONTROL: the chairman's message IS queued, once, for the liaison and nobody else, with its provenance, and acknowledged once in plain words", async () => {
    const run = ready();
    const result = await run.converse.forward(run.accept(chairmanUpdate(1)));
    assert.equal(result.outcome, "queued");
    assert.equal(run.queued().length, 1, "exactly one queue entry");
    const [entry] = run.queued();
    assert.equal(entry.session, "liaison");
    assert.equal(entry.session, RECIPIENT);
    for (const line of [SOURCE_LINE, "Telegram message: 101 (update 1)", "Received: 2026-10-02T10:00:", "why did the merge queue stall?", CHAIRMAN_SENDER]) {
      assert.ok(entry.prompt.includes(line), `the entry carries ${JSON.stringify(line)}`);
    }
    assert.equal(run.provider.sent.length, 1, "exactly one acknowledgement");
    assert.equal(run.provider.sent[0].text, "Got it, looking.");
    assert.equal(run.provider.sent[0].text, ACKNOWLEDGEMENT);
    assert.equal(run.provider.sent[0].replyTo, "101", "the acknowledgement answers the chairman's own message");
  });

  test("done-when 2, THE ORDER: the acknowledgement is sent BEFORE the queue is written (it fails if the ack is moved after the write)", async () => {
    const run = ready();
    await run.converse.forward(run.accept(chairmanUpdate(20)));
    assert.deepEqual(run.events, ["send: Got it, looking.", "queue"]);
    assert.ok(run.events.indexOf("send: Got it, looking.") < run.events.indexOf("queue"));
  });

  test("done-when 4: the chairman's text reaches nobody's queue but the liaison's -- not ceo's, with ceo on the roster", async () => {
    const run = ready();
    await run.converse.forward(run.accept(chairmanUpdate(21, { text: "tell ceo the build is red" })));
    assert.deepEqual(run.queued().map((entry) => entry.session), ["liaison"]);
    assert.equal(run.queued().filter((entry) => entry.session === "ceo").length, 0);
    assert.ok(run.provider.sent.every((message) => !message.text.includes("build is red")), "the chat is not sent the words back either");
  });

  test("done-when 5: the ledger line carries `ackAt` and the handoff id, and no handoff id is in anything sent to the chat", async () => {
    const run = ready();
    await run.converse.forward(run.accept(chairmanUpdate(2)));
    const line = run.ledgerLines().find((entry) => entry.origin === "converse");
    assert.ok(line, "a conversation line was written");
    assert.deepEqual([line.updateId, line.messageRef, line.verdict, line.ackRef], [2, "102", "queued", "fake-1"]);
    assert.equal(line.handoff, run.queued()[0].id);
    assert.match(line.ackAt, /^2026-10-02T10:00:\d\d\.\d{3}Z$/);
    assert.ok(Date.parse(line.ackAt) >= START, "ackAt is a time one can subtract the inbound line's from");
    assert.ok(!JSON.stringify(run.ledgerLines()).includes("merge queue stall"), "the ledger does not hold the chairman's text");
    for (const message of run.provider.sent) assert.ok(!message.text.includes(line.handoff) && !/handoff/.test(message.text), "no handoff id reaches the chat");
  });

  test("two identical messages are two orders: the queue's id is a hash, so the ref and time in the text are what separate them", async () => {
    const run = ready();
    await run.converse.forward(run.accept(chairmanUpdate(3, { text: "ok" })));
    run.clock.at += 60_000;
    await run.converse.forward(run.accept(chairmanUpdate(4, { text: "ok" })));
    assert.equal(new Set(run.queued().map((entry) => entry.id)).size, 2);
    assert.equal(run.provider.sent.length, 2);
  });

  /** What a chairman must never read in what he is told: the queue's vocabulary, a handoff, a path, an error class, or a session he does not know by name. */
  const INTERNAL = /NOT PROMPTED|NOT QUEUED|queue|handoff|\.mjs|[/\\]|Error|\b(worker|reviewer)-\d+|\bwork:tick\b|prompt:session/i;
  /** @param {string} text */
  const plain = (text) => {
    assert.ok(!INTERNAL.test(text), `plain words, no internal text: ${JSON.stringify(text)}`);
    const names = text.match(/\b(liaison|ceo|orchestrator|product-manager|engineer|worker|reviewer)\b/g) ?? [];
    assert.ok(names.every((name) => name === RECIPIENT || name === FALLBACK_RECIPIENT), `only the two sessions he knows by name: ${names}`);
  };
  const WITHOUT_LIAISON = ROSTER.filter((agent) => agent.label !== RECIPIENT);

  test("done-when 1: the liaison seat ABSENT from the roster -- the message is queued for ceo, with its provenance and a line saying why, and the ledger says so", async () => {
    const run = ready({ roster: WITHOUT_LIAISON });
    const result = await run.converse.forward(run.accept(chairmanUpdate(5)));
    assert.equal(result.outcome, "rerouted-to-ceo");
    assert.notEqual(result.outcome, "refused");
    const [entry] = run.queued();
    assert.equal(run.queued().length, 1, "one entry, read back from the queue file");
    assert.equal(entry.session, FALLBACK_RECIPIENT);
    for (const line of [SOURCE_LINE, "This is the chairman speaking, not a session.", "Telegram message: 105 (update 5)", CHAIRMAN_SENDER, "why did the merge queue stall?",
      `It came to you, ${FALLBACK_RECIPIENT}, and not to the ${RECIPIENT}, because the ${RECIPIENT}'s queue refused it: NOT PROMPTED, AND NOT QUEUED:`]) {
      assert.ok(entry.prompt.includes(line), `ceo's entry carries ${JSON.stringify(line)}`);
    }
    assert.ok(entry.prompt.endsWith("\nwhy did the merge queue stall?"), "the chairman's words are still last");
    const line = run.ledgerLines().find((candidate) => candidate.origin === "converse");
    assert.ok(line, "the ledger holds the converse line");
    assert.equal(line.verdict, "rerouted-to-ceo");
    assert.equal(line.taker, FALLBACK_RECIPIENT);
    assert.equal(line.handoff, entry.id, "the ledger carries ceo's handoff id");
    assert.equal(run.ledgerLines().filter((candidate) => candidate.origin === "converse").length, 1, "one line per message");
    assert.match(line.refusals[0], /^NOT PROMPTED, AND NOT QUEUED: /, "the queue's refusal is kept in the ledger, first line");
    assert.deepEqual(run.provider.sent.map((message) => message.text), [ACKNOWLEDGEMENT, PASSED_SEAT_ABSENT]);
  });

  test("done-when 1: the liaison's inbox FULL -- the message is queued for ceo, the liaison's queue is no deeper, and the ledger says so", async () => {
    const run = ready();
    fillQueue(run.queuePath, DEEP);
    const result = await run.converse.forward(run.accept(chairmanUpdate(6)));
    assert.equal(result.outcome, "rerouted-to-ceo");
    assert.equal(run.queued().filter((entry) => entry.session === RECIPIENT).length, DEEP, "the refused message did not join the queue it was refused for joining");
    const [entry] = run.queued().filter((candidate) => candidate.session === FALLBACK_RECIPIENT);
    assert.ok(entry.prompt.includes("why did the merge queue stall?") && entry.prompt.includes(SOURCE_LINE));
    assert.ok(entry.prompt.includes(`because the ${RECIPIENT}'s queue refused it: NOT PROMPTED, AND NOT QUEUED: "liaison" already has ${DEEP} order(s) waiting`), "the line names the reason");
    assert.ok(entry.prompt.split("why did the merge queue stall?").length === 2, "the refusal text, which repeats the message, is cut to its first line: the words appear once");
    const line = run.ledgerLines().find((candidate) => candidate.origin === "converse");
    assert.ok(line, "the ledger holds the converse line");
    assert.deepEqual([line.verdict, line.taker, line.handoff], ["rerouted-to-ceo", FALLBACK_RECIPIENT, entry.id]);
    assert.ok(!JSON.stringify(line).includes("why did the merge queue stall?"), "the ledger holds refs and a verdict, never the chairman's words");
    assert.deepEqual(run.provider.sent.map((message) => message.text), [ACKNOWLEDGEMENT, PASSED_REFUSED]);
  });

  test("done-when 1: a liaison queue that says QUEUED and holds nothing (or cannot be written) is a refusal too, and goes to ceo", async () => {
    const forgetful = { ...queue, queueOrLose: (/** @type {Record<string, any>} */ order) => (order.label === RECIPIENT ? queue.EXIT.QUEUED : queue.queueOrLose(order)) };
    const run = harness({ queue: forgetful });
    const result = await run.converse.forward(run.accept(chairmanUpdate(7)));
    assert.equal(result.outcome, "rerouted-to-ceo");
    assert.deepEqual(run.queued().map((entry) => entry.session), [FALLBACK_RECIPIENT]);
    const line = run.ledgerLines().find((candidate) => candidate.origin === "converse");
    assert.ok(line, "the ledger holds the converse line");
    assert.match(line.refusals[0], /not in the queue file/);
  });

  test("done-when 2: what he is told after \"Got it\" for a rerouted message holds none of the queue's words, a handoff, a path, an error class or a session he does not know", async () => {
    for (const setup of [() => ready({ roster: WITHOUT_LIAISON }), () => { const run = ready(); fillQueue(run.queuePath, DEEP); return run; }]) {
      const run = setup();
      await run.converse.forward(run.accept(chairmanUpdate(5)));
      assert.equal(run.provider.sent.length, 2);
      plain(run.provider.sent[1].text);
    }
    assert.equal(PASSED_SEAT_ABSENT, "The liaison isn't running; I've passed this to ceo.");
    assert.throws(() => plain("NOT PROMPTED, AND NOT QUEUED: no session named \"liaison\""), "the matcher notices the old refusal text (it can fail)");
    assert.throws(() => plain("sent to worker-7"), "and a session he does not know");
  });

  test("done-when 2: ceo's queue refusing too is the one case a message is lost: he is told so in plain words and asked to send it again, and the ledger says refused", async () => {
    const absent = ready({ roster: ROSTER.filter((agent) => agent.label !== RECIPIENT && agent.label !== FALLBACK_RECIPIENT) });
    const full = ready();
    fillQueue(full.queuePath, DEEP);
    fillQueue(full.queuePath, DEEP, FALLBACK_RECIPIENT);
    for (const run of [absent, full]) {
      const before = run.queued().length;
      const result = await run.converse.forward(run.accept(chairmanUpdate(5)));
      assert.equal(result.outcome, "refused");
      assert.equal(run.queued().length, before, "nothing was queued for anybody");
      assert.deepEqual(run.provider.sent.map((message) => message.text), [ACKNOWLEDGEMENT, notReached()]);
      plain(run.provider.sent[1].text);
      assert.match(run.provider.sent[1].text, /nothing was delivered\. Please send it again\.$/);
      const line = run.ledgerLines().find((candidate) => candidate.origin === "converse");
      assert.ok(line, "the ledger holds the converse line");
      assert.deepEqual([line.verdict, line.taker, line.handoff, line.refusals.length], ["refused", null, null, 2], "both refusals are kept in the ledger");
    }
  });

  test("done-when 2, the POSITIVE CONTROL: the liaison present -- one message, one acknowledgement and no extra message, nothing for ceo", async () => {
    const run = ready();
    const result = await run.converse.forward(run.accept(chairmanUpdate(5)));
    assert.equal(result.outcome, "queued");
    assert.deepEqual(run.queued().map((entry) => entry.session), [RECIPIENT]);
    assert.deepEqual(run.provider.sent.map((message) => message.text), [ACKNOWLEDGEMENT]);
    const line = run.ledgerLines().find((candidate) => candidate.origin === "converse");
    assert.ok(line, "the ledger holds the converse line");
    assert.deepEqual([line.verdict, line.taker, line.refusals], ["queued", RECIPIENT, []]);
    assert.ok(!run.queued()[0].prompt.includes("came to you"), "no reroute line when the liaison took it");
  });

  test("a value `createInbound` did not mint for THIS chairman queues nothing and sends nothing", async () => {
    const run = ready();
    const minted = run.accept(chairmanUpdate(8));
    const forged = { kind: "message", updateId: 9, userId: 4242, chatId: 4242, messageId: 9, text: "x" };
    const other = createInbound({ ledger: createLedger({ path: join(scratch, "other.jsonl"), now: () => START }), chairman: OTHER_CHAIRMAN });
    const strangers = other.handle({ update_id: 1, message: { message_id: 1, from: { id: OTHER_CHAIRMAN.userId }, chat: { id: OTHER_CHAIRMAN.chatId, type: "private" }, text: "hi" } });
    for (const value of [forged, { ...minted }, JSON.parse(JSON.stringify(minted)), /** @type {any} */ (strangers).accepted, null, undefined]) {
      assert.equal((await run.converse.forward(/** @type {any} */ (value))).outcome, "not-accepted");
    }
    assert.equal(run.queued().length, 0);
    assert.equal(run.provider.sent.length, 0);
  });

  test("a button press is not conversation: it is the answers path's, and nothing here queues it", async () => {
    const run = ready();
    const press = { update_id: 10, callback_query: { id: "cbq-1", from: { id: CHAIRMAN.userId }, data: "ans:A", message: { message_id: 5, chat: { id: CHAIRMAN.chatId, type: "private" } } } };
    assert.equal((await run.converse.forward(run.accept(press))).outcome, "not-conversation");
    assert.equal(run.queued().length, 0);
    assert.equal(run.provider.sent.length, 0);
  });

  test("a message that NAMES a worker, or ceo, still queues for the liaison only", async () => {
    const run = ready();
    const minted = run.accept(chairmanUpdate(11, { text: "worker-7 should take the next row, and tell reviewer-3 and ceo to look at it" }));
    await run.converse.forward(minted);
    const addressees = run.queued().map((entry) => entry.session);
    assert.deepEqual(addressees, ["liaison"]);
    assert.ok(addressees.every((session) => !/^(worker|reviewer)-|^ceo$/.test(session)));
  });

  test("a refused acknowledgement does not stop the message being queued, and is reported", async () => {
    const run = harness({ queue, send: async () => { throw new Error("telegram is down"); } });
    await assert.rejects(() => run.converse.forward(run.accept(chairmanUpdate(12))), /acknowledgement could not be sent/);
    assert.equal(run.queued().length, 1, "the message is queued whatever the acknowledgement did");
    assert.equal(run.ledgerLines().find((line) => line.origin === "converse")?.error, "Error: telegram is down");
  });

  test("a button's order for the liaison: ONE entry, for the liaison and nobody else, with its provenance, and nothing sent to the chairman here", async () => {
    const run = ready({ roster: ROSTER });
    const result = await run.converse.orderLiaison({ text: "the chairman asked for more on a11ign/a11ign#2885:\n\n> row 2885 needs you", messageRef: "501" });
    assert.equal(result.queued, true);
    assert.equal(run.queued().length, 1);
    const [entry] = run.queued();
    assert.equal(entry.session, RECIPIENT);
    assert.equal(result.handoff, entry.id);
    for (const line of [SOURCE_LINE, "Telegram message: 501 (a button press)", "Received: 2026-10-02T10:00:", "the chairman asked for more on a11ign/a11ign#2885", CHAIRMAN_SENDER]) {
      assert.ok(entry.prompt.includes(line), `the entry carries ${JSON.stringify(line)}`);
    }
    assert.deepEqual(run.queued().map((queued) => queued.session).filter((session) => session !== RECIPIENT), [], "nobody else");
    assert.equal(run.provider.sent.length, 0, "telling the chairman is the caller's");
    assert.ok(buttonOrderText({ text: "t", messageRef: "7" }, START).endsWith("\nt"), "the words are last");
  });

  test("done-when 3: a button's order the liaison's queue refuses (seat absent, or inbox full) is queued for ceo with the reason, and the chairman's line is plain; the control above queues for the liaison", async () => {
    const absent = ready({ roster: WITHOUT_LIAISON });
    const rerouted = await absent.converse.orderLiaison({ text: "x", messageRef: "501" });
    assert.deepEqual([rerouted.queued, rerouted.taker, rerouted.told], [true, FALLBACK_RECIPIENT, PASSED_SEAT_ABSENT]);
    const [entry] = absent.queued();
    assert.equal(entry.session, FALLBACK_RECIPIENT);
    assert.equal(rerouted.handoff, entry.id);
    assert.ok(entry.prompt.includes("Telegram message: 501 (a button press)") && entry.prompt.includes(`because the ${RECIPIENT}'s queue refused it: NOT PROMPTED`));
    assert.ok(entry.prompt.endsWith("\nx"), "the words are last");
    assert.ok(rerouted.told);
    plain(rerouted.told);

    const full = ready({ roster: ROSTER });
    fillQueue(full.queuePath, DEEP);
    const second = await full.converse.orderLiaison({ text: "x", messageRef: "501" });
    assert.deepEqual([second.queued, second.taker, second.told], [true, FALLBACK_RECIPIENT, PASSED_REFUSED]);
    assert.equal(full.queued().filter((queued) => queued.session === RECIPIENT).length, DEEP, "the liaison's queue is no deeper");

    const control = await ready({ roster: ROSTER }).converse.orderLiaison({ text: "x", messageRef: "501" });
    assert.deepEqual([control.queued, control.taker, control.told], [true, RECIPIENT, null]);
  });

  test("done-when 3: a button's order neither queue takes is not queued and carries no plain-words claim of delivery; `say` is the ledger's and `told` is null", async () => {
    const neither = ready({ roster: [{ label: "worker-7", status: "idle" }] });
    const lost = await neither.converse.orderLiaison({ text: "x", messageRef: "501" });
    assert.deepEqual([lost.queued, lost.taker, lost.told, lost.handoff], [false, null, null, null]);
    assert.match(lost.say, /^not delivered: NOT PROMPTED, AND NOT QUEUED: .* \| NOT PROMPTED, AND NOT QUEUED: /);
    assert.equal(neither.queued().length, 0);
  });

  test("the queue is told WHY: a button's order says a button, and a message says a message (it is what the queue repeats when it refuses)", async () => {
    /** @type {unknown[]} */
    const whys = [];
    const spy = { ...queue, queueOrLose: (/** @type {Record<string, any>} */ order) => { whys.push(order.why); return queue.queueOrLose(order); } };
    const run = harness({ queue: spy });
    await run.converse.orderLiaison({ text: "x", messageRef: "501" });
    await run.converse.forward(run.accept(chairmanUpdate(7)));
    assert.deepEqual(whys, ["the chairman pressed a button for the liaison", "the chairman wrote to the liaison"]);
  });

  test("a queue that says QUEUED and holds nothing is not an order anybody has: both unverified is not delivered", async () => {
    const run = harness({ queue: { ...queue, queueOrLose: () => queue.EXIT.QUEUED }, roster: ROSTER });
    const result = await run.converse.orderLiaison({ text: "x", messageRef: "501" });
    assert.equal(result.queued, false);
    assert.match(result.say, /^not delivered: .*not in the queue file/);
  });

  test("a message neither queue holds (both say QUEUED, neither entry is there) is told as not delivered, and the outcome is `unverified`", async () => {
    const run = harness({ queue: { ...queue, queueOrLose: () => queue.EXIT.QUEUED } });
    const result = await run.converse.forward(run.accept(chairmanUpdate(7)));
    assert.equal(result.outcome, "unverified");
    assert.deepEqual(run.provider.sent.map((message) => message.text), [ACKNOWLEDGEMENT, notReached()]);
    assert.equal(run.ledgerLines().find((line) => line.origin === "converse")?.handoff, null);
  });

  test(`${label}: provenanceText no longer tells the reader to avoid prompt:session (that is the liaison's brief, B3, and ceo is reached through it)`, () => {
    assert.ok(!/prompt:session/.test(provenanceText({ messageId: 7, updateId: 3, text: "the words" }, START)));
  });

  test(`${label}: provenanceText names the source, the message, the time, and puts the chairman's words last`, () => {
    const text = provenanceText({ messageId: 7, updateId: 3, text: "the words" }, START);
    assert.deepEqual(text.split("\n").slice(1, 4), [SOURCE_LINE, "Telegram message: 7 (update 3)", "Received: 2026-10-02T10:00:00.000Z"]);
    assert.ok(text.endsWith("\nthe words"));
  });
}

describe("fake queue port", () => cases(fakeQueue, "fake"));

describe("real queue (prompt-session.mjs)", { skip: "reason" in real ? /** @type {{reason: string}} */ (real).reason : false }, () => {
  const { session, wake } = "port" in real ? real.port : { session: null, wake: null };
  const port = session && wake ? { queueOrLose: session.queueOrLose, attributed: session.attributed, EXIT: session.EXIT, STANCE: session.STANCE, handoffId: wake.handoffId, readHandoffs: wake.readHandoffs, realPort: true } : null;
  cases(/** @type {any} */ (port ?? fakeQueue), "real");
});

describe("the queue file, when the listener names none", () => {
  test("the port's own path is used: an order lands there, and the acknowledgement is read back from it", async () => {
    const run = harness({ queue: fakeQueue });
    const path = join(dirname(run.queuePath), "the-port-names-this");
    const lone = createConverse({ chairman: CHAIRMAN, ledger: createLedger({ path: join(dirname(path), "l.jsonl"), now: () => START }), send: (m) => run.provider.send(m),
      agents: () => ROSTER, now: () => START, queue: { ...fakeQueue, defaultQueuePath: () => path } });
    const outcome = await lone.forward(run.accept(chairmanUpdate(1)));
    assert.equal(outcome.outcome, "queued");
    assert.deepEqual(entries(path).map((entry) => entry.session), ["liaison"]);
  });

  test("with no path given and a port that names none, it throws rather than queueing nowhere", async () => {
    const run = harness({ queue: fakeQueue });
    const lone = createConverse({ chairman: CHAIRMAN, ledger: createLedger({ path: join(dirname(run.queuePath), "l2.jsonl"), now: () => START }), send: (m) => run.provider.send(m),
      agents: () => ROSTER, now: () => START, queue: fakeQueue });
    await assert.rejects(lone.forward(run.accept(chairmanUpdate(2))), /no queue path was given/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// DONE-WHEN 3, THE SCAN: every caller of the queue under `src/messaging/`, found by reading the source, and the one call's label.

const MESSAGING = fileURLToPath(new URL(".", import.meta.url));
/** What reaches an order to a session: the queue's writers and the two modules that own them. `herdr ... agent prompt` is the direct path. */
const QUEUE_CALLERS = /\b(queueOrLose|queueHandoff|promptOrQueue|clearThenPrompt)\b|prompt-session\.mjs|\/wake\.mjs|["']agent["']\s*,\s*["']prompt["']/;

/** @param {string} dir @param {string} [base] @returns {string[]} every non-test `.mjs` under `dir`, as paths relative to `base` (`dir` itself unless a caller walks a subdirectory) */
function sourceFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, base);
    return entry.name.endsWith(".mjs") && !entry.name.includes(".test.") ? [relative(base, path)] : [];
  });
}

/** @param {string} source @returns {string} the code with comment lines removed: the call is judged by what it does and not by what the header says */
function withoutComments(source) {
  return source.split("\n").filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)).join("\n");
}

/** @param {string} dir @returns {string[]} the files under `dir` that call the queue, comments aside */
function queueCallersIn(dir) {
  return sourceFiles(dir).filter((file) => QUEUE_CALLERS.test(withoutComments(readFileSync(join(dir, file), "utf8"))));
}

describe("done-when 1: no queue entry is ever addressed to anyone but the liaison by this module (one caller, one label)", () => {
  const callers = queueCallersIn(MESSAGING);

  test("the scan finds the caller it is meant to find (its positive control), and the matcher notices each way to queue", () => {
    assert.ok(sourceFiles(MESSAGING).length > 10, "the walk reached the messaging sources");
    assert.ok(callers.includes("converse.mjs"), "converse.mjs is the caller the scan exists to bound");
    for (const sample of ["queueHandoff(path, { session: 'worker-1' })", "queueOrLose({})", "promptOrQueue(x)", "import './prompt-session.mjs'", "run(['agent', 'prompt', 'worker-1'])"]) {
      assert.ok(QUEUE_CALLERS.test(sample), `the matcher notices ${sample}`);
    }
  });

  test("converse.mjs is the ONLY file under src/messaging/ that queues or prompts", () => {
    assert.deepEqual(callers, ["converse.mjs"]);
  });

  test("THE CONTROL THE SCAN CAN FAIL: a directory holding converse.mjs and a fixture with a second caller is refused (two callers, not one)", () => {
    const fixture = join(scratch, "scan-fixture");
    mkdirSync(fixture, { recursive: true });
    copyFileSync(join(MESSAGING, "converse.mjs"), join(fixture, "converse.mjs"));
    assert.deepEqual(queueCallersIn(fixture), ["converse.mjs"], "without the second caller the copy passes, so the next failure is the fixture's");
    writeFileSync(join(fixture, "second-caller.mjs"), 'import { queueOrLose } from "../prompt-session.mjs";\nqueueOrLose({ label: "ceo", text: "x" });\n');
    assert.deepEqual(queueCallersIn(fixture), ["converse.mjs", "second-caller.mjs"]);
    assert.notDeepEqual(queueCallersIn(fixture), ["converse.mjs"], "the assertion above would fail on this directory");
  });

  test("its one call names the recipient by a constant: the liaison first, ceo only as the fallback, each written once and no other label anywhere in its code", () => {
    const code = withoutComments(readFileSync(join(MESSAGING, "converse.mjs"), "utf8"));
    assert.equal(RECIPIENT, "liaison");
    assert.equal(FALLBACK_RECIPIENT, "ceo");
    assert.match(code, /export const RECIPIENT = "liaison";/);
    assert.match(code, /export const FALLBACK_RECIPIENT = "ceo";/);
    assert.equal((code.match(/\.queueOrLose\(/g) ?? []).length, 1, "one call to the queue");
    assert.deepEqual(code.match(/\blabel: [^,]+,/g), ["label: recipient,"], "the call's label is a parameter; no other `label:` is passed anywhere");
    assert.equal([...code.matchAll(/(?<!function )\benqueue\(q, recipient, /g)].length, 1, "enqueue is reached only through attempt");
    const attempts = [...code.matchAll(/(?<!function )\battempt\(q, (\w+), /g)].map((match) => match[1]);
    assert.deepEqual(attempts, ["RECIPIENT", "FALLBACK_RECIPIENT"], "attempt is reached twice, the liaison first and the fallback second, by the constants");
    assert.equal([...code.matchAll(/(?<!function )\bsubmit\(await port\(\), /g)].length, 2, "submit is reached twice: once for a message, once for a button, and neither names a recipient");
    assert.equal((code.match(/"ceo"/g) ?? []).length, 1, "ceo is named once, as the fallback constant, and nowhere else");
    assert.equal((code.match(/"liaison"/g) ?? []).length, 1, "and the liaison once, as its own");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// DONE-WHEN 4: `resolveSender`, over every workspace id a fixture holds, never yields the chairman's sender. Needs the real `prompt-session.mjs`.

describe("done-when 4: resolveSender never yields the chairman sender", { skip: "reason" in real ? /** @type {{reason: string}} */ (real).reason : false }, () => {
  const WORKSPACES = [["w1", "ceo"], ["w2", "product-manager"], ["w3", "orchestrator"], ["w4", "worker-2909"], ["w5", "reviewer-3"], ["w6", "chairman"], ["w7", "chairman via telegram"]]
    .map(([workspace_id, label]) => ({ workspace_id, label, agent_status: "idle" }));
  const LOOKALIKE = "w7";
  const run = () => JSON.stringify({ result: { workspaces: WORKSPACES } });
  const resolve = (/** @type {string | undefined} */ id) => /** @type {any} */ (real).port.session.resolveSender(run, id);

  test("every id in the fixture resolves to ITS OWN label (the positive control: a resolver that returns null for all would pass the next assertion), and none is the chairman's", () => {
    for (const { workspace_id, label } of WORKSPACES.filter((w) => w.workspace_id !== LOOKALIKE)) {
      assert.equal(resolve(workspace_id), label);
      assert.notEqual(resolve(workspace_id), CHAIRMAN_SENDER);
    }
  });

  test("a workspace LABELLED with the chairman's sender resolves to nobody, not to the chairman (a11ign/a11ign#3060)", () => {
    assert.equal(resolve(LOOKALIKE), null);
  });

  test("an id herdr does not list, or no id at all, resolves to nobody rather than to the chairman", () => {
    for (const id of ["w99", "", undefined, "chairman via Telegram", "converse"]) assert.equal(resolve(id), null);
  });
});

test("which queue this run exercised: a skipped `real` suite names its reason, and a host run proves it loaded", () => {
  if ("reason" in real) {
    assert.match(real.reason, /cannot load here/, "the skip carries the refusal");
    return;
  }
  assert.equal(typeof real.port.session.queueOrLose, "function", "the real queueOrLose was the one driven");
});
