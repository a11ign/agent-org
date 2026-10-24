// @ts-check
// module: the code host contract's optional `rows` group, the plumbing section -- row mode's GitHub operations that the last callers of `src/` ask (contract 1.12, A11-160 step 9)
//
// A TYPE FILE: it imports nothing at run time. Each member is a named operation of what a caller asks, never a `gh` command line; it takes the `run` its caller hands it where the caller keeps its own executor, and
// THROWS (or answers `null` where its name says so) when the read is refused: none returns an empty list for "could not ask".
//
// The callers are the odd ones: the tool-version agreement (`lib/tool-version-agreement.ts`, which `host:check` and the org-health tick print), the host check's read of a worker's row, the GraphQL pool's probe
// (`api-pool.ts`, the gate's pacing, the call ledger's retry), the call ledger's retry, and the review eval (`scripts/review-eval.ts`). A caller that runs `gh` itself with a policy of its own (the ledger's retry, the survey,
// the tool-version agreement's 30 s cut and role environment) asks `runnerWith` of `code-host-rows.ts` or `answeringRunnerWith` here.
import type { RowsRun } from "./code-host-rows.ts";
import type { AnsweringRun, RunnerRequest } from "./code-host-rows-facts.ts";

/** A completed workflow run as the tool-version agreement reads it: the run's id, the commit it ran, when it was created (ISO, as GitHub words it) and the event that started it (`merge_group`, `push`). */
export type CiRunRead = { id: number; sha: string; createdAt: string; event: string };

/** A pull request as the review eval reads it: its title and body, and the commits the change is between. */
export type EvalPullRead = { title: string; body: string; baseRefOid: string; headRefOid: string };

/** A row as the review eval reads it: its title and body. */
export type EvalRowRead = { title: string; body: string };

export interface RowsPlumbing {
  // --- the tool-version agreement (A11-160 step 9; moved from `lib/tool-version-agreement.ts`) ---
  /** When `tag` of `repo` was published as a release (epoch ms), or `null` when the release carries no date GitHub could parse. THROWS when the read is refused or is not JSON. */
  releasePublishedAtOf(request: { repo: string; tag: string; run?: RowsRun }): number | null;
  /**
   * The newest COMPLETED run of the `ci.yml` workflow that gates `main` in `repo`: the newest of the merge queue's `merge_group` runs, else the newest on `main` (a repository with no queue). `null` when neither question returns a run.
   * THROWS when either read is refused or is not JSON (the second question is not asked when the first throws).
   */
  gatingCiRunOf(request: { repo: string; run?: RowsRun }): CiRunRead | null;
  /** The whole log of workflow run `id` of `repo`, or `""` when GitHub says it has none (expired, or never kept): that is an answer about the run. THROWS on any other refusal. */
  ciRunLogOf(request: { repo: string; id: number; run?: RowsRun }): string;

  // --- the host check (A11-160 step 9; moved from `host-units.ts`) ---
  /** The names of the labels on row `number` of `repo`, over REST (the REST pool and not GraphQL's). THROWS when the read is refused or is not JSON. From `host-units.ts` (the host check) and `pr-open.ts` (the owner label of a row). */
  restLabelNamesOf(request: { repo: string; number: number; run?: RowsRun }): string[];

  // --- the GraphQL pool and the call ledger (A11-160 step 9; moved from `api-pool.ts`, `work-gate/pacing.ts` and `gh-ledger.ts`) ---
  /** The GraphQL pool's probe as arguments: the cheapest call that names the pool, its budget and its reset in the headers of the answer (`-i`). The caller sends it through a runner of its own (the ledger's, as a queue's account). */
  graphqlPoolProbeArgs(): readonly string[];
  /**
   * A runner of the code host's program that NEVER THROWS: it answers how the program ended (its status, what it printed, the spawn error where there was one), and writes `options.input` to its standard input. The ledger's retry
   * runs a queued call with it (the call's directory, its account's environment, a bound, the stdin the call was queued with). A fake has no program, and its runner throws.
   */
  answeringRunnerWith(request?: RunnerRequest): AnsweringRun;

  // --- the review eval (A11-160 step 9; moved from `scripts/review-eval.ts`) ---
  /** Pull request `number` of `repo`: its title, body and the two commits its change is between. THROWS when the read is refused or is not JSON. */
  pullForReviewEvalOf(request: { repo: string; number: number; run?: RowsRun }): EvalPullRead;
  /** Row `number` of `repo`: its title and body. THROWS when the read is refused or is not JSON. */
  rowForReviewEvalOf(request: { repo: string; number: number; run?: RowsRun }): EvalRowRead;
}
