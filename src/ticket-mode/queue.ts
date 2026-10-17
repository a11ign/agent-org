// @ts-check
// module: ticket mode's queue -- what you queued, what is running, and how each run ended; pure transitions plus one file
//
// THE PERSON CHOOSES EVERY ENTRY. Nothing is added by a filter or a label: an entry exists because someone selected the ticket on the board (or
// named it to `ticket:serve`'s API) with the model and effort it runs with. The queue runs in the order entries were added. Which repositories a
// ticket is worked in is the worker's call, made from the ticket itself, and is recorded here as the worker makes its worktrees.
//
// EVERY TRANSITION IS A PURE FUNCTION of the queue and returns a new one, so the board, the pool and the tests share one set of rules. The server is
// the only writer of the file, which it replaces whole by rename, so a reader never sees half of one.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CONCLUDED, isBeingPublished, isParked, isPublishing, isWatched, openPulls, RESULT_KINDS, runStatus, settledByPulls, waitsOn } from "./board-view.ts";
import type { Blocker, PullState, Ticket } from "./source.ts";

/** A pull request a run opened: the repository it is in and its web address. */
export type PullRequest = Readonly<{ repo: string; url: string }>;

/** How a finished run ended. A worker writes the first seven; the pool decides the rest. */
export type Outcome =
  | Readonly<{ kind: "draft-pr"; prs: readonly PullRequest[] }>
  /** A worker opened its pull requests ready for review, on a machine with `tickets.drafts: false`: there is nothing to approve. */
  | Readonly<{ kind: "ready-pr"; prs: readonly PullRequest[] }>
  /** A review run marked its pull requests ready, answered their review and left their checks passing. */
  | Readonly<{ kind: "reviewed"; prs: readonly PullRequest[] }>
  | Readonly<{ kind: "planned" }>
  /**
   * The worker checked what the ticket asks and found nothing to change: the reason says what it checked and what it found. Nothing is asked of a
   * person, so the run is not Needs you, and it is not retried: a second worker would check the same thing again.
   */
  | Readonly<{ kind: "checked"; reason: string }>
  | Readonly<{ kind: "wrong-repo"; where: string }>
  | Readonly<{ kind: "needs-human"; reason: string }>
  | Readonly<{ kind: "no-outcome" }>
  | Readonly<{ kind: "crashed"; reason: string }>
  | Readonly<{ kind: "stopped" }>;

export type Phase = "queued" | "starting" | "running" | "finished";

