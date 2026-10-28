// @ts-check
// module: what a queued run's start is decided on (A11-364) -- the last known state of its blockers and plan, its age, and the reason a run is held when that state is not known
//
// A LIVE READ NEVER GATES A START. The pool reads blockers, stacked heads and plan paths in the background, each with a timeout (`pool-start-reads.ts`), and `fill` decides from what those reads last recorded. A run
// whose blockers or plan have never been read, or whose last read failed and whose known state is too old to start on, is held with the reason below; every other run starts. PURE: the pool's clock is given.

/** How long the pool waits for one read of the tracker, the code host or a remote before it counts as failed. */
export const READ_TIMEOUT_MS = 20_000;

/** How long after a failed read STARTED the board asks again: less than a pass (30 s), so the next pass after a failure asks again, however long the read took to fail. */
export const READ_RETRY_MS = 25_000;

/** How old the blockers last read may be and still start a run. Older than this, they are read again before the run starts, and a run whose read fails is held. */
export const BLOCKERS_MAX_AGE_MS = 30 * 60_000;

/** The fields of a queued run the start reads decide on. */
export type ReadState = Readonly<{
  phase: string;
  blockers?: readonly unknown[];
  blockersReadAt?: number;
  blockersFailure?: Readonly<{ error: string; retryAt: number }>;
  paths?: readonly string[];
  plan?: unknown;
  review?: unknown;
  pathsFailure?: string;
  pathsRetryAt?: number;
}>;

/** The time of day a retry is at, as the board words it: `00:12Z`. PURE. */
export const retryTime = (at: number): string => `${new Date(at).toISOString().slice(11, 16)}Z`;

/** Whether a queued run's plan paths are still to be read: a run that is not planning or reviewing, and has not been read yet. A planning run is never held by a path, and a review round keeps the paths of the run it continues. */
export const pathsUnread = (entry: ReadState): boolean => entry.phase === "queued" && entry.paths === undefined && entry.plan === undefined && entry.review === undefined;

/** The limit in words, as the board says it. */
const MAX_AGE_WORDS = `${BLOCKERS_MAX_AGE_MS / 60_000} minutes`;

/** Whether the blockers a queued run has are too old to start on at `now`: read longer ago than {@link BLOCKERS_MAX_AGE_MS}, or at a time nobody recorded (a queue an older board wrote). PURE. */
export const blockersStale = (entry: ReadState, now: number): boolean =>
  entry.blockers !== undefined && (entry.blockersReadAt === undefined || now - entry.blockersReadAt > BLOCKERS_MAX_AGE_MS);

/** The words after a failed read: what the tracker said, and when the board asks again. */
const failedWords = ({ error, retryAt }: NonNullable<ReadState["blockersFailure"]>): string => `${error}, retrying at ${retryTime(retryAt)}`;

/** The reason a queued run's blockers keep it from starting, or null: they were never read, or are too old and not read again yet. Without `now` age is not judged. PURE. */
export function blockersHold(entry: ReadState, now?: number): string | null {
  const failure = entry.blockersFailure;
  if (entry.blockers === undefined) return `blockers unread: ${failure === undefined ? "not read yet" : failedWords(failure)}`;
  if (now === undefined || !blockersStale(entry, now)) return null;
  const read = entry.blockersReadAt === undefined ? "at a time not recorded" : `at ${retryTime(entry.blockersReadAt)}`;
  return `blockers last read ${read}, older than ${MAX_AGE_WORDS}: ${failure === undefined ? "reading them again" : failedWords(failure)}`;
}

/**
 * What the board says of a queued run held for blockers the tracker could not give, or null (A11-364): the run's blockers were never read, or were last read too long ago to start on when the read failed, and the failure is
 * recorded. It needs no clock: a failure is the last word on the read until a read succeeds and clears it. A run whose read has only not been made yet says nothing, as it starts on the read in a moment. PURE.
 */
export const blockersFailureNote = (entry: ReadState): string | null =>
  entry.phase === "queued" && entry.blockersFailure !== undefined ? blockersHold(entry, entry.blockersFailure.retryAt) : null;

/** The reason a queued run's plan keeps it from starting, or null: its paths were never read. A plan that failed says why and when the board asks again. PURE. */
export function pathsHold(entry: ReadState): string | null {
  if (entry.pathsFailure !== undefined) return `plan unread: ${entry.pathsFailure}${entry.pathsRetryAt === undefined ? "" : `, retrying at ${retryTime(entry.pathsRetryAt)}`}`;
  return pathsUnread(entry) ? "plan unread: not read yet" : null;
}

/** The reason the last known state of a queued run's blockers and plan does not let it start, or null when it does. PURE. */
export const startReadHold = (entry: ReadState, now?: number): string | null =>
  entry.phase !== "queued" ? null : blockersHold(entry, now) ?? pathsHold(entry);
