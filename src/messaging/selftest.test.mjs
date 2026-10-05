// no-token: nothing here sends to any chat; the queue is a fake port over a temp file and the seats are a list
// @ts-check
// THE CHAIRMAN'S PATH, CHECKED END TO END BY THE ORGANISATION (a11ign/a11ign#3540, done-whens 1 to 4).
//
// Which parts are REAL and which are FAKE, said once: `createInbound`, `createConverse`, `createLedger` and `measure` are the real modules. The QUEUE is a fake port that writes the same entry shape and
// prints the same kind of refusal as `prompt-session.mjs` (the real port cannot be driven to "the inbox is full" without filling a real inbox), the ROSTER is a list, and the PROVIDER is the self-test's own recorder.
// The live reading, with the real queue and herdr's real roster, is done-when 5 and is on the row.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ACKNOWLEDGEMENT, FALLBACK_RECIPIENT, PASSED_SEAT_ABSENT, RECIPIENT } from "./converse.mjs";
import { readLedgerLines } from "./ledger.mjs";
import { measure } from "./measure.mjs";
import { defaultLedgerPath } from "./state.mjs";
import { RETRY_AFTER_MS, TAKEN_WITHIN_MS, createRecorder, judge, judgeWaiting, main, readState, selftestDue, selftestPaths, sendSelftest, tickSelftest, touchesMessaging, worthAChild } from "./selftest.mjs";

const START = Date.parse("2026-10-05T10:00:00Z");
const DEEP = 10;
const EXIT = { OK: 0, REFUSED: 1, QUEUED: 2 };
const NOT_QUEUED_PREFIX = "NOT PROMPTED, AND NOT QUEUED: ";
const WORKING = [{ label: "liaison", status: "working" }, { label: "ceo", status: "working" }];
const IDLE = WORKING.map((agent) => ({ ...agent, status: "idle" }));