export type Entry = Readonly<{
  ticket: Ticket;
  /** The repositories the worker has made worktrees in, as the pool last saw; empty until it chooses. */
  repos: readonly string[];
  model: string;
  effort: string;
  /**
   * The model and effort the ticket is planned with before it is worked, while it still needs its plan. Its next run is a planning run, and the
   * entry is queued again, without this, once the plan is attached.
   */
  plan?: RunChoice;
  /** Its plan was written by a planning run, which decided for the person: the pull request says what it decided. */
  planned?: boolean;
  /**
   * The batch it is planned in: the tickets one press of Queue planned first, {@link PLAN_BATCH_MAX} at most, which one planning run plans
   * together. While a batch's run is live or parked, every ticket in it holds the run's workspace and pane. Dropped once its plan is attached,
   * on a retry, and when it starts without the rest of its batch.
   */
  batch?: string;
  /** The repository its batch's planner said its work lands in, or null when it named none. Unset for a ticket planned alone. */
  plannedRepo?: string | null;
  phase: Phase;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** The herdr workspace the run's agent is in, while it has one. A finished run that still has one is parked: see {@link park}. */
  workspace?: string;
  /** The herdr pane the run's agent is in, beside its workspace. */
  pane?: string;
  /** Seen `working` at least once, so a later `idle` means a finished turn and not a prompt not yet taken. */
  seenWorking?: boolean;
  /** The agent is in a state that needs a person (a dialog, a prompt), as herdr reported it. */
  waiting?: boolean;
  outcome?: Outcome;
  tokens?: Readonly<{ input: number; output: number }>;
  /** The ticket's state type in the tracker once the run has finished, as last read. */
  trackerState?: string;
  /** The state of each of the ticket's pull requests by URL once the run has finished, as last read: a run whose pull requests merged is done. */
  pullStates?: Readonly<Record<string, PullState>>;
  /** The tickets that block this one, as last read while it is queued; unset until the tracker has been asked. */
  blockers?: readonly Blocker[];
  /** The Claude session the run's worker used, saved when the run ended, so a review run can resume the worker that wrote the code. */
  session?: string;
  /** Set on a review run: the pull requests a person approved, which the run marks ready and sees through their review. See {@link approve}. */
  review?: readonly PullRequest[];
  /** Set on a review round the board started on its own: the new feedback it answers. See {@link feedbackRound}. */
  feedback?: string;
  /** Set on a review round a person asked for with Respond to review: it answers the pull requests' current feedback. See {@link respond}. */
  asked?: boolean;
  /** How many rounds the board has started on its own since a person last approved: at most {@link MAX_FEEDBACK_ROUNDS}. */
  rounds?: number;
  /** Set when the board stopped answering new feedback on its own and handed the run to a person: why. A person's Approve clears it. */
  handedBack?: string;
  /** Set once a publish run posted its pull requests: the first message's web address, or null when it gave none, and when. */
  published?: Readonly<{ link: string | null; at: number }>;
}>;

/**
 * The board's PUBLISH RUN: a short run that posts the pull requests of the runs a person ticked, all in one go, with the host file's
 * `tickets.publish`. One at a time. It holds a worker slot while it is live, and keeps its last result, so the board can say why one failed.
 */
export type PublishRun = Readonly<{
  id: string;
  /** The runs it publishes, by ticket key, and their open pull requests. */
  keys: readonly string[];
  prs: readonly PullRequest[];
  phase: Phase;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  workspace?: string;
  pane?: string;
  seenWorking?: boolean;
  /** Why it failed, once it has: the runs stay Ready to merge. */
  failure?: string;
}>;

/**
 * `paused`: no queued entry starts while it is true. A new queue starts PAUSED, so queueing is never also starting: a person can queue tickets
 * before what the workers need is ready (a dev environment, a merge) and start them on the board when it is.
 */
export type Queue = Readonly<{ entries: readonly Entry[]; max: number; paused: boolean; publish?: PublishRun }>;

export type RunChoice = Readonly<{ model: string; effort: string }>;

const LIVE: ReadonlySet<Phase> = new Set(["starting", "running"]);

export const isLive = (entry: Entry): boolean => LIVE.has(entry.phase);

function replace(queue: Queue, key: string, change: (entry: Entry) => Entry): Queue {
  return { ...queue, entries: queue.entries.map((entry) => (entry.ticket.key === key ? change(entry) : entry)) };
}

const find = (queue: Queue, key: string): Entry | undefined => queue.entries.find((entry) => entry.ticket.key === key);

/** The most tickets one planning run plans. A larger batch is split into runs of this many, in queue order. */
export const PLAN_BATCH_MAX = 8;

/** Which tickets one press of Queue plans first, and on what. `batch` plans them together, {@link PLAN_BATCH_MAX} to a run. */
export type PlanFirst = Readonly<{ keys: ReadonlySet<string>; choice: RunChoice; batch?: boolean }>;

/**
 * Add each ticket not already on the queue, after the last entry. A ticket already there is left as it is. Each ticket `planFirst` names is
 * planned, on its model and effort, before it is worked. With `planFirst.batch`, the ones added are batched in runs of up to
 * {@link PLAN_BATCH_MAX}, in queue order, and a run of one is no batch.
 */
