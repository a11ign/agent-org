import { READY_LABEL, CLAIM_LABEL } from "../../claim-labels.ts";
import { waitingOn, fleetWaitingOn, todayIso, ANSWER_PREFIX } from "../../waiting-condition.ts";
import { subjectMention, subjectRef } from "../../review-attribution.ts";
import { holdersOf } from "../../pr-hold-state.ts";
import { NEEDS_CHAIRMAN_LABEL as CHAIRMAN_LABEL } from "../../project-vocabulary.ts";
import { readUnlessRefused } from "../../ticket-port/rows-by-label.ts";
import { defaultRun } from "../reads/read-memo-and-exit.ts";
import { HOUR_MS, MAX_ROW_ORDERS_PER_TICK, NOT_PICKABLE, PARKED_LABEL, PROMOTION_ASK_WINDOW_MS, declaredBlockers, labelsOf } from "../vocabulary.ts";

/**
 * Whether a CLAIMED row is waiting on something, for the two readers that screen one (`blockerClearedOrders` and
 * `anyBlockerClearingCandidate`), so the population that pays for a `closings` read cannot drift from the one that
 * uses it. `fleetWaitingOn` is the declared-field waits (#2186); the two labels are the rest.
 *
 * `needs:chairman` AND `parked` ARE WAITS `waitingOn` DELIBERATELY DOES NOT READ, AND THIS IS THE FOURTH READER OF
 * THAT GAP (#2780, after #2583/#2604/#2653 closed the three that reach an UNCLAIMED row). The order says "PICK IT
 * BACK UP" to a holder whose row names a person or the schedule as the one thing it waits on: #2623
 * (`needs:chairman` from 2026-09-28T16:06:31Z) was asked 19+ times in a day, and the prompt's own remedies never
 * mention the label. Skipped here rather than taught to `waitingOn`, which every reader would then inherit.
 */
export function holderWaitingOn(row: any, today: string, nowMs: number) {
  const labels = labelsOf(row);
  return Boolean(fleetWaitingOn(row, today, nowMs)) || labels.includes(CHAIRMAN_LABEL) || labels.includes(PARKED_LABEL);
}

/**
 * THE THREE REASONS A `blocker-cleared` ORDER IS DROPPED (#3451), a CLOSED set: a fourth is a new decision, not a spelling, and `work-gate-stale-blocker-cleared.test.ts` fails on one.
 */
export type BlockerClearedDropReason = "claimed-after-clearing" | "own-pull-request" | "moved-since-clearing";

/**
 * `at` is the time that decided it: the claim's, the pull request's open or merge, or the holder's newest move
 */
export type BlockerClearedDrop = { causeKey: string, reason: BlockerClearedDropReason, at: number };

export const BLOCKER_CLEARED_DROP_REASONS = Object.freeze(["claimed-after-clearing", "own-pull-request", "moved-since-clearing"]);

const isoOf = (ms: number): string => new Date(ms).toISOString();

/**
 * WHY NO `blocker-cleared` ORDER IS NEEDED, or `null` when the holder still has to be told -- from facts the same tick already read (#3451).
 * #3390 was told "PICK IT BACK UP" 91 minutes after its blocker closed, 1 min 46 s after it had opened its pull request, having CLAIMED 101 s after the clearing.
 * In the order asked: (1) the claim post-dates the clearing, which the claim itself refused to be made before; (2) a pull request of the claim's own
 * (`ownsPr`, in ANY tracked repository) is open and not held (#2493: a held PR is a declared wait, whose owner must hear the last edge close) or merged since the
 * claim; (3) the holder commented, committed or pushed AFTER the clearing. A holder who claimed before and has done none of that (#1908) is not here.
 */
function whyNotNeeded(moves: import("../../work-gate/claim-stall-tick.ts").ClaimMoves, clearedAtMs: number, nowMs: number): { reason: BlockerClearedDropReason; at: number; } | null {
  if (moves.claimedAt >= clearedAtMs) return { reason: "claimed-after-clearing", at: moves.claimedAt };
  const opened = moves.openPrs.filter((pr) => holdersOf(labelsOf(pr)).length === 0).map((pr) => Date.parse(String(pr.createdAt)));
  const acts = [...opened.map((at) => (Number.isFinite(at) ? at : nowMs)), ...(moves.mergedAt === null ? [] : [moves.mergedAt])];
  if (acts.length > 0) return { reason: "own-pull-request", at: Math.min(...acts) };
  const moved = Math.max(...[moves.comment, moves.commit, moves.push].filter((t) => t !== null));
  return moved > clearedAtMs ? { reason: "moved-since-clearing", at: moved } : null;
}

