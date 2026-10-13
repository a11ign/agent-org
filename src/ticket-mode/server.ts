#!/usr/bin/env node
// @ts-check
// command: ticket:serve -- ticket mode's board on 127.0.0.1: pick your assigned tickets, queue them to repositories, and watch the pool work them
//
// THE BOARD IS THE QUEUE'S ONE WRITER. The page, and anything else that talks to this API, asks the server to change the queue; the server applies
// the pure transition (`queue.ts`), saves the file and wakes the pool. The pool runs in this process.
//
// IT IS REACHABLE FROM THIS MACHINE ONLY, AND ONLY WITH ITS TOKEN. It binds 127.0.0.1. A random token is printed at start; the first page load
// carries it and gets it back as an HttpOnly cookie, and every request after must carry it. A `Host` that is not this server's is refused, which
// stops a DNS-rebinding page from reaching it, and a write from another origin is refused. The Linear key never leaves this process.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../lib/cli-flags.ts";
import { linearSource, readLinearKey } from "./linear.ts";
import { createPool, type PoolDeps } from "./pool.ts";
import { amend, enqueue, loadQueue, remove, retry, saveQueue, setMax, setPaused, type Queue, type RunChoice } from "./queue.ts";
import { readTicketSettings, type TicketSettings } from "./settings.ts";
import type { Ticket, TicketSource } from "./source.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "ui.html");
/** The page's logic, written in TypeScript so its tests run it, and sent to the browser with the types stripped. */
const VIEW = join(HERE, "board-view.ts");
const BIN = join(HERE, "..", "bin.ts");
const COOKIE = "ticket_token";
const TICK_MS = 30_000;
/** How often the tracker is asked whether finished runs' tickets are done. A merge is not urgent news, and every read is a Linear request. */
const TRACKER_MS = 120_000;
const MODELS = ["opus", "sonnet", "haiku"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

type Json = Record<string, unknown>;

export type BoardDeps = Readonly<{
  settings: TicketSettings;
  source: TicketSource;
  token: string;
  queuePath: string;
  choicePath: string;
  pool?: Pick<ReturnType<typeof createPool>, "tick" | "stop" | "close" | "reconcile" | "ensureSession" | "refreshTracker">;
  poolDeps?: Omit<PoolDeps, "settings" | "source" | "hook">;
  now?: () => number;
}>;

/** `board-view.ts` as the browser can run it: Node's own type stripping, so what the tests ran is what the page runs. */
export function boardViewScript(read: (path: string) => string = (path) => readFileSync(path, "utf8")): string {
  return stripTypeScriptTypes(read(VIEW));
}

/** The request carries this server's token, in its cookie or its `x-ticket-token` header. Compared in constant time. */
export function carriesToken(request: Pick<IncomingMessage, "headers">, token: string): boolean {
  const cookie = String(request.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const given = String(request.headers["x-ticket-token"] ?? cookie ?? "");
  return given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

/** Why a request is refused before it is read, or `null`. PURE over the request's headers and this server's port. */
export function refusal(request: Pick<IncomingMessage, "headers" | "method">, port: number): string | null {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(String(request.headers.host ?? ""))) return "this server answers only to its own host";
  const origin = request.headers.origin;
  if (request.method !== "GET" && origin !== undefined && !hosts.map((host) => `http://${host}`).includes(String(origin))) return "a write from another origin";
  return null;
}

/** The last model and effort chosen, so the page offers them again. */
function readChoice(path: string): RunChoice {
  const fallback: RunChoice = { model: "opus", effort: "high" };
  if (!existsSync(path)) return fallback;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as Partial<RunChoice>;
    return { model: saved.model ?? fallback.model, effort: saved.effort ?? fallback.effort };
  } catch {
    return fallback;
  }
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

/** An amend names only what it changes, and each part is held to the rules queueing uses. */
function validAmend(body: Json): Partial<RunChoice> {
  const model = body.model === undefined ? undefined : String(body.model);
  const effort = body.effort === undefined ? undefined : String(body.effort);
  if (model !== undefined) checkModel(model);
  if (effort !== undefined) checkEffort(effort);
  // `RunChoice` is read-only, so the change is built whole rather than assigned field by field.
  return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
}

/** The request handler, with every dependency named, so a test drives it without a socket. */
export function createBoard(deps: BoardDeps) {
  const { settings, source, token } = deps;
  const now = deps.now ?? Date.now;
  let queue: Queue = loadQueue(deps.queuePath, settings.max);
  const store = { get: () => queue, set: (next: Queue) => { queue = next; saveQueue(deps.queuePath, next); } };
  const pool = deps.pool ?? createPool(store, { ...deps.poolDeps, settings, source, hook: { node: process.execPath, bin: BIN } });
  let known = new Map<string, Ticket>();

  const wake = () => { void pool.tick(); };

  async function api(method: string, path: string, body: Json): Promise<[number, unknown]> {
    if (method === "GET" && path === "/api/config") {
      return [200, { models: MODELS, efforts: EFFORTS, choice: readChoice(deps.choicePath), max: queue.max, terminal: settings.terminal }];
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
      store.set(enqueue(queue, tickets, choice, now()));
      mkdirSync(dirname(deps.choicePath), { recursive: true });
      writeFileSync(deps.choicePath, `${JSON.stringify(choice)}\n`);
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
    const action = /^\/api\/queue\/([A-Za-z0-9_-]+)\/(amend|remove|retry|stop|close)$/.exec(path);
    if (method === "POST" && action) {
      const [, key, verb] = action;
      if (verb === "amend") store.set(amend(queue, key, validAmend(body)));
      if (verb === "remove") store.set(remove(queue, key));
      if (verb === "retry") store.set(retry(queue, key, now()));
      if (verb === "stop") pool.stop(key);
      if (verb === "close") pool.close(key);
      wake();
      return [200, queue];
    }
    return [404, { error: `no route ${method} ${path}` }];
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
      response.end(JSON.stringify(value));
    };
    const refused = refusal(request, settings.port);
    if (refused !== null) return send(403, { error: refused });
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${settings.port}`);
    if (request.method === "GET" && url.pathname === "/" && url.searchParams.get("token") === token) {
      response.writeHead(303, { Location: "/", "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/` });
      return void response.end();
    }
    if (!carriesToken(request, token)) return send(401, { error: "open the URL ticket:serve printed, which carries the token" });
    if (request.method === "GET" && url.pathname === "/board-view.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      return void response.end(boardViewScript());
    }
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:" });
      return void response.end(readFileSync(PAGE, "utf8"));
    }
    let body: Json = {};
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json;
    }
    try {
      const [status, value] = await api(request.method ?? "GET", url.pathname, body);
      send(status, value);
    } catch (err) {
      send(400, { error: String((err as Error)?.message ?? err) });
    }
  }

  return { handle, api, pool, store };
}

async function serve(): Promise<void> {
  refuseUnknownFlags(["--no-open"], { entry: import.meta.url, command: "agent-org ticket:serve" });
  const settings = readTicketSettings();
  const source = linearSource({ key: readLinearKey(settings.linearKey) });
  const token = randomBytes(24).toString("hex");
  const dir = join(settings.stateDir, "tickets");
  const board = createBoard({ settings, source, token, queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json") });
  await board.pool.ensureSession();
  board.pool.reconcile();
  const server = createServer((request, response) => { void board.handle(request, response); });
  server.listen(settings.port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${settings.port}/?token=${token}`;
    process.stdout.write(`ticket mode: ${url}\n  watch the workers: herdr session attach ${settings.herdrSession}\n  worktrees under ${settings.worktreeRoot}\n`);
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
