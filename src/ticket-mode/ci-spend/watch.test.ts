// no-token: gh -- herdr, git, the tracker, the code host and the clock are injected; nothing is spawned
// A11-261: the sweep reads what a ticket's pushes cost in CI from the code host, keeps it on the queue, warns the worker once past the budget, and holds the run at twice it: a live run is stopped and queued again, its next round starts
// on the board's next pass with the reason in its brief. The ticket is NBF-1 in the clone `nbl-ui-netbox`, whose `origin` names a11ign/nbl-ui-netbox; its branch is `nbf-1`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeCodeHost } from "../../plugins/fakes/code-host.ts";
import { branchCiKey } from "../../plugins/fakes/code-host-ci.ts";
import type { BranchCiRun, CodeHost } from "../../plugins/contracts/code-host.ts";
import { poolFixture } from "../pool-fixture.ts";
import { herdrName } from "../pool.ts";
import { ticketDir } from "../ticket-paths.ts";
import { BRIEF_FILE } from "../worker-files.ts";
import { logOf } from "../queue/run-log.ts";
import { waitNote } from "../board-view/pull-status-and-notes.ts";
import { FINISHED_READ_MS } from "./watch.ts";
import { ciViewOf } from "./view.ts";
import { holdReason, warnPrompt } from "./budget.ts";
import { PUSH_ONCE_RULE } from "./rules.ts";
import { runsOf } from "./store.ts";

const KEY = "NBF-1";
const REPOSITORY = "a11ign/nbl-ui-netbox";
const BRANCH = "nbf-1";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 25, 10, 0, 0);

/** A job on `labels` that ran for `minutes` whole minutes, started at 10:00:05. */
const job = (labels: string[], minutes: number) => ({ labels, startedAt: "2026-10-25T10:00:05Z", completedAt: new Date(Date.parse("2026-10-25T10:00:05Z") + minutes * MINUTE).toISOString() });
const run = (id: number, jobs: BranchCiRun["jobs"], over: Partial<BranchCiRun> = {}): BranchCiRun => ({ id, headSha: `head-${id}`, createdAt: new Date(T0 + 2 * MINUTE).toISOString(), status: "completed", jobs, ...over });

/**
 * NBF-1 started and running in `w1` over a fake code host that holds `runs` for its branch, with `budget` weighted minutes. `sweep` is one `watchFeedback` and what it started; `tick` is one pass of the board.
 * The code host may be given without `readBranchCi` (`readsBranches: false`), as a plugin of contract 1.21 is.
 */
async function board({ budget = 10, runs = [] as BranchCiRun[], readsBranches = true, finished = false, others = 0 } = {}) {
  let clock = T0 + MINUTE;
  const made = poolFixture({ keys: [KEY, ...Array.from({ length: others }, (_, n) => `NBF-${n + 2}`)], now: () => clock, tickets: { ciBudgetMinutes: budget }, max: 10 });
  const fake = createFakeCodeHost();
  fake.branchCi.runs.set(branchCiKey(REPOSITORY, BRANCH), runs);
  const { readBranchCi: _reads, ...older } = fake;
  const codeHost: CodeHost = readsBranches ? fake : older;
  /** Set to herdr's message to have it refuse every prompt to a pane with it. */
  const prompting: { refusal: string | null } = { refusal: null };
  const herdr = (args: string[]): string => {
    if (prompting.refusal !== null && args.includes("agent") && args.includes("prompt")) throw Object.assign(new Error("herdr exited 1"), { stdout: JSON.stringify({ error: { message: prompting.refusal } }) });
    return made.herdr.run(args);
  };
  const pool = made.restart({ codeHost, herdr, git: async () => `https://github.com/${REPOSITORY}.git\n` });
  await pool.tick();
  made.status.set(herdrName(KEY), "working");
  await pool.tick();
  /** The worker makes its worktree, as a started or resumed worker does, which records the repository it works in. */
  const worktreesMade = () => made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((entry) => ({ ...entry, repos: ["nbl-ui-netbox"] })) });
  worktreesMade();
  if (finished) {
    const url = `https://github.com/${REPOSITORY}/pull/1`;
    fake.seedPull(REPOSITORY, 1);
    made.store.set({ ...made.store.get(), entries: made.store.get().entries.map((entry) => ({ ...entry, phase: "finished" as const, finishedAt: clock, workspace: undefined, pane: undefined, outcome: { kind: "ready-pr" as const, prs: [{ repo: "nbl-ui-netbox", url }] } })) });
  }
  const sweep = async () => { pool.watchFeedback(); await flush(); await flush(); };
  const tick = async () => { clock += MINUTE; await pool.tick(); await flush(); };
  const prompts = () => made.herdr.calls.filter((args) => args.includes("agent") && args.includes("prompt"));
  const closes = () => made.herdr.calls.filter((args) => args.includes("workspace") && args.includes("close"));
  const starts = () => made.herdr.calls.filter((args) => args.includes("agent") && args.includes("start"));
  const record = () => made.store.get().ciSpend?.[KEY];
  const brief = () => readFileSync(join(ticketDir(made.settings, KEY), BRIEF_FILE), "utf8");
  const advance = (ms: number) => { clock += ms; };
  return { ...made, fake, pool, prompting, advance, sweep, tick, worktreesMade, prompts, closes, starts, record, brief, clock: () => clock };
}