/**
 * The read that was REFUSED, as a phrase, or `null` when every read the drop needs was made. FAILING TOWARD TELLING THE HOLDER: a refusal drops nothing, because
 * an order that should not have gone costs a wake and a drop that should not have happened strands a row (this function's own header).
 * A blocker ABSENT from a map that was read is a refusal only when the map carries no `closedNoLaterThan` (#3706): with one, the absent blocker is bounded, not unread.
 */
function refusedRead({ row, cleared, closings, claimFacts }: { row: any; cleared: number[]; closings: Closings | null; claimFacts: import("../../work-gate/claim-stall-tick.ts").ClaimFactsOfTick | null; }): string | null {
  if (claimFacts === null) return "the claim-stall tick read no claim";
  if (closings === null) return "the closing times were not read";
  if (closings.size === 0) return "the closing list was empty, so no bound exists for any blocker";
  const unclosed = cleared.find((n) => !closings.has(n));
  if (unclosed !== undefined && closings.closedNoLaterThan === undefined) return `the closing time of #${unclosed} was not read`;
  if (claimFacts.moves.has(Number(row.number))) return null;
  return `the claim read was refused (${claimFacts.skipped.get(Number(row.number)) ?? "the claim-stall tick did not evaluate this row"})`;
}

/**
 * The time the drop compares the claim against: the newest of the listed closings and, when a cleared blocker is ABSENT from the list, `closedNoLaterThan` (#3706).
 * `boundedBy` is that bound only when it decided the answer, so the log names it exactly when it was relied on. SOUND IN BOTH DIRECTIONS: the result is `>=` every blocker's
 * real closing, so a claim at or after it came after all of them, and a bound smaller than a listed closing changes nothing.
 */
function newestClosing(cleared: number[], closings: Closings): { at: number; boundedBy: { blocker: number; at: number; } | null; } {
  const listed = cleared.filter((n) => closings.has(n)).map((n) => (closings.get(n) as number));
  const absent = cleared.find((n) => !closings.has(n));
  const bound = closings.closedNoLaterThan;
  const newestListed = listed.length === 0 ? -Infinity : Math.max(...listed);
  if (absent === undefined || bound === undefined || bound <= newestListed) return { at: newestListed, boundedBy: null };
  return { at: bound, boundedBy: { blocker: absent, at: bound } };
}

/**
 * `blockerClearedReading`'s drop for ONE row about to be ordered, with the lines to print. `claimFacts` undefined is a caller that did not ask: no drop, no line.
 */
export function staleClearing({ row, cleared, causeKey, closings, claimFacts, nowMs }: {
        row: any; cleared: number[]; causeKey: string; closings: Closings | null; nowMs: number;
        claimFacts?: import("../../work-gate/claim-stall-tick.ts").ClaimFactsOfTick | null;
    }): { drop: BlockerClearedDrop | null; log: string[]; } {
  if (claimFacts === undefined) return { drop: null, log: [] };
  const refused = refusedRead({ row, cleared, closings, claimFacts });
  if (refused !== null || closings === null || claimFacts === null) {
    return { drop: null, log: [`blocker-cleared ${subjectMention(row)}: order KEPT -- ${refused}, so nothing was checked against it\n`] };
  }
  const moves = (claimFacts.moves.get(Number(row.number)) as import("../../work-gate/claim-stall-tick.ts").ClaimMoves);
  const { at: clearedAtMs, boundedBy } = newestClosing(cleared, closings);
  const closed = boundedBy === null ? `blockers closed ${isoOf(clearedAtMs)}`
    : `#${boundedBy.blocker} is absent from the closing list and closed no later than ${isoOf(boundedBy.at)}, the oldest listed updatedAt`;
  const why = whyNotNeeded(moves, clearedAtMs, nowMs);
  if (why === null) {
    return { drop: null, log: boundedBy === null ? [] : [`blocker-cleared ${subjectMention(row)}: order KEPT -- ${closed}, and the claim (${isoOf(moves.claimedAt)}) is not after it\n`] };
  }
  return { drop: { causeKey, ...why },
    log: [`SHELVED row ${subjectMention(row)}: blocker-cleared order dropped, ${why.reason} (claimed ${isoOf(moves.claimedAt)}, ${closed}, decided ${isoOf(why.at)})\n`] };
}

