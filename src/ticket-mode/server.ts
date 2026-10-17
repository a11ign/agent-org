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
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../lib/cli-flags.ts";
import { boardKey, boardKeyPath } from "./board-key.ts";
import { hasPlan } from "./board-view.ts";
import { linearSource, readLinearKey } from "./linear.ts";
import { API_BODY_BYTES, readJson, refusal, sameSecret, sendJson, type Json } from "./local-http.ts";
import { createPool, startsReviewers, type PoolDeps } from "./pool.ts";
import { loadReviewerGate } from "./reviewer-port.ts";
import { amend, approve, enqueue, loadQueue, queuePublish, remove, respond, retry, saveQueue, setMax, setPaused, type PlanFirst, type Queue, type RunChoice } from "./queue.ts";
import { plansInBatches, readTicketSettings, type TicketSettings } from "./settings.ts";
import type { Ticket, TicketSource } from "./source.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin.ts");
const TICK_MS = 30_000;
/** How often the tracker is asked whether finished runs' tickets are done. A merge is not urgent news, and every read is a Linear request. */
const TRACKER_MS = 120_000;
/** How often the open pull requests of runs Ready to merge are read for new feedback. Each is one GitHub request per pull request. */
const FEEDBACK_MS = 180_000;
const MODELS = ["opus", "sonnet", "haiku"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export type BoardDeps = Readonly<{
  settings: TicketSettings;
  source: TicketSource;
  key: string;
  queuePath: string;
  choicePath: string;
  pool?: Pick<ReturnType<typeof createPool>, "tick" | "stop" | "close" | "dismiss" | "reconcile" | "ensureSession" | "refreshTracker" | "watchFeedback">;
  poolDeps?: Omit<PoolDeps, "settings" | "source" | "hook">;
  now?: () => number;
}>;

/** Whether the request carries the instance's key in its `x-ticket-token` header. A cookie is never read. */
export function holdsKey(request: Pick<IncomingMessage, "headers">, key: string): boolean {
  const header = request.headers["x-ticket-token"];
  return header !== undefined && sameSecret(String(header), key);
}

/** The settings' choices: the model and effort a ticket queued from now on runs with, and those a ticket planned first is planned with. */
type SavedChoice = RunChoice & Readonly<{ planModel: string; planEffort: string }>;

/** Each part of the saved choice, with the rule its value is held to. */
const CHOICE_PARTS: Readonly<Record<keyof SavedChoice, (value: string) => void>> = { model: checkModel, effort: checkEffort, planModel: checkModel, planEffort: checkEffort };

/** The saved choice. A saved value the board no longer offers falls back, so queueing with the settings is never refused. */
function readChoice(path: string): SavedChoice {
  // Planning is the harder job, so it starts on the most capable model; the person changes either in Settings.
  const fallback: SavedChoice = { model: "opus", effort: "high", planModel: "opus", planEffort: "high" };
  if (!existsSync(path)) return fallback;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<SavedChoice>;
    const valid = (part: keyof SavedChoice, allowed: readonly string[]) => (allowed.includes(String(saved[part])) ? String(saved[part]) : fallback[part]);
    return { model: valid("model", MODELS), effort: valid("effort", EFFORTS), planModel: valid("planModel", MODELS), planEffort: valid("planEffort", EFFORTS) };
  } catch {
    return fallback;
  }
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

/** The request handler, with every dependency named, so a test drives it without a socket. */
export function createBoard(deps: BoardDeps) {
  const { settings, source, key } = deps;
  const now = deps.now ?? Date.now;
  let queue: Queue = loadQueue(deps.queuePath, settings.max);
  const store = { get: () => queue, set: (next: Queue) => { queue = next; saveQueue(deps.queuePath, next); } };
  const pool = deps.pool ?? createPool(store, { ...deps.poolDeps, settings, source, hook: { node: process.execPath, bin: BIN } });
  let known = new Map<string, Ticket>();

  const wake = () => { void pool.tick(); };
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

  async function api(method: string, path: string, body: Json): Promise<[number, unknown]> {
    if (method === "GET" && path === "/api/config") {
      return [200, { models: MODELS, efforts: EFFORTS, choice: readChoice(deps.choicePath), max: queue.max, terminal: settings.terminal, plan: settings.plan, planner: plans,
        publish: settings.publish !== null }];
    }
    if (method === "GET" && path === "/api/tickets") {
      const tickets = await source.assigned();
      known = new Map(tickets.map((ticket) => [ticket.key, ticket]));
      return [200, tickets];
    }
    if (method === "GET" && path === "/api/parents") {
      // The parents of the person's tickets that are not the person's own, so the Pick list can nest under them. One the tracker cannot
      // read is left out, and its children stand on their own.
      const missing = [...new Set([...known.values()].flatMap((t) => (t.parent && !known.has(t.parent) ? [t.parent] : [])))];
      const read = await Promise.allSettled(missing.map((key) => source.read(key)));
      return [200, read.flatMap((r) => (r.status === "fulfilled" && r.value !== null ? [r.value] : []))];
    }
    if (method === "GET" && path === "/api/queue") return [200, queue];
    if (method === "POST" && path === "/api/queue") {
      const choice = validRunChoice(body);
      const keys = Array.isArray(body.keys) ? body.keys.map(String) : [];
      const tickets: Ticket[] = [];
      for (const key of keys) {
        const ticket = known.get(key) ?? await source.read(key);
        if (ticket === null) throw new Error(`no ticket ${key}`);
        tickets.push(ticket);
      }
      store.set(enqueue(queue, tickets, choice, now(), body.plan === true ? planFirst(tickets) : null));
      wake();
      return [200, queue];
    }
    if (method === "POST" && path === "/api/choice") {
      // Only the part named is changed, so two pages open at once cannot undo each other's other half.
      const change = validChange(body, ["model", "effort", "planModel", "planEffort"]);
      if (Object.keys(change).length === 0) throw new Error("name a model or an effort to change");
      const choice = { ...readChoice(deps.choicePath), ...change };
      writeChoice(deps.choicePath, choice);
      return [200, { choice }];
    }
    if (method === "POST" && path === "/api/publish") {
      if (settings.publish === null) throw new Error("this machine names no tickets.publish, so it publishes nothing");
      store.set(queuePublish(queue, Array.isArray(body.keys) ? body.keys.map(String) : [], now()));
      wake();
      return [200, queue];
    }
    if (method === "POST" && path === "/api/paused") {
      if (typeof body.paused !== "boolean") throw new Error("paused must be true or false");
      store.set(setPaused(queue, body.paused));
      wake();
      return [200, queue];
    }
    if (method === "POST" && path === "/api/max") {
      store.set(setMax(queue, Number(body.max)));
      wake();
      return [200, queue];
    }
    const action = /^\/api\/queue\/([A-Za-z0-9_-]+)\/(amend|remove|retry|approve|respond|stop|close|dismiss)$/.exec(path);
    if (method === "POST" && action) {
      const [, key, verb] = action;
      if (verb === "amend") store.set(amend(queue, key, validChange(body, ["model", "effort"])));
      if (verb === "remove") store.set(remove(queue, key));
      if (verb === "retry") store.set(retry(queue, key, now()));
      if (verb === "approve") store.set(approve(queue, key, now()));
      if (verb === "respond") store.set(respond(queue, key, now()));
      if (verb === "stop") pool.stop(key);
      if (verb === "close") pool.close(key);
      if (verb === "dismiss") pool.dismiss(key);
      wake();
      return [200, queue];
    }
    return [404, { error: `no route ${method} ${path}` }];
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
      const [status, value] = await api(request.method ?? "GET", url.pathname, body);
      sendJson(response, status, value);
    } catch (err) {
      sendJson(response, 400, { error: String((err as Error)?.message ?? err) });
    }
  }

  return { handle, api, pool, store };
}

async function serve(): Promise<void> {
  // `--no-open` opened no browser when the instance served the page. It is still taken, so a script that passes it keeps working.
  refuseUnknownFlags(["--no-open"], { entry: import.meta.url, command: "agent-org ticket:serve" });
  const settings = readTicketSettings();
  // The gate's modules load only for an instance that starts reviewers, and before its pool is made, which reads them (`reviewer-port.ts`).
  if (startsReviewers(settings)) await loadReviewerGate();
  const source = linearSource({ key: readLinearKey(settings.linearKey) });
  const key = boardKey(boardKeyPath(settings.stateDir));
  const dir = join(settings.stateDir, "tickets");
  const board = createBoard({ settings, source, key, queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json") });
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
  setInterval(() => {
    try {
      board.pool.watchFeedback();
    } catch (err) {
      process.stderr.write(`ticket:serve: the pull requests' feedback could not be read: ${String((err as Error)?.message ?? err)}\n`);
    }
  }, FEEDBACK_MS);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  serve().catch((err) => {
    process.stderr.write(`ticket:serve: ${String((err as Error)?.message ?? err)}\n`);
    process.exit(1);
  });
}
