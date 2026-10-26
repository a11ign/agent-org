// @ts-check
// module: a run's event log, kept on the queue by ticket (A11-219, ADR 0006) -- PURE
//
// WHAT HAPPENED TO A RUN, EACH WITH ITS TIME, FOR THE PAGE'S TIMELINE. The log is not a field of the entry: `dismiss` and `remove` delete the entry, and `retry`, the review and talk rounds, the next-step run and the update
// re-queue each build a new entry from the fields they name, so a log on the entry would lose its own last line, or be carried by hand in each of them. It is `Queue.runLog`, by ticket key, beside the entries.
//
// EACH TRANSITION THAT RECORDS ONE LOGS IT ON A CHANGE IT ALREADY DETECTS, through {@link logEvent}, and a transition that is not given a time logs nothing, so the pure transitions the board and the tests share keep their
// old signatures. Every call the pool and the server make gives it.
import { countNeedsYou } from "./interventions.ts";
import type { Queue } from "./queue-entries-and-outcomes.ts";

/** The most events kept for one ticket: its last ones. */
export const RUN_LOG_MAX = 200;

/** The most logs kept for tickets no longer on the queue (dismissed or removed): the ones whose last event is newest. */
export const GONE_LOGS_MAX = 50;

/** The longest a reason is kept in an event: the first line of what was said, cut here. */
const REASON_MAX = 160;

/** The longest a re-reviewer's reasons are kept in a `rereview` event (A11-290): the whole verdict file, cut here. */
export const REREVIEW_REASONS_MAX = 2000;

/**
 * Why a round was started: new feedback, red checks, a conflict, a person's Respond (`asked`), a person's approval of draft pull requests, a talk session, or the reviewer's second look at a blocked head after the block was
 * answered without a commit (`rereview`), which the board counts as one of its own rounds though it queues no worker. A round the board started because the ticket's Decisions changed is `decisions`: it counts toward no cap either, since a person wrote the change (A11-305). A round the board held its run for, when the ticket's CI passed twice its budget, is `ci-budget`: it counts toward no cap, since
 * the cap is for review findings (A11-261). The two rounds of a stand-off (A11-290), the planner's and the worker's, count toward no cap either: a stand-off is routed once for each head, so it cannot repeat.
 */
export type RoundCause = "feedback" | "checks" | "conflict" | "asked" | "decisions" | "approved" | "talk" | "rereview" | "ci-budget" | "standoff-planner" | "standoff-worker";

/**
 * Why a ticket was queued again: a person's retry, the next plan step after a merge, a stop for an update, a plan written again, a stop behind a ticket its worker waits on (A11-272), a hold for its ticket's CI spend (A11-261), or the step
 * it waited with while a conflict round on one of its earlier pull requests ran (`conflict-round`, A11-286),
 * or a restart that caught it still starting, before its agent opened (`restart`, A11-294).
 */
export type RequeueWhy = "retry" | "next-step" | "update" | "replan" | "blocker" | "ci-budget" | "conflict-round" | "restart";

/**
 * What the board did about a pull request that conflicts with its base or is behind it (A11-286, {@link BaseMergeStep}): it asked the host to merge the base in (`merging`, for a conflict; `behind`, for a branch that is only behind), it started a conflict round
 * because the merge reported a real conflict (`round`), it left the pull request to the worker that holds the run's workspace (`waiting`), it could not start a round because the run has used the board's own (`capped`), or it started none because the run waits on a person, whose card says the conflict (`held`, A11-293).
 */
export type BaseMergeStep = "merging" | "behind" | "round" | "waiting" | "capped" | "held";

/** What answered a run that needed a person: a person's Respond, approval or talk, their answer through the board's answer route (A11-250), or the run's own terminal. */
export type AnsweredBy = "respond" | "approve" | "talk" | "answer" | "terminal";

/**
 * What came of a write of the run's result to the tracker that failed (A11-304): the board will try `retrying` again, the tracker `refused` it (a request that cannot succeed), or it kept failing for more than an hour and the board `gave-up`.
 * The worker's own outcome is not touched by any of them.
 */
export type TrackerWriteStep = "retrying" | "refused" | "gave-up";

