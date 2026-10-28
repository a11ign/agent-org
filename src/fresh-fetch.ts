// @ts-check
// module: a `fetch` that opens its own connection for every call and closes it after (A11-359)
//
// THE BOARD'S LONG-LIVED PROCESS KEPT KEEP-ALIVE SOCKETS TO LINEAR IN ITS POOL. The pool reads an idle socket late when the loop is busy, finds it closed by the far end, and fails the call with `ECONNRESET` or
// `UND_ERR_SOCKET` (A11-345 sent such a call once more; it did not hold). A connection that is opened for one call and closed after it cannot be stale, so there is nothing for the loop to read late. The cost is one
// TLS handshake per call, which is a few tens of milliseconds against calls the board makes a few times a minute.
//
// ONLY WHAT THE LINEAR CLIENT USES of `fetch` is here: a method, headers, a string or bytes body, an abort signal, and redirects (a download is redirected to storage). Every call has a deadline of its own, so a
// socket that is dead and never answers fails the call instead of holding it for ever.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

/** How long one call may take, from the first byte sent to the last byte read, when the caller names none. */
export const FRESH_FETCH_TIMEOUT_MS = 10_000;
/** The redirects a call follows before it is refused, as `fetch` does at 20: a download is redirected once. */
const MAX_REDIRECTS = 5;
const REDIRECTED = new Set([301, 302, 303, 307, 308]);
/** A status that has no body, which a `Response` must be built without. */
const NO_BODY = new Set([101, 204, 205, 304]);

/** The `fetch` `freshFetch` is built as: the same call and answer. */
type Fetch = typeof fetch;

/** A call that did not finish in time. A `TypeError("fetch failed")` with this cause is what the Linear client's retry reads as a failure of the connection. */
const timedOut = (ms: number): Error => Object.assign(new Error(`no answer within ${ms} ms`), { code: "UND_ERR_HEADERS_TIMEOUT" });

/** `fetch`'s own failure, as undici raises it: `TypeError("fetch failed")`, the reason in its cause, so the board's log says why (`fetch failed (ECONNRESET)`). */
const failed = (cause: unknown): TypeError => Object.assign(new TypeError("fetch failed"), { cause });

/** The headers of a call as the node client takes them, with `Connection: close` set last so no caller's header can ask for the connection to stay. */
function headersOf(init: RequestInit | undefined): Record<string, string> {
  const own: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => { own[name] = value; });
  return { ...own, connection: "close" };
}

/** The body of a call as bytes, or undefined for none. A string, bytes and nothing else are sent: the Linear client sends no other. */
function bodyOf(init: RequestInit | undefined): Buffer | undefined {
  const body = init?.body;
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError("freshFetch sends a string or bytes as a body");
}

/** One request on a connection of its own, answered whole. Rejects with `fetch failed` and the cause, or with the signal's reason. */
function once(url: URL, init: RequestInit | undefined, timeoutMs: number): Promise<{ response: IncomingMessage; body: Buffer }> {
  const bytes = bodyOf(init);
  const send = url.protocol === "http:" ? httpRequest : httpsRequest;
  return new Promise((resolve, reject) => {
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) return reject(signal.reason);
    const call = send(url, { method: init?.method ?? "GET", headers: { ...headersOf(init), ...(bytes === undefined ? {} : { "content-length": String(bytes.length) }) }, agent: false });
    // Declared before they are used by each other: `stop` ends the call and lets go of the timer and the listener, as a call that ended by itself does.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => stop(signal?.reason);
    const done = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    const stop = (error: unknown): void => { done(); call.destroy(); reject(error); };
    signal?.addEventListener("abort", onAbort, { once: true });
    // The deadline covers the whole call: a socket that accepted the request and then went silent is no more use than one that refused it.
    timer = setTimeout(() => stop(failed(timedOut(timeoutMs))), timeoutMs);
    call.on("error", (error) => { done(); reject(failed(error)); });
    call.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => { done(); resolve({ response, body: Buffer.concat(chunks) }); });
      response.on("error", (error) => { done(); reject(failed(error)); });
      response.on("aborted", () => { done(); reject(failed(Object.assign(new Error("the connection closed before the answer ended"), { code: "UND_ERR_SOCKET" }))); });
    });
    call.end(bytes);
  });
}

/** Whether `next` is a different origin than `from`: a call redirected there no longer carries the `Authorization` it was made with. */
const crossOrigin = (from: URL, next: URL): boolean => from.origin !== next.origin;

/**
 * A `fetch` over a connection that is opened for this call and closed after it. A redirect is followed up to {@link MAX_REDIRECTS} times, without the `Authorization` header once it leaves the origin (as `fetch` does).
 * `timeoutMs` bounds each request. Rejects like `fetch`: `TypeError("fetch failed")` with the reason in its cause.
 */
export function freshFetchWith(timeoutMs: number = FRESH_FETCH_TIMEOUT_MS): Fetch {
  return async (input, init) => {
    let url = new URL(input instanceof Request ? input.url : String(input));
    let call: RequestInit | undefined = init;
    for (let redirects = 0; ; redirects += 1) {
      const { response, body } = await once(url, call, timeoutMs);
      const status = response.statusCode ?? 0;
      const to = response.headers.location;
      if (REDIRECTED.has(status) && to !== undefined && redirects < MAX_REDIRECTS) {
        const next = new URL(to, url);
        const headers = new Headers(call?.headers);
        if (crossOrigin(url, next)) headers.delete("authorization");
        const seeOther = status === 303 || ((status === 301 || status === 302) && call?.method === "POST");
        call = { ...call, headers, ...(seeOther ? { method: "GET", body: undefined } : {}) };
        url = next;
        continue;
      }
      if (REDIRECTED.has(status) && to !== undefined) throw failed(new Error(`more than ${MAX_REDIRECTS} redirects`));
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) for (const each of [value ?? []].flat()) headers.append(name, each);
      return new Response(NO_BODY.has(status) ? null : new Uint8Array(body), { status, statusText: response.statusMessage ?? "", headers });
    }
  };
}

/** The `fetch` the board gives the tracker: a connection per call, and ten seconds for each. */
export const freshFetch: Fetch = freshFetchWith();
