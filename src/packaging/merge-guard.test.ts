/**
 * A PR THAT HAS NEVER RUN A CHECK READS AS `CLEAN`, AND A STALE RUN READS AS A CURRENT ONE (#161).
 *
 * Measured 2026-09-07. PR #148's base was another open PR's branch rather than `main`; `ci.yml` triggers
 * on `pull_request: branches: [main]`, so no workflow ever ran and the branch protection covering `main`
 * applied to nothing:
 *
 *     #148  CLEAN/MERGEABLE   check-runs: []   182 insertions into check-real-page-findings.ts
 *
 * `CLEAN/MERGEABLE` is the CORRECT answer to the question GitHub was asked, which is what makes it
 * dangerous — a required context that never ran is not a failing check, it is NO check, and the field
 * cannot express the difference. It was caught by a human noticing the list was EMPTY rather than green.
 *
 * TWO SHAPES, NEEDING OPPOSITE FIXES, and conflating them is how the first draft of the finding went
 * wrong: an empty check-run list means nothing has ever tested this, while runs WITH conclusions against
 * a base that has since moved are real results that look like evidence. The tests below drive both, plus
 * the third state this repo cares about most — "I could not ask", which must never read as either.
 *
 * DRIVEN AGAINST THE PURE VERDICT. The staleness case is the one no fixture gives for free, and the
 * lookup-failure cases cannot be produced on demand against a live API at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  mergeReadiness, reasonKind, recordVerdict, latestVerdictFor, realOutcomeFor, reconcile, lookupBranchTip,
  mergeSafetyVerdict, claimedCloseCoveredBy,
} from "../../../../scripts/merge-guard.mjs";

const REQUIRED = ["changed", "ts", "python", "ansible", "docs", "changeset"];
const MAIN_TIP = "2026-09-07T00:41:07Z";
const AFTER = "2026-09-07T00:45:35Z";
const BEFORE = "2026-09-07T00:08:02Z";

const HEAD = "d5c2436601abcdef";
const pr = (over: object = {}) => ({
  number: 148, state: "OPEN", baseRefName: "main", headRefOid: HEAD, ...over,
});
// `branchTip: HEAD` on every fixture below that is not itself testing #294 -- otherwise every one of
// them would trip the new head/tip-mismatch reason, since `pr()`'s `headRefOid` and a real branch tip
// are now two different facts that must be asked to agree.
const green = (at = AFTER) => REQUIRED.map((name) => ({
  name, status: "completed", conclusion: name === "ts" ? "success" : "skipped", completedAt: at,
}));

test("THE #148 CASE: a base that is not main, and not one check run — both named", () => {
  const v = mergeReadiness({
    pr: pr({ baseRefName: "lead/real-page-outcome-is-stated" }),
    required: REQUIRED, runs: [], mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: HEAD,
  });
  assert.equal(v.code, 1);
  assert.equal(v.reasons.length, 2, "two independent causes, two sentences -- they need different fixes");
  assert.match(v.reasons[0], /BASE IS NOT main/);
  assert.match(v.reasons[0], /branches: \[main\]/, "it must say WHY a non-main base runs nothing");
  assert.match(v.reasons[1], /NO CHECK RUNS EXIST/);
  assert.match(v.reasons[1], /never ran is not a failing check/,
    "the message must name the distinction the field cannot express");
});

test("A GENUINELY GREEN PR AGAINST main IS ACCEPTED — so this is not simply always-red", () => {
  // The half that stops a guard being deleted in a week. `skipped` is a path filter declining to run a
  // job, which is how this repo's own required contexts report on most PRs -- treating it as a failure
  // would refuse every correct PR in the tree.
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: HEAD });
  assert.equal(v.code, 0, `expected READY, got: ${v.reasons.join(" | ")}`);
  assert.deepEqual(v.reasons, []);
});

test("THE STALE SHAPE: real runs, real conclusions, against a base that has moved", () => {
  // The dangerous one, because the runs look like evidence. Measured on #135: newest run 00:08:02Z
  // against a main tipped 00:41:07Z.
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs: green(BEFORE), mainTipIso: MAIN_TIP,
    behindBy: 0, branchTip: HEAD });
  assert.equal(v.code, 1);
  assert.equal(v.reasons.length, 1);
  assert.match(v.reasons[0], /EVERY RUN PREDATES THE CURRENT main/);
  assert.match(v.reasons[0], new RegExp(`${BEFORE}.*${MAIN_TIP}`, "s"),
    "both timestamps, or the reader cannot tell how stale");
  assert.doesNotMatch(v.reasons[0], /NO CHECK RUNS/,
    "this is the OTHER cause; reporting the empty-list sentence here would send somebody to the wrong fix");
});

test("A REQUIRED CONTEXT THAT NEVER RAN is distinct from an empty list and from a failure", () => {
  const runs = green().filter((run) => run.name !== "changeset");
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs, mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: HEAD });
  assert.equal(v.code, 1);
  assert.match(v.reasons[0], /REQUIRED CONTEXT NEVER RAN: changeset/);
  assert.match(v.reasons[0], /Present-and-failing and never-ran are different states/);
});

test("a failing context and a still-running one are separate sentences", () => {
  const failing = green().map((r) => (r.name === "ts" ? { ...r, conclusion: "failure" } : r));
  assert.match(mergeReadiness({ pr: pr(), required: REQUIRED, runs: failing, mainTipIso: MAIN_TIP,
    behindBy: 0, branchTip: HEAD }).reasons.join("\n"), /FAILING: ts \(failure\)/);

  const running = green().map((r) => (r.name === "ts"
    ? { ...r, status: "in_progress", conclusion: null, completedAt: null } : r));
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs: running, mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: HEAD });
  assert.equal(v.code, 1);
  assert.match(v.reasons.join("\n"), /STILL RUNNING: ts/);
  assert.match(v.reasons.join("\n"), /ask again/, "in-flight is not a defect and must not read as one");
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
  // `branchTip` (#294) is the fifth lookup, added after this test was written -- included here rather
  // than left green with a passing default, since the test's own name is "all of them are named at once".
  for (const expected of [/branch protection/, /check runs/, /tip of `main`/, /branch's real tip/]) {
    assert.match(v.reasons[0], expected, "one round trip should tell you everything that is missing");
  }
});

/**
 * NEWER IN TIME, OLDER IN HISTORY — the false PASS this guard shipped with (#182).
 *
 * The staleness check compared the newest run's completion time against `main`'s tip commit DATE, as a
 * proxy for *"was this head ever tested alongside the code it is about to join"*. **A run can finish
 * AFTER `main`'s tip was committed while the branch still does not contain that commit**, which is what
 * ordinary concurrent merging produces. Measured on #165: `main` tipped 01:31:03Z, the run finished
 * later, the branch had never seen that commit, and this tool printed *"run against the current main"*
 * and exited 0. Only strict branch protection stopped it — a guard whose wrong answers are absorbed by
 * something else is one whose wrongness is invisible.
 *
 * This is the case that cannot be reproduced from live PRs once `main` moves again, because both reasons
 * then fire together. Driven from fixtures for exactly that reason.
 */
