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
// THE SEVENTH, #2970, REPLACED BY THE OUTCOME CLOCK (#3486, the chairman, 2026-10-04: "how do we make sure nothing happens again?"):
//   overdue                      3 x median  an open PR, or a claimed row, that has not MERGED or CLOSED within three times the median it takes.
//                                            THE CLOCK STARTS WHEN THE ITEM OPENS (a PR's `createdAt`, a row's newest claim record) AND ONLY
//                                            A MERGE OR A CLOSE STOPS IT: a comment, a label, a hold, a draft and a push do not restart it, and
//                                            no state excuses it. The state the gate can read (`stallReasonOf`: red, held-on-purpose,
//                                            awaiting-review ...) rides on the alarm as a LABEL, and the gate understanding it is never a
//                                            condition for raising it. The bounds and their measurement are beside `OVERDUE_PR_MINUTES`.
// WHY THE 180-MINUTE "NOT PROGRESSING" SIGNAL WAS REPLACED, not tuned: it fired at about 13x the median open-to-merge, exempted held and
// drafted PRs by construction (so a hold whose reason had gone, agent-org #149, and an approved draft with no stamp, #3406, were
// invisible), and counted any comment as activity, so a PR the bots kept commenting on never aged (#2950 sat 7.5 h; #3460 was re-queued).
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
// A LEAF, RELATIVE IMPORTS ONLY, like `repeating-lines.mjs`: `work-gate.mjs` imports this, and it runs before any `pnpm install`/build.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.mjs";
// A LEAF (`claim-labels.mjs` imports nothing), so the label is read from where it is declared, as `repeating-lines.mjs` does.
import { READY_LABEL, STATE_LABELS, stateLabelFindings } from "./claim-labels.mjs";
import { boardTruthTable } from "./board-truth-audit.mjs";
// The checkout the tool serves and the project's own words are read from where they are declared (`standalone-roots.test.ts`, `project-vocabulary.test.ts`).
import { HOME_CHECKOUT } from "./project-config.mjs";
import { ANSWER_PREFIX, BACKLOG_LABEL } from "./project-vocabulary.mjs";
// A LEAF too (it imports `newest-check-run.mjs` and `pr-hold-state.mjs`, which import nothing): the ONE decider of what counts as red.
import { brokenChecks } from "./red-pr.mjs";
// A LEAF too: the closed grammar of what a declared wait is waiting FOR (#2996), and the two ages that bound how long one may stand unexplained.
import { MANUAL_WAIT_HOURS, STALE_WAIT_GRACE_MINUTES, pastGrace } from "./wait-condition.mjs";
// A LEAF too (#3943): the pure reading of "no engineer holds a row, and which open rows are not being built, and why".
import { IDLE_REASONS, idleLine } from "./idle-with-open-rows.mjs";

/** No PR merged for this long, with work that could merge, is the idle org the chairman found. See the table above. */
export const NO_MERGE_HOURS = 3;
/** A PR whose required check has been red this long with nobody on it. */
export const RED_PR_MINUTES = 120;
/** A Ready row the claim has refused this many consecutive ticks -- `UNCLAIMABLE_AFTER_TICKS` (15) plus one judgment window. */
export const REFUSED_TICKS = 75;
/** A primary checkout that has stood off `origin/main` this long. */
export const PRIMARY_STALE_MINUTES = 60;
/**
 * HOW LONG AN ORDER MAY WAIT ON A SESSION THAT IS BUSY BEFORE THE WAIT IS A STALL: FIFTEEN MINUTES (#3448, the chairman, 2026-10-04). ONE number for
 * both of its readers: `wake.mjs`'s deferred order (`BUSY_SEAT_DEFERRAL_MS` is this) and a standing seat's queue, whose oldest entry is the same wait
 * seen from the inbox.
 *
 * WHY NOT THE HOUR IT WAS: #3406 sat green and approved for forty minutes behind `orchestrator`, and the hour said nothing for all of them. MEASURED
 * 2026-10-04 from `journalctl --user -u a11ign-work-tick -o short-iso` over 2026-10-02T16:12+01:00 to 2026-10-04T14:12+01:00 (the window `DEFERRED` has
 * existed in, #3029): every run of consecutive ticks deferring one causeKey with `"<seat>" is working` (a gap over 10 minutes ends a run), kept only if a
 * `WOKE <seat> <- <causeKey>` followed within 6 minutes. Of 212 such runs for `ceo`, `product-manager` and `orchestrator`: p50 1.9 min, p90 15.2, p99 46.2,
 * MAX 50.8; 22 ran over 15 minutes. SO THIS IS NOT A PERCENTILE THAT CLEARS THE HEALTHY WAITS: about one in ten waits that ENDED in a turn is raised
 * (roughly eleven a day), which `ceo` is asked about once per two hours as a judgment cause. The chairman's ruling is that a wait past a quarter of an hour
 * is worth a look, and the cost is stated here so the next reader does not mistake the bound for a measurement of health. A tick is 2 minutes: each is good to +-2.
 */
export const ORDER_STALL_MINUTES = 15;
/**
 * A FLEET AUTO-OFF THAT HAS REFUSED THIS LONG IS AN OUTAGE NOBODY READ: FIFTEEN MINUTES (#3853, incident #3846, the chairman via `ceo`, 2026-10-06). The same
 * quarter hour as {@link ORDER_STALL_MINUTES} and for the same reason: it is the chairman's ruling about how long a thing may wait unseen, and NOT a percentile.
 * `fleet-auto-off` refused 2,569 ticks over about twelve hours that day and the org did not act, because nothing that raises read the record it keeps.
 */
export const AUTO_OFF_REFUSAL_MINUTES = 15;
/**
 * HOW OLD THE REFUSAL RECORD'S LAST TICK MAY BE, AT THE MOMENT THE MIRROR READ IT, BEFORE IT IS NOT BELIEVED: FIVE MINUTES. The timer ticks every 10 s and writes the
 * record each time, so a refusal last written longer than this before `readAt` is a timer that had STOPPED (two of this gate's own ticks, {@link MINUTES_PER_TICK}),
 * and a stopped timer cannot be said to still be refusing. It is judged against `readAt`, NOT the tick's clock: the mirror is up to an hour old by design. It is a
 * stated unknown, never a clear and never a trip.
 */
export const AUTO_OFF_RECORD_STALE_MINUTES = 5;
/**
 * HOW OLD THE MIRROR MAY BE BEFORE IT IS NOT BELIEVED: TWO HOURS (product-manager's ruling on #3853). `fleet-watch` rewrites it after each hourly read and writes
 * NOTHING when the control plane could not be reached, so a mirror older than two hourly runs is a watcher that did not look, which is not the same as a fleet
 * that is not refusing. It is a stated unknown.
 */
export const AUTO_OFF_MIRROR_STALE_MINUTES = 120;
/**
 * Where `fleet-watch.mjs` mirrors the control plane's auto-off record for this tick to read (#3860), relative to the checkout the tick serves. The record itself
 * (`runs/fleet-auto-off-state.json`) lives under the control plane's root-owned checkout, and the tick does NOT ssh to it (#3566's budget; #3843, #3737).
 */
export const AUTO_OFF_MIRROR_PATH = "runs/fleet-auto-off-mirror.json";
/**
 * A POOL BELOW A FIFTH OF ITS LIMIT IS RAISED (#3448): 1,000 of 5,000 GraphQL points. THE REASON IS THE BURN RATE, NOT A PERCENTILE: `a11ign-ai-leads`
 * spent a whole window in the hour 2026-10-04 11:57Z-12:57Z (the chairman's read, #3448), about 83 points a minute, so a fifth is about twelve minutes of
 * warning at that rate -- six tick grids and a `ceo` turn, which a tenth (about six minutes) is not. A reading at a moment: re-derive before quoting.
 */
export const POOL_LOW_FRACTION = 0.2;

/**
 * A PANE STOPPED AT AN INTERACTIVE PROMPT FOR THIS LONG IS A STALL, NOT AN IDLE SESSION (#3458): the same quarter hour as {@link ORDER_STALL_MINUTES},
 * which is the chairman's ruling about waiting on a seat (#3448) and NOT a percentile of how long a prompt takes to answer. Codex's "Working directory"
 * picker held two restored reviewers for two days (2026-10-02, agent-org #35 and #36) and no signal in the org could see it, because a pane that has not
 * started an agent reports no work and no failure.
 */
