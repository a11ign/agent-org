// @ts-check
// module: a paired browser's call to one of the page's connections, passed on to that instance with its key
//
// THE PAGE NEVER TALKS TO AN INSTANCE. The request is rebuilt here with only what the instance needs: its own `Host` (so its DNS-rebinding
// guard accepts it), the key in `x-ticket-token`, and the JSON body. The browser's cookie, which is the page's session, is never sent on.
//
// ONLY THE ROUTES THE PAGE CALLS ARE PASSED ON. The request carries the instance's key, which opens any route the instance adds later. A list
// of what is allowed keeps a new key-only route closed until it is added here. `/api/terminal-pair` is one of them: the page's service asks for a
// worker terminal's pairing code only for a paired browser following a worker link (`ui-server.ts`), which refuses a browser's own call to it.
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { via, type Connections, type Target } from "./connections.ts";
import type { LastKnown } from "./last-known.ts";
import { redact, Unreachable } from "./remote.ts";

/** A call to pass on: its method, its path from `/api` on with any query, and its JSON body, or null. */
export type ForwardRequest = Readonly<{ method: string; path: string; body: string | null }>;

/** What the instance answered. */
export type ForwardAnswer = Readonly<{ status: number; body: string }>;

/** Send a request to an instance. */
export type Forward = (target: Target, request: ForwardRequest) => Promise<ForwardAnswer>;

const FORWARD_MS = 30_000;
/** The most an instance's answer may hold. The largest is a list of tickets. */
const ANSWER_BYTES = 8 * 1024 * 1024;
const READS = new Set(["/api/config", "/api/tickets", "/api/people", "/api/parents", "/api/pick", "/api/queue", "/api/writer", "/api/settings", "/api/plugins", "/api/health", "/api/interventions", "/api/flakes"]);
const WRITES = new Set(["/api/queue", "/api/queue-children", "/api/choice", "/api/publish", "/api/paused", "/api/max", "/api/terminal-pair", "/api/terminal-run", "/api/writer", "/api/grill-ticket",
  "/api/settings/preview", "/api/settings/save", "/api/settings/restore", "/api/plugins/action"]);
/** Reads that are passed on but never kept for an SSH connection's last known: the loop's health (A11-282) changes on every read, is polled every 10 s, and is no use once old. */
const NEVER_KEPT = new Set(["/api/health"]);
/** The Settings page's edits of a file, and its install, enable, disable and uninstall of a plugin (A11-163): they change a `.agent-org` file, which only the machine that holds it may do (A11-132). */
const SETTINGS_EDITS = new Set(["/api/settings/preview", "/api/settings/save", "/api/settings/restore", "/api/plugins/action"]);
const RUN_ACTION = /^\/api\/queue\/[A-Za-z0-9_-]+\/(amend|remove|retry|approve|respond|talk|stop|close|dismiss|apply-edit|discard-edit)$/;
/** One run in full (`GET /api/queue/<key>`, A11-270): a read, passed on, and never kept as last known, since a path for each run would push out the pages' own (`MOST_PATHS` in `last-known.ts`). */
const RUN_READ = /^\/api\/queue\/[A-Za-z0-9_-]+$/;
/** A new-ticket request's own actions: `/api/writer/<run>/stop` and `/api/writer/<run>/dismiss`. */
const WRITER_ACTION = /^\/api\/writer\/[A-Za-z0-9_-]+\/(?:stop|dismiss)$/;
/** How a forward fails when nothing is at the other end of the tunnel's socket any more: closed under the request, refused, or removed. */
const LINK_LOST = /\b(?:ECONNRESET|ECONNREFUSED|ENOENT|EPIPE)\b|socket hang up/;

/** Whether the page may make this call to an instance: one of the routes it calls there, by the method it calls it with. */
export function passedOn(method: string, pathname: string): boolean {
  if (method === "GET") return READS.has(pathname) || RUN_READ.test(pathname);
  if (method === "POST") return WRITES.has(pathname) || RUN_ACTION.test(pathname) || WRITER_ACTION.test(pathname);
  return false;
}

/** The headers an instance is sent: its own host, its key, the encoding it may pack an answer in (A11-270), and the body's type and length. Nothing of the browser's. */
export function forwardHeaders(target: Pick<Target, "host" | "key">, body: string | null): Record<string, string> {
  return { host: target.host, "x-ticket-token": target.key, accept: "application/json", "accept-encoding": "gzip",
    ...(body === null ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }) };
}

/** Send the request to the instance: over the tunnel's socket, or to its address. */
export const httpForward: Forward = (target, { method, path, body }) => new Promise((done, fail) => {
  const options: RequestOptions = { method, headers: forwardHeaders(target, body), timeout: FORWARD_MS };
  const answered = (response: IncomingMessage) => {
    // An answer the instance packed (`sendJson`) is unpacked as it arrives, and the limit is on what it unpacks to.
    const unpacked: Readable = response.headers["content-encoding"] === "gzip" ? response.pipe(createGunzip()) : response;
    const chunks: Buffer[] = [];
    let size = 0;
    unpacked.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > ANSWER_BYTES) return void (unpacked.destroy(new Error(`an answer over ${ANSWER_BYTES} bytes`)), response.destroy());
      chunks.push(chunk);
    });
    unpacked.on("end", () => done({ status: response.statusCode ?? 502, body: Buffer.concat(chunks).toString("utf8") }));
    unpacked.on("error", fail);
    response.on("error", fail);
  };
  let outgoing: ClientRequest;
  if ("socket" in target.address) {
    outgoing = httpRequest({ ...options, socketPath: target.address.socket, path }, answered);
  } else {
    // Joined, not resolved against the origin, so a path such as `//elsewhere/...` stays on the instance's host.
    const url = new URL(`${target.address.origin}${path}`);
    outgoing = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, answered);
  }
  outgoing.on("timeout", () => outgoing.destroy(new Error(`no answer within ${FORWARD_MS / 1000} seconds`)));
  outgoing.on("error", fail);
  outgoing.end(body ?? undefined);
});

