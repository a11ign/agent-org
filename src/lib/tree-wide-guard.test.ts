// no-token: DeclarationReading -- every input that reaches acceptanceGateOf is injected (prOf and gateOf are seams) and the tick test hands every reader a stub, so no declaration is read and no gh call runs
// agent-org#1503 (ADR 0045 cut c, receiving side of a11ign#5460): the org side of a11ign's `guardSweep`. Each test names its positive control: a discovery
// that finds nothing, a runner that ran nothing and a verdict that is `pass` over zero guards are all the same defect, so each has a fixture beside it
// that is MARKED and a twin that is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUTSIDE_GUARDS_FLAG, declaresTreeWideGuard, guardSweepJobOf, outsideGuardsOn, runTreeWideGuards, shadowGuardsVerdict, treeWideGuardFilesIn } from "./tree-wide-guard-org-side.ts";
import { sandboxGitEnv } from "./git-env.ts";
import { tmpDir } from "./tmp-fixture.ts";
import { acceptanceGateOf, firstRefusalOf, treeWideGuardVerdict } from "../work-gate/pr-orders.ts";
import { orgSideAcceptanceEligibility, type OrgSideVerdict } from "../acceptance-commands.ts";
import { ACCEPTANCE_GATE_SWITCH_ENV, TREE_WIDE_GUARDS_SWITCH_ENV, gateUnarmedOnAcceptance } from "../work-gate/tick.ts";

const MARKED = `import { test } from "node:test";\nimport { declareTreeWideGuard } from "@a11ign/toolchain/lib/tree-wide-guard";\ndeclareTreeWideGuard();\ntest("x", () => {});\n`;
const HEAD = "1111111111111111111111111111111111111111";
const BASE = "a11ign/a11ign";
const DECLARED = { exact: ["a11ign-worker[bot]"], pattern: [] as RegExp[] };
const agentPr = (over: Record<string, unknown> = {}) => ({ number: 7, headRefName: "agent/some-row-1503", headRefOid: HEAD, isCrossRepository: false, body: "x",
  headRepository: { nameWithOwner: BASE }, author: { login: "a11ign-worker[bot]" }, ...over });
const eligible = (pr: any) => orgSideAcceptanceEligibility(pr, { byDeclaredIdentity: (p) => (p.author as any)?.login === "a11ign-worker[bot]", baseRepo: BASE });

test("(1503 a) a file declares itself a tree-wide guard by IMPORTING the marker AND CALLING it, from either declared specifier, and by nothing else", () => {
  assert.equal(declaresTreeWideGuard(MARKED), true, "POSITIVE CONTROL: the marked fixture is seen");
  assert.equal(declaresTreeWideGuard(MARKED.replace("@a11ign/toolchain/lib/tree-wide-guard", "agent-org/tree-wide-guard")), true, "the tool's own declared export is the second specifier");
  assert.equal(declaresTreeWideGuard(MARKED.replace("declareTreeWideGuard();\n", "")), false, "imported and never called is not a declaration");
  assert.equal(declaresTreeWideGuard(`declareTreeWideGuard();\n`), false, "called with no import of it is not a declaration");
  assert.equal(declaresTreeWideGuard(`// import { declareTreeWideGuard } from "@a11ign/toolchain/lib/tree-wide-guard";\n// declareTreeWideGuard();\n`), false, "a comment is not one");
  assert.equal(declaresTreeWideGuard(`const s = "import { declareTreeWideGuard } from '@a11ign/other';"; declareTreeWideGuard();`), false, "another module's specifier is not the marker");
});

test("(1503 b) discovery reads the checkout at `cwd`, not the process's: a real git repository, one marked file and one twin", () => {
  const repo = tmpDir("tree-wide-guard-1503-");
  mkdirSync(join(repo, "packages/guards"), { recursive: true });
  writeFileSync(join(repo, "packages/guards/leak.test.ts"), MARKED);
  writeFileSync(join(repo, "packages/guards/plain.test.ts"), MARKED.replace("declareTreeWideGuard();\n", ""));
  writeFileSync(join(repo, "untracked.test.ts"), MARKED);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: sandboxGitEnv() });
  git("init", "-q");
  git("add", "packages");
  assert.deepEqual(treeWideGuardFilesIn(repo), ["packages/guards/leak.test.ts"], "the marked tracked file, and neither its twin nor the untracked one");
  assert.deepEqual(treeWideGuardFilesIn(repo, { lsFiles: () => "", readFile: () => MARKED }), [], "NEGATIVE CONTROL: a listing that is empty finds none");
});

