// @ts-check
// module: ending a run -- how it ended and what that does to its ticket, its plan, its proposed edit, and its ticket's state

import { clearMove, type Entry, type Outcome, type ProposedEdit, type Queue, type WorkingOutcome, type WrittenOutcome } from "./queue/queue-entries-and-outcomes.ts";
import { type PlannedAgainst, recordStampedPlan } from "./queue/queue-ticket-text.ts";
import { join } from "node:path";
import { forgetRun, isPlanning, log, messageOf, runMembers, runPlace, sameRun, update, updateEach } from "./pool-state.ts";
import { FINDINGS_RETRIED_FILE, ORDER_FILE, OUTCOME_FILE, PLAN_DIR, QUESTION_FILE } from "./worker-files.ts";
import { ATTACH_TRIES, ATTACH_WAITS_MS, isTransient, MS_PER_SECOND } from "./attach-retry.ts";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { findingsMiss, findingsRefusal, retriedUrls } from "./blocker-findings-check.ts";
import { accountRefusal, closedWorkOf, type KeptClosedWork } from "./closed-work-account.ts";
import { CLAIMS_GIVEN_FILE, CLAIMS_RETRIED_FILE, folderClaimMisses, folderClaimRefusal, folderClaimRetriedRefusal, type HeldClaim, parseClaimsGiven, planClaimPaths } from "./path-claims.ts";
import { type PlanStamp, stampedPlan, urlsNamedIn } from "./plan-stamp.ts";
import { descriptionHash, ticketReadOf, type TicketRead } from "./ticket-read.ts";
import { type Move, plannedMoves, withMoves } from "./after-merge-move.ts";
import { afterMergeChecksRefusal } from "./after-merge/plan-section.ts";
import { type FormatRefusal, formatRefusalOf, sendBack } from "./pool-plan-send-back.ts";
import { dateOf } from "./pool-answer.ts";
import { recordAnswer } from "./queue/queue-answer.ts";
import { blockersOfPlan, writePlanBlockers } from "./pool-plan-blockers.ts";
import { recordPlanBlockers } from "./queue/queue-plan-blockers.ts";
import { batchPlanDone, finish, noteWorking, park, planDone, recordPullFiles, recordPullStates, unpark } from "./queue/queue-transitions.ts";
import { doneComment, outcomeWritten, PLAN_FILE_BYTES, QUESTION_CHARS } from "./pool-outcome.ts";
import { writtenStep } from "./outcome.ts";
import { escalationItem, escalationReason, questionEscalation, questionText } from "./escalation.ts";
import { isRetryableWrite, WRITE_GIVE_UP_MS, WRITE_RETRY_NOTE, writeWait } from "./result-write-retry.ts";
import { logEvent, shortReason, type TrackerWriteStep } from "./queue/run-log.ts";
import { recordCurrentStep } from "./queue/queue-run-detail.ts";
import { recordOutcomeBlocks, recordOutcomeHeads } from "./queue/queue-pull-heads.ts";
import { clearPartial } from "./queue/queue-next-step.ts";
import { type Ticket } from "./source.ts";
import { ticketDir } from "./ticket-paths.ts";
import { missingBehaviour } from "./open-decisions.ts";
import { ticketDecisionsDefect } from "./plan-ticket-decisions.ts";
import { closedNote } from "../herdr-agents.ts";
import { mergeWaits, type Order, parseOrder, unknownRepos } from "./batch-order.ts";
import { CONCLUDED, HANDED_BACK, RESULT_KINDS, pullsOf, type PullHead } from "./board-view/view-types-and-filters.ts";
import { countTokens, findTranscript } from "./pool-transcripts.ts";
import { isParked } from "./board-view/pull-status-and-notes.ts";
import { settledByPulls } from "./board-view/pull-settled.ts";
import { stepNamed } from "./board-view/plan-steps.ts";
import { herdrRefusal } from "./pool-herdr.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { type PoolContext } from "./pool-context.ts";
import { recordPlannerDecision, recordWorkerRoundEnded, settlePlannerRound } from "./pool-standoff.ts";
import { planFiles as downloadPlanFiles } from "./pool-ticket-text.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import type { PullState } from "./source.ts";

/**
 * Record the plan step a live run's worker wrote as `currentStep` in its outcome file (A11-219), as written, without settling anything: it is read while the agent works and again when its outcome is settled. A file
 * the run was marked stale on is an earlier run's and says nothing of this one. Reading the same file again changes nothing.
 */
export function recordWrittenStep(ctx: PoolContext, entry: Entry): void {
  const { dir } = runPlace(ctx, entry);
  const path = join(dir, OUTCOME_FILE);
  try {
    if (!outcomeWritten(dir)) return;
    const step = writtenStep(readFileSync(path, "utf8"));
    if (step !== null) update(ctx, (queue) => recordCurrentStep(queue, entry.ticket.key, step));
  } catch {
    // A file that cannot be read says no step; the watch reads it for the run's end as it always did, and must not stop the pass for a step.
  }
}

/**
 * A run's agent wrote `working`: its reason, and the job or declared events and time it waits on, become the run's latest note, for every ticket in the run, and the run carries on. The file's own
 * time says whether it is newer than the note recorded, so reading the same file on every tick changes nothing.
 */
function noteStillWorking(ctx: PoolContext, entry: Entry, { reason, waitingOn, waits, until }: WorkingOutcome): void {
  const { attachRetries, now, writeRetries } = ctx;
  // The agent is working again, so a plan attach or a result write waiting to be tried again belongs to an outcome it has replaced: its next outcome is written afresh, and the stall watch reads the run as it does any other.
  attachRetries.delete(runPlace(ctx, entry).name);
  writeRetries.delete(runPlace(ctx, entry).name);
  const path = join(runPlace(ctx, entry).dir, OUTCOME_FILE);
  const at = existsSync(path) ? statSync(path).mtimeMs : now();
  updateEach(ctx, runMembers(ctx, entry), (queue, member) => noteWorking(queue, member, reason, at, now(), { waitingOn, waits, until }));
}

/**
 * A run wrote its outcome: `working` is recorded as its note and the run carries on, a planning run's plan is attached, a `done` completes its ticket,
 * a proposed edit is recorded with the ticket's text, and any other outcome ends the run.
 */
export function settle(ctx: PoolContext, entry: Entry, outcome: WrittenOutcome): void {
  recordWrittenStep(ctx, entry);
  if (outcome.kind === "working") return noteStillWorking(ctx, entry, outcome);
  if (outcome.kind === "reviewed") {
    if (entry.review === undefined) return end(ctx, entry, { kind: "needs-human", reason: "the worker wrote a reviewed outcome, but its run was not a review run" });
    // The planner's round for a stand-off decides it, and attaches an amended plan, before it ends (A11-290); the worker's ends the stand-off's second route.
    if (entry.standoff?.stage === "planner") return void settleStandoffPlanner(ctx, entry).catch(settleFailed(entry));
    end(ctx, entry, { kind: "reviewed", prs: entry.review });
    if (entry.standoff?.stage === "worker") recordWorkerRoundEnded(ctx, entry.ticket.key);
    return;
  }
  // An edit is recorded with the ticket's text before the run ends, so a proposal without that text is read first; with it, the run settles.
  if ("edit" in outcome && outcome.edit !== undefined && outcome.edit.base === undefined) return void proposeEdit(ctx, entry, outcome, outcome.edit).catch(settleFailed(entry));
  if (outcome.kind === "done") return void completeDone(ctx, entry, outcome).catch(settleFailed(entry));
  if (outcome.kind !== "planned") return end(ctx, entry, outcome);
  if (!isPlanning(ctx, entry)) return end(ctx, entry, { kind: "needs-human", reason: "the worker wrote a planned outcome, but its run was not a planning run" });
  // Nothing waits on the attach, so its own failure is caught here rather than left to stop the board.
  const attach = entry.batch === undefined ? attachPlan(ctx, entry) : attachBatch(ctx, entry);
  attach.catch((err) => log(`${entry.batch ?? entry.ticket.key}'s plan: ${messageOf(err)}`));
}

