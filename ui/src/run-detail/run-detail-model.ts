// module: what the Run detail page says of one run -- which board it is, the callout, the steps, the pull requests, the properties and the header buttons -- as pure functions of the queue the shell reads
//
// EVERY WORD ABOUT A RUN IS board-view's. The status, the verbs, the reason, the prompt, the wait, the working note and the completed line come from `src/ticket-mode/board-view/*.ts`, as `ui.html` and the Runs page use them; this
// file only arranges what they return. The twelve boards are one template switched by `state`, so `boardOf` picks the state a run is drawn as, and the sections read the run.
import { reviewLinesOf, safeHref, terminalOpenHref } from "../../../src/ticket-mode/board-view.ts";
import { promptNote, reasonOf } from "../../../src/ticket-mode/board-view/run-reason.ts";
import { repoLabel, shownStatus, terminalLink, waitNote, workingNote } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import { openPulls, pullsOf, type RunStatus } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { pullLabel } from "../../../src/ticket-mode/board-view/pull-label.ts";
import { versionLine } from "../../../src/ticket-mode/board-view/update-banner.ts";
import type { PlannedStep, QueueView, RunAction, ViewConnection } from "../api/types.ts";
import { actionsOf, type RowAction } from "../runs/run-actions.ts";
import { labelOf, since, timingOf, tokensOf, type RunEntry } from "../runs/runs-model.ts";

// ---- Which board a run is drawn as ----

/** The ten states of the boards that draw a run; loading and run gone are the page's own. */
export type RunBoard = "running" | "needs" | "handback" | "ready" | "done" | "failed" | "cancelled" | "queued" | "blocked" | "awaiting";

/**
 * The board of each status. A status with no board of its own takes the closest one: Talking, Planning and Reviewing the running board, Publishing and Published the Ready board, Checked the Done board.
 * Needs you is two boards, told apart by `boardOf`.
 */
const BOARD_OF_STATUS: Readonly<Record<RunStatus, RunBoard | "needs-you">> = {
  "needs-you": "needs-you", talking: "running", working: "running", planning: "running", reviewing: "running", blocked: "blocked", queued: "queued",
  "awaiting-review": "awaiting", "ready-to-merge": "ready", publishing: "ready", published: "ready", checked: "done", completed: "done", failed: "failed", cancelled: "cancelled",
};

/** Whether a run is still being worked: it is starting or running, so a Needs you run that is waiting on a dialog is live and a hand-back is not. */
export const isLiveRun = (entry: Pick<RunEntry, "phase">): boolean => entry.phase === "starting" || entry.phase === "running";

/** The board a status is drawn as, and for Needs you the Needs board while the run is live and Handed back once it has finished. PURE. */
export function boardOfStatus(status: RunStatus, phase: string): RunBoard {
  const board = BOARD_OF_STATUS[status];
  if (board !== "needs-you") return board;
  return phase === "finished" ? "handback" : "needs";
}

/** The board a run is drawn as: its shown status's. PURE. */
export const boardOf = (entry: RunEntry, queue: Pick<QueueView, "publish" | "entries">): RunBoard => boardOfStatus(shownStatus(entry, queue.publish, queue.entries), entry.phase);

// ---- The callout ----

/** The title of each board's callout, and the words the Needs and Handed back boards add beneath it. */
const CALLOUT_TITLE: Readonly<Record<RunBoard, string>> = {
  running: "Working", needs: "Needs you", handback: "Needs you", ready: "Approved. Waiting for you to merge.", done: "Completed", failed: "Failed", cancelled: "Cancelled",
  queued: "Queued", blocked: "Blocked", awaiting: "Draft pull request. Waiting for you to approve.",
};

const HELP: Readonly<Partial<Record<RunBoard, string>>> = {
  needs: "The agent is waiting on a dialog in its session. Talk to it opens that session in herdr.",
  handback: "Talk to it opens this run's own session in herdr, with everything it knew.",
};

/** The sentence beside the Ready board's button. */
export const MERGE_NOTE = "A person merges. Nothing is published from here.";

/** What the callout of a run says: the board's title, the backend's strings as paragraphs, and the board's help line where it has one. */
export type Callout = Readonly<{ title: string; paragraphs: readonly string[]; help: string | null }>;

const present = (text: string | null | undefined): text is string => text !== null && text !== undefined && text !== "";

/** The review line of each open pull request the pool has read, `a11ign/lab #150: approved at 1f6009d`, as the Ready board's body says it. */
const reviewText = (entry: RunEntry, queue: QueueView): string | null => {
  const lines = reviewLinesOf(entry, queue.pulls ?? {});
  return lines.length === 0 ? null : lines.join("; ");
};

