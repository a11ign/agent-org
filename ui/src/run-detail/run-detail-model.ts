// module: what the Run detail page says of one run -- which board it is, the callout, the steps, the pull requests, the properties and the header buttons -- as pure functions of the queue the shell reads
//
// EVERY WORD ABOUT A RUN IS board-view's. The status, the verbs, the reason, the prompt, the wait, the working note and the completed line come from `src/ticket-mode/board-view/*.ts`, as `ui.html` and the Runs page use them; this
// file only arranges what they return. The twelve boards are one template switched by `state`, so `boardOf` picks the state a run is drawn as, and the sections read the run.
import { reviewLinesOf, safeHref, terminalOpenHref } from "../../../src/ticket-mode/board-view.ts";
import { promptNote, reasonOf } from "../../../src/ticket-mode/board-view/run-reason.ts";
import { publishTerminalLink, repoLabel, shownStatus, terminalLink, waitNote, workingNote } from "../../../src/ticket-mode/board-view/pull-status-and-notes.ts";
import { openPulls, pullsOf, type RunStatus } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { pullLabel } from "../../../src/ticket-mode/board-view/pull-label.ts";
import { clockOf, versionLine } from "../../../src/ticket-mode/board-view/update-banner.ts";
import { diffLines, learnsFrom, ticketChangeOf, type DiffLine } from "../../../src/ticket-mode/board-view/ticket-change.ts";
import type { PlannedStep, QueueEntryView, QueueView, RunAction, RunDetailEntry, ViewConnection } from "../api/types.ts";
import { PUBLISH_MERGE_NOTE, PUBLISHED_MERGE_NOTE, PUBLISHING_MERGE_NOTE } from "../runs/publish-model.ts";
import { actionsOf, type RowAction } from "../runs/run-actions.ts";
import { labelOf, noteLines, since, timingOf, tokensOf, type NoteContext, type RunEntry } from "../runs/runs-model.ts";

// ---- Which board a run is drawn as ----

/** The twelve states of the boards that draw a run; loading and run gone are the page's own. */
export type RunBoard = "running" | "needs" | "handback" | "ready" | "publishing" | "published" | "done" | "failed" | "cancelled" | "queued" | "blocked" | "awaiting";

/**
 * The board of each status. A status with no board of its own takes the closest one: Talking, Planning and Reviewing the running board, Checked the Done board. Publishing and Published have the boards
 * the Publish tickets drew (A11-218). Needs you is two boards, told apart by `boardOf`.
 */
const BOARD_OF_STATUS: Readonly<Record<RunStatus, RunBoard | "needs-you">> = {
  "needs-you": "needs-you", talking: "running", working: "running", planning: "running", reviewing: "running", blocked: "blocked", queued: "queued",
  "awaiting-review": "awaiting", "ready-to-merge": "ready", publishing: "publishing", published: "published", checked: "done", completed: "done", failed: "failed", cancelled: "cancelled",
};

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
  running: "Working", needs: "Needs you", handback: "Needs you", ready: "Approved. Waiting for you to merge.", publishing: "Publishing", published: "Published", done: "Completed", failed: "Failed", cancelled: "Cancelled",
  queued: "Queued", blocked: "Blocked", awaiting: "Draft pull request. Waiting for you to approve.",
};

const HELP: Readonly<Partial<Record<RunBoard, string>>> = {
  needs: "The agent is waiting on a dialog in its session. Talk to it opens that session in herdr.",
  handback: "Talk to it opens this run's own session in herdr, with everything it knew.",
};

/** The sentence beside the Ready board's button on a machine with no publisher. */
export const MERGE_NOTE = "A person merges. Nothing is published from here.";

/** What the callout of a run says: the board's title, the backend's strings as paragraphs, and the board's help line where it has one. */
export type Callout = Readonly<{ title: string; paragraphs: readonly string[]; help: string | null }>;

const present = (text: string | null | undefined): text is string => text !== null && text !== undefined && text !== "";

