// no-token: gh -- herdr and the clock are injected and the directories are a test's own; the pool is driven over fakes and nothing is spawned
// A11-279: every run starts with a private TMPDIR under the private-tmp base, a restored run gets the same one, and the board removes it once the run holds no workspace, within a budget of entries a pass
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { poolFixture } from "./pool-fixture.ts";
import { herdrName } from "./pool.ts";
import { runEnvOf } from "./run-env.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { MAX_REMOVALS_PER_PASS, makeRunTmp, runTmpDir, runTmpName, SWEEP_GRACE_MS, sweepRunTmp } from "./run-isolation.ts";
import { newLegacySweepState } from "./legacy-tmp.ts";
import { ticketDir } from "./ticket-paths.ts";
import type { PoolContext } from "./pool-context.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";

const T0 = Date.UTC(2026, 9, 25, 15, 0, 0);
const INTERRUPTED = "⎿  Interrupted · What should Claude do instead?\n\n> ";

/** The `--env` pairs of each `workspace create`, in order. */
const createdWith = (calls: readonly string[][]) => calls.filter((args) => args.includes("workspace") && args.includes("create"))
  .map((args) => Object.fromEntries(args.flatMap((arg, at) => (args[at - 1] === "--env" ? [[arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]] : []))));

test("A11-279: a run's private TMPDIR is named by its id alone under the base, run-t- first, and an id cannot name a path outside the base", () => {
  assert.equal(runTmpName("A11-279"), "run-t-A11-279");
  assert.equal(runTmpDir("/base", "A11-279"), "/base/run-t-A11-279");
  assert.equal(runTmpName("../../etc"), "run-t-.._.._etc", "slashes are replaced");
  assert.equal(runTmpDir("/base", "../../etc"), "/base/run-t-.._.._etc");
  assert.equal(runTmpName("a b\0c"), "run-t-a_b_c");
});

test("A11-279: runEnvOf carries TMPDIR under the base for a ticket's run and for a batch's run, and none when the pool gives runs no base", () => {
  const entry = { ticket: { key: "A11-1", branch: "a11-1" } } as Pick<Entry, "batch" | "ticket">;
  assert.deepEqual(runEnvOf({ hostFile: "/h.json", runTmpBase: "/base" }, entry), { AGENT_ORG_TICKET: "A11-1", AGENT_ORG_TICKET_BRANCH: "a11-1", AGENT_ORG_TICKET_HOST: "/h.json", TMPDIR: "/base/run-t-A11-1" });
  assert.deepEqual(runEnvOf({ hostFile: undefined, runTmpBase: "/base" }, { ...entry, batch: "b-1" }), { TMPDIR: "/base/run-t-b-1" });
  assert.equal("TMPDIR" in runEnvOf({ hostFile: "/h.json" }, entry), false);
  assert.equal("A11Y_PRIVATE_TMP_RUN" in runEnvOf({ hostFile: "/h.json", runTmpBase: "/base" }, entry), false, "the pane gets no test-run marker, so step 1's guard still applies only under rstest");
});

test("A11-279: makeRunTmp makes the directory, and names why it could not", () => {
  const base = tmpDir("run-isolation-");
  assert.equal(makeRunTmp(base, runTmpDir(base, "A11-1")), null);
  assert.ok(existsSync(runTmpDir(base, "A11-1")));
  assert.equal(makeRunTmp(base, runTmpDir(base, "A11-1")), null, "an existing directory is fine");
  assert.match(makeRunTmp(base, join(base, "elsewhere")) ?? "", /not a run root/, "a path outside run-* under the base is refused");
  writeFileSync(join(base, "a-file"), "");
  const under = join(base, "a-file");
  assert.match(makeRunTmp(under, runTmpDir(under, "A11-1")) ?? "", /ENOTDIR/);
});

