// module: what the Runs page says of the queue -- its rail, its groups, its pages, a row's note, timing and tokens -- as pure functions of the queue the shell reads
//
// EVERY WORD ABOUT A RUN IS board-view's. The status names, the order, the counts, the runs a filter shows, each line of a row's note and the verbs a run offers come from `src/ticket-mode/board-view.ts`
// and `board-view/*.ts`, as `ui.html` draws them; this file only arranges what they return. The two small formatters `ui.html` keeps to itself (`length` and `since`) are restated here, since
// `ui.html` cannot be imported and is retired by A11-202.
import { reviewLinesOf } from "../../../src/ticket-mode/board-view.ts";
import { learnsLine } from "../../../src/ticket-mode/board-view/ticket-change.ts";
import { conflictNote } from "../../../src/ticket-mode/board-view/pull-conflict.ts";
import { checkNote, promptNote, queueNote, reasonOf, updateLines } from "../../../src/ticket-mode/board-view/run-reason.ts";
import { publishingOffLine } from "../../../src/ticket-mode/board-view/pull-review-state.ts";
import { ciNote } from "../../../src/ticket-mode/board-view/ci-note.ts";
import { readoptNote } from "../../../src/ticket-mode/board-view/readopt-note.ts";
import { sharedRunNote } from "../../../src/ticket-mode/board-view/run-terminal.ts";
import { cutListNote } from "../../../src/ticket-mode/board-view/overlap-hold.ts";
import { cycleNote } from "../../../src/ticket-mode/board-view/wait-cycles.ts";
import {
  isParked, overrideNote, rebaseNote, retargetNote, runsShown, shownStatus, stackedOn, stackNote, statusCounts, verdictNote, waitNote, waitsOn, workingNote,
} from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import { RUN_STATUSES, type RunStatus } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import type { ConfigView, QueueView } from "../api/types.ts";

/** A run as the queue API sends it. */
export type RunEntry = QueueView["entries"][number];

/** How many runs the page draws, and how many more each Load more draws. */
export const PAGE_SIZE = 50;

/** The name the filter is remembered under, the one `ui.html` uses, so a choice made in either board holds in the other. */
export const FILTER_MEMORY = "ticket-mode.run-filter";

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const BYTES_PER_K = 1000;
const MILLION = 1_000_000;

// ---- The rail ----

/** The rail's four section heads, each over the statuses it lists. Together they list `RUN_STATUSES`, in its order. */
export const RAIL_HEADS: readonly Readonly<{ label: string; statuses: readonly RunStatus[] }>[] = [
  { label: "Attention", statuses: ["needs-you", "talking"] },
  { label: "Active", statuses: ["working", "waiting", "planning", "reviewing", "blocked", "queued"] },
  { label: "Delivery", statuses: ["awaiting-review", "ready-to-merge", "publishing", "published", "checked"] },
  { label: "Finished", statuses: ["completed", "failed", "cancelled"] },
];

/** One status of the rail: its words, how many runs have it, and whether it is the one chosen. */
export type RailItem = Readonly<{ status: RunStatus; label: string; count: number }>;

export type Rail = Readonly<{ all: number; heads: readonly Readonly<{ label: string; items: readonly RailItem[] }>[] }>;

const LABEL_OF: ReadonlyMap<RunStatus, string> = new Map(RUN_STATUSES.map(({ status, label }) => [status, label]));

/** The words of a status, from `RUN_STATUSES`. */
export const labelOf = (status: RunStatus): string => LABEL_OF.get(status) ?? status;

/** The rail: "All runs" and every status under its head, each with how many runs have it (`statusCounts`). A status with no runs is listed at 0. PURE. */
export function railOf(queue: QueueView): Rail {
  const counts = statusCounts(queue.entries, queue.publish);
  return {
    all: queue.entries.length,
    heads: RAIL_HEADS.map(({ label, statuses }) => ({ label, items: statuses.map((status) => ({ status, label: labelOf(status), count: counts.get(status) ?? 0 })) })),
  };
}

/** The status a remembered choice names, or null (All runs) for anything else: a value from an older board, or nothing. PURE. */
export const filterFrom = (remembered: string | null): RunStatus | null => RUN_STATUSES.find(({ status }) => status === remembered)?.status ?? null;

// ---- The groups and the pages ----

/** The first group: every run that holds a worker slot. */
export const RUNNING_NOW = "Running now";

/** Whether a run holds a worker slot: it is starting or running. A parked or queued run holds none. */
export const holdsSlot = (entry: Readonly<{ phase: string }>): boolean => entry.phase === "starting" || entry.phase === "running";

/** A group of the list: its heading, how many runs the filter puts in it, and its runs. */
export type RunGroup = Readonly<{ id: string; label: string; count: number; runs: readonly RunEntry[] }>;

/** The runs the filter shows, the most recently active first (`runsShown`). */
export const filteredRuns = (queue: QueueView, filter: RunStatus | null): RunEntry[] => runsShown(queue.entries, filter, queue.publish);

