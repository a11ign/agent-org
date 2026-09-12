/**
 * `mergeReadiness` AND `mergeSafetyVerdict` -- THE COMPOSITIONS, not the rules.
 *
 * #455 split each individual refusal rule into its own module under `scripts/merge-guard/`, each with its
 * own direct test (`merge-guard-base-rule.test.ts`, `-head-tip-rule`, `-checks-rule`, `-staleness-rule`,
 * `-ancestry-rule`, `-claimed-row-rule`, `-pr-hold-rule`, plus the shared `-reason-kind`, `-lookups` and
 * `-reconciliation` modules). What belongs HERE is what a single rule's own test cannot show: that the
 * ENTRY POINT actually composes all eight into one verdict, that two rules combine correctly rather than
 * one masking the other, and the two properties that are facts about the composed file rather than about
 * any one rule -- it never reads `mergeStateStatus`, and its ancestry fetch is correctly oriented.
 *
 * "Rules in one file are not read together; rules in separate files with separate tests are at least
 * separable" is the plan's own reasoning for the split (#455) -- these tests are what proves separable
 * did not become "never composed at all".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { mergeReadiness, mergeSafetyVerdict } from "../../../../scripts/merge-guard.mjs";
import { reasonKind } from "../../../../scripts/merge-guard/reason-kind.mjs";
import { LIVE_SHAPE } from "./check-run-fixtures.ts";

const REQUIRED = ["changed", "ts", "python", "ansible", "docs", "changeset"];
const MAIN_TIP = "2026-09-07T00:41:07Z";
const AFTER = "2026-09-07T00:45:35Z";
const BEFORE = "2026-09-07T00:08:02Z";

const HEAD = "d5c2436601abcdef";
const pr = (over: object = {}) => ({
  number: 148, state: "OPEN", baseRefName: "main", headRefOid: HEAD, ...over,
});
// `branchTip: HEAD` on every fixture below that is not itself testing #294 -- otherwise every one of
// them would trip the head/tip-mismatch reason, since `pr()`'s `headRefOid` and a real branch tip are two
// different facts that must be asked to agree.
const green = (at = AFTER) => REQUIRED.map((name) => ({
  name, status: "completed", conclusion: name === "ts" ? "success" : "skipped", completedAt: at,
}));

test("THE #148 CASE, COMPOSED: a base that is not main, and not one check run — both named, from two rules", () => {
  const v = mergeReadiness({
    pr: pr({ baseRefName: "lead/real-page-outcome-is-stated" }),
    required: REQUIRED, runs: [], mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: HEAD,
  });
  assert.equal(v.code, 1);
  assert.equal(v.reasons.length, 2, "two independent causes from two rule modules, two sentences");
  assert.match(v.reasons[0], /BASE IS NOT main/);
  assert.match(v.reasons[1], /NO CHECK RUNS EXIST/);
});

test("A GENUINELY GREEN PR AGAINST main IS ACCEPTED — so composing eight rules is not simply always-red", () => {
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: HEAD });
  assert.equal(v.code, 0, `expected READY, got: ${v.reasons.join(" | ")}`);
  assert.deepEqual(v.reasons, []);
});

test("`[]` AND `null` ARE DIFFERENT ANSWERS, and this is the sharpest case in the file", () => {
  // "nothing ran" and "I could not ask" demand opposite responses. A lookup that fell through to an empty
  // array would report the safest-looking verdict for the least examined PR -- this repo's oldest defect.
  const nothingRan = mergeReadiness({ pr: pr(), required: REQUIRED, runs: [], mainTipIso: MAIN_TIP,
    behindBy: 0, branchTip: HEAD });
  assert.equal(nothingRan.code, 1, "an empty list is a FINDING");

  const couldNotAsk = mergeReadiness({ pr: pr(), required: REQUIRED, runs: null, mainTipIso: MAIN_TIP,
    behindBy: 0, branchTip: HEAD });
  assert.equal(couldNotAsk.code, 2, "a failed lookup is INCONCLUSIVE, and must never be either 0 or 1");
  assert.match(couldNotAsk.reasons[0], /CANNOT SAY/);
  assert.match(couldNotAsk.reasons[0], /check runs for head d5c2436601/, "it names WHICH lookup failed");
});

test("every failed lookup is inconclusive, and all of them are named at once", () => {
  const v = mergeReadiness({ pr: pr(), required: null, runs: null, mainTipIso: null, behindBy: null,
    branchTip: null });
  assert.equal(v.code, 2);
  for (const expected of [/branch protection/, /check runs/, /tip of `main`/, /branch's real tip/]) {
    assert.match(v.reasons[0], expected, "one round trip should tell you everything that is missing");
  }
});

test("the two staleness faults stay separable when composed -- neither rule masks the other", () => {
  // `behindBy: 0` with old runs is the #135 shape and must still print the timestamps.
  const oldRuns = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green(BEFORE), mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: HEAD,
  });
  assert.match(oldRuns.reasons.join("\n"), /PREDATES/);
  assert.doesNotMatch(oldRuns.reasons.join("\n"), /DOES NOT CONTAIN/);

  // AND THE THIRD CASE, WHICH IS THE WORST TO NOTICE: right answer, unsound method, both rules firing.
  //
  // #137, measured 2026-09-07 and used here as the fixture rather than invented numbers: newest run
  // 01:38:32Z against a `main` tipped 01:38:39Z, and `behind_by` 1. The clock refused it correctly on a
  // SEVEN-SECOND margin -- a gap that decided a question about commit containment and happened to land on
  // the right side.
  const both = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green("2026-09-07T01:38:32Z"),
    mainTipIso: "2026-09-07T01:38:39Z", behindBy: 1,
    branchTip: HEAD,
  });
  assert.equal(both.reasons.length, 2, "two faults, two sentences, from two different rule modules");
  assert.match(both.reasons[0], /DOES NOT CONTAIN main's TIP — it is 1 commit\(s\) behind/,
    "the ancestry reason is the load-bearing one here; the timestamp reason is right by seven seconds");
});

test("THE REAL #165 INCIDENT, COMPOSED AT FULL FIDELITY: today's guard refuses it, by ancestry alone", () => {
  // Re-derived from immutable sources (#182's own account) rather than replayed live -- #165's branch is
  // deleted and `main` has moved many times since. Every value below was read once.
  const v = mergeReadiness({
    pr: { number: 165, state: "OPEN", baseRefName: "main",
      headRefOid: "56c34b683e550155816872dedd2364e4d397aedb" },
    required: ["gate", "ts", "changed"],
    runs: [
      { name: "gate", status: "completed", conclusion: "success", completedAt: "2026-09-07T01:32:56Z" },
      { name: "changeset", status: "completed", conclusion: "skipped", completedAt: "2026-09-07T01:27:56Z" },
      { name: "docs", status: "completed", conclusion: "skipped", completedAt: "2026-09-07T01:27:56Z" },
      { name: "python", status: "completed", conclusion: "skipped", completedAt: "2026-09-07T01:27:56Z" },
      { name: "ansible", status: "completed", conclusion: "skipped", completedAt: "2026-09-07T01:27:56Z" },
      { name: "ts", status: "completed", conclusion: "success", completedAt: "2026-09-07T01:32:51Z" },
      { name: "changed", status: "completed", conclusion: "success", completedAt: "2026-09-07T01:27:56Z" },
    ],
    mainTipIso: "2026-09-07T01:31:03Z",
    behindBy: 2,
    branchTip: "56c34b683e550155816872dedd2364e4d397aedb",
  });
  assert.equal(v.code, 1, "before #182 this was the exact case that returned 0");
  assert.equal(v.reasons.length, 1, "the runs are genuinely newer than the tip; only ancestry fires");
  assert.match(v.reasons[0], /DOES NOT CONTAIN main's TIP — it is 2 commit\(s\) behind/);
});

test("THE REAL #195 INCIDENT, COMPOSED: GitHub's recorded head is the branch tip's PARENT, isolated from every other rule", () => {
  const v = mergeReadiness({
    pr: { number: 195, state: "OPEN", baseRefName: "main", headRefOid: "ac306fe9" },
    required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: "7c2e16fc",
  });
  assert.equal(v.code, 1, "green checks on the wrong commit must not read as READY");
  assert.equal(v.reasons.length, 1, "nothing else is wrong here -- isolate the one real fault");
  assert.match(v.reasons[0], /GITHUB'S HEAD IS NOT THE BRANCH TIP/);
});

test("a head/tip mismatch is NOT collapsed into the ancestry reason when both compose -- opposite remedies", () => {
  const v = mergeReadiness({
    pr: { number: 195, state: "OPEN", baseRefName: "main", headRefOid: "ac306fe9" },
    required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 2,
    branchTip: "7c2e16fc",
  });
  assert.equal(v.reasons.length, 2, "ancestry and tip-mismatch are independent faults");
  assert.match(v.reasons.join("\n"), /GITHUB'S HEAD IS NOT THE BRANCH TIP/);
  assert.match(v.reasons.join("\n"), /DOES NOT CONTAIN main's TIP/);
});

test("a FAILED branch-tip lookup is CANNOT_ASK, never READY -- null and equal are different answers", () => {
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: null });
  assert.equal(v.code, 2, "a failed `git ls-remote` must not fall through to 'no mismatch found'");
});

test("a PR that is not open is annotated rather than silently judged as if it were", () => {
  const v = mergeReadiness({ pr: pr({ state: "MERGED" }), required: REQUIRED, runs: green(),
    mainTipIso: MAIN_TIP, behindBy: 0, branchTip: HEAD });
  assert.match(v.notes.join("\n"), /MERGED, so this is a post-mortem/);
});

/**
 * #249 AND #266, COMPOSED TOGETHER: a claimed row this PR would close, and a hold on the PR ITSELF, are
 * two independent rules over two independent label sources -- a row's labels, and the PR's own. Each
 * rule's own test file drives its full state space; this proves the composition keeps them apart.
 */