/**
 * WHEN AN UNANSWERED `unclaimed-blocker-cleared` ORDER MAY BE ASKED AGAIN -- #2286.
 *
 * MEASURED 2026-09-24 (a reading at a moment, from the host's wake ledger): 28 of `product-manager`'s 46
 * recent deliveries were this cause and 23 of them were four rows re-asked at an UNCHANGED key on the
 * two-hour `JUDGMENT_TTL_MS`, six times each over ten hours, with nothing changed between. #2280
 * re-measured the whole ledger and found the same thing at scale: 447 of 454 redundant deliveries were
 * this TTL re-ask working as designed, 7 were inside the window. So the defect is not a leak in the
 * dedupe; it is that the TTL is a FIXED interval, and a fixed interval is the right answer for a question
 * that may have been missed and the wrong one for a question that has been missed FIVE TIMES.
 *
 * A BACKOFF, DERIVED FROM WHEN THE ROW WAS CLEARED, so the gate stays stateless (see `decide`): the
 * order is emitted only during a WINDOW that opens at each offset after the last blocker closed.
 *
 *   0    the clearing itself, at once. #2139 exists because six rows sat runnable up to 16h09m; nothing
 *        here may delay the FIRST ask, and the key of this window is byte-identical to the pre-#2286 key.
 *   6h   a second ask, because an order that lands while `product-manager` is mid-turn is genuinely
 *        missed sometimes, and six hours is one working stretch. #2149 and #2092 were being worked ten
 *        hours after their first delivery, so the second ask is the one that earns its turn.
 *   24h  a third, a day on: the row is now the oldest thing in the queue and the ask is cheap next to
 *        the cost of a forgotten row.
 *   72h, AND EVERY 72h FOR EVER AFTER. THE TAIL NEVER ENDS, which is `ceo`'s first constraint: a row
 *        nobody answered must not go silent, or the treadmill is replaced by the forgotten row this
 *        cause was written to stop. Three days is a long weekend, so a row is never unasked longer.
 *
 * `ceo` DID NOT PICK THIS SCHEDULE AND NOTHING EVIDENCES IT; the four rows' cost under it is in #2286's
 * pull request, and a different ladder is a change to these two constants and nothing else.
 *
 * EACH WINDOW IS EXACTLY `JUDGMENT_TTL_MS` LONG, AND THAT COUPLING IS THE MECHANISM. `wake` dedupes a
 * judgment cause for two hours after a delivery, and a delivery can only happen inside the window, so a
 * key delivered at time `t >= start` is held until `t + 2h >= start + 2h`, the window's end: ONE delivery
 * per window with no state kept anywhere. A window shorter than the TTL would ask once per window too;
 * a longer one would let the TTL re-ask inside it, which is the treadmill. `work-gate.test.ts` pins the
 * two numbers equal, because `wake.ts` imports this file and cannot be imported back.
 *
 * A window whose order was never delivered (the session was busy, the tick was refused) is RETRIED every
 * tick until the window closes, then not until the next one -- the cost of stopping the treadmill, stated.
 */
export const PROMOTION_ASK_OFFSETS_MS = Object.freeze([0, 6 * HOUR_MS, 24 * HOUR_MS]);

/** The interval of the tail: an ask at every multiple of this after the ladder, for ever. */
export const PROMOTION_ASK_PERIOD_MS = 72 * HOUR_MS;

/**
 * PURE. The ask a row is in, `age` after its last blocker closed -- or `null` between asks.
 *
 * @param age milliseconds since the clearing; a future stamp (clock skew) reads as zero
 * @returns `suffix` is `""` for the first ask, else `@<hours>h`, and it is
 *          part of the causeKey so each window is a NEW question to `wake`'s ledger
 */
