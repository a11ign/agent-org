// no-token: GH_TOKEN
// agent-org#1573: this file reads auto-arm.yml's TEXT and drives the outside pass over the fake code host's world (A11-160, step 5); the literal `GH_TOKEN` in an assertion message is what charges it, and it never uses a token.
/**
 * agent-org#1573: THE OUTSIDE HOME OF ARMING, FLAG `outside.arm`, SHIPPED OFF.
 *
 * Four things must hold, each with a control that fails when the thing it guards is broken:
 *   1. OFF IS NOTHING: absent, `false`, a non-boolean and a file that is not JSON all read off, and off reads and writes nothing at all.
 *   2. THE HOME ARMS ON THE JOB'S REFUSALS: draft, `hold:`, fork head, base not `main`, closed, already armed, and a field not read each leave a pull request alone.
 *   3. THE SECOND ACTOR FINDS THE WORK DONE: a pull request the project's job armed first, or this pass armed a moment ago, takes no write on the next pass.
 *   4. THE WORKFLOW READS THE FLAG BEFORE IT MINTS, and the schedule reaches no job that already ran on another event.
 */
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { OUTSIDE_ARM_FLAG, outsideArmOn } from "../arm-pr.ts";
import { outsideArmPass, outsideArmVerdict, type OutsideArmPr } from "../auto-arm-sweep.ts";
import { forgetActivation, substituteCodeHost } from "../plugins/active.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { FakeRowPull } from "../plugins/fakes/code-host-rows.ts";
import { settleOutsideArm } from "../work-gate/pr-orders/pr-gate-readings.ts";
import { HOME_CHECKOUT } from "../project-config.ts";
import { loadLanes, ownsReviewOnlyLane, type Lane } from "../lane-ownership.ts";

const REPO = "a11ign/a11ign";
const dir = mkdtempSync(join(tmpdir(), "outside-arm-"));
after(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => forgetActivation());
const declared = (name: string, text: string | null): string => {
  const path = join(dir, name);
  if (text !== null) writeFileSync(path, text);
  return path;
};
const quiet = { diagnostic: () => {}, state: {} as never };

const OPEN: OutsideArmPr = { number: 7, state: "OPEN", isDraft: false, baseRefName: "main", isCrossRepository: false, reviewDecision: "REVIEW_REQUIRED", labels: [{ name: "agent" }] };

// --- 1. the flag -----------------------------------------------------------------------------------------------------------------------

test("the flag is `outside.arm`, and only the literal `true` in an object of booleans turns it on", () => {
  assert.equal(OUTSIDE_ARM_FLAG, "outside.arm");
  assert.equal(outsideArmOn(declared("on.json", '{ "outside.arm": true, "model-routing": true }'), quiet), true);
  for (const [name, text] of [
    ["absent.json", null], ["false.json", '{ "outside.arm": false }'], ["unset.json", '{ "model-routing": true }'],
    ["string.json", '{ "outside.arm": "true" }'], ["number.json", '{ "outside.arm": 1 }'], ["broken.json", "{ not json"],
  ] as const) assert.equal(outsideArmOn(declared(name, text), quiet), false, `${name} reads off`);
});

test("a declaration that cannot be used is off and says so once, naming the file and not its text", () => {
  const lines: string[] = [];
  const path = declared("loud.json", '{ "outside.arm": "SECRET-TEXT" }');
  assert.equal(outsideArmOn(path, { diagnostic: (line) => lines.push(line), state: {} as never }), false);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(path) && !lines[0].includes("SECRET-TEXT"));
});

// --- 2. the refusals -------------------------------------------------------------------------------------------------------------------

test("the verdict leaves alone what the project's jobs refuse, and arms the one case they arm (a positive control beside every refusal)", () => {
  assert.deepEqual(outsideArmVerdict(OPEN, false).act, "arm", "CONTROL: an ordinary open pull request is armed");
  const refused: Array<[string, OutsideArmPr, boolean | null, RegExp]> = [
    ["a draft that is not approved", { ...OPEN, isDraft: true }, false, /draft that is not approved/],
    ["a closed pull request", { ...OPEN, state: "CLOSED" }, false, /CLOSED/],
    ["a base other than main", { ...OPEN, baseRefName: "release" }, false, /not main/],
    ["a fork's head", { ...OPEN, isCrossRepository: true }, false, /fork/],
    ["a head whose forkedness was not read", { ...OPEN, isCrossRepository: undefined }, false, /not read/],
    ["a held pull request", { ...OPEN, labels: [{ name: "hold:ceo" }] }, false, /hold/i],
    ["an armed pull request", OPEN, true, /already armed/],
    ["an armed state that was not read", OPEN, null, /not read/],
  ];
  for (const [what, pr, armed, why] of refused) {
    const verdict = outsideArmVerdict(pr, armed);
    assert.equal(verdict.act, "leave", what);
    assert.match(verdict.why, why, what);
  }
  assert.equal(outsideArmVerdict({ ...OPEN, labels: [{ name: "on-hold" }, { name: "holdout" }] }, false).act, "arm", "CONTROL: a hold is a PREFIX, as in the job");
  assert.equal(outsideArmVerdict({ ...OPEN, isDraft: true, reviewDecision: "APPROVED" }, false).act, "ready-and-arm", "an approved draft is readied, then armed (`arm-approved`)");
  assert.equal(outsideArmVerdict({ ...OPEN, isDraft: true, reviewDecision: "APPROVED", labels: ["hold:x"] }, false).act, "leave", "an approved draft that is held is still held");
});

