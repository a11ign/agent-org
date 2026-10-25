// @ts-check
// module: watching the runs -- each run's status from herdr, what its outcome settles, and the tick that drives a pass

import { herdrReason, readAgents } from "../herdr-agents.ts";
import { herdrRefusal } from "./pool-herdr.ts";
import { log, missedAgain, publishPlace, runMembers, runPlace, sameRun, update, updateEach, writerPlace } from "./pool-state.ts";
import { close, end, headCommitsOf, pullFilesOf, pullHeadsOf, recordWrittenStep, settle } from "./pool-settle.ts";
import { type RunPlace, worktreesIn } from "./pool-paths.ts";
import { checkRound, conflictRound, feedbackRound, markResumed, observe, observePublish, recordCheckHeads, recordPullFiles, recordRepos, recordStackBase, roundsLeft, unpark, watchWorking } from "./queue/queue-transitions.ts";
import { answerStartDialog, fill } from "./pool-start.ts";
import { declineSafetyPrompt, readPrompt, retellDeclined, untoldDecline } from "./pool-decline.ts";
import { join } from "node:path";
import { OUTCOME_FILE, STOP_COUNT_FILE, WAITING_FILE } from "./worker-files.ts";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { conflictLines, feedbackSince, markOutcomeStale, outcomeWritten, parseOutcome, publishResult, QUESTION_CHARS } from "./pool-outcome.ts";
import { isParked, isWatched, resumesOnConflict } from "./board-view/pull-status-and-notes.ts";
import { type Background, BACKGROUND_GONE, BACKGROUND_GONE_MS, type Entry, proposedEdit, replace, SETTLED, type WorkingNote, type WriterRun, type WrittenOutcome } from "./queue/queue-entries-and-outcomes.ts";
import { deadlineOf, wakeRefused } from "./wait-on/wait-note.ts";
import { sendWake, wakePrompt } from "./wait-on/wait-prompt.ts";
import { fleetJobStatusVia, type WaitSeams } from "./wait-on/wait-read.ts";
import { judgedWait, pollWhenDue } from "./wait-on/wait-watch.ts";
import type { Judged } from "./wait-on/wait-verdict.ts";
import type { Woke } from "./wait-on/wait-types.ts";
import { paneBackgroundWork } from "./background-work.ts";
import { endPublish, endWriter, finishWriter } from "./pool-board-runs.ts";
import { afterConflictCleared, stackBaseIn } from "./stack-rebase.ts";
import { moveOutcomeHeads, recordOutcomeHeads, recordPullHeads, recordStaleBlock } from "./queue/queue-pull-heads.ts";
import { isStaleBlockNote, staleBlockNote, stampedBlocks } from "./board-view/stale-block.ts";
import { isReviewerDialogNote, reviewerDialogNote } from "./board-view/reviewer-dialog-note.ts";
import { recordReviewerDialog } from "./queue/queue-reviewer-dialog.ts";
import { observeWriter, writerResumed, writerWaiting } from "./queue.ts";
import { openPulls } from "./board-view/view-types-and-filters.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import { reviewerLines } from "./pool-reviewers.ts";
import { type PoolContext } from "./pool-context.ts";
import { forceDrain } from "./pool-drain.ts";
import { releaseTicketWaits } from "./pool-ticket-wait.ts";
import { readoptCrashed } from "./pool-readopt.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { answerChecks, type CheckAnswer } from "./pool-checks.ts";
import { answerQueue, type QueueAnswer } from "./pool-merge-queue.ts";
import { recordQueueHeads } from "./queue/queue-merge-queue.ts";
import { foreignRedsOf } from "./pool-foreign-checks.ts";

/** The longest a publish run may take. Posting a few messages takes a minute or two. */
const PUBLISH_LIMIT_MS = 30 * 60_000;

const HOUR_MS = 60 * 60_000;
/** The longest a quick new-ticket run may take, from its start. */
const WRITER_LIMIT_MS = 30 * 60_000;
/**
 * The longest a grill new-ticket run may work, from its start or from the person's last answer: it waits on the person between its questions, so it
 * has longer. The person can stop it.
 */
const WRITER_GRILL_LIMIT_MS = 4 * 60 * 60_000;
/**
 * The longest a grill new-ticket run waits for the person to answer its question, from when its agent ended its turn with it. A run nobody answers
 * is failed, saying so (A11-129).
 */
const WRITER_ANSWER_WAIT_MS = 4 * 60 * 60_000;
/** What a grill run's card says its agent waits on, when no question can be read from the stop hook's file. */
const WAITING_LINE = "Its agent is waiting for you in its terminal.";

/** What the board tells a worker whose run is idle with no background work to wake it, once (A11-85). */
const BACKGROUND_GONE_PROMPT = "your background work is gone; check it and carry on";

/**
 * Claude session ids by workspace id. Keyed by WORKSPACE, not by agent name as `readAgentSessions` is: herdr names an agent only when its
 * `agent start` completes, and a start that a dialog held up past its wait never does (measured 2026-10-13, `name: null` on a running worker).
 */
function readSessionIds(ctx: PoolContext): Map<string, string> {
  const { herdr, settings } = ctx;
  try {
    const agents = JSON.parse(herdr(["--session", settings.herdrSession, "agent", "list"]))?.result?.agents;
    if (!Array.isArray(agents)) return new Map();
    return new Map(agents.filter((a) => a?.workspace_id && a?.agent_session?.value).map((a) => [String(a.workspace_id), String(a.agent_session.value)]));
  } catch {
    return new Map();
  }
}

