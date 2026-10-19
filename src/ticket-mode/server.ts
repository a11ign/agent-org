#!/usr/bin/env node
// @ts-check
// command: ticket:serve -- ticket mode's instance on 127.0.0.1: the queue, the pool of workers and their API, with no page. `ticket:ui` is the page
//
// THE INSTANCE IS THE QUEUE'S ONE WRITER. The page's service, and anything else that talks to this API, asks the server to change the queue;
// the server applies the pure transition (`queue.ts`), saves the file and wakes the pool. The pool runs in this process.
//
// IT SERVES NO PAGE, AND ANSWERS ONLY TO ITS KEY. It binds 127.0.0.1, and nothing secret goes in a URL. A script on this machine reads the
// instance's key from its mode-600 file (`board-key.ts`) and sends it as `x-ticket-token`. So does the page's service (`ui-server.ts`), which a
// browser pairs with, for this machine or for another one it reaches over SSH or https. A browser's cookie opens nothing here. A `Host` that
// is not this server's is refused, which stops a DNS-rebinding page from reaching it, and a write from another origin is refused. The Linear
// key never leaves this process.
import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { constants, homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../lib/cli-flags.ts";
import { boardKey, boardKeyPath } from "./board-key.ts";
import { hasPlan } from "./board-view/view-ticket.ts";
import { readOrNull } from "../install/paths.ts";
import { effectiveTerminal, localTerminalPort } from "../install/terminal.ts";
import { mintTerminalCode, type TerminalMint } from "./terminal-pair.ts";
import { linearSource, readLinearKey } from "./linear.ts";
import { pickEmptyText, pickLabel } from "./pick-scope.ts";
import { API_BODY_BYTES, readJson, refusal, sameSecret, sendJson, type Json } from "./local-http.ts";
import { createPool, startsReviewers, type PoolDeps } from "./pool.ts";
import { loadReviewerGate } from "./reviewer-port.ts";
import { amend, childOrder, enqueue, retry, type PlanFirst, type Queue, type RunChoice, type WriterRun, writerStatus } from "./queue/declared-remains.ts";
import { approve, queuePublish, respond, setMax, pauseQueue, resumeQueue } from "./queue/approve.ts";
import { dismissWriter, loadQueue, queueWriter, saveQueue, writerOf } from "./queue.ts";
import { plansInBatches, readTicketSettings, type TicketSettings } from "./settings.ts";
import { cachedTailnetName, readTailnetName, runTailscale, tailnetTerminal } from "./tailnet.ts";
import type { Assignee, People, Ticket, TicketSource } from "./source.ts";
import { PRIORITIES } from "./writer.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin.ts");
const TICK_MS = 30_000;
/** How often the tracker is asked whether finished runs' tickets are done. A merge is not urgent news, and every read is a Linear request. */
const TRACKER_MS = 120_000;
/** How often the open pull requests of runs Ready to merge are read for new feedback. Each is one GitHub request per pull request. */
export const FEEDBACK_MS = 180_000;
/** How long herdr web ui may take to mint a terminal pairing code before the link goes out plain (A11-93). */
const TERMINAL_PAIR_MS = 5_000;
/** How long a reading of who holds the open tickets stands. */
const PEOPLE_FRESH_MS = 300_000;
const MODELS = ["opus", "sonnet", "haiku"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export type BoardDeps = Readonly<{
  settings: TicketSettings;
  source: TicketSource;
  key: string;
  queuePath: string;
  choicePath: string;
  pool?: Pick<ReturnType<typeof createPool>, "tick" | "stop" | "close" | "dismiss" | "remove" | "reconcile" | "ensureSession" | "refreshTracker" | "watchFeedback" | "releaseReviewers" | "retargetStacked" | "rebaseStacked" | "applyEdit" | "discardEdit" | "stopWriterRun"> & Partial<Pick<ReturnType<typeof createPool>, "held">>;
  poolDeps?: Omit<PoolDeps, "settings" | "source" | "hook">;
  now?: () => number;
  /** This machine's MagicDNS name, read when `tickets.serve` puts the board on the tailnet; null while it cannot be read. Only `/api/config` asks. */
  tailnet?: () => Promise<string | null>;
  /** The worker terminal's pairing code, minted for a paired browser following a worker link (A11-93). Default: herdr web ui's own, on loopback. */
  mintTerminal?: () => Promise<TerminalMint>;
}>;

/** Whether the request carries the instance's key in its `x-ticket-token` header. A cookie is never read. */
export function holdsKey(request: Pick<IncomingMessage, "headers">, key: string): boolean {
  const header = request.headers["x-ticket-token"];
  return header !== undefined && sameSecret(String(header), key);
}

/**
 * The settings' choices: the model and effort a ticket queued from now on runs with, those a ticket planned first is planned with, and those a
 * new-ticket request is written with. The writer's are absent until one is chosen, and the host file's are in force then.
 */
type SavedChoice = RunChoice & Readonly<{ planModel: string; planEffort: string; writerModel?: string; writerEffort?: string }>;

/** A rule that also accepts "", which clears the part: the host file's value is in force again. */
const clearable = (check: (value: string) => void) => (value: string) => { if (value !== "") check(value); };

/** Each part of the saved choice, with the rule its value is held to. The writer's parts may be cleared. */
const CHOICE_PARTS: Readonly<Record<keyof SavedChoice, (value: string) => void>> = {
  model: checkModel, effort: checkEffort, planModel: checkModel, planEffort: checkEffort,
  writerModel: clearable(checkModel), writerEffort: clearable(checkEffort),
};

/** The saved choice. A saved value the board no longer offers falls back, so queueing with the settings is never refused. */
function readChoice(path: string): SavedChoice {
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

/** The choice with `change` made to it. A writer part changed to "" is cleared, so the file names no value for it again. */
function applyChange(choice: SavedChoice, change: Partial<SavedChoice>): SavedChoice {
  const { writerModel, writerEffort, ...kept } = { ...choice, ...change };
  return { ...kept, ...(writerModel ? { writerModel } : {}), ...(writerEffort ? { writerEffort } : {}) };
}

function writeChoice(path: string, choice: SavedChoice): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(choice)}\n`);
}

function checkModel(model: string): void {
  if (!MODELS.includes(model)) throw new Error(`model must be one of ${MODELS.join(", ")}`);
}

function checkEffort(effort: string): void {
  if (!EFFORTS.includes(effort)) throw new Error(`effort must be one of ${EFFORTS.join(", ")}`);
}

function validRunChoice(body: Json): RunChoice {
  const model = String(body.model ?? "");
  const effort = String(body.effort ?? "");
  checkModel(model);
  checkEffort(effort);
  return { model, effort };
}

/**
 * A change to a run's model or effort, or to the settings', names only what it changes, and each part is held to the rules queueing uses.
 * `parts` are the ones this change may name: a queued run has no planning choice of its own to change.
 */
function validChange<P extends keyof SavedChoice>(body: Json, parts: readonly P[]): Partial<Pick<SavedChoice, P>> {
  const named = parts.filter((part) => body[part] !== undefined).map((part) => [part, String(body[part])] as const);
  for (const [part, value] of named) CHOICE_PARTS[part](value);
  return Object.fromEntries(named) as Partial<Pick<SavedChoice, P>>;
}

/** The longest request a new-ticket run takes, in characters. */
const WRITER_REQUEST_CHARS = 8000;
const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/**
 * The choices a new-ticket request's form made, each one checked: a repository the machine has, a priority the drafts may name, a ticket's key. The
 * fields left out are not requirements. Throws naming the field at fault.
 */
function writerForm(body: Json, settings: TicketSettings): Readonly<Record<string, string | undefined>> {
  const text = (name: string): string | undefined => {
    if (body[name] === undefined || body[name] === "") return undefined;
    if (typeof body[name] !== "string") throw new Error(`${name} must be text`);
    return String(body[name]).trim();
  };
  const repo = text("repo");
  if (repo !== undefined && !(repo in settings.clones)) throw new Error(`repo must be one of ${Object.keys(settings.clones).join(", ")}, not ${repo}`);
  const priority = text("priority");
  if (priority !== undefined && !(PRIORITIES as readonly string[]).includes(priority)) throw new Error(`priority must be one of ${PRIORITIES.join(", ")}, not ${priority}`);
  const parent = text("parent");
  if (parent !== undefined && !TICKET_KEY.test(parent)) throw new Error(`parent must be a ticket's key, such as A11-12, not ${parent}`);
  return Object.fromEntries(Object.entries({ project: text("project"), repo, goal: text("goal"), priority, parent }).filter(([, value]) => value !== undefined));
}

