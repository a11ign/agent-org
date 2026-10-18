#!/usr/bin/env node
// @ts-check
// command: ticket:ui -- ticket mode's board page on 127.0.0.1, showing each instance its connections file names: this machine's, and others'
//
// THE PAGE'S SERVICE HOLDS NO QUEUE. It serves the page and passes a paired browser's `/c/<connection>/api/...` calls on to that connection's
// instance with the instance's key (`connections.ts`, `remote-proxy.ts`). Each instance keeps its own queue, workers and limit. The page never
// talks to an instance itself.
//
// IT IS REACHABLE FROM THIS MACHINE ONLY, AND ONLY BY WHAT HAS PAIRED. It binds 127.0.0.1, and nothing secret goes in a URL. A browser is
// shown a pairing page, where a one-time code that `ticket:pair` prints (`pairing.ts`) gets it a session of its own as an HttpOnly cookie that
// lasts a year (`browser-sessions.ts`). `ticket:pair` asks for the code with this machine's board key. A request carrying the key is passed on
// to no instance, but the key can pair a browser, which reaches every connection: whoever holds it is trusted as the person is. A `Host` that is
// not this server's is refused, and a write from another origin is refused.
//
// A WORKER LINK IS A REDIRECT FOR A PAIRED BROWSER (A11-93). `/c/<connection>/terminal?link=` asks the connection's instance for a terminal
// pairing code, and answers with the link carrying it, so the person never types a second code. The link is taken only when it is that
// connection's own terminal address (`sameTerminal`), so the redirect cannot carry a code to another site. A failed mint sends the plain link.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../lib/cli-flags.ts";
import { boardKey, boardKeyPath } from "./board-key.ts";
import { browserSessions, browserSessionsPath, SESSION_SECONDS, type BrowserSessions } from "./browser-sessions.ts";
import { createConnections, readConnections, type Connections, type ConnectionsRead } from "./connections.ts";
import { API_BODY_BYTES, readJson, refusal, sameSecret, sendJson, type Json } from "./local-http.ts";
import { createPairing, PAIR_MINUTES, type Pairing } from "./pairing.ts";
import { proxy, type Forward } from "./remote-proxy.ts";
import { readTicketSettings } from "./settings.ts";
import { cachedTailnetName, readTailnetName, runTailscale, type Tailnet } from "./tailnet.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "ui.html");
/** What a browser that has not paired is shown, in place of the board. */
const PAIR_PAGE = join(HERE, "pair.html");
/** The page's logic, written in TypeScript so its tests run it, and sent to the browser with the types stripped. */
const VIEW = join(HERE, "board-view.ts");
/** The Pick view's label filters, sent the same way. Each module the page imports is one the browser can run as it is: it imports nothing. */
const LABEL_FILTERS = join(HERE, "label-filters.ts");
/** The Pick view's Assignee filter, sent the same way: it imports nothing, so the browser runs it as it is. */
const ASSIGNEE_FILTER = join(HERE, "assignee-filter.ts");
const COOKIE = "ticket_session";
/** The most a pairing request may send. It is read before the request is known to be anyone's, so it is kept small. */
const PAIR_BODY_BYTES = 1024;
/** A call to a connection's instance: `/c/<connection>/api/...`. */
const CONNECTION_PATH = /^\/c\/([A-Za-z0-9_-]+)(\/api\/.*)$/;
/** A paired browser's follow of a worker link: `/c/<connection>/terminal?link=<the plain link>`. */
const TERMINAL_LINK = /^\/c\/([A-Za-z0-9_-]+)\/terminal$/;

/**
 * `link` as the redirect may send it, normalised, or null: it must be a web address on `template`'s origin and path, with the same query names,
 * and each literal value of the template as it is. Its `{workspace}`, `{pane}` and `{key}` values are the run's own, and only need a value.
 * PURE, so the one check that keeps the redirect from carrying a code elsewhere is tested on its own.
 */
export function sameTerminal(link: string, template: string): string | null {
  let given: URL;
  let expected: URL;
  try {
    given = new URL(link);
    expected = new URL(template);
  } catch {
    return null;
  }
  if (given.protocol !== "http:" && given.protocol !== "https:") return null;
  if (given.origin !== expected.origin || given.pathname !== expected.pathname) return null;
  const names = (url: URL) => [...new Set(url.searchParams.keys())].sort().join(" ");
  if (names(given) !== names(expected)) return null;
  for (const [name, value] of expected.searchParams) {
    const placeholder = /\{[a-z]+\}/.test(value);
    if (placeholder ? given.searchParams.get(name) === "" : given.searchParams.get(name) !== value) return null;
  }
  return given.href;
}

export type UiDeps = Readonly<{
  port: number;
  /** This machine's board key, which a request for a pairing code carries. */
  key: string;
  sessions: BrowserSessions;
  pairing?: Pairing;
  read: ConnectionsRead;
  connections: Connections;
  forward?: Forward;
  /**
   * The tailnet the page is served on, when `tickets.serve` names one: its HTTPS port, and this machine's MagicDNS name, asked only for a `Host`
   * that is not this server's own loopback, and null while it cannot be read.
   */
  tailnet?: Readonly<{ port: number; name: () => Promise<string | null> }>;
}>;

