// no-token: prepareContext -- Telegram is a fake and the ledger a temp file, and nothing here calls it; `poll.ts` only carries it in through `acquireLock`'s `createAnswers` import (measured with `gh` and `herdr` stubbed first on PATH: neither was spawned; a11ign/a11ign#4743)
// @ts-check
// THE LONG POLL AND THE LISTENER (a11ign/a11ign#2907 done-whens 1-5), against a FAKE TELEGRAM that behaves the way the real one does where it
// matters here: it REDELIVERS every update until a later `getUpdates` confirms it with an offset, so "a restart replays nothing" is something
// the fake can contradict. The clock is injected (`sleep` records the wait and returns), so nothing waits, and no network is reached.
//
// POSITIVE CONTROLS, because each of these claims is also what a listener that does nothing would satisfy:
//   * the offset: the first batch is HANDLED (three forwards) before the offset is read back, and a restart that asks from nothing is the
//     counter-case (its first request has no `offset`);
//   * exactly once: the same update is delivered twice by Telegram and forwarded once, in BOTH ways a restart can go (offset kept, offset lost);
//   * the lock: a free lock is taken first, a stale one is taken over, and a live one is the only one refused;
//   * the unit: the same check run over a deliberately bad unit finds what it looks for.
// Ids are made-up integers, and the token is a made-up string shaped like one.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { acquireLock, ListenerLockHeld, main, processStart, EXIT } from "../../listen.ts";
import { createInbound } from "../../inbound.ts";
import { createLedger, readLedgerLines } from "../../ledger.ts";
import { runProviderConformance } from "../../provider-contract.ts";
import { createSecret } from "../../secret.ts";
import {
  ALLOWED_UPDATES, BACKOFF_CEILING_MS, BACKOFF_INITIAL_MS, createOffsetStore, createTelegramPollingProvider, LONG_POLL_SECONDS, nextBackoff,
  nextCursor, PollConflictError, runListener,
} from "./poll.ts";

const TOKEN = "123456789:AAFk3x9Q-test_token_value_ZZ";
const CHAIRMAN = Object.freeze({ userId: 4242, chatId: 4242 });
const STRANGER = 9001;
const GROUP_ID = -1001234;
const CHANNEL_ID = -1005678;
const MS = 1000;
const PASSWORD_LINE = "password: hunter2";
// The tool's OWN unit template (`host/` at this repository's root, `src/messaging/providers/telegram` up four), not a project file.
const UNIT = fileURLToPath(new URL("../../../../host/chairman-listen.service.in", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "messaging-poll-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextDirectory = 0;
/** @returns {string} a fresh directory, so no test reads another's lock, offset or ledger */
const freshDirectory = (): string => {
  const path = join(scratch, `t${nextDirectory += 1}`);
  mkdirSync(path, { recursive: true });
  return path;
};

/** @param {number} id @param {Record<string, any>} [more] a message from the chairman in their own private chat */
function update(id: number, more: Record<string, any> = {}) {
  return { update_id: id, message: { message_id: id, from: { id: CHAIRMAN.userId }, chat: { id: CHAIRMAN.chatId, type: "private" }, text: `hello ${id}`, ...more } };
}

/** @param {number} id @param {{ from?: number, queryId?: string }} [who] a button press under one of the bot's messages */
function press(id: number, { from = CHAIRMAN.userId, queryId = `q${id}` }: { from?: number; queryId?: string; } = {}) {
  return { update_id: id, callback_query: { id: queryId, from: { id: from }, data: "ans:A", message: { message_id: 5, chat: { id: CHAIRMAN.chatId, type: "private" } } } };
}

/** @typedef {{ method: string, body: Record<string, any>, url: string }} Request */
/** @typedef {{ status: number, body: Record<string, any> } | Error | "ok"} Reply  `"ok"` is an ordinary answer in the middle of a script */

/** @param {number} status @param {Record<string, any>} body */
const reply = (status: number, body: Record<string, any>) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null } });

/**
 * Telegram as far as the listener can tell. `pending` is redelivered by every `getUpdates` until a later one's `offset` is past it.
 * `script` answers the first `getUpdates` calls instead (a failure, or a 409). After `stopAfter` calls the listener's signal is aborted, which is
 * how a test ends a loop that a real long poll would hold open; `arm(n)` does the same for the next `n` calls of a run after a restart.
 * @param {{ updates?: any[], script?: Reply[], stopAfter?: number }} [options]
 */