/** Read each live and parked run's status once: record any live run that has ended, and resume any parked one a person has answered. */
function watch(ctx: PoolContext): void {
  const { claudeSessions, herdr, session } = ctx;
  const agents = readAgents((args) => herdr(args), session);
  if (agents === null) return;
  const status = new Map(agents.map((agent) => [agent.label, agent.status]));
  for (const [workspace, id] of readSessionIds(ctx)) claudeSessions.set(workspace, id);
  readoptCrashed(ctx, agents);
  watchRunning(ctx, status);
  watchParked(ctx, status);
  rereadUnreadable(ctx);
  watchPublish(ctx, status);
  watchWriters(ctx, status);
}

/**
 * Each running run's status, from one listing (label -> status): record its repositories, answer a start dialog, or end it. A batch's run is
 * watched once, through its first ticket: the others have no agent of their own.
 */
function watchRunning(ctx: PoolContext, status: ReadonlyMap<string, string>): void {
  const { misses, startedHere, store } = ctx;
  const watched = new Set<string>();
  for (const entry of store.get().entries.filter((e) => e.phase === "running")) {
    const key = entry.ticket.key;
    const { name, dir, folder } = runPlace(ctx, entry);
    if (watched.has(name)) continue;
    watched.add(name);
    const seen = status.get(name);
    if (seen === undefined || seen === "unknown") {
      if (missedAgain(ctx, name)) end(ctx, entry, { kind: "crashed", reason: seen === undefined ? "its herdr workspace is gone" : "herdr finds no agent in its workspace" });
      continue;
    }
    misses.delete(name);
    if (["working", "idle", "done"].includes(seen)) startedHere.delete(name);
    const repos = worktreesIn(folder);
    if (repos.join("\n") !== entry.repos.join("\n")) update(ctx, (queue) => recordRepos(queue, key, repos));
    const sitting = !["working", "idle", "done"].includes(seen);
    if (sitting && answerStartDialog(ctx, runPlace(ctx, entry))) continue;
    // A dialog that is not a start dialog (A11-174): a Claude Code safety prompt is answered No and the agent told why, any other is left for a person, with its first line.
    const prompt = sitting ? readPrompt(ctx, runPlace(ctx, entry)) : null;
    if (prompt !== null && declineSafetyPrompt(ctx, entry, runPlace(ctx, entry), prompt)) continue;
    updateEach(ctx, runMembers(ctx, entry), (queue, member) => observe(queue, member, seen, prompt?.firstLine, ctx.now()));
    const latest = () => store.get().entries.find((e) => e.ticket.key === key) ?? entry;
    const current = latest();
    const outcomePath = join(dir, OUTCOME_FILE);
    // The step the worker says it is on is read while it works, so the page shows it as the worker moves on (A11-219).
    recordWrittenStep(ctx, current);
    if ((seen === "idle" || seen === "done") && outcomeWritten(dir)) {
      settle(ctx, current, parseOutcome(readFileSync(outcomePath, "utf8"), { talk: current.talk === true }));
      // A run still running after its outcome was read wrote `working`: its idle clock runs, and may mark it stalled. A decline it was not yet told of is told now, not to a run that just ended.
      if (sameRun(ctx, current)) {
        // A plan attach being tried again keeps its retry note on the card for minutes: the stall watch must not read that as an agent gone quiet, nor prompt the planner (A11-216).
        if (!ctx.attachRetries.has(name)) watchStall(ctx, current, seen);
        retellDeclined(ctx, latest(), runPlace(ctx, entry), seen);
      }
      continue;
    }
    // The message a refused one waits for, before an idle run with no outcome is called over: the status read before it is not the agent's answer to it (A11-174).
    const justTold = retellDeclined(ctx, current, runPlace(ctx, entry), seen);
    if (seen === "working") watchStall(ctx, latest(), seen);
    else if (!justTold && stoppedWithNoOutcome(ctx, latest(), seen)) end(ctx, latest(), { kind: "no-outcome" });
  }
  // What was read of a wait belongs to a run that is still running: a run that ended or was stopped leaves nothing behind.
  for (const name of ctx.waitPolls.keys()) if (!watched.has(name)) ctx.waitPolls.delete(name);
}

/**
 * Whether a running agent with no outcome file has stopped: it is done, or it went idle after it was seen working. An idle agent whose decline of a safety prompt it has not
 * been told of is not over: the message is what it waits for (A11-174). PURE.
 */
function stoppedWithNoOutcome(ctx: PoolContext, entry: Entry, seen: string): boolean {
  if (seen === "done") return true;
  if (seen !== "idle" || entry.seenWorking !== true) return false;
  return !untoldDecline(ctx, entry);
}

/**
 * Each parked run's status, from the same listing: one whose agent works again resumes, one that wrote a new outcome has ended again, and one
 * whose workspace is gone is unparked.
 */