/**
 * `board-view.ts` as the browser can run it: Node's own type stripping, so what the tests ran is what the page runs. The page loads ONE script, so the
 * files `board-view.ts` was split into (`board-view/`) are joined to it: one scope, with their relative imports dropped, as they are not modules here.
 */
export function boardViewScript(read: (path: string) => string = (path) => readFileSync(path, "utf8")): string {
  const dir = join(HERE, "board-view");
  const parts = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort().map((name) => join(dir, name))
    : [];
  // An import statement ends at its `;`, so one match never runs past it: a multi-line import from a sibling file goes, a `node:` import stays.
  const joined = [VIEW, ...parts].map((path) => read(path).replace(/^import\s+[^;]*?\bfrom\s+"\.[^"]*";[ \t]*$/gm, "")).join("\n");
  return stripTypeScriptTypes(joined);
}

/** `label-filters.ts` as the browser can run it, as `boardViewScript` sends `board-view.ts`. */
export function labelFiltersScript(read: (path: string) => string = (path) => readFileSync(path, "utf8")): string {
  return stripTypeScriptTypes(read(LABEL_FILTERS));
}

/** `assignee-filter.ts` as the browser can run it, as `boardViewScript` sends `board-view.ts`. */
export function assigneeFilterScript(read: (path: string) => string = (path) => readFileSync(path, "utf8")): string {
  return stripTypeScriptTypes(read(ASSIGNEE_FILTER));
}

/** The page's modules, by the path it imports each from. */
const SCRIPTS: Readonly<Record<string, () => string>> = {
  "/board-view.js": () => boardViewScript(), "/label-filters.js": () => labelFiltersScript(), "/assignee-filter.js": () => assigneeFilterScript(),
};

/**
 * What the request is paired by: the board key in its `x-ticket-token` header, a paired browser's session in its cookie when it sends no
 * header, or nothing.
 */
export function pairedBy(request: Pick<IncomingMessage, "headers">, key: string, sessions: Pick<BrowserSessions, "holds">): "key" | "browser" | null {
  const header = request.headers["x-ticket-token"];
  if (header !== undefined) return sameSecret(String(header), key) ? "key" : null;
  const cookie = String(request.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return cookie !== undefined && sessions.holds(cookie) ? "browser" : null;
}

function sendHtml(response: ServerResponse, path: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:" });
  response.end(readFileSync(path, "utf8"));
}

/** The request handler, with every dependency named, so a test drives it without a socket. */
export function createUi(deps: UiDeps) {
  const { port, key, sessions, read, connections } = deps;
  const pairing = deps.pairing ?? createPairing();

  /** What a request that has not paired may do: see the pairing page, and trade a live code at `POST /pair` for a session of its own. */
  async function pairBrowser(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    if (request.method === "GET" && path === "/") return sendHtml(response, PAIR_PAGE);
    if (request.method !== "POST" || path !== "/pair") {
      return sendJson(response, 401, { error: `this browser is not paired: open http://127.0.0.1:${port}/ and type the code agent-org ticket:pair prints` });
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

  /** A paired browser's call to a connection's instance. A script holding the board key is not passed on. */
  async function proxyConnection(request: IncomingMessage, response: ServerResponse, by: "key" | "browser", name: string, path: string): Promise<void> {
    if (connections.get(name) === undefined) return sendJson(response, 404, { error: `no connection ${name}` });
    if (by !== "browser") return sendJson(response, 403, { error: "only a paired browser is passed on to an instance" });
    // A worker's code is asked for by its worker link, which hands it on in a redirect, and never answered to the page's own call.
    if (path.split("?")[0] === "/api/terminal-pair") return sendJson(response, 403, { error: "a worker's pairing code comes from its worker link, not from a call" });
    let body: string | null;
    try {
      body = request.method === "POST" ? JSON.stringify(await readJson(request, API_BODY_BYTES)) : null;
    } catch (err) {
      return sendJson(response, 400, { error: String((err as Error)?.message ?? err) });
    }
    const [status, value] = await proxy(connections, name, { method: request.method ?? "GET", path, body }, deps.forward);
    sendJson(response, status, value);
  }

  /**
   * A paired browser's follow of a worker link: a redirect to the link with the connection's terminal pairing code in it (A11-93). A failed mint
   * redirects to the plain link, and the code is never logged or answered anywhere but the `Location` of this response.
   */
  async function workerLink(response: ServerResponse, by: "key" | "browser", name: string, link: string | null): Promise<void> {
    if (connections.get(name) === undefined) return sendJson(response, 404, { error: `no connection ${name}` });
    if (by !== "browser") return sendJson(response, 403, { error: "only a paired browser is passed on to an instance" });
    if (link === null) return sendJson(response, 400, { error: "name the worker's address in the link parameter" });
    const [status, config] = await proxy(connections, name, { method: "GET", path: "/api/config", body: null }, deps.forward);
    if (status !== 200) return sendJson(response, status, config);
    const template = (config as { terminal?: unknown }).terminal;
    const target = typeof template === "string" ? sameTerminal(link, template) : null;
    if (target === null) return sendJson(response, 400, { error: `that address is not ${name}'s worker terminal` });
    const [minted, answer] = await proxy(connections, name, { method: "POST", path: "/api/terminal-pair", body: "{}" }, deps.forward);
    const code = minted === 200 && typeof answer === "object" && answer !== null ? (answer as { code?: unknown }).code : undefined;
    const location = typeof code === "string" ? `${target}${target.includes("?") ? "&" : "?"}pair=${code}` : target;
    response.writeHead(302, { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    response.end();
  }

  /** The tailnet a request may name. The name is asked only for a `Host` that is not this server's loopback, so a hostile one costs no tailscale call. */
  async function tailnetFor(request: IncomingMessage): Promise<Tailnet | undefined> {
    if (deps.tailnet === undefined) return undefined;
    const host = String(request.headers.host ?? "");
    if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return undefined;
    const name = await deps.tailnet.name();
    return name === null ? undefined : { name, port: deps.tailnet.port };
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refused = refusal(request, port, await tailnetFor(request));
    if (refused !== null) return sendJson(response, 403, { error: refused });
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const by = pairedBy(request, key, sessions);
    if (by === null) return pairBrowser(request, response, url.pathname);
    // A code pairs a new browser, so only the key makes one. A browser's session, which can reach another port's server, cannot.
    if (request.method === "POST" && url.pathname === "/api/pair-code") {
      if (by !== "key") return sendJson(response, 403, { error: "a pairing code is made with the board key: run agent-org ticket:pair" });
      return sendJson(response, 200, { code: pairing.mint(), minutes: PAIR_MINUTES });
    }
    const worker = TERMINAL_LINK.exec(url.pathname);
    if (request.method === "GET" && worker !== null) return workerLink(response, by, worker[1], url.searchParams.get("link"));
    const script = request.method === "GET" && Object.hasOwn(SCRIPTS, url.pathname) ? SCRIPTS[url.pathname] : undefined;
    if (script !== undefined) {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      return void response.end(script());
    }
    if (request.method === "GET" && url.pathname === "/") return sendHtml(response, PAGE);
    if (request.method === "GET" && url.pathname === "/api/connections") {
      return sendJson(response, 200, { connections: read.connections.map(({ name, kind }) => ({ name, kind })), refusal: read.refusal });
    }
    const call = CONNECTION_PATH.exec(url.pathname);
    if (call !== null) return proxyConnection(request, response, by, call[1], `${call[2]}${url.search}`);
    sendJson(response, 404, { error: `no route ${request.method} ${url.pathname}` });
  }

  return { handle };
}

function serve(): void {
  refuseUnknownFlags(["--no-open"], { entry: import.meta.url, command: "agent-org ticket:ui" });
  const settings = readTicketSettings();
  const log = (line: string) => process.stderr.write(`ticket:ui: ${line}\n`);
  const keyPath = boardKeyPath(settings.stateDir);
  const read = readConnections();
  if (read.migrated !== null) log(read.migrated);
  if (read.refusal !== null) log(read.refusal);
  const connections = createConnections(read.connections, { local: { port: settings.port, keyPath } });
  const pairing = createPairing();
  const tailnet = settings.serve === null ? undefined : { port: settings.serve.ui, name: cachedTailnetName(async () => readTailnetName(runTailscale)) };
  const ui = createUi({ port: settings.uiPort, key: boardKey(keyPath), sessions: browserSessions(browserSessionsPath(settings.stateDir)), pairing, read, connections, tailnet });
  // Every tunnel this service opened ends with it.
  process.on("exit", () => connections.close());
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(128 + constants.signals[signal]));
  // One request's failure ends that request, never the service.
  const server = createServer((request, response) => {
    ui.handle(request, response).catch((err) => {
      log(`${request.method} ${request.url?.split("?")[0]}: ${String((err as Error)?.message ?? err)}`);
      if (response.headersSent) response.destroy();
      else sendJson(response, 500, { error: "the board failed to answer" });
    });
  });
  server.listen(settings.uiPort, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${settings.uiPort}/`;
    // A code is printed only to a person's terminal. Run detached, the output goes to a log, which a code has no reason to sit in.
    const pair = process.stdout.isTTY
      ? `pair a browser with code ${pairing.mint()} (once, within ${PAIR_MINUTES} minutes), or run agent-org ticket:pair for a new one`
      : "pair a browser: run agent-org ticket:pair, and type the code it prints";
    process.stdout.write(`ticket mode board: ${url}\n  ${pair}\n  instances: ${read.connections.map(({ name, kind }) => `${name} (${kind})`).join(", ")}\n`);
    if (!process.argv.includes("--no-open") && process.platform === "darwin") execFileSync("open", [url]);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  try {
    serve();
  } catch (err) {
    process.stderr.write(`ticket:ui: ${String((err as Error)?.message ?? err)}\n`);
    process.exit(1);
  }
}