test("THE FALSE PASS: runs NEWER than main's tip, on a head that does not contain it", () => {
  const v = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green(AFTER), mainTipIso: MAIN_TIP, behindBy: 2,
    branchTip: HEAD,
  });
  assert.equal(v.code, 1, "before #182 this returned 0 — the clock said fresh, the graph said behind");
  assert.equal(v.reasons.length, 1, "ONLY the ancestry reason: the runs really are newer than the tip");
  assert.match(v.reasons[0], /DOES NOT CONTAIN main's TIP — it is 2 commit\(s\) behind/);
  assert.match(v.reasons[0], /may be minutes fresh/,
    "the message must say why a recent run does not settle it, or the reader re-runs CI and tries again");
  assert.doesNotMatch(v.reasons[0], /PREDATES/,
    "these are different faults: the runs are old, versus the TREE is old. Collapsing them loses the "
    + "diagnosis the original check was built for");
});

test("the two staleness faults stay separable, and a contained head raises neither", () => {
  // `behindBy: 0` with old runs is the #135 shape and must still print the timestamps.
  const oldRuns = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green(BEFORE), mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: HEAD,
  });
  assert.match(oldRuns.reasons.join("\n"), /PREDATES/);
  assert.doesNotMatch(oldRuns.reasons.join("\n"), /DOES NOT CONTAIN/);

  // AND THE THIRD CASE, WHICH IS THE WORST TO NOTICE: right answer, unsound method.
  //
  // #137, measured 2026-09-07 and used here as the fixture rather than invented numbers: newest run
  // 01:38:32Z against a `main` tipped 01:38:39Z, and `behind_by` 1. The clock refused it correctly on a
  // SEVEN-SECOND margin -- a gap that decided a question about commit containment and happened to land on
  // the right side. Neither of the other two cases covers this: it is not a false pass, and it is not
  // #135's honest refusal. It is the one that makes the defect hard to see in normal operation, because
  // the guard looks like it is working.
  const both = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green("2026-09-07T01:38:32Z"),
    mainTipIso: "2026-09-07T01:38:39Z", behindBy: 1,
    branchTip: HEAD,
  });
  assert.equal(both.reasons.length, 2, "two faults, two sentences");
  assert.match(both.reasons[0], /DOES NOT CONTAIN main's TIP — it is 1 commit\(s\) behind/,
    "the ancestry reason is the load-bearing one here; the timestamp reason is right by seven seconds");
});

