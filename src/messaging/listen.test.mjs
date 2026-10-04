// no-token: clearBeforeOrder -- every consumer here is injected (a recording `converse`, a recording queue port, a recording `answers`); the real queue is never reached, so nothing here clears or prompts a session
// @ts-check
// THE LISTENER'S `onForward` (a11ign/a11ign#3064 done-whens 1 to 4): an accepted MESSAGE that is not an answer reaches `converse`, a BUTTON PRESS and a
// REPLY TO A REQUEST reach `answers` and never `converse`; a queue that cannot load is TOLD to the chairman and ledgered; the unit sets `AGENT_ORG_HOST`;
// and the "no consumer yet" line is gone. (`github-writer.test.mjs` drives the real `answers` through the same forwarder against a fixture `gh`.)
//
// EVERY ACCEPTED VALUE IS MINTED by the real `createInbound` over a real ledger file (never built by hand), and the consumers are recorders: the real
// `converse` is its own file's test and queues to the host's real queue, which a test must not do. What is NOT stubbed is this file's own choice:
// which consumer, what is sent, what is ledgered. `main()` is driven end to end once, over a fake `fetch`, so "the listener passes its default
// `onForward` to the loop" is a reading of the running program and not of `createForwarder` alone.
//
// POSITIVE CONTROL: "never reaches the other" is also what a recorder that records nothing reports, so each routing test first asserts the OWN
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

const { createForwarder, tellingWhenUndelivered, main, EXIT } = await import("./listen.mjs");
const { createConverse, notReached } = await import("./converse.mjs");
const { createInbound } = await import("./inbound.mjs");
const { createLedger, readLedgerLines } = await import("./ledger.mjs");
const { createFakeProvider } = await import("./fake-provider.mjs");
const { createOffsetStore, runListener } = await import("./providers/telegram/poll.mjs");

const CHAIRMAN = Object.freeze({ userId: 4242, chatId: 4242 });
/** The message id of a request the organisation sent: a reply to it is an answer, and a reply to anything else is conversation. */
const REQUEST_MESSAGE = 501;
const SOURCE = readFileSync(fileURLToPath(new URL("./listen.mjs", import.meta.url)), "utf8");
const UNIT = readFileSync(fileURLToPath(new URL("../../host/chairman-listen.service.in", import.meta.url)), "utf8");

const scratch = mkdtempSync(join(tmpdir(), "messaging-listen-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextDir = 0;

/** @param {number} id @param {string} text @param {number} [replyTo] */
const messageUpdate = (id, text, replyTo) => ({
  update_id: id,
  message: { message_id: 900 + id, from: { id: CHAIRMAN.userId }, chat: { id: CHAIRMAN.chatId, type: "private" }, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo } }) },
});
/** @param {number} id */
const pressUpdate = (id) => ({
  update_id: id, callback_query: { id: `cbq-${id}`, from: { id: CHAIRMAN.userId }, data: "ans:A", message: { message_id: REQUEST_MESSAGE, chat: { id: CHAIRMAN.chatId, type: "private" } } },
});

/** @returns {{ ledger: ReturnType<typeof createLedger>, inbound: ReturnType<typeof createInbound>, path: string }} a fresh ledger file and the real core over it */
function core() {
  nextDir += 1;
  const path = join(scratch, `ledger-${nextDir}.jsonl`);
  const ledger = createLedger({ path, now: () => 1_700_000_000_000 });
  return { ledger, inbound: createInbound({ ledger, chairman: CHAIRMAN }), path };
}

/** @param {ReturnType<typeof createInbound>} inbound @param {unknown} update @returns {Readonly<Record<string, any>>} the value the core minted for it */
function mint(inbound, update) {
  const handled = inbound.handle(update);
  assert.equal(handled.action, "forward", `the core did not forward ${JSON.stringify(update)}`);
  return /** @type {any} */ (handled).accepted;
}

/** Recorders for the two consumers. `answers` takes a press and a reply to REQUEST_MESSAGE, as the real one does, and calls the rest not an answer. */
function recorders() {
  /** @type {Record<string, any>[]} */ const toConverse = [];
  /** @type {Record<string, any>[]} */ const toAnswers = [];
  const answers = {
    answer: async (/** @type {Record<string, any>} */ accepted) => {
      toAnswers.push(accepted);
      const takes = accepted.kind === "button" || accepted.replyToMessageId === REQUEST_MESSAGE;
      return takes ? { action: "reply", text: "Recorded on a11ign/a11ign#2885: ceo has it." } : { action: "not-an-answer" };
    },
  };
  const converse = async (/** @type {Record<string, any>} */ accepted) => { toConverse.push(accepted); };
  return { toConverse, toAnswers, answers, converse };
}