test("(1503 c) the runner reads the VERDICT off node --test: a pass, a failure, and a file that ran nothing (exit 0, zero tests) which is NOT a pass", () => {
  const dir = tmpDir("tree-wide-guard-1503-run-");
  const write = (name: string, body: string) => writeFileSync(join(dir, name), body);
  write("ok.test.js", `import { test } from "node:test";\ntest("fine", () => {});\n`);
  write("bad.test.js", `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("broken", () => { assert.equal(1, 2); });\n`);
  write("empty.test.js", `export const nothing = 1;\n`);
  const ok = runTreeWideGuards(["ok.test.js"], dir);
  assert.equal(ok.ok, true, ok.lines.join("\n"));
  assert.ok(ok.ran >= 1);
  const bad = runTreeWideGuards(["ok.test.js", "bad.test.js"], dir);
  assert.equal(bad.ok, false);
  assert.ok(bad.lines.some((line) => /fail 1|✖/.test(line)), `names the failure: ${bad.lines.join(" | ")}`);
  const empty = runTreeWideGuards(["empty.test.js"], dir);
  assert.equal(empty.ok, false, "exit 0 over zero tests is not a pass");
  assert.match(empty.lines.join("\n"), /empty.test.js ran nothing/);
  assert.equal(runTreeWideGuards(["ok.test.js", "empty.test.js"], dir).ok, false, "one empty guard among passing ones still refuses");
  mkdirSync(join(dir, "packages/guards/src"), { recursive: true });
  write("packages/guards/src/nested-empty.test.js", `export const nothing = 1;\n`);
  const nested = runTreeWideGuards(["packages/guards/src/nested-empty.test.js"], dir);
  assert.equal(nested.ok, false, "a nested path is read the same way as a bare one");
  assert.match(nested.lines.join("\n"), /nested-empty.test.js ran nothing/);
  const seen: Record<string, string | undefined> = {};
  runTreeWideGuards(["ok.test.js"], dir, { env: { PATH: "/usr/bin", [`GH_TO${"KEN"}`]: "t", [`GITHUB_TO${"KEN"}`]: "t", NPM_CONFIG_PAT: "p", KEEP: "k" },
    spawn: (_c, _a, options: any) => { Object.assign(seen, options.env); return { status: 0, stdout: "✔ a real test (1ms)\nℹ tests 1\nℹ fail 0\n" }; } });
  assert.deepEqual(Object.keys(seen).sort(), ["KEEP", "PATH"], "tokens and secrets are not handed to a pull request's test code");
  const slow = runTreeWideGuards(["ok.test.js"], dir, { spawn: () => ({ status: null, error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }) }) });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.ok, false);
});

test("(1503 c2) with the project's rstest config the guards run under THE PROJECT'S runner and its VERDICT line is what is read: absent, fail, REFUSED, or fewer files than asked is not a pass", () => {
  const files = ["packages/guards/a.test.ts", "packages/guards/b.test.ts"];
  const through = (stdout: string, status: number | null = 0) => {
    const seen: { command?: string; args?: string[] } = {};
    const run = runTreeWideGuards(files, "/nowhere", { exists: (path) => path.endsWith("scripts/rstest/rstest.config.ts"), env: {},
      spawn: (command, args) => { Object.assign(seen, { command, args }); return { status, stdout }; } });
    return { run, seen };
  };
  const pass = through("noise\nVERDICT pass: 48 tests in 2 files\n");
  assert.equal(pass.run.ok, true, pass.run.lines.join("\n"));
  assert.equal(pass.run.ran, 48);
  const joined = [pass.seen.command, ...(pass.seen.args ?? [])].join(" ");
  assert.match(joined, /rstest run --config scripts\/rstest\/rstest\.config\.ts packages\/guards\/a\.test\.ts packages\/guards\/b\.test\.ts$/, "the project's runner, over exactly the discovered files");
  assert.doesNotMatch(joined, /--test/, "not node's runner");
  assert.equal(through("VERDICT fail: 48 tests in 2 files\n", 1).run.ok, false);
  assert.equal(through("VERDICT REFUSED: 0 tests in 2 files\n", 1).run.ok, false);
  assert.equal(through("VERDICT pass: 48 tests in 2 files\n", 1).run.ok, false, "a verdict line over a failing exit is not a pass");
  const none = through("all good, trust me\n");
  assert.equal(none.run.ok, false, "exit 0 and no VERDICT line: an unread verdict is not a pass");
  assert.match(none.run.lines.join("\n"), /no VERDICT line/);
  const short = through("VERDICT pass: 12 tests in 1 files\n");
  assert.equal(short.run.ok, false, "one of two guard files ran: that is not a pass");
  assert.match(short.run.lines.join("\n"), /1 of 2 guard file/);
  assert.equal(through("VERDICT pass: 0 tests in 2 files\n").run.ok, false, "zero tests is not a pass");
});