// --- 3. the pass: the fake code host's world, so the second actor can be watched ------------------------------------------------------------

/**
 * The fake code host holding `prs` as its open pull requests (`armed` of them already armed). `writes` is what the pass did, in order: the arm the test injects records `arm <n>` and sets the pull
 * request armed as GitHub would, and the code host's own `readyPullRequest` is in the world's calls.
 */
function world(prs: OutsideArmPr[], armed: number[] = []) {
  const host = createFakeCodeHost();
  substituteCodeHost(host);
  const { rowsWorld } = host;
  const names = (pr: OutsideArmPr) => (pr.labels ?? []).map((label) => (typeof label === "string" ? label : label.name));
  for (const pr of prs) {
    const pull: FakeRowPull = { number: pr.number, body: "", headRefName: `agent/${pr.number}`, labels: names(pr), isDraft: pr.isDraft === true, armed: armed.includes(pr.number), merged: false, mergedAt: null,
      createdAt: "2026-10-23T10:00:00Z", comments: [], baseRefName: pr.baseRefName, isCrossRepository: pr.isCrossRepository, reviewDecision: pr.reviewDecision ?? "" };
    rowsWorld.pulls.set(pr.number, pull);
  }
  const writes = () => rowsWorld.calls.filter((call) => call.startsWith("arm ") || call.startsWith("readyPullRequest"));
  return { rowsWorld, writes, pull: (number: number) => rowsWorld.pulls.get(number)! };
}
type World = ReturnType<typeof world>;
const armOf = (w: World, code = 0) => (number: number): number => { w.rowsWorld.calls.push(`arm ${number}`); if (code === 0) w.pull(number).armed = true; return code; };
const on = declared("pass-on.json", '{ "outside.arm": true }');
const off = declared("pass-off.json", '{ "outside.arm": false }');
const readsRefused = (w: World) => { for (const name of ["readOutsideArmListed", "readOpenPullNodes", "armedNodeOf"]) w.rowsWorld.failures.set(name, new Error(`the code host was asked: ${name}`)); };

test("OFF reads nothing and writes nothing: no list, no query, no arm", () => {
  const w = world([OPEN]);
  readsRefused(w); // any read of the code host would be COULD NOT ASK, which the result would show
  for (const switchesPath of [off, declared("pass-absent.json", null)]) {
    const result = outsideArmPass({ repo: REPO, switchesPath, arm: armOf(w), log: () => {} });
    assert.deepEqual(result, { armed: [], readied: [], left: [], failed: [], cannotAsk: false });
  }
  assert.deepEqual(w.writes(), []);
  // CONTROL: the same world, on, does act, so the silence above is the flag and not a pass that never runs.
  w.rowsWorld.failures.clear();
  const acted = outsideArmPass({ repo: REPO, switchesPath: on, arm: armOf(w), log: () => {} });
  assert.deepEqual(acted.armed, [7]);
});

test("ON arms what the job would arm, readies an approved draft first, and leaves every refusal alone", () => {
  const w = world([
    OPEN,
    { ...OPEN, number: 8, isDraft: true, reviewDecision: "APPROVED" },
    { ...OPEN, number: 9, isDraft: true },
    { ...OPEN, number: 10, isCrossRepository: true },
    { ...OPEN, number: 11, labels: [{ name: "hold:ceo" }] },
    { ...OPEN, number: 12, baseRefName: "release" },
  ]);
  const result = outsideArmPass({ repo: REPO, switchesPath: on, arm: armOf(w), log: () => {} });
  assert.deepEqual(result.armed, [7, 8]);
  assert.deepEqual(result.readied, [8]);
  assert.deepEqual(w.writes(), ["arm 7", "readyPullRequest #8", "arm 8"], "the ready comes before the arm, and nothing else is written");
  assert.deepEqual(result.left.map((l) => l.number), [9, 10, 11, 12]);
});