/** A pool over a base with `keys` started and seen working, on a clock a test moves, and herdr's restart as `restartReads` says. */
async function liveRuns(keys: readonly string[], base: string | undefined) {
  let clock = T0;
  const held = { herdr: "1" };
  const made = poolFixture({ keys, max: 3, now: () => clock, restartReads: { bootId: () => "boot-1", herdrStart: () => held.herdr }, ...(base === undefined ? {} : { privateTmpBase: base }) });
  await made.pool.tick();
  for (const key of keys) made.status.set(herdrName(key), "working");
  await made.pool.tick();
  const advance = async (ms: number) => { clock += ms; await made.pool.tick(); await new Promise<void>((resolve) => { setImmediate(resolve); }); };
  return { ...made, held, advance, now: () => clock };
}

test("A11-279: start() makes the run's directory and opens its workspace with TMPDIR naming it, for each run, and a pool without a base opens none", async () => {
  const base = tmpDir("run-isolation-");
  const run = await liveRuns(["NBF-1", "NBF-2"], base);
  assert.deepEqual(createdWith(run.herdr.calls).map((env) => env.TMPDIR), [join(base, "run-t-NBF-1"), join(base, "run-t-NBF-2")]);
  assert.deepEqual(readdirSync(base).toSorted(), ["run-t-NBF-1", "run-t-NBF-2"]);
  assert.deepEqual(createdWith(run.herdr.calls).map((env) => env.TMPDIR), [runEnvOf({ hostFile: "/work/.agent-org/host.json", runTmpBase: base }, run.entry("NBF-1")).TMPDIR, runEnvOf({ hostFile: "/work/.agent-org/host.json", runTmpBase: base }, run.entry("NBF-2")).TMPDIR]);
  const bare = await liveRuns(["NBF-1"], undefined);
  assert.deepEqual(createdWith(bare.herdr.calls).map((env) => "TMPDIR" in env), [false]);
});

test("A11-279: a directory that cannot be made starts the run without a TMPDIR rather than refusing it, and the run is the board's to see", async () => {
  const base = tmpDir("run-isolation-");
  writeFileSync(join(base, "a-file"), "");
  const run = await liveRuns(["NBF-1"], join(base, "a-file"));
  assert.deepEqual(createdWith(run.herdr.calls).map((env) => ["TMPDIR" in env, env.AGENT_ORG_TICKET]), [[false, "NBF-1"]]);
  assert.equal(run.entry("NBF-1").phase, "running");
});

test("A11-279: herdr restores both panes without their environment: each run is started again with the TMPDIR it started with, and the directory is still there", async () => {
  const base = tmpDir("run-isolation-");
  const run = await liveRuns(["NBF-1", "NBF-2"], base);
  const before = createdWith(run.herdr.calls).length;
  run.held.herdr = "2";
  run.herdr.restoreWithoutEnvironment();
  for (const key of ["NBF-1", "NBF-2"] as const) {
    run.status.set(herdrName(key), "idle");
    run.herdr.screens.set(run.entry(key).pane ?? "", INTERRUPTED);
  }
  await run.advance(30_000);
  for (const key of ["NBF-1", "NBF-2"] as const) {
    assert.equal(run.herdr.envs.get(run.entry(key).pane ?? "")?.TMPDIR, join(base, `run-t-${key}`), `${key}: TMPDIR inside the restored pane`);
    assert.equal(run.herdr.envs.get(run.entry(key).pane ?? "")?.AGENT_ORG_TICKET, key);
  }
  assert.equal(createdWith(run.herdr.calls).length - before, 2);
  assert.deepEqual(readdirSync(base).toSorted(), ["run-t-NBF-1", "run-t-NBF-2"], "no second directory for the restored run, and the first is not swept from under it");
});

test("A11-279: a pane that has the ticket's variables and no TMPDIR (a run started before runs had one) is not started again", async () => {
  const base = tmpDir("run-isolation-");
  const run = await liveRuns(["NBF-1"], base);
  const before = createdWith(run.herdr.calls).length;
  const pane = run.entry("NBF-1").pane ?? "";
  const { TMPDIR: _tmp, ...older } = run.herdr.envs.get(pane) ?? {};
  run.herdr.envs.set(pane, older);
  run.held.herdr = "2";
  run.status.set(herdrName("NBF-1"), "idle");
  run.herdr.screens.set(pane, INTERRUPTED);
  await run.advance(30_000);
  assert.equal(createdWith(run.herdr.calls).length, before);
  assert.equal(run.entry("NBF-1").pane, pane);
});

