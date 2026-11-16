// @ts-check
// module: what the board says of a cancelled run it reran, and of the stop when it was cancelled again and again (A11-342, A11-403) -- PURE
//
// ONE WORDING FOR THE LOG, THE TIMELINE AND THE CARD, as `base-merge-words.ts` is.
import { pullLabel } from "./pull-label.ts";

/** The characters of a head the line names, as GitHub's own short form does. */
const HEAD_CHARS = 8;

/** How many cancelled runs of a required check one head may have before the board stops rerunning it (A11-403): the first, and the runs of two accepted reruns. A third cancelled run is the stop. */
export const MAX_CANCELLED_RUNS = 3;

/** What a rerun of cancelled runs is worded from: the pull request, the head they blocked it at, the required checks they were runs of, why the code host would not rerun them, in its first line, when it would not, and that the board has stopped rerunning them. */
export type CancelledRerun = Readonly<{ url: string; head: string; checks: readonly string[]; refused?: string; stopped?: true }>;

/** That the board stopped rerunning the cancelled runs of a pull request at a head (A11-403), by the pull request's address in the run's `cancelledRerunStopped`: the head, and the line the card shows. */
export type CancelledStop = Readonly<{ head: string; note: string }>;

/**
 * The board's line for the rerun of the cancelled runs that blocked a pull request at a head: "a11ign/announcement-emulator #32 is blocked behind a cancelled run of gate at 8b3d0ba9: reran it", or, when the code host would not,
 * "...: could not rerun it (run 40438392613 cannot be rerun)", or, once the head's third cancelled run was read, "...: cancelled 3 times, the board has stopped rerunning it; a new push or a rerun clears it". PURE.
 */
export function cancelledRerunWords({ url, head, checks, refused, stopped }: CancelledRerun): string {
  const of = checks.length === 0 ? "a required check" : checks.join(", ");
  const blocked = `${pullLabel(url)} is blocked behind a cancelled run of ${of} at ${head.slice(0, HEAD_CHARS)}`;
  if (stopped === true) return `${blocked}: cancelled ${MAX_CANCELLED_RUNS} times, the board has stopped rerunning it; a new push or a rerun clears it`;
  return refused === undefined ? `${blocked}: reran it` : `${blocked}: could not rerun it (${refused})`;
}
