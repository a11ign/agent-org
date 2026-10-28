// @ts-check
// module: the instance's reads (A11-282) -- its GET routes, the views they answer, and how a request is let in, over a `ReadBoard` that both of the instance's threads can make
//
// THE READS ARE ANSWERED ON THE REQUEST THREAD. The instance's board thread runs the pool, whose `gh`, `git` and `herdr` calls are synchronous, so a read answered there waits on
// every one of them. The request thread (`request-thread.ts`) makes a `ReadBoard` over the latest board snapshot (`board-thread.ts`) and answers these routes itself; the board
// thread's `createBoard` (`server.ts`) makes one over its live queue and pool, so `createBoard(...).api` answers them exactly as before.
//
// SO THIS MODULE IMPORTS NOTHING OF THE POOL AT RUN TIME, and nothing that spawns synchronously on a read but the exceptions `request-thread-guard.test.ts` lists, as it walks what
// this imports. The view types keep their names, and `server.ts` exports them again, because the UI's client names them there.
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { UpdateNote } from "./board-view/update-banner.ts";
import { publisherStateOf, reviewerStateOf } from "./concern-states.ts";
import { API_BODY_BYTES, readJson, refusal, sameSecret, sendJson, sendJsonFor, type Json } from "./local-http.ts";
import { pickEmptyText, pickLabel } from "./pick-scope.ts";
import type { Pool } from "./pool.ts";
import { inWork, takenState } from "./pick-taken.ts";
import type { PluginsApi } from "./plugins-api.ts";
import type { ProblemOptions } from "./plugins.ts";
import { queueEntryView, queueView, shownWriter, type QueueView } from "./queue-view.ts";
export type { QueueEntryView, QueueListEntry, QueueView, RunDetailEntry } from "./queue-view.ts";
import { interventionsView } from "./queue/interventions.ts";
import { flakesPath, flakesViewOf } from "./flakes.ts";
import { type Queue, type RunChoice, type WriterRun, writerStatus } from "./queue/queue-entries-and-outcomes.ts";
import { isTicketWriter, type TicketWriterRun } from "./queue/writer-modes.ts";
import { EFFORTS, MODELS, readSettingsView } from "./settings-read.ts";
import { hostFilePath, type TicketSettings } from "./settings.ts";
import type { Assignee, People, ScopePage, Ticket, TicketSource, TrackerProject } from "./source.ts";
import { type TerminalRun, terminalRunOf } from "./terminal-pair.ts";
import { PRIORITIES } from "./writer.ts";

/** How long a reading of who holds the open tickets stands. */
const PEOPLE_FRESH_MS = 300_000;

/**
 * The settings' choices: the model and effort a ticket queued from now on runs with, those a ticket planned first is planned with, and those a
 * new-ticket request is written with. The writer's are absent until one is chosen, and the host file's are in force then.
 */
export type SavedChoice = RunChoice & Readonly<{ planModel: string; planEffort: string; writerModel?: string; writerEffort?: string }>;

/** The saved choice. A saved value the board no longer offers falls back, so queueing with the settings is never refused. */
export function readChoice(path: string): SavedChoice {
  // Planning is the harder job, so it starts on the most capable model; the person changes either in Settings.
  const fallback: SavedChoice = { model: "opus", effort: "high", planModel: "opus", planEffort: "high" };
  if (!existsSync(path)) return fallback;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<SavedChoice>;
    const valid = (part: Exclude<keyof SavedChoice, "writerModel" | "writerEffort">, allowed: readonly string[]) => (allowed.includes(String(saved[part])) ? String(saved[part]) : fallback[part]);
    // A writer part is kept only while the board offers it, and is left out when nothing is chosen, so the choice names no value of its own.
    const writerModel = String(saved.writerModel);
    const writerEffort = String(saved.writerEffort);
    return { model: valid("model", MODELS), effort: valid("effort", EFFORTS), planModel: valid("planModel", MODELS), planEffort: valid("planEffort", EFFORTS),
      ...(MODELS.includes(writerModel) ? { writerModel } : {}), ...(EFFORTS.includes(writerEffort) ? { writerEffort } : {}) };
  } catch {
    return fallback;
  }
}

/** The version this instance runs, the breaking update that drains, if one does (A11-169), and the version an update is moving to while it moves (A11-217). */
export type UpdateView = Readonly<{ version: string | null; note: UpdateNote | null; next: string | null }>;