const scratch = mkdtempSync(join(tmpdir(), "messaging-selftest-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextDir = 0;

/** @param {string} path @returns {Record<string, any>[]} */
const entries = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const handoffId = (/** @type {string} */ session, /** @type {string} */ prompt) => `handoff/${session}/${createHash("sha256").update(prompt).digest("hex").slice(0, 8)}`;
const attributed = (/** @type {string} */ text, /** @type {string | null} */ sender) => `Sent to you by \`${sender}\`:\n\n${text}`;

/**
 * The fake queue port: `promptOrQueue` reduced to its branches (an idle seat is typed into, a seat that is not on the roster or whose inbox is full is refused, anything else is queued).
 * `lies` makes it print QUEUED and write nothing, which is the "queue says it held the message and holds nothing" case.
 *
 * @param {{ lies?: boolean }} [options]
 */
function fakePort({ lies = false } = {}) {
  /** @type {{ label: string, text: string }[]} */
  const typed = [];
  const port = /** @type {import("./converse.mjs").QueuePort} */ (/** @type {unknown} */ ({
    EXIT, NOT_QUEUED_PREFIX, run: () => "", STANCE: { DECISION: "decision", FYI: "fyi", UNDECLARED: "undeclared", ORDER: "order" }, attributed, handoffId,
    readHandoffs: (/** @type {string} */ path) => entries(path),
    promptOrQueue(/** @type {Record<string, any>} */ { label, text, path, agents, sender }) {
      const seat = agents?.find((/** @type {{ label: string }} */ agent) => agent.label === label);
      if (seat && ["idle", "done"].includes(seat.status)) {
        typed.push({ label, text: attributed(text, sender) });
        return EXIT.OK;
      }
      if (!seat) {
        process.stderr.write(`${NOT_QUEUED_PREFIX}no session named "${label}". Fix the name and run it again.\n`);
        return EXIT.REFUSED;
      }
      const waiting = entries(path).filter((entry) => entry.session === label).length;
      if (waiting >= DEEP) {
        process.stderr.write(`${NOT_QUEUED_PREFIX}"${label}" already has ${waiting} order(s) waiting.\n`);
        return EXIT.REFUSED;
      }
      if (!lies) appendFileSync(path, `${JSON.stringify({ id: handoffId(label, attributed(text, sender)), session: label, prompt: attributed(text, sender), queuedAt: START })}\n`);
      process.stderr.write("QUEUED\n");
      return EXIT.QUEUED;
    },
  }));
  return { port, typed };
}

/** @param {string} path @param {number} count @param {string} session an inbox already holding `count` orders */
function fillQueue(path, count, session) {
  for (let index = 0; index < count; index += 1) appendFileSync(path, `${JSON.stringify({ id: handoffId(session, `earlier ${index}`), session, prompt: `earlier ${index}`, queuedAt: START })}\n`);
}

/** The queue as the tick leaves it once a seat has taken an entry: the entry is gone. @param {string} path @param {string} id */
function take(path, id) {
  writeFileSync(path, entries(path).filter((entry) => entry.id !== id).map((entry) => `${JSON.stringify(entry)}\n`).join(""));
}

/** @param {{ roster?: { label: string, status: string }[] | null, port?: ReturnType<typeof fakePort>, recorder?: ReturnType<typeof createRecorder>, prefill?: Record<string, number> }} [options] */
function harness({ roster = WORKING, port = fakePort(), recorder = createRecorder(), prefill = {} } = {}) {
  nextDir += 1;
  const home = join(scratch, `home-${nextDir}`);
  const queuePath = join(home, "queue");
  mkdirSync(home, { recursive: true });
  for (const [session, count] of Object.entries(prefill)) fillQueue(queuePath, count, session);
  port.port.defaultQueuePath = () => queuePath;
  const clock = { at: START };
  const now = () => clock.at;
  const sleep = async (/** @type {number} */ ms) => { clock.at += ms; };
  const deps = { home, now, queue: port.port, queuePath, agents: () => roster, recorder };
  return { home, queuePath, clock, now, sleep, deps, port, recorder, ledgerLines: () => readLedgerLines(selftestPaths(home).ledger) };
}

describe("done-when 1: a green path is read, from the ledger file", () => {
  test("a busy liaison: queued, the entry is taken, the acknowledgement came back -> pass, and the line holds the verdict, the ack and the handoff", async () => {
    const h = harness();
    const reading = await sendSelftest(h.deps);
    const handoff = reading.line?.handoff;
    assert.match(String(handoff), /^handoff\/liaison\//);
    const verdict = await judgeWaiting(reading, { now: h.now, sleep: async (ms) => { h.clock.at += ms; take(h.queuePath, handoff); } });
    assert.equal(verdict.result, "pass", JSON.stringify(verdict.stages));
    assert.deepEqual(verdict.stages.map((stage) => [stage.name, stage.ok]), [["listen", true], ["queue", true], ["seat", true], ["back", true]]);
    const [inbound, converse] = h.ledgerLines();
    assert.equal(inbound.direction, "in");
    assert.equal(converse.origin, "converse");
    assert.equal(converse.verdict, "queued");
    assert.equal(converse.taker, RECIPIENT);
    assert.equal(converse.handoff, handoff);
    assert.equal(converse.ackRef, "selftest-1");
    assert.deepEqual(h.recorder.sent.map((message) => message.text), [ACKNOWLEDGEMENT]);
  });

  test("an idle liaison is typed into at once: nothing to wait for, pass", async () => {
    const h = harness({ roster: IDLE });
    const verdict = await judgeWaiting(await sendSelftest(h.deps), { now: h.now, sleep: h.sleep });
    assert.equal(verdict.result, "pass");
    assert.equal(verdict.waitedMs, 0);
  });

  test("the order the seat reads says it is synthetic and asks for no action and nothing sent to the chat", async () => {
    const h = harness({ roster: IDLE });
    await sendSelftest(h.deps);
    const [order] = h.port.typed;
    assert.equal(order.label, RECIPIENT);
    assert.match(order.text, /SYNTHETIC SELF-TEST \d+, NOT THE CHAIRMAN/);
    assert.match(order.text, /Take no action, send nothing to the chat/);
  });

  test("two runs are two updates and two orders: the update id is the ledger's next, so a replay is not mistaken for the first", async () => {
    const h = harness({ roster: IDLE });
    await sendSelftest(h.deps);
    const second = await sendSelftest(h.deps);
    assert.equal(second.updateId, 2);
    assert.equal(second.line?.verdict, "delivered");
    assert.equal(h.port.typed.length, 2);
  });
});

describe("done-when 2: each stage's failure is named, and the absent seat is the positive control", () => {
  test("POSITIVE CONTROL, the failure of 19:44Z: the liaison is absent -> degraded, naming ceo, never green and never red", async () => {
    const h = harness({ roster: [{ label: "ceo", status: "working" }] });
    const reading = await sendSelftest(h.deps);
    const verdict = await judgeWaiting(reading, { now: h.now, sleep: async (ms) => { h.clock.at += ms; take(h.queuePath, reading.line?.handoff); } });
    assert.equal(verdict.result, "degraded");
    assert.match(verdict.detail, /ceo did \(/);
    assert.match(verdict.detail, /no session named "liaison"/);
    assert.equal(reading.line?.taker, FALLBACK_RECIPIENT);
    assert.ok(h.recorder.sent.some((message) => message.text === PASSED_SEAT_ABSENT), "the chairman's would-be explanation was recorded, not sent");
  });

  test("the absent seat with ceo absent too is RED at queue: the message would have been lost", async () => {
    const h = harness({ roster: [] });
    const verdict = await judgeWaiting(await sendSelftest(h.deps), { now: h.now, sleep: h.sleep });
    assert.equal(verdict.result, "red");
    assert.equal(verdict.stage, "queue");
    assert.match(verdict.detail, /neither liaison's queue nor ceo's took it/);
  });

  test("a full inbox: both inboxes full is RED at queue, and the full liaison inbox alone is only degraded", async () => {
    const both = harness({ prefill: { liaison: DEEP, ceo: DEEP } });
    const red = await judgeWaiting(await sendSelftest(both.deps), { now: both.now, sleep: both.sleep });
    assert.equal(red.result, "red");
    assert.equal(red.stage, "queue");
    assert.match(red.detail, /already has 10 order/);
    const one = harness({ prefill: { liaison: DEEP } });
    const reading = await sendSelftest(one.deps);
    const verdict = await judgeWaiting(reading, { now: one.now, sleep: async (ms) => { one.clock.at += ms; take(one.queuePath, reading.line?.handoff); } });
    assert.equal(verdict.result, "degraded");
  });

  test("an acknowledgement that never came back is RED at back, with the provider's own error as the reason", async () => {
    const recorder = { sent: [], send: async () => { throw new Error("the recorder refuses"); } };
    const h = harness({ roster: IDLE, recorder: /** @type {any} */ (recorder) });
    const reading = await sendSelftest(h.deps);
    assert.match(String(reading.thrown), /acknowledgement could not be sent/);
    const verdict = await judgeWaiting(reading, { now: h.now, sleep: h.sleep });
    assert.equal(verdict.result, "red");
    assert.equal(verdict.stage, "back");
    assert.match(verdict.detail, /the recorder refuses/);
  });

  test("a queue that says it held the message and holds nothing is RED at queue", async () => {
    const h = harness({ port: fakePort({ lies: true }) });
    const verdict = await judgeWaiting(await sendSelftest(h.deps), { now: h.now, sleep: h.sleep });
    assert.equal(verdict.result, "red");
    assert.equal(verdict.stage, "queue");
    assert.match(verdict.detail, /its entry is not in the queue file/);
  });

  test("an entry nobody takes within the bound is RED at seat, and the wait was the bound and no longer", async () => {
    const h = harness();
    const verdict = await judgeWaiting(await sendSelftest(h.deps), { now: h.now, sleep: h.sleep });
    assert.equal(verdict.result, "red");
    assert.equal(verdict.stage, "seat");
    assert.match(verdict.detail, /was still in liaison's queue after 600 s/);
    assert.ok(verdict.waitedMs >= TAKEN_WITHIN_MS && verdict.waitedMs < TAKEN_WITHIN_MS + 10_000);
  });

  test("an update the inbound core does not forward is RED at listen, and the later stages are not blamed", () => {
    const reading = /** @type {any} */ ({ handled: { action: "ignore", reason: "wrong-user" }, thrown: null, line: null, recorded: [] });
    const verdict = judge(reading, null);
    assert.equal(verdict.result, "red");
    assert.equal(verdict.stage, "listen");
    assert.match(verdict.detail, /answered "ignore" \(wrong-user\)/);
  });
});

describe("done-when 3: it never reaches the chat, and its line is not a message", () => {
  const tripwire = () => {
    const calls = /** @type {string[]} */ ([]);
    const trap = async (/** @type {unknown} */ message) => { calls.push(JSON.stringify(message)); throw new Error("a real provider was sent to"); };
    return { calls, deps: { provider: { send: trap, id: "telegram" }, send: trap, fetch: trap, telegram: { send: trap } } };
  };

  test("a provider handed in under any name is never sent through: the run still passes and the recorder holds the acknowledgement", async () => {
    const h = harness({ roster: IDLE });
    const trap = tripwire();
    const reading = await sendSelftest({ ...h.deps, ...trap.deps });
    assert.deepEqual(trap.calls, []);
    assert.deepEqual(h.recorder.sent.map((message) => message.text), [ACKNOWLEDGEMENT]);
    assert.equal(reading.line?.ackRef, "selftest-1");
  });

  test("the tick's call and the command's main refuse the same way: no send leaves the recorder", async () => {
    const trap = tripwire();
    const h = harness({ roster: IDLE });
    await tickSelftest({ ...h.deps, ...trap.deps, current: "v1.0.0", recorder: undefined });
    await main([], { home: h.home, now: h.now, queue: h.port.port, agents: () => IDLE, out: () => {}, ...trap.deps });
    assert.deepEqual(trap.calls, []);
  });

  test("the source imports no provider and never calls fetch (the positive control is that it DOES import the converse module it drives)", () => {
    const source = readFileSync(fileURLToPath(new URL("./selftest.mjs", import.meta.url)), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)).join("\n");
    assert.match(source, /from "\.\/converse\.mjs"/);
    assert.doesNotMatch(source, /providers\/|\bfetch\s*\(|telegram/i);
  });

  test("the synthetic line is absent from measure.mjs's count for a window containing it, and would not be if it had landed in the chairman's ledger", async () => {
    const h = harness({ roster: IDLE });
    const chairmanPath = defaultLedgerPath(h.home);
    mkdirSync(dirname(chairmanPath), { recursive: true });
    const real = [
      { direction: "in", updateId: 500, verdict: "forward", kind: "message", ts: new Date(START).toISOString() },
      { direction: "in", origin: "converse", updateId: 500, messageRef: "77", verdict: "queued", ackRef: "9", ackAt: new Date(START + 1000).toISOString(), ts: new Date(START + 2000).toISOString() },
    ];
    writeFileSync(chairmanPath, real.map((line) => `${JSON.stringify(line)}\n`).join(""));
    await sendSelftest(h.deps);
    const window = { since: START - 60_000, until: START + 60_000 };
    const counted = (/** @type {Record<string, any>[]} */ lines) => { const report = measure(lines, window); return report.empty ? 0 : report.messages.length; };
    assert.notEqual(selftestPaths(h.home).ledger, chairmanPath);
    assert.equal(counted(readLedgerLines(chairmanPath)), 1, "only the chairman's own message is counted");
    assert.equal(counted(h.ledgerLines()), 1, "POSITIVE CONTROL: the synthetic line IS countable, so its absence above is the file it is in and not a blind measure");
    assert.deepEqual(readLedgerLines(chairmanPath), real, "the chairman's ledger was not written to");
  });
});

describe("done-when 4: the trigger is a pure function", () => {
  const base = { lastPassed: "v0.49.1", current: "v0.49.2", changedFiles: /** @type {string[] | null} */ ([]), pending: false, lastAttemptAt: /** @type {number | null} */ (null), now: START };

  test("tag unchanged: no run", () => {
    assert.equal(selftestDue({ ...base, current: "v0.49.1", changedFiles: ["src/messaging/converse.mjs"] }).run, false);
  });
  test("tag moved with a messaging change: run", () => {
    for (const file of ["src/messaging/converse.mjs", "src/prompt-session.mjs", "src/wake.mjs", "src/herdr-agents.mjs", "src/project-roles.mjs"]) assert.equal(selftestDue({ ...base, changedFiles: [file, "README.md"] }).run, true, file);
  });
  test("tag moved with none, or with only a messaging TEST: no run", () => {
    assert.equal(selftestDue({ ...base, changedFiles: ["src/work-gate.mjs", "README.md"] }).run, false);
    assert.equal(selftestDue({ ...base, changedFiles: ["src/messaging/converse.test.mjs", "src/messaging/fake-provider.ts"] }).run, true, "fake-provider.ts is a .ts under messaging/ and is a shipped path");
    assert.equal(selftestDue({ ...base, changedFiles: ["src/messaging/converse.test.mjs"] }).run, false);
  });
  test("first ever run (no recorded version): run, whatever changed", () => {
    assert.deepEqual(selftestDue({ ...base, lastPassed: null, changedFiles: null }), { run: true, settled: false, reason: "no run is recorded as passed, so v0.49.2 is checked" });
  });
  test("a change that could not be read is a reason to run, never a reason not to", () => {
    assert.equal(selftestDue({ ...base, changedFiles: null }).run, true);
  });
  test("no release tag at HEAD: no run; a run still waiting for the seat: no second run", () => {
    assert.equal(selftestDue({ ...base, current: null, lastPassed: null }).run, false);
    assert.equal(selftestDue({ ...base, lastPassed: null, pending: true }).run, false);
  });
  test("a failed run is not a pass, and is retried once the back-off has passed", () => {
    const failed = { ...base, changedFiles: ["src/messaging/converse.mjs"], lastAttemptAt: START };
    assert.equal(selftestDue({ ...failed, now: START + RETRY_AFTER_MS - 1 }).run, false);
    assert.equal(selftestDue({ ...failed, now: START + RETRY_AFTER_MS }).run, true);
  });
  test("the path list: positive control for the matcher, and what it deliberately leaves out", () => {
    assert.ok(touchesMessaging(["src/messaging/listen.mjs"]));
    assert.ok(!touchesMessaging(["src/work-gate.mjs", "docs/messaging.md", "src/messaging/listen.test.mjs"]));
    assert.ok(!touchesMessaging(["src/messaging", "src/wake.mjs.bak", "lib/src/wake.mjs", "src/prompt-session.mts"]), "the pattern is anchored: a near miss is not a messaging path");
  });
});

describe("the tick's call: records a PASS only, retries a red, settles a queued entry on a later tick", () => {
  const changed = () => ["src/messaging/converse.mjs"];

  test("first run on an idle seat passes and records the version; the next tick on the same tag is a no-op that says why", async () => {
    const h = harness({ roster: IDLE });
    const first = await tickSelftest({ ...h.deps, current: "v1.0.0", changedFiles: changed });
    assert.match(first.lines[0], /PASS for v1\.0\.0/);
    assert.equal(first.report, null);
    assert.equal(readState(selftestPaths(h.home).state).lastPassed, "v1.0.0");
    const second = await tickSelftest({ ...h.deps, current: "v1.0.0", changedFiles: changed });
    assert.deepEqual(second, { lines: ["messaging selftest: not run, v1.0.0 already passed"], report: null });
    assert.equal(h.port.typed.length, 1, "the seat was not asked twice");
    assert.equal(h.ledgerLines().at(-1)?.direction, "selftest");
  });

  test("a red run is NOT recorded as passed, reaches ceo once as a report naming the stage, and is retried after the back-off with the same report suppressed", async () => {
    const h = harness({ roster: [], port: fakePort() });
    const red = await tickSelftest({ ...h.deps, current: "v1.0.0", changedFiles: changed });
    assert.match(red.lines[0], /RED at queue/);
    assert.match(String(red.report), /RED at the queue stage/);
    assert.match(String(red.report), /sent nothing and has not been told/);
    assert.equal(readState(selftestPaths(h.home).state).lastPassed, null);
    h.clock.at += 60_000;
    const waiting = await tickSelftest({ ...h.deps, current: "v1.0.0", changedFiles: changed });
    assert.match(waiting.lines[0], /back-off has not passed/);
    h.clock.at += RETRY_AFTER_MS;
    const retry = await tickSelftest({ ...h.deps, current: "v1.0.0", changedFiles: changed });
    assert.match(retry.lines[0], /RED at queue/);
    assert.equal(retry.report, null, "ceo was told this failure already");
    assert.equal(h.ledgerLines().filter((line) => line.direction === "selftest").length, 2);
  });

  test("a queued entry is pending, not waited for: a later tick passes it when it has left, and fails the seat stage when it has not within the bound", async () => {
    const taken = harness();
    const sent = await tickSelftest({ ...taken.deps, current: "v1.0.0", changedFiles: changed });
    assert.match(sent.lines[0], /waiting for liaison to take handoff\/liaison\//);
    const { pending } = readState(selftestPaths(taken.home).state);
    taken.clock.at += 30_000;
    assert.match((await tickSelftest({ ...taken.deps, current: "v1.0.0" })).lines[0], /still waiting/);
    take(taken.queuePath, pending?.handoff);
    assert.match((await tickSelftest({ ...taken.deps, current: "v1.0.0" })).lines[0], /PASS for v1\.0\.0/);
    assert.equal(readState(selftestPaths(taken.home).state).lastPassed, "v1.0.0");

    const stuck = harness();
    await tickSelftest({ ...stuck.deps, current: "v1.0.0", changedFiles: changed });
    stuck.clock.at += TAKEN_WITHIN_MS;
    const red = await tickSelftest({ ...stuck.deps, current: "v1.0.0" });
    assert.match(red.lines[0], /RED at seat/);
    assert.match(String(red.report), /RED at the seat stage/);
    assert.equal(readState(selftestPaths(stuck.home).state).lastPassed, null);
  });

  test("an absent liaison is recorded as passed-but-degraded and ceo is told it was degraded, once", async () => {
    const h = harness({ roster: [{ label: "ceo", status: "idle" }] });
    const run = await tickSelftest({ ...h.deps, current: "v1.0.0", changedFiles: changed });
    assert.match(run.lines[0], /DEGRADED for v1\.0\.0/);
    assert.match(String(run.report), /DEGRADED, not green/);
    assert.equal(readState(selftestPaths(h.home).state).lastPassed, "v1.0.0");
  });
});

describe("the command", () => {
  test("prints the four stages, the ledger path and the line, and exits 0 / 3 / 1 for pass / degraded / red", async () => {
    const run = async (/** @type {Parameters<typeof harness>[0]} */ options) => {
      const h = harness(options);
      const out = /** @type {string[]} */ ([]);
      const code = await main([], { home: h.home, now: h.now, sleep: h.sleep, queue: h.port.port, agents: () => (options?.roster ?? WORKING), out: (text) => out.push(text), err: (text) => out.push(text) });
      return { code, out };
    };
    const pass = await run({ roster: IDLE });
    assert.equal(pass.code, 0);
    assert.match(pass.out[0], /^messaging:selftest PASS/);
    assert.deepEqual(pass.out.slice(1, 5).map((text) => text.trim().split(/\s+/)[0]), ["listen", "queue", "seat", "back"]);
    assert.ok(pass.out.some((text) => text.startsWith("ledger: ")) && pass.out.some((text) => text.startsWith("line: {")));
    assert.equal((await run({ roster: [{ label: "ceo", status: "idle" }] })).code, 3);
    assert.equal((await run({ roster: [] })).code, 1);
  });

  test("a flag it does not read is refused and nothing is sent", async () => {
    const h = harness({ roster: IDLE });
    const messages = /** @type {string[]} */ ([]);
    const code = await main(["--send-to-chat"], { home: h.home, now: h.now, queue: h.port.port, agents: () => IDLE, err: (text) => messages.push(text) });
    assert.equal(code, 2);
    assert.deepEqual(h.port.typed, []);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// THE TICK STEP in `wake.mjs`: it is the one place a report can reach `ceo`'s queue, because `src/messaging/` may not name the queue.
// `wake.mjs` reads the project's declaration at import, so it loads where `AGENT_ORG_HOST` finds one; elsewhere these cases are SKIPPED WITH THE REFUSAL AS THE REASON,
// and the "wake.mjs loaded" test says which of the two this run was (a skip that fires always is a check that never runs).
const wake = await import("../wake.mjs").then((module) => ({ module }), (error) => ({ reason: String(error.message).split("\n")[0] }));
const skipUnlessLoaded = "reason" in wake ? `wake.mjs cannot load here: ${wake.reason}` : false;

describe("the tick step queues a report for ceo and for nobody else", () => {
  const spawned = (/** @type {Record<string, any>} */ answer, status = 0) => /** @type {any} */ (() => ({ status, stdout: `noise\n${JSON.stringify(answer)}\n`, stderr: "" }));

  test("wake.mjs loaded whenever the host declaration it needs exists (the skips below are for a bare checkout only)", () => {
    const declared = process.env.AGENT_ORG_HOST !== undefined && existsSync(process.env.AGENT_ORG_HOST);
    assert.ok(skipUnlessLoaded === false || !declared, String(skipUnlessLoaded));
  });

  test("a report is appended to the queue as an order for ceo, and the child's lines are returned", { skip: skipUnlessLoaded }, () => {
    const queueFile = join(scratch, "tick-step-queue");
    const lines = /** @type {any} */ (wake).module.checkChairmanPath({ spawn: spawned({ lines: ["messaging selftest RED at queue for v1.0.0"], report: "RED at the queue stage" }), ask: () => ({ spawn: true, line: null }), queueFile, now: START });
    assert.deepEqual(lines, ["messaging selftest RED at queue for v1.0.0"]);
    const [entry, ...rest] = entries(queueFile);
    assert.deepEqual(rest, []);
    assert.equal(entry.session, "ceo");
    assert.equal(entry.prompt, "RED at the queue stage");
    assert.equal(entry.fyi, false, "an order, not an FYI a lead seat would hold");
  });

  test("no report, no entry; a child that failed or printed nothing readable is a line and no entry", { skip: skipUnlessLoaded }, () => {
    const queueFile = join(scratch, "tick-step-quiet");
    const step = (/** @type {any} */ spawn) => /** @type {any} */ (wake).module.checkChairmanPath({ spawn, ask: () => ({ spawn: true, line: null }), queueFile, now: START });
    assert.deepEqual(step(spawned({ lines: ["not run"], report: null })), ["not run"]);
    assert.match(step(spawned({}, 2))[0], /^MESSAGING SELFTEST NOT RUN: exit 2/);
    assert.match(step(() => ({ status: 0, stdout: "not json", stderr: "" }))[0], /^MESSAGING SELFTEST NOT RUN/);
    assert.match(step(() => ({ error: new Error("spawn ETIMEDOUT"), status: null, stdout: "", stderr: "" }))[0], /ETIMEDOUT/);
    assert.deepEqual(entries(queueFile), []);
  });
});

describe("a quiet tick starts no process and asks no model", () => {
  const empty = readState(join(scratch, "no-such-state"));
  const noSpawn = /** @type {any} */ (() => { throw new Error("a process was started on a quiet tick"); });

  test("worthAChild: nothing to do for a passed or settled version; a child for an unseen one, a waiting entry, or an expired back-off", () => {
    assert.deepEqual(worthAChild({ state: { ...empty, lastPassed: "v1.0.0" }, current: "v1.0.0", now: START }), { spawn: false, line: null });
    assert.deepEqual(worthAChild({ state: { ...empty, lastPassed: "v0.9.0", decidedFor: "v1.0.0" }, current: "v1.0.0", now: START }), { spawn: false, line: null });
    assert.deepEqual(worthAChild({ state: empty, current: null, now: START }), { spawn: false, line: null });
    assert.equal(worthAChild({ state: empty, current: "v1.0.0", now: START }).spawn, true);
    assert.equal(worthAChild({ state: { ...empty, lastPassed: "v0.9.0" }, current: "v1.0.0", now: START }).spawn, true);
    assert.equal(worthAChild({ state: { ...empty, pending: { handoff: "h" } }, current: "v1.0.0", now: START }).spawn, true);
  });

  test("a red inside its back-off repeats ONE line naming the stage and spawns nothing; after the back-off it spawns", () => {
    const red = { ...empty, lastPassed: "v0.9.0", lastAttemptAt: START, lastRed: "seat" };
    const inside = worthAChild({ state: red, current: "v1.0.0", now: START + 60_000 });
    assert.equal(inside.spawn, false);
    assert.match(String(inside.line), /still RED at seat for v1\.0\.0; retrying after 540 s/);
    assert.equal(worthAChild({ state: red, current: "v1.0.0", now: START + RETRY_AFTER_MS }).spawn, true);
  });

  test("a release that changed no messaging path is remembered as decided, so the NEXT tick spawns nothing either", async () => {
    const h = harness({ roster: IDLE });
    await tickSelftest({ ...h.deps, current: "v0.9.0", changedFiles: () => ["src/messaging/converse.mjs"] });
    const quiet = await tickSelftest({ ...h.deps, current: "v1.0.0", changedFiles: () => ["README.md"] });
    assert.match(quiet.lines[0], /touches no messaging path/);
    const state = readState(selftestPaths(h.home).state);
    assert.equal(state.decidedFor, "v1.0.0");
    assert.equal(worthAChild({ state, current: "v1.0.0", now: h.now() }).spawn, false);
    assert.equal(worthAChild({ state, current: "v1.0.1", now: h.now() }).spawn, true, "the next release asks again");
  });

  test("the step in wake.mjs starts no process when the question says there is nothing to do, and says so when it cannot ask", { skip: skipUnlessLoaded }, () => {
    const step = (/** @type {any} */ ask) => /** @type {any} */ (wake).module.checkChairmanPath({ spawn: noSpawn, ask });
    assert.deepEqual(step(() => ({ spawn: false, line: null })), []);
    assert.deepEqual(step(() => ({ spawn: false, line: "messaging selftest still RED at seat for v1.0.0; retrying after 60 s" })), ["messaging selftest still RED at seat for v1.0.0; retrying after 60 s"]);
    assert.match(step(() => { throw new Error("git is gone"); })[0], /^MESSAGING SELFTEST NOT RUN: it could not be asked/);
  });
});