test("A11-279: a finished run's directory is removed on the tick that sees its workspace closed, and a parked or live run's is kept", async () => {
  const base = tmpDir("run-isolation-");
  const run = await liveRuns(["NBF-1", "NBF-2", "NBF-3"], base);
  for (const key of ["NBF-1", "NBF-2", "NBF-3"]) writeFileSync(join(runTmpDir(base, key), "scratch.txt"), "left by a test");
  const old = new Date(run.now() - SWEEP_GRACE_MS - 1);
  for (const key of ["NBF-1", "NBF-2", "NBF-3"]) utimesSync(runTmpDir(base, key), old, old);
  await run.advance(30_000);
  // NBF-1 concludes (its workspace is closed with the outcome), NBF-2 hands its ticket back (parked: its workspace stays open), NBF-3 works on.
  writeFileSync(join(ticketDir(run.settings, "NBF-1"), "outcome.json"), JSON.stringify({ kind: "checked", reason: "nothing to change" }));
  writeFileSync(join(ticketDir(run.settings, "NBF-2"), "outcome.json"), JSON.stringify({ kind: "needs-human", reason: "a question", escalation: "outward" }));
  run.status.set(herdrName("NBF-1"), "idle");
  run.status.set(herdrName("NBF-2"), "idle");
  await run.advance(30_000);
  assert.deepEqual([run.entry("NBF-1").phase, run.entry("NBF-1").workspace], ["finished", undefined]);
  assert.notEqual(run.entry("NBF-2").workspace, undefined, "parked: its agent is still open");
  await run.advance(30_000);
  assert.ok(existsSync(runTmpDir(base, "NBF-1")), "inside the grace of the last pass that held it, the ended run's directory is left");
  await run.advance(SWEEP_GRACE_MS);
  assert.deepEqual(readdirSync(base).toSorted(), ["run-t-NBF-2", "run-t-NBF-3"], "only the concluded run's directory, scratch file and all, is gone");
});

/** The `workspace list` answer of a herdr that lists `labels`, or one that cannot be asked when `labels` is null. */
const herdrListing = (labels: readonly string[] | null) => (args: string[]): string => {
  if (labels === null) throw new Error("herdr exited 1");
  return args.includes("list") ? JSON.stringify({ result: { workspaces: labels.map((label) => ({ label, workspace_id: `w-${label}`, agent_status: "idle" })) } }) : "{}";
};

/** A pool context that holds only what the sweep reads: the base, the clock, the queue's entries and the workspaces herdr lists in the board's session (none unless a test names them). */
const sweepCtx = (base: string | undefined, entries: readonly Partial<Entry>[], now: number, listed: readonly string[] | null = []): PoolContext =>
  ({ runTmpBase: base, now: () => now, store: { get: () => ({ entries }) }, herdr: herdrListing(listed), herdrCall: async (args: string[]) => herdrListing(listed)(args), settings: { herdrSession: "tickets" }, deps: {}, legacySweep: newLegacySweepState() }) as unknown as PoolContext;
const ended = (key: string): Partial<Entry> => ({ ticket: { key } as Entry["ticket"], phase: "finished" });

