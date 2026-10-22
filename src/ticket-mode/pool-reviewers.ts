// @ts-check
// module: the reviewers the pool starts for its pull requests -- started once per head, their verdicts posted and closed, and retired with their pull requests
//
// EVERY NEW HEAD OF AN OPEN PULL REQUEST GETS A REVIEWER, WHATEVER RUN IT HAS (A11-119). `reviewNewHeads` looks at every open pull request of the repositories
// the org holds on the server's sweep, so a run still running, one that ended `needs-human`, one with no run, and a pull request a person opened are all
// reviewed. `reviewerLines` does the same for the pull requests of a watched run, on `watchFeedback`, and adds the round a requested change asks for. Both go
// through `reviewPull`, so there is one start rule: a head is started once (`reviewerStarted`, recorded before the start), and never when a review is already
// posted on it.
//
// A REPLY TO A BLOCK GETS ONE RE-REVIEW OF THE SAME HEAD (A11-156). A head with the reviewer's `not convinced` review and no new commit stays blocked, and a worker that answers the review in a comment
// (correctly, "not a defect in this diff") had nobody reading it. When the worker's own account, or a person the org declares, replies after the block, `rereviewFor` starts the reviewer once more for that head
// with the replies in its brief, and records it (`reviewerRereviewed`, before the start) so the head is re-reviewed by reply once, whatever is posted after. No commit is needed to get a review.

import { earlierReviewWord, readReviewerMemory, replyAuthorsOf, type Repost, REVIEWER_LOGIN, reviewedRepositoriesOf, type ReviewerPort, type ReviewState, reviewPostedAt, reviewVerdict, reviewWordAt, standingBlock, writeReviewerMemory } from "./reviewer-port.ts";
import { log, messageOf, update } from "./pool-state.ts";
import { REVIEW_LEASE_MS } from "../ticket-port/review-claim.ts";
import { type Entry } from "./queue/queue-entries-and-outcomes.ts";
import { recordVerdictNotPosted } from "./queue/queue-transitions.ts";
import { type PoolContext } from "./pool-context.ts";
import { AWAITING_PERSON_LINE, claimWarning, type PullRead, pullReviewText, REVIEWER_OFF_LINE } from "./board-view/pull-review-state.ts";
import { openPulls, pullsOf } from "./board-view/view-types-and-filters.ts";
import { doneWhenOf } from "./done-when.ts";
import type { Reply } from "../plugins/contracts/code-host.ts";
import type { ReviewBrief } from "../plugins/contracts/reviewer.ts";

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
    const prompted = port.reprompt(ref, briefOf(ctx, url));
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

/** The most replies a re-review's prompt quotes, the newest: the prompt is one argument of one herdr call, and a head with a long thread must still be asked. */
const MAX_REPLIES_QUOTED = 10;

/** The key under which a dropped re-review is kept in `reviewerDropped`, which keys a first start by `url@head` alone: the two are dropped apart. */
const rereviewKey = (key: string): string => `${key}#rereview`;

/**
 * What a start of a reviewer answered: the refusal that started none (null when there is none), the expired claim it took over (null when it took none), and why the head's claim could not be written
 * (A11-172; absent when it could): with a refusal the claim is why nothing started, and without one the reviewer started with no claim, because no other instance is seen.
 */
type StartAnswer = Readonly<{ refusal: string | null; tookOver: string | null; unclaimed?: string }>;

/**
 * What the pool tells a reviewer of the ticket behind `url` (A11-156): the Done-when of the run that holds the pull request, since the reviewer cannot read the tracker. Null when no run holds
 * it (one a person opened, or a run since removed) or its ticket has no such section: the reviewer is then told the pull request is the only copy of the contract it has.
 */
function briefOf(ctx: PoolContext, url: string): ReviewBrief {
  const held = ctx.store.get().entries.find((entry) => pullsOf(entry).some((pull) => pull.url === url));
  return { doneWhen: doneWhenOf(held?.ticket.description) };
}

/** How a start is recorded: the set that holds its `url@head` before the start, the key `reviewerDropped` keeps it under when it is un-recorded, and what it is called in a log line. */
type StartKind = Readonly<{ recorded: Set<string>; droppedKey: (key: string) => string; says: string; brief: ReviewBrief; adopts: boolean }>;

const withUnclaimed = (reason: string | undefined): { unclaimed?: string } => (reason === undefined ? {} : { unclaimed: reason });