test("a FAILED ancestry lookup is inconclusive, never read as contained", () => {
  // The sharp one: `behind_by` falling through to 0 would mean "contains main's tip" and would restore
  // the exact false pass #182 is about, this time silently and for a different reason.
  const v = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: null,
    branchTip: HEAD,
  });
  assert.equal(v.code, 2);
  assert.match(v.reasons[0], /whether this head contains `main`'s tip/);
});

test("a PR that is not open is annotated rather than silently judged as if it were", () => {
  const v = mergeReadiness({ pr: pr({ state: "MERGED" }), required: REQUIRED, runs: green(),
    mainTipIso: MAIN_TIP, behindBy: 0, branchTip: HEAD });
  assert.match(v.notes.join("\n"), /MERGED, so this is a post-mortem/);
});

/**
 * AND THE ONE THAT MATTERS MOST: the guard must not consult the field it exists to distrust.
 *
 * `mergeStateStatus` is what reported #148 as the greenest PR on the board. A guard that read it would
 * share a failure mode with the thing it is checking, and this repo already has the rule — verify
 * `/health` over HTTP, not through the deploy channel that just failed. Asserted against the source
 * because no behavioural test can see a field being consulted "just to cross-check".
 */
test("the guard never reads mergeStateStatus, not even to cross-check", () => {
  const src = readFileSync(new URL("../../../../scripts/merge-guard.mjs", import.meta.url), "utf8");
  const code = src.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

  // TARGETS THE READ, NOT THE WORD -- and the first version of this assertion did the latter, then fired
  // on the script's own usage text explaining why the field is not to be trusted. A guard that forbids
  // NAMING the hazard makes the hazard harder to document, which is the opposite of the point. The two
  // patterns below are the only ways this script could actually consult it: ask GitHub for the field, or
  // read it off an object.
  assert.doesNotMatch(code, /--json[^\n]*mergeStateStatus/,
    "requesting the field at all invites the next reader to use it");
  assert.doesNotMatch(code, /\.mergeStateStatus\b/,
    "reading it -- even alongside the real check -- reintroduces the failure mode this tool exists to "
    + "avoid: a verification sharing a failure mode with the action verifies nothing");
  // `${sha}`, not `${pr.headRefOid}` literally -- #118 (workflow-run-liveness.mjs) needed the identical
  // per-sha check-runs lookup for a commit that is not (yet, or ever) a PR head, so it moved into
  // `lookupCheckRuns(sha)` and this call site now passes `pr.headRefOid` as that argument. The property
  // under test is unchanged: the authoritative source is still the check runs FOR A SPECIFIC SHA, never a
  // bounded `gh run list --limit N | grep`, which is what turned a stale-run PR into a runless one in this
  // finding's own first draft.
  assert.match(code, /commits\/\$\{sha\}\/check-runs/,
    "the authoritative source is the check runs FOR THE HEAD SHA. A `gh run list --limit N | grep` is "
    + "what turned a stale-run PR into a runless one in this finding's own first draft.");
});

/**
 * THE ORIENTATION SEAM (#188): every `behindBy` in this file's own fixtures above is INJECTED, so a
 * reversed `compare/<head>...main` in the real fetch would leave every one of them green while
 * production read the wrong number. Measured live: `compare/main...56c34b68` reports `behind_by: 2`
 * (correct — how many commits `main` has that the head lacks); the reversed
 * `compare/56c34b68...main` reports `behind_by: 10` — a different, perfectly plausible-looking number
 * for the identical pair of commits. Asserted against the source, offline, because no fixture-driven
 * test of the pure function can see which way the real HTTP call is built.
 */
test("the real behindBy fetch is oriented main...head, never the reverse (#188)", () => {
  const src = readFileSync(new URL("../../../../scripts/merge-guard.mjs", import.meta.url), "utf8");
  assert.match(src, /compare\/main\.\.\.\$\{pr\.headRefOid\}/,
    "must ask GitHub how far main is ahead of this head, not the reverse");
  assert.doesNotMatch(src, /compare\/\$\{pr\.headRefOid\}\.\.\.main/,
    "the reversed orientation returns a different, equally plausible-looking number for the same pair");
});

