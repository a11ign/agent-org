// @ts-check
// module: the reason line a run's card shows, and the question it keeps one click away (PURE)
import { pullAnswer, type PullAnswer } from "./pull-answer.ts";
import { afterPartialMerge, stepQueuedLine, stepRunningLine } from "./plan-steps.ts";
import { rebaseNote, retargetNote, settledByPulls, verdictNote, workingNote } from "./pull-status-and-notes.ts";
import { openPulls, type ViewEntry } from "./view-types-and-filters.ts";
import { clockOf, shortVersion, versionLine, type UpdateView } from "./update-banner.ts";
import { ticketChangeLine } from "./ticket-change.ts";

/** The words a card's reason line says for an answered run, in place of its question. */
const ANSWER_LINE: Readonly<Record<PullAnswer, string>> = { approved: "Approved", answered: "Answered: awaiting review" };

/**
 * The line the board shows for a finished run whose red checks it reran or could not hand to a worker (A11-154), one per pull request, or null when none: that a
 * check that failed for an infrastructure reason was rerun, such as "Reran test on 1a2b3c4: a runner was lost", or that it failed again after its rerun and a person
 * decides. The run's status does not change for it. PURE.
 */
export function checkNote(entry: ViewEntry): string | null {
  const notes = entry.phase === "finished" && openPulls(entry).length > 0 ? Object.values(entry.checkHeads ?? {}).flatMap(({ note }) => (note === undefined ? [] : [note])) : [];
  return notes.length > 0 ? notes.join("; ") : null;
}

/** What the worker says of a run: its handed-back reason, the background work it is waiting on, the question it asked, why it stopped, or where its work belongs. PURE. */
function askedReason(entry: ViewEntry): string | null {
  const outcome = entry.outcome;
  const note = workingNote(entry);
  if (entry.handedBack) return entry.handedBack;
  if (note !== null && !note.stalled) return note.text;
  if (outcome === undefined) return null;
  if (outcome.kind === "wrong-repo") return `Belongs in: ${outcome.where}`;
  if (outcome.kind === "no-outcome") return "Stopped without writing an outcome";
  return ["needs-human", "crashed", "checked", "done"].includes(outcome.kind) ? outcome.reason ?? null : null;
}

/**
 * What the card says of a plan's steps (A11-168), or null: that a step merged and the next is queued, or running once it started; and, on a finished run whose partial pull
 * requests merged with no next step to queue, why nothing was queued. The tracker's own word on the ticket comes first, as it does for the run's status. PURE.
 */
function stepNote(entry: ViewEntry): string | null {
  const merged = entry.steps ?? [];
  if (entry.phase !== "finished") return entry.phase === "queued" ? stepQueuedLine(merged) : stepRunningLine(merged);
  const settled = entry.trackerState === "completed" || entry.trackerState === "canceled" || entry.trackerState === "duplicate";
  if (entry.partial === undefined || settled || settledByPulls(entry) !== "completed") return null;
  const after = afterPartialMerge(entry.partial, merged);
  return "stalled" in after ? after.stalled : null;
}

/**
 * The reason line a run's card shows, and the question it keeps one click away. A needs-human run whose pull requests answered it says "Answered: awaiting
 * review" or "Approved" from them, and keeps what it asked as `question`. A text the card already shows as the rebase, retarget or verdict note is not said a
 * second time, as the line or as the question (A11-153). PURE.
 */
export function reasonOf(entry: ViewEntry): Readonly<{ line: string | null; question: string | null }> {
  const shown = [rebaseNote(entry), retargetNote(entry), verdictNote(entry), checkNote(entry)];
  const once = (text: string | null): string | null => (text === null || shown.includes(text) ? null : text);
  const asked = once(askedReason(entry));
  const answer = pullAnswer(entry);
  if (answer !== null) return { line: ANSWER_LINE[answer], question: asked };
  // A run the board handed back keeps the question it asked one click away: the hand-back is the line, but the worker's question is still to be answered (A11-154).
  const asking = entry.handedBack !== undefined && entry.outcome?.kind === "needs-human" ? once(entry.outcome.reason ?? null) : null;
  // That a ticket's text changed under the run comes first: it is what the run is doing about it (A11-167).
  return { line: ticketChangeLine(entry) ?? asked ?? stepNote(entry), question: asking };
}


/** Whether a run that holds its copy of agent-org (it is live, or a parked workspace is open) was started on a version that is not the instance's. PURE. */
const isOffInstanceVersion = (entry: ViewEntry, instanceVersion: string | null): boolean => {
  const holdsVersion = entry.phase === "starting" || entry.phase === "running" || entry.workspace !== undefined;
  return holdsVersion && instanceVersion !== null && entry.toolVersion !== instanceVersion;
};

/**
 * What a run's card says of the update (A11-169), one line each, in order. While a breaking update drains, a live run says it is "finishing before the update" and a queued one "waits for the update".
 * A run the board stopped for an update says when, and which release it resumes on, until its round starts. A live or parked run whose version is not the instance's says which it is on. A run on
 * the instance's version, and every run while no update drains, say nothing. PURE.
 */
export function updateLines(entry: ViewEntry, view: UpdateView | undefined): string[] {
  if (view === undefined) return [];
  const lines: string[] = [];
  const stopped = entry.stoppedForUpdate;
  if (stopped !== undefined && entry.phase === "queued") lines.push(`stopped for the update at ${clockOf(stopped.at)} and re-queued; resumes on ${shortVersion(stopped.target)}`);
  else if (view.note !== null) {
    if (entry.phase === "starting" || entry.phase === "running") lines.push("finishing before the update");
    else if (entry.phase === "queued") lines.push("waits for the update");
  }
  if (isOffInstanceVersion(entry, view.instanceVersion) && entry.toolVersion !== undefined && view.instanceVersion !== null) lines.push(versionLine(entry.toolVersion, view.instanceVersion));
  return lines;
}