/** What happened, without its time. */
type EventBody =
  | Readonly<{ kind: "queued"; model: string; effort: string; planFirst: boolean }>
  /** `link` is the ticket's address, where the plan is attached. */
  | Readonly<{ kind: "planned"; link: string | null }>
  | Readonly<{ kind: "started"; model: string; effort: string; instance: string | null }>
  /** `reason` is the first line of the feedback or the conflict, or null for a round no text started. */
  | Readonly<{ kind: "round"; cause: RoundCause; reason: string | null }>
  | Readonly<{ kind: "pr-opened"; url: string }>
  | Readonly<{ kind: "verdict"; url: string; head: string; review: "approved" | "changes-requested" }>
  /**
   * What a re-review of a blocked head came to when the verdict door refused it for an equal patch (A11-290): `not-convinced` is "rereview: still not convinced", and `convinced` an approval the door refused. `reasons` is the re-reviewer's
   * verdict file, cut to {@link REREVIEW_REASONS_MAX} characters.
   */
  | Readonly<{ kind: "rereview"; url: string; head: string; verdict: "convinced" | "not-convinced"; reasons: string }>
  /** What the board did with a stand-off (A11-290): routed it to the `planner` or the `worker`, or the planner `decided` it (`detail` says how), or it was `settled` with no person: the head moved on or was approved after it. */
  | Readonly<{ kind: "standoff"; url: string; head: string; step: "planner" | "worker" | "decided" | "settled"; detail: string | null }>
  | Readonly<{ kind: "needs-you"; reason: string }>
  | Readonly<{ kind: "answered"; by: AnsweredBy }>
  | Readonly<{ kind: "published"; link: string | null }>
  | Readonly<{ kind: "merged"; url: string }>
  /** `base` is the branch the pull request merges into, or null when the host did not say. */
  | Readonly<{ kind: "base-merge"; url: string; base: string | null; step: BaseMergeStep }>
  /** `outcome` is the kind of outcome the run ended on, and `reason` the one it gave, where it has one. */
  | Readonly<{ kind: "finished"; outcome: string; reason?: string }>
  /** A failed write of the run's result to the tracker (A11-304): the `failures`th, and the first line of the error the tracker or the network gave. */
  | Readonly<{ kind: "tracker-write"; step: TrackerWriteStep; failures: number; error: string }>
  | Readonly<{ kind: "dismissed" }>
  | Readonly<{ kind: "removed" }>
  | Readonly<{ kind: "requeued"; why: RequeueWhy }>;

/** One thing that happened to a run, at `at` (milliseconds). */
export type RunEvent = EventBody & Readonly<{ at: number }>;

/** The kinds of event a log holds. */
export type RunEventKind = RunEvent["kind"];

/** The first line of `text`, trimmed and cut to a short line; null when it has no words. PURE. */
export function shortReason(text: string): string | null {
  const line = text.split("\n").map((each) => each.trim()).find((each) => each !== "");
  if (line === undefined) return null;
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}…` : line;
}

/** The log of ticket `key`, oldest event first; empty when it has none. */
export const logOf = (queue: Queue, key: string): readonly RunEvent[] => queue.runLog?.[key] ?? [];

/** Whether ticket `key`'s log holds an event that `matches`. */
export const logHas = (queue: Queue, key: string, matches: (event: RunEvent) => boolean): boolean => logOf(queue, key).some(matches);

/**
 * Append `body` to ticket `key`'s log, at `at`, count a Needs-you event as one person-intervention that day (A11-257), and keep the log's last {@link RUN_LOG_MAX} events and the logs of the {@link GONE_LOGS_MAX} tickets that ended most recently. With no `at` it logs nothing:
 * a caller that has no clock is a pure helper's, which records no time. PURE.
 */
export function logEvent(queue: Queue, key: string, at: number | undefined, body: EventBody): Queue {
  if (at === undefined) return queue;
  const kept = [...logOf(queue, key), { ...body, at }].slice(-RUN_LOG_MAX);
  const logged = { ...queue, runLog: withoutOldGone(queue, { ...queue.runLog, [key]: kept }) };
  return body.kind === "needs-you" && !repeats(queue, key, { ...body, at }) ? countNeedsYou(logged, at) : logged;
}

/** Whether `event` is the one ticket `key`'s log ends with, the same at the same time: logged twice, it is one person-intervention. */
function repeats(queue: Queue, key: string, event: RunEvent): boolean {
  const last = logOf(queue, key).at(-1);
  return last !== undefined && JSON.stringify(last) === JSON.stringify(event);
}

/** The logs with those of tickets no longer on the queue cut to the {@link GONE_LOGS_MAX} whose last event is newest, a tie going to the one logged later. PURE. */
function withoutOldGone(queue: Queue, logs: Readonly<Record<string, readonly RunEvent[]>>): Readonly<Record<string, readonly RunEvent[]>> {
  const onQueue = new Set(queue.entries.map((entry) => entry.ticket.key));
  const gone = Object.keys(logs).filter((key) => !onQueue.has(key));
  if (gone.length <= GONE_LOGS_MAX) return logs;
  const lastAt = (key: string): number => logs[key]?.at(-1)?.at ?? 0;
  const dropped = new Set(gone.map((key, order) => ({ key, order })).sort((a, b) => lastAt(b.key) - lastAt(a.key) || b.order - a.order).slice(GONE_LOGS_MAX).map(({ key }) => key));
  return Object.fromEntries(Object.entries(logs).filter(([key]) => !dropped.has(key)));
}
