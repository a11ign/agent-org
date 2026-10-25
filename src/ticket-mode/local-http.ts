// @ts-check
// module: what the instance (`server.ts`) and the page's service (`ui-server.ts`) both do with a request on 127.0.0.1
//
// A `Host` that is not the server's own is refused, which stops a DNS-rebinding page from reaching it, and a write from another origin is
// refused. A secret is compared in time that does not depend on where it differs. A body is read up to a limit, and must be a JSON object.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";

export type Json = Record<string, unknown>;

/** The most an API request may send. The largest is a queue of ticket keys. */
export const API_BODY_BYTES = 64 * 1024;

/** The `Host` and `Origin` values the exposure plugin answers to besides this server's loopback: its `hosts` and `origins` for the board's address (none for a loopback-only exposure). */
export type Served = Readonly<{ hosts: readonly string[]; origins: readonly string[] }>;

/**
 * Why a request is refused before it is read, or `null`. PURE over the request's headers, this server's port and, when the exposure serves the page under a name, the `Host` and
 * `Origin` values it answers to: those may also name it, and nothing else does.
 */
export function refusal(request: Pick<IncomingMessage, "headers" | "method">, port: number, served?: Served): string | null {
  const loopback = [`127.0.0.1:${port}`, `localhost:${port}`];
  const hosts = [...loopback, ...(served?.hosts ?? [])];
  if (!hosts.includes(String(request.headers.host ?? ""))) return "this server answers only to its own host";
  const origin = request.headers.origin;
  const origins = [...loopback.map((host) => `http://${host}`), ...(served?.origins ?? [])];
  if (request.method !== "GET" && origin !== undefined && !origins.includes(String(origin))) return "a write from another origin";
  return null;
}

/** Whether `given` is `expected`, in time that does not depend on where they differ. Comparing digests makes any two inputs the same length. */
export function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** An answer shorter than this is sent as it is: packing it saves nothing worth the time. */
const PACK_FROM_BYTES = 4096;

/** Whether the request names gzip among the encodings it takes (`Accept-Encoding`), and not with a quality of 0. */
export function takesGzip(request: Pick<IncomingMessage, "headers">): boolean {
  const offered = String(request.headers["accept-encoding"] ?? "").split(",").map((part) => part.trim().toLowerCase().split(";").map((piece) => piece.trim()));
  return offered.some(([coding, quality]) => coding === "gzip" && !/^q=0(?:\.0{0,3})?$/.test(quality ?? ""));
}

export function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

/**
 * Answer the `request` with `answer.value` as JSON, gzipped when the answer is 4 KB or more and the request takes gzip: the board's lists are repeated text, and the instance's answers cross an SSH tunnel to the page's
 * service (A11-270), where the bytes are the cost.
 */
export function sendJsonFor(request: Pick<IncomingMessage, "headers">, response: ServerResponse, answer: Readonly<{ status: number; value: unknown }>): void {
  const body = JSON.stringify(answer.value);
  const packed = body.length >= PACK_FROM_BYTES && takesGzip(request);
  response.writeHead(answer.status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...(packed ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}) });
  response.end(packed ? gzipSync(body, { level: 3 }) : body);
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
