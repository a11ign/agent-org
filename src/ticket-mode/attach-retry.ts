// @ts-check
// module: telling a plan attach that hit a network or server failure, which the board tries again, from a refusal, which goes to a person (A11-216)

export const MS_PER_SECOND = 1_000;

/** How many times the board asks the tracker to attach a plan before a transient failure goes to a person: the first try and three retries. */
export const ATTACH_TRIES = 4;

/** How long the board waits after the first, second and third failed try before the next one, in milliseconds: 5 s, 30 s and 2 min. */
export const ATTACH_WAITS_MS: readonly number[] = [5 * MS_PER_SECOND, 30 * MS_PER_SECOND, 120 * MS_PER_SECOND];

const NETWORK_ERROR_NAMES = new Set(["AbortError", "TimeoutError"]);

const NETWORK_ERROR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE"]);

/** undici's own codes (`UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_SOCKET`, ...) start with this. */
const UNDICI_CODE_PREFIX = "UND_ERR_";

/** `err` and the error it names as its `cause`, one level down: Node's `fetch` throws `TypeError("fetch failed")` and puts the reason in the cause. */
export const withCause = (err: unknown): unknown[] => [err, (err as { cause?: unknown } | null | undefined)?.cause];

function isNetworkFailure(err: unknown): boolean {
  if (err instanceof TypeError && err.message === "fetch failed") return true;
  const { name, code } = (err ?? {}) as { name?: unknown; code?: unknown };
  if (typeof name === "string" && NETWORK_ERROR_NAMES.has(name)) return true;
  return typeof code === "string" && (NETWORK_ERROR_CODES.has(code) || code.startsWith(UNDICI_CODE_PREFIX));
}

function isServerFailure(err: unknown): boolean {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" && status >= 500 && status <= 599;
}

/**
 * Whether a plan attach that threw `err` is worth trying again as it is: a failure of the network (`fetch failed`, a timeout, a reset or an undici socket error), or a 5xx the tracker answered with.
 * Anything else is a refusal (a 4xx, a validation error, a GraphQL error on a 200) and goes to a person at once. It reads the error's type, its `code` and the numeric `status` a tracker puts on the
 * error it throws, on the error or its cause, and never the message text. PURE.
 */
export const isTransient = (err: unknown): boolean => withCause(err).some((one) => isNetworkFailure(one) || isServerFailure(one));