export function promotionAskWindow(age: number): { suffix: string; } | null {
  const at = Math.max(0, age);
  const tail = Math.floor(at / PROMOTION_ASK_PERIOD_MS) * PROMOTION_ASK_PERIOD_MS;
  const start = Math.max(tail, ...PROMOTION_ASK_OFFSETS_MS.filter((o) => o <= at));
  if (at - start >= PROMOTION_ASK_WINDOW_MS) return null;
  return { suffix: start === 0 ? "" : `@${start / HOUR_MS}h` };
}

/**
 * When the last of `cleared` closed, in epoch ms. A blocker missing from `closings` closed before the
 * window that read covers, so it counts as the epoch: the row lands on the wall-clock 72-hour grid
 * (`promotionAskWindow`'s tail) rather than being anchored to a moment nobody can name.
 */
function clearedAt(cleared: number[], closings: Map<number, number>) {
  return Math.max(...cleared.map((n) => closings.get(n) ?? 0));
}

/**
 * The backoff window a clearing is in, shared by `blockerClearedOrders` and `unclaimedBlockerClearedOrders`
 * (#2741) so the "no `closings`, no backoff" fallback is written once rather than as two ternaries that
 * could drift. `null` `closings` (not asked or refused) is the unstaged first ask, forever.
 */
export function clearingAskWindow(cleared: number[], nowMs: number, closings: Map<number, number> | null): { suffix: string; } | null {
  return closings ? promotionAskWindow(nowMs - clearedAt(cleared, closings)) : { suffix: "" };
}

/** How many rows `readRecentlyClosed` asks for. */
const RECENTLY_CLOSED_LIMIT = 100;
/** A commit sha the `Head:` line may carry: the same 7-40 lowercase hex the class's `HEAD_PATTERN` reads back. */
const HEAD_SHA = /^[0-9a-f]{7,40}$/;

/**
 * When each listed row closed. `closedNoLaterThan` is set only by `readRecentlyClosed` and only when its list is PROVEN ordered by `updatedAt`: every row ABSENT from the map then closed no later than it (#3706). A plain `Map` -- a test's, an old caller's -- carries none, and an absent blocker is then a read that was not made.
 */
export type Closings = Map<number, number> & { closedNoLaterThan?: number };

/**
 * `closedNoLaterThan` of a listing, or `undefined` when the listing cannot prove one: a row without a readable `updatedAt`, or an order that is not `updatedAt` descending.
 * THE ORDER IS CHECKED, NOT TRUSTED: `gh` silently ignores a sort key it does not know (`sort:closed-desc` returns the creation order, measured 2026-10-06), and the oldest
 * `updatedAt` of a list sorted by anything else bounds nothing.
 */
function oldestUpdatedWhenOrdered(listed: any[]): number | undefined {
  const updated = listed.map((r) => Date.parse(r?.updatedAt));
  const ordered = updated.length > 0 && updated.every((at, i) => Number.isFinite(at) && (i === 0 || updated[i - 1] >= at));
  return ordered ? updated[updated.length - 1] : undefined;
}

/**
 * When each row of the listing closed, or `null` when the read is refused.
 *
 * THE LISTING IS THE 100 MOST RECENTLY UPDATED CLOSED ROWS, NOT THE 100 MOST RECENTLY CLOSED (#3706). `gh issue list` orders by CREATION, so a plain
 * `--state closed --limit 100` leaves out an old row that closed today (measured 2026-10-06: 15 rows closed after the oldest listed closing were absent, #3534 among them), and
 * the older text of this header, "about two days of merges", described a list that was never read. `--search sort:updated-desc` is the order that bounds an absent row: `closedAt <= updatedAt`,
 * so a row absent from a list sorted by `updatedAt` has an `updatedAt` no later than the oldest listed one and CLOSED no later than it -- `closedNoLaterThan`, see `Closings`.
 *
 * ONE CALL FOR EVERY BLOCKER, NOT ONE PER ROW: `gh`'s `blockedBy` nodes carry `number` and `state` and no
 * closing time, and a per-blocker `issue view` would make the tick's cost a function of how many rows are
 * waiting -- the property `GH_READS` exists to protect. A blocker older than this list is treated as old
 * (`clearedAt`) by the backoff, and as closed no later than `closedNoLaterThan` by `staleClearing`.
 *
 * `null` IS "COULD NOT READ" AND `unclaimedBlockerClearedOrders` FAILS OPEN ON IT: with no closing time the
 * gate asks at the unstaged key, which is the pre-#2286 behaviour. The alternative -- reading a refused
 * call as "everything closed long ago" -- would silence a FRESH clearing behind the 72-hour grid, the
 * exact stranding #2139 was written to end.
 */