/**
 * The planner's round for a stand-off ended `reviewed` (A11-290): its decision is read, an amended plan is attached to the ticket first, and then the round ends as any review round does, and the decision is recorded on the run. A decision that cannot
 * be taken (none written, or an amended plan the board refuses or cannot attach) ends the round for a person with the reason.
 */
async function settleStandoffPlanner(ctx: PoolContext, entry: Entry): Promise<void> {
  const { attaching } = ctx;
  const { name } = runPlace(ctx, entry);
  if (attaching.has(name)) return;
  attaching.add(name);
  try {
    const settled = await settlePlannerRound(ctx, entry, () => attachAmendedPlan(ctx, entry));
    if (!sameRun(ctx, entry)) return;
    if ("refused" in settled) return end(ctx, entry, { kind: "needs-human", reason: `the planner's round for a stand-off: ${settled.refused}` });
    end(ctx, entry, { kind: "reviewed", prs: entry.review ?? [] });
    recordPlannerDecision(ctx, entry.ticket.key, settled.decided);
  } finally {
    attaching.delete(name);
  }
}

/**
 * Attach the amended plan a stand-off's planner wrote in its plan folder (A11-290), through the checks and the stamp a planning run's plan gets, and read the plan back so the reviewer's next brief holds the amended decisions. Null once it is attached, else
 * the words that refuse it.
 */
async function attachAmendedPlan(ctx: PoolContext, entry: Entry): Promise<string | null> {
  const key = entry.ticket.key;
  const planDir = join(ticketDir(ctx.settings, key), PLAN_DIR);
  try {
    const refused = await attachFiles(ctx, key, planDir);
    if (refused !== null) return "reason" in refused ? refused.reason : "the amended plan was refused";
  } catch (err) {
    return `the amended plan could not be attached (${messageOf(err)})`;
  }
  await readPlanBack(ctx, entry, planDir);
  return null;
}

/** The plan as the tracker holds it, downloaded again into the folder the reviewer's brief reads it from. A download that fails leaves the planner's own files there instead, which are what was attached. */
async function readPlanBack(ctx: PoolContext, entry: Entry, planDir: string): Promise<void> {
  const key = entry.ticket.key;
  try {
    const fresh = await ctx.source.read(key);
    await downloadPlanFiles(ctx, fresh ?? entry.ticket);
  } catch (err) {
    log(`${key}: the amended plan could not be downloaded again (${messageOf(err)}); the reviewer reads the files the planner wrote`);
    const pathsDir = join(ticketDir(ctx.settings, key), "paths");
    mkdirSync(pathsDir, { recursive: true });
    for (const name of readdirSync(planDir)) copyFileSync(join(planDir, name), join(pathsDir, name));
  }
}

/**
 * The board's completion of a worker's `done` (A11-91): the ticket moves to its team's completed state and the reason and evidence are posted on it,
 * through the tracker's own `complete`. The ticket's record of its move is cleared once it is complete, so nothing puts it back. A refusal, by the
 * board's rules or by the tracker, ends the run for a person, and the ticket is left where it is. A write that fails on the network or on the tracker's side is tried again on later ticks, and the
 * run's outcome stays as the worker wrote it ({@link resultWriteFailed}, A11-304). A review round's `done` is judged by its pull requests first (A11-173).
 */
async function completeDone(ctx: PoolContext, entry: Entry, outcome: Extract<Outcome, { kind: "done" }>): Promise<void> {
  const { attaching, source } = ctx;
  const key = entry.ticket.key;
  const { name } = runPlace(ctx, entry);
  const refusal = doneRefusal(ctx, entry);
  if (refusal !== null) return end(ctx, entry, { kind: "needs-human", reason: `${refusal}: ${outcome.reason}` });
  if (attaching.has(name) || waitingToRetryWrite(ctx, name)) return;
  attaching.add(name);
  try {
    const mergedStates = entry.review === undefined ? {} : await settleReviewDone(ctx, entry, outcome);
    if (mergedStates === null) return;
    if (source.complete === undefined) return end(ctx, entry, { kind: "needs-human", reason: `this tracker cannot complete ${key}: ${outcome.reason}` });
    const note = await completeOrComment(ctx, entry, outcome);
    // Stopped, or stopped and started again, while the tracker was asked: the person's last word stands, and a newer run is not touched.
    if (!sameRun(ctx, entry)) return;
    if (note !== null) return end(ctx, entry, handedBackForWrite(`${key} was not completed (${note.trim()}): ${outcome.reason}`));
    update(ctx, (queue) => clearMove(queue, key));
    end(ctx, entry, outcome);
    // Recorded once the run is finished, which is when the card reads them: it says what completed the ticket without waiting for the next refresh.
    if (Object.keys(mergedStates).length > 0) update(ctx, (queue) => recordPullStates(queue, new Map([[key, mergedStates]]), ctx.now()));
  } catch (err) {
    resultWriteFailed(ctx, entry, { err, reasonFor: (error) => `${key} could not be completed (${error}): ${outcome.reason}`, handBack: handedBackForWrite });
  } finally {
    attaching.delete(name);
  }
}

/**
 * The tracker's completion of the ticket with the worker's reason and evidence. After a try that failed, the ticket may already have moved (the tracker moves it first and then comments, and a response may be lost after either), and `complete`
 * leaves a finished ticket and its comment alone: so the evidence is posted as a comment here, and never lost. Null once the ticket is completed, else the tracker's note (A11-304).
 */
async function completeOrComment(ctx: PoolContext, entry: Entry, outcome: Extract<Outcome, { kind: "done" }>): Promise<string | null> {
  const { source, writeRetries } = ctx;
  const key = entry.ticket.key;
  const comment = doneComment(outcome);
  const retrying = writeRetries.has(runPlace(ctx, entry).name);
  if (retrying && source.comment !== undefined && (await source.read(key))?.statusType === "completed") {
    await source.comment(key, comment);
    return null;
  }
  return source.complete!(key, comment);
}

/** Whether the result write of the run `name` is waiting out the backoff after a failure worth trying again (A11-304): no call to the tracker is made before the time it names. */
const waitingToRetryWrite = (ctx: PoolContext, name: string): boolean => (ctx.writeRetries.get(name)?.nextAt ?? 0) > ctx.now();

/** The outcome that hands a run to a person because the tracker cannot take its result: under the escalation list's access item, with the tracker's own words in `reason`. PURE. */
const handedBackForWrite = (reason: string): Outcome => ({ kind: "needs-human", reason: escalationReason("access", reason), escalation: "access" });

/**
 * The outcome that hands a run whose proposed edit could not be recorded to a person: a worker's own stop keeps the item it named (its reason already starts with that item's label), and any other outcome is the tracker's, under the access item. PURE.
 */