/**
 * The runs under their headings. "Running now" holds every run that holds a worker slot, a Needs you run that is waiting among them. Every other run sits under its own status, in `RUN_STATUSES`'
 * order, and a status with no runs has no group. Within a group the runs keep the order they came in. PURE.
 */
export function groupsOf(queue: QueueView, runs: readonly RunEntry[]): RunGroup[] {
  const running = runs.filter(holdsSlot);
  const rest = runs.filter((run) => !holdsSlot(run));
  const groups: RunGroup[] = running.length === 0 ? [] : [{ id: "running-now", label: RUNNING_NOW, count: running.length, runs: running }];
  for (const { status, label } of RUN_STATUSES) {
    const own = rest.filter((run) => shownStatus(run, queue.publish, queue.entries) === status);
    if (own.length > 0) groups.push({ id: status, label, count: own.length, runs: own });
  }
  return groups;
}

/** What one page of the list draws: the groups cut to `limit` rows, the rows drawn, and how many runs the filter shows. A group's count is its runs under the filter, not its rows drawn. */
export type Paged = Readonly<{ groups: readonly RunGroup[]; shown: number; total: number }>;

/** The first `limit` rows in display order, and the groups they fall in. A group the limit does not reach is not drawn. PURE. */
export function paged(groups: readonly RunGroup[], limit: number): Paged {
  let left = limit;
  const drawn: RunGroup[] = [];
  for (const group of groups) {
    if (left <= 0) break;
    const runs = group.runs.slice(0, left);
    left -= runs.length;
    drawn.push({ ...group, runs });
  }
  return { groups: drawn, shown: drawn.reduce((sum, group) => sum + group.runs.length, 0), total: groups.reduce((sum, group) => sum + group.runs.length, 0) };
}

/** The footer's words, or null when every run is shown. PURE. */
export const footerOf = ({ shown, total }: Pick<Paged, "shown" | "total">): string | null => (shown >= total ? null : `Showing the latest ${shown} of ${total} runs`);

// ---- The header and the worker pool ----

/** The count line: `90 total · 3 running`, with `running` as the shell's Runs badge counts it; `0 total` when the queue holds no run. PURE. */
export const countText = (total: number, running: number): string => (total === 0 ? "0 total" : `${total} total · ${running} running`);

/** One square of the pool bar: filled for a run holding a slot, in the planning colour for a Planning run and the In progress colour otherwise (a Waiting run holds its slot too, A11-272), else empty. */
export type Slot = "planning" | "working" | "free";

/** The pool's squares and its words: `max` squares (more if more runs hold a slot than the limit says), one filled for each run holding a slot, in the order of the Running now group. PURE. */
export function poolOf(queue: QueueView): Readonly<{ slots: readonly Slot[]; busy: number; text: string }> {
  const holders = runsShown(queue.entries, null, queue.publish).filter(holdsSlot);
  const filled: Slot[] = holders.map((run) => (shownStatus(run, queue.publish, queue.entries) === "planning" ? "planning" : "working"));
  const slots = [...filled, ...Array.from<Slot>({ length: Math.max(0, queue.max - filled.length) }).fill("free")];
  return { slots, busy: holders.length, text: `${holders.length} of ${queue.max} busy` };
}

/** Whether workers are started or paused, as the queue says it: only an explicit `paused: false` is started. */
export type Workers = "started" | "paused";

const POOL_WORDS: Readonly<Record<Workers, Readonly<{ title: string; note: string; button: string }>>> = {
  paused: { title: "Workers paused", note: "Nothing queued will start.", button: "Start workers" },
  started: { title: "Workers started", note: "Queued tickets start as slots free up.", button: "Pause" },
};

/** What the pool bar says of the workers: "Workers started" or "Workers paused", what happens to queued tickets, and the button that changes it. PURE. */
export const poolWords = (workers: Workers): Readonly<{ title: string; note: string; button: string }> => POOL_WORDS[workers];

// ---- A row ----

/** How long a run took, or has taken: `14m`, `8 h 44m`. */
export function length(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MS_PER_MINUTE));
  return minutes < MINUTES_PER_HOUR ? `${minutes}m` : `${Math.floor(minutes / MINUTES_PER_HOUR)} h ${minutes % MINUTES_PER_HOUR}m`;
}

/** How long ago something was, as `ui.html` says it: `5 min`, `1 h 28 min`. */
export function since(ms: number, now: number): string {
  const minutes = Math.round((now - ms) / MS_PER_MINUTE);
  return minutes < MINUTES_PER_HOUR ? `${minutes} min` : `${Math.floor(minutes / MINUTES_PER_HOUR)} h ${minutes % MINUTES_PER_HOUR} min`;
}

