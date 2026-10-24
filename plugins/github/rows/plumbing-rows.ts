// module: the GitHub plugin's rows for the plumbing section of the contract (A11-160, step 9; moved from the callers named in each operation's comment)
//
// Each operation builds the argument list its caller built and reads GitHub's answer as the caller did, and THROWS when `gh` refuses: what a caller does with a refusal stays in core. `run` is the caller's executor
// where it has one; absent, the code host runs `gh` itself (`runners.own`).
import type { CodeHostRows, RowsHelpers, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { AnsweringRun, RunnerRequest } from "../../../src/plugins/contracts/code-host-rows-facts.ts";
import type { CiRunRead, EvalPullRead, EvalRowRead, RowsPlumbing } from "../../../src/plugins/contracts/code-host-rows-plumbing.ts";
import { GRAPHQL_POOL_PROBE } from "./graphql-pool-probe.ts";
import type { RowsRunners } from "./index.ts";

/** The operations of this section. */
export type PlumbingRows = Pick<CodeHostRows, keyof RowsPlumbing>;

/** The words `gh` refuses a log with when the run has none: expired, or never kept. */
const NO_LOG = /log not found/;

/** When `tag` of `repo` was published as a release (epoch ms), or `null` when the release carries no date that parses. */
export function releasePublishedAtOf({ repo, tag, run }: { repo: string; tag: string; run: RowsRun }): number | null {
  const published = Date.parse(JSON.parse(run(["api", `repos/${repo}/releases/tags/${tag}`])).published_at);
  return Number.isNaN(published) ? null : published;
}

/** The newest completed `ci.yml` run of `repo` that satisfies `filter` (a query-string fragment), or `undefined` when the answer lists none. */
function newestCompletedRun(repo: string, filter: string, run: RowsRun): any {
  return JSON.parse(run(["api", `repos/${repo}/actions/workflows/ci.yml/runs?${filter}&status=completed&per_page=1`])).workflow_runs?.[0];
}

/** The newest completed `ci.yml` run that gates `main`: the merge queue's first, else `main`'s own; `null` when neither question returns one. */
export function gatingCiRunOf({ repo, run }: { repo: string; run: RowsRun }): CiRunRead | null {
  const found = newestCompletedRun(repo, "event=merge_group", run) ?? newestCompletedRun(repo, "branch=main", run);
  return found === undefined || found === null ? null : { id: found.id, sha: found.head_sha, createdAt: found.created_at, event: found.event };
}

/** A run's whole log, or `""` when `gh` says it has none (an answer about the run); any other refusal is rethrown. */
export function ciRunLogOf({ repo, id, run }: { repo: string; id: number; run: RowsRun }): string {
  try {
    return run(["run", "view", String(id), "--repo", repo, "--log"]);
  } catch (err) {
    if (NO_LOG.test(`${(err as { stderr?: unknown } | null | undefined)?.stderr ?? ""}${(err as { message?: unknown } | null | undefined)?.message ?? ""}`)) return "";
    throw err;
  }
}

/** The names of the labels of row `number` of `repo`, over REST. */
export function restLabelNamesOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): string[] {
  return JSON.parse(run(["api", `repos/${repo}/issues/${number}`, "--jq", "[.labels[].name]"]));
}

export function pullForReviewEvalOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): EvalPullRead {
  return JSON.parse(run(["pr", "view", String(number), "--repo", repo, "--json", "title,body,baseRefOid,headRefOid"]));
}

export function rowForReviewEvalOf({ repo, number, run }: { repo: string; number: number; run: RowsRun }): EvalRowRead {
  return JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "title,body"]));
}

export function plumbingRowsOf(runners: RowsRunners, _helpers: () => RowsHelpers): PlumbingRows {
  const own = (run: RowsRun | undefined): RowsRun => run ?? runners.own;
  const refuse = (): never => { throw new Error("this code host's rows were built with no runner of their own, so a runner with a policy cannot be made"); };
  return {
    releasePublishedAtOf: ({ repo, tag, run }) => releasePublishedAtOf({ repo, tag, run: own(run) }),
    gatingCiRunOf: ({ repo, run }) => gatingCiRunOf({ repo, run: own(run) }),
    ciRunLogOf: ({ repo, id, run }) => ciRunLogOf({ repo, id, run: own(run) }),
    restLabelNamesOf: ({ repo, number, run }) => restLabelNamesOf({ repo, number, run: own(run) }),
    graphqlPoolProbeArgs: () => GRAPHQL_POOL_PROBE,
    answeringRunnerWith: (request?: RunnerRequest): AnsweringRun => (runners.withAnswer ?? refuse)(request ?? {}),
    pullForReviewEvalOf: ({ repo, number, run }) => pullForReviewEvalOf({ repo, number, run: own(run) }),
    rowForReviewEvalOf: ({ repo, number, run }) => rowForReviewEvalOf({ repo, number, run: own(run) }),
  };
}
