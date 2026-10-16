// agent-org#1579 (the follow-up to agent-org#1580, a11ign#5613): the outside home of a11ign's `acceptance` job, SHADOW when `outside.acceptance` is on.
// The gate's own seams are injected (`verdictOf`, `outsideSwitches`, `log`, `stateDir`), so no test reaches `gh`, a checkout or a runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTSIDE_ACCEPTANCE_FLAG, outsideAcceptanceOn, orgSideAcceptanceEligibility, shadowAcceptanceVerdict, type OrgSideVerdict } from "../acceptance-commands.ts";
import { ACCEPTANCE_GATE_SWITCH_ENV, TREE_WIDE_GUARDS_SWITCH_ENV, acceptanceJobOf, gateUnarmedOnAcceptance } from "./tick.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { newestPerName } from "../newest-check-run.ts";

const HEAD = "1111111111111111111111111111111111111111";
const BASE = "a11ign/a11ign";
const DECLARED = { exact: ["a11ign-worker[bot]"], pattern: [] as RegExp[] };
const agentPr = (over: Record<string, unknown> = {}) => ({ number: 1, headRefName: "agent/some-row-1612", headRefOid: HEAD, isCrossRepository: false, body: "x",
  headRepository: { nameWithOwner: BASE }, author: { login: "a11ign-worker[bot]" }, ...over });
const ON = { [OUTSIDE_ACCEPTANCE_FLAG]: true };
const OFF: Record<string, unknown>[] = [{}, { [OUTSIDE_ACCEPTANCE_FLAG]: false }, { [OUTSIDE_ACCEPTANCE_FLAG]: "true" }, { [OUTSIDE_ACCEPTANCE_FLAG]: 1 }];
const verdict = (kind: OrgSideVerdict["kind"], head = HEAD): OrgSideVerdict => ({ kind, head, lines: [], why: `${kind} from the verdict seam` } as OrgSideVerdict);
const rollupOf = (conclusion: string, name = "acceptance") => [{ name, conclusion, completedAt: "2026-10-16T10:00:00Z" }, { name: "ts", conclusion: "FAILURE", completedAt: "2026-10-16T10:00:00Z" }];

/** The gate with the acceptance switch off and the guards switch off: only the outside home can speak. Every seam is a fake. */
const shadowRun = (prs: any[], { kind = "fail", switches, unarmed = [1], env = {} }: { kind?: OrgSideVerdict["kind"]; switches?: Record<string, unknown>; unarmed?: number[]; env?: Record<string, string | undefined>; } = {}) => {
  const asked: string[] = [];
  const said: string[] = [];
  const verdictOf = (pr: any): OrgSideVerdict => { asked.push(`a${pr.number}`); return verdict(kind, pr.headRefOid); };
  const stateDir = tmpDir("outside-acceptance-shadow-1579-");
  const gated = gateUnarmedOnAcceptance(unarmed, { openPrs: prs, scope: BASE, env, declared: DECLARED, verdictOf, stateDir, outsideSwitches: () => switches as Record<string, unknown>, log: (line: string) => { said.push(line); } });
  return { gated, asked, said };
};

test("(1579 i) the flag is `outside.acceptance`, and only a literal true turns it on: absent, false and every other value are off", () => {
  assert.equal(OUTSIDE_ACCEPTANCE_FLAG, "outside.acceptance");
  assert.equal(outsideAcceptanceOn({ "outside.acceptance": true }), true, "POSITIVE CONTROL");
  // `outside.guards` on is the guards shadow's flag, not this one: it must not turn this on
  for (const off of [...OFF, { "outside.guards": true }, null, undefined]) assert.equal(outsideAcceptanceOn(off as never), false, JSON.stringify(off));
});

test("(1579 ii) flag absent or false: the gate logs nothing, asks no verdict, and its output is byte-identical to a call that never heard of the flag", () => {
  const bare = shadowRun([agentPr()], { switches: undefined });
  assert.deepEqual(bare.said, [], "nothing logged");
  assert.deepEqual(bare.asked, [], "the acceptance verdict was never asked for");
  assert.deepEqual(bare.gated, { armable: [1], withheld: [] });
  for (const switches of OFF) {
    const run = shadowRun([agentPr()], { switches });
    assert.deepEqual(run.said, [], JSON.stringify(switches));
    assert.deepEqual(run.asked, [], JSON.stringify(switches));
    assert.deepEqual(run.gated, bare.gated, JSON.stringify(switches));
  }
});

