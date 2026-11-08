// module: the New ticket dialog's rules -- the form it holds, the options its Manual fields offer, the writer pill, and the words of a refusal and of a request's rows. PURE.
import { goalNames, projectNames, safeHref, WRITER_PRIORITY_LABEL, writerBody, writerChoiceLabel, type WriterRunView, type WriterTicketView } from "../../../src/ticket-mode/board-view.ts";
import type { Placement } from "../../../src/ticket-mode/writer-placement.ts";
import type { ConfigView, QueueView, TicketView, WritersView } from "../api/types.ts";

/** The form as the dialog holds it. A Manual choice left on "Not set" is "", which sends nothing, so the writer chooses it. */
export type NewTicketForm = Readonly<{
  request: string;
  mode: "quick" | "grill";
  placement: Placement;
  project: string;
  repo: string;
  goal: string;
  priority: string;
  parent: string;
  /** What happens to the tickets once the writer has filed them (A11-420): they wait in the backlog, or the board queues them. */
  after: AfterWriting;
}>;

/** The "After writing" choice (A11-420). */
export type AfterWriting = "backlog" | "queue";

/** A fresh form: no request, Quick, Auto, every Manual choice not set, and the tickets kept in the backlog. */
export const EMPTY_FORM: NewTicketForm = { request: "", mode: "quick", placement: "auto", project: "", repo: "", goal: "", priority: "", parent: "", after: "backlog" };

export type Option = Readonly<{ value: string; label: string }>;

/** What the Manual selects offer besides "Not set". */
export type ManualOptions = Readonly<{ projects: readonly string[]; repos: readonly string[]; goals: readonly string[]; priorities: readonly Option[] }>;

/** The words under the Grill card: what it does, or why it cannot be chosen on this machine. */
export const GRILL_TEXT = "Opens a terminal where the writer asks you questions first.";
export const GRILL_NEEDS_TERMINAL = "Needs a terminal: name tickets.terminal in the host file.";

/** The priorities an instance that does not say which it offers is taken to offer, as `ui.html` takes them. */
const DEFAULT_PRIORITIES: readonly string[] = Object.keys(WRITER_PRIORITY_LABEL);

/** The options of the Manual fields: the projects and goals the tickets read carry, the repositories the host names, and the priorities the instance offers (an older instance names no repositories or priorities). */
export function manualOptionsOf(config: Partial<Pick<ConfigView, "repos" | "priorities">>, tickets: readonly TicketView[]): ManualOptions {
  return {
    projects: projectNames(tickets),
    repos: config.repos ?? [],
    goals: goalNames(tickets),
    priorities: (config.priorities ?? DEFAULT_PRIORITIES).map((value) => ({ value, label: WRITER_PRIORITY_LABEL[value] ?? value })),
  };
}

/** The writer pill's words: the model and effort the next request is stamped with (the Settings choice, else the host file's), where to change them, and how it is named to a screen reader. */
export function writerPillOf(config: ConfigView): Readonly<{ model: string; effort: string; title: string; label: string }> {
  const model = config.choice.writerModel || (config.writerDefault?.model ?? "");
  const effort = config.choice.writerEffort || (config.writerDefault?.effort ?? "");
  return { model, effort, title: "Ticket writer model and effort. Change in Settings", label: `Ticket writer: ${model}, ${effort} effort. Change in Settings` };
}

/**
 * The words under "After writing" (A11-420): where the tickets wait, and, when they are queued while the queue is paused, that they wait there until it is resumed.
 */
export function afterTextOf(after: AfterWriting, queue: Pick<QueueView, "paused"> | null): string {
  if (after === "backlog") return "The tickets wait in the backlog until you queue them.";
  const waits = queue?.paused === true ? ", and waits there until the queue is resumed" : "";
  return `Each ticket the writer files is added to the queue once the writer has finished${waits}. They run on the queue defaults, shown below.`;
}

/** A queue choice as the boards write it (A11-420): "sonnet · high · plan first", the plan part only when its tickets are planned first. */
export function queueChoiceLabel({ model, effort, plan }: Readonly<{ model: string; effort: string; plan: boolean }>): string {
  return [model, effort, ...(plan ? ["plan first"] : [])].join(" · ");
}

/**
 * The Queue pill's words (A11-420): the queue defaults a request that queues its tickets is stamped with (the saved choice's model and effort), "plan first" only when the board
 * plans, where to change them, and how it is named to a screen reader.
 */
export function queuePillOf({ choice, planner }: Pick<ConfigView, "choice" | "planner">): Readonly<{ choice: string; title: string; label: string }> {
  const words = [choice.model, `${choice.effort} effort`, ...(planner ? ["plan first"] : [])].join(", ");
  return { choice: queueChoiceLabel({ ...choice, plan: planner }), title: "Model and effort the queued tickets run on. Change in Settings", label: `Queue: ${words}. Change in Settings` };
}

/**
 * The body `POST /api/writer` is sent: `writerBody` of the form, which sends no choices under Auto and only the ones made under Manual, and `after` when the tickets are to be queued
 * (A11-420). It names no model, effort or plan: the server stamps the saved queue defaults.
 */
export function bodyOf(form: NewTicketForm): Record<string, string> {
  const body = writerBody(form);
  return form.after === "queue" ? { ...body, after: "queue" } : body;
}

/** The server's sentence with a full stop, added only when it lacks one, as the refused board ends its sentence before "Your request is still here.". */
export function sentenceEnding(sentence: string): string {
  const trimmed = sentence.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** A request's head line, "Ticket writer · sonnet/high · Quick": the model part is left out for a run queued before the choice was stamped on it. */
export function headLineOf(run: Pick<WriterRunView, "model" | "effort" | "mode">): string {
  const choice = writerChoiceLabel(run);
  return ["Ticket writer", ...(choice === "" ? [] : [choice]), run.mode === "grill" ? "Grill" : "Quick"].join(" · ");
}

/**
 * What an unfinished request's card adds to its head line when it will queue its tickets (A11-420), as the boards write it: "Queues them when done (sonnet/high, plan first)", the
 * plan part only on a board that plans. "" for a request that keeps them in the backlog.
 */
export function queuesWhenDoneOf(run: Pick<WritersView["runs"][number], "queueAfter">, config: Pick<ConfigView, "planner"> | null): string {
  const after = run.queueAfter;
  if (after === undefined) return "";
  return `Queues them when done (${after.model}/${after.effort}${after.plan && config?.planner === true ? ", plan first" : ""})`;
}

/** The address of a made ticket in the tracker, or "" when the board has none or it is not an http address. */
export const ticketHrefOf = (ticket: Pick<WriterTicketView, "url">): string => safeHref(ticket.url);
