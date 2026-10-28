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
import { overlapWait } from "./board-view/overlap-hold.ts";
import { waitsOn } from "./board-view/pull-status-and-notes.ts";
import { MAX_WRITER_RUNS, replace, type Entry, type Queue, type WriterPhase, type WriterRun, type WriterTicket } from "./queue/queue-entries-and-outcomes.ts";
import { placementOf } from "./writer-placement.ts";
import { isCheckRun } from "./after-merge/verify.ts";
import { isCiHeld } from "./ci-spend/hold.ts";
import { runOf, slotsHeld } from "./queue/queue-transitions.ts";
import type { ToolPin } from "./queue/queue-pins.ts";

/** Record that the board completed the ticket of the finished run `key`, so it is not completed again. */
export const recordClosedByBoard = (queue: Queue, key: string): Queue => replace(queue, key, (entry) => ({ ...entry, closedByBoard: true }));

/**
 * The queued entries to start now, in queue order: none while the queue is paused or the host is loaded past its cores (`wake.ts`'s `hostLoadRefusal` rule, where
 * exactly equal does not refuse), and otherwise as many as the free slots allow. An entry still waiting on a blocker, or on a path another run holds
 * ({@link overlapWait}), is passed over, and holds no slot. So is one whose plan could not be downloaded (`pathsFailure`): it takes no slot another
 * run could use (A11-125). And so is a review round or talk session that a working agent's session holds back (`sessionWait`, A11-154). A batch is one run, so its tickets take one slot between them, live or starting.
 * An entry this call starts holds its paths against the entries after it, as a live run would, so overlapping runs never start in the same pass. `ready` names the entries that may start at all (`fill` passes the ones whose blockers and plan paths are read), so one that is not takes no slot from a run behind it (A11-359).
 */
export function nextStarts(queue: Queue, load: number, cores: number, ready: (entry: Entry) => boolean = () => true): Entry[] {
  if (queue.paused || load > cores) return [];
  const free = queue.max - slotsHeld(queue);
  const runs = new Set<string>();
  const started: Entry[] = [];
  return queue.entries.filter((entry) => {
    if (entry.phase !== "queued" || !ready(entry) || isHeldBack(entry, queue.entries)) return false;
    if (!runs.has(runOf(entry)) && runs.size >= free) return false;
    if (overlapWait(entry, [...queue.entries, ...started.map(asStarting)]) !== null) return false;
    runs.add(runOf(entry));
    started.push(entry);
    return true;
  });
}

/** Whether a queued entry is held back for a reason of its own: its plan could not be downloaded, its blockers could not be read (A11-359), a session holds it, a blocker has not let go, or the board holds it for its ticket's CI spend (A11-261). PURE. */
const isHeldBack = (entry: Entry, entries: readonly Entry[]): boolean =>
  entry.pathsFailure !== undefined || entry.blockersFailure !== undefined || entry.sessionWait !== undefined || isCiHeld(entry) || waitsOn(entry, entries).length > 0;

/** The entry as it is once a start is recorded: starting, so it holds what a live run holds. */
const asStarting = (entry: Entry): Entry => ({ ...entry, phase: "starting" });

export function emptyQueue(max: number): Queue {
  return { entries: [], max, paused: true };
}

/** The queue on disk, or an empty one with `max` when there is no file yet. */
export function loadQueue(path: string, max: number): Queue {
  if (!existsSync(path)) return emptyQueue(max);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Omit<Queue, "writers"> & { writers?: readonly LegacyRun[] };
  return { entries: parsed.entries ?? [], max: parsed.max ?? max, paused: parsed.paused ?? true, ...(parsed.publish ? { publish: parsed.publish } : {}),
    ...(parsed.writers ? { writers: parsed.writers.map(writerAsRead) } : {}), ...(parsed.runLog ? { runLog: parsed.runLog } : {}), ...(parsed.ciSpend ? { ciSpend: parsed.ciSpend } : {}),
    ...(parsed.interventions ? { interventions: parsed.interventions } : {}) };
}

