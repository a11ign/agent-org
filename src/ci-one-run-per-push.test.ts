// no-token: none -- reads .github/workflows/ci.yml and pr-body-edit.yml; the repair step runs against a stand-in `gh` first on PATH that answers from files, so nothing here reaches GitHub
// A11-403: ONE PUSH IS ONE `ci` RUN. A pull request's body is edited seconds after its push, and `edited` in ci.yml's `pull_request` types started a second `ci` run in the same concurrency group (a11ign/agent-org#2017: runs 41399910129 and
// 41399933489). The two cancelled each other, and the board's rerun of one cancelled the other, leaving an approved, green pull request BLOCKED. `edited` is gone from ci.yml; `pr-body-edit.yml` keeps the repair (a `no-release:` line added by
// a body edit must still turn the `changeset` job green) without a second run.
//
// THE CHECKS ARE FUNCTIONS OVER THE PARSED FILES, returning what is wrong, and each is run on a copy with the fault put back (a check that passes on everything would pass the real file too). The repair step's shell is run for real
// under `bash -eo pipefail`, as the runner runs it, over a stand-in `gh` that answers the run list and the jobs from the same JSON GitHub sends, through the real `jq` filter the step passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { tmpDir } from "./lib/tmp-fixture.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const ciText = readFileSync(`${REPO}.github/workflows/ci.yml`, "utf8");
const bodyEditText = readFileSync(`${REPO}.github/workflows/pr-body-edit.yml`, "utf8");

type Step = { name?: string; run?: string; env?: Record<string, string>; shell?: string };
type Job = { if?: string; name?: string; needs?: string[] | string; permissions?: Record<string, string>; steps?: Step[]; "timeout-minutes"?: number };
type Workflow = {
  on: Record<string, { types?: string[] } | null>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean | string };
  jobs: Record<string, Job>;
};
const ci = parse(ciText) as Workflow;
const bodyEdit = parse(bodyEditText) as Workflow;

/** Why a pull request's push and its body edit could start two `ci` runs; null when they cannot. */
function secondRunGap(workflow: Workflow): string | null {
  const types = workflow.on.pull_request?.types;
  if (types === undefined) return "ci.yml has no pull_request types, so every event of a pull request starts a run";
  if (types.includes("edited")) return "`edited` starts a `ci` run, so a body edit after a push is a second run in the same group";
  return null;
}

/** Every `${{ }}` expression of the file's code (a comment is not code), which is where a run would read the event's payload. */
function expressionsOf(text: string): string[] {
  const code = text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  return [...code.matchAll(/\$\{\{([^}]*)\}\}/g)].map((match) => match[1]!.trim());
}

/** Why a rerun of `ci` would read a body that a body edit has since changed; null when no step reads the event's body. */
function staleBodyGap(text: string): string | null {
  const stale = expressionsOf(text).find((expression) => expression.includes("pull_request.body"));
  return stale === undefined ? null : `\`${stale}\` is the body as it was when the run began; a rerun replays it, so a body edit would not reach the check`;
}

/** The pins of `changeset-required.yml` that read the body from the event, which a rerun replays (before A11-403 step 2). */
const STALE_BODY_PINS = ["08fcafc094e6b45c993f7754f0dcfd259c96be93"];

/** Why the `changeset` job would read a stale body on a rerun; null when its pin is a full SHA that is not a known stale one. */
function changesetPinGap(workflow: Workflow): string | null {
  const uses = (workflow.jobs.changeset as unknown as { uses?: string }).uses ?? "";
  const pin = /^a11ign\/toolchain\/\.github\/workflows\/changeset-required\.yml@([0-9a-f]{40})$/.exec(uses)?.[1];
  if (pin === undefined) return `the changeset job does not use the shared workflow by a full SHA: ${uses}`;
  return STALE_BODY_PINS.includes(pin) ? `the changeset job is pinned to ${pin}, which reads the body from the event` : null;
}

test("one push is one `ci` run: ci.yml's pull_request types do not carry `edited`", () => {
  assert.equal(secondRunGap(ci), null);
  assert.deepEqual(ci.on.pull_request?.types, ["opened", "synchronize", "reopened", "ready_for_review"]);
});

test("the second-run check sees the trigger that started it", () => {
  assert.match(secondRunGap({ ...ci, on: { ...ci.on, pull_request: { types: ["opened", "synchronize", "reopened", "edited", "ready_for_review"] } } }) ?? "", /`edited` starts a `ci` run/);
  assert.match(secondRunGap({ ...ci, on: { ...ci.on, pull_request: {} } }) ?? "", /no pull_request types/);
});

