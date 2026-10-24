// no-token: gh -- `gh` is never reached: every read is handed a fake `run`, and the one test of `runBatch` puts a stub `gh` first on PATH.
/**
 * a11ign/a11ign#3566, slice 2: THE GATE'S PER-REPOSITORY READS WAIT TOGETHER, NOT ONE AFTER THE OTHER.
 *
 * Measured 2026-10-05 with a timing shim on PATH: one gate run made 68 `gh` calls, all one at a time, 33.9 s of its 40.6 s; eight were the open list and
 * eight the merged list of the declared repositories, differing only by `GH_REPO`. The fix moves WHEN they wait and nothing else, so what is pinned is:
 *   - the control: a `run` handed in (a test's stand-in for `gh`) is NOT batched, so every other test of the gate sees its calls one at a time as before;
 *   - the calls of every other repository arrive in ONE batch, and the lanes read are exactly what the one-at-a-time read returned;
 *   - a refusal in one repository is that lane's `null`, beside the others' answers (#1286: "could not ask" is never "nothing there");
 *   - a call the rehearsal could not foresee still runs on its own, and an answer is handed out once;
 *   - `runBatch` itself overlaps real child processes, and replays a failure with the status and stderr `execFileSync` would have thrown.
 *
 * THE POPULATION IS THE DECLARATION'S: one list per other declared code repository, so a third repository is covered the day it is declared.
 */
import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHADOW_COPY_MARKER, SHADOW_STATE_DIR_ENV, stateEntryPath } from "./host-config.ts";
import { tmpDirForFile } from "./lib/tmp-fixture.ts";
import { homeProjectDeclaration } from "./project-config.ts";
import { BATCH_MAX_CALLS, readWithFirstWaveTogether, runBatch } from "./work-gate/reads/read-memo-and-exit.ts";
import { readElsewherePrs } from "./work-gate/reads.ts";
import { readOtherScopes } from "./work-gate.ts";
import { readScopeTrunkRed } from "./work-gate/tick/tick-decisions-and-flags.ts";
import { scopesOf } from "./work-gate/vocabulary.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { askingRunFirst, standIn } from "./plugins/fakes/waves.test.support.ts";
import { trunkRunsKey } from "./plugins/fakes/code-host-queue.ts";
import { trunkOfCodeRepository } from "./trunk-red.ts";

// The reads are the fake code host's (A11-160, step 9): the open list is asked with the arguments the code host builds (the fake's are a stand-in, `fake-open-pull-list`), the merged lists and the trunk's runs
// make one stand-in call each to the `run` they are handed (`waves.test.support.ts`), and every other read is the world's own. What this file counts and orders is the executor's: which calls go out together,
// aimed where, and what a refusal does to a lane.
let host = createFakeCodeHost();
beforeEach(() => {
  host = askingRunFirst(createFakeCodeHost(), { newestMergedPulls: () => standIn("newestMergedPulls"), trunkRunsOf: (request) => standIn("trunkRunsOf", request.repo, request.workflow, request.eventFilter) });
  // each repository's workflow exists and has no run yet: an answer, which is what the rehearsal's empty answer stands for (a repository the world holds no workflow of answers 404, is marked as having none and is not asked again)
  for (const { key, code } of OTHER_CODE) {
    const source = trunkOfCodeRepository(key, code!.repo);
    for (const filter of source.eventFilters.length === 0 ? [null] : source.eventFilters) host.rowsWorld.tail.queue.trunkRuns.set(trunkRunsKey(code!.repo, source.workflow, filter), []);
  }
  substituteCodeHost(host);
});
afterEach(() => forgetActivation());
const OPEN_LIST = "fake-open-pull-list";

