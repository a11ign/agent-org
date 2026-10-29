// no-token: gh -- herdr, the tracker, the code host and the clock are injected; nothing is spawned
//
// A RUN CHANGED WHILE HERDR ANSWERED IS NOT ACTED ON (A11-282). The board thread's herdr calls hold no loop now, so the queue moves between a call and the code that follows it: a person stops a run, or another
// settle ends it. Each test here makes that happen on purpose: the store is changed INSIDE the pending asynchronous herdr (or environment) answer, and the test asserts the continuation does nothing to the run: no prompt,
// no observation, no end, no close. Each has a CONTROL that leaves the run alone and sees the action happen, so the test could fail. The checks they hold are `stillResumable` (pool-resume.ts), `stillRunning`
// (pool-watch.ts), the parked set read again for each run (pool-sessions.ts) and `sameRun` (pool-settle.ts, in pool-org-repos.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDrain, poolFixture } from "./pool-fixture.ts";
import { herdrName } from "./pool.ts";
import { logOf } from "./queue/run-log.ts";
import type { Queue } from "./queue/queue-entries-and-outcomes.ts";

/** 2026-10-21 at `hour:minute` in the viewer's zone. */
const at = (hour: number, minute: number): number => new Date(2026, 9, 21, hour, minute).getTime();
const KEY = "NBF-1";
const OTHER = "NBF-2";

/** `queue` with every run of `keys` ended, as a stop or another settle leaves it. */
const endedRuns = (queue: Queue, keys: readonly string[]): Queue => ({ ...queue, entries: queue.entries.map((entry) => (keys.includes(entry.ticket.key) ? { ...entry, phase: "finished" as const, workspace: undefined, pane: undefined } : entry)) });

/** `made`, whose run of NBF-1 one instance has started and seen working. */
async function startedFixture(made: ReturnType<typeof poolFixture>) {
  const first = made.restart({});
  await first.tick();
  made.status.set(herdrName(KEY), "working");
  await first.tick();
  return made;
}

const isWorkspaceList = (args: string[]): boolean => args.includes("workspace") && args.includes("list");

/** A run of NBF-1 started and seen working by one instance, and a second instance over the same queue whose herdr answers through `hook`: `hook(args)` runs INSIDE the answer, before it is given. */
async function restartedRun(hook: (args: string[], made: ReturnType<typeof poolFixture>) => void, over: Parameters<ReturnType<typeof poolFixture>["restart"]>[0] = {}) {
  const made = await startedFixture(poolFixture({ keys: [KEY], max: 1 }));
  made.herdr.calls.length = 0;
  const pool = made.restart({ herdrAsync: async (args) => { hook(args, made); return made.herdr.run(args); }, ...over });
  return { made, pool, prompts: () => made.herdr.calls.filter((args) => args.includes("prompt")) };
}

test("after a restart, a run stopped while its pane is read is not sent the resume prompt (CONTROL: left alone, it is)", async () => {
  const control = await restartedRun(() => {});
  control.made.status.set(herdrName(KEY), "idle");
  await control.pool.tick();
  assert.equal(control.prompts().length, 1, "CONTROL: an idle run with no outcome is resumed after a restart");

  let read = false;
  let environmentReads = 0;
  const run = await restartedRun((args, made) => { if (args.includes("agent") && args.includes("read") && !read) { read = true; made.store.set(endedRuns(made.store.get(), [KEY])); } },
    { paneEnv: () => { environmentReads += 1; return null; } });
  run.made.status.set(herdrName(KEY), "idle");
  await run.pool.tick();
  assert.ok(read, "the pane was read");
  assert.deepEqual(run.prompts(), [], "the run ended while herdr answered, so nothing is sent to it");
  assert.equal(environmentReads, 0, "and the environment of its pane is not read either");
});

test("after a restart, a run stopped while its environment is read is not sent the resume prompt, nor started again", async () => {
  let reads = 0;
  let stopWhileReading = false;
  const run = await restartedRun(() => {}, { paneEnv: async () => { reads += 1; if (stopWhileReading) run.made.store.set(endedRuns(run.made.store.get(), [KEY])); return null; } });
  run.made.status.set(herdrName(KEY), "idle");
  stopWhileReading = true;
  await run.pool.tick();
  assert.ok(reads >= 1, "the environment of the pane was read");
  assert.deepEqual(run.prompts(), [], "the run ended while the environment was read, so it is not prompted");
  assert.equal(run.made.herdr.calls.filter((args) => args.includes("workspace") && args.includes("create")).length, 0, "and not started again");
});