test("A11-279: the sweep leaves a directory modified inside the grace, a name that is not run-t-, a symlink's target, and everything when the pool has no base", async () => {
  const base = tmpDir("run-isolation-");
  const elsewhere = tmpDir("run-isolation-target-");
  writeFileSync(join(elsewhere, "keep.txt"), "not a run's");
  mkdirSync(join(base, "run-t-NEW"));
  mkdirSync(join(base, "run-t-OLD"));
  mkdirSync(join(base, "run-20261025T150000Z-1-abc"));
  mkdirSync(join(base, "other"));
  symlinkSync(elsewhere, join(base, "run-t-OLD", "link"));
  const t = Date.now();
  utimesSync(join(base, "run-t-OLD"), new Date(t - SWEEP_GRACE_MS - 1000), new Date(t - SWEEP_GRACE_MS - 1000));
  await sweepRunTmp(sweepCtx(undefined, [], t));
  assert.deepEqual(readdirSync(base).toSorted(), ["other", "run-20261025T150000Z-1-abc", "run-t-NEW", "run-t-OLD"], "no base: nothing is swept");
  await sweepRunTmp(sweepCtx(base, [], t));
  assert.deepEqual(readdirSync(base).toSorted(), ["other", "run-20261025T150000Z-1-abc", "run-t-NEW"], "the old run's directory goes; the new one, a test run's root and another name stay");
  assert.deepEqual(readdirSync(elsewhere), ["keep.txt"], "the symlink is removed as itself, never followed");
});

test("A11-279: the sweep removes one entry per call and at most MAX_REMOVALS_PER_PASS a pass, and finishes over passes", async () => {
  const base = tmpDir("run-isolation-");
  const dir = runTmpDir(base, "A11-1");
  mkdirSync(join(dir, "nested"), { recursive: true });
  const files = MAX_REMOVALS_PER_PASS + 100;
  for (let at = 0; at < files; at++) writeFileSync(join(dir, at % 2 === 0 ? `f${at}` : join("nested", `f${at}`)), "");
  const old = new Date(Date.now() - SWEEP_GRACE_MS - 1000);
  const t = Date.now();
  utimesSync(dir, old, old);
  const count = (path: string): number => readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? 1 + count(join(path, entry.name)) : 1), 0);
  assert.equal(count(dir), files + 1);
  await sweepRunTmp(sweepCtx(base, [ended("A11-1")], t));
  assert.equal(count(dir), files + 1 - MAX_REMOVALS_PER_PASS, "a pass removes its budget and no more");
  assert.ok(existsSync(dir));
  utimesSync(dir, old, old);
  await sweepRunTmp(sweepCtx(base, [ended("A11-1")], t));
  assert.equal(existsSync(dir), false, "the next pass finishes it");
});

test("A11-279: the sweep keeps the directory of a live run, of a run that holds a workspace, and of a batch's run, whatever their age", async () => {
  const base = tmpDir("run-isolation-");
  const old = new Date(Date.now() - SWEEP_GRACE_MS - 1000);
  for (const id of ["A11-1", "A11-2", "b-1", "A11-4"]) { mkdirSync(runTmpDir(base, id)); utimesSync(runTmpDir(base, id), old, old); }
  const entries: Partial<Entry>[] = [
    { ticket: { key: "A11-1" } as Entry["ticket"], phase: "running" },
    { ticket: { key: "A11-2" } as Entry["ticket"], phase: "finished", workspace: "w9" },
    { ticket: { key: "A11-3" } as Entry["ticket"], phase: "starting", batch: "b-1" },
    ended("A11-4"),
  ];
  await sweepRunTmp(sweepCtx(base, entries, Date.now()));
  assert.deepEqual(readdirSync(base).toSorted(), ["run-t-A11-1", "run-t-A11-2", "run-t-b-1"]);
});

test("A11-279: a base that does not exist is nothing to sweep", async () => {
  await assert.doesNotReject(sweepRunTmp(sweepCtx(join(tmpDir("run-isolation-"), "missing"), [], Date.now())));
});