/** What the routes act on: the settings and seams, the queue's store, the pool, the tickets the page last read, and the functions that make a queue change. */
type Board = Readonly<{
  deps: BoardDeps;
  settings: TicketSettings;
  source: TicketSource;
  store: { get: () => Queue; set: (next: Queue) => void };
  pool: NonNullable<BoardDeps["pool"]>;
  now: () => number;
  known: { tickets: Map<string, Ticket> };
  plans: boolean;
  wake: () => void;
  queueTickets: (tickets: readonly Ticket[], choice: RunChoice, options: { plan: boolean }) => void;
  whoAmI: () => Promise<Assignee | null>;
  terminalAddress: () => Promise<string | null>;
  scopesOnDemand: () => boolean;
  whoHolds: () => Promise<People>;
}>;

/** The queue as the page reads it: the stored queue, and why runs are held (`tickets.preflight`), or null while none is. The page's one picture of what the board is doing. */
function queueView(board: Pick<Board, "store" | "pool">) {
  return { ...board.store.get(), held: board.pool.held?.() ?? null };
}

/** A new-ticket request as the page shows it: its status, and the tickets its drafts made, with their keys. Its drafts stay on the board. */
function writerViewOf(run: WriterRun) {
  const { drafts, ...shown } = run;
  const tickets = drafts.flatMap(({ file, status, created, warnings }) => (status === "created" && created !== undefined
    ? [{ file, key: created.key, url: created.url, inPick: created.inPick !== false, warnings: warnings ?? [] }] : []));
  return { ...shown, status: writerStatus(run), tickets };
}

