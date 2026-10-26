// @ts-check
// module: a pull request that sits blocked with nobody on it (PURE) -- the note the board shows when a review requested changes and nothing has moved (A11-213)
//
// A PULL REQUEST BLOCKED BY A REVIEW, WITH NO NEW PUSH AND NO RUN, IS NOBODY'S WORK. A worker that answers a requested change either pushes a fix (a new head) or hands the run to a person (`needs-human`), so a finished
// run whose pull request still reads changes-requested at the head the board first saw it blocked at, after `STALE_BLOCK_MINUTES`, is idle: on control#132 it sat an hour with auto-merge on and nothing told a person.
// The board stamps the first read of a block (`PullHead.blockedSince`, kept while the head and the review stay as they are), and a block stamped for longer than the limit is the run's `handedBack`, which reads Needs you.
// A run that is running or queued has a round on the pull request, and a parked run is already a person's: neither is flagged.
import { pullLabel } from "./pull-label.ts";
import { isParked, isWatched } from "./pull-status-and-notes.ts";
import { openPulls, type PullHead, type ViewEntry } from "./view-types-and-filters.ts";

/** A stand-off as the board reads it (A11-290). */
type ViewStandoff = NonNullable<ViewEntry["standoff"]>;

/** How long a pull request may sit blocked with no new push and no run before the board flags it. */
export const STALE_BLOCK_MINUTES = 30;

/** How a stale-block note reads once written: the board recognises its own `handedBack` by this form, as it does a conflict's, and clears no other. */
export const STALE_BLOCK_LINE = /has sat changes requested at `[^`]*` for more than \d+ minutes, with no new push and no run: a person decides/;

/** Whether `text` is a stale-block note the board wrote. PURE. */
export const isStaleBlockNote = (text: string | undefined): boolean => text !== undefined && STALE_BLOCK_LINE.test(text);

/** The heads of one run's pull requests as the watch read them now, each blocked one stamped with when the board first saw it blocked at that head: kept from `before` while the head and the block stay, else `now`. PURE. */
export function stampedBlocks(heads: Readonly<Record<string, PullHead>>, before: Readonly<Record<string, PullHead>> | undefined, now: number): Readonly<Record<string, PullHead>> {
  return Object.fromEntries(Object.entries(heads).map(([url, head]) => {
    const { blockedSince: _earlier, ...unstamped } = head;
    if (head.review !== "changes-requested") return [url, unstamped];
    const earlier = before?.[url];
    const kept = earlier?.head === head.head && earlier.review === "changes-requested" ? earlier.blockedSince : undefined;
    return [url, { ...unstamped, blockedSince: kept ?? now }];
  }));
}

/** The longest a quoted line of the stand-off is in the note, in characters. */
const SAID_CHARS = 200;

/** The first words of what was said, on one line and cut. PURE. */
function saidOf(text: string): string {
  const line = text.split("\n").map((each) => each.trim()).find((each) => each !== "" && !each.startsWith("**Review of")) ?? text.trim();
  return line.length > SAID_CHARS ? `${line.slice(0, SAID_CHARS - 1)}…` : line;
}

/**
 * Whether the stand-off of this pull request's head (A11-290) still has a route to go, so the flag waits: it is open and the board watches the run (the next watch routes it), or the planner has decided it within the limit (an upheld decision goes to
 * the worker next, an amended one to the reviewer). A stand-off whose rounds have both ended, or whose round failed, holds nothing: the flag fires once the block has stood the limit, as it always did. PURE.
 */
function standoffHolds(entry: ViewEntry, standoff: ViewStandoff | undefined, url: string, head: string, now: number): boolean {
  if (standoff?.url !== url || standoff.head !== head) return false;
  if (standoff.stage === "open") return isWatched(entry);
  return standoff.stage === "planned" && now - (standoff.decidedAt ?? 0) <= STALE_BLOCK_MINUTES * 60_000;
}

/**
 * What the reviewer and the worker last said, and what the planner decided, when the pull request's block is a stand-off (A11-290): the card then tells the person what both routes came to. Empty when it is not one. PURE.
 */
function standoffAccount(standoff: ViewStandoff | undefined, url: string, head: string): string {
  if (standoff?.url !== url || standoff.head !== head) return "";
  const planner = standoff.planner === undefined ? "the planner was not asked" : `the planner ${standoff.planner.decision}: ${saidOf(standoff.planner.reason)}`;
  return `. The reviewer last said: ${saidOf(standoff.reasons)}; the worker last said: ${standoff.reply === null ? "nothing on the pull request" : saidOf(standoff.reply)}; ${planner}`;
}

/**
 * The note for a finished run that is not parked and has an open pull request which has sat changes requested at its recorded head for more than {@link STALE_BLOCK_MINUTES} minutes, one sentence for each such pull request
 * naming it and its head, or null when none has. A block that is a stand-off (A11-290) waits for both routes to end, and then says what the reviewer and the worker last said and what the planner decided. The minutes are not written in it, so the note is the same on every watch and the queue is not rewritten for a clock. PURE.
 */
export function staleBlockNote(entry: ViewEntry, now: number): string | null {
  if (entry.phase !== "finished" || isParked(entry)) return null;
  const limit = STALE_BLOCK_MINUTES * 60_000;
  const blocked = openPulls(entry).flatMap(({ url }) => {
    const head = entry.pullHeads?.[url];
    const stood = head !== undefined && head.review === "changes-requested" && head.blockedSince !== undefined && now - head.blockedSince > limit;
    if (head === undefined || !stood || standoffHolds(entry, entry.standoff, url, head.head, now)) return [];
    return [`${pullLabel(url)} has sat changes requested at \`${head.head.slice(0, 8)}\` for more than ${STALE_BLOCK_MINUTES} minutes, with no new push and no run: a person decides${standoffAccount(entry.standoff, url, head.head)}`];
  });
  return blocked.length === 0 ? null : blocked.join("; ");
}
