// @ts-check
// module: the reviewers the pool starts for its pull requests -- started once per head, their verdicts posted and closed, and retired with their pull requests

import { readPullState, readReviewState, type Repost, REVIEWER_LOGIN, type ReviewerPort, reviewPostedAt, reviewVerdict, writeReviewerMemory } from "./reviewer-port.ts";
import { log, messageOf, update } from "./pool-state.ts";
import { type Entry } from "./queue/declared-remains.ts";
import { recordVerdictNotPosted } from "./queue/approve.ts";
import { type PoolContext } from "./pool-context.ts";

/**
 * The attempts the pool makes to post a reviewer's verdict that is not on its pull request, per head (A11-83): a re-post of the verdict file, or the
 * one prompt to a reviewer that ended without a file. Past them the failure is said on the run, and nothing is posted again: a review cannot be taken back.
 */
export const MAX_REPOST_ATTEMPTS = 3;

/** What a run says when its reviewer ended without writing a verdict file for its head (A11-83). */
const NO_VERDICT_FILE = "the reviewer ended without writing a verdict file";

/** Writes what the reviewers remember. A file that cannot be written is said, and the reviewers carry on for this run. */
const rememberReviewers = (ctx: PoolContext): void => {
  const { reviewerFile, reviewerMemory, reviewerOn } = ctx;
  if (!reviewerOn) return;
  try { writeReviewerMemory(reviewerFile, reviewerMemory); }
  catch (err) { log(`${reviewerFile} cannot be written, so a restart may start a reviewer again: ${messageOf(err)}`); }
};

/**
 * A reviewer that ended without a review at its head on its pull request (A11-83): the verdict file it wrote is posted again through the door, and a
 * reviewer that ended with no file is prompted once. Every attempt is remembered per head (`reviewerReposts`), and `MAX_REPOST_ATTEMPTS` is the most
 * there are: past them, and when the door refuses a repost for good, the failure is what the run says. Returns that line, or null while there is
 * nothing to say: the reviewer is still working, or an attempt is still to come. Nothing is attempted while the reviewer is working.
 */
function unpostedVerdict(ctx: PoolContext, port: ReviewerPort, url: string, head: string, key: string): string | null {
  const { reviewerReposts } = ctx;
  const ref = { pr: url, head };
  const repost = reviewerReposts.get(key) ?? { attempts: 0 };
  const surfaced = (reason: string) => `verdict not posted: ${reason}`;
  const recordRepost = (next: Repost) => {
    reviewerReposts.set(key, next);
    rememberReviewers(ctx);
  };
  if (repost.attempts >= MAX_REPOST_ATTEMPTS) return surfaced(repost.reason ?? "the verdict is not on the pull request");
  if (port.settled(ref) === "working") return null;
  const file = port.verdictFileOf(ref);
  if (file === null) {
    // Nothing to post. The reviewer is prompted once, as a reviewer that has just started is; a second look with no file is the failure.
    if (repost.attempts > 0) return surfaced(NO_VERDICT_FILE);
    recordRepost({ attempts: 1, reason: NO_VERDICT_FILE });
    const prompted = port.reprompt(ref);
    if ("refusal" in prompted) log(`${url}: ${prompted.refusal}`);
    return null;
  }
  const answer = port.repostVerdict(ref, file);
  if ("posted" in answer) {
    // Counted until a review at this head is on the pull request: the next watch clears the count, and a repost is not made again meanwhile.
    recordRepost({ attempts: repost.attempts + 1 });
    log(`${url}: posted the verdict file ${file} for ${head.slice(0, 8)} through the verdict door`);
    return null;
  }
  const attempts = answer.final ? MAX_REPOST_ATTEMPTS : repost.attempts + 1;
  recordRepost({ attempts, reason: answer.refusal });
  log(`${url}: the verdict at ${head.slice(0, 8)} is not posted (${answer.final ? "not retried" : `attempt ${attempts} of ${MAX_REPOST_ATTEMPTS}`}): ${answer.refusal}`);
  return attempts >= MAX_REPOST_ATTEMPTS ? surfaced(answer.refusal) : null;
}

/**
 * The reviewer for each open pull request of a watched run, when the machine starts one: started once per head (`reviewerStarted`, and the port
 * says whether one is live for that head), and the first `not-convinced` verdict on each head asks the worker to answer it (`reviewerResumed`).
 * Returns the lines a round's brief says it answers, and none for `convinced` or a head with no verdict yet. A reviewer that ended without its verdict
 * on the pull request is looked at first (`unpostedVerdict`), so a reviewer started in this watch is not judged before it has begun.
 * The run records what is still not posted (`verdictNotPosted`), and that is cleared once every pull request has its verdict.
 */
