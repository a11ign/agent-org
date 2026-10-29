// no-token: gh -- herdr, the tracker, the code host and the clock are injected; nothing is spawned
// A11-272: a wait cycle is found on the tick and broken by the rules of a ticket wait; the chairman's session hears of it once, as one tracker comment on the cycle's smallest key. The 2026-10-25 shape: A11-231 waited on
// A11-229 while A11-229 was held behind A11-231's files (here NBF-1 and NBF-2, whose herdr names the fake numbers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeTracker, fakeTicket } from "../plugins/fakes/tracker.ts";
import { poolFixture } from "./pool-fixture.ts";
import { herdrName } from "./pool.ts";
import { ticketDir } from "./ticket-paths.ts";
import { waitCycles } from "./board-view/wait-cycles.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";

const WAITER = "NBF-1";
const BLOCKER = "NBF-2";
const FILES = ["lab:middleware/runtime/main.py", "lab:middleware/README.md", "lab:middleware/src/", "lab:middleware-spike.yml"];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const T0 = Date.UTC(2026, 9, 25, 12, 3, 0);
const WAITS_ON_BLOCKER = { kind: "working", reason: "step 2 needs NBF-2's step 3", waitingOn: [{ ticket: BLOCKER, until: "done" }] };

/** The pool over a tracker that holds both tickets, with NBF-1 running on `paths` and NBF-2 held behind them (or behind the slots `max` leaves, when they share none), as on 2026-10-25. */
async function incident({ paths = FILES, max = 3, source = createFakeTracker([fakeTicket(WAITER), fakeTicket(BLOCKER)]) }: Readonly<{ paths?: readonly string[]; max?: number; source?: ReturnType<typeof createFakeTracker> }> = {}) {
  let clock = T0;
  const made = poolFixture({ keys: [WAITER, BLOCKER], now: () => clock, source, max });
  made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((entry) => ({ ...entry, paths })) });
  await made.pool.tick();
  made.status.set(herdrName(WAITER), "working");
  await made.pool.tick();
  const pass = async () => {
    clock += 60_000;
    // A run the pass starts is listed working, as its agent is: the passes a start wakes would otherwise read it as gone from herdr.
    for (const entry of made.store.get().entries) if (!made.status.has(herdrName(entry.ticket.key))) made.status.set(herdrName(entry.ticket.key), "working");
    await made.pool.tick();
    await flush();
  };
  /** NBF-1's worker writes `outcome` and goes idle; the pool ticks once. */
  const write = async (key: string, outcome: Record<string, unknown>) => {
    const file = join(ticketDir(made.settings, key), "outcome.json");
    writeFileSync(file, JSON.stringify(outcome));
    utimesSync(file, new Date(clock), new Date(clock));
    made.status.set(herdrName(key), "idle");
    await pass();
  };
  const starts = (key: string) => made.herdr.calls.filter((args) => args.includes("agent") && args.includes("start") && args.includes(herdrName(key)));
  const told = () => JSON.parse(readFileSync(join(made.settings.stateDir, "tickets", "wait-cycles.json"), "utf8")).told as Record<string, { on: string }>;
  return { ...made, source, write, pass, starts, told };
}

test("A11-272: the deadlock reproduced: both tickets move on the first tick after the wait is written, with no reading of the wait yet", async () => {
  const run = await incident();
  assert.deepEqual([run.entry(WAITER).phase, runStatus(run.entry(BLOCKER), run.store.get().entries)], ["running", "blocked"], "NBF-2 is held behind the files NBF-1 holds");
  await run.write(WAITER, WAITS_ON_BLOCKER);
  const waiter = run.entry(WAITER);
  assert.equal(waiter.phase, "queued", "the run let go on the tick: it was in a cycle, so the wait's reading was not needed");
  assert.deepEqual(waiter.stoppedForBlocker?.keys, [BLOCKER]);
  assert.equal(waiter.session, `session-${herdrName(WAITER)}`, "it keeps its own Claude session");
  assert.deepEqual((await run.source.blockers!([WAITER])).get(WAITER)?.map(({ key }) => key), [BLOCKER], "the tracker records NBF-2 as blocking NBF-1");
  assert.ok(["starting", "running"].includes(run.entry(BLOCKER).phase), "NBF-2 starts on the files NBF-1 held");
  assert.equal(run.starts(BLOCKER).length, 1);
  assert.deepEqual(waitCycles(run.store.get().entries), [], "no cycle survives");
});

