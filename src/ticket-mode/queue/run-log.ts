// @ts-check
// module: a run's event log, kept on the queue by ticket (A11-219, ADR 0006) -- PURE
//
// WHAT HAPPENED TO A RUN, EACH WITH ITS TIME, FOR THE PAGE'S TIMELINE. The log is not a field of the entry: `dismiss` and `remove` delete the entry, and `retry`, the review and talk rounds, the next-step run and the update
// re-queue each build a new entry from the fields they name, so a log on the entry would lose its own last line, or be carried by hand in each of them. It is `Queue.runLog`, by ticket key, beside the entries.
//
// EACH TRANSITION THAT RECORDS ONE LOGS IT ON A CHANGE IT ALREADY DETECTS, through {@link logEvent}, and a transition that is not given a time logs nothing, so the pure transitions the board and the tests share keep their
// old signatures. Every call the pool and the server make gives it.
import type { Queue } from "./queue-entries-and-outcomes.ts";

/** The most events kept for one ticket: its last ones. */
export const RUN_LOG_MAX = 200;

/** The most logs kept for tickets no longer on the queue (dismissed or removed): the ones whose last event is newest. */
export const GONE_LOGS_MAX = 50;

/** The longest a reason is kept in an event: the first line of what was said, cut here. */
const REASON_MAX = 160;

/** Why a review round was queued: new feedback, red checks, a conflict, a person's Respond (`asked`), a person's approval of draft pull requests, or a talk session. */
export type RoundCause = "feedback" | "checks" | "conflict" | "asked" | "approved" | "talk";

/** Why a ticket was queued again: a person's retry, the next plan step after a merge, a stop for an update, or a plan written again. */
export type RequeueWhy = "retry" | "next-step" | "update" | "replan";

/** What answered a run that needed a person: a person's Respond, approval or talk, or the run's own terminal. */
export type AnsweredBy = "respond" | "approve" | "talk" | "terminal";

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
  | Readonly<{ kind: "needs-you"; reason: string }>
  | Readonly<{ kind: "answered"; by: AnsweredBy }>
  | Readonly<{ kind: "published"; link: string | null }>
  | Readonly<{ kind: "merged"; url: string }>
  /** `outcome` is the kind of outcome the run ended on, and `reason` the one it gave, where it has one. */
  | Readonly<{ kind: "finished"; outcome: string; reason?: string }>
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
 * Append `body` to ticket `key`'s log, at `at`, and keep the log's last {@link RUN_LOG_MAX} events and the logs of the {@link GONE_LOGS_MAX} tickets that ended most recently. With no `at` it logs nothing:
 * a caller that has no clock is a pure helper's, which records no time. PURE.
 */
export function logEvent(queue: Queue, key: string, at: number | undefined, body: EventBody): Queue {
  if (at === undefined) return queue;
  const kept = [...logOf(queue, key), { ...body, at }].slice(-RUN_LOG_MAX);
  return { ...queue, runLog: withoutOldGone(queue, { ...queue.runLog, [key]: kept }) };
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
