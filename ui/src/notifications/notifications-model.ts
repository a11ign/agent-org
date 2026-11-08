// module: the notification centre's rules -- what a notification is, which finished requests make one, how they are filtered, counted and worded. PURE.
import type { WritersView } from "../api/types.ts";
import { headLineOf, queueChoiceLabel } from "../new-ticket/new-ticket-model.ts";

type Run = WritersView["runs"][number];

/** What a notification is about. Today only a finished ticket-writer request is one; another kind is added with a mapper beside `writerNotificationOf`, and the panel draws it unchanged. */
export type NotificationKind = "writer";

export type NotificationOutcome = "succeeded" | "failed";

/** A ticket a notification says was filed. */
export type FiledTicket = Run["tickets"][number];

/** One entry of the panel. `at` is when it finished, or null for one the board kept no time for. `failure` is the reason it failed, in the backend's own words. */
export type Notification = Readonly<{
  id: string;
  kind: NotificationKind;
  outcome: NotificationOutcome;
  at: number | null;
  /** "Ticket writer · sonnet/high · Quick": who produced it. */
  headline: string;
  /** What was asked. */
  text: string;
  failure: string | null;
  tickets: readonly FiledTicket[];
  /** The keys of its tickets the live queue holds, each marked Queued (A11-420): a ticket queued by the run, by the note's button, or by hand. */
  queuedKeys: ReadonlySet<string>;
  /** How the queueing a request asked for went (A11-420), or null for a request that kept its tickets in the backlog. */
  queueing: Queueing | null;
  /** Arrived while this page was open: marked New. */
  fresh: boolean;
}>;

/** What a model, effort and plan a request's tickets were queued on, as `POST /api/queue` takes them. */
export type QueueChoice = Readonly<{ model: string; effort: string; plan: boolean }>;

/**
 * How a request's queueing went (A11-420): its tickets queued, said with what they were queued on, or not, with the run's recorded reason and the keys "Queue them" sends, on the
 * choice the request was stamped with.
 */
export type Queueing = Readonly<{ queued: true; text: string } | { queued: false; reason: string; keys: readonly string[]; choice: QueueChoice }>;

export type NotificationFilter = "all" | "succeeded" | "failed";

export const FILTERS: readonly Readonly<{ id: NotificationFilter; label: string }>[] = [
  { id: "all", label: "All" },
  { id: "succeeded", label: "Succeeded" },
  { id: "failed", label: "Failed" },
];

/** The amber note's words when a run recorded no reason, as a request stopped by an older board did. */
const NOT_QUEUED = "Written, but not queued. They are in the backlog.";

/** What the board reads to tell a request's queueing (A11-420): the keys the live queue holds, and whether the board plans, which says "plan first". */
export type QueueReading = Readonly<{ keys: ReadonlySet<string>; planner: boolean }>;

/** No queue read yet, on a board that does not plan. */
export const NO_QUEUE: QueueReading = { keys: new Set(), planner: false };

/**
 * How a finished request's queueing went (A11-420), or null for one that kept its tickets in the backlog or filed none. Queued when the run recorded it queued them, or once the live
 * queue holds every one of them (the note's button, or a person on the Tickets page, queued them since). Otherwise the run's recorded reason, with the keys the queue does not hold yet.
 */
export function queueingOf(run: Pick<Run, "queueAfter" | "afterWriting" | "tickets">, { keys: inQueue, planner }: QueueReading): Queueing | null {
  const after = run.queueAfter;
  if (after === undefined || run.tickets.length === 0) return null;
  const waiting = run.tickets.map(({ key }) => key).filter((key) => !inQueue.has(key));
  const recorded = run.afterWriting;
  if (waiting.length === 0 || (recorded !== undefined && "queued" in recorded)) {
    const count = run.tickets.length;
    return { queued: true, text: `${count} ${count === 1 ? "ticket" : "tickets"} queued with ${queueChoiceLabel({ ...after, plan: after.plan && planner })}.` };
  }
  return { queued: false, reason: recorded?.notQueued ?? NOT_QUEUED, keys: waiting, choice: after };
}

