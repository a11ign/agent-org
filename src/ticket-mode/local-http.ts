// @ts-check
// module: what the instance (`server.ts`) and the page's service (`ui-server.ts`) both do with a request on 127.0.0.1
//
// A `Host` that is not the server's own is refused, which stops a DNS-rebinding page from reaching it, and a write from another origin is
// refused. A secret is compared in time that does not depend on where it differs. A body is read up to a limit, and must be a JSON object.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tailnetHosts, tailnetOrigins, type Tailnet } from "./tailnet.ts";

export type Json = Record<string, unknown>;

/** The most an API request may send. The largest is a queue of ticket keys. */
export const API_BODY_BYTES = 64 * 1024;

/**
 * Why a request is refused before it is read, or `null`. PURE over the request's headers, this server's port and, when the page is served on the
 * tailnet, that tailnet: its `Host` and `Origin` may also name it, and nothing else does.
 */
export function refusal(request: Pick<IncomingMessage, "headers" | "method">, port: number, tailnet?: Tailnet): string | null {
  const loopback = [`127.0.0.1:${port}`, `localhost:${port}`];
  const hosts = [...loopback, ...(tailnet === undefined ? [] : tailnetHosts(tailnet))];
  if (!hosts.includes(String(request.headers.host ?? ""))) return "this server answers only to its own host";
  const origin = request.headers.origin;
  const origins = [...loopback.map((host) => `http://${host}`), ...(tailnet === undefined ? [] : tailnetOrigins(tailnet))];
  if (request.method !== "GET" && origin !== undefined && !origins.includes(String(origin))) return "a write from another origin";
  return null;
}

/** Whether `given` is `expected`, in time that does not depend on where they differ. Comparing digests makes any two inputs the same length. */
export function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

export function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

/** A request's JSON object, or `{}` when it has no body. REFUSES a body over `limit` bytes, and one that is not a JSON object. */
export async function readJson(request: IncomingMessage, limit: number): Promise<Json> {
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