function watchParked(ctx: PoolContext, status: ReadonlyMap<string, string>): void {
  const { misses, store } = ctx;
  const watched = new Set<string>();
  for (const entry of store.get().entries.filter(isParked)) {
    const { name } = runPlace(ctx, entry);
    if (watched.has(name)) continue;
    watched.add(name);
    const seen = status.get(name);
    if (seen === undefined) {
      if (missedAgain(ctx, name)) {
        misses.delete(name);
        closeLeftWorkspace(ctx, entry);
        updateEach(ctx, runMembers(ctx, entry), unpark);
      }
      continue;
    }
    misses.delete(name);
    const fresh = newOutcome(ctx, entry);
    if (seen === "working") {
      if (fresh === null) resume(ctx, entry);
      else markLive(ctx, entry);
    }
    else if (fresh !== null && (seen === "idle" || seen === "done")) {
      markLive(ctx, entry);
      settle(ctx, store.get().entries.find((e) => e.ticket.key === entry.ticket.key) ?? entry, fresh);
    }
  }
}

/**
 * Close the workspace of a parked run herdr no longer lists an agent for, by its id, as it is unparked (A11-154): left open, it would keep the run's herdr name and Claude session,
 * and the round that starts next would open beside it. A workspace that is gone already is no refusal worth saying; any other is logged, and the run is unparked as it was.
 */
function closeLeftWorkspace(ctx: PoolContext, entry: Entry): void {
  const { herdr, settings } = ctx;
  if (entry.workspace === undefined) return;
  try {
    herdr(["--session", settings.herdrSession, "workspace", "close", entry.workspace]);
  } catch (err) {
    if (!herdrRefusal(err).includes("workspace_not_found")) log(`${entry.ticket.key}: its workspace ${entry.workspace} could not be closed as the run was unparked (${herdrRefusal(err)})`);
  }
}

/**
 * The outcome a parked run's worker wrote after the run parked, or null. A file written before then, or one that says what the run parked on,
 * is the old outcome: the run parked on it.
 */
function newOutcome(ctx: PoolContext, entry: Entry): WrittenOutcome | null {
  const path = join(runPlace(ctx, entry).dir, OUTCOME_FILE);
  if (!existsSync(path) || statSync(path).mtimeMs <= (entry.finishedAt ?? 0)) return null;
  const outcome = parseOutcome(readFileSync(path, "utf8"), { talk: entry.talk === true });
  // A proposed edit is stored with the ticket's text the board read: the file never holds that, so it is set aside for the comparison (A11-91).
  const edit = proposedEdit(entry);
  const stored = edit === undefined ? entry.outcome : { ...entry.outcome, edit: { ...edit, base: undefined } };
  return JSON.stringify(outcome) === JSON.stringify(stored) ? null : outcome;
}

/** A finished run that is not parked, whose outcome file the pool could not read (A11-118). */
const isUnreadable = (entry: Entry): boolean => entry.phase === "finished" && !isParked(entry) && entry.outcome?.kind === "needs-human" && entry.outcome.unreadable === true;

/**
 * Each finished run whose outcome file was unreadable is checked again on every pass (A11-118). A file written after the run ended is read: a
 * corrected one ends the run on its real outcome, so the board moves it off Needs you without a Dismiss. A file that is still wrong changes nothing.
 */
/** Whether a fresh outcome of an unreadable finished run ends it: a valid one other than `working`, which takes no note once a run has ended (A11-118). PURE. */
const endsUnreadable = (fresh: WrittenOutcome | null): fresh is WrittenOutcome =>
  fresh !== null && fresh.kind !== "working" && !(fresh.kind === "needs-human" && fresh.unreadable === true);

function rereadUnreadable(ctx: PoolContext): void {
  const { store } = ctx;
  const watched = new Set<string>();
  for (const entry of store.get().entries.filter(isUnreadable)) {
    // A batch's run is read once, through its first ticket, as watchParked reads it.
    const { name } = runPlace(ctx, entry);
    if (watched.has(name)) continue;
    watched.add(name);
    const fresh = newOutcome(ctx, entry);
    if (!endsUnreadable(fresh)) continue;
    settle(ctx, store.get().entries.find((e) => e.ticket.key === entry.ticket.key) ?? entry, fresh);
  }
}

/**
 * A person answered a parked run: its outcome is marked stale, so the stop hook asks for a new one, and the run is live again. The mark is when the run
 * parked. A file the worker wrote after that is its new outcome, and the hook judges it as written; the file it parked on stays where it is (A11-152).
 */
function resume(ctx: PoolContext, entry: Entry): void {
  const { dir } = runPlace(ctx, entry);
  markOutcomeStale(dir, entry.finishedAt ?? ctx.now());
  markLive(ctx, entry);
}

/** Mark a parked run live again with a fresh stop count. An outcome file written since it parked stays: it is the run's new outcome. */
function markLive(ctx: PoolContext, entry: Entry): void {
  rmSync(join(runPlace(ctx, entry).dir, STOP_COUNT_FILE), { force: true });
  updateEach(ctx, runMembers(ctx, entry), markResumed);
}

/** The log line of a run first marked stalled on its `working` note: which of the reasons stalled it (A11-85, A11-236, A11-245). PURE. */
function stallLine(who: string, note: WorkingNote, stallMinutes: number): string {
  if (note.stallReason === BACKGROUND_GONE) return `${who} wrote working with no background work running for ${BACKGROUND_GONE_MS / 60_000} minutes, so nothing will wake it: marked stalled, and told once to check its background work: ${note.reason}`;
  if (note.waits !== undefined && note.stallReason !== undefined) return `${who} is stalled on its declared wait (${note.stallReason}): ${note.reason}`;
  // The only other reason a note carries is the one that names what it waited on past the end of its wait.
  if (note.stallReason !== undefined) return `${who} was waiting on background work and has been idle past the end of its wait, with no newer outcome (${note.stallReason}): ${note.reason}`;
  return `${who} has been idle for ${stallMinutes} minutes or more since it wrote working, with no newer outcome: ${note.reason}`;
}

