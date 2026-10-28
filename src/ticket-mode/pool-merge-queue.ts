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
import { isRollUpCheck } from "../newest-check-run.ts";
import type { CiRun, PullFeedback, PullQueue, QueueFailure, QueueFailureJob, QueueRemoval } from "../plugins/contracts/code-host.ts";
import type { QueueHead, QueueRetry } from "./board-view/queue-head.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import { failedTestOf } from "./failure-words.ts";
import type { Flake } from "./flakes.ts";
import { infrastructureCause, QUOTED_LINES, readCheck, registryCause, type ReadCheck } from "./pool-checks.ts";
import type { PoolContext } from "./pool-context.ts";
import { log, messageOf } from "./pool-state.ts";
import { stackMergeRequestOf } from "./stack-merge.ts";
import { conflictLine } from "./worker-files.ts";

/** How many removals for failed checks, with no push between, the board puts up with before it holds the pull request from the arm bot: the ticket says "more than twice". */
export const HOLD_AFTER = 3;

/** How many times the board asks the arm bot to arm a pull request again at one head, for a removal the change did not cause or a round that pushed nothing: the ticket says "at most two re-arms per head". */
export const MAX_REARMS = 2;

/** How long after a rerun a run that still reads failed is read as the failure that was rerun and not as the rerun failing again: GitHub's read can lag the rerun by a few seconds (`pool-checks.ts` keeps the same bound for a pull request's own checks). */
const RETRY_SETTLE_MS = 5 * 60_000;

/** The longest the board waits for the rerun of a merge group's jobs before it asks a worker anyway: the pull request must not sit out of the queue for more than half an hour (A11-371). */
const RETRY_WAIT_MS = 30 * 60_000;

/** The step of a job that GitHub runs to bring a runner up: a job that failed there never ran the code. */
const SET_UP_JOB = "Set up job";

/** The reason the queue gives for a removal after a failed `merge_group` run. */
const FAILED_CHECKS = /^failed_checks$/i;
/** The reasons that are a merge conflict. */
const CONFLICT = /conflict/i;
/** The account the queue itself removes as: a removal by anyone else is a person's decision. */
const QUEUE_ACTOR = /^github-merge-queue(?:\[bot\])?$/i;

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

const isFailedChecks = ({ reason }: QueueRemoval): boolean => FAILED_CHECKS.test(reason);

/** A time, as the brief and the card word it: `2026-10-25T12:21:00Z`. */
const timeOf = (at: number): string => new Date(at).toISOString().replace(/\.\d+Z$/, "Z");

/** The card's words for a pull request removed `count` times, naming the jobs that failed, and what is wrong with the hold when something is. PURE. */
const removedNote = (count: number, jobs: readonly string[], trouble?: string): string =>
  `removed from the merge queue ${count} times${jobs.length === 0 ? "" : `: ${jobs.join(", ")}`}${trouble === undefined ? "" : `, and ${trouble}`}`;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The hold from the arm bot
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What the code host answers a hold or a release of a pull request: whether the label is now as asked. */
type HoldCall = (holdFromQueue: NonNullable<PoolContext["codeHost"]["holdFromQueue"]>) => boolean;

/** Ask the code host to change the pull request's hold. Returns why it could not, or null once the label is as asked: a refusal is the board's to say, never a throw. */
function refusalOf(ctx: PoolContext, call: HoldCall, stillSo: string): string | null {
  const { holdFromQueue } = ctx.codeHost;
  if (holdFromQueue === undefined) return "the code host cannot hold a pull request";
  try {
    return call(holdFromQueue) ? null : stillSo;
  } catch (err) {
    return messageOf(err);
  }
}

/** Why the pull request could not be held from the arm bot, or null once it is. */
const holdRefusal = (ctx: PoolContext, url: string): string | null => refusalOf(ctx, (holdFromQueue) => holdFromQueue(url, true), "the label is still off");