/** The first paragraph of the callout, which is the backend's string for the board: null draws none. */
function bodyOf(entry: RunEntry, queue: QueueView, board: RunBoard): string | null {
  const { line } = reasonOf(entry);
  switch (board) {
    case "running": return workingNote(entry)?.text ?? line;
    case "needs": return promptNote(entry) ?? line;
    case "queued":
    case "blocked": return waitNote(entry, queue.entries) ?? line;
    case "ready": return line ?? reviewText(entry, queue);
    default: return line;
  }
}

/** The callout of a run: the board's title, the backend's own words, and the question the worker asked when it kept one. A string the backend has none of is not drawn. PURE. */
export function calloutOf(entry: RunEntry, queue: QueueView, board: RunBoard): Callout {
  // A running agent that was refused a safety prompt says so beside what it is doing.
  const declined = board === "running" ? promptNote(entry) : null;
  const paragraphs = [...new Set([bodyOf(entry, queue, board), declined, reasonOf(entry).question].filter(present))];
  return { title: CALLOUT_TITLE[board], paragraphs, help: HELP[board] ?? null };
}

/** The pull request the Ready board's button opens: the run's first open one, else its first, with the address safe to link. Null when it has none or its address is not http or https. PURE. */
export function readyPullOf(entry: RunEntry): Readonly<{ href: string; label: string }> | null {
  const [first] = openPulls(entry).length > 0 ? openPulls(entry) : pullsOf(entry);
  if (first === undefined || safeHref(first.url) === "") return null;
  return { href: first.url, label: `Open #${first.url.split("/").pop() ?? ""} on GitHub` };
}

// ---- The header ----

/** The two timing words after the status: "Running 52m" and "Started 52 min ago", or "Not started" and "Queued 2 min ago" for a run still on the queue. PURE. */
export function timesOf(entry: RunEntry, now: number): Readonly<{ timing: string; started: string }> {
  if (entry.phase === "queued" || entry.startedAt === undefined) return { timing: "Not started", started: `Queued ${since(entry.queuedAt ?? now, now)} ago` };
  const { timing, started } = timingOf(entry, now);
  return { timing, started: started ?? "" };
}

/** The colour class of the status word in the header: the boards'. Ready to merge and Completed take the lighter green their callout titles do. */
export const STATUS_WORD_TONE: Readonly<Record<RunBoard, string>> = {
  running: "tone-warn", needs: "tone-warn", handback: "tone-warn", ready: "tone-done", done: "tone-done", failed: "tone-danger", cancelled: "tone-muted", queued: "tone-quiet", blocked: "tone-quiet", awaiting: "tone-planning",
};

/** The status word of the header: the words of the run's shown status. */
export const statusWordOf = (entry: RunEntry, queue: Pick<QueueView, "publish" | "entries">): string => labelOf(shownStatus(entry, queue.publish, queue.entries));

/** The words of each verb on a header button: `ui.html`'s, which are the Runs page's names but for Stop and Dismiss, which the Runs board names for its icons. */
const LABEL_OF: Readonly<Partial<Record<RunAction, string>>> = { stop: "Stop", dismiss: "Dismiss" };

/** How a header button is coloured: Stop in the danger colours, Dismiss muted, every other verb the default ghost. */
export type ButtonTone = "danger" | "muted" | "default";

const TONE_OF: Readonly<Partial<Record<RunAction, ButtonTone>>> = { stop: "danger", dismiss: "muted" };

/** One button of the header. */
export type HeaderAction = Readonly<{ verb: RunAction; label: string; title: string; tone: ButtonTone }>;

/** The header's buttons: exactly the verbs `runActions` returns for the run, in its order, with the board's words and colours and the backend's tooltips. PURE. */
export const headerActionsOf = (entry: RunEntry, queue: QueueView): HeaderAction[] =>
  actionsOf(entry, queue).map(({ verb, name, title }: RowAction) => ({ verb, label: LABEL_OF[verb] ?? name, title, tone: TONE_OF[verb] ?? "default" }));

/** What the board says when the terminal button is the run's one Talk to it. */
export const TERMINAL_TITLE = "Opens this run's session in herdr";

/**
 * Where the run's terminal button goes, or null when it has none: the page's own link to the run's session in herdr, for a run whose actions offer no `talk` verb (a running one), while the machine names a terminal and
 * the run holds a pane. There is one Talk to it per run, so a run that offers the verb has no terminal button. PURE.
 */
export function terminalHrefOf(entry: RunEntry, actions: readonly HeaderAction[], terminal: string | null, connection: ViewConnection | null): string | null {
  if (actions.some(({ verb }) => verb === "talk") || connection === null) return null;
  const link = terminalLink(terminal, entry);
  return link === null || safeHref(link) === "" ? null : terminalOpenHref(connection, link);
}

