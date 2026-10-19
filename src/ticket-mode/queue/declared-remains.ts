import { CONCLUDED, openPulls, RESULT_KINDS, type StackBaseRecord } from "../board-view/view-ticket.ts";
import { isBeingPublished, isParked } from "../board-view/settled-by-pulls.ts";
import type { Blocker, PullState, StateMove, Ticket } from "../source.ts";
import type { Draft, Priority, Rejection, ResolvedDuplicate } from "../writer.ts";

/**
 * What a worker's `partial` declaration says remains of its ticket: its words, trimmed, or null for none, which is a blank declaration or the brief's
 * `<what remains>` placeholder. The outcome file and the pull request body read a declaration by this one rule (A11-92). PURE.
 */
export function declaredRemains(text: string): string | null {
  const remains = text.trim();
  return remains === "" || /^<.*>$/.test(remains) ? null : remains;
}

/** A pull request a run opened: the repository it is in and its web address. */
export type PullRequest = Readonly<{ repo: string; url: string }>;

/**
 * A change a worker proposes to its ticket's text (A11-91): the title and description it would have, and why. A field it leaves out stays as it is.
 * `base` is the text the tracker held when the board recorded the proposal, which Apply checks the ticket still holds before it writes anything: the
 * board records it, the worker never does. The board applies a proposal only on a person's request.
 */
export type ProposedEdit = Readonly<{ title?: string; description?: string; why: string; base?: Readonly<{ title: string; description: string }> }>;

/** How a finished run ended. A worker writes the first eight; the pool decides the rest. */
export type Outcome =
  /**
   * `partial` is what remains of the ticket after this pull request, when the worker declared it partial: the pull request then links the ticket
   * and leaves it open, so the board does not complete it on a merge (A11-92).
   */
  | Readonly<{ kind: "draft-pr"; prs: readonly PullRequest[]; partial?: string }>
  /** A worker opened its pull requests ready for review, on a machine with `tickets.drafts: false`: there is nothing to approve. */
  | Readonly<{ kind: "ready-pr"; prs: readonly PullRequest[]; partial?: string }>
  /** A review run marked its pull requests ready, answered their review and left their checks passing. */
  | Readonly<{ kind: "reviewed"; prs: readonly PullRequest[] }>
  | Readonly<{ kind: "planned" }>
  /**
   * The worker checked what the ticket asks and found nothing to change, and the ticket is not finished: the reason says what it checked and what it
   * found. Nothing is asked of a person, so the run is not Needs you, and it is not retried: a second worker would check the same thing again. The
   * ticket stays open.
   */
  | Readonly<{ kind: "checked"; reason: string; edit?: ProposedEdit }>
  /**
   * The worker verified every Done-when item of a ticket that needs no code or pull request, and `evidence` says, per item, what it ran or read and
   * what it showed (A11-91). The board completes the ticket on the tracker, posts the reason and the evidence on it, and the run is Completed.
   */
  | Readonly<{ kind: "done"; reason: string; evidence: readonly string[]; edit?: ProposedEdit }>
  | Readonly<{ kind: "wrong-repo"; where: string }>
  /**
   * `unreadable` is set when the worker's outcome file failed its contract, so the reason names the field and the run is read again once the file
   * changes (A11-118). Optional, so a queue stored before it still reads.
   */
  | Readonly<{ kind: "needs-human"; reason: string; edit?: ProposedEdit; unreadable?: true }>
  | Readonly<{ kind: "no-outcome" }>
  | Readonly<{ kind: "crashed"; reason: string }>
  | Readonly<{ kind: "stopped" }>;

/**
 * What a worker may write that is NOT how its run ended: `working` says its own background work (a shell, a Monitor or a task) is still running
 * and will wake it, so the turn it ends is not the run's end. The pool keeps such a run In progress and records the reason as its
 * {@link WorkingNote}; the next outcome the worker writes replaces it as usual. It is never a {@link Outcome}, so no finished run holds one.
 */
export type WorkingOutcome = Readonly<{ kind: "working"; reason: string }>;

/** Anything a worker can leave in its outcome file: how its run ended, or that it is still working in the background. */
export type WrittenOutcome = Outcome | WorkingOutcome;