/** @param {ReturnType<typeof recorders>} consumers @param {ReturnType<typeof createFakeProvider>} provider */
const forwarderOver = (consumers, provider) => createForwarder({
  answers: consumers.answers, converse: consumers.converse, send: (message) => provider.send(message), log: () => {},
});

describe("routing (done-when 1)", () => {
  test("a message that is not an answer reaches converse with the minted value", async () => {
    const { inbound } = core();
    const consumers = recorders();
    const provider = createFakeProvider();
    const accepted = mint(inbound, messageUpdate(1, "how is the queue today?"));
    await forwarderOver(consumers, provider)(accepted);
    assert.deepEqual(consumers.toConverse, [accepted], "converse did not get the very value the core minted");
    assert.deepEqual(provider.sent, [], "converse speaks for itself; the listener says nothing");
  });

  test("a button press reaches answers with the minted value, converse is not called, and what answers says is sent to the chairman", async () => {
    const { inbound } = core();
    const consumers = recorders();
    const provider = createFakeProvider();
    const accepted = mint(inbound, pressUpdate(2));
    await forwarderOver(consumers, provider)(accepted);
    assert.deepEqual(consumers.toAnswers, [accepted]);
    assert.deepEqual(consumers.toConverse, []);
    assert.deepEqual(provider.sent.map((message) => message.text), ["Recorded on a11ign/a11ign#2885: ceo has it."]);
  });

  test("a reply to a request reaches answers and NEVER converse (routing by kind alone would send it to conversation)", async () => {
    const { inbound } = core();
    const consumers = recorders();
    const provider = createFakeProvider();
    const accepted = mint(inbound, messageUpdate(3, "hold it until Monday", REQUEST_MESSAGE));
    await forwarderOver(consumers, provider)(accepted);
    assert.deepEqual(consumers.toAnswers, [accepted]);
    assert.deepEqual(consumers.toConverse, [], "an answer the chairman gave was also queued for ceo as conversation");
    assert.equal(provider.sent.length, 1);
  });
});

describe("a queue that cannot load is told, not dropped (done-when 2)", () => {
  const refusal = new Error("the declaration cannot be read: set AGENT_ORG_HOST");
  const unqueueable = async () => { throw refusal; };

  test("a message: the chairman is told in plain words (never the error's text), and the ledger line says refused and keeps the error", async () => {
    const { ledger, inbound } = core();
    const provider = createFakeProvider();
    const accepted = mint(inbound, messageUpdate(4, "are you there?"));
    const forward = tellingWhenUndelivered({ ledger, send: (message) => provider.send(message), converse: unqueueable });
    await assert.rejects(forward(accepted), /queue could not be reached/);
    assert.equal(provider.sent.length, 1);
    assert.equal(provider.sent[0].text, notReached());
    assert.ok(!/AGENT_ORG_HOST|Error|declaration/.test(provider.sent[0].text), "no error text reaches the chairman (a11ign/a11ign#3538)");
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
    await assert.rejects(tellingWhenUndelivered({ ledger, send, converse: converse.forward })(mint(inbound, messageUpdate(7, "hello"))), /queue could not be reached/);
    assert.equal(provider.sent[0].text, "Got it, looking.", "the acknowledgement went first, before the queue threw");
    assert.equal(provider.sent[1].text, notReached());
    assert.equal(readLedgerLines(ledger.path).filter((entry) => entry.origin === "converse").map((entry) => entry.verdict).join(), "refused");
  });

  test("a failure converse DID ledger keeps its own line: the listener neither re-tells the chairman nor ledgers a second", async () => {
    const { ledger, inbound } = core();
    const provider = createFakeProvider();
    const accepted = mint(inbound, messageUpdate(8, "hello"));
    const accounted = async () => {
      ledger.append({ direction: "in", origin: "converse", updateId: accepted.updateId, verdict: "queued" });
      throw new Error("converse: the message was queued but the acknowledgement could not be sent");
    };
    await assert.rejects(tellingWhenUndelivered({ ledger, send: (message) => provider.send(message), converse: accounted })(accepted), /acknowledgement could not be sent/);
    assert.deepEqual(provider.sent, []);
    assert.equal(readLedgerLines(ledger.path).filter((entry) => entry.origin === "converse").length, 1);
  });

  test("when the chairman cannot be told either, that is the error, and the ledger line still says refused", async () => {
    const { ledger, inbound } = core();
    const accepted = mint(inbound, messageUpdate(6, "hello"));
    const forward = tellingWhenUndelivered({ ledger, send: async () => { throw new Error("telegram is down"); }, converse: unqueueable });
    await assert.rejects(forward(accepted), (error) => /could not be told/.test(/** @type {Error} */ (error).message) && /telegram is down/.test(String(/** @type {Error} */ (error).cause)));
    assert.equal(readLedgerLines(ledger.path).find((entry) => entry.origin === "converse")?.verdict, "refused");
  });
});

