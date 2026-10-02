// @ts-check
// THE LISTENER'S `onForward` (a11ign/a11ign#3064 done-whens 1 to 4): an accepted MESSAGE reaches `converse`, an accepted BUTTON PRESS reaches
// `answers`, neither reaches the other; a queue that cannot load is TOLD to the chairman and ledgered; the unit sets `AGENT_ORG_HOST`; and the
// "no consumer yet" line is gone.
//
// EVERY ACCEPTED VALUE IS MINTED by the real `createInbound` over a real ledger file (never built by hand), and the consumers are recorders: the real
// `converse` is its own file's test (`converse.test.mjs`) and queues to the host's real queue, which a test must not do. What is NOT stubbed is this
// file's own choice: which consumer, what is sent, what is ledgered. `main()` is driven end to end once, over a fake `fetch`, so "the listener passes
// its default `onForward` to the loop" is a reading of the running program and not of `forwarding` alone.
//
// POSITIVE CONTROL: "neither reaches the other" is also what a recorder that records nothing reports, so each routing test first asserts the OWN
// consumer was called with the very value minted.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// The listener's own imports reach the project's declaration, so it must be findable BEFORE the first import of it, once, for this process.
const HOST_FILE = join(homedir(), "repos", "a11y-witness", ".agent-org", "host.json");
if (!process.env.AGENT_ORG_HOST && existsSync(HOST_FILE)) process.env.AGENT_ORG_HOST = HOST_FILE;

const { createGhWriter, forwarding, handoffQueueBeside, main, EXIT } = await import("./listen.mjs");
const { createConverse } = await import("./converse.mjs");
const { createInbound } = await import("./inbound.mjs");
const { createLedger, readLedgerLines } = await import("./ledger.mjs");
const { createFakeProvider } = await import("./fake-provider.mjs");

const CHAIRMAN = Object.freeze({ userId: 4242, chatId: 4242 });
const SOURCE = readFileSync(fileURLToPath(new URL("./listen.mjs", import.meta.url)), "utf8");
const UNIT = readFileSync(fileURLToPath(new URL("../../host/chairman-listen.service.in", import.meta.url)), "utf8");