test("A11-272: the chairman's session hears once: one comment on the smallest key, across later ticks, saying what the board did", async () => {
  const run = await incident();
  await run.write(WAITER, WAITS_ON_BLOCKER);
  assert.equal(run.source.comments.length, 1);
  const [{ key, text }] = run.source.comments;
  assert.equal(key, WAITER);
  assert.match(text, /Wait cycle NBF-1 → NBF-2 → NBF-1/);
  assert.match(text, /NBF-2 is held behind NBF-1's files/);
  assert.match(text, /NBF-1's worker waits on NBF-2/);
  assert.match(text, /released NBF-1's run and queued it behind NBF-2; it resumes its own session once that ticket is done/);
  await run.pass();
  await run.pass();
  assert.equal(run.source.comments.length, 1, "not again on later ticks");
});

test("A11-272: when the ticket it waited on is done, the released run starts again and resumes its own session", async () => {
  const run = await incident();
  await run.write(WAITER, WAITS_ON_BLOCKER);
  mkdirSync(join(run.root, "transcripts", "p"), { recursive: true });
  writeFileSync(join(run.root, "transcripts", "p", `session-${herdrName(WAITER)}.jsonl`), "{}\n");
  run.status.set(herdrName(BLOCKER), "working");
  await run.pass();
  await run.write(BLOCKER, { kind: "done", reason: "built it", evidence: ["the test passes"] });
  await run.pool.refreshTracker();
  await run.pass();
  const resumed = run.starts(WAITER).at(-1)!;
  assert.ok(resumed.includes("--resume") && resumed.includes(`session-${herdrName(WAITER)}`));
  assert.equal(run.entry(WAITER).stoppedForBlocker, undefined);
});

test("A11-272: a wait on a ticket that is in no cycle is still let go only once its first reading finds the ticket not done", async () => {
  // The reading takes a turn of the event loop, as a tracker's answer does: the pass that starts it is over before it ends, however many microtasks the pass takes (A11-282 made its herdr calls asynchronous).
  const source = createFakeTracker([fakeTicket(WAITER), fakeTicket(BLOCKER)]);
  const stateTypes = source.stateTypes!;
  source.stateTypes = async (keys) => { await flush(); return stateTypes(keys); };
  const run = await incident({ paths: [], max: 1, source });
  assert.equal(run.entry(BLOCKER).phase, "queued", "held for the one slot, and on no file");
  await run.write(WAITER, WAITS_ON_BLOCKER);
  assert.equal(run.entry(WAITER).phase, "running", "no cycle: the first tick only starts the reading");
  assert.equal(run.source.comments.length, 0, "and the chairman is told nothing");
  await run.pass();
  assert.equal(run.entry(WAITER).phase, "queued", "the reading found NBF-2 not done");
});

test("A11-272: a workspace herdr will not close is retried on the next tick, and the cycle is told after it is closed", async () => {
  const run = await incident();
  run.herdr.closing.refusal = "the pane is busy";
  await run.write(WAITER, WAITS_ON_BLOCKER);
  assert.equal(run.entry(WAITER).phase, "running");
  assert.equal(run.source.comments.length, 0, "nothing is said while the board has more to do");
  run.herdr.closing.refusal = null;
  await run.pass();
  assert.equal(run.entry(WAITER).phase, "queued");
  assert.equal(run.source.comments.length, 1);
});

test("A11-272: a comment the tracker refuses is tried again on a later tick, even after the cycle has cleared, and not on every pass", async () => {
  const run = await incident();
  const post = run.source.comment!;
  let refuse = true;
  let asked = 0;
  run.source.comment = async (key, body) => { asked += 1; if (refuse) throw new Error("rate limited"); return post(key, body); };
  await run.write(WAITER, WAITS_ON_BLOCKER);
  assert.deepEqual([run.source.comments.length, asked], [0, 1]);
  assert.equal(run.entry(WAITER).phase, "queued", "the cycle is broken whether or not the tracker takes the comment");
  await run.pool.tick();
  await run.pool.tick();
  assert.equal(asked, 1, "not again within the minute");
  refuse = false;
  await run.pass();
  await run.pass();
  assert.deepEqual([run.source.comments.length, asked], [1, 2], "posted once the tracker takes it, and once");
});

test("A11-272: a run let go before its first reading is queued behind every ticket its wait names, not only the one in the cycle", async () => {
  const source = createFakeTracker([fakeTicket(WAITER), fakeTicket(BLOCKER), fakeTicket("NBF-9")]);
  const run = await incident({ source });
  await run.write(WAITER, { ...WAITS_ON_BLOCKER, waitingOn: [{ ticket: BLOCKER, until: "done" }, { ticket: "NBF-9", until: "done" }] });
  assert.deepEqual(run.entry(WAITER).stoppedForBlocker?.keys, [BLOCKER, "NBF-9"]);
  assert.deepEqual((await source.blockers!([WAITER])).get(WAITER)?.map(({ key }) => key).sort(), [BLOCKER, "NBF-9"]);
});

/** Two queued tickets that each block the other in the tracker: a cycle of blockers alone, which the board cannot break. `max: 0` keeps the pool from starting anything. */
function blockersOnly() {
  const source = createFakeTracker([fakeTicket(WAITER), fakeTicket(BLOCKER)]);
  const made = poolFixture({ keys: [WAITER, BLOCKER], source, max: 0 });
  const blocker = (key: string) => [{ key, state: "unstarted", status: "Todo", pulls: {} }];
  const setBlockers = (on: boolean) => made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((entry) => ({ ...entry, blockersReadAt: 100, blockers: on ? blocker(entry.ticket.key === WAITER ? BLOCKER : WAITER) : [] })) });
  const told = () => JSON.parse(readFileSync(join(made.settings.stateDir, "tickets", "wait-cycles.json"), "utf8")).told as Record<string, unknown>;
  return { ...made, source, setBlockers, told };
}

test("A11-272: a cycle of blockers alone stays queued, is named once as one a person must break, and is told again when it clears and forms again", async () => {
  const run = blockersOnly();
  run.setBlockers(true);
  await run.pool.tick();
  await run.pool.tick();
  assert.deepEqual([run.entry(WAITER).phase, run.entry(BLOCKER).phase], ["queued", "queued"], "nothing is changed");
  assert.equal(run.source.comments.length, 1);
  assert.equal(run.source.comments[0].key, WAITER);
  assert.match(run.source.comments[0].text, /a person must remove one blocker relation in the tracker \(NBF-2 blocks NBF-1; NBF-1 blocks NBF-2\)/);
  assert.deepEqual(Object.keys(run.told()), ["NBF-1,NBF-2"]);
  await run.restart({}).tick();
  assert.equal(run.source.comments.length, 1, "a pool that reads the record from disk does not tell a cycle that is still there again");
  run.setBlockers(false);
  await run.pool.tick();
  assert.deepEqual(Object.keys(run.told()), [], "the record forgets a cycle that is gone");
  run.setBlockers(true);
  await run.pool.tick();
  assert.equal(run.source.comments.length, 2, "told again");
});

test("A11-272: a tracker with no comment gets the board's log line only, and the cycle is marked told", async () => {
  const fake = createFakeTracker([fakeTicket(WAITER), fakeTicket(BLOCKER)]);
  const { comment: _none, ...source } = fake;
  const made = poolFixture({ keys: [WAITER, BLOCKER], source, max: 0 });
  made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((entry) => ({ ...entry, blockersReadAt: 100, blockers: [{ key: entry.ticket.key === WAITER ? BLOCKER : WAITER, state: "unstarted", status: "Todo", pulls: {} }] })) });
  await made.pool.tick();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(made.settings.stateDir, "tickets", "wait-cycles.json"), "utf8")).told), ["NBF-1,NBF-2"]);
  assert.equal(fake.comments.length, 0);
});

