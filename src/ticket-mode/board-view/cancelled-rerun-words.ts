// @ts-check
// module: what the board says of a cancelled run it reran (A11-342) -- PURE
//
// ONE WORDING FOR THE LOG AND THE TIMELINE, as `base-merge-words.ts` is.
import { pullLabel } from "./pull-label.ts";

/** The characters of a head the line names, as GitHub's own short form does. */
const HEAD_CHARS = 8;

/** What a rerun of cancelled runs is worded from: the pull request, the head they blocked it at, the required checks they were runs of, and why the code host would not rerun them, in its first line, when it would not. */
export type CancelledRerun = Readonly<{ url: string; head: string; checks: readonly string[]; refused?: string }>;

/**
 * The board's line for the rerun of the cancelled runs that blocked a pull request at a head: "a11ign/announcement-emulator #32 is blocked behind a cancelled run of gate at 8b3d0ba9: reran it", or, when the code host would not,
 * "...: could not rerun it (run 40438392613 cannot be rerun)". PURE.
 */
export function cancelledRerunWords({ url, head, checks, refused }: CancelledRerun): string {
  const of = checks.length === 0 ? "a required check" : checks.join(", ");
  const blocked = `${pullLabel(url)} is blocked behind a cancelled run of ${of} at ${head.slice(0, HEAD_CHARS)}`;
  return refused === undefined ? `${blocked}: reran it` : `${blocked}: could not rerun it (${refused})`;
}
