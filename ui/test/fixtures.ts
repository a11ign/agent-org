// module: a stand-in instance for the shell's checks -- the answers `/api/connections` and `/c/<name>/api/...` give, built from a few fields, and a `fetch` that serves them
//
// ONLY THE FIELDS THE SHELL READS ARE FILLED, so the fixtures are cast to the server's types: a field the shell starts to read that is missing here fails its check. Used by the
// component checks (as the client's `fetch`) and by the page checks (answered through Playwright's `page.route`), so both see the same instance.
import type { Fetch } from "../src/api/request.ts";
import type { ConfigView, ConnectionsView, QueueView, TicketView, ViewConnection } from "../src/api/types.ts";

export const HERE: ViewConnection = { name: "here", kind: "local" };
export const PERSONAL: ViewConnection = { name: "personal", kind: "ssh" };
export const WORK: ViewConnection = { name: "work", kind: "https" };

export const VIEWER = { id: "u-me", name: "Me" };
export const OTHER = { id: "u-other", name: "Someone" };

type TicketFields = Readonly<{ key: string; project?: string | null; assignee?: typeof VIEWER | null; goals?: readonly string[] }>;

/** A ticket of the Pick list: its project, who has it, and its Goal labels. */
export function ticket({ key, project = "a11ign", assignee = VIEWER, goals = [] }: TicketFields): TicketView {
  const labels = goals.map((name) => ({ name, group: "Goal" }));
  return { key, title: `Title of ${key}`, description: "", url: "", branch: "", status: "Backlog", statusOrder: 1, team: "A11", project, priority: 0, parent: null, labels, assignee } as TicketView;
}

/** `/api/config`: who the key is, and the Assignee scope the list starts on. */
export const config = (fields: Partial<ConfigView> = {}): ConfigView => ({ viewer: VIEWER, pickDefault: "you", ...fields }) as ConfigView;

/** `/api/queue` holding one run in each of the phases. */
export const queueOf = (...phases: readonly string[]): QueueView => ({ entries: phases.map((phase, index) => ({ ticket: { key: `A11-${index + 1}` }, phase })) }) as unknown as QueueView;

/** What one instance answers. */
export type InstanceAnswers = Readonly<{ config?: ConfigView; tickets?: readonly TicketView[]; queue?: QueueView; queueFails?: Readonly<{ status: number; error: string }>; ticketsFail?: Readonly<{ status: number; error: string }>; configFail?: Readonly<{ status: number; error: string }> }>;

export type Stand = Readonly<{ connections?: readonly ViewConnection[]; refusal?: string | null; connectionsFail?: boolean; instances?: Readonly<Record<string, InstanceAnswers>>; fallback?: InstanceAnswers }>;
// `fallback` answers for any instance `instances` does not name, and for the root `/api/...` of a page with no connections.

const json = (body: unknown, status = 200): { status: number; body: string } => ({ status, body: JSON.stringify(body) });

/** The answer to one request path (`/api/...` or `/c/<name>/api/...`), as a status and a JSON body, or null for a path no instance has. */
export function answerFor(stand: Stand, path: string): { status: number; body: string } | null {
  if (path === "/api/connections") {
    if (stand.connectionsFail) return json({ error: "no" }, 500);
    const view: ConnectionsView = { connections: [...(stand.connections ?? [HERE])], refusal: stand.refusal ?? null };
    return json(view);
  }
  const [, name, route] = /^\/c\/([^/]+)(\/api\/[^?]+)/.exec(path) ?? [undefined, undefined, /^(\/api\/[^?]+)/.exec(path)?.[1]];
  const answers = (name === undefined ? undefined : stand.instances?.[decodeURIComponent(name)]) ?? stand.fallback ?? {};
  switch (route) {
    case "/api/config":
      return answers.configFail === undefined ? json(answers.config ?? config()) : json({ error: answers.configFail.error }, answers.configFail.status);
    case "/api/tickets":
      return answers.ticketsFail === undefined ? json(answers.tickets ?? []) : json({ error: answers.ticketsFail.error }, answers.ticketsFail.status);
    case "/api/queue":
      return answers.queueFails === undefined ? json(answers.queue ?? queueOf()) : json({ error: answers.queueFails.error }, answers.queueFails.status);
    default:
      return null;
  }
}

/** A `fetch` that answers from the stand, and records the path of every request it was given. */
export function standFetch(stand: Stand): Fetch & Readonly<{ paths: string[] }> {
  const paths: string[] = [];
  const serve = async (input: RequestInfo | URL): Promise<Response> => {
    const path = String(input);
    paths.push(path);
    const answer = answerFor(stand, path);
    return answer === null ? new Response(JSON.stringify({ error: `no route ${path}` }), { status: 404 }) : new Response(answer.body, { status: answer.status, headers: { "Content-Type": "application/json" } });
  };
  return Object.assign(serve as Fetch, { paths });
}

/**
 * An instance sized as the boards draw theirs: 37 tickets assigned to you in a11ign (15, 9, 6, 3, 2 and 1 by goal, and one with none), 8, 1 and 1 in three other projects, and three
 * runs running. The sidebar a page check captures then has the numbers of the boards' sidebar, so the two can be set side by side.
 */
export function boardSizedStand(connection: ViewConnection = PERSONAL): Stand {
  const goals: readonly (readonly [string, number])[] = [["Clean boundaries", 15], ["Fleet", 9], ["Old org gate (review)", 6], ["v3: outside adopter", 3], ["Capture quality", 2], ["NVDA emulator", 1]];
  const tickets: TicketView[] = [];
  const next = () => `A11-${tickets.length + 1}`;
  for (const [goal, count] of goals) for (let made = 0; made < count; made += 1) tickets.push(ticket({ key: next(), goals: [goal] }));
  tickets.push(ticket({ key: next() }));
  for (const [project, count] of [["agent-org", 8], ["announcement-emulator", 1], ["auth-capture-check", 1]] as const) for (let made = 0; made < count; made += 1) tickets.push(ticket({ key: next(), project }));
  return { connections: [connection], instances: { [connection.name]: { config: config(), tickets, queue: queueOf("running", "running", "running", "queued") } } };
}
