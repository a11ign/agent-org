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
import { hasPlan } from "./board-view/view-types-and-filters.ts";
import { readOrNull } from "../install/paths.ts";
import { effectiveTerminal, localTerminalPort } from "../install/terminal.ts";
import { mintTerminalCode, type TerminalMint, type TerminalRun, terminalRunOf } from "./terminal-pair.ts";
import { activatePlugins, realPluginDeps } from "../plugins/active.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import { pickEmptyText, pickLabel } from "./pick-scope.ts";
import { API_BODY_BYTES, readJson, refusal, sameSecret, sendJson, type Json } from "./local-http.ts";
import { createPool, startsReviewers, type PoolDeps } from "./pool.ts";
import { gateReviewJudge, loadReviewerGate } from "./reviewer-port.ts";
import { takenRefusal, takenState } from "./pick-taken.ts";
import { amend, childOrder, enqueue, retry, type PlanFirst, type Queue, type RunChoice, type WriterRun, writerStatus } from "./queue/queue-entries-and-outcomes.ts";
import { approve, queuePublish, setMax, pauseQueue, resumeQueue, startAnyway } from "./queue/queue-transitions.ts";
import { dismissWriter, loadQueue, queueWriter, saveQueue, writerOf } from "./queue.ts";
import { hostFilePath, plansInBatches, readTicketSettings, type TicketSettings } from "./settings.ts";
import { EFFORTS, MODELS, readSettingsView } from "./settings-read.ts";
import { type Change, type EditFile, previewEdit, restoreBackup, saveEdit } from "./settings-edit.ts";
import { isObject } from "./json-value.ts";
import { cachedTailnetName, readTailnetName, runTailscale, tailnetTerminal } from "./tailnet.ts";
import type { Assignee, People, Ticket, TicketSource } from "./source.ts";
import type { CodeHost } from "../plugins/contracts/code-host.ts";
import { PRIORITIES } from "./writer.ts";
import { type NeedsDecision, needsDecision } from "./open-decisions.ts";

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

