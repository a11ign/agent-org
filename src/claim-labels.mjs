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