/** Why the pull request's hold could not be lifted, or null once it is. */
const releaseRefusal = (ctx: PoolContext, url: string): string | null => refusalOf(ctx, (holdFromQueue) => holdFromQueue(url, false), "the label is still on");

/** The record of a pull request removed `count` times: the hold put on, or the card saying why it could not be. */
function holdRecord(ctx: PoolContext, entry: Entry, url: string, record: QueueHead, count: number): QueueHead {
  const why = holdRefusal(ctx, url);
  const jobs = record.jobs ?? [];
  if (why !== null) log(`${entry.ticket.key}: ${url} was removed from the merge queue ${count} times with no push between, and could not be held from the arm bot (${why}); the next watch asks again`);
  else if (record.held !== true) log(`${entry.ticket.key}: ${url} was removed from the merge queue ${count} times with no push between: held from the arm bot until its head changes`);
  return { ...record, step: "held", removals: count, held: why === null, note: removedNote(count, jobs, why === null ? undefined : `could not be held from the queue (${why})`) };
}

/**
 * Release the hold of a pull request whose head has moved off the one it was held at. Null once it is released, or when it was never on; the record again, with the card saying why, when the code host would not, so the
 * next watch asks again (the label is the arm bot's stop, and it must not stay on a head nobody removed from the queue).
 */