/**
 * THE REAL #165 INCIDENT, AT FULL FIDELITY — #182's own account, re-derived from immutable sources
 * rather than replayed live (the live conditions are gone: #165's branch is deleted and `main` has moved
 * many times since). Every value below was read once; re-running the commands now will not reproduce
 * them.
 *
 *   MAIN_TIP_SHA = 4050b31a42f08f6a2cc6a711824e717c610fb2d7   (#147's merge commit)
 *   MAIN_TIP_ISO = 2026-09-07T01:31:03Z
 *     git show -s --format=%cI 4050b31a42f08f6a2cc6a711824e717c610fb2d7
 *
 *   PR165_HEAD  = 56c34b683e550155816872dedd2364e4d397aedb   (#165's head BEFORE
 *                 `gh pr update-branch 165` force-pushed a merge of main into it)
 *     gh api repos/a11ign/a11ign/pulls/165/commits --jq '.[] | {sha, date: .commit.committer.date}'
 *
 *   git merge-base --is-ancestor 4050b31a42f08f6a2cc6a711824e717c610fb2d7 56c34b683e550155816872dedd2364e4d397aedb
 *   -> exit 1: MAIN_TIP_SHA is NOT an ancestor. The branch did not contain main's tip.
 *
 *   git rev-list --count 56c34b683e550155816872dedd2364e4d397aedb..4050b31a42f08f6a2cc6a711824e717c610fb2d7
 *   -> 2   (BEHIND_BY, verified a third way against the live compare API: behind_by=2 ahead_by=10)
 *
 *   gh api repos/a11ign/a11ign/commits/56c34b683e550155816872dedd2364e4d397aedb/check-runs \
 *     --paginate --jq '.check_runs[] | {name, status, conclusion, completed_at}'
 *   -> the seven runs below, verbatim. Newest (`gate`) completed 01:32:56Z, AFTER MAIN_TIP_ISO — the
 *      exact "newer in time, older in history" shape the pre-#184 clock check could not see.
 */