function handBackOfEdit(outcome: Extract<Outcome, { kind: "checked" | "done" | "needs-human" }>): (reason: string) => Outcome {
  if (outcome.kind !== "needs-human") return handedBackForWrite;
  return (reason) => ({ kind: "needs-human", reason, ...(outcome.escalation === undefined ? {} : { escalation: outcome.escalation }) });
}

/**
 * A write of a run's result to the tracker that failed: the error it threw, how the run's end words it (`reasonFor` puts the error's message in the sentence a person reads), and the outcome that hands the run to a person
 * when the write cannot succeed (`handBack` takes that sentence).
 */
type ResultWriteFailure = Readonly<{ err: unknown; reasonFor: (error: string) => string; handBack: (reason: string) => Outcome }>;

/**
 * A write of the result of the run `entry` (the completion of its ticket, the recording of its proposed edit) threw `err`. The run's outcome is the worker's and is not rewritten for a tracker that is down: a failure on the network, a 5xx or a 429
 * ({@link isRetryableWrite}) is logged as an event of its own, the card says {@link WRITE_RETRY_NOTE}, the run stays running, and the board tries again on later ticks, after a wait that grows ({@link writeWait}). Only a request the tracker refuses
 * (anything else it answers or throws), or a write that kept failing for {@link WRITE_GIVE_UP_MS}, ends the run for a person, under the access item, with the tracker's words. A run stopped meanwhile is left as it is.
 */
function resultWriteFailed(ctx: PoolContext, entry: Entry, { err, reasonFor, handBack }: ResultWriteFailure): void {
  if (!sameRun(ctx, entry)) return;
  const { now, writeRetries } = ctx;
  const { name } = runPlace(ctx, entry);
  const at = now();
  const failures = (writeRetries.get(name)?.failures ?? 0) + 1;
  const firstAt = writeRetries.get(name)?.firstAt ?? at;
  const logged = (step: TrackerWriteStep) => update(ctx, (queue) => logEvent(queue, entry.ticket.key, at, { kind: "tracker-write", step, failures, error: shortReason(messageOf(err)) ?? "no message" }));
  if (!isRetryableWrite(err)) {
    logged("refused");
    return end(ctx, entry, handBack(reasonFor(messageOf(err))));
  }
  if (at - firstAt >= WRITE_GIVE_UP_MS) {
    logged("gave-up");
    return end(ctx, entry, handBack(reasonFor(`${messageOf(err)}; it has failed since ${new Date(firstAt).toISOString()}, more than an hour`)));
  }
  logged("retrying");
  writeRetries.set(name, { failures, firstAt, nextAt: at + writeWait(failures) });
  updateEach(ctx, runMembers(ctx, entry), (queue, member) => noteWorking(queue, member, WRITE_RETRY_NOTE, at, at));
  log(`${entry.ticket.key}'s result could not be recorded in the tracker (${messageOf(err)}): trying again in ${writeWait(failures) / MS_PER_SECOND} seconds, failure ${failures}`);
}

/** What a review round's `done` does with its ticket, judged by the round's pull requests (A11-173): complete it now, leave it to the merge of an open pull request, or ask a person. PURE. */
function reviewDoneVerdict(entry: Entry, states: Readonly<Record<string, PullState>>): "complete" | "wait" | "ask" {
  const settled = settledByPulls({ ...entry, pullStates: states });
  if (settled === "completed") return "complete";
  return settled === "cancelled" ? "ask" : "wait";
}

/**
 * Settle a review round's `done` by its pull requests as the tracker reads them (A11-173). With every one merged or closed and one merged, the ticket is completed now: the pull requests'
 * states are returned, to be recorded once the run ends. With one still open the round ends as its ordinary `reviewed` result and the ticket completes when they merge, and the run's
 * declaration goes, since the worker has said nothing remains to build. With all closed unmerged nothing was built, and a person is asked. Returns null, the run ended, when it does not
 * complete, and also when the run was stopped meanwhile.
 */
async function settleReviewDone(ctx: PoolContext, entry: Entry, outcome: Extract<Outcome, { kind: "done" }>): Promise<Readonly<Record<string, PullState>> | null> {
  const key = entry.ticket.key;
  const states = (await ctx.source.pullStates?.([key]))?.get(key) ?? {};
  if (!sameRun(ctx, entry)) return null;
  const verdict = reviewDoneVerdict(entry, states);
  if (verdict === "complete") return states;
  if (verdict === "ask") end(ctx, entry, { kind: "needs-human", reason: `the worker wrote done in a review round, but its pull requests were closed without merging: ${outcome.reason}` });
  else {
    end(ctx, entry, { kind: "reviewed", prs: entry.review ?? [] });
    update(ctx, (queue) => clearPartial(queue, key));
  }
  return null;
}

/**
 * Record a worker's proposed edit to its ticket's text with the text the tracker holds now, which Apply checks the ticket still holds (A11-91), then
 * record the outcome it came with. The ticket is not changed. A planning or review run proposes none, and one whose ticket cannot be read is handed
 * to a person.
 */
async function proposeEdit(ctx: PoolContext, entry: Entry, outcome: Extract<Outcome, { kind: "checked" | "done" | "needs-human" }>, edit: ProposedEdit): Promise<void> {
  const { attaching, source } = ctx;
  const key = entry.ticket.key;
  const { name } = runPlace(ctx, entry);
  if (isPlanning(ctx, entry) || entry.review !== undefined) {
    return end(ctx, entry, { kind: "needs-human", reason: `${outcome.reason} (the worker proposed an edit to ${key}'s text from a ${isPlanning(ctx, entry) ? "planning" : "review"} run, which the board does not take)` });
  }
  if (attaching.has(name) || waitingToRetryWrite(ctx, name)) return;
  attaching.add(name);
  let base: Ticket | null = null;
  let failure: { err: unknown } | null = null;
  try {
    base = await source.read(key);
  } catch (err) {
    failure = { err };
  } finally {
    attaching.delete(name);
  }
  if (!sameRun(ctx, entry)) return;
  const unrecorded = (error: string) => `${outcome.reason} (the worker's proposed edit to ${key}'s text could not be recorded: ${error})`;
  if (base === null && failure !== null) return resultWriteFailed(ctx, entry, { err: failure.err, reasonFor: unrecorded, handBack: handBackOfEdit(outcome) });
  if (base === null) return end(ctx, entry, { kind: "needs-human", reason: unrecorded(`Linear has no ticket ${key}`) });
  // The guard is released above, and nothing awaits between here and settle's own checks: the completion or end it starts takes `attaching` itself,
  // before its first await, so a tick that sees this outcome again meanwhile finds the run already held.
  settle(ctx, entry, { ...outcome, edit: { ...edit, base: { title: base.title, description: base.description } } });
}

/** Why the board does not complete a ticket on its worker's `done`, or null when it may (A11-91): not a planning run, not a review round of a plan step with steps after it (A11-173), and no open sub-issues. A review round's `done` is judged by its pull requests ({@link settleReviewDone}). */
function doneRefusal(ctx: PoolContext, entry: Entry): string | null {
  if (isPlanning(ctx, entry)) return `the worker wrote done in a planning run, which completes no ticket`;
  const unfinished = entry.review !== undefined && entry.partial !== undefined ? stepNamed(entry.partial) : null;
  if (unfinished !== null && unfinished.step < unfinished.of) return `the worker wrote done in a review round of step ${unfinished.step} of ${unfinished.of}, which leaves the steps after it to do`;
  const children = entry.ticket.children ?? [];
  return children.length === 0 ? null : `${entry.ticket.key} has open sub-issues (${children.join(", ")}), which complete it, not its own done`;
}