function fakeTelegram({ updates = [], script = [], stopAfter = 1 }: { updates?: any[]; script?: Reply[]; stopAfter?: number; } = {}) {
  /** @type {Request[]} */
  const requests: Request[] = [];
  let pending = [...updates];
  let polls = 0;
  let nextMessageId = 700;
  let stop = new AbortController();
  let stopAt = stopAfter;
  const fetchImpl = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ url: string, /** @type {{ body: string }} */ init: { body: string; }) => {
    const method = url.split("/").pop() ?? "";
    const body = JSON.parse(init.body);
    requests.push({ method, body, url });
    if (method !== "getUpdates") return reply(200, { ok: true, result: method === "sendMessage" ? { message_id: nextMessageId += 1 } : true });
    polls += 1;
    if (polls >= stopAt) stop.abort();
    const scripted = script.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted !== undefined && scripted !== "ok") return reply(scripted.status, scripted.body);
    if (body.offset !== undefined) pending = pending.filter((each) => each.update_id >= body.offset);
    // As the real one: an update of a type the request did not list is not sent, so a listener that stops asking for one stops seeing it.
    const asked: string[] | undefined = body.allowed_updates;
    const wanted = (each: Record<string, any>) => asked === undefined || Object.keys(each).some((key) => key !== "update_id" && asked.includes(key));
    return reply(200, { ok: true, result: pending.filter(wanted) });
  }));
  return {
    fetch: fetchImpl, requests,
    get signal() { return stop.signal; },
    /** @param {number} calls ends the next run after this many more polls */
    arm(calls: number) { stop = new AbortController(); stopAt = polls + calls; },
    /** @param {string} method @returns {Request[]} */ calls: (method: string): Request[] => requests.filter((request) => request.method === method),
    /** @param {any[]} more Telegram delivers a further update to the bot */ deliver(...more: any[]) { pending.push(...more); },
  };
}

/**
 * One listener over a state directory. `restart` is a NEW process over the SAME files: a fresh inbound, a fresh offset store.
 * @param {{ directory: string, telegram: ReturnType<typeof fakeTelegram> }} options
 */
function listener({ directory, telegram }: { directory: string; telegram: ReturnType<typeof fakeTelegram>; }) {
  const ledgerPath = join(directory, "ledger.jsonl");
  const offsetPath = join(directory, "offset.json");
  let clock = Date.parse("2026-10-02T10:00:00Z");
  /** @type {number[]} */
  const sleeps: number[] = [];
  /** @type {string[]} */
  const logs: string[] = [];
  /** @type {any[]} */
  const forwarded: any[] = [];
  return {
    ledgerPath, offsetPath, sleeps, logs, forwarded,
    /** @param {{ signal?: AbortSignal }} [options] */
    run({ signal = telegram.signal }: { signal?: AbortSignal; } = {}) {
      const provider = createTelegramPollingProvider({ token: createSecret(TOKEN), chatId: CHAIRMAN.chatId, fetch: telegram.fetch, sleep: async () => {}, log: (line) => logs.push(line) });
      const inbound = createInbound({ ledger: createLedger({ path: ledgerPath, now: () => clock += MS }), chairman: CHAIRMAN });
      return runListener({
        provider, inbound, offsets: createOffsetStore(offsetPath, { log: (line) => logs.push(line) }), chairman: CHAIRMAN,
        onForward: (accepted) => { forwarded.push(accepted); }, sleep: async (ms) => { sleeps.push(ms); }, signal, log: (line) => logs.push(line),
      });
    },
  };
}

/** @param {any} telegram @returns {(number | undefined)[]} the offset each `getUpdates` asked from */
const offsetsAsked = (telegram: any): (number | undefined)[] => telegram.calls("getUpdates").map((/** @type {Request} */ call: Request) => call.body.offset);

