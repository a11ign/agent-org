import type { ViewConnection } from "./types.ts";

/**
 * What a call to the instance API comes to, as data. A call never throws: a success carries the server's JSON, and a failure carries the server's own
 * `error` sentence as `refusal`, so a page shows the backend's real words. `status` is 0 when no answer came at all.
 */
export type Answer<T> = Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; status: number; refusal: string; unreachable: boolean }>;

/** The words for an answer that is not JSON, since a page has nothing of the server's own to show. */
export const NOT_JSON = "the instance answered with something that is not JSON";

/** How every one of `ticket:ui`'s three "cannot reach" answers for a connection begins (`remote-proxy.ts`'s `proxy`). */
export const CANNOT_REACH = "cannot reach ";

const BAD_GATEWAY = 502;

/**
 * Whether a failure means an SSH remote connection's proxy could not reach it. A local or https connection that fails is an error, and so is a reached
 * instance that answered something that is not JSON, which the proxy also answers with 502 but does not word as "cannot reach".
 */
export function isUnreachable(connection: ViewConnection | null, status: number, refusal: string): boolean {
  return connection?.kind === "ssh" && status === BAD_GATEWAY && refusal.startsWith(CANNOT_REACH);
}

/** The refusal in a failed answer's JSON: its `error` sentence, or the status text when it names none. */
function refusalOf(value: unknown, response: Pick<Response, "status" | "statusText">): string {
  const error = typeof value === "object" && value !== null ? (value as { error?: unknown }).error : undefined;
  return typeof error === "string" && error !== "" ? error : response.statusText || `HTTP ${response.status}`;
}

/** The failure a rejected `fetch` comes to: no answer, with the browser's message. */
export function failedToSend(error: unknown): Answer<never> {
  return { ok: false, status: 0, refusal: error instanceof Error ? error.message : String(error), unreachable: false };
}

/** Read a response into an answer: its JSON on success, and the server's refusal as data otherwise. */
export async function answerOf<T>(connection: ViewConnection | null, response: Response): Promise<Answer<T>> {
  let value: unknown;
  try {
    value = JSON.parse(await response.text());
  } catch {
    return { ok: false, status: response.status, refusal: NOT_JSON, unreachable: isUnreachable(connection, response.status, NOT_JSON) };
  }
  if (response.ok) return { ok: true, data: value as T };
  const refusal = refusalOf(value, response);
  return { ok: false, status: response.status, refusal, unreachable: isUnreachable(connection, response.status, refusal) };
}