// agent-org#1147: THE STATE DIRECTORY IS THIS FILE'S OWN. `readTrunkRed` keeps a repository's "has no such workflow" marker in the host's state directory and does not ask
// again for a day, so on a host that had met one 404 the `main` read below made 14 calls where this file counts 16, and the test passed in CI and nowhere the host had run.
// `A11IGN_SHADOW_STATE_DIR` wins over `$HOME` and over a declared `stateDir`, so no host's markers reach this file and none of its `present` markers reaches the host.
const STATE = tmpDirForFile("other-scopes-state-");
writeFileSync(join(STATE, SHADOW_COPY_MARKER), "");
const SHADOW_BEFORE = process.env[SHADOW_STATE_DIR_ENV];
process.env[SHADOW_STATE_DIR_ENV] = STATE;
after(() => {
  if (SHADOW_BEFORE === undefined) delete process.env[SHADOW_STATE_DIR_ENV];
  else process.env[SHADOW_STATE_DIR_ENV] = SHADOW_BEFORE;
});

type Call = { args: string[], repo: string | undefined };
type Answer = { stdout: string } | { failed: true, stdout: string, stderr: string, status: number | null, code?: string };

const OTHERS = scopesOf([homeProjectDeclaration()]).filter((scope) => scope.key !== "");
const OTHER_CODE = OTHERS.filter((scope) => scope.code !== null);
const prOf = (repo: string) => ({ number: repo.length, isDraft: false, headRefOid: "abc", statusCheckRollup: [], author: { login: "x" }, comments: [], labels: [],
  files: [], changedFiles: 0, body: "", reviewDecision: "" });

/** What the runner answers per call: the open list is one pull request named for its repository, so a lane that reads another repository's answer is visible; anything else is empty. */
function answerOf({ args, repo }: Call): string {
  if (args[0] === OPEN_LIST) return JSON.stringify([prOf(repo ?? "primary")]);
  return "[]";
}
const OTHER_READ = "fake:other";
const failingRepo = (repo: string) => (call: Call) => call.repo === repo && call.args[0] === OPEN_LIST;

/** The `run` the gate hands its readers: one call at a time, noted, and refusing the calls `refuse` names the way `execFileSync` throws. */
function sequentialRun(seen: Call[], refuse: (call: Call) => boolean = () => false) {
  return (args: string[], repo?: string) => {
    seen.push({ args, repo });
    if (refuse({ args, repo })) throw Object.assign(new Error("Command failed: gh"), { status: 1, stderr: "refused", stdout: "" });
    return answerOf({ args, repo });
  };
}

/** A batch that answers as `answerOf` does and notes every call it was handed, one entry per BATCH. */
function fakeBatch(batches: Call[][], refuse: (call: Call) => boolean = () => false) {
  return (calls: Call[]): Answer[] => {
    batches.push(calls);
    return calls.map((call) => (refuse(call) ? { failed: true as const, stdout: "", stderr: "refused", status: 1 } : { stdout: answerOf(call) }));
  };
}

test("POSITIVE CONTROL: the declaration holds at least two other code repositories, so 'together' is not one call", () => {
  assert.ok(OTHER_CODE.length >= 2, `the declared other code repositories: ${OTHER_CODE.map((scope) => scope.key).join(", ")}`);
});

test("POSITIVE CONTROL: the trunk markers are read from this file's own state directory, so the host's are not (agent-org#1147)", () => {
  assert.equal(stateEntryPath(""), STATE);
});

test("CONTROL: a run handed in is not batched -- its calls arrive one at a time, as before", () => {
  const seen: Call[] = [];
  const lanes = readOtherScopes(sequentialRun(seen));
  assert.ok(seen.length >= OTHER_CODE.length, "every other repository's first read reached the run");
  assert.deepEqual(lanes.map(({ scope }) => scope.key), OTHERS.map((scope) => scope.key));
});

test("CONTROL: a plain run makes ONE pass over the reader -- no rehearsal runs it a second time", () => {
  let passes = 0;
  readWithFirstWaveTogether((run) => { passes += 1; return [run([OPEN_LIST], "a"), run([OPEN_LIST], "b")]; }, sequentialRun([]));
  assert.equal(passes, 1);
});

