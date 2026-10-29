// @ts-check
// module: a pull request that is approved and green and is not merging (PURE) -- the card's "Approved, not merging", the hour that reaches Needs you, and a merge flow's first install (A11-291)
//
// AN APPROVED PULL REQUEST WITH GREEN CHECKS THAT NOTHING MERGES IS NOBODY'S WORK, AND THE BOARD CALLED IT "Awaiting review". a11ign/plugin#10 sat approved at 91cfe96d, mergeable, with every check green, for a day, because the repository had no
// merge flow (auto-merge off, no `auto-arm.yml`); the card read "Awaiting review … approved at 91cfe96d", which hid it. A pull request is in that state when the watch reads it open, into the default branch, approved at its head, with its required
// checks green, mergeable and NOT IN THE MERGE QUEUE; the pool stamps the first read of it (`PullHead.unmergedSince`, kept while the head and the reading stay), and once it has lasted `NOT_MERGING_MINUTES` it records the reason it could read
// (`PullHead.notMerging`), which is what makes the run read "Approved, not merging". After `NOT_MERGING_NEEDS_YOU_MINUTES` the run's `mergeNote` is a note under the escalation list's access item, which `runStatus` reads as Needs you: A NOTE ON THE RUN,
// NOT A CHANGE OF ITS WORK, as the reviewer's refusal is (A11-241), so the board still watches the pull request, answers its feedback and offers Approve and Publish. A pull request that ADDS the repository's first merge flow is the one no bot can
// merge, so it needs a person the day it is approved (`PullHead.firstFlow`), not a day later.
import { ARM_WORKFLOW_PATH, MERGE_BOT_WORKFLOW_PATH, type MergeFlow, type PullFeedback } from "../../plugins/contracts/code-host.ts";
import { escalationReason } from "../escalation.ts";
import { pullLabel } from "./pull-label.ts";
import { notMergingPulls, speaksOfMerge } from "./pull-readiness.ts";
import { isParked } from "./pull-status-and-notes.ts";
import { openPulls, type PullHead, type ViewEntry } from "./view-types-and-filters.ts";

/** How long a pull request may be approved and green, mergeable and out of the merge queue before the card says it is not merging. */
export const NOT_MERGING_MINUTES = 15;

/** How long it may be before the run reads Needs you, under the escalation list's access item. */
export const NOT_MERGING_NEEDS_YOU_MINUTES = 60;

const MINUTE_MS = 60_000;

/** What a card's line starts with while a pull request is not merging. */
export const NOT_MERGING_LABEL = "Approved, not merging";

/**
 * Whether a pull request is approved and green and nothing merges it, whatever GitHub says of `mergeable` at the moment: open, approved at its head, no required check red or running, not in conflict, and the host says it is not in the merge
 * queue. A host that does not say whether it is queued (contract 1.24 and before) leaves this false: a pull request is not called stuck on a guess. PURE.
 */
export function isApprovedUnqueued(head: PullHead, read: PullFeedback): boolean {
  const settled = head.review === "approved" && head.red?.length === 0 && head.pending?.length === 0;
  return read.state === "open" && settled && !read.conflicting && read.queue !== undefined && !read.queue.queued;
}

/**
 * Whether a pull request is approved and ready to merge and nothing is merging it: {@link isApprovedUnqueued} and mergeable. GitHub reads `mergeable` as unknown for a while after the base moves, so a read that is not mergeable but not in conflict
 * either neither starts the count nor ends it ({@link marksOf}). PURE.
 */
export const isApprovedUnmerged = (head: PullHead, read: PullFeedback): boolean => isApprovedUnqueued(head, read) && read.mergeable;

/**
 * Why an approved, green pull request is not merging, as far as it can be read: the repository has no merge flow (auto-merge not allowed, no arm workflow; or, for a private repository, no merge bot, and with one, that the bot has not merged it), else auto-merge is not on for the pull request, else it is armed but out of the queue, else
 * only that it is not in the queue. `flow` is null or absent when the host could not say. PURE.
 */
