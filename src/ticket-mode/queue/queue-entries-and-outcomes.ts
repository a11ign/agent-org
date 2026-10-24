import { CONCLUDED, openPulls, RESULT_KINDS, type AfterMergeLine, type CheckHead, type PullHead, type StackBaseRecord } from "../board-view/view-types-and-filters.ts";
import { isBeingPublished, isParked } from "../board-view/pull-status-and-notes.ts";
import type { MergedStep } from "../board-view/plan-steps.ts";
import type { BlockerPullDeclared, PartialOverruled, PullDeclared } from "../board-view/pull-declared.ts";
import type { Blocker, PullState, StateMove, Ticket } from "../source.ts";
import type { Priority } from "../writer.ts";
import type { Placement } from "../writer-placement.ts";
import { needsDecision } from "../open-decisions.ts";
import type { PluginCopy, StoppedForUpdate } from "./queue-pins.ts";
import type { TicketRead } from "../ticket-read.ts";
import type { Learned, PlannedAgainst, TicketChange } from "./queue-ticket-text.ts";



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

/** A Claude Code safety prompt the pool declined on a run: see {@link Entry.declined}. */
type Declined = Readonly<{ command: string; warning: string; agent?: string; at: number; count: number; told: boolean }>;

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
   * The model and effort its plan was written with, kept when the plan was attached, so a plan that goes stale is written again on the choice the ticket was first planned with (A11-167). A run
   * without it, queued before this was kept, uses the planner's default.
   */
  plannedWith?: RunChoice;
  /**
   * The text of its ticket the run was last briefed with (A11-167): set as a brief is written, and moved to the new text when a change is sent to the live worker. A change in a ticket's
   * description is told from it. Carried through a review round, whose brief says what changed since the last one.
   */
  briefedAgainst?: TicketRead;
  /**
   * What its attached plan says of the text it was planned against, as read from the plan's stamp while the run is queued (A11-167): the board marks the plan stale when the ticket's description no
   * longer has this hash. Unset for a plan with no stamp, which is never read as stale, and until the plan has been read.
   */
  plannedAgainst?: PlannedAgainst;
  /** Set on a queued or planning run whose plan is stale (A11-167): the description it was planned against and the one the ticket has now. The run plans again before it is worked. */
  ticketChange?: TicketChange;
  /** The changes to its ticket's description sent to the live worker as a message, in order (A11-167). */
  ticketChanges?: readonly TicketChange[];
  /** What the planner of this queued run was given from its blockers' merged pull requests, by pull request address (A11-167). */
  learned?: Readonly<Record<string, Learned>>;
  /** What each merged pull request of this queued run's blockers declared of its blocker's ticket, by pull request address, once the sweep read its body (A11-206). A merged one not here is not read yet, and holds the run. */
  blockersDeclared?: Readonly<Record<string, BlockerPullDeclared>>;
  /** Set on a planning run that replaces a stale plan: the files of that plan, as the board copied them before it detached the plan (A11-167). Dropped once the new plan is attached. */
  previousPlan?: readonly string[];
  /** The addresses of the merged pull requests whose findings the last planning brief of this run gave its planner, so its plan can be held to naming each (A11-167). */
  findingsGiven?: readonly string[];
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
  /** The terminal the run's agent was in when the run ended, kept after its workspace and pane are cleared, so a link to it says the run ended (A11-129). */
  lastTerminal?: Readonly<{ workspace: string; pane: string }>;
  /** Seen `working` at least once, so a later `idle` means a finished turn and not a prompt not yet taken. */
  seenWorking?: boolean;
  /** The agent is in a state that needs a person (a dialog, a prompt), as herdr reported it. */
  waiting?: boolean;
  /** The first line of the dialog a waiting agent sits on, when the pool could read one from its pane. Cleared when the run stops waiting (A11-174). */
  prompt?: string;
  /**
   * The Claude Code safety prompt the pool last answered No to on this run (A11-174): the command it asked about, its warning, the subagent that raised it (absent for the main agent, A11-209), when, how many the run has had
   * answered (bounded), and whether the agent has been told yet (herdr refuses a message to an agent that still reads blocked). Dropped when the run ends.
   */
  declined?: Declined;
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
   * What the run's merged pull requests declared of the ticket in their bodies (A11-181), recorded once, when the board read them: `closes`, `partial` or `none`. A merged pull request's own declaration decides
   * over the outcome's `partial` (see {@link recordDeclared}). A run with a `partial` and no `declared` is not acted on at its merge: the board has not yet checked the words it would act on. Dropped when a run ends again.
   */
  declared?: PullDeclared;
  /** Set when the declaration overruled the outcome's `partial` (A11-181): the outcome's own words, and the declaration the board followed. The card names both. */
  partialOverruled?: PartialOverruled;
  /**
   * The plan steps of this ticket whose pull requests merged, in order, each with the pull requests that finished it (A11-168): set on the run the board queued for the next
   * step ({@link nextStepRun}), and carried through its review, talk and check rounds, so each step's run knows which it is on. Unset on a run that is the first step, or no step.
   */
  steps?: readonly MergedStep[];
  /**
   * The After-merge lines of the ticket's Done-when, each with who runs it, recorded once when the run's pull requests merged and the board posted them on the ticket (A11-173):
   * the board's "After-merge checks" list reads them, and a row leaves with its run. Unset until recorded, and never recorded empty.
   */
  afterMerge?: readonly AfterMergeLine[];
  /** Set while the board has posted, or is posting, the run's {@link afterMerge} lines as a comment on the ticket; cleared again when the post fails, so the next sweep tries again (A11-173). */
  afterMergePosted?: boolean;
  /**
   * How many numbered steps the ticket's plan has, read from the plan file once, when a partial pull request merged with a declaration that gives no `of <M>` and the run's
   * record gives none either (A11-173). 0 is recorded too, so a plan with no numbered steps is not read again. Carried to the run queued for the next step.
   */
  planSteps?: number;
  /**
   * Set once the board has acted on the ticket for a merged pull request its body did not complete (A11-92): it completed the ticket, or found it
   * already finished, or its team has no completed state to move it to, which the log says once.
   */
  closedByBoard?: boolean;
  /**
   * Set to `person` once the tracker said a person moved the ticket to its completed state while the run's work was partial (A11-178): the person's move wins, so the board does not undo it,
   * does not ask the tracker again, and reads the run as Completed. Dropped with the run's other state when the run is queued again.
   */
  completedBy?: "person";
  /**
   * Why the board could not put back a ticket the tracker's integration completed while the run's work was partial (A11-178): the card says it and flags the run, and the next sweep tries again.
   * Cleared once the ticket is put back, or a person is found to have completed it.
   */
  reopenFailure?: string;
  /** The tickets that block this one, as last read while it is queued; unset until the tracker has been asked. */
  blockers?: readonly Blocker[];
  /**
   * The repository-prefixed paths its plan says its work touches (`repo:path`, `overlap.ts`), as last read while it is queued. Unset until the
   * plan has been read; empty when the plan declares none. A run's footprint, with the files of its open pull requests, is what a run waits on
   * ({@link overlapWait}).
   */
  paths?: readonly string[];
  /**
   * The paths each step section of its plan lists, by step number (A11-175), read with {@link paths} and only when a section lists any. A run on step N holds step N's, not the whole plan's
   * (`footprintOf`); a step whose section lists none is not in it. Carried to the run queued for the next step.
   */
  stepPaths?: Readonly<Record<string, readonly string[]>>;
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
  /**
   * The commit each open pull request of the run was at when it ended, by URL (A11-153): a pull request now at another head has been answered. Set from the
   * read the end of the run makes, or, where that failed or the run was stored before this, from the first watch. Agent-org's own merge into the branch moves
   * it. Dropped when the run ends again or is resumed, since a round records its own.
   */
  outcomeHeads?: Readonly<Record<string, string>>;
  /** Each open pull request's head now, and whether it is approved at that head, by URL, as the last watch read them (A11-153). Written only when it changes. */
  pullHeads?: Readonly<Record<string, PullHead>>;
  /**
   * The head each open pull request's red checks were last answered at, by URL (A11-154): one round, or one rerun, for each head, so a head that stays red after its round
   * and a restart of the board start no second round for it. Carried through a review round. A pull request that is no longer open is dropped from it.
   */
  checkHeads?: Readonly<Record<string, CheckHead>>;
  /**
   * Set on a queued review round or talk session that a working agent in another workspace holds back, because that agent holds the run's Claude session or its herdr
   * name (A11-154): what the board says it waits for. Cleared when the agent ends, and when the run starts.
   */
  sessionWait?: string;
  /** Set on a review round or talk session started after the board closed the leftover of an earlier session beside it: what it closed. Dropped when the run ends. */
  sessionNote?: string;
  /** The Claude session the run's worker used, saved when the run ended, so a review run can resume the worker that wrote the code. */
  session?: string;
  /** Set on a review run: the pull requests a person approved, which the run marks ready and sees through their review. See {@link approve}. */
  review?: readonly PullRequest[];
  /** Set on a review round the board started on its own: the new feedback it answers. See {@link feedbackRound}. */
  feedback?: string;
  /** Set on a review round a person asked for with Respond to review: it answers the pull requests' current feedback. See {@link respond}. */
  asked?: boolean;
  /**
   * A person opened this run's saved session to talk to its agent (a draft they have a problem with, or a planner's question they will answer). The run
   * starts again in the same session, with a prompt that says a person is here, and ends as any run does.
   */
  talk?: boolean;
  /** The finished run a talk session replaced, which goes back on the board when the session cannot start. */
  talkFrom?: Omit<Entry, "talkFrom">;

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
  /** The version of agent-org the run's hooks and commands were written for, when it is known (A11-169). See {@link ToolPin}. */
  toolVersion?: string;
  /** The version folder those hooks and commands name; the folder is kept while this run holds a workspace. */
  toolRoot?: string;
  /** The conventions plugins' installs the run's session was started with. Best effort: absent when the install record could not be read. */
  pluginCopy?: readonly PluginCopy[];
  /** Set when a breaking update stopped this run and queued it again; its round resumes the same session on the new version. */
  stoppedForUpdate?: StoppedForUpdate;
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
  /** The terminal the publish run's agent was in when it ended, kept after its workspace and pane are cleared (A11-129). */
  lastTerminal?: Readonly<{ workspace: string; pane: string }>;
  seenWorking?: boolean;
  /** Why it failed, once it has: the runs stay Ready to merge. */
  failure?: string;
  /** The version folder its hooks name, recorded when it starts (A11-169). */
  toolRoot?: string;
  toolVersion?: string;
}>;

