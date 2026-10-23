// agent-org#1536: THE WRITE THAT CLOSES A ROW ON A WORKER'S OWN READING, as the arguments to `gh` built here and run through an injected `run` (`gh`, as the caller hands it in).
// This file names no `gh` and spawns nothing, and it is in the GitHub plugin, the one place `gh-call-ratchet.test.ts` lets a call shape be.
// A refused `run` THROWS: the caller decides what the throw means, and a row it could not close is reported as NOT CLOSED, never as closed.

import type { RowsRun as Run } from "../../../src/plugins/contracts/code-host-rows.ts";

/** `repo` is `owner/name`, `row` the issue's number in it, and `comment` the body the close leaves on the row. */
export function closeRowWithComment({ row, repo, comment, run }: { row: number; repo: string; comment: string; run: Run }): void {
  run(["issue", "close", String(row), "--repo", repo, "--comment", comment]);
}