const HELD_BASE = { pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
  branchTip: HEAD };
const CLOSES_CLAIMED = [{ number: 237, title: "example row", labels: ["in-progress", "session:worker-judge", "started"] }];

test("the composed baseline is READY before either #249 or #266 fires -- or the refusals below prove nothing", () => {
  const v = mergeReadiness({ ...HELD_BASE, prLabels: [], closes: [], session: "worker-capture" });
  assert.equal(v.code, 0, `the baseline must be READY, got: ${v.reasons.join(" | ")}`);
});

test("#249 and #266 fire independently when composed, and stay two sentences", () => {
  // `hold:` since 2026-09-09: `session:` on a PR is OWNERSHIP and no longer a hold. The row in
  // CLOSES_CLAIMED still carries `session:worker-judge` deliberately -- a ROW's claim vocabulary is
  // unchanged, and this test composing both is what proves the two are read by different predicates.
  const v = mergeReadiness({ ...HELD_BASE, prLabels: ["hold:dispatcher"], closes: CLOSES_CLAIMED,
    session: "worker-capture" });
  assert.equal(v.code, 1);
  assert.equal(v.reasons.length, 2, "a held PR AND a claimed row it would close are two independent faults");
  assert.equal(reasonKind(v.reasons.find((r) => /WOULD CLOSE/.test(r)) ?? ""), "CLAIMED_BY_ANOTHER_SESSION");
});

