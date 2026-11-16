// no-token: none -- herdr is a fake `exec` the test gives, and the client counts into its own ledger; nothing is spawned
//
// A11-436 (R3), step 3: the pool's herdr calls go through the one outside client, with the one rule for what is transient.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCallLedger } from "./call-outcomes.ts";
import { BREAKER_FAILURES, ServiceUnavailable, createOutsideClient, failureKindOf, isTransient } from "./outside-client.ts";
import { herdrThroughClient, type ExecAsync } from "./pool-herdr.ts";
import { poolFixture } from "./pool-fixture.ts";
import { herdrName } from "./pool.ts";
import { CRASH_RETRIES } from "./crash-retry.ts";
import type { ExecResult } from "../plugins/manifest.ts";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { newPoolContext } from "./pool-context.ts";
import { ensureSession } from "./pool-start.ts";

const LIST = ["--session", "tickets", "workspace", "list"];
const START = ["--session", "tickets", "agent", "start", "t-nbf-1", "--pane", "w1:p1"];

/** What `realExecAsync` answers for a herdr it cut at its bound. */
const cut: ExecResult = { status: null, stdout: "", stderr: "spawn herdr ETIMEDOUT", spawnError: "spawn herdr ETIMEDOUT", signal: "SIGTERM" };
/** A herdr whose server is not answering on its socket. */
const refusedConnection: ExecResult = { status: 1, stdout: "", stderr: "error: could not reach the herdr server: Connection refused (os error 111)\n", signal: null };
/** herdr answering that the agent is not there: the service answering, not failing. */
const notFound: ExecResult = { status: 1, stdout: "", stderr: "{\"error\":{\"code\":\"agent_not_found\"}}\n", signal: null };
const answered = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "", signal: null });

/** A client over its own ledger, whose waits take no time, and an `exec` that answers each of `answers` in turn and records each call's options. */
function world(...answers: (ExecResult | "never")[]) {
  const ledger = createCallLedger(() => 1_000);
  const waits: number[] = [];
  const outside = createOutsideClient({ ledger, now: () => 1_000, sleep: async (ms) => { waits.push(ms); } });
  const options: unknown[] = [];
  const exec: ExecAsync = async (file, _args, opts) => {
    assert.equal(file, "herdr");
    options.push(opts);
    const answer = answers[Math.min(options.length, answers.length) - 1];
    return answer === "never" ? new Promise<never>(() => undefined) : answer;
  };
  return { ledger, waits, options, herdr: herdrThroughClient({ outside, exec, echo: false }) };
}

test("Given a herdr call that never answers, when its timeout passes, it fails as transient and is counted once as a failed herdr call", async () => {
  const { herdr, ledger, options } = world("never");
  const failure = await herdr(START, 5).then(() => assert.fail("the call answered"), (err: unknown) => err);
  assert.equal(failureKindOf(failure), "network");
  assert.equal(isTransient(failure), true, "a run that crashed on it is started again by the board");
  assert.equal(options.length, 1, "a start is made once: a second try could start a second agent");
  assert.deepEqual(ledger.figures().herdr, { calls: 1, failures: 1, failuresPer100: 100 });
});

test("A herdr that exec cut at its own bound fails as transient, with the reason a card quotes", async () => {
  const { herdr } = world(cut);
  const failure = await herdr(START, 90_000).then(() => assert.fail("the call answered"), (err: unknown) => err as Error);
  assert.equal(failure.message, "spawn herdr ETIMEDOUT");
  assert.equal(isTransient(failure), true);
});

test("A herdr read that met a refused connection fails as transient and is made once, so a hung herdr holds a pass no longer than its 30 s; exec is told not to count it", async () => {
  const { herdr, ledger, waits, options } = world(refusedConnection, answered("{\"result\":{\"workspaces\":[]}}"));
  const failure = await herdr(LIST, 30_000).then(() => assert.fail("the call answered"), (err: unknown) => err);
  assert.equal(isTransient(failure), true);
  assert.deepEqual([waits, options], [[], [{ timeoutMs: 30_000, countedByCaller: true }]]);
  assert.deepEqual(ledger.figures().herdr, { calls: 1, failures: 1, failuresPer100: 100 });
  assert.equal(await herdr(LIST, 30_000), "{\"result\":{\"workspaces\":[]}}", "the next pass's read finds herdr back");
  assert.deepEqual(ledger.figures().herdr, { calls: 2, failures: 1, failuresPer100: 50 });
});

test("A herdr refusal is herdr answering: not tried again, not a failed call, and its stderr is on the error for the callers that read it", async () => {
  const { herdr, ledger, options } = world(notFound);
  const failure = await herdr(LIST, 30_000).then(() => assert.fail("the call answered"), (err: unknown) => err as Error & { stderr?: string });
  assert.equal(options.length, 1);
  assert.match(failure.stderr ?? "", /agent_not_found/);
  assert.equal(isTransient(failure), false);
  assert.deepEqual(ledger.figures().herdr, { calls: 1, failures: 0, failuresPer100: 0 });
});

