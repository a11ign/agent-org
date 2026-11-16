// @ts-check
// module: the pull request's check, merge-queue and settle states as one pure state machine (A11-437) -- what the board does next about the red and the cancelled checks of a pull request at its head, about the merge queue's removals of it, and about a run its pull requests settle, from the record it holds and what it read: wait (and why), read, rerun, start a round, ask the arm bot, hold it, complete the ticket or name a person. It reads no file, network or clock: the caller does what a step names and feeds the result back
//
// THE RERUN BOUNDS. A red check is rerun at one head for three reasons: before a worker is asked, when the code failed it (A11-300); when the worker's reply after a round says the failure is not its change's (A11-300); and when its log shows the
// infrastructure failing (A11-154). Red again after the rerun for its reason, it is named for a person. The record of a head keeps only its last answer, so an infrastructure rerun can come again after the rerun a reply asked for, but a round's
// replies are read once for a head (`PoolContext.repliesRead`), so the reruns of one check at one head are at most {@link RED_RERUNS_PER_HEAD}. A cancelled required run that blocks an approved, armed pull request is rerun at most {@link MAX_CANCELLED_RERUNS} times for a head (A11-342, A11-403),
// and a refused rerun is asked again at most {@link MAX_REFUSALS} times. `pr-state-machine.test.ts` feeds random event sequences to these functions and checks the bounds, that every wait gives a reason, and that each end state is reachable.
//
// THE MERGE QUEUE'S BOUNDS (step 2). A removal from the merge queue is answered once for a head (A11-264): the failed jobs of its `merge_group` run are rerun at most {@link QUEUE_RERUNS_PER_HEAD} time before a worker is asked (A11-371), the arm bot is asked to arm the pull request
// again at most {@link MAX_REARMS} times (A11-295), at most one round is started, and the {@link HOLD_AFTER}th removal for failed checks with no push between holds it from the arm bot. `queueStep` decides each of these; `pool-merge-queue.ts` makes the reads, the rerun, the asks and
// the label calls a step names, and briefs the round. `pr-state-machine-queue.test.ts` feeds random sequences of removals, pushes, approvals, reruns and refusals to it and checks the same three properties.
//
// THE SETTLE STATES (step 3). A run's pull requests settle it once every one has merged or closed: complete with one merged, a person asked with all closed unmerged, and a wait, with its reason, while one is open or unread (A11-173). `settleStep` decides it, and
// `reviewAtHead` reads a head's review for readiness (A11-179), which the cancelled gate turns on (A11-342); `pool-settle.ts` acts on both. `pr-state-machine-settle.test.ts` feeds random sequences to it and checks the same three properties.
import type { CiRun, PullFeedback, PullQueue, QueueFailure, QueueFailureJob, QueueRemoval } from "../plugins/contracts/code-host.ts";
import { type CheckHead, openPulls, type PullHead, type ViewEntry } from "./board-view/view-types-and-filters.ts";
import type { FlakeCandidate, RerunRecord } from "./board-view/check-rerun-record.ts";
import type { QueueHead, QueueRetry } from "./board-view/queue-head.ts";
import { MAX_CANCELLED_RUNS } from "./board-view/cancelled-rerun-words.ts";
import { failedTestOf } from "./failure-words.ts";
import { settledByPulls } from "./board-view/pull-settled.ts";
import type { PullState } from "./source.ts";

/**
 * A failing check with what its job's log says of it: the lines to quote, and why it is the infrastructure's and not the code's, when it is. `refusals` are the log's lines that say the check refused
 * (A11-179): a refusal names the ticket that owns what it refuses, and its words are not an error line's.
 */
export type ReadCheck = Readonly<{ name: string; lines: readonly string[]; refusals: readonly string[]; infrastructure: string | null; readable: boolean; detailsUrl: string | null }>;

/** The longest a red check that has others still running waits for its run to finish before the board reruns it anyway: GitHub reruns the failed jobs of a run only once the whole run has finished (A11-300). */
export const RERUN_WAIT_MS = 45 * 60_000;

/** How long after a rerun a failure that finished before it is read as the failure that was rerun, still on the check's page, and not as the rerun failing again: GitHub's read can lag the rerun by a few seconds. */
export const RERUN_SETTLE_MS = 5 * 60_000;

/** The reasons a red check is rerun for at one head: the code failed it, the worker's reply says it is not the change's, or the infrastructure failed it. */
export const RERUN_REASONS = ["code", "reply", "infrastructure"] as const;

/** Why a red check was rerun. */
export type RerunReason = (typeof RERUN_REASONS)[number];

/** The most reruns of one red check at one head, as many as there are reasons: the property tests of `pr-state-machine.test.ts` hold every random sequence to it. */
export const RED_RERUNS_PER_HEAD = RERUN_REASONS.length;

/** The most reruns the board makes of the cancelled runs that block a head: the first run is cancelled once before any rerun, so {@link MAX_CANCELLED_RUNS} cancelled runs are the first and the reruns. */
export const MAX_CANCELLED_RERUNS = MAX_CANCELLED_RUNS - 1;

/** How many refused reruns of cancelled runs the board puts up with for one head before it stops asking. */
export const MAX_REFUSALS = 3;

/** The characters of a head the card names, as GitHub's own short form does. */
const HEAD_CHARS = 8;

/** A head as the card names it. PURE. */
export const shortHead = (head: string): string => head.slice(0, HEAD_CHARS);

/** The names of checks, as a note lists them. PURE. */
export const checkNames = (checks: readonly Pick<ReadCheck, "name">[]): string => checks.map((check) => check.name).join(", ");

const reasons = (checks: readonly ReadCheck[]): string => [...new Set(checks.map((check) => check.infrastructure))].join(" and ");

/** What the machine reads of a pull request at a watch: the parts of the code host's feedback the check rules turn on. */
export type ChecksRead = Pick<PullFeedback, "head" | "failing" | "failures" | "failedAt" | "pendingRequired"> & Partial<Pick<PullFeedback, "state">>;

/** The red checks of a head once their logs are read: the code's own, the infrastructure's, and how many fail where the run's files are not (A11-179). */
export type ReadReds = Readonly<{ own: readonly ReadCheck[]; infrastructure: readonly ReadCheck[]; outside: number }>;

/**
 * What the board has found, fed to {@link checkStep}: a watch's read of the pull request; the logs of its red checks, once a step asked for them; the checks a worker's reply calls unrelated (A11-300); or a rerun the code host refused, with its reason.
 * `now` is the caller's clock, read once, so the machine reads none.
 */
export type CheckEvent =
  | Readonly<{ on: "watch"; read: ChecksRead; now: number }>
  | Readonly<{ on: "logs"; head: string; reds: ReadReds; now: number }>
  | Readonly<{ on: "unrelated-reply"; head: string; checks: readonly ReadCheck[]; now: number }>
  | Readonly<{ on: "refused"; head: string; rerun: Extract<CheckStep, { do: "rerun" }>; why: string }>;

