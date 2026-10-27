// @ts-check
// module: a pull request that sits blocked with nobody on it (PURE) -- the round the board starts for it, and the note it shows when it cannot (A11-213, A11-352)
//
// A PULL REQUEST BLOCKED BY A REVIEW, WITH NO NEW PUSH AND NO RUN, IS NOBODY'S WORK. A worker that answers a requested change either pushes a fix (a new head) or hands the run to a person (`needs-human`), so a finished
// run whose pull request still reads changes-requested at the head the board first saw it blocked at, after `STALE_BLOCK_MINUTES`, is idle: on control#132 it sat an hour with auto-merge on and nothing told a person.
// The board stamps the first read of a block (`PullHead.blockedSince`, kept while the head and the review stay as they are). A block stamped for longer than the limit is a review nobody is answering, and the board answers it
// itself (A11-352): the watch queues the feedback round Respond would, for every pull request {@link staleBlocks} names, so no person has to press anything. Only a block the board CANNOT start a round for is the run's `handedBack`,
// which reads Needs you, and the note says why ({@link noRoundBecause}): the run is not one the board answers (a draft waits for Approve), or the stand-off of the head has ended without agreement, or the board has asked the worker about this head already. A run at the cap on the board's rounds
// is handed back by the round itself (`feedbackRound`), which names the cap.
// A run that is running or queued has a round on the pull request, and a parked run is already a person's: neither is flagged.
import { pullLabel } from "./pull-label.ts";
import { isParked, isWatched } from "./pull-status-and-notes.ts";
import { openPulls, type PullHead, type ViewEntry } from "./view-types-and-filters.ts";

/** A stand-off as the board reads it (A11-290). */
type ViewStandoff = NonNullable<ViewEntry["standoff"]>;

/** How long a pull request may sit blocked with no new push and no run before the board flags it. */
export const STALE_BLOCK_MINUTES = 30;

/** How a stale-block note reads once written: the board recognises its own `handedBack` by this form, as it does a conflict's, and clears no other. Notes written before A11-352 ended `a person decides`, whatever the reason. */
export const STALE_BLOCK_LINE = /has sat changes requested at `[^`]*` for more than \d+ minutes, with no new push and no run: /;

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

/** Whether the stand-off is for pull request `url` at `head`. PURE. */
const isStandoffOf = (standoff: ViewStandoff | undefined, url: string, head: string): standoff is ViewStandoff => standoff?.url === url && standoff.head === head;

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
  if (!isStandoffOf(standoff, url, head)) return false;
  if (standoff.stage === "open") return isWatched(entry);
  return standoff.stage === "planned" && now - (standoff.decidedAt ?? 0) <= STALE_BLOCK_MINUTES * 60_000;
}

/**
 * What the reviewer and the worker last said, and what the planner decided, when the pull request's block is a stand-off (A11-290): the card then tells the person what both routes came to. Empty when it is not one. PURE.
 */
function standoffAccount(standoff: ViewStandoff | undefined, url: string, head: string): string {
  if (!isStandoffOf(standoff, url, head)) return "";
  const planner = standoff.planner === undefined ? "the planner was not asked" : `the planner ${standoff.planner.decision}: ${saidOf(standoff.planner.reason)}`;
  return `. The reviewer last said: ${saidOf(standoff.reasons)}; the worker last said: ${standoff.reply === null ? "nothing on the pull request" : saidOf(standoff.reply)}; ${planner}`;
}

/** A pull request of a finished run that has sat changes requested at its head for more than {@link STALE_BLOCK_MINUTES}, with nothing holding it back: its address and its head. */
export type StaleBlock = Readonly<{ url: string; head: string }>;

/**
 * The open pull requests of a finished run that is not parked which have sat changes requested at their recorded head for more than {@link STALE_BLOCK_MINUTES} minutes. A block that is a stand-off (A11-290) waits for both
 * of its routes to end before it is named. PURE.
 */
export function staleBlocks(entry: ViewEntry, now: number): readonly StaleBlock[] {
  if (entry.phase !== "finished" || isParked(entry)) return [];
  const limit = STALE_BLOCK_MINUTES * 60_000;
  return openPulls(entry).flatMap(({ url }) => {
    const head = entry.pullHeads?.[url];
    const stood = head !== undefined && head.review === "changes-requested" && head.blockedSince !== undefined && now - head.blockedSince > limit;
    return head === undefined || !stood || standoffHolds(entry, entry.standoff, url, head.head, now) ? [] : [{ url, head: head.head }];
  });
}

/**
 * The stale blocks the board answers itself (A11-352), as the line a feedback round carries: the run is one the board watches ({@link isWatched}) and the head has no stand-off, which has its own two routes and ends with a person.
 * What it leaves out, {@link staleBlockNote} says why. The cap on the board's rounds is not checked here: `feedbackRound` hands a run at the cap to the planner or to a person, naming the cap. PURE.
 */
export function blocksToAnswer(entry: ViewEntry, now: number): readonly StaleBlock[] {
  return isWatched(entry) ? staleBlocks(entry, now).filter((block) => !isStandoffOf(entry.standoff, block.url, block.head) && !wasAsked(entry, block)) : [];
}

/** Whether the board has already started a round for this block's head ({@link ViewEntry.blockAsked}): it asks once for each head. PURE. */
const wasAsked = (entry: ViewEntry, { url, head }: StaleBlock): boolean => entry.blockAsked?.[url] === head;

/** The line a feedback round carries for the blocks it answers, one for each pull request. PURE. */
export const blockRoundLine = ({ url, head }: StaleBlock): string => `${pullLabel(url)} has sat changes requested at \`${head.slice(0, 8)}\` for more than ${STALE_BLOCK_MINUTES} minutes with no new push: answer the review, then push.`;