test("a FAILED closes lookup is CANNOT_ASK even when the PR is otherwise green", () => {
  const v = mergeReadiness({ ...HELD_BASE, prLabels: [], closes: null, session: "dispatcher" });
  assert.equal(v.code, 2);
  assert.match(v.reasons[0], /which rows this PR would close/);
});

test("a FAILED prLabels lookup is CANNOT_ASK, never READY", () => {
  const v = mergeReadiness({ ...HELD_BASE, prLabels: null, closes: [], session: "worker-capture" });
  assert.equal(v.code, 2);
  assert.match(v.reasons[0], /could not read this PR's own labels/);
});

/**
 * #298 (unit 1): `mergeSafetyVerdict` is the narrower, self-reference-safe composition a required CI job
 * runs mid-workflow -- head-vs-tip (#294) ONLY. Ancestry (#182) and the claimed-row rule (#262) are
 * DELIBERATELY not composed in here, and these are the regressions this file exists to pin: `dispatcher`
 * drove an earlier version of this function (which did include both) against the real, moving PR queue
 * and measured it refusing the NORMAL case on both counts.
 */
test("mergeSafetyVerdict: READY when head-vs-tip is clean", () => {
  const v = mergeSafetyVerdict({ pr: pr(), branchTip: HEAD });
  assert.equal(v.code, 0, `expected READY, got: ${v.reasons.join(" | ")}`);
});

test("mergeSafetyVerdict: refuses on the #294 shape, same reason mergeReadiness would give", () => {
  const v = mergeSafetyVerdict({ pr: pr({ headRefOid: "ac306fe9" }), branchTip: "7c2e16fc" });
  assert.equal(v.code, 1);
  assert.equal(reasonKind(v.reasons[0]), "HEAD_MISMATCH");
});

test("MUTATION target: mergeSafetyVerdict is CANNOT_ASK, never READY, when branchTip is null", () => {
  const v = mergeSafetyVerdict({ pr: pr(), branchTip: null });
  assert.equal(v.code, 2, `expected CANNOT_ASK, got code ${v.code}: ${v.reasons.join(" | ")}`);
  assert.match(v.reasons[0], /git ls-remote/);
});

test("mergeSafetyVerdict: THE #182 REGRESSION -- a PR far behind main is still READY, ancestry is CLI advice, never a CI refusal", () => {
  // The shape `dispatcher` measured live: 13 of 13 open PRs behind `main` at once, with merges landing
  // roughly one a minute. `mergeSafetyVerdict` does not even ask for `behindBy` -- there is no argument
  // here that could smuggle ancestry back in by accident.
  const v = mergeSafetyVerdict({ pr: pr(), branchTip: HEAD });
  assert.equal(v.code, 0);
  assert.deepEqual(Object.keys(v).sort(), ["code", "reasons"].sort());
});

test("mergeSafetyVerdict: THE #262 REGRESSION -- closing a row THIS PR's own author claimed is still READY", () => {
  // `dispatcher` measured 10 of 13 open PRs closing a row their own author held -- the ordinary
  // worker-owned shape. `mergeSafetyVerdict` takes no `closes`/`session` at all, so this cannot regress
  // by someone quietly wiring the claim check back in with `session: null`.
  const v = mergeSafetyVerdict({ pr: pr(), branchTip: HEAD });
  assert.equal(v.code, 0, "a PR closing its own claimed row must never be refused by the CI gate");
});

/**
 * AND THE ONE THAT MATTERS MOST: the composed file must not consult the field it exists to distrust.
 *
 * `mergeStateStatus` is what reported #148 as the greenest PR on the board. A guard that read it would
 * share a failure mode with the thing it is checking. Asserted against source, because no behavioural
 * test can see a field being consulted "just to cross-check" -- and now that the rules live in eight
 * separate files, EVERY one of them is scanned, not just the entry point.
 */
test("no file in the merge-guard tree reads mergeStateStatus, not even to cross-check", () => {
  const files = [
    "../../../../scripts/merge-guard.mjs",
    "../../../../scripts/merge-guard/base-rule.mjs",
    "../../../../scripts/merge-guard/head-tip-rule.mjs",
    "../../../../scripts/merge-guard/checks-rule.mjs",
    "../../../../scripts/merge-guard/staleness-rule.mjs",
    "../../../../scripts/merge-guard/ancestry-rule.mjs",
    "../../../../scripts/merge-guard/claimed-row-rule.mjs",
    "../../../../scripts/merge-guard/pr-hold-rule.mjs",
    "../../../../scripts/merge-guard/armed-race-rule.mjs",
    "../../../../scripts/merge-guard/lookups.mjs",
    "../../../../scripts/merge-guard/reconciliation.mjs",
  ];
  for (const file of files) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    const code = src.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    // TARGETS THE READ, NOT THE WORD -- a guard that forbids NAMING the hazard makes the hazard harder to
    // document, which is the opposite of the point. The two patterns below are the only ways any of these
    // files could actually consult it: ask GitHub for the field, or read it off an object.
    assert.doesNotMatch(code, /--json[^\n]*mergeStateStatus/,
      `${file}: requesting the field at all invites the next reader to use it`);
    assert.doesNotMatch(code, /\.mergeStateStatus\b/,
      `${file}: reading it -- even alongside the real check -- reintroduces the failure mode this tool `
      + "exists to avoid");
  }
});

