// @ts-check
// module: bringing a ticket's open pull requests up to date with their base, and the conflict round when that cannot be done (A11-286)
//
// EVERY OPEN PULL REQUEST THE BOARD OPENED IS LOOKED AT, WHATEVER PHASE ITS RUN IS IN. `watchFeedback` reads the pull requests of a finished run; a pull request of a ticket that was queued for its next step, queued again, or whose run ended
// asking a person is in no finished run's record, and went `CONFLICTING` unseen (a11ign/agent-org#1921). `watchKeptPulls` reads those, which `kept-pulls.ts` finds from the run log.
//
// ONE RULE FOR A PULL REQUEST THAT CONFLICTS OR IS BEHIND ({@link mergeBaseInto}), the cheap fix first: the code host's `updateBranch` merges the base into the branch, and the armed auto-merge carries on once the new head's checks pass. Only a
// conflict the host reports as real starts a worker: the files it touches are listed with a dry merge in the clone, and a conflict round names them, the base and the merge command. A pull request that is `BEHIND` is updated the same way before
// the merge queue takes it (contract 1.24). The board does not push to a branch whose worker holds a workspace (the rule of A11-215), nor to a stacked run's (`rebaseStacked`, the restack of A11-248) or one in the merge queue.
//
// THE CONFLICT ROUND RUNS AHEAD OF THE NEXT STEP. A ticket queued for another step is replaced by a review round over the conflicting pull requests, and the step it was queued for waits in `Entry.afterRound` until the round has pushed
// ({@link keptPullRound}, {@link restoreAfterRound}). A finished run that holds a pull request its outcome does not name is handed the round as it is.
import { readEach } from "./pool-reads.ts";
import { askUpdate } from "./pool-checks.ts";
import { baseMergeLines, type BaseMerge } from "./pool-outcome.ts";
import { baseMergeWords } from "./board-view/base-merge-words.ts";
import { isParked, resumesOnConflict } from "./board-view/pull-status-and-notes.ts";
import { parsePull } from "./board-view/pull-url.ts";
import { CONCLUDED, openPulls } from "./board-view/view-types-and-filters.ts";
import { unwatchedPullsOf } from "./kept-pulls.ts";
import { log, messageOf, update } from "./pool-state.ts";
import type { PoolContext } from "./pool-context.ts";
import type { PullFeedback } from "../plugins/contracts/code-host.ts";
import { find, replace, reviewRound, SETTLED, type Entry, type PullRequest, type Queue } from "./queue/queue-entries-and-outcomes.ts";
import { conflictFields, conflictRoundFeedback, conflictRoundLeft, type ConflictOn } from "./queue/queue-conflict-rounds.ts";
import { type BaseMergeStep, logEvent, shortReason } from "./queue/run-log.ts";
import { conflictLine } from "./worker-files.ts";

/** One open pull request and what the board read of it. */
type OpenPull = Readonly<{ url: string; read: PullFeedback }>;

/** An open pull request the host said the head of. */
type HeadedPull = Readonly<{ url: string; read: PullFeedback & { head: string } }>;

/** The steps that are events of the run's log: the others are the sweep's own bookkeeping. */
const LOGGED: ReadonlySet<BaseMerge["step"]> = new Set<BaseMerge["step"]>(["merging", "behind", "round", "waiting", "capped", "held"]);

/** How long the host's merge of a base may leave a pull request at the head it was read at, before the board takes the conflict as real: GitHub answers 202 when it starts the merge, and a merge it then fails leaves the head where it was. */
const MERGE_GRACE_MS = 10 * 60_000;

/** The outcomes of a finished run that are a pull request the round pushed to: the next step is queued again after them. */
const PUSHED: ReadonlySet<string> = new Set(["ready-pr", "reviewed"]);

/** Whether the board has done what it does for `head` already: a try that made a decision (an update, a real conflict), a wait for a worker that still holds the branch is not one, nor is a refusal, the cap is while no round is left, and a conflict held for a person is while the run stays one no worker is woken for. */
function triedAt(known: BaseMerge | undefined, head: string, entry: Entry, { url, now }: { url: string; now: number }): boolean {
  if (known === undefined || known.head !== head) return false;
  if (known.step === "waiting" || known.step === "refused") return false;
  // A conflict held for a person is decided again once the run is one the board answers (a Respond, an approval): the round then names the files and the merge command.
  if (known.step === "held") return !resumesOnConflict(entry);
  // A conflict held for the cap is read again once it is old enough for the base to have moved (A11-374), as a merge the host accepted is: a base that moved earns a round.
  return known.step === "capped" ? !conflictRoundLeft(entry, { [url]: { base: known.baseSha ?? null } }) && now - (known.at ?? now) < MERGE_GRACE_MS : true;
}