export const PANE_PROMPT_MINUTES = ORDER_STALL_MINUTES;

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
/** The child that reads every runner's version gets this long: a `git ls-remote`, about a hundred small file reads and one REST call. */
const AGREEMENT_READ_MS = 90_000;
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
/**
 * THE OUTCOME CLOCK'S BOUNDS: THREE TIMES THE MEDIAN, each from a distribution MEASURED 2026-10-04 (a reading at a moment: re-derive before quoting).
 *   PR   100 min  3 x 33.7. The median of 289 pull requests of the PROJECT'S OWN repository merged 2026-09-27..10-04 (`gh pr list --state merged --limit 1000
 *                 --json createdAt,mergedAt`, createdAt to mergedAt, the last 7 days): p50/p75/p90/p95 = 33.7 / 65.8 / 150.8 / 198.3 min, and
 *                 46 of the 289 (15.9 %) took longer than 100. THIS REPO'S median and not the agent-org repo's 14.8 (153 PRs, the row's "about 14 min",
 *                 which would give about 45): the gate reads THIS repo's open PRs, so this is the distribution its PRs are judged against.
 *   ROW  135 min  3 x 44.5. The median of 282 rows closed 2026-10-01..10-04, from the NEWEST claim record to `closedAt` (`gh issue list --state closed
 *                 --limit 300 --json closedAt,comments`): p50/p75/p90 = 44.5 / 79 / 125 min. That window is three days and not seven because the 300
 *                 newest closed rows reach back no further, so it is the thinner of the two readings.
 * A bound is ONE constant per kind and not per state: that is the point of the clock. An item that "should" take longer is still overdue, and
 * its reason label says why, which is the information the reader needs; an exemption would be a state the clock cannot see.
 */
export const OVERDUE_PR_MINUTES = 100;
export const OVERDUE_ROW_MINUTES = 135;
/** The session every signal is offered to. */
const OFFERED_TO = "ceo";
/** #3942: the first reader of rows (`.claude/rules/org-routing-and-timers.md`), who is told of a row-state signal BEFORE `ceo` is, and in the same tick. */
const FIRST_READER = "product-manager";
/** How many merged PRs the last-merge read looks at: the newest-updated, which holds every merge of the last day or two. */
const MERGED_WINDOW = 20;

export const SIGNALS = Object.freeze({
  NO_MERGE: "no-merge-while-work-exists",
  RED_PR: "red-pr-unattended",
  REFUSED_ROW: "ready-row-refused",
  PRIMARY: "primary-not-at-main",
  FLEET_IDLE: "fleet-idle-while-work-waits",
  COPIES: "copies-drifted",
  OVERDUE: "overdue",
  STALE_WAIT: "stale-wait",
  WAIT_WITHOUT_REASON: "wait-without-reason",
  ORDER_STALLED: "order-deferred-too-long",
  POOL_LOW: "api-pool-low",
  PANE_AT_PROMPT: "pane-stopped-at-a-prompt",
  TOOL_VERSION: "runner-behind-newest-release",
  TEAM_ACCESS: "team-access-drifted",
  AUTO_OFF_REFUSING: "fleet-auto-off-refusing",
  STATE_LABEL: "row-without-exactly-one-state",
  IDLE_WITH_OPEN_ROWS: "idle-with-open-rows",
  RELEASE_FAILED: "release-run-failed",
  BOARD_TRUTH: "board-disagrees-with-reality",
});

/** Signals whose first reader is not `ceo`: the order goes to that session as well as to `ceo`, who takes every signal. */
const FIRST_READERS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({ [SIGNALS.STATE_LABEL]: FIRST_READER, [SIGNALS.BOARD_TRUTH]: FIRST_READER }));

/**
 * @typedef {{ signal: string, status: "tripped" | "clear" | "unknown", detail: string, firstTrippedAt?: number | null,
 *             discriminator?: string, prompt?: string }} Reading
 * `detail` is one line: for `unknown` it is WHY, for `tripped` the numbers. `firstTrippedAt` is epoch ms, or `null` when the
 * signal's own source carries no time.
 */

/** @typedef {import("./lib/tool-version-agreement.mjs").Agreement} ToolAgreement */

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
 * makes a new head with a new run, so a PR still red on its head has had none. THE OWNER'S COMMENT IS WHAT IS LEFT TO ASK. A PR WITH NO OWNER IS ALWAYS UNATTENDED: no
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
 * @typedef {{ kind: "pr" | "row", number: number | string, reason: string, owner: string | null, since: number | null, boundMinutes?: number }} OverdueCandidate
 * One open item the outcome clock runs on. `since` is when it OPENED (epoch ms): a PR's `createdAt`, a row's newest claim record. It is `null` when
 * nothing dates it, which is an unknown and never an age. `reason` is the gate's own label for the state (`stallReasonOf` for a PR) and is DISPLAYED, never
 * a condition; `owner` is `null` when NOBODY could be named. `boundMinutes` is the item's OWN bound, set by the reader that measured one (an idle claimed
 * row's 80 minutes, #3569) and absent for every other item, which keeps its kind's.
 */

/** @param {number} minutes @returns {string} how long an item has been open: minutes under two hours, hours to one decimal after */
const openFor = (minutes) => (minutes >= HOURS_FROM_MINUTES ? `${hoursOf(minutes)} h` : `${minutes} min`);

/** @param {OverdueCandidate} item @returns {number} the minutes it may stay open before it is overdue: its own when it carries one, else its kind's */
const boundOf = (item) => item.boundMinutes ?? (item.kind === "pr" ? OVERDUE_PR_MINUTES : OVERDUE_ROW_MINUTES);

/**
 * SIGNAL 7: THE OUTCOME CLOCK (#3486, replacing #2970's 180-minute "not progressing"). Every open PR and every claimed row has an age since it opened;
 * ONLY A MERGE OR A CLOSE STOPS IT, so a comment, a label, a hold, a draft and a push do not, and NO STATE EXEMPTS an item. `reason` rides on the
 * line as a label for whoever reads it. THE GATE UNDERSTANDING THE STATE IS NEVER A CONDITION FOR RAISING IT: that was the defect of the reasons
 * list this deleted, which is why a hold whose reason had gone (agent-org #149) and an approved draft with no stamp (#3406) were invisible.
 * `items` is `null` for a refused PR read. `unread` names the other reads the clock needed and was refused (the rows): an item with no
 * `since`, or an unread list, makes the answer unknown unless another item trips, and is never read as young.
 *
 * KEYED ON THE SET OF `kind#number:reason`, not an hour: a merge or a close takes an item out of the set, a new overdue item adds to it, and a reason
 * changing re-asks, because who owes the next move has changed.
 * @param {{ now: number, items: OverdueCandidate[] | null, unread?: string[] }} input
 * @returns {Reading}
 */
export function overdueReading({ now, items, unread = [] }) {
  if (items === null) return unknown(SIGNALS.OVERDUE, "the open pull requests could not be read");
  const crossedAt = (/** @type {OverdueCandidate} */ item) => /** @type {number} */ (item.since) + boundOf(item) * MS_PER_MINUTE;
  const overdue = items.filter((item) => item.since !== null && now >= crossedAt(item)).sort((a, b) => crossedAt(a) - crossedAt(b));
  if (overdue.length === 0) {
    const undated = items.filter((item) => item.since === null).length;
    const doubts = [...(undated > 0 ? [`${undated} open item(s) carried no opening time, so how long they have been open is not known`] : []),
      ...unread.map((what) => `${what} could not be read, so how long those items have been open is not known`)];
    return doubts.length === 0 ? clear(SIGNALS.OVERDUE) : unknown(SIGNALS.OVERDUE, doubts.join("; "));
  }
  const named = overdue.slice(0, MAX_NAMED).map((item) => `#${item.number} (${item.kind === "pr" ? "PR" : "row"}, ${item.reason}, open `
    + `${openFor(Math.round((now - /** @type {number} */ (item.since)) / MS_PER_MINUTE))}, ${item.owner === null ? "NO OWNER" : `owner ${item.owner}`}`
    + `${item.boundMinutes === undefined ? "" : `, bound ${item.boundMinutes} min`})`);
  const more = overdue.length > MAX_NAMED ? `, and ${overdue.length - MAX_NAMED} more` : "";
  const key = overdue.map((item) => `${item.kind}#${item.number}:${item.reason}`).sort().join(",");
  return { signal: SIGNALS.OVERDUE, status: "tripped", firstTrippedAt: crossedAt(overdue[0]), discriminator: `${SIGNALS.OVERDUE}@${key}`,
    detail: `${overdue.length} open item(s) not merged or closed within ${OVERDUE_PR_MINUTES} min (a PR) or ${OVERDUE_ROW_MINUTES} min (a claimed row): ${named.join("; ")}${more}` };
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
 * no readable `Waiting-for:` nothing can ever say they are over. THE AGE IS TIME SINCE THE ITEM'S LAST ACTIVITY (this signal's own; the outcome clock runs from the opening): an item somebody
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
 * @typedef {{ kind: "deferred" | "queue", name: string, since: number }} StalledOrder
 * One order that has not reached a seat: `deferred` is a derived order the waker refused because its seat is mid-turn, named by its causeKey and dated by the
 * tick that FIRST deferred it; `queue` is a standing seat's inbox, named by the seat and dated by its OLDEST authored order. `since` is epoch ms.
 */