/** Whether a forward failed because the link under it is gone, rather than because the instance was slow or answered too much. */
export function linkLost(err: unknown): boolean {
  return LINK_LOST.test(`${(err as NodeJS.ErrnoException)?.code ?? ""} ${String((err as Error)?.message ?? err)}`);
}

/**
 * Send `request` to `target`, and the target that answered. When an ssh connection's tunnel is found dead, it is opened again at once, and a GET
 * is sent once more on the new one; a POST is not, as it may have arrived. THROWS the forward's own error, or `Unreachable` when the tunnel
 * cannot be opened again.
 */
async function sendOn(connections: Connections, name: string, target: Target, request: ForwardRequest, forward: Forward): Promise<{ answer: ForwardAnswer; target: Target }> {
  try {
    return { answer: await forward(target, request), target };
  } catch (err) {
    if (connections.get(name)?.kind !== "ssh" || !linkLost(err)) throw err;
    const reopening = connections.restart(name, target);
    if (request.method !== "GET") {
      void reopening.catch(() => {});
      throw err;
    }
    const reopened = await reopening;
    return { answer: await forward(reopened, request), target: reopened };
  }
}

/**
 * A paired browser's call to connection `name`, passed on to its instance: the status and JSON value to answer with. A connection that
 * cannot be reached answers 502 with "cannot reach <name> <how>: <reason>". An instance that refuses the key has it read again next time. An
 * ssh connection whose tunnel is found dead by a request has it opened again at once, and a GET is answered from a second try on the new one.
 *
 * With `lastKnown`, an SSH connection's page reads (a GET with no query that answered 200) are kept, and a 502 "cannot reach" answer to such a read then carries `lastKnown: { value, readAt }`
 * beside its `error`, when one was kept for that path, so the page can show what it last saw. The `error` sentence is the same as without it. A local or https connection, a POST,
 * and an instance that answered something that is not JSON are neither kept nor recalled.
 */
export async function proxy(connections: Connections, name: string, request: ForwardRequest, forward: Forward = httpForward, lastKnown?: LastKnown): Promise<[number, unknown]> {
  const connection = connections.get(name);
  if (connection === undefined) return [404, { error: `no connection ${name}` }];
  const how = via(connection);
  const pathname = request.path.split("?")[0];
  if (!passedOn(request.method, pathname)) return [403, { error: `${request.method} ${pathname} is not passed on to an instance` }];
  // A remote instance's files are edited on that machine, so nothing this page forwards changes them there.
  if (SETTINGS_EDITS.has(pathname) && connection.kind !== "local") return [403, { error: `${name}'s settings are not changed from here: its files are edited on that machine, and this connection is ${how}` }];
  // A page of a scope read on demand (`?assignee=&after=`) is a cursor, not a state to come back to: only a read with no query is kept.
  const remembers = lastKnown !== undefined && connection.kind === "ssh" && request.method === "GET" && !request.path.includes("?") && !NEVER_KEPT.has(pathname) && !RUN_READ.test(pathname);
  const identity = connection.kind === "ssh" ? connection.ssh : "";
  /** The 502 for a connection that cannot be reached: its sentence, and the last good answer to this path when one was kept. */
  const cannotReach = (error: string): [number, unknown] => {
    const kept = remembers ? lastKnown.recall(name, identity, request.path) : undefined;
    return [502, kept === undefined ? { error } : { error, lastKnown: kept }];
  };
  const unreachable = (err: unknown) => cannotReach(`cannot reach ${name} ${how}: ${err instanceof Unreachable ? err.message : redact(String(err))}`);
  let reached: Target;
  try {
    reached = await connections.reach(name);
  } catch (err) {
    return unreachable(err);
  }
  let answer: ForwardAnswer;
  let target: Target;
  try {
    ({ answer, target } = await sendOn(connections, name, reached, request, forward));
  } catch (err) {
    if (err instanceof Unreachable) return unreachable(err);
    return cannotReach(`cannot reach ${name}'s instance ${how}: ${redact(String((err as Error)?.message ?? err))}. Is agent-org ticket:serve running there?`);
  }
  connections.answered(name, target);
  if (answer.status === 401) {
    connections.forget(name);
    return cannotReach(`cannot reach ${name} ${how}: its instance refused the key, which is read again on the next request`);
  }
  let value: unknown;
  try {
    value = JSON.parse(answer.body);
  } catch {
    return [502, { error: `${name}'s instance answered with something that is not JSON` }];
  }
  const isConfigAnswer = pathname === "/api/config" && answer.status === 200 && value !== null && typeof value === "object";
  if (isConfigAnswer) {
    const config = value as Record<string, unknown>;
    value = { ...config, terminal: target.terminal(typeof config.terminal === "string" ? config.terminal : null) };
  }
  if (remembers && answer.status === 200) lastKnown.remember(name, identity, request.path, value);
  return [answer.status, value];
}
