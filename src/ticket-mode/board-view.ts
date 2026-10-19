// @ts-check
// module: the ticket board page's logic -- which tickets show, how they group, what can be selected, what status a run has -- as pure functions
//
// WRITTEN HERE, IN TYPESCRIPT, SO ITS TESTS RUN IT, AND SENT TO THE BROWSER WITH THE TYPES STRIPPED (`server.ts` serves it as `/board-view.js`
// through Node's own `stripTypeScriptTypes`). The page (`ui.html`) only draws what these functions return and wires the clicks. So it imports
// nothing and uses no Node API: it must run as it is in a browser.
//
// A RULE THE PAGE AND THE POOL BOTH APPLY IS DEFINED HERE ONCE. Which outcomes hand a ticket back (`HANDED_BACK`) and what a parked run is
// (`isParked`) decide what the board shows and what the pool does, so `queue.ts` and `pool.ts` import them from here rather than restating them.

/** The fields of a ticket the board shows. */
import type { ViewEntry, ViewTicket } from "./board-view/view-ticket.ts";

/**
 * The model and effort a run uses, as its row names them: a ticket still to be planned names its planning run's too, and one worked from a
 * planning run's plan says so, since nobody agreed that plan.
 */
export function runChoiceLabel(entry: ViewEntry): string {
  const run = `${entry.model}/${entry.effort}`;
  if (entry.plan) return `plan on ${entry.plan.model}/${entry.plan.effort}, then ${run}`;
  return entry.planned ? `${run} on an unattended plan` : run;
}