/**
 * `paused`: no queued entry starts while it is true. A new queue starts PAUSED, so queueing is never also starting: a person can queue tickets
 * before what the workers need is ready (a dev environment, a merge) and start them on the board when it is.
 */
export type Queue = Readonly<{ entries: readonly Entry[]; max: number; paused: boolean; publish?: PublishRun; writers?: readonly WriterRun[] }>;

/**
 * A ticket a new-ticket run created, as the board shows it (A11-135): its key, its address when the tracker has the ticket, and whether Pick's list
 * shows it. The run filed it itself; the board reads it back from the tracker to show it.
 */
export type WriterTicket = Readonly<{ key: string; url: string | null; inPick: boolean | null;
  /** What the tracker held for the ticket when the board read it back, shown on the request's Done row (A11-199). None for a ticket that could not be read. */
  title?: string; priority?: number; project?: string | null }>;

/** The ticket-writing run's mode: `quick` runs unattended, `grill` asks the person in its terminal first. */
export type WriterMode = "quick" | "grill";

/** The choices the form made, each a requirement in the writer's brief. */
export type WriterForm = Readonly<{ project?: string; repo?: string; goal?: string; priority?: Priority; parent?: string }>;

/** The phases of a writer run. Only `starting` and `running` hold a worker slot. */
export type WriterPhase = "queued" | "starting" | "running" | "finished";