const seams = (over: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const base = {
    eligible,
    checkout: (head: string) => { calls.push("checkout"); return `/tmp/co-${head.slice(0, 4)}`; },
    prepare: () => { calls.push("prepare"); },
    discover: () => { calls.push("discover"); return ["packages/guards/a.test.ts", "packages/guards/b.test.ts"]; },
    run: () => { calls.push("run"); return { ok: true, lines: ["ℹ tests 9"], ran: 9, timedOut: false }; },
    release: () => { calls.push("release"); },
    ...over,
  };
  return { calls, base: base as any };
};

test("(1503 d) the verdict: an ineligible pull request makes no checkout and runs nothing; every doubt is not-run, never pass; a checkout is always released", () => {
  for (const [why, pr] of [["fork", agentPr({ isCrossRepository: true })], ["branch", agentPr({ headRefName: "feature/x" })], ["stranger", agentPr({ author: { login: "x" } })], ["unread", agentPr({ isCrossRepository: undefined })]] as const) {
    const { calls, base } = seams();
    const verdict = treeWideGuardVerdict(pr, base);
    assert.equal(verdict.kind, "not-run", why);
    assert.deepEqual(calls, [], `${why}: nothing was checked out, discovered or run`);
  }
  const happy = seams();
  const pass = treeWideGuardVerdict(agentPr(), happy.base);
  assert.deepEqual([pass.kind, pass.head], ["pass", HEAD], "POSITIVE CONTROL: the same fixture, eligible, passes");
  assert.deepEqual(happy.calls, ["checkout", "prepare", "discover", "run", "release"]);
  assert.match(pass.why, /2 tree-wide guard file\(s\) passed at 11111111 \(9 tests\)/);

  const failed = seams({ run: () => ({ ok: false, lines: ["✖ no leak (3ms)", "ℹ fail 1"], ran: 5, timedOut: false }) });
  const fail = treeWideGuardVerdict(agentPr(), failed.base);
  assert.equal(fail.kind, "fail");
  assert.deepEqual(failed.calls.at(-1), "release", "released after a failing run");
  assert.equal(treeWideGuardVerdict(agentPr(), seams({ run: () => ({ ok: false, lines: [], ran: 0, timedOut: true }) }).base).kind, "not-run", "a timeout says nothing");
  const noGuards = seams({ discover: () => [] });
  const none = treeWideGuardVerdict(agentPr(), noGuards.base);
  assert.equal(none.kind, "not-run", "zero guards is not a pass");
  assert.match(none.why, /the floor is 1/);
  assert.ok(!noGuards.calls.includes("run"), "and nothing was run over zero files");
  assert.equal(noGuards.calls.at(-1), "release");
  assert.equal(treeWideGuardVerdict(agentPr(), seams({ checkout: () => { throw new Error("merge ref is stale"); } }).base).kind, "not-run");
  const unprepared = seams({ prepare: () => { throw new Error("offline install failed"); } });
  assert.equal(treeWideGuardVerdict(agentPr(), unprepared.base).kind, "not-run", "a checkout that could not be prepared says nothing about the pull request");
  assert.equal(unprepared.calls.at(-1), "release");
  assert.equal(treeWideGuardVerdict(agentPr(), seams({ discover: () => { throw new Error("git ls-files failed"); } }).base).kind, "not-run");
});

