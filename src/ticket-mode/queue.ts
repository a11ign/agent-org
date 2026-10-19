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
import { MAX_WRITER_RUNS, replace, type DraftRecord, type Entry, type Queue, type WriterPhase, type WriterRun } from "./queue/declared-remains.ts";
import { runOf, slotsHeld } from "./queue/approve.ts";

/** Record that the board completed the ticket of the finished run `key`, so it is not completed again. */
export const recordClosedByBoard = (queue: Queue, key: string): Queue => replace(queue, key, (entry) => ({ ...entry, closedByBoard: true }));

/**
 * The queued entries to start now, in queue order: none while the queue is paused or the host is loaded past its cores (`wake.ts`'s `hostLoadRefusal` rule, where
 * exactly equal does not refuse), and otherwise as many as the free slots allow. An entry still waiting on a blocker, or on a path another run holds
 * ({@link overlapWait}), is passed over, and holds no slot. So is one whose plan could not be downloaded (`pathsFailure`): it takes no slot another
 * run could use (A11-125). A batch is one run, so its tickets take one slot between them, live or starting.
 * An entry this call starts holds its paths against the entries after it, as a live run would, so overlapping runs never start in the same pass.
 */
export function nextStarts(queue: Queue, load: number, cores: number): Entry[] {
  if (queue.paused || load > cores) return [];
  const free = queue.max - slotsHeld(queue);
  const runs = new Set<string>();
  const started: Entry[] = [];
  return queue.entries.filter((entry) => {
    if (entry.phase !== "queued" || entry.pathsFailure !== undefined || waitsOn(entry, queue.entries).length > 0) return false;
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
    ...(parsed.writers ? { writers: (parsed.writers as LegacyRun[]).map(writerAsRead) } : {}) };
}

/** Replace the file whole: write beside it, then rename over it. */
export function saveQueue(path: string, queue: Queue): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(queue, null, 2)}\n`);
  renameSync(next, path);
}

/*
 * WRITER RUNS. A new-ticket request is a short run of the ticket-writing skill, which leaves drafts; the board makes a ticket from each one when the
 * run ends. These transitions keep each run's phase, slot, drafts and failure, as the publish run's do for its own.
 */

/** Change the writer run `id`, if there is one. */
const replaceWriter = (queue: Queue, id: string, change: (run: WriterRun) => WriterRun): Queue =>
  ({ ...queue, writers: (queue.writers ?? []).map((run) => (run.id === id ? change(run) : run)) });

const findWriter = (queue: Queue, id: string): WriterRun | undefined => (queue.writers ?? []).find((run) => run.id === id);

/** The run without its wait: the agent it waited on has ended, or has its answer (A11-129). PURE. */
const notWaiting = ({ waiting: _answered, ...run }: WriterRun): WriterRun => run;

/** The failure an older board's review left, which this board no longer offers: the request is failed, and nothing is created from its drafts. */
export const LEGACY_REVIEW_FAILURE = "this request was left for review by an older board, and the review screen is gone: dismiss it and ask again";

/** A draft as an older board wrote it: `pending` and `discarded` are statuses this board no longer has. */
type LegacyDraft = Omit<DraftRecord, "status"> & Readonly<{ status: DraftRecord["status"] | "pending" | "discarded" }>;

/** A writer run as an older board wrote it: a grill run may be `waiting` on its question, and its drafts may be for review. */
type LegacyRun = Omit<WriterRun, "drafts" | "phase"> & Readonly<{ phase: WriterPhase | "waiting"; drafts: readonly LegacyDraft[] }>;

/** A draft as this board reads it. A draft an older board left for review is failed: nothing is made from it now. A draft an older board was creating is failed too, so the tracker is checked before the request is asked again. */
const draftAsRead = (draft: LegacyDraft): DraftRecord => {
  if (draft.status === "pending" || draft.status === "discarded") return { ...draft, status: "failed", failure: LEGACY_REVIEW_FAILURE };
  if (draft.status === "creating") return { ...draft, status: "failed", failure: "the board stopped while it was creating this ticket: check the tracker before you ask again" };
  return { ...draft, status: draft.status };
};

/**
 * A writer run as this board reads it. A grill run `waiting` on its question is running again: its agent is still in its terminal, and its clock starts
 * again, since the grill limit counts from the resume. A run with a draft an older board left for review is failed, so no ticket is made from it. PURE.
 */
export function writerAsRead(run: LegacyRun): WriterRun {
  const drafts = run.drafts.map(draftAsRead);
  if (run.drafts.some(({ status }) => status === "pending" || status === "discarded")) {
    return { ...run, phase: "finished", drafts, failure: LEGACY_REVIEW_FAILURE, finishedAt: run.finishedAt ?? run.queuedAt };
  }
  if (run.phase === "waiting") return { ...run, phase: "running", drafts, startedAt: undefined };
  return { ...run, phase: run.phase, drafts };
}

/**
 * Add a new-ticket request, queued, with the model and effort it runs on. At most {@link MAX_WRITER_RUNS} are unfinished at once: a fourth is refused,
 * naming why, so a person clears one first. PURE.
 */
export function queueWriter(queue: Queue, request: Pick<WriterRun, "id" | "request" | "mode" | "form" | "model" | "effort">, now: number): Queue {
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
 * The writer run's outcome was read: its valid drafts are kept, each waiting to be made, with its duplicates, and each refused file is kept by name. The
 * run is then `creating` (`writerCreated` ends it). A run with no valid draft ends failed, saying what each refused file got wrong. PURE.
 */
export function writerDrafted(queue: Queue, id: string, written: Readonly<{ drafts: readonly DraftRecord[]; rejected: readonly Rejection[] }>, now: number): Queue {
  if (written.drafts.length === 0) {
    const reasons = written.rejected.map(({ reason }) => reason).join("; ");
    const failure = written.rejected.length === 0 ? "it wrote no draft" : `none of its drafts is valid: ${reasons}`;
    return replaceWriter(queue, id, (run) => ({ ...notWaiting(run), phase: "finished", finishedAt: now, failure, rejected: written.rejected }));
  }
  return replaceWriter(queue, id, (run) => ({ ...notWaiting(run), phase: "creating", drafts: written.drafts, rejected: written.rejected }));
}

/**
 * Every draft of the run has been made or refused: the run is finished. It fails, saying why, when a draft file was refused or a draft's ticket was not
 * made; the tickets already made stay made and are shown with it. PURE.
 */
export function writerCreated(queue: Queue, id: string, now: number): Queue {
  return replaceWriter(queue, id, (run) => {
    const refused = run.rejected.length === 0 ? [] : [`${run.rejected.length} draft file${run.rejected.length === 1 ? "" : "s"} refused, shown above`];
    const notMade = run.drafts.filter(({ status }) => status !== "created").map(({ file, failure }) => `${file} was not created: ${failure ?? "it was not tried"}`);
    const failure = [...refused, ...notMade].join("; ");
    return { ...run, phase: "finished", finishedAt: now, ...(failure === "" ? { failure: undefined } : { failure }) };
  });
}

/** The writer run's draft `draftId`, or undefined. */
export const draftOf = (queue: Queue, id: string, draftId: string): DraftRecord | undefined => findWriter(queue, id)?.drafts.find((draft) => draft.id === draftId);

/** Record the tracker's answer for draft `draftId` of run `id`, which holds it: the change is made to the draft record only. */
export const changeDraft = (queue: Queue, id: string, draftId: string, change: (draft: DraftRecord) => DraftRecord): Queue =>
  replaceWriter(queue, id, (run) => ({ ...run, drafts: run.drafts.map((draft) => (draft.id === draftId ? change(draft) : draft)) }));

/** The writer run failed: it holds no slot, and the drafts it had are kept as they are. */
export function writerFailed(queue: Queue, id: string, failure: string, now: number): Queue {
  return replaceWriter(queue, id, (run) => ({ ...notWaiting(run), phase: "finished", finishedAt: now, failure }));
}

/**
 * The person stopped the writer run. A draft not yet made is failed, saying so, and is not tried; the tickets already made stay. Its workspace is closed
 * by the caller.
 */
export const stopWriter = (queue: Queue, id: string, now: number): Queue =>
  replaceWriter(queue, id, (run) => (run.phase === "finished" ? run : {
    ...notWaiting(run), phase: "finished", finishedAt: now, failure: "stopped on the board",
    drafts: run.drafts.map((draft) => (draft.status === "creating" ? { ...draft, status: "failed", failure: "stopped on the board" } : draft)),
  }));

/** Remove a finished writer run from the board. A run still under way is stopped first. */
export function dismissWriter(queue: Queue, id: string): Queue {
  const run = findWriter(queue, id);
  if (run === undefined) return queue;
  if (run.phase !== "finished") throw new Error("stop the new-ticket request before you dismiss it");
  return { ...queue, writers: (queue.writers ?? []).filter((other) => other.id !== id) };
}

/** The writer run `id`, or undefined. */
export const writerOf = (queue: Queue, id: string): WriterRun | undefined => findWriter(queue, id);