test("THE REAL #165 INCIDENT: today's guard refuses it, by ancestry, using the original data", () => {
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

/**
 * THE #195 INCIDENT — GitHub's recorded head can be the branch tip's PARENT, and every check GitHub
 * reports belongs to that older commit (#294).
 *
 *   git ls-remote origin lead/prune-orphan-captures    -> 7c2e16fc   the branch's real tip
 *   gh api .../pulls/195 --jq .head.sha                -> ac306fe9   GitHub's recorded head
 *   gh api .../commits/7c2e16fc/check-runs total_count -> 0          the tip: never tested
 *   gh api .../commits/ac306fe9/check-runs total_count -> 9          all green
 *
 * `gh pr checks 195` reports green on `ac306fe9`, the tip's parent -- not on `7c2e16fc`, the commit that
 * would actually merge.
 */
test("THE #195 INCIDENT: GitHub's recorded head is the branch tip's PARENT, and the mismatch is its own reason", () => {
  const v = mergeReadiness({
    pr: { number: 195, state: "OPEN", baseRefName: "main", headRefOid: "ac306fe9" },
    required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: "7c2e16fc",
  });
  assert.equal(v.code, 1, "green checks on the wrong commit must not read as READY");
  assert.equal(v.reasons.length, 1, "nothing else is wrong here -- isolate the one real fault");
  assert.match(v.reasons[0], /GITHUB'S HEAD IS NOT THE BRANCH TIP/);
  assert.match(v.reasons[0], /ac306fe9/, "GitHub's recorded head, named");
  assert.match(v.reasons[0], /7c2e16fc/, "the branch's real tip, named");
  assert.match(v.reasons[0], /re-push/i, "the remedy: re-push, not update-the-branch");
});

test("a head/tip mismatch is NOT collapsed into the ancestry reason -- they need opposite remedies", () => {
  // Behind main: update the branch. GitHub's head is not the tip: re-push. Conflating the two sends
  // someone to merge `main` in when the actual fix is a `git push --force-with-lease` on their own branch.
  const v = mergeReadiness({
    pr: { number: 195, state: "OPEN", baseRefName: "main", headRefOid: "ac306fe9" },
    required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 2,
    branchTip: "7c2e16fc",
  });
  assert.equal(v.reasons.length, 2, "ancestry and tip-mismatch are independent faults");
  assert.match(v.reasons.join("\n"), /GITHUB'S HEAD IS NOT THE BRANCH TIP/);
  assert.match(v.reasons.join("\n"), /DOES NOT CONTAIN main's TIP/);
});

test("branchTip === headRefOid adds no reason -- the common case", () => {
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: HEAD });
  assert.equal(v.code, 0);
  assert.doesNotMatch(v.reasons.join("\n"), /BRANCH TIP/i);
});

test("a FAILED branch-tip lookup is CANNOT_ASK, never READY -- null and equal are different answers", () => {
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: null });
  assert.equal(v.code, 2, "a failed `git ls-remote` must not fall through to 'no mismatch found'");
  assert.match(v.reasons[0], /branch's real tip/);
});

/**
 * `lookupBranchTip` is exercised directly rather than through `facts()`, because `facts()` needs a live
 * PR to call `gh pr view` against -- the same reason `lookupCheckRuns`/`lookupRequiredContexts` above it
 * have no fixture-driven test either. What IS testable offline is the parsing: `git ls-remote` on a real
 * branch in THIS repo, and the empty/malformed cases `lookup`'s try/catch and the `|| null` guard cover.
 */
test("lookupBranchTip reads the real tip of a real branch in this repo", () => {
  const tip = lookupBranchTip("main");
  assert.ok(tip, "main always has a tip");
  assert.match(tip as string, /^[0-9a-f]{40}$/, "a full sha, not an abbreviation or a ref name");
});

test("lookupBranchTip returns null for a branch that does not exist, never an empty string", () => {
  const tip = lookupBranchTip("this-branch-does-not-exist-294");
  assert.equal(tip, null);
});

// --- #188: recording the guard's verdict against what the platform actually did ---

function withTempLogDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "merge-guard-log-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Narrows `reconcile`'s discriminated union so a test can read `.record`'s fields. */
function recordOf(result: ReturnType<typeof reconcile>) {
  assert.ok(result.record, `expected a record, got: ${result.reason}`);
  return result.record;
}

test("reasonKind classifies every reason this file's own fixtures produce", () => {
  // A reason this cannot classify is worth knowing about immediately, not discovering later in a log
  // full of UNCLASSIFIED entries -- the count-based-check shape this repo keeps finding, arriving here
  // through a label instead of a number.
  const cases = [
    ["BASE IS NOT main — it is `x`.", "BASE_NOT_MAIN"],
    ["NO CHECK RUNS EXIST for head abc — not one, ever.", "NO_RUNS"],
    ["REQUIRED CONTEXT NEVER RAN: changeset.", "MISSING_REQUIRED_CONTEXT"],
    ["STILL RUNNING: ts. Not a refusal forever — ask again.", "STILL_RUNNING"],
    ["FAILING: ts (failure).", "FAILING"],
    ["THIS HEAD DOES NOT CONTAIN main's TIP — it is 2 commit(s) behind.", "ANCESTRY"],
    ["EVERY RUN PREDATES THE CURRENT main. Newest run x, `main` tipped y.", "STALE"],
  ];
  for (const [reason, expected] of cases) assert.equal(reasonKind(reason), expected, reason);
  assert.equal(reasonKind("something nobody wrote a pattern for"), "UNCLASSIFIED");
});

test("recordVerdict appends one entry with its reason KINDS, not just READY/REFUSED", () => {
  withTempLogDir((dir) => {
    const log = join(dir, "log.jsonl");
    recordVerdict(log, 165, { code: 1, reasons: ["THIS HEAD DOES NOT CONTAIN main's TIP — it is 2 commit(s) behind.\n  more"] });
    const entry = latestVerdictFor(log, 165);
    assert.ok(entry);
    assert.equal(entry.prNumber, 165);
    assert.equal(entry.code, 1);
    assert.deepEqual(entry.reasonKinds, ["ANCESTRY"]);
  });
});

test("latestVerdictFor returns null for a PR nothing ever recorded, never an empty-but-present entry", () => {
  withTempLogDir((dir) => {
    assert.equal(latestVerdictFor(join(dir, "does-not-exist.jsonl"), 165), null);
  });
});

test("latestVerdictFor picks the MOST RECENT entry when a PR was checked more than once", () => {
  withTempLogDir((dir) => {
    const log = join(dir, "log.jsonl");
    recordVerdict(log, 165, { code: 1, reasons: ["THIS HEAD DOES NOT CONTAIN main's TIP — it is 2 commit(s) behind."] });
    recordVerdict(log, 165, { code: 0, reasons: [] });
    const entry = latestVerdictFor(log, 165);
    assert.ok(entry);
    assert.equal(entry.code, 0, "the branch was updated between the two checks; the later verdict wins");
  });
});

test("realOutcomeFor: MERGED is ACCEPTED, CLOSED is REFUSED, anything else is no outcome yet", () => {
  assert.equal(realOutcomeFor("MERGED"), "ACCEPTED");
  assert.equal(realOutcomeFor("CLOSED"), "REFUSED");
  assert.equal(realOutcomeFor("OPEN"), null, "no outcome exists yet -- never invent one");
});

const BEFORE_RESOLUTION = "2026-09-07T02:00:00.000Z";
const RESOLVED_AT = "2026-09-07T02:10:00.000Z";
const AFTER_RESOLUTION = "2026-09-07T02:20:00.000Z";

test("THE DISAGREEMENT CASE: guard said READY, the platform actually refused it", () => {
  const result = reconcile({
    prNumber: 165,
    recordedVerdict: { code: 0, reasonKinds: [], at: BEFORE_RESOLUTION },
    realOutcome: "REFUSED",
    resolvedAt: RESOLVED_AT,
  });
  assert.equal(result.code, 0, "reconciling successfully is not the same as the two answers agreeing");
  const record = recordOf(result);
  assert.equal(record.guardVerdict, "READY");
  assert.equal(record.realOutcome, "REFUSED");
  assert.equal(record.agreement, "DISAGREED");
});

test("THE AGREEMENT CASE, stated explicitly — not merely the absence of a disagreement", () => {
  // worker-capture's constraint: a log that only records conflicts cannot tell "the two agreed" from
  // "the two were never compared". This must say AGREED, not just fail to say DISAGREED.
  const result = reconcile({
    prNumber: 100,
    recordedVerdict: { code: 0, reasonKinds: [], at: BEFORE_RESOLUTION },
    realOutcome: "ACCEPTED",
    resolvedAt: RESOLVED_AT,
  });
  assert.equal(result.code, 0);
  const record = recordOf(result);
  assert.equal(record.agreement, "AGREED");
  assert.equal(record.guardVerdict, "READY");
  assert.equal(record.realOutcome, "ACCEPTED");
});

test("a REFUSED verdict followed by a real refusal is ALSO an agreement", () => {
  const result = reconcile({
    prNumber: 101,
    recordedVerdict: { code: 1, reasonKinds: ["ANCESTRY"], at: BEFORE_RESOLUTION },
    realOutcome: "REFUSED",
    resolvedAt: RESOLVED_AT,
  });
  assert.equal(recordOf(result).agreement, "AGREED", "both said no; that is agreement too, not just a wash");
});

test("reconcile REFUSES rather than inventing an outcome for a PR that is still OPEN", () => {
  const result = reconcile({
    prNumber: 102, recordedVerdict: { code: 0, reasonKinds: [], at: BEFORE_RESOLUTION },
    realOutcome: null, resolvedAt: null,
  });
  assert.equal(result.code, 2, "INCONCLUSIVE, never a guess");
  assert.equal(result.record, null);
  assert.match(result.reason ?? "", /forward-only|no outcome/);
});

test("reconcile REFUSES when nothing was ever recorded for this PR", () => {
  const result = reconcile({
    prNumber: 103, recordedVerdict: null, realOutcome: "ACCEPTED", resolvedAt: RESOLVED_AT,
  });
  assert.equal(result.code, 2);
  assert.equal(result.record, null);
  assert.match(result.reason ?? "", /nothing to reconcile/);
});

/**
 * THE TRAP FOUND BY RUNNING THIS LIVE: recomputing the guard against an already-merged PR almost always
 * reads REFUSED, because `main` has kept moving and the merged head is now "behind" a tip it never needed
 * to be tested against. That is a stale question, not a disagreement — measured live against #191 minutes
 * after this file was written: `guard said REFUSED (ANCESTRY, STALE) ... DISAGREED`, for a PR that merged
 * cleanly. Reconcile must refuse a verdict recorded AFTER the PR resolved, rather than recording that as a
 * real disagreement.
 */
test("reconcile REFUSES a verdict recorded AFTER the PR already resolved — a stale post-mortem question", () => {
  const result = reconcile({
    prNumber: 191,
    recordedVerdict: { code: 1, reasonKinds: ["ANCESTRY", "STALE"], at: AFTER_RESOLUTION },
    realOutcome: "ACCEPTED",
    resolvedAt: RESOLVED_AT,
  });
  assert.equal(result.code, 2, "INCONCLUSIVE, never recorded as a disagreement");
  assert.equal(result.record, null);
  assert.match(result.reason ?? "", /AFTER it resolved|stale post-mortem/);
});

test("MUTATION: a write failure is never a silent no-op", () => {
  // A directory used as a file path makes the write fail deterministically without touching real
  // permissions bits, which behave differently across CI and a laptop.
  withTempLogDir((dir) => {
    assert.throws(() => recordVerdict(dir, 165, { code: 0, reasons: [] }),
      /could not write the log/,
      "a log that cannot write must say so loudly, not swallow the error and continue silently");
  });
});

/**
 * #249: ARMING CLOSES ROWS, AND NOTHING AT THAT END EVER CHECKED WHETHER SOMEBODY ELSE WAS INSIDE ONE.
 *
 * `row-claim check` runs before a worker dispatches or starts a row; nothing ran before a PR closing that
 * row was armed, and arming is the act that actually closes it. `closingClaimReasons` reuses
 * `row-claim.mjs`'s own `decideClaim` rather than re-deriving "is this row somebody else's" a second time.
 */
const CLOSES_CLAIMED = [{ number: 237, title: "example row", labels: ["in-progress", "session:worker-judge", "started"] }];

test("#249 case 1: REFUSES arming a PR that would close a row claimed by a DIFFERENT session", () => {
  const v = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: HEAD,
    closes: CLOSES_CLAIMED, session: "dispatcher",
  });
  assert.equal(v.code, 1, `expected REFUSED, got: ${v.reasons.join(" | ")}`);
  assert.match(v.reasons.join("\n"), /claim|held|session:worker-judge/i);
  assert.equal(reasonKind(v.reasons.find((r) => /WOULD CLOSE/.test(r)) ?? ""), "CLAIMED_BY_ANOTHER_SESSION");
});

