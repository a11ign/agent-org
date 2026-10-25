// @ts-check
// module: the pool's merge queue removals -- which removals of a finished run's pull requests the board answers, once for each head: a failed `merge_group` run starts a fix round, a conflict starts a conflict round, any other reason is named, and a pull request removed three times with no push between is held from the arm bot (A11-264)
//
// THE CHECKS ON A PULL REQUEST'S HEAD CAN BE GREEN WHILE THE QUEUE REMOVES IT. The merge queue runs the checks on the result of merging the pull request into the base (the `merge_group` run), so a check that came to the base with another pull request fails only there, and `answerChecks` (A11-154)
// never sees it. Measured 2026-10-25 on a11ign/announcement-emulator#18: approved, `gate` green on its head, removed three times for `failed_checks`, and the arm bot armed it again each time because nothing had changed.
import { isRollUpCheck } from "../newest-check-run.ts";
import type { PullFeedback, PullQueue, QueueFailure, QueueFailureJob, QueueRemoval } from "../plugins/contracts/code-host.ts";
import type { QueueHead } from "./board-view/queue-head.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import { QUOTED_LINES, readCheck, type ReadCheck } from "./pool-checks.ts";
import type { PoolContext } from "./pool-context.ts";
import { log, messageOf } from "./pool-state.ts";
import { conflictLine } from "./worker-files.ts";

/** How many removals for failed checks, with no push between, the board puts up with before it holds the pull request from the arm bot: the ticket says "more than twice". */
export const HOLD_AFTER = 3;

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
function failedBrief(pull: Pull, removal: QueueRemoval, failure: QueueFailure | null, read: Readonly<{ own: readonly ReadJob[]; infrastructure: readonly ReadJob[] }>): string {
  const { url, read: feedback } = pull;
  const base = feedback.base ?? "its base branch";
  const run = failure === null ? "" : ` (${failure.runUrl})`;
  const where = `The failure is on the result of merging it with ${base}, not on its own head${feedback.failing.length === 0 ? ", whose checks are green" : ""}.`;
  const named = failure === null ? ["Its merge_group run could not be read, so the failing job is not named."]
    : failure.jobs.length === 0 ? ["The run names no failing job."]
      : [...ownJobLines(read.own), ...read.infrastructure.map(infrastructureJobLine)];
  return [`${url} was removed from the merge queue at ${timeOf(removal.at)} because its merge_group run failed${run}. ${where}`, ...named,
    `Merge ${base} in, reproduce the failure, fix it, and push.`].join("\n");
}

/** The reasons the infrastructure failed the jobs, joined. PURE. */
const reasonsOf = (jobs: readonly ReadJob[]): string => [...new Set(jobs.map(({ check }) => check.infrastructure))].join(" and ");

/**
 * The answer to the newest removal of a pull request after a failed `merge_group` run, at a head the board has not answered. The run behind it is read, then the log of each job that failed. A round is started with the jobs' error lines, even when the run or a log could not be
 * read (it then says so). When every failed job failed for an infrastructure reason there is no round: it is named for a person, and nothing is rerun, because a rerun does not put the pull request back in the queue.
 */
function answerFailed(ctx: PoolContext, entry: Entry, pull: Pull, removal: QueueRemoval, count: number): PullAnswer {
  const { url, read } = pull;
  const failure = readFailure(ctx, url, removal);
  const jobs = failure === null ? [] : jobsToAnswer(failure);
  const readJobs: ReadJob[] = jobs.map((job) => ({ job, check: readCheck(ctx, { name: job.name, detailsUrl: job.detailsUrl }) }));
  const own = readJobs.filter(({ check }) => check.infrastructure === null);
  const infrastructure = readJobs.filter(({ check }) => check.infrastructure !== null);
  const names = jobs.map(({ name }) => name);
  const head = read.head!;
  if (own.length === 0 && infrastructure.length > 0) {
    const note = `removed from the merge queue: ${names.join(", ")} failed for an infrastructure reason (${reasonsOf(infrastructure)})`;
    log(`${entry.ticket.key}: ${note} (${url})`);
    return { record: withHold(ctx, entry, url, { head, step: "named", removals: count, jobs: names, note }, count) };
  }
  return { feedback: failedBrief(pull, removal, failure, { own, infrastructure }), record: withHold(ctx, entry, url, { head, step: "round", removals: count, jobs: names }, count) };
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
 * A removal at a head the board already answered starts no second round, however often it repeats (A11-154's rule for red checks). It is counted: the third removal for failed checks with no push between holds the pull request from the arm bot, and a hold the code host
 * refused is asked for again. Returns the record the entry should hold.
 */
function repeated(ctx: PoolContext, entry: Entry, pull: Pull, known: QueueHead, queue: PullQueue): QueueHead {
  const count = queue.removals.filter(isFailedChecks).length;
  if (count < HOLD_AFTER) return known.removals === count ? known : { ...known, removals: count };
  if (known.held === true && known.removals === count) return known;
  const jobs = known.removals === count ? known.jobs : jobsBehind(ctx, pull.url, queue.removals.at(-1)!, known.jobs);
  return holdRecord(ctx, entry, pull.url, { ...known, ...(jobs === undefined ? {} : { jobs }) }, count);
}

/** Whether the record only names a removal for another reason: it has no failed job, so no round was ever owed for it. PURE. */
const isNamedOnly = (record: QueueHead): boolean => record.step === "named" && record.jobs === undefined;

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
  if (read.queue.queued || newest === undefined) return { record: current };
  // A head that was only named for another reason (no round, no failed job) is still owed the round a removal for failed checks gets.
  if (current !== undefined && isNamedOnly(current) && isFailedChecks(newest)) current = undefined;
  if (current !== undefined) return { record: repeated(ctx, entry, pull, current, read.queue) };
  const count = read.queue.removals.filter(isFailedChecks).length;
  return isFailedChecks(newest) ? answerFailed(ctx, entry, pull, newest, count) : answerOther(ctx, entry, pull, newest, count);
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