/** The log line of a worker the board prompted for its wait, once (A11-245). PURE. */
const wakeLine = (who: string, woke: Woke): string =>
  `${who} was prompted once ${woke.why === "late" ? "because its wait passed its deadline" : `because what it waited on ${woke.why === "failed" ? "failed" : "finished"}`}`;

/**
 * Move a working run's idle clock on `seen`, and log once when the run is first marked stalled. A run that declared the events it waits on has them read, off the tick, while it is idle (A11-245); when the board first
 * judges the wait over, or past its deadline, the note's `woke` says so, and the worker is prompted once. Nothing is ended and no key is sent.
 */
function watchStall(ctx: PoolContext, entry: Entry, seen: string): void {
  const { now, settings, stallMs, store, waitPolls } = ctx;
  const { name } = runPlace(ctx, entry);
  const find = () => store.get().entries.find((e) => e.ticket.key === entry.ticket.key)?.working;
  const before = find();
  const wasResumed = before?.resumed === true;
  const background = seen === "working" ? null : paneBackground(ctx, entry);
  if (before !== undefined && (seen === "idle" || seen === "done")) pollWhenDue(waitPolls, name, before, now, waitSeamsOf(ctx));
  const judged = before === undefined ? null : judgedWait(waitPolls, name, before);
  // One time for every ticket of a batch, so a wake they share carries the same `at` on each.
  const at = now();
  updateEach(ctx, runMembers(ctx, entry), (queue, member) => watchWorking(queue, member, seen, at, stallMs, background, judged));
  const note = find();
  if (before?.stalled !== true && note?.stalled === true) log(stallLine(entry.batch ?? entry.ticket.key, note, settings.stallMinutes));
  if (!wasResumed && note?.resumed === true) promptBackgroundGone(ctx, entry);
  if (before?.woke === undefined && note?.woke !== undefined) wakeWorker(ctx, entry, note, note.woke, judged);
}

/** What the board reads a declared wait with: the code host, the tracker and the `fleet` program, or the seams a test gave. */
function waitSeamsOf({ codeHost, source, deps }: PoolContext): WaitSeams {
  return { codeHost, source, fleetJobStatus: deps.waitSeams?.fleetJobStatus ?? fleetJobStatusVia(), ...(deps.waitSeams?.readTimeoutMs === undefined ? {} : { readTimeoutMs: deps.waitSeams.readTimeoutMs }) };
}

/**
 * Prompt a run's worker, once, for the wait the note's `woke` says ended or passed its deadline (A11-245). `woke` was written to the note before this is called, so a restart or a repeated tick never sends it twice. A prompt herdr
 * refuses is counted and the wake is offered again on the next pass, up to {@link MAX_WAKE_TRIES}, after which the run is marked stalled with the refusal.
 */
function wakeWorker(ctx: PoolContext, entry: Entry, note: WorkingNote, woke: Woke, judged: Judged | null): void {
  const { herdr, settings } = ctx;
  const who = entry.batch ?? entry.ticket.key;
  const text = wakePrompt(woke, note.waits === undefined ? null : judged?.verdict ?? null, deadlineOf(note));
  const refusal = sendWake(herdr, settings.herdrSession, runPlace(ctx, entry).name, text);
  if (refusal === null) return log(wakeLine(who, woke));
  updateEach(ctx, runMembers(ctx, entry), (queue, member) => replace(queue, member, (held) => (held.working === undefined ? held : { ...held, working: wakeRefused(held.working, refusal, woke) })));
  log(`${who} could not be prompted for its wait: ${refusal}`);
}

/**
 * The background work a run's pane shows, as the board's {@link Background}: `live` when its status line counts a shell or a Monitor, `none` when
 * it counts neither, and null when herdr cannot read the pane, so the thirty-minute rule decides alone.
 */
function paneBackground(ctx: PoolContext, entry: Entry): Background {
  const { herdr, settings } = ctx;
  if (entry.pane === undefined) return null;
  try {
    const counts = paneBackgroundWork(herdr(["--session", settings.herdrSession, "pane", "read", entry.pane, "--source", "visible", "--lines", "6"]));
    return counts.shells + counts.monitors > 0 ? "live" : "none";
  } catch {
    return null;
  }
}

/** Tell a run's worker, once, that its background work is gone: it checks it and carries on. A refusal is said, and nothing else is sent. */
function promptBackgroundGone(ctx: PoolContext, entry: Entry): void {
  const { herdr, settings } = ctx;
  try {
    herdr(["--session", settings.herdrSession, "agent", "prompt", runPlace(ctx, entry).name, BACKGROUND_GONE_PROMPT]);
  } catch (err) {
    log(`${entry.batch ?? entry.ticket.key} could not be told its background work is gone: ${herdrReason(err)}`);
  }
}

/**
 * Each new-ticket run's status, from the same listing as the ticket runs'. A running one ends once its outcome file is there and its agent is idle or
 * done, when its outcome is read and the tickets it filed are checked (`finishWriter`). A quick run ends failed when its agent stops without one. A grill run is
 * different: when its agent ends its turn with no outcome, the run is Waiting for the person, who answers in its terminal. It keeps its workspace, its
 * pane and its slot, and resumes when its agent works again. It fails only when its agent exits, or when nobody answers for too long (A11-129).
 */
