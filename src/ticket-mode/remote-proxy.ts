// @ts-check
// module: a paired browser's call to one of the page's connections, passed on to that instance with its key
//
// THE PAGE NEVER TALKS TO AN INSTANCE. The request is rebuilt here with only what the instance needs: its own `Host` (so its DNS-rebinding
// guard accepts it), the key in `x-ticket-token`, and the JSON body. The browser's cookie, which is the page's session, is never sent on.
//
// ONLY THE ROUTES THE PAGE CALLS ARE PASSED ON. The request carries the instance's key, which opens any route the instance adds later. A list
// of what is allowed keeps a new key-only route closed until it is added here.
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { via, type Connections, type Target } from "./connections.ts";
import { redact, Unreachable } from "./remote.ts";

/** A call to pass on: its method, its path from `/api` on with any query, and its JSON body, or null. */
export type ForwardRequest = Readonly<{ method: string; path: string; body: string | null }>;

/** What the instance answered. */
export type ForwardAnswer = Readonly<{ status: number; body: string }>;

/** Send a request to an instance. */
export type Forward = (target: Target, request: ForwardRequest) => Promise<ForwardAnswer>;

const FORWARD_MS = 30_000;
const READS = new Set(["/api/config", "/api/tickets", "/api/parents", "/api/queue"]);
const WRITES = new Set(["/api/queue", "/api/choice", "/api/publish", "/api/paused", "/api/max"]);
const RUN_ACTION = /^\/api\/queue\/[A-Za-z0-9_-]+\/(amend|remove|retry|approve|respond|stop|close)$/;

/** Whether the page may make this call to an instance: one of the routes it calls there, by the method it calls it with. */
export function passedOn(method: string, pathname: string): boolean {
  if (method === "GET") return READS.has(pathname);
  if (method === "POST") return WRITES.has(pathname) || RUN_ACTION.test(pathname);
  return false;
}

/** The headers an instance is sent: its own host, its key, and the body's type and length. Nothing of the browser's. */
export function forwardHeaders(target: Pick<Target, "host" | "key">, body: string | null): Record<string, string> {
  return { host: target.host, "x-ticket-token": target.key, accept: "application/json",
    ...(body === null ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }) };
}

/** Send the request to the instance: over the tunnel's socket, or to its address. */
export const httpForward: Forward = (target, { method, path, body }) => new Promise((done, fail) => {
  const options: RequestOptions = { method, headers: forwardHeaders(target, body), timeout: FORWARD_MS };
  const answered = (response: IncomingMessage) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => done({ status: response.statusCode ?? 502, body: Buffer.concat(chunks).toString("utf8") }));
    response.on("error", fail);
  };
  let outgoing: ClientRequest;
  if ("socket" in target.address) {
    outgoing = httpRequest({ ...options, socketPath: target.address.socket, path }, answered);
  } else {
    const url = new URL(path, target.address.origin);
    outgoing = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, answered);
  }
  outgoing.on("timeout", () => outgoing.destroy(new Error(`no answer within ${FORWARD_MS / 1000} seconds`)));
  outgoing.on("error", fail);
  outgoing.end(body ?? undefined);
});

/**
 * A paired browser's call to connection `name`, passed on to its instance: the status and JSON value to answer with. A connection that
 * cannot be reached answers 502 with "cannot reach <name> <how>: <reason>". An instance that refuses the key has it read again next time.
 */
export async function proxy(connections: Connections, name: string, request: ForwardRequest, forward: Forward = httpForward): Promise<[number, unknown]> {
  const connection = connections.get(name);
  if (connection === undefined) return [404, { error: `no connection ${name}` }];
  const how = via(connection);
  const pathname = request.path.split("?")[0];
  if (!passedOn(request.method, pathname)) return [403, { error: `${request.method} ${pathname} is not passed on to an instance` }];
  let target: Target;
  try {
    target = await connections.reach(name);
  } catch (err) {
    return [502, { error: `cannot reach ${name} ${how}: ${err instanceof Unreachable ? err.message : redact(String(err))}` }];
  }
  let answer: ForwardAnswer;
  try {
    answer = await forward(target, request);
  } catch (err) {
    return [502, { error: `cannot reach ${name}'s instance ${how}: ${redact(String((err as Error)?.message ?? err))}. Is agent-org ticket:serve running there?` }];
  }
  if (answer.status === 401) {
    connections.forget(name);
    return [502, { error: `cannot reach ${name} ${how}: its instance refused the key, which is read again on the next request` }];
  }
  let value: unknown;
  try {
    value = JSON.parse(answer.body);
  } catch {
    return [502, { error: `${name}'s instance answered with something that is not JSON` }];
  }
  if (pathname === "/api/config" && answer.status === 200 && value !== null && typeof value === "object") {
    const config = value as Record<string, unknown>;
    value = { ...config, terminal: target.terminal(typeof config.terminal === "string" ? config.terminal : null) };
  }
  return [answer.status, value];
}
