// @ts-check
/**
 * A HOLD MEANS "CANNOT MERGE", AND ONE PLACE DECIDES WHETHER A PR IS HELD.
 *
 * #645. On 2026-09-09 a ruling changed an open PR's required shape at 09:05Z and `auto-arm` merged the
 * pre-correction commit at 09:16Z. The proposed remedy was `pr:hold`, on the stated ground that the queue
 * already refuses a held PR. **Demonstrating that instead of citing it is what found the hole**, and
 * there were three:
 *
 *   1. `auto-arm-sweep.mjs` refuses to ARM a held PR. True — and it is the only place that does.
 *   2. `auto-arm.yml`'s per-PR `arm` job gates on `draft == false && base.ref == 'main'` and NOTHING
 *      else, then runs `gh pr merge --auto` unconditionally. It re-arms a held PR on its next event.
 *   3. **Nothing disarms.** `git grep "disable-auto"` over the whole tree was EMPTY. Once auto-merge is
 *      enabled GitHub completes it the moment the required checks go green, and no label is consulted at
 *      that point — by GitHub or by us.
 *
 * So a hold taken at 09:05 on a PR armed at 09:00 changes a label and nothing else. **The hold stopped
 * ARMING; the actor to stop was MERGING-ONCE-ARMED.** The mechanism would have been ruled, built,
 * believed, and silent on the exact incident it was written for.
 *
 * ## Why this module exists rather than a second `if`
 *
 * The hole opened because *"is this PR held"* was written twice and only one copy was correct. Adding the
 * missing check to the `arm` job would make it two correct copies, which is the same shape with a longer
 * fuse — this repository's own most-recorded defect, and `sweepDecision`'s own header already says why a
 * predicate must not live in `run:` bash. So both callers read this.
 */

/**
 * THE LABEL PREFIX THAT IS A HOLD ON A PR. Exported, because it is now the ONLY spelling: three copies
 * of the old one were what made this rename a rename rather than an edit.
 *
 * IT WAS `session:` UNTIL 2026-09-09, AND THAT WAS ONE WORD DOING TWO JOBS. `session:<name>` also means
 * OWNERSHIP — who is working on a row, and, since ceo's 12:2xZ ruling, who opened a PR. orchestrator
 * applied `session:orchestrator` by hand to twelve PRs that day to mark them as theirs, and every one of
 * them was, as far as this file was concerned, HELD. Eleven merged anyway, which is a separate finding;
 * the point here is that the collision made "held" unreadable, and #725 was about to apply the label to
 * every armed PR in the org.
 *
 * A `session:` label on a PR is never consulted by the hold path again (ceo, 2026-09-09). Rows keep
 * `session:` — `row-claim.mjs` and `ready-label-audit.mjs` are unchanged and MUST stay that way, which
 * is why this constant is not shared with them.
 *
 * WHAT THIS RENAME DOES NOT DO: it does not make a hold stop a MERGE. The hold is enforced at ARM time —
 * `pr-hold` disarms when it takes the hold, and `armabilityOf` below stops anything re-arming. Nothing in
 * the required `gate` context consults a label: `merge-guard.mjs --ci-gate` calls `mergeSafetyVerdict`,
 * which reads head-vs-tip and nothing else. So a hold placed on an ALREADY-ARMED PR still stops nothing,
 * before this rename and after it. Recorded here rather than left to be discovered, because a reader who
 * sees a namespace built for holds will reasonably assume the holds are enforced.
 */
export const HOLD_PREFIX = "hold:";

/**
 * Who is holding this PR, if anybody.
 * @param {string[]} labels
 * @returns {string[]}
 */
export function holdersOf(labels) {
  return labels.filter((l) => l.startsWith(HOLD_PREFIX));
}

/**
 * May anything ARM this PR? One answer for the sweep and for the per-PR job.
 *
 * `reason` NAMES THE RULING, NOT THE STATE, when one was recorded. "Held" sends a reader to the label;
 * "held by ceo's ruling of 09:05Z — the guard keys on the field name, not the path" sends them to the
 * thing they must do. Two different faults must not print the same word, and two different REASONS for
 * one state must not either.
 *
 * @param {{ labels: string[], holdReason?: string | null }} pr
 * @returns {{ arm: boolean, reason: string }}
 */
export function armabilityOf({ labels, holdReason = null }) {
  const holders = holdersOf(labels);
  if (holders.length === 0) return { arm: true, reason: "not held" };
  return {
    arm: false,
    reason: holdReason
      ? `held by ${holders.join(", ")}: ${holdReason}`
      : `held by ${holders.join(", ")} -- on a PR the \`${HOLD_PREFIX}\` label IS the hold (#266), and no `
        + "reason was recorded with it. A hold whose reason nobody wrote down is one the next person "
        + "carrying this PR current will drop in good faith",
  };
}

/**
 * THE LABEL THAT SAYS THE HOLD IS WHAT DISARMED THIS PR.
 *
 * `takeHold` disarms unconditionally, so on release the two states it must tell apart -- "this PR was
 * armed and I turned it off" and "this PR was never armed" -- have the same end state and are gone by
 * the time anyone releases. The take records which one it found, because the release cannot recover it,
 * and re-arming a PR nobody armed would be arming in the dangerous direction.
 *
 * A LABEL rather than anything in this process, because the take and the release are different
 * processes, often different sessions, often hours apart. The PR is the only thing both can read.
 */
