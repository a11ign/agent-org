// module: a stand-in instance for the shell's checks -- the answers `/api/connections` and `/c/<name>/api/...` give, built from a few fields, and a `fetch` that serves them
//
// ONLY THE FIELDS THE SHELL READS ARE FILLED, so the fixtures are cast to the server's types: a field the shell starts to read that is missing here fails its check. Used by the
// component checks (as the client's `fetch`) and by the page checks (answered through Playwright's `page.route`), so both see the same instance.
import type { Fetch } from "../src/api/request.ts";
import type { ConfigView, ConnectionsView, PickView, QueueView, People, Ticket, TicketsPageView, TicketView, ViewConnection, WritersView } from "../src/api/types.ts";

export const HERE: ViewConnection = { name: "here", kind: "local" };
export const PERSONAL: ViewConnection = { name: "personal", kind: "ssh" };
export const WORK: ViewConnection = { name: "work", kind: "https" };

export const VIEWER = { id: "u-me", name: "Me" };
export const OTHER = { id: "u-other", name: "Someone" };

type TicketFields = Readonly<{ key: string; project?: string | null; assignee?: typeof VIEWER | null; goals?: readonly string[] }> & Partial<Omit<TicketView, "key" | "project" | "labels">> & Readonly<{ labels?: readonly Readonly<{ name: string; group: string | null }>[] }>;

/** A ticket of the Pick list: its project, who has it, and its Goal labels. Any other field of a ticket can be given, and a `labels` list adds to the goals. */
export function ticket({ key, project = "a11ign", assignee = VIEWER, goals = [], labels: others = [], ...rest }: TicketFields): TicketView {
  const labels = [...goals.map((name) => ({ name, group: "Goal" })), ...others];
  return { key, title: `Title of ${key}`, description: "", url: "", branch: "", status: "Backlog", statusOrder: 1, team: "A11", project, priority: 0, parent: null, labels, assignee, ...rest } as TicketView;
}

/** `/api/config`: who the key is, and the Assignee scope the list starts on. */
export const config = (fields: Partial<ConfigView> = {}): ConfigView => ({ viewer: VIEWER, pickDefault: "you", ...fields }) as ConfigView;

/** `/api/config` as an instance that queues, plans and writes answers it: the models and efforts the queue options offer, and the defaults they start from. */
export const queueingConfig = (fields: Partial<ConfigView> = {}): ConfigView => config({
  models: ["sonnet", "opus"], efforts: ["low", "medium", "high"], choice: { model: "sonnet", effort: "high", planModel: "opus", planEffort: "low", writerModel: "", writerEffort: "" },
  planner: true, plan: "plan", pick: "assigned to you", pickOpen: "open", scopes: false, writer: true, writerGrill: true, terminal: null, ...fields,
} as Partial<ConfigView>);

/** `/api/queue` holding one run in each of the phases. */
export const queueOf = (...phases: readonly string[]): QueueView => ({ entries: phases.map((phase, index) => ({ ticket: { key: `A11-${index + 1}` }, phase })) }) as unknown as QueueView;

/** A failure an instance answers with: the status and its sentence, and, as `ticket:ui`'s proxy sends beside a "cannot reach" sentence, the last answer it kept. */
export type Failure = Readonly<{ status: number; error: string; lastKnown?: Readonly<{ value: unknown; readAt: string }> }>;

/** A request an instance was given: its method, its path with the query, and its JSON body when it had one. */
export type Request = Readonly<{ method: string; path: string; body?: unknown }>;

/**
 * What one instance answers. The reads are the first six; `post` answers a request that changes something (the queue, a Grill) with a body or a failure, and answers 404 where it names none,
 * so a check that does not mean to post fails if the page does. `pages` are the pages of a scope read on demand, by scope, in order.
 */