/** The new-ticket requests, each with its status, as the page shows them. */
function writersViewOf(queue: Queue) {
  return { runs: (queue.writers ?? []).map(writerViewOf) };
}

/** The GET routes: the board's config, the Pick lists, the queue and the new-ticket requests. `undefined` when no route here names the request. */
async function readRoute(board: Board, method: string, path: string, query: URLSearchParams): Promise<[number, unknown] | undefined> {
  const { deps, settings, source, store, known, plans } = board;
  if (method === "GET" && path === "/api/config") {
    // `pickDefault` is the Assignee filter's first choice: the key's own tickets, or every open one. `pickOpen` is what Anyone reads as in the count.
    // `viewer` is the key's person, or null while the tracker cannot say: an instance that sends it names assignees, one that does not is older.
    return [200, { models: MODELS, efforts: EFFORTS, choice: readChoice(deps.choicePath), max: store.get().max, terminal: await board.terminalAddress(), plan: settings.plan, planner: plans,
      publish: settings.publish !== null, pick: pickLabel(settings.pick), pickDefault: settings.pick === "assigned" ? "you" : "anyone", scopes: board.scopesOnDemand(),
      pickOpen: settings.pick === "assigned" ? "open" : pickLabel(settings.pick), viewer: await board.whoAmI(),
      writer: settings.writer !== null, writerDefault: settings.writer === null ? null : { model: settings.writer.model, effort: settings.writer.effort },
      writerGrill: settings.terminal !== null, repos: Object.keys(settings.clones), priorities: PRIORITIES }];
  }
  if (method === "GET" && path === "/api/pick") {
    // Asked only by a Pick view whose list came back empty, so the name of the key's person costs a request only then. A tracker that cannot
    // say whose key it is, or cannot be asked, leaves the text saying "you": the empty list still names its setting.
    const user = settings.pick === "assigned" && source.viewer ? await source.viewer().catch(() => null) : null;
    return [200, { empty: pickEmptyText(settings.pick, user) }];
  }
  if (method === "GET" && path === "/api/people") {
    if (!board.scopesOnDemand()) return [404, { error: "this instance lists every ticket it has at once, so it counts nobody separately" }];
    return [200, await board.whoHolds()];
  }
  if (method === "GET" && path === "/api/tickets" && query.has("assignee")) {
    // One page of the scope the Assignee row chose, with the cursor of the next: Anyone and Unassigned can hold thousands of tickets, past what one answer carries.
    if (!board.scopesOnDemand()) return [404, { error: "this instance lists every ticket it has at once, so a scope is not read on its own" }];
    const page = await source.scoped!(query.get("assignee") ?? "", query.get("after"));
    for (const ticket of page.tickets) known.tickets.set(ticket.key, ticket);
    return [200, page];
  }
  if (method === "GET" && path === "/api/tickets") {
    const tickets = await source.assigned();
    known.tickets = new Map(tickets.map((ticket) => [ticket.key, ticket]));
    return [200, tickets];
  }
  if (method === "GET" && path === "/api/parents") {
    // The parents of the listed tickets that are not listed themselves, so the Pick list can nest under them whatever scope it shows. One the
    // tracker cannot read is left out, and its children stand on their own.
    const missing = [...new Set([...known.tickets.values()].flatMap((t) => (t.parent && !known.tickets.has(t.parent) ? [t.parent] : [])))];
    const read = await Promise.allSettled(missing.map((key) => source.read(key)));
    return [200, read.flatMap((r) => (r.status === "fulfilled" && r.value !== null ? [r.value] : []))];
  }
  if (method === "GET" && path === "/api/queue") return [200, queueView(board)];
  if (method === "GET" && path === "/api/writer") return [200, writersViewOf(store.get())];
  return undefined;
}

