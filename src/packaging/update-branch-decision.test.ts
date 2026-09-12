// no-token: gh
//
// #827's declaration, and this file has the honest claim for it: every test here calls `updateBranchDecision`,
// `headQuietSeconds` or `newestConclusion`, all PURE over their arguments. The `gh` helper it declares lives
// in `update-branch-sweep.mjs:291`, an imported file this one does not control and never reaches -- and the
// rule is verified shallowly against this file's own text, which contains no `gh(` at all.
//
// WITHOUT IT THIS ROW'S OWN ACCEPTANCE COMMAND IS REFUSED. `pr-open` said so:
//
//     REFUSED npx tsx --test .../update-branch-decision.test.ts -> needs `token`, which this job does not
//     have -- requires token via updateBranchDecision -> update-branch-sweep.mjs:291
//
// Its sibling `update-branch-sweep.test.ts` has carried this same line since #1018 for the same reason, so
// the mechanism is the one already in use rather than an exemption invented for this row.
/**
 * A RUNNING GATE MAY MEAN "THE AUTHOR IS PUSHING RIGHT NOW" — #488.
 *
 * The sweep's predicate was *armed, gate green or still running, and behind main*. An author who has just
 * pushed a fix HAS a running gate, so the train synced under them, their next push was rejected
 * non-fast-forward, and they had to merge a commit the pipeline made on their behalf — twice on #485.
 * The hand rule is *"the author holds the branch while its check is red"*; this puts it in the predicate.
 *
 * ## Narrowing is the dangerous direction, so the mutations run that way
 *
 * A sweep that syncs too LITTLE is indistinguishable from a quiet queue — which is exactly how #498 hid
 * for hours while two green PRs went 16 and 6 commits behind. So the mutation that matters here is not
 * "does it skip a fresh head"; it is **does it still sync a quiet, behind, green-or-running head**. Both
 * directions are driven below.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { updateBranchDecision, headQuietSeconds, newestConclusion, HEAD_QUIET_SECONDS, ZERO_DATE,
  redCause, newestRun, newestRunCompletedAt, mainTipCommittedAt }
  from "../../../../scripts/update-branch-sweep.mjs";
import { NO_VERDICT } from "../../../../scripts/merge-guard/checks-rule.mjs";

const NOW = new Date("2026-09-08T09:00:00Z");
const decide = (gateConclusion: string | null, quietSeconds: number | null) =>
  updateBranchDecision({ armed: true, gateConclusion, behind: true, quietSeconds });

test("running + head quiet six minutes → UPDATE; a slow CI on a still head is the case to sync", () => {
  assert.equal(decide(null, 360).update, true);
});

test("running + head moved a minute ago → SKIP, and the reason names the elapsed time", () => {
  const d = decide(null, 60);
  assert.equal(d.update, false);
  assert.match(d.reason, /head moved 60s ago/,
    "a skip that does not say how long ago cannot be checked by the author it affects");
  assert.match(d.reason, /author mid-push holds their own branch/);
});

test("green + behind → UPDATE, unchanged, and the quiet window is NOT applied to it", () => {
  // A green gate means CI has finished, so nobody is mid-push. Narrowing this case would reintroduce
  // #498's stall by another route — and #498's cost was two green PRs invisible for hours.
  assert.equal(decide("SUCCESS", 1).update, true, "one second of quiet, green gate: still eligible");
});

// ---------------------------------------------------------------------------------------------------
// #1100: A RED, ARMED, BEHIND PR IS UPDATED — the skip that lived here was self-sustaining.
//
// The test that stood at this spot asserted `decide("FAILURE", 9999).update === false` and is REPLACED
// rather than deleted, because the behaviour it pinned is this row's subject: `gate = FAILURE` has two
// causes — red from what the PR changed, and red from what MAIN changed underneath it — the conclusion is
// identical in both, and the correct action is opposite.
//
// Measured on sweep run `34692306488` at 11:55:56Z: #1093 skipped here, its failure `not ok 357` from
// `claude-md-content-preservation.test.ts`, a file #1080 had DELETED from main at 11:27:11Z. **No fix the
// author could push** — the assertion did not exist to be satisfied — and the update that would clear it
// was refused because of the red it would clear.
// ---------------------------------------------------------------------------------------------------

test("#1100 ACCEPTANCE: an armed, behind PR with a FAILING gate is UPDATED", () => {
  const d = updateBranchDecision({ armed: true, gateConclusion: "FAILURE", behind: true, quietSeconds: 9999 });
  assert.equal(d.update, true,
    "the skip that used to live here could never be cleared: updating is the only action that clears a "
    + "red caused by the base, and it was refused BECAUSE OF that red");
});

test("#1100: `armed` still bounds the population — an UNARMED PR is skipped, red or green", () => {
  // The `armed` gate is deliberately untouched: it means a reviewer was convinced, which is what makes
  // the population small by construction. Updating unarmed PRs is a different and much larger change.
  for (const gateConclusion of ["FAILURE", "SUCCESS", null]) {
    const d = updateBranchDecision({ armed: false, gateConclusion, behind: true, quietSeconds: 9999 });
    assert.equal(d.update, false, `unarmed with gate ${gateConclusion} must still be skipped`);
    assert.match(d.reason, /not armed for auto-merge/,
      "and skipped FOR THAT REASON -- a skip that reports the wrong cause is how #498 hid for hours");
  }
});

test("#1100: a PR that is NOT behind is still skipped, red or green — nothing licenses an empty push", () => {
  // DELIBERATELY ONLY `update`. The reason this skip gives is asserted in the reason test below, not here,
  // and the split is not tidiness: the row's own mutation (restoring the gate skip) must leave THIS clause
  // passing, and an assertion on the reason string would make it fail -- under that mutation a not-behind
  // red PR is still skipped, correctly, but skipped one branch earlier and so for a different stated
  // cause. A clause that cannot survive the mutation it is paired against is measuring the wrong thing.
  for (const gateConclusion of ["FAILURE", "SUCCESS", null]) {
    const d = updateBranchDecision({ armed: true, gateConclusion, behind: false, quietSeconds: 9999 });
    assert.equal(d.update, false, `not behind with gate ${gateConclusion} must still be skipped`);
  }
});

test("#1100: the reason SAYS WHICH CASE it is in — a quieter path is a regression even when green", () => {
  // #498's real value was that its skip named the READING rather than only the verdict. The replacement
  // must not be quieter: "updated despite a red base" and "updated because behind and green" are
  // different events and the log must not spell them the same.
  const red = updateBranchDecision({ armed: true, gateConclusion: "FAILURE", behind: true, quietSeconds: 9999 });
  assert.match(red.reason, /gate = failure/,
    "the conclusion it saw, NORMALISED, not a summary of it");
  assert.match(red.reason, /UPDATED ANYWAY/, "and that this is the deliberate new path, not the old one");
  assert.match(red.reason, /if it CLEARS, the red was the base's/,
    "and what the next reading MEANS -- the update is the instrument that tells the two causes apart, "
    + "which is the whole argument for doing it");
  assert.match(red.reason, /author owns the fix/,
    "#498 is relocated, not overruled: a red that survives an update is still the author's");

  const green = updateBranchDecision({ armed: true, gateConclusion: "SUCCESS", behind: true, quietSeconds: 9999 });
  assert.doesNotMatch(green.reason, /UPDATED ANYWAY|failure/i,
    "and the ordinary green update must not borrow the red path's words, or the log stops distinguishing "
    + "them and this test is the only place that ever did");

  // AND EACH SKIP STILL NAMES ITS OWN CAUSE, which is the property moved out of the not-behind clause
  // above so that clause survives this row's own mutation. A skip reporting the wrong cause is how #498
  // hid for hours: the log read as work correctly handed back rather than as the sweep being wrong.
  assert.match(updateBranchDecision({ armed: true, gateConclusion: "FAILURE", behind: false, quietSeconds: 9999 })
    .reason, /nothing to update/,
  "a red PR that is already up to date is skipped for being up to date, not for being red");
});

test("#1100: a CANCELLED gate is NO VERDICT, not a red — and the update would have created it", () => {
  // worker-judge's blocker, and it is the one I would have shipped. `ci.yml:119` is
  // `cancel-in-progress: true`, so a push to main that supersedes a run leaves the gate CANCELLED.
  // Measured on runs `34693906245`, `34693717423`, `34693471314` -- all three `gate: conclusion=cancelled`
  // -- and `"cancelled" !== "SUCCESS"`, so it fell into the update-anyway branch and was logged as a red.
  //
  // **THE ACTION PRODUCES THE STATE IT MISREADS**: main moves, the run is cancelled, the gate reads red,
  // this updates, a new run starts, main moves again. The red neither CLEARS nor PERSISTS -- it is
  // REPLACED -- so the instrument this row rests on has no reading for it, and the update destroys the
  // run whose verdict would have answered the question. 5 of the last 40 ci runs were cancelled.
  const cancelled = updateBranchDecision({
    armed: true, gateConclusion: "cancelled", behind: true, quietSeconds: 9999 });
  assert.equal(cancelled.update, true, "a superseded run is not a reason to hold a behind PR");
  assert.doesNotMatch(cancelled.reason, /UPDATED ANYWAY|red has two causes/,
    "but it must NOT be described as a red -- `checks-rule.mjs` already ruled this string NO VERDICT "
    + "(#1007) and two predicates meaning different things by the same conclusion is the defect");
  assert.match(cancelled.reason, /NO VERDICT/, "the reason must say what it actually read");

  // AND IT TAKES THE NO-VERDICT PATH, which is what breaks the loop: an author mid-push still holds
  // their branch, exactly as for a gate that is still running.
  assert.equal(updateBranchDecision({
    armed: true, gateConclusion: "cancelled", behind: true, quietSeconds: 10 }).update, false,
  "a cancelled gate inside the quiet window is held, like a running one -- a replacement run is going");
});

test("#1100: THE PRODUCTION VOCABULARY — statusCheckRollup's UPPER spelling reaches the same decision", () => {
  // THE BLOCKER, AND MY TEST WAS THE REASON IT SHIPPED GREEN. `updateBranchDecision` is fed from
  // `gh pr list --json statusCheckRollup`, which spells conclusions UPPER; `checks-rule.mjs` is fed from
  // `gh api .../check-runs`, which spells them lower. My fixture was written in the SECOND vocabulary, so
  // the imported lowercase `NO_VERDICT` never matched the uppercase value production supplies: the branch
  // was dead and the file read as though it were closed. **A correct value read from the wrong place.**
  //
  // Measured at the same moment on this repository:
  //
  //     gh pr list --json statusCheckRollup      #1107: COMPLETED/FAILURE   #1104: COMPLETED/SUCCESS
  //     gh api .../commits/<head>/check-runs      completed/success
  //
  // Driven in BOTH vocabularies and asserted to AGREE, because a predicate correct only for the spelling
  // its usual caller happens to use is exactly what shipped once.
  for (const [upper, lower] of [["CANCELLED", "cancelled"], ["FAILURE", "failure"], ["SUCCESS", "success"]]) {
    const fromRollup = updateBranchDecision({
      armed: true, gateConclusion: upper, behind: true, quietSeconds: 9999 });
    const fromRest = updateBranchDecision({
      armed: true, gateConclusion: lower, behind: true, quietSeconds: 9999 });
    assert.deepEqual(fromRollup, fromRest,
      `\`${upper}\` and \`${lower}\` are the same verdict in two APIs and must reach the same decision`);
  }

  // AND THE ONE THAT MATTERED: the uppercase cancelled must NOT be described as a red.
  const cancelled = updateBranchDecision({
    armed: true, gateConclusion: "CANCELLED", behind: true, quietSeconds: 9999 });
  assert.doesNotMatch(cancelled.reason, /UPDATED ANYWAY|red has two causes/,
    "this is the exact line the fix was written to stop printing, and the production spelling is the one "
    + "that was still printing it");
  assert.match(cancelled.reason, /NO VERDICT/);

  // AND THE NORMALISATION IS AT THE EDGE, where the other two spellings of absence are already collapsed.
  assert.equal(newestConclusion(
    [{ name: "gate", conclusion: "CANCELLED", completedAt: "2026-09-12T12:00:00Z" }],
    "gate"), NO_VERDICT,
  "`newestConclusion` must hand the decision one vocabulary -- `gh` spells absent three ways across its "
  + "own sources and case is the third");
});

test("#1100: the ruling on `cancelled` is IMPORTED from checks-rule, never restated", () => {
  // The whole point of the fix: one fact, one place. A second copy of the string here is the
  // fact-stated-twice shape on a value that decides whether a pull request is pushed.
  assert.equal(NO_VERDICT, "cancelled", "if this ever changes, both readers change together");
  const byConst = updateBranchDecision({
    armed: true, gateConclusion: NO_VERDICT, behind: true, quietSeconds: 9999 });
  assert.match(byConst.reason, /NO VERDICT/,
    "the decision must route on the IMPORTED constant, so a rename in checks-rule.mjs cannot leave this "
    + "file reading a string nothing produces any more");
});

test("#1100: a CONCLUDED failing gate does not wait on the quiet window", () => {
  // The window guards an author mid-push (#488). A concluded gate -- green or red -- means CI has
  // finished, so nobody is mid-push; the existing code already reasons that way for SUCCESS and this
  // keeps the two consistent rather than inventing a third rule. NOT a widening of the window: the
  // running-gate case below is untouched.
  assert.equal(updateBranchDecision({ armed: true, gateConclusion: "FAILURE", behind: true, quietSeconds: 1 })
    .update, true, "one second of quiet, concluded red gate: still eligible");
  assert.equal(updateBranchDecision({ armed: true, gateConclusion: null, behind: true, quietSeconds: 1 })
    .update, false, "and a RUNNING gate one second after a push is still held -- the window is untouched");
});

test("THE BOUNDARY IS INCLUSIVE AT 300s — 299 skips, 300 and 301 update", () => {
  // Said in a test rather than left to whoever next reads `<` versus `>=`.
  assert.equal(decide(null, 299).update, false);
  assert.equal(decide(null, HEAD_QUIET_SECONDS).update, true);
  assert.equal(decide(null, 301).update, true);
});

test("a head that cannot say when it appeared is REFUSED, not assumed quiet", () => {
  const d = decide(null, null);
  assert.equal(d.update, false);
  assert.match(d.reason, /NOTHING ON THE HEAD SAYS WHEN IT APPEARED/);
  // The asymmetry is the argument: waiting a cycle costs a cycle; pushing under an author costs them a
  // rejected push and a merge they did not make.
  assert.match(d.reason, /cost of waiting a cycle is a cycle/);
});

/**
 * THE ZERO DATE AND THE EMPTY CONCLUSION — found by driving the real API for this row, and they are
 * #498's own defect surviving its own fix.
 *
 * GitHub reports an IN_PROGRESS check run as `completedAt: "0001-01-01T00:00:00Z"` and `conclusion: ""` —
 * neither of which is null. Recorded 2026-09-08 from PR #505:
 *
 *     {"name":"arm","status":"IN_PROGRESS","startedAt":"2026-09-08T08:50:31Z",
 *      "completedAt":"0001-01-01T00:00:00Z","conclusion":""}
 *
 * `??` does not treat a zero date as missing, so a still-running run sorted as the OLDEST thing on the
 * head and lost to any completed one — including exactly the stale failure #498 was written to stop
 * winning. This lands where #488 lives: an author who has just pushed HAS a running gate.
 */
