// @ts-check
// module: the reason line a run's card shows, and the question it keeps one click away (PURE)
import { pullAnswer, type PullAnswer } from "./pull-answer.ts";
import { afterPartialMerge, stepQueuedLine, stepRunningLine } from "./plan-steps.ts";
import { completedEarly, settledByPulls } from "./pull-settled.ts";
import { mergeWaitLine } from "./pull-readiness.ts";
import { rebaseNote, retargetNote, runStatus, verdictNote, workingNote } from "./pull-status-and-notes.ts";
import { openPulls, pullsOf, type ViewEntry } from "./view-types-and-filters.ts";
import { pullLabel } from "./pull-label.ts";
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

/** What a card says of a run's agent sitting on a dialog (A11-174): the safety prompt the board declined for it (naming the subagent that raised it, A11-209), or the dialog a person must answer, with its first line when one could be read. PURE. */
export function promptNote(entry: ViewEntry): string | null {
  if (entry.waiting === true) return entry.prompt === undefined ? "Waiting on a person" : `Waiting on a person: ${entry.prompt}`;
  if (entry.phase !== "running" || entry.declined === undefined) return null;
  const { agent, command } = entry.declined;
  return `A safety prompt${agent === undefined ? "" : ` from the ${agent} subagent`} was declined automatically: ${command}`;
}

/** What the worker says of a run: its handed-back reason, the background work it is waiting on, the question it asked, why it stopped, or where its work belongs. PURE. */
function askedReason(entry: ViewEntry, now?: number): string | null {
  const outcome = entry.outcome;
  const note = workingNote(entry, now);
  if (entry.handedBack) return entry.handedBack;
  if (note !== null && !note.stalled) return note.text;
  if (outcome === undefined) return null;
  if (outcome.kind === "wrong-repo") return `Belongs in: ${outcome.where}`;
  if (outcome.kind === "no-outcome") return "Stopped without writing an outcome";
  return ["needs-human", "crashed", "checked", "done"].includes(outcome.kind) ? outcome.reason ?? null : null;
}

/**
 * What the card says of a run whose ticket the tracker completed while its work was partial and the board did not put back (A11-178): what the tracker did, what the run still has to do, and why
 * the board could not undo it. Said of a partial pull request that merged, and of a later step whose own pull requests are still open. PURE.
 */
function completedEarlyLine(entry: ViewEntry): string {
  const open = openPulls(entry).map(({ url }) => pullLabel(url));
  const last = (entry.steps ?? []).at(-1);
  const cause = entry.partial !== undefined ? `its last merged pull request declared Partial: ${entry.partial}`
    : `${last === undefined ? "its" : `step ${last.step + 1}'s`} pull request${open.length === 1 ? " is" : "s are"} not merged (${open.join(", ")})`;
  return `Done in the tracker, but ${cause}; the board could not put it back (${entry.reopenFailure ?? "it has not been asked yet"})`;
}

/** How many characters of a worker's words, or of a declaration, one card line quotes. */
const QUOTED_CHARS = 80;