/** Remember `next` for the pull request, and say it on the run's card and in the log when it is a step the board takes and it is new for the head (the card reads each step once for a head). */
function remember(ctx: PoolContext, entry: Entry, url: string, base: string | null, next: BaseMerge): void {
  const before = ctx.baseMerges.get(url);
  ctx.baseMerges.set(url, { ...next, at: next.at ?? ctx.now() });
  const { step } = next;
  if (!LOGGED.has(step) || (before?.head === next.head && before.step === step)) return;
  const logged = step as BaseMergeStep;
  log(`${entry.ticket.key}: ${baseMergeWords(url, base, logged)}`);
  update(ctx, (queue) => logEvent(queue, entry.ticket.key, ctx.now(), { kind: "base-merge", url, base, step: logged }));
}

/** Where the files of a conflict can be listed: the clone of the pull request's repository and its number, or null when there is no clone here or the host did not say the base. */
function listingPlace(ctx: PoolContext, url: string, base: string | null): Readonly<{ clone: string; repo: string; number: string; base: string }> | null {
  const pull = parsePull(url);
  const clone = pull === null ? undefined : ctx.settings.clones[pull.repo];
  return pull === null || clone === undefined || base === null ? null : { clone, repo: pull.repo, number: pull.number, base };
}

/**
 * The files a real conflict touches, from a dry merge of the pull request's head into its base in the repository's clone: `git merge-tree --write-tree --name-only` exits 1 on a conflict and prints the merged tree's id and then the
 * conflicted files. Null when they cannot be listed: a fetch or a merge that failed, or a merge that finds no conflict. Never rejects.
 */
async function conflictFilesOf(ctx: PoolContext, place: NonNullable<ReturnType<typeof listingPlace>>, head: string): Promise<Listing> {
  const { clone, number, repo, base } = place;
  try {
    await ctx.git(clone, ["fetch", "--quiet", "origin", base, `pull/${number}/head`]);
    await ctx.git(clone, ["merge-tree", "--write-tree", "--name-only", "--no-messages", `origin/${base}`, head]);
    return { files: null, baseSha: await baseShaOf(ctx, clone, base) };
  } catch (err) {
    const { code, stdout } = err as { code?: unknown; stdout?: unknown };
    if (code !== 1 || typeof stdout !== "string") {
      log(`${repo} #${number}: the files its conflict touches could not be listed (${messageOf(err).split("\n")[0]})`);
      return { files: null, baseSha: null };
    }
    const files = stdout.split("\n").slice(1).map((line) => line.trim()).filter((line) => line !== "");
    return { files: files.length === 0 ? null : files, baseSha: await baseShaOf(ctx, clone, base) };
  }
}

/** The commit `origin/<base>` is at in `clone`, which the listing fetched, or null when it cannot be read. It tells a conflict at a base that moved from one at a base that did not (A11-374). Never rejects. */
const baseShaOf = (ctx: PoolContext, clone: string, base: string): Promise<string | null> =>
  ctx.git(clone, ["rev-parse", `origin/${base}`]).then((out) => (typeof out === "string" ? out.trim() || null : null)).catch(() => null);

/** What the listing of a conflict found: the files it touches (null when they could not be listed) and the commit its base was at (null when not read). */
type Listing = Readonly<{ files: readonly string[] | null; baseSha: string | null }>;

/** `listing`, or one that found nothing when it has not settled within `ms` (a fetch or a merge that hangs must not leave the pull request unanswered for ever) (the board then starts the round without the files). Never rejects, and leaves no timer behind. */
function listedWithin(ms: number, listing: Promise<Listing>): Promise<Listing> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Listing>((resolve) => { timer = setTimeout(() => { log("the files of a conflict were not listed in time, so its round starts without them"); resolve({ files: null, baseSha: null }); }, ms); });
  return Promise.race([listing, late]).finally(() => clearTimeout(timer));
}

