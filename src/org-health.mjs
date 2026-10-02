// @ts-check
// THE ORG FIXES WHAT IT IS TOLD ABOUT AND DOES NOT LOOK (#2936, the chairman's "why isn't the agent org self healing ... surely
// the ceo should be optimising?", 2026-10-01). #2841, #2842, #2845, #2847, #2853 and #2882/#2912 each closed the exact instance
// the chairman's own session found; nothing asked "is anything landing".
//
// `org-stalled` fires only when NO other cause produced an order (`stalledOrder`: `if (orders.length > 0) return null`), so an org
// busy offering orders and landing nothing is invisible to it; `failingChecksOrder` wakes a PR's owner on the FIRST red and never
// asks whether that wake produced a fix. THIS IS THE QUESTION: four signals, read once per tick from state the gate already
// holds, each OFFERED to `ceo` as ONE judgment cause (`org-health`) with its numbers in the prompt, which is
// `org-routing-and-timers.md`'s rule for a health question: it goes in the gate, where it costs an API call and wakes the session
// WITH the answer, never a cron and never a standing model turn.
//
// THE FOUR SIGNALS AND THEIR THRESHOLDS, EACH FROM THE 14-DAY TABLE POSTED ON #2936 (2026-09-17..10-01), NOT GUESSED. A reading at
// a moment: re-derive before quoting. #2937 ADDS TWO MORE (the idle fleet, the drifting copies), described below the four.
//   no-merge-while-work-exists  N = 3 h     p97.7 of 647 merge gaps; 1.07 gaps/day over N, 0.57/day with a PR already open
//   red-pr-unattended           M = 120 min p95.7 of 462 red->next-run ages; at most 2.50 episodes/day (an upper bound)
//   ready-row-refused           75 ticks    NOT A PERCENTILE: the #2845 counter is 13 hours old, so it is structural -- 15 ticks for
//                                           `product-manager` plus one 2-hour judgment window; the row says to re-measure
//   primary-not-at-main         60 min      9 episodes in 14 days: seven of one tick and two of 20 h and 24 h (0.14/day)
//
// THE TWO ADDED BY #2937 (the chairman's own list):
//   fleet-idle-while-work-waits  24 h        zero captures for a day while a `fleet-gated` row or a lab job waits for the fleet. THE
//                                            24 h IS THE CHAIRMAN'S, not a percentile: the 2026-09 incidents of a worker unable to
//                                            capture ran 4.9 days and were found by a human reading a terminal.
//   copies-drifted               any         a declared copy (every file in `packages/agent-org/src/lib`, each headed `COPIED FROM <original>`) whose
//                                            body no longer matches its original beyond the lines its own header names
// THE SEVENTH, #2970 (the chairman, 2026-10-02: "an open PR is not progressing towards merge for N minutes, whatever the reason"):
//   pr-not-progressing           180 min     an open PR the classifier (`stallReasonOf`, #2968) puts in NEITHER `progressing` NOR
//                                            `held-on-purpose`, with no push, review or comment for that long. N IS THE p94.9 OF PR
//                                            OPEN-TO-MERGE: 651 PRs merged 2026-09-18..10-01 (`gh pr list --state merged`, createdAt to
//                                            mergedAt) had p50/p75/p90/p95 = 29 / 59 / 121 / 181 minutes and 618 of them merged within
//                                            180, so a PR quiet for longer than 95% of PRs take to merge ENTIRELY is not on its way.
//                                            A reading at a moment: the command is under `## Measured` on #3001.
// THE SUBJECT IS TIME WITHOUT A STATE CHANGE, NOT A CHECK STATE: #2950 sat a conflicted DRAFT with no checks for 7.5 h and the red
// signal could not see it, a green PR nobody reviews has no red either, and the detector for it was the PR that was stuck.
// WHAT `host-units-stale` AND `primary-not-at-main` ALREADY COVER, so this does not repeat them: the first asks about the systemd UNIT
// files against the installed ones, the second about the primary checkout the work-tick unit runs from (its code IS that working
// tree) against `origin/main`. NEITHER READS A DECLARED COPY. The extracted `a11ign/agent-org` repo is a third thing and is NOT read
// here: it is a shadow-window snapshot that lags by design (`shadow-window.service.in`), so reading it would be a standing false alarm.
//
// NO STATE OF ITS OWN. Every "first tripped" time is DERIVED from a fact the tick reads (the last merge plus N hours, the failing
// check's own time plus M minutes, the oldest commit the primary lacks plus 60 minutes), so the discriminator is stable across
// ticks without a file and a signal that clears simply stops being offered. The one exception is the refused-row signal, whose
// counter carries ticks and no time: it is keyed on the ROWS, for the reason given there.
//
// A READ THAT WAS REFUSED IS A STATED UNKNOWN, NEVER A CLEAR (#1286). Each reading is `tripped`, `clear` or `unknown`, and an
// unknown says why on stderr -- a line that repeats for a persistent refusal and is therefore offered by `repeating-lines.mjs`.
//
// A LEAF, RELATIVE IMPORTS ONLY, like `repeating-lines.mjs`: `work-gate.mjs` imports this, and it runs before any `npm ci`/build.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.mjs";
// A LEAF (`claim-labels.mjs` imports nothing), so the label is read from where it is declared, as `repeating-lines.mjs` does.
import { READY_LABEL } from "./claim-labels.mjs";
// The checkout the tool serves and the project's own words are read from where they are declared (`standalone-roots.test.ts`, `project-vocabulary.test.ts`).
import { HOME_CHECKOUT } from "./project-config.mjs";
import { ANSWER_PREFIX } from "./project-vocabulary.mjs";
// A LEAF too (it imports `newest-check-run.mjs` and `pr-hold-state.mjs`, which import nothing): the ONE decider of what counts as red.
import { brokenChecks } from "./red-pr.mjs";
// A LEAF too: the closed grammar of what a declared wait is waiting FOR (#2996), and the two ages that bound how long one may stand unexplained.
import { MANUAL_WAIT_HOURS, STALE_WAIT_GRACE_MINUTES, pastGrace } from "./wait-condition.mjs";

