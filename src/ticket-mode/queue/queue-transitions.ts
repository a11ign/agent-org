import { CONCLUDED, openPulls, type CheckHead, type StackBaseRecord } from "../board-view/view-types-and-filters.ts";
import { overlapWait } from "../board-view/overlap-hold.ts";
import { isParked, isPublishing, isWatched, resumesOnConflict, runActions, runStatus } from "../board-view/pull-status-and-notes.ts";
import { settledByPulls } from "../board-view/pull-settled.ts";
import type { Blocker, PullState } from "../source.ts";
import { conflictsIn } from "../worker-files.ts";
import type { RunWorker } from "./queue-run-detail.ts";
import { loggedPersonRound } from "./queue-person-round.ts";
import { logEvent, logHas, shortReason, type RoundCause } from "./run-log.ts";
import { BACKGROUND_GONE, BACKGROUND_GONE_MS, LIVE, SETTLED, find, isLive, replace, reviewRound, reviewable, type Background, type Entry, type Outcome, type PublishRun, type Queue, type WorkingNote, writerLive } from "./queue-entries-and-outcomes.ts";

/**
 * A person reviewed a finished run's DRAFT pull requests and approved them: the ticket goes back on the queue, at the end, as a REVIEW RUN. It
 * resumes the worker that wrote the code (its `session`), marks the pull requests ready, waits for their checks and review, and fixes what they
 * find. Only its pull requests still open are reviewed. A run with none open, one parked or settled by its tracker, and one whose pull requests
 * are ready already ({@link respond} is theirs) are left alone.
 */
export function approve(queue: Queue, key: string, now: number): Queue {
  const entry = find(queue, key);
  if (entry === undefined || entry.outcome?.kind !== "draft-pr" || !reviewable(entry)) return queue;
  const queued = { ...queue, entries: [...queue.entries.filter((e) => e.ticket.key !== key), reviewRound(entry, openPulls(entry), now)] };
  return loggedPersonRound(queued, entry, "approve", now, null);
}

/**
 * Why a person's Respond cannot act on `entry`, or null when it can (A11-154): the run is not on the board, is not finished, has a round queued already, its
 * tracker has completed or canceled the ticket, or it has no pull request open. A parked run is not refused here: the pool closes its workspace first. PURE.
 */
function respondRefusal(key: string, entry: Entry | undefined): string | null {
  if (entry === undefined) return `${key} is not on the board`;
  if (entry.phase === "queued" && entry.talk === true) return `a talk session is already queued for ${key}: a round would share its session`;
  if (entry.phase === "queued") return entry.review !== undefined ? `a round is already queued for ${key}` : `${key} has not run yet, so there is no pull request to answer`;
  if (entry.phase !== "finished") return `${key} is still running: Respond answers a run that has finished`;
  if (SETTLED.has(entry.trackerState ?? "")) return `${key}'s ticket is ${entry.trackerState === "completed" ? "completed" : "closed"} in the tracker, so there is nothing to respond to`;
  if (openPulls(entry).length === 0) return `${key} has no pull request open, so there is no feedback to answer`;
  const kind = entry.outcome?.kind ?? "";
  if (CONCLUDED.has(kind) || kind === "stopped") return `${key} ${kind === "stopped" ? "was stopped" : `concluded (${kind})`}: there is nothing for a worker to answer`;
  return null;
}

/**
 * A person asked the worker to answer the current feedback on a finished run's open pull requests, whatever its outcome ended on: Ready to merge, Published,
 * handed back after the board's own rounds, needs-human, crashed, or ready for review. The ticket goes back on the queue, at the end, as a review round that
 * resumes the same worker, and the count of the board's own rounds begins again, so watching carries on after it. A run handed back for a conflict carries the
 * conflict lines, so its round merges the base in first (A11-125). A run whose pull requests are drafts is approved, which marks them ready and starts the
 * same round. Throws, naming why, for a run Respond cannot act on ({@link respondRefusal}), so the board says it. A parked run is the pool's: it closes the
 * run's workspace, then asks this.
 */
export function respond(queue: Queue, key: string, now: number): Queue {
  const entry = find(queue, key);
  const refusal = respondRefusal(key, entry);
  if (refusal !== null) throw new Error(refusal);
  if (entry === undefined || isParked(entry)) throw new Error(`${key}'s workspace is open: it is closed before Respond acts`);
  if (entry.outcome?.kind === "draft-pr") return approve(queue, key, now);
  const conflict = conflictsIn(entry.handedBack ?? "");
  const queued = { ...queue, entries: [...queue.entries.filter((e) => e.ticket.key !== key), { ...reviewRound(entry, openPulls(entry), now), asked: true, ...(conflict === null ? {} : { conflict }) }] };
  return loggedPersonRound(queued, entry, "respond", now, conflict === null ? null : shortReason(conflict));
}

