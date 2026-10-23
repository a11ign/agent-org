// @ts-check
// module: the pool's red checks -- which failing checks of a finished run's pull requests the board answers, once for each head: it reruns a check that failed for an infrastructure reason, and briefs a round on the rest

import { CI_CLASS, errorLinesOfLog, LOG_TIMESTAMP, rateLimitOrLostRunner, READS_OUTSIDE, withoutColour } from "../ci-log-lines.ts";
import { rerunOn5xx } from "../ci-rerun-on-5xx.ts";
import { isRollUpCheck } from "../ticket-port/ci-reads.ts";
import type { FailingCheck, PullFeedback } from "../plugins/contracts/code-host.ts";
import { type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { type CheckHead } from "./board-view/view-types-and-filters.ts";
import { log } from "./pool-state.ts";
import { type PoolContext } from "./pool-context.ts";

/** The most error lines a round's brief quotes from the logs of all the checks that failed at a head, and the most characters of each: a brief names the failure, it is not the log. */
const QUOTED_LINES = 40;
const LINE_CHARS = 160;

/** How many of a log's last error lines are read for the cause of a failure: it is at the log's end, and an early line that mentions a rate limit or a refused connection is the code's own output. */
const CAUSE_WINDOW = 5;

/** The characters of a head the card names, as GitHub's own short form does. */
const HEAD_CHARS = 8;

/** A failing check with what its job's log says of it: the lines to quote, and why it is the infrastructure's and not the code's, when it is. */
type ReadCheck = Readonly<{ name: string; lines: readonly string[]; infrastructure: string | null; readable: boolean; detailsUrl: string | null }>;

/** What a pass over a run's red checks found: the feedback a round answers, or null, and the heads the checks were answered at. */
export type CheckAnswer = Readonly<{
  /** The failing checks and their log lines for the round that answers them, or null when no check needs a worker. */
  feedback: string | null;
  /** Everything the board has answered, for the pull requests still open, with this pass's answers added: the whole record, as the entry should hold it. */
  heads: Readonly<Record<string, CheckHead>>;
  /** The same without the answers that are a round: what is recorded when no round is queued, so a rerun already made is not made again. */
  withoutRound: Readonly<Record<string, CheckHead>>;
}>;

/**
 * Why a failing check's log shows the infrastructure and not the code failing, or null: a lost runner or a rate limit, a GitHub server error, or a network error. The log is read
 * without the colour codes and the runner's timestamps, which the failing-assertion rule of the rate-limit read anchors its lines without. PURE.
 */
export function infrastructureCause(log: string): string | null {
  const plain = withoutColour(log).split("\n").map((line) => line.replace(LOG_TIMESTAMP, "")).join("\n");
  // The cause of a job's failure is at its end: a build whose log mentions a rate limit or a refused connection earlier is the code's failure.
  const tail = errorLinesOfLog(plain).slice(-CAUSE_WINDOW);
  if (rateLimitOrLostRunner(tail.join("\n"), CI_CLASS)) return "a runner was lost or a rate limit was hit";
  if (rerunOn5xx({ log: plain, conclusion: "failure", rerunsOnThisHead: false }).action === "rerun") return "GitHub answered with a server error";
  if (tail.some((line) => READS_OUTSIDE.test(line))) return "a network error";
  return null;
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

/** One failing check, with its job's log read. A check with no Actions job, or whose log cannot be read, is `readable: false` and is the code's to answer. */
function readCheck(ctx: PoolContext, check: FailingCheck): ReadCheck {
  const unread = { name: check.name, lines: [], infrastructure: null, readable: false, detailsUrl: check.detailsUrl } as const;
  const text = check.detailsUrl === null ? null : ctx.codeHost.readCheckLog(check.detailsUrl);
  if (text === null) return unread;
  return { ...unread, lines: errorLinesOfLog(text).slice(-QUOTED_LINES).map((line) => line.slice(0, LINE_CHARS)), infrastructure: infrastructureCause(text), readable: true };
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
 * What the board does about the red checks of one open pull request at its head, once for each head (A11-154): `heads` for the pull request with the answer added, and the lines
 * a round answers, if any. Checks the code failed are briefed with their log lines. Checks that failed for an infrastructure reason are rerun, once, and named on the card;
 * red again on the same head after that, they are named for a person and no worker gets them. A head with a check of each kind is a round for the code's, which names the others.
 */
function answerPull(ctx: PoolContext, entry: Entry, pull: Readonly<{ url: string; read: PullFeedback }>, known: CheckHead | undefined): { lines: string[]; answer: CheckHead | null } {
  const { url, read } = pull;
  const none = { lines: [], answer: null };
  if (read.head === null || read.failing.length === 0) return none;
  const reran = known?.head === read.head && known.step === "rerun";
  if (known?.head === read.head && !reran) return none;
  const checks = checksToAnswer(read).map((check) => readCheck(ctx, check));
  const own = checks.filter((check) => check.infrastructure === null);
  const infrastructure = checks.filter((check) => check.infrastructure !== null);
  if (own.length > 0) return { lines: [...ownLines(url, own), ...infrastructure.map((check) => infrastructureLine(url, check))], answer: { head: read.head, step: "round" } };
  const head = short(read.head);
  if (reran) {
    const note = `${names(infrastructure)} failed again on ${head} after a rerun (${reasons(infrastructure)}): a person decides`;
    log(`${entry.ticket.key}: ${note}`);
    return { lines: [], answer: { head: read.head, step: "named", note } };
  }
  const refused = rerun(ctx, infrastructure);
  if (refused !== null) {
    // Asked again on every watch it would read a log and be refused for ever, and no person would hear of it: it is named for one instead.
    const note = `${names(infrastructure)} failed on ${head} for an infrastructure reason (${reasons(infrastructure)}) and could not be rerun (${refused}): a person decides`;
    log(`${entry.ticket.key}: ${note}`);
    return { lines: [], answer: { head: read.head, step: "named", note } };
  }
  const note = `Reran ${names(infrastructure)} on ${head}: ${reasons(infrastructure)}`;
  log(`${entry.ticket.key}: ${note}`);
  return { lines: [], answer: { head: read.head, step: "rerun", note } };
}

/** A record the board keeps for a head it has answered. A name for a person is dropped once nothing fails on that head any more: it was fixed, and the head stays answered. PURE. */
function keptRecord(known: CheckHead, read: PullFeedback): CheckHead {
  if (known.step !== "named" || read.failing.length > 0) return known;
  return { head: known.head, step: known.step };
}

/**
 * Answer the red checks of a finished run's open pull requests (A11-154): each pull request whose head has checks failing that the board has not answered at that head. The pull
 * requests that are no longer open, and the heads a pull request has moved off, are dropped from the record. The effects are the rerun of an infrastructure check, and the reads of the
 * logs of the checks that failed; the record is returned, for the caller to write with the round it queues.
 */
export function answerChecks(ctx: PoolContext, entry: Entry, open: readonly Readonly<{ url: string; read: PullFeedback }>[]): CheckAnswer {
  const lines: string[] = [];
  let heads: Record<string, CheckHead> = {};
  let withoutRound: Record<string, CheckHead> = {};
  for (const pull of open) {
    const known = entry.checkHeads?.[pull.url];
    const stays = known !== undefined && (pull.read.head === null || known.head === pull.read.head) ? { [pull.url]: keptRecord(known, pull.read) } : {};
    const { lines: found, answer } = answerPull(ctx, entry, pull, known);
    lines.push(...found);
    heads = { ...heads, ...stays, ...(answer === null ? {} : { [pull.url]: answer }) };
    withoutRound = { ...withoutRound, ...stays, ...(answer === null || answer.step === "round" ? {} : { [pull.url]: answer }) };
  }
  return { feedback: lines.length === 0 ? null : lines.join("\n"), heads, withoutRound };
}
