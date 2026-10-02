// no-token: clearBeforeOrder -- the real queue is driven only through queueOrLose (an append to a temp file); nothing here clears or prompts a session
// @ts-check
// CONVERSATION IN (a11ign/a11ign#2909 done-whens 1-4): an accepted chairman message becomes ONE queue entry for `ceo` and ONE acknowledgement;
// a queue refusal reaches the chairman unchanged; nothing in `src/messaging/` queues for anyone else; `resolveSender` never yields the chairman.
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
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { CHAIRMAN_SENDER, RECIPIENT, SOURCE_LINE, createConverse, provenanceText } from "./converse.mjs";
import { createFakeProvider } from "./fake-provider.mjs";
import { createInbound } from "./inbound.mjs";
import { createLedger, readLedgerLines } from "./ledger.mjs";

// Where this host keeps the project declaration the real queue reads at import. Set BEFORE the first import of it, once, for this process.
const HOST_FILE = join(homedir(), "repos", "a11y-witness", ".agent-org", "host.json");
if (!process.env.AGENT_ORG_HOST && existsSync(HOST_FILE)) process.env.AGENT_ORG_HOST = HOST_FILE;

const CHAIRMAN = Object.freeze({ userId: 4242, chatId: 4242 });
const OTHER_CHAIRMAN = Object.freeze({ userId: 4243, chatId: 4243 });
const ROSTER = [{ label: "ceo", status: "idle" }, { label: "worker-7", status: "idle" }, { label: "reviewer-3", status: "idle" }];
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