/** The POST routes that queue tickets, save the choice and settings, change the queue's pause and cap, and mint the terminal's pairing code. */
async function postRoute(board: Board, method: string, path: string, body: Json): Promise<[number, unknown] | undefined> {
  const { deps, settings, source, store, known, now, wake, queueTickets } = board;
  if (method === "POST" && path === "/api/terminal-pair") {
    // Minted here, on the terminal's own machine, and handed to the page's service only for a paired browser that follows a worker link (A11-93).
    if (deps.mintTerminal !== undefined) return [200, await deps.mintTerminal()];
    const tailnetName = settings.serve === null || deps.tailnet === undefined ? null : await deps.tailnet();
    return [200, await mintTerminalCode(settings, localTerminalPort(settings.terminal, tailnetName), { home: homedir(), read: readOrNull, request: fetch, timeoutMs: TERMINAL_PAIR_MS })];
  }
  if (method === "POST" && path === "/api/queue") {
    const choice = validRunChoice(body);
    const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
    const tickets: Ticket[] = [];
    for (const key of keys) {
      const ticket = known.tickets.get(key) ?? await source.read(key);
      if (ticket === null) throw new Error(`no ticket ${key}`);
      tickets.push(ticket);
    }
    queueTickets(tickets, choice, { plan: body.plan === true });
    return [200, queueView(board)];
  }
  if (method === "POST" && path === "/api/queue-children") {
    // A parent is never queued itself (`queue.ts`'s `refuseParents`): this queues its open sub-issues in its place (A11-76). The parent is
    // read afresh, so a sub-issue finished since the list was read is not queued; one the list holds is not read again. The order is the
    // tracker's blocking relations among them where it can say, or identifier order, which the answer's note then names. A sub-issue that
    // is itself a parent is left out, and named: its own row offers its children. One already on the queue keeps its place.
    const choice = validRunChoice(body);
    const key = String(body.key ?? "");
    const parent = await source.read(key);
    if (parent === null) throw new Error(`no ticket ${key}`);
    const children = parent.children ?? [];
    if (children.length === 0) throw new Error(`${key} has no open sub-issues: queue it as it is`);
    const order = childOrder(children, source.blockers ? await source.blockers(children) : null);
    const read: Ticket[] = [];
    for (const child of order.keys) {
      const ticket = known.tickets.get(child) ?? await source.read(child);
      if (ticket === null) throw new Error(`no ticket ${child}, a sub-issue of ${key}`);
      read.push(ticket);
    }
    const nested = read.filter((ticket) => (ticket.children?.length ?? 0) > 0).map((ticket) => ticket.key);
    const tickets = read.filter((ticket) => !nested.includes(ticket.key));
    queueTickets(tickets, choice, { plan: body.plan === true });
    const left = nested.length === 0 ? null : `${nested.join(", ")} ${nested.length === 1 ? "is itself a parent" : "are themselves parents"}, so not queued: queue ${nested.length === 1 ? "its" : "their"} children from ${nested.length === 1 ? "its" : "their"} own row`;
    const note = [order.note, left].filter((part) => part !== null).join("; ") || null;
    return [200, { queue: queueView(board), keys: tickets.map((ticket) => ticket.key), note }];
  }
  if (method === "POST" && path === "/api/choice") {
    // Only the part named is changed, so two pages open at once cannot undo each other's other half.
    const change = validChange(body, ["model", "effort", "planModel", "planEffort", "writerModel", "writerEffort"]);
    if (Object.keys(change).length === 0) throw new Error("name a model or an effort to change");
    const choice = applyChange(readChoice(deps.choicePath), change);
    writeChoice(deps.choicePath, choice);
    return [200, { choice }];
  }
  if (method === "POST" && path === "/api/publish") {
    if (settings.publish === null) throw new Error("this machine names no tickets.publish, so it publishes nothing");
    store.set(queuePublish(store.get(), Array.isArray(body.keys) ? body.keys.map(String) : [], now()));
    wake();
    return [200, queueView(board)];
  }
  if (method === "POST" && path === "/api/paused") {
    if (typeof body.paused !== "boolean") throw new Error("paused must be true or false");
    store.set(body.paused ? pauseQueue(store.get()) : resumeQueue(store.get()));
    wake();
    return [200, queueView(board)];
  }
  if (method === "POST" && path === "/api/max") {
    store.set(setMax(store.get(), Number(body.max)));
    wake();
    return [200, queueView(board)];
  }
  return undefined;
}

