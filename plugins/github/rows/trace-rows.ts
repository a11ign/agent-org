// module: the GitHub plugin's rows for the trace (A11-160, step 8; moved from `src/trace/freshness.ts`, `headless-pilot.ts`, `publish.ts` and `trace.ts`)
//
// The trace reads GitHub for the rows and pull requests a transcript is about, and posts the one comment that says the store went stale. What it does with the answer stays in core (the HTTP status line of a conditional read,
// the pages of a timeline, a refusal that names the row); the command that asks is here.
import type { RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { AnsweringRun, RunAnswer } from "../../../src/plugins/contracts/code-host-rows-facts.ts";

/** The pull request or row `number` of `repo`, as a read-only script reads it. */
export function rowSnapshotOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): { number: number; state: string; title: string; body: string; labels: { name: string }[] } {
  return JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "number,state,title,body,labels"]));
}

/** `gh api <args>`: the arguments after the verb are the caller's (a path and its parameters). */
export function apiTextOf({ args, run }: { args: readonly string[]; run: RowsRun }): string {
  return run(["api", ...args]);
}

/**
 * ONE GET of `path` with its response headers (`-i`), and `If-None-Match` when `etag` is given. THE `-H` COMES FIRST on a conditional call because the `gh` ledger keeps the first two words of a command (`api -H`), which is
 * what lets the trace store count the conditional reads apart from the unconditional ones (`api -i`, and the ledger's `script` says `publish.ts`).
 */
export function conditionalGetOf({ path, etag, run }: { path: string; etag: string | null; run: AnsweringRun }): RunAnswer {
  return run(["api", ...(etag === null ? [] : ["-H", `If-None-Match: ${etag}`]), "-i", path]);
}

/** Comments on row `number` of `repo`, the body on standard input. THROWS with what the program printed, or why it could not start. */
export function commentOnRowByInput({ repo, number, body, run }: { repo: string; number: string | number; body: string; run: AnsweringRun }): void {
  const ran = run(["issue", "comment", String(number), "--repo", repo, "--body-file", "-"], { input: body });
  if (ran.error !== undefined || ran.status !== 0) throw new Error(ran.error ?? (ran.stderr || `exit ${ran.status}`).trim());
}

/** The operations of this group that take a runner of the caller's, or of nobody's. */
export const traceRows = { rowSnapshotOf, apiTextOf };