export function enqueue(queue: Queue, tickets: readonly Ticket[], choice: RunChoice, now: number, planFirst: PlanFirst | null = null): Queue {
  const fresh = tickets.filter((ticket) => find(queue, ticket.key) === undefined);
  const planned = fresh.filter((ticket) => planFirst?.keys.has(ticket.key)).map((ticket) => ticket.key);
  const batches = new Map<string, string>();
  for (let start = 0; planFirst?.batch === true && start < planned.length; start += PLAN_BATCH_MAX) {
    const run = planned.slice(start, start + PLAN_BATCH_MAX);
    if (run.length > 1) for (const key of run) batches.set(key, `b${now}-${start / PLAN_BATCH_MAX}`);
  }
  const plan = (ticket: Ticket) => (planFirst?.keys.has(ticket.key) ? { plan: planFirst.choice } : {});
  const batch = (ticket: Ticket) => (batches.has(ticket.key) ? { batch: batches.get(ticket.key) } : {});
  return { ...queue, entries: [...queue.entries, ...fresh.map((ticket): Entry => ({ ticket, repos: [], ...choice, ...plan(ticket), ...batch(ticket), phase: "queued", queuedAt: now }))] };
}

/** The ticket is planned on its own, without the rest of its batch. */
export function leaveBatch(queue: Queue, key: string): Queue {
  return replace(queue, key, ({ batch: _left, ...entry }) => entry);
}

/** Change a queued entry's model or effort. An entry that has started keeps what it started with. */
export function amend(queue: Queue, key: string, choice: Partial<RunChoice>): Queue {
  return replace(queue, key, (entry) => (entry.phase === "queued" ? { ...entry, ...choice } : entry));
}

/** Take a queued entry off. A live or finished one stays: stop the first, and the second is a record. */
export function remove(queue: Queue, key: string): Queue {
  return { ...queue, entries: queue.entries.filter((entry) => entry.ticket.key !== key || entry.phase !== "queued") };
}

/**
 * Take a finished run off the board: a person has read how it ended and wants it gone. Only the queue's record goes. The ticket, its branch, its
 * worktrees and its pull requests are left as they are, and the ticket can be queued again. A queued run is Remove's and a live one is Stop's, so
 * neither is touched, and nor is a parked one: its workspace is closed first (the pool's `dismiss` does both), so no herdr workspace is left open
 * with no run on the board to close it. A run the publish run under way is posting stays until it has posted.
 */
export function dismiss(queue: Queue, key: string): Queue {
  const entry = find(queue, key);
  if (entry === undefined || entry.phase !== "finished" || isParked(entry) || isBeingPublished(entry, queue.publish)) return queue;
  return { ...queue, entries: queue.entries.filter((e) => e.ticket.key !== key) };
}

/**
 * Put a finished entry back at the end of the queue. A draft pull request is not retried: it is the result. Nor is a run that concluded with
 * nothing more to do (`checked`), nor a parked run, until its workspace is closed: a second workspace would take the same herdr name.
 */
export function retry(queue: Queue, key: string, now: number): Queue {
  const entry = find(queue, key);
  if (entry === undefined || entry.phase !== "finished" || isResult(entry) || CONCLUDED.has(entry.outcome?.kind ?? "") || isParked(entry)) return queue;
  const { ticket, repos, model, effort, plan, planned, session, review, published, feedback, asked, rounds } = entry;
  // A review run that failed is retried as the same review round, resuming the same worker, so it does not start the ticket over, and a round
  // the board started still counts towards its cap. Any other run starts a fresh worker, whose session replaces this one. A ticket of a batch
  // is planned again on its own.
  const round = { ...(session ? { session } : {}), ...(published ? { published } : {}), ...(feedback !== undefined ? { feedback } : {}), ...(asked ? { asked } : {}),
    ...(rounds !== undefined ? { rounds } : {}) };
  const retried: Entry = { ticket, repos, model, effort, ...(plan ? { plan } : {}), ...(planned ? { planned } : {}),
    ...(review ? { review, ...round } : {}), phase: "queued", queuedAt: now };
  return { ...queue, entries: [...queue.entries.filter((e) => e.ticket.key !== key), retried] };
}