/** The new-ticket request routes: a request is queued, and a run is stopped or dismissed. The board makes the tickets when a run's drafts are read. */
async function writerRoute(board: Board, method: string, path: string, body: Json): Promise<[number, unknown] | undefined> {
  const { deps, settings, source, store, pool, now, wake } = board;
  if (method === "POST" && path === "/api/writer") {
    // A new-ticket request: a run of the ticket writer, which leaves drafts, and the board makes a ticket from each one when the run ends.
    if (settings.writer === null) throw new Error("this machine names no tickets.writer, so it writes no tickets: name one in the host file");
    const request = typeof body.request === "string" ? body.request.trim() : "";
    if (request === "" || request.length > WRITER_REQUEST_CHARS) throw new Error(`a request is 1 to ${WRITER_REQUEST_CHARS} characters`);
    const mode = body.mode === undefined ? "quick" : body.mode;
    if (mode !== "quick" && mode !== "grill") throw new Error("mode must be \"quick\" or \"grill\"");
    if (mode === "grill" && settings.terminal === null) throw new Error("grill needs tickets.terminal, where the run's terminal opens: name it in the host file, or choose quick");
    const form = writerForm(body, settings);
    if (form.parent !== undefined && (await source.read(form.parent)) === null) throw new Error(`no ticket ${form.parent}`);
    // The model and effort are read now and stamped on the request, so a change in Settings reaches the next request, and this one keeps its own.
    const saved = readChoice(deps.choicePath);
    const model = saved.writerModel ?? settings.writer.model;
    const effort = saved.writerEffort ?? settings.writer.effort;
    store.set(queueWriter(store.get(), { id: `w${now().toString(36)}`, request, mode, form, model, effort }, now()));
    wake();
    return [200, writersViewOf(store.get())];
  }
  const writer = /^\/api\/writer\/([A-Za-z0-9_-]+)\/(stop|dismiss)$/.exec(path);
  if (method === "POST" && writer) {
    const [, run, verb] = writer;
    if (writerOf(store.get(), run) === undefined) throw new Error(`no new-ticket request ${run}`);
    if (verb === "stop") pool.stopWriterRun(run);
    if (verb === "dismiss") store.set(dismissWriter(store.get(), run));
    wake();
    return [200, writersViewOf(store.get())];
  }
  return undefined;
}