/** @param {string} path @param {number} count a queue already holding `count` orders for `ceo` */
function fillQueue(path, count) {
  for (let index = 0; index < count; index += 1) {
    const prompt = `earlier order ${index}`;
    const id = `handoff/ceo/${createHash("sha256").update(prompt).digest("hex").slice(0, 8)}`;
    appendFileSync(path, `${JSON.stringify({ id, session: "ceo", prompt, queuedAt: START - 60_000, decision: false })}\n`);
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
  STANCE: { DECISION: "decision", FYI: "fyi", UNDECLARED: "undeclared" },
  attributed: (/** @type {string} */ text, /** @type {string | null} */ sender) => `Sent to you by \`${sender}\`:\n\n${text}`,
  handoffId: (/** @type {string} */ session, /** @type {string} */ prompt) => `handoff/${session}/${createHash("sha256").update(prompt).digest("hex").slice(0, 8)}`,
  readHandoffs: entries,
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

/** @param {Record<string, any>} [more] */
function chairmanUpdate(id, more = {}) {
  return { update_id: id, message: { message_id: 100 + id, from: { id: CHAIRMAN.userId }, chat: { id: CHAIRMAN.chatId, type: "private" }, text: "why did the merge queue stall?", ...more } };
}

/**
 * The queue, watched: what it printed on its own stderr is read HERE, independently of the module, so "sent unchanged" compares the chairman's phone with the queue's
 * own words and not with the module's idea of them. `queue` undefined is the module's default, the real port, which is not watched.
 * @param {Record<string, any> | undefined} queue
 */
function recordingQueue(queue) {
  let words = "";
  if (!queue) return { port: undefined, words: () => words };
  const port = {
    ...queue,
    queueOrLose(/** @type {Record<string, any>} */ order) {
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
  };
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
  const said = recordingQueue(queue);
  const converse = createConverse({ chairman: CHAIRMAN, queuePath, ledger, send: send ?? ((message) => provider.send(message)), agents: () => roster, now: () => clock.at, queue: said.port });
  /** @param {unknown} update @returns {any} the accepted value `handle` minted for it */
  const accept = (update) => {
    const action = inbound.handle(update);
    assert.equal(action.action, "forward", `the fixture update must be forwarded by the inbound core (it said ${action.action})`);
    return /** @type {any} */ (action).accepted;
  };
  return { queuePath, provider, clock, converse, accept, said: said.words, ledgerLines: () => readLedgerLines(ledgerPath), queued: () => entries(queuePath) };
}

/** @param {Record<string, any>} queue */
function cases(queue, label) {
  const ready = (/** @type {Record<string, any>} */ more = {}) => harness({ queue, ...more });

  test("done-when 1, and the POSITIVE CONTROL: the chairman's message IS queued, once, for ceo, with its provenance, and acknowledged once", async () => {
    const run = ready();
    const result = await run.converse.forward(run.accept(chairmanUpdate(1)));
    assert.equal(result.outcome, "queued");
    assert.equal(run.queued().length, 1, "exactly one queue entry");
    const [entry] = run.queued();
    assert.equal(entry.session, RECIPIENT);
    for (const line of [SOURCE_LINE, "Telegram message: 101 (update 1)", "Received: 2026-10-02T10:00:", "why did the merge queue stall?", CHAIRMAN_SENDER]) {
      assert.ok(entry.prompt.includes(line), `the entry carries ${JSON.stringify(line)}`);
    }
    assert.equal(run.provider.sent.length, 1, "exactly one acknowledgement");
    assert.equal(run.provider.sent[0].text, `queued for ceo, handoff ${entry.id}`);
    assert.equal(run.provider.sent[0].replyTo, "101", "the acknowledgement answers the chairman's own message");
  });

  test("the ledger holds the chain (message -> handoff -> acknowledgement) and never the words", async () => {
    const run = ready();
    await run.converse.forward(run.accept(chairmanUpdate(2)));
    const line = run.ledgerLines().find((entry) => entry.origin === "converse");
    assert.ok(line, "a conversation line was written");
    assert.deepEqual([line.updateId, line.messageRef, line.verdict, line.ackRef], [2, "102", "queued", "fake-1"]);
    assert.equal(line.handoff, run.queued()[0].id);
    assert.ok(!JSON.stringify(run.ledgerLines()).includes("merge queue stall"), "the ledger does not hold the chairman's text");
  });

  test("two identical messages are two orders: the queue's id is a hash, so the ref and time in the text are what separate them", async () => {
    const run = ready();
    await run.converse.forward(run.accept(chairmanUpdate(3, { text: "ok" })));
    run.clock.at += 60_000;
    await run.converse.forward(run.accept(chairmanUpdate(4, { text: "ok" })));
    assert.equal(new Set(run.queued().map((entry) => entry.id)).size, 2);
    assert.equal(run.provider.sent.length, 2);
  });

  test("done-when 2: a queue refusal -- an unknown session -- is sent to the chairman unchanged, and nothing is queued", async () => {
    const run = ready({ roster: [{ label: "worker-7", status: "idle" }] });
    const result = await run.converse.forward(run.accept(chairmanUpdate(5)));
    assert.equal(result.outcome, "refused");
    assert.equal(run.queued().length, 0);
    assert.equal(run.provider.sent.length, 1);
    assert.equal(run.provider.sent[0].text, run.said().trim());
    assert.match(run.provider.sent[0].text, /NOT PROMPTED, AND NOT QUEUED/);
  });

  test("done-when 2: a queue refusal -- a full inbox -- is sent unchanged, and the queue is no deeper", async () => {
    const run = ready();
    fillQueue(run.queuePath, DEEP);
    const result = await run.converse.forward(run.accept(chairmanUpdate(6)));
    assert.equal(result.outcome, "refused");
    assert.equal(run.queued().length, DEEP, "the refused message did not join the queue it was refused for joining");
    assert.equal(run.provider.sent[0].text, run.said().trim());
    assert.ok(run.provider.sent[0].text.includes("why did the merge queue stall?"), "the refusal returns the message, so it exists somewhere");
  });

  test("a queue that says QUEUED and holds nothing is reported as NOT delivered, never acknowledged as queued", async () => {
    const liar = { ...queue, queueOrLose: () => queue.EXIT.QUEUED };
    const run = harness({ queue: liar });
    const result = await run.converse.forward(run.accept(chairmanUpdate(7)));
    assert.equal(result.outcome, "unverified");
    assert.match(run.provider.sent[0].text, /NOT delivered/);
    assert.ok(!/^queued for/.test(run.provider.sent[0].text));
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
    const press = { update_id: 10, callback_query: { id: "cbq-1", from: { id: CHAIRMAN.userId }, data: "approve:2885", message: { message_id: 5, chat: { id: CHAIRMAN.chatId, type: "private" } } } };
    assert.equal((await run.converse.forward(run.accept(press))).outcome, "not-conversation");
    assert.equal(run.queued().length, 0);
    assert.equal(run.provider.sent.length, 0);
  });

  test("done-when 3 (behaviour): a message that NAMES a worker still queues for ceo only", async () => {
    const run = ready();
    const minted = run.accept(chairmanUpdate(11, { text: "worker-7 should take the next row, and tell reviewer-3 to look at it" }));
    await run.converse.forward(minted);
    const addressees = run.queued().map((entry) => entry.session);
    assert.deepEqual(addressees, ["ceo"]);
    assert.ok(addressees.every((session) => !/^(worker|reviewer)-/.test(session)));
  });

  test("a refused acknowledgement does not unqueue the message, and is reported", async () => {
    const run = harness({ queue, send: async () => { throw new Error("telegram is down"); } });
    await assert.rejects(() => run.converse.forward(run.accept(chairmanUpdate(12))), /acknowledgement could not be sent/);
    assert.equal(run.queued().length, 1, "the message is queued whatever the acknowledgement did");
    assert.equal(run.ledgerLines().find((line) => line.origin === "converse")?.error, "Error: telegram is down");
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

// ---------------------------------------------------------------------------------------------------------------------------------------------
// DONE-WHEN 3, THE SCAN: every caller of the queue under `src/messaging/`, found by reading the source, and the one call's label.

const MESSAGING = fileURLToPath(new URL(".", import.meta.url));
/** What reaches an order to a session: the queue's writers and the two modules that own them. `herdr ... agent prompt` is the direct path. */
const QUEUE_CALLERS = /\b(queueOrLose|queueHandoff|promptOrQueue|clearThenPrompt)\b|prompt-session\.mjs|\/wake\.mjs|["']agent["']\s*,\s*["']prompt["']/;

/** @param {string} dir @returns {string[]} every non-test `.mjs` under `dir`, as paths relative to `MESSAGING` */
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".mjs") && !entry.name.includes(".test.") ? [relative(MESSAGING, path)] : [];
  });
}

/** @param {string} source @returns {string} the code with comment lines removed: the call is judged by what it does and not by what the header says */
function withoutComments(source) {
  return source.split("\n").filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)).join("\n");
}

describe("done-when 3: no queue entry is ever addressed to a worker or reviewer by this module", () => {
  const callers = sourceFiles(MESSAGING).filter((file) => QUEUE_CALLERS.test(withoutComments(readFileSync(join(MESSAGING, file), "utf8"))));

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

  test("its one call names the recipient by the constant, which is ceo, and no other label is anywhere in its code", () => {
    const code = withoutComments(readFileSync(join(MESSAGING, "converse.mjs"), "utf8"));
    assert.equal(RECIPIENT, "ceo");
    assert.match(code, /export const RECIPIENT = "ceo";/);
    assert.equal((code.match(/\.queueOrLose\(/g) ?? []).length, 1, "one call to the queue");
    assert.deepEqual(code.match(/\blabel: [^,]+,/g), ["label: RECIPIENT,"], "the call's label is the constant; no other `label:` is passed anywhere");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// DONE-WHEN 4: `resolveSender`, over every workspace id a fixture holds, never yields the chairman's sender. Needs the real `prompt-session.mjs`.

describe("done-when 4: resolveSender never yields the chairman sender", { skip: "reason" in real ? /** @type {{reason: string}} */ (real).reason : false }, () => {
  const WORKSPACES = [["w1", "ceo"], ["w2", "product-manager"], ["w3", "orchestrator"], ["w4", "worker-2909"], ["w5", "reviewer-3"], ["w6", "chairman"], ["w7", "chairman via telegram"]]
    .map(([workspace_id, label]) => ({ workspace_id, label, agent_status: "idle" }));
  const run = () => JSON.stringify({ result: { workspaces: WORKSPACES } });
  const resolve = (/** @type {string | undefined} */ id) => /** @type {any} */ (real).port.session.resolveSender(run, id);

  test("every id in the fixture resolves to ITS OWN label (the positive control: a resolver that returns null for all would pass the next assertion), and none is the chairman's", () => {
    for (const { workspace_id, label } of WORKSPACES) {
      assert.equal(resolve(workspace_id), label);
      assert.notEqual(resolve(workspace_id), CHAIRMAN_SENDER);
    }
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