export type BoardDeps = Readonly<{
  settings: TicketSettings;
  source: TicketSource;
  /** The enabled code host plugin's implementation, which the pool reads every pull request through (A11-160). */
  codeHost: CodeHost;
  key: string;
  /** The host file the Settings page reads, fresh on each request: `AGENT_ORG_HOST`'s file when unset. */
  hostPath?: string;
  queuePath: string;
  choicePath: string;
  pool?: Pick<ReturnType<typeof createPool>, "tick" | "stop" | "close" | "dismiss" | "remove" | "respond" | "reconcile" | "ensureSession" | "refreshTracker" | "watchFeedback" | "releaseReviewers" | "retargetStacked" | "rebaseStacked" | "applyEdit" | "discardEdit" | "stopWriterRun" | "reviewNewHeads"> & Partial<Pick<ReturnType<typeof createPool>, "held" | "pullReviews" | "talk">>;
  poolDeps?: Omit<PoolDeps, "settings" | "source" | "codeHost" | "hook">;
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

/**
 * A ticket as the page is sent it: with `needsDecision` where it holds an open decision or an ungrilled screen (`open-decisions.ts`). The page is not sent
 * a description to work it out from, so the server says it (A11-134).
 */
function withDecision(ticket: Ticket): Ticket & Readonly<{ needsDecision?: NeedsDecision }> {
  const open = needsDecision(ticket);
  return open === null ? ticket : { ...ticket, needsDecision: open };
}

/**
 * A ticket as the page is sent it, with `taken` where another instance holds it (A11-144): this instance holds no run for it and the tracker shows it in a
 * taken state, so Pick shows the state and does not let the ticket be queued here.
 */
function withTaken(board: Pick<Board, "settings" | "store">, ticket: Ticket): Ticket & Readonly<{ taken?: string }> {
  const held = board.store.get().entries.some((entry) => entry.ticket.key === ticket.key);
  const state = held ? null : takenState(ticket, board.settings.takenStates);
  return state === null ? ticket : { ...ticket, taken: state };
}

/** The first of `tickets` another instance holds, as the sentence a queue route refuses with, or null when none is (A11-144). */
function refuseTaken(board: Pick<Board, "settings" | "store">, tickets: readonly Ticket[]): string | null {
  for (const ticket of tickets) {
    const { taken } = withTaken(board, ticket);
    if (taken !== undefined) return takenRefusal(ticket.key, taken);
  }
  return null;
}

/**
 * The ticket a queue route adds: the page's copy, unless that copy still holds an open decision, which a Grill may have settled since, so the tracker is read
 * again (A11-134). Throws when the tracker has no such ticket: `of` names the parent it is a sub-issue of, when it is one.
 */
async function queuedTicket({ known, source }: Pick<Board, "known" | "source">, key: string, of?: string): Promise<Ticket> {
  const copy = known.tickets.get(key);
  if (copy !== undefined && needsDecision(copy) === null) return copy;
  const fresh = await source.read(key);
  if (fresh === null) throw new Error(of === undefined ? `no ticket ${key}` : `no ticket ${key}, a sub-issue of ${of}`);
  return fresh;
}

/** The queue as the page reads it: the stored queue, and why runs are held (`tickets.preflight`), or null while none is. The page's one picture of what the board is doing. */
function queueView(board: Pick<Board, "store" | "pool">) {
  // `pulls`: the review state of each open pull request the pool has read, by url, as the board words it (A11-119). `writers`: each run as the page
  // is sent it, without a Grill run's ticket text (A11-134).
  const queue = board.store.get();
  return { ...queue, writers: (queue.writers ?? []).map(shownWriter), held: board.pool.held?.() ?? null, pulls: board.pool.pullReviews?.() ?? {} };
}

/** A new-ticket request as the page shows it: its status, and the tickets it filed, each with its key and address (A11-135). */
function writerViewOf(run: WriterRun) {
  return { ...shownWriter(run), status: writerStatus(run) };
}

/** A new-ticket run without its Grill's ticket text: the board keeps that text to compare, and the page is not sent it (A11-134). */
function shownWriter(run: WriterRun): Omit<WriterRun, "startedFrom"> {
  const { startedFrom: _startedFrom, ...shown } = run;
  return shown;
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
  if (method === "GET" && path === "/api/settings") {
    // The read-only Settings page: each file read fresh, so a refusal names its field, and the instance's own queue and choice (A11-131).
    return [200, await readSettingsView({ hostPath: deps.hostPath ?? hostFilePath(), settings, queuePath: deps.queuePath, queueMax: store.get().max,
      choicePath: deps.choicePath, ...(deps.poolDeps?.pluginRecord === undefined ? {} : { pluginRecord: deps.poolDeps.pluginRecord }) })];
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
    return [200, { ...page, tickets: page.tickets.map((ticket) => withTaken(board, withDecision(ticket))) }];
  }
  if (method === "GET" && path === "/api/tickets") {
    const tickets = await source.assigned();
    known.tickets = new Map(tickets.map((ticket) => [ticket.key, ticket]));
    return [200, tickets.map((ticket) => withTaken(board, withDecision(ticket)))];
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

/**
 * Whether the run that holds the terminal a worker link names has ended, as the board holds it (A11-129). The page's service asks this before it sends
 * a paired browser on, and a board with no terminal names none.
 */
async function terminalRunFor(board: Board, body: Json): Promise<TerminalRun> {
  const template = await board.terminalAddress();
  const link = typeof body.link === "string" ? body.link : "";
  return template === null ? { state: "unknown" } : terminalRunOf(board.store.get(), template, link);
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
  if (method === "POST" && path === "/api/terminal-run") return [200, await terminalRunFor(board, body)];
  if (method === "POST" && path === "/api/queue") {
    const choice = validRunChoice(body);
    const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
    const tickets: Ticket[] = [];
    for (const key of keys) tickets.push(await queuedTicket(board, key));
    const refused = refuseTaken(board, tickets);
    if (refused !== null) return [409, { error: refused }];
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
    for (const child of order.keys) read.push(await queuedTicket(board, child, key));
    const nested = read.filter((ticket) => (ticket.children?.length ?? 0) > 0).map((ticket) => ticket.key);
    // A sub-issue with an open decision is left out too, and named: a Grill on its own row settles it first (A11-134).
    const undecided = read.filter((ticket) => !nested.includes(ticket.key) && needsDecision(ticket) !== null).map((ticket) => ticket.key);
    const tickets = read.filter((ticket) => !nested.includes(ticket.key) && !undecided.includes(ticket.key));
    const refused = refuseTaken(board, tickets);
    if (refused !== null) return [409, { error: refused }];
    queueTickets(tickets, choice, { plan: body.plan === true });
    const left = nested.length === 0 ? null : `${nested.join(", ")} ${nested.length === 1 ? "is itself a parent" : "are themselves parents"}, so not queued: queue ${nested.length === 1 ? "its" : "their"} children from ${nested.length === 1 ? "its" : "their"} own row`;
    const held = undecided.length === 0 ? null : `${undecided.join(", ")} ${undecided.length === 1 ? "holds" : "hold"} an open decision, so not queued: Grill ${undecided.length === 1 ? "it" : "them"} first`;
    const note = [order.note, left, held].filter((part) => part !== null).join("; ") || null;
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
    if (settings.publish === null) throw new Error("this machine names no tickets.publish (or its publisher is disabled), so it publishes nothing");
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
  if (method === "POST" && path === "/api/grill-ticket") {
    // A Grill on a ticket that holds an open decision, or a screen's behaviour to grill (A11-134): the New ticket Grill in a terminal, with the ticket on the run.
    // The run files nothing; its answers are written into the ticket when it ends decided (`pool-board-runs.ts`).
    if (settings.writer === null) throw new Error("this machine names no tickets.writer, so it writes no tickets: name one in the host file");
    if (settings.terminal === null) throw new Error("Grill needs a terminal: name tickets.terminal in the host file");
    const key = String(body.key ?? "");
    if (!TICKET_KEY.test(key)) throw new Error(`key must be a ticket's key, such as A11-12, not ${key}`);
    const ticket = await source.read(key);
    if (ticket === null) throw new Error(`no ticket ${key}`);
    if (needsDecision(ticket) === null) throw new Error(`${key} has no open decision and no screen behaviour to grill`);
    const saved = readChoice(deps.choicePath);
    const model = saved.writerModel ?? settings.writer.model;
    const effort = saved.writerEffort ?? settings.writer.effort;
    store.set(queueWriter(store.get(), { id: `w${now().toString(36)}`, request: `Grill ${key}`, mode: "grill", form: {}, model, effort, ticket: key,
      startedFrom: ticket.description }, now()));
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

/** The file a Settings edit names: the host file or the primary project's declaration, and no other. */
function editFileOf(value: unknown): EditFile {
  if (value === "host.json" || value === "project.json") return value;
  throw new Error("file must be host.json or project.json");
}

/** The changes a Settings edit names: each a key with its value, or with `remove: true`. */
function changesOf(value: unknown): Change[] {
  if (!Array.isArray(value)) throw new Error("changes must be a list of { key, value } or { key, remove: true }");
  return value.map((change): Change => {
    if (!isObject(change) || typeof change.key !== "string") throw new Error("each change names a key");
    if (change.remove === true) return { key: change.key, remove: true };
    if (change.value === undefined) throw new Error(`${change.key} names no value, and is not removed`);
    return { key: change.key, value: change.value };
  });
}

/**
 * The Settings page's edits: a preview, a save and a restore of one file, each checked by the readers (`settings-edit.ts`). They sit beside the other
 * writes, so they are behind the instance's key and its same-origin refusal, and a file is named here by its kind, never by a path a request gives.
 */
async function settingsEditRoute(board: Board, method: string, path: string, body: Json): Promise<[number, unknown] | undefined> {
  const edit = /^\/api\/settings\/(preview|save|restore)$/.exec(path);
  if (method !== "POST" || !edit) return undefined;
  const options = { hostPath: board.deps.hostPath ?? hostFilePath(), queuePath: board.deps.queuePath };
  const file = editFileOf(body.file);
  if (edit[1] === "restore") return [200, await restoreBackup(options, file)];
  const changes = changesOf(body.changes);
  if (edit[1] === "preview") return [200, await previewEdit(options, file, changes)];
  const confirmed = Array.isArray(body.confirmed) ? body.confirmed.map(String) : [];
  return [200, await saveEdit(options, file, changes, { base: String(body.base ?? ""), confirmed })];
}

/** The routes that act on one queued run: amend, remove, retry, approve, respond, start anyway, stop, close, dismiss, and apply or discard its edit. */
async function queueActionRoute(board: Board, method: string, path: string, body: Json): Promise<[number, unknown] | undefined> {
  const { store, pool, now, wake } = board;
  const action = /^\/api\/queue\/([A-Za-z0-9_-]+)\/(amend|remove|retry|approve|respond|talk|start-anyway|stop|close|dismiss|apply-edit|discard-edit)$/.exec(path);
  if (method === "POST" && action) {
    const [, key, verb] = action;
    if (verb === "amend") store.set(amend(store.get(), key, validChange(body, ["model", "effort"])));
    // The pool's, like Dismiss: a queued run's ticket is put back before the run leaves the queue.
    if (verb === "remove") await pool.remove(key);
    if (verb === "retry") store.set(retry(store.get(), key, now()));
    if (verb === "approve") store.set(approve(store.get(), key, now()));
    // The pool's, like Close: a parked run's workspace is closed before its round is queued, and a refusal is named (A11-154).
    if (verb === "respond") pool.respond(key);
    // The pool's: a talk session needs a saved session to resume, and says so when there is none.
    if (verb === "talk") pool.talk?.(key);
    // A person's override of the overlap wait, which the board records on the run and logs (A11-125).
    if (verb === "start-anyway") {
      store.set(startAnyway(store.get(), key, now()));
      process.stderr.write(`ticket:serve: ${key} starts anyway: a person overrode its overlap with ${store.get().entries.find((e) => e.ticket.key === key)?.overlapOverride?.holder ?? "a run"}\n`);
    }
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
    ?? (await settingsEditRoute(board, method, path, body))
    ?? (await queueActionRoute(board, method, path, body))
    ?? [404, { error: `no route ${method} ${path}` }];
}

/** The request handler, with every dependency named, so a test drives it without a socket. */
export function createBoard(deps: BoardDeps) {
  const { settings, source, codeHost, key } = deps;
  const now = deps.now ?? Date.now;
  let queue: Queue = loadQueue(deps.queuePath, settings.max);
  const store = { get: () => queue, set: (next: Queue) => { queue = next; saveQueue(deps.queuePath, next); } };
  const pool = deps.pool ?? createPool(store, { ...deps.poolDeps, settings, source, codeHost, hook: { node: process.execPath, bin: BIN } });
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
export function startFeedbackSweeps(pool: Pick<ReturnType<typeof createPool>, "watchFeedback" | "releaseReviewers" | "retargetStacked" | "rebaseStacked" | "reviewNewHeads">,
  every: (run: () => void, ms: number) => unknown): void {
  const sweeps: { sweep: () => void | Promise<void>; failure: string }[] = [
    { sweep: () => pool.watchFeedback(), failure: "the pull requests' feedback could not be read" },
    // Its own sweep, not `watchFeedback`'s: that one returns early when no run is watched, and a merged run is no longer watched.
    { sweep: () => pool.releaseReviewers(), failure: "the reviewers of merged or closed pull requests could not be released" },
    // A stacked pull request is retargeted when its base merges, whether or not a run is watched.
    { sweep: () => pool.retargetStacked(), failure: "the stacked pull requests' bases could not be checked" },
    // The stacked branches are rebased when their blocker's branch moves (A11-116). Asynchronous, so a failure is said when it settles.
    { sweep: () => pool.rebaseStacked(), failure: "the stacked branches could not be rebased" },
    // A reviewer on each new head of every open pull request, whatever its run is in (A11-119): not the watched runs' only.
    { sweep: () => pool.reviewNewHeads(), failure: "the reviewers of open pull requests could not be started" },
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
  // The tracker and the code host are the enabled plugins' (`plugins/linear` and `plugins/github`, unless the host file names others): a plugin the loader refuses refuses the start, by name.
  const active = await activatePlugins(settings.providers, defaultCatalog(), realPluginDeps({ env: process.env, stateDir: settings.stateDir, pick: settings.pick, clones: settings.clones, review: gateReviewJudge }));
  const source = active.tracker();
  const codeHost = active.codeHost();
  const key = boardKey(boardKeyPath(settings.stateDir));
  const dir = join(settings.stateDir, "tickets");
  const tailnet = settings.serve === null ? undefined : cachedTailnetName(async () => readTailnetName(runTailscale));
  const board = createBoard({ settings, source, codeHost, key, queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json"), tailnet });
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