test("A11-261: the sweep reads the workflow runs of the ticket's branch in the clone's repository, even before a pull request exists, and keeps them on the queue", async () => {
  const b = await board({ runs: [run(2, [job(["ubuntu-latest"], 3)], { status: "in_progress" }), run(1, [job(["macos-14"], 1), job(["ubuntu-latest"], 2)])] });
  assert.equal(b.entry(KEY).phase, "running");
  assert.equal(b.entry(KEY).ticket.branch, BRANCH);
  await b.sweep();
  assert.deepEqual(b.fake.branchCi.asked, [{ repository: REPOSITORY, branch: BRANCH, settled: [] }]);
  assert.deepEqual(runsOf(b.store.get(), KEY).map(({ id }) => id).sort(), [1, 2]);
  assert.deepEqual(ciViewOf(b.store.get(), b.entry(KEY), 10)?.ticket, { pushes: 2, jobs: 3, weighted: 15 }, "10 for the macOS minute, 2 and 3 for the Linux ones");
});

test("A11-261: a completed run is settled: its jobs are kept and the host is told not to read it again, while a run still going is read each time", async () => {
  const b = await board({ budget: 0, runs: [run(2, [job(["ubuntu-latest"], 1)], { status: "in_progress" }), run(1, [job(["macos-14"], 1)])] });
  await b.sweep();
  b.fake.branchCi.runs.set(branchCiKey(REPOSITORY, BRANCH), [run(2, [job(["ubuntu-latest"], 4)]), run(1, [job(["macos-14"], 1)])]);
  await b.sweep();
  assert.deepEqual(b.fake.branchCi.asked.map(({ settled }) => settled), [[], [1]], "the second read is told run 1 is settled");
  assert.deepEqual(ciViewOf(b.store.get(), b.entry(KEY), 0)?.ticket, { pushes: 2, jobs: 2, weighted: 14 }, "run 1's jobs were kept, and run 2 finished and is counted");
  await b.sweep();
  assert.deepEqual(b.fake.branchCi.asked.at(-1)?.settled.sort(), [1, 2], "both are settled now");
});

test("A11-261: the run's figures count from its first start and the ticket's count every push of the branch", async () => {
  const before = run(1, [job(["ubuntu-latest"], 5)], { createdAt: new Date(T0 - 3600_000).toISOString() });
  const b = await board({ budget: 0, runs: [run(2, [job(["macos-14"], 1)], { createdAt: new Date(T0 + 2 * MINUTE).toISOString() }), before] });
  await b.sweep();
  assert.equal(b.entry(KEY).ciSince, T0 + MINUTE, "recorded once, when the run first started");
  const view = ciViewOf(b.store.get(), b.entry(KEY), 0)!;
  assert.deepEqual([view.run, view.ticket], [{ pushes: 1, jobs: 1, weighted: 10 }, { pushes: 2, jobs: 2, weighted: 15 }]);
});

test("A11-261: past the budget the live worker is told in its pane, once, and the sweep records the warning", async () => {
  const b = await board({ budget: 10, runs: [run(1, [job(["macos-14"], 1), job(["ubuntu-latest"], 3)])] });
  await b.sweep();
  const name = herdrName(KEY);
  assert.deepEqual(b.prompts().map((args) => [args.at(-3), args.at(-2), args.at(-1)]), [["prompt", name, warnPrompt(13, 10)]], "one line, naming the total and where the board holds the run");
  assert.equal(b.record()?.warned, 13);
  assert.equal(b.entry(KEY).phase, "running", "a warning stops nothing");
  await b.sweep();
  await b.sweep();
  assert.equal(b.prompts().length, 1, "never again for this ticket");
});

