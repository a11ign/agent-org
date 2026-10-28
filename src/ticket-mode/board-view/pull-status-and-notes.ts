import { CONCLUDED, HANDED_BACK, RESULT_KINDS, RUN_STATUSES, hasPlan, openPulls, pullsOf, type RunStatus, type ViewBlocker, type ViewEntry, type ViewTicket } from "./view-types-and-filters.ts";
import { pullAnswer } from "./pull-answer.ts";
import { completedEarly, settledByPulls } from "./pull-settled.ts";
import { isNotMerging, isReadyToMerge, waitsOnlyOnReview } from "./pull-readiness.ts";
import { overlapWait, type OverlapWait } from "./overlap-hold.ts";
import { currentStepOf, currentStepPaths, stepNamed } from "./plan-steps.ts";
import { parsePull } from "./pull-url.ts";
import { isStoppedFor, sequencedBlockers, ticketWaitEnded } from "./waits-on.ts";
import { clockOf } from "./update-banner.ts";
import { deadlineOf } from "./wait-deadline.ts";
import { DEFAULT_PUBLISH_WHEN, type PublishWhen } from "./publish-when.ts";

/**
 * The blockers still holding a queued run back, given every run on the queue. A blocker lets go once the tracker completes it, or, when it is on
 * the queue itself, once its run is completed, which its pull requests merging is enough for. Any blocker also lets go once its pull requests have
 * merged ({@link pullsMerged}), whatever state its ticket is in: a ticket whose pull request said `Refs` stays In Progress after the merge (A11-154).
 * That lets go only a blocker nothing more is coming from ({@link holdReason}): one with a live run holds, whatever its pull requests so far did, and so does one whose merged pull request
 * declared itself partial (A11-206). A canceled or duplicate blocker never lets go: the work it promised will not come, so a person decides. Waiting is not on order: an unblocked run queued later starts first. A blocker the run can
 * be stacked on ({@link stackedOn}) does not hold it back. A run the board stopped for a wait on other tickets is held by each of them until the tracker reads it completed or canceled, whether or not the tracker lists
 * it as a blocker yet, and is never stacked on it ({@link blockersOf}, {@link ticketWaitEnded}, A11-272). A review round on a pull request that is open waits on none of its ticket's other blockers: the pull request exists, and
 * what the round answers (a review, a conflict, a removal from the merge queue) does not need them finished (A11-298, {@link sequencedBlockers}).
 */
export function waitsOn(entry: ViewEntry, entries: readonly ViewEntry[]): ViewBlocker[] {
  return sequencedBlockers(entry).filter((blocker) => (isStoppedFor(entry, blocker) ? !ticketWaitEnded(blocker.state) : !isDoneFor(entry, blocker, entries) && stackBaseOf(entry, blocker) === null));
}

/** Whether the planner said the run waits for this blocker to merge, rather than stacking on it: its key is in the run's `waitMerged`. */
const waitsToMerge = (entry: ViewEntry, blocker: ViewBlocker): boolean => (entry.waitMerged ?? []).includes(blocker.key);

/** Whether a blocker is done: the tracker completed it, or its run on the queue is Completed. */
function isDone(blocker: ViewBlocker, entries: readonly ViewEntry[]): boolean {
  if (blocker.state === "completed") return true;
  const run = entries.find((e) => e.ticket.key === blocker.key);
  return run !== undefined && run.phase === "finished" && runStatus(run) === "completed";
}

/**
 * Whether a blocker's pull requests have merged: at least one has, and none is still open. Linear completes a ticket on a merge only where its
 * team's workflow says so, and not at all for a pull request that says `Refs`, so a run must not wait on the tracker's word alone. A canceled or
 * duplicate blocker never lets go, whatever its pull requests did.
 */
function pullsMerged(blocker: ViewBlocker): boolean {
  if (blocker.state === "canceled" || blocker.state === "duplicate") return false;
  const states = Object.values(blocker.pulls ?? {});
  return states.includes("merged") && !states.includes("open");
}

/** The words a blocker's live run is described by on a card: where it is, as {@link runStatus} reads its phase and fields. */
function liveWord(run: Omit<ViewEntry, "talkFrom">): string {
  if (run.phase === "finished" || run.waiting) return "waiting on a question";
  if (run.plan) return "planning";
  if (run.review) return "in a review round";
  return run.phase === "queued" ? "queued" : "running";
}

/**
 * The run of a blocker's ticket that is still at work, or null (A11-206): one queued, starting or running (planning, working, in a review round or waiting on a question), or finished but parked on a question,
 * whose workspace is still held ({@link isParked}). More of that ticket's work may come from it, whatever its pull requests did so far. A talk session is a person talking to a finished run, not more work on the
 * ticket, so it is judged by the run it resumed (`talkFrom`). PURE.
 */
function liveRunOf(key: string, entries: readonly ViewEntry[]): Omit<ViewEntry, "talkFrom"> | null {
  for (const entry of entries.filter((e) => e.ticket.key === key)) {
    const judged = entry.talk === true ? entry.talkFrom : entry;
    if (judged !== undefined && isAtWork(judged)) return judged;
  }
  return null;
}

/** Whether a run is at work or waits on a question: it has not finished, or it has and its workspace is still held ({@link isParked}). */
const isAtWork = (run: Omit<ViewEntry, "talkFrom">): boolean => run.phase !== "finished" || isParked(run);

/** The merged pull requests of a blocker. PURE. */
const mergedPullsOf = (blocker: ViewBlocker): string[] => Object.entries(blocker.pulls ?? {}).filter(([, state]) => state === "merged").map(([url]) => url);

/**
 * What a blocker's merged pull requests say remains of its ticket, or null when they leave nothing (A11-206). The bodies the run recorded (`blockersDeclared`) say it: some merged pull request declared `Partial:`
 * and none closed the ticket. Neither the blocker's pull requests nor their declarations carry a merge time, so "the last one declared partial" is read as that; in the sequence the brief gives (partial steps, then the
 * one that closes) the two agree. The blocker's own finished run on the board says it too, when its worker declared the pull requests partial and they merged, which needs no body read.
 */