const scratch = mkdtempSync(join(tmpdir(), "messaging-listen-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextDir = 0;

/** @param {number} id @param {string} text */
const messageUpdate = (id, text) => ({ update_id: id, message: { message_id: 900 + id, from: { id: CHAIRMAN.userId }, chat: { id: CHAIRMAN.chatId, type: "private" }, text } });
/** @param {number} id */
const pressUpdate = (id) => ({
  update_id: id, callback_query: { id: `cbq-${id}`, from: { id: CHAIRMAN.userId }, data: "ans:A", message: { message_id: 501, chat: { id: CHAIRMAN.chatId, type: "private" } } },
});

/** @returns {{ ledger: ReturnType<typeof createLedger>, inbound: ReturnType<typeof createInbound> }} a fresh ledger file and the real core over it */
function core() {
  nextDir += 1;
  const ledger = createLedger({ path: join(scratch, `ledger-${nextDir}.jsonl`), now: () => 1_700_000_000_000 });
  return { ledger, inbound: createInbound({ ledger, chairman: CHAIRMAN }) };
}

/** @param {ReturnType<typeof createInbound>} inbound @param {unknown} update @returns {Readonly<Record<string, any>>} the value the core minted for it */
function mint(inbound, update) {
  const handled = inbound.handle(update);
  assert.equal(handled.action, "forward", `the core did not forward ${JSON.stringify(update)}`);
  return /** @type {any} */ (handled).accepted;
}

/** Recorders for the two consumers; `converseText` is what `converse.forward` is made to do. */
function recorders() {
  /** @type {Record<string, any>[]} */ const toConverse = [];
  /** @type {Record<string, any>[]} */ const toAnswers = [];
  const consumers = {
    converse: { forward: async (/** @type {Record<string, any>} */ accepted) => { toConverse.push(accepted); return { outcome: "queued" }; } },
    answers: { answer: async (/** @type {Record<string, any>} */ accepted) => { toAnswers.push(accepted); return { text: "Recorded on a11ign/a11ign#2885: ceo has it." }; } },
  };
  return { toConverse, toAnswers, consumers };
}

describe("routing by kind (done-when 1)", () => {
  test("a message reaches converse with the minted value, and answers is not called", async () => {
    const { ledger, inbound } = core();
    const { toConverse, toAnswers, consumers } = recorders();
    const provider = createFakeProvider();
    const accepted = mint(inbound, messageUpdate(1, "please look at #3064"));
    await forwarding({ ledger, send: (message) => provider.send(message), consumers })(accepted);
    assert.deepEqual(toConverse, [accepted]);
    assert.equal(toConverse[0], accepted, "the very value the core minted, not a copy: `isAccepted` knows only that one");
    assert.deepEqual(toAnswers, []);
  });

  test("a button press reaches answers with the minted value, converse is not called, and what answers says is sent to the chairman", async () => {
    const { ledger, inbound } = core();
    const { toConverse, toAnswers, consumers } = recorders();
    const provider = createFakeProvider();
    const accepted = mint(inbound, pressUpdate(2));
    await forwarding({ ledger, send: (message) => provider.send(message), consumers })(accepted);
    assert.equal(toAnswers[0], accepted);
    assert.deepEqual(toConverse, []);
    assert.deepEqual(provider.sent.map((message) => message.text), ["Recorded on a11ign/a11ign#2885: ceo has it."]);
  });

  test("an accepted kind nothing consumes is an error, never a silent return", async () => {
    const { ledger } = core();
    const { toConverse, toAnswers, consumers } = recorders();
    const forward = forwarding({ ledger, send: async () => ({ messageRef: "1" }), consumers });
    await assert.rejects(forward({ kind: "edited_message", updateId: 3 }), /nothing consumes/);
    assert.deepEqual([...toConverse, ...toAnswers], []);
  });
});

describe("a queue that cannot load is told, not dropped (done-when 2)", () => {
  const refusal = new Error("the declaration cannot be read: set AGENT_ORG_HOST");
  /** What the real `converse.forward` does when its queue will not load: it rejects BEFORE it writes a ledger line of its own. */
  const unqueueable = (/** @type {Consumers} */ working) => ({ ...working, converse: { forward: async () => { throw refusal; } } });
  /** @typedef {ReturnType<typeof recorders>["consumers"]} Consumers */

  test("a message: the chairman is SENT the reason, and the ledger line says refused", async () => {
    const { ledger, inbound } = core();
    const provider = createFakeProvider();
    const accepted = mint(inbound, messageUpdate(4, "are you there?"));
    await assert.rejects(forwarding({ ledger, send: (message) => provider.send(message), consumers: unqueueable(recorders().consumers) })(accepted), /queue could not be reached/);
    assert.equal(provider.sent.length, 1);
    assert.match(provider.sent[0].text, /could not queue that for ceo.*AGENT_ORG_HOST.*NOT delivered/s);
    assert.equal(provider.sent[0].replyTo, String(accepted.messageId));
    const line = readLedgerLines(ledger.path).find((entry) => entry.origin === "converse");
    assert.ok(line, "no converse line was ledgered");
    assert.equal(line.verdict, "refused");
    assert.equal(line.handoff, null);
    assert.match(line.error, /AGENT_ORG_HOST/);
    assert.ok(!JSON.stringify(line).includes("are you there"), "the chairman's words are never in the ledger");
  });

  test("the REAL converse, whose queue throws, leaves no line of its own, so the listener tells the chairman", async () => {
    const { ledger, inbound } = core();
    const provider = createFakeProvider();
    const send = (/** @type {{ text: string, replyTo?: string }} */ message) => provider.send(message);
    const queue = /** @type {any} */ ({ queueOrLose: () => { throw refusal; }, STANCE: { UNDECLARED: "undeclared" }, EXIT: { QUEUED: 2 }, attributed: (/** @type {string} */ text) => text, handoffId: () => "h", readHandoffs: () => [] });
    const converse = createConverse({ chairman: CHAIRMAN, queuePath: join(scratch, "queue"), ledger, send, now: () => 1, agents: () => [], queue });
    const consumers = { ...recorders().consumers, converse };
    await assert.rejects(forwarding({ ledger, send, consumers })(mint(inbound, messageUpdate(7, "hello"))), /queue could not be reached/);
    assert.match(provider.sent[0].text, /NOT delivered/);
    assert.equal(readLedgerLines(ledger.path).filter((entry) => entry.origin === "converse").map((entry) => entry.verdict).join(), "refused");
  });

  test("a failure converse DID ledger keeps its own line: the listener neither re-tells the chairman nor ledgers a second", async () => {
    const { ledger, inbound } = core();
    const provider = createFakeProvider();
    const accepted = mint(inbound, messageUpdate(8, "hello"));
    const accounted = { ...recorders().consumers, converse: { forward: async () => {
      ledger.append({ direction: "in", origin: "converse", updateId: accepted.updateId, verdict: "queued" });
      throw new Error("converse: the message was queued but the acknowledgement could not be sent");
    } } };
    await assert.rejects(forwarding({ ledger, send: (message) => provider.send(message), consumers: accounted })(accepted), /acknowledgement could not be sent/);
    assert.deepEqual(provider.sent, []);
    assert.equal(readLedgerLines(ledger.path).filter((entry) => entry.origin === "converse").length, 1);
  });

  test("when the chairman cannot be told either, that is the error, and the ledger line still says refused", async () => {
    const { ledger, inbound } = core();
    const accepted = mint(inbound, messageUpdate(6, "hello"));
    const forward = forwarding({ ledger, send: async () => { throw new Error("telegram is down"); }, consumers: unqueueable(recorders().consumers) });
    await assert.rejects(forward(accepted), (error) => /could not be told/.test(/** @type {Error} */ (error).message) && /telegram is down/.test(String(/** @type {Error} */ (error).cause)));
    assert.equal(readLedgerLines(ledger.path).find((entry) => entry.origin === "converse")?.verdict, "refused");
  });
});

describe("the queue path this file computes is the one the queue uses", () => {
  test("handoffQueueBeside(the wake ledger) is wake.mjs's handoffQueuePath, and the file name is wake.mjs's constant", async () => {
    const wake = await import("../wake.mjs");
    const ledgerPath = wake.ledgerPathFrom([]);
    assert.equal(handoffQueueBeside(ledgerPath), wake.handoffQueuePath(ledgerPath));
    assert.match(SOURCE, new RegExp(`const HANDOFF_QUEUE_FILE = "${wake.HANDOFF_QUEUE_FILE}";`));
  });
});

describe("the default onForward, through main() (done-when 1, running)", () => {
  /** A project root and home with messaging on, and the two secret files `listen` reads. */
  function installation() {
    nextDir += 1;
    const home = join(scratch, `home-${nextDir}`);
    const root = join(scratch, `root-${nextDir}`);
    const secrets = join(home, ".config", "agent-org");
    mkdirSync(secrets, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, ".agent-org"), { recursive: true });
    writeFileSync(join(secrets, "telegram-token"), "123456:fixture-token\n", { mode: 0o600 });
    writeFileSync(join(secrets, "chairman.json"), JSON.stringify(CHAIRMAN), { mode: 0o600 });
    const messaging = { provider: "telegram", tokenFile: "~/.config/agent-org/telegram-token", chairmanFile: "~/.config/agent-org/chairman.json" };
    writeFileSync(join(root, ".agent-org", "project.json"), JSON.stringify({ schema: 1, messaging }));
    return { home, root };
  }

  /** A fetch that serves `updates` to the first getUpdates, stops the listener on the second, and records each sendMessage's text. */
  function telegram(/** @type {unknown[]} */ updates) {
    const controller = new AbortController();
    /** @type {string[]} */ const said = [];
    let polls = 0;
    const reply = (/** @type {unknown} */ result) => ({ ok: true, json: async () => ({ ok: true, result }) });
    const fetch = async (/** @type {string} */ url, /** @type {{ body: string }} */ init) => {
      if (url.endsWith("/getUpdates")) {
        polls += 1;
        if (polls > 1) controller.abort();
        return reply(polls === 1 ? updates : []);
      }
      if (url.endsWith("/sendMessage")) said.push(JSON.parse(init.body).text);
      return reply(url.endsWith("/sendMessage") ? { message_id: 700 + said.length } : true);
    };
    return { fetch: /** @type {typeof globalThis.fetch} */ (/** @type {unknown} */ (fetch)), signal: controller.signal, said };
  }

  test("an accepted message and an accepted press each reach their own consumer", async () => {
    const { home, root } = installation();
    const { toConverse, toAnswers, consumers } = recorders();
    const wire = telegram([messageUpdate(10, "to ceo"), pressUpdate(11)]);
    /** @type {string[]} */ const lines = [];
    const code = await main({ root, home, fetch: wire.fetch, signal: wire.signal, consumers, sleep: async () => {}, err: (line) => lines.push(line) });
    assert.equal(code, EXIT.ok, lines.join("\n"));
    assert.deepEqual(toConverse.map((accepted) => accepted.text), ["to ceo"]);
    assert.deepEqual(toAnswers.map((accepted) => accepted.data), ["ans:A"]);
    assert.deepEqual(wire.said, ["Recorded on a11ign/a11ign#2885: ceo has it."]);
    assert.deepEqual(lines.filter((line) => /consumer/.test(line)), []);
  });

  test("a consumer that fails is logged and the next update is still handled", async () => {
    const { home, root } = installation();
    const { toAnswers, consumers: working } = recorders();
    const failing = { ...working, converse: { forward: async () => { throw new Error("queue is full"); } } };
    const wire = telegram([messageUpdate(20, "first"), pressUpdate(21)]);
    /** @type {string[]} */ const lines = [];
    await main({ root, home, fetch: wire.fetch, signal: wire.signal, consumers: failing, sleep: async () => {}, err: (line) => lines.push(line) });
    assert.equal(toAnswers.length, 1);
    assert.ok(lines.some((line) => /forward failed: the queue could not be reached/.test(line)), lines.join("\n"));
  });
});

describe("the real GitHub writer (what answers writes through)", () => {
  /** @param {string} stdout @returns {{ writer: ReturnType<typeof createGhWriter>, calls: (readonly string[])[] }} */
  function writerOver(stdout = "") {
    /** @type {(readonly string[])[]} */ const calls = [];
    return { calls, writer: createGhWriter({ run: async (argv) => { calls.push(argv); return stdout; } }) };
  }
  const ROW = { repo: "a11ign/a11ign", number: 2885 };

  test("the three writes are `gh issue` calls scoped to the row's repository, never the working directory's", async () => {
    const { writer, calls } = writerOver();
    await writer.comment(ROW, "Chairman answered via Telegram");
    await writer.removeLabel(ROW, "needs:chairman");
    await writer.addLabel(ROW, "answer:ceo");
    assert.deepEqual(calls, [
      ["issue", "comment", "2885", "--repo", "a11ign/a11ign", "--body", "Chairman answered via Telegram"],
      ["issue", "edit", "2885", "--repo", "a11ign/a11ign", "--remove-label", "needs:chairman"],
      ["issue", "edit", "2885", "--repo", "a11ign/a11ign", "--add-label", "answer:ceo"],
    ]);
  });

  test("the row is read as state, label names and comments", async () => {
    const view = { state: "OPEN", labels: [{ name: "ready" }, { name: "needs:chairman" }], comments: [{ body: "brief", createdAt: "2026-10-02T09:00:00Z", authorAssociation: "OWNER", id: "x" }] };
    const { writer, calls } = writerOver(JSON.stringify(view));
    assert.deepEqual(await writer.readRow(ROW), {
      state: "OPEN", labels: ["ready", "needs:chairman"], comments: [{ body: "brief", createdAt: "2026-10-02T09:00:00Z", authorAssociation: "OWNER" }],
    });
    assert.deepEqual(calls, [["issue", "view", "2885", "--repo", "a11ign/a11ign", "--json", "state,labels,comments"]]);
  });
});

describe("the unit and the source", () => {
  test("the chairman-listen unit sets AGENT_ORG_HOST to the project's host.json (done-when 3)", () => {
    const lines = UNIT.split("\n").filter((line) => /^Environment=AGENT_ORG_HOST=/.test(line));
    assert.deepEqual(lines, ["Environment=AGENT_ORG_HOST=@@checkout@@/.agent-org/host.json"]);
  });

  test("the default onForward no longer says nothing consumes the update (done-when 4)", () => {
    assert.ok(!/has no consumer yet/.test(SOURCE), "listen.mjs went back to dropping accepted updates with a log line");
    assert.match(SOURCE, /onForward \?\? forwarding\(/, "the default onForward is no longer `forwarding`, so this test would pass on a listener that forwards nothing");
  });
});
