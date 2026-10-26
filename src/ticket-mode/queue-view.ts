// @ts-check
// module: the queue as the page is sent it (A11-270) -- a list view the pages poll every 5 s, and one run in full, read on demand
//
// THE LIST VIEW IS SMALL BECAUSE THE PAGES POLL IT. `GET /api/queue` answered every field of every run the board ever queued, 1.1 MB on the agents host, and the shell reads it every 5 s on every page, over an SSH tunnel on
// the chairman's Mac. A run in the list keeps the fields a list page, and the board-view code those pages run, read (`LIST_FIELDS`), with its ticket's key, title and address. `GET /api/queue/<key>` answers the run in
// full, with its log, for the run's own page. A run that holds no path (it ended, and so did its ticket) drops the files it once held, which nothing reads of it.
import type { Entry, Queue, WriterRun } from "./queue/queue-entries-and-outcomes.ts";
import type { CiView } from "./board-view/ci-note.ts";
import { ENDED_TICKETS } from "./board-view/overlap-hold.ts";
import type { RunEvent } from "./queue/run-log.ts";
import type { ReadBoard } from "./read-routes.ts";
import { ciViewOf } from "./ci-spend/view.ts";
import { afterMergeView } from "./after-merge/route.ts";
import type { Ticket } from "./source.ts";

/**
 * The fields of a run the list pages read. It is the fields of `ViewEntry` (`board-view/view-types-and-filters.ts`), which every function the pages run on a run is typed by, and `tokens`, which a row draws. The UI's types
 * name a run by this list, so a page that reads a field left out fails its `tsc`.
 */
export const LIST_FIELDS = [
  "ticket", "phase", "outcome", "waiting", "prompt", "declined", "trackerState", "pullStates", "queuedAt", "startedAt", "finishedAt", "workspace", "pane", "blockers", "model", "effort", "pathsFailure", "toolVersion",
  "stoppedForUpdate", "stoppedForBlocker", "ciHold", "resume", "sessionWait", "sessionNote", "overlapOverride", "waitSince", "repos", "plan", "planned", "ticketChange", "ticketChanges", "learned", "review", "batch", "talkFrom",
  "blockersDeclared", "talk", "partial", "declared", "partialOverruled", "steps", "completedBy", "reopenFailure", "afterMerge", "planSteps", "plannedRepo", "projectRepo", "paths", "stepPaths", "pullFiles", "waitMerged",
  "published", "worker", "handedBack", "readopted", "lostInRestart", "working", "verdictNotPosted", "reviewerRefused", "retargets", "stackBase", "checkHeads", "queueHeads", "outcomeHeads", "outcomeBlocks", "pullHeads", "tokens",
] as const satisfies readonly (keyof Entry)[];

/** What a list draws of a run's ticket. The description and the rest of its text are in the run's full read. */
export type ListTicket = Pick<Ticket, "key" | "title" | "url">;

/** A run as the list is sent it. */
export type QueueListEntry = Readonly<Omit<Pick<Entry, (typeof LIST_FIELDS)[number]>, "ticket" | "talkFrom"> & {
  ticket: ListTicket;
  talkFrom?: QueueListEntry;
  ci?: CiView;
}>;

/** A run in full, as its own page reads it: the list's fields, and whichever of the rest the board holds. A list entry is one, so a page can draw from the list until the full read answers. */
export type RunDetailEntry = Omit<QueueListEntry, "ticket"> & Readonly<Partial<Omit<Entry, keyof QueueListEntry | "ticket">> & { ticket: ListTicket & Partial<Ticket> }>;

/** What `GET /api/queue/<key>` answers: the run in full, and its log, oldest event first. */
export type QueueEntryView = Readonly<{ entry: RunDetailEntry; runLog: readonly RunEvent[] }>;

/** The phases in which a run holds or contests paths. */
const PATH_PHASES: ReadonlySet<string> = new Set(["queued", "starting", "running"]);

/**
 * Whether nothing reads the files a run claimed (`paths`, `stepPaths`, `pullFiles`): it is neither queued nor live, and its ticket has ended, so it holds no path (`holds` and `contested` in `board-view/overlap-hold.ts`) and
 * is no wait. PURE.
 */
const claimsNothing = (entry: Entry): boolean => !PATH_PHASES.has(entry.phase) && ENDED_TICKETS.has(entry.trackerState ?? "");

/**
 * The fields the page's code reads of a run only in a case this run is not in, so the list leaves them out: the pull requests a queued run's planner learns from are shown for a queued run alone (`learnsFrom`), and
 * what a blocker's merged pull requests declared is looked at only for a blocker the tracker has not completed (`isDoneFor`). PURE.
 */
function unreadFields(entry: Entry): readonly (keyof Entry)[] {
  const filesUnread: readonly (keyof Entry)[] = claimsNothing(entry) ? ["paths", "pullFiles"] : [];
  const learnedUnread: readonly (keyof Entry)[] = entry.phase === "queued" ? [] : ["learned"];
  const declaredUnread: readonly (keyof Entry)[] = (entry.blockers ?? []).every(({ state }) => state === "completed") ? ["blockersDeclared"] : [];
  return [...filesUnread, ...learnedUnread, ...declaredUnread];
}

/** A step-by-step plan's `stepPaths` keeps its keys, since which step a run is on is told by them (`currentStepOf`), and loses the files. */
const withoutFiles = (stepPaths: NonNullable<Entry["stepPaths"]>): NonNullable<Entry["stepPaths"]> => Object.fromEntries(Object.keys(stepPaths).map((step) => [step, []]));

