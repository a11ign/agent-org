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
  mergeReadiness, reasonKind, recordVerdict, latestVerdictFor, realOutcomeFor, reconcile,
  headVsTipReason, mergeSafetyVerdict,
} from "../../../../scripts/merge-guard.mjs";

const REQUIRED = ["changed", "ts", "python", "ansible", "docs", "changeset"];
const MAIN_TIP = "2026-09-07T00:41:07Z";
const AFTER = "2026-09-07T00:45:35Z";
const BEFORE = "2026-09-07T00:08:02Z";

const pr = (over: object = {}) => ({
  number: 148, state: "OPEN", baseRefName: "main", headRefOid: "d5c2436601abcdef", ...over,
});
const green = (at = AFTER) => REQUIRED.map((name) => ({
  name, status: "completed", conclusion: name === "ts" ? "success" : "skipped", completedAt: at,
}));

test("THE #148 CASE: a base that is not main, and not one check run — both named", () => {
  const v = mergeReadiness({
    pr: pr({ baseRefName: "lead/real-page-outcome-is-stated" }),
    required: REQUIRED, runs: [], mainTipIso: MAIN_TIP, behindBy: 0,
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
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0 });
  assert.equal(v.code, 0, `expected READY, got: ${v.reasons.join(" | ")}`);
  assert.deepEqual(v.reasons, []);
});

test("THE STALE SHAPE: real runs, real conclusions, against a base that has moved", () => {
  // The dangerous one, because the runs look like evidence. Measured on #135: newest run 00:08:02Z
  // against a main tipped 00:41:07Z.
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs: green(BEFORE), mainTipIso: MAIN_TIP, behindBy: 0 });
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
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs, mainTipIso: MAIN_TIP, behindBy: 0 });
  assert.equal(v.code, 1);
  assert.match(v.reasons[0], /REQUIRED CONTEXT NEVER RAN: changeset/);
  assert.match(v.reasons[0], /Present-and-failing and never-ran are different states/);
});

test("a failing context and a still-running one are separate sentences", () => {
  const failing = green().map((r) => (r.name === "ts" ? { ...r, conclusion: "failure" } : r));
  assert.match(mergeReadiness({ pr: pr(), required: REQUIRED, runs: failing, mainTipIso: MAIN_TIP, behindBy: 0 })
    .reasons.join("\n"), /FAILING: ts \(failure\)/);

  const running = green().map((r) => (r.name === "ts"
    ? { ...r, status: "in_progress", conclusion: null, completedAt: null } : r));
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs: running, mainTipIso: MAIN_TIP, behindBy: 0 });
  assert.equal(v.code, 1);
  assert.match(v.reasons.join("\n"), /STILL RUNNING: ts/);
  assert.match(v.reasons.join("\n"), /ask again/, "in-flight is not a defect and must not read as one");
});

test("`[]` AND `null` ARE DIFFERENT ANSWERS, and this is the sharpest case in the file", () => {
  // "nothing ran" and "I could not ask" demand opposite responses. A lookup that fell through to an empty
  // array would report the safest-looking verdict for the least examined PR -- this repo's oldest defect.
  const nothingRan = mergeReadiness({ pr: pr(), required: REQUIRED, runs: [], mainTipIso: MAIN_TIP, behindBy: 0 });
  assert.equal(nothingRan.code, 1, "an empty list is a FINDING");

  const couldNotAsk = mergeReadiness({ pr: pr(), required: REQUIRED, runs: null, mainTipIso: MAIN_TIP, behindBy: 0 });
  assert.equal(couldNotAsk.code, 2, "a failed lookup is INCONCLUSIVE, and must never be either 0 or 1");
  assert.match(couldNotAsk.reasons[0], /CANNOT SAY/);
  assert.match(couldNotAsk.reasons[0], /check runs for head d5c2436601/, "it names WHICH lookup failed");
});

test("every failed lookup is inconclusive, and all of them are named at once", () => {
  const v = mergeReadiness({ pr: pr(), required: null, runs: null, mainTipIso: null, behindBy: null });
  assert.equal(v.code, 2);
  for (const expected of [/branch protection/, /check runs/, /tip of `main`/]) {
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
  });
  assert.equal(v.code, 2);
  assert.match(v.reasons[0], /whether this head contains `main`'s tip/);
});

