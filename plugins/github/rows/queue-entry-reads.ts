// agent-org#1195: THE READS AND THE ONE WRITE BEHIND "A MERGE-QUEUE ENTRY WITH NO RUN", as the arguments to `gh` built here and run through an injected `run` (`gh`, as the caller hands it in).
// This file spawns nothing, and it is in the GitHub plugin, the one place `gh-call-ratchet.test.ts` lets a call shape be: the cause
// (`work-gate/causes/queue-entry-no-run.ts`) holds none. A refused `run` THROWS, and an answer that is not the shape THROWS: none of these returns `[]` or `0` for a read that failed,
// because "unread" and "no run" are different facts and the detector acts on one of them.
//
// THE SHAPES were read from GitHub's GraphQL schema (introspection, 2026-10-12, recorded on the row): `MergeQueueEntry` has `state` (QUEUED, AWAITING_CHECKS, MERGEABLE,
// UNMERGEABLE, LOCKED), `enqueuedAt`, `position`, `headCommit` and `pullRequest`; `dequeuePullRequest` takes `input: { id }`, the PULL REQUEST's node id.

import type { QueueEntry, RowsRun as Run } from "../../../src/plugins/contracts/code-host-rows.ts";

const ENTRIES_QUERY = "query($o:String!,$r:String!,$b:String!){repository(owner:$o,name:$r){mergeQueue(branch:$b){entries(first:100){nodes{state enqueuedAt position headCommit{oid} pullRequest{number id}}}}}}";
const DEQUEUE_MUTATION = "mutation($id:ID!){dequeuePullRequest(input:{id:$id}){mergeQueueEntry{state}}}";

/**
 * THE ENTRIES OF `branch`'s MERGE QUEUE, in one GraphQL read. A repository with no queue for the branch (`mergeQueue: null`) is a THROW, not an empty queue: the detector's flag is on
 * for a repository that has one, so its absence is a fault to name and never a quiet "nothing queued".
 */
export function queueEntriesOf({ repo, branch, run }: { repo: string; branch: string; run: Run }): QueueEntry[] {
  const [owner, name] = repo.split("/");
  const answer = JSON.parse(run(["api", "graphql", "-f", `query=${ENTRIES_QUERY}`, "-f", `o=${owner}`, "-f", `r=${name}`, "-f", `b=${branch}`]));
  const queue = answer?.data?.repository?.mergeQueue;
  if (queue === null || queue === undefined) throw new Error(`${repo} has no merge queue for ${branch}, or the answer did not carry one`);
  const nodes = queue.entries?.nodes;
  if (!Array.isArray(nodes)) throw new Error("the merge queue's entries are not a list");
  return nodes.map((node: any) => {
    if (typeof node?.state !== "string" || typeof node?.enqueuedAt !== "string" || !Number.isInteger(node?.position)) throw new Error("a merge-queue entry carries no state, enqueuedAt or position");
    return {
      state: node.state, enqueuedAt: node.enqueuedAt, position: node.position,
      headSha: typeof node.headCommit?.oid === "string" ? node.headCommit.oid : null,
      pull: Number.isInteger(node.pullRequest?.number) ? node.pullRequest.number : null,
      pullId: typeof node.pullRequest?.id === "string" ? node.pullRequest.id : null,
    };
  });
}

/**
 * HOW MANY WORKFLOW RUNS EXIST FOR THE `merge_group` EVENT ON `sha`: one REST read of `total_count`, so a group with many runs costs no more than one with none. A count that is not a
 * whole number is a THROW. This is the RUNS, not the webhook feed, so it holds while `events.source` is `poll`.
 */
export function mergeGroupRunCountOf({ repo, sha, run }: { repo: string; sha: string; run: Run }): number {
  const printed = run(["api", `repos/${repo}/actions/runs?event=merge_group&head_sha=${sha}&per_page=1`, "--jq", ".total_count"]).trim();
  if (!/^\d+$/.test(printed)) throw new Error(`the runs of ${sha.slice(0, 12)} did not answer a count: ${printed.slice(0, 80)}`);
  return Number(printed);
}

/**
 * REMOVE a pull request from the merge queue by its node id. GraphQL carries a refusal in the body of an answer that `gh` may still print as a success, so an answer with `errors`
 * is a throw, as is one that is not JSON. `gh pr merge --disable-auto` is NOT this: it is documented to change nothing on a pull request that is already merging (`pr-hold.ts`).
 */
export function dequeuePullRequestOf({ pullId, run }: { pullId: string; run: Run }): void {
  const answer = JSON.parse(run(["api", "graphql", "-f", `query=${DEQUEUE_MUTATION}`, "-f", `id=${pullId}`]));
  if (Array.isArray(answer?.errors) && answer.errors.length > 0) throw new Error(`the dequeue was refused: ${String(answer.errors[0]?.message ?? "no message").slice(0, 160)}`);
}