/**
 * THE ORIENTATION SEAM (#188): every `behindBy` in this file's own fixtures above is INJECTED, so a
 * reversed `compare/<head>...main` in either real fetch would leave every one of them green while
 * production read the wrong number. There are now TWO live call sites -- `merge-guard.mjs`'s own
 * `facts()` (the ancestry rule's input) and `armed-race-rule.mjs`'s `lookupArmedPrStatus` (#442's
 * behind-by check) -- and #455's split makes it possible for one to be fixed and the other missed, so
 * both are scanned rather than trusting that fixing one fixes both.
 */
test("both real behindBy fetches are oriented main...head, never the reverse (#188)", () => {
  for (const file of ["../../../../scripts/merge-guard.mjs", "../../../../scripts/merge-guard/armed-race-rule.mjs"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /compare\/main\.\.\.\$\{pr\.headRefOid\}/,
      `${file}: must ask GitHub how far main is ahead of this head, not the reverse`);
    assert.doesNotMatch(src, /compare\/\$\{pr\.headRefOid\}\.\.\.main/,
      `${file}: the reversed orientation returns a different, equally plausible-looking number for the `
      + "same pair");
  }
});

// #1009: the waiting case AT THE MERGE PATH. `LIVE_SHAPE` is #1008's head at 23:3xZ, imported rather
// than retyped -- see `merge-guard-checks-rule.test.ts` for the population and why it lives there.
/** `mergeReadiness`'s other inputs, all benign, so only the check-run population is under test. */
const readinessInputs = {
  pr: { number: 1, state: "open", baseRefName: "main", headRefOid: "d5c2436601abcdef" },
  required: ["gate"], mainTipIso: "2026-09-12T00:00:00Z", behindBy: 0,
  branchTip: "d5c2436601abcdef", closes: [], prLabels: [], session: null,
};

test("#1009 CONSUMER: `merge-guard` renders the waiting case as a wait, not an absence", () => {
  const waiting = mergeReadiness({ ...readinessInputs, runs: LIVE_SHAPE });
  const joined = waiting.reasons.join("\n");
  assert.doesNotMatch(joined, /NEVER RAN/,
    `the merge path still reports an absence: ${JSON.stringify(waiting.reasons)}`);
  assert.match(joined, /STILL RUNNING:.*\bgate\b/, "it must name the context it is waiting on");

  // AND IT STILL REFUSES. A wait is not a pass: merging while the one required context has reached no
  // verdict is the thing the guard exists to stop, and #1007 makes the same point one case over.
  assert.notEqual(waiting.code, 0, "a wait must not become a merge");
});