/** A run whose outcome is its result, pull requests to show for it: retried, they would only be made again. */
const isResult = (entry: Entry): boolean => RESULT_KINDS.has(entry.outcome?.kind ?? "");

/**
 * A person reviewed a finished run's DRAFT pull requests and approved them: the ticket goes back on the queue, at the end, as a REVIEW RUN. It
 * resumes the worker that wrote the code (its `session`), marks the pull requests ready, waits for their checks and review, and fixes what they
 * find. Only its pull requests still open are reviewed. A run with none open, one parked or settled by its tracker, and one whose pull requests
 * are ready already ({@link respond} is theirs) are left alone.
 */
export function approve(queue: Queue, key: string, now: number): Queue {
  const entry = find(queue, key);
  if (entry === undefined || entry.outcome?.kind !== "draft-pr" || !reviewable(entry)) return queue;
  return { ...queue, entries: [...queue.entries.filter((e) => e.ticket.key !== key), reviewRound(entry, openPulls(entry), now)] };
}

/**
 * A person asked the worker to answer the current feedback on pull requests that are ready already: a run Ready to merge, Published, or handed
 * back because it reached the cap on rounds the board starts on its own. The ticket goes back on the queue, at the end, as a review round that
 * resumes the same worker, and the count of the board's own rounds begins again, so watching carries on after it.
 */
export function respond(queue: Queue, key: string, now: number): Queue {
  const entry = find(queue, key);
  if (entry === undefined || entry.outcome?.kind !== "reviewed" || !reviewable(entry)) return queue;
  return { ...queue, entries: [...queue.entries.filter((e) => e.ticket.key !== key), { ...reviewRound(entry, openPulls(entry), now), asked: true }] };
}

/** A finished run a person can start a review round of: it holds no workspace, the tracker has not settled it, and a pull request is open. */
const reviewable = (entry: Entry): boolean =>
  entry.phase === "finished" && !isParked(entry) && !SETTLED.has(entry.trackerState ?? "") && openPulls(entry).length > 0;

/** A review run of `entry`'s ticket for `prs`, queued at `now`, resuming its worker. A Slack message already posted for them stays its link. */
function reviewRound(entry: Entry, prs: readonly PullRequest[], now: number): Entry {
  const { ticket, repos, model, effort, planned, session, published } = entry;
  return { ticket, repos, model, effort, ...(planned ? { planned } : {}), ...(session ? { session } : {}), ...(published ? { published } : {}), review: prs,
    phase: "queued", queuedAt: now };
}

/** The most review rounds the board starts on its own, on new feedback, between two of a person's approvals. */
export const MAX_FEEDBACK_ROUNDS = 3;

/**
 * New feedback reached a watched run's pull requests after its last round ended (`feedback` says what): the ticket goes back on the queue, at
 * the end, as a review round that answers it, resuming the same worker. After {@link MAX_FEEDBACK_ROUNDS} such rounds since a person last
 * approved, the next trigger hands the run to a person instead, who approves again to let the board carry on. A run the board does not watch
 * ({@link isWatched}) is left alone.
 */
export function feedbackRound(queue: Queue, key: string, feedback: string, now: number): Queue {
  const entry = find(queue, key);
  if (entry === undefined || entry.phase !== "finished" || !isWatched(entry)) return queue;
  const rounds = entry.rounds ?? 0;
  if (rounds >= MAX_FEEDBACK_ROUNDS) {
    const handedBack = `The pull requests keep getting feedback: the board answered ${rounds} rounds on its own and stopped. Respond to review starts another. The latest: ${feedback}`;
    return replace(queue, key, (e) => ({ ...e, handedBack }));
  }
  const round: Entry = { ...reviewRound(entry, openPulls(entry), now), feedback, rounds: rounds + 1 };
  return { ...queue, entries: [...queue.entries.filter((e) => e.ticket.key !== key), round] };
}

