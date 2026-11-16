// @ts-check
// module: the pool's merge queue removals -- which removals of a finished run's pull requests the board answers, once for each head: a failed `merge_group` run starts a fix round, a conflict starts a conflict round, any other reason is named, and a pull request removed three times with no push between is held from the arm bot (A11-264); a removal the change did not cause, and a round that ends with no push, put the pull request back in the queue (A11-295)
//
// THE CHECKS ON A PULL REQUEST'S HEAD CAN BE GREEN WHILE THE QUEUE REMOVES IT. The merge queue runs the checks on the result of merging the pull request into the base (the `merge_group` run), so a check that came to the base with another pull request fails only there, and `answerChecks` (A11-154)
// never sees it. Measured 2026-10-25 on a11ign/announcement-emulator#18: approved, `gate` green on its head, removed three times for `failed_checks`, and the arm bot armed it again each time because nothing had changed.
//
// A REMOVAL IS NOT ALWAYS THE CHANGE'S (A11-295). On 2026-10-26 a11ign/agent-org#1939, approved and armed, was removed because the `merge_group` run's install could not find a package version published minutes before (`ETARGET`). The board started a round, the worker found
// nothing to change and ended without a push, and nothing armed the pull request again: it sat approved and out of the queue for 75 minutes. Two things are the board's now. A removal whose failed jobs all failed before the code ran (an install or registry error, a lost
// runner, a job that could not be set up) asks the arm bot to arm the pull request again, with no round, up to {@link MAX_REARMS} times for a head. And a round that ends with the head unmoved and the pull request out of the queue asks the arm bot too, or says in the log why it did not.
//
// A FLAKY TEST IS NOT A ROUND (A11-371). On 2026-10-28 agent-org#1983, approved and clean, was removed because one `ui` test failed in the `merge_group` run; the same test passed on the pull request's own checks, and the pull request sat out of the queue for six hours. The
// first removal for a failed job of the code's is now answered by a RERUN of the merge group's failed jobs, with no worker asked: when they pass the test is recorded as a flake (A11-300) and the arm bot is asked to arm the pull request again, once; when they fail again, or the pull request is
// removed again at the same head, a round starts and quotes the failing test. The card says "ejected from the merge queue: <job>, retrying" while the rerun runs, and "... sent to the run" once the run has it.
//
// THE RULES ARE THE STATE MACHINE'S (A11-437, step 2 of 3). What the board does about a removal is decided by `queueStep` (`pr-state-machine.ts`), which reads nothing; this module makes the reads, the rerun, the asks of the arm bot and the label calls a step
// names, feeds each answer back, and briefs the round the machine starts.
import { isRollUpCheck } from "../newest-check-run.ts";
import type { CiRun, PullFeedback, QueueFailure, QueueFailureJob, QueueRemoval } from "../plugins/contracts/code-host.ts";
import type { QueueHead } from "./board-view/queue-head.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import { failedTestOf } from "./failure-words.ts";
import { infrastructureCause, QUOTED_LINES, readCheck, registryCause } from "./pool-checks.ts";
import type { PoolContext } from "./pool-context.ts";
import { log, messageOf } from "./pool-state.ts";
import { type FailedRead, queueStep, type QueueEvent, type QueuePull, type QueueRound, type QueueStep, type ReadJob } from "./pr-state-machine.ts";
import { stackMergeRequestOf } from "./stack-merge.ts";
import { conflictLine } from "./worker-files.ts";

export { HOLD_AFTER, MAX_REARMS } from "./pr-state-machine.ts";

/** The step of a job that GitHub runs to bring a runner up: a job that failed there never ran the code. */
const SET_UP_JOB = "Set up job";

/** A pull request the watch read open. */
type Pull = Readonly<{ url: string; read: PullFeedback }>;

/** What a pass over one pull request's removals found: the lines of a fix round or of a conflict round, if one is due, and the record the entry should hold for it (none: drop what it held). */
type PullAnswer = Readonly<{ feedback?: string; conflict?: string; record?: QueueHead }>;