/**
 * A real conflict's decision, once its files are known (or known to be unlistable): a round when the run has one left, and the cap otherwise. A finished run's own pull request that the board starts no round for, since the run is a person's (a run handed
 * back is not woken for a conflict, {@link resumesOnConflict}), is `held`: its card says the conflict, and its Respond carries it (A11-293).
 */
function decideRound(ctx: PoolContext, entry: Entry, { url, read }: HeadedPull, { files, baseSha }: Listing): void {
  const latest = find(ctx.store.get(), entry.ticket.key) ?? entry;
  remember(ctx, latest, url, read.base, { head: read.head, step: conflictStep(latest, url, baseSha), files, baseSha });
}

/** The step a real conflict on `url` is decided as: `held` for a finished run's own pull request that no worker is woken for, else `round` while the conflict earns one (a conflict round counts toward no cap, except at a base that did not move since the last one, A11-374) and `capped` once it does not. PURE. */
function conflictStep(entry: Entry, url: string, baseSha: string | null): "held" | "round" | "capped" {
  if (ownsPull(entry, url) && !resumesOnConflict(entry)) return "held";
  return conflictRoundLeft(entry, { [url]: { base: baseSha } }) ? "round" : "capped";
}

/**
 * Read the files of the conflict the host reported at `head`, then decide ({@link decideRound}). The record says `listing` meanwhile, so no sweep acts on the pull request, and no conflict line is given for it, until the files are known.
 * With no clone to list them in there is nothing to wait for: it is decided at once, and null is returned.
 */
function listThenDecide(ctx: PoolContext, entry: Entry, pull: HeadedPull): Promise<void> | null {
  const { url, read } = pull;
  const place = listingPlace(ctx, url, read.base);
  if (place === null) {
    decideRound(ctx, entry, pull, { files: null, baseSha: null });
    return null;
  }
  ctx.baseMerges.set(url, { head: read.head, step: "listing" });
  return listedWithin(ctx.listingMs, conflictFilesOf(ctx, place, read.head)).then((files) => decideRound(ctx, entry, pull, files));
}

/** The listing of a real conflict's files that {@link mergeBaseInto} hands back, in a box: a promise returned from an async function would be waited for there, and the watch must not wait for the listing. */
export type ConflictListing = Readonly<{ settled: Promise<void> }>;

/** {@link listThenDecide}, boxed: null when the conflict was decided at once. */
function listingOf(ctx: PoolContext, entry: Entry, pull: HeadedPull): ConflictListing | null {
  const settled = listThenDecide(ctx, entry, pull);
  return settled === null ? null : { settled };
}

/** Whether the board's merge of the base (or a refusal of it) has stood at the head the pull request is still read at for longer than {@link MERGE_GRACE_MS}: the host accepted the merge and never made it. PURE over the clock. */
function acceptedButUnmoved(ctx: PoolContext, known: BaseMerge | undefined, head: string): boolean {
  const waited = ctx.now() - (known?.at ?? ctx.now());
  return known?.head === head && (known.step === "merging" || known.step === "refused" || known.step === "behind") && waited >= MERGE_GRACE_MS;
}

/** Whether a worker holds a workspace in the run, or is starting one. PURE. */
const holdsWorkspace = (entry: Entry): boolean => entry.workspace !== undefined || entry.phase === "starting" || entry.phase === "running";

/** Whether the pull request is one of the run's own, the ones its outcome or round names. PURE. */
const ownsPull = (entry: Entry, url: string): boolean => entry.phase === "finished" && openPulls(entry).some((pull) => pull.url === url);

/** What an open pull request needs of its base, as the step the board records for it: `merging` for a conflict, `behind` for a branch that only lags. Null for one that needs neither, one that is not open, one the host does not say the head of, and one in the merge queue. PURE. */
function needOf(read: PullFeedback): "merging" | "behind" | null {
  if (read.state !== "open" || read.head === null || read.queue?.queued === true) return null;
  if (read.conflicting) return "merging";
  return read.behind === true ? "behind" : null;
}

