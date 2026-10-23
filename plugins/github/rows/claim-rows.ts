// module: the GitHub plugin's rows for the claim (A11-160, step 7)
//
// The operations `src/row-claim.ts` held, as the code host's `rows` (contract 1.10). `postRowComment`, `setProjectStatus` and `ensureLabelIn` are the ones the claim shares with the other callers that write a comment on a row, move its card and create a label.
import { editRowLabels, ensureLabelArgs, readRestComments, readRestRow, setRowLabels } from "./claim-ops.ts";

export const claimRows = { ensureLabelArgs, readRestRow, readRestComments, setRowLabels, editRowLabels };