/** `text` cut to `max` characters with an ellipsis, so a worker's long list does not fill a card's line. */
const cutAt = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max).trimEnd()} …` : text);

/**
 * That a merged pull request's declaration disagreed with the run's outcome, naming both, or null when it did not (A11-181): `its outcome said Partial: "…", but a11ign/announcement-emulator #2 said Closes A11-155,
 * so the board followed the pull request`. The outcome's words are quoted as written, cut at a sensible length. PURE.
 */
function overruledNote(entry: ViewEntry): string | null {
  const overruled = entry.partialOverruled;
  if (overruled === undefined) return null;
  const said = overruled.outcome === null ? "nothing remains" : `Partial: "${cutAt(overruled.outcome, QUOTED_CHARS)}"`;
  return `its outcome said ${said}, but ${overruled.urls.map(pullLabel).join(", ")} said ${cutAt(overruled.pull, QUOTED_CHARS)}, so the board followed the pull request`;
}

/** The merged pull requests of a run, as the board names them. PURE. */
const mergedLabels = (entry: ViewEntry): string[] => pullsOf(entry).filter(({ url }) => entry.pullStates?.[url] === "merged").map(({ url }) => pullLabel(url));

/**
 * What the card says of a plan's steps (A11-168), or null: that a step merged and the next is queued, or running once it started; and, on a finished run whose partial pull
 * requests merged with no next step to queue, why nothing was queued. The tracker's own word on the ticket comes first, as it does for the run's status. PURE.
 */
function stepNote(entry: ViewEntry): string | null {
  const merged = entry.steps ?? [];
  if (entry.phase !== "finished") return entry.phase === "queued" ? stepQueuedLine(merged) : stepRunningLine(merged);
  if (completedEarly(entry)) return completedEarlyLine(entry);
  const settled = entry.trackerState === "completed" || entry.trackerState === "canceled" || entry.trackerState === "duplicate";
  if (entry.partial === undefined || settled || settledByPulls(entry) !== "completed") return null;
  // Its outcome's words are not acted on until the merged bodies are read against them: said, so a run held on a read that cannot be answered is not a silent Needs you (A11-181).
  if (entry.declared === undefined) return `reading what ${mergedLabels(entry).join(", ")} declared (Closes or Partial:) before acting on its merge`;
  const after = afterPartialMerge(entry.partial, merged, entry.planSteps);
  const disagreement = overruledNote(entry);
  if ("stalled" in after) return disagreement === null ? after.stalled : `${after.stalled}. ${disagreement}`;
  return disagreement;
}

/**
 * What completed a Completed run (A11-173), or null: `completed: a11ign/agent-org #1815, a11ign/plugin #9 merged`, with `; 2 after-merge checks listed` once the board listed the
 * ticket's After-merge lines. A merged pull request that overruled the outcome's `partial` says so, naming both (A11-181). A run Completed without a merged pull request of its own (a `done`, or the tracker's word) says nothing here. PURE.
 */
export function completedLine(entry: ViewEntry): string | null {
  if (entry.phase !== "finished" || runStatus(entry) !== "completed") return null;
  const merged = pullsOf(entry).filter(({ url }) => entry.pullStates?.[url] === "merged");
  if (merged.length === 0) return null;
  const listed = entry.afterMerge?.length ?? 0;
  const disagreement = overruledNote(entry);
  return `completed: ${merged.map(({ url }) => pullLabel(url)).join(", ")} merged${disagreement === null ? "" : `; ${disagreement}`}${listed > 0 ? `; ${listed} after-merge check${listed === 1 ? "" : "s"} listed` : ""}`;
}

/** What a reviewed run that is Awaiting review waits on (A11-179): its review, its red checks, its running checks, from the heads the watch read. Null for any other run, and for one that waits on nothing. PURE. */
function mergeWait(entry: ViewEntry): string | null {
  return entry.phase === "finished" && entry.outcome?.kind === "reviewed" && runStatus(entry) === "awaiting-review" ? mergeWaitLine(entry) : null;
}

/**
 * The reason line a run's card shows, and the question it keeps one click away. A needs-human run whose pull requests answered it says "Answered: awaiting
 * review" or "Approved" from them, and keeps what it asked as `question`. A text the card already shows as the rebase, retarget or verdict note is not said a
 * second time, as the line or as the question (A11-153). `now`, when given, lets a run waiting on background work say for how long (A11-236). PURE.
 */
export function reasonOf(entry: ViewEntry, now?: number): Readonly<{ line: string | null; question: string | null }> {
  const shown = [rebaseNote(entry), retargetNote(entry), verdictNote(entry), checkNote(entry)];
  const once = (text: string | null): string | null => (text === null || shown.includes(text) ? null : text);
  const asked = once(askedReason(entry, now));
  // A reviewer herdr would not start twice is what the card says first, and the worker's question, if it asked one, stays one click away (A11-241).
  if (entry.reviewerRefused !== undefined && runStatus(entry) === "needs-you") return { line: entry.reviewerRefused, question: asked };
  const answer = pullAnswer(entry);
  if (answer !== null) return { line: ANSWER_LINE[answer], question: asked };
  // A run the board handed back keeps the question it asked one click away: the hand-back is the line, but the worker's question is still to be answered (A11-154).
  const asking = entry.handedBack !== undefined && entry.outcome?.kind === "needs-human" ? once(entry.outcome.reason ?? null) : null;
  // A Completed run says what completed it; what its worker said of it (a `done`'s reason, posted on the ticket) is kept one click away (A11-173).
  const completed = completedLine(entry);
  if (completed !== null) return { line: ticketChangeLine(entry) ?? completed, question: asking ?? asked };
  // That a ticket's text changed under the run comes first: it is what the run is doing about it (A11-167). A reviewed run that is not ready says what it waits on (A11-179).
  return { line: ticketChangeLine(entry) ?? asked ?? stepNote(entry) ?? mergeWait(entry), question: asking };
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