/** What a pass over a run's removals found. */
export type QueueAnswer = Readonly<{
  /** The failed `merge_group` runs for the round that answers them, or null: red checks, in kind, so an unwatched run at its round cap is handed to a person with them. */
  feedback: string | null;
  /** The conflicts the queue removed pull requests for, for the round that answers them, or null: conflicts, in kind, so a round is queued only where one is left. */
  conflict: string | null;
  /** Everything the board has answered, for the pull requests still open, with this pass's answers added: the whole record, as the entry should hold it. */
  heads: Readonly<Record<string, QueueHead>>;
  /** The same without the answers that are a round: what is recorded when no round is queued, so a removal whose round did not start is answered again. */
  withoutRound: Readonly<Record<string, QueueHead>>;
}>;

/** A time, as the brief and the card word it: `2026-10-25T12:21:00Z`. */
const timeOf = (at: number): string => new Date(at).toISOString().replace(/\.\d+Z$/, "Z");

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The calls a step names
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What the code host answers a hold or a release of a pull request: whether the label is now as asked. */
type HoldCall = (holdFromQueue: NonNullable<PoolContext["codeHost"]["holdFromQueue"]>) => Promise<boolean>;

/** Ask the code host to change the pull request's hold. Returns why it could not, or null once the label is as asked: a refusal is the board's to say, never a throw. */
async function refusalOf(ctx: PoolContext, call: HoldCall, stillSo: string): Promise<string | null> {
  const { holdFromQueue } = ctx.codeHost;
  if (holdFromQueue === undefined) return "the code host cannot hold a pull request";
  try {
    return (await call(holdFromQueue)) ? null : stillSo;
  } catch (err) {
    return messageOf(err);
  }
}

/** Why the pull request could not be held from the arm bot, or null once it is. */
const holdRefusal = (ctx: PoolContext, url: string): Promise<string | null> => refusalOf(ctx, (holdFromQueue) => holdFromQueue(url, true), "the label is still off");

/** Why the pull request's hold could not be lifted, or null once it is. */
const releaseRefusal = (ctx: PoolContext, url: string): Promise<string | null> => refusalOf(ctx, (holdFromQueue) => holdFromQueue(url, false), "the label is still on");

/** Whether the code host can ask the arm bot to arm a pull request (`auto-arm.yml`'s `arm-approved`, the dispatch the stack merge uses): the arm bot re-reads the pull request and arms it only when it is approved, open and held by nobody. */
const canAskArmBot = (ctx: PoolContext): boolean => ctx.codeHost.requestStackMerge !== undefined;

/** Ask the arm bot to arm the pull request. Returns why it could not be asked, or null once it was: a refusal is the board's to say, never a throw. */
async function armBotRefusal(ctx: PoolContext, url: string): Promise<string | null> {
  try {
    const request = stackMergeRequestOf(url);
    if (request === null) return "it is not a GitHub pull request address";
    await ctx.codeHost.requestStackMerge?.(request);
    return null;
  } catch (err) {
    return messageOf(err);
  }
}

/** The failing `merge_group` run behind a removal, or null when the code host cannot say. */
async function readFailure(ctx: PoolContext, url: string, removal: QueueRemoval): Promise<QueueFailure | null> {
  if (removal.groupCommit === null || ctx.codeHost.readQueueFailure === undefined) return null;
  try {
    return await ctx.codeHost.readQueueFailure(url, removal.groupCommit);
  } catch (err) {
    log(`the merge_group run behind the removal of ${url} could not be read: ${messageOf(err)}`);
    return null;
  }
}

/** The jobs a round is about: a roll-up `gate` among them reports other jobs' results and names no cause, so the jobs behind it are named in its place. PURE. */
function jobsToAnswer(failure: QueueFailure): readonly QueueFailureJob[] {
  const behind = failure.jobs.filter(({ name }) => !isRollUpCheck(name));
  return behind.length > 0 ? behind : failure.jobs;
}

/** Why a job's log shows the infrastructure and not the code failing: what any red check shows, and the package registry (A11-295). */
const queueCause = (log: string): string | null => infrastructureCause(log) ?? registryCause(log);

