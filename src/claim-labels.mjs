// @ts-check
// THE FOUR CLAIM-LIFECYCLE LABEL LITERALS, ONE PLACE -- #804.
//
// Previously duplicated in three files: `row-claim.mjs` (CLAIM_LABEL/STARTED_LABEL, its own real owner),
// `ready-label-audit.mjs` (READY_LABEL/WAS_READY_LABEL, its own real owner), and
// `close-rows-for-merged-pr.mjs` (a THIRD copy of all four, "documented duplicates" added across #754 and
// #782 to avoid a circular import -- that file runs with no `npm ci`/build, so importing `row-claim.mjs`'s
// heavy rule-set graph, or importing back FROM `ready-label-audit.mjs` once it needed `labelsToStrip`,
// was each individually the wrong tradeoff).
//
// A documented duplicate is still the fact-stated-twice shape this repo names as its own most expensive
// recurring defect -- three copies of four literals is worse than the two-file cycle it was solving. THIS
// is the actual fix: a LEAF module, no imports of its own, so nothing depending on it can form a cycle
// through it. `row-claim.mjs` and `ready-label-audit.mjs` now RE-EXPORT from here rather than declaring
// their own copies (keeping every existing `import { X } from "./row-claim.mjs"` call site working
// unchanged), and `close-rows-for-merged-pr.mjs` imports directly -- a leaf import, safe under the
// identical no-`npm ci` constraint that made the local duplicates seem necessary in the first place.
export const READY_LABEL = "ready";

// #449: THE RECORD THAT A ROW WAS `ready` IMMEDIATELY BEFORE A CLAIM REMOVED IT. `declineRow`
// (row-claim.mjs) is the only writer of this label -- it always removes it in the same edit that
// restores `ready`, mirroring `session:<name>`/`runner:<name>`'s own shape: a label recording a FACT
// about the row's history, not a state a human sets by hand. See `strandedByIncompleteDecline`
// (ready-label-audit.mjs) for the audit this enables: a row carrying it while neither `ready` nor claimed
// is the #171 shape -- a correct decline whose restore silently did not happen.
export const WAS_READY_LABEL = "was-ready";

export const CLAIM_LABEL = "in-progress";
export const STARTED_LABEL = "started";

// THE FIFTH LITERAL IS NOT A LABEL, AND IT IS HERE FOR THE REASON THE FOUR ABOVE ARE -- #2110.
//
// `row-claim.mjs` owns the claim-record COMMENT: the append-only record of who holds a row, which exists
// because a 50-character label cannot hold a worktree path (#987). Its marker is an HTML comment so the
// rendered thread stays clean while `claimRecordFrom` still has something exact to match on.
//
// `work-gate.mjs` now has to find it too. A comment posted AFTER the newest claim record is a comment
// posted after the claim, and that ordering is the only free way this repo has to tell a constraint
// added under a holder from one the row already carried when it was taken -- both arrive in the same
// `gh issue list --json comments` page, so the question costs nothing extra to ask.
//
// THE ALTERNATIVE WAS A SECOND COPY OF THE LITERAL, or a `work-gate.mjs` import of `row-claim.mjs` --
// twenty-odd modules of claim rules, a `board-snapshot` dependency and a `gh` graph, pulled into a tick
// whose whole property is that it is two reads and no model. This module was split out to be the leaf
// that makes neither necessary; the header above says so for the four labels, and a claim-lifecycle
// literal two modules must agree on is the same fact whether it is spelled as a label or as a marker.
export const CLAIM_RECORD_MARKER = "<!-- row-claim: claim record -->";
