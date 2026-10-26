// @ts-check
// module: a queued run that has waited a long time on the same ticket (A11-298) -- what it waits on, and whether that ticket can move. PURE.
//
// ON 2026-10-25 EVERY TICKET OF A REPOSITORY WAITED 30 HOURS on the files of a pull request that had merged, and nothing on the board said a wait was long. A queued run is held by a ticket that blocks it or by the files of
// a run that holds them. The pool records which ticket and since when (`waitSince`, `recordWaits` in `queue/queue-long-waits.ts`); a wait on the same ticket for more than {@link LONG_WAIT_MS} is listed on the board's
// Runs page and by `doctor`, with the state of the ticket waited on and whether it can move by itself. Like the rest of `board-view/`, it is sent to the browser as one script with its relative imports dropped.
import { overlapWait } from "./overlap-hold.ts";
import { waitsOn, workStatus } from "./pull-status-and-notes.ts";
import { RUN_STATUSES, type RunStatus, type ViewEntry } from "./view-types-and-filters.ts";

/** How long a queued run may wait on the same ticket before the board and `doctor` list the wait: two hours. */
export const LONG_WAIT_MS = 2 * 60 * 60_000;

/** The ticket a queued run waits on and why: a `blocker` that holds it back, or the `files` of a run that holds paths it needs. */
export type WaitTarget = Readonly<{ key: string; kind: "blocker" | "files" }>;

/** What a queued run waits on right now: its first blocker that holds it, else the run whose files it contests; null for a run that is not queued or waits on neither. PURE. */
export function waitTarget(entry: ViewEntry, entries: readonly ViewEntry[]): WaitTarget | null {
  if (entry.phase !== "queued") return null;
  const blocker = waitsOn(entry, entries)[0];
  if (blocker !== undefined) return { key: blocker.key, kind: "blocker" };
  const holder = overlapWait(entry, entries);
  return holder === null ? null : { key: holder.key, kind: "files" };
}

/** The statuses of a run that moves on its own, or when a pull request is reviewed or merged: something is at work on it, or it is only waiting for GitHub. Any other status needs a person or another ticket first. */
const MOVES: ReadonlySet<RunStatus> = new Set(["working", "planning", "reviewing", "queued", "awaiting-review", "ready-to-merge", "publishing"]);

/** Whether a ticket's run can move by itself, and the sentence that says why: the status the board shows for it, and what it waits on when it is Blocked. */
export type HolderMove = Readonly<{ moves: boolean; words: string }>;

/** The label the board shows for a status. */
const labelOf = (status: RunStatus): string => RUN_STATUSES.find((each) => each.status === status)?.label ?? status;

/** Where the ticket `on` stands on the board and whether it can move: a ticket with no run is worked by nobody; a Blocked one waits on another ticket itself. PURE. */
export function holderMove(on: string, entries: readonly ViewEntry[]): HolderMove {
  const runs = entries.filter(({ ticket }) => ticket.key === on);
  const run = runs.find(({ phase }) => phase !== "finished") ?? runs[0];
  if (run === undefined) return { moves: false, words: `${on} has no run on the board, so nothing is working on it` };
  const status = workStatus(run, entries);
  const itself = status === "blocked" ? waitTarget(run, entries) : null;
  const behind = itself === null ? "" : `, waiting on ${itself.key}${itself.kind === "files" ? "'s files" : ""}`;
  const moves = MOVES.has(status);
  return { moves, words: `${on} is ${labelOf(status)}${behind}, so it ${moves ? "can" : "cannot"} move by itself` };
}

/** A queued run that has waited longer than {@link LONG_WAIT_MS} on the same ticket. */
export type LongWait = Readonly<{ key: string; on: string; kind: WaitTarget["kind"]; since: number; holder: HolderMove }>;

/** How long a wait has run, as the board says a duration: `45 min`, `31 h 20 min`. PURE. */
export function waitedWords(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Whether a run has waited on `target` for longer than {@link LONG_WAIT_MS} at `now`: the board recorded the start of a wait on that ticket (`waitSince`), not on another one. PURE. */
const waitedLong = (since: ViewEntry["waitSince"], target: WaitTarget, now: number): since is NonNullable<ViewEntry["waitSince"]> =>
  since !== undefined && since.on === target.key && now - since.since > LONG_WAIT_MS;

/** The queued runs that have waited more than {@link LONG_WAIT_MS} at `now` on the ticket they wait on now, longest first. A wait the board has not recorded the start of is not counted. PURE. */
export function longWaits(entries: readonly ViewEntry[], now: number): LongWait[] {
  return entries.flatMap((entry): LongWait[] => {
    const target = waitTarget(entry, entries);
    const since = entry.waitSince;
    if (target === null || !waitedLong(since, target, now)) return [];
    return [{ key: entry.ticket.key, on: target.key, kind: target.kind, since: since.since, holder: holderMove(target.key, entries) }];
  }).sort((a, b) => a.since - b.since || (a.key < b.key ? -1 : 1));
}

/** The sentence the board and `doctor` say of a long wait: `A11-229 has waited 31 h 20 min on A11-232's files: A11-232 is Blocked, waiting on A11-231, so it cannot move by itself.` PURE. */
export const longWaitSentence = (wait: LongWait, now: number): string =>
  `${wait.key} has waited ${waitedWords(now - wait.since)} on ${wait.on}${wait.kind === "files" ? "'s files" : ", which blocks it"}: ${wait.holder.words}.`;