/**
 * Starts the reviewer for `url` at `head` (A11-119's one start path, and A11-156's re-review by the same path). Recorded BEFORE the start, so an instance stopped while the reviewer starts never
 * starts it again for this head; a refusal un-records it. A first review adopts one herdr already lists for this head, where a re-review has none to adopt. The port claims the head for
 * this instance first (A11-149), so a head another instance holds is refused here. A refusal is said once per `url@head`, so a sweep every few minutes does
 * not repeat it for a pull request that stays red.
 */
function startWith(ctx: PoolContext, reviewer: ReviewerPort, url: string, head: string, kind: StartKind): StartAnswer {
  const { refusedHeads, reviewerDropped } = ctx;
  const key = `${url}@${head}`;
  const dropped = kind.droppedKey(key);
  kind.recorded.add(key);
  reviewerDropped.delete(dropped);
  rememberReviewers(ctx);
  const adopted = kind.adopts && reviewer.live({ pr: url, head });
  const started = adopted ? null : reviewer.start({ pr: url, head }, kind.brief);
  if (started === null) return { refusal: null, tookOver: null };
  if (!("refusal" in started)) {
    // Why this reviewer has no claim is kept with the start, so the board keeps saying so while it runs, across a restart (A11-172).
    if (started.unclaimed === undefined) ctx.reviewerMemory.unclaimed.delete(key);
    else ctx.reviewerMemory.unclaimed.set(key, started.unclaimed);
    // The port recorded the head its seat's reviewer was started for: written now, so a restart reads that reviewer as live.
    rememberReviewers(ctx);
    log(`${url}: started ${started.label} ${kind.says} ${head.slice(0, 8)}`);
    if (started.tookOver !== undefined) log(`${url}: ${started.tookOver}`);
    return { refusal: null, tookOver: started.tookOver ?? null, ...withUnclaimed(started.unclaimed) };
  }
  kind.recorded.delete(key);
  reviewerDropped.add(dropped);
  rememberReviewers(ctx);
  if (!refusedHeads.has(dropped)) {
    refusedHeads.add(dropped);
    log(started.refusal);
  }
  return { refusal: started.refusal, tookOver: null, ...withUnclaimed(started.unclaimed) };
}