test("THE SECOND ACTOR DOES NOTHING: a pull request the project's job armed first, and one this pass armed a pass ago, take no write", () => {
  const w = world([OPEN, { ...OPEN, number: 8 }], [8]); // the project's own job armed #8 before this pass looked
  const first = outsideArmPass({ repo: REPO, switchesPath: on, arm: armOf(w), log: () => {} });
  assert.deepEqual(first.armed, [7], "only the unarmed one");
  assert.deepEqual(first.left, [{ number: 8, why: "already armed" }]);
  w.rowsWorld.calls.length = 0;
  const second = outsideArmPass({ repo: REPO, switchesPath: on, arm: armOf(w), log: () => {} });
  assert.deepEqual(second.armed, [], "the work is done");
  assert.deepEqual(w.writes(), [], "and nothing is written");
  assert.deepEqual(second.left.map((l) => l.why), ["already armed", "already armed"]);
});

test("a read that fails is COULD NOT ASK and arms nothing; an arm that fails is named, and the pass goes on", () => {
  const lines: string[] = [];
  const w = world([OPEN, { ...OPEN, number: 8 }]);
  w.rowsWorld.failures.set("readOutsideArmListed", new Error("API rate limit exceeded"));
  const broken = outsideArmPass({ repo: REPO, switchesPath: on, arm: armOf(w), log: (l) => lines.push(l) });
  assert.equal(broken.cannotAsk, true);
  assert.deepEqual(w.writes(), []);
  assert.match(lines.join("\n"), /COULD NOT ASK -- API rate limit exceeded/);
  w.rowsWorld.failures.clear();
  const refusing = outsideArmPass({ repo: REPO, switchesPath: on, arm: (n) => (n === 7 ? 1 : armOf(w)(n)), log: (l) => lines.push(l) });
  assert.deepEqual(refusing.failed, [7]);
  assert.deepEqual(refusing.armed, [8]);
  assert.equal(refusing.cannotAsk, false);
});

