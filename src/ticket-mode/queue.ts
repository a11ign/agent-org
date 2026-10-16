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
import { isParked, pullsOf, RESULT_KINDS, settledByPulls, waitsOn } from "./board-view.ts";
import type { Blocker, PullState, Ticket } from "./source.ts";

/** A pull request a run opened: the repository it is in and its web address. */
export type PullRequest = Readonly<{ repo: string; url: string }>;

/** How a finished run ended. A worker writes the first five; the pool decides the rest. */
export type Outcome =
  | Readonly<{ kind: "draft-pr"; prs: readonly PullRequest[] }>
  /** A review run marked its pull requests ready, answered their review and left their checks passing. */
  | Readonly<{ kind: "reviewed"; prs: readonly PullRequest[] }>
  | Readonly<{ kind: "planned" }>
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
}>;

/**
 * `paused`: no queued entry starts while it is true. A new queue starts PAUSED, so queueing is never also starting: a person can queue tickets
 * before what the workers need is ready (a dev environment, a merge) and start them on the board when it is.
 */
export type Queue = Readonly<{ entries: readonly Entry[]; max: number; paused: boolean }>;

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
 * Put a finished entry back at the end of the queue. A draft pull request is not retried: it is the result. Nor is a parked run, until its
 * workspace is closed: a second workspace would take the same herdr name.
 */
export function retry(queue: Queue, key: string, now: number): Queue {
  const entry = find(queue, key);
  if (entry === undefined || entry.phase !== "finished" || isResult(entry) || isParked(entry)) return queue;
  const { ticket, repos, model, effort, plan, planned, session, review } = entry;
  // A review run that failed is retried as a review run, resuming the same worker, so it does not start the ticket over. Any other run starts
  // a fresh worker, whose session replaces this one. A ticket of a batch is planned again on its own.
  const retried: Entry = { ticket, repos, model, effort, ...(plan ? { plan } : {}), ...(planned ? { planned } : {}),
    ...(review ? { review, ...(session ? { session } : {}) } : {}), phase: "queued", queuedAt: now };
  return { ...queue, entries: [...queue.entries.filter((e) => e.ticket.key !== key), retried] };
}

/** A run whose outcome is its result, pull requests to show for it: retried, they would only be made again. */
const isResult = (entry: Entry): boolean => RESULT_KINDS.has(entry.outcome?.kind ?? "");

/**
 * A person reviewed a finished run's pull requests and approved them: the ticket goes back on the queue, at the end, as a REVIEW RUN. It resumes
 * the worker that wrote the code (its `session`), marks the pull requests ready, waits for their checks and review, and fixes what they find.
 * Only its pull requests still open are reviewed. A run with none open, or one parked or settled by its tracker, is left alone.
 */
export function approve(queue: Queue, key: string, now: number): Queue {
  const entry = find(queue, key);
  if (entry === undefined || entry.phase !== "finished" || !isResult(entry) || isParked(entry) || SETTLED.has(entry.trackerState ?? "")) return queue;
  const prs = pullsOf(entry).filter(({ url }) => entry.pullStates?.[url] !== "merged" && entry.pullStates?.[url] !== "closed");
  if (prs.length === 0) return queue;
  const { ticket, repos, model, effort, planned, session } = entry;
  const review: Entry = { ticket, repos, model, effort, ...(planned ? { planned } : {}), ...(session ? { session } : {}), review: prs, phase: "queued", queuedAt: now };
  return { ...queue, entries: [...queue.entries.filter((e) => e.ticket.key !== key), review] };
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
  const free = queue.max - new Set(queue.entries.filter(isLive).map(runOf)).size;
  const runs = new Set<string>();
  return queue.entries.filter((entry) => {
    if (entry.phase !== "queued" || waitsOn(entry, queue.entries).length > 0) return false;
    if (!runs.has(runOf(entry)) && runs.size >= free) return false;
    runs.add(runOf(entry));
    return true;
  });
}

/** The run an entry starts in, for counting slots: its batch's, which every ticket in the batch shares, or else its own. */
const runOf = (entry: Entry): string => entry.batch ?? entry.ticket.key;

export function emptyQueue(max: number): Queue {
  return { entries: [], max, paused: true };
}

/** The queue on disk, or an empty one with `max` when there is no file yet. */
export function loadQueue(path: string, max: number): Queue {
  if (!existsSync(path)) return emptyQueue(max);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Queue;
  return { entries: parsed.entries ?? [], max: parsed.max ?? max, paused: parsed.paused ?? true };
}

/** Replace the file whole: write beside it, then rename over it. */
export function saveQueue(path: string, queue: Queue): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(queue, null, 2)}\n`);
  renameSync(next, path);
}