/** The first review of a head (A11-119): recorded in `reviewerStarted`, under the key `reviewerDropped` has always held it by. */
function startFor(ctx: PoolContext, reviewer: ReviewerPort, url: string, head: string): StartAnswer {
  return startWith(ctx, reviewer, url, head, { recorded: ctx.reviewerStarted, droppedKey: (key) => key, says: "for", brief: briefOf(ctx, url), adopts: true });
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
 * What the board keeps of a head's claim that could not be written (A11-172): this start's, else, while a reviewer runs that started without a claim, the reason the pool remembers for it (so a restart, and a start
 * `ticket:review` made, are said too). A refused start is tried again on the next sweep, so it is not kept.
 */
function unclaimedNoteOf(started: StartAnswer | null, rememberedWhileReviewing: string | undefined): PullRead["unclaimed"] {
  if (started?.unclaimed !== undefined) return { reason: started.unclaimed, started: started.refusal === null };
  return started === null && rememberedWhileReviewing !== undefined ? { reason: rememberedWhileReviewing, started: true } : undefined;
}

/**
 * The replies to the reviewer's block, posted after it by the board's own account or a person the org declares (`replyAuthorsOf`), or null when they could not be asked: the account the board acts
 * as cannot be read, or the code host does not answer. Null is never "no reply", so the head is asked about again on the next look; it is said once.
 */
function repliesAfter(ctx: PoolContext, url: string, key: string, since: number): readonly Reply[] | null {
  const { codeHost, ownLogin, refusedHeads } = ctx;
  const unasked = `${key}#replies`;
  const said = (why: string) => {
    if (refusedHeads.has(unasked)) return;
    refusedHeads.add(unasked);
    log(`${url}: ${why}, so a reply to its review is not looked for; the next look asks again`);
  };
  // A code host of contract 1.1 reads no replies: said once, as an unreadable answer is, and no re-review is asked.
  if (typeof codeHost.readReplies !== "function") {
    said("the code host does not read replies");
    return null;
  }
  ownLogin.value ??= codeHost.readOwnLogin();
  if (ownLogin.value === null) {
    said("the account the board acts as could not be read");
    return null;
  }
  const replies = codeHost.readReplies(url, { since, authors: replyAuthorsOf(ownLogin.value) });
  if (replies === null) said("its replies could not be read");
  else refusedHeads.delete(unasked);
  return replies;
}

/**
 * A RE-REVIEW OF A HEAD THAT STAYS BLOCKED, ASKED BY A REPLY (A11-156): when the reviewer's newest review at the head is its `not convinced`, no reviewer is live for the head, the checks are
 * green, and a reply to the block has been posted since by the board's own account or a person the org declares, the reviewer is started once more for the same head, with the replies in its brief.
 * Once: the head is recorded before the start, and is never re-reviewed by reply again whatever is posted after, so a reply the reviewer still rejects cannot summon it again without new work. A new
 * head is a new first review and has no record. Returns the start's answer, or null when nothing was asked.
 */
function rereviewFor(ctx: PoolContext, reviewer: ReviewerPort, url: string, state: ReviewState): StartAnswer | null {
  const { head } = state;
  const key = `${url}@${head}`;
  const block = standingBlock(state.reviews, head);
  const asked = ctx.reviewerRereviewed.has(key) || reviewer.live({ pr: url, head });
  if (block === null || asked || !state.settled) return null;
  const replies = repliesAfter(ctx, url, key, block.at);
  if (replies === null || replies.length === 0 || ctx.codeHost.readPullState(url) !== "OPEN") return null;
  const brief: ReviewBrief = { ...briefOf(ctx, url), rereview: { replies: replies.slice(-MAX_REPLIES_QUOTED).map(({ author, url: where, text }) => ({ author, url: where, text })) } };
  return startWith(ctx, reviewer, url, head, { recorded: ctx.reviewerRereviewed, droppedKey: rereviewKey, says: "to re-review", brief, adopts: false });
}

/**
 * Once its verdict is posted, the reviewer for this head closes: its workspace goes, and its checkout stays (`close`). One still working is kept
 * in `closing`, which `releaseReviewers` asks again: a not-convinced verdict starts a round, and no watch reads this run until it ends.
 * A re-review's reviewer is the exception (A11-156): the block that stands at its head is the one it answers, so it closes once it has posted its own review, or has ended its turn.
 */
function closeAnsweredReviewer(ctx: PoolContext, reviewer: ReviewerPort, url: string, state: ReviewState): void {
  const { closing, reviewerRereviewed } = ctx;
  const { head } = state;
  const ref = { pr: url, head };
  const key = `${url}@${head}`;
  const verdict = reviewVerdict(state.reviews, head);
  const awaitingOwn = reviewerRereviewed.has(key) && verdict === "not-convinced" && reviewer.settled(ref) === "working";
  if (verdict === null || awaitingOwn || !reviewer.live(ref)) return;
  const answer = reviewer.close(ref);
  if ("refusal" in answer) {
    log(answer.refusal);
    closing.delete(key);
  } else if (answer.state === "busy") closing.set(key, ref);
  else closing.delete(key);
}

/** The prefix of the `refusedHeads` key under which a claim problem is said, by its reason (A11-172). A reason is not a `url@head`, so no head's key can clash with it. */
const CLAIM_PROBLEM = "claim:";

/** Says a claim that could not be written once per distinct reason, not once per pull request (A11-172): the pull request's own refusal line is its own, and this is the one line for the cause. */
function sayClaimProblem(ctx: PoolContext, { reason, started }: NonNullable<PullRead["unclaimed"]>): void {
  const said = `${CLAIM_PROBLEM}${reason}`;
  if (ctx.refusedHeads.has(said)) return;
  ctx.refusedHeads.add(said);
  log(started ? `reviews start without a claim on GitHub, because no other instance is seen: ${reason}` : `reviews cannot be claimed on GitHub: ${reason}`);
}

/** Forgets the claim problems no pull request has any more, so one that comes back is said again (A11-172). */
function forgetMendedClaimProblems(ctx: PoolContext): void {
  const standing = new Set([...ctx.pullReads.values()].flatMap(({ unclaimed }) => (unclaimed === undefined ? [] : [`${CLAIM_PROBLEM}${unclaimed.reason}`])));
  for (const key of [...ctx.refusedHeads]) if (key.startsWith(CLAIM_PROBLEM) && !standing.has(key)) ctx.refusedHeads.delete(key);
}

/**
 * One open pull request at its current head, as the pool looks at it (A11-119): a posted verdict is remembered, a reviewer that ended without one is looked
 * at (`unpostedVerdict`), a head whose checks have settled green gets its reviewer once (`startFor`), and a posted verdict closes its reviewer. What it
 * read is kept for the board (`pullReads`). Returns the state read and the verdict not posted, or null when GitHub did not say, which the caller says.
 */
function reviewPull(ctx: PoolContext, reviewer: ReviewerPort, url: string): Readonly<{ state: ReviewState; unposted: string | null }> | null {
  const { codeHost, pullReads, reviewerReposts, reviewerRereviewed, reviewerStarted } = ctx;
  const state = codeHost.readReviewState(url);
  if (state === null) return null;
  const { head } = state;
  const key = `${url}@${head}`;
  const ref = { pr: url, head };
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
  const first = startable && codeHost.readPullState(url) === "OPEN" ? startFor(ctx, reviewer, url, head) : null;
  closeAnsweredReviewer(ctx, reviewer, url, state);
  // The reply to a block asks for one more look at the same head, once the first reviewer has gone.
  const rereview = first === null ? rereviewFor(ctx, reviewer, url, state) : null;
  const started = first ?? rereview;
  const tookOver = tookOverOf(started, pullReads.get(url), head);
  const reviewing = reviewer.live(ref);
  const unclaimed = unclaimedNoteOf(started, reviewing ? ctx.reviewerMemory.unclaimed.get(key) : undefined);
  const read: PullRead = {
    head, settled: state.settled, reviewing, verdict: reviewWordAt(state.reviews, head),
    earlier: earlierReviewWord(state.reviews, head), refusal: started?.refusal ?? null, unposted, ...(tookOver === undefined ? {} : { tookOver }), ...(unclaimed === undefined ? {} : { unclaimed }),
    ...(reviewing && reviewerRereviewed.has(key) && reviewVerdict(state.reviews, head) === "not-convinced" ? { rereview: true } : {}),
  };
  pullReads.set(url, read);
  if (unclaimed !== undefined) sayClaimProblem(ctx, unclaimed);
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
  const { reviewerDropped, reviewerFile, reviewerMemory, reviewerRereviewed, reviewerStarted } = ctx;
  const { memory } = readReviewerMemory(reviewerFile);
  for (const key of memory.started) if (!reviewerDropped.has(key)) reviewerStarted.add(key);
  for (const key of memory.rereviewed) if (!reviewerDropped.has(rereviewKey(key))) reviewerRereviewed.add(key);
  for (const [label, head] of memory.heads) reviewerMemory.heads.set(label, head);
  // The latest sighting of each instance, from the pool's copy or the file's: `ticket:review` may have seen a second instance since this pool last wrote. One past the lease says nothing now, so it is
  // neither taken in nor kept (A11-172).
  for (const [instance, at] of memory.seen) reviewerMemory.seen.set(instance, Math.max(at, reviewerMemory.seen.get(instance) ?? at));
  for (const [instance, at] of reviewerMemory.seen) if (ctx.now() - at >= REVIEW_LEASE_MS) reviewerMemory.seen.delete(instance);
  // Why a start `ticket:review` made has no claim, for the heads still started.
  for (const [key, reason] of memory.unclaimed) if (reviewerStarted.has(key) && !reviewerMemory.unclaimed.has(key)) reviewerMemory.unclaimed.set(key, reason);
}

/**
 * Every open pull request of the repositories the org holds gets its reviewer on each new head, whatever run it has (A11-119): a head whose checks have
 * settled green is started once, a head with a posted verdict is not, and a new head after requested changes is. It runs on the server's sweep, not on
 * `watchFeedback`, which reads only the pull requests of a watched run: one still running, one that ended `needs-human`, and one a person opened with no run
 * are all reviewed here. It queues no worker round, since a round is for a watched run. Runs only where there is a reviewer; what `ticket:review` started
 * is adopted first, so the two never start a second reviewer for one head.
 */
export function reviewNewHeads(ctx: PoolContext): void {
  const { codeHost, pullReads, reviewer, settings } = ctx;
  if (reviewer === undefined) return listWhileOff(ctx);
  adoptRememberedReviewers(ctx);
  const listed = new Set<string>();
  let unlisted = false;
  for (const repository of reviewedRepositoriesOf(settings.clones)) {
    const urls = codeHost.openPullUrlsOf(repository);
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
  forgetMendedClaimProblems(ctx);
}

/** The one line the board shows while some pull request cannot be claimed for review, or runs without a claim (A11-172), or null: only a machine with a reviewer on has one. */
export const claimWarningOf = (ctx: PoolContext): string | null => (ctx.reviewerState === "on" ? claimWarning(ctx.pullReads.values()) : null);

/** The key under which a sweep remembers it said the open pull requests cannot be listed (it shares `refusedHeads`, whose keys are `url@head`, so it can name no head). */
const UNLISTABLE = "unlistable";

/**
 * WITH REVIEWS REQUIRED AND THE REVIEWER OFF (A11-161), the sweep still lists the open pull requests of the repositories the org holds, through the code host, so each shows "waiting on the
 * reviewer (off)": it reads no review and starts nothing. It lists only what the gate names (`reviewedRepositoriesOf`): where the gate does not load (the reason a reviewer may be off) it says so
 * once, and the runs' own pull requests still show the line from the queue (`pullReviewsOf`). Does nothing when reviews are not required: nothing extra is shown anywhere.
 */
function listWhileOff(ctx: PoolContext): void {
  const { codeHost, offPulls, settings } = ctx;
  if (ctx.reviewerState !== "off-required") return;
  let repositories: string[];
  try {
    repositories = reviewedRepositoriesOf(settings.clones);
  } catch (err) {
    // Said once, not on every sweep: the gate that does not load does not load the next time either.
    if (!ctx.refusedHeads.has(UNLISTABLE)) log(`reviews are required and the reviewer is off, and the open pull requests cannot be listed for the board: ${messageOf(err).split("\n")[0]}`);
    ctx.refusedHeads.add(UNLISTABLE);
    return;
  }
  const listed = new Set<string>();
  let unlisted = false;
  for (const repository of repositories) {
    const urls = codeHost.openPullUrlsOf(repository);
    if (urls === null) {
      unlisted = true;
      log(`${repository}: its open pull requests could not be listed, so the board looks again on the next sweep`);
      continue;
    }
    for (const url of urls) listed.add(url);
  }
  // A repository that could not be listed keeps what it showed until the next sweep reads it.
  if (!unlisted) offPulls.clear();
  for (const url of listed) offPulls.add(url);
}

/** The line each of the queue's runs' open pull requests reads as, with no read of GitHub: `text` for each. */
const queueLines = (ctx: PoolContext, text: string): [string, string][] => ctx.store.get().entries.flatMap((entry) => openPulls(entry).map(({ url }): [string, string] => [url, text]));

/**
 * The review line of each open pull request, by its url, as the board words it (A11-119, A11-161). With a reviewer on, the review state the pool read. With reviews required and the reviewer
 * off, "waiting on the reviewer (off)" for each pull request the sweep listed and each of a run's. With no reviewer and no requirement, "awaiting your review" for each of a run's open pull
 * requests, and nothing else: people review there.
 */
export function pullReviewsOf(ctx: PoolContext): Record<string, string> {
  switch (ctx.reviewerState) {
    case "on": return Object.fromEntries([...ctx.pullReads].map(([url, read]) => [url, pullReviewText(read)]));
    case "off-required": return Object.fromEntries([...[...ctx.offPulls].map((url): [string, string] => [url, REVIEWER_OFF_LINE]), ...queueLines(ctx, REVIEWER_OFF_LINE)]);
    case "none": return Object.fromEntries(queueLines(ctx, AWAITING_PERSON_LINE));
  }
}

/**
 * Drops what the pool remembers of a pull request: its `url@head` keys (started, resumed, re-posts, re-reviewed) and any verdict still awaiting its close.
 */
function forgetPull(ctx: PoolContext, url: string): void {
  const { closing, reviewerDropped, reviewerReposts, reviewerRereviewed, reviewerResumed, reviewerStarted } = ctx;
  const ofPull = (key: string) => key.startsWith(`${url}@`);
  for (const key of [...reviewerStarted, ...reviewerResumed, ...reviewerReposts.keys(), ...reviewerRereviewed]) {
    if (ofPull(key)) {
      if (reviewerStarted.has(key)) reviewerDropped.add(key);
      if (reviewerRereviewed.has(key)) reviewerDropped.add(rereviewKey(key));
      reviewerStarted.delete(key);
      ctx.reviewerMemory.unclaimed.delete(key);
      reviewerResumed.delete(key);
      reviewerReposts.delete(key);
      reviewerRereviewed.delete(key);
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
  const { closing, codeHost, reviewer, reviewerRereviewed, reviewerStarted } = ctx;
  if (reviewer === undefined) return;
  for (const [key, ref] of [...closing]) {
    const answer = reviewer.close(ref);
    if ("refusal" in answer) log(answer.refusal);
    if ("refusal" in answer || answer.state !== "busy") closing.delete(key);
  }
  const pulls = new Set([...reviewerStarted, ...reviewerRereviewed].map((key) => key.slice(0, key.lastIndexOf("@"))));
  for (const url of reviewer.listedPulls()) pulls.add(url);
  for (const url of pulls) {
    const state = codeHost.readPullState(url);
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