describe("the default onForward, through main() (done-when 1 and 2, running)", () => {
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

  /** A GitHub that has no request the chairman's updates could answer, so `answers` calls a plain message not-an-answer and a press unresolvable. */
  const github = /** @type {any} */ ({ readRow: async () => { throw new Error("no row is read for an update that answers nothing"); } });
  const env = { GH_CONFIG_DIR: "/nowhere" };

  test("an accepted message reaches converse, and a press reaches answers (which says so to the chairman) and not converse", async () => {
    const { home, root } = installation();
    /** @type {string[]} */ const toConverse = [];
    const wire = telegram([messageUpdate(10, "to ceo"), pressUpdate(11)]);
    /** @type {string[]} */ const lines = [];
    const converse = async (/** @type {Record<string, any>} */ accepted) => { toConverse.push(accepted.text); };
    const code = await main({ root, home, env, github, converse, fetch: wire.fetch, signal: wire.signal, sleep: async () => {}, err: (line) => lines.push(line) });
    assert.equal(code, EXIT.ok, lines.join("\n"));
    assert.deepEqual(toConverse, ["to ceo"]);
    assert.equal(wire.said.length, 1, "the press was answered: the message was conversation, and converse is a recorder here that says nothing");
    assert.match(wire.said[0], /not a request I can resolve/);
    assert.deepEqual(lines.filter((line) => /consumer/.test(line)), []);
  });

  test("a queue that will not load is told to the chairman through the running listener, and the next update is still handled", async () => {
    const { home, root } = installation();
    const wire = telegram([messageUpdate(20, "first"), pressUpdate(21)]);
    /** @type {string[]} */ const lines = [];
    const converse = async () => { throw new Error("the declaration cannot be read: set AGENT_ORG_HOST"); };
    await main({ root, home, env, github, converse, fetch: wire.fetch, signal: wire.signal, sleep: async () => {}, err: (line) => lines.push(line) });
    assert.equal(wire.said[0], notReached());
    assert.match(wire.said[1], /not a request I can resolve/, "the press after the refused message was still handled");
    assert.ok(lines.some((line) => /forward failed: the queue could not be reached/.test(line)), lines.join("\n"));
  });
});