/** A new-ticket request and the run that files its ticket: a record of its own, not a ticket entry, since its ticket does not exist yet. */
export type WriterRun = Readonly<{
  id: string;
  request: string;
  mode: WriterMode;
  /** Who places the ticket. A run queued before placement existed has the placement its form implies (`placementOf`). */
  placement: Placement;
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
  /**
   * A grill run whose agent has ended its turn with no outcome, and is waiting for the person to answer in its terminal: the question the agent asked,
   * and when the wait began. Cleared when the agent works again (A11-129).
   */
  waiting?: Readonly<{ question: string; since: number }>;
  /** The terminal the run's agent was in when the run ended, kept after the run's record ends so a link to it says so (A11-129). */
  lastTerminal?: Readonly<{ workspace: string; pane: string }>;
  /** Why the run failed, once it has. A stopped run says so. */
  failure?: string;
  /** The tickets the run created, in the order it created them, shown as links once the run ends. */
  tickets: readonly WriterTicket[];
  /** The key of the ticket a Grill run grills, which it writes its answers into rather than filing a ticket (A11-134). */
  ticket?: string;
  /** The description of that ticket when the Grill started: the answers are written only while it still holds this text. */
  startedFrom?: string;
  /** The version folder its hooks name, recorded when it starts (A11-169). */
  toolRoot?: string;
  toolVersion?: string;
}>;