function partialMergeOf(entry: ViewEntry, blocker: ViewBlocker, entries: readonly ViewEntry[]): string | null {
  const declared = mergedPullsOf(blocker).flatMap((url) => entry.blockersDeclared?.[url] ?? []);
  if (declared.some(({ kind }) => kind === "closes")) return null;
  for (const one of declared) if (one.kind === "partial") return one.remains;
  const run = entries.find((e) => e.ticket.key === blocker.key);
  return run === undefined ? null : mergedPartialOf(run);
}

/** What a finished run's worker declared remains of its ticket, once its pull requests have merged (the run then reads Needs you, or the board queues the next step in its place), or null. PURE. */
const mergedPartialOf = (run: ViewEntry): string | null => (run.phase === "finished" && settledByPulls(run) === "completed" ? (run.partial ?? null) : null);

/** Why a merged blocker holds for a partial merge, as a card says it: the plan step the `Partial:` words name, else that its last merged pull request is partial. PURE. */
function partialWord(remains: string): string {
  const step = stepNamed(remains);
  return step === null ? "its last merged pull request is partial" : `step ${step.step} of ${step.of} merged`;
}

/** Whether a merged pull request of a blocker has not had its body read for this run yet (A11-206): what it declared is not known. */
const hasUnread = (entry: ViewEntry, blocker: ViewBlocker): boolean => mergedPullsOf(blocker).some((url) => entry.blockersDeclared?.[url] === undefined);

/**
 * Why a blocker that is not done holds a run, as a card says it in brackets after the blocker's key, or null when nothing here holds it (A11-206). In this order: a live run holds, whatever its pull requests did so far ({@link liveRunOf});
 * a merged pull request that declared itself partial holds ({@link partialMergeOf}); a blocker whose run on the board is Completed holds nothing; and a blocker whose pull requests have merged ({@link pullsMerged}) holds while
 * a body is unread, since it may say `Partial:`. A canceled or duplicate blocker is not held here: a person decides, and the board says so. The tracker's own completion is checked before this. PURE.
 */
function holdReason(entry: ViewEntry, blocker: ViewBlocker, entries: readonly ViewEntry[]): string | null {
  if (blocker.state === "canceled" || blocker.state === "duplicate") return null;
  const live = liveRunOf(blocker.key, entries);
  if (live !== null) return liveWord(live);
  const remains = partialMergeOf(entry, blocker, entries);
  if (remains !== null) return partialWord(remains);
  if (isDone(blocker, entries) || !pullsMerged(blocker)) return null;
  return hasUnread(entry, blocker) ? "its merged pull requests are not read yet" : null;
}

/**
 * Whether a blocker is done for a run: the tracker completed it, else nothing holds it ({@link holdReason}) and either its run on the queue is Completed ({@link isDone}) or its pull requests have merged ({@link pullsMerged}),
 * whatever its ticket's state says.
 */
function isDoneFor(entry: ViewEntry, blocker: ViewBlocker, entries: readonly ViewEntry[]): boolean {
  if (blocker.state === "completed") return true;
  return holdReason(entry, blocker, entries) === null && (isDone(blocker, entries) || pullsMerged(blocker));
}

/** The repository a GitHub pull request is in, or null for a URL that is not one. */
export const repoOfPull = (url: string): string | null => parsePull(url)?.repo ?? null;

/**
 * The repository a run is planned for: the planner's, when its batch named one, else its project's (`project-repo.ts`). A planner's `null` falls back
 * to the project's, so a planner that names none does not suppress the default. PURE.
 */
export const repoOf = (entry: Pick<ViewEntry, "plannedRepo" | "projectRepo">): string | null => entry.plannedRepo ?? entry.projectRepo ?? null;

/** A blocker a run starts on top of: its key, the open pull request it stacks on in the run's repository (none when it has none there), that repository, its branch, and the commit the branch is at there (`head`, read by the pool; null when unknown). */
export type StackBase = Readonly<{ key: string; url: string | null; repo: string; branch: string; head: string | null }>;

/**
 * What a run stacks on for `blocker`, or null when it waits for it. A blocker is stackable in the run's repository when its branch is pushed there (`head`) or
 * it has an open pull request there, since a pull request is not needed for a branch to be built on. It is not when the planner said to wait for it to merge
 * (`waitMerged`), when it is canceled or a duplicate (a person decides), when its pull requests have all merged (its work is on the default branch), or when no
 * repository is planned or defaulted for the run. PURE.
 */
export function stackBaseOf(entry: ViewEntry, blocker: ViewBlocker): StackBase | null {
  const repo = repoOf(entry);
  if (repo === null || !blocker.branch || waitsToMerge(entry, blocker)) return null;
  if (blocker.state === "canceled" || blocker.state === "duplicate" || pullsMerged(blocker)) return null;
  const url = Object.entries(blocker.pulls ?? {}).find(([pull, state]) => state === "open" && repoOfPull(pull) === repo)?.[0] ?? null;
  const head = blocker.head ?? null;
  return url === null && head === null ? null : { key: blocker.key, url, repo, branch: blocker.branch, head };
}

/**
 * The blockers a run starts on top of rather than waits for. A blocker not yet done is one the run can stack on in its repository ({@link stackBaseOf}):
 * the run branches from the blocker's branch, and its pull request, when it opens one, is based on the blocker's branch. A run with no repository
 * stacks on nothing, and a finished run is stacked on nothing any more.
 */
export function stackedOn(entry: ViewEntry, entries: readonly ViewEntry[]): StackBase[] {
  if (entry.phase === "finished") return [];
  return (entry.blockers ?? []).flatMap((blocker) => {
    const base = isDoneFor(entry, blocker, entries) ? null : stackBaseOf(entry, blocker);
    return base === null ? [] : [base];
  });
}

