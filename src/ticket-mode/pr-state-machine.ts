// @ts-check
// module: the pull request's check states as one pure state machine (A11-437, step 1 of 3) -- what the board does next about the red and the cancelled checks of a pull request at its head, from the record it holds and what it read: wait (and why), read, rerun, start a round or name a person. It reads no file, network or clock: the caller does what a step names and feeds the result back
//
// THE RERUN BOUNDS. A red check is rerun at one head for three reasons: before a worker is asked, when the code failed it (A11-300); when the worker's reply after a round says the failure is not its change's (A11-300); and when its log shows the
// infrastructure failing (A11-154). Red again after the rerun for its reason, it is named for a person. The record of a head keeps only its last answer, so an infrastructure rerun can come again after the rerun a reply asked for, but a round's
// replies are read once for a head (`PoolContext.repliesRead`), so the reruns of one check at one head are at most {@link RED_RERUNS_PER_HEAD}. A cancelled required run that blocks an approved, armed pull request is rerun at most {@link MAX_CANCELLED_RERUNS} times for a head (A11-342, A11-403),
// and a refused rerun is asked again at most {@link MAX_REFUSALS} times. `pr-state-machine.test.ts` feeds random event sequences to these functions and checks the bounds, that every wait gives a reason, and that each end state is reachable.
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import type { CheckHead } from "./board-view/view-types-and-filters.ts";
import type { FlakeCandidate, RerunRecord } from "./board-view/check-rerun-record.ts";
import { MAX_CANCELLED_RUNS } from "./board-view/cancelled-rerun-words.ts";
import { failedTestOf } from "./failure-words.ts";

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