/** A finished request as a notification, not yet marked new: done is succeeded, anything else that finished is failed (a request stopped on the board finishes with a failure). */
export function writerNotificationOf(run: Run, queue: QueueReading = NO_QUEUE): Notification {
  return {
    id: run.id, kind: "writer", outcome: run.status === "failed" ? "failed" : "succeeded", at: run.finishedAt ?? null, headline: headLineOf(run), text: run.request,
    failure: run.status === "failed" ? (run.failure ?? null) : null, tickets: run.tickets, queuedKeys: new Set(run.tickets.map(({ key }) => key).filter((key) => queue.keys.has(key))),
    queueing: queueingOf(run, queue), fresh: false,
  };
}

/** The notifications of the requests the board lists: each finished one, a new arrival first and then the newest finished first. A request still under way is no notification. */
export function notificationsOf(runs: readonly Run[], fresh: ReadonlySet<string>, queue: QueueReading = NO_QUEUE): readonly Notification[] {
  const finished = runs.filter((run) => run.phase === "finished").map((run) => ({ ...writerNotificationOf(run, queue), fresh: fresh.has(run.id) }));
  return finished.map((item, at) => ({ item, at })).sort((a, b) => Number(b.item.fresh) - Number(a.item.fresh) || (b.item.at ?? -1) - (a.item.at ?? -1) || b.at - a.at).map(({ item }) => item);
}

export const filtered = (items: readonly Notification[], filter: NotificationFilter): readonly Notification[] => (filter === "all" ? items : items.filter((item) => item.outcome === filter));

/** The count on each filter tab. */
export const countsOf = (items: readonly Notification[]): Readonly<Record<NotificationFilter, number>> => ({
  all: items.length, succeeded: filtered(items, "succeeded").length, failed: filtered(items, "failed").length,
});

/** How long ago `at` was at `now`, as the boards write it: "just now", "14 min ago", "1 h ago", "yesterday", "3 d ago". */
const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

export function agoOf(at: number | null, now: number): string {
  if (at === null) return "earlier";
  const minutes = Math.max(0, Math.floor((now - at) / MINUTE_MS));
  if (minutes < 1) return "just now";
  if (minutes < MINUTES_PER_HOUR) return `${minutes} min ago`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return `${hours} h ago`;
  const days = Math.floor(hours / HOURS_PER_DAY);
  return days === 1 ? "yesterday" : `${days} d ago`;
}

/** The name of the button that clears one: its outcome and age, which is how a person tells the items apart. */
export const clearLabelOf = (item: Notification, now: number): string => `Clear notification: ${item.outcome === "failed" ? "failed" : "done"}, ${agoOf(item.at, now)}`;

/** The name of the bell: how many finished requests are listed. */
export const bellLabelOf = (count: number): string => `Notifications, ${count}`;

/** What the panel says when it has nothing to list: all caught up when nothing is held, else that the chosen filter has nothing. */
export function emptyOf(filter: NotificationFilter, total: number): Readonly<{ title: string; note: string }> {
  if (total === 0) return { title: "You are all caught up", note: "Results from the ticket writer arrive here, with what each one filed or why it failed." };
  if (filter === "succeeded") return { title: "No succeeded notifications", note: "Nothing has finished successfully since these were last cleared." };
  return { title: "No failed notifications", note: "Nothing has failed since these were last cleared." };
}

/**
 * The ids of the requests that finished while the page was open: those `before` held unfinished and `runs` now holds finished. `before` is the ids of the requests under way at the last look.
 * A request the page first saw finished is not new, so a reload marks nothing.
 */
export function arrivedOf(before: ReadonlySet<string>, runs: readonly Run[]): readonly string[] {
  return runs.filter((run) => run.phase === "finished" && before.has(run.id)).map((run) => run.id);
}

/** The ids of the requests under way. */
export const underWayOf = (runs: readonly Run[]): ReadonlySet<string> => new Set(runs.filter((run) => run.phase !== "finished").map((run) => run.id));