/**
 * A11-298, the 2026-10-25 board: NBF-1 (A11-229) queued on files, NBF-2 (A11-231) blocked by NBF-1, and NBF-3 (A11-232) a queued review round on pull request #18, which holds #18's files and was queued behind NBF-2
 * by its worker's own wait.
 */
function roundCycle() {
  const url = "https://github.com/a11ign/lab/pull/18";
  const source = createFakeTracker([fakeTicket("NBF-1"), fakeTicket("NBF-2"), fakeTicket("NBF-3")]);
  const made = poolFixture({ keys: ["NBF-1", "NBF-2", "NBF-3"], source, max: 3 });
  const blocker = (key: string) => [{ key, state: "started", status: "In Progress", pulls: {} }];
  made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((entry) => {
    if (entry.ticket.key === "NBF-1") return { ...entry, paths: FILES, blockersReadAt: 100, blockers: [] };
    if (entry.ticket.key === "NBF-2") return { ...entry, paths: [], blockersReadAt: 100, blockers: blocker("NBF-1") };
    return { ...entry, paths: [], review: [{ repo: "lab", url }], pullFiles: { [url]: ["middleware/README.md"] }, stoppedForBlocker: { at: T0, keys: ["NBF-2"], others: [] }, blockersReadAt: 100, blockers: [] };
  }) });
  return { ...made, source };
}

test("A11-298: the cycle 229 → (overlap) 232 → (blocker) 231 → (blocker) 229 is told once, and broken: the round's hold is lifted and 229 starts", async () => {
  const run = roundCycle();
  await run.pool.tick();
  assert.ok(["starting", "running"].includes(run.entry("NBF-1").phase), "NBF-1 starts on the files the round holds, because the round waits on it through NBF-2");
  assert.equal(run.entry("NBF-2").phase, "queued", "and NBF-2 stays behind NBF-1");
  assert.equal(run.source.comments.length, 1);
  const [{ key, text }] = run.source.comments;
  assert.equal(key, "NBF-1");
  assert.match(text, /Wait cycle NBF-1 → NBF-3 → NBF-2 → NBF-1: NBF-1 is held behind NBF-3's files; NBF-3 is blocked by NBF-2; NBF-2 is blocked by NBF-1\./);
  assert.match(text, /The board lifts NBF-3's hold on NBF-1/);
  assert.doesNotMatch(text, /a person must/, "nothing is left for the chairman's session to do");
  await run.pool.tick();
  await run.pool.tick();
  assert.equal(run.source.comments.length, 1, "not again on later ticks");
});