test("a refused call replays as the throw `execFileSync` made: its status, stderr and message reach the reader", () => {
  const seen: unknown[] = [];
  readWithFirstWaveTogether((run) => {
    try { return run([OPEN_LIST], "a") + run([OTHER_READ], "b"); } catch (err) { seen.push(err); return ""; }
  }, sequentialRun([]), fakeBatch([], failingRepo("a")));
  const thrown = seen[0] as Error & { status: number, stderr: string };
  assert.equal(thrown.status, 1);
  assert.equal(thrown.stderr, "refused");
  assert.match(thrown.message, /^Command failed: gh fake-open-pull-list/);
});

test("the first reads of every other repository arrive in ONE batch, and the lanes are what the one-at-a-time read returned", () => {
  const seen: Call[] = [];
  const sequential = readOtherScopes(sequentialRun(seen));
  const batches: Call[][] = [];
  const through: Call[] = [];
  const batched = readOtherScopes(sequentialRun(through), fakeBatch(batches));
  assert.equal(batches.length, 1, "ONE batch");
  assert.deepEqual(through, [], "and nothing the rehearsal named reached the run on its own");
  assert.equal(batches[0].length, seen.length, "every call the one-at-a-time read made went in it");
  assert.deepEqual(batches[0].filter((call) => call.args[0] === OPEN_LIST).map((call) => call.repo).sort(), OTHER_CODE.map((scope) => scope.code!.repo).sort(),
    "an open list per other code repository, each aimed at its own");
  assert.deepEqual(batched, sequential);
});

test("the merged lists of the other repositories go out together too, and the result is the one-at-a-time result", () => {
  host.rowsWorld.pulls.set(77, { number: 77, body: "", headRefName: "agent/x", labels: [], isDraft: false, armed: false, merged: true, mergedAt: "2026-10-01T00:00:00Z", createdAt: "2026-10-01T00:00:00Z", comments: [] });
  const sequential = readElsewherePrs(undefined, sequentialRun([]));
  const batches: Call[][] = [];
  const batched = readElsewherePrs(undefined, sequentialRun([]), [], fakeBatch(batches));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].filter((call) => call.args[0] === "fake:newestMergedPulls").length, OTHER_CODE.length);
  assert.ok(sequential !== undefined && sequential.merged !== null && sequential.merged.length > 0, "the control: the answer is not empty, so equality says something");
  assert.deepEqual(batched, sequential);
});

test("each other repository's `main` is asked in the same wave -- the rehearsal's empty answer does not stop `readTrunkRed`", () => {
  const batches: Call[][] = [];
  const read = (run: (args: string[], repo?: string) => string) => OTHERS.map((scope) => readScopeTrunkRed(scope, run));
  const batched = readWithFirstWaveTogether(read, sequentialRun([]), fakeBatch(batches));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].filter((call) => call.args[0] === "fake:trunkRunsOf").length, OTHER_CODE.length * 2, "a push read and a schedule read each (agent-org#539)");
  assert.deepEqual(batched, read(sequentialRun([])));
});

test("a refusal in one repository is that lane's null, beside the others' answers, as it was one at a time", () => {
  const refused = OTHER_CODE[0].code!.repo;
  const sequential = readOtherScopes(sequentialRun([], failingRepo(refused)));
  const batched = readOtherScopes(sequentialRun([]), fakeBatch([], failingRepo(refused)));
  assert.equal(batched.find(({ scope }) => scope.code?.repo === refused)!.read.prs, null);
  assert.ok(batched.some(({ scope, read }) => scope.code?.repo !== refused && read.prs !== null && read.prs.length > 0), "and a neighbour is still read");
  assert.deepEqual(batched, sequential);
});