export function readRecentlyClosed(run: (args: string[]) => string = defaultRun): Closings | null {
  try {
    // #5050: `--search sort:updated-desc` was a SEARCH. The connection orders by the same field, newest update first, which `oldestUpdatedWhenOrdered` reads.
    const query = "query($owner:String!,$name:String!,$first:Int!){repository(owner:$owner,name:$name){issues(states:CLOSED,first:$first,"
      + "orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number closedAt updatedAt}}}}";
    const args = ["api", "graphql", "-f", `query=${query}`, "-F", "owner={owner}", "-F", "name={repo}", "-F", `first=${RECENTLY_CLOSED_LIMIT}`];
    const parsed = JSON.parse(readUnlessRefused({ what: `the ${RECENTLY_CLOSED_LIMIT} newest-updated CLOSED rows`, run, read: () => run(args) }))?.data?.repository?.issues?.nodes;
    if (!Array.isArray(parsed)) return null;
    const closings: Closings = new Map();
    for (const r of parsed) {
      const at = Date.parse(r?.closedAt);
      if (Number.isFinite(at)) closings.set(Number(r.number), at);
    }
    const bound = oldestUpdatedWhenOrdered(parsed);
    if (bound !== undefined) closings.closedNoLaterThan = bound;
    return closings;
  } catch {
    return null;
  }
}

/**
 * THE SAME CLEARING, ONE POPULATION OVER: an UNCLAIMED row whose last declared blocker closed -- #2139.
 *
 * `blockerClearedOrders` above scopes itself with `labelsOf(row).includes(CLAIM_LABEL)`, and that single
 * condition is the whole gap. A row NOBODY holds reaches no cause at all when its blockers clear:
 * `blocker-cleared` wants a claim, `lane-backlog-unpromoted` addresses only a lane OWNER, and
 * `ready-queue-empty` fires only when the unlaned Ready pool is EMPTY. So a `lane:any` backlog row that
 * has just become startable is visible to the gate and addressed by nothing in it.
 *
 * MEASURED 2026-09-23 ON THE LIVE TRACKER, and the shape is the point rather than the six rows. A sweep
 * for open rows whose every declared blocker is CLOSED returned SIX -- none claimed, none `ready`, all
 * `lane:any`, every one structurally startable -- stranded 57m, 4h30m, 13h43m, 13h51m, 14h09m and
 * **16h09m**, with three of five peer sessions idle the whole time. They were found because a queued
 * report about an unrelated row sent a human looking.
 *
 * AND THE READY QUEUE WAS NOT EMPTY -- FOUR ROWS. That is precisely why the one cause that would
 * eventually have looked stayed silent, and it is why this cause is NOT gated on an empty shelf the way
 * `epic-unfiled` and `blocked-unexaminable` are. The failure being named is a queue with DEPTH and no
 * THROUGHPUT: work the org already owns, already scoped, and merely unpromoted. A shelf-empty gate would
 * have withheld every one of those six for sixteen hours and then reported them as a supply problem.
 *
 * TO `product-manager`, because promotion is that session's call: `agent-practices.md` makes it first
 * reader for "filing and amendments ... holds, lane labels, promotions". This cause does not promote
 * anything itself -- it asks the one session that may.
 *
 * ONE ORDER PER ROW, KEYED ON THE SET THAT CLEARED -- `blockerClearedOrders`' key discipline from #1799,
 * unchanged. An unchanged clearing asks once; a row blocked again and cleared again is a new question.
 *
 * `READY_LABEL` IS EXCLUDED AND IT IS NOT A TIDINESS FILTER. A `ready` row is already offered by
 * `ready-row-unclaimed`, so asking `product-manager` to promote it would be asking for a promotion that
 * has already happened -- an order whose own subject line is false, which is worse than a duplicate.
 *
 * A ROW HIDDEN BY A `NOT_PICKABLE` LABEL IS NAMED, NOT DROPPED, and #1561 is why. Its `blockedBy` edge
 * cleared itself at 2026-09-23T08:28:00Z exactly as designed and it still sat 4h30m, because a hand-set
 * `blocked` LABEL outlived the referent it named: `blocked` is in `NOT_PICKABLE`, so a self-clearing edge
 * was overridden by a non-self-clearing label. Excluding that row would reproduce the very invisibility
 * that stranded it, and `blocked-unexaminable` -- the only other cause that could have reached it -- is
 * itself shelf-gated and was silent for the same four hours. So the order reports the row AND names what
 * still hides it, which is the one thing #2139 forbids doing silently: never reported as free.
 *
 * AN UNANSWERED ORDER BACKS OFF (#2286): see `PROMOTION_ASK_OFFSETS_MS`. `closings` says when each blocker
 * closed; without it (`null`, or an old caller) every order is the unstaged first ask, which is the
 * behaviour before the backoff existed and is what a refused read must fall back to.
 *
 * `head` IS THE `origin/main` COMMIT THE GATE READ THIS TICK, STAMPED INTO EACH PROMPT AS A `Head: <sha>` LINE (#1129). The
 * `unclaimed-blocker-cleared` decision class guards `promote` on that line, so an order that states none holds the class for
 * ever. Absent, or not a hex sha, the line is OMITTED -- never written as "unknown" -- which is what leaves `promote`
 * unavailable, as before. It is NOT in `causeKey`: a moving `main` must not turn one clearing into a new question.
 *
 * @param rows every open row
 */