/** No PR merged for this long, with work that could merge, is the idle org the chairman found. See the table above. */
export const NO_MERGE_HOURS = 3;
/** A PR whose required check has been red this long with nobody on it. */
export const RED_PR_MINUTES = 120;
/** A Ready row the claim has refused this many consecutive ticks -- `UNCLAIMABLE_AFTER_TICKS` (15) plus one judgment window. */
export const REFUSED_TICKS = 75;
/** A primary checkout that has stood off `origin/main` this long. */
export const PRIMARY_STALE_MINUTES = 60;

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const MS_PER_HOUR = MINUTES_PER_HOUR * MS_PER_MINUTE;
/** A span is quoted in minutes up to this many and in hours past it, `repeating-lines.mjs`'s `spanOf` rule. */
const HOURS_FROM_MINUTES = 120;
/** How much of a quoted refusal or a stderr reason a prompt keeps. */
const MAX_QUOTED_CHARS = 200;
const MAX_REASON_CHARS = 160;
/** The measured tick (`repeating-lines.mjs`'s `MINUTES_PER_TICK`): a streak of ticks is quoted in minutes only as "about". */
const MINUTES_PER_TICK = 2.1;
/** How many PRs or rows one prompt names before it says "and N more". */
const MAX_NAMED = 5;
/** No capture on the fleet for this long, with work that needs it waiting, is the idle fleet the chairman found (#2937). */
export const FLEET_IDLE_HOURS = 24;
/** Where the declared copies sit, relative to the TOOL's root: its own `lib/`, each file headed by what it was copied from (#3041: this was the monorepo's `packages/agent-org/src/lib`, which in the standalone tool is `src/lib`). */
const COPIES_DIR = "src/lib";
/** The tool's root, by its own location: `src/` is this file's directory, so the root is one up. Neither the project's layout nor a count of directories above it. */
const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The checkout the tool serves, when the caller names none. Where it holds no `COPIES_DIR` no copy is found, and the reading says so. */
const DEFAULT_ROOT = HOME_CHECKOUT;
const COPY_HEADER_START = /^\/\/ COPIED FROM `([^`]+)` at /;
const COPY_HEADER_END = "// ==== end of copy header ====";
/** What a header says it changed: `NOTHING`, `ONE LINE`, or `N NAMED LINES`. */
const COPY_HEADER_CHANGES = /CHANGED FROM THE ORIGINAL(?:,\s*(?:(\d+) NAMED LINES?|ONE LINE)|:\s*NOTHING)/;
/** An open PR quiet this long, and neither progressing nor held on purpose, is not on its way to merge. See the table above. */
export const PR_NOT_PROGRESSING_MINUTES = 180;
/**
 * The two `stallReasonOf` answers that are NOT a stall (`STALL_REASON.PROGRESSING`, `STALL_REASON.HELD_ON_PURPOSE`), written as the
 * strings because this is a leaf and `pr-orders.mjs` is not one. `org-health.test.ts` pins them to the classifier's own values and
 * to its whole reason set, so a reason added there is either covered or named here, never silently dropped.
 */
export const REASONS_THAT_ARE_NOT_A_STALL = Object.freeze(["progressing", "held-on-purpose"]);
/** The session every signal is offered to. */
const OFFERED_TO = "ceo";
/** How many merged PRs the last-merge read looks at: the newest-updated, which holds every merge of the last day or two. */
const MERGED_WINDOW = 20;

export const SIGNALS = Object.freeze({
  NO_MERGE: "no-merge-while-work-exists",
  RED_PR: "red-pr-unattended",
  REFUSED_ROW: "ready-row-refused",
  PRIMARY: "primary-not-at-main",
  FLEET_IDLE: "fleet-idle-while-work-waits",
  COPIES: "copies-drifted",
  PR_NOT_PROGRESSING: "pr-not-progressing",
  STALE_WAIT: "stale-wait",
  WAIT_WITHOUT_REASON: "wait-without-reason",
});

/**
 * @typedef {{ signal: string, status: "tripped" | "clear" | "unknown", detail: string, firstTrippedAt?: number | null,
 *             discriminator?: string, prompt?: string }} Reading
 * `detail` is one line: for `unknown` it is WHY, for `tripped` the numbers. `firstTrippedAt` is epoch ms, or `null` when the
 * signal's own source carries no time.
 */

/** @param {number} ms @returns {string} the UTC hour a time falls in, `2026-10-01T07`: the discriminator's resolution */
const hourOf = (ms) => new Date(ms).toISOString().slice(0, 13);
/** @param {number} ms */
const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
/** @param {number} ms @param {number} now */
const ageText = (ms, now) => {
  const minutes = Math.max(0, Math.round((now - ms) / MS_PER_MINUTE));
  return minutes >= HOURS_FROM_MINUTES ? `${Math.round(minutes / MINUTES_PER_HOUR)} h` : `${minutes} min`;
};

/** @param {number} minutes @returns {number} hours to one decimal place */
const hoursOf = (minutes) => Math.round((minutes / MINUTES_PER_HOUR) * 10) / 10;

/** @param {string} signal @param {string} why @returns {Reading} */
const unknown = (signal, why) => ({ signal, status: "unknown", detail: why });
/** @param {string} signal @returns {Reading} */
const clear = (signal) => ({ signal, status: "clear", detail: "" });

/**
 * SIGNAL 1: NOTHING HAS LANDED FOR `NO_MERGE_HOURS` WHILE SOMETHING COULD.
 *
 * "Something could" is a green, unheld PR (the gate's own `shouldBeMerging`) or a Ready row an engineer is being offered. An idle
 * org with an empty queue is finished, not stalled, so the gap alone is never a trip. THE GAP IS TESTED FIRST: a merge inside N
 * hours is clear whatever the work reading says, so a refused work read cannot turn a healthy tick into an unknown.
 *
 * @param {{ now: number, lastMergedAt: number | null, work: { greenPrs: number, claimableRows: number } | null }} input
 * @returns {Reading}
 */
export function noMergeReading({ now, lastMergedAt, work }) {
  if (lastMergedAt === null) return unknown(SIGNALS.NO_MERGE, "the last merge could not be read, so the gap is not known");
  const tripAt = lastMergedAt + NO_MERGE_HOURS * MS_PER_HOUR;
  if (now < tripAt) return clear(SIGNALS.NO_MERGE);
  if (work === null) return unknown(SIGNALS.NO_MERGE, "no PR has merged for over the threshold, but what could merge was not read");
  if (work.greenPrs + work.claimableRows === 0) return clear(SIGNALS.NO_MERGE);
  return {
    signal: SIGNALS.NO_MERGE, status: "tripped", firstTrippedAt: tripAt, discriminator: `${SIGNALS.NO_MERGE}@${hourOf(tripAt)}`,
    detail: `${ageText(lastMergedAt, now)} since the last merge (${isoOf(lastMergedAt)}); ${work.greenPrs} green unheld PR(s) and `
      + `${work.claimableRows} claimable Ready row(s) exist`,
  };
}

/**
 * @typedef {{ number: number | string, owner: string | null, redSince: number | null, ownerCommentAts: number[] }} RedPr
 * One open PR whose required check has settled red. `owner` is `null` when NOBODY could be named (`ownerOfPr`'s last rung).
 * `redSince` is when the head's first failing check finished, `null` when no check carried a time. `ownerCommentAts` are the
 * times of comments from the account that opened the PR, all of them: the leaf asks which fall after the red began.
 */

/**
 * WHEN DID THIS PULL REQUEST'S BREAKAGE BEGIN, or `null` when it has none to date (#2956). RED IS DECIDED ONCE, BY `red-pr.mjs`
 * (`isBrokenRed`, #2954), and the question is asked of it here and not re-answered: `pr-checks-failing` excuses a hold only when the
 * hold is its ADDRESSEE's own (#2400), so a PR a worker owns and `ceo` holds is still ordered, and a count built from those orders
 * alone offered `ceo` its own freeze every day of it (#2883). THE HOLD'S OWN TWO JOBS ARE LEFT OUT and every other red is dated by
 * ITSELF: a held PR with a real `ts / run` failure is red since THAT check finished, not since the hold's `gate` did.
 * `options.holdStands` is `red-pr.mjs`'s: whether the hold still EXCUSES (#2996), so a hold whose reason is gone dates the red it caused.
 * @param {{ labels?: any[], statusCheckRollup?: any[] }} pr
 * @param {{ holdStands?: (pr: any) => boolean }} [options]
 * @returns {number | null} epoch ms of the earliest broken check, `null` for none or for a broken check GitHub gave no time
 */
export function redSinceOf(pr, options) {
  const times = brokenChecks(pr, options).map((check) => check.failedAt).filter(Number.isFinite);
  return times.length > 0 ? Math.min(...times) : null;
}

/**
 * Is this red PR UNATTENDED once `RED_PR_MINUTES` have passed?
 *
 * NO PUSH IS ASSUMED BY CONSTRUCTION, and the reason is a fact about this repo: the head is the one that went red, and a push
 * makes a new head with a new run, so a PR still red on its head has had none (`update-branch-sweep.mjs` leaves a failing PR
 * alone, so a sweep cannot refresh it). THE OWNER'S COMMENT IS WHAT IS LEFT TO ASK. A PR WITH NO OWNER IS ALWAYS UNATTENDED: no
 * account is "its owner's", so a comment on it is not an owner's act and cannot excuse it (the 2026-10-01 case, #2941).
 * @param {RedPr} pr @param {number} now
 */
function isUnattended(pr, now) {
  if (pr.redSince === null || now - pr.redSince < RED_PR_MINUTES * MS_PER_MINUTE) return false;
  if (pr.owner === null) return true;
  const since = pr.redSince;
  return !pr.ownerCommentAts.some((at) => at >= since);
}

/**
 * SIGNAL 2: A RED PR NOBODY IS ON. `failingChecksOrder` woke the owner on the first red, and nothing asks whether that produced
 * a fix. `redPrs` is `null` for a refused PR read; one PR with no time makes the answer unknown unless another PR trips.
 * @param {{ now: number, redPrs: RedPr[] | null }} input
 * @returns {Reading}
 */
export function redPrReading({ now, redPrs }) {
  if (redPrs === null) return unknown(SIGNALS.RED_PR, "the open pull requests could not be read");
  const tripped = redPrs.filter((pr) => isUnattended(pr, now)).sort((a, b) => /** @type {number} */ (a.redSince) - /** @type {number} */ (b.redSince));
  if (tripped.length === 0) {
    const undated = redPrs.filter((pr) => pr.redSince === null);
    return undated.length === 0 ? clear(SIGNALS.RED_PR)
      : unknown(SIGNALS.RED_PR, `${undated.length} red PR(s) carried no check time, so how long they have been red is not known`);
  }
  const first = /** @type {number} */ (tripped[0].redSince) + RED_PR_MINUTES * MS_PER_MINUTE;
  const named = tripped.slice(0, MAX_NAMED).map((pr) => `#${pr.number} (red ${ageText(/** @type {number} */ (pr.redSince), now)}, `
    + `${pr.owner === null ? "NO OWNER" : `owner ${pr.owner}`})`);
  const more = tripped.length > MAX_NAMED ? `, and ${tripped.length - MAX_NAMED} more` : "";
  return { signal: SIGNALS.RED_PR, status: "tripped", firstTrippedAt: first, discriminator: `${SIGNALS.RED_PR}@${hourOf(first)}`,
    detail: `${tripped.length} PR(s) red over ${RED_PR_MINUTES} min with no comment from their owner since: ${named.join("; ")}${more}` };
}

