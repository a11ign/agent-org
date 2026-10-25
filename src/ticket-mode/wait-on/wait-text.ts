// A leaf of ticket mode, run by no command: the words the card shows for a run that waits, and the rounding of the time left (A11-245, folding in A11-236). PURE. The board builds the text at each poll and stores it on the note, so the view needs no
// clock: `Waiting on fleet job 123 (4 of 6 pages, about 20 min)`, never Stalled.
import { type Progress, type Reading, subjectOf } from "./wait-types.ts";

const MINUTE_MS = 60_000;
/** The time left is rounded to this many minutes, and to whole hours from {@link MINUTES_PER_HOUR} on. */
const ROUND_TO_MINUTES = 5;
const MINUTES_PER_HOUR = 60;
/** `HH:MM` of an ISO time, by position. */
const CLOCK_FROM = 11;
const CLOCK_TO = 16;

/** The time left, rounded so the text changes rarely: to 5 minutes, at least 5, and to whole hours from an hour on. `null` when nothing is left. PURE. */
export function roundedEta(remainingMs: number): string | null {
  if (!(remainingMs > 0)) return null;
  const minutes = Math.max(ROUND_TO_MINUTES, Math.round(remainingMs / MINUTE_MS / ROUND_TO_MINUTES) * ROUND_TO_MINUTES);
  return minutes < MINUTES_PER_HOUR ? `about ${minutes} min` : `about ${Math.round(minutes / MINUTES_PER_HOUR)} h`;
}

const countOf = ({ done, total }: Progress, unit: string): string => `${done} of ${total} ${unit}`;

/** What a reading says in brackets after its item. PURE. */
function detailOf(reading: Reading, now: number): string {
  if (reading.status === "unreadable") return `could not read it: ${reading.why}`;
  if ("job" in reading) {
    const { job } = reading;
    if (reading.status === "finished") return "done";
    if (reading.status === "failed") return `${job.state}: ${job.reason}`;
    const eta = job.estimatedFinish === null ? null : roundedEta(job.estimatedFinish - now);
    return [job.progress === null ? job.state : countOf(job.progress, "pages"), eta].filter((part) => part !== null).join(", ");
  }
  if ("run" in reading) {
    const { run } = reading;
    if (run.status === "completed") return run.conclusion ?? "completed";
    return [run.status === "queued" ? "queued" : "running", run.jobs === null ? null : countOf(run.jobs, "jobs")].filter((part) => part !== null).join(", ");
  }
  if ("pull" in reading) {
    const { pull } = reading;
    if (pull.state === "MERGED") return "merged";
    if (pull.state === "CLOSED") return "closed without merging";
    if (pull.review !== null) return pull.review === "APPROVED" ? "approved" : "changes requested";
    return reading.wait.kind === "pullRequest" && reading.wait.until === "reviewed" ? "open, not reviewed yet" : "open";
  }
  return reading.status === "finished" ? "done" : reading.status === "failed" ? "canceled" : reading.stateType;
}

/** An item as the card spells it: its subject, then its detail in brackets. */
const itemOf = (reading: Reading, now: number): string => `${subjectOf(reading.wait)} (${detailOf(reading, now)})`;

/** The card's line for a run waiting on declared events, from the latest reading of each: `Waiting on fleet job fj-1 (done); CI run a11ign/x#9 (running, 3 of 5 jobs)`. PURE. */
export function waitText(readings: readonly Reading[], now: number): string {
  return `Waiting on ${readings.map((reading) => itemOf(reading, now)).join("; ")}`;
}

/** A time as `HH:MMZ`, in UTC. */
const clock = (at: number): string => `${new Date(at).toISOString().slice(CLOCK_FROM, CLOCK_TO)}Z`;

/** The card's line for a run waiting on background work it holds itself, inside its deadline, from the note alone: `Waiting on background work since 20:46Z, until 23:46Z: two capture shells`. PURE. */
export function undeclaredWaitText(wait: Readonly<{ since: number; until: number; what: string }>): string {
  return `Waiting on background work since ${clock(wait.since)}, until ${clock(wait.until)}: ${wait.what}`;
}
