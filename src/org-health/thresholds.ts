import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME_CHECKOUT } from "../project-config.ts";

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
 * both of its readers: `wake.ts`'s deferred order (`BUSY_SEAT_DEFERRAL_MS` is this) and a standing seat's queue, whose oldest entry is the same wait
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

export const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
export const MS_PER_HOUR = MINUTES_PER_HOUR * MS_PER_MINUTE;
/** A span is quoted in minutes up to this many and in hours past it, `repeating-lines.ts`'s `spanOf` rule. */
export const HOURS_FROM_MINUTES = 120;
/** How much of a quoted refusal or a stderr reason a prompt keeps. */
export const MAX_QUOTED_CHARS = 200;
export const MAX_REASON_CHARS = 160;
/** The measured tick (`repeating-lines.ts`'s `MINUTES_PER_TICK`): a streak of ticks is quoted in minutes only as "about". */
export const MINUTES_PER_TICK = 2.1;
/** How many PRs or rows one prompt names before it says "and N more". */
export const MAX_NAMED = 5;
/** The child that reads every runner's version gets this long: a `git ls-remote`, about a hundred small file reads and one REST call. */
export const AGREEMENT_READ_MS = 90_000;
/** No capture on the fleet for this long, with work that needs it waiting, is the idle fleet the chairman found (#2937). */
export const FLEET_IDLE_HOURS = 24;

/**
 * How long a fleet may stay on mixed Windows builds before `ceo` is woken (the chairman's ruling on a11ign/a11ign#4405: "a mixed fleet that stays mixed for more than 4 hours wakes ceo").
 * THE LINE IS THE CONTRACT the control row files the incident with (`fleet-watch` files it on the first mismatch): an OPEN incident issue whose body carries this line on a line of its own
 * IS the stopped line, and a CLOSED one is the fleet reading one build. The constant lives in the filing row; this one copies it, and the test pins the copy.
 */