/** A run as the list is sent it: its list fields without those it is not read for (see {@link unreadFields}), its ticket's key, title and address, its last ticket change, and its CI. PURE. */
export function listEntry(entry: Entry, ci?: CiView): QueueListEntry {
  const unread = unreadFields(entry);
  const fields = LIST_FIELDS.filter((field) => entry[field] !== undefined && !unread.includes(field));
  const { ticket: { key, title, url }, ticketChanges, talkFrom, stepPaths, ...kept } = Object.fromEntries(fields.map((field) => [field, entry[field]])) as unknown as Entry;
  return {
    ...kept, ticket: { key, title, url },
    ...(ticketChanges ? { ticketChanges: ticketChanges.slice(-1) } : {}),
    ...(stepPaths ? { stepPaths: claimsNothing(entry) ? withoutFiles(stepPaths) : stepPaths } : {}),
    ...(talkFrom ? { talkFrom: listEntry(talkFrom as Entry) } : {}),
    ...(ci === undefined ? {} : { ci }),
  };
}

/**
 * A run as its own page is sent it, without the copies of its ticket's text the board keeps to tell a change by (`briefedAgainst`, `plannedAgainst`; A11-167): the page draws a change from `ticketChange` and
 * `ticketChanges`, which hold the two texts of a change, and each run already carries its ticket. The step a conflict round holds back (`afterRound`, A11-286) is a whole entry of its own, and is not sent.
 */
export function shownEntry(entry: Entry): Entry {
  const { briefedAgainst: _briefed, plannedAgainst: _planned, afterRound: _held, ticketChanges, talkFrom, ...shown } = entry;
  // Only the latest change is drawn; and a talk session's copy of the run it replaced is shown as that run is.
  return { ...shown, ...(ticketChanges ? { ticketChanges: ticketChanges.slice(-1) } : {}), ...(talkFrom ? { talkFrom: shownEntry(talkFrom as Entry) } : {}) };
}

/** A new-ticket run without its Grill's ticket text: the board keeps that text to compare, and the page is not sent it (A11-134). */
export function shownWriter(run: WriterRun): Omit<WriterRun, "startedFrom"> {
  const { startedFrom: _startedFrom, ...shown } = run;
  return shown;
}

type ViewBoard = Pick<ReadBoard, "store" | "pool" | "update" | "settings">;

/** The CI of a run for the page, from the runs the board holds (A11-261). */
const ciOf = (board: ViewBoard, queue: Queue, entry: Entry): CiView | undefined => ciViewOf(queue, entry, board.settings.ciBudgetMinutes);

/** What `/api/queue` answers, and every route that changes the queue. The UI's client names this type, so a field renamed here fails its `tsc`. */
export type QueueView = ReturnType<typeof queueView>;

/** The events of each run's log that say the board opened a pull request for it, by ticket key: the whole of the log the Runs page reads (`unlistedPulls`, A11-286), which is the run's own page's to read in full. */
function openedPullLog(runLog: Queue["runLog"]): Readonly<Record<string, readonly RunEvent[]>> {
  return Object.fromEntries(Object.entries(runLog ?? {}).flatMap(([key, events]) => {
    const opened = events.filter(({ kind }) => kind === "pr-opened");
    return opened.length === 0 ? [] : [[key, opened]];
  }));
}

/** The queue as the pages read it: the stored queue with each run as the list sends it, and why runs are held (`tickets.preflight`), or null while none is. The page's one picture of what the board is doing. */
export function queueView(board: ViewBoard) {
  // `pulls`: the review state of each open pull request the pool has read, by url, as the board words it (A11-119). `claimWarning`: the one line for review claims GitHub refuses, or null (A11-172). `hostAlerts`: what is wrong with the host itself, each with when it began (A11-279). `writers`: each run as the page
  // is sent it, without a Grill run's ticket text (A11-134). `ci`: what each run's and its ticket's pushes cost in CI, read from the workflow runs the board holds, which are not sent (A11-261). The tally of interventions is not sent either: `/api/interventions` answers it (A11-257). The runs' logs are not sent but for the events that
  // opened a pull request (`openedPullLog`); a run's page reads its own (`queueEntryView`).
  const { ciSpend: _ciSpend, interventions: _interventions, runLog, ...queue } = board.store.get();
  const entries = queue.entries.map((entry) => listEntry(entry, ciOf(board, board.store.get(), entry)));
  // `update`: the version this instance runs and the breaking update that drains, if one does (A11-169), so the page words the banner and each run's line from one reading. `afterMergeChecks`: the open checks, oldest first (A11-277).
  return { ...queue, entries, openedPullLog: openedPullLog(runLog), writers: (queue.writers ?? []).map(shownWriter), held: board.pool.held?.() ?? null, pulls: board.pool.pullReviews?.() ?? {}, claimWarning: board.pool.claimWarning?.() ?? null, hostAlerts: board.pool.hostAlerts?.() ?? [], update: board.update(),
    afterMergeChecks: afterMergeView(board.settings.stateDir) };
}

/** One run in full, with its log, as `GET /api/queue/<key>` answers it; null for a ticket the queue holds no run of. */
export function queueEntryView(board: ViewBoard, key: string): QueueEntryView | null {
  const queue = board.store.get();
  const entry = queue.entries.find((candidate) => candidate.ticket.key === key);
  if (entry === undefined) return null;
  const ci = ciOf(board, queue, entry);
  return { entry: { ...shownEntry(entry), ...(ci === undefined ? {} : { ci }) }, runLog: queue.runLog?.[key] ?? [] };
}