/**
 * What the board does about one open pull request of `entry`'s ticket that conflicts with its base or is behind it. Answers once the update was asked and its outcome recorded ({@link BaseMerge}), so the caller's pass sees the record: null when no files are to be listed, and otherwise the listing of a real conflict's files, which
 * settles once the record says what is decided, and which the caller answers by deciding the round again.
 *
 * It does nothing for a pull request that is not open, one the host does not say the head of, one in the merge queue, one of a run stacked in its repository (its restack keeps it current), a host that cannot update a branch, and a pull
 * request it has done its part for at this head. A run that holds a workspace is not pushed to: the pull request is recorded as waiting, once, and answered when the run ends. Otherwise the host merges the base in: `updated` is recorded and the
 * armed auto-merge carries on from the new head; `conflict` starts the listing of the files; `up-to-date` means the read was stale and records nothing, so the next head is looked at; a refusal is said once and asked again on the next sweep.
 */
export async function mergeBaseInto(ctx: PoolContext, entry: Entry, pull: OpenPull): Promise<ConflictListing | null> {
  const { url, read } = pull;
  const { head } = read;
  const kind = needOf(read);
  if (kind === null || head === null || ctx.codeHost.updateBranch === undefined) return null;
  const repo = parsePull(url)?.repo;
  if (repo === undefined || entry.stackBase?.repo === repo) return null;
  const known = ctx.baseMerges.get(url);
  const unmoved = acceptedButUnmoved(ctx, known, head);
  if (unmoved && kind === "merging") return listingOf(ctx, entry, { url, read: { ...read, head } });
  if (!unmoved && triedAt(known, head, entry, { url, now: ctx.now() })) return null;
  // A pull request held red on main is brought up to date once main is green (A11-215), not before: merging a branch that is only behind would take the red in.
  const held = entry.checkHeads?.[url];
  if (kind === "behind" && held?.step === "not-ours" && held.head === head) return null;
  if (holdsWorkspace(entry)) {
    // The run's own pull request is answered by the watch (a parked run is woken on a conflict, A11-89): only another pull request of the ticket waits on the worker.
    if (!ownsPull(entry, url)) remember(ctx, entry, url, read.base, { head, step: "waiting" });
    return null;
  }
  const result = await askUpdate(ctx, url, head);
  switch (result.kind) {
    case "updated":
      remember(ctx, entry, url, read.base, { head, step: kind });
      return null;
    case "up-to-date":
      return null;
    case "refused":
      if (!(known?.step === "refused" && known.head === head && known.reason === result.reason)) log(`${entry.ticket.key}: ${url} could not be brought up to date with ${read.base ?? "its base"} (${result.reason}); the next watch asks again`);
      ctx.baseMerges.set(url, { head, step: "refused", reason: result.reason, at: known?.step === "refused" && known.head === head ? known.at : ctx.now() });
      return null;
    case "conflict":
      return listingOf(ctx, entry, { url, read: { ...read, head } });
  }
}

/** Whether the board may start a conflict round on `entry` for a pull request its outcome does not name: it is queued as a fresh run (not a round already, not a talk session), or it is finished with no workspace open, and not concluded. */
function takesRound(entry: Entry): boolean {
  if (SETTLED.has(entry.trackerState ?? "")) return false;
  if (entry.phase === "queued") return entry.review === undefined && entry.talk !== true;
  return entry.phase === "finished" && !isParked(entry) && !isConcluded(entry);
}

/** Whether a finished run ended with nothing more to do, or was stopped by a person: it is not woken for a pull request its outcome does not name. PURE. */
const isConcluded = (entry: Entry): boolean => CONCLUDED.has(entry.outcome?.kind ?? "") || entry.outcome?.kind === "stopped";

/**
 * The round that merges the base into pull requests of the ticket's earlier steps that conflict (A11-286), ahead of whatever the ticket was queued for. PURE.
 * A queued entry is replaced by a review round over `pulls`, and itself stashed as the round's `afterRound`; a finished one is replaced by a review round over its own open pull requests and `pulls`, as the A11-89 round is. The round counts as
 * not one of the board's own, unless its base has not moved since the last conflict round on a pull request (A11-374), and logs a `round` of cause `conflict`. The queue as it was when the run cannot take one: it is gone, it holds a workspace, it is a round already, or its base did not move and the board's rounds are used up.
 */