export const FLEET_BUILD_MIXED_HOURS = 4;
export const FLEET_BUILD_INCIDENT_LINE = "Incident: incident:fleet-build-mixed";
/** Where the declared copies sit, relative to the TOOL's root: its own `lib/`, each file headed by what it was copied from (#3041: this was the monorepo's `packages/agent-org/src/lib`, which in the standalone tool is `src/lib`). */
export const COPIES_DIR = "src/lib";
/** The tool's root, by its own location: `src/` is this file's directory, so the root is one up. Neither the project's layout nor a count of directories above it. */
export const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The checkout the tool serves, when the caller names none. Where it holds no `COPIES_DIR` no copy is found, and the reading says so. */
export const DEFAULT_ROOT = HOME_CHECKOUT;
export const COPY_HEADER_START = /^\/\/ COPIED FROM `([^`]+)` at /;
export const COPY_HEADER_END = "// ==== end of copy header ====";
/** What a header says it changed: `NOTHING`, `ONE LINE`, or `N NAMED LINES`. */
export const COPY_HEADER_CHANGES = /CHANGED FROM THE ORIGINAL(?:,\s*(?:(\d+) NAMED LINES?|ONE LINE)|:\s*NOTHING)/;
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
/**
 * THE MILESTONE CLOCK'S BOUND (#4231): the chairman's, not a percentile ("if the primary milestone has open rows and none is claimed or in a pull request for more
 * than 2 hours, that is an alarm to `ceo` with the row named", 2026-10-08, root cause 3).
 */
export const MILESTONE_CLOCK_MINUTES = 120;
/** The line of a milestone's description that makes it THE primary one (#4231): data `ceo` sets on the milestone, never a number this file knows. A line of its own, so a sentence that mentions it is not it. */
export const PRIMARY_MILESTONE_LINE = /^[ \t]*Primary:[ \t]*yes[ \t]*$/im;
/** The session every signal is offered to. */
export const OFFERED_TO = "ceo";
/** #3942: the first reader of rows (`.claude/rules/org-routing-and-timers.md`), who is told of a row-state signal BEFORE `ceo` is, and in the same tick. */
const FIRST_READER = "product-manager";
/** How many merged PRs the last-merge read looks at: the newest-updated, which holds every merge of the last day or two. */
export const MERGED_WINDOW = 20;

export const SIGNALS = Object.freeze({
  NO_MERGE: "no-merge-while-work-exists",
  RED_PR: "red-pr-unattended",
  REFUSED_ROW: "ready-row-refused",
  PRIMARY: "primary-not-at-main",
  FLEET_IDLE: "fleet-idle-while-work-waits",
  COPIES: "copies-drifted",
  OVERDUE: "overdue",
  REVIEW_GATED_UNASKED: "review-gated-unasked",
  STALE_WAIT: "stale-wait",
  WAIT_WITHOUT_REASON: "wait-without-reason",
  ORDER_STALLED: "order-deferred-too-long",
  POOL_LOW: "api-pool-low",
  PANE_AT_PROMPT: "pane-stopped-at-a-prompt",
  TOOL_VERSION: "runner-behind-newest-release",
  NODE_CANNOT_STRIP: "node-cannot-strip",
  TEAM_ACCESS: "team-access-drifted",
  AUTO_OFF_REFUSING: "fleet-auto-off-refusing",
  STATE_LABEL: "row-without-exactly-one-state",
  IDLE_WITH_OPEN_ROWS: "idle-with-open-rows",
  SHELVED_CIRCLE: "row-shelved-against-the-pr-that-waits-on-it",
  RELEASE_FAILED: "release-run-failed",
  FLEET_BUILD_MIXED: "fleet-build-mixed-over-4h",
  RELEASE_BEHIND_MAIN: "release-behind-main",
  BOARD_TRUTH: "board-disagrees-with-reality",
  CLASS_REPEAT: "class-repeat",
  MILESTONE_CLOCK: "primary-milestone-idle",
  CLAIM_REFUSAL_STORM: "claim-refusal-storm",
  FLAG_WITHOUT_SWITCH: "flag-without-a-switch",
  TICK_RECORD_UNWRITTEN: "tick-record-unwritten",
  TICK_WALL_HIGH: "tick-wall-high",
  QUEUE_ENTRY_NO_RUN: "queue-entry-no-run",
  QUEUE_HEAD_AGE: "queue-head-age",
  REQUIRED_RED_ON_5XX: "required-red-on-5xx",
  MANUAL_RERUNS: "manual-reruns",
  SWEEP_OVERDUE: "repository-unread-past-sweep",
});

/** Signals whose first reader is not `ceo`: the order goes to that session as well as to `ceo`, who takes every signal. */
export const FIRST_READERS = (Object.freeze({ [SIGNALS.STATE_LABEL]: FIRST_READER, [SIGNALS.BOARD_TRUTH]: FIRST_READER, [SIGNALS.SHELVED_CIRCLE]: FIRST_READER, [SIGNALS.FLAG_WITHOUT_SWITCH]: FIRST_READER, [SIGNALS.QUEUE_ENTRY_NO_RUN]: FIRST_READER, [SIGNALS.QUEUE_HEAD_AGE]: FIRST_READER, [SIGNALS.REQUIRED_RED_ON_5XX]: FIRST_READER, [SIGNALS.MANUAL_RERUNS]: FIRST_READER }) as Readonly<Record<string, string>>);

/**
 * `detail` is one line: for `unknown` it is WHY, for `tripped` the numbers. `firstTrippedAt` is epoch ms, or `null` when the signal's own source carries no time.
 */
export type Reading = { signal: string, status: "tripped" | "clear" | "unknown", detail: string, firstTrippedAt?: number | null, discriminator?: string, prompt?: string,
  /** agent-org#887: TRIPPED and raised as an incident only -- `orgHealthOrders` makes no order of it, so `ceo` is not woken by it (a first failed release, until a second follows) */
  incidentOnly?: true };

export type ToolAgreement = import("../lib/tool-version-agreement.ts").Agreement;

/** @returns the UTC hour a time falls in, `2026-10-01T07`: the discriminator's resolution */
export const hourOf = (ms: number): string => new Date(ms).toISOString().slice(0, 13);
export const isoOf = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
export const ageText = (ms: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - ms) / MS_PER_MINUTE));
  return minutes >= HOURS_FROM_MINUTES ? `${Math.round(minutes / MINUTES_PER_HOUR)} h` : `${minutes} min`;
};

/** @returns hours to one decimal place */
export const hoursOf = (minutes: number): number => Math.round((minutes / MINUTES_PER_HOUR) * 10) / 10;

export const unknown = (signal: string, why: string): Reading => ({ signal, status: "unknown", detail: why });
export const clear = (signal: string): Reading => ({ signal, status: "clear", detail: "" });

/**
 * SIGNAL 1: NOTHING HAS LANDED FOR `NO_MERGE_HOURS` WHILE SOMETHING COULD.
 *
 * "Something could" is a green, unheld PR (the gate's own `shouldBeMerging`) or a Ready row an engineer is being offered. An idle
 * org with an empty queue is finished, not stalled, so the gap alone is never a trip. THE GAP IS TESTED FIRST: a merge inside N
 * hours is clear whatever the work reading says, so a refused work read cannot turn a healthy tick into an unknown.
 *
 * `lastMergedIn` (#4047) is the repository that merge was in, named in the detail when the caller knows it.
 */
export function noMergeReading({ now, lastMergedAt, lastMergedIn = null, work }: { now: number; lastMergedAt: number | null; lastMergedIn?: string | null; work: { greenPrs: number; claimableRows: number; } | null; }): Reading {
  if (lastMergedAt === null) return unknown(SIGNALS.NO_MERGE, "the last merge could not be read, so the gap is not known");
  const tripAt = lastMergedAt + NO_MERGE_HOURS * MS_PER_HOUR;
  if (now < tripAt) return clear(SIGNALS.NO_MERGE);
  if (work === null) return unknown(SIGNALS.NO_MERGE, "no PR has merged for over the threshold, but what could merge was not read");
  if (work.greenPrs + work.claimableRows === 0) return clear(SIGNALS.NO_MERGE);
  return {
    signal: SIGNALS.NO_MERGE, status: "tripped", firstTrippedAt: tripAt, discriminator: `${SIGNALS.NO_MERGE}@${hourOf(tripAt)}`,
    detail: `${ageText(lastMergedAt, now)} since the last merge (${isoOf(lastMergedAt)}${lastMergedIn === null ? "" : ` in ${lastMergedIn}`}); ${work.greenPrs} green unheld PR(s) and `
      + `${work.claimableRows} claimable Ready row(s) exist`,
  };
}

/**
 * One open PR whose required check has settled red. `owner` is `null` when NOBODY could be named (`ownerOfPr`'s last rung). `redSince` is when the head's first failing check finished, `null` when no check carried a time. `ownerCommentAts` are the times of comments from the account that opened the PR, all of them: the leaf asks which fall after the red began.
 */
export type RedPr = { number: number | string, owner: string | null, redSince: number | null, ownerCommentAts: number[] };

/** agent-org#1538 (a11ign#5528): one open PR whose red is review-gated. `redSince` is as `RedPr`'s; `reviewerOrdered` is whether a reviewer was ordered at its head. */
export type ReviewGatedPr = { number: number | string, redSince: number | null, reviewerOrdered: boolean };