/**
 * A person started a queued run anyway, past the overlap it is Blocked on (A11-125): it starts beside the run that holds a path it shares, as a live
 * run would, and the overlap is recorded as overridden on the run. Refused, naming why, when the run is not queued or nothing overlaps it now, since it
 * starts on its own; and when it waits on a ticket or its plan, which this does not pass.
 */
export function startAnyway(queue: Queue, key: string, now: number): Queue {
  const entry = find(queue, key);
  if (entry === undefined || entry.phase !== "queued") throw new Error(`${key} is not queued, so there is no overlap to start past`);
  const wait = overlapWait(entry, queue.entries);
  if (wait === null) throw new Error(`nothing overlaps ${key} now, so there is no overlap to start past`);
  if (!runActions(entry, undefined, queue.entries).includes("start-anyway")) throw new Error(`${key} waits on a ticket or its plan, which Start anyway does not pass`);
  return replace(queue, key, (e) => ({ ...e, overlapOverride: { holder: wait.key, pull: wait.pull, path: wait.path, at: now } }));
}

/** The most review rounds the board starts on its own, on new feedback, between two of a person's approvals. */
export const MAX_FEEDBACK_ROUNDS = 3;

/**
 * New feedback reached a watched run's pull requests after its last round ended (`feedback` says what), a check is red at a head the board has not answered, or
 * a pull request conflicts with its base (`feedback` names it as a conflict): the ticket goes back on the queue, at
 * the end, as a review round that answers it, resuming the same worker. `heads` is what the board has answered the red checks at, which the round records
 * (A11-154). After {@link MAX_FEEDBACK_ROUNDS} such rounds since a person last
 * approved, the next trigger hands the run to a person instead, who approves again to let the board carry on. A run the board does not watch
 * ({@link isWatched}) is left alone.
 */
export function feedbackRound(queue: Queue, key: string, feedback: string, now: number, heads?: CheckHeads): Queue {
  const entry = find(queue, key);
  if (entry === undefined || entry.phase !== "finished" || !isWatched(entry)) return queue;
  return roundOrHandBack(queue, withHeads(entry, heads), feedback, now, "feedback");
}

/** What the board has answered the red checks of a run's pull requests at, by URL (A11-154). */
type CheckHeads = Readonly<Record<string, CheckHead>>;

/** `entry` with the heads its red checks were answered at, or as it is when there are none to record. PURE. */
const withHeads = (entry: Entry, heads: CheckHeads | undefined): Entry => (heads === undefined ? entry : { ...entry, checkHeads: heads });

/**
 * A round for `entry` that answers `feedback`, for `cause`, or, once the board has started {@link MAX_FEEDBACK_ROUNDS} of its own, the run handed to a person with the latest feedback named, which logs that it needs them
 * when the words of the hand-back are new (A11-219).
 */
function roundOrHandBack(queue: Queue, entry: Entry, feedback: string, now: number, cause: RoundCause): Queue {
  const rounds = entry.rounds ?? 0;
  if (rounds < MAX_FEEDBACK_ROUNDS) return queueRound(queue, entry, feedback, now, cause);
  const handedBack = `The pull requests keep getting feedback: the board answered ${rounds} rounds on its own and stopped. Respond to review starts another. The latest: ${feedback}`;
  const handed = replace(queue, entry.ticket.key, (e) => ({ ...e, handedBack, ...(entry.checkHeads === undefined ? {} : { checkHeads: entry.checkHeads }) }));
  return entry.handedBack === handedBack ? handed : logEvent(handed, entry.ticket.key, now, { kind: "needs-you", reason: shortReason(handedBack) ?? handedBack });
}

/**
 * Red checks at a head the board has not answered reached a run that {@link resumesOnConflict} names, watched or not (A11-154): a run parked on a question, ended
 * with no outcome, crashed, or handed back. The ticket goes back on the queue as a review round that names the failing checks, resuming the same worker, as
 * {@link feedbackRound} does. At the cap on the board's own rounds the run is handed to a person whatever its outcome was, who answers with Respond to review.
 * `heads` is recorded with the round, or with the hand-back, so the head is not answered twice.
 */
export function checkRound(queue: Queue, key: string, feedback: string, now: number, heads: CheckHeads): Queue {
  const entry = find(queue, key);
  if (entry === undefined || entry.phase !== "finished" || !resumesOnConflict(entry)) return queue;
  return roundOrHandBack(queue, withHeads(entry, heads), feedback, now, "checks");
}

/** Record what the board did about the red checks of a finished run's pull requests, when it started no round for it: a rerun, or checks named for a person (A11-154). */
export function recordCheckHeads(queue: Queue, key: string, heads: CheckHeads): Queue {
  return replace(queue, key, (entry) => (entry.phase === "finished" ? { ...entry, checkHeads: heads } : entry));
}

/** Whether the board may start one more round of its own on `entry`: it has started fewer than {@link MAX_FEEDBACK_ROUNDS} since a person approved. */
export const roundsLeft = (entry: Entry): boolean => (entry.rounds ?? 0) < MAX_FEEDBACK_ROUNDS;