/**
 * A person ticked runs Ready to merge and pressed Publish: one publish run is queued for all of them, with their open pull requests. Refused,
 * naming why, while another publish run is under way, and for a run that is not on the queue or not Ready to merge.
 */
export function queuePublish(queue: Queue, keys: readonly string[], now: number): Queue {
  if (isPublishing(queue.publish)) throw new Error("a publish run is under way: wait for it to finish");
  const ticked = [...new Set(keys)];
  if (ticked.length === 0) throw new Error("tick at least one run Ready to merge");
  const entries = ticked.map((key) => {
    const entry = find(queue, key);
    if (entry === undefined || entry.phase !== "finished" || runStatus(entry) !== "ready-to-merge" || isParked(entry)) {
      throw new Error(`${key} is not Ready to merge, so it cannot be published`);
    }
    return entry;
  });
  return { ...queue, publish: { id: `p${now.toString(36)}`, keys: ticked, prs: entries.flatMap(openPulls), phase: "queued", queuedAt: now } };
}

/** Change the publish run, if there is one. */
const replacePublish = (queue: Queue, change: (publish: PublishRun) => PublishRun): Queue =>
  (queue.publish === undefined ? queue : { ...queue, publish: change(queue.publish) });

export const markPublishStarting = (queue: Queue, now: number): Queue => replacePublish(queue, (p) => ({ ...p, phase: "starting", startedAt: now }));

export const markPublishRunning = (queue: Queue, workspace: string, pane: string): Queue =>
  replacePublish(queue, (p) => ({ ...p, phase: "running", workspace, pane }));

/** What herdr says the publish run's agent is doing: `working` marks it seen, so a later `idle` is a finished turn. */
export const observePublish = (queue: Queue, status: string): Queue =>
  replacePublish(queue, (p) => ({ ...p, seenWorking: p.seenWorking === true || status === "working" }));

/**
 * The publish run ended with its messages posted: each run it published is Published, linking the first message, a run that went back on the
 * queue for another round while it posted included.
 */
export function publishDone(queue: Queue, links: readonly string[], now: number): Queue {
  const { publish } = queue;
  if (publish === undefined) return queue;
  const published = { link: links[0] ?? null, at: now };
  const ended: PublishRun = { ...withoutWorkspace(publish), phase: "finished", finishedAt: now };
  return { ...queue, publish: ended, entries: queue.entries.map((e) => (publish.keys.includes(e.ticket.key) ? { ...e, published } : e)) };
}

/** The publish run failed: its runs stay as they were, and the board says why. */
export const publishFailed = (queue: Queue, failure: string, now: number): Queue =>
  replacePublish(queue, (p) => ({ ...withoutWorkspace(p), phase: "finished", finishedAt: now, failure }));

/** A publish run that has ended holds no workspace: it is closed. */
const withoutWorkspace = ({ workspace: _closed, pane: _gone, ...publish }: PublishRun): PublishRun => publish;

/** Whether the queued publish run starts now: it has a slot of its own free. It does not wait on Pause, because a person just asked for it. */
export function publishStarts(queue: Queue): boolean {
  return queue.publish?.phase === "queued" && slotsHeld(queue) < queue.max;
}

export function setPaused(queue: Queue, paused: boolean): Queue {
  return { ...queue, paused };
}

export function setMax(queue: Queue, max: number): Queue {
  if (!Number.isInteger(max) || max < 1) throw new Error(`max must be a whole number of 1 or more, not ${max}`);
  return { ...queue, max };
}

export function markStarting(queue: Queue, key: string, now: number): Queue {
  return replace(queue, key, (entry) => ({ ...entry, phase: "starting", startedAt: now }));
}