test("After ten failed herdr attempts in a row herdr's breaker refuses the next call at once, and says herdr is unavailable", async () => {
  const { herdr, options } = world(cut);
  for (let failed = 0; failed < BREAKER_FAILURES; failed += 1) await assert.rejects(herdr(START, 5));
  const made = options.length;
  const refusal = await herdr(LIST, 5).then(() => assert.fail("the call answered"), (err: unknown) => err);
  assert.ok(refusal instanceof ServiceUnavailable);
  assert.match(refusal.message, /^herdr is unavailable/);
  assert.equal(options.length, made, "the call was not made");
  assert.equal(isTransient(refusal), true);
});

const KEY = "NBF-1";
const FIRST_WAIT = 30_000;

/** The fixture's fake herdr as an `exec`: its answer, or its refusal as herdr's exit 1. */
const execOver = (run: (args: string[]) => string): ExecAsync => async (_file, args) => {
  try {
    return answered(run([...args]));
  } catch (err) {
    return { status: 1, stdout: "", stderr: String((err as { stderr?: unknown }).stderr ?? (err as Error).message), signal: null };
  }
};

test("Given herdr's agent start never answers, the run's start fails as transient: the board starts it again by itself instead of leaving it crashed", async () => {
  const clock = { now: Date.now() };
  const made = poolFixture({ keys: [KEY], max: 1, now: () => clock.now });
  const hanging = { on: true };
  const fake = execOver(made.herdr.run);
  const exec: ExecAsync = (file, args, options) => (hanging.on && args.includes("start") ? new Promise<never>(() => undefined) : fake(file, args, options));
  const outside = createOutsideClient({ ledger: createCallLedger(() => clock.now), sleep: async () => undefined });
  const herdr = herdrThroughClient({ outside, exec, echo: false });
  // The start's own 90 s cannot pass in a test: the client is handed a herdr whose start is cut at 5 ms, as the 90 s would cut it.
  const pool = made.restart({ herdr: () => assert.fail("synchronous herdr called"), herdrAsync: (args, timeoutMs) => herdr(args, args.includes("start") ? 5 : timeoutMs) });
  await pool.tick();
  const crashed = made.entry(KEY);
  assert.equal(crashed.outcome?.kind, "crashed");
  assert.match(crashed.outcome?.kind === "crashed" ? crashed.outcome.reason : "", /herdr could not start Claude for NBF-1 \(herdr did not answer within/);
  assert.deepEqual(crashed.crashRetry, { count: 1, retryAt: clock.now + FIRST_WAIT }, `a transient crash: retry 1 of ${CRASH_RETRIES} is scheduled`);
  hanging.on = false;
  clock.now += FIRST_WAIT;
  await pool.tick();
  made.status.set(herdrName(KEY), "working");
  await pool.tick();
  assert.equal(made.entry(KEY).phase, "running", "started again by the board, with no person's retry");
});

test("Given herdr's workspace create never answers, the start fails as transient too: the pane's refusal carries herdr's failure", async () => {
  const clock = { now: Date.now() };
  const made = poolFixture({ keys: [KEY], max: 1, now: () => clock.now });
  const fake = execOver(made.herdr.run);
  const exec: ExecAsync = (file, args, options) => (args.includes("create") ? Promise.resolve(cut) : fake(file, args, options));
  const herdr = herdrThroughClient({ outside: createOutsideClient({ ledger: createCallLedger(() => clock.now), sleep: async () => undefined }), exec, echo: false });
  const pool = made.restart({ herdr: () => assert.fail("synchronous herdr called"), herdrAsync: herdr });
  await pool.tick();
  assert.equal(made.entry(KEY).outcome?.kind, "crashed");
  assert.equal(made.entry(KEY).crashRetry?.retryAt, clock.now + FIRST_WAIT);
});

test("Whether herdr's server is up is asked directly, not through the board's client: an open herdr breaker does not stop a start from finding the server", async () => {
  const made = poolFixture({ keys: [KEY], max: 1 });
  const ctx = newPoolContext(made.store, { settings: made.settings, source: createFakeTracker([fakeTicket(KEY)]), codeHost: {} as never, hook: { node: "/node", bin: "/tool/versions/v0.273.0/src/bin.ts" },
    herdr: () => assert.fail("synchronous herdr called"), herdrAsync: async (args) => made.herdr.run(args), restartReads: { bootId: () => "boot-1", herdrStart: () => "1" }, now: () => 100, wait: async () => {},
    startServer: () => assert.fail("the server was started although it answers") });
  const breakerOpen = new ServiceUnavailable("herdr", BREAKER_FAILURES, 200);
  await ensureSession({ ...ctx, herdrCall: async () => { throw breakerOpen; } });
});