export type InstanceAnswers = Readonly<{
  config?: ConfigView; tickets?: readonly TicketView[]; queue?: QueueView; queueFails?: Failure; ticketsFail?: Failure; configFail?: Failure;
  parents?: readonly Ticket[]; people?: People; pagesFail?: Failure; pick?: PickView; writer?: WritersView; pages?: Readonly<Record<string, readonly TicketsPageView[]>>;
  post?: (path: string, body: unknown) => unknown | Failure;
}>;

export type Stand = Readonly<{
  connections?: readonly ViewConnection[]; refusal?: string | null; connectionsFail?: boolean; instances?: Readonly<Record<string, InstanceAnswers>>; fallback?: InstanceAnswers;
  /** Leaves every call to an instance unanswered, as one that is slow to answer does, while the connections are read. */
  holdInstance?: boolean;
  /** Leaves only the queue unanswered, as a slow queue read does. */
  holdQueue?: boolean;
}>;
// `fallback` answers for any instance `instances` does not name, and for the root `/api/...` of a page with no connections.

const json = (body: unknown, status = 200): { status: number; body: string } => ({ status, body: JSON.stringify(body) });

/** A failure as the proxy answers it: its sentence, and its `lastKnown` when it has one. */
const failed = ({ status, error, lastKnown }: Failure): { status: number; body: string } => json({ error, ...(lastKnown === undefined ? {} : { lastKnown }) }, status);

const isFailure = (value: unknown): value is Failure => typeof value === "object" && value !== null && "status" in value && "error" in value;

/** What the instance leaves out of a run in the queue it lists, and sends in the run's own read (`queue-view.ts`, A11-270). */
const DETAIL_ONLY = ["plannedSteps", "currentStep", "feedback", "session"] as const;

/** `/api/queue` as the instance lists it: each run without what only its own page draws, and no log. */
function listOf(queue: QueueView): QueueView {
  const { runLog: _runLog, ...rest } = queue as QueueView & { runLog?: unknown };
  const entries = queue.entries.map((entry) => Object.fromEntries(Object.entries(entry).filter(([field]) => !(DETAIL_ONLY as readonly string[]).includes(field))));
  return { ...rest, entries } as unknown as QueueView;
}

/** `/api/queue/<key>`: the run in full with its log, as the queue holds them, or a 404 for a run it does not hold. */
function runAnswer(answers: InstanceAnswers, key: string): { status: number; body: string } {
  if (answers.queueFails !== undefined) return failed(answers.queueFails);
  const queue = (answers.queue ?? queueOf()) as QueueView & { runLog?: Readonly<Record<string, unknown>> };
  const entry = queue.entries.find((candidate) => candidate.ticket.key === key);
  return entry === undefined ? json({ error: `no run ${key} on the queue` }, 404) : json({ entry, runLog: queue.runLog?.[key] ?? [] });
}

/** The answer to a request that changes something, or to a read the instance has no answer for. */
function postAnswer(answers: InstanceAnswers, route: string, request: Readonly<{ method: string; body?: unknown }>): { status: number; body: string } | null {
  if (request.method !== "POST" || answers.post === undefined) return null;
  const answer = answers.post(route, request.body);
  return isFailure(answer) ? json({ error: answer.error }, answer.status) : json(answer);
}

/** The pages of the scope an `/api/tickets?assignee=` names, from the cursor `after` names. */
function pageAnswer(answers: InstanceAnswers, query: URLSearchParams): { status: number; body: string } | null {
  if (query.has("assignee") && answers.pagesFail !== undefined) return json({ error: answers.pagesFail.error }, answers.pagesFail.status);
  const pages = answers.pages?.[query.get("assignee") ?? ""];
  if (pages === undefined) return null;
  const index = Number(query.get("after") ?? 0);
  return json({ ...pages[index], next: index + 1 < pages.length ? String(index + 1) : null });
}