export function unclaimedBlockerClearedOrders(rows: any[], today: string = todayIso(), { closings = null, now = Date.now(), head = null }: { closings?: Map<number, number> | null; now?: number; head?: string | null; } = {}): {
    session: string; cause: string; subject: string; discriminator: string;
    prompt: string; causeKey: string;
}[] {
  const orders = [];
  for (const { row, cleared } of unclaimedClearings(rows, today, now)) {
    const window = clearingAskWindow(cleared, now, closings);
    if (window) orders.push(promotionOrder(row, cleared, window.suffix, head));
    if (orders.length >= MAX_ROW_ORDERS_PER_TICK) break;
  }
  return orders;
}

/**
 * The unclaimed rows whose last declared blocker has closed, with the set that cleared -- the population
 * `unclaimedBlockerClearedOrders` asks about, and the one `main` reads BEFORE deciding whether to pay for
 * `readRecentlyClosed` at all. Split out so those two callers cannot drift into two spellings of "cleared".
 *
 * `nowMs` IS THE CLOCK THE HOUR-FORM `Not-before:` IS READ AGAINST (#2812). `today` only decides the date form, so a
 * caller that injected `now` and not this left the hour to the real clock: a fixture naming 2026-09-30T00:00:00Z as
 * the future went red on main when the wall clock passed it.
 */
export function unclaimedClearings(rows: any[], today: string = todayIso(), nowMs: number = Date.now()): { row: any; cleared: number[]; }[] {
  const found = [];
  for (const row of rows ?? []) {
    const labels = labelsOf(row);
    const cleared = declaredBlockers(row);
    if (labels.includes(CLAIM_LABEL) || labels.includes(READY_LABEL) || cleared === null) continue;
    // `needs:chairman` IS A WAIT AND `waitingOn` DOES NOT READ IT (#2583). The label names a person and
    // clears when removed, exactly as `blockedWithoutReferent` already rules, so an order to PROMOTE such a
    // row offers work whose first step is impossible (#2561: its private repository did not exist), and
    // repeats at every `PROMOTION_ASK_OFFSETS_MS` step. Skipped HERE, in this cause's own population,
    // rather than taught to `waitingOn`, which every reader of that function would then inherit.
    if (labels.includes(CHAIRMAN_LABEL)) continue;
    // `parked` IS THE SAME WAIT WITH A DIFFERENT LIFTER (#2653): `ceo` schedules the row when its prerequisite phase
    // is done, so a cleared blocker is not the event that promotes it. #2568 was ordered 30 minutes after being parked.
    if (labels.includes(PARKED_LABEL)) continue;
    // THE LINE THAT MAKES `cleared` MEAN CLEARED, and `blockerClearedOrders`' own sentence applies here
    // unchanged: `waitingOn` reports an OPEN `blockedBy` node before anything else, so passing here is
    // what proves every number above is closed -- and it covers the `Not-before:` and `answer:` cases in
    // the same breath, which is why `declaredBlockers` does not re-ask.
    if (waitingOn(row, today, nowMs)) continue;
    found.push({ row, cleared });
  }
  return found;
}