/**
 * What the board does next, from {@link checkStep}:
 * - `nothing`: no head, nothing red, or the head is answered already;
 * - `end`: the pull request merged or was closed, and its record goes;
 * - `wait`: not yet, and `reason` says why;
 * - `record-pass`: the rerun of the code's checks came out green: write its `flakes` and keep `record`, or, when the flake log cannot be written, do `otherwise`;
 * - `read-replies`: a round ended with the head where it was and the checks still red: read the worker's replies (A11-300);
 * - `read-logs`: read the red checks' logs and the checks red elsewhere, and feed them back as `logs`; `reran` is the head's record when the board reran at it already;
 * - `rerun`: rerun the jobs behind `checks` and keep `record`, whose note the log says, or feed a refusal back;
 * - `round`: brief a worker on `own`, naming `infrastructure`;
 * - `name`: a person decides, and `record` says why;
 * - `hold`: every red check fails where the run's files are not (A11-179): the hold rules answer it.
 */
export type CheckStep =
  | Readonly<{ do: "nothing" }>
  | Readonly<{ do: "end"; as: "merged" | "closed" }>
  | Readonly<{ do: "wait"; reason: string }>
  | Readonly<{ do: "record-pass"; record: CheckHead & { rerun: RerunRecord }; flakes: readonly FlakeCandidate[]; otherwise: CheckStep }>
  | Readonly<{ do: "read-replies" }>
  | Readonly<{ do: "read-logs"; reran: CheckHead | undefined }>
  | Readonly<{ do: "rerun"; for: RerunReason; checks: readonly ReadCheck[]; record: CheckHead & { note: string }; own: readonly ReadCheck[]; infrastructure: readonly ReadCheck[] }>
  | Readonly<{ do: "round"; own: readonly ReadCheck[]; infrastructure: readonly ReadCheck[]; record: CheckHead }>
  | Readonly<{ do: "name"; record: CheckHead & { note: string } }>
  | Readonly<{ do: "hold" }>;

const NOTHING: CheckStep = { do: "nothing" };

/** Whether a record is the rerun of the code's own checks at `head`, which has not yet come out green and been recorded. PURE. */
export const isUnsettledRerun = (known: CheckHead | undefined, head: string | null): known is CheckHead & { rerun: RerunRecord } =>
  known?.step === "rerun" && known.head === head && known.rerun !== undefined && known.rerun.passed !== true && known.rerun.candidates.length > 0;

/** Whether none of a rerun's checks is red or running now: the host says which required checks are running, and says none, and none of the rerun's checks is among the failures. PURE. */
const rerunCameOutGreen = (record: RerunRecord, read: ChecksRead): boolean =>
  read.pendingRequired !== undefined && read.pendingRequired.length === 0 && !record.candidates.some(({ check }) => read.failures.some(({ name }) => name === check));

/** Whether the pull request has checks still running, and the failure is recent enough to wait for them: the failed jobs of a run can be rerun only once the run has finished. A failure with no time is not waited for. PURE. */
const runStillGoing = (read: ChecksRead, now: number): boolean => (read.pendingRequired ?? []).length > 0 && read.failedAt !== null && now - read.failedAt < RERUN_WAIT_MS;

/** Whether a rerun's red check is still the failure that was rerun, not yet replaced on the host by the rerun's own run (A11-300): it finished before the rerun, shortly after it. PURE. */
const stillTheRerunFailure = (known: CheckHead | undefined, read: ChecksRead, now: number): boolean =>
  known?.rerun !== undefined && read.failedAt !== null && read.failedAt <= known.rerun.at && now - known.rerun.at < RERUN_SETTLE_MS;

/** The flake candidates of the checks a rerun is for: the test or step that failed in each, and the run it failed in. PURE. */
const candidatesOf = (checks: readonly ReadCheck[]): FlakeCandidate[] =>
  checks.flatMap((check) => (check.detailsUrl === null ? [] : [{ test: failedTestOf(check), check: check.name, run: check.detailsUrl }]));

/** The record of a rerun of the code's own red checks (A11-300), with what failed kept for the flake log. PURE. */
const rerunRecord = (head: string, note: string, kind: "code" | "reply", at: number, checks: readonly ReadCheck[]): CheckHead & { note: string } =>
  ({ head, step: "rerun", note, rerun: { for: kind, at, candidates: candidatesOf(checks) } });

/** A step that names a person, with the record that says why. PURE. */
const named = (head: string, note: string, extra: Partial<CheckHead> = {}): CheckStep => ({ do: "name", record: { head, step: "named", note, ...extra } });

/** THE PASS ON A RERUN (A11-300): the record that says the rerun of the code's checks passed and was recorded as a flake, or null when the head's record is no such rerun or it has not come out green. PURE. */
function passOnRerun(known: CheckHead | undefined, read: ChecksRead, otherwise: CheckStep): CheckStep | null {
  if (!isUnsettledRerun(known, read.head) || !rerunCameOutGreen(known.rerun, read)) return null;
  const note = `${known.rerun.candidates.map(({ check }) => check).join(", ")} failed on ${shortHead(known.head)} and passed on rerun: recorded as a flake`;
  return { do: "record-pass", record: { ...known, note, rerun: { ...known.rerun, passed: true } }, flakes: known.rerun.candidates, otherwise };
}

/** What a watch does once no rerun pass is to be recorded: nothing when nothing is red or the head is answered, a wait while the run or the rerun is not done, the replies at a round's end, else the logs. PURE. */
function afterPass(known: CheckHead | undefined, read: ChecksRead & { head: string }, now: number): CheckStep {
  if (read.failing.length === 0) return NOTHING;
  const atHead = known?.head === read.head;
  const reran = atHead && known.step === "rerun";
  const looked = atHead && known.step === "not-ours";
  // A head answered already: a round that ended with its checks still red may have a reply that says the failure is not the change's (A11-300).
  if (atHead && !reran && !looked) return known.step === "round" ? { do: "read-replies" } : NOTHING;
  if (reran && stillTheRerunFailure(known, read, now)) return { do: "wait", reason: `the rerun at ${shortHead(read.head)} has not replaced the failure it reran on the code host yet` };
  // The failed jobs of a run are rerun only once the run has finished: a head not answered yet waits for its running checks, before any log is read (A11-300).
  if (!reran && !looked && runStillGoing(read, now)) return { do: "wait", reason: `${read.failing.join(", ")} failed at ${shortHead(read.head)} while the run's other checks are still running: the failed jobs are rerun once it finishes` };
  return { do: "read-logs", reran: reran ? known : undefined };
}

/** What a watch of a pull request does first: its end, when it merged or was closed; nothing without a head; record a rerun's pass; else {@link afterPass}. PURE. */
function onWatch(known: CheckHead | undefined, read: ChecksRead, now: number): CheckStep {
  const { head, state } = read;
  if (state === "merged" || state === "closed") return { do: "end", as: state };
  if (head === null) return NOTHING;
  const rest = afterPass(known, { ...read, head }, now);
  return passOnRerun(known, read, rest) ?? rest;
}