/** The handler for a settle step that failed outside its own checks: said on the board's log, and the next pass finds the run as it was. */
const settleFailed = (entry: Entry) => (err: unknown): void => log(`${entry.batch ?? entry.ticket.key}: ${messageOf(err)}`);

/**
 * What a plan is checked against besides its files being plain markdown: the pull requests its brief listed and the addresses the stop hook's one automatic retry named for them (A11-207), and the paths other
 * tickets held when the brief was written and whether the retry for a folder claim was made (A11-212), and the description the planner read, which the plan is held to follow the Decisions of (A11-250).
 */
type PlanChecks = Readonly<{ given?: readonly string[]; retried?: readonly string[]; claims?: readonly HeldClaim[]; claimsProblem?: string; claimsRetried?: boolean; description?: string; screen?: Pick<Ticket, "description" | "labels">; closed?: readonly KeptClosedWork[] }>;

/**
 * The files a planning run left in `planDir` to attach, and the Before-merge lines the plan moves to After merge (A11-275), or why they cannot be. Only plain markdown files are taken: a planning run is
 * unattended, so a link in its folder could point the board at a secret it would then upload. A plan that claims a folder another queued or running ticket writes into is refused, naming the narrower paths (A11-212),
 * and so is a move the board cannot write: a line the ticket does not hold under `### Before merge`, a reason that is not one of the three, or a missing or over-long `who`. So is a plan that leaves an After-merge line
 * naming nobody out of its `## After-merge checks` section, or names a runner there the board cannot record (A11-277). That last refusal carries `afterMerge`: it is sent back to the planner (A11-288), not ended on.
 */
function planFiles(planDir: string, { given = [], retried = [], claims = [], claimsProblem, claimsRetried = false, description, screen, closed = [] }: PlanChecks = {}): { files: string[]; moves: Move[] } | { refusal: string; afterMerge?: Readonly<{ moves: readonly Move[] }> } {
  const names = existsSync(planDir) ? readdirSync(planDir).sort() : [];
  if (names.length === 0) return { refusal: `the planning run wrote no plan in ${planDir}` };
  const odd = names.find((name) => {
    const info = lstatSync(join(planDir, name));
    return !info.isFile() || !name.endsWith(".md") || info.size > PLAN_FILE_BYTES;
  });
  if (odd !== undefined) return { refusal: `the plan folder ${planDir} holds ${odd}, which is not a markdown file of 1 MB or less, so nothing was attached` };
  const texts = names.map((name) => readFileSync(join(planDir, name), "utf8"));
  // A screen's behaviour is settled by the planner, in the plan, when the ticket's own Grill did not (A11-257): a plan that does not say so is not attached.
  const behaviour = screen === undefined ? null : missingBehaviour(texts, screen);
  if (behaviour !== null) return { refusal: behaviour };
  const miss = findingsMiss(texts, given);
  if (miss !== null) return { refusal: findingsRefusal(miss, given, retried) };
  // The work a closed pull request of this ticket held is carried over or dropped, item by item, in the plan (A11-249).
  const account = accountRefusal(texts, closed);
  if (account !== null) return { refusal: account };
  // A decision a person made overrides the plan: a plan that says it conflicts with one, or that does not say whether it follows them, is not attached (A11-250).
  const defect = description === undefined ? null : ticketDecisionsDefect(texts, description);
  if (defect !== null) return { refusal: `the plan does not follow the ticket's Decisions: ${defect}` };
  // With no text of the ticket to check them against (a batch member no longer on the board), no line is moved: the reviewer's rule still keeps such a line from blocking.
  const planned = description ?? screen?.description;
  const moved = planned === undefined ? { moves: [] } : plannedMoves(texts, planned);
  if ("refusal" in moved) return moved;
  // Each After-merge line that names nobody to run it is given a runner by the plan, and every runner the plan names is one the board can send a check to (A11-277).
  const checks = planned === undefined ? null : afterMergeChecksRefusal(texts, planned, moved.moves);
  // That refusal alone goes back to the planner (A11-288): the rest of them end the run, as they did.
  if (checks !== null) return { refusal: checks, afterMerge: { moves: moved.moves } };
  // A claims file that is there and cannot be read is no list of nothing: the plan is not attached unchecked.
  if (claimsProblem !== undefined) return { refusal: claimsProblem };
  const folders = folderClaimMisses(texts.flatMap(planClaimPaths), claims);
  if (folders.length > 0) return { refusal: claimsRetried ? folderClaimRetriedRefusal(folders) : folderClaimRefusal(folders) };
  return { files: names.map((name) => join(planDir, name)), moves: moved.moves };
}

/** What a plan moves to After merge: ticket `key`, the moves its plan names, and the text the planner read (`briefed`), when the run recorded one. */
type Moving = Readonly<{ key: string; moves: readonly Move[]; briefed: TicketRead | undefined }>;

/**
 * Write the Before-merge lines a plan moves to After merge into ticket `key` (A11-275), read fresh, before the plan is stamped and attached, so a worker is never briefed with a line no branch can meet. Returns the read the plan
 * is stamped with: the rewritten text when the ticket held what the planner read (`briefed`), so the plan is not read as stale for the board's own write (A11-167), and else `briefed` as it was, so a person's edit meanwhile
 * still marks it stale. The Decisions entry is dated by the planner's read, so a retried attach rewrites the ticket to the same text and writes nothing twice. A tracker that cannot edit a ticket's text, a ticket it no longer has
 * and a write it refuses leave the ticket as it is, logged, and the plan is attached all the same: the reviewer's rule still keeps such a line from blocking. A network or server failure is thrown on, for the attach to be tried again.
 */
async function writeMoves(ctx: PoolContext, { key, moves, briefed }: Moving): Promise<TicketRead | undefined> {
  const { now, source } = ctx;
  if (moves.length === 0) return briefed;
  const unwritten = (why: string): TicketRead | undefined => {
    log(`${key}: ${why}, so the lines its plan moves to After merge stay under Before merge in the ticket`);
    return briefed;
  };
  if (source.updateTicketText === undefined) return unwritten("this tracker cannot edit a ticket's text");
  const date = dateOf(briefed?.readAt ?? now());
  let fresh: Ticket | null;
  let rewritten: string;
  try {
    fresh = await source.read(key);
    if (fresh === null) return unwritten(`the tracker has no ticket ${key}`);
    rewritten = withMoves(fresh.description, moves, date);
    if (rewritten !== fresh.description) await source.updateTicketText(key, { description: rewritten });
  } catch (err) {
    if (isTransient(err)) throw err;
    return unwritten(`the tracker refused to read or write the ticket (${messageOf(err)})`);
  }
  const planned = briefed === undefined ? null : withMoves(briefed.description, moves, date);
  return planned !== null && descriptionHash(planned) === descriptionHash(rewritten) ? ticketReadOf({ description: rewritten, updatedAt: fresh.updatedAt }, now()) : briefed;
}

/**
 * The run's copy of ticket `key` moved on to `stamped`, the text its plan was stamped with, when that is the board's own rewrite and not the text the run was briefed with (`briefed`). What the run was briefed
 * against stays the planner's read: a batch's attach tried again checks each plan against the text its planner read, and the board's own Decisions entry must not make it ask for a `## Ticket decisions` section. PURE.
 */
