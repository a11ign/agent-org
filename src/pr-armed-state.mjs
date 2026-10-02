// @ts-check
/**
 * ARMED MEANS "NOTHING LEFT TO ARM", AND ONE PLACE DECIDES WHETHER A PR IS ARMED.
 *
 * #2046. This is `pr-hold-state.mjs`'s argument, made a second time about the other half of the same
 * decision, and `arm-pr.mjs`'s own header had already written the lesson down: *"The predicate was
 * written twice and only one copy was correct. It now lives once, in `pr-hold-state.mjs`, and both
 * callers read it -- adding the missing `if` here would have made it two correct copies, which is the
 * same shape with a longer fuse."* The HOLD predicate was unified. The ARMED predicate was not, and it
 * has now cost three rows:
 *
 *   #1729  `confirmArmed` could not see the queue, so the sweep reported FAILED TO ARM on three PRs
 *          that were at position 1 and merged within five minutes.
 *   #2004  the sweep's CANDIDATE read could not see the queue, so a queued PR was swept as unarmed on
 *          every run -- deterministic, not a race.
 *   #2046  `arm-pr`'s REFUSAL path could not see the queue, so the `arm` job went red whenever the
 *          sweep in its own run won the race to arm the PR.
 *
 * Each time the rule was already written, already exported and already tested, and the deciding read
 * did not call it. So the rule moved out of the sweep and into a module with no imports at all, beside
 * the hold module it is the mirror of. `auto-arm-sweep.mjs` re-exports `armedFromApi` because
 * `work-gate.mjs` reads it from there and the gate's own header reasons about the shape of that import
 * graph; the re-export is a second SPELLING of one definition, never a second copy of the rule.
 *
 * LEAF-SHAPED ON PURPOSE. This module imports nothing -- not `node:*`, not `cli-flags.mjs`. Both
 * callers state as a property of themselves that they run under a bare `actions/checkout` with no
 * `npm ci` and no build (`auto-arm-sweep.mjs`'s header records what the circular bootstrap cost in
 * #330/#331), and a shared predicate must not be the thing that takes that property away.
 */

/**
 * THE THREE STATES OF A PULL REQUEST THAT IS ARMED, and #1729 enumerated two of them.
 *
 * `auto_merge != null` is a pending auto-merge and `merged` is a landed one -- but between those two
 * lies a third, and it is the state a BUSY queue spends most of its time in: the PR has left auto-merge
 * and is SITTING IN THE MERGE QUEUE. `auto_merge` is cleared on entry, `merged` is not yet true, and the
 * old predicate read that as "the arm did not take" on a pull request that was position 1 of 1.
 *
 * OBSERVED, not inferred -- #1762 at 2026-09-19T14:36Z, read straight from the API:
 *
 *   {"autoMergeRequest": null, "merged": false,
 *    "mergeQueueEntry": {"state": "AWAITING_CHECKS", "position": 1}}
 *
 * `gh` had said so in words on the arm call -- `! Pull request #1750 is already queued to merge` -- and
 * that message is the arm HAVING TAKEN, not a warning. The sweep exited 1 on three such PRs at 14:34Z
 * and all three merged within five minutes.
 *
 * GRAPHQL RATHER THAN REST, because `mergeQueueEntry` exists on neither `repos/:o/:r/pulls/:n` nor
 * `gh pr view --json` -- the queue is a GraphQL-only object, and a REST read structurally cannot see the
 * state this function exists to recognise.
 */
export const ARMED_QUERY = "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r)"
  + "{pullRequest(number:$n){merged autoMergeRequest{enabledAt} mergeQueueEntry{state}}}}";

/**
 * The `gh` argv that asks `ARMED_QUERY` about one pull request, split out so both callers ask the
 * IDENTICAL question rather than each assembling its own flags around a shared query string. #2004's
 * own finding was a predicate re-spelled inside a shell argument; the argv is where that happens.
 *
 * @param {{ number: string | number, repo: string }} pr
 * @returns {string[]} the arguments to `gh`, jq'd down to the pull request node
 */
export function armedQueryArgs({ number, repo }) {
  const [owner, name] = String(repo).split("/");
  return ["api", "graphql", "-f", `query=${ARMED_QUERY}`, "-f", `o=${owner}`, "-f", `r=${name}`,
    "-F", `n=${number}`, "--jq", ".data.repository.pullRequest"];
}

/**
 * PURE. Is this pull request armed, given what the API said about it?
 *
 * Split from the read so the three-state rule is testable without a network, and so a future fourth
 * state is added HERE rather than to a `--jq` string inside a shell argument.
 *
 * @param {{ merged?: boolean, autoMergeRequest?: unknown, mergeQueueEntry?: unknown } | null} pr
 */
export function armedFromApi(pr) {
  if (!pr) return false;
  return pr.merged === true || pr.autoMergeRequest != null || pr.mergeQueueEntry != null;
}