/** What a read takes from the pool: why runs are held, what is wrong with the host, the pull requests' review lines, the review claims' warning and the reviewer's state. A board with no pool reads none. */
export type ReadPool = Partial<Pick<Pool, "held" | "hostAlerts" | "pullReviews" | "claimWarning" | "reviewerState">>;

/** The files the reads open: the host file (`AGENT_ORG_HOST`'s when unset), the queue, the saved choice and the Claude Code plugins' install record (the machine's own when unset). */
export type ReadPaths = Readonly<{ hostPath?: string; queuePath: string; choicePath: string; pluginRecord?: string }>;

/** What the reads act on: the settings, the tracker, the queue as last stored, the pool's readings, the tickets the page last read, and the readers of the board's other parts. */
export type ReadBoard = Readonly<{
  settings: TicketSettings;
  source: TicketSource;
  store: { get: () => Queue };
  pool: ReadPool;
  /** The tickets the page last listed, and the latest claim each in-work one without a run here carries, as the tracker last said (A11-168). */
  known: { tickets: Map<string, Ticket>; claims: Map<string, string> };
  /** This instance's name as a claim names it (`claimantOf`), read once. */
  claimant: () => string;
  plans: boolean;
  paths: ReadPaths;
  update: () => UpdateView;
  terminalAddress: () => Promise<string | null>;
  plugins: Pick<PluginsApi, "read">;
  /** What the Settings page's Claude Code plugins are read through, when not the machine's own programs: the request thread's readers, which spawn nothing. */
  problems?: ProblemOptions;
  /** What `/api/health` answers (A11-282). Absent, the route is not served, as on an instance from before it. */
  health?: () => unknown;
  /** The clock `/api/interventions` names today by: the time now when absent. */
  now?: () => number;
}> & TrackerReads;

/** Whether the request carries the instance's key in its `x-ticket-token` header. A cookie is never read. */
export function holdsKey(request: Pick<IncomingMessage, "headers">, key: string): boolean {
  const header = request.headers["x-ticket-token"];
  return header !== undefined && sameSecret(String(header), key);
}

/** How an answer is made: the route table of the thread that answers, by method, path, body and query. */
export type Api = (method: string, path: string, body: Json, query: URLSearchParams) => Promise<[number, unknown]>;

/**
 * Answers one request as the instance does on either thread: a request from another host or origin is refused, one without the key is a 401, and a route that throws is a 400 with
 * its sentence. The caller answers a 500 when this itself fails.
 */
export async function answerKeyed(request: IncomingMessage, response: ServerResponse, { port, key, api }: Readonly<{ port: number; key: string; api: Api }>): Promise<void> {
  const refused = refusal(request, port);
  if (refused !== null) return sendJson(response, 403, { error: refused });
  if (!holdsKey(request, key)) {
    return sendJson(response, 401, { error: "this is an agent-org instance, which serves no page and answers only to its key: open the board with agent-org ticket:ui" });
  }
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    const body = request.method === "POST" ? await readJson(request, API_BODY_BYTES) : {};
    const [status, value] = await api(request.method ?? "GET", url.pathname, body, url.searchParams);
    sendJsonFor(request, response, { status, value });
  } catch (err) {
    sendJson(response, 400, { error: String((err as Error)?.message ?? err) });
  }
}

/**
 * What the tracker is asked for beyond the lists: whose key this is, who holds the open tickets, whether the Assignee row reads scopes one at a time, whether the Pick view is narrowed to
 * a project it reads on demand (A11-378), and whether a person can search the whole workspace's open tickets.
 */
export type TrackerReads = Readonly<{ whoAmI: () => Promise<Assignee | null>; whoHolds: () => Promise<People>; scopesOnDemand: () => boolean; projectsOnDemand: () => boolean; searchable: () => boolean }>;