/** The repositories the worker has made worktrees in so far. */
export function recordRepos(queue: Queue, key: string, repos: readonly string[]): Queue {
  return replace(queue, key, (entry) => ({ ...entry, repos }));
}

export function markRunning(queue: Queue, key: string, workspace: string, pane: string): Queue {
  return replace(queue, key, (entry) => ({ ...entry, phase: "running", workspace, pane }));
}

/** What herdr says the agent is doing: `working` marks it seen, and any status but the four ordinary ones means it is waiting on a person. */
export function observe(queue: Queue, key: string, status: string): Queue {
  return replace(queue, key, (entry) => ({
    ...entry,
    seenWorking: entry.seenWorking === true || status === "working",
    waiting: !["working", "idle", "done", "unknown"].includes(status),
  }));
}

/** What the pool learned of a run as it ended: the tokens it spent and the Claude session it ran in. */
export type RunRecord = Readonly<{ tokens?: Entry["tokens"]; session?: string }>;

/**
 * A run that ended. Its session is the one it ran in. Where the pool did not learn it, a review run keeps the session it resumed, and any
 * other run has none, so an earlier worker's session is never taken for this one's.
 */
function ended(entry: Entry, outcome: Outcome, now: number, { tokens, session }: RunRecord): Entry {
  const ranIn = session ?? (entry.review ? entry.session : undefined);
  const { session: _earlier, ...rest } = entry;
  return { ...rest, phase: "finished", outcome, finishedAt: now, waiting: false, ...(tokens ? { tokens } : {}), ...(ranIn ? { session: ranIn } : {}) };
}

/** The run has ended and its workspace is gone. */
export function finish(queue: Queue, key: string, outcome: Outcome, now: number, record: RunRecord = {}): Queue {
  return replace(queue, key, (entry) => ({ ...ended(entry, outcome, now, record), workspace: undefined, pane: undefined }));
}

/** The run has ended and keeps its workspace and pane, where a person can answer its agent. */
export function park(queue: Queue, key: string, outcome: Outcome, now: number, record: RunRecord = {}): Queue {
  return replace(queue, key, (entry) => ended(entry, outcome, now, record));
}

/**
 * The ticket has its plan: it goes back on the queue, where it was, to be worked with its own model and effort. A planning run leaves nothing
 * behind but the mark that its plan was decided for the person; `unattended` is false for a plan that reached the ticket some other way.
 */
export function planDone(queue: Queue, key: string, unattended = true): Queue {
  return replace(queue, key, ({ ticket, repos, model, effort, queuedAt, blockers }) =>
    ({ ticket, repos, model, effort, ...(unattended ? { planned: true } : {}), phase: "queued", queuedAt, ...(blockers ? { blockers } : {}) }));
}

/**
 * A ticket planned in a batch has its plan, as {@link planDone}, with the repository its planner said its work lands in. Its blockers are read
 * again before it starts, because the board has just written its batch's order to the tracker.
 */
export function batchPlanDone(queue: Queue, key: string, repo: string | null): Queue {
  return replace(planDone(queue, key), key, ({ blockers: _stale, ...entry }) => ({ ...entry, plannedRepo: repo }));
}

/** A person answered a parked run's agent, which is working again: the run is live once more, and its old outcome and tracker state are dropped. */
export function markResumed(queue: Queue, key: string): Queue {
  return replace(queue, key, (entry) => (isParked(entry)
    ? { ...entry, phase: "running", outcome: undefined, finishedAt: undefined, trackerState: undefined, pullStates: undefined, waiting: false, seenWorking: true }
    : entry));
}

/** A parked run's workspace is closed: the run keeps its outcome and holds no workspace. */
export function unpark(queue: Queue, key: string): Queue {
  return replace(queue, key, (entry) => (isParked(entry) ? { ...entry, workspace: undefined, pane: undefined } : entry));
}

/** The tracker states a finished run can end in, after which its ticket is not read again. */
const SETTLED = new Set(["completed", "canceled", "duplicate"]);