/**
 * The order `unclaimedBlockerClearedOrders` emits for one row.
 *
 * SPLIT OUT so the loop above reads as the four conditions it actually applies. The prompt carries the
 * ANSWER -- which row, what cleared, and what still hides it -- because a woken turn that has to survey
 * the tracker is a tick with extra steps.
 *
 * INCIDENT BEHIND THE ORDER'S TEXT (moved out of it, #3444: the agent reading the order cannot use it):
 * a shelf with four rows on it is why six rows sat runnable for up to 16h09m on 2026-09-23 with three engineers idle.
 * #1561's `blockedBy` cleared at 2026-09-23T08:28:00Z exactly as designed and the row sat another 4h30m behind a hand-set `blocked` label.
 *
 *
 * @param [suffix] which re-ask this is -- `""` for the first, `@6h` for the one due six hours on
 * @param [head] the `origin/main` commit the gate read; a `Head: <sha>` line when it is a hex sha, no line otherwise (#1129)
 */
function promotionOrder(row: any, cleared: number[], suffix: string = "", head: string | null = null) {
  // RE-DERIVED RATHER THAN PASSED IN: the caller's list is its own, and a helper that reads the row it
  // is describing cannot be handed labels belonging to a different one.
  const hiding = labelsOf(row).filter((n) => NOT_PICKABLE.includes(n));
  const key = cleared.join(".");
  return {
    session: "product-manager",
    cause: "unclaimed-blocker-cleared",
    subject: `row-${subjectRef(row.repoKey, row.number)}`,
    discriminator: key,
    prompt: `${subjectMention(row)}${row.title ? ` (${row.title})` : ""} IS UNCLAIMED AND NO LONGER BLOCKED. `
      + `Every row it declared a dependency on is now closed: ${cleared.map((n) => `#${n}`).join(", ")}.\n`
      + "NOTHING ELSE IN THIS ORG WILL SAY SO. `blocker-cleared` addresses the session HOLDING a row and "
      + "nobody holds this one; `lane-backlog-unpromoted` addresses a lane OWNER; `ready-queue-empty` "
      + "fires only when the Ready shelf is EMPTY. Depth is not throughput.\n"
      + `PROMOTE IT, OR RECORD WHY NOT AS DATA. A \`${READY_LABEL}\` label is the promotion; anything else goes in a `
      + `FIELD and not a comment -- \`gh issue edit ${row.number} --add-blocked-by <n>\`, a `
      + `\`Not-before: YYYY-MM-DDTHH:MM:SSZ\` line in the body, or \`${ANSWER_PREFIX}<session>\` if it `
      + "waits on a ruling. Each clears itself, each stops this being asked again, and nothing in this "
      + "org reads comments.\n"
      + (hiding.length > 0
        ? `IT STILL CARRIES ${hiding.map((n) => `\`${n}\``).join(", ")}, AND THAT IS WHAT NOW HIDES IT `
          + "-- the edge cleared itself and the label did not. "
          + `Take the label off if its condition has become true; if the wait is real, it is `
          + "one of the three fields above, which is the whole difference between a condition that "
          + "clears itself and one only a person re-reading the row can lift.\n"
        : "")
      + "THIS IS NOT A SURVEY OF THE BACKLOG. One row, one clearing, already named -- if the answer is "
      + "\"it stays in backlog\", say so in a field and this stops asking."
      // ON ITS OWN LINE: the class reads it with a line-anchored pattern (`HEAD_PATTERN`).
      + (head !== null && HEAD_SHA.test(head) ? `\nHead: ${head}` : ""),
    causeKey: `product-manager/unclaimed-blocker-cleared/row-${subjectRef(row.repoKey, row.number)}/${key}${suffix}`,
  };
}
