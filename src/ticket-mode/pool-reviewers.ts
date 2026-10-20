// @ts-check
// module: the reviewers the pool starts for its pull requests -- started once per head, their verdicts posted and closed, and retired with their pull requests
//
// EVERY NEW HEAD OF AN OPEN PULL REQUEST GETS A REVIEWER, WHATEVER RUN IT HAS (A11-119). `reviewNewHeads` looks at every open pull request of the repositories
// the org holds on the server's sweep, so a run still running, one that ended `needs-human`, one with no run, and a pull request a person opened are all
// reviewed. `reviewerLines` does the same for the pull requests of a watched run, on `watchFeedback`, and adds the round a requested change asks for. Both go
// through `reviewPull`, so there is one start rule: a head is started once (`reviewerStarted`, recorded before the start), and never when a review is already
// posted on it.

import { earlierReviewWord, openPullUrlsOf, readPullState, readReviewState, readReviewerMemory, type Repost, REVIEWER_LOGIN, reviewedRepositoriesOf, type ReviewerPort, type ReviewState, reviewPostedAt, reviewVerdict, reviewWordAt, writeReviewerMemory } from "./reviewer-port.ts";
import { log, messageOf, update } from "./pool-state.ts";
import { type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { recordVerdictNotPosted } from "./queue/queue-transitions.ts";
import { type PoolContext } from "./pool-context.ts";
import { type PullRead, pullReviewText } from "./board-view/pull-review-state.ts";

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
  // Taken in before the write, since `ticket:review` may have recorded a start since this pool last read the file: a write of the pool's copy alone would
  // drop it, and the pool would then start a second reviewer on that head.
  adoptRememberedReviewers(ctx);
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

/** What a start of a reviewer answered: the refusal that started none (null when there is none), and the expired claim it took over (null when it took none). */
type StartAnswer = Readonly<{ refusal: string | null; tookOver: string | null }>;

/**
 * Starts the reviewer for `url` at `head` (A11-119's one start path). Recorded BEFORE the start, so an instance stopped while the reviewer starts never
 * starts it again for this head; a refusal un-records it. One herdr already lists for this head is adopted, not started. The port claims the head for
 * this instance first (A11-149), so a head another instance holds is refused here. A refusal is said once per `url@head`, so a sweep every few minutes does
 * not repeat it for a pull request that stays red.
 */
function startFor(ctx: PoolContext, reviewer: ReviewerPort, url: string, head: string, key: string): StartAnswer {
  const { refusedHeads, reviewerStarted } = ctx;
  reviewerStarted.add(key);
  ctx.reviewerDropped.delete(key);
  rememberReviewers(ctx);
  const adopted = reviewer.live({ pr: url, head });
  const started = adopted ? null : reviewer.start({ pr: url, head });
  if (started === null) return { refusal: null, tookOver: null };
  if (!("refusal" in started)) {
    // The port recorded the head its seat's reviewer was started for: written now, so a restart reads that reviewer as live.
    rememberReviewers(ctx);
    log(`${url}: started ${started.label} for ${head.slice(0, 8)}`);
    if (started.tookOver !== undefined) log(`${url}: ${started.tookOver}`);
    return { refusal: null, tookOver: started.tookOver ?? null };
  }
  reviewerStarted.delete(key);
  ctx.reviewerDropped.add(key);
  rememberReviewers(ctx);
  if (!refusedHeads.has(key)) {
    refusedHeads.add(key);
    log(started.refusal);
  }
  return { refusal: started.refusal, tookOver: null };
}

/**
 * The takeover the board keeps for a head (A11-149): the one this start made, else the one an earlier sweep made on the same head. The sweeps that follow find
 * the reviewer running and start nothing, so the note is kept until the head changes.
 */
function tookOverOf(started: StartAnswer | null, kept: PullRead | undefined, head: string): string | undefined {
  if (started?.tookOver) return started.tookOver;
  return kept?.head === head ? kept.tookOver : undefined;
}

/**
 * One open pull request at its current head, as the pool looks at it (A11-119): a posted verdict is remembered, a reviewer that ended without one is looked
 * at (`unpostedVerdict`), a head whose checks have settled green gets its reviewer once (`startFor`), and a posted verdict closes its reviewer. What it
 * read is kept for the board (`pullReads`). Returns the state read and the verdict not posted, or null when GitHub did not say, which the caller says.
 */
function reviewPull(ctx: PoolContext, reviewer: ReviewerPort, url: string): Readonly<{ state: ReviewState; unposted: string | null }> | null {
  const { closing, gh, pullReads, reviewerReposts, reviewerStarted } = ctx;
  const state = readReviewState(url, gh);
  if (state === null) return null;
  const { head } = state;
  const key = `${url}@${head}`;
  const posted = reviewPostedAt(state.reviews, head);
  let unposted: string | null = null;
  if (posted) {
    if (reviewerReposts.delete(key)) rememberReviewers(ctx);
  } else if (reviewerStarted.has(key)) {
    unposted = unpostedVerdict(ctx, reviewer, url, head, key);
  }
  // A head whose checks have not settled green gets no reviewer yet: this look passes it by, and the next one asks again. Nor does a pull request GitHub
  // does not show open: a merged one's memory is forgotten once it is retired (`releaseReviewers`), and a tracker that still reads it open must not start a
  // reviewer for it again. A new head after requested changes has no posted review, so it is started here.
  const startable = state.settled && !posted && !reviewerStarted.has(key);
  const started = startable && readPullState(url, gh) === "OPEN" ? startFor(ctx, reviewer, url, head, key) : null;
  const tookOver = tookOverOf(started, pullReads.get(url), head);
  // Once its verdict is posted, the reviewer for this head closes: its workspace goes, and its checkout stays (`close`). One still working is kept
  // in `closing`, which `releaseReviewers` asks again: a not-convinced verdict starts a round below, and no watch reads this run until it ends.
  if (reviewVerdict(state.reviews, head) !== null && reviewer.live({ pr: url, head })) {
    const ref = { pr: url, head };
    const answer = reviewer.close(ref);
    if ("refusal" in answer) {
      log(answer.refusal);
      closing.delete(key);
    } else if (answer.state === "busy") closing.set(key, ref);
    else closing.delete(key);
  }
  const read: PullRead = {
    head, settled: state.settled, reviewing: reviewer.live({ pr: url, head }), verdict: reviewWordAt(state.reviews, head),
    earlier: earlierReviewWord(state.reviews, head), refusal: started?.refusal ?? null, unposted, ...(tookOver === undefined ? {} : { tookOver }),
  };
  pullReads.set(url, read);
  return { state, unposted };
}

/**
 * The reviewer for each open pull request of a watched run, when the machine starts one (`reviewPull`): the first `not-convinced` verdict on each head asks
 * the worker to answer it (`reviewerResumed`). Returns the lines a round's brief says it answers, and none for `convinced` or a head with no verdict yet.
 * A reviewer that ended without its verdict on the pull request is looked at first (`unpostedVerdict`), so a reviewer started in this watch is not judged
 * before it has begun. The run records what is still not posted (`verdictNotPosted`), and that is cleared once every pull request has its verdict.
 */
export function reviewerLines(ctx: PoolContext, entry: Entry, urls: readonly string[]): string[] {
  const { reviewer, reviewerResumed } = ctx;
  if (reviewer === undefined) return [];
  const lines: string[] = [];
  const unposted: string[] = [];
  for (const url of urls) {
    const pulled = reviewPull(ctx, reviewer, url);
    if (pulled === null) {
      log(`${url}: its reviewer could not be checked, the next watch asks again`);
      continue;
    }
    const { state, unposted: said } = pulled;
    if (said !== null) unposted.push(said);
    const key = `${url}@${state.head}`;
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

/** Takes in what the reviewer memory file says and the pool does not: a start `ticket:review` made, its `url@head` and its seat's head (A11-119). */
function adoptRememberedReviewers(ctx: PoolContext): void {
  const { reviewerDropped, reviewerFile, reviewerMemory, reviewerStarted } = ctx;
  const { memory } = readReviewerMemory(reviewerFile);
  for (const key of memory.started) if (!reviewerDropped.has(key)) reviewerStarted.add(key);
  for (const [label, head] of memory.heads) reviewerMemory.heads.set(label, head);
}

/**
 * Every open pull request of the repositories the org holds gets its reviewer on each new head, whatever run it has (A11-119): a head whose checks have
 * settled green is started once, a head with a posted verdict is not, and a new head after requested changes is. It runs on the server's sweep, not on
 * `watchFeedback`, which reads only the pull requests of a watched run: one still running, one that ended `needs-human`, and one a person opened with no run
 * are all reviewed here. It queues no worker round, since a round is for a watched run. Runs only where there is a reviewer; what `ticket:review` started
 * is adopted first, so the two never start a second reviewer for one head.
 */
export function reviewNewHeads(ctx: PoolContext): void {
  const { gh, pullReads, reviewer, settings } = ctx;
  if (reviewer === undefined) return;
  adoptRememberedReviewers(ctx);
  const listed = new Set<string>();
  let unlisted = false;
  for (const repository of reviewedRepositoriesOf(settings.clones)) {
    const urls = openPullUrlsOf(repository, gh);
    if (urls === null) {
      unlisted = true;
      log(`${repository}: its open pull requests could not be listed, so their reviewers are looked at on the next sweep`);
      continue;
    }
    for (const url of urls) {
      listed.add(url);
      const before = pullReads.get(url)?.unposted ?? null;
      const pulled = reviewPull(ctx, reviewer, url);
      if (pulled === null) {
        log(`${url}: its reviewer could not be checked, the next sweep asks again`);
        continue;
      }
      // Said when it changes: a verdict that stays unposted is one line, not one per sweep.
      if (pulled.unposted !== null && pulled.unposted !== before) log(`${url}: ${pulled.unposted}`);
    }
  }
  // A pull request no longer open is no longer shown, unless a repository could not be listed: then what it showed stays until the next sweep reads it.
  if (!unlisted) for (const url of [...pullReads.keys()]) if (!listed.has(url)) pullReads.delete(url);
}

/** The review state of each open pull request the pool has read, as the board words it, by its url (A11-119). */
export function pullReviewsOf(ctx: PoolContext): Record<string, string> {
  return Object.fromEntries([...ctx.pullReads].map(([url, read]) => [url, pullReviewText(read)]));
}

/**
 * Drops what the pool remembers of a pull request: its `url@head` keys (started, resumed, re-posts) and any verdict still awaiting its close.
 */
function forgetPull(ctx: PoolContext, url: string): void {
  const { closing, reviewerDropped, reviewerReposts, reviewerResumed, reviewerStarted } = ctx;
  const ofPull = (key: string) => key.startsWith(`${url}@`);
  for (const key of [...reviewerStarted, ...reviewerResumed, ...reviewerReposts.keys()]) {
    if (ofPull(key)) {
      if (reviewerStarted.has(key)) reviewerDropped.add(key);
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