/** The keys of finished runs that neither the tracker nor their pull requests have settled yet: the ones worth asking about again. */
export function unsettledKeys(queue: Queue): string[] {
  return queue.entries.filter((entry) => entry.phase === "finished" && !SETTLED.has(entry.trackerState ?? "") && settledByPulls(entry) === null)
    .map((entry) => entry.ticket.key);
}

/** Record the state of each finished run's pull requests, for each run the tracker named. */
export function recordPullStates(queue: Queue, pulls: ReadonlyMap<string, Readonly<Record<string, PullState>>>): Queue {
  return { ...queue, entries: queue.entries.map((entry) => {
    const states = pulls.get(entry.ticket.key);
    return entry.phase === "finished" && states !== undefined ? { ...entry, pullStates: states } : entry;
  }) };
}

/** Record the tickets that block each queued run, for each run the tracker was asked about. A run that has started keeps what it started with. */
export function recordBlockers(queue: Queue, blockers: ReadonlyMap<string, readonly Blocker[]>): Queue {
  return { ...queue, entries: queue.entries.map((entry) => {
    const found = blockers.get(entry.ticket.key);
    return entry.phase === "queued" && found !== undefined ? { ...entry, blockers: found } : entry;
  }) };
}

/** The keys of queued runs whose blockers have not been read yet. */
export const unreadBlockerKeys = (queue: Queue): string[] =>
  queue.entries.filter((entry) => entry.phase === "queued" && entry.blockers === undefined).map((entry) => entry.ticket.key);

/** Record the tracker's state for each finished run it named. */
export function recordTrackerStates(queue: Queue, states: ReadonlyMap<string, string>): Queue {
  return { ...queue, entries: queue.entries.map((entry) => {
    const state = states.get(entry.ticket.key);
    return entry.phase === "finished" && state !== undefined ? { ...entry, trackerState: state } : entry;
  }) };
}

/**
 * The queued entries to start now, in queue order: none while the queue is paused or the host is loaded past its cores (`wake.ts`'s `hostLoadRefusal` rule, where
 * exactly equal does not refuse), and otherwise as many as the free slots allow. An entry still waiting on a blocker is passed over, and holds
 * no slot. A batch is one run, so its tickets take one slot between them, live or starting.
 */
export function nextStarts(queue: Queue, load: number, cores: number): Entry[] {
  if (queue.paused || load > cores) return [];
  const free = queue.max - slotsHeld(queue);
  const runs = new Set<string>();
  return queue.entries.filter((entry) => {
    if (entry.phase !== "queued" || waitsOn(entry, queue.entries).length > 0) return false;
    if (!runs.has(runOf(entry)) && runs.size >= free) return false;
    runs.add(runOf(entry));
    return true;
  });
}

/** The slots live runs hold: one per run, and one for a live publish run. */
const slotsHeld = (queue: Queue): number =>
  new Set(queue.entries.filter(isLive).map(runOf)).size + (queue.publish !== undefined && LIVE.has(queue.publish.phase) ? 1 : 0);

/** The run an entry starts in, for counting slots: its batch's, which every ticket in the batch shares, or else its own. */
const runOf = (entry: Entry): string => entry.batch ?? entry.ticket.key;

export function emptyQueue(max: number): Queue {
  return { entries: [], max, paused: true };
}

/** The queue on disk, or an empty one with `max` when there is no file yet. */
export function loadQueue(path: string, max: number): Queue {
  if (!existsSync(path)) return emptyQueue(max);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Queue;
  return { entries: parsed.entries ?? [], max: parsed.max ?? max, paused: parsed.paused ?? true, ...(parsed.publish ? { publish: parsed.publish } : {}) };
}

/** Replace the file whole: write beside it, then rename over it. */
export function saveQueue(path: string, queue: Queue): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(queue, null, 2)}\n`);
  renameSync(next, path);
}
