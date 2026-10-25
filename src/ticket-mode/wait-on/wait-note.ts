// A leaf of ticket mode, run by no command: what a running run's `working` note says at a moment, for a run that waits (A11-236, A11-245). PURE over the note, the time and the latest judged reading. A wait is DECLARED (the outcome listed
// the events: the board reads them and wakes the worker) or UNDECLARED (the worker's own shell or Monitor holds it, and the board only watches its bound). Inside its deadline a run is waiting, whatever the idle clock says; at the deadline the
// board prompts the worker ONCE (`woke`, written before the prompt is sent), and only a worker that stays idle for the grace after that is Stalled.
import type { WorkingNote } from "../queue/queue-entries-and-outcomes.ts";
import { type Judged } from "./wait-verdict.ts";
import { pendingText } from "./wait-text.ts";
import { type Wait, type Woke, subjectOf, waitKey } from "./wait-types.ts";

/** How long a run waiting on background work may sit idle past its `working` outcome, when the outcome gives no `until`: three hours. */
export const BACKGROUND_WAIT_MS = 3 * 60 * 60_000;

/** The most times the board offers a wake prompt that herdr keeps refusing, before it marks the run stalled with the refusal. */
export const MAX_WAKE_TRIES = 3;

/** The start of the stall reason of a run idle past the end of its wait: the deadline and what it waited on follow. */
const WAITED_PAST = "waited past";

/** The time (ms) a waiting note's wait ends: the `until` its outcome gave, whatever it is, or {@link BACKGROUND_WAIT_MS} after the outcome file was written, so a newer outcome starts it again. PURE. */
export const deadlineOf = ({ at, until }: Pick<WorkingNote, "at" | "until">): number => until ?? at + BACKGROUND_WAIT_MS;

/** What a note's wait was on, in words: the declared items still pending when the worker was woken late, else the job it named, else nothing in particular. */
function waitedOn(note: WorkingNote): string | null {
  return note.woke?.on ?? note.waitingOn ?? null;
}

/** The stall reason of a run that stayed idle past the end of its wait, naming what it waited on. PURE. */
function waitedPastReason(note: WorkingNote): string {
  const deadline = new Date(deadlineOf(note)).toISOString();
  const on = waitedOn(note);
  return on === null ? `${WAITED_PAST} ${deadline} with its background work still running` : `${WAITED_PAST} ${deadline} on ${on}`;
}

/** The note without the marks a pass recomputes: whether it waits, and whether it is stalled and why. */
function unmarked({ waiting: _waiting, stalled: _stalled, stallReason: _why, ...rest }: WorkingNote): WorkingNote {
  return rest;
}

/** The note of an idle run once its worker has been prompted for a wait: stalled when it has stayed idle for `stallMs` since, with the reason a late prompt gives, and otherwise neither waiting nor stalled. */
function afterWake(note: WorkingNote, now: number, stallMs: number): WorkingNote {
  const late = note.woke?.why === "late";
  if (now - (note.idleSince ?? now) < stallMs) return note;
  return { ...note, stalled: true, ...(late ? { stallReason: waitedPastReason(note) } : {}) };
}

/** Whether herdr has refused the wake prompt {@link MAX_WAKE_TRIES} times: the board stops offering it. */
const refusedTooOften = (note: WorkingNote): boolean => (note.wakeTries ?? 0) >= MAX_WAKE_TRIES;

/** The note of a run whose wake prompt herdr keeps refusing: stalled, with the refusal as the reason. */
const unwakeable = (note: WorkingNote): WorkingNote => ({ ...note, stalled: true, stallReason: `could not wake the worker: ${note.wakeRefusal ?? "its prompt was refused"}` });

/**
 * The note of an idle run that waits on background work it holds itself (A11-236): its pane shows live work, or its outcome names a job. Inside the wait it is `waiting`. Past the deadline the worker is
 * prompted once (`woke` is set, and the pool sends the prompt), and the run is stalled only when it stays idle for `stallMs` after that, with the reason naming the job. PURE.
 */
export function undeclaredMark(note: WorkingNote, now: number, stallMs: number): WorkingNote {
  const rest = unmarked(note);
  if (refusedTooOften(rest)) return unwakeable(rest);
  if (now < deadlineOf(rest)) return { ...rest, waiting: true };
  if (rest.woke === undefined) return { ...rest, idleSince: now, woke: { at: now, why: "late" } };
  return afterWake(rest, now, stallMs);
}