/** The answer to one request (a path `/api/...` or `/c/<name>/api/...`, and its method and body), as a status and a JSON body, or null for a path no instance has. */
export function answerFor(stand: Stand, path: string, request: Readonly<{ method: string; body?: unknown }> = { method: "GET" }): { status: number; body: string } | null {
  if (path === "/api/connections") {
    if (stand.connectionsFail) return json({ error: "no" }, 500);
    const view: ConnectionsView = { connections: [...(stand.connections ?? [HERE])], refusal: stand.refusal ?? null };
    return json(view);
  }
  const [, name, route] = /^\/c\/([^/]+)(\/api\/[^?]+)/.exec(path) ?? [undefined, undefined, /^(\/api\/[^?]+)/.exec(path)?.[1]];
  const answers = (name === undefined ? undefined : stand.instances?.[decodeURIComponent(name)]) ?? stand.fallback ?? {};
  const posted = route === undefined ? null : postAnswer(answers, route, request);
  if (posted !== null) return posted;
  switch (route) {
    case "/api/config":
      return answers.configFail === undefined ? json(answers.config ?? config()) : failed(answers.configFail);
    case "/api/tickets":
      return answers.ticketsFail === undefined ? (pageAnswer(answers, new URLSearchParams(path.split("?")[1] ?? "")) ?? json(answers.tickets ?? [])) : failed(answers.ticketsFail);
    case "/api/queue":
      return answers.queueFails === undefined ? json(listOf(answers.queue ?? queueOf())) : failed(answers.queueFails);
    case "/api/parents":
      return json(answers.parents ?? []);
    case "/api/people":
      return answers.people === undefined ? null : json(answers.people);
    case "/api/pick":
      return answers.pick === undefined ? null : json(answers.pick);
    case "/api/writer":
      return answers.writer === undefined ? null : json(answers.writer);
    default: {
      const run = route === undefined ? null : /^\/api\/queue\/([^/]+)$/.exec(route);
      return run === null ? null : runAnswer(answers, decodeURIComponent(run[1]));
    }
  }
}

/** The body of a request as JSON, or undefined when it has none. */
const bodyOf = (init: RequestInit | undefined): unknown => (typeof init?.body === "string" ? JSON.parse(init.body) : undefined);

/** A `fetch` that answers from the stand, and records the path of every request it was given and, in `requests`, each with its method and body. */
export function standFetch(stand: Stand): Fetch & Readonly<{ paths: string[]; requests: Request[] }> {
  const paths: string[] = [];
  const requests: Request[] = [];
  const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    const request = { method: init?.method ?? "GET", body: bodyOf(init) };
    paths.push(path);
    requests.push({ ...request, path });
    if (stand.holdInstance === true && path !== "/api/connections") return new Promise<Response>(() => undefined);
    if (stand.holdQueue === true && path.endsWith("/api/queue") && request.method === "GET") return new Promise<Response>(() => undefined);
    const answer = answerFor(stand, path, request);
    return answer === null ? new Response(JSON.stringify({ error: `no route ${path}` }), { status: 404 }) : new Response(answer.body, { status: answer.status, headers: { "Content-Type": "application/json" } });
  };
  return Object.assign(serve as Fetch, { paths, requests });
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

