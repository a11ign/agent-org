// no-token: gh -- herdr, the tracker, the code host and the clock are injected; the board's two session routes are called over the pool's own queue and state directory
// A11-275: a worker that needs something only the person's session can do declares a `session` wait; the run reads In progress and never Needs you, the ask is in the session's queue, and the session's answer wakes the worker with the result
import { test } from "node:test";
import assert from "node:assert/strict";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { poolFixture } from "./pool-fixture.ts";
import { herdrName } from "./pool.ts";
import { ticketDir } from "./ticket-paths.ts";
import { workingNote } from "./board-view/pull-status-and-notes.ts";
import { sessionAnswerRoute } from "./session-answers.ts";
import { sessionAsksRoute, type SessionAsksView } from "./session-asks.ts";

const NAME = herdrName("NBF-1");
const PANE = "w1:p1";
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 25, 10, 0, 0);
const ASK = "run `agent-org update` on the Mac; a pass reads installed 0.312.0";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** NBF-1 wrote `working` declaring a `session` wait and went idle: the pool, its fakes, the clock a test moves, and the two session routes over the pool's own queue. */
async function askingRun(until = "2026-10-25T14:00:00Z") {
  let clock = T0;
  const made = poolFixture({ now: () => clock });
  const pool = made.restart({});
  await pool.tick();
  made.status.set(NAME, "working");
  await pool.tick();
  const file = join(ticketDir(made.settings, "NBF-1"), "outcome.json");
  const write = async (outcome: Record<string, unknown>) => {
    writeFileSync(file, JSON.stringify(outcome));
    utimesSync(file, new Date(clock), new Date(clock));
    made.status.set(NAME, "idle");
    await pool.tick();
    await flush();
  };
  await write({ kind: "working", reason: "needs the Mac", waitingOn: [{ session: ASK }], until });
  const board = { stateDir: made.settings.stateDir, now: () => clock, queue: made.store.get };
  const asks = () => (sessionAsksRoute(board, "GET", "/api/session-asks", new URLSearchParams())![1] as SessionAsksView).asks;
  const answer = (result: string) => sessionAnswerRoute(board, "POST", "/api/session-asks/NBF-1/answer", { ask: ASK, result })!;
  const prompts = () => made.herdr.calls.filter((args) => args.includes("prompt") && args.includes(PANE)).map((args) => String(args.at(-1)));
  const pass = async (ms = MIN) => { clock += ms; await pool.tick(); await flush(); };
  const passes = async (count: number, ms = MIN) => { for (let i = 0; i < count; i += 1) await pass(ms); };
  return { ...made, write, asks, answer, prompts, pass, passes, working: () => made.entry("NBF-1").working, note: () => workingNote(made.entry("NBF-1")) };
}

test("A11-275: a worker that declares an ask for the person's session is waiting, not Needs you, and the ask is in the session's queue", async () => {
  const run = await askingRun();
  await run.passes(3);
  assert.equal(run.working()?.waiting, true);
  assert.equal(run.working()?.stalled, undefined);
  assert.equal(run.note()?.text, `Waiting on the person's session: ${ASK} (asked, no answer yet)`);
  assert.equal(run.note()?.waiting, true);
  assert.equal(run.entry("NBF-1").outcome, undefined, "the run has no outcome: it is not finished, so it cannot be Needs you");
  assert.deepEqual(run.asks(), [{ kind: "waiting-run", key: "NBF-1", url: "https://linear.app/x/NBF-1", pullRequests: [], ask: ASK, sentAt: T0, answer: "/api/session-asks/NBF-1/answer" }]);
  assert.deepEqual(run.prompts(), [], "nobody is prompted while the ask is open");
});

test("A11-275: the session's answer finishes the wait and the worker is prompted once, with the result in the prompt", async () => {
  const run = await askingRun();
  await run.passes(2);
  assert.deepEqual(run.answer("installed 0.312.0"), [200, { key: "NBF-1", ask: ASK, result: "installed 0.312.0" }]);
  assert.deepEqual(run.asks(), [], "an answered ask leaves the queue");
  await run.passes(6);
  assert.equal(run.prompts().length, 1, "exactly one prompt");
  assert.ok(run.prompts()[0].startsWith(`What you waited on has finished: the person's session answered "${ASK}": installed 0.312.0. Act on it`), run.prompts()[0]);
  assert.equal(run.working()?.woke?.why, "finished");
  assert.equal(run.working()?.stalled, undefined);
});

test("A11-275: an ask nobody answers wakes the worker once at its deadline to declare it again, and is not Needs you", async () => {
  const run = await askingRun("2026-10-25T10:30:00Z");
  await run.passes(40);
  assert.equal(run.prompts().length, 1);
  assert.ok(run.prompts()[0].startsWith(`Your wait passed its deadline (2026-10-25T10:30:00.000Z) with these still pending: the person's session: ${ASK}`), run.prompts()[0]);
  assert.equal(run.working()?.woke?.why, "late");
  assert.deepEqual(run.answer("too late")[0], 409, "the session is told the wait has ended");
});

test("A11-275: an answer given for an earlier declaration of the same words does not finish a later one", async () => {
  const run = await askingRun();
  await run.passes(2);
  run.answer("first answer");
  await run.passes(6);
  assert.equal(run.working()?.woke?.why, "finished");
  // The worker declares the same ask again, a minute later, with a deadline of its own.
  await run.pass();
  await run.write({ kind: "working", reason: "needs the Mac again", waitingOn: [{ session: ASK }], until: "2026-10-25T14:00:00Z" });
  await run.passes(6);
  assert.equal(run.working()?.woke, undefined, "the earlier answer does not wake the new declaration");
  assert.equal(run.asks().length, 1, "and the ask is in the queue again, with the new time");
  assert.equal(run.prompts().length, 1, "only the first wake was sent");
});