/** The items of a wait that are not yet over, by the verdict's own list of the ones that are: what a late prompt says is still pending. PURE. */
const pendingOf = (waits: readonly Wait[], ended: readonly Wait[]): string => waits.filter((wait) => !ended.some((over) => waitKey(over) === waitKey(wait))).map(subjectOf).join("; ");

/** The first prompt a declared wait earns, from what was last read of it: its end (every item finished, or one failed), its deadline passing with items still pending, or null while it is still waiting. PURE. */
function firstWake(note: WorkingNote, now: number, judged: Judged | null): Pick<WorkingNote, "woke" | "ended"> | null {
  if (judged === null) return null;
  const { verdict } = judged;
  if (verdict.outcome !== "pending") return { woke: { at: now, why: verdict.outcome }, ended: verdict.ended };
  const deadline = deadlineOf(note);
  // A reading taken before the deadline says nothing of what is pending at it: the next poll's is waited for.
  return now >= deadline && judged.readAt >= deadline ? { woke: { at: now, why: "late", on: pendingOf(note.waits ?? [], verdict.ended) } } : null;
}

/**
 * The note of an idle run that declared its wait (A11-245), at `now`, given the latest judged reading of it (null when none has been read). A wait whose items are over, or past its deadline with items pending, earns
 * the worker one prompt: `woke` is set here, and the pool sends the prompt and sets nothing twice. Until then the run is waiting, with the card's line for what was last read. A run whose prompt herdr refused
 * {@link MAX_WAKE_TRIES} times is stalled with the refusal. A note marked a repeat (see {@link repeatOf}) is read once: if what it declares is over already it is stalled and woken for nothing, and if not (a CI
 * run rerun under the same ID, a pull request pushed again) it is an ordinary wait. PURE.
 */
export function declaredMark(note: WorkingNote, now: number, stallMs: number, judged: Judged | null): WorkingNote {
  const rest = unmarked(note);
  if (refusedTooOften(rest)) return unwakeable(rest);
  if (rest.repeat === true) return repeatMark(rest, now, stallMs, judged);
  if (rest.woke !== undefined) return afterWake(rest, now, stallMs);
  const wake = firstWake(rest, now, judged);
  if (wake !== null) return { ...rest, ...wake, idleSince: now };
  return { ...rest, waiting: true, waitText: judged?.text ?? rest.waitText ?? pendingText(rest.waits ?? []) };
}

/** A repeat note before its first reading is waiting; once read, it is stalled for re-declaring what had ended, or, if that is not over, the ordinary wait it is. PURE. */
function repeatMark(note: WorkingNote, now: number, stallMs: number, judged: Judged | null): WorkingNote {
  const { repeat: _repeat, woke: _told, ...fresh } = note;
  if (judged === null) return { ...note, waiting: true, waitText: pendingText(note.waits ?? []) };
  if (judged.verdict.outcome === "pending") return declaredMark(fresh, now, stallMs, judged);
  return { ...note, stalled: true, stallReason: `re-declared a wait that had already ended: ${(note.ended ?? []).map(subjectOf).join("; ")}` };
}

/** Whether a note's wake told the worker that items had ended (it finished or failed), and not only that the deadline passed. */
const toldEnded = (note: WorkingNote | undefined): boolean => note?.woke !== undefined && note.woke.why !== "late";

/** What a note's `woke` and `ended` become on a worker's NEW `working` outcome that declares `waits`: a repeat of the wait it was just told had ended (every item among them) is marked, so the board wakes nothing for it. PURE. */
export function repeatOf(earlier: WorkingNote | undefined, waits: readonly Wait[] | undefined): Pick<WorkingNote, "repeat" | "ended" | "woke"> {
  const told = earlier?.ended;
  if (waits === undefined || told === undefined || !toldEnded(earlier)) return {};
  const keys = new Set(told.map(waitKey));
  return waits.every((wait) => keys.has(waitKey(wait))) ? { repeat: true, ended: told, woke: earlier?.woke } : {};
}

/** The note after herdr refused the wake prompt: the wake is not recorded as sent, the try is counted and the refusal kept, so the next pass sends it again until {@link MAX_WAKE_TRIES}. PURE. */
export function wakeRefused(note: WorkingNote, refusal: string, woke: Woke): WorkingNote {
  if (note.woke?.at !== woke.at) return note;
  const { woke: _unsent, ...rest } = note;
  return { ...rest, wakeTries: (note.wakeTries ?? 0) + 1, wakeRefusal: refusal };
}