/**
 * SIGNAL 10: AN ORDER HAS WAITED ON A BUSY SESSION FOR OVER `ORDER_STALL_MINUTES` (#3448). A deferral is not a fault -- it is what the queue is for -- and a
 * deferral that outlasts the bound is a stall nobody was told of: #3406 held a green, approved draft for forty minutes while the one session that could act
 * on it was on another row. `stalled` is `null` when the waker's record could not be read, which is a stated unknown and never a clear.
 *
 * STRICTLY OVER, as `refusalReport`'s `isOverdue` is, so the signal and the `UNDELIVERED` line it sits beside agree on the minute. Keyed on the SET of names,
 * not an hour: one order delivered or one more stalled changes it, and an unchanged set holds for the two hours the cause holds for.
 * @param {{ now: number, stalled: StalledOrder[] | null }} input
 * @returns {Reading}
 */
export function orderStallReading({ now, stalled }) {
  if (stalled === null) return unknown(SIGNALS.ORDER_STALLED, "the waker's record of deferred orders and queued orders could not be read");
  const over = stalled.filter((s) => now - s.since > ORDER_STALL_MINUTES * MS_PER_MINUTE).sort((a, b) => a.since - b.since || a.name.localeCompare(b.name));
  if (over.length === 0) return clear(SIGNALS.ORDER_STALLED);
  const named = over.slice(0, MAX_NAMED).map((s) => `${s.kind === "queue" ? `the queue of ${s.name}` : s.name} (${ageText(s.since, now)})`);
  const more = over.length > MAX_NAMED ? `, and ${over.length - MAX_NAMED} more` : "";
  const key = over.map((s) => `${s.kind}:${s.name}`).sort().join(",");
  return { signal: SIGNALS.ORDER_STALLED, status: "tripped", firstTrippedAt: over[0].since + ORDER_STALL_MINUTES * MS_PER_MINUTE,
    discriminator: `${SIGNALS.ORDER_STALLED}@${key}`,
    detail: `${over.length} order(s) or queue(s) have waited over ${ORDER_STALL_MINUTES} min on a session that is busy: ${named.join("; ")}${more}` };
}

/**
 * @typedef {{ session: string, pane: string, prompt: string, since: number }} PromptPane
 * One pane whose visible screen is an interactive prompt: the session it belongs to, herdr's pane id, WHICH prompt it is, and the tick that FIRST saw it
 * (`since`, epoch ms -- herdr stamps no time on a screen, so the waker keeps the first sighting).
 */

/**
 * SIGNAL 12: A PANE HAS STOPPED AT AN INTERACTIVE PROMPT FOR OVER `PANE_PROMPT_MINUTES` (#3458). Codex's working-directory picker and a trust prompt wait for a
 * human at a terminal nobody reads, and the pane reports no failure: it is a session that never started. `panes` is `null` when herdr's panes could not be read,
 * which is a stated unknown and never a clear. A pane that reads as idle WITH NO PROMPT is not in `panes` at all, so it is never raised here.
 *
 * STRICTLY OVER, as {@link orderStallReading} is. Keyed on the set of sessions and panes, so one stuck pane is one signal however many ticks it lasts.
 * @param {{ now: number, panes: PromptPane[] | null }} input
 * @returns {Reading}
 */
export function panePromptReading({ now, panes }) {
  if (panes === null) return unknown(SIGNALS.PANE_AT_PROMPT, "herdr's panes could not be read");
  const over = panes.filter((p) => now - p.since > PANE_PROMPT_MINUTES * MS_PER_MINUTE).sort((a, b) => a.since - b.since || a.session.localeCompare(b.session));
  if (over.length === 0) return clear(SIGNALS.PANE_AT_PROMPT);
  const named = over.slice(0, MAX_NAMED).map((p) => `${p.session} (pane ${p.pane}, ${p.prompt}, ${ageText(p.since, now)})`);
  const more = over.length > MAX_NAMED ? `, and ${over.length - MAX_NAMED} more` : "";
  const key = over.map((p) => `${p.session}:${p.pane}`).sort().join(",");
  return { signal: SIGNALS.PANE_AT_PROMPT, status: "tripped", firstTrippedAt: over[0].since + PANE_PROMPT_MINUTES * MS_PER_MINUTE,
    discriminator: `${SIGNALS.PANE_AT_PROMPT}@${key}`,
    detail: `${over.length} pane(s) have stood at an interactive prompt for over ${PANE_PROMPT_MINUTES} min: ${named.join("; ")}${more}` };
}

/**
 * @typedef {{ reason: string, detail: string, at: number, since: number | null }} AutoOffRefusal
 * The refusal `fleet-auto-off.mjs` keeps in its state file. `at` is the LAST tick that refused (rewritten every ten seconds) and `since` is the FIRST tick of the
 * unbroken run, `null` when the record carries none: a tick that proceeds, or has nothing to power off, writes `refusal: null`, which is what ends a run.
 * @typedef {{ unreadable: string } | { refusal: AutoOffRefusal | null, readAt: number }} AutoOffFact
 * What the mirror said, or WHY it could not be read. `readAt` is when `fleet-watch` read the record off the control plane (epoch ms), NOT when this tick ran.
 * `refusal: null` is a mirror that was read and records no refusal, which is not the same as `unreadable`.
 */

/**
 * SIGNAL 15: `fleet-auto-off` HAS REFUSED TO POWER WORKERS OFF FOR OVER `AUTO_OFF_REFUSAL_MINUTES` (#3853). It is loud by design (it prints `refuse <reason>`, exits 1
 * and records the refusal), and on 2026-10-06 that was 2,569 refusals nobody acted on, because nothing that raises read the record. THE AGE IS `since`, NOT `at`:
 * `at` is the latest tick and is seconds old for as long as the refusal stands, so an age taken from it is never over. A record with no `since` is therefore an
 * UNKNOWN that says so, never a fallback to `at`, which would read every standing refusal as brand new.
 *
 * AN UNKNOWN, NEVER A CLEAR, for a mirror that could not be read, that does not parse, that was read longer ago than `AUTO_OFF_MIRROR_STALE_MINUTES` (a watcher
 * that did not look), whose last tick is older than `AUTO_OFF_RECORD_STALE_MINUTES` before `readAt` (the timer had stopped), or that is inconsistent (`since` after
 * `at`). STRICTLY OVER, as {@link orderStallReading} is. Keyed on `since`, so one unbroken refusal is one signal
 * however long it lasts and however often its reason changes; a tick that proceeds ends the run and the next refusal is a new one.
 * @param {{ now: number, autoOff: AutoOffFact }} input
 * @returns {Reading}
 */
export function autoOffRefusalReading({ now, autoOff }) {
  const signal = SIGNALS.AUTO_OFF_REFUSING;
  if ("unreadable" in autoOff) return unknown(signal, autoOff.unreadable);
  const { refusal, readAt } = autoOff;
  if (now - readAt > AUTO_OFF_MIRROR_STALE_MINUTES * MS_PER_MINUTE) {
    return unknown(signal, `the auto-off mirror was last read off the control plane ${ageText(readAt, now)} ago (limit ${AUTO_OFF_MIRROR_STALE_MINUTES} min), so whether fleet auto-off is refusing is not known`);
  }
  if (refusal === null) return clear(signal);
  if (readAt - refusal.at > AUTO_OFF_RECORD_STALE_MINUTES * MS_PER_MINUTE) {
    return unknown(signal, `the record's last refusal (${refusal.reason}) was written ${ageText(refusal.at, readAt)} before the mirror read it, so the timer had stopped and whether it still refuses is not known`);
  }
  if (refusal.since === null) return unknown(signal, `the record names a refusal (${refusal.reason}) but carries no \`since\`, so how long it has stood is not known`);
  if (refusal.since > refusal.at) return unknown(signal, `the record's refusal began (${isoOf(refusal.since)}) after its last tick (${isoOf(refusal.at)}), so its age is not known`);
  const tripAt = refusal.since + AUTO_OFF_REFUSAL_MINUTES * MS_PER_MINUTE;
  if (now <= tripAt) return clear(signal);
  return { signal, status: "tripped", firstTrippedAt: tripAt, discriminator: `${signal}@${isoOf(refusal.since)}`,
    detail: `fleet auto-off has refused to power workers off for ${ageText(refusal.since, now)} (\`${refusal.reason}\`): ${refusal.detail.slice(0, MAX_QUOTED_CHARS)}` };
}

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value @returns {value is number} */
const isTime = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * THE REFUSAL RECORD, from the mirror file as text: `{ readAt, record }`, `record` being the control plane's state file verbatim (`{}` when it has none). Anything
 * that is not a mirror this reading can believe is `unreadable` with the reason, never a `null` refusal: absent and malformed are different from "refused nothing".
 * @param {string | null} text `null` for a file that could not be read
 * @param {string} path only for the sentence
 * @returns {AutoOffFact}
 */