/**
 * SIGNAL 3: A READY ROW THE CLAIM HAS REFUSED `REFUSED_TICKS` TICKS RUNNING. THE COUNTER IS #2845's, READ AND NOT RECOUNTED: it
 * is the streak `claimRefusalStreaksNow` already advanced this tick, and `product-manager` was told at 15 of them.
 *
 * KEYED ON THE ROW REFS, NOT AN HOUR, because the counter carries ticks and no time: an hour derived from `now` minus the ticks
 * drifts by a tick's jitter and would re-ask across an hour boundary. The set of refs changes only when a row enters or leaves.
 * @param {{ refusals: Record<string, { reason: string, ticks: number }> | null }} input
 * @returns {Reading}
 */
export function refusedRowReading({ refusals }) {
  if (refusals === null) return unknown(SIGNALS.REFUSED_ROW, "the claim-refusal counter was not read");
  const over = Object.entries(refusals).filter(([, seen]) => seen.ticks >= REFUSED_TICKS).sort(([a], [b]) => a.localeCompare(b));
  if (over.length === 0) return clear(SIGNALS.REFUSED_ROW);
  const named = over.slice(0, MAX_NAMED).map(([ref, seen]) => `${ref} (${seen.ticks} ticks, about ${hoursOf(seen.ticks * MINUTES_PER_TICK)} h): `
    + `${seen.reason.replace(/\s+/g, " ").slice(0, MAX_QUOTED_CHARS)}`);
  const more = over.length > MAX_NAMED ? `, and ${over.length - MAX_NAMED} more` : "";
  return { signal: SIGNALS.REFUSED_ROW, status: "tripped", firstTrippedAt: null,
    discriminator: `${SIGNALS.REFUSED_ROW}@${over.map(([ref]) => ref).join(",")}`,
    detail: `${over.length} Ready row(s) refused over ${REFUSED_TICKS} ticks: ${named.join("; ")}${more}` };
}