describe("#3442: a credential reaches neither the queue, the answers path, the ledger nor a quote, read end to end over recording ports", () => {
  const X = "zq-fake-value-0";
  const MIXED = "Aq9Zx7Lm2Kp4Vb8Nc3Jd5Hs6";
  const GITHUB = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
  /** Each of these holds a credential of the row's classes 1 to 3, and each needs the real classifier to refuse it. */
  const CREDENTIAL_MESSAGES = [
    `My password is: ${X}`, `password is ${X}`, `password: ${X}`, `password = ${X}`, `pw: ${X}`, `pwd=${X}`, `here's my password ${X}`, `my password ${X}`,
    `${X} is my password`, GITHUB, ["xox", "b-1234567890-abcdefghijkl"].join(""), ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""), MIXED, `look: ${MIXED} thanks`,
  ];
  /** What of the value must appear nowhere afterwards: the whole, and a piece too long to be a coincidence. */
  const FRAGMENTS = [X, "zq-fake", "fake-value", GITHUB.slice(0, 20), MIXED, MIXED.slice(4, 14), "abcdefghijkl", "ABCDEFGHIJKLMNOP"];

  /** The queue port as a recorder: every call is kept, and it says QUEUED as the real one does. */
  function recordingQueue() {
    /** @type {Record<string, any>[]} */ const calls = [];
    return {
      calls,
      port: {
        EXIT: { OK: 0, REFUSED: 1, QUEUED: 2 }, STANCE: { UNDECLARED: "undeclared" }, attributed: (/** @type {string} */ text) => text,
        handoffId: () => "handoff/liaison/recorded", readHandoffs: () => [{ id: "handoff/liaison/recorded", session: "liaison", prompt: "" }],
        queueOrLose(/** @type {Record<string, any>} */ order) { calls.push(order); return 2; },
      },
    };
  }

  /** The running loop over real `createInbound`, the real forwarder and the real `converse`, with a recorder at every port that leaves the process. */
  async function run(/** @type {string[]} */ texts) {
    const { ledger, inbound, path } = core();
    const queue = recordingQueue();
    const toAnswers = /** @type {Record<string, any>[]} */ ([]);
    const controller = new AbortController();
    const wire = /** @type {{ sent: Record<string, any>[], deleted: Record<string, any>[] }} */ ({ sent: [], deleted: [] });
    const provider = {
      poll: async () => { controller.abort(); return { updates: texts.map((text, index) => messageUpdate(300 + index, text)), cursor: 400 }; },
      send: async (/** @type {Record<string, any>} */ message) => { wire.sent.push(message); return { messageRef: `ref-${wire.sent.length}` }; },
      deleteMessage: async (/** @type {Record<string, any>} */ target) => { wire.deleted.push(target); },
      answerCallbackQuery: async () => {}, leaveChat: async () => {},
    };
    const send = (/** @type {{ text: string, replyTo?: string }} */ message) => provider.send(message);
    const conversation = createConverse({ chairman: CHAIRMAN, ledger, send, queue: queue.port, queuePath: "/nowhere/queue.jsonl", agents: () => [{ label: "liaison", status: "idle" }] });
    const answers = { answer: async (/** @type {Record<string, any>} */ accepted) => { toAnswers.push(accepted); return { action: "not-an-answer" }; } };
    const offsets = /** @type {ReturnType<typeof createOffsetStore>} */ ({ read: () => undefined, write: () => {} });
    await runListener({
      provider: /** @type {any} */ (provider), inbound, offsets, chairman: CHAIRMAN, sleep: async () => {}, signal: controller.signal,
      onForward: createForwarder({ answers, send, converse: conversation.forward, log: () => {} }),
    });
    return { queue: queue.calls, toAnswers, wire, ledgerText: readFileSync(path, "utf8") };
  }

  test("POSITIVE CONTROL: a benign message IS queued once and answered once, so the empty readings below are not an inert harness", async () => {
    const result = await run(["why did the merge queue stall?"]);
    assert.equal(result.queue.length, 1, "the queue port was called once for the clean message");
    assert.equal(result.toAnswers.length, 1);
    assert.equal(result.wire.deleted.length, 0);
    assert.equal(result.wire.sent.length, 1, "converse's acknowledgement");
  });

  test("every credential message: the queue port is never called, `answers` never sees it, the one reply carries no replyTo, and nothing is written with any part of it", async () => {
    assert.equal(CREDENTIAL_MESSAGES.length, 14, "the population is not empty");
    for (const text of CREDENTIAL_MESSAGES) {
      const result = await run([text]);
      const label = text.replace(X, "<X>").slice(0, 30);
      assert.deepEqual(result.queue, [], `the queue was called for ${label}`);
      assert.deepEqual(result.toAnswers, [], `answers read ${label}`);
      assert.equal(result.wire.deleted.length, 1, `${label} was not deleted from the chat`);
      assert.equal(result.wire.sent.length, 1, `${label}: exactly one reply`);
      assert.equal(Object.hasOwn(result.wire.sent[0], "replyTo") && result.wire.sent[0].replyTo !== undefined, false, `the reply to ${label} quotes the message`);
      for (const fragment of FRAGMENTS) {
        assert.ok(!result.ledgerText.includes(fragment), `the ledger holds ${fragment} after ${label}`);
        assert.ok(!JSON.stringify(result.wire).includes(fragment), `the chat was sent ${fragment} after ${label}`);
      }
      const lines = result.ledgerText.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(lines.length, 1, "one line: the verdict, and nothing from converse");
      assert.ok(["drop", "withhold"].includes(lines[0].verdict) && lines[0].sha256 === null, `${label}: ${lines[0].verdict}, hash ${lines[0].sha256}`);
    }
  });

  test("a withheld message is told once and the same message resent with 'not a secret' is queued", async () => {
    const withheld = await run([MIXED]);
    assert.match(withheld.wire.sent[0].text, /looks like a credential/);
    const released = await run([`${MIXED} not a secret`]);
    assert.equal(released.queue.length, 1);
    assert.equal(released.wire.deleted.length, 0);
  });

  test("a credential and a benign message in one batch: only the benign one is queued", async () => {
    const result = await run([`password: ${X}`, "how is the queue today?"]);
    assert.equal(result.queue.length, 1);
    assert.equal(result.toAnswers.length, 1);
    assert.ok(!JSON.stringify(result.queue).includes(X));
  });
});

