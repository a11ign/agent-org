// no-token: DeclarationReading -- every input that reaches the verdict is injected (`eligible`, `facts`, `outsideSwitches`), so no declaration is read and no gh call runs
// agent-org#1598 (the epic "agent-org stands alone", a11ign#928; a11ign#5549): the outside home of a project's `ownedPaths` job. Each test names its positive control: a shadow verdict that
// blocks nothing, or an outside pull request that meets no request, proves nothing unless the same fixture, made an agent's, is asked and refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTSIDE_OWNED_PATHS_FLAG, loadFacts, outsideOwnedPathsOn, ownedPathsJobOf, ownedPathsVerdict, shadowOwnedPathsVerdict } from "./owned-path-signoff.ts";
import { orgSideAcceptanceEligibility, type OrgSideVerdict } from "./acceptance-commands.ts";
import { gateUnarmedOnAcceptance } from "./work-gate/tick/blocker-cleared-reading.ts";

const HEAD = "2222222222222222222222222222222222222222";
const BASE = "a11ign/a11ign";
const DECLARED = { exact: ["a11ign-worker[bot]"], pattern: [] as RegExp[] };
const FACTS = { owned: ["packages/owned/", "packages/one-file.ts"], facts: [{ id: "alpha", states: ["unchanged", "bumped"] }, { id: "beta", states: ["unchanged", "moved"] }] };
const SIGNED_BODY = "alpha: unchanged\nbeta: unchanged\n";
const files = (...paths: string[]) => paths.map((path) => ({ path }));
const agentPr = (over: Record<string, unknown> = {}) => ({ number: 7, headRefName: "agent/some-row-1598", headRefOid: HEAD, isCrossRepository: false, body: "no sign-off here",
  headRepository: { nameWithOwner: BASE }, author: { login: "a11ign-worker[bot]" }, files: files("packages/owned/x.ts"), changedFiles: 1, ...over });
const forkPr = (over: Record<string, unknown> = {}) => agentPr({ isCrossRepository: true, headRefName: "feature/y", author: { login: "someone" }, ...over });
const eligible = (pr: any) => orgSideAcceptanceEligibility(pr, { byDeclaredIdentity: (p) => (p.author as any)?.login === "a11ign-worker[bot]", baseRepo: BASE });
const verdict = (pr: any) => ownedPathsVerdict(pr, { eligible, facts: () => FACTS });
const ON = { [OUTSIDE_OWNED_PATHS_FLAG]: true };

test("(1598 a) the flag is `outside.ownedPaths`, and only a literal true turns it on: absent, false and every other value are off", () => {
  assert.equal(OUTSIDE_OWNED_PATHS_FLAG, "outside.ownedPaths");
  assert.equal(outsideOwnedPathsOn(ON), true, "POSITIVE CONTROL");
  for (const off of [{}, { [OUTSIDE_OWNED_PATHS_FLAG]: false }, { [OUTSIDE_OWNED_PATHS_FLAG]: "true" }, { [OUTSIDE_OWNED_PATHS_FLAG]: 1 }, { "outside.guards": true }, null, undefined]) {
    assert.equal(outsideOwnedPathsOn(off as never), false, JSON.stringify(off));
  }
});

test("(1598 b) an agent pull request over an owned path: refused with no sign-off, passed with one, passed over an unowned path, and every state is the job's own", () => {
  const refused = verdict(agentPr());
  assert.equal(refused.kind, "fail", "POSITIVE CONTROL: the request is made and refused");
  assert.match(refused.lines.join("\n"), /alpha[\s\S]*beta/, "names the unstated facts");
  assert.equal(verdict(agentPr({ body: SIGNED_BODY })).kind, "pass");
  assert.equal(verdict(agentPr({ files: files("README.md", "packages/owned-notes/x.ts") })).kind, "pass", "no owned path is touched (a sibling directory is not owned)");
  assert.equal(verdict(agentPr({ files: files("packages/one-file.ts"), body: "alpha: unchanged\nbeta: moved\n" })).kind, "pass", "a bare file path is owned");
  assert.equal(verdict(agentPr({ body: "alpha: unchanged\nalpha: bumped\nbeta: unchanged\n" })).kind, "fail", "contradicting states are refused");
});

test("(1598 c) what could not be asked is not-run, never a pass: facts unreadable, a cut-short file list, an unread body or file list", () => {
  assert.equal(ownedPathsVerdict(agentPr(), { eligible, facts: () => null }).kind, "not-run");
  assert.equal(verdict(agentPr({ changedFiles: 250 })).kind, "not-run", "100 of 250 files is not the diff");
  assert.match(verdict(agentPr({ changedFiles: 250 })).why, /cut short/);
  for (const over of [{ body: null }, { body: undefined }, { files: undefined }, { files: [{ name: "x" }] }, { changedFiles: undefined }, { headRefOid: "" }]) {
    assert.equal(verdict(agentPr(over)).kind, "not-run", JSON.stringify(over));
  }
});

test("(1598 d) an OUTSIDE pull request over an owned path meets no sign-off request: not-run before the facts are read, and no refusal lines to show it", () => {
  let factsRead = 0;
  const outside = ownedPathsVerdict(forkPr(), { eligible, facts: () => { factsRead++; return FACTS; } });
  assert.equal(outside.kind, "not-run");
  assert.deepEqual(outside.lines, [], "no 'its body does not state' request");
  assert.equal(factsRead, 0, "the facts file was not even read");
  assert.match(outside.why, /fork/);
  for (const over of [{ headRefName: "feature/y" }, { author: { login: "someone" } }]) {
    assert.equal(ownedPathsVerdict(agentPr(over), { eligible, facts: () => FACTS }).kind, "not-run", `${JSON.stringify(over)} is not an agent pull request`);
  }
  assert.equal(verdict(agentPr()).kind, "fail", "POSITIVE CONTROL: the same files and body, as an agent's, are refused");
});

