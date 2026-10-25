// no-token: gh -- herdr, the tracker, the code host and the clock are injected; nothing is spawned
// A11-272: a run whose worker waits on another ticket gives up its slot and its files: the board records the ticket as its blocker, closes the run and queues it behind the ticket, which starts on the
// files, and the run resumes its own session once the ticket is done. The 2026-10-25 shape: A11-231 waited on A11-229, which needed A11-231's files (here NBF-1 and NBF-2, whose herdr names the fake numbers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { poolFixture } from "./pool-fixture.ts";
import { herdrName } from "./pool.ts";
import { ticketDir } from "./ticket-paths.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import type { TicketSource } from "./source.ts";

const WAITER = "NBF-1";
const BLOCKER = "NBF-2";
const FILES = ["lab:middleware/runtime/main.py", "lab:middleware/README.md", "lab:middleware/src/", "lab:middleware-spike.yml"];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const T0 = Date.UTC(2026, 9, 25, 12, 3, 0);

/** The board's pool over a tracker that holds both tickets, with NBF-1 and NBF-2 queued on the same files: NBF-1 starts, and NBF-2 is held behind its files. */
async function deadlock(source: TicketSource & Partial<ReturnType<typeof createFakeTracker>>, keys = [WAITER, BLOCKER]) {
  let clock = T0;
  const made = poolFixture({ keys, now: () => clock, source, max: 3 });
  made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((entry) => ({ ...entry, paths: FILES })) });
  await made.pool.tick();
  made.status.set(herdrName(WAITER), "working");
  await made.pool.tick();
  /** The worker of `key` writes `outcome` and goes idle; the pool ticks, and the reading it starts is there for the next tick. */
  const write = async (key: string, outcome: Record<string, unknown>) => {
    const file = join(ticketDir(made.settings, key), "outcome.json");
    writeFileSync(file, JSON.stringify(outcome));
    utimesSync(file, new Date(clock), new Date(clock));
    made.status.set(herdrName(key), "idle");
    await pass();
  };
  const pass = async () => { clock += 60_000; await made.pool.tick(); await flush(); };
  const starts = () => made.herdr.calls.filter((args) => args.includes("agent") && args.includes("start"));
  const closes = () => made.herdr.calls.filter((args) => args.includes("workspace") && args.includes("close"));
  const statusOf = (key: string) => runStatus(made.entry(key), made.store.get().entries);
  return { ...made, write, pass, starts, closes, statusOf };
}

/** NBF-1's worker finds that it needs NBF-2's work, and declares the wait. */
const WAITS_ON_BLOCKER = { kind: "working", reason: "step 2 needs NBF-2's step 3", waitingOn: [{ ticket: BLOCKER, until: "done" }] };

const tracker = () => createFakeTracker([fakeTicket(WAITER), fakeTicket(BLOCKER)]);

test("A11-272: the deadlock reproduced: NBF-2 is held behind NBF-1's files, and once NBF-1's worker declares it waits on NBF-2, NBF-2 is held no longer and starts", async () => {
  const run = await deadlock(tracker());
  assert.deepEqual([run.entry(WAITER).phase, run.statusOf(BLOCKER)], ["running", "blocked"], "an ordinary overlap: NBF-1 holds the files");
  await run.write(WAITER, WAITS_ON_BLOCKER);
  assert.equal(run.entry(WAITER).phase, "running", "the first tick only starts the wait's reading");
  assert.ok(["starting", "running"].includes(run.entry(BLOCKER).phase), "a run never holds its files against the ticket it waits on");
});

test("A11-272: a run that waits on a ticket not done gives up its slot and its files: the tracker records the blocker, its workspace closes, it is queued behind it, and the ticket starts", async () => {
  const source = tracker();
  const run = await deadlock(source);
  await run.write(WAITER, WAITS_ON_BLOCKER);
  await run.pass();
  assert.deepEqual((await source.blockers!([WAITER])).get(WAITER)?.map(({ key }) => key), [BLOCKER], "the tracker records NBF-2 as blocking NBF-1");
  const waiter = run.entry(WAITER);
  assert.equal(waiter.phase, "queued");
  assert.equal(waiter.workspace, undefined);
  assert.equal(run.closes().length, 1, "its workspace was closed");
  assert.deepEqual(waiter.stoppedForBlocker, { at: T0 + 2 * 60_000, keys: [BLOCKER], others: [] });
  assert.equal(waiter.session, `session-${herdrName(WAITER)}`, "the Claude session its agent had is kept");
  assert.equal(run.statusOf(WAITER), "blocked");
  assert.ok(["starting", "running"].includes(run.entry(BLOCKER).phase), "NBF-2 starts on the files NBF-1 held");
  assert.equal(run.starts().filter((args) => args.includes(herdrName(BLOCKER))).length, 1);
});