test("a PR that is not open is annotated rather than silently judged as if it were", () => {
  const v = mergeReadiness({ pr: pr({ state: "MERGED" }), required: REQUIRED, runs: green(),
    mainTipIso: MAIN_TIP, behindBy: 0 });
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
 *     gh api repos/DanBeckDev/a11y-witness/pulls/165/commits --jq '.[] | {sha, date: .commit.committer.date}'
 *
 *   git merge-base --is-ancestor 4050b31a42f08f6a2cc6a711824e717c610fb2d7 56c34b683e550155816872dedd2364e4d397aedb
 *   -> exit 1: MAIN_TIP_SHA is NOT an ancestor. The branch did not contain main's tip.
 *
 *   git rev-list --count 56c34b683e550155816872dedd2364e4d397aedb..4050b31a42f08f6a2cc6a711824e717c610fb2d7
 *   -> 2   (BEHIND_BY, verified a third way against the live compare API: behind_by=2 ahead_by=10)
 *
 *   gh api repos/DanBeckDev/a11y-witness/commits/56c34b683e550155816872dedd2364e4d397aedb/check-runs \
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
  });
  assert.equal(v.code, 1, "before #182 this was the exact case that returned 0");
  assert.equal(v.reasons.length, 1, "the runs are genuinely newer than the tip; only ancestry fires");
  assert.match(v.reasons[0], /DOES NOT CONTAIN main's TIP — it is 2 commit\(s\) behind/);
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
    closes: CLOSES_CLAIMED, session: "dispatcher",
  });
  assert.equal(v.code, 1, `expected REFUSED, got: ${v.reasons.join(" | ")}`);
  assert.match(v.reasons.join("\n"), /claim|held|session:worker-judge/i);
  assert.equal(reasonKind(v.reasons.find((r) => /WOULD CLOSE/.test(r)) ?? ""), "CLAIMED_BY_ANOTHER_SESSION");
});

test("#249 case 2: does NOT refuse when the session ASKING already holds the row — resuming is not a collision", () => {
  const v = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    closes: CLOSES_CLAIMED, session: "worker-judge",
  });
  assert.equal(v.code, 0, `expected READY, got: ${v.reasons.join(" | ")}`);
});

test("#249 case 3: an empty closes list, or an unclaimed row, stays silent — the common case", () => {
  const empty = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    closes: [], session: "dispatcher",
  });
  assert.equal(empty.code, 0);

  const unclaimed = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    closes: [{ number: 999, labels: [] }], session: "dispatcher",
  });
  assert.equal(unclaimed.code, 0);
});

test("#249 case 4: closes === null (a failed lookup) is CANNOT_ASK, never READY — [] and null are different answers", () => {
  const v = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    closes: null, session: "dispatcher",
  });
  assert.equal(v.code, 2);
  assert.match(v.reasons[0], /which rows this PR would close/);
});

test("#249: omitting `session` treats every claimed row it would close as somebody else's — the conservative default", () => {
  const v = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    closes: CLOSES_CLAIMED,
  });
  assert.equal(v.code, 1, "a check that does not know who is asking cannot vouch for the asker");
});

/**
 * #294 / #298 (unit 1): GitHub's recorded head must agree with `git ls-remote`'s answer, or the merge is
 * refused rather than treated as ready. `headVsTipReason` is the pure comparison; `mergeSafetyVerdict` is
 * the narrower, self-reference-safe composite a required CI job runs mid-workflow (see that function's
 * own comment for why it never asks about check-run conclusions).
 */

test("headVsTipReason: silent when GitHub's recorded head agrees with the remote tip", () => {
  assert.deepEqual(headVsTipReason("d5c2436601abcdef", "d5c2436601abcdef"), []);
});

test("headVsTipReason: THE REAL #195 SHAPE — a stale recorded head disagrees with the branch's real tip", () => {
  const reasons = headVsTipReason("ac306fe9", "7c2e16fc");
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /GITHUB'S RECORDED HEAD.*ac306fe9.*DOES NOT MATCH.*7c2e16fc/s);
  assert.equal(reasonKind(reasons[0]), "HEAD_MISMATCH");
});