/**
 * SIGNAL 4: THE PRIMARY CHECKOUT HAS STOOD OFF `origin/main` FOR `PRIMARY_STALE_MINUTES`. `primary-stale` already tells `ceo` on
 * the tick it appears (#2781) and is CONSUMED here, not rebuilt: this adds the AGE, which is what says that the first telling did
 * not produce a fix. `drift` is `null` when the primary could not be asked (a linked worktree, CI, a git refusal), and `since` is
 * `null` when the drift carried nothing to date it by.
 * @param {{ now: number, drift: { behind: number, ahead: number, dirty: string[] } | null, since: number | null }} input
 * @returns {Reading}
 */
export function primaryReading({ now, drift, since }) {
  if (drift === null) return unknown(SIGNALS.PRIMARY, "the primary checkout could not be asked (a linked worktree, CI, or git refused)");
  if (drift.behind === 0 && drift.ahead === 0 && drift.dirty.length === 0) return clear(SIGNALS.PRIMARY);
  if (since === null) return unknown(SIGNALS.PRIMARY, "the primary is off origin/main but nothing dated how long");
  const tripAt = since + PRIMARY_STALE_MINUTES * MS_PER_MINUTE;
  if (now < tripAt) return clear(SIGNALS.PRIMARY);
  return { signal: SIGNALS.PRIMARY, status: "tripped", firstTrippedAt: tripAt, discriminator: `${SIGNALS.PRIMARY}@${hourOf(tripAt)}`,
    detail: `the primary has been off origin/main for ${ageText(since, now)} (since ${isoOf(since)}): ${drift.behind} commit(s) behind, `
      + `${drift.ahead} ahead, ${drift.dirty.length} dirty tracked path(s)` };
}

/**
 * @typedef {{ captures24h: number, lastCaptureAt: number | null }} FleetCaptures
 * What the fleet did in the last `FLEET_IDLE_HOURS`: how many captures, and when the last one finished (`null` when none is known).
 * @typedef {{ rows: (number | string)[], labJobs: string[] }} FleetWaiting
 * What is waiting for the fleet: open `fleet-gated` rows nothing else stops, and lab jobs queued for it.
 */

/**
 * SIGNAL 5: THE FLEET HAS CAPTURED NOTHING FOR `FLEET_IDLE_HOURS` WHILE SOMETHING IS WAITING FOR IT (#2937).
 *
 * AN IDLE FLEET NOBODY NEEDS IS HEALTHY, so the idleness alone is never a trip: it needs a `fleet-gated` row or a lab job to be
 * waiting. THE IDLENESS IS TESTED FIRST, as `noMergeReading` tests its gap: a capture inside the window is clear whatever the waiting
 * read says. `fleet === null` is a read that was refused or never made, and IT IS NEVER "IDLE": a fleet that could not be asked
 * says nothing about captures. A count of zero beside a last capture INSIDE the window contradicts itself, and is stated as unknown
 * rather than believed either way.
 *
 * @param {{ now: number, fleet: FleetCaptures | null, waiting: FleetWaiting | null }} input
 * @returns {Reading}
 */
export function fleetIdleReading({ now, fleet, waiting }) {
  if (fleet === null) return unknown(SIGNALS.FLEET_IDLE, "the fleet's captures could not be read, so it is not known to be idle");
  if (fleet.captures24h > 0) return clear(SIGNALS.FLEET_IDLE);
  const windowMs = FLEET_IDLE_HOURS * MS_PER_HOUR;
  if (fleet.lastCaptureAt !== null && now - fleet.lastCaptureAt < windowMs) {
    return unknown(SIGNALS.FLEET_IDLE, "the fleet reports zero captures in the window and a last capture inside it");
  }
  if (waiting === null) return unknown(SIGNALS.FLEET_IDLE, "the fleet has captured nothing for over the threshold, but what waits for it was not read");
  const waits = waiting.rows.length + waiting.labJobs.length;
  if (waits === 0) return clear(SIGNALS.FLEET_IDLE);
  const last = fleet.lastCaptureAt;
  const first = last === null ? null : last + windowMs;
  const named = [...waiting.rows.slice(0, MAX_NAMED).map((row) => `#${row}`), ...waiting.labJobs.slice(0, MAX_NAMED)].join(", ");
  const key = last === null ? [...waiting.rows, ...waiting.labJobs].sort().join(",") : hourOf(/** @type {number} */ (first));
  return { signal: SIGNALS.FLEET_IDLE, status: "tripped", firstTrippedAt: first, discriminator: `${SIGNALS.FLEET_IDLE}@${key}`,
    detail: `${fleet.captures24h} captures in the last ${FLEET_IDLE_HOURS} h; the last was `
      + `${last === null ? "never recorded" : `${isoOf(last)} (${ageText(last, now)} ago)`}; ${waits} thing(s) wait for the fleet: ${named}` };
}

/**
 * @typedef {{ number: number | string, reason: string, owner: string | null, lastActivityAt: number | null }} QuietPr
 * One open PR the classifier gave a reason. `reason` is `stallReasonOf`'s answer, `owner` is `null` when NOBODY could be named, and
 * `lastActivityAt` is the newest of its push, review and comment times (epoch ms), `null` when a read it needed was refused.
 */

/** @param {number} minutes @returns {string} how long a PR has been quiet: minutes under two hours, hours to one decimal after */
const quietFor = (minutes) => (minutes >= HOURS_FROM_MINUTES ? `${hoursOf(minutes)} h` : `${minutes} min`);

/**
 * SIGNAL 7: AN OPEN PULL REQUEST IS NOT PROGRESSING TOWARDS MERGE, WHATEVER THE REASON (#2970). The reason is the CLASSIFIER'S
 * (`stallReasonOf`), asked of every open PR by the caller, and ANY reason but the two that are not a stall counts: that is what
 * keeps this and the owner's order from disagreeing about which PRs are stuck, and it is what a new reason falls into by default.
 * THE AGE IS TIME SINCE THE NEWEST PUSH, REVIEW OR COMMENT, so a PR somebody is working on is never offered and a held one never is
 * however old (a freeze is a decision, #2956). `stalledPrs` is `null` for a refused PR read; a PR whose activity could not be dated
 * makes the answer unknown unless another PR trips, and is never read as old.
 *
 * KEYED ON THE SET OF `number:reason`, not an hour: a push or a comment takes a PR out of the set, a new stall adds to it, and
 * an unchanged set holds for the two hours the cause holds for.
 * @param {{ now: number, stalledPrs: QuietPr[] | null }} input
 * @returns {Reading}
 */