/** `entry` goes back on the queue, at the end, as a review round that answers `feedback`, for `cause`, and counts as one of the board's own rounds. */
function queueRound(queue: Queue, entry: Entry, feedback: string, now: number, cause: RoundCause): Queue {
  const round: Entry = { ...reviewRound(entry, openPulls(entry), now), feedback, rounds: (entry.rounds ?? 0) + 1 };
  const queued = { ...queue, entries: [...queue.entries.filter((e) => e.ticket.key !== entry.ticket.key), round] };
  return logEvent(queued, entry.ticket.key, now, { kind: "round", cause, reason: shortReason(feedback) });
}

/**
 * A pull request of a run the board does not watch conflicts with its base (A11-89): the run is parked, or ended with no outcome, or crashed, and
 * {@link resumesOnConflict} names it. Its ticket goes back on the queue as a review round that answers the conflict and resumes the same worker,
 * as {@link feedbackRound} does for a watched run. At the cap nothing is queued, and no `handedBack` is set: a parked run already reads Needs you.
 */
export function conflictRound(queue: Queue, key: string, feedback: string, now: number): Queue {
  const entry = find(queue, key);
  const cannotResume = entry === undefined || entry.phase !== "finished" || isWatched(entry) || !resumesOnConflict(entry) || !roundsLeft(entry);
  if (cannotResume) return queue;
  return queueRound(queue, entry, feedback, now, "conflict");
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
    const cannotApprove = entry === undefined || entry.phase !== "finished" || runStatus(entry) !== "ready-to-merge" || isParked(entry);
    if (cannotApprove) {
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
  const ended: PublishRun = { ...withoutWorkspace(publish), ...lastTerminalOf(publish), phase: "finished", finishedAt: now };
  const done = { ...queue, publish: ended, entries: queue.entries.map((e) => (publish.keys.includes(e.ticket.key) ? { ...e, published } : e)) };
  return publish.keys.reduce<Queue>((next, key) => logEvent(next, key, now, { kind: "published", link: published.link }), done);
}

/** The publish run failed: its runs stay as they were, and the board says why. */
export const publishFailed = (queue: Queue, failure: string, now: number): Queue =>
  replacePublish(queue, (p) => ({ ...withoutWorkspace(p), ...lastTerminalOf(p), phase: "finished", finishedAt: now, failure }));

/** A publish run that has ended holds no workspace: it is closed. */
const withoutWorkspace = ({ workspace: _closed, pane: _gone, ...publish }: PublishRun): PublishRun => publish;

/**
 * The terminal a run's agent was in, once the run has ended and its workspace and pane are cleared: a link to it then says the run ended, rather than
 * spinning (A11-129). Empty when the run held no terminal.
 */
const lastTerminalOf = ({ workspace, pane }: Readonly<{ workspace?: string; pane?: string }>): Readonly<{ lastTerminal?: { workspace: string; pane: string } }> =>
  workspace === undefined || pane === undefined ? {} : { lastTerminal: { workspace, pane } };

/** Whether the queued publish run starts now: it has a slot of its own free. It does not wait on Pause, because a person just asked for it. */
export function publishStarts(queue: Queue): boolean {
  return queue.publish?.phase === "queued" && slotsHeld(queue) < queue.max;
}

/** The queue, paused: nothing starts until it is resumed. */
export function pauseQueue(queue: Queue): Queue {
  return { ...queue, paused: true };
}

/** The queue, resumed: it starts what its slots allow. */
export function resumeQueue(queue: Queue): Queue {
  return { ...queue, paused: false };
}

export function setMax(queue: Queue, max: number): Queue {
  if (!Number.isInteger(max) || max < 1) throw new Error(`max must be a whole number of 1 or more, not ${max}`);
  return { ...queue, max };
}

export function markStarting(queue: Queue, key: string, now: number, worker?: RunWorker): Queue {
  // The round that follows a stop for an update is under way: the board stops saying the run was stopped (A11-169). What a start records of the run's plan and machine is read again
  // for this start, so the earlier one's is dropped (A11-219).
  return replace(queue, key, ({ sessionWait: _held, stoppedForUpdate: _stopped, plannedSteps: _planned, currentStep: _step, ...entry }) =>
    ({ ...entry, phase: "starting", startedAt: now, ...(worker === undefined ? {} : { worker }) }));
}

/**
 * A queued review round or talk session is held back by the agent of an earlier session in another workspace (`wait` says which), or is not (`wait` undefined);
 * `note`, when given, says what the board closed of that earlier session first (A11-154). A run that is not queued is left alone. PURE.
 */
export function holdForSession(queue: Queue, key: string, wait: string | undefined, note?: string): Queue {
  return replace(queue, key, (entry) => {
    if (entry.phase !== "queued") return entry;
    const { sessionWait: _held, ...rest } = entry;
    return { ...rest, ...(wait === undefined ? {} : { sessionWait: wait }), ...(note === undefined ? {} : { sessionNote: note }) };
  });
}

/** The repositories the worker has made worktrees in so far. */
export function recordRepos(queue: Queue, key: string, repos: readonly string[]): Queue {
  return replace(queue, key, (entry) => ({ ...entry, repos }));
}

export function markRunning(queue: Queue, key: string, workspace: string, pane: string): Queue {
  const before = find(queue, key);
  const running = replace(queue, key, (entry) => ({ ...entry, phase: "running", workspace, pane }));
  if (before?.phase !== "starting" || before.startedAt === undefined) return running;
  // The start is logged here, once its agent is open, at the time it began: a start that is put back on the queue (its plan reached the ticket, or it plans again) or refused never ran. A planning run starts on the
  // choice its plan was asked with, and any other on the entry's own.
  const { model, effort } = before.plan ?? before;
  return logEvent(running, key, before.startedAt, { kind: "started", model, effort, instance: before.worker?.instance ?? null });
}

/**
 * What herdr says the agent is doing: `working` marks it seen, and any status but the four ordinary ones means it is waiting on a person. `prompt` is the first line of
 * the dialog its pane shows, kept while it waits and dropped when it does not (A11-174).
 */
export function observe(queue: Queue, key: string, status: string, prompt?: string, now?: number): Queue {
  const waiting = !["working", "idle", "done", "unknown"].includes(status);
  const before = find(queue, key);
  const was = before?.waiting === true;
  const observed = replace(queue, key, ({ prompt: _earlier, ...entry }) =>
    ({ ...entry, seenWorking: entry.seenWorking === true || status === "working", waiting, ...(waiting && prompt !== undefined ? { prompt } : {}) }));
  // A change of whether the run waits is the event: the pool observes it on every pass (A11-219).
  if (before === undefined) return observed;
  if (waiting && !was) return logEvent(observed, key, now, { kind: "needs-you", reason: shortReason(prompt ?? "") ?? status });
  return !waiting && was ? logEvent(observed, key, now, { kind: "answered", by: "terminal" }) : observed;
}

/**
 * A running run's worker wrote a `working` outcome at `at`: record its reason, and the job and time it gave in `wait` (A11-236), as the run's latest note, with its agent idle since `now`, and keep
 * the run running. A note no newer than the one recorded changes nothing, so the stall clock is not reset by reading the same file again. A run
 * that is not running is left alone: a `working` outcome never ends, parks or revives one.
 */
export function noteWorking(queue: Queue, key: string, reason: string, at: number, now: number, wait: Readonly<{ waitingOn?: string; until?: number }> = {}): Queue {
  return replace(queue, key, (entry) => {
    if (entry.phase !== "running" || (entry.working !== undefined && at <= entry.working.at)) return entry;
    const { waitingOn, until } = wait;
    return {
      ...entry,
      working: {
        reason, at, idleSince: now,
        ...(waitingOn === undefined ? {} : { waitingOn }), ...(until === undefined ? {} : { until }),
        ...(entry.working?.resumed === true ? { resumed: true } : {}),
      },
    };
  });
}

/**
 * The background mark of an idle run's note, at `now`: `live` clears the mark, since work that runs wakes the worker; `none` starts its clock, and once
 * the clock has run for {@link BACKGROUND_GONE_MS} marks the run stalled with {@link BACKGROUND_GONE} and says it has been resumed, at most once; null (the pane
 * cannot be read) changes nothing, so the idle clock alone decides, as it always did. PURE.
 */
function backgroundMark(note: WorkingNote, background: Background, now: number): WorkingNote {
  if (background === null) return note;
  const { noBackgroundSince: _since, stallReason: _why, stalled: _stalled, resumed: _resumed, ...rest } = note;
  if (background === "live") return rest;
  const since = note.noBackgroundSince ?? now;
  if (now - since < BACKGROUND_GONE_MS) return { ...note, noBackgroundSince: since };
  return { ...note, noBackgroundSince: since, stalled: true, stallReason: BACKGROUND_GONE, resumed: true };
}

/** How long a run waiting on background work may sit idle past its `working` outcome, when the outcome gives no `until`: three hours. */
const BACKGROUND_WAIT_MS = 3 * 60 * 60_000;

/** The start of the stall reason of a run idle past the end of its wait on background work (A11-236): the deadline and the job follow. */
const WAITED_PAST = "waited past";

/** The time (ms) a waiting note's wait ends: the `until` its outcome gave, whatever it is, or {@link BACKGROUND_WAIT_MS} after the outcome file was written, so a newer outcome starts it again. PURE. */
const waitDeadline = ({ at, until }: Pick<WorkingNote, "at" | "until">): number => until ?? at + BACKGROUND_WAIT_MS;

/** The stall reason of a run that stayed idle past the end of its wait on background work, naming the job (A11-236). PURE. */
const waitedPastReason = (note: WorkingNote): string => {
  const deadline = new Date(waitDeadline(note)).toISOString();
  return note.waitingOn === undefined ? `${WAITED_PAST} ${deadline} with its background work still running` : `${WAITED_PAST} ${deadline} on ${note.waitingOn}`;
};

/**
 * The note of an idle run that waits on background work, at `now` (A11-236): its pane shows live work, or its outcome names a job. Inside the wait it is
 * `waiting`, and not stalled, though the background mark may still say its work is gone (the worker is prompted once, as A11-85 does). Past the end of the
 * wait, with no newer outcome, it is stalled, and the reason names the job. PURE.
 */
function waitingMark(marked: WorkingNote, now: number): WorkingNote {
  const { waiting: _ended, stalled: _marked, stallReason: _why, ...rest } = marked;
  if (now >= waitDeadline(marked)) return { ...rest, stalled: true, stallReason: waitedPastReason(marked) };
  return { ...rest, waiting: true };
}

/**
 * What herdr says a running run with a working note is doing, at `now`. Working clears the idle clock and the stall: its background work woke it.
 * Idle or done starts the clock when it is not running already, and marks the run stalled once it has run for `stallMs`. Any other status, and a
 * run with no note, changes nothing. `background` is what the run's pane shows of its background work, which an idle run with no work to wake it
 * reaches within {@link BACKGROUND_GONE_MS} (see {@link backgroundMark}); the default, null, is a pane that cannot be read.
 *
 * A11-236: a run that waits on background work (live on its pane, or a job named in its note) is not on that clock: see {@link waitingMark}.
 */
export function watchWorking(queue: Queue, key: string, status: string, now: number, stallMs: number, background: Background = null): Queue {
  return replace(queue, key, (entry) => {
    const note = entry.working;
    if (entry.phase !== "running" || note === undefined) return entry;
    if (status === "working") {
      const { idleSince: _woke, stalled: _cleared, stallReason: _why, noBackgroundSince: _since, waiting: _waited, ...awake } = note;
      return { ...entry, working: awake };
    }
    if (status !== "idle" && status !== "done") return entry;
    const idleSince = note.idleSince ?? now;
    const marked = backgroundMark({ ...note, idleSince }, background, now);
    if (background === "live" || note.waitingOn !== undefined) return { ...entry, working: waitingMark(marked, now) };
    const { waiting: _not, ...plain } = marked;
    return { ...entry, working: { ...plain, ...(now - idleSince >= stallMs ? { stalled: true } : {}) } };
  });
}

/** What the pool learned of a run as it ended: the tokens it spent and the Claude session it ran in. */
type RunRecord = Readonly<{ tokens?: Entry["tokens"]; session?: string }>;

/**
 * A run that ended. Its session is the one it ran in. Where the pool did not learn it, a review run keeps the session it resumed, and any
 * other run has none, so an earlier worker's session is never taken for this one's.
 */
function ended(entry: Entry, outcome: Outcome, now: number, { tokens, session }: RunRecord): Entry {
  const ranIn = session ?? (entry.review || entry.talk ? entry.session : undefined);
  // A working note is a running run's: the outcome it ended on replaces it. A pull request outcome says whether the run is partial, a `done` says nothing
  // remains to build and drops the declaration (A11-173), and any other keeps what the run had: a review round's `reviewed` says nothing of it.
  // The heads of its pull requests belong to the outcome it replaces: the end of this run records its own (A11-153).
  const { session: _earlier, working: _note, declined: _refused, prompt: _asked, partial: _declared, talk: _talking, talkFrom: _replaced, outcomeHeads: _ended, pullHeads: _read, sessionNote: _closed, handedBack: _handed, stoppedForUpdate: _stopped, ...kept } = entry;
  // A talk session that ends on a pull request outcome is that run again, not a review round: the list it borrowed to keep them linked goes.
  const borrowed = entry.talk && entry.talkFrom?.review === undefined && (outcome.kind === "draft-pr" || outcome.kind === "ready-pr");
  const { review: _borrowed, ...unborrowed } = kept;
  const rest = borrowed ? unborrowed : kept;
  const partial = outcome.kind === "draft-pr" || outcome.kind === "ready-pr" ? outcome.partial : outcome.kind === "done" ? undefined : entry.partial;
  // What the merged pull requests declared goes with the `partial` it decided (A11-181): a pull request outcome or a `done` sets `partial` afresh, and any other keeps both.
  const resets = outcome.kind === "draft-pr" || outcome.kind === "ready-pr" || outcome.kind === "done";
  const { declared: _pulled, partialOverruled: _overruled, ...fresh } = rest;
  return { ...(resets ? fresh : rest), phase: "finished", outcome, finishedAt: now, waiting: false, ...(tokens ? { tokens } : {}), ...(ranIn ? { session: ranIn } : {}),
    ...(partial !== undefined ? { partial } : {}) };
}

/** The run has ended and its workspace is gone. */
export function finish(queue: Queue, key: string, outcome: Outcome, now: number, record: RunRecord = {}): Queue {
  const finished = replace(queue, key, (entry) => ({ ...ended(entry, outcome, now, record), ...lastTerminalOf(entry), workspace: undefined, pane: undefined }));
  return loggedEnd(queue, finished, key, outcome, now);
}

/**
 * The events of a run that ended on `outcome`, after the queue `finished` is made from `before`: each pull request the outcome names that the log has not seen opened, that it finished, and that it needs a person when it asked one.
 * A run already finished on this very outcome logs nothing, so a run parked and then finished on the same word is one ending (A11-219). PURE.
 */
function loggedEnd(before: Queue, finished: Queue, key: string, outcome: Outcome, now: number): Queue {
  const was = find(before, key);
  if (was === undefined || (was.phase === "finished" && JSON.stringify(was.outcome) === JSON.stringify(outcome))) return finished;
  const opened = ("prs" in outcome ? outcome.prs : []).filter(({ url }) => !logHas(finished, key, (event) => event.kind === "pr-opened" && event.url === url));
  const withPulls = opened.reduce<Queue>((next, { url }) => logEvent(next, key, now, { kind: "pr-opened", url }), finished);
  const reason = "reason" in outcome ? shortReason(outcome.reason) : null;
  const ended = logEvent(withPulls, key, now, { kind: "finished", outcome: outcome.kind, ...(reason === null ? {} : { reason }) });
  return outcome.kind === "needs-human" ? logEvent(ended, key, now, { kind: "needs-you", reason: reason ?? outcome.kind }) : ended;
}

/**
 * The run has ended and keeps its workspace and pane, where a person can answer its agent. A talk session stays one while it waits there for the person, so the board
 * says Talking and not that the run needs them (A11-171), and the run it replaced stays with it, so a session that ends again is judged as before: the mark goes when the run
 * ends for good, or its workspace is closed ({@link unpark}).
 */
export function park(queue: Queue, key: string, outcome: Outcome, now: number, record: RunRecord = {}): Queue {
  const parked = replace(queue, key, (entry) => ({ ...ended(entry, outcome, now, record), ...(entry.talk === true ? { talk: true, ...(entry.talkFrom ? { talkFrom: entry.talkFrom } : {}) } : {}) }));
  return loggedEnd(queue, parked, key, outcome, now);
}

/**
 * The ticket has its plan: it goes back on the queue, where it was, to be worked with its own model and effort. A planning run leaves nothing
 * behind but the mark that its plan was decided for the person; `unattended` is false for a plan that reached the ticket some other way.
 */
export function planDone(queue: Queue, key: string, { unattended = true, now }: { unattended?: boolean; now?: number } = {}): Queue {
  // The choice it was planned with and what its blockers gave its planner are kept (A11-167): a plan that goes stale is written again on the same choice, and the findings are not read twice. What their pull requests declared is kept too (A11-206), so a run does not wait a sweep for it again.
  // A stale plan written again leaves a run that had these before it: the record of the move it made, the plan steps merged and the overlap a person started it past (A11-167).
  const planned = replace(queue, key, ({ ticket, repos, model, effort, queuedAt, blockers, plan, learned, blockersDeclared, plannedAgainst, movedFrom, steps, overlapOverride }) =>
    ({ ticket, repos, model, effort, ...(unattended ? { planned: true } : {}), ...(plan ? { plannedWith: plan } : {}), ...(learned ? { learned } : {}), ...(blockersDeclared ? { blockersDeclared } : {}), ...(plannedAgainst ? { plannedAgainst } : {}),
      ...(movedFrom ? { movedFrom } : {}), ...(steps ? { steps } : {}), ...(overlapOverride ? { overlapOverride } : {}), phase: "queued", queuedAt, ...(blockers ? { blockers } : {}) }));
  const entry = find(queue, key);
  // The plan is attached to the ticket's own page, so that is the link (the tracker contract does not return the attachment's address).
  return entry === undefined ? planned : logEvent(planned, key, now, { kind: "planned", link: entry.ticket.url ?? null });
}

/**
 * A ticket planned in a batch has its plan, as {@link planDone}, with the repository its planner said its work lands in, and the blockers its
 * planner said to wait on to merge (`waitMerged`, when there are any). Its blockers are read again before it starts, because the board has just
 * written its batch's order to the tracker.
 */
export function batchPlanDone(queue: Queue, key: string, repo: string | null, waitMerged: readonly string[] = [], now?: number): Queue {
  return replace(planDone(queue, key, { now }), key, ({ blockers: _stale, ...entry }) => ({ ...entry, plannedRepo: repo, ...(waitMerged.length > 0 ? { waitMerged } : {}) }));
}

/** A person answered a parked run's agent, which is working again: the run is live once more, and its old outcome and tracker state are dropped. */
export function markResumed(queue: Queue, key: string): Queue {
  return replace(queue, key, (entry) => (isParked(entry)
    ? { ...entry, phase: "running", outcome: undefined, finishedAt: undefined, trackerState: undefined, pullStates: undefined, outcomeHeads: undefined, pullHeads: undefined,
      handedBack: undefined, waiting: false, seenWorking: true }
    : entry));
}

/** A parked run's workspace is closed: the run keeps its outcome and holds no workspace, and a talk session it was is over (A11-171). */
export function unpark(queue: Queue, key: string): Queue {
  return replace(queue, key, (entry) => {
    if (!isParked(entry)) return entry;
    const { talk: _over, talkFrom: _replaced, ...rest } = entry;
    return { ...rest, ...lastTerminalOf(entry), workspace: undefined, pane: undefined };
  });
}

/**
 * The keys of finished runs that neither the tracker nor their pull requests have settled yet: the ones worth asking about again. A run declared partial whose pull
 * requests merged is not settled by them (A11-168): its ticket stays open and the board may queue its next step, so the tracker is asked again, and a ticket finished
 * since the pull request was open is seen before a step is queued for it.
 */
export function unsettledKeys(queue: Queue): string[] {
  return queue.entries.filter((entry) => entry.phase === "finished" && (isUnsettled(entry) || completedBeforeMerge(entry))).map((entry) => entry.ticket.key);
}

/** A finished run neither the tracker nor its pull requests have settled, or a partial one whose pull requests merged and whose ticket the tracker has not finished. PURE. */
const isUnsettled = (entry: Entry): boolean => !SETTLED.has(entry.trackerState ?? "")
  && (settledByPulls(entry) === null || (entry.partial !== undefined && settledByPulls(entry) === "completed"));

/**
 * A partial run whose ticket the tracker read Completed before it read its pull requests merged (A11-178): the tracker's integration completes a ticket as the merge lands, and a read between the two sees the
 * ticket done and the pull request open. The run's pull requests are asked again until they say, so the completion is found to be early and put back. A ticket a person completed is no longer asked about once
 * the board has found that out. PURE.
 */
const completedBeforeMerge = (entry: Entry): boolean => entry.partial !== undefined && entry.trackerState === "completed" && entry.completedBy === undefined && settledByPulls(entry) === null;

/** Record the state of each finished run's pull requests, for each run the tracker named. */
export function recordPullStates(queue: Queue, pulls: ReadonlyMap<string, Readonly<Record<string, PullState>>>, now?: number): Queue {
  const recorded = { ...queue, entries: queue.entries.map((entry) => {
    const states = pulls.get(entry.ticket.key);
    return entry.phase === "finished" && states !== undefined ? { ...entry, pullStates: states } : entry;
  }) };
  // A pull request that turns merged is logged once: it was not merged in the record before, and the log has not seen it merge.
  return queue.entries.reduce<Queue>((next, entry) => {
    const states = entry.phase === "finished" ? pulls.get(entry.ticket.key) : undefined;
    const turned = Object.entries(states ?? {}).filter(([url, state]) => state === "merged" && entry.pullStates?.[url] !== "merged"
      && !logHas(next, entry.ticket.key, (event) => event.kind === "merged" && event.url === url));
    return turned.reduce<Queue>((logged, [url]) => logEvent(logged, entry.ticket.key, now, { kind: "merged", url }), next);
  }, recorded);
}

/**
 * Record the paths each queued run's plan declares, for each run whose plan was read, and clear why it could not be (`pathsFailure`). A run that has
 * started keeps what it started with. `stepPaths` is the paths each step section of the plan lists, by step number, for a plan that has any (A11-175); a plan read again that has none drops what was recorded.
 */
export function recordPaths(queue: Queue, paths: ReadonlyMap<string, readonly string[]>, stepPaths: ReadonlyMap<string, Readonly<Record<string, readonly string[]>>> = new Map()): Queue {
  return { ...queue, entries: queue.entries.map((entry) => {
    const found = paths.get(entry.ticket.key);
    if (entry.phase !== "queued" || found === undefined) return entry;
    const { pathsFailure: _read, stepPaths: _earlier, ...rest } = entry;
    const ofSteps = stepPaths.get(entry.ticket.key);
    return { ...rest, paths: found, ...(ofSteps === undefined || Object.keys(ofSteps).length === 0 ? {} : { stepPaths: ofSteps }) };
  }) };
}

/**
 * Record why each queued run's plan could not be downloaded (A11-125), so the board says why it waits. A run whose plan is read keeps its paths, and
 * is not held by this; the run is asked again on the next pass, as its paths are still unread.
 */
export function recordPathsFailure(queue: Queue, failures: ReadonlyMap<string, string>): Queue {
  return { ...queue, entries: queue.entries.map((entry) => {
    const reason = failures.get(entry.ticket.key);
    return entry.phase === "queued" && reason !== undefined ? { ...entry, pathsFailure: reason } : entry;
  }) };
}

/**
 * Whether a queued run's plan paths are still to be read: a run that is not planning or reviewing, and has not been read yet. A planning run is
 * never held by a path, and a review round keeps the paths of the run it continues.
 */
export const pathsUnread = (entry: Entry): boolean =>
  entry.phase === "queued" && entry.paths === undefined && entry.plan === undefined && entry.review === undefined;

/** The queued runs whose plan paths have not been read yet. */
export const unreadPaths = (queue: Queue): Entry[] => queue.entries.filter(pathsUnread);

/** Record the files a finished run's open pull requests change, by URL, as the watch read them. */
export function recordPullFiles(queue: Queue, key: string, files: Readonly<Record<string, readonly string[]>>): Queue {
  return replace(queue, key, (entry) => (entry.phase === "finished" ? { ...entry, pullFiles: files } : entry));
}

/** Record why a finished run's reviewer verdict is not on its pull request (A11-83), or clear it with `undefined` once one is. */
export function recordVerdictNotPosted(queue: Queue, key: string, reason: string | undefined): Queue {
  return replace(queue, key, (entry) => {
    if (entry.phase !== "finished") return entry;
    const { verdictNotPosted: _previous, ...rest } = entry;
    return reason === undefined ? rest : { ...rest, verdictNotPosted: reason };
  });
}

/** Record what a finished run's stacked pull requests need said of their bases (A11-106), or clear it with `undefined` once none does. */
export function recordRetargets(queue: Queue, key: string, notes: Readonly<Record<string, string>> | undefined): Queue {
  return replace(queue, key, (entry) => {
    if (entry.phase !== "finished") return entry;
    const { retargets: _previous, ...rest } = entry;
    return notes === undefined ? rest : { ...rest, retargets: notes };
  });
}

/** Record the tickets that block each queued run, for each run the tracker was asked about. A run that has started keeps what it started with. */
export function recordBlockers(queue: Queue, blockers: ReadonlyMap<string, readonly Blocker[]>): Queue {
  return { ...queue, entries: queue.entries.map((entry) => {
    const found = blockers.get(entry.ticket.key);
    return entry.phase === "queued" && found !== undefined ? { ...entry, blockers: found } : entry;
  }) };
}

/**
 * Record the repository each queued run's project names (`project-repo.ts`), by key. A key the map leaves out keeps what it had, so a source that
 * could not say does not clear a repository it named before.
 */
export function recordProjectRepos(queue: Queue, repos: ReadonlyMap<string, string | null>): Queue {
  return { ...queue, entries: queue.entries.map((entry) => {
    const found = repos.get(entry.ticket.key);
    return entry.phase === "queued" && found !== undefined ? { ...entry, projectRepo: found } : entry;
  }) };
}

/** Record what a run was branched from (or clear it, for `undefined`), by key: the pool keeps it current as the blocker's branch moves (A11-116). */
export function recordStackBase(queue: Queue, key: string, stackBase: StackBaseRecord | undefined): Queue {
  return replace(queue, key, (entry) => ({ ...entry, stackBase }));
}

/**
 * Record the commit each stacked blocker's branch is at, by run and then by blocker key (A11-116), on the blockers of the queued runs as they are now: a
 * read that is slow to answer never writes back the blockers it read before the tracker answered again. A blocker with no head read has none.
 */
export function recordHeads(queue: Queue, heads: ReadonlyMap<string, ReadonlyMap<string, string>>): Queue {
  return { ...queue, entries: queue.entries.map((entry) => {
    const found = heads.get(entry.ticket.key);
    if (entry.phase !== "queued" || found === undefined || entry.blockers === undefined) return entry;
    return { ...entry, blockers: entry.blockers.map((blocker) => withHead(blocker, found.get(blocker.key))) };
  }) };
}

/** A blocker with the head given, or with none when `head` is undefined. PURE. */
const withHead = (blocker: Blocker, head: string | undefined): Blocker => {
  const { head: _stale, ...rest } = blocker;
  return head === undefined ? rest : { ...rest, head };
};

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
 * The finished runs whose ticket the board may complete itself (A11-92, A11-153): not declared partial, whose pull requests have all merged or closed with
 * one merged, whatever kind the run's outcome was, and whose ticket the tracker has not finished. PURE.
 */
export function completableRuns(queue: Queue): Entry[] {
  return queue.entries.filter((entry) => entry.phase === "finished" && entry.partial === undefined
    && entry.closedByBoard !== true && !SETTLED.has(entry.trackerState ?? "") && settledByPulls(entry) === "completed");
}

/** The slots live runs hold: one per run, and one for a live publish run. */
export const slotsHeld = (queue: Queue): number =>
  new Set(queue.entries.filter(isLive).map(runOf)).size + (queue.publish !== undefined && LIVE.has(queue.publish.phase) ? 1 : 0) + (queue.writers ?? []).filter(writerLive).length;

/** The run an entry starts in, for counting slots: its batch's, which every ticket in the batch shares, or else its own. */
export const runOf = (entry: Entry): string => entry.batch ?? entry.ticket.key;
