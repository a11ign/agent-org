// module: the GitHub writes the work gate makes to rows, pull requests and the board (A11-160, step 6; moved from `src/work-gate/`)
//
// The gate DECIDES what is written and in what order (a brief before a label, a label before a body edit) and what a refusal means; the command that writes it is here. Each takes the `run` the gate hands it, builds the
// argument list the gate built, and THROWS when `gh` refuses: a write that failed is never a write that was done. `aim`, where a write has one, is the repository the gate's executor aims the call at (`GH_REPO`).
import type { AimedRun, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

/** Posts `body` as a comment on row `number` of the repository the call is aimed at (`aim`, else the executor's own). */
export function commentOnRow({ number, body, aim, run }: { number: number | string; body: string; aim?: string; run: AimedRun }): void {
  run(["issue", "comment", String(number), "--body", body], aim);
}

/** The bodies of the comments already on row `number`; an answer that carries no comment list is a row with none. THROWS when the read is refused or is not JSON. */
export function commentBodiesOfRow({ number, run }: { number: number | string; run: RowsRun }): string[] {
  const { comments } = JSON.parse(run(["issue", "view", String(number), "--json", "comments"]));
  return Array.isArray(comments) ? comments.map((comment) => String(comment?.body ?? "")) : [];
}

/** Puts `label` on row `number`. */
export function addLabelToRow({ number, label, run }: { number: number | string; label: string; run: RowsRun }): void {
  run(["issue", "edit", String(number), "--add-label", label]);
}

/** Takes `label` off row `number`. */
export function removeLabelFromRow({ number, label, run }: { number: number | string; label: string; run: RowsRun }): void {
  run(["issue", "edit", String(number), "--remove-label", label]);
}

/** Replaces the body of row `number`. */
export function setRowBody({ number, body, run }: { number: number | string; body: string; run: RowsRun }): void {
  run(["issue", "edit", String(number), "--body", body]);
}

/** Creates the label `name`, or updates its description (`--force`, so a second tick's create is harmless). */
export function ensureLabel({ name, description, run }: { name: string; description: string; run: RowsRun }): void {
  run(["label", "create", name, "--force", "--description", description]);
}

/** Files a row in the repository the call is aimed at with one label, and answers what `gh` printed (the new row's URL). */
export function fileLabelledRow({ title, label, body, run }: { title: string; label: string; body: string; run: RowsRun }): string {
  return run(["issue", "create", "--title", title, "--label", label, "--body", body]);
}

/** Adds `label` to row `number` of `repo` through the labels endpoint, which is idempotent and creates a label that does not exist yet (`issue edit --add-label` refuses one). */
export function addLabelToRowByApi({ repo, number, label, run }: { repo: string; number: number; label: string; run: RowsRun }): void {
  run(["api", `repos/${repo}/issues/${number}/labels`, "-f", `labels[]=${label}`]);
}

/** Marks pull request `number` ready for review. `repo` absent is the repository the call is aimed at. */
export function markPullReady({ number, repo, run }: { number: number | string; repo?: string; run: RowsRun }): void {
  run(["pr", "ready", String(number), ...(repo === undefined ? [] : ["--repo", repo])]);
}

/** Adds the issue at `url` to project `projectNumber` of `owner`. */
export function addRowToProject({ owner, projectNumber, url, run }: { owner: string; projectNumber: number; url: string; run: RowsRun }): void {
  run(["project", "item-add", String(projectNumber), "--owner", owner, "--url", url]);
}

/** Sets the Status of the project item for the issue at `url`. The item must already be on the project. */
export function setProjectStatus({ owner, projectNumber, url, status, run }: { owner: string; projectNumber: number; url: string; status: string; run: RowsRun }): void {
  run(["project", "item-edit", String(projectNumber), "--owner", owner, "--url", url, "--field", "Status", "--value", status]);
}