function watchWriters(ctx: PoolContext, status: ReadonlyMap<string, string>): void {
  const { finishing, misses, now, startedHere, store } = ctx;
  for (const run of store.get().writers ?? []) {
    if (run.phase !== "running") continue;
    const place = writerPlace(ctx, run);
    const overdue = writerOverdue(run, now());
    if (overdue !== null) {
      endWriter(ctx, run, overdue);
      continue;
    }
    const seen = status.get(place.name);
    if (seen === undefined || seen === "unknown") {
      if (missedAgain(ctx, place.name)) endWriter(ctx, run, `its agent exited: ${seen === undefined ? "its herdr workspace is gone" : "herdr finds no agent in its workspace"}`);
      continue;
    }
    misses.delete(place.name);
    if (["working", "idle", "done"].includes(seen)) startedHere.delete(place.name);
    if (!["working", "idle", "done"].includes(seen) && answerStartDialog(ctx, place)) continue;
    if (seen === "working") {
      update(ctx, (queue) => writerResumed(observeWriter(queue, run.id), run.id, now()));
      continue;
    }
    const outcomePath = join(place.dir, OUTCOME_FILE);
    if ((seen === "idle" || seen === "done") && existsSync(outcomePath)) {
      if (!finishing.has(run.id)) void finishWriter(ctx, run, place, readFileSync(outcomePath, "utf8"));
    } else if (run.mode === "grill" && (seen === "idle" || seen === "done")) {
      update(ctx, (queue) => writerWaiting(queue, run.id, questionOnFile(place.dir), now()));
    } else if (stoppedWithoutOutcome(run, seen)) endWriter(ctx, run, "it stopped without writing an outcome");
  }
}

/**
 * Why a new-ticket run is over its time, or null while it may run on. A quick run has {@link WRITER_LIMIT_MS} from its start. A grill run waiting for
 * the person has {@link WRITER_ANSWER_WAIT_MS} from when it began to wait; a grill run working has {@link WRITER_GRILL_LIMIT_MS} from its start or its
 * last answer. PURE.
 */
function writerOverdue(run: WriterRun, now: number): string | null {
  if (run.mode === "quick") {
    return now - (run.startedAt ?? now) > WRITER_LIMIT_MS ? `it did not finish within ${WRITER_LIMIT_MS / 60_000} minutes` : null;
  }
  if (run.waiting !== undefined) {
    return now - run.waiting.since > WRITER_ANSWER_WAIT_MS ? `nobody answered its question for ${WRITER_ANSWER_WAIT_MS / HOUR_MS} hours` : null;
  }
  return now - (run.startedAt ?? now) > WRITER_GRILL_LIMIT_MS ? `it did not finish within ${WRITER_GRILL_LIMIT_MS / 60_000} minutes` : null;
}

/**
 * The question a grill run's agent asked, from the file the stop hook writes beside its outcome, or the fixed line when the file says none it can read
 * (A11-129). Cut to the length a needs-human reason is, so the card shows what the agent wrote and no more.
 */
function questionOnFile(dir: string): string {
  try {
    const { question } = JSON.parse(readFileSync(join(dir, WAITING_FILE), "utf8")) as { question?: unknown };
    return typeof question === "string" && question.trim() !== "" ? question.trim().slice(0, QUESTION_CHARS) : WAITING_LINE;
  } catch {
    return WAITING_LINE;
  }
}

/**
 * Whether a quick run's agent has stopped with no outcome: it is done, or it went idle after it was seen working. A grill run never stops this way:
 * its agent ending its turn with no outcome is a question it waits on (A11-129).
 */
function stoppedWithoutOutcome(run: WriterRun, seen: string): boolean {
  if (run.mode === "grill") return false;
  return seen === "done" || (seen === "idle" && run.seenWorking === true);
}

/**
 * How a publish run ended, as the publisher plugin reads its outcome (A11-161). A run that was started before the publisher was switched off still ends, and is read by core's own protocol,
 * which every publisher shares: nothing of a chat service is in it.
 */
const readPublishResult = ({ publisher }: PoolContext, outcomeText: string, dir: string) => (publisher === undefined ? publishResult(outcomeText, dir) : publisher.result(outcomeText, dir));

/** The publish run's status, from the same listing as the ticket runs': it ends once its outcome file is there and its agent is idle or done. */
function watchPublish(ctx: PoolContext, status: ReadonlyMap<string, string>): void {
  const { misses, now, startedHere, store } = ctx;
  const publish = store.get().publish;
  if (publish?.phase !== "running") return;
  const place = publishPlace(ctx, publish);
  // A publish run holds a slot, and no other can start while it is under way, so one that never ends must not hold them for ever.
  if (now() - (publish.startedAt ?? now()) > PUBLISH_LIMIT_MS) return endPublish(ctx, publish, { failure: `it did not finish within ${PUBLISH_LIMIT_MS / 60_000} minutes` });
  const seen = status.get(place.name);
  if (seen === undefined || seen === "unknown") {
    if (missedAgain(ctx, place.name)) endPublish(ctx, publish, { failure: seen === undefined ? "its herdr workspace is gone" : "herdr finds no agent in its workspace" });
    return;
  }
  misses.delete(place.name);
  if (["working", "idle", "done"].includes(seen)) startedHere.delete(place.name);
  if (!["working", "idle", "done"].includes(seen) && answerStartDialog(ctx, place)) return;
  update(ctx, (queue) => observePublish(queue, seen));
  const outcomePath = join(place.dir, OUTCOME_FILE);
  if ((seen === "idle" || seen === "done") && existsSync(outcomePath)) endPublish(ctx, publish, readPublishResult(ctx, readFileSync(outcomePath, "utf8"), place.dir));
  else if (seen === "done" || (seen === "idle" && store.get().publish?.seenWorking === true)) endPublish(ctx, publish, { failure: "it stopped without writing an outcome" });
}

