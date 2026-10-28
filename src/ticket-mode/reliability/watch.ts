// @ts-check
// module: the watch the board keeps on a board-reliability ticket's figure (A11-366) -- when it starts, when it passes, when it breaches. PURE
//
// ONE WATCH A TICKET, FROM ENROLMENT TO ITS WINDOW'S END. The board enrols a ticket labelled `board-reliability` while it is on the queue (or at once, for the tickets the epic closed before there was a watch). The watch
// waits for the ticket to be completed, then for the release that carries the fix to be installed on this host (`after-merge/installed.ts`): the figure of the week before the fix reaches this host says nothing about the
// fix. From then on each sweep reads the figure once. A reading at or over the threshold is a breach, on the first, and the ticket is reopened once with the readings. A window that closes with every reading under holds.
//
// A TICKET THAT LEAVES COMPLETED IS NOT THE WATCH'S: a person, or the board's own reopen, put it back to work. The watch then waits for it to be completed again, and starts over from that close.
import { breaches, type FigureSpec } from "./figures.ts";

/** What a watch is doing: waiting for the ticket to be completed (`open`), watching its figure (`watching`), breached and not yet reopened (`breached`), reopened by the board (`reopened`), or its window closed clean (`held`). */
export type WatchState = "open" | "watching" | "breached" | "reopened" | "held";

/** One reading of the figure: when, and the number. */
export type Reading = Readonly<{ at: number; value: number }>;

/** The figures of the board when a watch breached, in the words of the ticket's comment. */
export type Readings = Readonly<{ at: number; lines: readonly string[] }>;

export type Watch = Readonly<{
  key: string;
  title: string;
  url: string | null;
  /** The figure it watches, or null while the ticket names none (and `why` says what is wrong with its line, or that it has none). */
  spec: FigureSpec | null;
  why?: string;
  /** Where the spec came from: the ticket's own `Figure:` line, or the board's table for a ticket closed before the watch (`BACKFILLED`). */
  origin: "ticket" | "backfill";
  state: WatchState;
  /** When the ticket was seen completed. */
  closedAt?: number;
  /** When the window began: the first sweep that read the fix as installed on this host. */
  began?: number;
  /** How many times the figure was read since the window began, the latest reading and the highest. */
  reads: number;
  last?: Reading;
  peak?: Reading;
  /** The breach: the reading that crossed the threshold and every figure the board served then. Kept so a reopen that failed is made again with the same words. */
  breach?: Readonly<{ reading: Reading; readings: Readings }>;
  /** How many times the board has reopened this ticket. */
  reopens: number;
  /** When the board moved the ticket out of its completed state, and whether its comment with the readings and its place on the queue are done. */
  reopenedAt?: number;
  commented?: boolean;
  queued?: boolean;
}>;

/** What one sweep knows of a watch: the clock, whether the tracker has the ticket completed (null when it could not say), whether its fix is installed, and the figure's reading with every figure then (null when the board served none). */
export type Facts = Readonly<{ now: number; completed: boolean | null; installed: boolean; read: Readonly<{ value: number; readings: Readings }> | null }>;

/** A new watch for a ticket the board has not watched. PURE. */
export function newWatch(ticket: Pick<Watch, "key" | "title" | "url" | "origin">, spec: FigureSpec | null, why?: string): Watch {
  return { ...ticket, spec, ...(why === undefined ? {} : { why }), state: "open", reads: 0, reopens: 0 };
}

/** The watch with its window thrown away: the ticket is at work again, and the watch begins at its next close. */
function restarted(watch: Watch): Watch {
  const { closedAt: _closed, began: _began, last: _last, peak: _peak, breach: _breach, ...rest } = watch;
  return { ...rest, state: "open", reads: 0 };
}

/** The watch with `reading` counted. */
function counted(watch: Watch, reading: Reading): Watch {
  return { ...watch, reads: watch.reads + 1, last: reading, peak: watch.peak === undefined || reading.value > watch.peak.value ? reading : watch.peak };
}

/** Whether a watch's window has closed at `now`. */
const windowClosed = (watch: Watch, spec: FigureSpec, now: number): boolean => watch.began !== undefined && now >= watch.began + spec.windowMs;

/** The watch of a ticket that is completed: begun when its fix is installed, read, and breached on the first reading at the threshold or held when the window closes with a reading in it. */
function watched(watch: Watch, spec: FigureSpec, { now, installed, read }: Facts): Watch {
  const began = watch.began ?? (installed ? now : undefined);
  if (began === undefined) return watch;
  const started = watch.began === undefined ? { ...watch, began } : watch;
  if (read === null) return started;
  const reading: Reading = { at: now, value: read.value };
  const counting = counted(started, reading);
  if (breaches(read.value, spec)) return { ...counting, state: "breached", breach: { reading, readings: read.readings } };
  return windowClosed(counting, spec, now) ? { ...counting, state: "held" } : counting;
}

/**
 * The watch after one sweep. A tracker that could not say whether the ticket is completed changes nothing. A watch with no spec only follows the ticket's state. A watch the board owes a reopen (`breached`, or reopened with its comment or its place on the queue still to do) is the
 * board's to finish: the sweep does it and calls {@link reopened} and {@link reopenStepDone}; it is left as it is here. PURE.
 */
export function advance(watch: Watch, facts: Facts): Watch {
  const { completed, now } = facts;
  if (completed === null || owesReopen(watch)) return watch;
  if (!completed) return watch.state === "open" ? watch : restarted(watch);
  if (watch.state === "held") return watch;
  const closed: Watch = watch.state === "open" || watch.state === "reopened" ? { ...restarted(watch), state: "watching", closedAt: now } : watch;
  return watch.spec === null ? closed : watched(closed, watch.spec, facts);
}

/** The watch with the ticket moved out of its completed state at `now`: reopened, with its comment and its place on the queue still to do. PURE. */
export const reopened = (watch: Watch, now: number): Watch => ({ ...watch, state: "reopened", reopens: watch.reopens + 1, reopenedAt: now, commented: false, queued: false });

/** The watch with a step of its reopen done. PURE. */
export const reopenStepDone = (watch: Watch, step: "commented" | "queued"): Watch => ({ ...watch, [step]: true });

/** Whether the board still owes a breached ticket something: its reopen, the comment with the readings, or its place on the queue. */
export const owesReopen = (watch: Watch): boolean => watch.state === "breached" || (watch.state === "reopened" && (watch.commented !== true || watch.queued !== true));