test("(1503 e) two families gate one arming: the first that is not a pass wins, a pass needs every family at ONE head, and no family is no verdict", () => {
  const v = (kind: OrgSideVerdict["kind"], head: string | null, why: string): OrgSideVerdict => ({ kind, head, lines: [], why });
  assert.equal(firstRefusalOf([]), null, "both switched off: the org said nothing");
  assert.equal(firstRefusalOf([v("pass", HEAD, "a")])?.why, "a");
  assert.equal(firstRefusalOf([v("pass", HEAD, "a"), v("fail", HEAD, "g")])?.why, "g", "one family failing refuses");
  assert.equal(firstRefusalOf([v("not-run", HEAD, "n"), v("fail", HEAD, "g")])?.why, "n", "the first refusal is the one named");
  assert.equal(firstRefusalOf([v("pass", HEAD, "a"), v("pass", HEAD, "g")])?.kind, "pass");
  assert.equal(firstRefusalOf([v("pass", HEAD, "a"), v("pass", "2222", "g")])?.kind, "not-run", "passes at two heads are not one pass");
  const gated = acceptanceGateOf([1, 2], { prOf: (n) => ({ headRefOid: HEAD, n }) as any, gateOf: (pr: any) => (pr.n === 1 ? firstRefusalOf([v("pass", HEAD, "a"), v("pass", HEAD, "g")]) : firstRefusalOf([v("pass", HEAD, "a"), v("fail", HEAD, "tree-wide guards FAILED")])) });
  assert.deepEqual(gated.armable, [1]);
  assert.match(gated.withheld[0].why, /tree-wide guards FAILED/);
});

test("(1503 f) the tick: the guards switch is its own; only `on` runs them; and an acceptance pass does not excuse a guard failure", () => {
  const prs = [agentPr({ number: 1 }), agentPr({ number: 2, headRefName: "feature/y" }), agentPr({ number: 3, isCrossRepository: true })];
  const asked: string[] = [];
  const guardsOf = (pr: any): OrgSideVerdict => { asked.push(`g${pr.number}`); return { kind: "fail", head: pr.headRefOid, lines: ["✖ leak"], why: "tree-wide guards FAILED" }; };
  const verdictOf = (pr: any): OrgSideVerdict => { asked.push(`a${pr.number}`); return { kind: "pass", head: pr.headRefOid, lines: [], why: "acceptance passed" }; };
  // the host's own decisions file may carry `outside.acceptance` (a11ign#5613): this pins the env switches, so the outside switches are handed empty
  const common = { openPrs: prs, scope: BASE, declared: DECLARED, verdictOf, guardsOf, log: () => {}, outsideSwitches: () => ({}) };
  assert.deepEqual(gateUnarmedOnAcceptance([1, 2, 3], { ...common, env: {} }), { armable: [1, 2, 3], withheld: [] });
  assert.deepEqual(asked, [], "both off: neither family was asked");
  const only = gateUnarmedOnAcceptance([1, 2, 3], { ...common, env: { [TREE_WIDE_GUARDS_SWITCH_ENV]: "on" } });
  assert.deepEqual(asked, ["g1"], "guards on alone: the eligible agent pull request only, and acceptance not asked");
  assert.deepEqual(only.armable, [2, 3]);
  assert.deepEqual(only.withheld.map((w) => w.number), [1]);
  asked.length = 0;
  const both = gateUnarmedOnAcceptance([1], { ...common, env: { [TREE_WIDE_GUARDS_SWITCH_ENV]: "on", [ACCEPTANCE_GATE_SWITCH_ENV]: "on" } });
  assert.deepEqual(asked, ["a1", "g1"]);
  assert.deepEqual(both.armable, [], "acceptance passed, the guards failed: not armed");
  assert.deepEqual(gateUnarmedOnAcceptance([1], { ...common, env: { [TREE_WIDE_GUARDS_SWITCH_ENV]: "yes" } }).armable, [1], "only the word `on` turns it on");
});

const ON = { [OUTSIDE_GUARDS_FLAG]: true };
const verdictFor = (kind: OrgSideVerdict["kind"]) => { const calls: unknown[] = []; return { calls, verdictOf: (pr: unknown) => { calls.push(pr); return { kind, head: HEAD, lines: [], why: kind } as OrgSideVerdict; } }; };

test("(1580 a) the flag is `outside.guards`, and only a literal true turns it on", () => {
  assert.equal(OUTSIDE_GUARDS_FLAG, "outside.guards");
  assert.equal(outsideGuardsOn({ "outside.guards": true }), true, "POSITIVE CONTROL");
  for (const off of [{}, { "outside.guards": false }, { "outside.guards": "true" }, { "outside.guards": 1 }, { "outside.acceptance": true }, null, undefined]) {
    assert.equal(outsideGuardsOn(off as never), false, JSON.stringify(off));
  }
});