describe("the offset (done-when 1)", () => {
  test("after a batch of three is accepted the offset is persisted at the last id plus one, and a restart asks from there", async () => {
    const telegram = fakeTelegram({ updates: [update(10), update(11), update(12)] });
    const first = listener({ directory: freshDirectory(), telegram });
    await first.run();
    assert.equal(first.forwarded.length, 3, "the three updates were handled before the offset is read back");
    assert.deepEqual(JSON.parse(readFileSync(first.offsetPath, "utf8")), { offset: 13 });
    const restarted = fakeTelegram({ updates: [update(10), update(11), update(12), update(13)] });
    const second = listener({ directory: dirname(first.offsetPath), telegram: restarted });
    await second.run();
    assert.deepEqual(offsetsAsked(restarted), [13], "the restart asked from the persisted offset and not from nothing");
    assert.deepEqual(second.forwarded.map((accepted) => accepted.updateId), [13], "and only the update past it was handled");
  });

  test("a listener with no offset file asks from nothing: the counter-case of the test above", async () => {
    const telegram = fakeTelegram({ updates: [update(10)] });
    await listener({ directory: freshDirectory(), telegram }).run();
    assert.deepEqual(offsetsAsked(telegram), [undefined]);
  });

  test("the cursor is the last id plus one, never lower than the one before, and ignores an id that is not an integer", () => {
    assert.equal(nextCursor([{ update_id: 5 }, { update_id: 7 }, { update_id: 6 }], undefined), 8);
    assert.equal(nextCursor([{ update_id: 3 }], 20), 20);
    assert.equal(nextCursor([], 4), 4);
    assert.equal(nextCursor([{ update_id: "9" }, {}, null], undefined), undefined);
  });

  test("a corrupt offset file is 'no offset', said in the log, and does not stop the listener", () => {
    const path = join(freshDirectory(), "offset.json");
    writeFileSync(path, "{not json");
    /** @type {string[]} */
    const logs: string[] = [];
    assert.equal(createOffsetStore(path, { log: (line) => logs.push(line) }).read(), undefined);
    assert.match(logs.join("\n"), /unreadable/);
  });

  test("a batch the core cannot record does not move the offset, and is backed off from rather than skipped", async () => {
    const telegram = fakeTelegram({ updates: [update(15), update(16)], stopAfter: 2 });
    const directory = freshDirectory();
    /** @type {string[]} */
    const logs: string[] = [];
    /** @type {number[]} */
    const sleeps: number[] = [];
    const provider = createTelegramPollingProvider({ token: createSecret(TOKEN), chatId: CHAIRMAN.chatId, fetch: telegram.fetch, sleep: async () => {} });
    const broken = { handle: () => { throw new Error("ledger: disk full"); } };
    await runListener({
      provider, inbound: broken, offsets: createOffsetStore(join(directory, "offset.json")), chairman: CHAIRMAN,
      sleep: async (ms) => { sleeps.push(ms); }, signal: telegram.signal, log: (line) => logs.push(line),
    });
    assert.ok(!existsSync(join(directory, "offset.json")), "nothing was confirmed that was not recorded");
    assert.deepEqual(sleeps, [MS, 2 * MS], "a poll that answered but whose batch could not be recorded is not a success, so the wait keeps growing");
    assert.match(logs.join("\n"), /ledger: disk full/);
  });

  test("POSITIVE CONTROL: one accepted update is processed exactly once across a simulated restart, whether the offset survived it or not", async () => {
    const survived = fakeTelegram({ updates: [update(20)] });
    const directory = freshDirectory();
    const before = listener({ directory, telegram: survived });
    await before.run();
    const after = listener({ directory, telegram: survived });
    survived.arm(1);
    await after.run();
    assert.equal(before.forwarded.length + after.forwarded.length, 1, "offset kept: Telegram does not redeliver it");

    // The crash the ordering exists for: the update was handled and the offset never written, so Telegram hands it over again.
    const lost = fakeTelegram({ updates: [update(21)] });
    const lostDirectory = freshDirectory();
    const crashed = listener({ directory: lostDirectory, telegram: lost });
    await crashed.run();
    rmSync(crashed.offsetPath);
    const resumed = listener({ directory: lostDirectory, telegram: lost });
    lost.arm(1);
    await resumed.run();
    assert.deepEqual(offsetsAsked(lost), [undefined, undefined], "the offset was lost, so it asked from nothing and was handed the update again");
    assert.equal(crashed.forwarded.length + resumed.forwarded.length, 1, "and the ledger turned the replay into nothing");
  });
});

