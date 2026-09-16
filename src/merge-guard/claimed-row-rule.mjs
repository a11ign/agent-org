#!/usr/bin/env node
// @ts-check
// RULE: WOULD ARMING THIS PR CLOSE A ROW SOMEBODY ELSE IS INSIDE? -- #249.
//
// `row-claim check` runs before a worker DISPATCHES or STARTS a row; nothing ran before a PR closing that
// row was ARMED, and arming is the act that actually closes it. Measured 2026-09-07: PR #245 was armed
// while the row it closed (#237) carried `in-progress`, `session:worker-judge`, `started` -- a second,
// independent fix on that row was discarded. Ninth dispatch collision that night, seventh from the
// dispatcher, who had been the one running `row-claim check` correctly at the OTHER end of the loop every
// time.
//
// So this rule asks GitHub what a PR would close (`closingIssuesReferences` -- resolved server-side, never
// a `Closes #N` regex over the PR body, see `lookups.mjs`) and reuses `row-claim.mjs`'s own claim
// predicate, `decideClaim`, rather than re-deriving "is this row somebody else's" a second time.
// `decideClaim` already draws the one line this needs: resuming your OWN claimed row is not a collision,
// which is why `session` exists here -- the identity of whoever is running this check, compared against
// the `session:*` label on each row it would close. Omit it and every claimed row it would close reads as
// somebody else's, which is the conservative default: a check that does not know who is asking cannot
// vouch for the asker.
//
// NOT A POLICY CHANGE ABOUT WHO MAY ARM. A dispatcher who has confirmed with the row's holder should be
// able to proceed, and `--allow-claimed-close=<name>` is that escape hatch -- printed, never silent, the
// same shape `--allow-stale-workers` already uses elsewhere in this repo, because a bypass nobody can see
// is one that becomes the default.
//
// MEASURED 2026-09-07, the day this landed: it fires on 10 of 13 open PRs' armings, and in every one of
// the 10 the row's claimant IS the PR's author (#262->#249, #259->#247, #258->#244, #257->#246, #232->#189,
// #229->#223, #181->#155, #172->#159, #150->#123 -- only #238/#195/#183/#148 close nothing). The real
// incident this row exists for was the OPPOSITE shape -- one session's branch closing a DIFFERENT session's
// row -- and it is 0 of these 10. `session` cannot see PR authorship (every session pushes as the same
// GitHub identity, so there is no author field to compare against the claimant), which is why this fires
// on the safe case as often as the dangerous one: the identity it compares is the only one that exists.
//
// So `--allow-claimed-close` takes a REQUIRED value naming who you confirmed with --
// `--allow-claimed-close=<session>` -- rather than a bare boolean, and it is CHECKED, not merely printed:
// it overrides a row's collision reason only when the named session is among that row's REAL claimant
// sessions, read fresh off GitHub the same way `session` is. A name that does not match any actual
// claimant on the row being closed leaves that reason refused -- turning "I confirmed" from an honor
// system into a claim this tool can verify against the same labels `decideClaim` already reads.
import { claimStatus, decideClaim } from "../row-claim.mjs";
import { reasonKind } from "./reason-kind.mjs";

// `--allow-claimed-close=<name>`'s OWN argv PARSING stays in `merge-guard.mjs`, not here, deliberately.
// This file reads only the already-extracted VALUE (a plain string or null) -- never `process.argv`
// itself -- so it is a pure function of facts, the same discipline every other rule module follows, and
// so it does not become a second CLI entry point `cli-flags.test.ts`'s argv-reading census has to track.
// `merge-guard.mjs` already reads argv and already calls `refuseUnknownFlags` for the whole command.

/**
 * @param {{number: number, title?: string, labels: string[]}[]} closes
 * @param {string | null} session
 * @returns {string[]}
 */
export function closingClaimReasons(closes, session) {
  const reasons = [];
  for (const issue of closes) {
    const decision = decideClaim(issue.labels, session ?? "");
    if (!decision.proceed) {
      reasons.push(`WOULD CLOSE #${issue.number}${issue.title ? ` "${issue.title}"` : ""}, but `
        + `${decision.reason}.\n`
        + "  Arming this PR closes that row whether or not you hold it. Confirm with whoever does, or\n"
        + "  wait -- or pass `--allow-claimed-close=<their session>` if you have already confirmed.");
    }
  }
  return reasons;
}

/**
 * WHICH rows does `--allow-claimed-close=<confirmedWith>` actually cover? -- the check that makes the
 * flag a verifiable claim rather than an honor system.
 *
 * A row is covered when `confirmedWith` is among the REAL claimant sessions read from its own labels
 * (`claimStatus`, the same reader `decideClaim` uses) -- never merely because the flag was passed. A name
 * typed on the command line that does not match any actual claimant on the row being closed covers
 * nothing, so that row's collision reason stays refused.
 *
 * @param {{number: number, labels: string[]}[]} closes
 * @param {string} confirmedWith
 * @returns {Set<number>} issue numbers this confirmation actually covers
 */
export function claimedCloseCoveredBy(closes, confirmedWith) {
  const covered = new Set();
  for (const issue of closes) {
    const status = claimStatus(issue.labels);
    if (status.claimed && status.sessions.includes(confirmedWith)) covered.add(issue.number);
  }
  return covered;
}

/**
 * Split a verdict's reasons into what `--allow-claimed-close=<name>` overrides and what survives it --
 * only rows `name` actually holds (`claimedCloseCoveredBy`), never any other refusal.
 *
 * No exit-code check against the caller's verdict: `reasonKind(reason) === "CLAIMED_BY_ANOTHER_SESSION"`
 * already narrows to exactly this rule's own "WOULD CLOSE #" sentences, which a CANNOT_ASK verdict's
 * lookup-failure message can never match -- so filtering by reason shape alone is already precise, without
 * this module needing to know the composed verdict's own exit-code table.
 *
 * @param {{reasons: string[]}} verdict
 * @param {{number: number, labels: string[]}[]} closes
 * @param {string | null} allowClaimedClose
 * @returns {{overridden: string[], remaining: string[]}}
 */
export function applyAllowClaimedClose(verdict, closes, allowClaimedClose) {
  const covered = allowClaimedClose ? claimedCloseCoveredBy(closes, allowClaimedClose) : new Set();
  const issueNumberOf = (/** @type {string} */ reason) => {
    const m = /^WOULD CLOSE #(\d+)/.exec(reason);
    return m ? Number(m[1]) : null;
  };
  const isCoveredCollision = (/** @type {string} */ reason) =>
    reasonKind(reason) === "CLAIMED_BY_ANOTHER_SESSION" && covered.has(issueNumberOf(reason));
  return {
    overridden: verdict.reasons.filter(isCoveredCollision),
    remaining: verdict.reasons.filter((r) => !isCoveredCollision(r)),
  };
}
