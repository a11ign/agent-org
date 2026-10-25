// A leaf of ticket mode, run by no command: whether a worker's declared wait is over, and what the board tells it when it is (A11-245). PURE. All items finished: the wait is finished. Any item failed: the wait is failed at once, with the others still
// pending. Otherwise it is pending. An item the board could not read counts as pending, so a flaky read never wakes a worker with a false alarm.
import { type Reading, type Wait, askCut, subjectOf } from "./wait-types.ts";

/** Where a wait stands, with the words for the prompt: `lines` has one per item (the failures first, then the rest), `reason` is the first failure's, and `ended` the items that are over, which a repeat guard compares a new declaration to. */
export type Verdict =
  | Readonly<{ outcome: "pending"; lines: readonly string[]; ended: readonly Wait[] }>
  | Readonly<{ outcome: "finished"; lines: readonly string[]; ended: readonly Wait[] }>
  | Readonly<{ outcome: "failed"; reason: string; lines: readonly string[]; ended: readonly Wait[] }>;

/** What a reading says in a sentence for the worker: what happened to the item, with the results location, the conclusion or the reason. PURE. */
export function lineOf(reading: Reading): string {
  const subject = subjectOf(reading.wait);
  if (reading.status === "unreadable") return `${subject}: the board could not read it (${reading.why})`;
  if ("job" in reading) {
    const { job } = reading;
    if (reading.status === "finished") return `${subject} is done${job.results === null ? "" : `; its results are at ${job.results} (fleet job fetch ${reading.wait.id} --to <dir> copies them)`}`;
    if (reading.status === "failed") return `${subject} ${job.state === "cancelled" ? "was cancelled" : "failed"}: ${job.reason}`;
    return `${subject} is ${job.state}${job.progress === null ? "" : `, ${job.progress.done} of ${job.progress.total} pages`}`;
  }
  if ("run" in reading) {
    const { run } = reading;
    if (run.status === "completed") return `${subject} (${run.name}) concluded ${run.conclusion}: ${run.url}`;
    return `${subject} (${run.name}) is ${run.status === "queued" ? "queued" : "running"}${run.jobs === null ? "" : `, ${run.jobs.done} of ${run.jobs.total} jobs done`}: ${run.url}`;
  }
  if ("pull" in reading) {
    const { pull } = reading;
    if (pull.state === "MERGED") return `${subject} was merged`;
    if (pull.state === "CLOSED") return `${subject} was closed without merging`;
    if (pull.review !== null) return `${subject} has ${pull.review === "APPROVED" ? "an approving review" : "a review asking for changes"} on its current head`;
    return `${subject} is still open${reading.wait.until === "reviewed" ? " and has no review on its current head" : ""}`;
  }
  if ("result" in reading) return reading.result === null ? `${subject} has not answered yet` : `the person's session answered "${askCut(reading.wait.ask)}": ${reading.result}`;
  return `${subject} is ${reading.status === "finished" ? "done" : reading.status === "failed" ? "canceled" : `not done (${reading.stateType})`}`;
}

/** Where the wait stands, given the latest reading of every item. An empty list is pending: a wait with no items was never declared. PURE. */
export function judgeWaits(readings: readonly Reading[]): Verdict {
  const failed = readings.filter((reading) => reading.status === "failed");
  const ended = readings.filter((reading) => reading.status === "finished" || reading.status === "failed").map((reading) => reading.wait);
  if (failed.length > 0) {
    const lines = [...failed, ...readings.filter((reading) => reading.status !== "failed")].map(lineOf);
    return { outcome: "failed", reason: lineOf(failed[0]), lines, ended };
  }
  if (readings.length > 0 && readings.every((reading) => reading.status === "finished")) return { outcome: "finished", lines: readings.map(lineOf), ended };
  return { outcome: "pending", lines: readings.filter((reading) => reading.status !== "finished").map(lineOf), ended };
}

/** The latest completed reading of a note's declared wait: what it judged, when the read STARTED (a reading must have started at or after a deadline to say what was pending then), and the card's line for it. */
export type Judged = Readonly<{ verdict: Verdict; readAt: number; text: string }>;