/** The tracker's other reads over `source`, each kept as long as it stands. Made once per board. */
export function trackerReads(source: TicketSource, settings: Pick<TicketSettings, "pick">): TrackerReads {
  let viewer: Assignee | null = null;
  let people: { at: number; value: People } | null = null;
  let peopleReading: Promise<People> | null = null;
  return {
    /**
     * The person whose key this is, read once and kept for the life of the instance. A failure is null and is asked again on the next config read,
     * so a tracker that is down at start-up does not hide the Assignee filter for ever. A source without `me` has no one to name.
     */
    async whoAmI() {
      if (viewer === null && source.me !== undefined) viewer = await source.me().catch(() => null);
      return viewer;
    },
    /** Who holds the open tickets, read once in a while: it takes about 12 s on a workspace of 7,000 tickets. Asked again after PEOPLE_FRESH_MS, and never twice at once. */
    async whoHolds() {
      if (people !== null && Date.now() - people.at < PEOPLE_FRESH_MS) return people.value;
      peopleReading ??= source.people!().then((value) => { people = { at: Date.now(), value }; return value; }).finally(() => { peopleReading = null; });
      return peopleReading;
    },
    /**
     * Whether the Assignee row can reach tickets beyond the key's own, one scope at a time: the default list is the key's own, and the source can read the rest. Never where the Pick view
     * reads a project at a time instead (A11-378): a scope such as Anyone is every open ticket of the workspace, and the project picker is what widens the list there.
     */
    scopesOnDemand: () => settings.pick === "assigned" && source.people !== undefined && source.scoped !== undefined && !projectsOnDemand(source, settings),
    /** Whether the Pick view offers the tracker's projects and reads the one picked, a page at a time (A11-378): the default list is the key's own, and the source can list and read projects. */
    projectsOnDemand: () => projectsOnDemand(source, settings),
    /** Whether the Pick view's search reaches the whole workspace's open tickets (A11-378). */
    searchable: () => source.search !== undefined,
  };
}

/** Whether the Pick view reads a project at a time (A11-378): the list is the key's own, and the source lists its projects and reads one. */
const projectsOnDemand = (source: TicketSource, settings: Pick<TicketSettings, "pick">): boolean =>
  settings.pick === "assigned" && source.projects !== undefined && source.projectPage !== undefined;

/** Whether a board plans a ticket first: the machine names a planner, and the tracker can take the plan it writes. */
export const plansOf = (settings: Pick<TicketSettings, "planner" | "plan">, source: Pick<TicketSource, "attachPlan">): boolean =>
  settings.planner !== null && settings.plan !== null && source.attachPlan !== undefined;

/** Whether this instance's queue holds a run for the ticket, in any phase. */
export const holdsRun = ({ store }: Pick<ReadBoard, "store">, key: string): boolean => store.get().entries.some((entry) => entry.ticket.key === key);

/**
 * A ticket as the page is sent it, with `taken` where another instance holds it (A11-144, A11-168): the tracker shows it in a taken state and its latest claim, as the board
 * last read it, names another instance. A ticket this instance holds a run for is never taken. Pick shows the state and does not let the ticket be queued here.
 */
function withTaken<T extends Ticket>(board: Pick<ReadBoard, "settings" | "store" | "known" | "claimant">, ticket: T): T & Readonly<{ taken?: string }> {
  const held = holdsRun(board, ticket.key);
  const state = held ? null : takenState(ticket, board.settings.takenStates, board.known.claims.get(ticket.key), board.claimant());
  return state === null ? ticket : { ...ticket, taken: state };
}

/** A ticket as `/api/tickets` answers it: with `taken` where it holds. The UI's client names this type, so a field renamed here fails its `tsc`. */
export type TicketView = ReturnType<typeof ticketView> & Readonly<{
  /** Never sent now (A11-257): nothing holds a ticket for an open decision. The page's and the built UI's dead branches still read it, and A11-202, A11-241 and A11-245 hold those files; a follow-up removes both. */
  needsDecision?: Readonly<{ kind: string; reason: string }>;
}>;

function ticketView(board: Pick<ReadBoard, "settings" | "store" | "known" | "claimant">, ticket: Ticket) {
  return withTaken(board, ticket);
}

/** One page of a scope's tickets as `/api/tickets?assignee=` answers it: each ticket as `/api/tickets` shows it, and the cursor of the next page or null. */
export type TicketsPageView = Readonly<{ tickets: readonly TicketView[]; next: string | null }>;

/** One of the tracker's projects as `/api/projects` answers it (A11-378). */
export type ProjectView = TrackerProject;

/** What `/api/pick` answers: the words an empty Pick list says. */
export type PickView = Readonly<{ empty: ReturnType<typeof pickEmptyText> }>;

/**
 * Read the claim of each of `tickets` a claim could matter for: in a taken state, with no run here. The answer replaces what the board kept for them. A source with no
 * `claims` answers none, so none is taken; one that cannot be asked leaves none of these taken either, since a claim the board could not read is not another instance's.
 * The queue route reads again before it refuses anything.
 */
async function readClaims(board: Pick<ReadBoard, "settings" | "source" | "store" | "known">, tickets: readonly Ticket[]): Promise<void> {
  const { known, settings, source } = board;
  const keys = tickets.filter((ticket) => !holdsRun(board, ticket.key) && inWork(ticket, settings.takenStates)).map((ticket) => ticket.key);
  for (const key of keys) known.claims.delete(key);
  if (keys.length === 0 || source.claims === undefined) return;
  try {
    for (const [key, claimant] of await source.claims(keys)) known.claims.set(key, claimant);
  } catch (err) {
    process.stderr.write(`ticket:serve: the tracker could not say who claimed the in-work tickets, so none is shown as taken: ${String((err as Error)?.message ?? err)}\n`);
  }
}