/** Replace the file whole: write beside it, then rename over it. */
export function saveQueue(path: string, queue: Queue): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(queue, null, 2)}\n`);
  renameSync(next, path);
}

/*
 * WRITER RUNS. A new-ticket request is a run of the ticket-writing skill, which files its own ticket and attaches its plan (A11-135). These transitions
 * keep each run's phase, slot, tickets and failure, as the publish run's do for its own.
 */

/** Change the writer run `id`, if there is one. */
const replaceWriter = (queue: Queue, id: string, change: (run: WriterRun) => WriterRun): Queue =>
  ({ ...queue, writers: (queue.writers ?? []).map((run) => (run.id === id ? change(run) : run)) });

const findWriter = (queue: Queue, id: string): WriterRun | undefined => (queue.writers ?? []).find((run) => run.id === id);

/** The run without its wait: the agent it waited on has ended, or has its answer (A11-129). PURE. */
const notWaiting = ({ waiting: _answered, ...run }: WriterRun): WriterRun => run;

/** The failure an older board's review left, which this board no longer offers: the request is failed, and nothing is created from its drafts. */
export const LEGACY_REVIEW_FAILURE = "this request was left for review by an older board, and the review screen is gone: dismiss it and ask again";
/** The failure of a run an older board was making tickets for: this board files none from drafts, so the tracker is checked before the request is asked again. */
export const LEGACY_CREATING_FAILURE = "the board no longer makes tickets from drafts: check the tracker before you ask again";

/** A draft as an older board wrote it: only the fields this reading needs, with the statuses an older board had. */
type LegacyDraft = Readonly<{ file: string; status: "creating" | "created" | "failed" | "pending" | "discarded";
  created?: Readonly<{ key: string; url: string; inPick?: boolean }> }>;

/** A writer run as an older board wrote it: a grill run may be `waiting` on its question, and its drafts may be for review or being made. */
type LegacyRun = Omit<WriterRun, "tickets" | "phase" | "placement"> & Readonly<{ phase: WriterPhase | "waiting" | "creating"; tickets?: readonly WriterTicket[]; placement?: WriterRun["placement"];
  drafts?: readonly LegacyDraft[]; rejected?: readonly unknown[] }>;

/**
 * A writer run as this board reads it (A11-135). The tickets an older board made from its drafts are kept, as made. A run with a draft an older board left
 * for review is failed, so no ticket is made from it. A run an older board was making tickets for is failed too, saying to check the tracker. A grill
 * run `waiting` on its question is running again: its agent is still in its terminal, and its clock starts again, since the grill limit counts from the
 * resume. PURE.
 */
export function writerAsRead(run: LegacyRun): WriterRun {
  const { drafts = [], tickets: filed = [], rejected: _rejected, placement = placementOf(run.form), ...others } = run;
  const rest = { ...others, placement };
  const tickets: WriterTicket[] = [...filed, ...drafts.flatMap(({ status, created }) => (status === "created" && created !== undefined
    ? [{ key: created.key, url: created.url, inPick: created.inPick !== false }] : []))];
  if (drafts.some(({ status }) => status === "pending" || status === "discarded")) {
    return { ...rest, phase: "finished", tickets, failure: LEGACY_REVIEW_FAILURE, finishedAt: run.finishedAt ?? run.queuedAt };
  }
  if (run.phase === "creating") {
    const unmade = drafts.some(({ status }) => status !== "created");
    return { ...rest, phase: "finished", tickets, ...(unmade ? { failure: LEGACY_CREATING_FAILURE } : {}), finishedAt: run.finishedAt ?? run.queuedAt };
  }
  if (run.phase === "waiting") return { ...rest, phase: "running", tickets, startedAt: undefined };
  return { ...rest, phase: run.phase, tickets };
}

/**
 * Add a new-ticket request, queued, with the model and effort it runs on. At most {@link MAX_WRITER_RUNS} are unfinished at once: a fourth is refused,
 * naming why, so a person clears one first. PURE.
 */
export function queueWriter(queue: Queue, request: Pick<WriterRun, "id" | "request" | "mode" | "placement" | "form" | "model" | "effort"> & Partial<Pick<WriterRun, "ticket" | "startedFrom" | "team" | "checks">>, now: number): Queue {
  // The board's own runs for its After-merge checks (A11-302) are not new-ticket requests: they neither count toward the cap nor are held by it.
  const open = (queue.writers ?? []).filter((run) => run.phase !== "finished" && !isCheckRun(run.mode)).length;
  if (!isCheckRun(request.mode) && open >= MAX_WRITER_RUNS) throw new Error(`${MAX_WRITER_RUNS} new-ticket requests are unfinished already: finish or stop one before you add another`);
  const run: WriterRun = { ...request, phase: "queued", queuedAt: now, tickets: [] };
  return { ...queue, writers: [...(queue.writers ?? []), run] };
}

/** The writer run that starts now: the first queued one, when a worker slot is free. A person's request waits for no Pause: they just asked for it. The board's own check runs (A11-302) do wait for it. */
export function writerToStart(queue: Queue): WriterRun | undefined {
  if (slotsHeld(queue) >= queue.max) return undefined;
  return (queue.writers ?? []).find((run) => run.phase === "queued" && !(queue.paused && isCheckRun(run.mode)));
}

export const markWriterStarting = (queue: Queue, id: string, now: number): Queue =>
  replaceWriter(queue, id, (run) => ({ ...run, phase: "starting", startedAt: now }));

/** The copy of agent-org a new-ticket run is started with (A11-169), recorded as `recordToolPin` records a ticket run's. */
export const recordWriterPin = (queue: Queue, id: string, pin: ToolPin): Queue =>
  replaceWriter(queue, id, (run) => ({ ...run, toolRoot: pin.toolRoot, ...(pin.toolVersion === undefined ? {} : { toolVersion: pin.toolVersion }) }));

export const markWriterRunning = (queue: Queue, id: string, workspace: string, pane: string): Queue =>
  replaceWriter(queue, id, (run) => ({ ...run, phase: "running", workspace, pane }));

/** The agent was seen working: a quick run is under way, so one that then goes idle with no outcome has stopped. */
export const observeWriter = (queue: Queue, id: string): Queue =>
  replaceWriter(queue, id, (run) => (run.seenWorking === true ? run : { ...run, seenWorking: true }));

/**
 * A grill run's agent has ended its turn with no outcome, so it waits for the person to answer in its terminal, with `question` as the question. A
 * run already waiting keeps its question and its time: the same question is no change, so the file is not rewritten each pass. PURE.
 */
export const writerWaiting = (queue: Queue, id: string, question: string, now: number): Queue =>
  replaceWriter(queue, id, (run) => (run.waiting?.question === question ? run : { ...run, waiting: { question, since: now } }));

/**
 * The person answered a grill run's question and its agent works again: the run is no longer waiting, and its working clock starts again, so the grill
 * limit counts from the answer. A run that is not waiting is unchanged. PURE.
 */
export const writerResumed = (queue: Queue, id: string, now: number): Queue =>
  replaceWriter(queue, id, (run) => (run.waiting === undefined ? run : { ...notWaiting(run), startedAt: now }));

/**
 * The writer run ended (A11-135): it finished, with the tickets it created, shown as links, and why it failed when it did. A ticket made before a failure
 * stays made and is shown with it. PURE.
 */
export function writerEnded(queue: Queue, id: string, ended: Readonly<{ tickets: readonly WriterTicket[]; failure?: string }>, now: number): Queue {
  return replaceWriter(queue, id, (run) => ({ ...notWaiting(run), phase: "finished", finishedAt: now, tickets: ended.tickets, failure: ended.failure }));
}

/** The writer run failed: it holds no slot, and the tickets it had made are kept as they are. */
export function writerFailed(queue: Queue, id: string, failure: string, now: number): Queue {
  return replaceWriter(queue, id, (run) => ({ ...notWaiting(run), phase: "finished", finishedAt: now, failure }));
}

/** The person stopped the writer run. Its workspace is closed by the caller, and the tickets it already made stay. */
export const stopWriter = (queue: Queue, id: string, now: number, stopped: Readonly<{ tickets: readonly WriterTicket[]; problem: string | null }> = { tickets: [], problem: null }): Queue =>
  replaceWriter(queue, id, (run) => (run.phase === "finished" ? run : { ...notWaiting(run), phase: "finished", finishedAt: now, tickets: stopped.tickets, failure: joined("stopped on the board", stopped.problem) }));

/** The failure text from its parts, with the empty ones left out, or undefined when none is left. PURE. */
export const joined = (...parts: readonly (string | null)[]): string | undefined => {
  const text = parts.filter((part): part is string => part !== null).join("; ");
  return text === "" ? undefined : text;
};

/** Remove a finished writer run from the board. A run still under way is stopped first. */
export function dismissWriter(queue: Queue, id: string): Queue {
  const run = findWriter(queue, id);
  if (run === undefined) return queue;
  if (run.phase !== "finished") throw new Error("stop the new-ticket request before you dismiss it");
  return { ...queue, writers: (queue.writers ?? []).filter((other) => other.id !== id) };
}

/** The writer run `id`, or undefined. */
export const writerOf = (queue: Queue, id: string): WriterRun | undefined => findWriter(queue, id);