export const REARM_LABEL = "rearm-on-release";

/**
 * HAS THIS PR ALREADY MERGED? Both verdicts need it, and neither could see it before 2026-09-09.
 *
 * `state` comes back `MERGED` from `gh pr view --json state` and `closed` from REST's `pulls/N`, which is
 * why both spellings are checked and why REST's `merged` boolean is preferred when present: `closed`
 * alone does not distinguish a merged PR from one somebody shut.
 *
 * @param {{ state?: unknown, merged?: unknown } | null | undefined} pr
 * @returns {boolean}
 */
function isMerged(pr) {
  if (pr?.merged === true) return true;
  return String(pr?.state ?? "").toUpperCase() === "MERGED";
}

/**
 * ARM IS VERIFIED FROM THE STATE, NEVER THE EXIT CODE -- the mirror of `disarmVerdict` below, and it
 * exists because arming has the SAME asymmetry pointed the other way.
 *
 * `gh pr merge --auto --squash` returned `Merge method squash merging is not allowed on this repository`
 * on 2026-09-09 and the caller saw only a non-zero exit, because stderr was redirected; the PR sat
 * UNARMED with nothing in the log, and an unarmed PR is indistinguishable from an armed one until the
 * queue fails to take it. Reading `autoMergeRequest` back is what caught it.
 *
 * @param {{ autoMergeRequest?: unknown, state?: unknown, merged?: unknown } | null} prAfterArm
 * @returns {{ armed: boolean, reason: string }}
 */
export function armVerdict(prAfterArm) {
  // MERGED IS NOT UNARMED, the mirror of the rule in `disarmVerdict` below. A PR that merged between the
  // arm and the read-back has a null `autoMergeRequest`, and reporting that as "still unarmed" sends the
  // operator to re-arm something that has already landed. Wrong in the alarming direction rather than the
  // dangerous one, but wrong, and the fix is the same field.
  if (isMerged(prAfterArm)) {
    return { armed: true, reason: "it MERGED -- auto-merge did its job between the arm and this read, "
      + "which is why `autoMergeRequest` reads null" };
  }
  if (prAfterArm?.autoMergeRequest != null) {
    return { armed: true, reason: "auto-merge is back on: `autoMergeRequest` reads non-null" };
  }
  return {
    armed: false,
    reason: "THE HOLD IS OFF AND THE PR IS STILL UNARMED. The hold disarmed it and the release did not "
      + "put it back, so it will sit green and unmerged with nothing marking it as waiting -- a hold "
      + "that outlived its reason, and invisible, which is the pair this file exists to prevent. Re-arm "
      + "by hand with `gh pr merge --auto --merge <n>` and read `autoMergeRequest` back.",
  };
}

/**
 * Did the disarm actually take? **READ THE STATE, NEVER THE EXIT CODE.**
 *
 * `gh pr merge --disable-auto` returns success on a PR that is already merging, having changed nothing —
 * a verification sharing a failure mode with the action, which this repository has paid for before:
 * reading a guest's hash through the same `exec` channel that was broken returned EMPTY rather than
 * MISMATCHED, and empty read as a flaky tool rather than a failed deploy.
 *
 * A hold that labelled and failed to disarm is the most dangerous of the three states, because it LOOKS
 * held.
 *
 * @param {{ autoMergeRequest?: unknown, state?: unknown, merged?: unknown } | null} prAfterDisarm
 *   as read back from the API
 * @returns {{ disarmed: boolean, reason: string }}
 */
export function disarmVerdict(prAfterDisarm) {
  // MERGED IS NOT DISARMED, AND THIS IS THE ONE THAT WOULD HAVE HURT. `autoMergeRequest` reads null on a
  // MERGED PR as surely as on a disarmed one -- measured on #845 at 17:25:53Z, where `arm-pr` said
  // "armed", the PR merged four seconds later, and three separate reads then reported NOT-ARMED. Both
  // fields are null and neither says why.
  //
  // Read as "disarmed", that makes `takeHold` print `#N is now held by X` about a PR that has already
  // merged: a hold reported as successful over something nobody can hold any more. Wrong in the
  // reassuring direction, which is the only direction that matters in a state somebody acts on.
  if (isMerged(prAfterDisarm)) {
    return { disarmed: false, reason: "THIS PR HAS ALREADY MERGED, so there is nothing to hold. "
      + "`autoMergeRequest` reads null on a merged PR exactly as it does on a disarmed one, and treating "
      + "that as a successful disarm would report a hold over something that no longer exists." };
  }
  if (prAfterDisarm?.autoMergeRequest == null) {
    return { disarmed: true, reason: "auto-merge is off: `autoMergeRequest` is null" };
  }
  return {
    disarmed: false,
    reason: "THE LABEL IS ON AND AUTO-MERGE IS STILL ARMED. This PR will merge the moment its checks go "
      + "green, and it now LOOKS held to anyone reading the label. Disarm it by hand with "
      + "`gh pr merge --disable-auto <n>` and read `autoMergeRequest` back, or remove the label so the "
      + "state is at least honest.",
  };
}