/** One pass: watch the live runs, then fill free slots. Passes never overlap; a call during a pass runs one more pass after it. */
export async function tick(ctx: PoolContext): Promise<void> {
  const pass = ctx.tickState;
  if (pass.busy) {
    pass.again = true;
    return;
  }
  pass.busy = true;
  try {
    do {
      pass.again = false;
      watch(ctx);
      // A draining update's deadline (A11-169): the runs still live are stopped and queued again before the pass fills slots, which a drain starts nothing in.
      forceDrain(ctx);
      // A run whose worker waits on a ticket not done lets go of its slot and its files, and is queued behind it, before the pass fills slots (A11-272).
      const releasing = releaseTicketWaits(ctx);
      if (releasing !== null) await releasing;
      await fill(ctx);
    } while (pass.again);
  } finally {
    pass.busy = false;
  }
}

/**
 * Read the open pull requests of each finished run, and queue a review round for each run whose pull requests got new feedback since its last
 * round ended: a review, a comment or an inline comment by anyone but the workers' account, or a pull request that conflicts with its base; or a check that is
 * red at a head the board has not answered, once for each head, with the failing checks and their log lines (A11-154, {@link answerChecks}). A watched run gets all of
 * that. Any other run {@link resumesOnConflict} names, such as one parked on a question, one that ended needs-human, and one that crashed, gets its conflict and its red
 * checks alone (A11-89): its workspace is closed, then a round is queued, so a question it parked on is not answered by a new comment. A check that failed for an
 * infrastructure reason is rerun first, and named, and no worker gets it. Every finished run's read records the files its open pull requests change, which is its
 * footprint while it is held (a draft too). A run whose pull request could not be read is asked again next time, and one merged or closed since is left alone.
 */
export function watchFeedback(ctx: PoolContext): void {
  const { codeHost, feedbackIgnores, now, store } = ctx;
  clearOverStaleBlocks(ctx);
  const finished = store.get().entries.filter((entry) => entry.phase === "finished" && openPulls(entry).length > 0);
  if (finished.length === 0) return;
  ctx.ownLogin.value ??= codeHost.readOwnLogin();
  const self = ctx.ownLogin.value;
  if (self === null) return log("the GitHub account the workers use could not be read, so no pull request's feedback was read");
  // Every finished run's pull requests are read before any is answered: a red check that another run's pull request fails too is not this run's (A11-179), and that is known only once they are all read.
  const reads = finished.map((entry) => ({ entry, reads: openPulls(entry).map((pr) => ({ url: pr.url, read: codeHost.readPullFeedback(pr.url, self, feedbackIgnores) })) }));
  const foreign = foreignRedsOf(ctx, reads.map(({ entry, reads: pulls }) => ({ entry, open: pulls.filter((pull): pull is { url: string; read: PullFeedback } => pull.read?.state === "open") })));
  let queued = false;
  const recorded: string[] = [];
  for (const { entry, reads: pulls } of reads) {
    const unread = pulls.filter(({ read }) => read === null).map(({ url }) => url);
    if (unread.length > 0) {
      log(`${entry.ticket.key}: the feedback on ${unread.join(", ")} could not be read, so it was not checked; the next watch asks again`);
      continue;
    }
    const readable = pulls.filter((pull): pull is { url: string; read: PullFeedback } => pull.read !== null);
    const open = readable.filter(({ read }) => read.state === "open");
    const partial = open.filter(({ read }) => !read.filesComplete).map(({ url }) => url);
    if (partial.length > 0) log(`${entry.ticket.key}: ${partial.join(", ")} changes more than the 100 files read, so the files past those read are unknown and hold nothing`);
    const files = pullFilesOf(open);
    // Written only when a file changed, so a watch that finds the same files does not rewrite the queue.
    if (JSON.stringify(files) !== JSON.stringify(entry.pullFiles ?? {})) update(ctx, (queue) => recordPullFiles(queue, entry.ticket.key, files));
    recordHeads(ctx, entry, readable);
    recorded.push(entry.ticket.key);
    clearResolvedConflict(ctx, entry, open);
    if (!resumesOnConflict(entry)) continue;
    const checks = answerChecks(ctx, entry, open, foreign);
    const removals = answerQueue(ctx, entry, open);
    if (isWatched(entry)) {
      // A reviewer's verdict is read by `reviewerLines`, which asks for a round only on requested changes; its reviews are not feedback here.
      const lines = [feedbackSince(readable, entry.finishedAt ?? 0), checks.feedback, removals.feedback, removals.conflict, ...reviewerLines(ctx, entry, openPulls(entry).map((pr) => pr.url))]
        .filter((line): line is string => line !== null);
      if (lines.length === 0) recordWithoutRound(ctx, entry, checks, removals);
      else {
        recordQueueAnswer(ctx, entry, removals.heads);
        update(ctx, (queue) => feedbackRound(queue, entry.ticket.key, lines.join("\n"), now(), checks.heads));
        queued = true;
      }
      continue;
    }
    if (resumeUnwatched(ctx, entry, readable, checks, removals)) queued = true;
  }
  // After every run's round was decided: a run that was handed a round has left `finished`, and a note does not change what the loop above decided for the run.
  for (const key of recorded) {
    flagStaleBlock(ctx, key);
    flagReviewerDialog(ctx, key);
  }
  if (queued) void tick(ctx);
}