export function prNotProgressingReading({ now, stalledPrs }) {
  if (stalledPrs === null) return unknown(SIGNALS.PR_NOT_PROGRESSING, "the open pull requests could not be read");
  const stalled = stalledPrs.filter((pr) => !REASONS_THAT_ARE_NOT_A_STALL.includes(pr.reason));
  const quiet = stalled.filter((pr) => pr.lastActivityAt !== null && now - pr.lastActivityAt >= PR_NOT_PROGRESSING_MINUTES * MS_PER_MINUTE);
  if (quiet.length === 0) {
    const undated = stalled.filter((pr) => pr.lastActivityAt === null);
    return undated.length === 0 ? clear(SIGNALS.PR_NOT_PROGRESSING)
      : unknown(SIGNALS.PR_NOT_PROGRESSING, `${undated.length} stalled PR(s) carried no activity time, so how long they have been quiet is not known`);
  }
  const oldestFirst = [...quiet].sort((a, b) => /** @type {number} */ (a.lastActivityAt) - /** @type {number} */ (b.lastActivityAt));
  const first = /** @type {number} */ (oldestFirst[0].lastActivityAt) + PR_NOT_PROGRESSING_MINUTES * MS_PER_MINUTE;
  const named = oldestFirst.slice(0, MAX_NAMED).map((pr) => `#${pr.number} (${pr.reason}, quiet `
    + `${quietFor(Math.round((now - /** @type {number} */ (pr.lastActivityAt)) / MS_PER_MINUTE))}, ${pr.owner === null ? "NO OWNER" : `owner ${pr.owner}`})`);
  const more = oldestFirst.length > MAX_NAMED ? `, and ${oldestFirst.length - MAX_NAMED} more` : "";
  const key = quiet.map((pr) => `${pr.number}:${pr.reason}`).sort().join(",");
  return { signal: SIGNALS.PR_NOT_PROGRESSING, status: "tripped", firstTrippedAt: first, discriminator: `${SIGNALS.PR_NOT_PROGRESSING}@${key}`,
    detail: `${oldestFirst.length} open PR(s) neither merged nor held, with no push, review or comment for over ${PR_NOT_PROGRESSING_MINUTES} min: ${named.join("; ")}${more}` };
}

/**
 * SIGNAL 8: A WAIT STANDS ALTHOUGH THE CONDITION IT NAMES IS TRUE (#2996). The setter was ordered by the gate on the first tick the condition
 * held (`staleWaitOrders`); this is the question of whether that produced a removal, asked `STALE_WAIT_GRACE_MINUTES` later. `stale` is
 * `null` for a refused read of the rows and PRs. A wait whose condition could not be dated makes the answer unknown unless another trips.
 * @param {{ now: number, stale: { item: { kind: string, number: number, repoKey?: string }, wait: { text: string, key: string }, setter: string,
 *           resolvedAt: number | null }[] | null }} input
 * @returns {Reading}
 */
export function staleWaitReading({ now, stale }) {
  if (stale === null) return unknown(SIGNALS.STALE_WAIT, "the rows and pull requests carrying waits could not be read");
  const over = stale.filter((s) => s.resolvedAt !== null && pastGrace(s.resolvedAt, now))
    .sort((a, b) => /** @type {number} */ (a.resolvedAt) - /** @type {number} */ (b.resolvedAt));
  if (over.length === 0) {
    const undated = stale.filter((s) => s.resolvedAt === null);
    return undated.length === 0 ? clear(SIGNALS.STALE_WAIT)
      : unknown(SIGNALS.STALE_WAIT, `${undated.length} wait(s) have a true condition that nothing dated, so how long they have stood is not known`);
  }
  const first = /** @type {number} */ (over[0].resolvedAt) + STALE_WAIT_GRACE_MINUTES * MS_PER_MINUTE;
  const named = over.slice(0, MAX_NAMED).map((s) => `${s.item.repoKey ?? ""}#${s.item.number} (\`Waiting-for: ${s.wait.text}\` true for `
    + `${ageText(/** @type {number} */ (s.resolvedAt), now)}, setter ${s.setter})`);
  const more = over.length > MAX_NAMED ? `, and ${over.length - MAX_NAMED} more` : "";
  const key = over.map((s) => `${s.item.repoKey ?? ""}#${s.item.number}:${s.wait.key}`).sort().join(",");
  return { signal: SIGNALS.STALE_WAIT, status: "tripped", firstTrippedAt: first, discriminator: `${SIGNALS.STALE_WAIT}@${key}`,
    detail: `${over.length} wait(s) still stand over ${STALE_WAIT_GRACE_MINUTES} min after the condition they name became true: ${named.join("; ")}${more}` };
}

/**
 * SIGNAL 9: A WAIT THAT NAMES NO REASON, QUIET FOR `MANUAL_WAIT_HOURS` (#2996). `hold:*`, `answer:*` and the blocked label do not clear themselves, so with
 * no readable `Waiting-for:` nothing can ever say they are over. THE AGE IS TIME SINCE THE ITEM'S LAST ACTIVITY, as `pr-not-progressing`'s is: an item somebody
 * is working on is not stalled, and the wait's own start is not on the list read. A wait on `manual` is not here -- it is COUNTED in the detail.
 * @param {{ now: number, bare: { item: { kind: string, number: number, repoKey?: string }, fields: string[], quietSince: number | null }[] | null, manual?: number }} input
 * @returns {Reading}
 */