export function parseAutoOffMirror(text, path) {
  if (text === null) return { unreadable: `\`${path}\` could not be read, so whether fleet auto-off is refusing is not known` };
  let mirror;
  try {
    mirror = JSON.parse(text);
  } catch (err) {
    return { unreadable: `\`${path}\` is not JSON (${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS)})` };
  }
  if (!isObject(mirror) || !isTime(mirror.readAt) || !isObject(mirror.record)) return { unreadable: `\`${path}\` is not \`{ readAt, record }\`` };
  const refusal = mirror.record.refusal ?? null;
  if (refusal === null) return { refusal: null, readAt: mirror.readAt };
  if (typeof refusal.reason !== "string" || typeof refusal.detail !== "string" || !isTime(refusal.at) || !(refusal.since === undefined || isTime(refusal.since))) {
    return { unreadable: `\`${path}\` holds a refusal without a reason, a detail and a time` };
  }
  return { refusal: { reason: refusal.reason, detail: refusal.detail, at: refusal.at, since: refusal.since ?? null }, readAt: mirror.readAt };
}

/**
 * THE FLEET'S REFUSAL RECORD, as `fleet-watch` mirrored it (`AUTO_OFF_MIRROR_PATH`) from the control plane. NEVER THROWS, and never ssh: the file is read off this
 * checkout like any other. A checkout `fleet-watch` does not run in holds no mirror, or one nobody keeps current, and the reading says so: that is the answer, not a
 * defect of the reader.
 * @param {{ root?: string, read?: (path: string) => string }} [where]
 * @returns {AutoOffFact}
 */
export function readAutoOffRefusal({ root = DEFAULT_ROOT, read = (path) => readFileSync(path, "utf8") } = {}) {
  const path = resolve(root, AUTO_OFF_MIRROR_PATH);
  return parseAutoOffMirror(readOrNull(read, path), path);
}

/**
 * @typedef {{ account: string | null, resource: string, remaining: number, limit: number, resetAt: string | null }} PoolReading
 * One API budget as a real call's answer gave it (`poolFromHeaders`, or a `rateLimit` field in a query the gate was sending anyway), NEVER `/rate_limit`, which
 * has reported a full pool during a total outage (#1967). `account` is the login the call ran as, `null` when the answer did not name one.
 */

/**
 * SIGNAL 11: A POOL IS BELOW `POOL_LOW_FRACTION` OF ITS LIMIT (#3448). A session that meets an exhausted pool sleeps on the reset, and three standing seats did at
 * once on 2026-10-04 with nothing in the org knowing why its inbox was three orders deep. The reading names the account, the pool and the reset, because "low"
 * with no window is not a measurement. `pools` is `null` when no pool was read this tick.
 *
 * A POOL AT EXACTLY THE FRACTION IS NOT RAISED (at or above clears), and a limit of 0 is unread and never a divide. Keyed on the account, the pool and the
 * reset time, so one spent window is one signal however many ticks it lasts and the next window starts a new one.
 * @param {{ pools: PoolReading[] | null }} input
 * @returns {Reading}
 */
export function poolLowReading({ pools }) {
  if (pools === null) return unknown(SIGNALS.POOL_LOW, "no API pool was read this tick");
  const low = pools.filter((p) => p.limit > 0 && p.remaining / p.limit < POOL_LOW_FRACTION).sort((a, b) => `${a.account}/${a.resource}`.localeCompare(`${b.account}/${b.resource}`));
  if (low.length === 0) return clear(SIGNALS.POOL_LOW);
  const named = low.slice(0, MAX_NAMED).map((p) => `${p.account ?? "an unnamed account"}'s ${p.resource} pool has ${p.remaining} of ${p.limit} left`
    + ` (${Math.round((p.remaining / p.limit) * 100)}%), resetting ${p.resetAt ?? "at a time the answer did not give"}`);
  const key = low.map((p) => `${p.account}/${p.resource}/${p.resetAt}`).join(",");
  return { signal: SIGNALS.POOL_LOW, status: "tripped", firstTrippedAt: null, discriminator: `${SIGNALS.POOL_LOW}@${key}`,
    detail: `${low.length} API pool(s) are below ${Math.round(POOL_LOW_FRACTION * 100)}% of their limit: ${named.join("; ")}` };
}

/**
 * SIGNAL: AN OPEN ROW IS NOT IN EXACTLY ONE STATE (#3942). THE RULE IS `stateLabelFindings`' (the leaf the audit reads too), over the open rows
 * the tick already read, so it costs no call. It trips THE TICK A ROW APPEARS, with one grace (#4048: a row `row-file` is still filing, below): a row in no state is absent from the Ready lane and
 * the claim pool and nothing else will ever name it (fifteen stood for days behind `labellessRows`, which a `lane:any` label satisfied), and a
 * row in two is read two ways by two readers. KEYED ON THE NUMBERS AND THEIR KIND, not an hour: the set changes only when a row enters, leaves
 * or changes kind, so one standing set is one order however many ticks it lasts. `null` is a refused read, which is unknown and never clear.
 * #4048: GIVEN `now`, a row with no state label younger than `FILING_GRACE_MS` is a row `row-file` is still filing (it adds the label last), not a finding.
 * @param {{ rows: { number: number, state?: string, createdAt?: string, labels?: (string | { name?: string })[] }[] | null, now?: number }} input
 * @returns {Reading}
 */