test("(1580 b) OFF the home does nothing: the verdict is never asked for; ON, the same seam is called once", () => {
  for (const switches of [{}, { [OUTSIDE_GUARDS_FLAG]: false }, undefined]) {
    const { calls, verdictOf } = verdictFor("fail");
    assert.deepEqual(shadowGuardsVerdict(agentPr(), { switches, verdictOf }), { on: false });
    assert.equal(calls.length, 0);
  }
  const { calls, verdictOf } = verdictFor("pass");
  assert.equal(shadowGuardsVerdict(agentPr(), { switches: ON, verdictOf }).on, true, "CONTROL");
  assert.equal(calls.length, 1);
});

test("(1580 c) ON is SHADOW: a failing verdict blocks nothing, and is compared with the job's by pass or fail alone", () => {
  const cases: [OrgSideVerdict["kind"], "pass" | "fail" | null, string][] = [["pass", "pass", "agree"], ["fail", "fail", "agree"], ["pass", "fail", "disagree"],
    ["fail", "pass", "disagree"], ["pass", null, "not-compared"], ["not-run", "pass", "not-compared"]];
  for (const [kind, job, agreement] of cases) {
    const shadow = shadowGuardsVerdict(agentPr(), { switches: ON, job, verdictOf: verdictFor(kind).verdictOf });
    assert.ok(shadow.on);
    assert.equal(shadow.blocks, false, "a shadow verdict holds nothing, even a fail");
    assert.equal(shadow.agreement, agreement, `${kind} vs ${job}`);
  }
});

test("(1580 d) the tick: `outside.guards` records a shadow verdict beside the job's and arms exactly as it would without it; off, nothing is asked", () => {
  const prs = [agentPr({ number: 1 }), agentPr({ number: 2, headRefName: "feature/y" })];
  const asked: string[] = [];
  const said: string[] = [];
  const guardsOf = (pr: any): OrgSideVerdict => { asked.push(`g${pr.number}`); return { kind: "fail", head: pr.headRefOid, lines: ["✖ leak"], why: "tree-wide guards FAILED" }; };
  const rollup = (conclusion: string) => [{ name: "guardSweep", conclusion, completedAt: "2026-10-16T10:00:00Z" }, { name: "ts", conclusion: "FAILURE", completedAt: "2026-10-16T10:00:00Z" }];
  const common = { openPrs: prs, scope: BASE, declared: DECLARED, guardsOf, env: {}, log: (line: string) => { said.push(line); } };
  for (const switches of [{}, { [OUTSIDE_GUARDS_FLAG]: false }]) {
    assert.deepEqual(gateUnarmedOnAcceptance([1, 2], { ...common, outsideSwitches: () => switches }), { armable: [1, 2], withheld: [] });
    assert.deepEqual(asked, [], "off: the guards were not asked for");
  }
  const on = gateUnarmedOnAcceptance([1, 2], { ...common, outsideSwitches: () => ON });
  assert.deepEqual(asked, ["g1"], "on: the eligible agent pull request only");
  assert.deepEqual(on, { armable: [1, 2], withheld: [] }, "a failing SHADOW verdict withholds nothing");
  assert.ok(said.some((line) => /outside-guards: SHADOW #1 fail.*beside the job's unread: not-compared/.test(line)), said.join("|"));
  said.length = 0;
  for (const [conclusion, expected] of [["SUCCESS", "pass: disagree"], ["FAILURE", "fail: agree"], ["IN_PROGRESS", "unread: not-compared"]]) {
    gateUnarmedOnAcceptance([1], { ...common, openPrs: [agentPr({ number: 1, statusCheckRollup: rollup(conclusion) })], outsideSwitches: () => ON });
    assert.ok(said.pop()?.includes(`beside the job's ${expected}`), `${conclusion} -> ${expected}`);
  }
});

test("(1580 e) the job's verdict is the `guardSweep` check alone: its conclusion maps to pass/fail, and absence, a pending run or another check's failure is null", () => {
  assert.equal(guardSweepJobOf([{ name: "guardSweep", conclusion: "SUCCESS" }]), "pass", "POSITIVE CONTROL");
  assert.equal(guardSweepJobOf([{ name: "ci / guardSweep", conclusion: "FAILURE" }]), "fail");
  assert.equal(guardSweepJobOf([{ name: "guardSweep", conclusion: "TIMED_OUT" }]), "fail");
  for (const rollup of [[], null, undefined, [{ name: "guardSweep", conclusion: "" }], [{ name: "guardSweep", conclusion: "CANCELLED" }], [{ name: "ts", conclusion: "SUCCESS" }], [{ name: "notguardSweep", conclusion: "SUCCESS" }]]) {
    assert.equal(guardSweepJobOf(rollup as never), null, JSON.stringify(rollup));
  }
});