export function whyNotMerging(repository: string, read: PullFeedback, flow: MergeFlow | null | undefined): string {
  if (flow?.private === true && !(flow.autoMerge && flow.armWorkflow)) {
    // A private repository on GitHub Free has no merge queue: its flow is the merge bot (A11-291).
    return flow.mergeBot ? `the merge bot (${MERGE_BOT_WORKFLOW_PATH}) has not merged it` : `${repository} has no merge flow: no ${MERGE_BOT_WORKFLOW_PATH} (a private repository's flow is the merge bot)`;
  }
  const missing = [...(flow?.autoMerge === false ? ["auto-merge is not allowed"] : []), ...(flow?.armWorkflow === false ? [`no ${ARM_WORKFLOW_PATH}`] : [])];
  if (missing.length > 0) return `${repository} has no merge flow: ${missing.join(", ")}`;
  if (read.armed === false) return "auto-merge is not on for it, and it is not in the merge queue";
  return read.armed === true ? "auto-merge is on, but it is not in the merge queue" : "it is not in the merge queue";
}

/** What the watch can ask of the code host about a repository's merge flow: the answer, or null/undefined when it could not say. Asked only for a pull request that needs it. */
export type FlowOf = (repository: string) => Promise<MergeFlow | null | undefined>;

/** `owner/name` of a GitHub pull request's address, or null for any other. PURE. */
const repositoryOf = (url: string): string | null => /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+\/?$/.exec(url)?.[1] ?? null;

/** Whether the pull request changes the arm workflow's file or the merge bot's, and so may install the repository's merge flow. PURE. */
const touchesFlowFile = (read: PullFeedback): boolean => read.files.includes(ARM_WORKFLOW_PATH) || read.files.includes(MERGE_BOT_WORKFLOW_PATH);

/** Whether the repository has neither the arm workflow nor the merge bot on its default branch: a pull request that adds one gives it its FIRST merge flow. PURE. */
const hasNoFlowFile = (flow: MergeFlow | null | undefined): boolean => flow?.armWorkflow === false && flow.mergeBot === false;

/**
 * Whether a pull request that has been unmerged long enough is one the merge queue would take: it merges into the repository's default branch. A pull request stacked on another's branch waits on its base and is not stuck. Where the flow could
 * not be read the default branch is not known, and the pull request is called stuck as it was. PURE.
 */
const intoDefaultBranch = (read: PullFeedback, flow: MergeFlow | null | undefined): boolean => flow === null || flow === undefined || read.base === null || read.base === flow.defaultBranch;

/** The stamp a head keeps or starts: kept from the last watch while the head is the same, else started now, and only from a read that is ready to merge. */
const sinceOf = (head: PullHead, read: PullFeedback, earlier: PullHead | undefined, now: number): number | undefined =>
  earlier?.head === head.head && earlier.unmergedSince !== undefined ? earlier.unmergedSince : isApprovedUnmerged(head, read) ? now : undefined;

/** The marks one head earns from this read (A11-291), and the stamp it keeps from the last watch. */
async function marksOf(url: string, head: PullHead, read: PullFeedback, earlier: PullHead | undefined, now: number, flowOf: FlowOf): Promise<Pick<PullHead, "unmergedSince" | "notMerging" | "firstFlow">> {
  const repository = repositoryOf(url);
  const firstFlow = repository !== null && read.state === "open" && head.review === "approved" && touchesFlowFile(read) && hasNoFlowFile(await flowOf(repository));
  const first = firstFlow ? { firstFlow: true as const } : {};
  const since = isApprovedUnqueued(head, read) ? sinceOf(head, read, earlier, now) : undefined;
  if (since === undefined) return first;
  if (now - since <= NOT_MERGING_MINUTES * MINUTE_MS || repository === null) return { unmergedSince: since, ...first };
  const flow = await flowOf(repository);
  return { unmergedSince: since, ...(intoDefaultBranch(read, flow) ? { notMerging: whyNotMerging(repository, read, flow) } : {}), ...first };
}

/**
 * The heads as the watch records them, each marked by what its read says (A11-291): `unmergedSince` while it is approved and green and nothing merges it (kept from `before` while the head and the reading stay, else `now`; a moment in which GitHub
 * does not know whether it is mergeable keeps it), `notMerging` once that has lasted {@link NOT_MERGING_MINUTES} and the pull request goes into the default branch, and `firstFlow` while an approved head adds the repository's first merge flow. A head the
 * read does not cover, or that is none of these, carries no mark. `flowOf` is asked only for a head that needs it, one head at a time. PURE apart from `flowOf`.
 */