/**
 * The code's own red checks at a head (A11-300): rerun once before any worker is asked, unless one has no job to rerun or the head was rerun at already; red again after a rerun the worker's reply asked for, a person decides; else a round. PURE.
 */
function onOwn(known: CheckHead | undefined, head: string, reds: ReadReds, now: number): CheckStep {
  const { own, infrastructure } = reds;
  const reran = known?.head === head && known.step === "rerun" ? known : undefined;
  if (reran === undefined && own.every(({ detailsUrl }) => detailsUrl !== null)) {
    const note = `Reran ${checkNames(own)} on ${shortHead(head)} before asking a worker: a worker is asked only if ${own.length === 1 ? "it fails" : "they fail"} again`;
    return { do: "rerun", for: "code", checks: [...own, ...infrastructure], record: rerunRecord(head, note, "code", now, own), own, infrastructure };
  }
  if (reran?.rerun?.for === "reply") return named(head, `${checkNames(own)} failed again on ${shortHead(head)} after a rerun the worker's reply asked for: a person decides`, { redAgain: own.map(({ name }) => name) });
  return { do: "round", own, infrastructure, record: { head, step: "round" } };
}

/** Checks that failed for an infrastructure reason and no check of the code's (A11-154): rerun once; red again after an infrastructure rerun at the same head, a person decides. PURE. */
function onInfrastructure(known: CheckHead | undefined, head: string, checks: readonly ReadCheck[]): CheckStep {
  const reranForIt = known?.head === head && known.step === "rerun" && known.rerun === undefined;
  if (reranForIt) return named(head, `${checkNames(checks)} failed again on ${shortHead(head)} after a rerun (${reasons(checks)}): a person decides`);
  const note = `Reran ${checkNames(checks)} on ${shortHead(head)}: ${reasons(checks)}`;
  return { do: "rerun", for: "infrastructure", checks, record: { head, step: "rerun", note }, own: [], infrastructure: checks };
}

/** The red checks of a head once their logs are read. PURE. */
function onLogs(known: CheckHead | undefined, head: string, reds: ReadReds, now: number): CheckStep {
  const { own, infrastructure, outside } = reds;
  if (own.length > 0) return onOwn(known, head, reds, now);
  // The rerun of the code's own checks is still under way, and what is red now is neither the code's own nor an infrastructure failure: its record is kept, not replaced by a hold or an infrastructure rerun that would forget what to record if it passes (A11-300).
  if (infrastructure.length === 0 && isUnsettledRerun(known, head)) return { do: "wait", reason: `the rerun of ${known.rerun.candidates.map(({ check }) => check).join(", ")} at ${shortHead(head)} is still under way` };
  if (infrastructure.length === 0 && outside > 0) return { do: "hold" };
  return onInfrastructure(known, head, infrastructure);
}

/** A round's worker replied that its red checks are not its change's (A11-300): rerun them once, unless there are none or one has no job to rerun. PURE. */
function onUnrelatedReply(head: string, checks: readonly ReadCheck[], now: number): CheckStep {
  if (checks.length === 0 || checks.some(({ detailsUrl }) => detailsUrl === null)) return NOTHING;
  const note = `Reran ${checkNames(checks)} on ${shortHead(head)}: the worker's reply says the failure is not from the change`;
  return { do: "rerun", for: "reply", checks, record: rerunRecord(head, note, "reply", now, checks.filter(({ infrastructure }) => infrastructure === null)), own: checks, infrastructure: [] };
}

/** A rerun the code host refused: the code's own checks get their round as before A11-300; an infrastructure or a reply's rerun is named for a person, since asked again on every watch it would be refused for ever. PURE. */
function onRefused(head: string, rerun: Extract<CheckStep, { do: "rerun" }>, why: string): CheckStep {
  const { checks } = rerun;
  if (rerun.for === "code") return { do: "round", own: rerun.own, infrastructure: rerun.infrastructure, record: { head, step: "round" } };
  if (rerun.for === "reply") return named(head, `${checkNames(checks)} failed on ${shortHead(head)}, and the worker's reply says the failure is not from the change, but it could not be rerun (${why}): a person decides`);
  return named(head, `${checkNames(checks)} failed on ${shortHead(head)} for an infrastructure reason (${reasons(checks)}) and could not be rerun (${why}): a person decides`);
}

/**
 * The rerun step once the code host has taken it, `now` being the time the board read then: the rerun a worker's reply asked for is stamped with it (A11-300), so a failure the host reports from while it was being made is still the one
 * that was rerun; the code's own rerun keeps the time it was decided at, read before it was made, and an infrastructure rerun has no time. PURE.
 */
export function takenRerun(step: Extract<CheckStep, { do: "rerun" }>, now: number): Extract<CheckStep, { do: "rerun" }> {
  const { record } = step;
  return step.for === "reply" && record.rerun !== undefined ? { ...step, record: { ...record, rerun: { ...record.rerun, at: now } } } : step;
}

/**
 * THE TRANSITION OF A PULL REQUEST'S RED CHECKS (A11-154, A11-300). `known` is the record the board holds for the pull request; `event` is what it found. The step says what to do next; a step that reads or reruns is answered by
 * the next event. PURE: it reads no file, network or clock.
 */
export function checkStep(known: CheckHead | undefined, event: CheckEvent): CheckStep {
  switch (event.on) {
    case "watch": return onWatch(known, event.read, event.now);
    case "logs": return onLogs(known, event.head, event.reds, event.now);
    case "unrelated-reply": return onUnrelatedReply(event.head, event.checks, event.now);
    case "refused": return onRefused(event.head, event.rerun, event.why);
  }
}

/** The reruns of the cancelled runs that block a head, as the run's log records them (A11-403): taken by the host, refused by it, and whether the board stopped. */
export type CancelledTries = Readonly<{ taken: number; refused: number; stopped: boolean }>;

/**
 * What the board does about the cancelled runs that block an approved, armed head: nothing more (`leave`: it stopped, whose line the card shows, or the host refused {@link MAX_REFUSALS} reruns, each of which the run's timeline shows),
 * `ask-busy` the code host whether a run of the workflow is in progress there, `wait` while one is, `stop` and say so, or `rerun` one. `reason` says why it leaves or waits.
 */
export type CancelledStep = Readonly<{ do: "ask-busy" | "stop" | "rerun" }> | Readonly<{ do: "leave" | "wait"; reason: string }>;

/**
 * THE TRANSITION OF THE CANCELLED RUNS THAT BLOCK A HEAD (A11-342, A11-403). `tries` is what the log records at the head; `busy` is whether the code host says a run of the workflow is still in progress there, or `unread` before the
 * board asked, which it does only when the step is not `leave`. At most {@link MAX_CANCELLED_RERUNS} reruns, then one stop; refusals are asked again up to {@link MAX_REFUSALS}. PURE.
 */
