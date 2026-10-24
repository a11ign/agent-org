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
