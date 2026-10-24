// module: the GitHub plugin's rows for the queue section of the contract (A11-160, step 9; moved from `src/trunk-sweep.ts`, `src/queue-stalled.ts`, `src/org-watch.ts`, `src/trunk-red.ts` and `src/queue-table.ts`)
//
// Each operation builds the argument list its caller built and reads GitHub's answer as the caller did, and THROWS when `gh` refuses: what a caller does with a refusal (a 404 on the runs read is "no such workflow", a pool it
// could not read is `null`, a count that is not a number is not zero) stays in core. `run` is the caller's executor where it has one (the queue table meters it, the trunk reading is handed the work gate's); absent, the code host
// runs `gh` itself (`runners.own`).
import type { CodeHostRows, RowsHelpers, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import type { ApiBudgetReading, CheckRunBrief, OpenPullRow, OriginPull, PullQueueNode, RowsQueue } from "../../../src/plugins/contracts/code-host-rows-queue.ts";
import type { RowsRunners } from "./index.ts";
import { GRAPHQL_POOL_PROBE } from "./graphql-pool-probe.ts";
import { withOwnRun } from "./with-own-run.ts";

/** The operations of this section. */
export type QueueRows = Pick<CodeHostRows, keyof RowsQueue>;

/**
 * The queue field REST cannot carry, for every open pull request in ONE call -- `mergeQueueEntry` is a GraphQL-only object (the armed-state read says the same about its per-PR query), and that query asks about one pull
 * request by number, which would be a call per row. `autoMergeRequest` rides along so a single node answers the whole question of whether a pull request is armed. First 100, matching the REST page of {@link openPullRowsOf}.
 */
export const QUEUE_QUERY = "query($o:String!,$r:String!){repository(owner:$o,name:$r)"
  + "{pullRequests(states:OPEN,first:100){nodes{number autoMergeRequest{enabledAt} "
  + "mergeQueueEntry{state position}}}}}";

// --- the trunk sweep and the queue table's trunk line ----------------------------------------------------------------------------------------

export function mainShaOf({ repo, run }: { repo: string; run: RowsRun }): string {
  return run(["api", `repos/${repo}/commits/main`, "--jq", ".sha"]).trim();
}

export function checkRunTotalOf({ repo, sha, run }: { repo: string; sha: string; run: RowsRun }): number {
  return Number(run(["api", `repos/${repo}/commits/${sha}/check-runs`, "--jq", ".total_count"]).trim());
}

export function dispatchWorkflow({ repo, workflow, run }: { repo: string; workflow: string; run: RowsRun }): void {
  run(["workflow", "run", workflow, "--repo", repo]);
}

export function checkoutWorkflowRunsOf({ workflow, limit, run }: { workflow: string; limit: number; run: RowsRun }): any[] | null {
  const runs = JSON.parse(run(["run", "list", `--workflow=${workflow}`, "--limit", String(limit), "--json", "headSha,conclusion,status,databaseId"]));
  return Array.isArray(runs) ? runs : null;
}

// --- the stalled-queue report and the org watch ----------------------------------------------------------------------------------------------

export function openMainPullRollupsOf({ repo, run }: { repo: string; run: RowsRun }): any[] {
  return JSON.parse(run(["pr", "list", "--repo", repo, "--state", "open", "--base", "main", "--limit", "100",
    "--json", "number,headRefOid,autoMergeRequest,statusCheckRollup,isDraft"]));
}

export function workflowRunsOnMain({ repo, workflow, perPage, run }: { repo: string; workflow: string; perPage: number; run: RowsRun }): any[] {
  return JSON.parse(run(["api", `repos/${repo}/actions/workflows/${workflow}/runs?branch=main&per_page=${perPage}`])).workflow_runs ?? [];
}

// --- the red-trunk reading ---------------------------------------------------------------------------------------------------------------------

export function trunkRunsOf({ repo, workflow, eventFilter, run }: { repo: string; workflow: string; eventFilter: string | null; run: RowsRun }): any[] | null {
  const body = JSON.parse(run(["api", "--method", "GET", `repos/${repo}/actions/workflows/${workflow}/runs`,
    "-f", "branch=main", ...(eventFilter === null ? [] : ["-f", eventFilter]), "-f", "per_page=10"]));
  if (body === null) throw new Error(`the runs of ${workflow} answered no body`);
  return Array.isArray(body.workflow_runs) ? body.workflow_runs : null;
}

export function annotationsOfCheckRun({ repo, checkRunId, run }: { repo: string; checkRunId: number | string; run: RowsRun }): any[] | null {
  const annotations = JSON.parse(run(["api", `repos/${repo}/check-runs/${checkRunId}/annotations`]));
  return Array.isArray(annotations) ? annotations : null;
}

export function originPullOfCommit({ repo, sha, run }: { repo: string; sha: string; run: RowsRun }): OriginPull | null {
  const pulls = JSON.parse(run(["api", `repos/${repo}/commits/${sha}/pulls`]));
  if (!Array.isArray(pulls) || pulls.length === 0) return null;
  return { number: pulls[0].number, title: String(pulls[0].title ?? ""), labels: (pulls[0].labels ?? []).map((label: { name: string }) => String(label.name)) };
}

// --- the queue table ---------------------------------------------------------------------------------------------------------------------------

export function openPullRowsOf({ repo, run }: { repo: string; run: RowsRun }): OpenPullRow[] | null {
  const pulls = JSON.parse(run(["api", `repos/${repo}/pulls?state=open&per_page=100`]));
  if (!Array.isArray(pulls)) return null;
  return pulls.map((pull: any): OpenPullRow => ({
    number: pull.number,
    headRefName: pull.head?.ref ?? "?",
    headRefOid: pull.head?.sha ?? "",
    updatedAt: pull.updated_at,
    // `?? null`, NOT `Boolean()`: absent must stay distinguishable from false.
    draft: pull.draft ?? null,
    labels: (pull.labels ?? []).map((label: any) => String(label?.name ?? "")),
    auto_merge: pull.auto_merge ?? null,
  }));
}

export function pullQueueStatesOf({ repo, run }: { repo: string; run: RowsRun }): PullQueueNode[] | null {
  const [owner, name] = repo.split("/");
  const nodes = JSON.parse(run(["api", "graphql", "-f", `query=${QUEUE_QUERY}`, "-f", `o=${owner}`, "-f", `r=${name}`, "--jq", ".data.repository.pullRequests.nodes"]));
  return Array.isArray(nodes) ? nodes : null;
}

export function checkRunBriefsOf({ repo, sha, run }: { repo: string; sha: string; run: RowsRun }): CheckRunBrief[] {
  const raw = run(["api", `repos/${repo}/commits/${sha}/check-runs`, "--paginate", "--jq", ".check_runs[] | {name, conclusion, completedAt: .completed_at}"]);
  return raw.trim().split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as CheckRunBrief]; } catch { return []; }
  });
}