const movedOn = (queue: Queue, { key, briefed }: Pick<Moving, "key" | "briefed">, stamped: TicketRead | undefined): Queue =>
  (stamped === undefined || stamped === briefed ? queue : recordAnswer(queue, key, stamped));

/**
 * The addresses the stop hook's one automatic retry named for the ticket `key` (A11-207), from the mark it left beside the run's outcome file in `runDir`. None when it made no retry, or the mark cannot be read:
 * the refusal is then the plain one.
 */
function retriedFor(runDir: string, key: string): readonly string[] {
  const path = join(runDir, FINDINGS_RETRIED_FILE);
  try {
    return existsSync(path) ? retriedUrls(readFileSync(path, "utf8"))[key] ?? [] : [];
  } catch {
    return [];
  }
}

/**
 * The paths other tickets held when the run's brief was written (A11-212), from the list beside its outcome file in `runDir`. None when the file is missing: a run briefed before it, or one that was not a planning
 * run, is not checked. A file that is there but cannot be read, or is not a list, is a problem the plan is refused for, since the board wrote it and the folder claims cannot be checked without it.
 */
function claimsFor(runDir: string): Pick<PlanChecks, "claims" | "claimsProblem"> {
  const path = join(runDir, CLAIMS_GIVEN_FILE);
  if (!existsSync(path)) return {};
  try {
    const claims = parseClaimsGiven(readFileSync(path, "utf8"));
    return claims === null ? { claimsProblem: `the list of paths other tickets held (${path}) is not a list, so the plan's folder claims cannot be checked` } : { claims };
  } catch (err) {
    return { claimsProblem: `the list of paths other tickets held (${path}) cannot be read (${messageOf(err)}), so the plan's folder claims cannot be checked` };
  }
}

/** What the plan of the ticket `key`, written by the run whose files are in `runDir`, is checked against; `given` are the pull requests its entry was briefed with. */
const checksFor = (runDir: string, key: string, given: readonly string[] | undefined, read: TicketRead | undefined, ticket: Ticket, closed: readonly KeptClosedWork[]): PlanChecks =>
  ({ closed, ...(given === undefined ? {} : { given }), retried: retriedFor(runDir, key), ...claimsFor(runDir), claimsRetried: existsSync(join(runDir, CLAIMS_RETRIED_FILE)), ...(read === undefined ? {} : { description: read.description }),
    screen: { description: read?.description ?? ticket.description, labels: ticket.labels } });

/** The entry of the ticket `key`, as the queue has it now: the planning run's own, which holds the text it was briefed with. */
const entryOf = (ctx: PoolContext, key: string): Entry | undefined => ctx.store.get().entries.find((e) => e.ticket.key === key);

/**
 * Stamp the plan a planning run wrote with the text of the ticket it was briefed with (A11-167, ADR 0005): the file that matches the host file's `tickets.plan` gets a `## Planned against` section before its
 * `## Paths`. The board writes it, so the hash is the planning run's own read and not an agent's copy. Returns the stamp, for the run to keep. A run with no recorded read (one started before this) or a
 * machine with no plan pattern stamps nothing, and such a plan is never read as stale.
 */
function stampPlan(ctx: PoolContext, files: readonly string[], read: TicketRead | undefined): PlannedAgainst | null {
  const { settings } = ctx;
  if (settings.plan === null || read === undefined) return null;
  const pattern = new RegExp(settings.plan);
  const plan = files.find((file) => pattern.test(basename(file)));
  if (plan === undefined) return null;
  const stamp: PlanStamp = { updatedAt: read.updatedAt, hash: read.hash, files: files.map((file) => basename(file)), description: read.description };
  const text = stampedPlan(readFileSync(plan, "utf8"), stamp);
  // A plan the stamp would push past the size every reader skips beyond stays as it is, unstamped: it is never read as stale, rather than unreadable for its paths.
  if (Buffer.byteLength(text) > PLAN_FILE_BYTES) return null;
  writeFileSync(plan, text);
  return { ...stamp, named: urlsNamedIn(text) };
}

/** Whether the plan attach of the run `name` is waiting out the backoff after a failure worth trying again (A11-216): no call to the tracker is made before the time it names. */
const waitingToRetry = (ctx: PoolContext, name: string): boolean => (ctx.attachRetries.get(name)?.nextAt ?? 0) > ctx.now();

/** A plan attach that failed: the error it threw, how the failure is worded for a person, and where the run's files are. */
type AttachFailure = Readonly<{ err: unknown; failed: string; files: string }>;

/**
 * A plan attach of the run `entry` is in threw `err`. A refusal (a 4xx, a validation error, anything {@link isTransient} does not call a network or server failure) ends the run for a person at once, naming it.
 * A network or 5xx failure is tried again by the board, from the files still on disk and without waking the planner: the wait before the next try (A11-216) and the retry number are put on the
 * card of every ticket in the run, and the run stays running. The {@link ATTACH_TRIES}th failure ends the run for a person. A run stopped meanwhile is left as it is.
 */
function attachFailed(ctx: PoolContext, entry: Entry, { err, failed, files }: AttachFailure): void {
  if (!sameRun(ctx, entry)) return;
  const { attachRetries, now } = ctx;
  const { name } = runPlace(ctx, entry);
  const failures = (attachRetries.get(name)?.failures ?? 0) + 1;
  if (!isTransient(err)) return end(ctx, entry, { kind: "needs-human", reason: `${failed} (${messageOf(err)}): ${files}` });
  if (failures >= ATTACH_TRIES) return end(ctx, entry, { kind: "needs-human", reason: `${failed} after ${ATTACH_TRIES} tries (${messageOf(err)}): ${files}` });
  const wait = ATTACH_WAITS_MS[failures - 1];
  const at = now();
  attachRetries.set(name, { failures, nextAt: at + wait });
  updateEach(ctx, runMembers(ctx, entry), (queue, member) => noteWorking(queue, member, `attaching the plan (retry ${failures})`, at, at));
  log(`${entry.batch ?? entry.ticket.key}'s plan could not be attached (${messageOf(err)}): trying again in ${wait / MS_PER_SECOND} seconds, retry ${failures} of ${ATTACH_TRIES - 1}`);
}

/**
 * Write the lines the plan moves into its ticket ({@link writeMoves}), stamp the plan with the text the ticket then holds, and attach `files` to the ticket, on a tracker that takes plans. Returns what the queue records of it: the
 * stamp, and the run's copy of the ticket moved on to the board's rewrite, or null when there is neither. Throws what the tracker throws, for the caller to retry or hand back.
 */
async function attachMoved(ctx: PoolContext, files: readonly string[], moving: Moving): Promise<((queue: Queue) => Queue) | null> {
  const { settings, source } = ctx;
  const stamped = await writeMoves(ctx, moving);
  const stamp = stampPlan(ctx, files, stamped);
  const note = await source.attachPlan!(moving.key, files, settings.planner?.state ?? null);
  if (note !== null) log(note);
  return recordedOf(moving, stamped, stamp);
}

/** What the queue records of an attached plan: its stamp, and the run's copy of the ticket moved on to the board's rewrite (`stamped`), or null when there is neither. PURE. */
function recordedOf(moving: Moving, stamped: TicketRead | undefined, stamp: PlannedAgainst | null): ((queue: Queue) => Queue) | null {
  if (stamp === null && stamped === moving.briefed) return null;
  return (queue) => {
    const moved = movedOn(queue, moving, stamped);
    return stamp === null ? moved : recordStampedPlan(moved, moving.key, stamp);
  };
}

