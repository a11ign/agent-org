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
import { overlapWait, waitsOn } from "./board-view/settled-by-pulls.ts";
import type { Rejection } from "./writer.ts";
import { MAX_WRITER_RUNS, replace, type DraftRecord, type Entry, type Queue, type WriterRun } from "./queue/declared-remains.ts";
import { runOf, slotsHeld } from "./queue/approve.ts";

/** Record that the board completed the ticket of the finished run `key`, so it is not completed again. */
export const recordClosedByBoard = (queue: Queue, key: string): Queue => replace(queue, key, (entry) => ({ ...entry, closedByBoard: true }));

/**
 * The queued entries to start now, in queue order: none while the queue is paused or the host is loaded past its cores (`wake.ts`'s `hostLoadRefusal` rule, where
 * exactly equal does not refuse), and otherwise as many as the free slots allow. An entry still waiting on a blocker, or on a path another run holds
 * ({@link overlapWait}), is passed over, and holds no slot. A batch is one run, so its tickets take one slot between them, live or starting.
 * An entry this call starts holds its paths against the entries after it, as a live run would, so overlapping runs never start in the same pass.
 */
export function nextStarts(queue: Queue, load: number, cores: number): Entry[] {
  if (queue.paused || load > cores) return [];
  const free = queue.max - slotsHeld(queue);
  const runs = new Set<string>();
  const started: Entry[] = [];
  return queue.entries.filter((entry) => {
    if (entry.phase !== "queued" || waitsOn(entry, queue.entries).length > 0) return false;
    if (!runs.has(runOf(entry)) && runs.size >= free) return false;
    if (overlapWait(entry, [...queue.entries, ...started.map(asStarting)]) !== null) return false;
    runs.add(runOf(entry));
    started.push(entry);
    return true;
  });
}

/** The entry as it is once a start is recorded: starting, so it holds what a live run holds. */
const asStarting = (entry: Entry): Entry => ({ ...entry, phase: "starting" });

export function emptyQueue(max: number): Queue {
  return { entries: [], max, paused: true };
}

/** The queue on disk, or an empty one with `max` when there is no file yet. */
export function loadQueue(path: string, max: number): Queue {
  if (!existsSync(path)) return emptyQueue(max);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Queue;
  return { entries: parsed.entries ?? [], max: parsed.max ?? max, paused: parsed.paused ?? true, ...(parsed.publish ? { publish: parsed.publish } : {}),
    ...(parsed.writers ? { writers: parsed.writers } : {}) };
}