test("agent-org#1626: an `arm-pr` that writes the arm and then exits nonzero is READ BACK, and the pass reports what GitHub says, not COULD NOT ARM alone", () => {
  // The three exits `arm-pr` takes AFTER its arm write (src/arm-pr.ts EXIT): 1 the retired-session label refusal, 3 ARMED_THEN_LABEL_FAILED, 4 JUMP_UNCONFIRMED.
  for (const [code, line] of [[1, "arm-pr: retired session label"], [3, "arm-pr: labelling failed AFTER the arm step. #7 IS ARMED"], [4, "arm-pr: the jump is not confirmed"]] as const) {
    const w = world([OPEN]);
    const lines: string[] = [];
    const arm = (number: number, say: (l: string) => void): number => { w.rowsWorld.calls.push(`arm ${number}`); w.pull(number).armed = true; say(`arm-pr: armed #${number} -- open`); say(line); return code; };
    const result = outsideArmPass({ repo: REPO, switchesPath: on, arm, log: (l) => lines.push(l) });
    assert.deepEqual(result.armed, [7], `exit ${code}: GitHub says armed`);
    assert.deepEqual(result.failed, [], `exit ${code}: not reported as a failure to arm`);
    const out = lines.join("\n");
    assert.match(out, new RegExp(`OUTSIDE-ARM: #7 armed -- read back: .*BUT arm-pr exited ${code} \\(${line}\\)`), `exit ${code}: the exit is named beside the read-back`);
    assert.doesNotMatch(out, /COULD NOT ARM/, `exit ${code}`);
  }
  // CONTROL, the other direction: the same exit 1 BEFORE any write (the authorship refusal) leaves GitHub unarmed, and the pass says so.
  const w = world([OPEN]);
  const lines: string[] = [];
  const refused = outsideArmPass({ repo: REPO, switchesPath: on, arm: (n, say) => { say(`arm-pr: NOT arming #${n} -- authored into a review-only lane`); return 1; }, log: (l) => lines.push(l) });
  assert.deepEqual(refused.armed, []);
  assert.deepEqual(refused.failed, [7]);
  assert.match(lines.join("\n"), /COULD NOT ARM -- arm-pr exited 1 \(arm-pr: NOT arming #7 .*\); read back: NOT ARMED/);
  // A read-back that throws after a nonzero exit says it could not tell, and names the exit.
  const unread: string[] = [];
  w.rowsWorld.failures.set("armedNodeOf", new Error("boom"));
  const blind = outsideArmPass({ repo: REPO, switchesPath: on, arm: () => 3, log: (l) => unread.push(l) });
  assert.deepEqual(blind.armed, []);
  assert.deepEqual(blind.failed, [7]);
  assert.match(unread.join("\n"), /COULD NOT ARM -- arm-pr exited 3, and the read-back could not say whether it took: boom/);
});

test("the gate's half takes the tick's list as it is (label objects, no `state`), and off asks the code host nothing", () => {
  const w = world([OPEN], [7]);
  const tickList = [{ number: 7, isDraft: false, baseRefName: "main", isCrossRepository: false, reviewDecision: "", labels: [{ name: "agent" }], body: "ignored" }];
  const lines: string[] = [];
  readsRefused(w);
  const offResult = settleOutsideArm(tickList, { scope: REPO, run: () => { throw new Error("off asks nothing"); }, log: (l) => lines.push(l), switchesPath: off });
  assert.deepEqual(offResult, { armed: [], readied: [], left: [], failed: [], cannotAsk: false }, "off reads nothing: a read of the code host would have been COULD NOT ASK");
  // The gate's own list is not read again: only the armed state is, then `arm-pr`'s command is reached for a pull request that needs it (here none does: it is armed).
  w.rowsWorld.failures.delete("readOpenPullNodes");
  const result = settleOutsideArm(tickList, { scope: REPO, run: () => { throw new Error("no gh expected"); }, log: (l) => lines.push(l), switchesPath: on });
  assert.deepEqual(result.left, [{ number: 7, why: "already armed" }]);
  assert.deepEqual(w.writes(), [], "the tick's list was the list: `readOutsideArmListed` was refused above and not reached, and nothing was written");
});

// --- 4. the sweep and the stalled report, as commands, and the workflow ---------------------------------------------------------------------

test("the sweep and the stalled report, given an OFF declaration, say so and run nothing (no `gh` is on the PATH, so any read would fail the run)", () => {
  for (const script of ["auto-arm-sweep.ts", "queue-stalled.ts"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(`../${script}`, import.meta.url)), `--outside-switches=${off}`], {
      cwd: HOME_CHECKOUT, encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY: REPO, PATH: "/nonexistent" },
    });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    assert.match(result.stdout, /outside\.arm is off/, script);
  }
  // CONTROL: ON, the same command goes on to read, and with no `gh` it cannot: the off silence above is the flag.
  const ranOn = spawnSync(process.execPath, [fileURLToPath(new URL("../auto-arm-sweep.ts", import.meta.url)), `--outside-switches=${on}`], {
    cwd: HOME_CHECKOUT, encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY: REPO, PATH: "/nonexistent" },
  });
  assert.equal(ranOn.status, 2, "CANNOT_ASK: it tried to list pull requests");
  assert.doesNotMatch(ranOn.stdout, /outside\.arm is off/);
});

type Job = { if?: string; permissions?: Record<string, string>; steps: Array<{ name?: string; id?: string; if?: string; uses?: string; run?: string; with?: Record<string, string>; env?: Record<string, string>; }> };
const doc = parseYaml(readFileSync(fileURLToPath(new URL("../../.github/workflows/auto-arm.yml", import.meta.url)), "utf8")) as { on: Record<string, unknown>; jobs: Record<string, Job> };

test("the workflow: the schedule reaches only the two outside jobs, and every job that ran on another event still does not run on it", () => {
  assert.ok("schedule" in doc.on);
  for (const name of ["arm", "relay", "arm-approved"]) {
    assert.doesNotMatch(doc.jobs[name].if ?? "", /schedule/, `${name} must not read the schedule`);
    assert.match(doc.jobs[name].if ?? "", /github\.event_name == '(pull_request_target|pull_request_review|workflow_dispatch)'/, `${name} keeps its own event`);
  }
  for (const name of ["outside-sweep", "outside-stalled"]) assert.match(doc.jobs[name].if ?? "", /^github\.event_name == 'schedule' && github\.repository == 'a11ign\/agent-org'$/, name);
});