test("A11-261: a worker whose pane refuses the warning is told again by the next sweep, and the warning is recorded only once it was taken", async () => {
  const b = await board({ budget: 10, runs: [run(1, [job(["macos-14"], 1), job(["ubuntu-latest"], 3)])] });
  b.prompting.refusal = "the pane is busy";
  await b.sweep();
  assert.equal(b.record()?.warned, undefined);
  b.prompting.refusal = null;
  await b.sweep();
  assert.deepEqual([b.record()?.warned, b.prompts().length], [13, 1], "the refused prompt never reached the pane, and the next one did");
});

test("A11-261: at twice the budget a live run is stopped and queued again with its session, and the card says why", async () => {
  const b = await board({ budget: 10, runs: [run(1, [job(["macos-14"], 2), job(["ubuntu-latest"], 5)])] });
  await b.sweep();
  const entry = b.entry(KEY);
  const reason = holdReason(25, 10, 2);
  assert.equal(reason, "Held: CI ~25 min, over twice this ticket's budget of 10");
  assert.equal(entry.phase, "queued");
  assert.equal(b.closes().length, 1, "its workspace was closed, as the update drain closes one");
  assert.equal(entry.session, `session-${herdrName(KEY)}`, "the Claude session its agent had is kept");
  assert.deepEqual(entry.ciHold, { reason, at: b.clock(), passes: 0 });
  assert.equal(waitNote(entry, b.store.get().entries), reason, "the card shows why");
  assert.deepEqual([b.record()?.warned, b.record()?.held], [25, 2]);
  assert.equal(b.prompts().length, 0, "the hold says it all: no warning beside it");
  assert.deepEqual(logOf(b.store.get(), KEY).filter(({ kind }) => kind === "requeued").map((event) => (event as { why: string }).why), ["ci-budget"]);
});

test("A11-261: the held run starts its next round on the board's next pass, resuming its session, with the reason and the push-once rule at the head of its brief, and no person is asked", async () => {
  const b = await board({ budget: 10, runs: [run(1, [job(["macos-14"], 2), job(["ubuntu-latest"], 5)])] });
  await b.sweep();
  const startsBefore = b.starts().length;
  mkdirSync(join(b.root, "transcripts", "p"), { recursive: true });
  writeFileSync(join(b.root, "transcripts", "p", `session-${herdrName(KEY)}.jsonl`), "{}\n");
  await b.tick();
  assert.equal(b.entry(KEY).phase, "queued", "held through the pass that follows");
  assert.equal(b.starts().length, startsBefore);
  await b.tick();
  const resumed = b.starts().at(-1)!;
  assert.equal(b.starts().length, startsBefore + 1, "started again, on the pass after");
  assert.ok(resumed.includes("--resume") && resumed.includes(`session-${herdrName(KEY)}`), "it resumes the stopped run's own session");
  assert.ok(["starting", "running"].includes(b.entry(KEY).phase));
  assert.equal(b.entry(KEY).ciHold, undefined);
  assert.equal(b.entry(KEY).outcome, undefined, "never a needs-human");
  const text = b.brief();
  assert.ok(text.startsWith(`# ${KEY}: ${KEY}\n\n## The board held this run\n\nHeld: CI ~25 min, over twice this ticket's budget of 10.`), text.slice(0, 200));
  assert.ok(text.includes(PUSH_ONCE_RULE));
  assert.equal(b.entry(KEY).rounds, undefined, "a hold is not one of the review rounds the cap counts");
  assert.deepEqual(logOf(b.store.get(), KEY).filter(({ kind }) => kind === "round").map((event) => (event as { cause: string }).cause), ["ci-budget"]);
});

test("A11-261: a run that goes on pushing is held again at each further whole budget, and not before", async () => {
  const b = await board({ budget: 10, runs: [run(1, [job(["macos-14"], 2)])] });
  await b.sweep();
  assert.equal(b.record()?.held, 2);
  await b.tick();
  await b.tick();
  assert.ok(["starting", "running"].includes(b.entry(KEY).phase));
  b.status.set(herdrName(KEY), "working");
  await b.tick();
  b.worktreesMade();
  await b.sweep();
  assert.equal(b.closes().length, 1, "no new hold at the same multiple");
  b.fake.branchCi.runs.set(branchCiKey(REPOSITORY, BRANCH), [run(2, [job(["macos-14"], 1)]), run(1, [job(["macos-14"], 2)])]);
  await b.sweep();
  assert.equal(b.closes().length, 2, "held again at three times the budget");
  assert.equal(b.record()?.held, 3);
  assert.equal(b.entry(KEY).ciHold?.reason, holdReason(30, 10, 3));
});