// ---- The steps ----

/** How a planned step is marked: the one the worker is on, the ones after it, and the ones it has passed. */
export type StepMark = "now" | "next" | "done";

export type StepRow = Readonly<{ n: number; text: string; mark: StepMark }>;

const markOf = (n: number, current: number | undefined): StepMark => {
  if (current === undefined || n > current) return "next";
  return n === current ? "now" : "done";
};

/** The rows of "What it will do": each planned step of a run that is being worked, marked by the step its worker says it is on; none for a run that has finished or has no steps. PURE. */
export function stepsOf(entry: RunEntry): StepRow[] {
  const steps: readonly PlannedStep[] = isLiveRun(entry) ? (entry.plannedSteps ?? []) : [];
  return steps.map(({ n, title }) => ({ n, text: title, mark: markOf(n, entry.currentStep) }));
}

// ---- The pull requests ----

/** The tone of a pull request's state word. */
export type PullTone = "merged" | "approved" | "draft" | "open" | "closed";

export type PullRow = Readonly<{ url: string; href: string; label: string; detail: string; state: string; tone: PullTone }>;

/** How many characters of a commit the board names: `1f6009d`. */
const SHORT_HEAD = 7;

/** The state of one pull request: Merged or Closed as the pool last read it, Approved by a reviewer at its head, Draft for a draft the run opened, else Open. */
function pullState(entry: RunEntry, url: string): Readonly<{ state: string; tone: PullTone; detail: string }> {
  const settled = entry.pullStates?.[url];
  if (settled === "merged") return { state: "Merged", tone: "merged", detail: "" };
  if (settled === "closed") return { state: "Closed", tone: "closed", detail: "" };
  const head = entry.pullHeads?.[url];
  if (head?.review === "approved") return { state: "Approved", tone: "approved", detail: `Approved at ${head.head.slice(0, SHORT_HEAD)}` };
  if (entry.outcome?.kind === "draft-pr") return { state: "Draft", tone: "draft", detail: "Draft" };
  return { state: "Open", tone: "open", detail: "" };
}

/** The rows of "Pull requests": each of the run's pull requests, named as the board names it. PURE. */
export const pullRowsOf = (entry: RunEntry): PullRow[] => pullsOf(entry).map(({ url }) => ({ url, href: safeHref(url), label: pullLabel(url), ...pullState(entry, url) }));

/** The boards on which a run has not opened its pull requests yet, so the empty panel says the worker will. */
const WORKING_BOARDS: ReadonlySet<RunBoard> = new Set(["running", "queued", "blocked"]);

/** What the empty "Pull requests" panel says. */
export const noPullsText = (board: RunBoard): string => (WORKING_BOARDS.has(board) ? "None yet. The worker opens them when its steps finish." : "This run opened no pull requests.");

// ---- The properties ----

/** What the Properties list says of a run; a row with no value (`worker`, `tokens`, `version`) is not drawn. */
export type Properties = Readonly<{ repos: string; model: string; plan: string; worker: string | null; tokens: string | null; version: string | null }>;

/** The plan a run was given: "Unattended plan" for a planned run, "Plan first" for one that plans before it works, else a dash. */
const planOf = (entry: RunEntry): string => (entry.planned ? "Unattended plan" : entry.plan ? "Plan first" : "—");

/** Whether a run holds its copy of agent-org: it is live, or a parked workspace is open. */
const holdsItsVersion = (entry: RunEntry): boolean => entry.phase === "starting" || entry.phase === "running" || entry.workspace !== undefined;

/** The version a run was started on when it is not the instance's, else null. */
const otherVersion = (entry: RunEntry, instance: string | null): string | null => (instance === null || entry.toolVersion === instance ? null : (entry.toolVersion ?? null));

/** A run that holds its copy of agent-org and was started on a version that is not the instance's says which, as `updateLines` decides it. */
function versionOf(entry: RunEntry, queue: QueueView): string | null {
  const instance = queue.update?.version ?? null;
  const own = otherVersion(entry, instance);
  if (own === null || instance === null || !holdsItsVersion(entry)) return null;
  const line = versionLine(own, instance);
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}

/** The worker's instance, and its host when that is not the same word. */
const workerOf = (entry: RunEntry): string | null => {
  if (entry.worker === undefined) return null;
  return entry.worker.host === entry.worker.instance ? entry.worker.instance : `${entry.worker.instance} · ${entry.worker.host}`;
};

/** The Properties of a run. PURE. */
export const propertiesOf = (entry: RunEntry, queue: QueueView): Properties => ({
  repos: repoLabel(entry), model: `${entry.model}/${entry.effort}`, plan: planOf(entry), worker: workerOf(entry), tokens: tokensOf(entry), version: versionOf(entry, queue),
});
