// module: the GitHub plugin's rows for the claim's rules (A11-160, step 7)
//
// The reads and writes of `src/row-claim/*-rule.ts`, which read nothing of core's: each takes the `run` its caller hands it.
import { blockedByOf, bodyAndLabelsOf, commitsOfPull, openPullReviewsOf, openPullsWithFilesOf, pullFilePathsOf, rowCarriesLabel, rowShapeFactsOf } from "./rules-reads.ts";
import { changedPathsOfPull, closingPullsOf, crossReferencingPullsOf } from "./rules-delivery.ts";
import { addLabelToRowIn, compareShaWithMain, ensureLabelIn } from "./rules-writes.ts";

export const rulesRows = {
  blockedByOf, bodyAndLabelsOf, rowShapeFactsOf, rowCarriesLabel, openPullReviewsOf, commitsOfPull, closingPullsOf, crossReferencingPullsOf, changedPathsOfPull, openPullsWithFilesOf, pullFilePathsOf,
  ensureLabelIn, addLabelToRowIn, compareShaWithMain,
};
