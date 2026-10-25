// @ts-check
// module: the instance's request thread (A11-282) -- the HTTP server, answering every read from the latest board snapshot and forwarding everything else to the board thread
//
// A READ NEVER WAITS ON BACKGROUND WORK. The board thread runs the pool, the tick and the sweeps, whose `gh`, `git` and `herdr` calls are synchronous and held every request for as long
// as each ran (60 s for a 940-byte `/api/config`). This thread is a `worker_threads` worker that `serve()` starts (`board-thread.ts`). It answers the GET routes of `read-routes.ts`,
// `/api/health` and `POST /api/terminal-run` itself, from the snapshot the board thread posts and from the tracker, which it reaches over `fetch` with its own activation of the
// tracker plugin. Every other request is forwarded whole, and may wait while the board thread is held: the 200 ms bound is on reads.
//
// SO IT SPAWNS NOTHING SYNCHRONOUSLY ON A READ. What a read would run a program for is read once on the board thread and handed over (the tool's version, the release the
// plugins' contracts are checked against), and a command is looked for on the PATH by reading the disk. The one exception is the Settings read's first import of
// `project-config.ts` on a host with a project, whose `git rev-parse` runs once: it is not made at start, since an instance that starts no reviewer loads none of the reviewer
// gate's modules. `request-thread-guard.test.ts` walks what this module imports, and its ledger counts any synchronous spawn after `listen` in `/api/health`'s
// `requestThreadSyncCalls`, each said as an ERROR.
import { accessSync, constants, statSync } from "node:fs";
import { createServer } from "node:http";
import { delimiter, join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { loadActive, realPluginDeps } from "../plugins/active.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import { reviewerStateOf } from "./concern-states.ts";
import { startRequestHealth } from "./health-route.ts";
import { sendJson, type Json } from "./local-http.ts";
import { pluginsApi } from "./plugins-api.ts";
import type { ProblemOptions } from "./plugins.ts";
import { type Api, answerKeyed, plansOf, type ReadBoard, readRoute, terminalRunFor, trackerReads } from "./read-routes.ts";
import { hostFilePath, type TicketSettings } from "./settings.ts";
import type { TicketSource } from "./source.ts";
import { applyCopies, type BoardSnapshot, copiesOf, LISTEN_FAILED, namedKeys, REQUEST_THREAD, type RequestThreadData, type ToBoard, type ToRequests } from "./thread-messages.ts";

/** The board thread as this thread reaches it: `parentPort`, or a test's stand-in. */
export type BoardPort = Readonly<{ postMessage: (message: ToBoard) => void; on: (event: "message", listener: (message: ToRequests) => void) => unknown }>;

/** Whether `command` is a program on `path`, as `command -v` finds one, read from the disk, so no program is run to ask. A command with a `/` is that file. */
export function onPathOf(path: string | undefined): (command: string) => boolean {
  return (command) => {
    const files = command.includes("/") ? [command] : (path ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command));
    return files.some((file) => {
      try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
  };
}

/** The requests this thread answers itself: the GET routes of `read-routes.ts` and `POST /api/terminal-run`, which reads only the queue and the terminal address. `undefined` for the rest. */
export async function localRoute(board: ReadBoard, method: string, path: string, body: Json, query: URLSearchParams): Promise<[number, unknown] | undefined> {
  if (method === "POST" && path === "/api/terminal-run") return [200, await terminalRunFor(board, body)];
  return method === "GET" ? readRoute(board, method, path, query) : undefined;
}

/** The enabled tracker plugin's source, activated in this thread alone: the other plugins stay the board thread's. */
async function trackerOf(settings: TicketSettings): Promise<TicketSource> {
  const deps = realPluginDeps({ env: process.env, stateDir: settings.stateDir, pick: settings.pick, clones: settings.clones });
  return (await loadActive(settings.providers, defaultCatalog(), deps, undefined, ["tracker"])).tracker();
}

/** What a read is given for the Claude Code plugins' contracts in place of running a program: the release read on the board thread, and the PATH read from the disk. */
const problemsOf = (data: RequestThreadData): ProblemOptions => ({ agentOrgVersion: () => data.agentOrgVersion, onPath: onPathOf(process.env.PATH) });

/**
 * The reads' board over the latest snapshot: the queue, the pool's readings, the update and the terminal address are the board thread's as it last posted them, and the tickets, the
 * tracker's other reads, the Plugins section and the health are this thread's own.
 */
export function readBoardOf(data: RequestThreadData, parts: Readonly<{ source: TicketSource; plugins: ReadBoard["plugins"]; latest: () => BoardSnapshot; health: () => unknown;
  /** Asks the board thread to work the terminal address out again, as a read used it. */
  terminalRead: () => void; }>): ReadBoard {
  const { settings } = data;
  const { source, latest } = parts;
  return {
    settings, source, plugins: parts.plugins, problems: problemsOf(data), health: parts.health, paths: data.paths,
    store: { get: () => latest().queue },
    pool: { held: () => latest().held, pullReviews: () => latest().pullReviews, claimWarning: () => latest().claimWarning, reviewerState: () => latest().reviewerState ?? reviewerStateOf(settings, null) },
    known: { tickets: new Map(), claims: new Map() },
    claimant: () => data.claimant,
    plans: plansOf(settings, source),
    update: () => latest().update,
    terminalAddress: async () => {
      parts.terminalRead();
      return latest().terminal;
    },
    ...trackerReads(source, settings),
  };
}

/** The route table of this thread: its own routes, and every other request forwarded to the board thread with the copies of the tickets it names. */
function apiOf(board: ReadBoard, port: BoardPort, onSnapshot: (snapshot: BoardSnapshot) => void): Api {
  const waiting = new Map<number, (answer: [number, unknown]) => void>();
  let calls = 0;
  port.on("message", (message) => {
    if (message.kind === "snapshot") return onSnapshot(message.snapshot);
    applyCopies(board.known, message.known);
    waiting.get(message.id)?.([message.status, message.value]);
    waiting.delete(message.id);
  });
  const forward = (method: string, path: string, body: Json, query: URLSearchParams) => new Promise<[number, unknown]>((done) => {
    calls += 1;
    waiting.set(calls, done);
    port.postMessage({ kind: "call", id: calls, method, path, body, query: query.toString(), known: copiesOf(board.known, namedKeys(body, board.known)) });
  });
  return async (method, path, body, query) => {
    const local = await localRoute(board, method, path, body, query);
    if (local !== undefined) return local;
    const answer = await forward(method, path, body, query);
    // A plugin action the board thread took changes what the checks find, and the Plugins section is read here: its checks are asked for again, as the action asked on one thread.
    if (method === "POST" && path === "/api/plugins/action" && answer[0] === 200) void board.plugins.read({ check: true }).catch(() => undefined);
    return answer;
  };
}

/** Answers the instance's requests on `data.settings.port` until the thread ends. */
export async function serveRequests(data: RequestThreadData, port: BoardPort): Promise<void> {
  let latest = { snapshot: data.snapshot, receivedAt: Date.now() };
  const health = startRequestHealth({ latest: () => latest });
  // The Plugins section's checks run here, in child processes, as they ran on the instance's one thread: the board thread starts none.
  const plugins = pluginsApi({ hostPath: data.paths.hostPath ?? hostFilePath(), settings: data.settings, seam: { version: data.toolVersion, claude: problemsOf(data) }, warm: true });
  const board = readBoardOf(data, { source: await trackerOf(data.settings), plugins, latest: () => latest.snapshot, health: health.view, terminalRead: () => port.postMessage({ kind: "terminal" }) });
  const api = apiOf(board, port, (snapshot) => { latest = { snapshot, receivedAt: Date.now() }; });
  // One request's failure ends that request, never the thread.
  const server = createServer((request, response) => {
    answerKeyed(request, response, { port: data.settings.port, key: data.key, api }).catch((err: unknown) => {
      process.stderr.write(`ticket:serve: ${request.method} ${request.url?.split("?")[0]}: ${String((err as Error)?.message ?? err)}\n`);
      if (response.headersSent) response.destroy();
      else sendJson(response, 500, { error: "the instance failed to answer" });
    });
  });
  // A port another process holds ends the instance, as its own listen did: two instances must never both run a pool.
  server.once("error", (err: Error) => {
    process.stderr.write(`ticket:serve: the request thread cannot listen on 127.0.0.1:${data.settings.port}: ${err.message}\n`);
    process.exit(LISTEN_FAILED);
  });
  server.listen(data.settings.port, "127.0.0.1", () => {
    health.listening();
    port.postMessage({ kind: "listening", port: data.settings.port });
  });
}

if (!isMainThread && parentPort !== null && (workerData as Partial<RequestThreadData> | null)?.role === REQUEST_THREAD) {
  serveRequests(workerData as RequestThreadData, parentPort).catch((err: unknown) => {
    process.stderr.write(`ticket:serve: the request thread could not start: ${String((err as Error)?.message ?? err)}\n`);
    process.exit(1);
  });
}
