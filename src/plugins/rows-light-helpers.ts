// @ts-check
// module: the part of what core owns of row mode that reads nothing of the project, handed to the code host's `rows` (A11-160, step 4)
//
// How GitHub's rate-limit answers are read (`api-pool.ts`), the claim label and the error a window read throws: three leaves, none of which evaluates the project's declaration, so a program that only
// reads rows by label (`provider-low-confidence --question`) loads them on a host with no project. `rows.ts` registers them; `rows-helpers.ts` is the other part.
import { poolFromRateLimitField, poolFromResponse, rawResponse } from "../api-pool.ts";
import { CLAIM_LABEL } from "../claim-labels.ts";
import { WindowCutShort } from "../ticket-port/window-cut-short.ts";
import type { RowsReadHelpers } from "./contracts/code-host-rows.ts";

export const rowsReadHelpers = (): RowsReadHelpers => ({
  claimLabel: CLAIM_LABEL,
  pool: { fromResponse: (raw) => poolFromResponse(raw), rawResponse, fromRateLimitField: poolFromRateLimitField },
  WindowCutShort,
});