/** A page of tickets as the page is sent it: each is known to the board, as a listed ticket is, so it can be queued, and the claim of an in-work one is read. */
async function pageView(board: Pick<ReadBoard, "settings" | "source" | "store" | "known" | "claimant">, page: ScopePage): Promise<TicketsPageView> {
  for (const ticket of page.tickets) board.known.tickets.set(ticket.key, ticket);
  await readClaims(board, page.tickets);
  return { ...page, tickets: page.tickets.map((ticket) => ticketView(board, ticket)) };
}

/** A new-ticket request as the page shows it: its status, and the tickets it filed, each with its key and address (A11-135). */
function writerViewOf(run: TicketWriterRun) {
  return { ...shownWriter(run), status: writerStatus(run) };
}

/** What `/api/writer` answers, and every route that changes a new-ticket request. */
export type WritersView = ReturnType<typeof writersViewOf>;

/** The new-ticket requests, each with its status, as the page shows them. */
export function writersViewOf(queue: Queue) {
  return { runs: (queue.writers ?? []).filter(isTicketWriter).map(writerViewOf) };
}

/** What `/api/config` answers: the board's choices and capabilities. The UI's client names this type, so a field renamed here fails its `tsc`. */
export type ConfigView = Awaited<ReturnType<typeof configView>>;

async function configView(board: ReadBoard) {
  const { settings, store, plans, paths } = board;
  const update = board.update();
  // `pickDefault` is the Assignee filter's first choice: the key's own tickets, or every open one. `pickOpen` is what Anyone reads as in the count.
  // `viewer` is the key's person, or null while the tracker cannot say: an instance that sends it names assignees, one that does not is older.
  return { models: MODELS, efforts: EFFORTS, choice: readChoice(paths.choicePath), max: store.get().max, terminal: await board.terminalAddress(), plan: settings.plan, planner: plans,
    publish: settings.publish !== null, publisher: publisherStateOf(settings), reviewer: board.pool.reviewerState?.() ?? reviewerStateOf(settings, null), pick: pickLabel(settings.pick), pickDefault: settings.pick === "assigned" ? "you" : "anyone", scopes: board.scopesOnDemand(),
    pickOpen: settings.pick === "assigned" ? "open" : pickLabel(settings.pick), viewer: await board.whoAmI(), projects: board.projectsOnDemand(), search: board.searchable(),
    writer: settings.writer !== null, writerDefault: settings.writer === null ? null : { model: settings.writer.model, effort: settings.writer.effort },
    writerGrill: settings.terminal !== null, repos: Object.keys(settings.clones), priorities: PRIORITIES, version: update.version, updateNote: update.note };
}