test("(1579 iii) flag on, gate off: the eligible pull request is logged as a SHADOW line beside the job's verdict, the verdict is asked for once, and it arms as without the flag", () => {
  const { gated, asked, said } = shadowRun([agentPr({ number: 1 })], { switches: ON, kind: "fail" });
  assert.deepEqual(asked, ["a1"], "asked once, for the eligible pull request");
  assert.equal(said.length, 1, said.join("|"));
  assert.match(said[0], /^outside-acceptance: SHADOW #1 fail \(fail from the verdict seam\) beside the job's unread: not-compared; blocks nothing\.\n$/);
  assert.deepEqual(gated, { armable: [1], withheld: [] }, "a failing shadow holds nothing back");
  const pass = shadowRun([agentPr({ number: 1 })], { switches: ON, kind: "pass" });
  assert.deepEqual(pass.gated, { armable: [1], withheld: [] }, "POSITIVE CONTROL: a passing shadow arms the same way");
  assert.match(pass.said[0], /SHADOW #1 pass .*beside the job's unread: not-compared/);
});

test("(1579 iv) flag on: only the eligible pull request is asked for and logged; a feature branch, a fork and a stranger's pull request are neither", () => {
  const prs = [agentPr({ number: 1 }), agentPr({ number: 2, headRefName: "feature/y" }), agentPr({ number: 3, isCrossRepository: true }), agentPr({ number: 4, author: { login: "a-stranger" } })];
  const { gated, asked, said } = shadowRun(prs, { switches: ON, unarmed: [1, 2, 3, 4], kind: "pass" });
  assert.deepEqual(asked, ["a1"]);
  assert.equal(said.length, 1);
  assert.doesNotMatch(said.join("|"), /#[234]\b/, "a non-eligible pull request logs nothing");
  assert.deepEqual(gated, { armable: [1, 2, 3, 4], withheld: [] }, "every unarmed pull request is returned untouched");
});

test("(1579 v) the job's verdict is the `acceptance` check alone, the newest run of its name: SUCCESS is pass, FAILURE is fail, a run in progress is unread", () => {
  assert.equal(acceptanceJobOf([{ name: "acceptance", conclusion: "SUCCESS" }]), "pass", "POSITIVE CONTROL");
  assert.equal(acceptanceJobOf([{ name: "ci / acceptance", conclusion: "FAILURE" }]), "fail");
  assert.equal(acceptanceJobOf([{ name: "acceptance", conclusion: "TIMED_OUT" }]), "fail");
  for (const rollup of [[], null, undefined, [{ name: "acceptance", conclusion: "" }], [{ name: "acceptance", conclusion: "IN_PROGRESS" }], [{ name: "acceptance", conclusion: "CANCELLED" }],
    [{ name: "ts", conclusion: "SUCCESS" }], [{ name: "acceptance-notes", conclusion: "SUCCESS" }], [{ name: "guardSweep", conclusion: "SUCCESS" }]]) {
    assert.equal(acceptanceJobOf(rollup as never), null, JSON.stringify(rollup));
  }
  const { said } = shadowRun([agentPr({ number: 1, statusCheckRollup: rollupOf("SUCCESS") })], { switches: ON, kind: "fail" });
  assert.match(said[0], /beside the job's pass: disagree/, "a failing shadow against a passing job is a disagreement, which the canary counts");
  assert.equal(shadowRun([agentPr({ number: 1, statusCheckRollup: rollupOf("FAILURE") })], { switches: ON, kind: "fail" }).said[0].includes("beside the job's fail: agree"), true);
  assert.equal(shadowRun([agentPr({ number: 1, statusCheckRollup: rollupOf("IN_PROGRESS") })], { switches: ON, kind: "pass" }).said[0].includes("beside the job's unread: not-compared"), true);
});

test("(1579 vi) the job's newest run is the one read: an older red run of `acceptance` does not outvote a newer green one", () => {
  const rollup = [{ name: "acceptance", conclusion: "FAILURE", completedAt: "2026-10-16T09:00:00Z" }, { name: "acceptance", conclusion: "SUCCESS", completedAt: "2026-10-16T11:00:00Z" }];
  assert.equal(acceptanceJobOf(newestPerName(rollup)), "pass", "the caller narrows to the newest run per name, as the gate does");
  const { said } = shadowRun([agentPr({ number: 1, statusCheckRollup: rollup })], { switches: ON, kind: "pass" });
  assert.match(said[0], /beside the job's pass: agree/);
});

test("(1579 vii) the shadow does not depend on the gate's own call: `shadowAcceptanceVerdict` with a `verdictOf` seam asks it only when the flag is on", () => {
  for (const switches of OFF) {
    let calls = 0;
    assert.deepEqual(shadowAcceptanceVerdict(agentPr(), { switches, verdictOf: () => { calls++; return verdict("pass"); }, byDeclaredIdentity: () => true, baseRepo: BASE, checkout: () => "", }), { on: false });
    assert.equal(calls, 0, JSON.stringify(switches));
  }
  let calls = 0;
  const shadow = shadowAcceptanceVerdict(agentPr(), { switches: ON, job: "pass", verdictOf: () => { calls++; return verdict("pass"); }, byDeclaredIdentity: () => true, baseRepo: BASE, checkout: () => "" });
  assert.equal(calls, 1, "POSITIVE CONTROL: on, asked once");
  assert.equal(shadow.on && shadow.agreement, "agree");
  assert.equal(orgSideAcceptanceEligibility(agentPr(), { byDeclaredIdentity: () => true, baseRepo: BASE }).eligible, true);
});

test("(1579 viii) REGRESSION: `outside.guards` on beside a switched-on acceptance gate must not skip the real acceptance verdict", () => {
  const prs = [agentPr({ number: 1 })];
  const stateDir = tmpDir("outside-acceptance-shadow-1579-regression-");
  const guardsSaid: string[] = [];
  const common = { openPrs: prs, scope: BASE, env: { [ACCEPTANCE_GATE_SWITCH_ENV]: "on" }, declared: DECLARED, stateDir, log: (line: string) => { guardsSaid.push(line); },
    outsideSwitches: () => ({ "outside.guards": true }) as Record<string, unknown>, guardsOf: () => verdict("pass") };
  const failing = gateUnarmedOnAcceptance([1], { ...common, verdictOf: () => verdict("fail") });
  assert.deepEqual(failing.armable, [], "the real acceptance fail withholds the pull request");
  assert.equal(failing.withheld.length, 1);
  assert.ok(guardsSaid.some((line) => /outside-guards: SHADOW #1 pass/.test(line)), "the guards shadow still logs beside it");
  const passing = gateUnarmedOnAcceptance([1], { ...common, verdictOf: () => verdict("pass") });
  assert.deepEqual(passing.armable, [1], "POSITIVE CONTROL: a real acceptance pass arms it");
});

test("(1579 ix) both shadows on at once: each logs its own line, and neither holds a pull request back", () => {
  const said: string[] = [];
  const gated = gateUnarmedOnAcceptance([1], { openPrs: [agentPr({ number: 1 })], scope: BASE, env: {}, declared: DECLARED, stateDir: tmpDir("outside-acceptance-shadow-1579-both-"),
    verdictOf: () => verdict("fail"), guardsOf: () => verdict("fail"), outsideSwitches: () => ({ ...ON, "outside.guards": true }), log: (line: string) => { said.push(line); } });
  assert.deepEqual(gated, { armable: [1], withheld: [] });
  assert.equal(said.filter((line) => /^outside-acceptance: SHADOW #1 fail/.test(line)).length, 1, said.join("|"));
  assert.equal(said.filter((line) => /^outside-guards: SHADOW #1 fail/.test(line)).length, 1, said.join("|"));
});

test("(1579 x) the acceptance shadow beside a REAL switched-on guards gate changes nothing: the real guards failure still withholds the pull request", () => {
  const said: string[] = [];
  const gated = gateUnarmedOnAcceptance([1], { openPrs: [agentPr({ number: 1 })], scope: BASE, env: { [TREE_WIDE_GUARDS_SWITCH_ENV]: "on" }, declared: DECLARED, stateDir: tmpDir("outside-acceptance-shadow-1579-real-guards-"),
    verdictOf: () => verdict("pass"), guardsOf: () => verdict("fail"), outsideSwitches: () => ON, log: (line: string) => { said.push(line); } });
  assert.deepEqual(gated.armable, [], "the guards gate is real and fails: not armed");
  assert.ok(said.some((line) => /^outside-acceptance: SHADOW #1 pass/.test(line)), "the acceptance shadow still logs beside it");
});