/**
 * One failing job of the merge group with its log read, and its cause: a job that failed while the runner was set up never ran the code, whatever its log says. A code host that cannot ask the arm bot has nothing to do for such a removal that a round
 * would not do better, so it keeps the causes it knew before A11-295 (a lost runner, a rate limit, a server error, a network error) and a registry error or a failed setup is the code's, as it was.
 */
async function readJob(ctx: PoolContext, job: QueueFailureJob): Promise<ReadJob> {
  const widened = canAskArmBot(ctx);
  const check = await readCheck(ctx, { name: job.name, detailsUrl: job.detailsUrl }, widened ? queueCause : infrastructureCause);
  return { job, check: widened && check.infrastructure === null && job.step === SET_UP_JOB ? { ...check, infrastructure: "the runner could not set the job up" } : check };
}

/** The run behind a removal, and the log of each job a round is about. */
async function readFailed(ctx: PoolContext, url: string, { removal, count, prior }: Extract<QueueStep, { do: "read-failure" }>): Promise<FailedRead> {
  const failure = await readFailure(ctx, url, removal);
  const jobs: ReadJob[] = [];
  for (const job of failure === null ? [] : jobsToAnswer(failure)) jobs.push(await readJob(ctx, job));
  return { removal, count, prior, failure, jobs };
}

/** One read of a run, or null when the host would not say: a throw is a refusal, never an answer. */
async function readRun(ctx: PoolContext, repo: string, id: number): Promise<CiRun | null> {
  try {
    return (await ctx.codeHost.readCiRun?.(repo, id)) ?? null;
  } catch (err) {
    log(`the run ${id} of ${repo} could not be read: ${messageOf(err)}`);
    return null;
  }
}

/** The runs a rerun of a merge group's jobs waits on, or null when the pull request's address names no repository to ask. */
async function readRuns(ctx: PoolContext, url: string, ids: readonly number[]): Promise<(CiRun | null)[] | null> {
  const repo = stackMergeRequestOf(url)?.repo;
  if (repo === undefined) return null;
  const runs: (CiRun | null)[] = [];
  for (const id of ids) runs.push(await readRun(ctx, repo, id));
  return runs;
}

/** Write a passed rerun's tests to the flake log, with its run, the head and the pull request: a log that cannot be written is said and does not keep the pull request out of the queue. */
function recordFlakes(ctx: PoolContext, entry: Entry, url: string, { head, candidates }: Extract<QueueStep, { do: "record-flakes" }>): void {
  const at = ctx.now();
  try {
    ctx.flakes.record(candidates.map((candidate) => ({ ...candidate, head, pull: url, at })));
  } catch (err) {
    log(`${entry.ticket.key}: the flakes of ${url} could not be recorded: ${messageOf(err)}`);
  }
}

