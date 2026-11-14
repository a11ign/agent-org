// @ts-check
// module: the GitHub REST client of the GitHub Issues plugin -- one call to api.github.com with the token, tried again on a 429, a 5xx or a lost connection (A11-447)
//
// EVERY CALL GOES THROUGH THE INJECTED `fetch`, so the plugin's tests answer from an in-memory repository (`fake-github.ts`) and nothing reaches GitHub. A first attempt goes through `fetch`
// and each retry through `retryFetch`, so the board counts a call once however many times it is tried (A11-345), as the Linear plugin does. A failed answer throws an error carrying
// the HTTP `status` (tracker contract 1.7), so the board tries a plan attach again on a 5xx without reading the message.

export const GITHUB_API = "https://api.github.com";

/** The waits before the first, second and third retry, in milliseconds: a call is made at most four times. */
export const RETRY_WAITS_MS: readonly number[] = [200, 800, 2_000];
/** How long one attempt may take before it is dropped and tried again on a new connection. */
const ATTEMPT_MS = 10_000;

/** The seams a call goes through: the token, the two `fetch`es, the wait between attempts, and the log a retry is said in. */
export type Client = Readonly<{ token: string; request: typeof fetch; retryRequest: typeof fetch; sleep: (ms: number) => Promise<void>; log: (line: string) => void }>;

/** An error that carries the HTTP `status` GitHub answered with, as data (tracker contract 1.7). */
export const answered = (message: string, status: number): Error => Object.assign(new Error(message), { status });

/** Whether `error` is an answer of `status`. */
export const isStatus = (error: unknown, status: number): boolean => (error as { status?: unknown } | null)?.status === status;

/** GitHub asks to be called again later with a 429, and fails itself with a 5xx. */
const TOO_MANY_REQUESTS = 429;
const SERVER_ERRORS = { from: 500, to: 599 } as const;
const retryableStatus = (status: number): boolean => status === TOO_MANY_REQUESTS || (status >= SERVER_ERRORS.from && status <= SERVER_ERRORS.to);
const isConnectionFailure = (err: unknown): boolean => (err instanceof TypeError && err.message === "fetch failed") || (err as Error | null)?.name === "TimeoutError";

/** One call, tried again on a retryable answer or a lost connection, up to three times; the last answer or failure is the caller's. */
async function sendWithRetries(client: Client, url: string, init: RequestInit): Promise<Response> {
  for (let tried = 0; ; tried += 1) {
    const last = tried >= RETRY_WAITS_MS.length;
    let failure: unknown;
    try {
      const response = await (tried === 0 ? client.request : client.retryRequest)(url, { ...init, signal: AbortSignal.timeout(ATTEMPT_MS) });
      if (!retryableStatus(response.status) || last) return response;
      await response.arrayBuffer().catch(() => undefined);
      failure = answered(`GitHub answered ${response.status}`, response.status);
    } catch (err) {
      if (!isConnectionFailure(err) || last) throw err;
      failure = err;
    }
    client.log(`GitHub Issues: a call failed (${(failure as Error).message}), trying again in ${RETRY_WAITS_MS[tried]} ms`);
    await client.sleep(RETRY_WAITS_MS[tried]);
  }
}

/**
 * Calls `method path` of GitHub's REST API with `body` as JSON, and answers the parsed answer (null for an empty one). THROWS an error carrying the status for any answer that is not 2xx,
 * so a caller tells a missing issue (404) from a refusal by `isStatus`.
 */
export async function callGitHub<T>(client: Client, method: string, path: string, body?: unknown): Promise<T> {
  const response = await sendWithRetries(client, `${GITHUB_API}${path}`, {
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