export function stateLabelReading({ rows, now }) {
  if (rows === null) return unknown(SIGNALS.STATE_LABEL, "the open rows could not be read, so no row is known to be in exactly one state");
  const found = stateLabelFindings(rows, { now }).sort((a, b) => a.number - b.number);
  if (found.length === 0) return clear(SIGNALS.STATE_LABEL);
  const none = found.filter((f) => f.kind === "NONE");
  const many = found.filter((f) => f.kind === "MANY");
  const parts = [
    ...(none.length > 0 ? [`${none.length} carry NO state label: ${none.map((f) => `#${f.number}`).join(", ")}`] : []),
    ...(many.length > 0 ? [`${many.length} carry MORE THAN ONE: ${many.map((f) => `#${f.number} (${f.labels.join(", ")})`).join(", ")}`] : []),
  ];
  return { signal: SIGNALS.STATE_LABEL, status: "tripped", firstTrippedAt: null,
    discriminator: `${SIGNALS.STATE_LABEL}@${found.map((f) => `${f.number}${f.kind === "NONE" ? "n" : "m"}`).join(",")}`,
    detail: `${found.length} open row(s) are not in exactly one of ${STATE_LABELS.join(", ")}; ${parts.join("; ")}` };
}

/**
 * SIGNAL: THE BOARD DISAGREES WITH REALITY (#4043, the chairman, 2026-10-08): an open epic whose children are all closed, a row a merged PR closes, a claim with nobody
 * holding it, a wait already true, a row in no state or two, a duplicate. `audit` is `boardTruthAudit`'s answer over rows the caller already read; `null` is a refused read,
 * which is unknown and never clear. The detail IS the day's table, count first (`boardTruthTable`), so the order carries each row and the field to fix. It trips the tick a
 * row disagrees and is KEYED ON THE ROW AND QUESTION PAIRS, so one standing set is one order however many ticks it lasts. An UNREAD question alone does not trip: it is named
 * in the table's count line and reported UNKNOWN here so it is said, not assumed clear.
 * @param {{ audit: { findings: { question: string, number: number }[], unread: string[] } | null, day?: string }} input
 * @returns {Reading}
 */
export function boardTruthReading({ audit, day = "today" }) {
  if (audit === null) return unknown(SIGNALS.BOARD_TRUTH, "the board could not be read, so no row is known to agree with reality");
  if (audit.findings.length === 0) {
    return audit.unread.length === 0 ? clear(SIGNALS.BOARD_TRUTH)
      : unknown(SIGNALS.BOARD_TRUTH, `0 disagree on what was read, but ${audit.unread.join(", ")} could not be read`);
  }
  return { signal: SIGNALS.BOARD_TRUTH, status: "tripped", firstTrippedAt: null,
    discriminator: `${SIGNALS.BOARD_TRUTH}@${audit.findings.map((f) => `${f.number}${f.question}`).join(",")}`,
    detail: `\n${boardTruthTable(/** @type {any} */ (audit), day)}\n` };
}

/**
 * SIGNAL: THE ORG IS IDLE WHILE ROWS ARE OPEN (#3943). `idle` is `idleWithOpenRowsReading`'s answer over the open rows the tick already read, so it costs no call:
 * `null` is an engineer holding a row (clear); `{ kind: "unread" }` is a read that did not return, which is unknown and NEVER an idle org; an idle org
 * with nothing unoffered is finished and clear. It trips THE TICK THE CONDITION HOLDS, with no grace (the chairman's order: within one tick), and clears the tick an
 * engineer holds a row. KEYED ON THE KINDS OF REASON (and the `READY_UNOFFERED` numbers, the one defect), not on every row, so a backlog row filed while idle is not a
 * second order; a new KIND of reason is.
 * @param {{ idle: import("./idle-with-open-rows.mjs").IdleRows }} input
 * @returns {Reading}
 */
export function idleWithOpenRowsSignal({ idle }) {
  if (idle === null) return clear(SIGNALS.IDLE_WITH_OPEN_ROWS);
  if (idle.kind === "unread") return unknown(SIGNALS.IDLE_WITH_OPEN_ROWS, idle.why);
  if (idle.findings.length === 0) return clear(SIGNALS.IDLE_WITH_OPEN_ROWS);
  const kinds = [...new Set(idle.findings.map((f) => f.kind))].sort();
  const defects = idle.findings.filter((f) => f.kind === IDLE_REASONS.READY_UNOFFERED).map((f) => f.number);
  return { signal: SIGNALS.IDLE_WITH_OPEN_ROWS, status: "tripped", firstTrippedAt: null,
    discriminator: `${SIGNALS.IDLE_WITH_OPEN_ROWS}@${kinds.join(",")}${defects.length > 0 ? `:${defects.join(",")}` : ""}`,
    detail: `no engineer holds a row, and ${idleLine(idle.findings, idle.dateHeld)}` };
}

/**
 * @typedef {{ original: string, copy: string, allowedLines: number | null, originalText: string | null, copyText: string }} CopyPair
 * One declared copy: where it came from and where it sits (both relative to the checkout), how many lines its own header says it
 * changed (`null` when the header says none), the original's text (`null` when it could not be read) and the copy's text.
 */

/**
 * SIGNAL (#3533): A RUNNER OF `agent-org` THAT IS NOT ON THE NEWEST RELEASE FOR LONGER THAN ONE RELEASE CYCLE, whichever of the three kinds it is (the tool checkout, a worktree's resolved
 * copy, the last `ci.yml` run on `main`). The comparison is `lib/tool-version-agreement.mjs`'s, which `host:check` calls too; THIS only turns its result into a reading. `agreement` is `undefined`
 * when the caller does not ask (a host that declares no tool), `null` when the read was refused, else what the child read returned (`{ result }`). Keyed on the newest tag: one release, one signal,
 * and the next release is a new one. A runner the read could not say anything about is an `unknown` and never a clear.
 * @param {{ agreement: { result: ToolAgreement } | null }} input @returns {Reading}
 */
export function toolVersionReading({ agreement }) {
  if (agreement === null) return unknown(SIGNALS.TOOL_VERSION, "the read of which `agent-org` version every runner runs did not return");
  const { result } = agreement;
  if (result.unreadable !== null) return unknown(SIGNALS.TOOL_VERSION, result.unreadable);
  if (result.signals.length === 0) {
    const unsaid = result.readings.filter((r) => r.verdict === "unknown" || r.verdict === "unread");
    if (unsaid.length === 0) return clear(SIGNALS.TOOL_VERSION);
    return unknown(SIGNALS.TOOL_VERSION, `no runner is behind the newest release, but ${unsaid.length} could not be read: ${unsaid.slice(0, MAX_NAMED).map((r) => `${r.runner} (${r.detail})`).join("; ")}`);
  }
  const named = result.signals.slice(0, MAX_NAMED).map((s) => `${s.kind} ${s.runner} runs ${s.version ?? "no release"}`).join("; ");
  const more = result.signals.length > MAX_NAMED ? `; and ${result.signals.length - MAX_NAMED} more` : "";
  const firstTrippedAt = result.newestCutAt === null ? null : result.newestCutAt + result.cycleMs;
  return { signal: SIGNALS.TOOL_VERSION, status: "tripped", firstTrippedAt, discriminator: `${SIGNALS.TOOL_VERSION}@${result.newest}`,
    detail: `${result.signals.length} runner(s) are not on ${result.newest}, which was cut over one release cycle ago: ${named}${more}` };
}

/**
 * THE READ, in a CHILD: `lib/tool-version-agreement.mjs --json` asks the tool's remote for its tags, each worktree for its resolved copy and GitHub for the last CI run, and a gate that imported
 * those readers would carry the history readers into every test that reaches the tick (`host-units.mjs`'s `jsonReport` is the precedent for the fence). `undefined` is "not asked" (a host that
 * declares no tool); `null` is a read that failed, which the reading says. NEVER THROWS.
 * @param {(args: string[]) => string} [run] @returns {{ now: number, result: ToolAgreement } | null | undefined}
 */
export function readToolAgreement(run = (args) => execFileSync(process.execPath, args, { encoding: "utf8", timeout: AGREEMENT_READ_MS, stdio: ["ignore", "pipe", "pipe"], env: process.env })) {
  try {
    const parsed = JSON.parse(run([resolve(TOOL_ROOT, "src/lib/tool-version-agreement.mjs"), "--json"]));
    return parsed.asked === false ? undefined : parsed;
  } catch {
    return null;
  }
}

/** GitHub's `permissions` booleans on a team's repository, highest first: the team's level there is the first one that is true. */
const TEAM_LEVELS = Object.freeze(["admin", "maintain", "push", "triage", "pull"]);
/** One `full_name<TAB>admin<TAB>maintain<TAB>push<TAB>triage<TAB>pull` line per repository the team reaches. */
const TEAM_LISTING_JQ = ".[]|[.full_name,.permissions.admin,.permissions.maintain,.permissions.push,.permissions.triage,.permissions.pull]|@tsv";
const TEAM_PAGE_SIZE = 100;

/**
 * @typedef {{ repo: string, level: string }} TeamRepository
 * @typedef {{ team: string, layer: string, declared: string[], reached: TeamRepository[] | null, why: string }} TeamAccess `reached` is `null` for a read that could not run, and `why` then says what GitHub answered
 * @typedef {{ teams: TeamAccess[] } | { unreadable: string }} TeamAccessFact
 */

/**
 * SIGNAL 14: AN ORG TEAM HOLDS A LEVEL THE PROJECT'S DECLARATION DOES NOT GIVE (a11ign/a11ign#3634, a class gap of #3587: `bots` held `admin` on
 * `screenreader-worker` and `auth-capture-check` and nothing read it). Two things trip it: `admin` on ANY repository the team reaches (an agent with
 * admin edits the protection whose review requirement nobody may walk past), and a level other than the declared one on a DECLARED repository,
 * where a declared repository the team does not reach is `none`. A repository the team reaches that the declaration does not name is NOT a trip
 * unless it is `admin`: the declaration says what each layer repository gives, not what else the team may see.
 *
 * A READ THAT CANNOT RUN IS UNKNOWN, NEVER CLEAR. `GET orgs/<org>/teams/<slug>/repos` answers 404 to a token that cannot see the team, and an EMPTY
 * listing is the same blindness wearing a 200 (a declared team that reaches nothing has not been read), so each is `unknown` with its reason, as is a
 * declaration that could not be read or declares no team. A trip stands over an unread team: what WAS read is not unread.
 * @param {{ access: TeamAccessFact }} input `access` is `readTeamAccess`'s answer; `undefined` (not asked) never reaches here
 * @returns {Reading}
 */
export function teamAccessReading({ access }) {
  if ("unreadable" in access) return unknown(SIGNALS.TEAM_ACCESS, access.unreadable);
  if (access.teams.length === 0) return unknown(SIGNALS.TEAM_ACCESS, "the declaration names no team, so no team's level was compared");
  const unread = access.teams.flatMap((t) => (t.reached === null ? [`${t.team} (${t.why})`]
    : t.reached.length === 0 ? [`${t.team} (it reaches no repository, which is a read that saw nothing: CANNOT_TELL)`] : []));
  const found = access.teams.flatMap(teamDifferences);
  if (found.length === 0) {
    return unread.length === 0 ? clear(SIGNALS.TEAM_ACCESS)
      : unknown(SIGNALS.TEAM_ACCESS, `CANNOT_TELL: the team's repositories could not be read: ${unread.join("; ")}`);
  }
  const named = found.slice(0, MAX_NAMED).map((f) => f.text).join("; ");
  const more = found.length > MAX_NAMED ? `, and ${found.length - MAX_NAMED} more` : "";
  return { signal: SIGNALS.TEAM_ACCESS, status: "tripped", firstTrippedAt: null,
    discriminator: `${SIGNALS.TEAM_ACCESS}@${found.map((f) => f.key).sort().join(",")}`,
    detail: `${found.length} team level(s) differ from the declaration: ${named}${more}` };
}

/** @param {TeamAccess} access @returns {{ key: string, text: string }[]} one entry per repository, `team:repo` keyed so a second repository is a new trip */
function teamDifferences({ team, layer, declared, reached }) {
  if (reached === null || reached.length === 0) return [];
  const held = new Map(reached.map(({ repo, level }) => [repo, level]));
  const found = new Map();
  for (const repo of declared) {
    const level = held.get(repo) ?? "none";
    if (level !== layer) found.set(repo, `${repo}: the ${team} team holds ${level}, declared ${layer}`);
  }
  for (const [repo, level] of held) {
    if (level === "admin" && !found.has(repo)) found.set(repo, `${repo}: the ${team} team holds admin${declared.includes(repo) ? "" : " and is not declared"}`);
  }
  return [...found].map(([repo, text]) => ({ key: `${team}:${repo}`, text }));
}

/** @param {string} text @returns {TeamRepository[] | null} `null` for a line that is not six fields: a partial listing is not a reading */
export function parseTeamListing(text) {
  const rows = [];
  for (const line of text.split("\n").filter((l) => l.trim() !== "")) {
    const [repo, ...flags] = line.split("\t");
    if (!repo || flags.length !== TEAM_LEVELS.length) return null;
    rows.push({ repo, level: TEAM_LEVELS.find((_, i) => flags[i] === "true") ?? "none" });
  }
  return rows;
}

/**
 * THE DECLARATION THE PROJECT NAMES, as `{ org, declared, teams }`, or `{ unreadable }`. The route is `teamAccess.declaration` in `.agent-org/project.json`
 * (a path relative to the project root, which may not climb out of it): `agent-org` names no project's file. The file's own shape is the contract: `teams`
 * maps a team's slug to `{ layer }`, and `repositories` is keyed by the `owner/name` of each declared repository, whose common owner is the org. A
 * malformed key is a named reason and never a silent off, so a project that mistyped it is told on the next tick rather than believing it is watched.
 * @param {string} root @param {(path: string) => string} read
 * @returns {{ declaration: undefined } | { unreadable: string } | { org: string, declared: string[], teams: { team: string, layer: string }[] }}
 */
function readTeamDeclaration(root, read) {
  const project = `${root}/.agent-org/project.json`;
  try {
    const key = JSON.parse(read(project)).teamAccess;
    if (key === undefined) return { declaration: undefined };
    if (typeof key?.declaration !== "string" || key.declaration === "" || resolve(root, key.declaration).startsWith(`${resolve(root)}/`) === false) {
      return { unreadable: `${project}: teamAccess.declaration must be a path inside the project (CANNOT_TELL)` };
    }
    return teamDeclarationOf(JSON.parse(read(resolve(root, key.declaration))), key.declaration);
  } catch (err) {
    return { unreadable: `the team declaration could not be read: ${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS)} (CANNOT_TELL)` };
  }
}

/** @param {any} file @param {string} where @returns {ReturnType<typeof readTeamDeclaration>} */
function teamDeclarationOf(file, where) {
  const declared = Object.keys(file?.repositories ?? {}).filter((k) => !k.startsWith("_"));
  const orgs = new Set(declared.map((repo) => repo.split("/")[0]));
  const teams = Object.entries(file?.teams ?? {}).filter(([k]) => !k.startsWith("_"))
    .map(([team, level]) => ({ team, layer: /** @type {any} */ (level)?.layer }));
  if (orgs.size !== 1 || teams.some((t) => typeof t.layer !== "string")) {
    return { unreadable: `${where}: it must declare \`repositories\` of one org and each \`teams.<slug>.layer\` as a string (CANNOT_TELL)` };
  }
  return { org: [...orgs][0], declared, teams };
}

/**
 * THE FACT FOR `teamAccessReading`: the declaration, then ONE paginated REST call per declared team on the core pool (`gh api` spends core, never GraphQL, `gh-api-budget.md`).
 * `undefined` is "not asked" (the project declares no `teamAccess`), `{ unreadable }` a read that failed, and a team GitHub refused is `reached: null` with its own reason.
 * NEVER THROWS.
 * @param {(args: string[]) => string} run @param {{ root?: string, read?: (path: string) => string }} [io]
 * @returns {TeamAccessFact | undefined}
 */
export function readTeamAccess(run, { root = HOME_CHECKOUT, read = (path) => readFileSync(path, "utf8") } = {}) {
  const found = readTeamDeclaration(root, read);
  if ("declaration" in found) return undefined;
  if ("unreadable" in found) return found;
  return { teams: found.teams.map(({ team, layer }) => ({ team, layer, declared: found.declared, ...readTeamRepositories(run, found.org, team) })) };
}

/** @param {(args: string[]) => string} run @param {string} org @param {string} team @returns {{ reached: TeamRepository[] | null, why: string }} */
function readTeamRepositories(run, org, team) {
  try {
    const reached = parseTeamListing(run(["api", `orgs/${org}/teams/${team}/repos?per_page=${TEAM_PAGE_SIZE}`, "--paginate", "--jq", TEAM_LISTING_JQ]));
    return reached === null ? { reached, why: "GitHub answered a line that is not a repository's permissions" } : { reached, why: "" };
  } catch (err) {
    return { reached: null, why: String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS) };
  }
}

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

/** How many of the newest `release.yml` runs on `main` the release read looks at: the `status` runs it skips on every commit crowd the list, so the window is wide. */
const RELEASE_RUN_WINDOW = 30;
const RELEASE_JOBS_WINDOW = 100;
/** The two conclusions that say whether a release happened. `cancelled`, `skipped`, `neutral` and a run still going say nothing, so they neither trip nor clear (#4001). */
const RELEASE_VERDICTS = Object.freeze(["success", "failure"]);

/**
 * @typedef {{ id: number, event: string, status: string, conclusion: string | null, sha: string, createdAt: string, updatedAt: string, url: string }} ReleaseRun
 * @typedef {{ name: string, steps: string[] }} FailedJob
 * @typedef {{ runs: ReleaseRun[], jobs?: FailedJob[] | null, pending?: string[] | null }} ReleaseRuns `jobs` and `pending` are read only when the newest verdict is a failure; `null` is a read that was refused
 */

/** @param {ReleaseRun[]} runs @returns {ReleaseRun | undefined} the newest run that concluded `success` or `failure`: the one that says whether the last release happened */
export function newestReleaseVerdict(runs) {
  return [...runs].filter((r) => RELEASE_VERDICTS.includes(String(r.conclusion))).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

/**
 * SIGNAL 18 (#4001): THE LAST RELEASE RUN ON `main` FAILED AND NOTHING HAS SUCCEEDED SINCE. The newest run that CONCLUDED decides: a later `success` clears it, and a run
 * that was cancelled, skipped or is still going neither trips nor clears it (the `status` runs `release.yml` skips on every commit must not read as a release). Any event
 * counts, because a failed release is a failed release whatever started it. A list with no verdict in it is UNKNOWN, never clear: a window of skipped runs says nothing.
 * The jobs and the pending changesets are the DETAIL of a failure already certain, so a refusal of either is said in the detail and does not turn the trip into an unknown.
 * @param {{ releaseRuns: ReleaseRuns | null }} input
 * @returns {Reading}
 */
export function releaseFailedReading({ releaseRuns }) {
  const signal = SIGNALS.RELEASE_FAILED;
  if (releaseRuns === null) return unknown(signal, "the runs of release.yml on main could not be read, so the last release is not known to have succeeded");
  const verdict = newestReleaseVerdict(releaseRuns.runs);
  if (verdict === undefined) return unknown(signal, `none of the newest ${releaseRuns.runs.length} release.yml run(s) on main concluded success or failure, so no release is known to have happened or failed`);
  if (verdict.conclusion === "success") return clear(signal);
  const failedAt = Date.parse(verdict.updatedAt);
  return { signal, status: "tripped", firstTrippedAt: Number.isFinite(failedAt) ? failedAt : null, discriminator: `${signal}@${verdict.id}`,
    detail: `release.yml on main FAILED and no later run succeeded: run ${verdict.id} (${verdict.event}) at ${verdict.sha.slice(0, 9)}, ${failedJobsText(releaseRuns.jobs)}; ${pendingText(releaseRuns.pending)}; ${verdict.url}` };
}

/** @param {FailedJob[] | null | undefined} jobs @returns {string} */
function failedJobsText(jobs) {
  if (!jobs) return "the failing job could not be read (read the run)";
  if (jobs.length === 0) return "no job of it reports failure (read the run)";
  const named = jobs.slice(0, MAX_NAMED).map(({ name, steps }) => `job \`${name}\`${steps.length > 0 ? ` (step ${steps.map((s) => `"${s}"`).join(", ")})` : ""}`);
  return `${named.join("; ")}${jobs.length > MAX_NAMED ? `; and ${jobs.length - MAX_NAMED} more` : ""}`;
}

/** @param {string[] | null | undefined} pending @returns {string} */
function pendingText(pending) {
  if (!pending) return "the pending changesets could not be read";
  if (pending.length === 0) return "no changeset is pending in .changeset/";
  return `${pending.length} changeset(s) pending in .changeset/: ${pending.slice(0, MAX_NAMED).join(", ")}${pending.length > MAX_NAMED ? ", ..." : ""}`;
}

/**
 * THE FACT FOR `releaseFailedReading`: ONE REST CALL on the core pool for the newest `release.yml` runs on `main`, and, only while the newest verdict is a failure, TWO MORE
 * (that run's jobs, and `.changeset/` on `main`). `null` is a refused or unparseable list, a stated unknown and never "no failure". NEVER THROWS.
 * @param {(args: string[]) => string} run @param {string} repo
 * @returns {ReleaseRuns | null}
 */
export function readReleaseRuns(run, repo) {
  const runs = tryJson(() => run(["api", "--method", "GET", `repos/${repo}/actions/workflows/release.yml/runs`, "-f", "branch=main", "-f", `per_page=${RELEASE_RUN_WINDOW}`,
    "--jq", "[.workflow_runs[] | {id, event, status, conclusion, sha: .head_sha, createdAt: .created_at, updatedAt: .updated_at, url: .html_url}]"]));
  if (!Array.isArray(runs)) return null;
  const verdict = newestReleaseVerdict(runs);
  if (verdict?.conclusion !== "failure") return { runs };
  const jobs = tryJson(() => run(["api", `repos/${repo}/actions/runs/${verdict.id}/jobs?per_page=${RELEASE_JOBS_WINDOW}`,
    "--jq", "[.jobs[] | select(.conclusion == \"failure\") | {name, steps: [.steps[] | select(.conclusion == \"failure\") | .name]}]"]));
  const files = tryJson(() => run(["api", `repos/${repo}/contents/.changeset?ref=main`, "--jq", "[.[].name]"]));
  return { runs, jobs: Array.isArray(jobs) ? jobs : null,
    pending: Array.isArray(files) ? files.filter((name) => name.endsWith(".md") && name !== "README.md") : null };
}

/** @param {() => string} read @returns {any} the parsed output, or `null` for a refusal or text that is not JSON: a stated gap for the caller, never an empty answer */
function tryJson(read) {
  try {
    return JSON.parse(read());
  } catch {
    return null;
  }
}

/**
 * THE READINGS, in a fixed order: the four of #2936, then the two of #2937 and the outcome clock (#3486, which replaced #2970's) WHEN ITS FACT IS GIVEN. An OMITTED fact (`undefined`) is
 * "this caller does not ask", which is silent; `null` is "asked and refused", which is a stated unknown. The two must not share a
 * value, or a gate that never wired the fleet read would log an unknown every tick for a fault nobody can fix from the log.
 * @param {{ now: number, lastMergedAt: number | null, work: { greenPrs: number, claimableRows: number } | null, redPrs: RedPr[] | null,
 *           refusals: Record<string, { reason: string, ticks: number }> | null,
 *           drift: { behind: number, ahead: number, dirty: string[] } | null, primarySince: number | null,
 *           fleet?: FleetCaptures | null, waiting?: FleetWaiting | null, copies?: CopyPair[] | null, overdue?: { items: OverdueCandidate[] | null, unread?: string[] },
 *           waits?: { stale: Parameters<typeof staleWaitReading>[0]["stale"], bare: Parameters<typeof waitWithoutReasonReading>[0]["bare"], manual: number } | null,
 *           pools?: PoolReading[] | null, toolAgreement?: { result: ToolAgreement } | null, teamAccess?: TeamAccessFact, autoOff?: AutoOffFact, stateRows?: Parameters<typeof stateLabelReading>[0]["rows"], idle?: import("./idle-with-open-rows.mjs").IdleRows, releaseRuns?: ReleaseRuns | null, boardTruth?: Parameters<typeof boardTruthReading>[0]["audit"] }} facts `boardTruth` (#4043) is `boardTruthAudit`'s answer over the rows the tick already read, `null` for a refused read and OMITTED when the caller does not ask; `releaseRuns` (#4001) is `readReleaseRuns()`'s answer, `null` for a refused read and OMITTED when the caller does not ask; `idle` (#3943) is `idleWithOpenRowsReading`'s answer over the rows the tick already read, OMITTED when the caller does not ask; `stateRows` (#3942) is the open rows the tick already read, `null` for a refused read and OMITTED when the caller does not ask; `autoOff` (#3853) is `readAutoOffRefusal()`'s answer, which `orgHealthTick` reads itself when the caller gives none; `teamAccess` (#3634) is `readTeamAccess()`'s answer, OMITTED when the project declares none; `toolAgreement` (#3533) is `readToolAgreement()`'s answer, OMITTED when the caller does not ask; `pools` (#3448) is the API budgets the tick read, `null` when none was; the order-stall reading is the WAKER's and rides `orderStallOrders`
 * @returns {Reading[]}
 */
export function orgHealthReadings(facts) {
  const readings = [noMergeReading(facts), redPrReading(facts), refusedRowReading(facts),
    primaryReading({ now: facts.now, drift: facts.drift, since: facts.primarySince })];
  if (facts.fleet !== undefined) readings.push(fleetIdleReading({ now: facts.now, fleet: facts.fleet, waiting: facts.waiting ?? null }));
  if (facts.copies !== undefined) readings.push(copyDriftReading({ pairs: facts.copies }));
  if (facts.overdue !== undefined) readings.push(overdueReading({ now: facts.now, ...facts.overdue }));
  if (facts.waits !== undefined) {
    readings.push(staleWaitReading({ now: facts.now, stale: facts.waits?.stale ?? null }),
      waitWithoutReasonReading({ now: facts.now, bare: facts.waits?.bare ?? null, manual: facts.waits?.manual }));
  }
  if (facts.pools !== undefined) readings.push(poolLowReading({ pools: facts.pools }));
  if (facts.toolAgreement !== undefined) readings.push(toolVersionReading({ agreement: facts.toolAgreement }));
  if (facts.teamAccess !== undefined) readings.push(teamAccessReading({ access: facts.teamAccess }));
  if (facts.autoOff !== undefined) readings.push(autoOffRefusalReading({ now: facts.now, autoOff: facts.autoOff }));
  if (facts.stateRows !== undefined) readings.push(stateLabelReading({ rows: facts.stateRows, now: facts.now }));
  if (facts.boardTruth !== undefined) readings.push(boardTruthReading({ audit: facts.boardTruth, day: isoOf(facts.now).slice(0, 10) }));
  if (facts.idle !== undefined) readings.push(idleWithOpenRowsSignal({ idle: facts.idle }));
  if (facts.releaseRuns !== undefined) readings.push(releaseFailedReading({ releaseRuns: facts.releaseRuns }));
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
  [SIGNALS.OVERDUE]: "Each item named has been open longer than three times the median it takes to merge (a PR) or close (a claimed row), and nothing has merged "
    + "or closed it: a comment, a hold or a push does not stop this clock. The reason in brackets is a LABEL for who owes the next move, never an excuse: "
    + "`conflicted` and `red` are the owner's to fix, `awaiting-review` needs a verdict (`reviewer-<n>`, or `product-manager` when the PR has none), "
    + "`awaiting-author-draft` is its author's to mark ready, `unarmed` is `product-manager`'s, `held-on-purpose` is a hold or a freeze that may have outlived its "
    + "reason (read its `Waiting-for:`, and lift it if the condition is true). The owner may already have been ordered and nothing came of it: READ WHY "
    + "(`gh pr view <n>`), then unstick it, re-lane it by putting the label of a session that can on it, or close it if it is abandoned.",
  [SIGNALS.STALE_WAIT]: "Each wait named still stands although the condition it declared is true: the reason is gone and the wait is a stall, not "
    + "health. The setter was ordered with the exact field to remove and did not. Remove it yourself (`pnpm run pr:hold -- <n> --session=<s> --release` "
    + "for a hold, `gh issue edit <n> --remove-label <label>` for a label, or the `Waiting-for:` line), or re-lane the item to a session that will.",
  [SIGNALS.ORDER_STALLED]: "Each order named has waited on a session that is busy for longer than the bound, and an order that waits is a stall nobody was told of "
    + "(#3406 held a green, approved draft this way). READ THE ORDER (`causeKey` names its cause and subject), then do what it asks yourself if it is a "
    + "finishing act (a ready-flip, a close-out), re-lane it by putting the label of a free session on the row or PR, or tell the busy session's owner what it "
    + "is not reading. A queue named is a standing seat's inbox whose oldest order is that old: that seat is never between tasks, so reduce what is sent to it.",
  [SIGNALS.POOL_LOW]: "An API pool is nearly spent. Every session on that account is about to sleep on its reset. READ WHICH CALLS SPENT IT before the "
    + "reset (a `gh` read is 1 point or more; `gh project item-*` and the board snapshot read the whole Project), prefer `gh api` REST reads for polling, "
    + "and do NOT switch to another account's `gh` config to get past it: which account a write is attributed to is `ceo`'s, and the pool comes back.",
  [SIGNALS.PANE_AT_PROMPT]: "Each pane named is waiting for a person to answer a prompt (Codex's working-directory picker, or a trust prompt), so the session in it has "
    + "not started and will not: the pane reports no failure. READ THE PANE (`herdr --session org pane read <pane> --source visible`), then answer it "
    + "if the session is still wanted (`herdr --session org pane send-keys <pane> Enter`), or close the workspace if it is not -- a reviewer whose pull "
    + "request is closed or merged is the second (`reviewer teardown` ends those by itself when it can see them). A trust prompt on a clone is the "
    + "reviewer's own codex config to edit, not a tick's.",
  [SIGNALS.TOOL_VERSION]: "Each runner named has run an older `agent-org` than the newest release for longer than one release cycle (the tick's interval, the tag lag and one more tick), so \"the org runs the latest\" "
    + "is not true of it. READ `node src/lib/tool-version-agreement.mjs` (or `host:check`) in the tool checkout for the whole list. A `tool` runner is the work-tick's `update-tool`, which should have moved the checkout to "
    + "the newest tag: read the tick's first journal line and why it did not. A `worktree` runner resolves a COPY of the dependency through its `node_modules`: until the removal row (#3534) merges it is the pin, "
    + "and after it a copy that is still there is stale (`pnpm install` in that worktree, or remove it). A `ci` runner names the version the last `ci.yml` run on `main` used: its lockfile's, or the tag its resolver step printed.",
  [SIGNALS.TEAM_ACCESS]: "An org team holds a level on a repository that the project's declaration (`teamAccess.declaration` in `.agent-org/project.json`) does not give: `admin` anywhere it reaches, "
    + "or a level other than the declared one on a declared repository. DO NOT CHANGE THE TEAM'S LEVEL YOURSELF: it is an org-admin act, the chairman's. Read the declaration's own prose "
    + "for what the level should be, then put the repositories named on #928 and `" + ANSWER_PREFIX + "ceo` on the row that carries them, or open the pull request that declares the level if the declaration is the one that is wrong.",
  [SIGNALS.AUTO_OFF_REFUSING]: "The fleet's auto-off timer holds every shutdown back because the checkout it runs from is not `main`'s (`stale-checkout`), its `git fetch` failed (`fetch-failed`) or "
    + "the comparison could not be made (`cannot-tell`), so idle workers stay powered ON. It is loud by design and was unread: 2,569 refusals over twelve hours on 2026-10-06. READ THE REASON AND DETAIL "
    + "above, then have `orchestrator` (the first reader for fleet questions) bring the control plane's checkout to `main` or fix the fetch. DO NOT RUN `fleet:*` YOURSELF, and do not clear the record by "
    + "hand: it clears when a tick proceeds. Say on #928 what the refusal was and what ended it.",
  [SIGNALS.BOARD_TRUTH]: "Each row in the table disagrees with what is true of it, and the table names the FIELD that does. `product-manager` reads it first and fixes what a field fixes: CLOSE an epic whose "
    + "children are closed or a row whose closing PR merged, LIFT a wait that is already true, keep the ONE state label that is true. A row marked for its owner needs a judgment (a claim nobody holds, a duplicate): "
    + "release the claim or close the duplicate with the reason on the row. Do not script the repair, and post the day's table on #928 so a count of 0 is a statement and not silence.",
  [SIGNALS.STATE_LABEL]: `A row is in exactly ONE of ${STATE_LABELS.map((l) => `\`${l}\``).join(", ")}, and each row named is in none or in several. A row in none is absent from the `
    + "Ready lane, the claim pool and every label-keyed count, and `ready:audit`'s `labelless rows` could not see it while it held any other label at all. `product-manager` reads it first: PROMOTE a row in none "
    + `(\`${READY_LABEL}\` if it is startable, else \`${BACKLOG_LABEL}\`), and for a row in several keep the ONE that is true (\`parked\` and \`epic\` REPLACE \`${BACKLOG_LABEL}\`), by hand with the reason on the row. `
    + "Do not script the repair; read `ready:audit`'s `state labels` line for the count against what GitHub reports.",
  [SIGNALS.IDLE_WITH_OPEN_ROWS]: "Nobody is building and rows are open: each row named is the reason it is not being built, from a closed list. MOST ARE STATES THE ORG CHOSE (`BACKLOG`, `PARKED`, `EPIC`, "
    + "`BLOCKED_BY` an open row, `WAITING_FOR` a declared condition, `ANSWER_OWED`, `LANE`, `B4 overlaps`): read whether the one holding the most is still true, and PROMOTE or UNBLOCK it if it is not. "
    + "`NO_STATE_LABEL` and `TWO_STATE_LABELS` are `row-without-exactly-one-state`'s. **`READY_UNOFFERED` IS A DEFECT, NOT A STATE**: a `" + READY_LABEL + "` row the gate has no reason to withhold while no one works, "
    + "so the offer is wrong or is not being taken; read `work:tick`'s own output for it and FILE what you find `" + READY_LABEL + "` WITH AN OWNER in this turn. Rows waiting on a `Not-before:` date are counted and not named. "
    + "It clears the tick an engineer holds a row.",
  [SIGNALS.RELEASE_FAILED]: "The newest `release.yml` run on `main` that concluded failed, and no later run has succeeded, so what merged since is NOT released and the tag the org follows is behind. "
    + "The job (and step) are named above: READ THE RUN'S LOG for that step before choosing. A cause that was TRANSIENT (a runner lost, a registry or network error) is retried from the SAME run: "
    + "`gh run rerun <run id> --failed -R <the repository in the URL above>`. A cause FIXED ON `main` since (the run is at an older sha) needs a NEW run, which a rerun of the old one does not give: "
    + "`gh workflow run release.yml --ref main -R <repository>`. If the cause is not fixed yet, FILE THE FIX `" + READY_LABEL + "` WITH AN OWNER in this turn. "
    + "Do not wait for the next changeset: a run is only ever started by a merge that carries one, so waiting leaves it red for as long as nobody merges one. It clears the tick a later run succeeds.",
  [SIGNALS.WAIT_WITHOUT_REASON]: "Each item named holds a wait (`hold:*`, `" + ANSWER_PREFIX + "*` or the blocked label) that says nothing about what it waits for, and nothing "
    + "has moved on it for hours. A wait nobody can check is how the 2026-10-02 freeze stood four hours after it ended. Ask its setter what ends it and write "
    + "`Waiting-for: <closed|merged|labelled <label>|unlabelled <label>> <#n>` on it, or remove the wait.",
}));

/** @param {string} signal @returns {string[]} who is ordered: the signal's first reader if it has one, then `ceo`, who takes every signal */
const readersOf = (signal) => [...(FIRST_READERS[signal] ? [FIRST_READERS[signal]] : []), OFFERED_TO];

/**
 * ONE ORDER PER TRIPPED SIGNAL, to `ceo` (and to the signal's first reader where `FIRST_READERS` names one), the numbers in the prompt. THE PROMPT CARRIES THE OTHER TRIPPED SIGNALS, because a
 * session is delivered one order per tick (`repeating-lines.mjs`' reason). An unknown or clear reading emits nothing here.
 * @param {Reading[]} readings
 * @returns {{session: string, cause: string, subject: string, discriminator: string, prompt: string, causeKey: string}[]}
 */
export function orgHealthOrders(readings) {
  const tripped = readings.filter((r) => r.status === "tripped");
  return tripped.flatMap((r) => readersOf(r.signal).map((session) => {
    const others = tripped.filter((o) => o !== r).map((o) => o.signal);
    const when = r.firstTrippedAt ? ` It first tripped at ${isoOf(r.firstTrippedAt)}.` : "";
    return {
      session,
      cause: "org-health",
      subject: r.signal,
      discriminator: /** @type {string} */ (r.discriminator),
      prompt: `ORG HEALTH: \`${r.signal}\` HAS TRIPPED. ${r.detail}.${when}\n${REMEDY[r.signal]}\n`
        + "This is asked because the org fixes what it is told about and does not look (the chairman, 2026-10-01): leave the place "
        + "better than you found it, and say on #928 what you found and did. It holds for two hours unchanged and stops when the "
        + `condition clears.${others.length > 0 ? `\nALSO TRIPPED (${others.length}): ${others.join(", ")}.` : ""}`,
      causeKey: `${session}/org-health/${r.discriminator}`,
    };
  }));
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
 * @param {{ log?: (line: string) => void, readCopies?: () => CopyPair[] | null, readAutoOff?: () => AutoOffFact }} [io]
 */
export function orgHealthTick(facts, { log = (line) => process.stderr.write(line), readCopies = () => readDeclaredCopies(), readAutoOff = () => readAutoOffRefusal() } = {}) {
  try {
    const copies = facts.copies !== undefined ? facts.copies : copiesToCompare(readCopies());
    const autoOff = facts.autoOff !== undefined ? facts.autoOff : readAutoOff();
    const readings = orgHealthReadings({ ...facts, autoOff, ...(copies === undefined ? {} : { copies }) });
    for (const r of readings) if (r.status === "unknown") log(`org-health: ${r.signal} UNKNOWN -- ${r.detail}; it is not read as clear.\n`);
    return orgHealthOrders(readings);
  } catch (err) {
    log(`org-health: could not run (${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS)}) -- no order this tick.\n`);
    return [];
  }
}