/** Why the board cannot start the round that answers the stale block of `entry` at `block`, in the words after the note's colon. A block the board can start a round for gives no reason, and so no note. PURE. */
function noRoundBecause(entry: ViewEntry, block: StaleBlock): string | null {
  if (isStandoffOf(entry.standoff, block.url, block.head)) return "a person decides";
  if (wasAsked(entry, block)) return "the board already asked the worker to answer it at this head, which has not moved: a person decides";
  // A note of this kind is what makes the run read Needs you and so unwatched: without it the run is the one the board answers, and the note goes.
  const withoutNote = isStaleBlockNote(entry.handedBack) ? { ...entry, handedBack: undefined } : entry;
  if (!isWatched(withoutNote)) return entry.outcome?.kind === "draft-pr" ? "the pull request is a draft, and Approve starts the round that answers the review" : "the board does not start a round on a run that ended this way, and Respond to review does";
  return null;
}

/**
 * The note for a finished run that is not parked and has an open pull request which has sat changes requested at its recorded head for more than {@link STALE_BLOCK_MINUTES} minutes and which the board CANNOT start a round for
 * ({@link noRoundBecause}): one sentence for each such pull request naming it and its head and why no round starts, or null when none has. A block that is a stand-off (A11-290) waits for both routes to end, and then says what the reviewer and the worker last said and what the planner decided.
 * The minutes are not written in it, so the note is the same on every watch and the queue is not rewritten for a clock. PURE.
 */
export function staleBlockNote(entry: ViewEntry, now: number): string | null {
  const blocked = staleBlocks(entry, now).flatMap((block) => {
    const why = noRoundBecause(entry, block);
    return why === null ? [] : [`${pullLabel(block.url)} has sat changes requested at \`${block.head.slice(0, 8)}\` for more than ${STALE_BLOCK_MINUTES} minutes, with no new push and no run: ${why}${standoffAccount(entry.standoff, block.url, block.head)}`];
  });
  return blocked.length === 0 ? null : blocked.join("; ");
}