/**
 * What the board says about a run stacked on its blockers: each with its open pull request, such as "Stacked on NBF-1 #12", and each without one, which
 * is stacked on its branch alone, such as "Stacked on NBF-1 (branch `x`, no pull request yet)".
 */
export const stackNote = (bases: readonly StackBase[]): string => `Stacked on ${bases.map(({ key, url, branch }) => (url === null ? `${key} (branch \`${branch}\`, no pull request yet)` : `${key} #${parsePull(url)?.number ?? url}`)).join(", ")}`;

/**
 * Why a run waits for one blocker it cannot stack on, as {@link waitNote} says it: a canceled blocker is a person's decision, and a blocker that holds for its live run, its partial merge or an unread body says which,
 * such as "Waits for NBF-1 (running)" (A11-206). A blocker whose pull requests merged and are all read holds nothing ({@link isDoneFor}). PURE.
 */
function blockerWait(entry: ViewEntry, blocker: ViewBlocker, entries: readonly ViewEntry[]): string {
  if (isStoppedFor(entry, blocker)) return `Waits for ${blocker.key} to be done: its worker waits on it`;
  if (blocker.state === "canceled" || blocker.state === "duplicate") return `${blocker.key} was ${blocker.state === "canceled" ? "canceled" : "marked a duplicate"}: a person decides`;
  const held = holdReason(entry, blocker, entries);
  if (held !== null) return `Waits for ${blocker.key} (${held})`;
  if (repoOf(entry) === null) return `Waits for ${blocker.key}: no repository is planned for this ticket, so it cannot stack`;
  return `Waits for ${blocker.key} to push its branch`;
}

/**
 * What the board says about a queued run held back, or null when none holds it: until its blockers merge, such as "Waits for NBF-1 to merge"; why it
 * cannot stack on one, such as "Waits for NBF-1 to push its branch"; or for a path another run holds, such as "Waits on NBF-1 #12: both touch pool.ts".
 */
export function waitNote(entry: ViewEntry, entries: readonly ViewEntry[]): string | null {
  const plan = entry.pathsFailure === undefined ? [] : [`Waits: its plan could not be downloaded (${entry.pathsFailure}); the board asks again on every pass`];
  if (entry.blockersFailure !== undefined) plan.push(`Waits: the tracker could not say which tickets block it (${entry.blockersFailure}); the board asks again on every pass`);
  if (entry.sessionWait !== undefined) plan.push(entry.sessionWait);
  if (entry.ciHold !== undefined && entry.ciHold.released !== true) plan.push(entry.ciHold.reason);
  const waits = waitsOn(entry, entries);
  const merging = waits.filter((blocker) => waitsToMerge(entry, blocker)).map((blocker) => {
    const held = holdReason(entry, blocker, entries);
    return held === null ? blocker.key : `${blocker.key} (${held})`;
  });
  if (merging.length > 0) return [...plan, `Waits for ${merging.join(", ")} to merge`].join("; ");
  const reasons = [...plan, ...waits.map((blocker) => blockerWait(entry, blocker, entries))];
  const overlap = overlapWait(entry, entries);
  if (overlap !== null) reasons.push(overlapNote(overlap));
  return reasons.length === 0 ? null : reasons.join("; ");
}

/**
 * Why a queued run waits for an overlap: the run, its pull request's number when it has one, and every path both touch, such as "Waits on NBF-1 #12: both touch pool.ts, server.ts"; or while the run's files are not read
 * yet. When every overlap is a directory claim and no file is shared, it adds whose directory to narrow, such as "a folder claim, not a shared file: narrow NBF-1's `src/` in its plan" (A11-212). PURE.
 */
function overlapNote(overlap: OverlapWait): string {
  const pull = overlap.pull === null ? "" : ` #${overlap.pull}`;
  if (overlap.path === null) return `Waits on ${overlap.key}${pull}: its changed files are not read yet`;
  const both = `Waits on ${overlap.key}${pull}: both touch ${named(overlap.overlaps.map(({ path }) => path))}`;
  const narrow = foldersToNarrow(overlap.overlaps);
  return narrow === null ? both : `${both}; a folder claim, not a shared file: narrow ${narrow.join(" and ")} in ${narrow.length === 1 ? "its plan" : "their plans"}`;
}

/** The most paths a card's wait line names; a hold over more says how many it leaves out. */
const MAX_PATHS_NAMED = 5;

/** The paths as the wait line lists them: the first {@link MAX_PATHS_NAMED}, then how many more there are. PURE. */
const named = (paths: readonly string[]): string =>
  (paths.length <= MAX_PATHS_NAMED ? paths : [...paths.slice(0, MAX_PATHS_NAMED), `and ${paths.length - MAX_PATHS_NAMED} more`]).join(", ");

/** Whose directory claims to narrow, as "A11-196's `ui/test/`, `ui/captures/`" for each run, when every overlap is a directory claim; null when a file is shared for real. PURE. */
function foldersToNarrow(overlaps: OverlapWait["overlaps"]): string[] | null {
  if (overlaps.some(({ folderOf }) => folderOf === null)) return null;
  const foldersOf = new Map<string, Set<string>>();
  for (const { folderOf, folder } of overlaps) {
    if (folderOf !== null && folder !== null) foldersOf.set(folderOf, (foldersOf.get(folderOf) ?? new Set()).add(`\`${folder}\``));
  }
  return [...foldersOf].map(([key, folders]) => `${key}'s ${[...folders].join(", ")}`);
}

/**
 * The repository a run's row names: the repositories it has made worktrees in, else the one it is planned for, saying whether its planner named it or its
 * project did; else the worker chooses one, which a queued run with no repository says (A11-116). PURE.
 */
export function repoLabel(entry: ViewEntry): string {
  if (entry.repos !== undefined && entry.repos.length > 0) return entry.repos.join(", ");
  const planned = repoOf(entry);
  if (planned !== null) return `${planned} (${entry.plannedRepo ? "planned" : "from its project"})`;
  return entry.phase === "queued" ? "the worker chooses the repo" : "choosing a repo";
}