export function keptPullRound(queue: Queue, key: string, pulls: readonly PullRequest[], feedback: string, now: number, on: ConflictOn): Queue {
  const entry = find(queue, key);
  if (entry === undefined || !takesRound(entry) || !conflictRoundLeft(entry, on)) return queue;
  const review = [...(entry.phase === "finished" ? openPulls(entry) : []), ...pulls].filter(({ url }, at, all) => all.findIndex((pull) => pull.url === url) === at);
  const round: Entry = { ...reviewRound(entry, review, now), feedback: conflictRoundFeedback(queue, entry, on, feedback), ...conflictFields(entry, on), ...(entry.phase === "queued" ? { afterRound: entry } : {}) };
  const queued = { ...queue, entries: [...queue.entries.filter((e) => e.ticket.key !== key), round] };
  return logEvent(queued, key, now, { kind: "round", cause: "conflict", reason: shortReason(round.feedback ?? feedback) });
}

/** Whether a round ended on a pull request, with its workspace closed, and its ticket is not settled by the tracker: it pushed, and the step it held back is still wanted. PURE. */
const hasPushed = (entry: Entry): boolean => entry.phase === "finished" && !isParked(entry) && !SETTLED.has(entry.trackerState ?? "") && PUSHED.has(entry.outcome?.kind ?? "");

/**
 * Queue the step a conflict round held back again, once the round has pushed (A11-286): the entry that holds `afterRound`, is finished with no workspace, and ended on a pull request (`ready-pr` or `reviewed`) is replaced by the stashed
 * entry, queued at `now`, which keeps the rounds the board has started since a person approved so the cap still bounds them. A round that ended asking a person keeps the step waiting. PURE.
 */
export function restoreAfterRound(queue: Queue, key: string, now: number): Queue {
  const entry = find(queue, key);
  if (entry?.afterRound === undefined || !hasPushed(entry)) return queue;
  const stashed = entry.afterRound;
  const rounds = entry.rounds ?? stashed.rounds;
  // What the conflict round counted of the pull requests' conflicts is kept with it (A11-374): the step it held back was queued before them.
  const conflicts = { ...(entry.conflictRounds === undefined ? {} : { conflictRounds: entry.conflictRounds }), ...(entry.conflictBase === undefined ? {} : { conflictBase: entry.conflictBase }) };
  const restored = replace(queue, key, () => ({ ...stashed, ...(rounds === undefined ? {} : { rounds }), ...conflicts, queuedAt: now }));
  return logEvent(restored, key, now, { kind: "requeued", why: "conflict-round" });
}

/** The lines of the round for conflicting pull requests whose merge found a real conflict: each one's conflict line, then the files and the command. */
function roundFeedback(ctx: PoolContext, ready: readonly OpenPull[]): string {
  return ready.flatMap(({ url, read }) => [conflictLine(url, read.base), ...baseMergeLines(read.base, ctx.baseMerges.get(url)?.files)]).join("\n");
}

/** What a sweep of one ticket's kept pull requests reads: the open ones, and whether any could not be read. A pull request found merged or closed is remembered as settled. */
async function readOpenKept(ctx: PoolContext, entry: Entry, pulls: readonly PullRequest[], self: string): Promise<readonly OpenPull[]> {
  const reads = await readEach(pulls, async ({ url }) => ({ url, read: await ctx.codeHost.readPullFeedback(url, self, ctx.feedbackIgnores) }));
  const unread = reads.filter(({ read }) => read === null).map(({ url }) => url);
  if (unread.length > 0) log(`${entry.ticket.key}: the feedback on ${unread.join(", ")} could not be read, so it was not checked; the next watch asks again`);
  const readable = reads.filter((pull): pull is OpenPull => pull.read !== null);
  for (const { url, read } of readable) if (read.state !== "open") ctx.settledPulls.add(url);
  return readable.filter(({ read }) => read.state === "open");
}

/** Queue the step a finished round held back again, when the round has pushed. Written only when it changes the queue. */
function restoreStep(ctx: PoolContext, key: string): void {
  const held = ctx.store.get();
  const restored = restoreAfterRound(held, key, ctx.now());
  if (restored !== held) ctx.store.set(restored);
}

/** Whether `entry` is still a run whose kept pull requests are looked at: it is on the queue, the tracker has not settled its ticket, and it holds a workspace or may take a round. */
const isStillKept = (entry: Entry | undefined): entry is Entry => entry !== undefined && !SETTLED.has(entry.trackerState ?? "") && looksAtKept(entry);