test("A11-279: the sweep touches the directory of a held run on every pass and makes it again if it is gone, so the tmpfiles rule and another instance's sweep never find it old", async () => {
  const base = tmpDir("run-isolation-");
  const t = Date.now();
  const old = new Date(t - 3 * SWEEP_GRACE_MS);
  mkdirSync(runTmpDir(base, "A11-1"));
  utimesSync(runTmpDir(base, "A11-1"), old, old);
  const entries: Partial<Entry>[] = [{ ticket: { key: "A11-1" } as Entry["ticket"], phase: "running" }, { ticket: { key: "A11-2" } as Entry["ticket"], phase: "finished", workspace: "w2" }];
  await sweepRunTmp(sweepCtx(base, entries, t));
  assert.equal(statSync(runTmpDir(base, "A11-1")).mtimeMs, t, "touched to the pool's clock");
  assert.ok(existsSync(runTmpDir(base, "A11-2")), "a parked run's directory that the tmpfiles rule removed is made again");
  // Another instance's sweep, a pass later and with no entry for either, leaves both: they are inside its grace.
  await sweepRunTmp(sweepCtx(base, [], t + SWEEP_GRACE_MS - 1));
  assert.deepEqual(readdirSync(base).toSorted(), ["run-t-A11-1", "run-t-A11-2"]);
});

test("A11-279: a run's directory that is a symlink is removed as itself and its target is left", async () => {
  const base = tmpDir("run-isolation-");
  const elsewhere = tmpDir("run-isolation-target-");
  writeFileSync(join(elsewhere, "keep.txt"), "not a run's");
  symlinkSync(elsewhere, join(base, "run-t-LINK"));
  await sweepRunTmp(sweepCtx(base, [], Date.now()));
  assert.deepEqual([readdirSync(base), readdirSync(elsewhere)], [[], ["keep.txt"]]);
});

/** A base holding a directory for each of `labels`, each last modified three graces before `t`. */
function baseWithOld(labels: readonly string[], t: number): string {
  const base = tmpDir("run-isolation-");
  const old = new Date(t - 3 * SWEEP_GRACE_MS);
  for (const label of labels) { mkdirSync(runTmpDir(base, label)); utimesSync(runTmpDir(base, label), old, old); }
  return base;
}

test("A11-303: the sweep keeps the directory of a session herdr lists though no queue entry owns it (a reviewer, a new-ticket run), touches it, and takes it once herdr no longer lists it", async () => {
  const t = Date.now();
  const base = baseWithOld(["reviewer-nbl-ui-7", "reviewer-nbl-ui-8"], t);
  writeFileSync(join(runTmpDir(base, "reviewer-nbl-ui-8"), "ae-pw-leftover"), "from an acceptance run");
  utimesSync(runTmpDir(base, "reviewer-nbl-ui-8"), new Date(t - 3 * SWEEP_GRACE_MS), new Date(t - 3 * SWEEP_GRACE_MS));
  await sweepRunTmp(sweepCtx(base, [], t, ["reviewer-nbl-ui-7"]));
  assert.deepEqual(readdirSync(base), ["run-t-reviewer-nbl-ui-7"], "the listed reviewer's directory stays, the unlisted one's is gone");
  assert.equal(statSync(runTmpDir(base, "reviewer-nbl-ui-7")).mtimeMs, t, "and is touched, so the tmpfiles rule and another instance's sweep find it young");
  await sweepRunTmp(sweepCtx(base, [], t + SWEEP_GRACE_MS - 1, []));
  assert.deepEqual(readdirSync(base), ["run-t-reviewer-nbl-ui-7"], "the pass that no longer lists it is inside the grace of the last touch");
  await sweepRunTmp(sweepCtx(base, [], t + SWEEP_GRACE_MS, []));
  assert.deepEqual(readdirSync(base), [], "and once the grace has passed with the workspace gone, so is it");
});

test("A11-303: herdr that cannot be listed takes no directory a queue entry does not own, and a directory of an ended queue run is taken without asking herdr", async () => {
  const t = Date.now();
  const base = baseWithOld(["reviewer-nbl-ui-7", "A11-1"], t);
  await sweepRunTmp(sweepCtx(base, [ended("A11-1")], t, null));
  assert.deepEqual(readdirSync(base), ["run-t-reviewer-nbl-ui-7"], "no listing says nothing of the reviewer, so its directory is left; the ended run's is its queue entry's to say");
  await sweepRunTmp(sweepCtx(base, [], t, []));
  assert.deepEqual(readdirSync(base), [], "listed, and not there, it goes");
});