/** Replace the file whole: write beside it, then rename over it. */
export function saveQueue(path: string, queue: Queue): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(queue, null, 2)}\n`);
  renameSync(next, path);
}

/*
 * WRITER RUNS. A new-ticket request is a short run of the ticket-writing skill, which leaves drafts; a person approves each one on the board, and only
 * then is a ticket made. These transitions keep each run's phase, slot and drafts, as the publish run's do for its own.
 */

/** Change the writer run `id`, if there is one. */
const replaceWriter = (queue: Queue, id: string, change: (run: WriterRun) => WriterRun): Queue =>
  ({ ...queue, writers: (queue.writers ?? []).map((run) => (run.id === id ? change(run) : run)) });

const findWriter = (queue: Queue, id: string): WriterRun | undefined => (queue.writers ?? []).find((run) => run.id === id);

/**
 * Add a new-ticket request, queued. At most {@link MAX_WRITER_RUNS} are unfinished at once: a fourth is refused, naming why, so a person clears one
 * first. PURE.
 */
export function queueWriter(queue: Queue, request: Pick<WriterRun, "id" | "request" | "mode" | "form">, now: number): Queue {
  const open = (queue.writers ?? []).filter((run) => run.phase !== "finished").length;
  if (open >= MAX_WRITER_RUNS) throw new Error(`${MAX_WRITER_RUNS} new-ticket requests are unfinished already: finish or stop one before you add another`);
  const run: WriterRun = { ...request, phase: "queued", queuedAt: now, drafts: [], rejected: [] };
  return { ...queue, writers: [...(queue.writers ?? []), run] };
}

/** The writer run that starts now: the first queued one, when a worker slot is free. A run waits for no Pause: a person just asked for it. */
export function writerToStart(queue: Queue): WriterRun | undefined {
  if (slotsHeld(queue) >= queue.max) return undefined;
  return (queue.writers ?? []).find((run) => run.phase === "queued");
}

export const markWriterStarting = (queue: Queue, id: string, now: number): Queue =>
  replaceWriter(queue, id, (run) => ({ ...run, phase: "starting", startedAt: now }));

export const markWriterRunning = (queue: Queue, id: string, workspace: string, pane: string): Queue =>
  replaceWriter(queue, id, (run) => ({ ...run, phase: "running", workspace, pane }));

/** The agent was seen working: a grill run's question is answered, or it is simply under way. */
export const observeWriter = (queue: Queue, id: string): Queue =>
  replaceWriter(queue, id, (run) => (run.seenWorking === true ? run : { ...run, seenWorking: true }));

/** A grill run waits for the person to answer its question in its terminal. Its slot is given back while it waits. */
export const writerWaiting = (queue: Queue, id: string, question: string): Queue =>
  replaceWriter(queue, id, (run) => ({ ...run, phase: "waiting", question }));

/** A waiting grill run is working again: it has been answered, and its question is no longer shown. */
export const writerResumed = (queue: Queue, id: string, now: number): Queue =>
  replaceWriter(queue, id, (run) => ({ ...run, phase: "running", startedAt: now, question: undefined, seenWorking: false }));

/**
 * The writer run ended with its drafts: each valid draft is stored as pending, with its duplicates, and each refused file is kept by name. A run
 * with no valid draft ends failed, saying what each refused file got wrong. PURE.
 */
export function writerDrafted(queue: Queue, id: string, written: Readonly<{ drafts: readonly DraftRecord[]; rejected: readonly Rejection[] }>, now: number): Queue {
  if (written.drafts.length === 0) {
    const reasons = written.rejected.map(({ reason }) => reason).join("; ");
    const failure = written.rejected.length === 0 ? "it wrote no draft" : `none of its drafts is valid: ${reasons}`;
    return replaceWriter(queue, id, (run) => ({ ...run, phase: "finished", finishedAt: now, failure, rejected: written.rejected, question: undefined }));
  }
  return replaceWriter(queue, id, (run) => ({ ...run, phase: "finished", finishedAt: now, drafts: written.drafts, rejected: written.rejected, question: undefined }));
}

/** The writer run failed: it holds no slot, and its drafts so far are kept. */
export function writerFailed(queue: Queue, id: string, failure: string, now: number): Queue {
  return replaceWriter(queue, id, (run) => ({ ...run, phase: "finished", finishedAt: now, failure, question: undefined }));
}

/** The person stopped the writer run: its workspace is closed by the caller, and the drafts it already wrote stay for review. */
export const stopWriter = (queue: Queue, id: string, now: number): Queue =>
  replaceWriter(queue, id, (run) => (run.phase === "finished" ? run : { ...run, phase: "finished", finishedAt: now, failure: "stopped on the board", question: undefined }));

/** Remove a finished writer run from the board. A run still writing is stopped first. */
export function dismissWriter(queue: Queue, id: string): Queue {
  const run = findWriter(queue, id);
  if (run === undefined) return queue;
  if (run.phase !== "finished") throw new Error("stop the new-ticket request before you dismiss it");
  return { ...queue, writers: (queue.writers ?? []).filter((other) => other.id !== id) };
}

/** Change one draft of the writer run `id`, which holds it. */
export const changeDraft = (queue: Queue, id: string, draftId: string, change: (draft: DraftRecord) => DraftRecord): Queue =>
  replaceWriter(queue, id, (run) => ({ ...run, drafts: run.drafts.map((draft) => (draft.id === draftId ? change(draft) : draft)) }));

/** The writer run's draft `draftId`, or undefined. */
export const draftOf = (queue: Queue, id: string, draftId: string): DraftRecord | undefined =>
  findWriter(queue, id)?.drafts.find((draft) => draft.id === draftId);

/** The writer run `id`, or undefined. */
export const writerOf = (queue: Queue, id: string): WriterRun | undefined => findWriter(queue, id);