/**
 * PURE. WHICH of the three states is it in -- or `null` when nobody has armed it.
 *
 * #2046: a caller that is about to say "there was nothing left to arm" has to be able to say WHY, and
 * the three states are not interchangeable to the person reading a green `arm` step: a QUEUED PR is
 * somebody else's arm having won the race, a MERGED one is the race having finished, and a pending
 * auto-merge is this PR having been armed before. `settledReason` in `arm-pr.mjs` is the same shape for
 * the same reason -- a reason that names the state is how a reader tells a real verdict from a
 * swallowed error.
 *
 * The order is most-advanced-first, so a PR that is both merged and carries a stale entry reads as
 * merged. Never a default: `armedFromApi` decides, and this only names what it decided.
 *
 * @param {{ merged?: boolean, autoMergeRequest?: unknown, mergeQueueEntry?: unknown } | null} pr
 * @returns {string | null}
 */
export function armedReason(pr) {
  if (!armedFromApi(pr)) return null;
  if (pr?.merged === true) return "it is already merged";
  if (pr?.mergeQueueEntry != null) return "it is already queued to merge";
  return "auto-merge is already enabled on it";
}

/**
 * ARMED AND THEN EJECTED IS NOT "NEVER ARMED" (#3019), and `armedFromApi` cannot tell them apart.
 *
 * Measured 2026-10-02T13:32Z on `a11ign/agent-org#16` and `#17`: both green on every required check, both
 * approved, `mergeQueueEntry` null -- and `armedFromApi` false, so the gate called them UNARMED and sent
 * `product-manager` an order to "arm it by hand". `auto-arm` had armed each (exit 0); each was
 * `added_to_merge_queue` and then `removed_from_merge_queue` with `reason: "failed_checks"`, because the
 * `merge_group` run of `gate` was red. Re-arming without a push re-enters the queue and fails the same
 * way, and a failing entry makes the entries behind it rebuild.
 *
 * The three armed states above say what a PR IS NOW. This one is about what happened to it, so it reads
 * the timeline: the LAST queue event is a removal for `failed_checks`, and nothing pushed to the head
 * after it. Ordering decides "since", not a clock: the nodes come back chronologically, so a commit or a
 * force-push AFTER the removal is a push since.
 *
 * Only the pushes this reads are new heads -- a manual dequeue (`reason` anything else) is somebody's
 * decision and stays whatever it is today.
 */
const QUEUE_AND_PUSH_ITEMS = "[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT,"
  + "HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_COMMIT]";

/**
 * LAST 10, NOT ALL. The question is only about what follows the newest queue event; a window holding no
 * queue event at all is a PR that was pushed to since, or never queued, and both read as "not ejected".
 */
const EJECTION_WINDOW = 10;

export const EJECTION_QUERY = "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r)"
  + `{pullRequest(number:$n){mergeQueueEntry{state} timelineItems(last:${EJECTION_WINDOW},itemTypes:${QUEUE_AND_PUSH_ITEMS})`
  + "{nodes{__typename ... on AddedToMergeQueueEvent{createdAt} "
  + "... on RemovedFromMergeQueueEvent{createdAt reason}}}}}}";

/**
 * The `gh` argv that asks `EJECTION_QUERY` about one pull request -- `armedQueryArgs`'s shape, for the same reason.
 * @param {{ number: string | number, repo: string }} pr
 * @returns {string[]}
 */
export function ejectionQueryArgs({ number, repo }) {
  const [owner, name] = String(repo).split("/");
  return ["api", "graphql", "-f", `query=${EJECTION_QUERY}`, "-f", `o=${owner}`, "-f", `r=${name}`,
    "-F", `n=${number}`, "--jq", ".data.repository.pullRequest"];
}

const QUEUE_EVENTS = ["AddedToMergeQueueEvent", "RemovedFromMergeQueueEvent"];

/**
 * PURE. Was this pull request ejected from the merge queue for a failed queue run, with its head unmoved since?
 *
 * `null` is "the API did not say" (no `timelineItems.nodes` array), and it is NEVER `{ ejected: false }`: a refused
 * read must send no order, not a false all-clear (`greenUnarmedOrders`'s rule for the queue read).
 *
 * A PR that is IN the queue now (`mergeQueueEntry`) is armed, so it is not ejected whatever the history says.
 *
 * @param {{ mergeQueueEntry?: unknown, timelineItems?: { nodes?: unknown } } | null} pr
 * @returns {{ ejected: boolean, removedAt: string | null } | null}
 */
export function queueEjectionOf(pr) {
  /** @type {any} */
  const nodes = pr?.timelineItems?.nodes;
  if (!Array.isArray(nodes)) return null;
  const notEjected = { ejected: false, removedAt: null };
  if (pr?.mergeQueueEntry != null) return notEjected;
  const lastQueueAt = nodes.map((n) => QUEUE_EVENTS.includes(n?.__typename)).lastIndexOf(true);
  const last = nodes[lastQueueAt];
  if (last?.__typename !== "RemovedFromMergeQueueEvent" || last.reason !== "failed_checks") return notEjected;
  const pushedSince = lastQueueAt < nodes.length - 1;
  return pushedSince ? notEjected : { ejected: true, removedAt: String(last.createdAt ?? "") || null };
}