/** Record what the board did about a run's merge queue removals (`heads`, {@link QueueAnswer.heads}) before the round that answers them is queued. Written only when it changed. */
function recordQueueAnswer(ctx: PoolContext, entry: Entry, heads: QueueAnswer["heads"]): void {
  if (JSON.stringify(heads) !== JSON.stringify(entry.queueHeads ?? {})) update(ctx, (queue) => recordQueueHeads(queue, entry.ticket.key, heads));
}

/**
 * Record the reruns and the names the pass over a run's red checks made when it queued no round ({@link CheckAnswer.withoutRound}), and the removals from the merge queue it named or held ({@link QueueAnswer.withoutRound}). Written only when
 * they changed.
 */
function recordWithoutRound(ctx: PoolContext, entry: Entry, checks: CheckAnswer, removals: QueueAnswer): void {
  if (JSON.stringify(checks.withoutRound) !== JSON.stringify(entry.checkHeads ?? {})) update(ctx, (queue) => recordCheckHeads(queue, entry.ticket.key, checks.withoutRound));
  recordQueueAnswer(ctx, entry, removals.withoutRound);
}

/**
 * Record the head each pull request the watch read is at, and whether it is approved there (`pullHeads`, A11-153) with what the read said of its readiness to merge (A11-179): written only when it
 * changes, as the files are. A pull request that merged or closed since the board last asked the tracker keeps its record, so the run does not read "not read yet" for the minutes before the tracker says so.
 * A pull request the run has no outcome head for takes this head as its outcome head: the end of the run could not read it, or the run was stored before heads were recorded, and the first watch is the nearest
 * read to the end.
 */
function recordHeads(ctx: PoolContext, entry: Entry, readable: readonly { url: string; read: PullFeedback }[]): void {
  const key = entry.ticket.key;
  followUpdatesFromMain(ctx, entry, readable);
  const heads = stampedBlocks(pullHeadsOf(readable), entry.pullHeads, ctx.now());
  if (JSON.stringify(heads) !== JSON.stringify(entry.pullHeads ?? {})) update(ctx, (queue) => recordPullHeads(queue, key, heads, ctx.now()));
  const open = readable.filter(({ read }) => read.state === "open");
  const unrecorded = Object.fromEntries(Object.entries(headCommitsOf(open)).filter(([url]) => entry.outcomeHeads?.[url] === undefined));
  if (Object.keys(unrecorded).length > 0) update(ctx, (queue) => recordOutcomeHeads(queue, key, unrecorded));
}

/** Whether an open pull request is read at a head other than `head`. PURE. */
const movedFrom = (head: string, read: PullFeedback): boolean => read.state === "open" && read.head !== null && read.head !== head;

/**
 * The board brought a pull request up to date with main (A11-215, the `updated` check record), and the watch now reads it at the head that push made: the run's outcome head moves with it, as it does for agent-org's own merge of a blocker's
 * branch (A11-153), because that push is no person's answer to a run that ended `needs-human`. An outcome head at another commit was moved by someone else, and stays.
 */
function followUpdatesFromMain(ctx: PoolContext, entry: Entry, readable: readonly { url: string; read: PullFeedback }[]): void {
  for (const { url, read } of readable) {
    const updated = entry.checkHeads?.[url];
    if (updated?.step !== "updated" || !movedFrom(updated.head, read) || entry.outcomeHeads?.[url] !== updated.head) continue;
    const to = read.head!;
    update(ctx, (queue) => moveOutcomeHeads(queue, entry.ticket.key, updated.head, to));
  }
}

/**
 * Clear the stale-block note (A11-213) and the reviewer-dialog note (A11-221) of a finished run that has no pull request left open, or whose ticket the tracker settled: the watch below reads only runs with an open pull request, so a pull
 * request merged or closed since the note was set would leave it on the card. The status is already Completed or Cancelled; this keeps the card from quoting a block that is gone.
 */
function clearOverStaleBlocks(ctx: PoolContext): void {
  for (const entry of ctx.store.get().entries) {
    const over = entry.phase === "finished" && (openPulls(entry).length === 0 || SETTLED.has(entry.trackerState ?? ""));
    if (over && isStaleBlockNote(entry.handedBack)) update(ctx, (queue) => recordStaleBlock(queue, entry.ticket.key, null, ctx.now()));
    if (over && isReviewerDialogNote(entry.handedBack)) update(ctx, (queue) => recordReviewerDialog(queue, entry.ticket.key, null, ctx.now()));
  }
}

/**
 * Flag a finished run whose pull request has sat changes requested for more than the stale-block limit minutes with no new push and no run (A11-213): the note becomes its `handedBack`, so the board reads Needs you, and
 * it goes again once a push, an approval or a round ends the block. Written only when it changes, as the heads are. A run's heads are those the watch has just recorded.
 */