/** The GET routes: the board's config, the Pick lists, the queue and the new-ticket requests. `undefined` when no route here names the request. */
export async function readRoute(board: ReadBoard, method: string, path: string, query: URLSearchParams): Promise<[number, unknown] | undefined> {
  const { settings, source, store, known, paths } = board;
  if (method === "GET" && path === "/api/config") return [200, await configView(board)];
  if (method === "GET" && path === "/api/settings") {
    // The read-only Settings page: each file read fresh, so a refusal names its field, and the instance's own queue and choice (A11-131).
    return [200, await readSettingsView({ hostPath: paths.hostPath ?? hostFilePath(), settings, queuePath: paths.queuePath, queueMax: store.get().max,
      choicePath: paths.choicePath, ...(paths.pluginRecord === undefined ? {} : { pluginRecord: paths.pluginRecord }), ...(board.problems === undefined ? {} : { problems: board.problems }) })];
  }
  if (method === "GET" && path === "/api/plugins") {
    // The Plugins section is its own call (A11-163): a plugin's checks run programs, and the rest of the page must not wait on them or fail with them. `?check` asks for fresh checks (A11-270).
    return [200, await board.plugins.read({ check: query.has("check") })];
  }
  if (method === "GET" && path === "/api/pick") {
    // Asked only by a Pick view whose list came back empty, so the name of the key's person costs a request only then. A tracker that cannot
    // say whose key it is, or cannot be asked, leaves the text saying "you": the empty list still names its setting.
    const user = settings.pick === "assigned" && source.viewer ? await source.viewer().catch(() => null) : null;
    const view: PickView = { empty: pickEmptyText(settings.pick, user) };
    return [200, view];
  }
  if (method === "GET" && path === "/api/people") {
    if (!board.scopesOnDemand()) return [404, { error: "this instance lists every ticket it has at once, so it counts nobody separately" }];
    return [200, await board.whoHolds()];
  }
  if (method === "GET" && path === "/api/tickets" && query.has("assignee")) {
    // One page of the scope the Assignee row chose, with the cursor of the next: Anyone and Unassigned can hold thousands of tickets, past what one answer carries.
    if (!board.scopesOnDemand()) return [404, { error: "this instance lists every ticket it has at once, so a scope is not read on its own" }];
    return [200, await pageView(board, await source.scoped!(query.get("assignee") ?? "", query.get("after")))];
  }
  if (method === "GET" && path === "/api/projects") {
    if (!board.projectsOnDemand()) return [404, { error: "this instance does not read a project at a time: its list is tickets.pick's, or its tracker cannot list projects" }];
    const projects: readonly ProjectView[] = await source.projects!();
    return [200, projects];
  }
  if (method === "GET" && path === "/api/tickets" && query.has("project")) {
    // One page of the project the picker chose (A11-378), with the cursor of the next.
    if (!board.projectsOnDemand()) return [404, { error: "this instance does not read a project at a time: its list is tickets.pick's, or its tracker cannot list projects" }];
    return [200, await pageView(board, await source.projectPage!(query.get("project") ?? "", query.get("after")))];
  }
  if (method === "GET" && path === "/api/search") {
    // The whole workspace's open tickets that match, whoever holds them and whatever their project (A11-378). They are known to the board as a listed ticket is, so one can be queued.
    if (!board.searchable()) return [404, { error: "this instance's tracker cannot search, so the Pick view filters only the tickets it lists" }];
    const found = await source.search!(query.get("q") ?? "");
    return [200, (await pageView(board, { tickets: found, next: null })).tickets];
  }
  if (method === "GET" && path === "/api/tickets") {
    const tickets = await source.assigned();
    known.tickets = new Map(tickets.map((ticket) => [ticket.key, ticket]));
    known.claims = new Map();
    await readClaims(board, tickets);
    return [200, tickets.map((ticket) => ticketView(board, ticket))];
  }
  if (method === "GET" && path === "/api/parents") {
    // The parents of the listed tickets that are not listed themselves, so the Pick list can nest under them whatever scope it shows. One the
    // tracker cannot read is left out, and its children stand on their own.
    const missing = [...new Set([...known.tickets.values()].flatMap((t) => (t.parent && !known.tickets.has(t.parent) ? [t.parent] : [])))];
    const read = await Promise.allSettled(missing.map((key) => source.read(key)));
    return [200, read.flatMap((r) => (r.status === "fulfilled" && r.value !== null ? [r.value] : []))];
  }
  if (method === "GET" && path === "/api/queue") return [200, queueView(board)];
  const run = method === "GET" ? /^\/api\/queue\/([A-Za-z0-9_-]+)$/.exec(path) : null;
  if (run !== null) {
    const view = queueEntryView(board, decodeURIComponent(run[1]));
    return view === null ? [404, { error: `no run ${run[1]} on the queue` }] : [200, view];
  }
  if (method === "GET" && path === "/api/writer") return [200, writersViewOf(store.get())];
  if (method === "GET" && path === "/api/health" && board.health !== undefined) return [200, board.health()];
  // The health number (A11-257): `/api/health` is the loop's (A11-282), so the person-interventions are their own route, beside the POST that records a fix.
  if (method === "GET" && path === "/api/interventions") return [200, interventionsView(store.get(), (board.now ?? Date.now)())];
  // The tests that flaked three times in seven days (A11-300), read from the flake log in the board's state: the chairman's session files a ticket for each.
  if (method === "GET" && path === "/api/flakes") return [200, flakesViewOf(flakesPath(board.settings.stateDir), (board.now ?? Date.now)())];
  return undefined;
}

/**
 * Whether the run that holds the terminal a worker link names has ended, as the board holds it (A11-129). The page's service asks this before it sends
 * a paired browser on, and a board with no terminal names none.
 */
export async function terminalRunFor(board: Pick<ReadBoard, "terminalAddress" | "store">, body: Json): Promise<TerminalRun> {
  const template = await board.terminalAddress();
  const link = typeof body.link === "string" ? body.link : "";
  return template === null ? { state: "unknown" } : terminalRunOf(board.store.get(), template, link);
}