/**
 * Attach a planning run's files to its ticket, close its workspace, and queue the ticket again to be worked. A plan that cannot be attached ends
 * the run for a person, with its files kept in the ticket's `plan` folder, unless the failure was the network's or the tracker's own (a 5xx): then the board tries again later ({@link attachFailed}).
 */
async function attachPlan(ctx: PoolContext, entry: Entry): Promise<void> {
  const { attaching, herdr, session, settings, source } = ctx;
  const key = entry.ticket.key;
  const { name } = runPlace(ctx, entry);
  if (attaching.has(name) || waitingToRetry(ctx, name)) return;
  attaching.add(name);
  const planDir = join(ticketDir(settings, key), PLAN_DIR);
  try {
    // Not through `attachFiles`: its extra step would queue the ticket again only after this pass has filled its slots.
    const found = planFiles(planDir, checksFor(runPlace(ctx, entry).dir, key, entry.findingsGiven, entry.briefedAgainst, entry.ticket, closedWorkOf(ticketDir(settings, key))));
    if ("refusal" in found) return found.afterMerge === undefined || !canSendBack(entry) ? end(ctx, entry, { kind: "needs-human", reason: found.refusal }) : sendBack(ctx, entry, [formatRefusalOf(entry, found.refusal, found.afterMerge.moves)]);
    if (source.attachPlan === undefined) return end(ctx, entry, { kind: "needs-human", reason: `this tracker takes no plans: attach the files in ${planDir} by hand` });
    const moving = { key, moves: found.moves, briefed: entry.briefedAgainst };
    // A plan that moves nothing awaits nothing before its attach, so the slot it frees is filled in this same pass.
    const stamped = found.moves.length === 0 ? moving.briefed : await writeMoves(ctx, moving);
    const stamp = stampPlan(ctx, found.files, stamped);
    const note = await source.attachPlan(key, found.files, settings.planner?.state ?? null);
    if (note !== null) log(note);
    // Stopped, or stopped and started again, while its plan was attached: the person's last word stands, and a newer run is not touched.
    if (!sameRun(ctx, entry)) return;
    // The tickets the plan's work waits on are the tracker's blockers before the ticket is queued again, so no run of it starts before they are there to be read (A11-272).
    const named = blockersOfPlan(found.files, key);
    const blockers = named.length === 0 ? named : await writePlanBlockers(ctx, key, named);
    if (!sameRun(ctx, entry)) return;
    if (entry.workspace) closedNote((args) => herdr(args), entry.workspace, session);
    forgetRun(ctx, name);
    update(ctx, (queue) => recordPlanBlockers(planDone(recordedOf(moving, stamped, stamp)?.(queue) ?? queue, key, { now: ctx.now() }), key, blockers));
  } catch (err) {
    attachFailed(ctx, entry, { err, failed: "the plan could not be attached", files: `its files are in ${planDir}` });
  } finally {
    attaching.delete(name);
  }
}

/**
 * Attach the plan files in `dir` to the ticket `key`. Null once they are attached, or else the outcome that hands the ticket to a person. A network or server failure is thrown on, for the batch to try again as a
 * whole ({@link attachFailed}); any other failure hands this one ticket back.
 */
async function attachFiles(ctx: PoolContext, key: string, dir: string): Promise<Outcome | null> {
  const { source } = ctx;
  const member = entryOf(ctx, key);
  const found = planFiles(dir, member === undefined ? {} : checksFor(runPlace(ctx, member).dir, key, member.findingsGiven, member.briefedAgainst, member.ticket, closedWorkOf(ticketDir(ctx.settings, key))));
  if ("refusal" in found) return { kind: "needs-human", reason: found.refusal };
  if (source.attachPlan === undefined) return { kind: "needs-human", reason: `this tracker takes no plans: attach the files in ${dir} by hand` };
  try {
    const recorded = await attachMoved(ctx, found.files, { key, moves: found.moves, briefed: member?.briefedAgainst });
    if (recorded !== null) update(ctx, recorded);
    return null;
  } catch (err) {
    if (isTransient(err)) throw err;
    return { kind: "needs-human", reason: `the plan could not be attached (${messageOf(err)}): its files are in ${dir}` };
  }
}

/**
 * Attach each plan a batch's run left to its own ticket, and queue that ticket again to be worked. A ticket the run asked a question about, or
 * wrote nothing for, is handed back to a person and parked (A11-171): the run keeps its workspace and pane, which the person answers it in, and the tickets that were
 * planned leave the batch. The workspace is closed only when no ticket was handed back. The batch's order is recorded in the tracker first, so no ticket of the batch
 * starts before its blockers are there to be read. A person's answer settles the tickets still in the batch the same way, when the run writes `planned` again.
 */
async function attachBatch(ctx: PoolContext, entry: Entry): Promise<void> {
  const { attaching, herdr, now, session, settings } = ctx;
  const { name, dir } = runPlace(ctx, entry);
  if (attaching.has(name) || waitingToRetry(ctx, name)) return;
  attaching.add(name);
  const members = runMembers(ctx, entry);
  const planDir = join(dir, PLAN_DIR);
  try {
    // A member whose section the board refuses sends the whole run back before any member is attached, so the planner's next `planned` does not attach a plan twice (A11-288).
    const refused = canSendBack(entry) ? members.flatMap((member) => formatRefusalIn(ctx, member, join(planDir, member.ticket.key)) ?? []) : [];
    if (refused.length > 0) return sendBack(ctx, entry, refused);
    const handedBack = new Map<string, Outcome>();
    for (const { ticket: { key } } of members) {
      const outcome = await planOneOfBatch(ctx, key, join(planDir, key));
      if (outcome !== null) handedBack.set(key, outcome);
    }
    const order = await recordOrder(ctx, planDir, members.map(({ ticket }) => ticket.key));
    // A repository that is no clone of this machine is never stored: the ticket is planned with none and handed to a person, saying why.
    const misplaced = unknownRepos(order, Object.keys(settings.clones));
    // Stopped, or stopped and started again, while its plans were attached: the person's last word stands, and a newer run is not touched.
    const still = members.filter((member) => sameRun(ctx, member));
    if (still.length === 0) return;
    // A run that asked a person something stays open for the answer: its agent was told a person may answer it there.
    const parks = entry.workspace !== undefined && still.some(({ ticket: { key } }) => handedBack.has(key));
    if (entry.workspace && !parks) closedNote((args) => herdr(args), entry.workspace, session);
    forgetRun(ctx, name);
    const id = entry.workspace === undefined ? undefined : ctx.claudeSessions.get(entry.workspace);
    updateEach(ctx, still, (queue, key) => {
      const outcome = handedBack.get(key);
      const refused = misplaced.get(key);
      if (outcome !== undefined) return (parks ? park : finish)(queue, key, outcome, now(), id === undefined ? {} : { session: id });
      if (refused !== undefined) return finish(batchPlanDone(queue, key, null, [], now()), key, { kind: "needs-human", reason: refused }, now());
      const place = order.get(key);
      return batchPlanDone(queue, key, place?.repo ?? null, mergeWaits(place), now());
    });
  } catch (err) {
    const [still] = members.filter((member) => sameRun(ctx, member));
    if (still !== undefined) attachFailed(ctx, still, { err, failed: "the plans could not be attached", files: `their files are in ${planDir}` });
  } finally {
    attaching.delete(name);
  }
}

