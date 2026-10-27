// @ts-check
// module: the reason line a run's card shows, and the question it keeps one click away (PURE)
import { pullAnswer, type PullAnswer } from "./pull-answer.ts";
import { afterPartialMerge, stepQueuedLine, stepRunningLine } from "./plan-steps.ts";
import { completedEarly, settledByPulls } from "./pull-settled.ts";
import { mergeWaitLine } from "./pull-readiness.ts";
import { notMergingLine } from "./not-merging.ts";
import { rebaseNote, retargetNote, runStatus, verdictNote, workingNote } from "./pull-status-and-notes.ts";
import { openPulls, pullsOf, type ViewEntry } from "./view-types-and-filters.ts";
import { pullLabel } from "./pull-label.ts";
import { clockOf, shortVersion, versionLine, type UpdateView } from "./update-banner.ts";
import { ticketChangeLine } from "./ticket-change.ts";
import { blockerClearedLine, liftedBlockLine } from "./blocker-cleared.ts";

/** The words a card's reason line says for an answered run, in place of its question. */
const ANSWER_LINE: Readonly<Record<Exclude<PullAnswer, "cleared">, string>> = { approved: "Approved", answered: "Answered: awaiting review" };

/** The line for an answered run: the fixed words of {@link ANSWER_LINE}, or, for a lifted review, the pull requests it was lifted on (A11-258). PURE. */
const answerLine = (entry: ViewEntry, answer: PullAnswer): string | null => (answer === "cleared" ? liftedBlockLine(entry) : ANSWER_LINE[answer]);

/**
 * The line the board shows for a finished run whose red checks it reran or could not hand to a worker (A11-154), one per pull request, or null when none: that a
 * check that failed for an infrastructure reason was rerun, such as "Reran test on 1a2b3c4: a runner was lost", or that it failed again after its rerun and a person
 * decides. The run's status does not change for it. PURE.
 */
export function checkNote(entry: ViewEntry): string | null {
  const notes = entry.phase === "finished" && openPulls(entry).length > 0 ? Object.values(entry.checkHeads ?? {}).flatMap(({ note }) => (note === undefined ? [] : [note])) : [];
  return notes.length > 0 ? notes.join("; ") : null;
}

/**
 * The line the board shows for a finished run whose pull request the merge queue removed and no round answers (A11-264), one per pull request, or null when none: the removal named with its reason ("removed from the merge queue: merge_conflict"
 * for a reason the board does not answer), or the pull request removed three times for failed checks with no push between ("removed from the merge queue 3 times: middleware"), which the arm bot is held off. The run's status does not change for it. PURE.
 */
export function queueNote(entry: ViewEntry): string | null {
  const notes = entry.phase === "finished" && openPulls(entry).length > 0 ? Object.values(entry.queueHeads ?? {}).flatMap(({ note }) => (note === undefined ? [] : [note])) : [];
  return notes.length > 0 ? notes.join("; ") : null;
}

/** What a card says of a run's agent sitting on a dialog (A11-174): the safety prompt the board declined for it (naming the subagent that raised it, A11-209), or the dialog a person must answer, with its first line when one could be read. PURE. */
export function promptNote(entry: ViewEntry): string | null {
  if (entry.waiting === true) return entry.prompt === undefined ? "Waiting on a person" : `Waiting on a person: ${entry.prompt}`;
  if (entry.phase !== "running" || entry.declined === undefined) return null;
  const { agent, command } = entry.declined;
  return `A safety prompt${agent === undefined ? "" : ` from the ${agent} subagent`} was declined automatically: ${command}`;
}

/** What the card says when the pane had lost the run's environment (A11-279): the board started the run again with it, or could not. */
const ENVIRONMENT_LINES = {
  restored: "its environment was restored",
  missing: "environment missing: the gh wrapper will refuse its pull request until it is restarted",
} as const;

/**
 * What a running run's card says of the board's resume prompt (A11-279), or null when it sent none: "Resumed after a restart at 15:27", "Idle since 15:22, resumed at 15:32", or, when herdr would not take the prompt,
 * "could not be prompted: <herdr's reason>". The times are the viewer's clock, as the card's other times are. PURE.
 */
export function resumeLine(entry: ViewEntry): string | null {
  const { resume } = entry;
  if (entry.phase !== "running" || resume === undefined) return null;
  if (resume.refused !== undefined) return `could not be prompted: ${resume.refused}${resume.environment === "missing" ? `; ${ENVIRONMENT_LINES.missing}` : ""}`;
  const what = resume.after === "restart" ? `Resumed after a restart at ${clockOf(resume.at)}` : `Idle since ${clockOf(resume.idleSince ?? resume.at)}, resumed at ${clockOf(resume.at)}`;
  return resume.environment === undefined ? what : `${what}; ${ENVIRONMENT_LINES[resume.environment]}`;
}

