// @ts-check
// module: the pool's red checks -- which failing checks of a finished run's pull requests the board answers, once for each head: it reruns a red check once before it asks a worker (A11-300), records a pass on rerun as a flake, and briefs a round only on a check that is red again

import { CI_CLASS, errorLinesOfLog, LOG_TIMESTAMP, rateLimitOrLostRunner, READS_OUTSIDE, withoutColour } from "../ci-log-lines.ts";
import { rerunOn5xx } from "../ci-rerun-on-5xx.ts";
import { isRollUpCheck } from "../newest-check-run.ts";
import type { FailingCheck, PullFeedback, UpdateBranchResult } from "../plugins/contracts/code-host.ts";
import type { Flake } from "./flakes.ts";
import { failedTestOf, saysUnrelated } from "./failure-words.ts";
import { type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { type CheckHead } from "./board-view/view-types-and-filters.ts";
import type { FlakeCandidate, RerunRecord } from "./board-view/check-rerun-record.ts";
import { NO_FOREIGN_REDS, type ForeignReds, type ForeignRedsRead } from "./pool-foreign-checks.ts";
import { log, messageOf } from "./pool-state.ts";
import { ownerOfRed } from "./ticket-references.ts";
import { conflictLine } from "./worker-files.ts";
import { type PoolContext } from "./pool-context.ts";

/** The most error lines a round's brief quotes from the logs of all the checks that failed at a head, and the most characters of each: a brief names the failure, it is not the log. */
export const QUOTED_LINES = 40;
const LINE_CHARS = 160;

/** How many of a log's last error lines are read for the cause of a failure: it is at the log's end, and an early line that mentions a rate limit or a refused connection is the code's own output. */
const CAUSE_WINDOW = 5;

/** The characters of a head the card names, as GitHub's own short form does. */
const HEAD_CHARS = 8;

/** The longest a red check that has others still running waits for its run to finish before the board reruns it anyway: GitHub reruns the failed jobs of a run only once the whole run has finished (A11-300). */
const RERUN_WAIT_MS = 45 * 60_000;

/** How long after a rerun a failure that finished before it is read as the failure that was rerun, still on the check's page, and not as the rerun failing again: GitHub's read can lag the rerun by a few seconds. */
const RERUN_SETTLE_MS = 5 * 60_000;

/**
 * A failing check with what its job's log says of it: the lines to quote, and why it is the infrastructure's and not the code's, when it is. `refusals` are the log's lines that say the check refused
 * (A11-179): a refusal names the ticket that owns what it refuses, and its words are not an error line's.
 */
export type ReadCheck = Readonly<{ name: string; lines: readonly string[]; refusals: readonly string[]; infrastructure: string | null; readable: boolean; detailsUrl: string | null }>;

/** What a pass over a run's red checks found: the feedback a round answers, or null, and the heads the checks were answered at. */
export type CheckAnswer = Readonly<{
  /** The failing checks and their log lines for the round that answers them, or null when no check needs a worker. */
  feedback: string | null;
  /** Everything the board has answered, for the pull requests still open, with this pass's answers added: the whole record, as the entry should hold it. */
  heads: Readonly<Record<string, CheckHead>>;
  /** The same without the answers that are a round: what is recorded when no round is queued, so a rerun already made is not made again. */
  withoutRound: Readonly<Record<string, CheckHead>>;
}>;

/** The lines of a job log that say the check refused (A11-179), without the colour codes and the runner's timestamps, the last {@link QUOTED_LINES}. PURE. */
function refusalLinesOfLog(log: string): string[] {
  return withoutColour(log).split("\n").map((line) => line.replace(LOG_TIMESTAMP, "").trim()).filter((line) => /refus/i.test(line)).slice(-QUOTED_LINES);
}

/** A job log without the colour codes and the runner's timestamps. PURE. */
const plainLog = (log: string): string => withoutColour(log).split("\n").map((line) => line.replace(LOG_TIMESTAMP, "")).join("\n");

/**
 * Why a failing check's log shows the infrastructure and not the code failing, or null: a lost runner or a rate limit, a GitHub server error, or a network error. The log is read
 * without the colour codes and the runner's timestamps, which the failing-assertion rule of the rate-limit read anchors its lines without. PURE.
 */
export function infrastructureCause(log: string): string | null {
  const plain = plainLog(log);
  // The cause of a job's failure is at its end: a build whose log mentions a rate limit or a refused connection earlier is the code's failure.
  const tail = errorLinesOfLog(plain).slice(-CAUSE_WINDOW);
  if (rateLimitOrLostRunner(tail.join("\n"), CI_CLASS)) return "a runner was lost or a rate limit was hit";
  if (rerunOn5xx({ log: plain, conclusion: "failure", rerunsOnThisHead: false }).action === "rerun") return "GitHub answered with a server error";
  if (tail.some((line) => READS_OUTSIDE.test(line))) return "a network error";
  return null;
}

/** How many of a log's last lines are read for a registry error: npm prints its `code`, a few explanatory lines and the path of its debug log, in that order, at the end. */
const REGISTRY_WINDOW = 10;

/** An install that fails on the registry's side, by the lines npm and pnpm print: a version the registry does not list (yet), or a server error. */
const REGISTRY_ERROR = /^(?:npm error\s+(?:code\s+)?(?:ETARGET|notarget|E5\d\d|5\d\d\s)|\s*ERR_PNPM_(?:NO_MATCHING_VERSION|FETCH_5\d\d))/i;

/**
 * Why a failing job's log shows the package registry and not the code failing, or null: the install asked for a version the registry does not list (`ETARGET`, a version published minutes ago that
 * the runner's mirror has not seen yet) or the registry answered with a server error. Read from the log's last lines ({@link REGISTRY_WINDOW}), as {@link infrastructureCause} reads the end of a log, and not
 * from its error lines, which leave out pnpm's. PURE.
 */
export function registryCause(log: string): string | null {
  const tail = plainLog(log).split("\n").map((line) => line.trim()).filter((line) => line !== "").slice(-REGISTRY_WINDOW);
  return tail.some((line) => REGISTRY_ERROR.test(line)) ? "the package registry did not serve a version the install asked for" : null;
}

/**
 * The failing checks a round is about: the ones the board answers (`failing`), except that a roll-up `gate` among them reports other jobs' results and names no cause, so the jobs
 * behind it are named in its place, with the logs that do. PURE.
 */
function checksToAnswer(read: PullFeedback): readonly FailingCheck[] {
  const counted = read.failures.filter(({ name }) => read.failing.includes(name));
  const behind = counted.some(({ name }) => isRollUpCheck(name)) ? read.failures.filter(({ name }) => !isRollUpCheck(name)) : counted;
  return behind.length > 0 ? behind : counted;
}

/**
 * One failing check, with its job's log read. A check with no Actions job, or whose log cannot be read, is `readable: false` and is the code's to answer. `causeOf` says why a log shows the infrastructure
 * and not the code ({@link infrastructureCause} unless the caller knows more).
 */
export function readCheck(ctx: PoolContext, check: FailingCheck, causeOf: (log: string) => string | null = infrastructureCause): ReadCheck {
  const unread = { name: check.name, lines: [], refusals: [], infrastructure: null, readable: false, detailsUrl: check.detailsUrl } as const;
  if (check.detailsUrl === null) return unread;
  try {
    const text = ctx.codeHost.readCheckLog(check.detailsUrl);
    if (text === null) return unread;
    return { ...unread, lines: errorLinesOfLog(text).slice(-QUOTED_LINES).map((line) => line.slice(0, LINE_CHARS)), refusals: refusalLinesOfLog(text), infrastructure: causeOf(text), readable: true };
  } catch (err) {
    log(`the log of ${check.name} on ${check.detailsUrl} could not be read: ${messageOf(err)}`);
    return unread;
  }
}

/** The lines of the feedback that name one check the code failed, with the error lines of its log: at most {@link QUOTED_LINES} for all of them. PURE. */
function ownLines(url: string, checks: readonly ReadCheck[]): string[] {
  const share = Math.max(1, Math.floor(QUOTED_LINES / checks.length));
  return checks.flatMap((check) => {
    const quoted = check.lines.slice(-share);
    if (!check.readable) return [`${check.name} failed on the head commit of ${url}; its log could not be read.`];
    if (quoted.length === 0) return [`${check.name} failed on the head commit of ${url}; its log names no error.`];
    return [`${check.name} failed on the head commit of ${url}:`, ...quoted.map((line) => `  ${line}`)];
  });
}

/** The line that names the checks a round is not about because they fail where the run's files are not (A11-179). PURE. */
const foreignLine = (url: string, names: readonly string[]): string =>
  `${names.join(", ")} also failed on the head commit of ${url}, but ${names.length === 1 ? "fails" : "fail"} on the default branch or on pull requests that touch none of your files: that is not a fault in your change, so leave ${names.length === 1 ? "it" : "them"}.`;

/** The line that names a check that failed for an infrastructure reason in a round that is not about it. PURE. */
const infrastructureLine = (url: string, check: ReadCheck): string =>
  `${check.name} also failed on the head commit of ${url} for an infrastructure reason (${check.infrastructure}): that is not a fault in your change, so leave it; the next push runs it again.`;

const short = (head: string): string => head.slice(0, HEAD_CHARS);
const names = (checks: readonly ReadCheck[]): string => checks.map((check) => check.name).join(", ");
const reasons = (checks: readonly ReadCheck[]): string => [...new Set(checks.map((check) => check.infrastructure))].join(" and ");

/** Rerun the failed jobs of the runs behind `checks`. Returns why the code host refused, or null once they are rerun. */
function rerun(ctx: PoolContext, checks: readonly ReadCheck[]): string | null {
  return ctx.codeHost.rerunFailedChecks(checks.flatMap(({ detailsUrl }) => (detailsUrl === null ? [] : [detailsUrl])));
}

/**
 * The ticket that owns a red check the run cannot mend: the one the pull request's `Blocked-by:` line names, else the one the check's own refusal text names (A11-179): a failing test's title names tickets too, and is no owner. A check that was named at this head
 * already has its answer in `previous`, so its log is not read again on every watch. Null when no ticket is named.
 */
function ownerOf(ctx: PoolContext, key: string, body: string, check: FailingCheck, previous: Readonly<Record<string, string | null>>): string | null {
  const viaBody = ownerOfRed(key, body, []);
  if (viaBody !== null) return viaBody;
  if (Object.hasOwn(previous, check.name)) return previous[check.name];
  return ownerOfRed(key, "", readCheck(ctx, check).refusals);
}

/** The card's note for checks held as red on main, with the ticket that owns each when one is named. PURE. */
const heldNote = (names: readonly string[], owners: Readonly<Record<string, string | null>>): string =>
  names.map((name) => `${name} is red on main / not this run's${(owners[name] ?? null) === null ? "" : `; owned by ${owners[name]}`}`).join("; ");

/**
 * The record for a head whose red checks are all ones the run cannot mend (A11-179): they fail on the default branch, or on pull requests that touch none of the run's files. No round is started and
 * nothing is rerun. The card is told so, with the ticket that owns each check when one is named. Made again on every watch, and said in the log when it changes. It records which of the checks are red on
 * the default branch (`waitingOnMain`, A11-215), and keeps those an earlier record at this head recorded, so a watch that cannot read main does not forget what the pull request waits on.
 */
function notOursAnswer(ctx: PoolContext, entry: Entry, pull: Readonly<{ url: string; read: PullFeedback }>, outside: readonly FailingCheck[], known: CheckHead | undefined, reds: ForeignRedsRead): CheckHead {
  const { read } = pull;
  const sameHead = known?.head === read.head && known.step === "not-ours";
  const previous = sameHead ? known.notOurs ?? {} : {};
  const owners: Record<string, string | null> = Object.fromEntries(outside.map((check) => [check.name, ownerOf(ctx, entry.ticket.key, read.body ?? "", check, previous)]));
  // A roll-up that failed reports its jobs' results: with every job behind it elsewhere's, it is red for the same reason and belongs to the same ticket.
  const owner = Object.values(owners).find((name) => name !== null) ?? null;
  for (const name of read.failing.filter((failing) => isRollUpCheck(failing) && !Object.hasOwn(owners, failing))) owners[name] = owner;
  const note = heldNote(outside.map(({ name }) => name), owners);
  const waiting = [...new Set([...(sameHead ? known.waitingOnMain ?? [] : []), ...Object.keys(owners).filter((name) => reds.onMain.has(name))])].filter((name) => Object.hasOwn(owners, name));
  const answer: CheckHead = { head: read.head!, step: "not-ours", note, notOurs: owners, ...(waiting.length === 0 ? {} : { waitingOnMain: waiting }) };
  if (JSON.stringify(known) !== JSON.stringify(answer)) log(`${entry.ticket.key}: ${note}`);
  return answer;
}

/**
 * What the board does about checks that failed for an infrastructure reason at `head` and that no check of the code's accompanies: rerun them once and name the rerun on the card; red again on the same
 * head after it (`reran`), or a rerun the host refuses, they are named for a person and no worker gets them (A11-154).
 */
function answerInfrastructure(ctx: PoolContext, entry: Entry, { head, checks, reran }: Readonly<{ head: string; checks: readonly ReadCheck[]; reran: boolean }>): CheckHead {
  const shown = short(head);
  if (reran) {
    const note = `${names(checks)} failed again on ${shown} after a rerun (${reasons(checks)}): a person decides`;
    log(`${entry.ticket.key}: ${note}`);
    return { head, step: "named", note };
  }
  const refused = rerun(ctx, checks);
  if (refused !== null) {
    // Asked again on every watch it would read a log and be refused for ever, and no person would hear of it: it is named for one instead.
    const note = `${names(checks)} failed on ${shown} for an infrastructure reason (${reasons(checks)}) and could not be rerun (${refused}): a person decides`;
    log(`${entry.ticket.key}: ${note}`);
    return { head, step: "named", note };
  }
  const note = `Reran ${names(checks)} on ${shown}: ${reasons(checks)}`;
  log(`${entry.ticket.key}: ${note}`);
  return { head, step: "rerun", note };
}

/** The line that tells a worker what to do with a failure that is not its change's, so the board can rerun it (A11-300). PURE. */
const unrelatedAdvice = (url: string): string =>
  `If a check above failed for a reason that is not your change (it fails without your change too), push nothing for it, and reply on ${url} saying the failure is unrelated to your change and why: the board then reruns the failed jobs once.`;

/** The flake candidates of the checks a rerun is for: the test or step that failed in each, and the run it failed in. PURE. */
const candidatesOf = (checks: readonly ReadCheck[]): FlakeCandidate[] =>
  checks.flatMap((check) => (check.detailsUrl === null ? [] : [{ test: failedTestOf(check), check: check.name, run: check.detailsUrl }]));

/** The record of a rerun of the code's own red checks (A11-300), with what failed kept for the flake log. PURE. */
const rerunRecord = (head: string, note: string, kind: "code" | "reply", at: number, checks: readonly ReadCheck[]): CheckHead =>
  ({ head, step: "rerun", note, rerun: { for: kind, at, candidates: candidatesOf(checks) } });

/** Whether the pull request has checks still running, and the failure is recent enough to wait for them: the failed jobs of a run can be rerun only once the run has finished. A failure with no time is not waited for. PURE. */
const runStillGoing = (read: PullFeedback, now: number): boolean => (read.pendingRequired ?? []).length > 0 && read.failedAt !== null && now - read.failedAt < RERUN_WAIT_MS;

/** Whether a record is the rerun of the code's own checks at `head`, which has not yet come out green and been recorded. PURE. */
const isUnsettledRerun = (known: CheckHead | undefined, head: string | null): known is CheckHead & { rerun: RerunRecord } =>
  known?.step === "rerun" && known.head === head && known.rerun !== undefined && known.rerun.passed !== true && known.rerun.candidates.length > 0;

/** Whether none of a rerun's checks is red or running now: the host says which required checks are running, and says none, and none of the rerun's checks is among the failures. PURE. */
const rerunCameOutGreen = (record: RerunRecord, read: PullFeedback): boolean =>
  read.pendingRequired !== undefined && read.pendingRequired.length === 0 && !record.candidates.some(({ check }) => read.failures.some(({ name }) => name === check));

/**
 * THE RERUN BEFORE A ROUND (A11-300). The code's own red checks at a head no one has rerun at are rerun once, and a worker is asked only if they are red again. The failed jobs of a run can be rerun only once the run
 * has finished ({@link runStillGoing} is why `answerPull` waits). Null when the checks are not rerun: one has no job page to rerun, or the host refused, and the round is started as it was before A11-300.
 */
function rerunBeforeRound(ctx: PoolContext, entry: Entry, pull: Readonly<{ url: string; read: PullFeedback }>, checks: Readonly<{ own: readonly ReadCheck[]; infrastructure: readonly ReadCheck[] }>): { lines: string[]; answer: CheckHead } | null {
  const { read } = pull;
  const { own, infrastructure } = checks;
  if (own.some(({ detailsUrl }) => detailsUrl === null)) return null;
  const now = ctx.now();
  const head = read.head!;
  const refused = rerun(ctx, [...own, ...infrastructure]);
  if (refused !== null) {
    log(`${entry.ticket.key}: ${names(own)} failed on ${short(head)} and could not be rerun (${refused}): a worker is asked`);
    return null;
  }
  const note = `Reran ${names(own)} on ${short(head)} before asking a worker: a worker is asked only if ${own.length === 1 ? "it fails" : "they fail"} again`;
  log(`${entry.ticket.key}: ${note}`);
  return { lines: [], answer: rerunRecord(head, note, "code", now, own) };
}

/**
 * THE PASS ON A RERUN (A11-300): the head's record is a rerun of the code's own checks, and none of them is red or running now. Each test or step that failed is written to the flake log with its run and the head, once: the
 * record that comes back says `passed`. Null when the rerun has not come out green, or the host does not say which required checks are still running, which is no evidence that none is.
 */
function recordPassOnRerun(ctx: PoolContext, entry: Entry, pull: Readonly<{ url: string; read: PullFeedback }>, known: CheckHead | undefined): CheckHead | null {
  const { url, read } = pull;
  if (!isUnsettledRerun(known, read.head) || !rerunCameOutGreen(known.rerun, read)) return null;
  const record = known.rerun;
  const at = ctx.now();
  const flakes: Flake[] = record.candidates.map((candidate) => ({ ...candidate, head: known.head, pull: url, at }));
  try {
    ctx.flakes.record(flakes);
  } catch (err) {
    log(`${entry.ticket.key}: the flakes of ${url} could not be recorded: ${messageOf(err)}`);
  }
  const note = `${record.candidates.map(({ check }) => check).join(", ")} failed on ${short(known.head)} and passed on rerun: recorded as a flake`;
  log(`${entry.ticket.key}: ${note}`);
  return { ...known, note, rerun: { ...record, passed: true } };
}

/** Whether a rerun's red check is still the failure that was rerun, not yet replaced on the host by the rerun's own run (A11-300): it finished before the rerun, shortly after it. PURE. */
const stillTheRerunFailure = (known: CheckHead | undefined, read: PullFeedback, now: number): boolean =>
  known?.rerun !== undefined && read.failedAt !== null && read.failedAt <= known.rerun.at && now - known.rerun.at < RERUN_SETTLE_MS;

/**
 * THE RERUN AFTER A "NOT MINE" (A11-300). A round for the code's red checks ended with the head where it was (the record is still the round's, at this head, and the checks are still red), and the worker's reply on the pull
 * request says the failure is not its change's: the failed jobs are rerun once, rather than leaving the pull request red and unreviewed. A round's replies are read once. Null when no reply says so, they could not be read, or this
 * is not the round's end; a host that refuses the rerun names the checks for a person.
 */
function rerunOnUnrelatedReply(ctx: PoolContext, entry: Entry, pull: Readonly<{ url: string; read: PullFeedback }>, foreign: ForeignReds): CheckHead | null {
  const { url, read } = pull;
  const self = ctx.ownLogin.value;
  const asked = `${url}@${read.head}`;
  // Without the round's start there is no telling which replies are the round's.
  if (self === null || entry.startedAt === undefined) return null;
  if (ctx.repliesRead.has(asked) || typeof ctx.codeHost.readReplies !== "function") return null;
  const replies = ctx.codeHost.readReplies(url, { since: entry.startedAt, authors: [self] });
  if (replies === null) return null;
  ctx.repliesRead.add(asked);
  if (!replies.some(({ text }) => saysUnrelated(text))) return null;
  const reds = foreign(entry, url);
  const checks = checksToAnswer(read).filter(({ name }) => !reds.names.has(name)).map((check) => readCheck(ctx, check));
  if (checks.length === 0 || checks.some(({ detailsUrl }) => detailsUrl === null)) return null;
  const head = read.head!;
  const refused = rerun(ctx, checks);
  if (refused !== null) {
    const note = `${names(checks)} failed on ${short(head)}, and the worker's reply says the failure is not from the change, but it could not be rerun (${refused}): a person decides`;
    log(`${entry.ticket.key}: ${note}`);
    return { head, step: "named", note };
  }
  const note = `Reran ${names(checks)} on ${short(head)}: the worker's reply says the failure is not from the change`;
  log(`${entry.ticket.key}: ${note}`);
  return rerunRecord(head, note, "reply", ctx.now(), checks.filter(({ infrastructure }) => infrastructure === null));
}

/** What the board said on the card of a pull request it brought up to date with main (A11-215). */
const UPDATED_NOTE = "main is green again: updated from main";

/** Whether the known record is the hold (`not-ours`) at the pull request's head, with checks recorded as waited on main. PURE. */
const isHeldOnMain = (known: CheckHead | undefined, head: string): known is CheckHead & { waitingOnMain: readonly string[] } =>
  known?.step === "not-ours" && known.head === head && (known.waitingOnMain ?? []).length > 0;

/**
 * What main says of the checks a held pull request has red: `failing` when any still fails on it, or on another run's pull request; `unsaid` when the host cannot say which checks pass, which is no evidence that any does;
 * `unsettled` when any is neither failing nor passing there and may still conclude (it is running, or main could not be read); `absent` when main was read and reports no run of one, so the pull request no longer waits on main for it;
 * and `passing` only when every one is reported passing. PURE.
 */
function mainSays(checks: readonly FailingCheck[], reds: ForeignRedsRead): "failing" | "unsaid" | "unsettled" | "absent" | "passing" {
  const { mainPassing, mainPending } = reds;
  if (checks.some(({ name }) => reds.names.has(name))) return "failing";
  if (mainPassing === null) return "unsaid";
  const notPassing = checks.filter(({ name }) => !mainPassing.has(name));
  if (notPassing.length === 0) return "passing";
  return reds.mainBranch === null || mainPending === null || notPassing.some(({ name }) => mainPending.has(name)) ? "unsettled" : "absent";
}

/** The update from main of a held pull request that main's checks have mended, answered by what the code host did: `null` is an update that found nothing to take, which leaves the failure the run's own. */
function updateFromMain(ctx: PoolContext, entry: Entry, pull: Readonly<{ url: string; read: PullFeedback }>, known: CheckHead & { waitingOnMain: readonly string[] }, checks: readonly FailingCheck[]): { lines: string[]; answer: CheckHead } | null {
  const { url, read } = pull;
  const head = read.head!;
  const result = askUpdate(ctx, url, head);
  if (result.kind === "updated") {
    log(`${entry.ticket.key}: ${UPDATED_NOTE} (${url})`);
    return { lines: [], answer: { head, step: "updated", note: UPDATED_NOTE } };
  }
  if (result.kind === "conflict") {
    log(`${entry.ticket.key}: ${url} could not be updated from main: it conflicts with its base`);
    return { lines: [conflictLine(url, read.base)], answer: known };
  }
  if (result.kind === "up-to-date") return null;
  const note = `${heldNote(checks.map(({ name }) => name), known.notOurs ?? {})}; could not update from main (${result.reason}), asked again next watch`;
  if (known.note !== note) log(`${entry.ticket.key}: ${note}`);
  return { lines: [], answer: { ...known, note } };
}

/** The update of a branch, as the code host answers it, or a refusal when the host throws, which the contract says it does not. */
export function askUpdate(ctx: PoolContext, url: string, head: string): UpdateBranchResult {
  try {
    return ctx.codeHost.updateBranch!(url, head);
  } catch (err) {
    return { kind: "refused", reason: messageOf(err) };
  }
}

/**
 * THE RULE OF A11-215: a pull request held as red on main is brought up to date with main once main reports the checks it waits on passing, and not before. It applies when the known record is the hold (`not-ours`) at the pull
 * request's head with checks recorded as waited on main, every check the pull request has red now is one of them, and the host can update a branch. Main is read for those checks now ({@link mainSays}): still failing, or a host that cannot
 * say which checks pass, or main reports no run of one of them, and the pull request is answered as it was before A11-215; neither failing nor passing, and the hold is kept as it is with no round; every one passing, and the update is made, once for the head ({@link updateFromMain}).
 * A pull request that conflicts is not sent to the update: the conflict round the watch starts for it is the answer. One stacked on another branch, or whose run holds a workspace, is not updated either. Returns null when the rule does not apply or is done with the pull request.
 */
function updateHeld(ctx: PoolContext, entry: Entry, pull: Readonly<{ url: string; read: PullFeedback }>, known: CheckHead | undefined, reds: ForeignRedsRead): { lines: string[]; answer: CheckHead | null } | null {
  const { read } = pull;
  if (read.head === null || !isHeldOnMain(known, read.head) || ctx.codeHost.updateBranch === undefined) return null;
  const checks = checksToAnswer(read);
  if (checks.length === 0 || !checks.every(({ name }) => known.waitingOnMain.includes(name))) return null;
  const says = mainSays(checks, reds);
  if (says === "failing" || says === "unsaid" || says === "absent") return null;
  if (says === "unsettled" || read.conflicting) return { lines: [], answer: known };
  // A pull request stacked on another branch would be given that branch and not main: it is answered as it was before A11-215.
  if (read.base !== reds.mainBranch) return null;
  // The board does not push to the branch of a run whose worker holds its workspace (the guard agent-org's own merge of a blocker's branch keeps): the worker's next push would be refused. That is a run parked on a question, which a person answers first.
  if (entry.workspace !== undefined) return { lines: [], answer: known };
  return updateFromMain(ctx, entry, pull, known, checks);
}

/**
 * What the board does about the red checks of one open pull request at its head, once for each head (A11-154): `heads` for the pull request with the answer added, and the lines
 * a round answers, if any. Checks the code failed are rerun once (A11-300, {@link answerOwn}) and briefed with their log lines only if they are red again; a pass on that rerun is recorded as a flake ({@link recordPassOnRerun}). Checks that failed for an
 * infrastructure reason are rerun, once, and named on the card; red again on the same head after that, they are named for a person and no worker gets them. A head with a check of each kind is a rerun and then a round for the code's, which names the others.
 * A round that ended with the head where it was and the checks still red is answered by a rerun when the worker's reply says the failure is not its change's ({@link rerunOnUnrelatedReply}).
 * A check that is red where the run's files are not (`foreign`, A11-179) is the run's no more than an infrastructure failure is a fault in its change: it starts no round and is not rerun, and it is
 * looked at again on every watch, which is why it is the one record that does not end the answer for its head. A pull request held as red on main whose checks main now passes is brought up to date with main instead ({@link updateHeld}).
 */
function answerPull(ctx: PoolContext, entry: Entry, pull: Readonly<{ url: string; read: PullFeedback }>, known: CheckHead | undefined, foreign: ForeignReds): { lines: string[]; answer: CheckHead | null } {
  const { url, read } = pull;
  const none = { lines: [], answer: null };
  if (read.head === null) return none;
  const passed = recordPassOnRerun(ctx, entry, pull, known);
  if (passed !== null) return { lines: [], answer: passed };
  if (read.failing.length === 0) return none;
  const reran = known?.head === read.head && known.step === "rerun";
  const looked = known?.head === read.head && known.step === "not-ours";
  if (known?.head === read.head && !reran && !looked) {
    // A round that ended with the head where it was and the checks still red: its worker's reply may say the failure is not the change's, which the board answers with a rerun (A11-300).
    const answer = known.step === "round" ? rerunOnUnrelatedReply(ctx, entry, pull, foreign) : null;
    return answer === null ? none : { lines: [], answer };
  }
  if (reran && stillTheRerunFailure(known, read, ctx.now())) return none;
  // The failed jobs of a run are rerun only once the run has finished: a head not answered yet waits for its running checks, before any log is read (A11-300).
  if (!reran && !looked && runStillGoing(read, ctx.now())) return none;
  const reds = foreign(entry, url);
  const mended = updateHeld(ctx, entry, pull, known, reds);
  if (mended !== null) return mended;
  const answered = checksToAnswer(read);
  const outside = answered.filter(({ name }) => reds.names.has(name));
  const checks = answered.filter(({ name }) => !reds.names.has(name)).map((check) => readCheck(ctx, check));
  const own = checks.filter((check) => check.infrastructure === null);
  const infrastructure = checks.filter((check) => check.infrastructure !== null);
  if (own.length > 0) return answerOwn(ctx, entry, pull, { own, infrastructure, outside }, reran ? known : undefined);
  // The rerun of the code's own checks is still under way, and what is red now is neither the code's own nor an infrastructure failure: its record is kept, not replaced by a hold or an infrastructure rerun that would forget what to record if it passes (A11-300).
  if (infrastructure.length === 0 && isUnsettledRerun(known, read.head)) return none;
  if (infrastructure.length === 0 && outside.length > 0) return { lines: [], answer: notOursAnswer(ctx, entry, pull, outside, known, reds) };
  return { lines: [], answer: answerInfrastructure(ctx, entry, { head: read.head, checks: infrastructure, reran: reran && known.rerun === undefined }) };
}

/**
 * What the board does about the code's own red checks at a head (A11-300): rerun them once, before any worker is asked; a round for them when they are red again after the rerun, or the rerun could not be made; and, when the rerun
 * was made because a worker's reply said the failure is not its change's, a person decides, since the worker has been asked once and the checks have been rerun once. The round names the infrastructure failures and the checks red elsewhere that it
 * is not about. `reran` is the head's record when the board has rerun its checks already (an infrastructure rerun, or one of the code's own), and undefined when it has not.
 */
function answerOwn(ctx: PoolContext, entry: Entry, pull: Readonly<{ url: string; read: PullFeedback }>, checks: Readonly<{ own: readonly ReadCheck[]; infrastructure: readonly ReadCheck[]; outside: readonly FailingCheck[] }>, reran: CheckHead | undefined): { lines: string[]; answer: CheckHead | null } {
  const { url, read } = pull;
  const { own, infrastructure, outside } = checks;
  const head = read.head!;
  if (reran === undefined) {
    const rerunFirst = rerunBeforeRound(ctx, entry, pull, { own, infrastructure });
    if (rerunFirst !== null) return rerunFirst;
  }
  if (reran?.rerun?.for === "reply") {
    const note = `${names(own)} failed again on ${short(head)} after a rerun the worker's reply asked for: a person decides`;
    log(`${entry.ticket.key}: ${note}`);
    return { lines: [], answer: { head, step: "named", note } };
  }
  const others = outside.length > 0 ? [foreignLine(url, outside.map(({ name }) => name))] : [];
  return { lines: [...ownLines(url, own), ...infrastructure.map((check) => infrastructureLine(url, check)), unrelatedAdvice(url), ...others], answer: { head, step: "round" } };
}

/**
 * Whether the record of a pull request's checks is kept as it is: there is one, it is not one of checks red elsewhere (made again from each watch's reads, A11-179), and the head has not moved. The record of an update
 * from main (A11-215) is also kept once the head has moved, while the new head's checks have not all concluded, so the card goes on saying why they run. PURE.
 */
const isKept = (known: CheckHead | undefined, read: PullFeedback): known is CheckHead =>
  known !== undefined && known.step !== "not-ours" && (read.head === null || known.head === read.head || (known.step === "updated" && (read.pendingRequired ?? []).length > 0));

/** A record the board keeps for a head it has answered. A name for a person is dropped once nothing fails on that head any more: it was fixed, and the head stays answered. PURE. */
function keptRecord(known: CheckHead, read: PullFeedback): CheckHead {
  if (known.step !== "named" || read.failing.length > 0) return known;
  return { head: known.head, step: known.step };
}

/**
 * Answer the red checks of a finished run's open pull requests (A11-154): each pull request whose head has checks failing that the board has not answered at that head. The pull
 * requests that are no longer open, and the heads a pull request has moved off, are dropped from the record. The effects are the rerun of a check that is red at a head, the flakes written when a rerun passes, the reads of the replies of a round that ended with its checks red, and the reads of the
 * logs of the checks that failed; the record is returned, for the caller to write with the round it queues. `foreign` says which checks fail where the run's files are not (A11-179).
 */
export function answerChecks(ctx: PoolContext, entry: Entry, open: readonly Readonly<{ url: string; read: PullFeedback }>[], foreign: ForeignReds = NO_FOREIGN_REDS): CheckAnswer {
  const lines: string[] = [];
  let heads: Record<string, CheckHead> = {};
  let withoutRound: Record<string, CheckHead> = {};
  for (const pull of open) {
    const known = entry.checkHeads?.[pull.url];
    const stays = isKept(known, pull.read) ? { [pull.url]: keptRecord(known, pull.read) } : {};
    const { lines: found, answer } = answerPull(ctx, entry, pull, known, foreign);
    lines.push(...found);
    heads = { ...heads, ...stays, ...(answer === null ? {} : { [pull.url]: answer }) };
    withoutRound = { ...withoutRound, ...stays, ...(answer === null || answer.step === "round" ? {} : { [pull.url]: answer }) };
  }
  return { feedback: lines.length === 0 ? null : lines.join("\n"), heads, withoutRound };
}