/** The routes that act on one queued run: amend, remove, retry, approve, respond, stop, close, dismiss, and apply or discard its edit. */
async function queueActionRoute(board: Board, method: string, path: string, body: Json): Promise<[number, unknown] | undefined> {
  const { store, pool, now, wake } = board;
  const action = /^\/api\/queue\/([A-Za-z0-9_-]+)\/(amend|remove|retry|approve|respond|stop|close|dismiss|apply-edit|discard-edit)$/.exec(path);
  if (method === "POST" && action) {
    const [, key, verb] = action;
    if (verb === "amend") store.set(amend(store.get(), key, validChange(body, ["model", "effort"])));
    // The pool's, like Dismiss: a queued run's ticket is put back before the run leaves the queue.
    if (verb === "remove") await pool.remove(key);
    if (verb === "retry") store.set(retry(store.get(), key, now()));
    if (verb === "approve") store.set(approve(store.get(), key, now()));
    if (verb === "respond") store.set(respond(store.get(), key, now()));
    if (verb === "stop") pool.stop(key);
    if (verb === "close") pool.close(key);
    // The pool's, like Close: a parked run's workspace is closed before the run leaves the board.
    if (verb === "dismiss") await pool.dismiss(key);
    // The pool's: Apply re-reads the ticket before it writes, and Discard drops the proposal the queue holds (A11-91). Only a person's request does either.
    if (verb === "apply-edit") await pool.applyEdit(key);
    if (verb === "discard-edit") pool.discardEdit(key);
    wake();
    return [200, queueView(board)];
  }
  return undefined;
}

/** The route table: each request is answered by the first group that names its method and path, and a path none names is a 404. */
async function routeApi(board: Board, method: string, path: string, body: Json, query: URLSearchParams): Promise<[number, unknown]> {
  return (await readRoute(board, method, path, query))
    ?? (await postRoute(board, method, path, body))
    ?? (await writerRoute(board, method, path, body))
    ?? (await queueActionRoute(board, method, path, body))
    ?? [404, { error: `no route ${method} ${path}` }];
}