/**
 * A running run's latest note, from a `working` outcome: the reason it gave, and `at`, when it wrote the file, so only a newer one replaces it.
 * `idleSince` is when its agent was last seen settling into idle with this note and no newer outcome, and is dropped while the agent works.
 * `stalled` is set once the agent has stayed idle like that for `tickets.stallMinutes`: the board says so, so a run whose background work never
 * woke it, or that forgot its final outcome, is still noticed. Being stalled ends nothing.
 *
 * A11-85: its pane shows no background work (a shell or a Monitor) while it is idle: `noBackgroundSince` is when the board first saw that, and once
 * it has been so for {@link BACKGROUND_GONE_MS}, `stalled` is set with `stallReason` {@link BACKGROUND_GONE}, and `resumed` says the board has
 * prompted the worker once to check its background work and carry on. `resumed` outlasts a newer note, so a worker that writes `working` again with
 * nothing running is refused by the stop hook, not prompted in a loop; live background work seen again clears it.
 */
export type WorkingNote = Readonly<{ reason: string; at: number; idleSince?: number; stalled?: boolean; stallReason?: string; noBackgroundSince?: number; resumed?: boolean }>;

/** The stall reason of a run idle with no background work for {@link BACKGROUND_GONE_MS}: nothing will wake it, so the board prompts it once. */
export const BACKGROUND_GONE = "background work gone";

/** How long a run whose pane shows no background work may sit idle on a `working` note before the board marks it stalled: six 30-second ticks. */
export const BACKGROUND_GONE_MS = 3 * 60_000;

/** What the pane shows of a run's background work: `live` when a shell or a Monitor runs, `none` when neither does, or null when the pane cannot be read. */
export type Background = "live" | "none" | null;

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
  /**
   * The repository its project names (`project-repo.ts`), or null when its project names none: the default for {@link plannedRepo}. Read by the pool
   * while the run is queued, from the project's summary as the tracker holds it, so a summary fixed after the run was queued still reaches it.
   */
  projectRepo?: string | null;
  /**
   * The tickets of its batch its planner said it waits on to merge, rather than stacking on their open pull requests: `wait: "merged"` in the
   * order. Unset when there are none. A retry drops it with {@link plannedRepo}.
   */
  waitMerged?: readonly string[];
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
  /**
   * The state the board moved the ticket out of when a run started it, and the one it moved it to: the record the board puts the ticket back by
   * when the run ends without a pull request. Kept until it is put back, so it survives a restart and a retry. See {@link recordMove}.
   */
  movedFrom?: StateMove;
  /** The ticket's state type in the tracker once the run has finished, as last read. */
  trackerState?: string;
  /** The state of each of the ticket's pull requests by URL once the run has finished, as last read: a run whose pull requests merged is done. */
  pullStates?: Readonly<Record<string, PullState>>;
  /**
   * What remains of the ticket, when the worker declared its pull requests partial (A11-92). The board does not complete the ticket on their merge. Kept
   * through a review round, whose `reviewed` outcome does not say it, and dropped by a retry, which starts a fresh worker.
   */
  partial?: string;
  /**
   * Set once the board has acted on the ticket for a merged pull request its body did not complete (A11-92): it completed the ticket, or found it
   * already finished, or its team has no completed state to move it to, which the log says once.
   */
  closedByBoard?: boolean;
  /** The tickets that block this one, as last read while it is queued; unset until the tracker has been asked. */
  blockers?: readonly Blocker[];
  /**
   * The repository-prefixed paths its plan says its work touches (`repo:path`, `overlap.ts`), as last read while it is queued. Unset until the
   * plan has been read; empty when the plan declares none. A run's footprint, with the files of its open pull requests, is what a run waits on
   * ({@link overlapWait}).
   */
  paths?: readonly string[];
  /**
   * Why its plan could not be downloaded on the last pass (A11-125): the run is held, and the board asks again on every pass. Set by
   * `recordPathsFailure`, and cleared once the plan is read.
   */
  pathsFailure?: string;
  /**
   * The files each of its open pull requests changes, by URL, as the last watch read them: the footprint of a run with a pull request open. An
   * empty name in a list marks a list cut short: the files past those listed are unknown and hold nothing (`footprintOf`).
   */
  pullFiles?: Readonly<Record<string, readonly string[]>>;
  /**
   * Why a reviewer's verdict is not on one of the run's pull requests (A11-83): its reviewer ended without a review at the head, and the pool could
   * not post the verdict file it wrote. Set as the watch finds it, and cleared once a review at that head is on the pull request. The board shows it.
   */
  verdictNotPosted?: string;
  /**
   * What a stacked pull request needs said of its base, by URL (A11-106): a merged base that could not be retargeted, or a branch that is gone. Set as the sweep
   * finds it, and cleared once every pull request's base is current. The board shows it.
   */
  retargets?: Readonly<Record<string, string>>;
  /**
   * The blocker's branch this run was branched from, and the commit it was at, with what agent-org did to keep the run on it (A11-116). Set once the
   * worktree is made from the branch (`stack-base.json`), and carried through a review round, which the pool rebases before it starts.
   */
  stackBase?: StackBaseRecord;
  /** The Claude session the run's worker used, saved when the run ended, so a review run can resume the worker that wrote the code. */
  session?: string;
  /** Set on a review run: the pull requests a person approved, which the run marks ready and sees through their review. See {@link approve}. */
  review?: readonly PullRequest[];
  /** Set on a review round the board started on its own: the new feedback it answers. See {@link feedbackRound}. */
  feedback?: string;
  /** Set on a review round a person asked for with Respond to review: it answers the pull requests' current feedback. See {@link respond}. */
  asked?: boolean;
  /** Set on an asked round for a run the board handed back at its cap for a conflict: the conflict lines, which the round merges the base in for. */
  conflict?: string;
  /**
   * Set when a person started the run anyway, past the overlap it was Blocked on (A11-125): the run it overlapped, its first open pull request's number,
   * and the path both touch (null while that run's files are not read yet). The run no longer waits on that overlap, and the board says so for as
   * long as the run is on the board. Kept through a start, a finish and a retry, and carried by a review round.
   */
  overlapOverride?: Readonly<{ holder: string; pull: string | null; path: string | null; at: number }>;
  /** How many rounds the board has started on its own since a person last approved: at most {@link MAX_FEEDBACK_ROUNDS}. */
  rounds?: number;
  /** Set when the board stopped answering new feedback on its own and handed the run to a person: why. A person's Approve clears it. */
  handedBack?: string;
  /** Set once a publish run posted its pull requests: the first message's web address, or null when it gave none, and when. */
  published?: Readonly<{ link: string | null; at: number }>;
  /** Set while a running run's worker last said its background work is still running: see {@link WorkingNote}. Dropped when the run ends. */
  working?: WorkingNote;
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
export type Queue = Readonly<{ entries: readonly Entry[]; max: number; paused: boolean; publish?: PublishRun; writers?: readonly WriterRun[] }>;