test("the workflow reads the flag BEFORE it mints, mints only when it is on, scopes the mint to a11ign and has no fallback to `github.token` for the arming step", () => {
  const sweep = doc.jobs["outside-sweep"].steps;
  const index = (pick: (s: Job["steps"][number]) => boolean) => sweep.findIndex(pick);
  const flag = index((s) => s.id === "flag"), mint = index((s) => s.id === "octo-sts"), arm = index((s) => (s.run ?? "").includes("auto-arm-sweep.ts"));
  assert.ok(flag >= 0 && flag < mint && mint < arm, "flag, then mint, then arm");
  assert.match(sweep[flag].run ?? "", /arm-pr\.ts --outside-arm-state=\.agent-org\/decisions\.json/);
  assert.equal(sweep[mint].if, "steps.flag.outputs.on == 'true'");
  assert.equal(sweep[mint].with?.scope, "a11ign/a11ign");
  assert.equal(sweep[mint].with?.identity, "outside-arm");
  assert.equal(sweep[arm].if, "steps.flag.outputs.on == 'true'");
  assert.equal(sweep[arm].env?.GH_TOKEN, "${{ steps.octo-sts.outputs.token }}", "the arming step holds the minted token and nothing else");
  assert.equal(sweep[arm].env?.GITHUB_REPOSITORY, "a11ign/a11ign");
  assert.equal(doc.jobs["outside-sweep"].permissions?.["id-token"], "write");
  const stalled = doc.jobs["outside-stalled"];
  assert.equal(stalled.permissions?.["id-token"], "write");
  const stalledMint = stalled.steps.findIndex((s) => s.id === "octo-sts"), stalledRun = stalled.steps.findIndex((s) => (s.run ?? "").includes("queue-stalled.ts"));
  assert.ok(stalled.steps.findIndex((s) => s.id === "flag") < stalledMint && stalledMint < stalledRun, "flag, then mint, then report");
  assert.equal(stalled.steps[stalledMint].if, "steps.flag.outputs.on == 'true'");
  assert.equal(stalled.steps[stalledMint].with?.identity, "outside-arm");
  assert.equal(stalled.steps[stalledRun].env?.GH_TOKEN, "${{ steps.octo-sts.outputs.token }}", "the report holds the minted token, never `github.token`");
  assert.ok(stalled.steps.some((s) => s.id === "flag") && stalled.steps.filter((s) => (s.run ?? "").includes("queue-stalled.ts")).every((s) => s.if === "steps.flag.outputs.on == 'true'"));
  // CONTROL for the reading above: the project's own `arm` job IS a job that mints and has no flag step, so the checks are not vacuous.
  assert.ok(doc.jobs.arm.steps.some((s) => s.id === "octo-sts") && !doc.jobs.arm.steps.some((s) => s.id === "flag"));
});

// --- 5. the lanes the pass is handed are the lanes `arm-pr` judges authorship by -----------------------------------------------------------

test("agent-org#1627: `arm-pr` under the pass judges authorship from the lanes the caller passed, not from the home checkout's file", () => {
  const LEADS = "a11ign-ai-leads";
  const PIPELINE: Lane = { lane: "the pipeline", owner: "ceo", branchPrefixes: ["ceo/"], paths: [".github/workflows/"], why: "trunk health", reviewOnly: true };
  // The one read that proves authorship was judged: the changed-file list is read only when the author owns a review-only lane (`authorshipVerdict`, which asks the code host).
  const drive = (lanes?: { lanes: Lane[]; } | null) => {
    const w = world([OPEN]);
    w.pull(7).author = LEADS;
    w.rowsWorld.tail.readouts.pulls.set(`${REPO}#7`, { title: "", body: "", additions: 0, deletions: 0, files: [".github/workflows/ci.yml"] });
    const run = (args: string[]): string => { throw new Error(`unexpected gh ${args.join(" ")}`); };
    const lines: string[] = [];
    const result = outsideArmPass({ repo: REPO, switchesPath: on, run, log: (l) => lines.push(l), ...(lanes === undefined ? {} : { lanes }) });
    return { result, lines: lines.join("\n"), filesRead: w.rowsWorld.calls.some((call) => call.startsWith("pullFilenamesOf")) };
  };
  const home = loadLanes();
  assert.ok(ownsReviewOnlyLane(LEADS, home), "PRECONDITION: the home checkout's file makes this author a lane owner, so the passed lanes below DIFFER from it");

  const passedEmpty = drive({ lanes: [] });
  assert.equal(passedEmpty.filesRead, false, "lanes passed with no lane: the home file's lane is not consulted");
  assert.doesNotMatch(passedEmpty.lines, /review-only lane|pipeline/i, "no lane refusal under the passed lanes");

  const passedLane = drive({ lanes: [PIPELINE] });
  assert.equal(passedLane.filesRead, true, "CONTROL: lanes passed that own the author make arm-pr read the changed files");
  assert.deepEqual(passedLane.result.armed, [], "and a pipeline file by that author is not armed");
  assert.match(passedLane.lines, /lane|pipeline/i, "and the refusal names the lane");

  assert.equal(drive().filesRead, true, "CONTROL: omitted, `arm-pr` falls back to the home checkout's file (the default this row is about)");
});