test("a RUNNING newest gate beats a completed older failure — the zero date is absence", () => {
  const runs = [
    { name: "gate", conclusion: "FAILURE", completedAt: "2026-09-08T07:32:37Z", startedAt: "2026-09-08T07:30:00Z" },
    { name: "gate", conclusion: "", completedAt: "0001-01-01T00:00:00Z", startedAt: "2026-09-08T08:50:31Z" },
  ];
  assert.equal(newestConclusion(runs, "gate"), null,
    "the newest run is IN_PROGRESS, so there is no verdict yet — not the older FAILURE, and not the "
    + "empty string, which `updateBranchDecision` would read as 'not SUCCESS' and skip as failing");
});

test("#500's own measured case still reads SUCCESS — this fix does not undo that one", () => {
  assert.equal(newestConclusion([
    { name: "gate", conclusion: "FAILURE", completedAt: "2026-09-08T07:32:35Z" },
    { name: "gate", conclusion: "SUCCESS", completedAt: "2026-09-08T07:35:34Z" },
  ], "gate"), "success",
  "#1100: the fixture keeps the API's own UPPER spelling and the expectation is normalised -- the ordering "
  + "this test is about is unchanged, only the vocabulary downstream of it");
});

test("quiet time comes from the OLDEST check-run start, and a zero date is not a start", () => {
  // The oldest start is the closest thing on the head to "when this head appeared": later runs are
  // re-runs. A commit's own author/committer date is supplied by the pusher's machine and can precede
  // the push by days, which would read as quiet the instant it arrived — the opposite of the protection.
  const quiet = headQuietSeconds([
    { startedAt: "2026-09-08T08:50:00Z" },
    { startedAt: "2026-09-08T08:58:00Z" },
    { startedAt: "0001-01-01T00:00:00Z" },
  ], NOW);
  assert.equal(quiet, 600, "08:50 is the oldest real start; the zero date is not a start at all");
});