test("A11-272: when the ticket it waited on is done, the stopped run starts again and resumes its own session", async () => {
  const run = await deadlock(tracker());
  await run.write(WAITER, WAITS_ON_BLOCKER);
  await run.pass();
  mkdirSync(join(run.root, "transcripts", "p"), { recursive: true });
  writeFileSync(join(run.root, "transcripts", "p", `session-${herdrName(WAITER)}.jsonl`), "{}\n");
  run.status.set(herdrName(BLOCKER), "working");
  await run.pass();
  await run.pass();
  assert.equal(run.entry(WAITER).phase, "queued", "still held while NBF-2 works");
  await run.write(BLOCKER, { kind: "done", reason: "built it", evidence: ["the test passes"] });
  await run.pass();
  assert.equal(run.starts().filter((args) => args.includes(herdrName(WAITER))).length, 1, "not before the tracker's sweep reads NBF-2 completed");
  await run.pool.refreshTracker();
  await run.pass();
  const resumed = run.starts().filter((args) => args.includes(herdrName(WAITER))).at(-1)!;
  assert.ok(resumed.includes("--resume") && resumed.includes(`session-${herdrName(WAITER)}`), "the round resumes the stopped run's own session");
  assert.ok(["starting", "running"].includes(run.entry(WAITER).phase));
  assert.equal(run.entry(WAITER).stoppedForBlocker, undefined);
});

test("A11-272: a tracker that cannot record a blocker still holds the stopped run until the ticket it waits on is completed", async () => {
  const fake = createFakeTracker([fakeTicket(WAITER), fakeTicket("NBF-9")]);
  const { addBlockers: _cannot, ...source } = fake;
  const run = await deadlock(source, [WAITER]);
  await run.write(WAITER, { ...WAITS_ON_BLOCKER, waitingOn: [{ ticket: "NBF-9", until: "done" }] });
  await run.pass();
  assert.equal(run.entry(WAITER).phase, "queued");
  await run.pass();
  await run.pass();
  assert.equal(run.statusOf(WAITER), "blocked", "nothing lists NBF-9 as its blocker, and the stop's own record holds it");
  assert.equal(run.starts().filter((args) => args.includes(herdrName(WAITER))).length, 1);
  fake.completeAs("NBF-9", "person");
  await run.pass();
  await run.pass();
  assert.equal(run.starts().filter((args) => args.includes(herdrName(WAITER))).length, 2, "it starts once NBF-9 is completed");
});

test("A11-272: a workspace herdr will not close is left running, nothing is queued beside it, and the next tick tries again", async () => {
  const run = await deadlock(tracker());
  await run.write(WAITER, WAITS_ON_BLOCKER);
  run.herdr.closing.refusal = "the pane is busy";
  await run.pass();
  assert.deepEqual([run.entry(WAITER).phase, run.entry(WAITER).workspace, run.entry(WAITER).stoppedForBlocker], ["running", "w1", undefined]);
  run.herdr.closing.refusal = null;
  await run.pass();
  assert.equal(run.entry(WAITER).phase, "queued");
});

test("A11-272: a ticket wait whose ticket is already done is an ordinary declared wait: the run is not stopped, and the worker is woken for it", async () => {
  const source = tracker();
  source.completeAs(BLOCKER, "person");
  const run = await deadlock(source, [WAITER]);
  await run.write(WAITER, WAITS_ON_BLOCKER);
  await run.pass();
  await run.pass();
  assert.equal(run.entry(WAITER).phase, "running");
  assert.equal(run.entry(WAITER).working?.woke?.why, "finished");
  assert.equal(run.closes().length, 0);
});