/** Whether a run's kept pull requests are looked at: a run that holds a workspace has them recorded as waiting, and one that may take a round has them answered. A talk session and a round already queued read nothing. */
const looksAtKept = (entry: Entry): boolean => holdsWorkspace(entry) || takesRound(entry);

/**
 * One ticket's sweep: the step a finished round held back is queued again, and the ticket's pull requests that no finished run's watch reads are read and brought up to date, or handed to a conflict round. Returns whether a round was queued.
 */
async function sweepTicket(ctx: PoolContext, key: string): Promise<boolean> {
  restoreStep(ctx, key);
  const entry = find(ctx.store.get(), key);
  if (entry === undefined || SETTLED.has(entry.trackerState ?? "")) return false;
  const pulls = unwatchedPullsOf(ctx.store.get(), entry, ctx.settledPulls);
  if (pulls.length === 0 || !looksAtKept(entry)) return false;
  ctx.ownLogin.value ??= await ctx.codeHost.readOwnLogin();
  const self = ctx.ownLogin.value;
  if (self === null) {
    log("the GitHub account the workers use could not be read, so no kept pull request's feedback was read");
    return false;
  }
  const open = await readOpenKept(ctx, entry, pulls, self);
  // The reads took time: a run that was stopped, dismissed or settled meanwhile is not brought up to date from the copy this sweep began with (A11-356).
  const latest = find(ctx.store.get(), key);
  if (!isStillKept(latest)) return false;
  const before = new Map(open.map(({ url }) => [url, ctx.baseMerges.get(url)]));
  // The updates are asked one after another, as they always were; the listings of real conflicts' files go on together.
  const listings: Promise<void>[] = [];
  for (const pull of open) {
    if (!isStillKept(find(ctx.store.get(), key))) break;
    const listing = await mergeBaseInto(ctx, latest, pull);
    if (listing !== null) listings.push(listing.settled);
  }
  await Promise.all(listings);
  const decided = open.filter(({ url, read }) => {
    const now = ctx.baseMerges.get(url);
    return now !== before.get(url) && now?.step === "round" && now.head === read.head;
  });
  return startRound(ctx, key, decided);
}

/** Queue the round for the pull requests this sweep found a real conflict in. The record of those the run could not take a round for is dropped, so the next sweep decides again. */
function startRound(ctx: PoolContext, key: string, ready: readonly OpenPull[]): boolean {
  if (ready.length === 0) return false;
  const queue = ctx.store.get();
  // A pass of the pool that is filling slots holds the queue's entries from before this await: replacing a queued entry under it would start its old brief as the round. The next sweep decides again.
  const round = ctx.tickState.busy ? queue : keptPullRound(queue, key, ready.map(({ url }) => ({ repo: parsePull(url)?.repo ?? "", url })), roundFeedback(ctx, ready), ctx.now(), Object.fromEntries(ready.map(({ url }) => [url, { base: ctx.baseMerges.get(url)?.baseSha ?? null, files: ctx.baseMerges.get(url)?.files }])));
  if (round === queue) {
    for (const { url } of ready) ctx.baseMerges.delete(url);
    return false;
  }
  ctx.store.set(round);
  return true;
}

/**
 * Sweep the open pull requests of every ticket on the queue that the finished runs' watch (`watchFeedback`) does not read (A11-286): the next step's earlier pull requests while it is queued, running or planned, the ones kept across a re-queue,
 * and the ones of a run that ended asking a person. Sweeps never overlap. Resolves to whether a conflict round was queued, which the caller answers by letting the pool start it. Never rejects.
 */
export async function watchKeptPulls(ctx: PoolContext): Promise<boolean> {
  if (ctx.keptSweep.busy) return false;
  ctx.keptSweep.busy = true;
  let queued = false;
  try {
    for (const { ticket } of [...ctx.store.get().entries]) queued = (await sweepTicket(ctx, ticket.key)) || queued;
  } catch (err) {
    log(`the pull requests kept for the queue's tickets could not all be looked at: ${messageOf(err).split("\n")[0]}`);
  } finally {
    ctx.keptSweep.busy = false;
  }
  return queued;
}
