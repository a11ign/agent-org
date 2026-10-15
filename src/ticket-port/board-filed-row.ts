// THE BOARD WRITE OF A ROW THE GATE FILES: the card, then its Status, then the labels LAST. One copy, shared by `ci-failure-class.ts` (its incident rows, #5405)
// and `outside-idle-writes.ts` (the outside-idle triage row, #1369). A refused `run` THROWS, so the caller decides whether a refused board is a logged miss or a refusal.

import { isIssueOnBoard } from "./project-membership.ts";

type Run = (args: string[]) => string;

/**
 * Boards a filed row: adds the card only when the issue is NOT on the board at all (a second item-add is refused or duplicates it), sets its Status, then adds its labels.
 * `isIssueOnBoard` is the read that tells "absent" from "on it with no Status", so a retry after a partial board does not add the card twice.
 */
export function boardFiledRow({ repo, number, owner, projectNumber, status, labels, run }: {
  repo: string; number: number; owner: string; projectNumber: number; status: string; labels: string[]; run: Run;
}): void {
  const url = `https://github.com/${repo}/issues/${number}`;
  if (!isIssueOnBoard(number, { read: run })) run(["project", "item-add", String(projectNumber), "--owner", owner, "--url", url]);
  run(["project", "item-edit", String(projectNumber), "--owner", owner, "--url", url, "--field", "Status", "--value", status]);
  run(["issue", "edit", String(number), "--repo", repo, ...labels.flatMap((label) => ["--add-label", label])]);
}
