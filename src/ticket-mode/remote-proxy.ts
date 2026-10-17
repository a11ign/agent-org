// @ts-check
// module: a paired browser's call to another machine's board, passed through the SSH tunnel `remote.ts` holds
//
// THE PAGE NEVER TALKS TO THE REMOTE. The request is rebuilt here with only what the remote needs: its own `Host` (so its DNS-rebinding guard
// accepts it), the key in `x-ticket-token`, and the JSON body. The browser's cookie, which is this board's session, is never sent on.
//
// ONLY THE ROUTES THE PAGE CALLS ARE PASSED ON. The request carries the remote's key, which also makes pairing codes there and opens any
// route the remote adds later. A list of what is allowed keeps a new key-only route closed until it is added here.
import { request as httpRequest } from "node:http";
import { localTerminal, redact, Unreachable, type Link, type Remotes } from "./remote.ts";

/** A call to pass on: its method, its path from `/api` on with any query, and its JSON body, or null. */
export type ForwardRequest = Readonly<{ method: string; path: string; body: string | null }>;

/** What the remote board answered. */
export type ForwardAnswer = Readonly<{ status: number; body: string }>;

/** Send a request to the remote board through the tunnel. */
export type Forward = (link: Link, request: ForwardRequest) => Promise<ForwardAnswer>;

const FORWARD_MS = 30_000;
const READS = new Set(["/api/config", "/api/tickets", "/api/parents", "/api/queue"]);
const WRITES = new Set(["/api/queue", "/api/choice", "/api/publish", "/api/paused", "/api/max"]);
const RUN_ACTION = /^\/api\/queue\/[A-Za-z0-9_-]+\/(amend|remove|retry|approve|respond|stop|close)$/;

/** Whether the page may make this call to another machine's board: one of the routes it calls there, by the method it calls it with. */
export function passedOn(method: string, pathname: string): boolean {
  if (method === "GET") return READS.has(pathname);
  if (method === "POST") return WRITES.has(pathname) || RUN_ACTION.test(pathname);
  return false;
}

/** The headers a remote board is sent: its own host, its key, and the body's type and length. Nothing of the browser's. */
export function forwardHeaders(link: Pick<Link, "port" | "key">, body: string | null): Record<string, string> {
  return { host: `127.0.0.1:${link.port}`, "x-ticket-token": link.key, accept: "application/json",
    ...(body === null ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }) };
}

/** Send the request over the tunnel's socket to the remote board. */
export const httpForward: Forward = (link, { method, path, body }) => new Promise((done, fail) => {
  const outgoing = httpRequest({ socketPath: link.socket, method, path, headers: forwardHeaders(link, body), timeout: FORWARD_MS }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => done({ status: response.statusCode ?? 502, body: Buffer.concat(chunks).toString("utf8") }));
    response.on("error", fail);
  });
  outgoing.on("timeout", () => outgoing.destroy(new Error(`no answer within ${FORWARD_MS / 1000} seconds`)));
  outgoing.on("error", fail);
  outgoing.end(body ?? undefined);
});

/**
 * A paired browser's call to remote profile `name`, passed through its tunnel: the status and JSON value to answer with. A remote that
 * cannot be reached answers 502 with "cannot reach <name> over SSH: <reason>". A remote that refuses the key has it read again next time.
 */
export async function proxy(remotes: Remotes, name: string, request: ForwardRequest, forward: Forward = httpForward): Promise<[number, unknown]> {
  const pathname = request.path.split("?")[0];
  if (!passedOn(request.method, pathname)) return [403, { error: `${request.method} ${pathname} is not passed on to another machine's board` }];
  let link: Link;
  try {
    link = await remotes.reach(name);
  } catch (err) {
    return [502, { error: `cannot reach ${name} over SSH: ${err instanceof Unreachable ? err.message : redact(String(err))}` }];
  }
  let answer: ForwardAnswer;
  try {
    answer = await forward(link, request);
  } catch (err) {
    return [502, { error: `cannot reach ${name}'s board through SSH: ${redact(String((err as Error)?.message ?? err))}. Is agent-org ticket:serve running there?` }];
  }
  if (answer.status === 401) {
    remotes.forget(name);
    return [502, { error: `cannot reach ${name} over SSH: its board refused the key read from it, which is read again on the next request` }];
  }
  let value: unknown;
  try {
    value = JSON.parse(answer.body);
  } catch {
    return [502, { error: `${name}'s board answered with something that is not JSON` }];
  }
  if (pathname === "/api/config" && answer.status === 200 && value !== null && typeof value === "object") {
    const config = value as Record<string, unknown>;
    value = { ...config, terminal: localTerminal(typeof config.terminal === "string" ? config.terminal : null, link.terminalLocal) };
  }
  return [answer.status, value];
}