test("a run that ends while its pane's dialog is read is not observed as waiting for a person (CONTROL: left alone, it is)", async () => {
  const waiting = async (stopsIt: boolean) => {
    const run = await restartedRun((args, made) => { if (stopsIt && args.includes("agent") && args.includes("read")) made.store.set(endedRuns(made.store.get(), [KEY])); });
    // `blocked` is neither working nor at a prompt: the pane is read for a dialog.
    run.made.status.set(herdrName(KEY), "blocked");
    await run.pool.tick();
    return { entry: run.made.entry(KEY), needsYou: logOf(run.made.store.get(), KEY).filter((event) => event.kind === "needs-you").length };
  };
  const control = await waiting(false);
  assert.deepEqual([control.entry.phase, control.entry.waiting, control.needsYou], ["running", true, 1], "CONTROL: a run on a dialog is seen waiting for a person");
  const ended = await waiting(true);
  assert.deepEqual([ended.entry.phase, ended.entry.waiting, ended.needsYou], ["finished", false, 0], "the run ended while herdr answered, so it is not marked waiting, and no Needs-you is logged for it");
});

test("a run that ends while its worker is told of a declined prompt is not called over for having no outcome afterwards (CONTROL: left alone, it is)", async () => {
  const outcomeKindAfter = async (stopsIt: boolean) => {
    // herdr refuses the message as the agent reads blocked; `stopsIt` has the run end while that refusal is pending.
    const run = await restartedRun((args, made) => {
      if (!args.includes("prompt")) return;
      if (stopsIt) made.store.set(endedRuns(made.store.get(), [KEY]));
      throw Object.assign(new Error("herdr exited 1"), { stdout: JSON.stringify({ error: { code: "agent_blocked", message: "agent_blocked" } }) });
    });
    // The worker declined a safety prompt and has not been told yet.
    run.made.store.set({ ...run.made.store.get(), entries: run.made.store.get().entries.map((entry) => ({ ...entry, declined: { count: 1, at: 100, told: false, command: "rm -f $X/*", warning: "" } })) });
    run.made.status.set(herdrName(KEY), "done");
    await run.pool.tick();
    return run.made.entry(KEY).outcome?.kind;
  };
  assert.equal(await outcomeKindAfter(false), "no-outcome", "CONTROL: an agent that is done with no outcome ends the run no-outcome");
  assert.equal(await outcomeKindAfter(true), undefined, "the run ended while the prompt was sent, so nothing ends it again");
});

test("a leftover agent's workspace is not closed when its run was parked while herdr listed (CONTROL: left alone, it is closed)", async () => {
  const closesOf = async (parksIt: boolean) => {
    const made = poolFixture({ keys: [KEY, OTHER], max: 2 });
    // NBF-1 is a queued Talk session, which must not start beside what holds its name; an idle agent of that name holds it, in workspace w1.
    made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((entry) => (entry.ticket.key === KEY ? { ...entry, talk: true } : entry)) });
    made.status.set(herdrName(KEY), "idle");
    let listings = 0;
    const pool = made.restart({ herdrAsync: async (args) => {
      // The pass lists once to watch its runs, and again to settle the Talk session: while herdr lists for the settling, NBF-2's run ends on a question and is parked in that same workspace.
      if (isWorkspaceList(args)) listings += 1;
      if (parksIt && listings === 2 && isWorkspaceList(args)) {
        made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((entry) => (entry.ticket.key === OTHER ? { ...entry, phase: "finished" as const, workspace: "w1", outcome: { kind: "needs-human" as const, reason: "r" } } : entry)) });
      }
      return made.herdr.run(args);
    } });
    await pool.tick();
    return made.herdr.calls.filter((args) => args.includes("workspace") && args.includes("close") && args.includes("w1")).length;
  };
  assert.ok(await closesOf(false) >= 1, "CONTROL: an idle agent holding a queued Talk session's name is a leftover, and its workspace is closed");
  assert.equal(await closesOf(true), 0, "a workspace a run parked in while herdr listed is a person's pane, and is never closed as a leftover");
});

test("a run that ends while its workspace is closed for an update is not stopped for it, nor queued again, nor recorded as stopped (CONTROL: left alone, it is)", async () => {
  const stoppedFor = async (endsIt: boolean) => {
    const drain = memoryDrain();
    const made = await startedFixture(poolFixture({ keys: [KEY], max: 1, drain, now: () => at(14, 31), startUpdate: () => {} }));
    drain.current = { kind: "draining", record: { target: "v0.280.0", since: new Date(at(12, 30)).toISOString(), deadline: new Date(at(14, 30)).toISOString(), stopped: [] } };
    const pool = made.restart({ herdrAsync: async (args) => {
      if (endsIt && args.includes("workspace") && args.includes("close")) made.store.set(endedRuns(made.store.get(), [KEY]));
      return made.herdr.run(args);
    } });
    await pool.tick();
    return { phase: made.entry(KEY).phase, stoppedForUpdate: made.entry(KEY).stoppedForUpdate, recorded: drain.writes.at(-1)?.stopped };
  };
  assert.deepEqual(await stoppedFor(false), { phase: "queued", stoppedForUpdate: { at: at(14, 31), target: "v0.280.0" }, recorded: [KEY] }, "CONTROL: at the deadline the live run is stopped, queued again and recorded");
  assert.deepEqual(await stoppedFor(true), { phase: "finished", stoppedForUpdate: undefined, recorded: [] }, "the run ended while herdr closed its workspace, so it was not stopped for the update");
});