test("(1598 e) the shadow records agree / disagree / not-compared against the job's verdict and BLOCKS NOTHING, even on a fail; off, nothing is asked", () => {
  const verdictFor = (kind: OrgSideVerdict["kind"]) => () => ({ kind, head: HEAD, lines: [], why: "x" }) as OrgSideVerdict;
  let asked = 0;
  for (const switches of [{}, { [OUTSIDE_OWNED_PATHS_FLAG]: false }]) {
    assert.deepEqual(shadowOwnedPathsVerdict(agentPr(), { switches, job: "pass", verdictOf: () => { asked++; return verdictFor("pass")(); } }), { on: false });
  }
  assert.equal(asked, 0, "off: the verdict was not asked for");
  const cases: [OrgSideVerdict["kind"], "pass" | "fail" | null, string][] = [["pass", "pass", "agree"], ["fail", "fail", "agree"], ["fail", "pass", "disagree"], ["pass", "fail", "disagree"],
    ["fail", null, "not-compared"], ["not-run", "pass", "not-compared"]];
  for (const [kind, job, agreement] of cases) {
    const shadow = shadowOwnedPathsVerdict(agentPr(), { switches: ON, job, verdictOf: verdictFor(kind) });
    assert.ok(shadow.on);
    assert.equal(shadow.blocks, false, "a shadow verdict holds nothing, even a fail");
    assert.equal(shadow.agreement, agreement, `${kind} vs ${job}`);
  }
});

test("(1598 f) the job's verdict is the `ownedPaths` check alone: its conclusion maps to pass/fail, and absence, a skip or another check's failure is null", () => {
  assert.equal(ownedPathsJobOf([{ name: "ownedPaths", conclusion: "SUCCESS" }]), "pass", "POSITIVE CONTROL");
  assert.equal(ownedPathsJobOf([{ name: "ci / ownedPaths", conclusion: "FAILURE" }]), "fail");
  for (const rollup of [[], null, undefined, [{ name: "ownedPaths", conclusion: "" }], [{ name: "ownedPaths", conclusion: "SKIPPED" }], [{ name: "ownedPaths", conclusion: "CANCELLED" }],
    [{ name: "ts", conclusion: "SUCCESS" }], [{ name: "notownedPaths", conclusion: "SUCCESS" }]]) {
    assert.equal(ownedPathsJobOf(rollup as never), null, JSON.stringify(rollup));
  }
});

test("(1598 g) the tick: `outside.ownedPaths` records a shadow verdict beside the job's for the agent pull request only, withholds nothing, and arms exactly as it would without it", () => {
  // the verdict's kind over the fixture's owned path depends on the project's real facts file (the tick reads it), so the first record asserts only its shape; the last asserts a pass over an unowned path
  const real = loadFacts();
  const prs = [agentPr({ number: 1 }), forkPr({ number: 2 })];
  const said: string[] = [];
  const common = { openPrs: prs, scope: BASE, declared: DECLARED, env: {}, log: (line: string) => { said.push(line); } };
  for (const switches of [{}, { [OUTSIDE_OWNED_PATHS_FLAG]: false }]) {
    assert.deepEqual(gateUnarmedOnAcceptance([1, 2], { ...common, outsideSwitches: () => switches }), { armable: [1, 2], withheld: [] });
    assert.deepEqual(said, [], "off: nothing is recorded");
  }
  const on = gateUnarmedOnAcceptance([1, 2], { ...common, outsideSwitches: () => ON });
  assert.deepEqual(on, { armable: [1, 2], withheld: [] }, "a SHADOW verdict withholds nothing, whatever it is");
  assert.equal(said.length, 1, said.join("|"));
  assert.match(said[0], /outside-ownedpaths: SHADOW #1 (pass|fail|not-run) .*beside the job's unread: not-compared; blocks nothing\./);
  assert.ok(!said.some((line) => /#2/.test(line)), "the outside pull request meets no sign-off request, and no record is made of it");
  said.length = 0;
  const rollup = (conclusion: string) => [{ name: "ownedPaths", conclusion, completedAt: "2026-10-16T10:00:00Z" }];
  gateUnarmedOnAcceptance([1], { ...common, openPrs: [agentPr({ number: 1, files: files("README.md"), statusCheckRollup: rollup("SUCCESS") })], outsideSwitches: () => ON });
  if (real !== null) assert.match(said.pop() ?? "", /SHADOW #1 pass .*beside the job's pass: agree/, "an unowned path passes, as the job does");
});

test("(1598 h) the coverage: every path the project's facts file owns is refused for an unsigned agent pull request, so the home covers what the job covers", () => {
  const real = loadFacts();
  if (real === null) { assert.ok(true, "SKIPPED: no docs/owned-path-facts.json at the home checkout, so there is no list to compare (an honest skip, not a pass)"); return; }
  assert.ok(real.owned.length > 0, "the list is not empty (a loop over nothing proves nothing)");
  for (const path of real.owned) {
    const file = path.endsWith("/") ? `${path}x.ts` : path;
    assert.equal(ownedPathsVerdict(agentPr({ files: files(file) }), { eligible }).kind, "fail", `${path} is covered`);
  }
});
