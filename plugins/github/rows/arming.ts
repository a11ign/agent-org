// module: the GitHub reads and writes behind ARMING one pull request (A11-160, step 5; moved from `src/arm-pr.ts`)
//
// `arm-pr` enables auto-merge on ONE pull request unless it is held. What it DECIDES (the hold, the authorship, the blockers, the labels, the exit codes) is core's; what it ASKS OF GITHUB and how it reads the
// answer is here: the pull request's labels, body, state and author, the blocked-by edges of a row it closes, the comments of a pull request, the labels of a row, the arm itself and the read-back of it, the
// trunk's runs, the merge-queue seat and the jump to the front. Each takes the `run` its caller hands it (the contract's head says why), and each THROWS when `gh` refuses or the answer is not the shape:
// "could not read" is never an empty list. This file names no `gh` and spawns nothing.
import type { ArmingPullRead, QueueSeat, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import { armedNodeOf, armedReason } from "./armed-state.ts";

/** A row's blocked-by edges as `gh issue view --json blockedBy` returns them. */
type BlockedByRow = { blockedBy?: { nodes?: unknown; totalCount?: unknown } } | null;

/**
 * The numbers of a row's OPEN blockers, or `null` when the list cannot be trusted whole (no `nodes` array, or fewer nodes than the total with none of them open: the page was cut). A node without a
 * state counts as open, because "not known closed" is not "closed".
 */
export function openBlockersOf(row: BlockedByRow): number[] | null {
  const nodes = row?.blockedBy?.nodes;
  if (!Array.isArray(nodes)) return null;
  const open = nodes.filter((node) => String(node?.state ?? "OPEN").toUpperCase() === "OPEN").map((node) => Number(node?.number));
  const total = row?.blockedBy?.totalCount;
  if (open.length === 0 && typeof total === "number" && total > nodes.length) return null;
  return open;
}

/** The OPEN blockers of the row `number` of `repo` (see {@link openBlockersOf}): `null` for a list that cannot be trusted whole. THROWS when the read is refused. */
export function openBlockersOfRow({ repo, number, run }: { repo: string; number: number; run: RowsRun }): number[] | null {
  return openBlockersOf(JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "blockedBy"])));
}

/** The labels of the row `number` of `repo`. THROWS when the read is refused or the answer carries no label list. */
export function labelsOfRow({ repo, number, run }: { repo: string; number: number; run: RowsRun }): string[] {
  return JSON.parse(run(["issue", "view", String(number), "--repo", repo, "--json", "labels"])).labels.map((label: { name: string }) => label.name);
}

/** The comments already on pull request `number`: only their bodies are read. THROWS when the read is refused or the answer carries no comment list. */
export function readPullComments({ repo, number, run }: { repo: string; number: string | number; run: RowsRun }): { body: string }[] {
  const comments = JSON.parse(run(["pr", "view", String(number), "--repo", repo, "--json", "comments"])).comments;
  if (!Array.isArray(comments)) throw new Error("the API returned no comment list");
  return comments.map((comment) => ({ body: String(comment?.body ?? "") }));
}

/** Posts `body` as a comment on pull request `number`. A refused write THROWS. */
export function commentOnPull({ repo, number, body, run }: { repo: string; number: string | number; body: string; run: RowsRun }): void {
  run(["pr", "comment", String(number), "--repo", repo, "--body", body]);
}

/** Adds `labels` to pull request `number`. A refused write THROWS. */
export function addLabelsToPull({ repo, number, labels, run }: { repo: string; number: string; labels: readonly string[]; run: RowsRun }): void {
  run(["pr", "edit", number, "--repo", repo, ...labels.flatMap((label) => ["--add-label", label])]);
}

/** What `arm-pr` reads of a pull request before it arms it: its labels, body, state and author. THROWS when the read is refused or the answer has no label list. */
export function readPullForArming({ repo, number, run }: { repo: string; number: string; run: RowsRun }): ArmingPullRead {
  const view = JSON.parse(run(["pr", "view", number, "--repo", repo, "--json", "labels,body,state,author"]));
  return { labels: view.labels.map((label: { name: string }) => label.name), body: view.body, state: typeof view.state === "string" ? view.state : null, author: view.author?.login ?? null };
}

/** The state of pull request `number` (`OPEN`, `MERGED` or `CLOSED`), or `null` for an answer that carries none. THROWS when the read is refused. */
export function pullStateOf({ repo, number, run }: { repo: string; number: string; run: RowsRun }): string | null {
  const state = JSON.parse(run(["pr", "view", number, "--repo", repo, "--json", "state"])).state;
  return typeof state === "string" ? state : null;
}

/** Why pull request `number` needs no arm (it is merged, queued or auto-merging), or `null` when nobody has armed it. THROWS when the read is refused. */
export function armedReasonOf({ repo, number, run }: { repo: string; number: string; run: RowsRun }): string | null {
  return armedReason(armedNodeOf({ number, repo, run }));
}

/** The write: enables auto-merge (merge commit) on pull request `number`. A refused `run` THROWS, and its exit is not the evidence that it took: a caller reads the pull request back. */
export function armPullAuto({ repo, number, run }: { repo: string; number: string | number; run: RowsRun }): void {
  run(["pr", "merge", "--auto", "--merge", String(number), "--repo", repo]);
}

const SETTLED_STATES = ["MERGED", "CLOSED"];

/** Why a pull request in `state` has nothing left to arm, or `null` when it is still open or its state is unknown. */
export function settledReason(state: string | null): string | null {
  if (state === null) return null;
  return SETTLED_STATES.includes(state) ? `it is already ${state.toLowerCase()}` : null;
}