/**
 * A draft a writer run left, as the board holds it: the draft as checked, its duplicates as the tracker has them, and its status. `creating` is kept
 * before the tracker is asked, so a restart in between is seen: the creation is asked again with the same id, and the tracker's own id keeps it to one
 * ticket. `created` carries the ticket's key and address, and whether Pick lists it; `failed` carries why the tracker refused it, or why it was not tried.
 */
export type DraftRecord = Readonly<{
  id: string;
  file: string;
  draft: Draft;
  duplicates: readonly ResolvedDuplicate[];
  status: "creating" | "created" | "failed";
  /** The ticket the board made, once it has. `inPick` says whether Pick's list shows it; absent on a ticket an older board made, which did not say. */
  created?: Readonly<{ key: string; url: string; inPick?: boolean }>;
  /** Why the draft's ticket was not made. */
  failure?: string;
  /** The tracker's warnings on the ticket it made: a relation that did not land. */
  warnings?: readonly string[];
}>;

/** The ticket-writing run's mode: `quick` runs unattended, `grill` asks the person in its terminal before it drafts. */
export type WriterMode = "quick" | "grill";

/** The choices the form made, each a requirement in the writer's brief. */
export type WriterForm = Readonly<{ project?: string; repo?: string; goal?: string; priority?: Priority; parent?: string }>;

/**
 * The phases of a writer run. Only `starting` and `running` hold a worker slot. `creating` is the board making the tickets its drafts describe, once the
 * run's outcome is read: no agent runs then.
 */
export type WriterPhase = "queued" | "starting" | "running" | "creating" | "finished";