export function cancelledStep(tries: CancelledTries, busy: boolean | "unread"): CancelledStep {
  const spent = tries.taken >= MAX_CANCELLED_RERUNS;
  if (tries.stopped) return { do: "leave", reason: `the cancelled runs were rerun ${MAX_CANCELLED_RERUNS} times at the head and cancelled again: the board has stopped rerunning them` };
  if (!spent && tries.refused >= MAX_REFUSALS) return { do: "leave", reason: `the code host refused ${MAX_REFUSALS} reruns of the cancelled runs at the head: the board has stopped asking` };
  if (busy === "unread") return { do: "ask-busy" };
  if (busy) return { do: "wait", reason: "a run of the cancelled check's workflow is still in progress at the head: a rerun now would cancel it" };
  return spent ? { do: "stop" } : { do: "rerun" };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The merge queue's removals (A11-264, A11-295, A11-371): step 2 of 3
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** How many removals for failed checks, with no push between, the board puts up with before it holds the pull request from the arm bot: the ticket says "more than twice". */
export const HOLD_AFTER = 3;

/** How many times the board asks the arm bot to arm a pull request again at one head, for a removal the change did not cause or a round that pushed nothing: the ticket says "at most two re-arms per head". */
export const MAX_REARMS = 2;

/** How many times the failed jobs of a merge group are rerun at one head before a worker is asked (A11-371): once, and a second removal goes to the run. */
export const QUEUE_RERUNS_PER_HEAD = 1;

/** The longest the board waits for the rerun of a merge group's jobs before it asks a worker anyway: the pull request must not sit out of the queue for more than half an hour (A11-371). */
export const RETRY_WAIT_MS = 30 * 60_000;

/** The reason the queue gives for a removal after a failed `merge_group` run. */
const FAILED_CHECKS = /^failed_checks$/i;
/** The reasons that are a merge conflict. */
const CONFLICT = /conflict/i;
/** The account the queue itself removes as: a removal by anyone else is a person's decision. */
const QUEUE_ACTOR = /^github-merge-queue(?:\[bot\])?$/i;

/** What the log says of a pull request still out of the queue after an ask the arm bot refused. */
const STILL_OUT = "it is still out of the merge queue";

/**
 * One open pull request as the queue rules read it: its address, the code host's read of it, whether the code host can ask the arm bot (`canRearm`) and read a run's conclusion (`canReadRuns`), and whether the round the board started for it is over
 * and left it where it was (`roundOver`: the run is finished with a worker neither waiting on a person's answer nor handed back at the round cap, both of which are a person's to decide).
 */
export type QueuePull = Readonly<{
  url: string;
  read: Pick<PullFeedback, "head" | "queue" | "approvedAtHead" | "verdictAtHead" | "reviewDecision" | "conflicting">;
  canRearm: boolean;
  canReadRuns: boolean;
  roundOver: boolean;
}>;

/** One failing job of the merge group, with its log read. */
export type ReadJob = Readonly<{ job: QueueFailureJob; check: ReadCheck }>;

/** A removal for failed checks once the run behind it (`failure`, null when it could not be read) and the logs of the jobs a round is about are read; `count` is the removals for failed checks at the head, and `prior` the record a re-arm or a rerun left. */
export type FailedRead = Readonly<{ removal: QueueRemoval; count: number; prior: QueueHead | undefined; failure: QueueFailure | null; jobs: readonly ReadJob[] }>;

/** The round a removal starts, which the caller briefs: a fix round for a failed `merge_group` run, with the re-arms already made and whether the board re-arms when it pushes nothing, or a conflict round. */
export type QueueRound =
  | Readonly<{ kind: "fix"; seen: FailedRead; rearms: number; willRearm: boolean }>
  | Readonly<{ kind: "conflict"; removal: QueueRemoval }>;

/** What follows a hold: the answer, with the round it starts if one, or the rest of the answer to a removal at a head already answered (`known`). */
export type AfterHold = Readonly<{ round?: QueueRound }> | Readonly<{ repeated: QueueHead }>;

/**
 * What the board does next about a pull request's removals, from {@link queueStep}; `say` is what the log says first, each line after the ticket's key:
 * - `answer`: the record the entry should hold for the pull request (none: drop what it held), and the round to brief when one is due;
 * - `release`: lift the hold from the arm bot at the head the pull request moved off, and feed `released` back;
 * - `read-runs`: read the conclusion of the merge group's runs a rerun is waiting on, and feed `runs` back;
 * - `read-failure`: read the `merge_group` run behind `removal` and the logs of its jobs, and feed `failure` back;
 * - `read-jobs`: read the run behind the newest removal for the names of its failed jobs, which the hold names, and feed `jobs` back;
 * - `rerun-jobs`: rerun the merge group's failed jobs at `addresses` (A11-371), and feed `rerun-jobs` back;
 * - `record-flakes`: write each of `candidates` at `head` to the flake log (a log that cannot be written is said), then do `then`;
 * - `ask-arm-bot`: ask the arm bot to arm the pull request again (A11-295), and feed `armed` back;
 * - `hold`: put the hold from the arm bot on the pull request (A11-264), and feed `held` back.
 */
export type QueueStep = Readonly<{ say?: readonly string[] }> & (
  | Readonly<{ do: "answer"; record: QueueHead | undefined; round?: QueueRound }>
  | Readonly<{ do: "release"; record: QueueHead }>
  | Readonly<{ do: "read-runs"; known: QueueHead & { retry: QueueRetry } }>
  | Readonly<{ do: "read-failure"; removal: QueueRemoval; count: number; prior: QueueHead | undefined }>
  | Readonly<{ do: "read-jobs"; known: QueueHead; removal: QueueRemoval; count: number }>
  | Readonly<{ do: "rerun-jobs"; addresses: readonly string[]; runs: readonly number[]; seen: FailedRead }>
  | Readonly<{ do: "record-flakes"; head: string; candidates: readonly FlakeCandidate[]; then: QueueStep }>
  | Readonly<{ do: "ask-arm-bot"; record: QueueHead; because: string }>
  | Readonly<{ do: "hold"; record: QueueHead; count: number; then: AfterHold }>
);

/**
 * What the board has found, fed to {@link queueStep}: a watch, with the record the entry holds; then the answer to the step before it. `why` and `refused` are null when the code host did what was asked, else why it did not; `runs` is null when the
 * runs could not be asked for, and a run the host would not say anything of is null among them; `names` is null when the run behind the removal could not be read. `now` is the caller's clock, read after the step, so the machine reads none.
 */
export type QueueEvent =
  | Readonly<{ on: "watch"; known: QueueHead | undefined }>
  | Readonly<{ on: "released"; record: QueueHead; why: string | null }>
  | Readonly<{ on: "runs"; known: QueueHead & { retry: QueueRetry }; runs: readonly (CiRun | null)[] | null; now: number }>
  | Readonly<{ on: "failure"; seen: FailedRead }>
  | Readonly<{ on: "jobs"; known: QueueHead; count: number; names: readonly string[] | null }>
  | Readonly<{ on: "rerun-jobs"; seen: FailedRead; runs: readonly number[]; refused: string | null; now: number }>
  | Readonly<{ on: "flakes-written"; then: QueueStep }>
  | Readonly<{ on: "armed"; record: QueueHead; because: string; refused: string | null }>
  | Readonly<{ on: "held"; record: QueueHead; count: number; then: AfterHold; why: string | null }>;

type Step<Kind extends QueueStep["do"]> = Extract<QueueStep, { do: Kind }>;
type On<Kind extends QueueEvent["on"]> = Extract<QueueEvent, { on: Kind }>;

const isFailedChecks = ({ reason }: QueueRemoval): boolean => FAILED_CHECKS.test(reason);

/** The removals for failed checks since the head last moved. PURE. */
const failedCount = (queue: PullQueue): number => queue.removals.filter(isFailedChecks).length;

/** The head and the queue of a pull request the watch read both of. */
const headOf = (pull: QueuePull): string => pull.read.head!;
const queueOf = (pull: QueuePull): PullQueue => pull.read.queue!;

/** The answer that holds `record`, with what the log says. PURE. */
const answer = (record: QueueHead | undefined, say: readonly string[] = [], round?: QueueRound): Step<"answer"> => ({ do: "answer", record, ...(say.length === 0 ? {} : { say }), ...(round === undefined ? {} : { round }) });

/** `step` with `lines` said before it. PURE. */
const sayingFirst = (lines: readonly string[], step: QueueStep): QueueStep => (lines.length === 0 ? step : { ...step, say: [...lines, ...(step.say ?? [])] });

/** The card's words for a pull request removed `count` times, naming the jobs that failed, and what is wrong with the hold when something is. PURE. */
export const removedNote = (count: number, jobs: readonly string[], trouble?: string): string =>
  `removed from the merge queue ${count} times${jobs.length === 0 ? "" : `: ${jobs.join(", ")}`}${trouble === undefined ? "" : `, and ${trouble}`}`;

/** The start of the card's line for a pull request the queue removed for the jobs `names` (A11-371). PURE. */
const ejectedNote = (names: readonly string[]): string => `ejected from the merge queue: ${names.join(", ")}`;

/**
 * Whether the pull request is approved at its head as the host says: the newest verdict on the head approves and GitHub's decision does not ask for another. The verdict is anyone's but the workers' own, the board's reviewer
 * included (A11-397): `approvedAtHead` leaves the reviewer out, so that its approval is no person's answer to the worker's feedback, and a pull request only the reviewer approved would never be armed again. A newest verdict
 * that asks for changes refuses it, whoever wrote it, as the card and the wait on a pull request read it. PURE.
 */
const approvedAtHead = ({ approvedAtHead: approved, verdictAtHead, reviewDecision }: QueuePull["read"]): boolean =>
  (approved || verdictAtHead === "approved") && verdictAtHead !== "changes-requested" && (reviewDecision ?? "approved") === "approved";

/** Why the board does not ask the arm bot to arm the pull request again at this record, or null when it may. PURE. */
function noRearmBecause({ canRearm, read }: QueuePull, record: QueueHead): string | null {
  if (!canRearm) return "the code host cannot ask the arm bot";
  if (record.step === "held") return record.held === true ? "it is held from the arm bot" : "it is to be held from the arm bot, which the code host has not done yet";
  if ((record.rearms ?? 0) >= MAX_REARMS) return `the arm bot was asked ${MAX_REARMS} times at this head already`;
  if (!approvedAtHead(read)) return "it is not approved at this head";
  if (read.conflicting) return "it conflicts with its base";
  return null;
}

/** Whether a round was started at the record's head: a record written before A11-295 is a round when it says so and names its jobs. PURE. */
const startedRound = (record: QueueHead): boolean => record.roundStarted === true || (record.step === "round" && record.jobs !== undefined);

/** Whether the record only names a removal for another reason: it has no failed job, so no round was ever owed for it. PURE. */
const isNamedOnly = (record: QueueHead): boolean => record.step === "named" && record.jobs === undefined;

/** `record` without the line the card shows, and without an ask the arm bot refused: the pull request is in the queue. A rerun still to be judged is given up (A11-371): the pull request is queued, and the rerun was made for this head. PURE. */
function withoutNote(record: QueueHead): QueueHead {
  const { note: _note, refused: _refused, retry: _retry, ...rest } = record;
  return record.step === "retrying" ? { ...rest, step: "rearmed" } : rest;
}

/** The re-arms and the rerun a record carries to the next answer at its head. PURE. */
const carriedFrom = (prior: QueueHead | undefined): Pick<QueueHead, "rearms" | "retried"> => {
  const rearms = prior?.rearms ?? 0;
  return { ...(rearms === 0 ? {} : { rearms }), ...(prior?.retried === true ? { retried: true } : {}) };
};

// --- Putting a pull request back in the queue (A11-295) ---

/**
 * Put the pull request back in the queue, for `because` (A11-295). The arm bot is asked once and counted ({@link MAX_REARMS} for a head); it re-reads the pull request itself and arms it only when it is approved and held by nobody. What is NOT asked is said, in the log and on the
 * card, with why: the pull request is held from the arm bot, not approved at this head, conflicts, was armed {@link MAX_REARMS} times at this head already, or the code host cannot ask. For a record of a head a round was started at, this is also the end of that round
 * (`roundEnded`). PURE.
 */
function rearmStep(pull: QueuePull, record: QueueHead, because: string): QueueStep {
  const blocked = noRearmBecause(pull, record);
  if (blocked === null) return { do: "ask-arm-bot", record, because };
  const { refused: _earlier, ...rest } = record;
  const note = `removed from the merge queue: ${because}; not armed again: ${blocked}`;
  const kept = record.step === "held" && record.note !== undefined ? record.note : note;
  return answer({ ...rest, step: record.step === "held" ? "held" : "named", ...(startedRound(record) ? { roundEnded: true } : {}), note: kept }, [`${pull.url} was ${note}`]);
}

/** The record once the arm bot was asked, or the ask was refused: a refused ask is kept (`refused`) and made again by the next watch, and said again only when the reason changed. PURE. */
function onArmed(pull: QueuePull, { record, because, refused }: On<"armed">): QueueStep {
  const { refused: earlier, ...rest } = record;
  if (refused !== null) {
    const note = `removed from the merge queue: ${because}; the arm bot could not be asked to arm it again (${refused}), asked again next watch`;
    return answer({ ...rest, step: "rearmed", refused, note }, earlier === refused ? [] : [`${pull.url} was ${note}`]);
  }
  const rearms = (record.rearms ?? 0) + 1;
  const note = `removed from the merge queue: ${because}; the arm bot was asked to arm it again (${rearms} of ${MAX_REARMS})`;
  return answer({ ...rest, step: "rearmed", rearms, ...(startedRound(record) ? { roundEnded: true } : {}), note }, [`${pull.url} was ${note}`]);
}

// --- The hold from the arm bot (A11-264) ---

/** `record` as it is below the limit, and held from the arm bot at it: then what follows the hold. PURE. */
function holdStep(pull: QueuePull, record: QueueHead, count: number, then: AfterHold): QueueStep {
  return count < HOLD_AFTER ? afterHold(pull, record, then) : { do: "hold", record, count, then };
}

/** What follows the hold, with the record it left. PURE. */
const afterHold = (pull: QueuePull, record: QueueHead, then: AfterHold): QueueStep => ("repeated" in then ? repeatedRest(pull, then.repeated, record) : answer(record, [], then.round));

/** The record of a pull request removed `count` times: the hold put on, or the card saying why it could not be, which the next watch asks again. PURE. */
function onHeld(pull: QueuePull, { record, count, then, why }: On<"held">): QueueStep {
  const said = why !== null ? [`${pull.url} was removed from the merge queue ${count} times with no push between, and could not be held from the arm bot (${why}); the next watch asks again`]
    : record.held === true ? [] : [`${pull.url} was removed from the merge queue ${count} times with no push between: held from the arm bot until its head changes`];
  const held: QueueHead = { ...record, step: "held", removals: count, held: why === null, note: removedNote(count, record.jobs ?? [], why === null ? undefined : `could not be held from the queue (${why})`) };
  return sayingFirst(said, afterHold(pull, held, then));
}

/** The hold of a head the pull request moved off: lifted, and the watch goes on as at a head never answered; or kept, with the card saying why, so the next watch asks again (the label must not stay on a head nobody removed from the queue). PURE. */
function onReleased(pull: QueuePull, { record, why }: On<"released">): QueueStep {
  if (why === null) return sayingFirst([`${pull.url} has a new head, so the hold from the merge queue is lifted`], atHead(pull, undefined));
  const stuck: QueueHead = { ...record, note: removedNote(record.removals, record.jobs ?? [], `the hold could not be lifted after the push (${why})`) };
  return answer(stuck, [`${pull.url} has a new head, but the hold from the merge queue could not be lifted (${why}); the next watch asks again`]);
}

// --- A removal for failed checks ---

/** The names of the failed jobs a removal's round is about. PURE. */
const namesOf = ({ jobs }: FailedRead): string[] => jobs.map(({ job }) => job.name);

/** The reasons the infrastructure failed the jobs, joined. PURE. */
const reasonsOf = (jobs: readonly ReadJob[]): string => [...new Set(jobs.map(({ check }) => check.infrastructure))].join(" and ");

/**
 * The answer to the newest removal of a pull request after a failed `merge_group` run, once its run and logs are read. When every failed job failed for an infrastructure reason (before the code ran) the pull request is put back in the queue, with no round, up to
 * {@link MAX_REARMS} times for a head and never at the removal that holds it. Otherwise the jobs are rerun once before any worker is asked (A11-371), or a round is started with the jobs' error lines: the third removal at a head is that round, whatever failed. A code host that
 * cannot ask the arm bot names an infrastructure removal for a person, as before. PURE.
 */
function onFailure(pull: QueuePull, seen: FailedRead): QueueStep {
  const { count, prior, jobs } = seen;
  const names = namesOf(seen);
  const own = jobs.filter(({ check }) => check.infrastructure === null);
  const infrastructure = jobs.filter(({ check }) => check.infrastructure !== null);
  if (own.length === 0 && infrastructure.length > 0) {
    const because = `${names.join(", ")} failed for an infrastructure reason (${reasonsOf(infrastructure)})`;
    if (!pull.canRearm) {
      const note = `removed from the merge queue: ${because}`;
      return sayingFirst([`${note} (${pull.url})`], holdStep(pull, { head: headOf(pull), step: "named", removals: count, jobs: names, note }, count, {}));
    }
    if (count < HOLD_AFTER && (prior?.rearms ?? 0) < MAX_REARMS) return rearmStep(pull, { head: headOf(pull), step: "rearmed", removals: count, jobs: names, ...carriedFrom(prior) }, because);
  }
  return own.length > 0 && prior?.retried !== true ? retryOrRound(pull, seen) : roundStep(pull, seen);
}

/** The round for a removal after a failed `merge_group` run, held at the {@link HOLD_AFTER}th. A removal the board already reran the jobs of is on the card as sent to the run, so a pull request that is approved and out of the queue is never shown as idle (A11-371). PURE. */
function roundStep(pull: QueuePull, seen: FailedRead): QueueStep {
  const { count, prior } = seen;
  const names = namesOf(seen);
  const sent = prior?.retried === true ? { note: `${ejectedNote(names)}, sent to the run` } : {};
  const record: QueueHead = { head: headOf(pull), step: "round", removals: count, jobs: names, roundStarted: true, ...carriedFrom(prior), ...sent };
  return holdStep(pull, record, count, { round: { kind: "fix", seen, rearms: prior?.rearms ?? 0, willRearm: pull.canRearm && count < HOLD_AFTER } });
}

/** The id of the run a job's page belongs to (`.../actions/runs/<id>/job/<id>`), or null for an address that names no job, which the code host leaves out of a rerun. PURE. */
function runIdOf(detailsUrl: string): number | null {
  const id = /\/actions\/runs\/(\d+)\/job\/\d+/.exec(detailsUrl)?.[1];
  return id === undefined ? null : Number(id);
}

/** Whether a rerun of the merge group's jobs could be made and judged: the run names a failed job, the code host can read a run's conclusion, and the removal is not the one that holds the pull request. PURE. */
const canRetry = (pull: QueuePull, failure: QueueFailure, count: number): boolean => failure.jobs.length > 0 && pull.canReadRuns && count < HOLD_AFTER;

/**
 * THE RERUN OF A MERGE GROUP'S FAILED JOBS, made once for a head before any worker is asked (A11-371), or the round as before when the jobs are not rerun: the code host cannot read a run's conclusion, so a rerun could not be judged; the run behind the removal could not be read
 * or names no job; the removal is the {@link HOLD_AFTER}th; or the arm bot would not be asked once the jobs pass (the pull request is not approved at its head, conflicts, is held or has used its re-arms), which is said. PURE.
 */
function retryOrRound(pull: QueuePull, seen: FailedRead): QueueStep {
  const { failure, count, prior } = seen;
  if (failure === null || !canRetry(pull, failure, count)) return roundStep(pull, seen);
  const blocked = noRearmBecause(pull, { head: headOf(pull), step: "rearmed", removals: count, ...carriedFrom(prior) });
  if (blocked !== null) return sayingFirst([`the failed jobs of the merge group behind ${pull.url} are not rerun: ${blocked}`], roundStep(pull, seen));
  const addresses = failure.jobs.map(({ detailsUrl }) => detailsUrl);
  const runs = addresses.map(runIdOf).filter((id): id is number => id !== null);
  if (runs.length !== addresses.length) return roundStep(pull, seen);
  return { do: "rerun-jobs", addresses, runs: [...new Set(runs)], seen };
}

/** The rerun the code host took, which the board waits on with the tests that failed, for the flake log; or refused, which is said, and the round starts. PURE. */
function onRerunJobs(pull: QueuePull, { seen, runs, refused, now }: On<"rerun-jobs">): QueueStep {
  if (refused !== null) return sayingFirst([`the failed jobs of the merge group behind ${pull.url} could not be rerun (${refused}): a round is started`], roundStep(pull, seen));
  const { count, prior, jobs } = seen;
  const names = namesOf(seen);
  const candidates = jobs.filter(({ check }) => check.infrastructure === null).map(({ job, check }) => ({ test: failedTestOf(check), check: job.name, run: job.detailsUrl }));
  const note = `${ejectedNote(names)}, retrying`;
  const record: QueueHead = { head: headOf(pull), step: "retrying", removals: count, jobs: names, retried: true, ...carriedFrom(prior), retry: { at: now, runs, candidates }, note };
  return answer(record, [`${note} (${pull.url}): the failed jobs of its merge group were rerun before a worker is asked`]);
}

// --- The end of the rerun (A11-371) ---

/**
 * What the rerun of a merge group's jobs came to: `passed` when every run rerun has concluded green (a green read can only be the rerun's, since the runs were red); `failed` when one concluded otherwise, believed only once {@link RERUN_SETTLE_MS} have passed since the rerun,
 * because a read just after it can still show the failure that was rerun; else `waiting`, which is also what a run the host would not say anything of is. PURE.
 */
function rerunVerdict(at: number, runs: readonly (CiRun | null)[] | null, now: number): "passed" | "failed" | "waiting" {
  if (runs === null || runs.some((run) => run === null || run.status !== "completed")) return "waiting";
  if (runs.every((run) => run?.conclusion === "success")) return "passed";
  return now - at >= RERUN_SETTLE_MS ? "failed" : "waiting";
}

/** The newest removal sent to the run (A11-371): a removal for failed checks is answered as a first one is, with the record of the rerun; any other is answered as such, with the rerun spent for this head. PURE. */
function toTheRun(pull: QueuePull, known: QueueHead): QueueStep {
  const queue = queueOf(pull);
  const newest = queue.removals.at(-1)!;
  const count = failedCount(queue);
  return isFailedChecks(newest) ? { do: "read-failure", removal: newest, count, prior: known } : answerOther(pull, newest, count, { retried: true });
}

/** A record that says `retrying`, at a watch: the runs are read unless the pull request was removed again meanwhile (someone armed it by hand), or for another reason, which goes to the run. PURE. */
function onRetrying(pull: QueuePull, known: QueueHead): QueueStep {
  const queue = queueOf(pull);
  const { retry } = known;
  if (retry === undefined || failedCount(queue) > known.removals || !isFailedChecks(queue.removals.at(-1)!)) return toTheRun(pull, known);
  return { do: "read-runs", known: { ...known, retry } };
}

/**
 * THE END OF THE RERUN (A11-371). Passed: each failed test is written to the flake log, and the arm bot is asked to arm the pull request again, once for the head. Failed, or still not concluded {@link RETRY_WAIT_MS} after the rerun: the round starts, with the failing test quoted.
 * Still running: the record stays, and its card line says it is retrying. PURE.
 */
function onRuns(pull: QueuePull, { known, runs, now }: On<"runs">): QueueStep {
  const { retry } = known;
  const names = known.jobs ?? [];
  const verdict = rerunVerdict(retry.at, runs, now);
  if (verdict === "failed") return sayingFirst([`${ejectedNote(names)}: the rerun did not pass (${pull.url})`], toTheRun(pull, known));
  if (verdict === "waiting") {
    if (now - retry.at < RETRY_WAIT_MS) return answer(known);
    return sayingFirst([`${ejectedNote(names)}: the rerun had not concluded ${RETRY_WAIT_MS / 60_000} minutes after it was made (${pull.url})`], toTheRun(pull, known));
  }
  const { retry: _retry, note: _note, ...rest } = known;
  return { do: "record-flakes", head: known.head, candidates: retry.candidates, then: rearmStep(pull, { ...rest, step: "rearmed", rerunPassed: true }, `${names.join(", ")} passed on rerun`) };
}

// --- The other removals ---

/** The card's words for a removal the board does not answer: its reason, and who removed it when that was not the queue. PURE. */
function namedNote({ reason, actor }: QueueRemoval): string {
  const by = actor === null || QUEUE_ACTOR.test(actor) ? "" : ` by ${actor}`;
  return `removed from the merge queue${by}: ${reason}`;
}

/** The answer to the newest removal of a pull request when it is not one for failed checks: a conflict starts a round, any other reason is named on the card and starts none; `retried` says the head's rerun was made already (A11-371). PURE. */
function answerOther(pull: QueuePull, removal: QueueRemoval, count: number, retried: Pick<QueueHead, "retried"> = {}): QueueStep {
  const head = headOf(pull);
  if (CONFLICT.test(removal.reason)) return holdStep(pull, { head, step: "round", removals: count, ...retried }, count, { round: { kind: "conflict", removal } });
  const note = namedNote(removal);
  return sayingFirst([`${note} (${pull.url})`], holdStep(pull, { head, step: "named", removals: count, note, ...retried }, count, {}));
}

// --- A removal at a head already answered ---

/**
 * A removal at a head the board already answered. It starts no second round, however often it repeats (A11-154), with one exception: a head answered with a re-arm that no round was started at (A11-295), whose next removal is answered as a first one is. The removals are counted, and
 * the {@link HOLD_AFTER}th for failed checks with no push between holds the pull request from the arm bot (a hold the code host refused is asked for again), naming the jobs of the newest removal's run. PURE.
 */
function onRepeated(pull: QueuePull, known: QueueHead): QueueStep {
  const queue = queueOf(pull);
  const newest = queue.removals.at(-1)!;
  const count = failedCount(queue);
  if (known.step === "rearmed" && !startedRound(known)) {
    if (!isFailedChecks(newest)) return namedIfSilent(pull, known, newest);
    if (count > known.removals) return { do: "read-failure", removal: newest, count, prior: known };
    return known.refused === undefined ? answer(known) : rearmStep(pull, known, STILL_OUT);
  }
  if (count < HOLD_AFTER) return repeatedRest(pull, known, known.removals === count ? known : { ...known, removals: count });
  if (known.held === true && known.removals === count) return repeatedRest(pull, known, known);
  if (known.removals === count) return holdStep(pull, known, count, { repeated: known });
  return isFailedChecks(newest) ? { do: "read-jobs", known, removal: newest, count } : holdStep(pull, { ...known, jobs: known.jobs ?? [] }, count, { repeated: known });
}

/** Whether the card shows nothing for a record: it is no round, and its line was cleared when the pull request went back in the queue. PURE. */
const showsNothing = (record: QueueHead): boolean => record.note === undefined && record.step !== "round";

/**
 * The answer to a removal for another reason (a conflict, a person) at a head already answered, once it is counted and held: `record`, and when it shows nothing, since the pull request went back in the queue, the card names the removal and the log says it, the rest of the
 * record standing, so the pull request never sits out of the queue with no reason shown (A11-437). PURE.
 */
function namedIfSilent(pull: QueuePull, record: QueueHead, removal: QueueRemoval): QueueStep {
  if (!showsNothing(record)) return answer(record);
  const note = namedNote(removal);
  return answer({ ...record, note }, [`${note} (${pull.url})`]);
}

/** The jobs of the newest removal's run, for the hold, or the ones already known when the code host cannot say. PURE. */
const onJobs = (pull: QueuePull, { known, count, names }: On<"jobs">): QueueStep =>
  holdStep(pull, { ...known, jobs: names ?? known.jobs ?? [] }, count, { repeated: known });

/**
 * The rest of a removal at a head the board answered with a round, once it is counted (`record`): the pull request goes back in the queue when the round ends (the head unmoved, the pull request out of the queue), and again after each removal that follows, until the re-arms
 * are spent or the hold stops them. PURE.
 */
function repeatedRest(pull: QueuePull, known: QueueHead, record: QueueHead): QueueStep {
  const queue = queueOf(pull);
  const count = failedCount(queue);
  const newest = queue.removals.at(-1)!;
  if (!isFailedChecks(newest)) return namedIfSilent(pull, record, newest);
  if (!startedRound(known) || !pull.roundOver) return answer(record);
  const marked: QueueHead = { ...record, roundStarted: true };
  if (record.roundEnded !== true) return rearmStep(pull, marked, "its round ended with no push and it is still out of the queue");
  if (count <= known.removals && record.refused === undefined) return answer(record);
  return rearmStep(pull, marked, count > known.removals ? "it was removed again after its round" : STILL_OUT);
}

// --- A watch ---

/** A watch at a head the record is for, or with no record: a queued pull request the board put back says so no more; else the newest removal is answered, as a first one or as a repeat. PURE. */
function atHead(pull: QueuePull, known: QueueHead | undefined): QueueStep {
  const queue = queueOf(pull);
  const newest = queue.removals.at(-1);
  // A pull request the board put back in the queue is in it: the card stops saying it was asked to be (the re-arms stay counted for the head).
  if (queue.queued && (known?.step === "rearmed" || known?.step === "retrying")) return answer(withoutNote(known));
  if (queue.queued || newest === undefined) return answer(known);
  // A head that was only named for another reason (no round, no failed job) is still owed the round a removal for failed checks gets.
  const named = known !== undefined && isNamedOnly(known) && isFailedChecks(newest) ? known : undefined;
  const current = named === undefined ? known : undefined;
  if (current?.step === "retrying") return onRetrying(pull, current);
  if (current !== undefined) return onRepeated(pull, current);
  const count = failedCount(queue);
  return isFailedChecks(newest) ? { do: "read-failure", removal: newest, count, prior: named?.retried === true ? named : undefined } : answerOther(pull, newest, count);
}

/** A watch of the pull request: a host that does not say (no head, or no timeline) keeps the record; a head the pull request moved off has its hold lifted first. PURE. */
function onQueueWatch(pull: QueuePull, known: QueueHead | undefined): QueueStep {
  const { head, queue } = pull.read;
  if (head === null || queue === undefined) return answer(known);
  if (known === undefined || known.head === head) return atHead(pull, known);
  return known.held === true ? { do: "release", record: known } : atHead(pull, undefined);
}

/**
 * THE TRANSITION OF A PULL REQUEST'S REMOVALS FROM THE MERGE QUEUE (A11-264, A11-295, A11-371). `pull` is the pull request as the watch read it; `event` is the watch, with the record the entry holds, or the answer to the step before. The step says what to do next, and a step
 * that is not `answer` is answered by the next event. PURE: it reads no file, network or clock.
 */
export function queueStep(pull: QueuePull, event: QueueEvent): QueueStep {
  switch (event.on) {
    case "watch": return onQueueWatch(pull, event.known);
    case "released": return onReleased(pull, event);
    case "runs": return onRuns(pull, event);
    case "failure": return onFailure(pull, event.seen);
    case "jobs": return onJobs(pull, event);
    case "rerun-jobs": return onRerunJobs(pull, event);
    case "flakes-written": return event.then;
    case "armed": return onArmed(pull, event);
    case "held": return onHeld(pull, event);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The settle states (A11-173, A11-179): step 3 of 3
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * What a review round's `done` does with its ticket, from {@link settleStep}: `complete` it now, since every pull request of the run merged or closed and one merged; `ask` a person, since every one closed unmerged and nothing was built;
 * or `wait` for the merge of the pull requests still open, or not yet read, and `reason` says which.
 */
export type SettleStep = Readonly<{ do: "complete" }> | Readonly<{ do: "wait" | "ask"; reason: string }>;

/**
 * THE SETTLE OF A RUN BY ITS PULL REQUESTS (A11-173). `entry` is the run, whose own pull requests are judged; `states` is what the tracker read of them, by address. Every one merged or closed, with one merged, completes the ticket; every one closed
 * unmerged asks a person; else the run waits for the ones still open or unread, which the reason names. PURE: it reads no file, network or clock.
 */
export function settleStep(entry: ViewEntry, states: Readonly<Record<string, PullState>>): SettleStep {
  const read = { ...entry, pullStates: states };
  const settled = settledByPulls(read);
  if (settled === "completed") return { do: "complete" };
  if (settled === "cancelled") return { do: "ask", reason: "its pull requests were closed without merging" };
  const open = openPulls(read).map(({ url }) => url);
  return { do: "wait", reason: open.length === 0 ? "it has no pull request to settle it" : `${open.join(", ")} not merged or closed yet: the ticket completes when they merge` };
}

/**
 * What a read says of a head's review for readiness (A11-179), or undefined when the code host did not say: `none` when no review sits at the head, whatever GitHub's decision says, `approved` when the newest verdict on the head approves it
 * and GitHub's review decision is approved or needs none, `changes-requested` when a verdict is there and either asks for changes, and `none` otherwise, which is also a branch whose decision still asks for a review. GitHub's decision
 * follows the pull request and not the commit (A11-340): it stays `changes-requested` after a push to a head nobody has reviewed, so it says nothing of a head without a verdict. PURE.
 */
export function reviewAtHead(read: Pick<PullFeedback, "verdictAtHead" | "reviewDecision">): PullHead["review"] {
  if (read.verdictAtHead === undefined || read.reviewDecision === undefined) return undefined;
  if (read.verdictAtHead === null) return "none";
  if (read.reviewDecision === "changes-requested" || read.verdictAtHead === "changes-requested") return "changes-requested";
  return read.verdictAtHead === "approved" && (read.reviewDecision === "approved" || read.reviewDecision === null) ? "approved" : "none";
}
