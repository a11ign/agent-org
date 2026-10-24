// module: the GitHub plugin's rows for the pullwork section of the contract (A11-160, step 9; moved from the callers named in each operation's comment)
//
// Each operation builds the argument list its caller built and reads GitHub's answer as the caller did, and THROWS when `gh` refuses: what a caller does with a refusal stays in core. Every operation takes the `run`
// its caller made with the policy it wants (`runnerWith`: the bound, the buffer, the directory, the guard); the argument builders take none.
import type { CodeHostRows, RowsHelpers } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { RowsPullwork } from "../../../src/plugins/contracts/code-host-rows-pullwork.ts";
import { closeCheckoutPull, commentOnCheckoutPull, openPullNumberOfBranch, openPullsForSweep, pullHeadRefsPageOf, pullsListedForStop } from "./branch-sweep-calls.ts";
import { autoMergeOfHeldPull, autoMergeRequestOfHeldPull, disarmHeldPull, editHeldPullLabel, armHeldPull, heldPullLabelsOf, holdTargetRowOf } from "./pr-hold-calls.ts";
import { armArgsAfterCreate, authoringLoginOf, branchHeadForOpening, labelArgsAfterCreate, labelCreateArgs, labelExistsForOpening, pullHeadForOpening, pullWriteArgs, rowBodyForOpening } from "./pr-open-calls.ts";
import type { RowsRunners } from "./index.ts";

/** The operations of this section. */
export type PullworkRows = Pick<CodeHostRows, keyof RowsPullwork>;

export function pullworkRowsOf(_runners: RowsRunners, _helpers: () => RowsHelpers): PullworkRows {
  return {
    pullWriteArgs, armArgsAfterCreate, labelArgsAfterCreate, labelCreateArgs,
    labelExistsForOpening, pullHeadForOpening, rowBodyForOpening, branchHeadForOpening, authoringLoginOf,
    heldPullLabelsOf, editHeldPullLabel, autoMergeOfHeldPull, autoMergeRequestOfHeldPull, armHeldPull, disarmHeldPull, holdTargetRowOf,
    openPullNumberOfBranch, pullHeadRefsPageOf, openPullsForSweep, commentOnCheckoutPull, closeCheckoutPull, pullsListedForStop,
  };
}