test("a call the rehearsal did not foresee runs on its own, and an answer is handed out ONCE", () => {
  const through: Call[] = [];
  const batches: Call[][] = [];
  const asked = [OPEN_LIST, OTHER_READ].map((kind) => ({ args: [kind], repo: kind }));
  // `later` is asked only after a non-empty answer, as the widened page is after a full first one: the rehearsal's `[]` never reaches it.
  const read = (run: (args: string[], repo?: string) => string) => {
    const first = asked.map(({ args, repo }) => run(args, repo));
    return [...first, run([OPEN_LIST], asked[0].repo), first[0] === "[]" ? "[]" : run(["fake:later"], asked[0].repo)];
  };
  const answers = readWithFirstWaveTogether(read, sequentialRun(through), fakeBatch(batches));
  assert.equal(batches[0].length, 2);
  assert.deepEqual(through.map((call) => call.args.join(" ")), [OPEN_LIST, "fake:later"], "the repeat and the unforeseen call are new reads and reach the run");
  assert.deepEqual(answers, [answerOf(asked[0]), answerOf(asked[1]), answerOf(asked[0]), "[]"]);
});

test("a batch that fails, or a reader that throws on the rehearsal, falls back to one at a time and SAYS so", () => {
  const notes: string[] = [];
  const read = (run: (args: string[], repo?: string) => string) => [run([OPEN_LIST], "a"), run([OPEN_LIST], "b")];
  const brokenBatch = () => { throw new Error("no node"); };
  assert.deepEqual(readWithFirstWaveTogether(read, sequentialRun([]), brokenBatch, (line) => notes.push(line)), read(sequentialRun([])));
  assert.match(notes[0], /could not be batched.*no node/);
  const fussy = (run: (args: string[], repo?: string) => string) => { if (run([OPEN_LIST], "a") === "[]") throw new Error("empty is not allowed"); return "read"; };
  const batches: Call[][] = [];
  assert.equal(readWithFirstWaveTogether(fussy, (args, repo) => answerOf({ args, repo }), fakeBatch(batches), (line) => notes.push(line)), "read");
  assert.equal(batches.length, 0, "no batch went out for a rehearsal that failed");
  assert.match(notes[1], /threw on the rehearsal's empty answers.*empty is not allowed/);
});

test("`runBatch` starts its calls together, answers in order, aims by GH_REPO, and reports a failure with its status and stderr", () => {
  forgetActivation(); // a process test: the batch is the GitHub plugin's, over a stub `gh` that only logs and counts
  const dir = mkdtempSync(join(tmpdir(), "batch-"));
  try {
    const log = join(dir, "log");
    // The stub holds each call open for half a second: calls that waited for one another would log a `start` after an `end`.
    writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "start $1" >> ${log}\nsleep 0.5\necho "end $1" >> ${log}\n`
      + `if [ "$1" = bad ]; then echo "boom" >&2; exit 3; fi\necho "$1:\${GH_REPO:-none}"\n`);
    chmodSync(join(dir, "gh"), 0o755);
    const calls: Call[] = [{ args: ["one"], repo: "o/a" }, { args: ["bad"], repo: undefined }, { args: ["three"], repo: "o/c" }, { args: ["four"], repo: undefined }];
    const answers = runBatch(calls, { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_REPO: "" });
    assert.deepEqual(answers.map((answer) => ("failed" in answer ? "failed" : answer.stdout)), ["one:o/a\n", "failed", "three:o/c\n", "four:none\n"]);
    const failed = answers[1] as Extract<Answer, { failed: true }>;
    assert.equal(failed.status, 3);
    assert.equal(failed.stderr, "boom\n");
    const events = readFileSync(log, "utf8").split("\n").filter(Boolean);
    assert.equal(events.slice(0, calls.length).every((event) => event.startsWith("start")), true, `all started before any ended: ${events.join(", ")}`);
    assert.ok(BATCH_MAX_CALLS >= calls.length, "the control: this batch fits in one chunk, so 'together' is not about chunking");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