/** The request handler, with every dependency named, so a test drives it without a socket. */
export function createBoard(deps: BoardDeps) {
  const { settings, source, key } = deps;
  const now = deps.now ?? Date.now;
  let queue: Queue = loadQueue(deps.queuePath, settings.max);
  const store = { get: () => queue, set: (next: Queue) => { queue = next; saveQueue(deps.queuePath, next); } };
  const pool = deps.pool ?? createPool(store, { ...deps.poolDeps, settings, source, hook: { node: process.execPath, bin: BIN } });
  const known = { tickets: new Map<string, Ticket>() };
  let warnedNoName = false;
  let viewer: Assignee | null = null;

  /**
   * The person whose key this is, read once and kept for the life of the instance. A failure is null and is asked again on the next config read,
   * so a tracker that is down at start-up does not hide the Assignee filter for ever. A source without `me` has no one to name.
   */
  async function whoAmI(): Promise<Assignee | null> {
    if (viewer === null && source.me !== undefined) viewer = await source.me().catch(() => null);
    return viewer;
  }

  /** Whether the Assignee row can reach tickets beyond the key's own, one scope at a time: the default list is the key's own, and the source can read the rest. */
  const scopesOnDemand = (): boolean => settings.pick === "assigned" && source.people !== undefined && source.scoped !== undefined;

  /** Who holds the open tickets, read once in a while: it takes about 12 s on a workspace of 7,000 tickets. Asked again after PEOPLE_FRESH_MS, and never twice at once. */
  let people: { at: number; value: People } | null = null;
  let peopleReading: Promise<People> | null = null;
  async function whoHolds(): Promise<People> {
    if (people !== null && Date.now() - people.at < PEOPLE_FRESH_MS) return people.value;
    peopleReading ??= source.people!().then((value) => { people = { at: Date.now(), value }; return value; }).finally(() => { peopleReading = null; });
    return peopleReading;
  }

  /**
   * The terminal address the page is handed. Served on the tailnet, it is the tailnet's address unless the stored one names another machine. When the
   * name cannot be read, the stored address is handed over, and the reason is logged once.
   */
  async function terminalAddress(): Promise<string | null> {
    if (settings.serve === null) return settings.terminal;
    const name = deps.tailnet === undefined ? null : await deps.tailnet();
    if (name === null && !warnedNoName) {
      warnedNoName = true;
      process.stderr.write("ticket:serve: the tailnet name cannot be read from `tailscale status --json`, so the board is handed the stored terminal address\n");
    }
    return effectiveTerminal(settings.terminal, name === null ? null : tailnetTerminal({ name, port: settings.serve.terminal }));
  }

  const wake = () => { void pool.tick(); };
  /** Add tickets to the queue as Queue does, with `choice`, and planned first when `plan` is on, then wake the pool. The one place a queue add is made. */
  function queueTickets(tickets: readonly Ticket[], choice: RunChoice, { plan }: { plan: boolean; }): void {
    store.set(enqueue(queue, tickets, choice, now(), plan ? planFirst(tickets) : null));
    wake();
  }
  /** Whether this board plans a ticket first: the machine names a planner, and the tracker can take the plan it writes. */
  const plans = settings.planner !== null && settings.plan !== null && source.attachPlan !== undefined;

  /**
   * Which of `tickets` to plan before they are worked, and on what: each without a plan of its own, when this board plans at all. They are
   * planned together when the planner plans batches.
   */
  function planFirst(tickets: readonly Ticket[]): PlanFirst | null {
    if (!plans || settings.plan === null) return null;
    const pattern = new RegExp(settings.plan);
    const { planModel, planEffort } = readChoice(deps.choicePath);
    return { keys: new Set(tickets.filter((ticket) => !hasPlan(ticket, pattern)).map((ticket) => ticket.key)), choice: { model: planModel, effort: planEffort },
      batch: plansInBatches(settings.planner) };
  }

  const board: Board = { deps, settings, source, store, pool, now, known, plans, wake, queueTickets, whoAmI, terminalAddress, scopesOnDemand, whoHolds };

  async function api(method: string, path: string, body: Json, query = new URLSearchParams()): Promise<[number, unknown]> {
    return routeApi(board, method, path, body, query);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refused = refusal(request, settings.port);
    if (refused !== null) return sendJson(response, 403, { error: refused });
    if (!holdsKey(request, key)) {
      return sendJson(response, 401, { error: "this is an agent-org instance, which serves no page and answers only to its key: open the board with agent-org ticket:ui" });
    }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${settings.port}`);
    try {
      const body = request.method === "POST" ? await readJson(request, API_BODY_BYTES) : {};
      const [status, value] = await api(request.method ?? "GET", url.pathname, body, url.searchParams);
      sendJson(response, status, value);
    } catch (err) {
      sendJson(response, 400, { error: String((err as Error)?.message ?? err) });
    }
  }

  return { handle, api, pool, store };
}

/**
 * The child's program (A11-84): load the host module and run the start-up check of the routing wrapper. A process boundary keeps the gate's closure out of this instance, as
 * `work-gate.ts` does for `host:check`, and a host the module cannot load on (no declaration of its project) is one line on stderr, never a stack: the instance starts anyway.
 */
const STARTUP_PROGRAM = `import(${JSON.stringify(new URL("../host-units/gh-wrapper-and-notes.ts", import.meta.url).href)})`
  + ".then((host) => host.startupGhWrapper())"
  + ".catch((cause) => { process.stderr.write(`ERROR gh wrapper: cannot be checked (${String(cause?.message ?? cause).split(\"\\n\")[0]})\\n`); });";

/**
 * THE `gh` WRAPPER AT START-UP (A11-84): the installed wrapper is checked before the pool is made, because every worker's `gh` and the reviewer's token mint depend on
 * it. The check logs a divergence LOUDLY and re-renders the wrapper through the one guarded writer, and a refused re-render is logged and the instance starts anyway.
 * A child that cannot be run at all is logged here, so the instance never runs silent.
 */
export function checkGhWrapperAtStart({ err = (line: string) => process.stderr.write(line), run = (program: string) => spawnSync(process.execPath,
  ["--input-type=module", "-e", program], { stdio: ["ignore", "inherit", "inherit"], timeout: 120_000 }) }:
    { err?: (line: string) => void; run?: (program: string) => { status: number | null; error?: Error } } = {}): void {
  const child = run(STARTUP_PROGRAM);
  if (child.error === undefined && child.status === 0) return;
  const why = child.error?.message ?? `the check exited ${child.status}`;
  err(`ERROR gh wrapper: cannot be checked (${why.split("\n")[0]}), so the instance does not know its App identity is in place\n`);
}

/**
 * The sweeps the server runs on the feedback cadence, each on its own timer (A11-106): one that throws is said, and the others still run on theirs. `every` is
 * what schedules a sweep, which `serve` passes `setInterval` for, so a test sees each sweep and its interval without a timer.
 */
export function startFeedbackSweeps(pool: Pick<ReturnType<typeof createPool>, "watchFeedback" | "releaseReviewers" | "retargetStacked" | "rebaseStacked">,
  every: (run: () => void, ms: number) => unknown): void {
  const sweeps: { sweep: () => void | Promise<void>; failure: string }[] = [
    { sweep: () => pool.watchFeedback(), failure: "the pull requests' feedback could not be read" },
    // Its own sweep, not `watchFeedback`'s: that one returns early when no run is watched, and a merged run is no longer watched.
    { sweep: () => pool.releaseReviewers(), failure: "the reviewers of merged or closed pull requests could not be released" },
    // A stacked pull request is retargeted when its base merges, whether or not a run is watched.
    { sweep: () => pool.retargetStacked(), failure: "the stacked pull requests' bases could not be checked" },
    // The stacked branches are rebased when their blocker's branch moves (A11-116). Asynchronous, so a failure is said when it settles.
    { sweep: () => pool.rebaseStacked(), failure: "the stacked branches could not be rebased" },
  ];
  const said = (failure: string, err: unknown) => process.stderr.write(`ticket:serve: ${failure}: ${String((err as Error)?.message ?? err)}\n`);
  for (const { sweep, failure } of sweeps) {
    every(() => {
      try {
        const done = sweep();
        if (done instanceof Promise) done.catch((err: unknown) => said(failure, err));
      } catch (err) {
        said(failure, err);
      }
    }, FEEDBACK_MS);
  }
}

async function serve(): Promise<void> {
  // `--no-open` opened no browser when the instance served the page. It is still taken, so a script that passes it keeps working.
  refuseUnknownFlags(["--no-open"], { entry: import.meta.url, command: "agent-org ticket:serve" });
  const settings = readTicketSettings();
  // The gate's modules load only for an instance that starts reviewers, and before its pool is made, which reads them (`reviewer-port.ts`).
  if (startsReviewers(settings)) await loadReviewerGate();
  // A11-84: the routing wrapper is checked, and re-rendered when it has diverged, before the pool is made (see `checkGhWrapperAtStart`).
  checkGhWrapperAtStart();
  const source = linearSource({ key: readLinearKey(settings.linearKey), pick: settings.pick });
  const key = boardKey(boardKeyPath(settings.stateDir));
  const dir = join(settings.stateDir, "tickets");
  const tailnet = settings.serve === null ? undefined : cachedTailnetName(async () => readTailnetName(runTailscale));
  const board = createBoard({ settings, source, key, queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json"), tailnet });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(128 + constants.signals[signal]));
  await board.pool.ensureSession();
  board.pool.reconcile();
  // One request's failure ends that request, never the instance.
  const server = createServer((request, response) => {
    board.handle(request, response).catch((err) => {
      process.stderr.write(`ticket:serve: ${request.method} ${request.url?.split("?")[0]}: ${String((err as Error)?.message ?? err)}\n`);
      if (response.headersSent) response.destroy();
      else sendJson(response, 500, { error: "the instance failed to answer" });
    });
  });
  server.listen(settings.port, "127.0.0.1", () => {
    process.stdout.write(`ticket mode instance: 127.0.0.1:${settings.port}, which serves no page\n  open the board: agent-org ticket:ui\n`
      + `  watch the workers: herdr session attach ${settings.herdrSession}\n  worktrees under ${settings.worktreeRoot}\n`);
  });
  setInterval(() => { void board.pool.tick(); }, TICK_MS);
  void board.pool.refreshTracker();
  setInterval(() => { void board.pool.refreshTracker(); }, TRACKER_MS);
  startFeedbackSweeps(board.pool, (run, ms) => { setInterval(run, ms); });
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  serve().catch((err) => {
    process.stderr.write(`ticket:serve: ${String((err as Error)?.message ?? err)}\n`);
    process.exit(1);
  });
}