test("headVsTipReason: a failed ls-remote lookup (null) is silent here — mergeReadiness/mergeSafetyVerdict own the CANNOT_ASK, not this pure comparison", () => {
  assert.deepEqual(headVsTipReason("d5c2436601abcdef", null), []);
});

test("mergeReadiness: omitting remoteHeadOid entirely skips the #294 check — every pre-#294 call site keeps working", () => {
  const v = mergeReadiness({ pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0 });
  assert.equal(v.code, 0, `expected READY with no remoteHeadOid asked for, got: ${v.reasons.join(" | ")}`);
});

test("mergeReadiness: remoteHeadOid=null (asked for, lookup failed) is CANNOT_ASK, never a silent pass", () => {
  const v = mergeReadiness({
    pr: pr(), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0, remoteHeadOid: null,
  });
  assert.equal(v.code, 2);
  assert.match(v.reasons[0], /git ls-remote/);
});

test("mergeReadiness: a real remoteHeadOid mismatch refuses, folded in alongside every other reason", () => {
  const v = mergeReadiness({
    pr: pr({ headRefOid: "ac306fe9" }), required: REQUIRED, runs: green(), mainTipIso: MAIN_TIP, behindBy: 0,
    remoteHeadOid: "7c2e16fc",
  });
  assert.equal(v.code, 1);
  assert.equal(reasonKind(v.reasons.find((r) => /GITHUB'S RECORDED HEAD/.test(r)) ?? ""), "HEAD_MISMATCH");
});

test("mergeSafetyVerdict: READY when ancestry, closing-claim and head-vs-tip are all clean", () => {
  const v = mergeSafetyVerdict({
    pr: pr(), behindBy: 0, closes: [], session: "ci", remoteHeadOid: "d5c2436601abcdef",
  });
  assert.equal(v.code, 0, `expected READY, got: ${v.reasons.join(" | ")}`);
});

test("mergeSafetyVerdict: refuses on ancestry alone, with no check-run inspection at all — the self-reference this function exists to avoid", () => {
  const v = mergeSafetyVerdict({
    pr: pr(), behindBy: 3, closes: [], session: "ci", remoteHeadOid: "d5c2436601abcdef",
  });
  assert.equal(v.code, 1);
  assert.equal(reasonKind(v.reasons[0]), "ANCESTRY");
});

test("mergeSafetyVerdict: refuses on the #294 shape", () => {
  const v = mergeSafetyVerdict({
    pr: pr({ headRefOid: "ac306fe9" }), behindBy: 0, closes: [], session: "ci", remoteHeadOid: "7c2e16fc",
  });
  assert.equal(v.code, 1);
  assert.equal(reasonKind(v.reasons[0]), "HEAD_MISMATCH");
});

test("mergeSafetyVerdict: refuses on the #262 closing-claim shape, same rule as mergeReadiness", () => {
  const v = mergeSafetyVerdict({
    pr: pr(), behindBy: 0, closes: CLOSES_CLAIMED, session: "dispatcher", remoteHeadOid: "d5c2436601abcdef",
  });
  assert.equal(v.code, 1);
  assert.equal(reasonKind(v.reasons[0]), "CLAIMED_BY_ANOTHER_SESSION");
});

test("MUTATION target: mergeSafetyVerdict is CANNOT_ASK, never READY, when any of its three lookups is null", () => {
  const missingAncestry = mergeSafetyVerdict({
    pr: pr(), behindBy: null, closes: [], session: "ci", remoteHeadOid: "d5c2436601abcdef",
  });
  const missingCloses = mergeSafetyVerdict({
    pr: pr(), behindBy: 0, closes: null, session: "ci", remoteHeadOid: "d5c2436601abcdef",
  });
  const missingRemote = mergeSafetyVerdict({
    pr: pr(), behindBy: 0, closes: [], session: "ci", remoteHeadOid: null,
  });
  for (const v of [missingAncestry, missingCloses, missingRemote]) {
    assert.equal(v.code, 2, `expected CANNOT_ASK, got code ${v.code}: ${v.reasons.join(" | ")}`);
  }
});