/** What the worker says of a run: its handed-back reason, the board's resume of it, the background work it is waiting on, the question it asked, why it stopped, or where its work belongs. PURE. */
function askedReason(entry: ViewEntry, now?: number): string | null {
  const outcome = entry.outcome;
  const note = workingNote(entry, now);
  const resumed = resumeLine(entry);
  if (entry.handedBack) return entry.handedBack;
  // An idle run is never shown as only running: the board's resume comes first, then what its worker last said (A11-279).
  if (note !== null && !note.stalled) return resumed === null ? note.text : `${resumed}; ${note.text}`;
  if (resumed !== null) return resumed;
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
 * What completed a Completed run (A11-173), or null: `completed: a11ign/agent-org #1815, a11ign/plugin #9 merged` (`the blocker cleared: a11ign/agent-org #1815 merged` for a run that ended `needs-human`, A11-258), with `; 2 after-merge checks listed` once the board listed the
 * ticket's After-merge lines. A merged pull request that overruled the outcome's `partial` says so, naming both (A11-181). A run Completed without a merged pull request of its own (a `done`, or the tracker's word) says nothing here. PURE.
 */
export function completedLine(entry: ViewEntry): string | null {
  if (entry.phase !== "finished" || runStatus(entry) !== "completed") return null;
  const merged = pullsOf(entry).filter(({ url }) => entry.pullStates?.[url] === "merged");
  if (merged.length === 0) return null;
  const listed = entry.afterMerge?.length ?? 0;
  const disagreement = overruledNote(entry);
  const head = blockerClearedLine(entry) ?? `completed: ${merged.map(({ url }) => pullLabel(url)).join(", ")} merged`;
  return `${head}${disagreement === null ? "" : `; ${disagreement}`}${listed > 0 ? `; ${listed} after-merge check${listed === 1 ? "" : "s"} listed` : ""}`;
}

/** What a reviewed run that is Awaiting review waits on (A11-179): its review, its red checks, its running checks, from the heads the watch read. Null for any other run, and for one that waits on nothing. PURE. */
function mergeWait(entry: ViewEntry): string | null {
  return entry.phase === "finished" && entry.outcome?.kind === "reviewed" && runStatus(entry) === "awaiting-review" ? mergeWaitLine(entry) : null;
}

/** What a finished run the planner marked as waiting on another ticket reads (A11-343): `Waiting on A11-341: <why>`, and that a round starts when that ticket's pull request merges. Null for any other run. PURE. */
export function waitingLine(entry: ViewEntry): string | null {
  const wait = entry.waitingOnTicket;
  return entry.phase !== "finished" || wait === undefined ? null : `Waiting on ${wait.key}: ${wait.reason.trim()}; the board starts a round when its pull request merges`;
}

/**
 * The reason line a run's card shows, and the question it keeps one click away. A needs-human run whose pull requests answered it says "Answered: awaiting
 * review" or "Approved" from them, or "the blocker cleared: the requested changes on … were lifted" (A11-258), and keeps what it asked as `question`; one whose pull requests merged says "the blocker cleared: … merged" (A11-258). A text the card already shows as the rebase, retarget or verdict note is not said a
 * second time, as the line or as the question (A11-153). `now`, when given, lets a run waiting on background work say for how long (A11-236). PURE.
 */
export function reasonOf(entry: ViewEntry, now?: number): Readonly<{ line: string | null; question: string | null }> {
  const shown = [rebaseNote(entry), retargetNote(entry), verdictNote(entry), checkNote(entry), queueNote(entry)];
  const once = (text: string | null): string | null => (text === null || shown.includes(text) ? null : text);
  // A run the planner marked as waiting on another ticket says on what, and why, ahead of every other note: nothing is asked of a person (A11-343).
  const waiting = waitingLine(entry);
  if (waiting !== null) return { line: waiting, question: null };
  const asked = once(askedReason(entry, now));
  // A reviewer herdr would not start twice is what the card says first, and the worker's question, if it asked one, stays one click away (A11-241).
  if (entry.reviewerRefused !== undefined && runStatus(entry) === "needs-you") return { line: entry.reviewerRefused, question: asked };
  // A pull request approved and green that nothing merges, for an hour, or that installs a merge flow, is what the card says first (A11-291).
  if (entry.mergeNote !== undefined && runStatus(entry) === "needs-you") return { line: entry.mergeNote, question: asked };
  const answer = pullAnswer(entry);
  if (answer !== null) return { line: answerLine(entry, answer), question: asked };
  // A run the board handed back keeps the question it asked one click away: the hand-back is the line, but the worker's question is still to be answered (A11-154).
  const asking = entry.handedBack !== undefined && entry.outcome?.kind === "needs-human" ? once(entry.outcome.reason ?? null) : null;
  // A Completed run says what completed it; what its worker said of it (a `done`'s reason, posted on the ticket) is kept one click away (A11-173).
  const completed = completedLine(entry);
  if (completed !== null) return { line: ticketChangeLine(entry) ?? completed, question: asking ?? asked };
  // A `needs-human` run whose pull requests merged and whose next step is not simply queued says the blocker is gone and what happens next, in place of the question it asked, which stays one click away (A11-258).
  const cleared = blockerClearedLine(entry);
  if (cleared !== null) return { line: ticketChangeLine(entry) ?? [cleared, stepNote(entry)].filter((part) => part !== null).join("; "), question: asking ?? asked };
  // That a ticket's text changed under the run comes first: it is what the run is doing about it (A11-167). A pull request approved and green that nothing merges says so, with the reason (A11-291). A reviewed run that is not ready says what it waits on (A11-179).
  return { line: ticketChangeLine(entry) ?? asked ?? notMergingLine(entry) ?? stepNote(entry) ?? mergeWait(entry), question: asking };
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