test("no start times anywhere → null, never a number", () => {
  assert.equal(headQuietSeconds([], NOW), null);
  assert.equal(headQuietSeconds(null, NOW), null);
  assert.equal(headQuietSeconds([{ startedAt: "0001-01-01T00:00:00Z" }], NOW), null,
    "a head whose only timestamp is the zero date cannot be shown to be quiet");
});

test("the SUCCESS reason names the quiet window when that is why the PR was eligible", () => {
  // The window is this change's whole subject, so a sync that happens BECAUSE of it must say so. #498's
  // failure read from the other side: there the SKIP line named the author instead of the reading, and
  // the log could not falsify it. This is the line somebody reads when they ask "why did it push under
  // me?", and an unasserted log line is a comment.
  const d = decide(null, 412);
  assert.equal(d.update, true);
  assert.match(d.reason, /quiet 412s, over the 300s window/);
});

test("a GREEN gate's success reason does NOT claim a quiet window it did not use", () => {
  // Green skips the window entirely, so mentioning it would be a reason that is not the reason -- the
  // shape where a message describes a check that never ran.
  assert.doesNotMatch(decide("SUCCESS", 1).reason, /quiet/);
});

test("ZERO_DATE is one const, shared by both readers of 'has this run finished'", () => {
  // It was defined twice, in a file whose morning was about one fact written in two places. Asserted
  // rather than trusted: the next person to learn GitHub emits some other sentinel must have one place
  // to change, or the two readers disagree about whether a run is running.
  assert.equal(ZERO_DATE, "0001-01-01T00:00:00Z");
  assert.equal(newestConclusion(
    [{ name: "gate", conclusion: "", completedAt: ZERO_DATE, startedAt: "2026-09-08T09:00:00Z" }],
    "gate"), null);
  assert.equal(headQuietSeconds([{ startedAt: ZERO_DATE }], NOW), null);
});