export async function markedHeads(heads: Readonly<Record<string, PullHead>>, reads: Readonly<Record<string, PullFeedback>>, before: Readonly<Record<string, PullHead>> | undefined, now: number, flowOf: FlowOf): Promise<Readonly<Record<string, PullHead>>> {
  const marked: Record<string, PullHead> = {};
  for (const [url, head] of Object.entries(heads)) {
    const { unmergedSince: _since, notMerging: _why, firstFlow: _first, ...unmarked } = head;
    const read = reads[url];
    marked[url] = read === undefined ? unmarked : { ...unmarked, ...(await marksOf(url, head, read, before?.[url], now, flowOf)) };
  }
  return marked;
}

/**
 * The line the card shows while a run's pull request is approved and not merging, one clause for each pull request that is, naming it, its head and the reason, or null when none is. A pull request of the run that is not stuck is not named, and
 * the run's status says Approved, not merging only when every open pull request is stuck. PURE.
 */
export function notMergingLine(entry: ViewEntry): string | null {
  const stuck = speaksOfMerge(entry) ? notMergingPulls(entry) : [];
  return stuck.length === 0 ? null : `${NOT_MERGING_LABEL}: ${stuck.map(({ url, head, why }) => `${pullLabel(url)} at ${head.head.slice(0, 8)}, ${why}`).join("; ")}`;
}

/**
 * The note for a finished run that is not parked, one sentence for each pull request that is the first install of a merge flow and is approved (A11-291): nothing can arm it, so a person merges it, and the board says so the day it is approved. Under the
 * escalation list's access item, which a merge flow's token and rules are. Null when none is, and while the run's ticket has Decisions no round has answered (`decisionsPending`, A11-305): the pull request is about to change, so a person is not asked to merge
 * it yet (a round the board has queued or is running holds no note either, since a note is written only over a finished run). PURE.
 */
export function firstFlowNote(entry: ViewEntry): string | null {
  if (!speaksOfMerge(entry) || isParked(entry) || entry.decisionsPending !== undefined) return null;
  const installs = openPulls(entry).flatMap(({ url }) => (entry.pullHeads?.[url]?.firstFlow === true ? [url] : []));
  return installs.length === 0 ? null : escalationReason("access", installs.map((url) => `${pullLabel(url)} adds ${repositoryOf(url) ?? "this repository"}'s first merge flow (${ARM_WORKFLOW_PATH} or ${MERGE_BOT_WORKFLOW_PATH}), so no bot exists to merge it: a person merges it`).join("; "));
}

/**
 * The note for a finished run that is not parked and has an open pull request approved and green that nothing has merged for more than {@link NOT_MERGING_NEEDS_YOU_MINUTES} minutes, one sentence for each such pull request naming it, its head and the
 * reason, under the escalation list's access item; null when none has. The minutes are not written in it, so the note is the same on every watch and the queue is not rewritten for a clock. PURE.
 */
export function stuckForAnHourNote(entry: ViewEntry, now: number): string | null {
  if (!speaksOfMerge(entry) || isParked(entry)) return null;
  const limit = NOT_MERGING_NEEDS_YOU_MINUTES * MINUTE_MS;
  const stuck = notMergingPulls(entry).filter(({ head }) => head.unmergedSince !== undefined && now - head.unmergedSince > limit);
  return stuck.length === 0 ? null
    : escalationReason("access", stuck.map(({ url, head, why }) => `${pullLabel(url)} has been approved at \`${head.head.slice(0, 8)}\` with green checks for more than ${NOT_MERGING_NEEDS_YOU_MINUTES} minutes and is not merging (${why}): a person decides`).join("; "));
}

/** The note a finished run's `mergeNote` should hold for its pull requests' merge, or null: a merge flow's first install comes first, since it needs a person at once. PURE. */
export const mergeNote = (entry: ViewEntry, now: number): string | null => firstFlowNote(entry) ?? stuckForAnHourNote(entry, now);