function released(ctx: PoolContext, entry: Entry, url: string, record: QueueHead): QueueHead | null {
  if (record.held !== true) return null;
  const why = releaseRefusal(ctx, url);
  if (why === null) {
    log(`${entry.ticket.key}: ${url} has a new head, so the hold from the merge queue is lifted`);
    return null;
  }
  log(`${entry.ticket.key}: ${url} has a new head, but the hold from the merge queue could not be lifted (${why}); the next watch asks again`);
  return { ...record, note: removedNote(record.removals, record.jobs ?? [], `the hold could not be lifted after the push (${why})`) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Putting a pull request back in the queue (A11-295)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Whether the code host can ask the arm bot to arm a pull request (`auto-arm.yml`'s `arm-approved`, the dispatch the stack merge uses): the arm bot re-reads the pull request and arms it only when it is approved, open and held by nobody. */
const canAskArmBot = (ctx: PoolContext): boolean => ctx.codeHost.requestStackMerge !== undefined;

/** Whether the pull request is approved at its head as the host says: the newest verdict on the head approves and GitHub's decision does not ask for another. PURE. */
const approvedAtHead = ({ approvedAtHead: approved, reviewDecision }: PullFeedback): boolean => approved && (reviewDecision ?? "approved") === "approved";

/** Why the board does not ask the arm bot to arm the pull request again at this record, or null when it may. PURE. */
function noRearmBecause(ctx: PoolContext, { read }: Pull, record: QueueHead): string | null {
  if (!canAskArmBot(ctx)) return "the code host cannot ask the arm bot";
  if (record.step === "held") return record.held === true ? "it is held from the arm bot" : "it is to be held from the arm bot, which the code host has not done yet";
  if ((record.rearms ?? 0) >= MAX_REARMS) return `the arm bot was asked ${MAX_REARMS} times at this head already`;
  if (!approvedAtHead(read)) return "it is not approved at this head";
  if (read.conflicting) return "it conflicts with its base";
  return null;
}

/** Ask the arm bot to arm the pull request. Returns why it could not be asked, or null once it was: a refusal is the board's to say, never a throw. */
function armBotRefusal(ctx: PoolContext, url: string): string | null {
  try {
    const request = stackMergeRequestOf(url);
    if (request === null) return "it is not a GitHub pull request address";
    ctx.codeHost.requestStackMerge?.(request);
    return null;
  } catch (err) {
    return messageOf(err);
  }
}

/** Whether a round was started at the record's head: a record written before A11-295 is a round when it says so and names its jobs. PURE. */
const startedRound = (record: QueueHead): boolean => record.roundStarted === true || (record.step === "round" && record.jobs !== undefined);

/**
 * Put the pull request back in the queue, for `because`, and return the record that says what was done (A11-295). The arm bot is asked once and counted ({@link MAX_REARMS} for a head); it re-reads the pull request itself and arms it only when it is approved and held by
 * nobody. What is NOT asked is said, in the log and on the card, with why: the pull request is held from the arm bot, not approved at this head, conflicts, was armed {@link MAX_REARMS} times at this head already, or the code host cannot ask. A refused ask is kept (`refused`)
 * and made again by the next watch. For a record of a head a round was started at, this is also the end of that round (`roundEnded`): the log says why the pull request is not in the queue, whether it was armed again or not.
 */
function rearm(ctx: PoolContext, entry: Entry, pull: Pull, record: QueueHead, because: string): QueueHead {
  const { url } = pull;
  const ended = startedRound(record) ? { roundEnded: true } : {};
  const { refused: earlier, ...rest } = record;
  const said = (note: string): string => {
    log(`${entry.ticket.key}: ${url} was ${note}`);
    return note;
  };
  const blocked = noRearmBecause(ctx, pull, record);
  if (blocked !== null) {
    const note = said(`removed from the merge queue: ${because}; not armed again: ${blocked}`);
    return { ...rest, step: record.step === "held" ? "held" : "named", ...ended, note: record.step === "held" && record.note !== undefined ? record.note : note };
  }
  const refused = armBotRefusal(ctx, url);
  if (refused !== null) {
    const note = `removed from the merge queue: ${because}; the arm bot could not be asked to arm it again (${refused}), asked again next watch`;
    return { ...rest, step: "rearmed", refused, note: earlier === refused ? note : said(note) };
  }
  const rearms = (record.rearms ?? 0) + 1;
  return { ...rest, step: "rearmed", rearms, ...ended, note: said(`removed from the merge queue: ${because}; the arm bot was asked to arm it again (${rearms} of ${MAX_REARMS})`) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A removal for failed checks
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The failing `merge_group` run behind a removal, or null when the code host cannot say. */
function readFailure(ctx: PoolContext, url: string, removal: QueueRemoval): QueueFailure | null {
  if (removal.groupCommit === null || ctx.codeHost.readQueueFailure === undefined) return null;
  try {
    return ctx.codeHost.readQueueFailure(url, removal.groupCommit);
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

/** One failing job of the merge group, with its log read. */
type ReadJob = Readonly<{ job: QueueFailureJob; check: ReadCheck }>;

/** Why a job's log shows the infrastructure and not the code failing: what any red check shows, and the package registry (A11-295). */
const queueCause = (log: string): string | null => infrastructureCause(log) ?? registryCause(log);

/**
 * One failing job of the merge group with its log read, and its cause: a job that failed while the runner was set up never ran the code, whatever its log says. A code host that cannot ask the arm bot has nothing to do for such a removal that a round
 * would not do better, so it keeps the causes it knew before A11-295 (a lost runner, a rate limit, a server error, a network error) and a registry error or a failed setup is the code's, as it was.
 */
function readJob(ctx: PoolContext, job: QueueFailureJob): ReadJob {
  const widened = canAskArmBot(ctx);
  const check = readCheck(ctx, { name: job.name, detailsUrl: job.detailsUrl }, widened ? queueCause : infrastructureCause);
  return { job, check: widened && check.infrastructure === null && job.step === SET_UP_JOB ? { ...check, infrastructure: "the runner could not set the job up" } : check };
}

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

/** The reasons the infrastructure failed the jobs, joined. PURE. */
const reasonsOf = (jobs: readonly ReadJob[]): string => [...new Set(jobs.map(({ check }) => check.infrastructure))].join(" and ");

/**
 * The answer to the newest removal of a pull request after a failed `merge_group` run, at a head the board has not answered, or answered with a re-arm (`prior`, A11-295). The run behind it is read, then the log of each job that failed. When every failed job failed
 * for an infrastructure reason (before the code ran) the pull request is put back in the queue, with no round: the arm bot is asked to arm it again ({@link rearm}), up to {@link MAX_REARMS} times for a head and never at the removal that holds it. Otherwise a round is
 * started with the jobs' error lines, even when the run or a log could not be read (it then says so): the third removal at a head is that round, whatever failed. A code host that cannot ask the arm bot names the removal for a person, as before, and nothing is rerun,
 * because a rerun does not put the pull request back in the queue.
 */
function answerFailed(ctx: PoolContext, entry: Entry, pull: Pull, removal: QueueRemoval, count: number, prior?: QueueHead): PullAnswer {
  const { url, read } = pull;
  const failure = readFailure(ctx, url, removal);
  const jobs = failure === null ? [] : jobsToAnswer(failure);
  const readJobs: ReadJob[] = jobs.map((job) => readJob(ctx, job));
  const own = readJobs.filter(({ check }) => check.infrastructure === null);
  const infrastructure = readJobs.filter(({ check }) => check.infrastructure !== null);
  const names = jobs.map(({ name }) => name);
  const head = read.head!;
  const rearms = prior?.rearms ?? 0;
  const carried = { ...(rearms === 0 ? {} : { rearms }), ...(prior?.retried === true ? { retried: true } : {}) };
  if (own.length === 0 && infrastructure.length > 0) {
    const because = `${names.join(", ")} failed for an infrastructure reason (${reasonsOf(infrastructure)})`;
    if (!canAskArmBot(ctx)) {
      const note = `removed from the merge queue: ${because}`;
      log(`${entry.ticket.key}: ${note} (${url})`);
      return { record: withHold(ctx, entry, url, { head, step: "named", removals: count, jobs: names, note }, count) };
    }
    if (count < HOLD_AFTER && rearms < MAX_REARMS) return { record: rearm(ctx, entry, pull, { head, step: "rearmed", removals: count, jobs: names, ...carried }, because) };
  }
  if (own.length > 0 && prior?.retried !== true) {
    const retrying = retryBeforeRound(ctx, entry, pull, { failure, jobs: readJobs, names, count, carried });
    if (retrying !== null) return { record: retrying };
  }
  // A removal the board already reran the jobs of is on the card as sent to the run, so a pull request that is approved and out of the queue is never shown as idle (A11-371).
  const sent = prior?.retried === true ? { note: `${ejectedNote(names)}, sent to the run` } : {};
  const record: QueueHead = { head, step: "round", removals: count, jobs: names, roundStarted: true, ...carried, ...sent };
  return { feedback: failedBrief(pull, removal, failure, { own, infrastructure }, { rearms, willRearm: canAskArmBot(ctx) && count < HOLD_AFTER, earlier: prior }), record: withHold(ctx, entry, url, record, count) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The rerun before a round (A11-371)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The start of the card's line for a pull request the queue removed for the jobs `names` (A11-371). PURE. */
const ejectedNote = (names: readonly string[]): string => `ejected from the merge queue: ${names.join(", ")}`;

/** The id of the run a job's page belongs to (`.../actions/runs/<id>/job/<id>`), or null for an address that names no job, which the code host leaves out of a rerun. PURE. */
function runIdOf(detailsUrl: string): number | null {
  const id = /\/actions\/runs\/(\d+)\/job\/\d+/.exec(detailsUrl)?.[1];
  return id === undefined ? null : Number(id);
}

/** Whether the run behind a removal was read and names a job that failed: without one there is nothing to rerun. PURE. */
const hasFailedJobs = (failure: QueueFailure | null): failure is QueueFailure => failure !== null && failure.jobs.length > 0;

/** Whether the code host can read a run's conclusion, which a rerun is judged by. PURE. */
const canReadRuns = (ctx: PoolContext): boolean => ctx.codeHost.readCiRun !== undefined;

/**
 * THE RERUN OF A MERGE GROUP'S FAILED JOBS, made once for a head before any worker is asked (A11-371). Returns the record that says so (`retrying`, with the tests that failed, for the flake log), or null when the jobs are not rerun and the round starts as it did before: the code host
 * cannot read a run's conclusion, so a rerun could not be judged; the run behind the removal could not be read; the arm bot would not be asked once the jobs pass (the pull request is not approved at its head, conflicts, is held or has used its re-arms); or the host refused the rerun, which is said.
 */
function retryBeforeRound(ctx: PoolContext, entry: Entry, { url, read }: Pull, { failure, jobs, names, count, carried }: Readonly<{ failure: QueueFailure | null; jobs: readonly ReadJob[]; names: readonly string[]; count: number; carried: Pick<QueueHead, "rearms"> }>): QueueHead | null {
  if (!hasFailedJobs(failure) || !canReadRuns(ctx) || count >= HOLD_AFTER) return null;
  const head = read.head!;
  const blocked = noRearmBecause(ctx, { url, read }, { head, step: "rearmed", removals: count, ...carried });
  if (blocked !== null) {
    log(`${entry.ticket.key}: the failed jobs of the merge group behind ${url} are not rerun: ${blocked}`);
    return null;
  }
  const addresses = failure.jobs.map(({ detailsUrl }) => detailsUrl);
  const runIds = addresses.map(runIdOf).filter((id): id is number => id !== null);
  if (runIds.length !== addresses.length) return null;
  const refused = ctx.codeHost.rerunFailedChecks(addresses);
  if (refused !== null) {
    log(`${entry.ticket.key}: the failed jobs of the merge group behind ${url} could not be rerun (${refused}): a round is started`);
    return null;
  }
  const candidates = jobs.filter(({ check }) => check.infrastructure === null).map(({ job, check }) => ({ test: failedTestOf(check), check: job.name, run: job.detailsUrl }));
  const retry: QueueRetry = { at: ctx.now(), runs: [...new Set(runIds)], candidates };
  const note = `${ejectedNote(names)}, retrying`;
  log(`${entry.ticket.key}: ${note} (${url}): the failed jobs of its merge group were rerun before a worker is asked`);
  return { head, step: "retrying", removals: count, jobs: names, retried: true, ...carried, retry, note };
}

/** One read of a run, or null when the host would not say: a throw is a refusal, never an answer. */
function readRun(ctx: PoolContext, repo: string, id: number): CiRun | null {
  try {
    return ctx.codeHost.readCiRun?.(repo, id) ?? null;
  } catch (err) {
    log(`the run ${id} of ${repo} could not be read: ${messageOf(err)}`);
    return null;
  }
}

/**
 * What the rerun of a merge group's jobs came to: `passed` when every run rerun has concluded green (a green read can only be the rerun's, since the runs were red); `failed` when one concluded otherwise, believed only once {@link RETRY_SETTLE_MS} have passed since the rerun, because a read
 * just after it can still show the failure that was rerun; else `waiting`, which is also what a run the host would not say anything of is. PURE apart from the reads.
 */
function rerunVerdict(ctx: PoolContext, url: string, retry: QueueRetry): "passed" | "failed" | "waiting" {
  const repo = stackMergeRequestOf(url)?.repo;
  if (repo === undefined) return "waiting";
  const runs = retry.runs.map((id) => readRun(ctx, repo, id));
  if (runs.some((run) => run === null || run.status !== "completed")) return "waiting";
  if (runs.every((run) => run?.conclusion === "success")) return "passed";
  return ctx.now() - retry.at >= RETRY_SETTLE_MS ? "failed" : "waiting";
}

/** The flake log's entries for a rerun that passed: each test or step that failed, with its run and the head. PURE. */
const flakesOf = (retry: QueueRetry, head: string, url: string, at: number): Flake[] => retry.candidates.map((candidate) => ({ ...candidate, head, pull: url, at }));

/** `answer` with the record saying the rerun was made for this head: a removal for another reason does not give a later one a second rerun. PURE. */
const spentOn = (answer: PullAnswer): PullAnswer => (answer.record === undefined ? answer : { ...answer, record: { ...answer.record, retried: true } });

/**
 * THE END OF THE RERUN (A11-371), asked at every watch while the record says `retrying`. Passed: each failed test is written to the flake log (a log that cannot be written is said and does not keep the pull request out of the queue), and the arm bot is asked to arm the pull request
 * again ({@link rearm}), once for the head. Failed, or still not concluded {@link RETRY_WAIT_MS} after the rerun: the round starts, with the failing test quoted. Removed again meanwhile (someone armed it by hand): the same round. Still running: the record stays.
 */
function answerRetry(ctx: PoolContext, entry: Entry, pull: Pull, known: QueueHead, queue: PullQueue): PullAnswer {
  const newest = queue.removals.at(-1)!;
  const count = queue.removals.filter(isFailedChecks).length;
  const names = known.jobs ?? [];
  const toTheRun = (): PullAnswer => (isFailedChecks(newest) ? answerFailed(ctx, entry, pull, newest, count, known) : spentOn(answerOther(ctx, entry, pull, newest, count)));
  if (known.retry === undefined || count > known.removals || !isFailedChecks(newest)) return toTheRun();
  const verdict = rerunVerdict(ctx, pull.url, known.retry);
  if (verdict === "failed") {
    log(`${entry.ticket.key}: ${ejectedNote(names)}: the rerun did not pass (${pull.url})`);
    return toTheRun();
  }
  if (verdict === "waiting") {
    if (ctx.now() - known.retry.at < RETRY_WAIT_MS) return { record: known };
    log(`${entry.ticket.key}: ${ejectedNote(names)}: the rerun had not concluded ${RETRY_WAIT_MS / 60_000} minutes after it was made (${pull.url})`);
    return toTheRun();
  }
  const { retry, note: _note, ...rest } = known;
  try {
    ctx.flakes.record(flakesOf(retry, known.head, pull.url, ctx.now()));
  } catch (err) {
    log(`${entry.ticket.key}: the flakes of ${pull.url} could not be recorded: ${messageOf(err)}`);
  }
  return { record: rearm(ctx, entry, pull, { ...rest, step: "rearmed", rerunPassed: true }, `${names.join(", ")} passed on rerun`) };
}

/** `record` as it is below the limit, and held from the arm bot at it. */
const withHold = (ctx: PoolContext, entry: Entry, url: string, record: QueueHead, count: number): QueueHead => (count < HOLD_AFTER ? record : holdRecord(ctx, entry, url, record, count));

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The other removals
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The brief of a round for a removal because the pull request conflicts with its base: the sentence a conflict round is recognised by (`conflictLine`), then why the queue named it. PURE. */
function conflictBrief({ url, read }: Pull, removal: QueueRemoval): string {
  const base = read.base ?? "its base branch";
  return [conflictLine(url, read.base), `The merge queue removed it at ${timeOf(removal.at)} because of it (${removal.reason}). Merge ${base} in, resolve the conflict, and push.`].join("\n");
}

/** The card's words for a removal the board does not answer: its reason, and who removed it when that was not the queue. PURE. */
function namedNote({ reason, actor }: QueueRemoval): string {
  const by = actor === null || QUEUE_ACTOR.test(actor) ? "" : ` by ${actor}`;
  return `removed from the merge queue${by}: ${reason}`;
}

/** The answer to the newest removal of a pull request when it is not one for failed checks: a conflict starts a round, any other reason is named on the card and starts none. */
function answerOther(ctx: PoolContext, entry: Entry, pull: Pull, removal: QueueRemoval, count: number): PullAnswer {
  const head = pull.read.head!;
  if (CONFLICT.test(removal.reason)) return { conflict: conflictBrief(pull, removal), record: withHold(ctx, entry, pull.url, { head, step: "round", removals: count }, count) };
  const note = namedNote(removal);
  log(`${entry.ticket.key}: ${note} (${pull.url})`);
  return { record: withHold(ctx, entry, pull.url, { head, step: "named", removals: count, note }, count) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// One pull request
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The names of the jobs that failed in the `merge_group` run behind a removal, or the ones already known when the code host cannot say. */
function jobsBehind(ctx: PoolContext, url: string, removal: QueueRemoval, known: readonly string[] | undefined): readonly string[] {
  const failure = isFailedChecks(removal) ? readFailure(ctx, url, removal) : null;
  return failure === null ? known ?? [] : jobsToAnswer(failure).map(({ name }) => name);
}

/**
 * The record of a head the board already answered, counted (A11-154's rule for red checks): the third removal for failed checks with no push between holds the pull request from the arm bot, and a hold the code host refused is asked for again.
 */
function counted(ctx: PoolContext, entry: Entry, pull: Pull, known: QueueHead, queue: PullQueue): QueueHead {
  const count = queue.removals.filter(isFailedChecks).length;
  if (count < HOLD_AFTER) return known.removals === count ? known : { ...known, removals: count };
  if (known.held === true && known.removals === count) return known;
  const jobs = known.removals === count ? known.jobs : jobsBehind(ctx, pull.url, queue.removals.at(-1)!, known.jobs);
  return holdRecord(ctx, entry, pull.url, { ...known, ...(jobs === undefined ? {} : { jobs }) }, count);
}

/** What the log says of a pull request still out of the queue after an ask the arm bot refused. */
const STILL_OUT = "it is still out of the merge queue";

/**
 * A removal at a head the board already answered ({@link counted}). It starts no second round, however often it repeats (A11-154), with one exception: a head answered with a re-arm that no round was started at (A11-295), whose next removal is answered as a first one
 * is, a re-arm until {@link MAX_REARMS} are spent and then the round. Where a round was started, the pull request goes back in the queue when the round ends (the head unmoved, the pull request out of the queue), and again after each removal that follows, until the
 * re-arms are spent or the hold stops them. Returns the answer: the record the entry should hold, and the round when one is due.
 */
function repeated(ctx: PoolContext, entry: Entry, pull: Pull, known: QueueHead, queue: PullQueue): PullAnswer {
  const newest = queue.removals.at(-1)!;
  const failed = isFailedChecks(newest);
  const count = queue.removals.filter(isFailedChecks).length;
  if (known.step === "rearmed" && !startedRound(known)) {
    if (!failed) return { record: known };
    if (count > known.removals) return answerFailed(ctx, entry, pull, newest, count, known);
    return { record: known.refused === undefined ? known : rearm(ctx, entry, pull, known, STILL_OUT) };
  }
  const record = counted(ctx, entry, pull, known, queue);
  if (!failed || !startedRound(known) || !roundIsOver(entry)) return { record };
  const marked: QueueHead = { ...record, roundStarted: true };
  if (record.roundEnded !== true) return { record: rearm(ctx, entry, pull, marked, "its round ended with no push and it is still out of the queue") };
  const again = count > known.removals || record.refused !== undefined;
  return { record: again ? rearm(ctx, entry, pull, marked, count > known.removals ? "it was removed again after its round" : STILL_OUT) : record };
}

/**
 * Whether the round the board started for a removal is over and left the pull request where it was: the run is finished with a worker that is neither waiting on a person's answer (`needs-human`) nor handed back at the round cap (`handedBack`), both of which
 * are a person's to decide and are not the board's to override by arming the pull request. PURE.
 */
const roundIsOver = (entry: Entry): boolean => entry.handedBack === undefined && entry.outcome?.kind !== "needs-human";

/** Whether the record only names a removal for another reason: it has no failed job, so no round was ever owed for it. PURE. */
const isNamedOnly = (record: QueueHead): boolean => record.step === "named" && record.jobs === undefined;

/** `record` without the line the card shows, and without an ask the arm bot refused: the pull request is in the queue. A rerun still to be judged is given up (A11-371): the pull request is queued, and the rerun was made for this head. PURE. */
function withoutNote(record: QueueHead): QueueHead {
  const { note: _note, refused: _refused, retry: _retry, ...rest } = record;
  return record.step === "retrying" ? { ...rest, step: "rearmed" } : rest;
}

/** The answer for one open pull request, given the record the entry holds for it. */
function answerPull(ctx: PoolContext, entry: Entry, pull: Pull, known: QueueHead | undefined): PullAnswer {
  const { url, read } = pull;
  // A host that does not say (a plugin before contract 1.21, or an answer with no timeline) is not one that says there are no removals: what the entry holds stays.
  if (read.head === null || read.queue === undefined) return { record: known };
  let current = known;
  if (current !== undefined && current.head !== read.head) {
    const stuck = released(ctx, entry, url, current);
    if (stuck !== null) return { record: stuck };
    current = undefined;
  }
  const newest = read.queue.removals.at(-1);
  // A pull request the board put back in the queue is in it: the card stops saying it was asked to be (the re-arms stay counted for the head).
  if (read.queue.queued && (current?.step === "rearmed" || current?.step === "retrying")) return { record: withoutNote(current) };
  if (read.queue.queued || newest === undefined) return { record: current };
  // A head that was only named for another reason (no round, no failed job) is still owed the round a removal for failed checks gets.
  const named = current !== undefined && isNamedOnly(current) && isFailedChecks(newest) ? current : undefined;
  if (named !== undefined) current = undefined;
  if (current?.step === "retrying") return answerRetry(ctx, entry, pull, current, read.queue);
  if (current !== undefined) return repeated(ctx, entry, pull, current, read.queue);
  const count = read.queue.removals.filter(isFailedChecks).length;
  return isFailedChecks(newest) ? answerFailed(ctx, entry, pull, newest, count, named?.retried === true ? named : undefined) : answerOther(ctx, entry, pull, newest, count);
}

/**
 * Answer the merge queue's removals of a finished run's open pull requests (A11-264): each pull request the queue removed since its head last moved, at a head the board has not answered. A removal for failed checks is briefed with the failing job and step and their error
 * lines from the `merge_group` run; a conflict is briefed as a conflict; any other reason is named on the card. The pull requests that are no longer open, and the heads a pull request has moved off, are dropped from the record, and the hold from the arm bot is lifted for a head that moved.
 * The effects are the reads of the run and the logs, and the label; the record is returned, for the caller to write with the round it queues.
 */
export function answerQueue(ctx: PoolContext, entry: Entry, open: readonly Pull[]): QueueAnswer {
  const feedback: string[] = [];
  const conflict: string[] = [];
  let heads: Record<string, QueueHead> = {};
  let withoutRound: Record<string, QueueHead> = {};
  for (const pull of open) {
    const answer = answerPull(ctx, entry, pull, entry.queueHeads?.[pull.url]);
    if (answer.feedback !== undefined) feedback.push(answer.feedback);
    if (answer.conflict !== undefined) conflict.push(answer.conflict);
    const asRecord = answer.record === undefined ? {} : { [pull.url]: answer.record };
    heads = { ...heads, ...asRecord };
    withoutRound = { ...withoutRound, ...(answer.feedback !== undefined || answer.conflict !== undefined ? {} : asRecord) };
  }
  return { feedback: feedback.length === 0 ? null : feedback.join("\n"), conflict: conflict.length === 0 ? null : conflict.join("\n"), heads, withoutRound };
}