/** A new-ticket request and the run that writes its drafts: a record of its own, not a ticket entry, since its ticket does not exist yet. */
export type WriterRun = Readonly<{
  id: string;
  request: string;
  mode: WriterMode;
  form: WriterForm;
  /** The model and effort the run is stamped with when it is queued (the Settings choice, else the host file's). Absent on a run queued before that. */
  model?: string;
  effort?: string;
  phase: WriterPhase;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  workspace?: string;
  pane?: string;
  /** Whether the agent has been seen working, which lets a grill run's next outcome be told from its last. */
  seenWorking?: boolean;
  /** Why the run failed, once it has. A stopped run says so. */
  failure?: string;
  drafts: readonly DraftRecord[];
  rejected: readonly Rejection[];
}>;

/** The most new-ticket requests that are not finished at once: a fourth is refused until one ends. */
export const MAX_WRITER_RUNS = 3;

/** Where a new-ticket request is on the board: queued, writing (its agent, or the board making its tickets), done, or failed. */
export type WriterStatus = "queued" | "writing" | "done" | "failed";

/** The status of a writer run, from its phase and its failure. PURE. */
export function writerStatus(run: WriterRun): WriterStatus {
  if (run.failure !== undefined) return "failed";
  if (run.phase === "queued") return "queued";
  if (run.phase === "finished") return "done";
  return "writing";
}

export type RunChoice = Readonly<{ model: string; effort: string }>;

export const LIVE: ReadonlySet<Phase> = new Set(["starting", "running"]);

export const isLive = (entry: Entry): boolean => LIVE.has(entry.phase);

/**
 * How many runs are live (starting or running): a batch's tickets are one run, and the publish run counts while it is under way. `update` reads
 * it to leave the instance alone while a worker is mid-turn (A11-78). PURE.
 */
export function liveRunCount(queue: Queue): number {
  const runs = new Set(queue.entries.filter(isLive).map((entry) => entry.batch === undefined ? `ticket:${entry.ticket.key}` : `batch:${entry.batch}`));
  return runs.size + (queue.publish !== undefined && LIVE.has(queue.publish.phase) ? 1 : 0) + (queue.writers ?? []).filter(writerLive).length;
}

export function replace(queue: Queue, key: string, change: (entry: Entry) => Entry): Queue {
  return { ...queue, entries: queue.entries.map((entry) => (entry.ticket.key === key ? change(entry) : entry)) };
}

export const find = (queue: Queue, key: string): Entry | undefined => queue.entries.find((entry) => entry.ticket.key === key);

/** The most tickets one planning run plans. A larger batch is split into runs of this many, in queue order. */
export const PLAN_BATCH_MAX = 8;

/** Which tickets one press of Queue plans first, and on what. `batch` plans them together, {@link PLAN_BATCH_MAX} to a run. */
export type PlanFirst = Readonly<{ keys: ReadonlySet<string>; choice: RunChoice; batch?: boolean }>;

/**
 * Refuse a PARENT: a ticket the tracker says has open sub-issues. An epic has nothing of its own to build, so a worker given one plans it, runs,
 * and ends in Needs you with nothing done; one was queued, planned and run twice before this rule (A11-76). The board hides a parent's checkbox,
 * but the page is not the only caller of the API, so the queue holds the rule itself. The reason names each parent, how many sub-issues it has
 * open, and what to do instead. A ticket whose sub-issues are all done or canceled has none open and is queued as any other. PURE.
 */
export function refuseParents(tickets: readonly Ticket[]): void {
  const parents = tickets.filter((ticket) => (ticket.children?.length ?? 0) > 0);
  if (parents.length === 0) return;
  const named = parents.map(({ key, children = [] }) => `${key} has ${children.length} open sub-issue${children.length === 1 ? "" : "s"} (${children.join(", ")})`);
  throw new Error(`${named.join("; ")}: a parent is not queued, because it has nothing of its own to build. Queue its children instead`);
}

/** Two tracker keys in identifier order: by team, then by number as a number, so `A11-9` comes before `A11-10`. PURE. */
export function byIdentifier(a: string, b: string): number {
  const [, teamA = a, numberA = "0"] = /^(.*)-(\d+)$/.exec(a) ?? [];
  const [, teamB = b, numberB = "0"] = /^(.*)-(\d+)$/.exec(b) ?? [];
  return teamA.localeCompare(teamB) || Number(numberA) - Number(numberB) || a.localeCompare(b);
}

/** The order a parent's children are queued in, and what the board says about how it was found. */
export type ChildOrder = Readonly<{ keys: readonly string[]; note: string | null }>;