export function waitWithoutReasonReading({ now, bare, manual = 0 }) {
  if (bare === null) return unknown(SIGNALS.WAIT_WITHOUT_REASON, "the rows and pull requests carrying waits could not be read");
  const quiet = bare.filter((b) => b.quietSince !== null && now - b.quietSince >= MANUAL_WAIT_HOURS * MS_PER_HOUR)
    .sort((a, b) => /** @type {number} */ (a.quietSince) - /** @type {number} */ (b.quietSince));
  if (quiet.length === 0) {
    const undated = bare.filter((b) => b.quietSince === null);
    return undated.length === 0 ? clear(SIGNALS.WAIT_WITHOUT_REASON)
      : unknown(SIGNALS.WAIT_WITHOUT_REASON, `${undated.length} wait(s) with no reason carried no activity time, so how long they have stood is not known`);
  }
  const first = /** @type {number} */ (quiet[0].quietSince) + MANUAL_WAIT_HOURS * MS_PER_HOUR;
  const named = quiet.slice(0, MAX_NAMED).map((b) => `${b.item.repoKey ?? ""}#${b.item.number} (${b.fields.join(", ")}, quiet `
    + `${ageText(/** @type {number} */ (b.quietSince), now)})`);
  const more = quiet.length > MAX_NAMED ? `, and ${quiet.length - MAX_NAMED} more` : "";
  const key = quiet.map((b) => `${b.item.repoKey ?? ""}#${b.item.number}`).sort().join(",");
  return { signal: SIGNALS.WAIT_WITHOUT_REASON, status: "tripped", firstTrippedAt: first, discriminator: `${SIGNALS.WAIT_WITHOUT_REASON}@${key}`,
    detail: `${quiet.length} wait(s) name no readable condition and have been quiet over ${MANUAL_WAIT_HOURS} h: ${named.join("; ")}${more}; `
      + `${manual} further wait(s) are \`manual\`, which is allowed and counted` };
}

/**
 * @typedef {{ original: string, copy: string, allowedLines: number | null, originalText: string | null, copyText: string }} CopyPair
 * One declared copy: where it came from and where it sits (both relative to the checkout), how many lines its own header says it
 * changed (`null` when the header says none), the original's text (`null` when it could not be read) and the copy's text.
 */