export function reviewerLines(ctx: PoolContext, entry: Entry, urls: readonly string[]): string[] {
  const { closing, gh, reviewer, reviewerReposts, reviewerResumed, reviewerStarted } = ctx;
  if (reviewer === undefined) return [];
  const lines: string[] = [];
  const unposted: string[] = [];
  for (const url of urls) {
    const state = readReviewState(url, gh);
    if (state === null) {
      log(`${url}: its reviewer could not be checked, the next watch asks again`);
      continue;
    }
    const key = `${url}@${state.head}`;
    if (reviewPostedAt(state.reviews, state.head)) {
      if (reviewerReposts.delete(key)) rememberReviewers(ctx);
    } else if (reviewerStarted.has(key)) {
      const said = unpostedVerdict(ctx, reviewer, url, state.head, key);
      if (said !== null) unposted.push(said);
    }
    // A head whose checks have not settled green gets no reviewer yet: this watch passes it by, and the next one asks again. Nor does a pull
    // request GitHub does not show open: a merged one's memory is forgotten once it is retired (`releaseReviewers`), and a tracker that still reads
    // it open must not start a reviewer for it again.
    if (state.settled && !reviewerStarted.has(key) && readPullState(url, gh) === "OPEN") {
      // Recorded BEFORE the start, so an instance stopped while the reviewer starts never starts it again for this head; a refusal un-records
      // it. One herdr already lists for this head (started by an instance that stopped before it could record it) is adopted, not started.
      reviewerStarted.add(key);
      rememberReviewers(ctx);
      const adopted = reviewer.live({ pr: url, head: state.head });
      const started = adopted ? null : reviewer.start({ pr: url, head: state.head });
      if (started !== null && "refusal" in started) {
        log(started.refusal);
        reviewerStarted.delete(key);
        rememberReviewers(ctx);
      } else if (started !== null) {
        // The port recorded the head its seat's reviewer was started for: written now, so a restart reads that reviewer as live.
        rememberReviewers(ctx);
      }
    }
    // Once its verdict is posted, the reviewer for this head closes: its workspace goes, and its checkout stays (`close`). One still working is kept
    // in `closing`, which `releaseReviewers` asks again: a not-convinced verdict starts a round below, and no watch reads this run until it ends.
    if (reviewVerdict(state.reviews, state.head) !== null && reviewer.live({ pr: url, head: state.head })) {
      const ref = { pr: url, head: state.head };
      const answer = reviewer.close(ref);
      if ("refusal" in answer) {
        log(answer.refusal);
        closing.delete(key);
      } else if (answer.state === "busy") closing.set(key, ref);
      else closing.delete(key);
    }
    if (reviewVerdict(state.reviews, state.head) === "not-convinced" && !reviewerResumed.has(key)) {
      reviewerResumed.add(key);
      rememberReviewers(ctx);
      lines.push(`${REVIEWER_LOGIN} requested changes on ${url} at ${state.head}: fix what its review found, then push.`);
    }
  }
  // Said on the run when it changes, so the board shows what is not posted and the log says it once.
  const said = unposted.length > 0 ? unposted.join("; ") : undefined;
  if (said !== entry.verdictNotPosted) {
    if (said !== undefined) log(`${entry.ticket.key}: ${said}`);
    update(ctx, (queue) => recordVerdictNotPosted(queue, entry.ticket.key, said));
  }
  return lines;
}

/**
 * Drops what the pool remembers of a pull request: its `url@head` keys (started, resumed, re-posts) and any verdict still awaiting its close.
 */
function forgetPull(ctx: PoolContext, url: string): void {
  const { closing, reviewerReposts, reviewerResumed, reviewerStarted } = ctx;
  const ofPull = (key: string) => key.startsWith(`${url}@`);
  for (const key of [...reviewerStarted, ...reviewerResumed, ...reviewerReposts.keys()]) {
    if (ofPull(key)) {
      reviewerStarted.delete(key);
      reviewerResumed.delete(key);
      reviewerReposts.delete(key);
    }
  }
  for (const key of [...closing.keys()]) if (ofPull(key)) closing.delete(key);
  rememberReviewers(ctx);
}

/**
 * The reviewers of pull requests that have merged or closed, and of the verdicts still awaiting a close, asked on the server's own sweep (every
 * `FEEDBACK_MS`), not on `watchFeedback`: a merged run leaves the watch, and a `ticket:review` reviewer has no run at all. Each pull request the pool
 * remembers, and each the session lists, has its state read: a merged or closed one is retired (its workspaces, then its checkout, then what is
 * remembered of it), while an open one is left, and one whose state cannot be read is asked again next sweep.
 */
export function releaseReviewers(ctx: PoolContext): void {
  const { closing, gh, reviewer, reviewerStarted } = ctx;
  if (reviewer === undefined) return;
  for (const [key, ref] of [...closing]) {
    const answer = reviewer.close(ref);
    if ("refusal" in answer) log(answer.refusal);
    if ("refusal" in answer || answer.state !== "busy") closing.delete(key);
  }
  const pulls = new Set([...reviewerStarted].map((key) => key.slice(0, key.lastIndexOf("@"))));
  for (const url of reviewer.listedPulls()) pulls.add(url);
  for (const url of pulls) {
    const state = readPullState(url, gh);
    if (state === null) {
      log(`${url}: its state could not be read, so its reviewer is kept; the next sweep asks again`);
      continue;
    }
    if (state === "OPEN") continue;
    const answer = reviewer.retire(url);
    if ("refusal" in answer) {
      log(answer.refusal);
      continue;
    }
    if (answer.report !== null) log(answer.report);
    // Forgotten only now that its workspaces and its checkout are gone: until then the next sweep retries it.
    forgetPull(ctx, url);
  }
}