/** The most new-ticket requests that are not finished at once: a fourth is refused until one ends. */
export const MAX_WRITER_RUNS = 3;

/**
 * Where a new-ticket request is on the board: queued, writing (its agent, or the board making its tickets), waiting for the person to answer its
 * agent in the terminal, done, or failed.
 */
export type WriterStatus = "queued" | "writing" | "waiting" | "done" | "failed";

/** The status of a writer run, from its phase, its wait and its failure. PURE. */
export function writerStatus(run: WriterRun): WriterStatus {
  if (run.failure !== undefined) return "failed";
  if (run.phase === "queued") return "queued";
  if (run.phase === "finished") return "done";
  if (run.waiting !== undefined) return "waiting";
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
 * Refuse a ticket that still holds an open decision, or a screen's behaviour that is not grilled: a worker may not settle either (`open-decisions.ts`), so
 * the queue holds the rule itself, as the page's Select does not. The reason names each ticket and its open line, and says to Grill it. PURE.
 */
export function refuseDecisions(tickets: readonly Ticket[]): void {
  const held = tickets.flatMap((ticket) => {
    const open = needsDecision(ticket);
    return open === null ? [] : [`${ticket.key}: ${open.reason}`];
  });
  if (held.length === 0) return;
  throw new Error(held.join("; "));
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
  refuseDecisions(fresh);
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
  // A queued talk session is not a run of its own: taking it off puts back the finished run it replaced, with its outcome and pull requests.
  return { ...queue, entries: queue.entries.flatMap((entry): Entry[] => (entry.ticket.key !== key || entry.phase !== "queued" ? [entry] : entry.talkFrom ? [{ ...entry.talkFrom }] : [])) };
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
  const { ticket, repos, model, effort, plan, planned, session, review, published, feedback, asked, conflict, rounds, movedFrom, paths, stepPaths, plannedRepo, projectRepo, pullFiles, partial, declared, partialOverruled, steps, planSteps, afterMerge, afterMergePosted, stackBase, overlapOverride, checkHeads, briefedAgainst, plannedWith } = entry;
  // A review run that failed is retried as the same review round, resuming the same worker, so it does not start the ticket over, and a round
  // the board started still counts towards its cap. Any other run starts a fresh worker, whose session replaces this one. A ticket of a batch
  // is planned again on its own.
  const round = { ...(session ? { session } : {}), ...(published ? { published } : {}), ...(feedback !== undefined ? { feedback } : {}), ...(asked ? { asked } : {}),
    ...(conflict !== undefined ? { conflict } : {}), ...(overlapOverride ? { overlapOverride } : {}), ...(rounds !== undefined ? { rounds } : {}), ...carriedFields({ paths, stepPaths, plannedRepo, projectRepo, pullFiles, partial, declared, partialOverruled, steps, planSteps, afterMerge, afterMergePosted, stackBase, checkHeads, briefedAgainst }) };
  // The record of the board's move is carried over too: a retried run finds its ticket already started, and would move nothing to record again. So are the plan
  // steps already merged: a fresh worker for a step that crashed is still on that step (A11-168).
  const retried: Entry = { ticket, repos, model, effort, ...(plan ? { plan } : {}), ...(plannedWith ? { plannedWith } : {}), ...(planned ? { planned } : {}), ...(movedFrom ? { movedFrom } : {}), ...(steps ? { steps } : {}),
    ...(review ? { review, ...round } : {}), phase: "queued", queuedAt: now };
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
 * A talk session for `entry`'s finished run, queued at `now`: the same ticket, session, batch and pull requests, so the run ends as the first one did. The run it
 * replaces is kept as `talkFrom`, and goes back on the board if the session cannot start. PURE.
 */
export function talkRound(entry: Entry, now: number): Entry {
  const { talkFrom: _earlier, ...before } = entry;
  const { ticket, repos, model, effort, plan, planned, session, batch, published, overlapOverride, toolRoot, toolVersion, pluginCopy } = entry;
  // The session resumes the run's own settings, which name the version folder it was prepared with: the pin goes with it (A11-169).
  const pin = { ...(toolRoot !== undefined ? { toolRoot } : {}), ...(toolVersion !== undefined ? { toolVersion } : {}), ...(pluginCopy !== undefined ? { pluginCopy } : {}) };
  // The pull requests the finished run listed stay with the session as its `review`, so they stay linked while its agent waits for a person.
  const review = entry.review ?? (entry.outcome && "prs" in entry.outcome ? entry.outcome.prs : undefined);
  return { ticket, repos, model, effort, ...(plan ? { plan } : {}), ...(planned ? { planned } : {}), ...(session ? { session } : {}), ...(batch ? { batch } : {}),
    ...(review ? { review } : {}), ...(published ? { published } : {}), ...(overlapOverride ? { overlapOverride } : {}), ...carriedFields(entry), ...pin,
    talk: true, talkFrom: before, phase: "queued", queuedAt: now };
}

/**
 * The fields a review round carries from the run it continues, the ticket text it was briefed with, its paths, pull request files, partial declaration and what its pull requests declared, merged plan steps, the plan's step count, the After-merge lines listed and posted, and the heads its red checks were answered at: only those the run has set. PURE.
 */
const carriedFields = ({ paths, stepPaths, plannedRepo, projectRepo, pullFiles, partial, declared, partialOverruled, steps, planSteps, afterMerge, afterMergePosted, stackBase, checkHeads, briefedAgainst }: Pick<Entry, "paths" | "stepPaths" | "plannedRepo" | "projectRepo" | "pullFiles" | "partial" | "declared" | "partialOverruled" | "steps" | "planSteps" | "afterMerge" | "afterMergePosted" | "stackBase" | "checkHeads" | "briefedAgainst">) => ({
  ...(briefedAgainst ? { briefedAgainst } : {}), ...(paths ? { paths } : {}), ...(stepPaths ? { stepPaths } : {}), ...(plannedRepo !== undefined ? { plannedRepo } : {}), ...(projectRepo !== undefined ? { projectRepo } : {}), ...(pullFiles ? { pullFiles } : {}),
  ...(partial !== undefined ? { partial } : {}), ...(declared ? { declared } : {}), ...(partialOverruled ? { partialOverruled } : {}), ...(steps ? { steps } : {}), ...(planSteps !== undefined ? { planSteps } : {}), ...(afterMerge ? { afterMerge } : {}), ...(afterMergePosted ? { afterMergePosted } : {}), ...(stackBase ? { stackBase } : {}), ...(checkHeads ? { checkHeads } : {}),
});

/** The tracker states a finished run can end in, after which its ticket is not read again. */
export const SETTLED = new Set(["completed", "canceled", "duplicate"]);

/** Whether a writer run holds a worker slot: it is starting or running. */
export const writerLive = (run: WriterRun): boolean => run.phase === "starting" || run.phase === "running";