/** @param {string} text @returns {{ body: string, complete: boolean }} the text with the copy header block removed, wherever it sits */
function withoutCopyHeader(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => COPY_HEADER_START.test(line));
  const end = lines.indexOf(COPY_HEADER_END);
  if (start < 0 || end < start) return { body: text, complete: false };
  return { body: [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n"), complete: true };
}

/**
 * How many lines of `lines` have no counterpart left in `against`, counted as a MULTISET so a moved or duplicated line is not
 * mistaken for an edit and an edit is one line on each side.
 * @param {string[]} lines @param {string[]} against @returns {number}
 */
function linesWithoutCounterpart(lines, against) {
  const left = new Map();
  for (const line of against) left.set(line, (left.get(line) ?? 0) + 1);
  let without = 0;
  for (const line of lines) {
    const available = left.get(line) ?? 0;
    if (available > 0) left.set(line, available - 1);
    else without += 1;
  }
  return without;
}

/**
 * @param {CopyPair} pair
 * @returns {{ verdict: "same" | "drifted" | "unknown", why: string }}
 * A copy drifts when more of the ORIGINAL'S lines are changed or gone than its OWN HEADER names, or when a header that names NOTHING
 * sits above a copy with lines the original lacks. THE HEADER'S COUNT IS THE ALLOWANCE, which is what lets the pair list be discovered
 * rather than declared a second time -- and its price is stated here: a one-byte change ON a line the header already names is inside
 * the allowance, and so are the copy's own extra lines once the header names any change, because the header counts the original's
 * lines it changed and ONE of them can become several (`changed-packages.mjs`'s `REPO` became four lines under "3 NAMED LINES", #2884). `agent-org-outward-edges.test.ts` applies each sanctioned edit exactly and
 * is the exact check; this is the cheap one that runs on every tick.
 */
function judgePair(pair) {
  if (pair.originalText === null) return { verdict: "unknown", why: `${pair.original} could not be read` };
  const { body, complete } = withoutCopyHeader(pair.copyText);
  if (!complete) return { verdict: "drifted", why: "the copy has no complete header" };
  if (pair.allowedLines === null) return { verdict: "unknown", why: "its header does not say how many lines it changed" };
  const copyLines = body.split("\n");
  const originalLines = pair.originalText.split("\n");
  const extra = linesWithoutCounterpart(copyLines, originalLines);
  const missing = linesWithoutCounterpart(originalLines, copyLines);
  if (missing <= pair.allowedLines && (extra === 0 || pair.allowedLines > 0)) return { verdict: "same", why: "" };
  return { verdict: "drifted", why: `${extra} line(s) only in the copy, ${missing} only in the original, and its header names ${pair.allowedLines}` };
}

/**
 * SIGNAL 6: A DECLARED COPY NO LONGER MATCHES ITS ORIGINAL (#2937). `packages/guards/src/isolation-gate.mjs` and
 * `packages/agent-org/src/lib/isolation-gate.mjs` were edited identically BY HAND in #2921: a drift waiting to happen unless a question
 * reads it. `pairs` is `null` for a read that could not run; an EMPTY list is stated as unknown too, because a discovery that finds
 * no copy in a tree that holds nineteen has not found a clean tree.
 * @param {{ pairs: CopyPair[] | null }} input
 * @returns {Reading}
 */
export function copyDriftReading({ pairs }) {
  if (pairs === null) return unknown(SIGNALS.COPIES, "the declared copies could not be read");
  if (pairs.length === 0) return unknown(SIGNALS.COPIES, "no declared copy was found, so none was compared");
  const judged = pairs.map((pair) => ({ pair, ...judgePair(pair) }));
  const drifted = judged.filter((j) => j.verdict === "drifted");
  if (drifted.length === 0) {
    const unread = judged.filter((j) => j.verdict === "unknown");
    return unread.length === 0 ? clear(SIGNALS.COPIES)
      : unknown(SIGNALS.COPIES, `${unread.length} declared copy(ies) could not be compared: ${unread[0].pair.copy} (${unread[0].why})`);
  }
  const named = drifted.slice(0, MAX_NAMED).map(({ pair, why }) => `${pair.copy} against ${pair.original}: ${why}`);
  const more = drifted.length > MAX_NAMED ? `, and ${drifted.length - MAX_NAMED} more` : "";
  return { signal: SIGNALS.COPIES, status: "tripped", firstTrippedAt: null,
    discriminator: `${SIGNALS.COPIES}@${drifted.map(({ pair }) => pair.copy).sort().join(",")}`,
    detail: `${drifted.length} declared cop${drifted.length === 1 ? "y" : "ies"} drifted from the original: ${named.join("; ")}${more}` };
}

/** @param {(path: string) => string} read @param {string} path @returns {string | null} the text, or `null` for a file that cannot be read: absent is not empty */
function readOrNull(read, path) {
  try {
    return read(path);
  } catch {
    return null;
  }
}

/**
 * THE DECLARED COPIES OF A CHECKOUT, discovered from the headers: every file in `COPIES_DIR` whose header names its original. `null`
 * when the directory cannot be listed. Each pair's original is read here and is `null` in the pair when it cannot be.
 * `root` is the PROJECT, where each copy's original is read; `toolRoot` is where the copies themselves are.
 * @param {{ root?: string, toolRoot?: string, list?: (dir: string) => string[], read?: (path: string) => string }} [where]
 * @returns {CopyPair[] | null}
 */
export function readDeclaredCopies({ root = DEFAULT_ROOT, toolRoot = TOOL_ROOT, list = (dir) => readdirSync(dir), read = (path) => readFileSync(path, "utf8") } = {}) {
  let names;
  try {
    names = list(`${toolRoot}/${COPIES_DIR}`).sort();
  } catch {
    return null; // an unlistable directory is not an empty one
  }
  /** @type {CopyPair[]} */
  const pairs = [];
  for (const name of names) {
    const copy = `${COPIES_DIR}/${name}`;
    let copyText;
    try {
      copyText = read(`${toolRoot}/${copy}`);
    } catch {
      continue; // a directory or a file that vanished between the list and the read is not a copy
    }
    const original = copyText.split("\n").map((line) => COPY_HEADER_START.exec(line)?.[1]).find(Boolean);
    if (original === undefined) continue;
    const changed = COPY_HEADER_CHANGES.exec(copyText);
    pairs.push({ original, copy, originalText: readOrNull(read, `${root}/${original}`), copyText, allowedLines: changed === null ? null : Number(changed[1] ?? (/ONE LINE/.test(changed[0]) ? 1 : 0)) });
  }
  return pairs;
}

/**
 * WHEN THE PRIMARY STOPPED BEING CURRENT: the committer date of the oldest commit `origin/main` has that HEAD lacks, else the
 * oldest modified time among its dirty tracked files. INFERRED from git and the filesystem, not logged: nothing records the moment
 * `primary:update` first failed. `null` when neither can be read.
 * @param {{ behind: number, dirty: string[] } | null} drift
 * @param {{ root: string, run?: (args: string[]) => string, mtimeOf?: (path: string) => number }} where
 * @returns {number | null}
 */
export function primaryStandingSince(drift, { root, run = (args) => execFileSync("git", args, { cwd: root, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  mtimeOf = (path) => statSync(`${root}/${path}`).mtimeMs }) {
  if (drift === null) return null;
  const times = [];
  try {
    if (drift.behind > 0) times.push(Date.parse(run(["log", "--reverse", "--max-count=1", "--format=%cI", "HEAD..refs/remotes/origin/main"]).trim()));
    for (const path of drift.dirty) times.push(mtimeOf(path));
  } catch {
    return null; // a read that failed is not an age
  }
  const known = times.filter(Number.isFinite);
  return known.length > 0 ? Math.min(...known) : null;
}

/**
 * THE LAST MERGE, as epoch ms, or `null`. ONE REST CALL on the core pool: the newest-UPDATED closed PRs, of which the latest
 * `merged_at` is the answer (merging updates the PR, so every recent merge is among them). `null` -- refused, unparseable, or no
 * merged PR in the window -- is a stated unknown, never "long ago": a refusal says nothing about when the last merge was.
 * @param {(args: string[]) => string} run @param {string} repo
 * @returns {number | null}
 */
export function readLastMergedAt(run, repo) {
  try {
    const out = run(["api", `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${MERGED_WINDOW}`,
      "--jq", "[.[] | select(.merged_at != null) | .merged_at] | max"]);
    // `gh --jq` prints a string RAW (no quotes) and the word `null` for an empty list, both of which `Date.parse` reads as NaN or a time.
    const at = Date.parse(out.trim());
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/**
 * THE READINGS, in a fixed order: the four of #2936, then the two of #2937 and the one of #2970 WHEN THEIR FACT IS GIVEN. An OMITTED fact (`undefined`) is
 * "this caller does not ask", which is silent; `null` is "asked and refused", which is a stated unknown. The two must not share a
 * value, or a gate that never wired the fleet read would log an unknown every tick for a fault nobody can fix from the log.
 * @param {{ now: number, lastMergedAt: number | null, work: { greenPrs: number, claimableRows: number } | null, redPrs: RedPr[] | null,
 *           refusals: Record<string, { reason: string, ticks: number }> | null,
 *           drift: { behind: number, ahead: number, dirty: string[] } | null, primarySince: number | null,
 *           fleet?: FleetCaptures | null, waiting?: FleetWaiting | null, copies?: CopyPair[] | null, stalledPrs?: QuietPr[] | null,
 *           waits?: { stale: Parameters<typeof staleWaitReading>[0]["stale"], bare: Parameters<typeof waitWithoutReasonReading>[0]["bare"], manual: number } | null }} facts
 * @returns {Reading[]}
 */
export function orgHealthReadings(facts) {
  const readings = [noMergeReading(facts), redPrReading(facts), refusedRowReading(facts),
    primaryReading({ now: facts.now, drift: facts.drift, since: facts.primarySince })];
  if (facts.fleet !== undefined) readings.push(fleetIdleReading({ now: facts.now, fleet: facts.fleet, waiting: facts.waiting ?? null }));
  if (facts.copies !== undefined) readings.push(copyDriftReading({ pairs: facts.copies }));
  if (facts.stalledPrs !== undefined) readings.push(prNotProgressingReading({ now: facts.now, stalledPrs: facts.stalledPrs }));
  if (facts.waits !== undefined) {
    readings.push(staleWaitReading({ now: facts.now, stale: facts.waits?.stale ?? null }),
      waitWithoutReasonReading({ now: facts.now, bare: facts.waits?.bare ?? null, manual: facts.waits?.manual }));
  }
  return readings;
}

/** What a prompt says about each signal, in the chairman's words where they have them. */
const REMEDY = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
  [SIGNALS.NO_MERGE]: "Nothing is landing while something could. Find which link is stuck (a green PR with no approval, an engineer pool that "
    + "cannot claim, a queue ruleset, a stopped tick), then FIX IT or FILE IT `" + READY_LABEL + "` WITH AN OWNER in this turn.",
  [SIGNALS.RED_PR]: "A red PR was ordered to its owner on its first red and nothing came of it. Read why (`gh pr checks <n>`), then fix it, "
    + "re-lane it by putting the label of a session that can on the PR (`pr-checks-failing` names the label shape), or close it if it is abandoned.",
  [SIGNALS.REFUSED_ROW]: "`product-manager` was told at 15 ticks and the claim is still refused. The refusal text is quoted: read whose tree "
    + "it is (`pnpm run worktree:whose -- <path>`), and free the row or take it off the shelf.",
  [SIGNALS.PRIMARY]: "`primary-stale` told you when this began and the primary is still behind. Every order the gate gives is given from the "
    + "primary's code, so the org has been running stale for this long: follow `primary-stale`'s own steps (save the diff first).",
  [SIGNALS.FLEET_IDLE]: "The fleet has captured nothing for a day and something needs it. Read why before anything else (`pnpm run fleet:status` is "
    + "`orchestrator`'s to run, not yours): a worker that cannot capture, a lab job that never started, or a row nobody dispatched. "
    + "`orchestrator` owns fleet and lab questions, so put the finding on the row and `" + ANSWER_PREFIX + "orchestrator` on it rather than running the fleet yourself.",
  [SIGNALS.COPIES]: "A declared copy no longer matches its original. Neither is known to be the right one: read both (`git log -3 -- <path>` for each), "
    + "then carry the change to the other side and move the commit in the copy's header. `agent-org-outward-edges.test.ts` is the exact check "
    + "and will go red on `main`'s next PR until you do.",
  [SIGNALS.PR_NOT_PROGRESSING]: "Each PR named has had no push, review or comment for hours and is not held. The reason says who owes the next move: "
    + "`conflicted` and `red` are its owner's to fix, `awaiting-review` needs a verdict (`reviewer-<n>`, or `product-manager` when the PR has none), "
    + "`awaiting-author-draft` is its author's to mark ready, `unarmed` is `product-manager`'s. The owner may already have been ordered and nothing came of it: "
    + "READ WHY (`gh pr view <n>`), then unstick it, re-lane it by putting the label of a session that can on the PR, or close it if it is abandoned.",
  [SIGNALS.STALE_WAIT]: "Each wait named still stands although the condition it declared is true: the reason is gone and the wait is a stall, not "
    + "health. The setter was ordered with the exact field to remove and did not. Remove it yourself (`pnpm run pr:hold -- <n> --session=<s> --release` "
    + "for a hold, `gh issue edit <n> --remove-label <label>` for a label, or the `Waiting-for:` line), or re-lane the item to a session that will.",
  [SIGNALS.WAIT_WITHOUT_REASON]: "Each item named holds a wait (`hold:*`, `" + ANSWER_PREFIX + "*` or the blocked label) that says nothing about what it waits for, and nothing "
    + "has moved on it for hours. A wait nobody can check is how the 2026-10-02 freeze stood four hours after it ended. Ask its setter what ends it and write "
    + "`Waiting-for: <closed|merged|labelled <label>|unlabelled <label>> <#n>` on it, or remove the wait.",
}));

/**
 * ONE ORDER PER TRIPPED SIGNAL, to `ceo`, the numbers in the prompt. THE PROMPT CARRIES THE OTHER TRIPPED SIGNALS, because a
 * session is delivered one order per tick (`repeating-lines.mjs`' reason). An unknown or clear reading emits nothing here.
 * @param {Reading[]} readings
 * @returns {{session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string}[]}
 */
export function orgHealthOrders(readings) {
  const tripped = readings.filter((r) => r.status === "tripped");
  return tripped.map((r) => {
    const others = tripped.filter((o) => o !== r).map((o) => o.signal);
    const when = r.firstTrippedAt ? ` It first tripped at ${isoOf(r.firstTrippedAt)}.` : "";
    return {
      session: OFFERED_TO,
      cause: "org-health",
      subject: r.signal,
      discriminator: /** @type {string} */ (r.discriminator),
      prompt: `ORG HEALTH: \`${r.signal}\` HAS TRIPPED. ${r.detail}.${when}\n${REMEDY[r.signal]}\n`
        + "This is asked because the org fixes what it is told about and does not look (the chairman, 2026-10-01): leave the place "
        + "better than you found it, and say on #928 what you found and did. It holds for two hours unchanged and stops when the "
        + `condition clears.${others.length > 0 ? `\nALSO TRIPPED (${others.length}): ${others.join(", ")}.` : ""}`,
      causeKey: `${OFFERED_TO}/org-health/${r.discriminator}`,
    };
  });
}

/**
 * A tree that holds copy headers but NONE of their originals is an extracted tool, not a product checkout, and there is nothing to
 * compare it against: no reading, which is not "clear" and not "unknown" (a stated unknown here would repeat every tick forever).
 * @param {CopyPair[] | null} pairs @returns {CopyPair[] | null | undefined}
 */
function copiesToCompare(pairs) {
  if (pairs !== null && pairs.length > 0 && pairs.every((pair) => pair.originalText === null)) return undefined;
  return pairs;
}

/**
 * THE WHOLE TICK: say each unknown on stderr, return the orders. NEVER THROWS -- a detector that can crash the gate stops every
 * order behind it (`repeatingLinesTick`'s rule). Only unknowns are written: a tripped signal's report is its order, and a
 * line written every tick for a standing condition would be offered by `repeating-lines.mjs` as a fault of its own.
 * THE COPIES ARE READ HERE, from disk, when the caller gives none: they are files of the checkout the tick runs from, so no
 * caller has them already, and a leaf that reads them keeps `work-gate.mjs` out of it. In an extracted tree no original is
 * found, so the reading is left out rather than stated unknown every tick (`copiesToCompare`).
 * @param {Parameters<typeof orgHealthReadings>[0]} facts
 * @param {{ log?: (line: string) => void, readCopies?: () => CopyPair[] | null }} [io]
 */
export function orgHealthTick(facts, { log = (line) => process.stderr.write(line), readCopies = () => readDeclaredCopies() } = {}) {
  try {
    const copies = facts.copies !== undefined ? facts.copies : copiesToCompare(readCopies());
    const readings = orgHealthReadings(copies === undefined ? facts : { ...facts, copies });
    for (const r of readings) if (r.status === "unknown") log(`org-health: ${r.signal} UNKNOWN -- ${r.detail}; it is not read as clear.\n`);
    return orgHealthOrders(readings);
  } catch (err) {
    log(`org-health: could not run (${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS)}) -- no order this tick.\n`);
    return [];
  }
}