/** Whether a refused plan can go back to its planner: the run is still running. A finished run whose unreadable outcome was corrected to `planned` (`rereadUnreadable`) has no planner to prompt, so its refusal ends it as before. */
const canSendBack = (entry: Entry): boolean => entry.phase === "running";

/** Whether a batch member's folder `dir` holds plan files and no question: what {@link planOneOfBatch} hands to {@link attachFiles}. */
const holdsPlan = (dir: string): boolean => existsSync(dir) && lstatSync(dir).isDirectory() && !existsSync(join(dir, QUESTION_FILE)) && readdirSync(dir).length > 0;

/**
 * The refusal of batch member `member`'s `## After-merge checks` section in its plan folder `dir` (A11-288), or null when the folder holds a question, nothing, or a plan the section does not refuse. Only a folder
 * {@link planOneOfBatch} would hand to {@link attachFiles} is read.
 */
function formatRefusalIn(ctx: PoolContext, member: Entry, dir: string): FormatRefusal | null {
  if (!holdsPlan(dir)) return null;
  const { key } = member.ticket;
  const found = planFiles(dir, checksFor(runPlace(ctx, member).dir, key, member.findingsGiven, member.briefedAgainst, member.ticket, closedWorkOf(ticketDir(ctx.settings, key))));
  return "refusal" in found && found.afterMerge !== undefined ? formatRefusalOf(member, found.refusal, found.afterMerge.moves) : null;
}

/**
 * Attach one batch ticket's plan from its folder, `dir`. Null once it is attached, or else the outcome that hands the ticket to a person. The
 * unattended run made the folder and everything in it, so a link is never followed: it could point the board at a secret, which the board
 * would then upload or show.
 */
async function planOneOfBatch(ctx: PoolContext, key: string, dir: string): Promise<Outcome | null> {
  const nothing: Outcome = { kind: "needs-human", reason: `the planning run wrote nothing for ${key}: no plan and no ${QUESTION_FILE} in ${dir}` };
  if (!existsSync(dir)) return nothing;
  if (!lstatSync(dir).isDirectory()) return { kind: "needs-human", reason: `the planner left ${dir}, which is not a plain folder` };
  const question = join(dir, QUESTION_FILE);
  if (existsSync(question)) {
    if (!lstatSync(question).isFile()) return { kind: "needs-human", reason: `the planner left ${question}, which is not a plain file` };
    // The question names the item of the escalation list it is for, and the card says which; one that names none got past the stop hook's bound and is marked, so it is seen and counted (A11-257).
    const asked = readFileSync(question, "utf8");
    const item = escalationItem(questionEscalation(asked));
    return { kind: "needs-human", reason: escalationReason(item?.id, `the planner needs a person: ${questionText(asked).slice(0, QUESTION_CHARS)}`), ...(item === undefined ? {} : { escalation: item.id }) };
  }
  return readdirSync(dir).length === 0 ? nothing : attachFiles(ctx, key, dir);
}

/**
 * The tickets the batch's run has a folder for under `planDir` that are on the board: those it was planned with, including the ones planned and gone from the batch since.
 * A folder that is no ticket of the board's is nothing the order may name.
 */
const plannedTickets = (ctx: PoolContext, planDir: string): string[] => (existsSync(planDir)
  ? readdirSync(planDir, { withFileTypes: true }).filter((item) => item.isDirectory() && entryOf(ctx, item.name) !== undefined).map((item) => item.name) : []);

/**
 * Read a batch's order from its plan folder and record it in the tracker: each of `keys`, the tickets settled now, blocked by the tickets of the batch it waits on. The order
 * names every ticket the batch was planned with, so it is read against those folders as well as `keys`: a run answered by a person settles only the tickets still in
 * the batch, and the tickets planned before it are not given their relations again (A11-171). An order that fails its checks records nothing and is logged, and so is a
 * relation the tracker refuses: the plans stand without them. Returns the order, empty when there is none to use.
 */
async function recordOrder(ctx: PoolContext, planDir: string, keys: readonly string[]): Promise<Order> {
  const { source } = ctx;
  const path = join(planDir, ORDER_FILE);
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    log(`the planning run of ${keys.join(", ")} wrote no ${ORDER_FILE} as a plain file, so their order was not recorded`);
    return new Map();
  }
  const read = parseOrder(readFileSync(path, "utf8"), [...new Set([...keys, ...plannedTickets(ctx, planDir)])]);
  if ("refusal" in read) {
    log(`${path} was not used, so no order was recorded: ${read.refusal}`);
    return new Map();
  }
  const add = source.addBlockers?.bind(source);
  for (const [key, { after }] of read.order) {
    if (add === undefined || after.length === 0 || !keys.includes(key)) continue;
    try {
      await add(key, after);
    } catch (err) {
      log(`${after.join(", ")} could not be recorded as blocking ${key}: ${messageOf(err)}`);
    }
  }
  return read.order;
}

/**
 * Record how a run ended, for every ticket in it. One that hands its tickets back keeps its workspace (parked); any other has its workspace
 * closed, a `checked` or `done` one included ({@link CONCLUDED}): nobody answers a run that found nothing to do, so its finished agent is not left open.
 */
export function end(ctx: PoolContext, entry: Entry, outcome: Outcome): void {
  const { claudeSessions, herdr, now, session, transcripts } = ctx;
  // A concluded run never parks, whatever else a later change hands back: nobody would answer its agent.
  const parks = entry.workspace !== undefined && HANDED_BACK.has(outcome.kind) && !CONCLUDED.has(outcome.kind);
  if (entry.workspace && !parks) closedNote((args) => herdr(args), entry.workspace, session);
  const id = entry.workspace === undefined ? undefined : claudeSessions.get(entry.workspace);
  const tokens = countTokens(id === undefined ? null : findTranscript(transcripts, id));
  const { name } = runPlace(ctx, entry);
  const record = id === undefined ? {} : { session: id };
  // A batch's run spent its tokens once, so they are recorded on the ticket it was watched through, and not counted again on each of the rest.
  updateEach(ctx, runMembers(ctx, entry), (queue, key) => (parks ? park : finish)(queue, key, outcome, now(), key === entry.ticket.key ? { ...record, tokens } : record));
  recordPullsAtEnd(ctx, entry, outcome);
  // A run that is not handed back gives its ticket back now. A parked one keeps it In Progress while a person may answer it.
  if (!HANDED_BACK.has(outcome.kind)) for (const member of runMembers(ctx, entry)) void restoreAndLog(ctx, member.ticket.key);
  forgetRun(ctx, name);
}

/**
 * The files each open pull request changes, by URL, from the reads of them: a list GitHub cut short ends with an empty name, so only the files listed
 * hold (`footprintOf`). The watch and the end of a run both record it this way, so a run holds the same files either way (A11-125).
 */
export function pullFilesOf(open: readonly { url: string; read: PullFeedback }[]): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(open.map(({ url, read }) => [url, read.filesComplete ? read.files : [...read.files, ""]]));
}

/**
 * What a read says of a head's review for readiness (A11-179), or undefined when the code host did not say: `approved` when the newest verdict on the head approves it and GitHub's review decision
 * is approved or needs none, `changes-requested` when either asks for changes, and `none` otherwise, which is also a branch whose decision still asks for a review. PURE.
 */