/**
 * The order to queue a parent's open sub-issues in. PURE.
 *
 * BLOCKING ORDER WHERE THE TRACKER GIVES ONE. `blockers` is the tracker's "blocked by" for each child, as `TicketSource.blockers` reads it, or
 * null for a source that cannot say. A child blocked by a sibling goes after that sibling; a blocker that is not one of the siblings orders
 * nothing here, because the queue holds a run back on it anyway (`board-view.ts`'s `waitsOn`). Among children free to go, identifier order
 * decides, so the same relations always give the same order. Where the tracker gives no order at all, or its relations go round in a cycle,
 * the rest go in identifier order and the note says so, so the person is never told an order is the tracker's when it is not.
 */
export function childOrder(children: readonly string[], blockers: ReadonlyMap<string, readonly Pick<Blocker, "key">[]> | null): ChildOrder {
  const keys = [...new Set(children)].sort(byIdentifier);
  if (blockers === null) return { keys, note: "the tracker gives no blocking order, so they are queued in identifier order" };
  const siblings = new Set(keys);
  const waitsFor = new Map(keys.map((key) => [key, new Set((blockers.get(key) ?? []).map(({ key: blocker }) => blocker).filter((b) => siblings.has(b) && b !== key))]));
  const ordered: string[] = [];
  const left = new Set(keys);
  while (left.size > 0) {
    const free = [...left].find((key) => [...waitsFor.get(key)!].every((blocker) => !left.has(blocker)));
    if (free === undefined) {
      const rest = [...left];
      return { keys: [...ordered, ...rest], note: `the blocking relations among ${rest.join(", ")} go round in a cycle, so those are queued in identifier order` };
    }
    ordered.push(free);
    left.delete(free);
  }
  return { keys: ordered, note: null };
}

/**
 * Add each ticket not already on the queue, after the last entry. A ticket already there is left as it is. Each ticket `planFirst` names is
 * planned, on its model and effort, before it is worked. With `planFirst.batch`, the ones added are batched in runs of up to
 * {@link PLAN_BATCH_MAX}, in queue order, and a run of one is no batch. A parent is refused, whole, before anything is added: see
 * {@link refuseParents}.
 */