/** The statuses of a run that waits on a review or a merge: the ones a board note (a stale block, a reviewer on a dialog, a reviewer herdr will not start) may turn into Needs you without taking the run's work from it. */
export const WAITS_ON_REVIEW: ReadonlySet<string> = new Set(["awaiting-review", "not-merging", "ready-to-merge", "published"]);

/** Whether the board left a note on the run that asks a person without changing its work: a reviewer herdr refused twice to start (A11-241), or a pull request approved and green that nothing merges (A11-291). */
const hasBoardNote = (entry: ViewEntry): boolean => entry.reviewerRefused !== undefined || entry.mergeNote !== undefined;

/**
 * What the board shows of a run's status: {@link workStatus}, except that a run waiting on a review or a merge whose reviewer herdr refused twice to start (`reviewerRefused`, A11-241) reads Needs you, since the board retries on
 * every sweep and only a person can mend what herdr says; so does one with a pull request approved and green that nothing has merged for an hour, or that installs a repository's first merge flow (`mergeNote`, A11-291). It is a NOTE on the run and not a change of its work: whether the board watches the run, offers Approve or Publish, or resumes its worker is decided by
 * `workStatus`, so a refused reviewer does not stop the board answering feedback on the pull request.
 */
export function runStatus(entry: ViewEntry, entries: readonly ViewEntry[] = []): RunStatus {
  const status = workStatus(entry, entries);
  return entry.phase === "finished" && hasBoardNote(entry) && WAITS_ON_REVIEW.has(status) ? "needs-you" : status;
}

/**
 * A run's status. A queued run is blocked while a ticket that blocks it is not done, and cannot be stacked on (`entries` is the whole queue, for {@link waitsOn}),
 * or while it waits on a path another run holds ({@link overlapWait}), or while its plan cannot be downloaded (`pathsFailure`). The
 * tracker's word wins once the run has finished: a ticket it completed is done and one it canceled is cancelled, whatever the run ended in. Then
 * its pull requests, whatever the outcome was: Linear completes a ticket on a merge only where its team's workflow says so, so a run whose pull requests
 * merged is done even while its ticket is still in progress (A11-153), unless its worker declared them partial: then the ticket is not done, and the run needs a person where
 * the board did not queue the next step (A11-168). A ticket the tracker completed while the run's work was partial needs a person too, ahead of the tracker's word, unless a person completed it
 * ({@link completedEarly}, A11-178). Before either, the outcome decides, except that a `needs-human` run whose pull request
 * was answered or approved is awaiting its review, not asking ({@link pullAnswer}). It never answers Publishing: that is {@link shownStatus}'s. Ignores `reviewerRefused`: that is {@link runStatus}'s note.
 */
export function workStatus(entry: ViewEntry, entries: readonly ViewEntry[] = []): RunStatus {
  if (entry.phase === "queued") return queuedHeld(entry, entries) ? "blocked" : "queued";
  // A talk session is Talking, never Planning, though it carries its planning run's `plan` (A11-171). One whose agent is blocked on a person still needs them.
  // A run parked on a wait its worker declared, or on background work, is Waiting and never In progress: nothing is at work in it (A11-272). A stalled note carries no `waiting`, so it stays In progress, flagged.
  if (entry.phase !== "finished") return entry.waiting ? "needs-you" : isTalking(entry) ? "talking" : entry.working?.waiting === true ? "waiting" : entry.plan ? "planning" : entry.review ? "reviewing" : "working";
  // The tracker's integration completed a ticket whose work is partial, and the board could not put it back: a person is asked, ahead of the tracker's word (A11-178).
  if (completedEarly(entry)) return "needs-you";
  if (entry.trackerState === "completed") return "completed";
  if (entry.trackerState === "canceled" || entry.trackerState === "duplicate") return "cancelled";
  const settled = settledByPulls(entry);
  // A pull request declared partial that merged does not finish the run: the board queued the next step in its place, or, where it could not, a person is asked (A11-168).
  if (settled === "completed" && entry.partial !== undefined) return "needs-you";
  if (settled !== null) return settled;
  // A parked talk session waiting for the person in its terminal: settled runs are not Talking, whatever pane they still hold (A11-171).
  if (isTalking(entry)) return "talking";
  // The planner marked the run as waiting on another ticket (A11-343): nothing is asked of a person, and a round starts when that ticket's pull request merges.
  if (entry.waitingOnTicket !== undefined) return "waiting";
  // The board stopped answering a run's red checks or feedback on its own and handed it to a person, whatever the run ended on (A11-154): Respond starts again.
  if (entry.handedBack !== undefined) return "needs-you";
  const kind = entry.outcome?.kind ?? "";
  if (kind === "draft-pr") return "awaiting-review";
  // A ready-pr run is never Ready to merge, but a machine that publishes before review posts it, and once posted it reads Published as a reviewed run does.
  if (kind === "ready-pr") return entry.published ? "published" : awaitingReview(entry);
  // A reviewed outcome says the worker's feedback round ended, not that GitHub would merge: the pull requests have to be approved at their head and green there (A11-179).
  if (kind === "reviewed") return entry.published ? "published" : isReadyToMerge(entry) ? "ready-to-merge" : awaitingReview(entry);
  if (kind === "needs-human" && pullAnswer(entry) !== null) return awaitingReview(entry);
  if (HANDED_BACK.has(kind)) return "needs-you";
  if (kind === "checked") return "checked";
  if (kind === "done") return "completed";
  return kind === "stopped" ? "cancelled" : "failed";
}

/**
 * What a run with an open pull request that nobody has merged reads: Awaiting review, except that a pull request approved at its head with green checks that nothing merges for 15 minutes (`NOT_MERGING_MINUTES`) reads
 * "Approved, not merging", since waiting for a review is not what it does (A11-291). A draft is left out: its Approve is what it waits for. Ready to merge is left as it is: Approve and Publish are offered from it.
 */
const awaitingReview = (entry: ViewEntry): RunStatus => (isNotMerging(entry) ? "not-merging" : "awaiting-review");