/** The review line of each open pull request the pool has read, `a11ign/lab #150: approved at 1f6009d`, as the Ready board's body says it. */
const reviewText = (entry: RunEntry, queue: QueueView): string | null => {
  const lines = reviewLinesOf(entry, queue.pulls ?? {});
  return lines.length === 0 ? null : lines.join("; ");
};

/** The run's pull requests as the boards name them, `a11ign/lab #150`, its open ones else all of them, joined with ", "; empty when it has none. */
const pullNames = (entry: RunEntry): string => (openPulls(entry).length > 0 ? openPulls(entry) : pullsOf(entry)).map(({ url }) => pullLabel(url)).join(", ");

/** What the Publishing board says: the publish run is posting these pull requests, and merges none. */
const publishingBody = (entry: RunEntry): string => `A publish run is posting ${pullNames(entry) || "this run's pull requests"}. Nothing is merged: a person still merges.`;

/** What the Published board says: what was posted and, when the backend recorded it, when. The channel is not named: the backend holds none. */
function publishedBody(entry: RunEntry): string {
  const at = entry.published?.at;
  return `Posted ${pullNames(entry) || "this run's pull requests"}${at === undefined ? "" : ` at ${clockOf(at)}`}. Nothing was merged: a person still merges.`;
}

/** The first paragraph of the callout, which is the backend's string for the board: null draws none. */
function bodyOf(entry: RunEntry, queue: QueueView, board: RunBoard): string | null {
  const { line } = reasonOf(entry);
  switch (board) {
    case "running": return workingNote(entry)?.text ?? line;
    case "needs": return promptNote(entry) ?? line;
    case "queued":
    case "blocked": return waitNote(entry, queue.entries) ?? line;
    case "ready": return line ?? reviewText(entry, queue);
    case "publishing": return publishingBody(entry);
    case "published": return publishedBody(entry);
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

/** The row beneath the callout's words on the Ready, Publishing and Published boards: the publish run's terminal while it posts, the pull request a person merges, the posted message, and what the board says of merging. */
export type MergeRow = Readonly<{ terminalHref: string | null; open: Readonly<{ href: string; label: string }> | null; messageHref: string | null; note: string }>;

/** What the page knows of the machine that decides the merge row: whether it has a publisher, the terminal it names and the instance the links open on. */
export type MergeMachine = Readonly<{ publishes: boolean; terminal: string | null; connection: ViewConnection | null }>;

/** The address of the publish run's session, opened through the instance's connection, or null: the run is not being published, the publish run has no pane yet, the machine names no terminal, or the address is not safe to link. */
function publishTerminalHref(entry: RunEntry, queue: QueueView, { terminal, connection }: MergeMachine): string | null {
  const link = publishTerminalLink(terminal, entry, queue.publish);
  return link === null || connection === null || safeHref(link) === "" ? null : terminalOpenHref(connection, link);
}

/**
 * The merge row of a board, or null for a board that has none. On the Ready board a machine with a publisher says what Publish does, and any other says nothing is published from here; the Publishing and Published
 * boards follow the run's status, so they say the same on every machine. PURE.
 */
export function mergeRowOf(entry: RunEntry, queue: QueueView, machine: MergeMachine): MergeRow | null {
  const open = readyPullOf(entry);
  switch (boardOf(entry, queue)) {
    case "ready": return { terminalHref: null, open, messageHref: null, note: machine.publishes ? PUBLISH_MERGE_NOTE : MERGE_NOTE };
    case "publishing": return { terminalHref: publishTerminalHref(entry, queue, machine), open, messageHref: null, note: PUBLISHING_MERGE_NOTE };
    case "published": return { terminalHref: null, open, messageHref: safeHref(entry.published?.link ?? "") || null, note: PUBLISHED_MERGE_NOTE };
    default: return null;
  }
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
  running: "tone-warn", needs: "tone-warn", handback: "tone-warn", ready: "tone-done", publishing: "tone-warn", published: "tone-published", done: "tone-done", failed: "tone-danger", cancelled: "tone-muted", queued: "tone-quiet", blocked: "tone-quiet", awaiting: "tone-planning",
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

/**
 * The run the page draws: the queue's entry, which the shell reads every 5 s and which is the newest word on everything it holds, with the steps the run's own read adds (A11-270). Until that read answers, or when it
 * does not (the run is not on the queue it read, or the instance is unreachable), the entry alone: the steps appear in place when it does. PURE.
 */
export const detailOf = (entry: RunEntry, full: QueueEntryView | null): RunDetailEntry =>
  full === null ? entry : { ...entry, ...(full.entry.plannedSteps === undefined ? {} : { plannedSteps: full.entry.plannedSteps }), ...(full.entry.currentStep === undefined ? {} : { currentStep: full.entry.currentStep }) };

/** How far a run has got: the last step it has passed, and the step it is working on now, if any. */
type Progress = Readonly<{ passed: number; working: number | undefined }>;

/**
 * While a run is being worked the step its worker says it is on is the board's spinner and the ones before it are passed. A run that has finished is working on none, so the steps it reached, the one it ended on
 * among them, have the Completed check and the rest the ring. The board has no third mark, so this is the smallest reading and can be overturned without touching anything else.
 */
function progressOf(entry: Pick<RunDetailEntry, "phase" | "currentStep">): Progress {
  const current = entry.currentStep;
  if (current === undefined) return { passed: 0, working: undefined };
  return entry.phase === "finished" ? { passed: current, working: undefined } : { passed: current - 1, working: current };
}

const markOf = (n: number, { passed, working }: Progress): StepMark => {
  if (n === working) return "now";
  return n <= passed ? "done" : "next";
};

/** The rows of "What it will do": each planned step the run kept, finished or not, marked by the step its worker says it is on; none for a run that recorded no steps. PURE. */
export function stepsOf(entry: RunDetailEntry): StepRow[] {
  const steps: readonly PlannedStep[] = entry.plannedSteps ?? [];
  const progress = progressOf(entry);
  return steps.map(({ n, title }) => ({ n, text: title, mark: markOf(n, progress) }));
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

// ---- What the callout leaves out: the disclosures ----

/** The ticket text a run's planner or live worker was told changed: the board's line and the description as a line diff. */
export type TicketChange = Readonly<{ summary: string; heading: string; lines: readonly DiffLine[] }>;

/** The worker's proposed edit to its ticket: why, then the text the ticket has now beside the title and description it would have. */
export type Proposal = Readonly<{ summary: string; now: string; proposed: string }>;

/** What a run says beside its callout, each only when it has something to say. */
export type Disclosures = Readonly<{
  changed: TicketChange | null;
  learns: readonly Readonly<{ text: string; url: string }>[];
  proposal: Proposal | null;
  /** Every line the Runs row clamps to two, whole: the full text of the row's note. */
  noted: readonly string[];
}>;

/** The text of a title and a description as `ui.html` shows a ticket's text: the title, a blank line, the description. */
const ticketText = (title: string, description: string): string => `${title}\n\n${description}`;

function proposalOf(entry: RunEntry): Proposal | null {
  const outcome = entry.outcome;
  const edit = outcome !== undefined && "edit" in outcome ? outcome.edit : undefined;
  if (edit === undefined) return null;
  const now = edit.base ?? { title: "", description: "" };
  return { summary: `Proposed edit to the ticket: ${edit.why}`, now: ticketText(now.title, now.description), proposed: ticketText(edit.title ?? now.title, edit.description ?? now.description) };
}

function changeOf(entry: RunEntry): TicketChange | null {
  const change = ticketChangeOf(entry);
  if (change === null) return null;
  return { summary: change.line, heading: `What changed in ${entry.ticket.key}`, lines: diffLines(change.change.from, change.change.to) };
}

/**
 * What `ui.html` shows of a run beyond the callout: what changed in its ticket's text, the pull requests its planner learns from, the proposed edit's text, and every line of its note. The
 * Runs page clamps the note to two lines with the whole only in a tooltip, so the full text is here, where a keyboard and a screen reader reach it. PURE.
 */
export const disclosuresOf = (entry: RunEntry, context: NoteContext): Disclosures => ({
  changed: changeOf(entry), learns: learnsFrom(entry), proposal: proposalOf(entry), noted: noteLines(entry, context),
});
