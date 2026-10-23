// agent-org#1369: THE LABEL WRITE OF AN OUTSIDE-IDLE TRIAGE ROW, as the argument list to `gh` built here and run through an injected `run` (`gh`, as the caller hands it in).
// This file names no `gh` and spawns nothing: `index.test.ts` holds this folder to that, and `gh-call-ratchet.test.ts` is why these are written HERE and not in
// `src/work-gate/pr-orders.ts`, a file outside the plugin. The row is filed by `createRow` (`approved-unqueued-reads.ts`) and boarded by `boardFiledRow` (`board-filed-row.ts`,
// shared with the CI incident row). A refused `run` THROWS.

import type { RowsRun as Run } from "../../../src/plugins/contracts/code-host-rows.ts";

/** Creates the label a triage row carries. `--force`, so a second tick's create is harmless. */
export function ensureTriageLabel({ repo, label, description, run }: { repo: string; label: string; description: string; run: Run }): void {
  run(["label", "create", label, "--repo", repo, "--force", "--description", description]);
}
