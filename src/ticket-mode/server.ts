#!/usr/bin/env node
// @ts-check
// command: ticket:serve -- ticket mode's board on 127.0.0.1: pick your assigned tickets, queue them to repositories, and watch the pool work them
//
// THE BOARD IS THE QUEUE'S ONE WRITER. The page, and anything else that talks to this API, asks the server to change the queue; the server applies
// the pure transition (`queue.ts`), saves the file and wakes the pool. The pool runs in this process.
//
// IT IS REACHABLE FROM THIS MACHINE ONLY, AND ONLY BY WHAT HAS PAIRED. It binds 127.0.0.1, and nothing secret goes in a URL. A script on this
// machine reads the board's key from its mode-600 file (`board-key.ts`) and sends it as `x-ticket-token`. A browser is shown a pairing page,
// where a one-time code that `ticket:pair` prints (`pairing.ts`) gets it a session of its own as an HttpOnly cookie that lasts a year
// (`browser-sessions.ts`). A `Host` that is not this server's is refused, which stops a DNS-rebinding page from reaching it, and a write from
// another origin is refused. The Linear key never leaves this process.
import { createHash, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../lib/cli-flags.ts";
import { boardKey, boardKeyPath } from "./board-key.ts";
import { hasPlan } from "./board-view.ts";
import { browserSessions, browserSessionsPath, SESSION_SECONDS, type BrowserSessions } from "./browser-sessions.ts";
import { linearSource, readLinearKey } from "./linear.ts";
import { createPairing, PAIR_MINUTES, type Pairing } from "./pairing.ts";
import { createPool, type PoolDeps } from "./pool.ts";
import { amend, enqueue, loadQueue, remove, retry, saveQueue, setMax, setPaused, type Queue, type RunChoice } from "./queue.ts";
import { readTicketSettings, type TicketSettings } from "./settings.ts";
import type { Ticket, TicketSource } from "./source.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "ui.html");
/** What a browser that has not paired is shown, in place of the board. */
const PAIR_PAGE = join(HERE, "pair.html");
/** The page's logic, written in TypeScript so its tests run it, and sent to the browser with the types stripped. */
const VIEW = join(HERE, "board-view.ts");
const BIN = join(HERE, "..", "bin.ts");
const COOKIE = "ticket_session";
/** The most a pairing request may send. It is read before the request is known to be anyone's, so it is kept small. */
const PAIR_BODY_BYTES = 1024;
/** The most any other request may send. The largest is a queue of ticket keys. */
const API_BODY_BYTES = 64 * 1024;
const TICK_MS = 30_000;
/** How often the tracker is asked whether finished runs' tickets are done. A merge is not urgent news, and every read is a Linear request. */
const TRACKER_MS = 120_000;
const MODELS = ["opus", "sonnet", "haiku"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

type Json = Record<string, unknown>;

export type BoardDeps = Readonly<{
  settings: TicketSettings;
  source: TicketSource;
  key: string;
  queuePath: string;
  choicePath: string;
  pool?: Pick<ReturnType<typeof createPool>, "tick" | "stop" | "close" | "reconcile" | "ensureSession" | "refreshTracker">;
  pairing?: Pairing;
  sessions?: BrowserSessions;
  poolDeps?: Omit<PoolDeps, "settings" | "source" | "hook">;
  now?: () => number;
}>;

/** `board-view.ts` as the browser can run it: Node's own type stripping, so what the tests ran is what the page runs. */
export function boardViewScript(read: (path: string) => string = (path) => readFileSync(path, "utf8")): string {
  return stripTypeScriptTypes(read(VIEW));
}

/**
 * What the request is paired by: the board's key in its `x-ticket-token` header, a paired browser's session in its cookie when it sends no
 * header, or nothing.
 */
export function pairedBy(request: Pick<IncomingMessage, "headers">, key: string, sessions: Pick<BrowserSessions, "holds">): "key" | "browser" | null {
  const header = request.headers["x-ticket-token"];
  if (header !== undefined) return sameSecret(String(header), key) ? "key" : null;
  const cookie = String(request.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return cookie !== undefined && sessions.holds(cookie) ? "browser" : null;
}

/** Whether `given` is `expected`, in time that does not depend on where they differ. Comparing digests makes any two inputs the same length. */
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

function sendHtml(response: ServerResponse, path: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:" });
  response.end(readFileSync(path, "utf8"));
}

/** Why a request is refused before it is read, or `null`. PURE over the request's headers and this server's port. */
export function refusal(request: Pick<IncomingMessage, "headers" | "method">, port: number): string | null {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(String(request.headers.host ?? ""))) return "this server answers only to its own host";
  const origin = request.headers.origin;
  if (request.method !== "GET" && origin !== undefined && !hosts.map((host) => `http://${host}`).includes(String(origin))) return "a write from another origin";
  return null;
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
  const pairing = deps.pairing ?? createPairing(now);
  const sessions = deps.sessions ?? browserSessions(browserSessionsPath(settings.stateDir), now);
  let queue: Queue = loadQueue(deps.queuePath, settings.max);
  const store = { get: () => queue, set: (next: Queue) => { queue = next; saveQueue(deps.queuePath, next); } };
  const pool = deps.pool ?? createPool(store, { ...deps.poolDeps, settings, source, hook: { node: process.execPath, bin: BIN } });
  let known = new Map<string, Ticket>();

  const wake = () => { void pool.tick(); };
  /** Whether this board plans a ticket first: the machine names a planner, and the tracker can take the plan it writes. */
  const plans = settings.planner !== null && settings.plan !== null && source.attachPlan !== undefined;

  /** Which of `tickets` to plan before they are worked, and on what: each without a plan of its own, when this board plans at all. */
  function planFirst(tickets: readonly Ticket[]): Readonly<{ keys: ReadonlySet<string>; choice: RunChoice }> | null {
    if (!plans || settings.plan === null) return null;
    const pattern = new RegExp(settings.plan);
    const { planModel, planEffort } = readChoice(deps.choicePath);
    return { keys: new Set(tickets.filter((ticket) => !hasPlan(ticket, pattern)).map((ticket) => ticket.key)), choice: { model: planModel, effort: planEffort } };
  }

  async function api(method: string, path: string, body: Json): Promise<[number, unknown]> {
    if (method === "GET" && path === "/api/config") {
      return [200, { models: MODELS, efforts: EFFORTS, choice: readChoice(deps.choicePath), max: queue.max, terminal: settings.terminal, plan: settings.plan, planner: plans }];
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
    const action = /^\/api\/queue\/([A-Za-z0-9_-]+)\/(amend|remove|retry|stop|close)$/.exec(path);
    if (method === "POST" && action) {
      const [, key, verb] = action;
      if (verb === "amend") store.set(amend(queue, key, validChange(body, ["model", "effort"])));
      if (verb === "remove") store.set(remove(queue, key));
      if (verb === "retry") store.set(retry(queue, key, now()));
      if (verb === "stop") pool.stop(key);
      if (verb === "close") pool.close(key);
      wake();
      return [200, queue];
    }
    return [404, { error: `no route ${method} ${path}` }];
  }

  /** What a request that has not paired may do: see the pairing page, and trade a live code at `POST /pair` for a session of its own. */
  async function pairBrowser(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    if (request.method === "GET" && path === "/") return sendHtml(response, PAIR_PAGE);
    if (request.method !== "POST" || path !== "/pair") {
      return sendJson(response, 401, { error: `this browser is not paired: open http://127.0.0.1:${settings.port}/ and type the code agent-org ticket:pair prints` });
    }
    let body: Json;
    try {
      body = await readJson(request, PAIR_BODY_BYTES);
    } catch (err) {
      // Not a pairing request at all, so it spends none of the live code's tries.
      return sendJson(response, 400, { error: String((err as Error)?.message ?? err) });
    }
    if (!pairing.redeem(body.code)) return sendJson(response, 401, { error: "That code is wrong, used or out of date. Run agent-org ticket:pair for a new one." });
    sendJson(response, 200, { paired: true }, { "Set-Cookie": `${COOKIE}=${sessions.open()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}` });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refused = refusal(request, settings.port);
    if (refused !== null) return sendJson(response, 403, { error: refused });
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${settings.port}`);
    const by = pairedBy(request, key, sessions);
    if (by === null) return pairBrowser(request, response, url.pathname);
    // A code pairs a new browser, so only the key makes one. A browser's session, which can reach another port's server, cannot.
    if (request.method === "POST" && url.pathname === "/api/pair-code") {
      if (by !== "key") return sendJson(response, 403, { error: "a pairing code is made with the board's key: run agent-org ticket:pair" });
      return sendJson(response, 200, { code: pairing.mint(), minutes: PAIR_MINUTES });
    }
    if (request.method === "GET" && url.pathname === "/board-view.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      return void response.end(boardViewScript());
    }
    if (request.method === "GET" && url.pathname === "/") return sendHtml(response, PAGE);
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

/** A request's JSON object, or `{}` when it has no body. REFUSES a body over `limit` bytes, and one that is not a JSON object. */
async function readJson(request: IncomingMessage, limit: number): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error(`a request body over ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("a request body must be a JSON object");
  return value as Json;
}

async function serve(): Promise<void> {
  refuseUnknownFlags(["--no-open"], { entry: import.meta.url, command: "agent-org ticket:serve" });
  const settings = readTicketSettings();
  const source = linearSource({ key: readLinearKey(settings.linearKey) });
  const key = boardKey(boardKeyPath(settings.stateDir));
  const dir = join(settings.stateDir, "tickets");
  const pairing = createPairing();
  const board = createBoard({ settings, source, key, pairing, queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json") });
  await board.pool.ensureSession();
  board.pool.reconcile();
  // One request's failure ends that request, never the board.
  const server = createServer((request, response) => {
    board.handle(request, response).catch((err) => {
      process.stderr.write(`ticket:serve: ${request.method} ${request.url?.split("?")[0]}: ${String((err as Error)?.message ?? err)}\n`);
      if (response.headersSent) response.destroy();
      else sendJson(response, 500, { error: "the board failed to answer" });
    });
  });
  server.listen(settings.port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${settings.port}/`;
    // A code is printed only to a person's terminal. Run detached, the board's output goes to a log, which a code has no reason to sit in.
    const pair = process.stdout.isTTY
      ? `pair a browser with code ${pairing.mint()} (once, within ${PAIR_MINUTES} minutes), or run agent-org ticket:pair for a new one`
      : "pair a browser: run agent-org ticket:pair, and type the code it prints";
    process.stdout.write(`ticket mode: ${url}\n  ${pair}\n  watch the workers: herdr session attach ${settings.herdrSession}\n  worktrees under ${settings.worktreeRoot}\n`);
    if (!process.argv.includes("--no-open") && process.platform === "darwin") execFileSync("open", [url]);
  });
  setInterval(() => { void board.pool.tick(); }, TICK_MS);
  void board.pool.refreshTracker();
  setInterval(() => { void board.pool.refreshTracker(); }, TRACKER_MS);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  serve().catch((err) => {
    process.stderr.write(`ticket:serve: ${String((err as Error)?.message ?? err)}\n`);
    process.exit(1);
  });
}
