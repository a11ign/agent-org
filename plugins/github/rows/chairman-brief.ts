// a11ign#5528, agent-org#1538: the chairman's brief on a pull request whose failing check says `Cleared-by: human`. The two writes are GitHub's, so they
// live in the GitHub plugin and not in the gate's own file: a file outside the plugin may not gain a `gh` call (gh-call-ratchet).

import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

/** Put `label` on pull request `number` of `repo` and post `body` as its comment: the label and the brief the chairman reads. */
export function briefChairmanOnPull({ repo, number, label, body, run }: { repo: string; number: number; label: string; body: string; run: RowsRun }): void {
  run(["pr", "edit", String(number), "--repo", repo, "--add-label", label]);
  run(["pr", "comment", String(number), "--repo", repo, "--body", body]);
}