test("the merge condition and the push's own supersession stay: merge_group, push, and the per-pull-request group", () => {
  assert.ok("merge_group" in ci.on, "merge_group is the merge condition for main");
  assert.ok("push" in ci.on);
  assert.match(String(ci.concurrency?.group), /pull-request-\{0\}/);
  assert.match(String(ci.concurrency?.["cancel-in-progress"]), /github\.event_name == 'pull_request'/);
});

test("no step of ci.yml reads the event's pull request body, so a rerun reads the live one", () => {
  assert.equal(staleBodyGap(ciText), null);
  assert.match(staleBodyGap("env:\n  PR_BODY: ${{ github.event.pull_request.body }}\n") ?? "", /replays it/);
  assert.equal(staleBodyGap("# PR_BODY: ${{ github.event.pull_request.body }}\n"), null, "a comment is not a read");
});

test("the Closes check fetches the body from the API, and fails the step when that fails", () => {
  const suite = ci.jobs.suite!;
  const step = suite.steps!.find((candidate) => candidate.name?.startsWith("The declared Closes matches"))!;
  assert.match(step.run!, /PR_BODY="\$\(gh api "repos\/\$REPOSITORY\/pulls\/\$NUMBER" --jq/);
  assert.ok(step.run!.indexOf("PR_BODY=") < step.run!.indexOf("export PR_BODY"), "assigned on its own line, so `bash -e` sees a failed read");
  assert.equal(step.env?.PR_BODY, undefined, "the body is not given by `env:` from the payload");
});

test("the changeset job is pinned to a toolchain commit that reads the body live", () => {
  assert.equal(changesetPinGap(ci), null);
  const stale = ciText.replace(/changeset-required\.yml@[0-9a-f]{40}/, `changeset-required.yml@${STALE_BODY_PINS[0]}`);
  assert.match(changesetPinGap(parse(stale) as Workflow) ?? "", /reads the body from the event/);
});

// ---- pr-body-edit.yml: the structure ----

test("pr-body-edit runs on a body edit alone, and starts no suite", () => {
  assert.deepEqual(Object.keys(bodyEdit.on), ["pull_request"]);
  assert.deepEqual(bodyEdit.on.pull_request?.types, ["edited"]);
  assert.deepEqual(Object.keys(bodyEdit.jobs), ["repair"]);
  const text = bodyEditText.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(text, /npm (ci|install|test)|rstest|pnpm|actions\/checkout/, "it installs and runs nothing of the repository");
});

test("pr-body-edit acts only when the body changed, and not for a bot or a fork, whose token cannot rerun", () => {
  const condition = bodyEdit.jobs.repair!.if!;
  assert.match(condition, /github\.event\.changes\.body != null/);
  assert.match(condition, /github\.actor != 'dependabot\[bot\]'/);
  assert.match(condition, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
});

test("pr-body-edit holds `actions: write` and `contents: read` and nothing else", () => {
  assert.deepEqual(bodyEdit.permissions, { contents: "read" });
  assert.deepEqual(bodyEdit.jobs.repair!.permissions, { actions: "write", contents: "read" });
});

test("pr-body-edit has its own group per pull request that a newer edit cancels, and no job a merge can wait for", () => {
  assert.equal(bodyEdit.concurrency?.group, "pr-body-edit-${{ github.event.pull_request.number }}-${{ github.event.changes.body != null && 'body' || 'other' }}", "a title edit or a retarget has a group of its own, so it cannot cancel a waiting repair");
  assert.equal(bodyEdit.concurrency?.["cancel-in-progress"], true);
  assert.notEqual(bodyEdit.concurrency?.group, ci.concurrency?.group, "its group is not ci's, so it never cancels or is cancelled by a ci run");
  for (const [id, job] of Object.entries(bodyEdit.jobs)) assert.notEqual(job.name ?? id, "gate", `job ${id} must not be named gate`);
  assert.ok((bodyEdit.jobs.repair!["timeout-minutes"] ?? 0) > 30, "the job outlasts its 30 minute wait");
  assert.equal(bodyEdit.jobs.repair!.steps![0]!.env!.WAIT_SECONDS, "1800", "the wait is 30 minutes");
});

test("pr-body-edit's body and branch reach the script through env, never interpolated into it", () => {
  const step = bodyEdit.jobs.repair!.steps![0]!;
  assert.doesNotMatch(step.run!, /\$\{\{/);
  assert.equal(step.env!.HEAD_REF, "${{ github.event.pull_request.head.ref }}");
  assert.equal(step.shell, "bash", "`bash` is `bash -eo pipefail`, so an API failure fails the step");
});

// ---- pr-body-edit.yml: the step, run for real over a stand-in `gh` ----

const REPOSITORY = "a11ign/agent-org";
const HEAD = "2f3f57e1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MOVED = "9999999999999999999999999999999999999999";
const RUN_ID = 41399933489;

type RunState = { id: number; status: string; conclusion: string | null; created_at: string };
type JobState = { name: string; conclusion: string; steps?: { name: string; conclusion: string }[] };

const CLOSES_STEP = "The declared Closes matches what GitHub will actually close, for this repository's own pull requests (agent-org#863)";
const job = (name: string, conclusion: string, steps: { name: string; conclusion: string }[] = []): JobState => ({ name, conclusion, steps });
const GREEN = ["ui", "typecheck", "lint", "release-dry-run", "suite (2)", "suite (3)", "suite (4)"].map((name) => job(name, "success"));
const suiteOne = (stepName: string) => job("suite (1)", "failure", [{ name: "Install the tool's dependencies", conclusion: "success" }, { name: stepName, conclusion: "failure" }]);

type World = {
  /** The ref's answers in order, the last repeating; the first is read before the wait and the last just before a rerun. */
  heads?: string[];
  /** The run list's answers in order, the last repeating. */
  lists?: RunState[][];
  jobs?: JobState[];
  failApi?: boolean;
};

/** The world's answers, one file each: the ref's and the run list's in the order they are read (the last repeating), and the run's jobs. */
function writeWorld(dir: string, world: World): void {
  mkdirSync(join(dir, "heads"));
  mkdirSync(join(dir, "lists"));
  (world.heads ?? [HEAD]).forEach((head, at) => writeFileSync(join(dir, "heads", String(at + 1)), `${JSON.stringify({ object: { sha: head } })}\n`));
  (world.lists ?? [[]]).forEach((runs, at) => writeFileSync(join(dir, "lists", String(at + 1)), `${JSON.stringify({ workflow_runs: runs })}\n`));
  writeFileSync(join(dir, "jobs"), `${JSON.stringify({ jobs: world.jobs ?? [] })}\n`);
}

/** A stand-in `gh` that answers the three reads the step makes from the world's files, through the `--jq` filter it was given, and logs every call. Any other call exits 99. */
function writeFakeGh(dir: string, failApi: boolean): void {
  const fake = join(dir, "gh");
  writeFileSync(fake, `#!/bin/bash
echo "$*" >> "${dir}/calls"
[ "${failApi}" = true ] && { echo "gh: HTTP 502" >&2; exit 1; }
filter=""; prev=""; for arg in "$@"; do [ "$prev" = "--jq" ] && filter="$arg"; prev="$arg"; done
nth() { n=$(cat "${dir}/$1.n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${dir}/$1.n"; f="${dir}/$1/$n"; [ -f "$f" ] || f="${dir}/$1/$(ls "${dir}/$1" | sort -n | tail -n1)"; echo "$f"; }
case "$*" in
  "api repos/${REPOSITORY}/git/ref/heads/"*) jq -r "$filter" "$(nth heads)" ;;
  "api repos/${REPOSITORY}/actions/workflows/ci.yml/runs?head_sha="*) jq -r "$filter" "$(nth lists)" ;;
  "api repos/${REPOSITORY}/actions/runs/${RUN_ID}/jobs"*) jq -r "$filter" "${dir}/jobs" ;;
  "run rerun ${RUN_ID} --repo ${REPOSITORY} --failed") echo "rerun requested" ;;
  *) echo "unexpected gh call: $*" >&2; exit 99 ;;
esac
`);
  chmodSync(fake, 0o755);
}

/** Runs the step as the runner would (`bash -eo pipefail`), in a directory holding the stand-in `gh`, and reports its exit status, its output and the `gh` calls it made. */
function runRepair(world: World, env: Record<string, string> = {}) {
  const dir = tmpDir("pr-body-edit-");
  const step = bodyEdit.jobs.repair!.steps![0]!;
  writeWorld(dir, world);
  writeFakeGh(dir, world.failApi === true);
  writeFileSync(join(dir, "script.sh"), step.run!);
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(dir, "script.sh")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...step.env, REPOSITORY, HEAD_REF: "admin/a11-401-x", EVENT_HEAD: HEAD, WAIT_SECONDS: "60", POLL_SECONDS: "0", ...env },
  });
  const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  return { status: result.status, out: `${result.stdout}${result.stderr}`, calls, reran: calls.some((call) => call.startsWith("run rerun")), listReads: calls.filter((call) => call.includes("/actions/workflows/ci.yml/runs")).length };
}

const completed = (conclusion: string, id = RUN_ID, created_at = "2026-11-02T06:26:40Z"): RunState => ({ id, status: "completed", conclusion, created_at });
const running = (id = RUN_ID): RunState => ({ id, status: "in_progress", conclusion: null, created_at: "2026-11-02T06:26:40Z" });

test("a ci run that failed in the changeset check is rerun with --failed, once it has completed, after waiting out the run in progress", () => {
  const result = runRepair({ lists: [[running()], [running()], [completed("failure")]], jobs: [...GREEN, job("changeset / changeset-required", "failure"), job("gate", "failure")] });
  assert.equal(result.status, 0, result.out);
  assert.equal(result.listReads, 3, "the run list is read again until the run has completed");
  assert.equal(result.calls.at(-1), `run rerun ${RUN_ID} --repo ${REPOSITORY} --failed`);
  assert.equal(result.calls.filter((call) => call.startsWith("run rerun")).length, 1);
});

test("a ci run that failed in the Closes check, a step of suite (1), is rerun", () => {
  const result = runRepair({ lists: [[completed("failure")]], jobs: [...GREEN, suiteOne(CLOSES_STEP), job("changeset / changeset-required", "success")] });
  assert.equal(result.status, 0, result.out);
  assert.equal(result.reran, true);
});

test("a ci run that failed in a test of suite (1) is not rerun: a body edit cannot change it", () => {
  const result = runRepair({ lists: [[completed("failure")]], jobs: [...GREEN, suiteOne("The tool's suite under rstest -- this shard's share"), job("changeset / changeset-required", "success")] });
  assert.equal(result.status, 0, result.out);
  assert.equal(result.reran, false);
  assert.match(result.out, /not in the changeset check or the Closes check/);
});

test("a ci run that failed in the changeset check AND elsewhere is not rerun: --failed would repeat the real failure", () => {
  const result = runRepair({ lists: [[completed("failure")]], jobs: [...GREEN.filter((j) => j.name !== "lint"), job("lint", "failure"), job("changeset / changeset-required", "failure"), job("gate", "failure")] });
  assert.equal(result.status, 0, result.out);
  assert.equal(result.reran, false);
  assert.match(result.out, /1 other job\(s\)/);
});

test("a ci run that failed only in lint is not rerun", () => {
  const result = runRepair({ lists: [[completed("failure")]], jobs: [...GREEN.filter((j) => j.name !== "lint"), job("lint", "failure"), job("changeset / changeset-required", "success")] });
  assert.equal(result.reran, false);
});

test("a ci run that succeeded, was cancelled or was skipped is not rerun: a cancelled run is the board's", () => {
  for (const conclusion of ["success", "cancelled", "skipped", "timed_out"]) {
    const result = runRepair({ lists: [[completed(conclusion)]], jobs: [job("changeset / changeset-required", "failure")] });
    assert.equal(result.status, 0, result.out);
    assert.equal(result.reran, false, conclusion);
    assert.match(result.out, new RegExp(`concluded ${conclusion}`));
  }
});

test("the newest ci run of the head decides, not an older cancelled one", () => {
  const older = completed("cancelled", 41399910129, "2026-11-02T06:26:26Z");
  const newer = completed("failure", RUN_ID, "2026-11-02T06:26:40Z");
  const result = runRepair({ lists: [[older, newer]], jobs: [job("changeset / changeset-required", "failure")] });
  assert.equal(result.reran, true);
});

test("a branch that has moved on since the edit is not touched: its push has its own ci run, which a rerun of the old head's would cancel", () => {
  const result = runRepair({ heads: [MOVED], lists: [[completed("failure")]], jobs: [job("changeset / changeset-required", "failure")] });
  assert.equal(result.status, 0, result.out);
  assert.equal(result.reran, false);
  assert.equal(result.listReads, 0, "the run list is not even read");
});

test("a branch that moves on while the run completes is not rerun either", () => {
  const result = runRepair({ heads: [HEAD, HEAD, MOVED], lists: [[running()], [completed("failure")]], jobs: [job("changeset / changeset-required", "failure")] });
  assert.equal(result.status, 0, result.out);
  assert.equal(result.reran, false);
  assert.match(result.out, /moved on to 99999999 while waiting/);
});

test("a run that has not completed when the wait ends gives a warning, ends green, and reruns nothing", () => {
  const result = runRepair({ lists: [[running()]] }, { WAIT_SECONDS: "0" });
  assert.equal(result.status, 0, result.out);
  assert.equal(result.reran, false);
  assert.match(result.out, /::warning::pr-body-edit: the ci run of 2f3f57e1 \(41399933489, in_progress\) had not completed after 0s/);
});

test("a head with no ci run yet is waited for in the same bounded way", () => {
  const result = runRepair({ lists: [[], [], [completed("failure")]], jobs: [job("changeset / changeset-required", "failure")] });
  assert.equal(result.reran, true);
  assert.equal(result.listReads, 3);
  const never = runRepair({ lists: [[]] }, { WAIT_SECONDS: "0" });
  assert.equal(never.status, 0, never.out);
  assert.match(never.out, /::warning::/);
  assert.equal(never.reran, false);
});

test("a failed API read fails the step: it is never read as no run, or as nothing failed", () => {
  const result = runRepair({ failApi: true });
  assert.notEqual(result.status, 0);
  assert.equal(result.reran, false);
});