/** How long a wait has run, as the board says a duration: `5 min`, `1 h 28 min`. PURE. */
function waitedFor(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * The note a running run shows from its worker's `working` outcome: its reason, which says what of its own is still running; `Waiting on background work`
 * when the board reads the run as waiting on it (A11-236), with how long it has, counted from the outcome's time, when `now` is given, and the job it named
 * in place of the reason; or, once its agent has sat idle with no newer outcome for `tickets.stallMinutes`, or past the end of its wait, that it has stalled,
 * with that reason. A wait ends its words with when it ends, `, until 16:30` ({@link untilOf}). Null for any other run. A waiting run's status is Waiting ({@link workStatus}), a stalled run's stays In progress:
 * nothing is asked of a person, and a stalled run is only flagged so it is not forgotten.
 */
export function workingNote(entry: ViewEntry, now?: number): Readonly<{ text: string; stalled: boolean; waiting: boolean }> | null {
  const note = entry.working;
  if (entry.phase !== "running" || note === undefined) return null;
  if (note.stalled === true) {
    // `stallReason` is queue.ts's BACKGROUND_GONE when the pane showed no background work; this module imports nothing, so it reads the reason as text.
    return { text: `Stalled: ${note.stallReason ?? "idle with no newer outcome"} since it said: ${note.reason}`, stalled: true, waiting: false };
  }
  if (note.waiting !== true) return { text: note.reason, stalled: false, waiting: false };
  // A wait the worker declared (A11-245) reads as the board last read it, which the poll stored on the note: `Waiting on fleet job 123 (4 of 6 pages, about 20 min)`.
  if (note.waitText !== undefined) return { text: `${note.waitText}${untilOf(note)}`, stalled: false, waiting: true };
  const lasted = now === undefined || note.at === undefined ? "" : ` for ${waitedFor(now - note.at)}`;
  return { text: `Waiting on background work${lasted}: ${note.waitingOn ?? note.reason}${untilOf(note)}`, stalled: false, waiting: true };
}

/** When a waiting note's wait ends, as the card says it, `, until 16:30` (A11-272): the `until` its outcome gave, else three hours after it ({@link deadlineOf}); nothing when the note has no time. A wait past its deadline still says when it was due. PURE. */
function untilOf(note: NonNullable<ViewEntry["working"]>): string {
  if (note.at === undefined && note.until === undefined) return "";
  return `, until ${clockOf(deadlineOf({ at: note.at ?? 0, until: note.until }))}`;
}

/**
 * The line the board shows for a finished run whose reviewer's verdict is not on one of its pull requests (A11-83), or null when every verdict is.
 * The run's status does not change for it: a person reads the reason and decides, as the pool does not retry past its attempts.
 */
export function verdictNote(entry: ViewEntry): string | null {
  return entry.phase === "finished" && entry.verdictNotPosted !== undefined ? entry.verdictNotPosted : null;
}

/**
 * The line the board shows for a finished run with a stacked pull request whose base needs saying (A11-106), one per pull request, or null when none does.
 * The run's status does not change for it: a person reads what is needed, and the sweep clears it once the base is current.
 */
export function retargetNote(entry: ViewEntry): string | null {
  const notes = entry.phase === "finished" ? Object.values(entry.retargets ?? {}) : [];
  return notes.length > 0 ? notes.join("; ") : null;
}

/** The commit a stack note names: its first seven characters, as git's own short form does. PURE. */
const short = (sha: string): string => sha.slice(0, 7);

/** How many file names a conflict note names before it counts the rest. */
const CONFLICT_NOTE_FILES = 3;

/** The file names a conflict is in, as the board shows them: the first few, then how many more there are. PURE. */
const conflictFiles = (files: readonly string[]): string => {
  const names = files.map((file) => file.slice(file.lastIndexOf("/") + 1));
  const shown = names.slice(0, CONFLICT_NOTE_FILES);
  return names.length <= CONFLICT_NOTE_FILES ? shown.join(", ") : `${shown.join(", ")} and ${names.length - CONFLICT_NOTE_FILES} more`;
};

/**
 * The line the board shows for a run stacked on a blocker's branch that agent-org keeps current (A11-116, A11-150), or null when there is nothing to say:
 * that a merge of the blocker's branch conflicted and the worker is resolving it, such as "Resolving a conflict with NBF-1 in pool.ts"; that the board's rounds
 * ran out before it was resolved; that the blocker's branch moved and it is merged in when the worker stops; or that it was merged in by agent-org, such as
 * "Merged NBF-1 into the branch by agent-org (abc1234 → def5678)". The run's status does not change for it. PURE.
 */
export function rebaseNote(entry: ViewEntry): string | null {
  const base = entry.stackBase;
  if (base === undefined) return null;
  if (base.conflict !== undefined) {
    if (base.conflict.capped === undefined) return `Resolving a conflict with ${base.key} in ${conflictFiles(base.conflict.files)}`;
    // Said only while the run is handed back: that is when Respond to review starts another round. A parked run at the cap has none to start.
    return entry.handedBack === undefined ? null
      : `The board's ${base.conflict.capped} rounds are used up before the merge with ${base.key} was resolved: Respond to review starts another`;
  }
  if (base.seen !== undefined && entry.phase !== "finished") return `Will have ${base.key} merged in when the worker stops`;
  const merged = base.merged ?? base.rebased;
  if (merged !== undefined && merged.to === base.sha) return `Merged ${base.key} into the branch by agent-org (${short(merged.from)} → ${short(merged.to)})`;
  return null;
}

/**
 * The status the board shows for a run: its {@link runStatus}, except that a run Ready to merge, or Awaiting review out of draft (which a machine that publishes before review posts), is Publishing while the board's `publish` run is
 * posting it. The pool, and what a run offers or is watched for, go by `workStatus`, which still calls that run what it was.
 */
export function shownStatus(entry: ViewEntry, publish: ViewPublish | undefined, entries: readonly ViewEntry[] = []): RunStatus {
  const status = runStatus(entry, entries);
  return (status === "ready-to-merge" || awaitsReviewOutOfDraft(entry, status)) && isBeingPublished(entry, publish) ? "publishing" : status;
}

/** How many runs have each status, as the board shows them. */
export function statusCounts(entries: readonly ViewEntry[], publish?: ViewPublish): Map<RunStatus, number> {
  const counts = new Map<RunStatus, number>(RUN_STATUSES.map(({ status }) => [status, 0]));
  for (const status of entries.map((entry) => shownStatus(entry, publish, entries))) counts.set(status, (counts.get(status) ?? 0) + 1);
  return counts;
}

/** The runs a filter shows (every run for `null`), the most recently active first, as GitHub lists its runs. */
export function runsShown<T extends ViewEntry>(entries: readonly T[], filter: RunStatus | null, publish?: ViewPublish): T[] {
  const latest = (entry: ViewEntry) => entry.finishedAt ?? entry.startedAt ?? entry.queuedAt ?? 0;
  return entries.filter((entry) => filter === null || shownStatus(entry, publish, entries) === filter).sort((a, b) => latest(b) - latest(a));
}

/** A parked run: a finished one that kept its herdr workspace, so a person can still answer its agent there. It holds no slot. */
export const isParked = (entry: ViewEntry): boolean => entry.phase === "finished" && entry.workspace !== undefined;

/** A talk session that holds its pane: its agent is starting or running in it, or waits there for the person (parked). A queued one holds none yet (A11-171). */
const isTalking = (entry: ViewEntry): boolean => entry.talk === true && entry.phase !== "queued" && (entry.phase !== "finished" || isParked(entry));

/** What a person can do to a run from the board: a verb the board sends to one queued run, `POST /api/queue/<key>/<verb>`. */
export type RunAction = "remove" | "stop" | "retry" | "close" | "approve" | "respond" | "talk" | "dismiss" | "apply-edit" | "discard-edit" | "start-anyway";

/** Why a person presses Start anyway, shown as its tooltip: the run starts beside the run that holds a path it shares, and the two may conflict on it. */
export const START_ANYWAY_TITLE = "Start this run now, beside the run that holds a path it shares: the two may conflict on that path";

/**
 * Whether a queued run may be started anyway: it is Blocked on an overlap with a run that holds a path it shares, and on no ticket that blocks it, nor
 * on its plan's download (a plan that could not be read). PURE.
 */
const startAnywayOffered = (entry: ViewEntry, entries: readonly ViewEntry[]): boolean =>
  entry.phase === "queued" && unblockedByTicket(entry, entries) && overlapWait(entry, entries) !== null;

/** Whether a queued run waits on no ticket that blocks it, its plan could be read, and no session holds it back, so an overlap alone may hold it. PURE. */
const unblockedByTicket = (entry: ViewEntry, entries: readonly ViewEntry[]): boolean =>
  entry.pathsFailure === undefined && entry.blockersFailure === undefined && entry.sessionWait === undefined && waitsOn(entry, entries).length === 0;

/** Whether a queued run is held back: by a ticket that blocks it, by a path another run holds, or by a plan that could not be downloaded. PURE. */
const queuedHeld = (entry: ViewEntry, entries: readonly ViewEntry[]): boolean =>
  !unblockedByTicket(entry, entries) || overlapWait(entry, entries) !== null;

/**
 * The note a run started past its overlap keeps on its row, for as long as it is on the board (A11-125): which run it overlapped, and where, such as
 * "Started anyway: it overlapped A11-98 #12 on src/pool.ts; a person overrode the wait". Null for a run started any other way. PURE.
 */
export function overrideNote(entry: ViewEntry): string | null {
  const override = entry.overlapOverride;
  if (override === undefined) return null;
  const pull = override.pull === null ? "" : ` #${override.pull}`;
  const where = override.path === null ? "before its changed files were read" : `on ${override.path}`;
  return `Started anyway: it overlapped ${override.holder}${pull} ${where}; a person overrode the wait`;
}

/** Why a person presses Approve, shown as its tooltip: the drafts are reviewed. */
export const APPROVE_TITLE = "Drafts reviewed and approved: mark the pull requests ready, then see them through their checks and review";

/** Why a person presses Respond to review, shown as its tooltip: the pull requests are open, and have feedback to answer. */
export const RESPOND_TITLE = "Answer the feedback on these pull requests now: their reviews, comments and failing checks";

/** Why a person presses Dismiss, shown as its tooltip: only the board's record goes. */
export const DISMISS_TITLE = "Take this run off the board, closing its workspace if it is open. The ticket, its branch and its pull requests are left as they are";

/** Why a person presses Dismiss on a run with a proposed edit, shown as its tooltip: the proposal goes with the run (A11-91). */
export const DISMISS_EDIT_TITLE = `${DISMISS_TITLE}. Its proposed edit to the ticket's text is dropped too`;

/** Why a person presses Apply edit, shown as its tooltip: the worker's proposed title and description are written to the ticket. */
export const APPLY_EDIT_TITLE = "Write the worker's proposed title and description to the ticket. Refused when the ticket has changed since the worker proposed them";

/** Why a person presses Discard edit, shown as its tooltip: the proposal is dropped and the ticket is left as it is. */
export const DISCARD_EDIT_TITLE = "Drop the worker's proposed edit. The ticket is left as it is";

/** Whether a finished run holds a worker's proposed edit to its ticket's text, which a person has not applied or discarded (A11-91). */
export const hasEdit = (entry: ViewEntry): boolean => entry.outcome?.edit !== undefined;

/** Whether a finished run left nothing to talk about: it has no outcome, was stopped, concluded, or is completed or canceled. PURE. */
function hasNothingToSay(kind: string | undefined, status: string): boolean {
  return kind === undefined || kind === "stopped" || CONCLUDED.has(kind) || status === "completed" || status === "cancelled";
}

/** Whether a finished run offers Respond to review: a pull request is open, its tracker and pull requests have not settled it, and it did not conclude or get stopped (A11-154). PURE. */
function respondOffered(entry: ViewEntry, status: string): boolean {
  const kind = entry.outcome?.kind ?? "";
  const settled = status === "completed" || status === "cancelled";
  return openPulls(entry).length > 0 && !settled && !CONCLUDED.has(kind) && kind !== "stopped";
}

/**
 * The actions a run offers. A queued run can be removed, or started anyway when it is Blocked on an overlap ({@link startAnywayOffered}), and a live one stopped. A finished run that kept its workspace (parked) can be closed,
 * and only once it is closed can it be retried. Pull requests are results, and are not retried, and nor is a run that concluded with nothing more
 * to do ({@link CONCLUDED}). Drafts awaiting review offer Approve, which marks them ready. Every other finished run with a pull request still open, that
 * its tracker has not completed or canceled and whose pull requests have not all merged or closed, offers Respond to review, which answers their feedback now:
 * whatever its outcome was, and a parked one too, whose workspace Respond closes first (A11-154). EVERY FINISHED RUN OFFERS DISMISS, last, a parked one
 * too, so no run stays on the board for ever: it takes the run off the board and closes its workspace if one is open. A run the publish run under
 * way is posting is the exception: `queue.ts`'s `dismiss` keeps it until it has posted, so it is not offered there either.
 */
export function runActions(entry: ViewEntry, publish?: ViewPublish, entries: readonly ViewEntry[] = []): RunAction[] {
  if (entry.phase === "queued") return startAnywayOffered(entry, entries) ? ["start-anyway", "remove"] : ["remove"];
  // A talk session offers Talk while it holds its pane: the press finds that pane again rather than opening another (A11-171).
  if (entry.phase !== "finished") return isTalking(entry) ? ["talk", "stop"] : ["stop"];
  const dismiss: RunAction[] = isBeingPublished(entry, publish) ? [] : ["dismiss"];
  const edit: RunAction[] = hasEdit(entry) ? ["apply-edit", "discard-edit"] : [];
  const status = workStatus(entry);
  const kind = entry.outcome?.kind;
  const respond: RunAction[] = respondOffered(entry, status) ? ["respond"] : [];
  if (isParked(entry)) return [...(isTalking(entry) ? ["talk" as const] : []), "close", ...respond, ...edit, ...dismiss];
  // A session is worth opening for any run that ended with something to say, and for none that concluded or whose pull requests all merged.
  const talk: RunAction[] = hasNothingToSay(kind, status) ? [] : ["talk"];
  if (status === "awaiting-review" && kind === "draft-pr") return ["approve", ...talk, ...edit, ...dismiss];
  const done = kind === undefined || RESULT_KINDS.has(kind) || CONCLUDED.has(kind) || status === "completed";
  return [...respond, ...(done ? [] : ["retry" as const]), ...talk, ...edit, ...dismiss];
}

/**
 * Whether the board watches a run's pull requests for new feedback: it is Ready to merge or Published, a reviewed run still waiting on its review or its checks (A11-179: it is read again until
 * it merges, or it could never become ready), or a ready-pr run waiting for review (opened ready on a machine with `tickets.drafts: false`, with no Approve to come). It holds no workspace, and has a
 * pull request still open. Merged or closed pull requests are never watched.
 */
export function isWatched(entry: ViewEntry): boolean {
  const status = workStatus(entry);
  const waitingReady = (status === "awaiting-review" || status === "not-merging") && (entry.outcome?.kind === "ready-pr" || entry.outcome?.kind === "reviewed");
  return (status === "ready-to-merge" || status === "published" || waitingReady) && !isParked(entry) && openPulls(entry).length > 0;
}

/**
 * Whether the board resumes a run's worker when one of its pull requests conflicts with its base (A11-89): a run {@link isWatched} is, and so is a
 * finished run with a pull request still open that is not a result, concluded or stopped. That is a run parked on a question (`needs-human`), one
 * that ended with no outcome or crashed, or one that handed its ticket back: the worker can clear a conflict itself, so the board does not wait on a
 * person. A run the tracker completed or canceled is left alone, and so is one whose pull requests all merged or closed.
 */
export function resumesOnConflict(entry: ViewEntry): boolean {
  // A run the planner marked as waiting on a ticket gets its round when that ticket's pull request merges, not from the feedback it waits out (A11-343).
  if (entry.waitingOnTicket !== undefined) return false;
  if (isWatched(entry)) return true;
  const kind = entry.outcome?.kind ?? "";
  const status = workStatus(entry);
  return entry.phase === "finished" && openPulls(entry).length > 0 && !RESULT_KINDS.has(kind) && !CONCLUDED.has(kind) && kind !== "stopped"
    && status !== "completed" && status !== "cancelled";
}

/** Whether the tracker settled the run's ticket: completed, canceled or marked a duplicate. A ticket it completed while a later step is open still reads Needs you ({@link completedEarly}), so the status alone does not say it. */
const trackerSettled = (entry: ViewEntry): boolean => ["completed", "canceled", "duplicate"].includes(entry.trackerState ?? "");

/**
 * Whether the board brings a finished run's open pull requests up to date with their base (A11-293, {@link mergeBaseInto} in `pool-base-merge.ts`): every finished run with a pull request still open, whatever its status, Needs you included, since a
 * conflict rots just as well on a run waiting for a person. A run that concluded with nothing more to do, one a person stopped and one whose ticket the tracker settled are left alone, as {@link resumesOnConflict} leaves them. Whether a worker is woken
 * for the conflict is that function's.
 */
export function mergesBase(entry: ViewEntry): boolean {
  const kind = entry.outcome?.kind ?? "";
  return entry.phase === "finished" && openPulls(entry).length > 0 && !CONCLUDED.has(kind) && kind !== "stopped" && !trackerSettled(entry);
}

/** The fields of the board's publish run that the page reads: its workspace and pane are set once it runs, and dropped when it ends. */
export type ViewPublish = Readonly<{ keys: readonly string[]; phase: string; failure?: string; workspace?: string; pane?: string }>;

/** Whether the publish run is still to finish: queued, starting or running. */
export const isPublishing = (publish: ViewPublish | undefined): boolean => publish !== undefined && publish.phase !== "finished";

/** Whether the publish run still to finish is the one posting this run's pull requests. */
export const isBeingPublished = (entry: ViewEntry, publish: ViewPublish | undefined): boolean =>
  isPublishing(publish) && publish?.keys.includes(entry.ticket.key) === true;

/** The outcomes whose pull requests are out of draft: what a machine that publishes before review can publish while they await review. */
const OUT_OF_DRAFT: ReadonlySet<string> = new Set(["reviewed", "ready-pr"]);

/** Whether a run is awaiting review on pull requests out of draft: the runs besides Ready to merge that a machine publishing before review posts, and that {@link shownStatus} shows as Publishing meanwhile. */
const awaitsReviewOutOfDraft = (entry: ViewEntry, status: RunStatus): boolean =>
  (status === "awaiting-review" || status === "not-merging") && OUT_OF_DRAFT.has(entry.outcome?.kind ?? "");

/**
 * Whether a run's work reaches the point this machine publishes at: Ready to merge under either setting, and, under `awaiting-review`, a run out of draft (`reviewed` or `ready-pr`) whose open pull requests
 * were all read and wait on their review and nothing else ({@link waitsOnlyOnReview}). A draft never does: nothing reaches the channel before a person approved it.
 */
function reachesPublish(entry: ViewEntry, when: PublishWhen): boolean {
  const status = workStatus(entry);
  if (status === "ready-to-merge") return true;
  return when === "awaiting-review" && awaitsReviewOutOfDraft(entry, status) && openPulls(entry).length > 0 && waitsOnlyOnReview(entry);
}

/**
 * Whether a run can be ticked for Publish: its work reaches the point this machine publishes at ({@link reachesPublish}), by default once it is Ready to merge. A published run, a parked one, and one the
 * publish run in progress holds are not. `queuePublish` asks the same, so the board never offers what the server refuses.
 */
export const publishable = (entry: ViewEntry, publish?: ViewPublish, when: PublishWhen = DEFAULT_PUBLISH_WHEN): boolean =>
  reachesPublish(entry, when) && !isParked(entry) && !isBeingPublished(entry, publish);

/** The Publish button's words for `count` ticked runs. */
export const publishLabel = (count: number): string => `Publish selected (${count})`;

/** What the Board says about the last publish run: that it is under way, or why it failed. Null once it published, and when there is none. */
export function publishNote(publish: ViewPublish | undefined): string | null {
  if (publish === undefined) return null;
  const runs = `${publish.keys.length} run${publish.keys.length === 1 ? "" : "s"}`;
  if (isPublishing(publish)) return `Publishing ${runs}`;
  return publish.failure === undefined ? null : `Publishing ${runs} failed: ${publish.failure}`;
}

/**
 * The web address of a run's live terminal: `template` (the host file's `tickets.terminal`) with the run's `{workspace}`, `{pane}` and `{key}`
 * filled in, each encoded for a URL. Null when the machine serves no terminal or the run holds no pane.
 */
export function terminalLink(template: string | null, entry: ViewEntry): string | null {
  if (template === null || entry.workspace === undefined || entry.pane === undefined) return null;
  const values: Readonly<Record<string, string>> = { workspace: entry.workspace, pane: entry.pane, key: entry.ticket.key };
  return template.replace(/\{(workspace|pane|key)\}/g, (_, name: string) => encodeURIComponent(values[name]));
}

/**
 * The web address of the publish run's terminal, which every run that shows Publishing links on its own row: `terminalLink` with the publish
 * run's workspace and pane in place of the run's own. Null for any other run, and while the publish run has no pane yet.
 */
export const publishTerminalLink = (template: string | null, entry: ViewEntry, publish: ViewPublish | undefined): string | null =>
  shownStatus(entry, publish) === "publishing" ? terminalLink(template, { ...entry, workspace: publish?.workspace, pane: publish?.pane }) : null;

type Choice = Readonly<{ model: string; effort: string }>;

/** The model and effort the tickets queued next run with: the default, with the parts chosen for this batch in its place. */
export const batchChoice = (defaults: Choice, batch: Partial<Choice>): Choice => ({ ...defaults, ...batch });

/**
 * The parts of `chosen` that differ from the default, which is all a batch keeps. A part chosen equal to the default is dropped, so the batch
 * follows the default there when the default changes.
 */
export const batchOverride = (defaults: Choice, chosen: Choice): Partial<Choice> => ({
  ...(chosen.model === defaults.model ? {} : { model: chosen.model }),
  ...(chosen.effort === defaults.effort ? {} : { effort: chosen.effort }),
});

/** Whether a batch runs on the default, having chosen nothing of its own. */
export const isDefaultBatch = (batch: Partial<Choice>): boolean => Object.keys(batch).length === 0;

/** What the Pick footer says beside the batch's model and effort. */
export const batchNote = (defaults: Choice, batch: Partial<Choice>): string =>
  isDefaultBatch(batch) ? "The default" : `These tickets only. The default is ${defaults.model} at ${defaults.effort} effort`;

/** What the Board says about how many workers run at once. */
export const workersLabel = (max: number): string => `Up to ${max} worker${max === 1 ? "" : "s"} at once`;

/** The Queue button's words for `count` selected tickets, `planning` of which are planned first. */
export function queueLabel(count: number, planning = 0): string {
  if (count === 0) return "Select tickets to queue";
  const queue = `Queue ${count} ticket${count === 1 ? "" : "s"}`;
  if (planning === 0) return queue;
  const which = planning < count ? String(planning) : count === 1 ? "it" : "all";
  return `${queue}, planning ${which} first`;
}

/** How many of `tickets` have no plan of their own, so would be planned first. */
export const unplannedCount = (tickets: readonly ViewTicket[], plan: RegExp): number => tickets.filter((t) => !hasPlan(t, plan)).length;
