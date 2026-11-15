// @ts-check
// module: the GitHub REST client of the GitHub Issues plugin -- one call to api.github.com with the token, through the board's outside client (A11-447)
//
// EVERY CALL GOES THROUGH THE INJECTED `fetch`, so the plugin's tests answer from an in-memory repository (`fake-github.ts`) and nothing reaches GitHub. It is sent through the board's outside client
// (`deps.outside`, A11-436), which times each attempt, tries it again when its one rule says another try can get past the failure (a lost connection, a 429, a 5xx), and counts the call once: the plugin
// keeps no retry loop of its own, as the Linear plugin keeps none. A POST is made once, since a second try could post a comment twice. Without the board's client a call is made once. A failed answer
// throws an error carrying the HTTP `status` (tracker contract 1.7), so the board tries a plan attach again on a 5xx without reading the message.
import type { ServiceCall } from "../../src/plugins/manifest.ts";

export const GITHUB_API = "https://api.github.com";

/** The seams a call goes through: the token, the `fetch` that sends it, and the board's outside client that times, retries and counts it. */
export type Client = Readonly<{ token: string; request: typeof fetch; outside: ServiceCall }>;

/** A call made once, with nothing to time or retry: what a source made without the board's client does (doctor, and a process that is not the board). */
export const callOnce: ServiceCall = (attempt) => attempt(new AbortController().signal);

/** An error that carries the HTTP `status` GitHub answered with, as data (tracker contract 1.7). */
export const answered = (message: string, status: number): Error => Object.assign(new Error(message), { status });

/** Whether `error` is an answer of `status`. */
export const isStatus = (error: unknown, status: number): boolean => (error as { status?: unknown } | null)?.status === status;

/** One call through the outside client: the attempt is given its signal, the answer's status is what the client classes, and a body not used is let go so its connection closes. */
const send = (client: Client, url: string, init: RequestInit): Promise<Response> => client.outside((signal) => client.request(url, { ...init, signal }), {
  statusOf: (response) => response.status,
  release: (response) => response.arrayBuffer(),
  once: init.method === "POST",
});

/**
 * Calls `method path` of GitHub's REST API with `body` as JSON, and answers the parsed answer (null for an empty one). THROWS an error carrying the status for any answer that is not 2xx,
 * so a caller tells a missing issue (404) from a refusal by `isStatus`.
 */
export async function callGitHub<T>(client: Client, method: string, path: string, body?: unknown): Promise<T> {
  const response = await send(client, `${GITHUB_API}${path}`, {
    method,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${client.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw answered(`GitHub answered ${response.status} to ${method} ${path}: ${text.slice(0, MESSAGE_CHARS)}`, response.status);
  return (text === "" ? null : JSON.parse(text)) as T;
}

/** How much of a refusal's body its error carries. */
const MESSAGE_CHARS = 200;

/** The size of a page GitHub lists: its largest. */
export const PAGE_SIZE = 100;

/** Every item of a listed path, page by page until a short one: `path` carries its own query, and the page is added to it. */
export async function fetchAllPages<T>(client: Client, path: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page += 1) {
    const items = await callGitHub<T[]>(client, "GET", `${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`);
    all.push(...items);
    if (items.length < PAGE_SIZE) return all;
  }
}