/** `url` when it is an http or https address, and "" otherwise, so a link a remote board sends can never run script in this page. */
export const safeHref = (url: unknown): string => (typeof url === "string" && /^https?:\/\//i.test(url) ? url : "");

/** An instance the header's switcher offers: its connection's name, and how it is reached. */
export type ViewConnection = Readonly<{ name: string; kind: "local" | "ssh" | "https" }>;

/** The connection to show: the one this browser remembers while it is still listed, this machine's otherwise, then the first, and null with none. */
export function chosenConnection(connections: readonly ViewConnection[], remembered: string | null): ViewConnection | null {
  return connections.find((c) => c.name === remembered) ?? connections.find((c) => c.kind === "local") ?? connections[0] ?? null;
}

/** Where a connection's API is: under `/c/<connection>`, which the page's service passes on to that instance. */
export const apiBase = (connection: ViewConnection | null): string => (connection === null ? "" : `/c/${encodeURIComponent(connection.name)}`);

/**
 * Where a run's "Open terminal" goes: the page's service's worker link for `connection`, which pairs a paired browser's terminal on the way and
 * then goes to `link` (A11-93). `link` is the plain address, which the link's title keeps.
 */
export const terminalOpenHref = (connection: ViewConnection, link: string): string => `${apiBase(connection)}/terminal?link=${encodeURIComponent(link)}`;

/** What the switcher calls a connection. */
export const connectionLabel = (connection: ViewConnection): string => (connection.kind === "local" ? `${connection.name} (this machine)` : connection.name);

/*
 * NEW TICKETS (A11-94). The page draws a request's form, its runs and each draft as these return them. Nothing here creates a ticket: the approve
 * button posts a draft's fields, and the board creates the ticket on the person's approval.
 */

/** A new-ticket request's runs, as the board words each status. */
export const WRITER_STATUS_LABEL: Readonly<Record<string, string>> = Object.freeze({
  queued: "Queued", writing: "Writing", "needs-you": "Needs you", "to-review": "Ready to review", done: "Done", failed: "Failed",
});

/** A draft's priority, as the page names it. */
export const WRITER_PRIORITY_LABEL: Readonly<Record<string, string>> = Object.freeze({ urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No priority" });

/** The request form's values, as the page holds them: text, the chosen mode, and the optional choices, empty when none. */
export type WriterFormValues = Readonly<{ request: string; mode: string; project?: string; repo?: string; goal?: string; priority?: string; parent?: string }>;

/**
 * Whether the form can be sent, and what it says when it cannot: a request is needed, and grill needs a terminal the machine names. PURE.
 */
export function writerStart(form: Pick<WriterFormValues, "request" | "mode">, { grill }: { grill: boolean; }): Readonly<{ enabled: boolean; reason: string | null }> {
  if (form.request.trim() === "") return { enabled: false, reason: "Write what the ticket is for, in plain words" };
  if (form.mode === "grill" && !grill) return { enabled: false, reason: "Grill needs a terminal: name tickets.terminal in the host file" };
  return { enabled: true, reason: null };
}

/** The request body the form sends: its text trimmed, and each choice the person made, with the empty ones left out. PURE. */
export function writerBody(form: WriterFormValues): Record<string, string> {
  const body: Record<string, string> = { request: form.request.trim(), mode: form.mode };
  for (const name of ["project", "repo", "goal", "priority", "parent"] as const) {
    const value = (form[name] ?? "").trim();
    if (value !== "") body[name] = value;
  }
  return body;
}

/** The goals the New ticket form offers: the labels of the `Goal` group the listed tickets carry, once each, by name. PURE. */
export function goalNames(tickets: readonly (ViewTicket & Readonly<{ labels?: readonly Readonly<{ name: string; group: string | null }>[] }>)[]): string[] {
  return [...new Set(tickets.flatMap((t) => (t.labels ?? []).filter(({ group }) => group === "Goal").map(({ name }) => name)))].sort();
}

/** The projects the New ticket form offers: those the listed tickets are in, once each, by name. PURE. */
export function projectNames(tickets: readonly ViewTicket[]): string[] {
  return [...new Set(tickets.flatMap((t) => (t.project ? [t.project] : [])))].sort();
}

/** The controls a new-ticket run shows: Stop while it is not finished, Dismiss once it is, and Open terminal while its agent is working. PURE. */
export function writerRunActions(run: Pick<WriterRunView, "phase" | "workspace" | "drafts">): Readonly<{ stop: boolean; dismiss: boolean; terminal: boolean }> {
  const finished = run.phase === "finished";
  const creating = run.drafts.some(({ status }) => status === "creating");
  return {
    stop: !finished,
    dismiss: finished && !creating,
    terminal: run.workspace !== undefined && (run.phase === "running" || run.phase === "waiting"),
  };
}

/** The model and effort a new-ticket run ran on, as its card names them, or "" for a run queued before the choice was stamped on it. PURE. */
export function writerChoiceLabel(run: Pick<WriterRunView, "model" | "effort">): string {
  return run.model === undefined || run.effort === undefined ? "" : `${run.model}/${run.effort}`;
}

/** A draft's own controls: Approve and Approve and queue once it may be created, and Discard while it is pending. PURE. */
export function draftControls(draft: Pick<DraftView, "status" | "duplicates">, { acknowledged }: { acknowledged: boolean; }): Readonly<{ approve: boolean; queue: boolean; discard: boolean; reason: string | null }> {
  if (draft.status !== "pending") return { approve: false, queue: false, discard: false, reason: null };
  const named = draft.duplicates.length > 0 && !acknowledged;
  return {
    approve: !named,
    queue: !named,
    discard: true,
    reason: named ? "Check the duplicates above, then tick that they are duplicates, to approve" : null,
  };
}

/** A draft's status, as the review shows it: created with its key, being created, discarded, refused by the tracker with why, or waiting for review. PURE. */
export function draftStatusText(draft: Pick<DraftView, "status" | "created" | "failure">): string {
  if (draft.status === "created") return `Created as ${draft.created?.key ?? "a ticket"}`;
  if (draft.status === "creating") return "Being created";
  if (draft.status === "discarded") return "Discarded";
  return draft.failure === undefined ? "Waiting for your review" : `Not created: ${draft.failure}`;
}

/** The duplicates a draft names, as the review links them above its buttons: a title and address, or "not found in the tracker". PURE. */
export function duplicateLines(draft: Pick<DraftView, "duplicates">): Readonly<{ key: string; why: string; url: string | null; text: string }>[] {
  return draft.duplicates.map(({ key, why, title, url }) => ({ key, why, url, text: title === null ? `${key}: not found in the tracker` : `${key} ${title}` }));
}

/** A draft's fields as the review's form holds them: text for each input, the done-when items one to a line, and the lists comma-separated. PURE. */
export function draftForm(draft: DraftFields): Readonly<Record<keyof DraftFields, string>> {
  return {
    title: draft.title, why: draft.why, doneWhen: draft.doneWhen.join("\n"), notes: draft.notes ?? "", team: draft.team ?? "", project: draft.project ?? "",
    repo: draft.repo ?? "", goal: draft.goal ?? "", labels: draft.labels.join(", "), priority: draft.priority, parent: draft.parent ?? "",
    blocks: draft.blocks.join(", "), blockedBy: draft.blockedBy.join(", "),
  };
}

/** The draft the review's form sends back: each input read as the draft format reads it, with the empty ones left out. PURE. */
export function draftFields(form: Readonly<Record<keyof DraftFields, string>>): Record<string, unknown> {
  const text = (value: string) => value.trim();
  const list = (value: string) => value.split(",").map(text).filter((item) => item !== "");
  const fields: Record<string, unknown> = {
    title: text(form.title), why: text(form.why), doneWhen: form.doneWhen.split("\n").map(text).filter((item) => item !== ""),
    labels: list(form.labels), priority: form.priority, blocks: list(form.blocks), blockedBy: list(form.blockedBy),
  };
  for (const name of ["notes", "team", "project", "repo", "goal", "parent"] as const) if (text(form[name]) !== "") fields[name] = text(form[name]);
  return fields;
}

/** A draft as the board holds it, with the fields the review shows. Duplicates and the status are read, not edited. */
export type DraftFields = Readonly<{
  title: string; why: string; doneWhen: readonly string[]; notes: string | null; team: string | null; project: string | null; repo: string | null; goal: string | null;
  labels: readonly string[]; priority: string; parent: string | null; blocks: readonly string[]; blockedBy: readonly string[];
}>;

/** A draft's view on the board: its fields, its duplicates as read, and its status. */
export type DraftView = Readonly<{
  id: string; file: string; draft: DraftFields & Readonly<{ duplicates: readonly Readonly<{ key: string; why: string; title: string | null; url: string | null }>[] }>;
  duplicates: readonly Readonly<{ key: string; why: string; title: string | null; url: string | null }>[];
  status: "pending" | "creating" | "created" | "discarded";
  created?: Readonly<{ key: string; url: string }>; failure?: string; warnings?: readonly string[];
}>;

/** A new-ticket run's view on the board: its request, its phase, its drafts and what was refused. */
export type WriterRunView = Readonly<{
  id: string; request: string; mode: "quick" | "grill"; phase: string; status: string; form: Readonly<Record<string, string>>; model?: string; effort?: string;
  workspace?: string; question?: string; failure?: string; drafts: readonly DraftView[]; rejected: readonly Readonly<{ file: string; reason: string }>[];
}>;