/**
 * TWO POOLS, BOTH SHARED, AND ONLY THE HEADERS TELL THE TRUTH. `gh api rate_limit` reports zero used, always, for these tokens (measured 2026-09-09: after five real calls it still read `core used 0, remaining 5000` while the same
 * call's headers read `X-Ratelimit-Used: 2109`), so each pool is read off a real call of its own kind: REST for core, GraphQL for graphql. `gh pr list`, `gh issue list` and `gh pr view` spend GRAPHQL and `gh api` spends CORE; a table
 * reading only one pool reports a healthy budget during an outage of the other.
 */
function apiBudgetOf(helpers: () => RowsHelpers, { repo, run }: { repo: string; run: RowsRun }): ApiBudgetReading | null {
  const { pool } = helpers();
  const read = (args: readonly string[]) => pool.fromResponse(pool.rawResponse(args, run));
  const core = read(["api", `repos/${repo}`, "-i", "--jq", ".name"]);
  const graphql = read(GRAPHQL_POOL_PROBE);
  return core === null && graphql === null ? null : { core, graphql };
}

export function queueRowsOf({ own }: RowsRunners, helpers: () => RowsHelpers): QueueRows {
  return {
    mainShaOf: withOwnRun(mainShaOf, own),
    checkRunTotalOf: withOwnRun(checkRunTotalOf, own),
    dispatchWorkflow: withOwnRun(dispatchWorkflow, own),
    checkoutWorkflowRunsOf: withOwnRun(checkoutWorkflowRunsOf, own),
    openMainPullRollupsOf: withOwnRun(openMainPullRollupsOf, own),
    workflowRunsOnMain: withOwnRun(workflowRunsOnMain, own),
    trunkRunsOf: withOwnRun(trunkRunsOf, own),
    annotationsOfCheckRun: withOwnRun(annotationsOfCheckRun, own),
    originPullOfCommit: withOwnRun(originPullOfCommit, own),
    openPullRowsOf: withOwnRun(openPullRowsOf, own),
    pullQueueStatesOf: withOwnRun(pullQueueStatesOf, own),
    checkRunBriefsOf: withOwnRun(checkRunBriefsOf, own),
    apiBudgetOf: (request) => apiBudgetOf(helpers, request),
  };
}