/**
 * HOW LONG TO KEEP ASKING after a refused arm, and how often. Measured on #1020: the arm was refused on a pull request that was merging that same second, and a read one second later said OPEN. Five reads
 * two seconds apart is long enough for the platform to settle and short enough that a real refusal is not held up.
 */
const SETTLE_ATTEMPTS = 5;
const SETTLE_INTERVAL_MS = 2_000;
const sleepFor = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** What {@link armMergeOf} may be given besides the request: the sleep between reads, how many reads, how far apart, and where a read it could not make is said. */
export type ArmMergeSeams = { sleep?: (ms: number) => unknown; attempts?: number; intervalMs?: number; error?: (line: string) => void };

/** The state of the pull request once the arm was refused, asked up to `attempts` times with `sleep` between; `null` when it never reads as settled. A read that fails is said and counts as unread. */
function settledStateOf({ number, repo, run }: { number: string; repo: string; run: RowsRun }, { sleep, attempts, intervalMs }: Required<Pick<ArmMergeSeams, "sleep" | "attempts" | "intervalMs">>): string | null {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) sleep(intervalMs);
    let state: string | null = null;
    try {
      state = pullStateOf({ repo, number, run });
    } catch (cause) {
      console.error(`arm-pr: could not read #${number}'s state: ${(cause as Error).message}`);
    }
    if (state !== null && SETTLED_STATES.includes(state)) return state;
  }
  return null;
}

/** Why the pull request is armed already, or `null` for neither armed nor readable: a read that fails is said. */
function armedReasonUnlessUnreadable({ number, repo, run }: { number: string; repo: string; run: RowsRun }, error: (line: string) => void): string | null {
  try {
    return armedReasonOf({ repo, number, run });
  } catch (cause) {
    error(`arm-pr: could not read whether #${number} is already armed: ${(cause as Error).message}`);
    return null;
  }
}

/**
 * Arms the merge of pull request `number`: auto-merge, merge commit. If the arm is refused, the pull request may have SETTLED between the caller's read and the write (merged or closed meanwhile), or been
 * armed by the other door, so it is asked before the refusal is believed: settled, then armed. Only a refusal that neither explains is thrown. `armed: false` carries why nothing was left to arm.
 */
export function armMergeOf({ number, repo, run }: { number: string; repo: string; run: RowsRun }, seams: ArmMergeSeams = {}): { armed: boolean; reason: string } {
  const { sleep = sleepFor, attempts = SETTLE_ATTEMPTS, intervalMs = SETTLE_INTERVAL_MS, error = console.error } = seams;
  const nothingLeftToArm = (reason: string | null) => ({ armed: false, reason: `${reason} -- nothing was left to arm` });
  try {
    armPullAuto({ repo, number, run });
    return { armed: true, reason: "auto-merge enabled" };
  } catch (refusal) {
    const settled = settledStateOf({ number, repo, run }, { sleep, attempts, intervalMs });
    if (settled !== null) return nothingLeftToArm(settledReason(settled));
    const armed = armedReasonUnlessUnreadable({ number, repo, run }, error);
    if (armed !== null) return nothingLeftToArm(armed);
    throw refusal;
  }
}

// --- the trunk, for a jump to the front of the queue --------------------------------------------------------------------------------

/** One page of the runs of `workflow` on `main`, newest first. THROWS when the read is refused; a page with no `workflow_runs` list is an empty page. */
export function trunkRunsPage({ repo, workflow, page, perPage, run }: { repo: string; workflow: string; page: number; perPage: number; run: RowsRun }): any[] {
  const url = `repos/${repo}/actions/workflows/${workflow}/runs?branch=main&per_page=${perPage}&page=${page}`;
  return JSON.parse(run(["api", url])).workflow_runs ?? [];
}

const SEAT_QUERY = "query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r)"
  + "{pullRequest(number:$n){id headRefOid mergeStateStatus mergeQueueEntry{position state jump}}}}";

const JUMP_MUTATION = "mutation($id:ID!,$oid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,jump:true,expectedHeadOid:$oid})"
  + "{mergeQueueEntry{position state jump}}}";

/** The pull request's seat in the merge queue: its node id, its head, its merge state and its queue entry (null when it is not queued). THROWS when the read is refused or answers no pull request. */
export function readQueueSeat({ number, repo, run }: { number: string; repo: string; run: RowsRun }): QueueSeat {
  const [owner, name] = repo.split("/");
  const pr = JSON.parse(run(["api", "graphql", "-f", `query=${SEAT_QUERY}`, "-f", `o=${owner}`, "-f", `r=${name}`, "-F", `n=${number}`, "--jq", ".data.repository.pullRequest"]));
  if (!pr || typeof pr.id !== "string") throw new Error("the read answered no pull request");
  return pr;
}

/** The write: enqueues the pull request with `id` at the FRONT of the merge queue, expecting its head to be `headOid`. The answer is not the evidence: a caller reads the seat back. A refused write THROWS. */
export function jumpToFront({ id, headOid, run }: { id: string; headOid: string; run: RowsRun }): void {
  run(["api", "graphql", "-f", `query=${JUMP_MUTATION}`, "-f", `id=${id}`, "-f", `oid=${headOid}`]);
}

/** The command a person runs to take a pull request out of the merge queue by hand, for a message that says the dequeue failed. */
export const dequeueByHandCommand = (id: string): string => `gh api graphql -f query='mutation($id:ID!){dequeuePullRequest(input:{id:$id}){mergeQueueEntry{state}}}' -f id=${id}`;