describe("the 409 and the lock (done-when 2)", () => {
  test("a 409 stops the listener with a message naming the other poller, and the token is not in it", async () => {
    const conflict = { status: 409, body: { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" } };
    const telegram = fakeTelegram({ script: [conflict], stopAfter: 99 });
    await assert.rejects(listener({ directory: freshDirectory(), telegram }).run(), (error) => {
      assert.ok(error instanceof PollConflictError);
      assert.match(error.message, /another process is polling this bot/);
      assert.match(error.message, /messaging:listen/);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
    assert.equal(telegram.calls("getUpdates").length, 1, "it was not retried");
  });

  test("main exits REFUSED on a 409 and says why", async () => {
    const harness = mainHarness({ script: [{ status: 409, body: { ok: false, error_code: 409, description: "Conflict" } }], stopAfter: 99 });
    assert.equal(await harness.run(), EXIT.refused);
    assert.match(harness.errors.join("\n"), /another process is polling this bot/);
  });

  test("a second instance fails the lock, naming the holder; the free lock and a stale one are taken, and release frees it", () => {
    const path = join(freshDirectory(), "listener.lock");
    // THE HOLDER IS THE WORKER'S PARENT, NOT THE WORKER: asking whether a pid is alive is `process.kill(pid, 0)`, and rstest's worker throws on that call for its own pid.
    const first = acquireLock(path, { pid: process.ppid });
    assert.throws(() => acquireLock(path, { pid: process.ppid + 1 }), (error) => error instanceof ListenerLockHeld && error.holder === process.ppid && /one listener per bot/.test(error.message));
    first.release();
    assert.ok(!existsSync(path), "release removed it");
    acquireLock(path, { pid: 1234, exists: () => true, startOf: () => "100" });
    const takenOver = acquireLock(path, { pid: 5678, exists: () => false });
    assert.match(readFileSync(path, "utf8"), /^5678 /, "the holder is gone: the stale lock was taken over");
    takenOver.release();
  });

  test("a pid that was handed to another process since is recognised by its start time, and the lock is taken over", () => {
    const path = join(freshDirectory(), "listener.lock");
    acquireLock(path, { pid: 4321, exists: () => true, startOf: () => "100" });
    const next = acquireLock(path, { pid: 8765, exists: () => true, startOf: (pid) => (pid === 4321 ? "999" : "100") });
    assert.match(readFileSync(path, "utf8"), /^8765 /);
    next.release();
  });

  // EVERY TEST ABOVE INJECTS `startOf`, so none of them read the kernel: the real read was off by one field (23, the virtual size, for 22) and passed all of them.
  // The oracle is not a second parse of the same line: field 22 counts clock ticks since boot, so for this very process it is a positive number whose
  // age against /proc/uptime is small, where the virtual size beside it, in bytes, puts the start before the boot and a field before it is zero.
  test("processStart reads field 22 of the real /proc/<pid>/stat: this process started moments ago, by the kernel's own clock", { skip: !existsSync("/proc/self/stat") }, () => {
    const start = Number(processStart(process.pid));
    const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
    const uptimeSeconds = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    assert.ok(start > 0, `a start time is a positive count of ticks, not ${start}`);
    const ageSeconds = uptimeSeconds - start / ticksPerSecond;
    assert.ok(ageSeconds >= 0 && ageSeconds < 3600, `this test process is minutes old at most, by the clock the kernel keeps; got ${ageSeconds}s (a neighbouring field would not give that)`);
    assert.equal(processStart(process.pid), processStart(process.pid), "and it is stable for the life of the process");
    assert.equal(processStart(2 ** 22 + 1), null, "no such process: null, so the pid alone decides");
  });

  test("a release by a process that no longer holds the lock does not delete its successor's", () => {
    const path = join(freshDirectory(), "listener.lock");
    const old = acquireLock(path, { pid: 111, exists: () => true, startOf: () => "1" });
    writeFileSync(path, "222 1\n");
    old.release();
    assert.ok(existsSync(path));
  });
});

describe("the backoff (done-when 3)", () => {
  const failure = { status: 500, body: { ok: false, error_code: 500, description: "boom" } };

  test("errors wait 1, 2, 4 ... up to the ceiling on the injected clock, and a success resets it", async () => {
    const telegram = fakeTelegram({ script: [...Array.from({ length: 8 }, () => failure), "ok", failure], stopAfter: 11 });
    const run = listener({ directory: freshDirectory(), telegram });
    await run.run();
    assert.deepEqual(run.sleeps, [1, 2, 4, 8, 16, 32, 60, 60, 1].map((seconds) => seconds * MS), "the ninth call succeeded, so the tenth's failure starts again at one second; the eleventh ends the run");
  });

  test("nextBackoff doubles from the initial wait and holds at the ceiling", () => {
    assert.equal(nextBackoff(null), BACKOFF_INITIAL_MS);
    assert.equal(nextBackoff(BACKOFF_INITIAL_MS), 2 * BACKOFF_INITIAL_MS);
    assert.equal(nextBackoff(BACKOFF_CEILING_MS), BACKOFF_CEILING_MS);
    assert.equal(nextBackoff(BACKOFF_CEILING_MS / 2 + 1), BACKOFF_CEILING_MS);
  });

  test("a network error is backed off from the same way, and its message does not carry the token", async () => {
    const telegram = fakeTelegram({ script: [new Error(`getaddrinfo ENOTFOUND api.telegram.org/bot${TOKEN}/getUpdates`)], stopAfter: 2 });
    const run = listener({ directory: freshDirectory(), telegram });
    await run.run();
    assert.deepEqual(run.sleeps, [MS]);
    assert.match(run.logs.join("\n"), /retrying in 1s/);
    assert.ok(!run.logs.join("\n").includes(TOKEN));
  });
});

describe("every button press is answered (done-when 4)", () => {
  test("the chairman's press is answered and forwarded; a stranger's is answered and dropped", async () => {
    const telegram = fakeTelegram({ updates: [press(30), press(31, { from: STRANGER, queryId: "stranger-q" })] });
    const run = listener({ directory: freshDirectory(), telegram });
    await run.run();
    assert.deepEqual(telegram.calls("answerCallbackQuery").map((call) => call.body), [{ callback_query_id: "q30" }, { callback_query_id: "stranger-q" }]);
    assert.deepEqual(run.forwarded.map((accepted) => accepted.updateId), [30], "only the chairman's press reached the consumer");
    const lines = readLedgerLines(run.ledgerPath);
    assert.deepEqual(lines.map((line) => [line.updateId, line.verdict]), [[30, "forward"], [31, "drop"]]);
  });

  test("a press that is answered before the handler runs stays answered when the handler throws", async () => {
    const telegram = fakeTelegram({ updates: [press(32)] });
    const run = listener({ directory: freshDirectory(), telegram });
    const provider = createTelegramPollingProvider({ token: createSecret(TOKEN), chatId: CHAIRMAN.chatId, fetch: telegram.fetch, sleep: async () => {} });
    await runListener({
      provider, inbound: createInbound({ ledger: createLedger({ path: run.ledgerPath, now: Date.now }), chairman: CHAIRMAN }),
      offsets: createOffsetStore(run.offsetPath), chairman: CHAIRMAN, onForward: () => { throw new Error("the consumer broke"); },
      sleep: async () => {}, signal: telegram.signal, log: (line) => run.logs.push(line),
    });
    assert.equal(telegram.calls("answerCallbackQuery").length, 1);
    assert.match(run.logs.join("\n"), /forward failed: the consumer broke/);
    assert.deepEqual(JSON.parse(readFileSync(run.offsetPath, "utf8")), { offset: 33 }, "one update's failure did not keep the offset from moving");
  });

  test("a replayed press is answered too, and a press with no query id is not answered and does not stop the batch", async () => {
    const withoutId = { update_id: 41, callback_query: { from: { id: CHAIRMAN.userId }, data: "x", message: { message_id: 5, chat: { id: CHAIRMAN.chatId, type: "private" } } } };
    const telegram = fakeTelegram({ updates: [press(40), withoutId, update(42)] });
    const run = listener({ directory: freshDirectory(), telegram });
    await run.run();
    assert.deepEqual(telegram.calls("answerCallbackQuery").map((call) => call.body.callback_query_id), ["q40"]);
    assert.deepEqual(run.forwarded.map((accepted) => accepted.updateId), [40, 42]);
  });
});

describe("what the listener does about what the core said", () => {
  test("a message from a group is dropped and the bot leaves THAT chat; the chairman's own private chat is never left", async () => {
    const groupMessage = update(50, { chat: { id: GROUP_ID, type: "supergroup" } });
    const strangerPrivate = update(51, { from: { id: STRANGER }, chat: { id: STRANGER, type: "private" } });
    const telegram = fakeTelegram({ updates: [update(49), groupMessage, strangerPrivate] });
    const run = listener({ directory: freshDirectory(), telegram });
    await run.run();
    assert.deepEqual(telegram.calls("leaveChat").map((call) => call.body), [{ chat_id: GROUP_ID }]);
    assert.deepEqual(run.forwarded.map((accepted) => accepted.updateId), [49]);
  });

  test("the chairman's own chat is never left, even when an update calls it a group", async () => {
    const telegram = fakeTelegram({ updates: [update(52, { chat: { id: CHAIRMAN.chatId, type: "group" } })] });
    await listener({ directory: freshDirectory(), telegram }).run();
    assert.equal(telegram.calls("leaveChat").length, 0);
  });

  test("a chat notice is recorded and the bot STAYS: the channel it was added to is never left, answered or forwarded from (#4743)", async () => {
    const added = {
      update_id: 70,
      my_chat_member: { chat: { id: CHANNEL_ID, type: "channel", title: "announcements" }, from: { id: CHAIRMAN.userId }, date: 1, old_chat_member: { status: "left" }, new_chat_member: { status: "administrator" } },
    };
    const post = { update_id: 71, channel_post: { message_id: 1, chat: { id: CHANNEL_ID, type: "channel", title: "announcements" }, date: 1, text: "/stop" } };
    const groupMessage = update(73, { chat: { id: GROUP_ID, type: "supergroup" } });
    const telegram = fakeTelegram({ updates: [added, post, update(72), groupMessage] });
    const run = listener({ directory: freshDirectory(), telegram });
    await run.run();
    assert.deepEqual(telegram.calls("leaveChat").map((call) => call.body), [{ chat_id: GROUP_ID }], "the group is left, as before (the control); the channel is not");
    assert.deepEqual(telegram.requests.map((request) => request.method).filter((method) => !["getUpdates", "leaveChat"].includes(method)), [], "nothing was sent or deleted");
    assert.deepEqual(run.forwarded.map((accepted) => accepted.updateId), [72], "only the chairman's message reached the forward path");
    const seen = readLedgerLines(run.ledgerPath).filter((line) => line.direction === "chat-seen");
    assert.deepEqual(seen.map((line) => [line.chatId, line.type, line.title]), [[CHANNEL_ID, "channel", "announcements"]], "one line, though two updates named the chat");
    assert.equal(JSON.parse(readFileSync(run.offsetPath, "utf8")).offset, 74, "the offset moved past both notices");
  });

  test("a message that is a credential is deleted, then answered; and it is not forwarded", async () => {
    const telegram = fakeTelegram({ updates: [update(60, { text: PASSWORD_LINE })] });
    const run = listener({ directory: freshDirectory(), telegram });
    await run.run();
    assert.deepEqual(telegram.requests.map((request) => request.method).filter((method) => method !== "getUpdates"), ["deleteMessage", "sendMessage"]);
    assert.deepEqual(telegram.calls("deleteMessage")[0].body, { chat_id: CHAIRMAN.chatId, message_id: 60 });
    assert.equal(run.forwarded.length, 0);
  });

  test("a failed step is logged and the next one still runs", async () => {
    const telegram = fakeTelegram({ updates: [update(61, { text: PASSWORD_LINE })] });
    const original = /** @type {any} */ (telegram.fetch);
    telegram.fetch = /** @type {typeof telegram.fetch} */ (async (/** @type {string} */ url: string, init: any) => (url.endsWith("/deleteMessage")
      ? reply(400, { ok: false, error_code: 400, description: "message can't be deleted" }) : original(url, init)));
    const run = listener({ directory: freshDirectory(), telegram });
    await run.run();
    assert.match(run.logs.join("\n"), /deleteMessage failed: telegram deleteMessage failed: 400/);
    assert.equal(telegram.calls("sendMessage").length, 1, "the reply was still sent");
  });
});

describe("the provider", () => {
  test("it passes the conformance suite with its poll section RUN, not skipped", async () => {
    const telegram = fakeTelegram();
    const provider = createTelegramPollingProvider({ token: createSecret(TOKEN), chatId: CHAIRMAN.chatId, fetch: telegram.fetch, sleep: async () => {}, log: () => {} });
    const { passed, skipped } = await runProviderConformance(provider);
    assert.ok(passed.includes("poll-returns-updates-and-honours-abort"));
    assert.ok(!skipped.some((each) => each.check.startsWith("poll")));
    assert.equal(telegram.calls("getUpdates").length, 0, "the already-aborted poll reached no network");
  });

  test("a poll asks for messages, button presses and the two chat notices, with a long timeout, and no offset the first time", async () => {
    const telegram = fakeTelegram();
    const provider = createTelegramPollingProvider({ token: createSecret(TOKEN), chatId: CHAIRMAN.chatId, fetch: telegram.fetch, sleep: async () => {}, log: () => {} });
    await provider.poll(undefined);
    assert.deepEqual(telegram.calls("getUpdates")[0].body, { timeout: LONG_POLL_SECONDS, allowed_updates: [...ALLOWED_UPDATES] });
    assert.deepEqual([...ALLOWED_UPDATES], ["message", "callback_query", "my_chat_member", "channel_post"]);
  });

  test("an abort while the long poll is open returns at once with nothing, and the cursor it was given", async () => {
    const stop = new AbortController();
    const hanging = /** @type {typeof fetch} */ (/** @type {unknown} */ ((/** @type {string} */ _url: string, /** @type {{ signal: AbortSignal }} */ init: { signal: AbortSignal; }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    })));
    const provider = createTelegramPollingProvider({ token: createSecret(TOKEN), chatId: CHAIRMAN.chatId, fetch: hanging, sleep: async () => {}, log: () => {} });
    const pending = provider.poll(77, stop.signal);
    stop.abort();
    assert.deepEqual(await pending, { updates: [], cursor: 77 });
  });
});

/**
 * `main` over a real project root, home, secret files and state directory, in a temp directory, with a fake Telegram.
 * @param {{ script?: Reply[], stopAfter?: number, updates?: any[], paired?: boolean, withKey?: boolean }} [options]
 */
function mainHarness({ script, stopAfter = 1, updates = [], paired = true, withKey = true }: { script?: Reply[]; stopAfter?: number; updates?: any[]; paired?: boolean; withKey?: boolean; } = {}) {
  const home = freshDirectory();
  const root = freshDirectory();
  const secrets = join(home, ".config", "agent-org");
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, ".agent-org"), { recursive: true });
  const messaging = { provider: "telegram", tokenFile: "~/.config/agent-org/token", chairmanFile: "~/.config/agent-org/chairman.json" };
  writeFileSync(join(root, ".agent-org", "project.json"), JSON.stringify(withKey ? { messaging } : {}));
  writeFileSync(join(secrets, "token"), `${TOKEN}\n`, { mode: 0o600 });
  if (paired) writeFileSync(join(secrets, "chairman.json"), `${JSON.stringify(CHAIRMAN)}\n`, { mode: 0o600 });
  const telegram = fakeTelegram({ script, stopAfter, updates });
  /** @type {string[]} */
  const errors: string[] = [];
  /** @type {string[]} */
  const outputs: string[] = [];
  const state = join(home, ".local", "state", "agent-org", "messaging");
  /** What `converse` was handed: the real one queues for `ceo` on this machine, which a unit test must never do. */
  /** @type {number[]} */
  const consumed: number[] = [];
  return {
    home, state, telegram, errors, outputs, consumed,
    /** @param {{ env?: Record<string, string | undefined> }} [more] the environment the unit declares an account in, unless a test says otherwise */
    run: ({ env = { GH_CONFIG_DIR: "/the/unit/gh" } }: { env?: Record<string, string | undefined>; } = {}) => main({
      root, home, env, converse: (accepted) => { consumed.push(accepted.updateId); }, fetch: telegram.fetch, signal: telegram.signal, sleep: async () => {}, out: (line) => outputs.push(line), err: (line) => errors.push(line),
    }),
  };
}

describe("main", () => {
  test("it polls, keeps the offset and the ledger under the state directory, releases the lock, and exits 0 when told to stop", async () => {
    const harness = mainHarness({ updates: [update(70), update(71)] });
    assert.equal(await harness.run(), EXIT.ok);
    assert.deepEqual(JSON.parse(readFileSync(join(harness.state, "offset.json"), "utf8")), { offset: 72 });
    assert.deepEqual(readLedgerLines(join(harness.state, "ledger.jsonl")).map((line) => line.updateId), [70, 71]);
    assert.ok(!existsSync(join(harness.state, "listener.lock")), "the lock was released");
    assert.deepEqual(harness.consumed, [70, 71], "what is not an answer to a request is handed to `converse`, in order");
  });

  test("with the `messaging` key absent it is silent, exits 0, and constructs nothing", async () => {
    const harness = mainHarness({ withKey: false });
    assert.equal(await harness.run(), EXIT.ok);
    assert.equal(harness.telegram.requests.length, 0);
    assert.ok(!existsSync(harness.state), "no state directory was made");
  });

  test("with nobody paired it refuses to start and says to pair, without calling Telegram", async () => {
    const harness = mainHarness({ paired: false });
    assert.equal(await harness.run(), EXIT.refused);
    assert.match(harness.errors.join("\n"), /messaging:pair/);
    assert.equal(harness.telegram.requests.length, 0);
  });

  test("with no GitHub account declared it refuses to start, as the unit's account and never a person's, without calling Telegram", async () => {
    const harness = mainHarness();
    assert.equal(await harness.run({ env: {} }), EXIT.refused);
    assert.match(harness.errors.join("\n"), /no GitHub account is declared/);
    assert.equal(harness.telegram.requests.length, 0);
  });

  test("a second instance refuses with the holder's pid and calls nothing", async () => {
    const harness = mainHarness();
    acquireLock(join(harness.state, "listener.lock"), { pid: process.ppid }); // the worker's parent: see the lock test above
    assert.equal(await harness.run(), EXIT.refused);
    assert.match(harness.errors.join("\n"), new RegExp(`pid ${process.ppid}`));
    assert.equal(harness.telegram.requests.length, 0);
  });
});

describe("the unit (done-when 5)", () => {
  /** @param {string} unit @returns {string[]} what is wrong with it, by the rule it breaks */
  function problemsWith(unit: string): string[] {
    const active = unit.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    const problems = [];
    for (const directive of ["ListenStream", "ListenDatagram", "ListenSequentialPacket", "Port", "Socket", "SocketBindAllow", "EnvironmentFile"]) {
      if (active.some((line) => line.trimStart().startsWith(`${directive}=`))) problems.push(`has ${directive}`);
    }
    if (active.some((line) => /^Environment=.*(TOKEN|SECRET|PASSWORD|KEY)/i.test(line.trim()))) problems.push("has a secret-named Environment");
    if (active.some((line) => /\d{6,}:[\w-]{20,}/.test(line))) problems.push("has a token-shaped string");
    return problems;
  }

  test("the unit has no ListenStream, no Port and no secret", () => {
    assert.deepEqual(problemsWith(readFileSync(UNIT, "utf8")), []);
  });

  test("POSITIVE CONTROL: the same check finds each of them in a unit that has them", () => {
    const bad = `[Service]\nListenStream=8080\nPort=80\nEnvironment=BOT_TOKEN=abc\nExecStart=/bin/true --token ${TOKEN}\nEnvironmentFile=/x\n`;
    assert.deepEqual(problemsWith(bad), ["has ListenStream", "has Port", "has EnvironmentFile", "has a secret-named Environment", "has a token-shaped string"]);
  });

  test("it is Type=simple, restarts on failure and not on a refusal, and starts the listener by the script's name", () => {
    const unit = readFileSync(UNIT, "utf8");
    assert.match(unit, /^Type=simple$/m);
    assert.match(unit, /^Restart=on-failure$/m);
    assert.match(unit, new RegExp(`^RestartPreventExitStatus=${EXIT.refused}$`, "m"));
    assert.match(unit, /^ExecStart=%h\/\.local\/bin\/pnpm run messaging:listen$/m);
  });
});
