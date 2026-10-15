// agent-org#1369: THE WRITES OF AN OUTSIDE-IDLE TRIAGE ROW, as the arguments to `gh` built here and run through an injected `run` (`gh`, as the caller hands it in).
// This file names no `gh` and spawns nothing: `ticket-port.test.ts` (#484) holds the port to that, and `gh-call-ratchet.test.ts` is why these are written HERE and not in
// `src/work-gate/pr-orders.ts`, a file outside the port. The row itself is filed by `createRow` (`approved-unqueued-reads.ts`). A refused `run` THROWS.

import { isIssueOnBoard } from "./project-membership.ts";

type Run = (args: string[]) => string;

/** Creates the label a triage row carries. `--force`, so a second tick's create is harmless. */
export function ensureTriageLabel({ repo, label, description, run }: { repo: string; label: string; description: string; run: Run }): void {
  run(["label", "create", label, "--repo", repo, "--force", "--description", description]);
}

/**
 * Boards a triage row as `ci-failure-class` boards its incident rows: adds the item when the row is not on the board yet (a second add duplicates it),
 * sets its Status, then adds its labels. A refused board throws to the caller, and the row stays unboarded.
 */
export function boardTriageRow({ repo, number, owner, projectNumber, status, labels, run }: {
  repo: string; number: number; owner: string; projectNumber: number; status: string; labels: string[]; run: Run;
}): void {
  const url = `https://github.com/${repo}/issues/${number}`;
  if (!isIssueOnBoard(number, { read: run })) run(["project", "item-add", String(projectNumber), "--owner", owner, "--url", url]);
  run(["project", "item-edit", String(projectNumber), "--owner", owner, "--url", url, "--field", "Status", "--value", status]);
  run(["issue", "edit", String(number), "--repo", repo, ...labels.flatMap((label) => ["--add-label", label])]);
}
