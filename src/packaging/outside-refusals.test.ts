// no-token: lookup
// agent-org#1578: the real verdict is reached once, with an injected `run` that always throws; every other case injects `verdictOf`, so no token is read and none is needed.
/**
 * agent-org#1578: THE OUTSIDE HOME OF a11ign's `deliberateRefusals` JOB, FLAG `outside.refusals`, SHIPPED OFF, SHADOW WHEN ON.
 *
 *   1. OFF IS NOTHING: absent, `false`, a non-boolean and a file that is not JSON all read off, and off reads, asks and writes nothing.
 *   2. ON IS SHADOW: the verdict is recorded beside the job's and nothing is armed, labelled, commented or refused (the only `gh` the pass makes is the verdict's own reads).
 *   3. THE SECOND ACTOR FINDS THE WORK DONE: a head already recorded is not asked again.
 *   4. AGENT PULL REQUESTS ONLY, AND ONLY ONCE THE JOB HAS SPOKEN: a fork, a non-org author, a job still running or cancelled are skipped.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTSIDE_REFUSALS_FLAG, outsideRefusalsOn, type DeliberateRefusal } from "../deliberate-refusal.ts";
import { MAX_REFUSAL_SHADOWS_PER_TICK, REFUSALS_JOB, REFUSALS_SHADOW_FILE, refusalsJobVerdict, settleOutsideRefusals } from "../work-gate/pr-orders.ts";
import { ORG_LOGINS } from "../messaging/sources/readers.ts";

const REPO = "a11ign/a11ign";
const dir = mkdtempSync(join(tmpdir(), "outside-refusals-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => join(dir, `state-${n++}`);
const declared = (name: string, text: string | null): string => {
  const path = join(dir, name);
  if (text !== null) writeFileSync(path, text);
  return path;
};
const quiet = { diagnostic: () => {}, state: {} as never };
const AUTHOR = ORG_LOGINS[0];
const jobRun = (conclusion: string | null, status = "COMPLETED", name = REFUSALS_JOB) => ({ name, status, conclusion, completedAt: "2026-10-16T10:00:00Z" });
const pr = (number: number, over: Record<string, unknown> = {}) => ({
  number, headRefOid: `${String(number).padStart(2, "0")}c0ffee1234`, isCrossRepository: false, author: { login: AUTHOR }, statusCheckRollup: [jobRun("SUCCESS")], ...over,
});
const lines: string[] = [];
const records = (stateDir: string): any[] => (existsSync(join(stateDir, REFUSALS_SHADOW_FILE))
  ? readFileSync(join(stateDir, REFUSALS_SHADOW_FILE), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : []);
const verdicts = (table: Record<number, DeliberateRefusal>, asked: number[] = []) =>
  ((({ number }: { number: number | string; }) => { asked.push(Number(number)); return table[Number(number)] ?? { kind: "clear" }; }) as never);
const never = (args: string[]): string => { throw new Error(`no gh expected, got ${args.join(" ")}`); };
const base = (stateDir: string, over: Record<string, unknown> = {}) => ({ scope: REPO, run: never, log: (line: string) => { lines.push(line); }, stateDir, now: () => "2026-10-16T12:00:00Z", ...over });
const on = declared("on.json", '{ "outside.refusals": true }');
const off = declared("off.json", '{ "outside.refusals": false }');

// --- 1. the flag -----------------------------------------------------------------------------------------------------------------------

test("the flag is `outside.refusals`, and only the literal `true` in an object of booleans turns it on", () => {
  assert.equal(OUTSIDE_REFUSALS_FLAG, "outside.refusals");
  assert.equal(outsideRefusalsOn(declared("flag-on.json", '{ "outside.refusals": true, "model-routing": true }'), quiet), true);
  for (const [name, text] of [
    ["absent.json", null], ["false.json", '{ "outside.refusals": false }'], ["unset.json", '{ "outside.arm": true }'],
    ["string.json", '{ "outside.refusals": "true" }'], ["number.json", '{ "outside.refusals": 1 }'], ["broken.json", "{ not json"],
  ] as const) assert.equal(outsideRefusalsOn(declared(name, text), quiet), false, `${name} reads off`);
});

test("OFF asks nothing, reads nothing and writes nothing, whatever the pull requests are", () => {
  for (const [switchesPath, flag] of [[off, undefined], [declared("never-written.json", null), undefined], [on, false]] as const) {
    const stateDir = fresh();
    const asked: number[] = [];
    const result = settleOutsideRefusals([pr(1), pr(2)], base(stateDir, { switchesPath, ...(flag === undefined ? {} : { on: flag }), verdictOf: verdicts({}, asked) }));
    assert.deepEqual(result.recorded, []);
    assert.deepEqual(asked, [], "no verdict was asked");
    assert.equal(existsSync(stateDir), false, "no state directory was made");
  }
});

// --- 2. ON is shadow -------------------------------------------------------------------------------------------------------------------

test("ON records the home's verdict beside the job's, with the reason line, and says which pull requests DISAGREE", () => {
  const stateDir = fresh();
  lines.length = 0;
  const table: Record<number, DeliberateRefusal> = {
    1: { kind: "clear" },
    2: { kind: "refused", why: "head is not the branch tip" },
    3: { kind: "cannot-ask", why: "could not read #3" },
    4: { kind: "clear" },
  };
  const prs = [pr(1), pr(2, { statusCheckRollup: [jobRun("FAILURE")] }), pr(3, { statusCheckRollup: [jobRun("SUCCESS")] }), pr(4, { statusCheckRollup: [jobRun("FAILURE")] })];
  const options = base(stateDir, { switchesPath: on, verdictOf: verdicts(table) });
  const result = { recorded: [...settleOutsideRefusals(prs, options).recorded, ...settleOutsideRefusals(prs, options).recorded] }; // the cap is three a tick; two ticks reach all four
  assert.deepEqual(result.recorded.map((r) => [r.number, r.home, r.job, r.agreement]), [
    [1, "pass", "pass", "agree"], [2, "refuse", "refuse", "agree"], [3, "refuse", "pass", "disagree"], [4, "pass", "refuse", "disagree"],
  ]);
  assert.equal(result.recorded[1].reason, "head is not the branch tip");
  assert.equal(result.recorded[2].reason, "CANNOT ASK: could not read #3", "a failed read is a refusal, and says it could not ask");
  assert.equal(result.recorded[0].reason, "clear");
  assert.deepEqual(records(stateDir), result.recorded, "what is returned is what is on disk");
  assert.ok(lines.some((line) => line.includes("#3@") && line.includes("DISAGREE")) && lines.some((line) => line.includes("#1@") && line.includes(" AGREE")));
});

test("ON BLOCKS NOTHING: the pass returns no list for the gate to act on, and its own `gh` is only the verdict's reads", () => {
  const stateDir = fresh();
  const seen: string[][] = [];
  const result = settleOutsideRefusals([pr(5, { statusCheckRollup: [jobRun("FAILURE")] })], base(stateDir, {
    switchesPath: on, run: (args: string[]) => { seen.push(args); throw new Error("unreadable"); },
  }));
  assert.deepEqual(Object.keys(result), ["recorded"], "the only output is the record");
  assert.equal(result.recorded[0].home, "refuse", "the REAL verdict, with every read failing, refuses (cannot ask) and does not throw");
  assert.ok(seen.length > 0 && seen.every((args) => args[0] === "api"), `only reads: ${seen.map((args) => args.join(" ")).join(" | ")}`);
});

// --- 3. the second actor ---------------------------------------------------------------------------------------------------------------

test("a head already recorded is not asked again, and a push is", () => {
  const stateDir = fresh();
  const asked: number[] = [];
  const options = base(stateDir, { switchesPath: on, verdictOf: verdicts({}, asked) });
  assert.equal(settleOutsideRefusals([pr(6)], options).recorded.length, 1);
  assert.equal(settleOutsideRefusals([pr(6)], options).recorded.length, 0, "the second pass over the same head writes nothing");
  assert.deepEqual(asked, [6]);
  assert.equal(records(stateDir).length, 1);
  assert.equal(settleOutsideRefusals([pr(6, { headRefOid: "ffffffff00" })], options).recorded.length, 1, "CONTROL: a new head is a new question");
  assert.equal(records(stateDir).length, 2);
});

// --- 4. who and when -------------------------------------------------------------------------------------------------------------------

test("only agent pull requests, and only once the job has settled at the head (a positive control beside every skip)", () => {
  const stateDir = fresh();
  const asked: number[] = [];
  const prs = [
    pr(10),
    pr(11, { isCrossRepository: true }), pr(12, { author: { login: "some-outside-contributor" } }), pr(13, { author: null }), pr(14, { isCrossRepository: undefined }),
    pr(15, { statusCheckRollup: [] }), pr(16, { statusCheckRollup: [jobRun(null, "IN_PROGRESS")] }), pr(17, { statusCheckRollup: [jobRun("CANCELLED")] }),
    pr(18, { statusCheckRollup: [jobRun("SUCCESS", "COMPLETED", "ts")] }), pr(19, { headRefOid: "" }),
  ];
  const result = settleOutsideRefusals(prs, base(stateDir, { switchesPath: on, verdictOf: verdicts({}, asked) }));
  assert.deepEqual(asked, [10], "CONTROL: the ordinary agent pull request is asked, and nothing else is");
  assert.deepEqual(result.recorded.map((r) => r.number), [10]);
});

test("the job's verdict is the NEWEST run's, and a skipped job is a pass", () => {
  assert.equal(refusalsJobVerdict(pr(20)), "pass");
  assert.equal(refusalsJobVerdict({ statusCheckRollup: [jobRun("SKIPPED")] }), "pass");
  for (const conclusion of ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]) assert.equal(refusalsJobVerdict({ statusCheckRollup: [jobRun(conclusion)] }), "refuse", conclusion);
  for (const missing of [undefined, null, [], "x", [jobRun("SUCCESS", "COMPLETED", "other")], [jobRun("CANCELLED")], [jobRun(null, "QUEUED")], [jobRun("WEIRD")]]) {
    assert.equal(refusalsJobVerdict({ statusCheckRollup: missing }), null, `absence is not a pass: ${JSON.stringify(missing)}`);
  }
  const older = { ...jobRun("FAILURE"), completedAt: "2026-10-16T09:00:00Z" }, newer = { ...jobRun("SUCCESS"), completedAt: "2026-10-16T11:00:00Z" };
  assert.equal(refusalsJobVerdict({ statusCheckRollup: [newer, older] }), "pass", "a superseded failure does not outlive its rerun");
  assert.equal(refusalsJobVerdict({ statusCheckRollup: [older, { ...newer, conclusion: "FAILURE" }] }), "refuse");
});

test("one tick computes at most MAX_REFUSAL_SHADOWS_PER_TICK verdicts; the rest wait for the next", () => {
  const stateDir = fresh();
  const asked: number[] = [];
  const prs = Array.from({ length: MAX_REFUSAL_SHADOWS_PER_TICK + 2 }, (_, i) => pr(30 + i));
  const options = base(stateDir, { switchesPath: on, verdictOf: verdicts({}, asked) });
  assert.equal(settleOutsideRefusals(prs, options).recorded.length, MAX_REFUSAL_SHADOWS_PER_TICK);
  assert.equal(settleOutsideRefusals(prs, options).recorded.length, 2, "the next tick reaches the rest");
  assert.equal(new Set(asked).size, prs.length);
});

test("a record file that cannot be read records nothing and says so, rather than asking again every tick", () => {
  const stateDir = fresh();
  writeFileSync(join(dir, "plain-file"), "x");
  const asked: number[] = [];
  lines.length = 0;
  const result = settleOutsideRefusals([pr(40)], base(join(dir, "plain-file"), { switchesPath: on, verdictOf: verdicts({}, asked) }));
  assert.deepEqual(result.recorded, []);
  assert.deepEqual(asked, []);
  assert.ok(lines.some((line) => line.includes("COULD NOT READ")));
  assert.equal(existsSync(stateDir), false);
});

test("the host gate calls the pass once per tick, right after the arming one", () => {
  const tick = readFileSync(new URL("../work-gate/tick.ts", import.meta.url), "utf8");
  const calls = tick.match(/settleOutsideRefusals\(openPrs, \{[^}]*\}\)/g) ?? [];
  assert.equal(calls.length, 1);
  assert.ok(tick.indexOf("settleOutsideArm(openPrs") < tick.indexOf("settleOutsideRefusals(openPrs"));
});
