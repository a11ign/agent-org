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
import { openPulls, pullsOf, type ViewEntry, type ViewTicket } from "./board-view/view-ticket.ts";

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
 * NEW TICKETS (A11-94, A11-124). The page draws a request's form and its runs as these return them. Nothing here creates a ticket: a request is sent,
 * and the run files its own tickets. The page shows each ticket the run made, as a link.
 */

/** A new-ticket request's runs, as the board words each status. */
export const WRITER_STATUS_LABEL: Readonly<Record<string, string>> = Object.freeze({ queued: "Queued", writing: "Writing", waiting: "Waiting for you", done: "Done", failed: "Failed" });

/** A priority, as the New ticket form names it. */
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

/** The controls a new-ticket run shows: Stop while it is under way, Dismiss once it is finished, and Open terminal while its agent is working. PURE. */
export function writerRunActions(run: Pick<WriterRunView, "phase" | "workspace">): Readonly<{ stop: boolean; dismiss: boolean; terminal: boolean }> {
  const finished = run.phase === "finished";
  return { stop: !finished, dismiss: finished, terminal: run.workspace !== undefined && run.phase === "running" };
}

/** The model and effort a new-ticket run ran on, as its card names them, or "" for a run queued before the choice was stamped on it. PURE. */
export function writerChoiceLabel(run: Pick<WriterRunView, "model" | "effort">): string {
  return run.model === undefined || run.effort === undefined ? "" : `${run.model}/${run.effort}`;
}

/** A ticket a new-ticket run made, as the board shows it: its key, its address when the tracker has it, and whether Pick lists it. */
export type WriterTicketView = Readonly<{ key: string; url: string | null; inPick: boolean | null }>;

/** A new-ticket run's view on the board: its request, its phase, and the tickets it made. */
export type WriterRunView = Readonly<{
  id: string; request: string; mode: "quick" | "grill"; phase: string; status: string; form: Readonly<Record<string, string>>; model?: string; effort?: string;
  workspace?: string; pane?: string; failure?: string; tickets: readonly WriterTicketView[];
}>;

/** A pull request's address as the board names it: `owner/repo #number`, read off its url (A11-119). */
export function pullLabel(url: string): string {
  return url.replace("https://github.com/", "").replace("/pull/", " #");
}

/**
 * The review line of each open pull request of a run that the pool has read (A11-119): `owner/repo #n: <its review state>`. A pull request the pool has not
 * read shows none. `reviews` is the queue's `pulls`, a url to the words its review state reads as (`pullReviewText`).
 */
export function reviewLinesOf(entry: ViewEntry, reviews: Readonly<Record<string, string>>): string[] {
  return openPulls(entry).filter(({ url }) => reviews[url] !== undefined).map(({ url }) => `${pullLabel(url)}: ${reviews[url]}`);
}

/**
 * The open pull requests the pool has read that no run lists (A11-119): what the runs tab's "Pull requests" section shows for a person's pull request with
 * no run. Each is its label, its url and its review line. Empty when every one the pool has read belongs to a run.
 */
export function unlistedPulls(entries: readonly ViewEntry[], reviews: Readonly<Record<string, string>>): { url: string; label: string; text: string }[] {
  const listed = new Set(entries.flatMap((entry) => pullsOf(entry).map(({ url }) => url)));
  return Object.entries(reviews).filter(([url]) => !listed.has(url)).map(([url, text]) => ({ url, label: pullLabel(url), text }));
}