export function reviewAtHead(read: PullFeedback): PullHead["review"] {
  if (read.verdictAtHead === undefined || read.reviewDecision === undefined) return undefined;
  if (read.reviewDecision === "changes-requested" || read.verdictAtHead === "changes-requested") return "changes-requested";
  return read.verdictAtHead === "approved" && (read.reviewDecision === "approved" || read.reviewDecision === null) ? "approved" : "none";
}

/**
 * The head of each open pull request that has one, with whether a reviewer approved it there, by URL, from the reads of them (A11-153), and what the read said of its readiness to merge at that head
 * (A11-179: its review, its red required checks and its required checks still running, each left out when the code host did not say), and the branch it conflicts with while it conflicts (A11-293). One that GitHub gave no head for is left out: nothing can be
 * compared with it.
 */
export function pullHeadsOf(open: readonly { url: string; read: PullFeedback }[]): Readonly<Record<string, PullHead>> {
  return Object.fromEntries(open.flatMap(({ url, read }) => {
    if (read.head === null) return [];
    const review = reviewAtHead(read);
    return [[url, { head: read.head, approved: read.approvedAtHead, ...(review === undefined ? {} : { review }), red: read.failing,
      ...(read.pendingRequired === undefined ? {} : { pending: read.pendingRequired }), mergeable: read.mergeable, ...(read.state === "open" && read.conflicting ? { conflict: { base: read.base } } : {}) }]];
  }));
}

/** The open pull requests that read `changes-requested` at their head, by URL with that head, from the reads of them (A11-258): what a `needs-human` run ended on, for {@link pullHeadsOf}'s `review`. */
export function blockedPullsOf(open: readonly { url: string; read: PullFeedback }[]): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(pullHeadsOf(open)).filter(([, { review }]) => review === "changes-requested").map(([url, { head }]) => [url, head]));
}

/** The commit each open pull request is at, by URL, from the reads of them (A11-153): {@link pullHeadsOf} without the approval. */
export function headCommitsOf(open: readonly { url: string; read: PullFeedback }[]): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(pullHeadsOf(open)).map(([url, { head }]) => [url, head]));
}

/**
 * A run that ends with a pull request open is footprinted at once (A11-125): the files of its open pull requests are read as the watch reads them and
 * recorded, so a queued run that shares one with it waits from now, not from the next watch. The read and the record are one synchronous block, so no
 * start pass can fall between the run ending and its files being recorded. When a read fails, nothing is recorded: the run holds its repository until
 * a watch records the files (`overlapWait`). The same read records the head each open pull request is at as the run ends (`outcomeHeads`), which is what a
 * later push answers (A11-153), and, for a run that ends `needs-human`, which of them were changes requested (`outcomeBlocks`, A11-258). That is for a draft or ready pull request, and for a run that ends `needs-human`, which has no result: its pull requests are the
 * round's it continued. Only a draft or ready pull request's files are recorded, as before.
 */
function recordPullsAtEnd(ctx: PoolContext, entry: Entry, outcome: Outcome): void {
  const { codeHost, feedbackIgnores, ownLogin } = ctx;
  const key = entry.ticket.key;
  const isDraftOrReady = outcome.kind === "draft-pr" || outcome.kind === "ready-pr";
  // Only a run that is asking (`needs-human`) is answered by a push, so no other kind pays for a read of its pull requests.
  const pulls = isDraftOrReady || outcome.kind === "needs-human" ? pullsOf({ outcome, review: entry.review }) : [];
  if (pulls.length === 0) return;
  ownLogin.value ??= codeHost.readOwnLogin();
  const self = ownLogin.value;
  if (self === null) return;
  const reads = pulls.map(({ url }) => ({ url, read: codeHost.readPullFeedback(url, self, feedbackIgnores) }));
  const readable = reads.filter((pull): pull is { url: string; read: PullFeedback } => pull.read !== null);
  if (readable.length < reads.length) {
    log(`${key}: the files and heads of its pull requests could not be read, so its repository is held until the next watch reads them`);
    return;
  }
  const open = readable.filter(({ read }) => read.state === "open");
  const blocked = outcome.kind === "needs-human" ? blockedPullsOf(open) : {};
  update(ctx, (queue) => recordOutcomeBlocks(recordOutcomeHeads(isDraftOrReady ? recordPullFiles(queue, key, pullFilesOf(open)) : queue, key, headCommitsOf(open)), key, blocked));
}

/**
 * Put a ticket the board moved back in the state it came from, for a run that ended without a pull request. Only while the ticket is still in
 * the state the board moved it to: a person who has moved it since is left to it. Either way the record goes, once the tracker has answered.
 * Waits for the move that recorded it, which may still be on its way to the tracker. Throws, with the tracker's reason, when the tracker refuses,
 * and keeps the record, so the next pass tries again.
 */
export async function restoreWorkingState(ctx: PoolContext, key: string): Promise<void> {
  const { pendingMoves, source, store } = ctx;
  await pendingMoves.get(key);
  const entry = store.get().entries.find((e) => e.ticket.key === key);
  // A run that opened a pull request is never put back: the tracker's own integration takes its ticket from there. Nor is a review round, nor a
  // `done` run, whose ticket the board completed.
  const needsNoRecord = entry?.movedFrom === undefined || entry.review !== undefined || RESULT_KINDS.has(entry.outcome?.kind ?? "") || entry.outcome?.kind === "done";
  if (needsNoRecord) return;
  const restore = source.restoreState?.bind(source);
  if (restore !== undefined) {
    let note: string | null;
    try { note = await restore(key, entry.movedFrom); }
    catch (err) { throw new Error(`${key} could not be put back to ${entry.movedFrom.from}: ${messageOf(err)}`); }
    if (note !== null) log(note);
  }
  update(ctx, (queue) => clearMove(queue, key));
}

/**
 * Put back the tickets of finished runs that ended without a pull request and still hold the record of a move: a restore the tracker refused, or a
 * run a restart crashed. A handed-back run keeps its ticket In Progress while a person may still answer its agent, so it is left alone here, and
 * Dismiss or a later retry settles it.
 */
export async function restoreStranded(ctx: PoolContext): Promise<void> {
  const { store } = ctx;
  const stranded = store.get().entries.filter((e) => e.phase === "finished" && e.movedFrom !== undefined && !isParked(e) && !HANDED_BACK.has(e.outcome?.kind ?? "") && e.outcome?.kind !== "done");
  for (const { ticket } of stranded) await restoreAndLog(ctx, ticket.key);
}

/** {@link restoreWorkingState}, with a refusal written to the board's log: a caller that nothing waits on, and the next pass tries again. */
const restoreAndLog = (ctx: PoolContext, key: string): Promise<void> => restoreWorkingState(ctx, key).catch((err) => log(messageOf(err)));

/** Close a parked run's workspace. Its outcome and its worktrees stay. Throws with herdr's reason when herdr refuses, so the run stays parked. */
export function close(ctx: PoolContext, key: string): void {
  const { herdr, misses, settings, store } = ctx;
  const entry = store.get().entries.find((e) => e.ticket.key === key && isParked(e));
  if (entry?.workspace === undefined) return;
  try {
    herdr(["--session", settings.herdrSession, "workspace", "close", entry.workspace]);
  } catch (err) {
    throw new Error(`herdr could not close ${key}'s workspace (${herdrRefusal(err)})`);
  }
  misses.delete(runPlace(ctx, entry).name);
  updateEach(ctx, runMembers(ctx, entry), unpark);
}