test("A11-261: a budget of 0 never warns or holds, and the figures still show", async () => {
  const b = await board({ budget: 0, runs: [run(1, [job(["macos-14"], 90)])] });
  await b.sweep();
  assert.equal(b.prompts().length, 0);
  assert.equal(b.closes().length, 0);
  assert.equal(b.entry(KEY).phase, "running");
  assert.deepEqual([b.record()?.warned, b.record()?.held], [undefined, undefined]);
  assert.deepEqual(ciViewOf(b.store.get(), b.entry(KEY), 0), { run: { pushes: 1, jobs: 1, weighted: 900 }, ticket: { pushes: 1, jobs: 1, weighted: 900 }, budget: 0, state: "ok" });
});

test("A11-261: a ticket under its budget is neither warned nor held", async () => {
  const b = await board({ budget: 10, runs: [run(1, [job(["ubuntu-latest"], 10)])] });
  await b.sweep();
  assert.deepEqual([b.prompts().length, b.closes().length, b.entry(KEY).phase], [0, 0, "running"], "ten weighted minutes is the budget, not past it");
});

test("A11-261: a code host without readBranchCi changes nothing, and says so once", async () => {
  const b = await board({ readsBranches: false });
  const before = b.store.get();
  await b.sweep();
  await b.sweep();
  assert.equal(b.store.get().ciSpend, undefined);
  assert.deepEqual(b.store.get().entries, before.entries);
  assert.equal(b.prompts().length + b.closes().length, 0);
});

test("A11-261: a branch the code host cannot read changes nothing: no run is counted, warned or held", async () => {
  const b = await board({ budget: 10, runs: [run(1, [job(["macos-14"], 3)])] });
  await b.sweep();
  assert.equal(b.closes().length, 1);
  b.fake.branchCi.runs.delete(branchCiKey(REPOSITORY, BRANCH));
  const held = b.record();
  await b.sweep();
  assert.deepEqual(b.record(), held, "a read that cannot be made never reads as no runs");
});

test("A11-261: a finished run with a pull request open is read and its next round is told why, but it is not stopped", async () => {
  const b = await board({ budget: 10, finished: true, runs: [run(1, [job(["macos-14"], 3)])] });
  await b.sweep();
  assert.equal(b.entry(KEY).phase, "finished");
  assert.equal(b.closes().length, 0);
  assert.equal(b.prompts().length, 0, "it has no pane");
  assert.equal(b.entry(KEY).ciTold, holdReason(30, 10, 3), "its next round is told why");
  assert.equal(b.entry(KEY).ciHold, undefined, "and nothing holds it");
  assert.equal(b.record()?.held, 3);
});

test("A11-261: a run still starting, or one a person is talking to, is left for a later sweep, and the hold is not recorded", async () => {
  const b = await board({ budget: 10, runs: [run(1, [job(["macos-14"], 3)])] });
  b.store.set({ ...b.store.get(), entries: b.store.get().entries.map((entry) => ({ ...entry, talk: true })) });
  await b.sweep();
  assert.equal(b.closes().length, 0);
  assert.equal(b.record()?.held, undefined);
  b.store.set({ ...b.store.get(), entries: b.store.get().entries.map(({ talk: _talking, ...entry }) => entry) });
  await b.sweep();
  assert.equal(b.closes().length, 1, "once nobody is talking to it");
});

test("A11-261: a workspace herdr will not close is left running, nothing is queued beside it, and the next sweep tries again", async () => {
  const b = await board({ budget: 10, runs: [run(1, [job(["macos-14"], 3)])] });
  b.herdr.closing.refusal = "the pane is busy";
  await b.sweep();
  assert.deepEqual([b.entry(KEY).phase, b.entry(KEY).ciHold, b.record()?.held], ["running", undefined, undefined]);
  b.herdr.closing.refusal = null;
  await b.sweep();
  assert.equal(b.entry(KEY).phase, "queued");
  assert.equal(b.record()?.held, 3);
});