test("#249 case 2: does NOT refuse when the session ASKING already holds the row — resuming is not a collision", () => {
  const v = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: HEAD,
    closes: CLOSES_CLAIMED, session: "worker-judge",
  });
  assert.equal(v.code, 0, `expected READY, got: ${v.reasons.join(" | ")}`);
});

test("#249 case 3: an empty closes list, or an unclaimed row, stays silent — the common case", () => {
  const empty = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: HEAD,
    closes: [], session: "dispatcher",
  });
  assert.equal(empty.code, 0);

  const unclaimed = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: HEAD,
    closes: [{ number: 999, labels: [] }], session: "dispatcher",
  });
  assert.equal(unclaimed.code, 0);
});

test("#249 case 4: closes === null (a failed lookup) is CANNOT_ASK, never READY — [] and null are different answers", () => {
  const v = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: HEAD,
    closes: null, session: "dispatcher",
  });
  assert.equal(v.code, 2);
  assert.match(v.reasons[0], /which rows this PR would close/);
});

test("#249: omitting `session` treats every claimed row it would close as somebody else's — the conservative default", () => {
  const v = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    branchTip: HEAD,
    closes: CLOSES_CLAIMED,
  });
  assert.equal(v.code, 1, "a check that does not know who is asking cannot vouch for the asker");
});

