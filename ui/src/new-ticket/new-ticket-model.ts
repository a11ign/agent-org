// module: the New ticket dialog's rules -- the form it holds, the options its Manual fields offer, the writer pill, and the words of a refusal and of a request's rows. PURE.
import { PRIORITY_NAMES } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { goalNames, projectNames, safeHref, WRITER_PRIORITY_LABEL, writerBody, writerChoiceLabel, type WriterFormValues, type WriterRunView, type WriterTicketView } from "../../../src/ticket-mode/board-view.ts";
import type { Placement } from "../../../src/ticket-mode/writer-placement.ts";
import type { ConfigView, TicketView } from "../api/types.ts";

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
}>;

/** A fresh form: no request, Quick, Auto, and every Manual choice not set. */
export const EMPTY_FORM: NewTicketForm = { request: "", mode: "quick", placement: "auto", project: "", repo: "", goal: "", priority: "", parent: "" };

/** The five choices Manual placement sets. */
export const PLACEMENT_FIELDS = ["project", "repo", "goal", "priority", "parent"] as const;

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

/** The body `POST /api/writer` is sent: `writerBody` of the form, which sends no choices under Auto and only the ones made under Manual. */
export function bodyOf(form: NewTicketForm): Record<string, string> {
  const values: WriterFormValues = form;
  return writerBody(values);
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

/** A made ticket's meta on the Done row, "Medium · a11ign": the parts the tracker gave, and nothing for a ticket the board could not read back. */
export function ticketMetaOf(ticket: Pick<WriterTicketView, "priority" | "project">): string {
  const priority = ticket.priority === undefined ? null : (PRIORITY_NAMES[ticket.priority] ?? null);
  return [priority, ticket.project ?? null].filter((part): part is string => part !== null && part !== "").join(" · ");
}

/** The address of a made ticket in the tracker, or "" when the board has none or it is not an http address. */
export const ticketHrefOf = (ticket: Pick<WriterTicketView, "url">): string => safeHref(ticket.url);