/** Make what a step names, and return what the code host answered, as the machine's next event. */
async function perform(ctx: PoolContext, entry: Entry, url: string, step: Exclude<QueueStep, { do: "answer" }>): Promise<QueueEvent> {
  switch (step.do) {
    case "release": return { on: "released", record: step.record, why: await releaseRefusal(ctx, url) };
    case "read-runs": return { on: "runs", known: step.known, runs: await readRuns(ctx, url, step.known.retry.runs), now: ctx.now() };
    case "read-failure": return { on: "failure", seen: await readFailed(ctx, url, step) };
    case "read-jobs": {
      const failure = await readFailure(ctx, url, step.removal);
      return { on: "jobs", known: step.known, count: step.count, names: failure === null ? null : jobsToAnswer(failure).map(({ name }) => name) };
    }
    case "rerun-jobs": return { on: "rerun-jobs", seen: step.seen, runs: step.runs, refused: await ctx.codeHost.rerunFailedChecks(step.addresses), now: ctx.now() };
    case "record-flakes": {
      recordFlakes(ctx, entry, url, step);
      return { on: "flakes-written", then: step.then };
    }
    case "ask-arm-bot": return { on: "armed", record: step.record, because: step.because, refused: await armBotRefusal(ctx, url) };
    case "hold": return { on: "held", record: step.record, count: step.count, then: step.then, why: await holdRefusal(ctx, url) };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The briefs of the rounds
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The lines that name the jobs the code failed, with the error lines of their logs: at most {@link QUOTED_LINES} for all of them. PURE. */
function ownJobLines(own: readonly ReadJob[]): string[] {
  const share = Math.max(1, Math.floor(QUOTED_LINES / own.length));
  return own.flatMap(({ job, check }) => {
    const where = job.step === null ? `${job.name} failed` : `${job.name} failed at step "${job.step}"`;
    if (!check.readable) return [`${where}; its log could not be read.`];
    const quoted = check.lines.slice(-share);
    if (quoted.length === 0) return [`${where}; its log names no error.`];
    return [`${where}:`, ...quoted.map((line) => `  ${line}`)];
  });
}

/** The line that names a job that failed for an infrastructure reason in a round that is not about it. PURE. */
const infrastructureJobLine = ({ job, check }: ReadJob): string =>
  `${job.name} also failed in the merge group for an infrastructure reason (${check.infrastructure}): that is not a fault in your change, so leave it.`;

/** The brief of a round for a removal after a failed `merge_group` run: what happened, which jobs failed and where, and what to do. PURE. */
function failedBrief(pull: Pull, removal: QueueRemoval, failure: QueueFailure | null, read: Readonly<{ own: readonly ReadJob[]; infrastructure: readonly ReadJob[] }>, then: Readonly<{ rearms: number; willRearm: boolean; earlier?: QueueHead }>): string {
  const { url, read: feedback } = pull;
  const base = feedback.base ?? "its base branch";
  const run = failure === null ? "" : ` (${failure.runUrl})`;
  const where = `The failure is on the result of merging it with ${base}, not on its own head${feedback.failing.length === 0 ? ", whose checks are green" : ""}.`;
  const beforeTheCodeOnly = read.own.length === 0 && read.infrastructure.length > 0;
  const named = failure === null ? ["Its merge_group run could not be read, so the failing job is not named."]
    : failure.jobs.length === 0 ? ["The run names no failing job."]
      : read.own.length === 0 ? ownJobLines(read.infrastructure) : [...ownJobLines(read.own), ...read.infrastructure.map(infrastructureJobLine)];
  const closing = beforeTheCodeOnly ? beforeTheCode(base, then.rearms) : `Merge ${base} in, reproduce the failure, fix it, and push.`;
  return [`${url} was removed from the merge queue at ${timeOf(removal.at)} because its merge_group run failed${run}. ${where}`, ...rerunLines(then.earlier, read.own), ...named, closing, ...(then.willRearm ? [WHEN_NOTHING_TO_FIX] : [])].join("\n");
}

/** What a round is told of the rerun the board made before it (A11-371), and the test that failed: nothing when the board made none. PURE. */
function rerunLines(earlier: QueueHead | undefined, own: readonly ReadJob[]): string[] {
  if (earlier?.retried !== true) return [];
  const said = earlier.rerunPassed === true ? "The board reran the failed jobs once and they passed, so it asked the arm bot to queue the pull request again; the queue removed it again."
    : earlier.step === "retrying" ? "The board reran the failed jobs and they did not pass."
      : "The board reran the failed jobs once before; the queue removed the pull request again.";
  return [said, ...own.map(({ job, check }) => `The failing test in ${job.name}: ${failedTestOf(check)}`)];
}

/** What a round is told when every failed job failed before the code ran and the board is not asking the arm bot to arm the pull request again: how often it did. PURE. */
const beforeTheCode = (base: string, rearms: number): string =>
  `Every job that failed did so before your code ran${rearms === 0 ? "" : `, and the pull request was removed again after the board asked the arm bot to arm it ${rearms} ${rearms === 1 ? "time" : "times"}`}. ` +
  `Read the logs: if something in the change causes it (a version the registry does not list, say), merge ${base} in, fix it, and push.`;

/** The last line of a round for a removal: a round that finds nothing to change ends without a push, and the board then asks the arm bot to arm the pull request again. */
const WHEN_NOTHING_TO_FIX = "If nothing in your change causes it, push nothing and say so: the board asks the arm bot to arm the pull request again.";

/** The brief of a round for a removal because the pull request conflicts with its base: the sentence a conflict round is recognised by (`conflictLine`), then why the queue named it. PURE. */
function conflictBrief({ url, read }: Pull, removal: QueueRemoval): string {
  const base = read.base ?? "its base branch";
  return [conflictLine(url, read.base), `The merge queue removed it at ${timeOf(removal.at)} because of it (${removal.reason}). Merge ${base} in, resolve the conflict, and push.`].join("\n");
}

/** The lines of the round the machine started, as a fix round or as a conflict round. PURE. */
function briefOf(pull: Pull, round: QueueRound | undefined): Pick<PullAnswer, "feedback" | "conflict"> {
  if (round === undefined) return {};
  if (round.kind === "conflict") return { conflict: conflictBrief(pull, round.removal) };
  const { removal, failure, jobs, prior } = round.seen;
  const read = { own: jobs.filter(({ check }) => check.infrastructure === null), infrastructure: jobs.filter(({ check }) => check.infrastructure !== null) };
  return { feedback: failedBrief(pull, removal, failure, read, { rearms: round.rearms, willRearm: round.willRearm, earlier: prior }) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// One pull request
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Whether the round the board started for a removal is over and left the pull request where it was: the run is finished with a worker that is neither waiting on a person's answer (`needs-human`) nor handed back at the round cap (`handedBack`), both of which
 * are a person's to decide and are not the board's to override by arming the pull request. PURE.
 */
const roundIsOver = (entry: Entry): boolean => entry.handedBack === undefined && entry.outcome?.kind !== "needs-human";

/** The pull request as the machine reads it. PURE. */
const queuePullOf = (ctx: PoolContext, entry: Entry, { url, read }: Pull): QueuePull =>
  ({ url, read, canRearm: canAskArmBot(ctx), canReadRuns: ctx.codeHost.readCiRun !== undefined, roundOver: roundIsOver(entry) });

/** The answer for one open pull request, given the record the entry holds for it: the machine's steps, made one after the other until it answers, each step's lines logged first. */
async function answerPull(ctx: PoolContext, entry: Entry, pull: Pull, known: QueueHead | undefined): Promise<PullAnswer> {
  const seen = queuePullOf(ctx, entry, pull);
  let step = queueStep(seen, { on: "watch", known });
  for (;;) {
    for (const line of step.say ?? []) log(`${entry.ticket.key}: ${line}`);
    if (step.do === "answer") return { ...briefOf(pull, step.round), record: step.record };
    step = queueStep(seen, await perform(ctx, entry, pull.url, step));
  }
}

/**
 * Answer the merge queue's removals of a finished run's open pull requests (A11-264): each pull request the queue removed since its head last moved, at a head the board has not answered. A removal for failed checks is briefed with the failing job and step and their error
 * lines from the `merge_group` run; a conflict is briefed as a conflict; any other reason is named on the card. The pull requests that are no longer open, and the heads a pull request has moved off, are dropped from the record, and the hold from the arm bot is lifted for a head that moved.
 * The effects are the reads of the run and the logs, and the label; the record is returned, for the caller to write with the round it queues.
 */
export async function answerQueue(ctx: PoolContext, entry: Entry, open: readonly Pull[]): Promise<QueueAnswer> {
  const feedback: string[] = [];
  const conflict: string[] = [];
  let heads: Record<string, QueueHead> = {};
  let withoutRound: Record<string, QueueHead> = {};
  for (const pull of open) {
    const answer = await answerPull(ctx, entry, pull, entry.queueHeads?.[pull.url]);
    if (answer.feedback !== undefined) feedback.push(answer.feedback);
    if (answer.conflict !== undefined) conflict.push(answer.conflict);
    const asRecord = answer.record === undefined ? {} : { [pull.url]: answer.record };
    heads = { ...heads, ...asRecord };
    withoutRound = { ...withoutRound, ...(answer.feedback !== undefined || answer.conflict !== undefined ? {} : asRecord) };
  }
  return { feedback: feedback.length === 0 ? null : feedback.join("\n"), conflict: conflict.length === 0 ? null : conflict.join("\n"), heads, withoutRound };
}