/**
 * #249's follow-up (2026-09-07): measured 10 of 13 open PRs' armings fire the collision, and every one of
 * the 10 is author == claimant — the real incident (a DIFFERENT session's row) is 0 of 10. `--session`
 * cannot see PR authorship at all (every session pushes as the same GitHub identity), so
 * `--allow-claimed-close` becomes the flag passed four times in five, and an unfalsifiable bypass at that
 * rate is the `A11Y_SKIP_VERIFY=1` shape. `claimedCloseCoveredBy` turns "I confirmed" into a CHECKABLE
 * claim: it re-reads the row's own labels, the same way `decideClaim` does, rather than trusting whatever
 * string was typed on the command line.
 */
test("claimedCloseCoveredBy: the named session covers a row it actually holds", () => {
  const covered = claimedCloseCoveredBy(
    [{ number: 237, labels: ["in-progress", "session:worker-judge", "started"] }], "worker-judge");
  assert.deepEqual([...covered], [237]);
});

test("claimedCloseCoveredBy: a name that matches NO real claimant covers nothing", () => {
  const covered = claimedCloseCoveredBy(
    [{ number: 237, labels: ["in-progress", "session:worker-judge", "started"] }], "dispatcher");
  assert.deepEqual([...covered], []);
});

test("claimedCloseCoveredBy: an unclaimed row is never covered, however the flag is spelled", () => {
  const covered = claimedCloseCoveredBy([{ number: 999, labels: [] }], "worker-judge");
  assert.deepEqual([...covered], []);
});

test("claimedCloseCoveredBy: covers only the rows the name actually holds, among several closed", () => {
  const covered = claimedCloseCoveredBy([
    { number: 237, labels: ["in-progress", "session:worker-judge"] },
    { number: 238, labels: ["in-progress", "session:worker-audit"] },
    { number: 239, labels: [] },
  ], "worker-judge");
  assert.deepEqual([...covered], [237]);
});

/**
 * IS SOMEBODY ELSE HOLDING THIS PR? — #266, and it is #197's finding one object along.
 *
 * Measured 2026-09-07 on PR #258: the dispatcher said "arming on green" and ran `update-branch`; the
 * author ran this guard, saw `7 commit(s) behind`, rebased and pushed. `--force-with-lease` refused, and
 * it is the only reason nothing was lost — a plain `--force` would have taken the branch to a base
 * fetched before #229 merged, silently reverting that PR's README and changeset inside an unrelated
 * branch.
 *
 * The stated rule named ARMED PRs; #258 was unarmed, so by that rule it was the author's, while the
 * dispatcher was updating it in preparation for arming. **The other party cannot see that state**, so
 * the collision was a property of the rule rather than of anyone's care.
 *
 * A LABEL RATHER THAN AN AGREEMENT, because #197 already ran this experiment on rows: a claim existing
 * only as a sentence in a dispatch message produced three double-dispatches, each caught by a worker's
 * caution and never by the tool. Repeating a measured negative is not a trial.
 */
// `branchTip: HEAD` for the reason stated at the top of this file: without it every fixture here trips
// #294's head-vs-tip reason and the hold tests would refuse for a cause unrelated to holds -- the
// canary-that-cannot-express-the-fault trap these same tests were written to avoid once already.
const HELD_BASE = { pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
  branchTip: HEAD };