/**
 * #1126: A RED'S CAUSE IS DECIDABLE FROM TIME, BEFORE THE UPDATE.
 *
 * #1100 made an armed, behind, red PR updatable on the argument that the update is the only instrument
 * separating a red caused by the BASE from one caused by the PR's own contents. Sound, and *post hoc*:
 * you learn the cause by watching whether it clears. worker-judge's point on that review is that the
 * discriminator already exists and is not the conclusion — **a red whose newest `gate` run completed
 * BEFORE main's current tip landed cannot have been evaluated against current main.** That is "red
 * because of the base" stated positively instead of guessed.
 *
 * The verdict does not change: both classified cases still UPDATE. #498's rule lives on this path and a
 * sweep that syncs too little is indistinguishable from a quiet queue. What changes is what the line says.
 */
const RED = { armed: true, gateConclusion: "FAILURE", behind: true, quietSeconds: 9999 };

test("#1126 clause 1: a gate that concluded BEFORE main's tip landed is the BASE's red, and says so", () => {
  const decision = updateBranchDecision({ ...RED,
    gateCompletedAt: "2026-09-12T10:00:00Z", mainTipAt: "2026-09-12T11:00:00Z" });
  assert.equal(decision.update, true, "a classified red still updates -- the verdict must not become a refusal");
  assert.match(decision.reason, /THE BASE'S/);
  assert.match(decision.reason, /determined rather than guessed/);
  // The post-hoc sentence must be GONE, not merely joined: leaving it would say both "we determined it"
  // and "we will find out", and a log line that states a finding and a plan for the same fact is the one
  // nobody can act on.
  assert.doesNotMatch(decision.reason, /if it CLEARS/);
});

test("#1126 clause 2: a gate that concluded AFTER main's tip landed is the PR's OWN red, and still updates", () => {
  const decision = updateBranchDecision({ ...RED,
    gateCompletedAt: "2026-09-12T11:30:00Z", mainTipAt: "2026-09-12T11:00:00Z" });
  assert.equal(decision.update, true,
    "#498: being current is not the author's job to arrange, so this is NOT a refusal");
  assert.match(decision.reason, /THIS PR'S OWN/);
  assert.match(decision.reason, /the author owns the fix/);
  assert.doesNotMatch(decision.reason, /if it CLEARS/);
});

test("#1126 clause 3: timing that cannot be READ is neither cause, and keeps #1100's sentence", () => {
  // "Could not ask" and "the answer is no" must not render the same -- the distinction this file already
  // draws for `quietSeconds` and `ZERO_DATE`. When the timing is unreadable the experiment really IS the
  // only instrument, so the post-hoc reason is not a fallback here, it is the correct answer.
  for (const [label, input] of [
    ["no gate completion stamp", { gateCompletedAt: null, mainTipAt: "2026-09-12T11:00:00Z" }],
    ["git could not answer", { gateCompletedAt: "2026-09-12T10:00:00Z", mainTipAt: null }],
    ["neither", { gateCompletedAt: null, mainTipAt: null }],
    ["an unparseable stamp", { gateCompletedAt: "not a date", mainTipAt: "2026-09-12T11:00:00Z" }],
  ] as const) {
    const decision = updateBranchDecision({ ...RED, ...input });
    assert.equal(decision.update, true, label);
    assert.match(decision.reason, /CANNOT BE READ/, label);
    assert.match(decision.reason, /if it CLEARS/, `${label}: #1100's sentence is kept verbatim here`);
    assert.doesNotMatch(decision.reason, /determined rather than guessed/, label);
  }
});

test("#1126 clause 4: NO_VERDICT is untouched -- a cancelled gate still takes the wait path", () => {
  // The discriminator applies only to a conclusion that is a verdict ABOUT THE HEAD. #1007 ruled a
  // cancelled run joins the WAIT and never `failing`, and supplying timestamps must not reclassify it.
  const decision = updateBranchDecision({ armed: true, gateConclusion: NO_VERDICT, behind: true,
    quietSeconds: 9999, gateCompletedAt: "2026-09-12T10:00:00Z", mainTipAt: "2026-09-12T11:00:00Z" });
  assert.doesNotMatch(decision.reason, /THE BASE'S|THIS PR'S OWN/,
    "a cancelled gate carries no verdict to attribute, so it must not be attributed");
});

test("#1126: redCause returns THREE answers, and the third is not a verdict", () => {
  assert.equal(redCause({ gateCompletedAt: "2026-09-12T10:00:00Z", mainTipAt: "2026-09-12T11:00:00Z" }), "base");
  assert.equal(redCause({ gateCompletedAt: "2026-09-12T12:00:00Z", mainTipAt: "2026-09-12T11:00:00Z" }), "its own");
  assert.equal(redCause({ gateCompletedAt: null, mainTipAt: "2026-09-12T11:00:00Z" }), null);
  assert.equal(redCause({ gateCompletedAt: "2026-09-12T10:00:00Z", mainTipAt: null }), null);
  assert.equal(redCause({ gateCompletedAt: "rubbish", mainTipAt: "2026-09-12T11:00:00Z" }), null);
  // COMPARED AS INSTANTS, NEVER AS STRINGS. `git log --format=%cI` emits a local offset and GitHub emits
  // `Z`; lexicographically "2026-09-12T11:30:00+02:00" sorts AFTER "2026-09-12T10:00:00Z" while being
  // 09:30Z — earlier. A string comparison would report "its own" for a red the base caused.
  assert.equal(redCause({ gateCompletedAt: "2026-09-12T10:00:00Z", mainTipAt: "2026-09-12T11:30:00+02:00" }),
    "its own", "09:30Z tip is BEFORE the 10:00Z gate, so the red is the PR's own despite the string order");
});

test("#1126: the conclusion and the timestamp come from the SAME run", () => {
  // Two scans for "the newest run" could disagree on a head whose runs tie or carry no stamps, and the
  // verdict would then be dated by a run that did not produce it. One scan, both readers.
  const runs = [
    { name: "gate", conclusion: "SUCCESS", completedAt: "2026-09-12T09:00:00Z", startedAt: "2026-09-12T08:00:00Z" },
    { name: "gate", conclusion: "FAILURE", completedAt: "2026-09-12T10:00:00Z", startedAt: "2026-09-12T09:30:00Z" },
  ];
  assert.equal(newestConclusion(runs, "gate"), "failure");
  assert.equal(newestRunCompletedAt(runs, "gate"), "2026-09-12T10:00:00Z");
  assert.equal(newestRun(runs, "gate")?.conclusion, "FAILURE", "the same run answers both");
});

test("#1126: a still-running newest gate has NO completion time -- startedAt must not stand in", () => {
  // Reading a start as an end dates a verdict earlier than it exists, which in this comparison is the
  // direction that wrongly reports "the base did it". The zero date is absence wearing a timestamp.
  const running = [{ name: "gate", conclusion: "", completedAt: ZERO_DATE, startedAt: "2026-09-12T08:00:00Z" }];
  assert.equal(newestRunCompletedAt(running, "gate"), null);
  assert.equal(newestRunCompletedAt([{ name: "gate", conclusion: "", startedAt: "2026-09-12T08:00:00Z" }], "gate"), null);
});

test("#1126: mainTipCommittedAt distinguishes a git FAILURE from an empty answer", () => {
  assert.equal(mainTipCommittedAt(() => ({ status: 0, stdout: "2026-09-12T11:00:00+01:00\n" })),
    "2026-09-12T11:00:00+01:00");
  assert.equal(mainTipCommittedAt(() => ({ status: 1, stdout: "" })), null, "a failed git is not an answer");
  assert.equal(mainTipCommittedAt(() => ({ status: 0, stdout: "" })), null, "and neither is an empty one");
  // The failure path returns no `stdout` key at all; reading it must still be null rather than throwing.
  assert.equal(mainTipCommittedAt(() => ({ status: 128 })), null);
});

test("#1126: the readers added to bounded-window-reads' NAMES_ITS_WINDOW actually narrow", () => {
  // A name on that list is a claim about behaviour. Proved here the way `newestConclusionOf` is proved
  // above: a rollup carrying a SUPERSEDED failure alongside a current success must yield the current one,
  // in either array order, because the rollup's order is not documented to be chronological.
  const rollup = [
    { name: "gate", conclusion: "FAILURE", completedAt: "2026-09-12T09:00:00Z", startedAt: "2026-09-12T08:00:00Z" },
    { name: "gate", conclusion: "SUCCESS", completedAt: "2026-09-12T10:00:00Z", startedAt: "2026-09-12T09:30:00Z" },
    { name: "ts", conclusion: "FAILURE", completedAt: "2026-09-12T10:05:00Z", startedAt: "2026-09-12T10:00:00Z" },
  ];
  for (const order of [rollup, [...rollup].reverse()]) {
    assert.equal(newestRun(order, "gate")?.conclusion, "SUCCESS",
      "the superseded FAILURE must not win, in either order");
    assert.equal(newestRunCompletedAt(order, "gate"), "2026-09-12T10:00:00Z");
  }
  assert.equal(newestRun(rollup, "absent"), null, "a name with no runs is null, not the newest of another name");
  assert.equal(newestRunCompletedAt(rollup, "absent"), null);
});