/** The rows the Tickets board draws, by key, title and goal: the first of the 25 in its Backlog section. `A11-24` has ten open sub-issues, `A11-180` is on the queue and `A11-53` has an open decision. */
const BOARD_ROWS: readonly (readonly [string, string, string | null])[] = [
  ["A11-24", "agent-org stands alone: a11ign runs product checks only, and the org acts on it from outside", "Clean boundaries"],
  ["A11-180", "lab's cross-repo leg runs old-org tests against agent-org's internals and goes red on every agent-org release", null],
  ["A11-65", "INCIDENT 2026-10-06: the agents host hung for 2 h 15 min unnoticed and fleet auto-off refused for ~12 h unread; the record, the corrected measurements and the class-fix rows (chairman, via ceo)", "Fleet"],
  ["A11-63", "The screen loop's observation names an unnamed alert from the text beneath it, as the CLI's screenOf already does (from #5564)", "Capture quality"],
  ["A11-62", "auth-capture-check is a declared code repository, so a row whose Region is in it opens without an Outside-Region line (from #5703)", "Old org gate (review)"],
  ["A11-54", "ceo's ruling: trunk.yml's trunkBuildTest stays unscoped for now: it is not duplicate work, the merge queue's own check is scoped too", "Old org gate (review)"],
  ["A11-53", "An authenticated run on a private repository, written down and verified cold: a fresh session performs it from the document alone, twice", "v3: outside adopter"],
  ["A11-50", "Label all fifteen worker boxes with their UniFi names", "Fleet"],
  ["A11-32", "Run the outsider test for real and record it (a11ign#4425 done-when 6)", "Clean boundaries"],
  ["A11-30", "Renovate opens no PROJECT_REF bump on agent-org: read why and fix it, so agent-org#1267 can proceed", "Clean boundaries"],
  ["A11-29", "Verify The weekly token-cost unit misses a CI-health comment that lands after its last Monday start (follow-up to a11ign#5290)", "Old org gate (review)"],
  ["A11-27", "Re-lay the control plane's two timer units from /root/control and give the patch window A11Y_PVE_KEY (live half of a11ign#5506)", "Fleet"],
];

const TEN_SUB_ISSUES = Array.from({ length: 10 }, (_, index) => `A11-9${index}`);

/**
 * The instance the Tickets boards draw: 37 tickets assigned to you in a11ign (25 in Backlog, the rows of the board first, and 12 in Todo), 8, 1 and 1 in three other projects, three runs
 * running and one finished, and `queue` as given. A11-180 is on the queue. `assigned` is false for the instance of the empty board, whose tickets are all someone else's.
 */
export function ticketsBoardStand({ paused = false, assigned = true }: Readonly<{ paused?: boolean; assigned?: boolean }> = {}): Stand {
  const owner = assigned ? VIEWER : OTHER;
  const first = BOARD_ROWS.map(([key, title, goal]) => ticket({
    key, title, goals: goal === null ? [] : [goal], assignee: owner, url: `https://linear.app/a11ign/issue/${key}`,
    ...(key === "A11-24" ? { children: TEN_SUB_ISSUES } : {}),
    ...(key === "A11-53" ? { needsDecision: { kind: "open", reason: "Two readings of the ticket" } } : {}),
  } as never));
  // What the first twelve leave of the board's goal counts (15, 9, 6, 3, 2 and 1), spread over the rest of the 37.
  const goals = [...Array<string>(12).fill("Clean boundaries"), ...Array<string>(6).fill("Fleet"), ...Array<string>(3).fill("Old org gate (review)"), ...Array<string>(2).fill("v3: outside adopter"), "Capture quality", "NVDA emulator"];
  const filler = (count: number, status: string, statusOrder: number, from: number) => Array.from({ length: count }, (_, index) => ticket({ key: `A11-${from + index}`, title: `Another ticket, ${from + index}`, status, statusOrder, assignee: owner, goals: [goals[(from === 100 ? 0 : 13) + index]] }));
  const others = (project: string, count: number, from: number) => Array.from({ length: count }, (_, index) => ticket({ key: `A11-${from + index}`, title: `A ticket of ${project}`, project, assignee: owner }));
  const tickets = [...first, ...filler(13, "Backlog", 1, 100), ...filler(12, "Todo", 2, 200), ...others("agent-org", 8, 300), ...others("announcement-emulator", 1, 400), ...others("auth-capture-check", 1, 410)];
  const queue = { entries: [{ ticket: { key: "A11-180" }, phase: "finished" }, ...queueOf("running", "running", "running").entries], paused } as unknown as QueueView;
  return { connections: [PERSONAL], instances: { personal: { config: queueingConfig(), tickets, queue } } };
}