test("the hold fixture is READY before a hold is added — or the refusals below prove nothing", () => {
  // A canary that cannot express the fault is worthless: the first draft of these tests used `runs: []`,
  // so every case "refused" on NO CHECK RUNS EXIST and two of them passed for a reason unrelated to holds.
  const v = mergeReadiness({ ...HELD_BASE, prLabels: [], session: "worker-capture" });
  assert.equal(v.code, 0, `the baseline must be READY, got: ${v.reasons.join(" | ")}`);
});

test("a PR held by another session is REFUSED, and the holder is NAMED", () => {
  const v = mergeReadiness({ ...HELD_BASE, prLabels: ["session:dispatcher"], session: "worker-capture" });
  assert.equal(v.code, 1);
  assert.match(v.reasons[0], /IS HELD by dispatcher/,
    "'held' and 'held by X' are different instructions -- one of them tells you who to ask");
  assert.match(v.reasons[0], /you are worker-capture/, "and who it thinks YOU are, or the reader cannot tell "
    + "a real collision from a mis-set --session");
  assert.match(v.reasons[0], /pr:hold/, "it must name the command that takes the hold, not just refuse");
});

test("a PR held by ME is not a collision — resuming your own work must not refuse", () => {
  const v = mergeReadiness({ ...HELD_BASE, prLabels: ["session:worker-capture"], session: "worker-capture" });
  assert.equal(v.code, 0, `expected READY, got: ${v.reasons.join(" | ")}`);
});

test("an UNHELD PR is silent — the common case must not gain a sentence", () => {
  // A check that fires on every PR is one people stop reading, which is this repo's own rule about
  // refusing more not being automatically better.
  const v = mergeReadiness({ ...HELD_BASE, prLabels: ["ready", "backlog"], session: "worker-capture" });
  assert.equal(v.code, 0, `expected READY, got: ${v.reasons.join(" | ")}`);
});

test("a FAILED label lookup is CANNOT_ASK, never READY — `[]` and `null` differ", () => {
  // `[]` is "nobody holds this PR"; `null` is "I could not ask". Reporting the second as the first is
  // exactly the false pass this whole file exists to prevent.
  const v = mergeReadiness({ ...HELD_BASE, prLabels: null, session: "worker-capture" });
  assert.equal(v.code, 2);
  assert.match(v.reasons[0], /could not read this PR's own labels/);
});

test("with no --session, every holder is somebody else — the safe default when the asker is anonymous", () => {
  const v = mergeReadiness({ ...HELD_BASE, prLabels: ["session:dispatcher"] });
  assert.equal(v.code, 1);
  assert.match(v.reasons[0], /IS HELD by dispatcher/);
  assert.doesNotMatch(v.reasons[0], /you are/, "it must not claim an identity the caller never gave");
});

/**
 * #298 (unit 1): `mergeSafetyVerdict` is the narrower, self-reference-safe check a required CI job runs
 * mid-workflow -- head-vs-tip (#294, `headTipMismatchReason` -- see its own tests above) ONLY.
 *
 * Ancestry (#182) and closing-claim (#262) are DELIBERATELY not composed in here, and this is the
 * regression these tests exist to pin: `dispatcher` drove an earlier version of this function (which did
 * include both) against the real, moving PR queue and measured it refusing the NORMAL case on both counts
 * -- almost every open PR is behind `main` most of the time with `strict=false`, and a CI job has no
 * session identity to tell "closes the row I was built for" apart from "discards a stranger's work". A
 * required job that refuses the normal case is not a gate. See `mergeSafetyVerdict`'s own comment in
 * `scripts/merge-guard.mjs` for the measurements.
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

test("mergeSafetyVerdict: THE #182 REGRESSION -- a PR far behind main is still READY, because ancestry is CLI advice, never a CI refusal", () => {
  // The shape `dispatcher` measured live: 13 of 13 open PRs behind `main` at once, with merges landing
  // roughly one a minute. `mergeSafetyVerdict` does not even ask for `behindBy` -- there is no argument
  // here that could smuggle ancestry back in by accident.
  const v = mergeSafetyVerdict({ pr: pr(), branchTip: HEAD });
  assert.equal(v.code, 0);
  assert.deepEqual(Object.keys(v).sort(), ["code", "reasons"].sort());
});

test("mergeSafetyVerdict: THE #262 REGRESSION -- closing a row THIS PR's own author claimed is still READY, because CI has no session identity", () => {
  // `dispatcher` measured 10 of 13 open PRs closing a row their own author held -- the ordinary
  // worker-owned shape. `mergeSafetyVerdict` takes no `closes`/`session` at all, so this cannot regress
  // by someone quietly wiring the claim check back in with `session: null`.
  const v = mergeSafetyVerdict({ pr: pr(), branchTip: HEAD });
  assert.equal(v.code, 0, "a PR closing its own claimed row must never be refused by the CI gate");
});
