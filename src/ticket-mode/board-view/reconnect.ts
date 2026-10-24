// @ts-check
// module: when the board reads again and which failed reads are an instance restarting, as pure functions the page and the UI package's poll both apply
//
// An auto-update restarts the instance and the page's own service, 10 to 30 s each time. A read that fails in that window is not an error the server answered with, so the
// board says "Reconnecting..." and tries again with a growing wait, and shows red only for an answer. This file is the one place that rule and that wait are written.

/** How long after a successful read the next one is made. */
export const POLL_MS = 5_000;

/** The wait after the first failure in a row, which doubles with each further one up to `MAX_BACKOFF_MS`. */
export const MIN_BACKOFF_MS = 2_000;
export const MAX_BACKOFF_MS = 60_000;

/** The wait before the next read: `POLL_MS` after a success (no failures in a row), else 2s, 4s, 8s ... capped at 60s. PURE. */
export function nextDelay(failuresInARow: number): number {
  if (failuresInARow <= 0) return POLL_MS;
  return Math.min(MIN_BACKOFF_MS * 2 ** (failuresInARow - 1), MAX_BACKOFF_MS);
}

/** How every one of `ticket:ui`'s three "cannot reach" answers for a connection begins (`remote-proxy.ts`'s `proxy`). */
export const CANNOT_REACH = "cannot reach ";

const NO_ANSWER = 0;
const BAD_GATEWAY = 502;
const SERVICE_UNAVAILABLE = 503;

/**
 * Whether a failure means an SSH remote connection's proxy could not reach it. A local or https connection that fails is not this, and nor is a reached
 * instance that answered something that is not JSON, which the proxy also answers with 502 but does not word as "cannot reach". PURE.
 */
export function isUnreachable(connection: Readonly<{ kind: string }> | null, status: number, refusal: string): boolean {
  return connection?.kind === "ssh" && status === BAD_GATEWAY && refusal.startsWith(CANNOT_REACH);
}

/**
 * Whether a failed read looks like the instance, or the service in front of it, restarting: no answer at all (`status` 0: connection refused or a network error), or a 502 or
 * 503 from a proxy. An SSH remote its proxy cannot reach is {@link isUnreachable} instead, its own state. Anything else is an error the server answered with. PURE.
 */
export function looksLikeRestart(connection: Readonly<{ kind: string }> | null, status: number, refusal: string): boolean {
  if (isUnreachable(connection, status, refusal)) return false;
  return status === NO_ANSWER || status === BAD_GATEWAY || status === SERVICE_UNAVAILABLE;
}
