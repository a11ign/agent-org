import { apiBase } from "../../../src/ticket-mode/board-view.ts";
import { answerOf, failedToSend, type Answer } from "./answer.ts";
import type { ViewConnection } from "./types.ts";

/** The browser's `fetch`, or a stand-in a test gives. */
export type Fetch = typeof fetch;

/** One call: its method, its path from `/api` on with any query, and its JSON body when it has one. */
export type Call = Readonly<{ method: "GET" | "POST"; path: string; body?: unknown; signal?: AbortSignal }>;

/** Where a call is addressed: under the connection's `/c/<name>`, or at the root for `/api/connections` and for a null connection. */
export type Target = Readonly<{ connection: ViewConnection | null; fetch: Fetch; atRoot?: boolean }>;

/**
 * The one place a request is built, sent and read. It does what `ui.html`'s `call` does: a same-origin `fetch` carrying the paired browser's session cookie
 * (`credentials: "same-origin"` is the default), a JSON body with its type, and no token of its own, since `ticket:ui` adds the instance's key.
 */
export async function send<T>({ connection, fetch, atRoot = false }: Target, { method, path, body, signal }: Call): Promise<Answer<T>> {
  const init: RequestInit = { method, ...(signal === undefined ? {} : { signal }), ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) };
  try {
    return await answerOf<T>(connection, await fetch(`${atRoot ? "" : apiBase(connection)}${path}`, init));
  } catch (error) {
    return failedToSend(error);
  }
}