test("A11-261: a finished run whose workflow runs are all settled is not asked about every sweep, but once every fifteen minutes, and at once while one of its runs is still going", async () => {
  const b = await board({ budget: 0, finished: true, runs: [run(1, [job(["ubuntu-latest"], 1)])] });
  await b.sweep();
  await b.sweep();
  assert.equal(b.fake.branchCi.asked.length, 1, "read once, then left");
  b.advance(FINISHED_READ_MS - 1);
  await b.sweep();
  assert.equal(b.fake.branchCi.asked.length, 1);
  b.advance(1);
  await b.sweep();
  assert.deepEqual(b.fake.branchCi.asked.map(({ settled }) => settled), [[], [1]], "asked again after the quiet time, and told run 1 is settled");
  b.fake.branchCi.runs.set(branchCiKey(REPOSITORY, BRANCH), [run(2, [job(["ubuntu-latest"], 1)], { status: "in_progress" }), run(1, [job(["ubuntu-latest"], 1)])]);
  b.advance(FINISHED_READ_MS);
  await b.sweep();
  await b.sweep();
  assert.equal(b.fake.branchCi.asked.length, 4, "a run still going is asked about every sweep");
});

test("A11-261: no more than three tickets are read for the first time in one sweep, the rest follow on the next, and none is read again before its quiet time is over", async () => {
  const b = await board({ budget: 0, finished: true, others: 4, runs: [run(1, [job(["ubuntu-latest"], 1)])] });
  for (let n = 2; n <= 5; n++) b.fake.branchCi.runs.set(branchCiKey(REPOSITORY, `nbf-${n}`), [run(10 * n, [job(["ubuntu-latest"], 1)])]);
  await b.sweep();
  assert.deepEqual(b.fake.branchCi.asked.map(({ branch }) => branch), ["nbf-1", "nbf-2", "nbf-3"]);
  await b.sweep();
  assert.deepEqual(b.fake.branchCi.asked.map(({ branch }) => branch), ["nbf-1", "nbf-2", "nbf-3", "nbf-4", "nbf-5"], "the two left, and not the three read already");
  await b.sweep();
  assert.equal(b.fake.branchCi.asked.length, 5);
});

test("A11-261: a finished run whose branch ran nothing is asked about once, not every sweep", async () => {
  const b = await board({ budget: 0, finished: true, runs: [] });
  await b.sweep();
  await b.sweep();
  await b.sweep();
  assert.equal(b.fake.branchCi.asked.length, 1);
  assert.equal(b.store.get().ciSpend, undefined, "and nothing is recorded for it");
});

test("A11-261: a finished run whose branch could not be read is asked again by the next sweep, not left for the quiet time, and is counted once it can be", async () => {
  const b = await board({ budget: 10, finished: true, runs: [run(1, [job(["macos-14"], 3)])] });
  b.fake.branchCi.runs.delete(branchCiKey(REPOSITORY, BRANCH));
  await b.sweep();
  assert.equal(b.fake.branchCi.asked.length, 1);
  assert.equal(b.record(), undefined, "nothing is counted from a read that failed");
  b.fake.branchCi.runs.set(branchCiKey(REPOSITORY, BRANCH), [run(1, [job(["macos-14"], 3)])]);
  await b.sweep();
  assert.equal(b.fake.branchCi.asked.length, 2, "the next sweep asked again");
  assert.deepEqual(ciViewOf(b.store.get(), b.entry(KEY), 10)?.ticket, { pushes: 1, jobs: 1, weighted: 30 });
  await b.sweep();
  assert.equal(b.fake.branchCi.asked.length, 2, "and once it was read in full, the quiet time holds");
});

test("A11-261: a ticket whose branch keeps failing does not take the first reads of the others", async () => {
  const b = await board({ budget: 0, finished: true, others: 4, runs: [] });
  b.fake.branchCi.runs.delete(branchCiKey(REPOSITORY, BRANCH));
  for (let n = 2; n <= 5; n++) b.fake.branchCi.runs.set(branchCiKey(REPOSITORY, `nbf-${n}`), [run(10 * n, [job(["ubuntu-latest"], 1)])]);
  await b.sweep();
  await b.sweep();
  const readBranches = new Set(b.fake.branchCi.asked.map(({ branch }) => branch));
  assert.deepEqual([...readBranches].sort(), ["nbf-1", "nbf-2", "nbf-3", "nbf-4", "nbf-5"], "nbf-1 failed twice, and the other four were all read in two sweeps");
  assert.equal(b.store.get().ciSpend?.["NBF-5"] !== undefined, true);
});