export function enqueue(queue: Queue, tickets: readonly Ticket[], choice: RunChoice, now: number, planFirst: PlanFirst | null = null): Queue {
  refuseParents(tickets.filter((ticket) => find(queue, ticket.key) === undefined));
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
 * The board moved the ticket out of `move.from` as a run started. The first move is the one kept: a run that starts a ticket already started
 * moves nothing, and so records nothing, and must not replace or clear what a run recorded.
 */
export function recordMove(queue: Queue, key: string, move: StateMove): Queue {
  return replace(queue, key, (entry) => (entry.movedFrom === undefined ? { ...entry, movedFrom: move } : entry));
}

/** The board has put the ticket back, or left it where a person put it: its record is no longer needed. */
export function clearMove(queue: Queue, key: string): Queue {
  return replace(queue, key, ({ movedFrom: _restored, ...entry }) => entry);
}

/** The edit a finished run's worker proposed to its ticket's text, or undefined when it proposed none (A11-91). PURE. */
export const proposedEdit = (entry: Entry): ProposedEdit | undefined => (entry.outcome !== undefined && "edit" in entry.outcome ? entry.outcome.edit : undefined);

/**
 * The run's proposed edit to its ticket's text is dropped: a person applied it, or discarded it. The run's outcome stays as the worker wrote it.
 * A run with no proposal is left as it is.
 */
export function clearEdit(queue: Queue, key: string): Queue {
  return replace(queue, key, (entry) => {
    const { outcome } = entry;
    if (outcome === undefined || !("edit" in outcome) || outcome.edit === undefined) return entry;
    const { edit: _proposed, ...rest } = outcome;
    return { ...entry, outcome: rest };
  });
}

/**
 * Take a finished run off the board: a person has read how it ended and wants it gone. Only the queue's record goes. The ticket, its branch, its
 * worktrees and its pull requests are left as they are, and the ticket can be queued again. A queued run is Remove's and a live one is Stop's, so
 * neither is touched, and nor is a parked one: its workspace is closed first (the pool's `dismiss` does both), so no herdr workspace is left open
 * with no run on the board to close it. A run the publish run under way is posting stays until it has posted.
 */
export function dismiss(queue: Queue, key: string): Queue {
  const entry = find(queue, key);
  const isUnsettledEntry = entry === undefined || entry.phase !== "finished" || isParked(entry) || isBeingPublished(entry, queue.publish);
  if (isUnsettledEntry) return queue;
  return { ...queue, entries: queue.entries.filter((e) => e.ticket.key !== key) };
}

/**
 * Put a finished entry back at the end of the queue. A draft pull request is not retried: it is the result. Nor is a run that concluded with
 * nothing more to do (`checked`), nor a parked run, until its workspace is closed: a second workspace would take the same herdr name.
 */
export function retry(queue: Queue, key: string, now: number): Queue {
  const entry = find(queue, key);
  const isConcludedEntry = entry === undefined || entry.phase !== "finished" || isResult(entry) || CONCLUDED.has(entry.outcome?.kind ?? "") || isParked(entry);
  if (isConcludedEntry) return queue;
  const { ticket, repos, model, effort, plan, planned, session, review, published, feedback, asked, conflict, rounds, movedFrom, paths, plannedRepo, projectRepo, pullFiles, partial, stackBase, overlapOverride } = entry;
  // A review run that failed is retried as the same review round, resuming the same worker, so it does not start the ticket over, and a round
  // the board started still counts towards its cap. Any other run starts a fresh worker, whose session replaces this one. A ticket of a batch
  // is planned again on its own.
  const round = { ...(session ? { session } : {}), ...(published ? { published } : {}), ...(feedback !== undefined ? { feedback } : {}), ...(asked ? { asked } : {}),
    ...(conflict !== undefined ? { conflict } : {}), ...(rounds !== undefined ? { rounds } : {}), ...carriedFields({ paths, plannedRepo, projectRepo, pullFiles, partial, stackBase }) };
  // The record of the board's move is carried over too: a retried run finds its ticket already started, and would move nothing to record again.
  const retried: Entry = { ticket, repos, model, effort, ...(plan ? { plan } : {}), ...(planned ? { planned } : {}), ...(movedFrom ? { movedFrom } : {}),
    ...(overlapOverride ? { overlapOverride } : {}), ...(review ? { review, ...round } : {}), phase: "queued", queuedAt: now };
  return { ...queue, entries: [...queue.entries.filter((e) => e.ticket.key !== key), retried] };
}

/** A run whose outcome is its result, pull requests to show for it: retried, they would only be made again. */
const isResult = (entry: Entry): boolean => RESULT_KINDS.has(entry.outcome?.kind ?? "");

/** A finished run a person can start a review round of: it holds no workspace, the tracker has not settled it, and a pull request is open. */
export const reviewable = (entry: Entry): boolean =>
  entry.phase === "finished" && !isParked(entry) && !SETTLED.has(entry.trackerState ?? "") && openPulls(entry).length > 0;

/**
 * A review run of `entry`'s ticket for `prs`, queued at `now`, resuming its worker. A Slack message already posted for them stays its link, and the
 * run keeps its footprint: its paths and the files of its pull requests, so it still holds them while it is live.
 */
export function reviewRound(entry: Entry, prs: readonly PullRequest[], now: number): Entry {
  const { ticket, repos, model, effort, planned, session, published, overlapOverride } = entry;
  return { ticket, repos, model, effort, ...(planned ? { planned } : {}), ...(session ? { session } : {}), ...(published ? { published } : {}),
    ...(overlapOverride ? { overlapOverride } : {}), ...carriedFields(entry), review: prs, phase: "queued", queuedAt: now };
}

/**
 * The fields a review round carries from the run it continues, its paths, pull request files and partial declaration: only those the run has set. PURE.
 */
const carriedFields = ({ paths, plannedRepo, projectRepo, pullFiles, partial, stackBase }: Pick<Entry, "paths" | "plannedRepo" | "projectRepo" | "pullFiles" | "partial" | "stackBase">) => ({
  ...(paths ? { paths } : {}), ...(plannedRepo !== undefined ? { plannedRepo } : {}), ...(projectRepo !== undefined ? { projectRepo } : {}), ...(pullFiles ? { pullFiles } : {}),
  ...(partial !== undefined ? { partial } : {}), ...(stackBase ? { stackBase } : {}),
});

/** The tracker states a finished run can end in, after which its ticket is not read again. */
export const SETTLED = new Set(["completed", "canceled", "duplicate"]);

/** Whether a writer run holds a worker slot: it is starting or running. */
export const writerLive = (run: WriterRun): boolean => run.phase === "starting" || run.phase === "running";
