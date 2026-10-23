// module: what the GitHub plugin knows of whether a pull request is ARMED, and of the merge queue's history of it (A11-160, step 5; moved from `src/pr-armed-state.ts`)
//
// ARMED MEANS "NOTHING LEFT TO ARM", AND ONE PLACE DECIDES WHETHER A PULL REQUEST IS ARMED (#2046). The rule was written once in a module beside the hold predicate, and each time a deciding read did not call
// it the arming doors disagreed (#1729, #2004, #2046). It is still one definition: here. Core's `pr-armed-state.ts` delegates to it, and `auto-arm-sweep.ts` re-exports `armedFromApi` from there.
//
// THE THREE STATES OF A PULL REQUEST THAT IS ARMED. `autoMergeRequest != null` is a pending auto-merge and `merged` is a landed one, and between those two lies the state a BUSY queue spends most of its time in:
// the pull request has left auto-merge and is SITTING IN THE MERGE QUEUE (`autoMergeRequest` cleared on entry, `merged` not yet true). Observed, #1762 at 2026-09-19T14:36Z:
// `{"autoMergeRequest": null, "merged": false, "mergeQueueEntry": {"state": "AWAITING_CHECKS", "position": 1}}`. GRAPHQL RATHER THAN REST, because `mergeQueueEntry` exists on neither
// `repos/:o/:r/pulls/:n` nor `gh pr view --json`: a REST read structurally cannot see the state this exists to recognise.
//
// This file names no `gh` and spawns nothing: the arguments are built here and run through the `run` the caller hands the operation.
import type { QueueEjection, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";

/** A pull request node as the armed query returns it. */
export type ArmedNode = { merged?: boolean; autoMergeRequest?: unknown; mergeQueueEntry?: unknown } | null;

export const ARMED_QUERY = "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r)"
  + "{pullRequest(number:$n){merged autoMergeRequest{enabledAt} mergeQueueEntry{state}}}}";

/** The `gh` arguments that ask {@link ARMED_QUERY} about one pull request, split out so every caller asks the IDENTICAL question (#2004 was a predicate re-spelled inside a shell argument). */
export function armedQueryArgs({ number, repo }: { number: string | number; repo: string }): string[] {
  const [owner, name] = String(repo).split("/");
  return ["api", "graphql", "-f", `query=${ARMED_QUERY}`, "-f", `o=${owner}`, "-f", `r=${name}`,
    "-F", `n=${number}`, "--jq", ".data.repository.pullRequest"];
}

/** PURE. Is this pull request armed, given what the API said about it? Split from the read so the three-state rule is testable without a network. */
export function armedFromApi(pr: ArmedNode): boolean {
  if (!pr) return false;
  return pr.merged === true || pr.autoMergeRequest != null || pr.mergeQueueEntry != null;
}

/**
 * PURE. WHICH of the three states it is in, or `null` when nobody has armed it. The order is most-advanced-first, so a pull request that is both merged and carries a stale entry reads as merged.
 * Never a default: {@link armedFromApi} decides, and this only names what it decided.
 */
export function armedReason(pr: ArmedNode): string | null {
  if (!armedFromApi(pr)) return null;
  if (pr?.merged === true) return "it is already merged";
  if (pr?.mergeQueueEntry != null) return "it is already queued to merge";
  return "auto-merge is already enabled on it";
}

/** The armed query's node for one pull request, read through `run`. THROWS when the read is refused or the answer is not JSON. */
export function armedNodeOf({ number, repo, run }: { number: string | number; repo: string; run: RowsRun }): ArmedNode {
  return JSON.parse(run(armedQueryArgs({ number, repo })));
}

/**
 * ARMED AND THEN EJECTED IS NOT "NEVER ARMED" (#3019), and {@link armedFromApi} cannot tell them apart. Measured 2026-10-02 on `a11ign/agent-org#16` and `#17`: both green and approved, `mergeQueueEntry` null, and
 * both `added_to_merge_queue` and then `removed_from_merge_queue` with `reason: "failed_checks"` because the `merge_group` run was red. Re-arming without a push re-enters the queue and fails the same way.
 * The timeline decides "since", not a clock: the nodes come back chronologically, so a commit or a force-push AFTER the removal is a push since. A manual dequeue (any other `reason`) is somebody's
 * decision and stays whatever it is. LAST 10, NOT ALL: a window holding no queue event is a pull request pushed to since, or never queued, and both read as "not ejected".
 */
const QUEUE_AND_PUSH_ITEMS = "[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT,"
  + "HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_COMMIT]";
const EJECTION_WINDOW = 10;

export const EJECTION_QUERY = "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r)"
  + `{pullRequest(number:$n){mergeQueueEntry{state} timelineItems(last:${EJECTION_WINDOW},itemTypes:${QUEUE_AND_PUSH_ITEMS})`
  + "{nodes{__typename ... on AddedToMergeQueueEvent{createdAt} "
  + "... on RemovedFromMergeQueueEvent{createdAt reason}}}}}}";

/** The `gh` arguments that ask {@link EJECTION_QUERY} about one pull request: {@link armedQueryArgs}'s shape, for the same reason. */
export function ejectionQueryArgs({ number, repo }: { number: string | number; repo: string }): string[] {
  const [owner, name] = String(repo).split("/");
  return ["api", "graphql", "-f", `query=${EJECTION_QUERY}`, "-f", `o=${owner}`, "-f", `r=${name}`,
    "-F", `n=${number}`, "--jq", ".data.repository.pullRequest"];
}

const QUEUE_EVENTS = ["AddedToMergeQueueEvent", "RemovedFromMergeQueueEvent"];

/**
 * PURE. Was this pull request ejected from the merge queue for a failed queue run, with its head unmoved since? `null` is "the API did not say" (no `timelineItems.nodes` array), and it is NEVER
 * `{ ejected: false }`: a refused read must send no order, not a false all-clear. A pull request that is IN the queue now is armed, so it is not ejected whatever the history says.
 */
export function queueEjectionOf(pr: { mergeQueueEntry?: unknown; timelineItems?: { nodes?: unknown } } | null): QueueEjection | null {
  const nodes: any = pr?.timelineItems?.nodes;
  if (!Array.isArray(nodes)) return null;
  const notEjected = { ejected: false, removedAt: null };
  if (pr?.mergeQueueEntry != null) return notEjected;
  const lastQueueAt = nodes.map((n) => QUEUE_EVENTS.includes(n?.__typename)).lastIndexOf(true);
  const last = nodes[lastQueueAt];
  if (last?.__typename !== "RemovedFromMergeQueueEvent" || last.reason !== "failed_checks") return notEjected;
  const pushedSince = lastQueueAt < nodes.length - 1;
  return pushedSince ? notEjected : { ejected: true, removedAt: String(last.createdAt ?? "") || null };
}

/** The merge queue's history of one pull request, read through `run`: `null` when the answer carries none. THROWS when the read is refused or the answer is not JSON. */
export function readQueueEjection({ number, repo, run }: { number: string | number; repo: string; run: RowsRun }): QueueEjection | null {
  return queueEjectionOf(JSON.parse(run(ejectionQueryArgs({ number, repo }))));
}