function flagStaleBlock(ctx: PoolContext, key: string): void {
  const { now, store } = ctx;
  const entry = store.get().entries.find((e) => e.ticket.key === key);
  if (entry === undefined) return;
  const next = recordStaleBlock(store.get(), key, staleBlockNote(entry, now()), now());
  if (next.entries.find((e) => e.ticket.key === key)?.handedBack !== entry.handedBack) update(ctx, () => next);
}

/**
 * Flag a finished run whose open pull request has a reviewer stopped on a dialog the board cannot answer (A11-221): the note becomes its `handedBack`, so the board reads Needs you and quotes the dialog's first line, and it goes
 * again at the first look that finds no dialog on any of the run's open pull requests, or when the pool has no reviewer. A pull request the pool has not read yet (a restart) leaves the note as it is. Written only when it changes.
 */
function flagReviewerDialog(ctx: PoolContext, key: string): void {
  const { pullReads, store } = ctx;
  const entry = store.get().entries.find((e) => e.ticket.key === key);
  if (entry === undefined) return;
  const note = reviewerDialogNote(entry, pullReads);
  // With no reviewer there is nothing to wait on and no look to come: the note goes. Otherwise a pull request not read yet keeps it.
  if (note === null && ctx.reviewer !== undefined && openPulls(entry).some(({ url }) => !pullReads.has(url))) return;
  const next = recordReviewerDialog(store.get(), key, note, ctx.now());
  if (next.entries.find((e) => e.ticket.key === key)?.handedBack !== entry.handedBack) update(ctx, () => next);
}

/**
 * Clear the conflict a stacked run records with its blocker's branch (A11-116, A11-150) once the branch no longer conflicts with its base: every open pull
 * request of the run in the stacked repository reads mergeable. A person's own merge, or a worker's round that has since ended, resolves it without agent-org's
 * merge ever being made, and the board would say "Resolving a conflict" for ever. A pull request GitHub is still computing (`UNKNOWN`) is not mergeable yet. The
 * record keeps the run branched from the head that conflicted, as a merge by a worker does (`afterConflictCleared`), so that head is not merged again.
 */
function clearResolvedConflict(ctx: PoolContext, entry: Entry, open: readonly { url: string; read: PullFeedback }[]): void {
  const record = entry.stackBase;
  if (record?.conflict === undefined) return;
  const stacked = openPulls(entry).filter((pr) => pr.repo === record.repo);
  const mergeable = stacked.length > 0 && stacked.every(({ url }) => open.find((pull) => pull.url === url)?.read.mergeable === true);
  if (mergeable) update(ctx, (queue) => recordStackBase(queue, entry.ticket.key, afterConflictCleared(stackBaseIn(queue, entry.ticket.key, record))));
}

/**
 * Resume a run the board does not watch, one `watchFeedback` found a conflict or red checks on (A11-89, A11-154): only those wake it. A conflict needs a round left, and queues
 * nothing at the cap; red checks at the cap hand the run to a person, whatever it ended on, and close nothing. Its workspace is closed first, because a second workspace would take
 * the same herdr name (`queue.ts` `retry`). Refused, the run stays parked and the next watch asks again. Returns whether a round was queued.
 */
function resumeUnwatched(ctx: PoolContext, entry: Entry, readable: readonly { url: string; read: PullFeedback }[], checks: CheckAnswer, removals: QueueAnswer): boolean {
  const { now } = ctx;
  const key = entry.ticket.key;
  const red = [checks.feedback, removals.feedback].filter((line): line is string => line !== null);
  const lines = [conflictLines(readable), removals.conflict, ...red].filter((line): line is string => line !== null);
  const feedback = lines.join("\n");
  if (lines.length === 0) {
    recordWithoutRound(ctx, entry, checks, removals);
    return false;
  }
  if (!roundsLeft(entry)) {
    if (red.length > 0) {
      recordQueueAnswer(ctx, entry, removals.heads);
      update(ctx, (queue) => checkRound(queue, key, feedback, now(), checks.heads));
    } else recordWithoutRound(ctx, entry, checks, removals);
    return false;
  }
  try {
    close(ctx, key);
  } catch (err) {
    log(`${key}: its workspace could not be closed, so the ${red.length === 0 ? "conflict" : "red checks"} round was not started (${err instanceof Error ? err.message : String(err)})`);
    recordWithoutRound(ctx, entry, checks, removals);
    return false;
  }
  recordQueueAnswer(ctx, entry, removals.heads);
  update(ctx, (queue) => checkRound(queue, key, feedback, now(), checks.heads));
  return true;
}

/**
 * Start the round that merges a stacked branch's conflicting base in, for a finished run the sweep found conflicting with its blocker's moved branch (A11-150).
 * A run the board watches takes it as {@link feedbackRound} does, so at the round cap the run is handed back with the conflict named. Any other run the board
 * resumes on a conflict takes it as {@link conflictRound} does, which queues nothing at the cap.
 */
export function startStackConflictRound(ctx: PoolContext, key: string, feedback: string): void {
  const { now } = ctx;
  const entry = ctx.store.get().entries.find((e) => e.ticket.key === key);
  if (entry === undefined) return;
  update(ctx, (queue) => (isWatched(entry) ? feedbackRound(queue, key, feedback, now()) : conflictRound(queue, key, feedback, now())));
}