describe("the unit and the source", () => {
  test("the chairman-listen unit sets AGENT_ORG_HOST to the project's host.json (done-when 3)", () => {
    const lines = UNIT.split("\n").filter((line) => /^Environment=AGENT_ORG_HOST=/.test(line));
    assert.deepEqual(lines, ["Environment=AGENT_ORG_HOST=@@checkout@@/.agent-org/host.json"]);
  });

  test("the default onForward no longer says nothing consumes the update (done-when 4)", () => {
    assert.ok(!/has no consumer yet/.test(SOURCE), "listen.mjs went back to dropping accepted updates with a log line");
    assert.match(SOURCE, /onForward \?\? createForwarder\(/, "the default onForward is no longer the forwarder, so this test would pass on a listener that forwards nothing");
    assert.match(SOURCE, /converse: tellingWhenUndelivered\(/, "the converse path is no longer wrapped, so a queue that will not load is dropped again");
  });
});

describe("a message that can no longer be answered has its keyboard taken off (a11ign/a11ign#3423 done-when 6)", () => {
  /** @param {string | null} clear @returns {{ answer: (accepted: unknown) => Promise<any> }} an answers that replies, naming the message to clear */
  const replying = (clear) => ({ answer: async () => ({ action: "reply", text: "That was already answered.", clearKeyboard: clear }) });

  test("the keyboard comes off BEFORE the reply goes, and the control: with nothing to clear no call is made", async () => {
    const { inbound } = core();
    const order = /** @type {string[]} */ ([]);
    const forward = createForwarder({
      answers: replying(String(REQUEST_MESSAGE)), converse: async () => {}, log: () => {},
      send: async ({ text }) => { order.push(`send ${text}`); }, clearKeyboard: async (ref) => { order.push(`clear ${ref}`); },
    });
    await forward(mint(inbound, pressUpdate(60)));
    assert.deepEqual(order, [`clear ${REQUEST_MESSAGE}`, "send That was already answered."]);

    const quiet = /** @type {string[]} */ ([]);
    const none = createForwarder({ answers: replying(null), converse: async () => {}, log: () => {}, send: async () => {}, clearKeyboard: async (ref) => { quiet.push(ref); } });
    await none(mint(inbound, pressUpdate(61)));
    assert.deepEqual(quiet, []);
  });

  test("a keyboard that cannot be taken off is logged, and the reply still goes", async () => {
    const { inbound } = core();
    const logged = /** @type {string[]} */ ([]);
    const sent = /** @type {string[]} */ ([]);
    const forward = createForwarder({
      answers: replying("501"), converse: async () => {}, log: (line) => logged.push(line),
      send: async ({ text }) => { sent.push(text); }, clearKeyboard: async () => { throw new Error("message to edit not found"); },
    });
    await forward(mint(inbound, pressUpdate(62)));
    assert.deepEqual(sent, ["That was already answered."]);
    assert.match(logged.join("\n"), /could not take the keyboard off message 501: message to edit not found/);
  });

  test("the program wires both: the provider's clearKeyboard to the forwarder, and the liaison's order to the answers", () => {
    assert.match(SOURCE, /clearKeyboard: \(ref\) => provider\.clearKeyboard\(ref\)/);
    assert.match(SOURCE, /orders: \{ liaison: \(order\) => conversation\.orderLiaison\(order\) \}/);
  });
});