/** The two timing lines of a row: "Running 5m" or "Ran 14m" with "Started 5 min ago"; a queued run says "Queued 3 min ago" and has no second line. PURE. */
export function timingOf(entry: Pick<RunEntry, "phase" | "startedAt" | "finishedAt" | "queuedAt">, now: number): Readonly<{ timing: string; started: string | null }> {
  if (entry.startedAt !== undefined) {
    const took = length((entry.finishedAt ?? now) - entry.startedAt);
    return { timing: `${entry.phase === "finished" ? "Ran" : "Running"} ${took}`, started: `Started ${since(entry.startedAt, now)} ago` };
  }
  return { timing: `Queued ${since(entry.queuedAt, now)} ago`, started: null };
}

/** A token count in the board's units: `189k` below a million, `74.2M` from a million. */
function unitsOf(count: number): string {
  const thousands = Math.round(count / BYTES_PER_K);
  return count >= MILLION || thousands * BYTES_PER_K >= MILLION ? `${(count / MILLION).toFixed(1)}M` : `${thousands}k`;
}

/** A run's tokens, `74.2M in · 189k out`, or null when the queue gives none. PURE. */
export const tokensOf = (entry: Pick<RunEntry, "tokens">): string | null => (entry.tokens === undefined ? null : `${unitsOf(entry.tokens.input)} in · ${unitsOf(entry.tokens.output)} out`);

/** What joins the lines of a row's note. */
export const NOTE_JOIN = " · ";

/** The words of a parked run, as `ui.html` says them. */
const PARKED_LINE = "Still open: answer the agent in its terminal and the run carries on";

/** What a row's note needs of the page besides the run: the whole queue, and the terminal and publisher the machine names. */
export type NoteContext = Readonly<{ queue: QueueView; publisher: ConfigView["publisher"] | undefined; now?: number }>;

const present = (line: string | null | undefined): line is string => line !== null && line !== undefined && line !== "";

/** The lines of a run's note, in the order `ui.html`'s `row()` draws them, with its CI line among them (Run detail lists them all; the card draws that line apart, `ciLineOf`). The links it puts inside some of them (What changed, the pull requests a plan learns from, the question's disclosure) are Run detail's. PURE. */
export const noteLines = (entry: RunEntry, context: NoteContext): string[] => linesOf(entry, context, ciNote(entry.ci));

/** A run's CI line as its card draws it apart from the note (A11-261): the words, and the tone they take, `warn` (amber) once the ticket is over its budget or the run is held for it, and `plain` before. */
export type CiLine = Readonly<{ text: string; tone: "plain" | "warn" }>;

/** The CI line of a run's card, or null when the board has read none. The card draws it in its own element, so the note does not repeat it. PURE. */
export function ciLineOf(entry: Pick<RunEntry, "ci">): CiLine | null {
  const text = ciNote(entry.ci);
  if (text === null) return null;
  const state = entry.ci?.state;
  return { text, tone: state === "over" || state === "held" ? "warn" : "plain" };
}

/** The lines of a note, with the CI line, when given, where `ciNote` puts it. */
function linesOf(entry: RunEntry, { queue, publisher, now }: NoteContext, ci?: string | null): string[] {
  const { entries } = queue;
  const waits = waitsOn(entry, entries);
  const stacked = stackedOn(entry, entries);
  const stalled = workingNote(entry, now);
  const outcome = entry.outcome;
  const edit = outcome !== undefined && "edit" in outcome ? outcome.edit : undefined;
  const lines: (string | null | undefined)[] = [
    promptNote(entry),
    sharedRunNote(entry, entries),
    waits.length > 0 ? `Waits on ${waits.map((blocker) => `${blocker.key} (${blocker.status})`).join(", ")}` : null,
    stacked.length > 0 ? stackNote(stacked) : null,
    rebaseNote(entry),
    waitNote(entry, entries),
    cycleNote(entry, entries),
    publishingOffLine(shownStatus(entry, queue.publish, entries), publisher),
    entry.sessionNote,
    readoptNote(entry),
    overrideNote(entry),
    cutListNote(entry, entries),
    reasonOf(entry, now).line,
    learnsLine(entry),
    ...updateLines(entry, queue.update ? { note: queue.update.note, instanceVersion: queue.update.version } : undefined),
    ...reviewLinesOf(entry, queue.pulls ?? {}),
    ...(outcome?.kind === "done" ? outcome.evidence : []),
    edit === undefined ? null : `Proposed edit to the ticket: ${edit.why}`,
    verdictNote(entry),
    retargetNote(entry),
    checkNote(entry),
    queueNote(entry),
    conflictNote(entry),
    ci,
    stalled?.stalled === true ? stalled.text : null,
    isParked(entry) ? PARKED_LINE : null,
  ];
  return lines.filter(present);
}

/** The note: the lines joined with " · ", or null when there are none. It is clamped to two lines on the page and whole in the row's tooltip. The CI line is not in it: the card draws that apart (`ciLineOf`). PURE. */
export function noteOf(entry: RunEntry, context: NoteContext): string | null {
  const lines = linesOf(entry, context);
  return lines.length === 0 ? null : lines.join(NOTE_JOIN);
}
