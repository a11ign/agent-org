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
//   review-gated-unasked        120 min     a red PR whose every failing check names a review as its remedy (`Cleared-by: review`, a11ign#5528) and no reviewer was
//                                           ordered at its head: the gate has the check's answer and asked nobody. THE 2 HOURS IS THE CHAIRMAN'S (a11ign#5528: red ten hours unasked).
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
// THE CLAIM-REFUSAL STORM, agent-org#889 (a11ign/agent-org#885 class 2, the chairman, 2026-10-11):
//   claim-refusal-storm          > 10 / 15 min   more than ten claims refused inside fifteen minutes, naming the most frequent reason. THE BOUND IS THE CHAIRMAN'S,
//                                            not a percentile: 163 refusals in 66 minutes (08:09-09:15) stopped every worker start, the fixer's included.
// THE "MERGED BUT OFF" COUNT, agent-org#1135 (class `hand-reroute`, a11ign#4437):
//   flag-without-a-switch        any         a `*_FLAG` the code ships (`src/flag-switch-ledger.ts`) whose key no declaration file carries, `false` counting as decided; or, for a flag whose home is the canary state, one absent from `machinery-canary.json` more than two hours after its merge with no open `ready`/`in-progress` row naming it (agent-org#1324). Named once a day with the date
//                                            of the merge that added it, to `product-manager`, who files the a11ign switch row the chairman's rule (a11ign#928, 2026-10-12) asks for with the change.
// THE TICK RECORD, agent-org#1208 (a11ign#928: a slow tick is recorded on one standing row and wakes nobody):
//   tick-record-unwritten        any         the standing comment a slow tick edits could not be written (or the project declares no row). A DIGEST that rides the next order and is
//                                            never an order of its own to wake on; the tick retries each tick, so it clears itself. The record's own p50/p95 are on the row.
//   tick-wall-high               any         the tick wall's p95 over the last 24 h is past the limit (`tickHealthOf`, the record's own cost file): more than one tick in twenty overran, which is a trend
//                                            for `ceo`'s daily read and not an order per overrun. Its detail carries p50/p95 and `tick-overran` wakes per day (slow reads 0; killed is the one that wakes).
// THE MERGE QUEUE'S ENTRY WITH NO RUN, agent-org#1195 (a11ign#928: "the merge queue sat for 50 minutes on an entry whose CI never started"; asked only while `queue.queueEntryNoRun` is on):
//   queue-entry-no-run           any         the day's re-queues of an entry GitHub never requested checks for (the count the chairman asked for), and an INCIDENT for a repeat: no run AGAIN after its
//                                            one re-queue, which the gate does not re-queue a second time. To `product-manager`, who reads it first, and `ceo`.
//   queue-head-age               > 10 min    the position-1 entry has stood in the queue longer than the detector's limit, so a stall of that shape shows at ten minutes and not at fifty.
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
// unknown says why on stderr -- a line that repeats for a persistent refusal and is therefore offered by `repeating-lines.ts`.
//
// A LEAF, RELATIVE IMPORTS ONLY, like `repeating-lines.ts`: `work-gate.ts` imports this, and it runs before any `pnpm install`/build.
import { canStrip, describeBad, type NodeStripFact } from "./node-strips-types.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.ts";
import { isAppLogin, spenderPhraseFor } from "./gh-ledger.ts";
import { CANARY_STATE_NAME, GITHUB_ROLES, homeHostConfig, hostConfigPath, roleIdentity, stateEntryPath, type HostConfig } from "./host-config.ts";
import { AUTHOR_FALLBACK_MS } from "./gh-author-fallback.ts";
// A LEAF too (node builtins only): the append-only log of events that never become a closed row, where a refused claim is written and read back.
import { CI_RERUN_LEDGER_FILE, rerunOn5xx } from "./ci-rerun-on-5xx.ts";
import { CLAIM_GUARD_HELD_KIND, CLAIM_REFUSED_KIND, FAILURE_LEDGER_FILE, parseFailureLedger } from "./failure-ledger.ts";
// A LEAF (`claim-labels.ts` imports nothing), so the label is read from where it is declared, as `repeating-lines.ts` does.
import { READY_LABEL, STATE_LABELS, stateLabelFindings } from "./claim-labels.ts";
import { boardTruthTable } from "./board-truth-audit.ts";
// The registry of flags the code ships and the declarations that decide them (agent-org#1135); it imports only the two config leaves this file already does.
import type { FlagLedger } from "./flag-switch-ledger.ts";
import { tickHealthLine, tickRecordUnwrittenLine, tickWallIsHigh, type TickHealth, type TickRecordState } from "./work-tick-health.ts"; // a leaf (`node:*` only): the tick's own record state and the one line it says
// The checkout the tool serves and the project's own words are read from where they are declared (`standalone-roots.test.ts`, `project-vocabulary.test.ts`).
import { HOME_CHECKOUT } from "./project-config.ts";
import { ANSWER_PREFIX, BACKLOG_LABEL } from "./project-vocabulary.ts";
import { openIncidentsOf } from "./ticket-port/open-incidents.ts";
import { closeIncident, closedIncidentsOf, createIncident, jobLogOf } from "./ticket-port/release-incidents.ts";
// A LEAF too (it imports `newest-check-run.ts` and `pr-hold-state.ts`, which import nothing): the ONE decider of what counts as red.
import { brokenChecks } from "./red-pr.ts";
// A LEAF too (`node:*` only): the account pause record, read here and by `account-limit.ts` (a11ign#5497), so the canary holds the hour the gate paused.
import { ACCOUNT_LIMIT_FLAG, pauseRecorded } from "./account-limit-record.ts";
// A LEAF too: the closed grammar of what a declared wait is waiting FOR (#2996), and the two ages that bound how long one may stand unexplained.
import { MANUAL_WAIT_HOURS, PARKED_LABEL, STALE_WAIT_GRACE_MINUTES, isItemWait, namedDoneWhens, parseWaits, pastGrace } from "./wait-condition.ts";
import { holdersOf } from "./pr-hold-state.ts";
import { declaredClosedRows } from "./row-claim/file-overlap-rule.ts";
import { extractClosesDeclaration, closesReferences } from "./acceptance-commands.ts";
import { homeProjectDeclaration } from "./project-config.ts";
// A LEAF too (#3943): the pure reading of "no engineer holds a row, and which open rows are not being built, and why".
import { IDLE_REASONS, idleLine } from "./idle-with-open-rows.ts";
import { repoVerdict } from "./release-behind-main.ts";
import { CLASS_REPEAT_WINDOW_MS, FAILURE_CLASSES_PATH, CLASS_LABEL_PREFIX, groupByClass, newestOccurrence, occurrencesOf } from "./class-repeat.ts";

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

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const MS_PER_HOUR = MINUTES_PER_HOUR * MS_PER_MINUTE;
/** A span is quoted in minutes up to this many and in hours past it, `repeating-lines.ts`'s `spanOf` rule. */
const HOURS_FROM_MINUTES = 120;
/** How much of a quoted refusal or a stderr reason a prompt keeps. */
const MAX_QUOTED_CHARS = 200;
const MAX_REASON_CHARS = 160;
/** The measured tick (`repeating-lines.ts`'s `MINUTES_PER_TICK`): a streak of ticks is quoted in minutes only as "about". */
const MINUTES_PER_TICK = 2.1;
/** How many PRs or rows one prompt names before it says "and N more". */
const MAX_NAMED = 5;
/** The child that reads every runner's version gets this long: a `git ls-remote`, about a hundred small file reads and one REST call. */
const AGREEMENT_READ_MS = 90_000;
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
/**
 * THE MILESTONE CLOCK'S BOUND (#4231): the chairman's, not a percentile ("if the primary milestone has open rows and none is claimed or in a pull request for more
 * than 2 hours, that is an alarm to `ceo` with the row named", 2026-10-08, root cause 3).
 */
export const MILESTONE_CLOCK_MINUTES = 120;
/** The line of a milestone's description that makes it THE primary one (#4231): data `ceo` sets on the milestone, never a number this file knows. A line of its own, so a sentence that mentions it is not it. */
export const PRIMARY_MILESTONE_LINE = /^[ \t]*Primary:[ \t]*yes[ \t]*$/im;
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
const FIRST_READERS = (Object.freeze({ [SIGNALS.STATE_LABEL]: FIRST_READER, [SIGNALS.BOARD_TRUTH]: FIRST_READER, [SIGNALS.SHELVED_CIRCLE]: FIRST_READER, [SIGNALS.FLAG_WITHOUT_SWITCH]: FIRST_READER, [SIGNALS.QUEUE_ENTRY_NO_RUN]: FIRST_READER, [SIGNALS.QUEUE_HEAD_AGE]: FIRST_READER, [SIGNALS.REQUIRED_RED_ON_5XX]: FIRST_READER, [SIGNALS.MANUAL_RERUNS]: FIRST_READER }) as Readonly<Record<string, string>>);

/**
 * `detail` is one line: for `unknown` it is WHY, for `tripped` the numbers. `firstTrippedAt` is epoch ms, or `null` when the signal's own source carries no time.
 */
export type Reading = { signal: string, status: "tripped" | "clear" | "unknown", detail: string, firstTrippedAt?: number | null, discriminator?: string, prompt?: string,
  /** agent-org#887: TRIPPED and raised as an incident only -- `orgHealthOrders` makes no order of it, so `ceo` is not woken by it (a first failed release, until a second follows) */
  incidentOnly?: true };

export type ToolAgreement = import("./lib/tool-version-agreement.ts").Agreement;

/** @returns the UTC hour a time falls in, `2026-10-01T07`: the discriminator's resolution */
const hourOf = (ms: number): string => new Date(ms).toISOString().slice(0, 13);
const isoOf = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const ageText = (ms: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - ms) / MS_PER_MINUTE));
  return minutes >= HOURS_FROM_MINUTES ? `${Math.round(minutes / MINUTES_PER_HOUR)} h` : `${minutes} min`;
};

/** @returns hours to one decimal place */
const hoursOf = (minutes: number): number => Math.round((minutes / MINUTES_PER_HOUR) * 10) / 10;

const unknown = (signal: string, why: string): Reading => ({ signal, status: "unknown", detail: why });
const clear = (signal: string): Reading => ({ signal, status: "clear", detail: "" });

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

/** agent-org#1538: a review-gated red this long with no reviewer ordered at its head is unasked. The bound is the chairman's (2 hours, a11ign#5528). */
export const REVIEW_GATED_MINUTES = 120;

/**
 * WHEN DID THIS PULL REQUEST'S BREAKAGE BEGIN, or `null` when it has none to date (#2956). RED IS DECIDED ONCE, BY `red-pr.ts`
 * (`isBrokenRed`, #2954), and the question is asked of it here and not re-answered: `pr-checks-failing` excuses a hold only when the
 * hold is its ADDRESSEE's own (#2400), so a PR a worker owns and `ceo` holds is still ordered, and a count built from those orders
 * alone offered `ceo` its own freeze every day of it (#2883). THE HOLD'S OWN TWO JOBS ARE LEFT OUT and every other red is dated by
 * ITSELF: a held PR with a real `ts / run` failure is red since THAT check finished, not since the hold's `gate` did.
 * `options.holdStands` is `red-pr.ts`'s: whether the hold still EXCUSES (#2996), so a hold whose reason is gone dates the red it caused.
 * @returns epoch ms of the earliest broken check, `null` for none or for a broken check GitHub gave no time
 */
export function redSinceOf(pr: { labels?: any[]; statusCheckRollup?: any[]; }, options?: { holdStands?: (pr: any) => boolean; }): number | null {
  const times = brokenChecks(pr, options).map((check) => check.failedAt).filter(Number.isFinite);
  return times.length > 0 ? Math.min(...times) : null;
}

/**
 * Is this red PR UNATTENDED once `RED_PR_MINUTES` have passed?
 *
 * NO PUSH IS ASSUMED BY CONSTRUCTION, and the reason is a fact about this repo: the head is the one that went red, and a push
 * makes a new head with a new run, so a PR still red on its head has had none. THE OWNER'S COMMENT IS WHAT IS LEFT TO ASK. A PR WITH NO OWNER IS ALWAYS UNATTENDED: no
 * account is "its owner's", so a comment on it is not an owner's act and cannot excuse it (the 2026-10-01 case, #2941).
 */
function isUnattended(pr: RedPr, now: number) {
  if (pr.redSince === null || now - pr.redSince < RED_PR_MINUTES * MS_PER_MINUTE) return false;
  if (pr.owner === null) return true;
  const since = pr.redSince;
  return !pr.ownerCommentAts.some((at) => at >= since);
}

/**
 * SIGNAL 2: A RED PR NOBODY IS ON. `failingChecksOrder` woke the owner on the first red, and nothing asks whether that produced
 * a fix. `redPrs` is `null` for a refused PR read; one PR with no time makes the answer unknown unless another PR trips.
 */
export function redPrReading({ now, redPrs }: { now: number; redPrs: RedPr[] | null; }): Reading {
  if (redPrs === null) return unknown(SIGNALS.RED_PR, "the open pull requests could not be read");
  const tripped = redPrs.filter((pr) => isUnattended(pr, now)).sort((a, b) => (a.redSince as number) - (b.redSince as number));
  if (tripped.length === 0) {
    const undated = redPrs.filter((pr) => pr.redSince === null);
    return undated.length === 0 ? clear(SIGNALS.RED_PR)
      : unknown(SIGNALS.RED_PR, `${undated.length} red PR(s) carried no check time, so how long they have been red is not known`);
  }
  const first = (tripped[0].redSince as number) + RED_PR_MINUTES * MS_PER_MINUTE;
  const named = tripped.slice(0, MAX_NAMED).map((pr) => `#${pr.number} (red ${ageText((pr.redSince as number), now)}, `
    + `${pr.owner === null ? "NO OWNER" : `owner ${pr.owner}`})`);
  const more = tripped.length > MAX_NAMED ? `, and ${tripped.length - MAX_NAMED} more` : "";
  return { signal: SIGNALS.RED_PR, status: "tripped", firstTrippedAt: first, discriminator: `${SIGNALS.RED_PR}@${hourOf(first)}`,
    detail: `${tripped.length} PR(s) red over ${RED_PR_MINUTES} min with no comment from their owner since: ${named.join("; ")}${more}` };
}

/**
 * SIGNAL: A REVIEW-GATED RED PR NOBODY WAS ASKED TO CLEAR (agent-org#1538, a11ign#5528). A check that names a review as its remedy is answered by a
 * reviewer, not by its author, so a red with no reviewer ordered at its head is the gate sitting on its own answer. `prs` is `null` for a refused
 * PR read (unknown, never clear); a PR with no check time cannot be dated and makes the answer unknown unless another PR trips.
 */
export function reviewGatedUnaskedReading({ now, prs }: { now: number; prs: ReviewGatedPr[] | null; }): Reading {
  if (prs === null) return unknown(SIGNALS.REVIEW_GATED_UNASKED, "the open pull requests could not be read");
  const unasked = prs.filter((pr) => !pr.reviewerOrdered);
  const tripped = unasked.filter((pr) => pr.redSince !== null && now - pr.redSince >= REVIEW_GATED_MINUTES * MS_PER_MINUTE)
    .sort((a, b) => (a.redSince as number) - (b.redSince as number));
  if (tripped.length === 0) {
    const undated = unasked.filter((pr) => pr.redSince === null);
    return undated.length === 0 ? clear(SIGNALS.REVIEW_GATED_UNASKED)
      : unknown(SIGNALS.REVIEW_GATED_UNASKED, `${undated.length} review-gated red PR(s) carried no check time, so how long they have been red is not known`);
  }
  const first = (tripped[0].redSince as number) + REVIEW_GATED_MINUTES * MS_PER_MINUTE;
  const named = tripped.slice(0, MAX_NAMED).map((pr) => `#${pr.number} (red ${ageText(pr.redSince as number, now)}, no reviewer ordered at its head)`);
  const more = tripped.length > MAX_NAMED ? `, and ${tripped.length - MAX_NAMED} more` : "";
  return { signal: SIGNALS.REVIEW_GATED_UNASKED, status: "tripped", firstTrippedAt: first, discriminator: `${SIGNALS.REVIEW_GATED_UNASKED}@${hourOf(first)}`,
    detail: `${tripped.length} PR(s) red over ${REVIEW_GATED_MINUTES} min whose failing checks name a review as the remedy, with no reviewer ordered: ${named.join("; ")}${more}` };
}

/**
 * SIGNAL 3: A READY ROW THE CLAIM HAS REFUSED `REFUSED_TICKS` TICKS RUNNING. THE COUNTER IS #2845's, READ AND NOT RECOUNTED: it
 * is the streak `claimRefusalStreaksNow` already advanced this tick, and `product-manager` was told at 15 of them.
 *
 * KEYED ON THE ROW REFS, NOT AN HOUR, because the counter carries ticks and no time: an hour derived from `now` minus the ticks
 * drifts by a tick's jitter and would re-ask across an hour boundary. The set of refs changes only when a row enters or leaves.
 */
export function refusedRowReading({ refusals }: { refusals: Record<string, { reason: string; ticks: number; }> | null; }): Reading {
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
 */
export function primaryReading({ now, drift, since }: { now: number; drift: { behind: number; ahead: number; dirty: string[]; } | null; since: number | null; }): Reading {
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
 * What the fleet did in the last `FLEET_IDLE_HOURS`: how many captures, and when the last one finished (`null` when none is known).
 */
export type FleetCaptures = { captures24h: number, lastCaptureAt: number | null };
/**
 * What is waiting for the fleet: open `fleet-gated` rows nothing else stops, and lab jobs queued for it.
 */
export type FleetWaiting = { rows: (number | string)[], labJobs: string[] };

/**
 * SIGNAL 5: THE FLEET HAS CAPTURED NOTHING FOR `FLEET_IDLE_HOURS` WHILE SOMETHING IS WAITING FOR IT (#2937).
 *
 * AN IDLE FLEET NOBODY NEEDS IS HEALTHY, so the idleness alone is never a trip: it needs a `fleet-gated` row or a lab job to be
 * waiting. THE IDLENESS IS TESTED FIRST, as `noMergeReading` tests its gap: a capture inside the window is clear whatever the waiting
 * read says. `fleet === null` is a read that was refused or never made, and IT IS NEVER "IDLE": a fleet that could not be asked
 * says nothing about captures. A count of zero beside a last capture INSIDE the window contradicts itself, and is stated as unknown
 * rather than believed either way.
 */
export function fleetIdleReading({ now, fleet, waiting }: { now: number; fleet: FleetCaptures | null; waiting: FleetWaiting | null; }): Reading {
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
  const key = last === null ? [...waiting.rows, ...waiting.labJobs].sort().join(",") : hourOf((first as number));
  return { signal: SIGNALS.FLEET_IDLE, status: "tripped", firstTrippedAt: first, discriminator: `${SIGNALS.FLEET_IDLE}@${key}`,
    detail: `${fleet.captures24h} captures in the last ${FLEET_IDLE_HOURS} h; the last was `
      + `${last === null ? "never recorded" : `${isoOf(last)} (${ageText(last, now)} ago)`}; ${waits} thing(s) wait for the fleet: ${named}` };
}

/**
 * One open item the outcome clock runs on. `since` is when it OPENED (epoch ms): a PR's `createdAt`, a row's newest claim record. It is `null` when nothing dates it, which is an unknown and never an age. `reason` is the gate's own label for the state (`stallReasonOf` for a PR) and is DISPLAYED, never a condition; `owner` is `null` when NOBODY could be named. `boundMinutes` is the item's OWN bound, set by the reader that measured one (an idle claimed row's 80 minutes, #3569) and absent for every other item, which keeps its kind's.
 */
export type OverdueCandidate = { kind: "pr" | "row", number: number | string, reason: string, owner: string | null, since: number | null, boundMinutes?: number };

/** @returns how long an item has been open: minutes under two hours, hours to one decimal after */
const openFor = (minutes: number): string => (minutes >= HOURS_FROM_MINUTES ? `${hoursOf(minutes)} h` : `${minutes} min`);

/** @returns the minutes it may stay open before it is overdue: its own when it carries one, else its kind's */
const boundOf = (item: OverdueCandidate): number => item.boundMinutes ?? (item.kind === "pr" ? OVERDUE_PR_MINUTES : OVERDUE_ROW_MINUTES);

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
 */
export function overdueReading({ now, items, unread = [] }: { now: number; items: OverdueCandidate[] | null; unread?: string[]; }): Reading {
  if (items === null) return unknown(SIGNALS.OVERDUE, "the open pull requests could not be read");
  const crossedAt = (item: OverdueCandidate) => (item.since as number) + boundOf(item) * MS_PER_MINUTE;
  const overdue = items.filter((item) => item.since !== null && now >= crossedAt(item)).sort((a, b) => crossedAt(a) - crossedAt(b));
  if (overdue.length === 0) {
    const undated = items.filter((item) => item.since === null).length;
    const doubts = [...(undated > 0 ? [`${undated} open item(s) carried no opening time, so how long they have been open is not known`] : []),
      ...unread.map((what) => `${what} could not be read, so how long those items have been open is not known`)];
    return doubts.length === 0 ? clear(SIGNALS.OVERDUE) : unknown(SIGNALS.OVERDUE, doubts.join("; "));
  }
  const named = overdue.slice(0, MAX_NAMED).map((item) => `#${item.number} (${item.kind === "pr" ? "PR" : "row"}, ${item.reason}, open `
    + `${openFor(Math.round((now - (item.since as number)) / MS_PER_MINUTE))}, ${item.owner === null ? "NO OWNER" : `owner ${item.owner}`}`
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
 */
export function staleWaitReading({ now, stale }: {
        now: number; stale: {
            item: { kind: string; number: number; repoKey?: string; }; wait: { text: string; key: string; }; setter: string;
            resolvedAt: number | null;
        }[] | null;
    }): Reading {
  if (stale === null) return unknown(SIGNALS.STALE_WAIT, "the rows and pull requests carrying waits could not be read");
  const over = stale.filter((s) => s.resolvedAt !== null && pastGrace(s.resolvedAt, now))
    .sort((a, b) => (a.resolvedAt as number) - (b.resolvedAt as number));
  if (over.length === 0) {
    const undated = stale.filter((s) => s.resolvedAt === null);
    return undated.length === 0 ? clear(SIGNALS.STALE_WAIT)
      : unknown(SIGNALS.STALE_WAIT, `${undated.length} wait(s) have a true condition that nothing dated, so how long they have stood is not known`);
  }
  const first = (over[0].resolvedAt as number) + STALE_WAIT_GRACE_MINUTES * MS_PER_MINUTE;
  const named = over.slice(0, MAX_NAMED).map((s) => `${s.item.repoKey ?? ""}#${s.item.number} (\`Waiting-for: ${s.wait.text}\` true for `
    + `${ageText((s.resolvedAt as number), now)}, setter ${s.setter})`);
  const more = over.length > MAX_NAMED ? `, and ${over.length - MAX_NAMED} more` : "";
  const key = over.map((s) => `${s.item.repoKey ?? ""}#${s.item.number}:${s.wait.key}`).sort().join(",");
  return { signal: SIGNALS.STALE_WAIT, status: "tripped", firstTrippedAt: first, discriminator: `${SIGNALS.STALE_WAIT}@${key}`,
    detail: `${over.length} wait(s) still stand over ${STALE_WAIT_GRACE_MINUTES} min after the condition they name became true: ${named.join("; ")}${more}` };
}

/**
 * SIGNAL 9: A WAIT THAT NAMES NO REASON, QUIET FOR `MANUAL_WAIT_HOURS` (#2996). `hold:*`, `answer:*` and the blocked label do not clear themselves, so with
 * no readable `Waiting-for:` nothing can ever say they are over. THE AGE IS TIME SINCE THE ITEM'S LAST ACTIVITY (this signal's own; the outcome clock runs from the opening): an item somebody
 * is working on is not stalled, and the wait's own start is not on the list read. A wait on `manual` is not here -- it is COUNTED in the detail.
 */
export function waitWithoutReasonReading({ now, bare, manual = 0 }: { now: number; bare: { item: { kind: string; number: number; repoKey?: string; }; fields: string[]; quietSince: number | null; atOnce?: boolean; }[] | null; manual?: number; }): Reading {
  if (bare === null) return unknown(SIGNALS.WAIT_WITHOUT_REASON, "the rows and pull requests carrying waits could not be read");
  const quiet = bare.flatMap((b) => {
    const trippedAt = bareTrippedAt(b, now);
    return trippedAt === null ? [] : [{ ...b, trippedAt }];
  }).sort((a, b) => a.trippedAt - b.trippedAt);
  if (quiet.length === 0) {
    const undated = bare.filter((b) => b.quietSince === null);
    return undated.length === 0 ? clear(SIGNALS.WAIT_WITHOUT_REASON)
      : unknown(SIGNALS.WAIT_WITHOUT_REASON, `${undated.length} wait(s) with no reason carried no activity time, so how long they have stood is not known`);
  }
  const named = quiet.slice(0, MAX_NAMED).map((b) => `${b.item.repoKey ?? ""}#${b.item.number} (${b.fields.join(", ")}, ${b.atOnce ? "no reason given" : "quiet "
    + ageText((b.quietSince as number), now)})`);
  const more = quiet.length > MAX_NAMED ? `, and ${quiet.length - MAX_NAMED} more` : "";
  const key = quiet.map((b) => `${b.item.repoKey ?? ""}#${b.item.number}`).sort().join(",");
  return { signal: SIGNALS.WAIT_WITHOUT_REASON, status: "tripped", firstTrippedAt: quiet[0].trippedAt, discriminator: `${SIGNALS.WAIT_WITHOUT_REASON}@${key}`,
    detail: `${quiet.length} wait(s) name no readable condition and are either parked with no reason or have been quiet over ${MANUAL_WAIT_HOURS} h: ${named.join("; ")}${more}; `
      + `${manual} further wait(s) are \`manual\`, which is allowed and counted` };
}

/**
 * WHEN A BARE WAIT BECAME NAMEABLE, or `null` while it is not. A `parked` row with no reason is nameable at once (#4230): a park with no reason is the defect itself, so it does not wait
 * out the quiet hours a `hold:*` earns, and `now` stands in for an activity time nobody read. Every other bare wait is nameable `MANUAL_WAIT_HOURS` after the item's last activity.
 */
function bareTrippedAt({ quietSince, atOnce }: { quietSince: number | null; atOnce?: boolean; }, now: number): number | null {
  if (atOnce === true) return quietSince ?? now;
  return quietSince !== null && now - quietSince >= MANUAL_WAIT_HOURS * MS_PER_HOUR ? quietSince + MANUAL_WAIT_HOURS * MS_PER_HOUR : null;
}

/**
 * One order that has not reached a seat: `deferred` is a derived order the waker refused because its seat is mid-turn, named by its causeKey and dated by the tick that FIRST deferred it; `queue` is a standing seat's inbox, named by the seat and dated by its OLDEST authored order. `since` is epoch ms.
 */
export type StalledOrder = { kind: "deferred" | "queue", name: string, since: number };

/**
 * SIGNAL 10: AN ORDER HAS WAITED ON A BUSY SESSION FOR OVER `ORDER_STALL_MINUTES` (#3448). A deferral is not a fault -- it is what the queue is for -- and a
 * deferral that outlasts the bound is a stall nobody was told of: #3406 held a green, approved draft for forty minutes while the one session that could act
 * on it was on another row. `stalled` is `null` when the waker's record could not be read, which is a stated unknown and never a clear.
 *
 * STRICTLY OVER, as `refusalReport`'s `isOverdue` is, so the signal and the `UNDELIVERED` line it sits beside agree on the minute. Keyed on the SET of names,
 * not an hour: one order delivered or one more stalled changes it, and an unchanged set holds for the two hours the cause holds for.
 */
export function orderStallReading({ now, stalled }: { now: number; stalled: StalledOrder[] | null; }): Reading {
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
 * One pane whose visible screen is an interactive prompt: the session it belongs to, herdr's pane id, WHICH prompt it is, and the tick that FIRST saw it (`since`, epoch ms -- herdr stamps no time on a screen, so the waker keeps the first sighting).
 */
export type PromptPane = { session: string, pane: string, prompt: string, since: number };

/**
 * SIGNAL 12: A PANE HAS STOPPED AT AN INTERACTIVE PROMPT FOR OVER `PANE_PROMPT_MINUTES` (#3458). Codex's working-directory picker and a trust prompt wait for a
 * human at a terminal nobody reads, and the pane reports no failure: it is a session that never started. `panes` is `null` when herdr's panes could not be read,
 * which is a stated unknown and never a clear. A pane that reads as idle WITH NO PROMPT is not in `panes` at all, so it is never raised here.
 *
 * STRICTLY OVER, as {@link orderStallReading} is. Keyed on the set of sessions and panes, so one stuck pane is one signal however many ticks it lasts.
 */
export function panePromptReading({ now, panes }: { now: number; panes: PromptPane[] | null; }): Reading {
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
 * The refusal `fleet-auto-off.mjs` keeps in its state file. `at` is the LAST tick that refused (rewritten every ten seconds) and `since` is the FIRST tick of the unbroken run, `null` when the record carries none: a tick that proceeds, or has nothing to power off, writes `refusal: null`, which is what ends a run.
 */
export type AutoOffRefusal = { reason: string, detail: string, at: number, since: number | null };
/**
 * What the mirror said, or WHY it could not be read. `readAt` is when `fleet-watch` read the record off the control plane (epoch ms), NOT when this tick ran. `refusal: null` is a mirror that was read and records no refusal, which is not the same as `unreadable`.
 */
export type AutoOffFact = { unreadable: string } | { refusal: AutoOffRefusal | null, readAt: number };

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
 */
export function autoOffRefusalReading({ now, autoOff }: { now: number; autoOff: AutoOffFact; }): Reading {
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

const isObject = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * THE REFUSAL RECORD, from the mirror file as text: `{ readAt, record }`, `record` being the control plane's state file verbatim (`{}` when it has none). Anything
 * that is not a mirror this reading can believe is `unreadable` with the reason, never a `null` refusal: absent and malformed are different from "refused nothing".
 * @param text `null` for a file that could not be read
 * @param path only for the sentence
 */
export function parseAutoOffMirror(text: string | null, path: string): AutoOffFact {
  if (text === null) return { unreadable: `\`${path}\` could not be read, so whether fleet auto-off is refusing is not known` };
  let mirror;
  try {
    mirror = JSON.parse(text);
  } catch (err) {
    return { unreadable: `\`${path}\` is not JSON (${String((err as any)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS)})` };
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
 */
export function readAutoOffRefusal({ root = DEFAULT_ROOT, read = (path) => readFileSync(path, "utf8") }: { root?: string; read?: (path: string) => string; } = {}): AutoOffFact {
  const path = resolve(root, AUTO_OFF_MIRROR_PATH);
  return parseAutoOffMirror(readOrNull(read, path), path);
}

/**
 * MORE THAN THIS MANY CLAIM REFUSALS IN {@link CLAIM_REFUSAL_STORM_MINUTES} IS A STORM (a11ign/agent-org#885 class 2, agent-org#889, the chairman 2026-10-11): TEN, so eleven trips.
 * The case it is for: the stale-rule guard refused 163 claims between 08:09 and 09:15 on 2026-10-11 because `main` held an unreleased rule file, no worker started, and the
 * worker that would have fixed it was one of the refused. Nothing raised, because each refusal was an answer to one claim and the sum of them was nobody's reading.
 */
export const CLAIM_REFUSAL_STORM_REFUSALS = 10;
/** The window those refusals are counted in. */
export const CLAIM_REFUSAL_STORM_MINUTES = 15;

// #972: the kind is declared in the ledger's leaf, where the recorder reads it; re-exported here for the reader's callers.
export { CLAIM_REFUSED_KIND };

/** One refused claim, as the failure ledger holds it: when, and the claim's own words for why (a line, never a path through a stack). */
export type ClaimRefusal = { at: number; reason: string };

const squashed = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * SIGNAL 26: CLAIMS ARE BEING REFUSED IN A STORM -- MORE THAN `CLAIM_REFUSAL_STORM_REFUSALS` REFUSALS IN THE LAST `CLAIM_REFUSAL_STORM_MINUTES`. It names the MOST FREQUENT REASON and
 * how many of the window's refusals gave it, because "claims are refused" with no cause is the line the org read for an hour on 2026-10-11 and could not act on. A tie is
 * broken by the reason's own text, so the same ledger names the same reason every tick.
 *
 * COUNTED, NOT DE-DUPLICATED: ten refusals of ten rows and ten refusals of one row are both ten claims the org could not make, which is what blocks work. A refusal exactly
 * `CLAIM_REFUSAL_STORM_MINUTES` old is inside the window, and one dated after `now` (a clock a little ahead) is counted, never dropped.
 *
 * `refusals` is `null` for a ledger that could not be read, a stated unknown and never "no storm". Keyed on the commonest reason, so one storm is one order however many ticks
 * it lasts and a storm that changes its cause is a second.
 */
export function claimRefusalStormReading({ now, refusals }: { now: number; refusals: ClaimRefusal[] | null; }): Reading {
  const signal = SIGNALS.CLAIM_REFUSAL_STORM;
  if (refusals === null) return unknown(signal, "the failure ledger could not be read, so whether claims are being refused in a storm is not known");
  const window = CLAIM_REFUSAL_STORM_MINUTES * MS_PER_MINUTE;
  const recent = refusals.filter((refusal) => now - refusal.at <= window).sort((a, b) => a.at - b.at);
  if (recent.length <= CLAIM_REFUSAL_STORM_REFUSALS) return clear(signal);
  const counts = new Map<string, number>();
  for (const { reason } of recent) counts.set(squashed(reason), (counts.get(squashed(reason)) ?? 0) + 1);
  const [reason, count] = [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0];
  const shown = reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}...` : reason;
  return { signal, status: "tripped", firstTrippedAt: recent[CLAIM_REFUSAL_STORM_REFUSALS].at,
    discriminator: `${signal}@${createHash("sha256").update(reason).digest("hex").slice(0, 8)}`,
    detail: `${recent.length} claims were refused in the last ${CLAIM_REFUSAL_STORM_MINUTES} min (more than ${CLAIM_REFUSAL_STORM_REFUSALS}); the most frequent reason, ${count} of them: ${JSON.stringify(shown)}` };
}

/**
 * THE FACT FOR `claimRefusalStormReading`: the failure ledger's `claim-refused` lines and its `claim-guard-held` lines (agent-org#1262: the guard working still counts as a refusal here). A ledger that is not there is `[]`, because nothing has written one, which is what a
 * host that has refused no claim holds; one that cannot be read, or holds a line that does not parse (`parseFailureLedger` throws, an event read wrong is a storm drawn
 * wrong), is `null`. NEVER THROWS.
 */
export function readClaimRefusals({ path, read = (file) => readFileSync(file, "utf8") }: { path?: string; read?: (path: string) => string; } = {}): ClaimRefusal[] | null {
  try {
    const file = path ?? stateEntryPath(FAILURE_LEDGER_FILE);
    let text: string;
    try {
      text = read(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
      throw err;
    }
    return parseFailureLedger(text, file).filter((entry) => entry.classKey === CLAIM_REFUSED_KIND || entry.classKey === CLAIM_GUARD_HELD_KIND).map(({ at, ref }) => ({ at, reason: ref }));
  } catch {
    return null;
  }
}

/**
 * One API budget as a real call's answer gave it (`poolFromHeaders`, or a `rateLimit` field in a query the gate was sending anyway), NEVER `/rate_limit`, which has reported a full pool during a total outage (#1967). `account` is the login the call ran as, `null` when the answer did not name one.
 */
export type PoolReading = { account: string | null, resource: string, remaining: number, limit: number, resetAt: string | null };

/**
 * SIGNAL: A FLAG THE CODE SHIPS OFF AND NOBODY SET (agent-org#1135). `ledger` is `readFlagLedger`'s answer: `null` is a refused read and `{ unknown }` a read that named why it could not be
 * made, both unknown and never clear (a declaration that did not parse is not a declaration that holds nothing). A flag decided as `false` is not counted, and an absent one is.
 * It trips THE TICK ONE IS UNSET, with no grace: the violation is that the switch row was not filed with the change, and a grace period is the delay the rule exists to end.
 * KEYED ON THE DAY AND THE SET, so each unset flag is named once a day (a standing set is one order a day, and a newly shipped flag is a new order the day it ships) and a day's
 * order is not re-opened by a tick. The detail IS the list: key, the constant that holds it, the merge that added it, and the pull request, so no one searches for which change.
 */
export function flagSwitchReading({ day, ledger }: { day: string; ledger: FlagLedger | null; }): Reading {
  const signal = SIGNALS.FLAG_WITHOUT_SWITCH;
  if (ledger === null) return unknown(signal, "the flags the code ships could not be read against the declarations");
  if ("unknown" in ledger) return unknown(signal, ledger.unknown);
  const absent = ledger.canaryAbsent ?? [];
  if (ledger.unset.length === 0 && absent.length === 0) return clear(signal);
  const line = (flag: { key: string; name: string; file: string; mergedAt: string | null; pr: number | null; }) => `- \`${flag.key}\` (${flag.name} in ${flag.file}), merged ${flag.mergedAt === null ? "on a date git did not give" : flag.mergedAt.slice(0, 10)}${flag.pr === null ? "" : ` in #${flag.pr}`}`;
  const parts: string[] = [];
  if (ledger.unset.length > 0) parts.push(`${ledger.unset.length} of ${ledger.shipped} flags the code ships ${ledger.unset.length === 1 ? "is" : "are"} OFF because no declaration sets ${ledger.unset.length === 1 ? "it" : "them"}:\n${ledger.unset.map(line).join("\n")}`);
  // agent-org#1324: a flag whose home is the canary state and that the state does not carry two hours after its merge, with no owed row naming it
  if (absent.length > 0) parts.push(`${absent.length} ${absent.length === 1 ? "flag is" : "flags are"} merged and ABSENT from ${CANARY_STATE_FILE} for over two hours, with no open \`ready\` or \`in-progress\` row naming ${absent.length === 1 ? "it" : "them"}:\n${absent.map(line).join("\n")}`);
  return { signal, status: "tripped", firstTrippedAt: null,
    discriminator: `${signal}@${day}:${[...ledger.unset, ...absent].map((flag) => flag.key).sort().join(",")}`,
    detail: parts.join("\n") };
}

/**
 * SIGNAL: THE TICK RECORD IS UNWRITTEN (agent-org#1208). A slow tick wakes nobody and is recorded on one standing row; this is the line that says when it could not be
 * (a refused write, or no row declared), so a record that stopped is seen and the fallback is never a wake per overrun. `state` is the tick's own record state file, read by the
 * gate; an unreadable file is already `unwritten` there, so there is no unknown of this reading's own. Keyed on the day the write first failed, so one outage is one line.
 */
export function tickRecordReading({ now, state }: { now: number; state: TickRecordState; }): Reading {
  const signal = SIGNALS.TICK_RECORD_UNWRITTEN;
  const line = tickRecordUnwrittenLine(state, now);
  if (line === null || state.unwritten === null) return clear(signal);
  return { signal, status: "tripped", firstTrippedAt: state.unwritten.since, discriminator: `${signal}@${isoOf(state.unwritten.since).slice(0, 10)}`, detail: line };
}

/**
 * SIGNAL: THE TICK WALL'S p95 IS PAST THE LIMIT (agent-org#1208, done-when 5). The chairman's two health signals, tick wall p50/p95 and `tick-overran` wakes per day, are read from the
 * record's own cost file (`tickHealthOf`) and printed on this reading's `detail` whether it trips or not; it TRIPS when the p95 is over the limit, i.e. more than one tick in twenty
 * overran. A window with no tick is clear (the cost file's own failure is said by the tick). Keyed on the day, so it is one line a day and never an order per overrun.
 */
export function tickWallReading({ day, health }: { day: string; health: TickHealth | null; }): Reading {
  const signal = SIGNALS.TICK_WALL_HIGH;
  if (health === null || health.ticks === 0) return clear(signal);
  const detail = tickHealthLine(health);
  if (!tickWallIsHigh(health)) return { signal, status: "clear", detail };
  return { signal, status: "tripped", firstTrippedAt: null, discriminator: `${signal}@${day}`, detail };
}

/** What the merge-queue detector counted: the day's re-queues, and each entry that stood with no run AGAIN after its one re-queue (`why` says what that re-queue came to). */
export type QueueNoRunFact = { today: number; repeats: { pull: number; sha: string; minutes: number; why: string }[] };

/**
 * SIGNAL: A MERGE-QUEUE ENTRY WHOSE CHECKS NEVER STARTED (agent-org#1195). It COUNTS the day's re-queues, which is the chairman's "so we know how often GitHub drops the event", and it names an INCIDENT
 * for a repeat: an entry with no run AGAIN after its one re-queue, which the gate does not re-queue a second time. Keyed on the day, the count and the repeats, so a new occurrence is a new order
 * and a standing one is not. It is a DIGEST class: `product-manager` reads it first and at once, `ceo` in the digest, and a queue that stays stuck also trips `no-merge-while-work-exists`.
 */
export function queueEntryNoRunReading({ day, fact }: { day: string; fact: QueueNoRunFact; }): Reading {
  const signal = SIGNALS.QUEUE_ENTRY_NO_RUN;
  if (fact.today === 0 && fact.repeats.length === 0) return clear(signal);
  const lines = fact.repeats.map((repeat) => `INCIDENT: #${repeat.pull} has stood AWAITING_CHECKS ${repeat.minutes} minutes with no run on ${repeat.sha.slice(0, 12)} AGAIN after its one re-queue (${repeat.why}); the gate does not re-queue it a second time`);
  return { signal, status: "tripped", firstTrippedAt: null,
    discriminator: `${signal}@${day}:${fact.today}:${fact.repeats.map((repeat) => repeat.pull).sort((a, b) => a - b).join(",")}`,
    detail: [`${fact.today} merge-queue entr${fact.today === 1 ? "y was" : "ies were"} re-queued today because no run of its group ever started`, ...lines].join("\n") };
}

/** One line of the `checks rerun on 5xx` ledger the tick writes (agent-org#1217): when, which run, and the repository it was in. */
export type RerunOn5xx = { at: number; runId: number; repo: string };

const RERUN_LEDGER_LINE = /^(\d+)\tchecks rerun on 5xx: (\S+) run (\d+) head \S+: /;

/**
 * THE FACT FOR `requiredRedOn5xxReading`: the tick's `checks rerun on 5xx` ledger, beside the delivery ledger. A ledger that is not there is `[]` (the tick has rerun nothing, which is the
 * ordinary case while `ci.rerunOn5xx` is off); one that cannot be read, or holds a line that is not `<epochMs>\tchecks rerun on 5xx: <repo> run <id> head <sha>: <why>`, is `null`: a line read
 * wrong is a count drawn wrong, and a stated unknown is never zero. NEVER THROWS.
 */
export function readRerunsOn5xx({ path, read = (file) => readFileSync(file, "utf8") }: { path?: string; read?: (path: string) => string; } = {}): RerunOn5xx[] | null {
  try {
    const file = path ?? stateEntryPath(CI_RERUN_LEDGER_FILE);
    let text: string;
    try {
      text = read(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
      throw err;
    }
    const entries: RerunOn5xx[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const match = RERUN_LEDGER_LINE.exec(line);
      if (match === null) return null;
      entries.push({ at: Number(match[1]), repo: match[2], runId: Number(match[3]) });
    }
    return entries;
  } catch {
    return null;
  }
}

/** The run ids of the ledger's reruns, per UTC day (`YYYY-MM-DD`), oldest id first. A day with none is not a key: ask {@link requiredRedOn5xxReading} for today's zero. */
export function rerunsPerDay(reruns: RerunOn5xx[]): Map<string, number[]> {
  const days = new Map<string, number[]>();
  for (const { at, runId } of reruns) {
    const day = isoOf(at).slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), runId].sort((a, b) => a - b));
  }
  return days;
}

/**
 * SIGNAL: REQUIRED CHECKS RERUN ON A GITHUB 5xx (agent-org#1218, chairman a11ign#928): HOW OFTEN GITHUB BROKE A REQUIRED CHECK AND THE TICK ANSWERED IT WITH A RERUN, so the cost of the
 * rerun is measured. Counted from the ledger line the tick writes, per UTC day, with the run ids. A day with no rerun is a COUNT OF ZERO printed in the detail and `clear`, never an absent
 * reading; the count trips as a digest (`product-manager` first), keyed on the day and the ids, so a new rerun is a new order and a standing day is not. `reruns` is `null` for a ledger
 * that could not be read: unknown, never zero.
 */
export function requiredRedOn5xxReading({ now, reruns }: { now: number; reruns: RerunOn5xx[] | null; }): Reading {
  const signal = SIGNALS.REQUIRED_RED_ON_5XX;
  if (reruns === null) return unknown(signal, "the `checks rerun on 5xx` ledger could not be read, so how often a required check was rerun on a 5xx is not known");
  const day = isoOf(now).slice(0, 10);
  const ids = rerunsPerDay(reruns).get(day) ?? [];
  const detail = `${ids.length} required check${ids.length === 1 ? " was" : "s were"} rerun on a GitHub 5xx on ${day}${ids.length === 0 ? "" : `: run ${ids.join(", run ")}`}`;
  if (ids.length === 0) return { signal, status: "clear", detail };
  return { signal, status: "tripped", firstTrippedAt: null, discriminator: `${signal}@${day}:${ids.join(",")}`, detail };
}

/**
 * One rerun made at attempt 2 or later, as a reader of the code host saw it: the run, when, the log's own text (`lastErrorLine` reads it), and whether a person asked for it. `byPerson`
 * is the caller's to decide from the run's triggering actor, because this file holds no tracker call (the call baseline).
 */
export type RerunSeen = { runId: number; at: number; log: string; byPerson: boolean };

/**
 * SIGNAL: A PERSON RERAN A RUN WHOSE LAST ERROR WAS A GITHUB 5xx (agent-org#1218): THE DETECTOR'S MISSES MADE VISIBLE. The decider (`rerunOn5xx`) answers `rerun` for such a log with no prior
 * rerun on the head, so a person doing it by hand is a case the tick did not answer (the switch was off, the tick was down, or the detector read the log differently). The decider is
 * ASKED, not re-implemented, so the two agree on what a 5xx is. A run in the tick's own ledger is not a miss, whoever the code host says triggered it. Per UTC day, with the run ids, a day with none
 * `clear` with a zero. `seen` is `null` for a read that was refused, and `ledger` `null` for an unreadable ledger: each unknown, because a ledger that cannot be read cannot excuse a rerun.
 */
export function manualRerunsReading({ now, seen, ledger }: { now: number; seen: RerunSeen[] | null; ledger: RerunOn5xx[] | null; }): Reading {
  const signal = SIGNALS.MANUAL_RERUNS;
  if (seen === null) return unknown(signal, "the reruns on the code host could not be read, so how often a person reran a 5xx by hand is not known");
  if (ledger === null) return unknown(signal, "the `checks rerun on 5xx` ledger could not be read, so a person's rerun cannot be told from the tick's");
  const day = isoOf(now).slice(0, 10);
  const tick = new Set(ledger.map((entry) => entry.runId));
  const ids = seen
    .filter((rerun) => rerun.byPerson && isoOf(rerun.at).slice(0, 10) === day && !tick.has(rerun.runId))
    .filter((rerun) => rerunOn5xx({ log: rerun.log, conclusion: "failure", rerunsOnThisHead: false }).action === "rerun")
    .map((rerun) => rerun.runId).sort((a, b) => a - b);
  const detail = `${ids.length} run${ids.length === 1 ? "" : "s"} whose last error was a GitHub 5xx ${ids.length === 1 ? "was" : "were"} rerun by a person on ${day}${ids.length === 0 ? "" : `: run ${ids.join(", run ")}`}`;
  if (ids.length === 0) return { signal, status: "clear", detail };
  return { signal, status: "tripped", firstTrippedAt: null, discriminator: `${signal}@${day}:${ids.join(",")}`, detail };
}

/**
 * SIGNAL: THE POSITION-1 ENTRY HAS STOOD IN THE MERGE QUEUE TOO LONG (agent-org#1195). `head` is `null` for an empty queue, which is clear; `runs` is the count of `merge_group` runs on its head commit,
 * `null` when that was not read, and is said in the detail so the reader sees at once whether the checks started. Keyed on the day and the pull request, so a stall is ONE order, not one per tick.
 * @param limit the age past which it trips: the detector's own, so the two agree on what "too long" is
 */
export function queueHeadAgeReading({ day, head, limit }: { day: string; head: { pull: number | null; minutes: number; state: string; runs: number | null } | null; limit: number; }): Reading {
  const signal = SIGNALS.QUEUE_HEAD_AGE;
  if (head === null || head.minutes <= limit) return clear(signal);
  const runs = head.runs === null ? "its runs were not read" : head.runs === 0 ? "no run exists on its group" : `${head.runs} run${head.runs === 1 ? "" : "s"} on its group`;
  return { signal, status: "tripped", firstTrippedAt: null, discriminator: `${signal}@${day}:#${head.pull ?? "unknown"}`,
    detail: `the merge queue's position-1 entry (${head.pull === null ? "no pull request named" : `#${head.pull}`}) has stood ${head.minutes} minutes, past ${limit}, in ${head.state}; ${runs}` };
}

/**
 * agent-org#1168 (a11ign#928, "fix the class, not the three PRs"): THE THREE READINGS BEHIND `health.approvedDirty`, SHIPPED OFF. Each is a pure function of facts the caller read once, and
 * `orgHealthReadings` asks for them only when the switch is decided on, so OFF is NO reading and not a clear one.
 *
 * THE CLASSES ARE NOT IN `SIGNALS`: `work-gate/org-health-suppression.ts` declares every class an order can carry and its test pins `SIGNALS` to that table, a file outside this row's Region.
 * They are registered there in their own row before the switch is set. Until then an order of these classes falls to that table's default, which pages.
 */
export const APPROVED_DIRTY_FLAG = "health.approvedDirty";
/** How long an approved pull request may stay DIRTY with no push to its head before it is a finding (the row's figure). */
export const APPROVED_DIRTY_MINUTES = 30;
/** How many `hold:` labels one pull request may carry at once before the reading names it (a judgment; the chairman's figure is not in the row). */
export const HOLDS_PER_PR = 3;
export const APPROVED_DIRTY_SIGNAL = "approved-pr-dirty";
export const HOLDS_PER_PR_SIGNAL = "holds-per-pr";
export const SAME_WAY_RERUN_SIGNAL = "rerun-failed-the-same-way";

/**
 * One open pull request as the approved-DIRTY reading needs it. `dirtySince` is when the caller FIRST SAW it DIRTY, kept across ticks by the caller, because GitHub gives no time for a merge state;
 * `null` when no tick has seen it DIRTY. `headPushedAt` is the push time of its head commit, `null` when that is not known.
 */
export type DirtyPr = { number: number | string, approved: boolean, mergeStateStatus: string, dirtySince: number | null, headPushedAt: number | null };
/** `holds` is the count of `hold:` labels on one open pull request now. */
export type HoldCount = { number: number | string, holds: number };
/** `attempts` is the failing job names of each run on one head, oldest first; an empty list is a run that passed. */
export type RerunPr = { number: number | string, attempts: string[][] };
/** What `orgHealthReadings` is given for the three readings: `enabled` is the switch's decision, and each list is `null` for a refused read. */
export type ApprovedDirtyFacts = { enabled: boolean, prs: DirtyPr[] | null, holds: HoldCount[] | null, reruns: RerunPr[] | null };

const DIRTY_WINDOW_MS = APPROVED_DIRTY_MINUTES * MS_PER_MINUTE;

/**
 * An approved pull request that has been DIRTY for MORE than the window, with no push to its head inside that window: a push inside it is a rebase in progress, and the reading waits for it.
 */
function isApprovedDirty(pr: DirtyPr): boolean {
  return pr.approved && pr.mergeStateStatus === "DIRTY";
}
/** Past the window, but whether its head was pushed inside it is not known: an unread push time is not a push-free head, so it is unknown and never a finding. */
function pushUnknown(pr: DirtyPr, now: number): boolean {
  return isApprovedDirty(pr) && pr.dirtySince !== null && now - pr.dirtySince > DIRTY_WINDOW_MS && pr.headPushedAt === null;
}
function dirtyFinding(pr: DirtyPr, now: number): boolean {
  if (!isApprovedDirty(pr) || pr.dirtySince === null || now - pr.dirtySince <= DIRTY_WINDOW_MS) return false;
  return pr.headPushedAt !== null && pr.headPushedAt <= now - DIRTY_WINDOW_MS;
}

/** SIGNAL A: AN APPROVED PULL REQUEST IS DIRTY AND NOBODY IS REBASING IT. `org-health` never read the merge state, so #1130 and #1131 sat approved and DIRTY behind a red PR and no signal named them. */
export function approvedDirtyReading({ now, prs }: { now: number; prs: DirtyPr[] | null; }): Reading {
  const signal = APPROVED_DIRTY_SIGNAL;
  if (prs === null) return unknown(signal, "the open pull requests could not be read");
  const tripped = prs.filter((pr) => dirtyFinding(pr, now)).sort((a, b) => (a.dirtySince as number) - (b.dirtySince as number));
  if (tripped.length === 0) {
    const undated = prs.filter((pr) => isApprovedDirty(pr) && pr.dirtySince === null);
    if (undated.length > 0) return unknown(signal, `${undated.length} approved PR(s) are DIRTY and no tick has seen when they went DIRTY, so how long they have been DIRTY is not known`);
    const unpushed = prs.filter((pr) => pushUnknown(pr, now));
    return unpushed.length === 0 ? clear(signal) : unknown(signal, `${unpushed.length} approved PR(s) have been DIRTY over ${APPROVED_DIRTY_MINUTES} min and their head push time is not known, so whether they were pushed inside the window is not known`);
  }
  const first = (tripped[0].dirtySince as number) + DIRTY_WINDOW_MS;
  const named = tripped.slice(0, MAX_NAMED).map((pr) => `#${pr.number} (DIRTY ${ageText(pr.dirtySince as number, now)})`);
  const more = tripped.length > MAX_NAMED ? `, and ${tripped.length - MAX_NAMED} more` : "";
  return { signal, status: "tripped", firstTrippedAt: first, discriminator: `${signal}@${hourOf(first)}`,
    detail: `${tripped.length} approved PR(s) DIRTY over ${APPROVED_DIRTY_MINUTES} min with no push to their head since: ${named.join("; ")}${more}` };
}

/** SIGNAL B: A PULL REQUEST CARRYING `HOLDS_PER_PR` OR MORE HOLDS AT ONCE. Each hold is someone's stop on it, and a pile of them is a PR nobody is moving. */
export function holdsPerPrReading({ holds }: { holds: HoldCount[] | null; }): Reading {
  const signal = HOLDS_PER_PR_SIGNAL;
  if (holds === null) return unknown(signal, "the pull requests' hold labels could not be read");
  const tripped = holds.filter((pr) => pr.holds >= HOLDS_PER_PR);
  if (tripped.length === 0) return clear(signal);
  const named = tripped.slice(0, MAX_NAMED).map((pr) => `#${pr.number} (${pr.holds} holds)`);
  const more = tripped.length > MAX_NAMED ? `, and ${tripped.length - MAX_NAMED} more` : "";
  return { signal, status: "tripped", firstTrippedAt: null, discriminator: `${signal}:${tripped.map((pr) => pr.number).sort().join(",")}`,
    detail: `${tripped.length} PR(s) carry ${HOLDS_PER_PR} or more holds at once: ${named.join("; ")}${more}` };
}

/** SIGNAL C: THE LAST TWO RUNS ON A HEAD FAILED THE SAME JOBS. A rerun that fails the way the last one did is the code's failure, not a flake, so another rerun answers nothing. */
export function sameWayRerunReading({ reruns }: { reruns: RerunPr[] | null; }): Reading {
  const signal = SAME_WAY_RERUN_SIGNAL;
  if (reruns === null) return unknown(signal, "the runs on the pull requests' heads could not be read");
  const jobsKey = (jobs: string[]) => [...jobs].sort().join("\n");
  const tripped = reruns.flatMap((pr) => {
    const last = pr.attempts.slice(-2);
    return last.length === 2 && last[0].length > 0 && jobsKey(last[0]) === jobsKey(last[1]) ? [{ pr, jobs: [...last[1]].sort() }] : [];
  });
  if (tripped.length === 0) return clear(signal);
  const named = tripped.slice(0, MAX_NAMED).map(({ pr, jobs }) => `#${pr.number} (${jobs.join(", ")})`);
  const more = tripped.length > MAX_NAMED ? `, and ${tripped.length - MAX_NAMED} more` : "";
  return { signal, status: "tripped", firstTrippedAt: null, discriminator: `${signal}:${tripped.map(({ pr }) => pr.number).sort().join(",")}`,
    detail: `${tripped.length} PR(s) whose last two runs on the head failed the same jobs: ${named.join("; ")}${more}` };
}

/** The three readings when the switch is decided on; NONE when it is OFF or undecided here, which is what makes the shipped-OFF change a no-op. */
export function approvedDirtyReadings({ now, enabled, prs, holds, reruns }: ApprovedDirtyFacts & { now: number; }): Reading[] {
  if (!enabled) return [];
  return [approvedDirtyReading({ now, prs }), holdsPerPrReading({ holds }), sameWayRerunReading({ reruns })];
}

/**
 * agent-org#1248 (a11ign#928, the chairman's direction of 2026-10-12): AN APPROVED PULL REQUEST HELD AT `REVIEW_REQUIRED` IS A HEALTH FINDING. The reviewer switchover left approvals that did
 * not count toward `main`'s merge rule (a11ign#5303, #5302, agent-org#1241 and control#75 sat approved for 90 minutes), and no reading named them. SHIPPED OFF, like the approved-DIRTY readings:
 * OFF is NO reading, and the live gate does not pass the flag yet.
 *
 * THE CLASS IS NOT IN `SIGNALS`, for the reason `APPROVED_DIRTY_FLAG` gives: an order of an unregistered class falls to the suppression table's default, which pages.
 */
export const APPROVED_REQUIRED_FLAG = "health.approvedRequired";
/** How long an approved pull request may stay held at `REVIEW_REQUIRED` before it is a finding (the row's figure). */
export const APPROVED_REQUIRED_MINUTES = 10;
export const APPROVED_REQUIRED_SIGNAL = "approved-pr-review-required";

/**
 * One open pull request as the approved-REVIEW_REQUIRED reading needs it. `approvers` are the identities whose APPROVED review is on `head`, and `reviewDecision` is GitHub's, as read.
 * `heldSince` is when a tick FIRST SAW it approved and `REVIEW_REQUIRED`, kept across ticks by the caller, and `heldHead` is the head that stamp was taken on. A stamp taken on an older head
 * is not this head's age: a new head restarts the clock, so it clears the finding and is not a finding until it has been held on that head. `null` is a stamp no tick has taken.
 */
export type ApprovedRequiredPr = { number: number | string, open: boolean, reviewDecision: string | null, head: string, approvers: string[], heldHead: string | null, heldSince: number | null };
/** What `orgHealthReadings` is given for the reading: `enabled` is `health.approvedRequired`'s decision, and `prs` is `null` for a refused read. */
export type ApprovedRequiredFacts = { enabled: boolean, prs: ApprovedRequiredPr[] | null };

const APPROVED_REQUIRED_WINDOW_MS = APPROVED_REQUIRED_MINUTES * MS_PER_MINUTE;

/** Approved on its head and held at `REVIEW_REQUIRED`: the state that is a finding once it has stood past the window. A closed or merged pull request is not held. */
function isApprovedRequired(pr: ApprovedRequiredPr): boolean {
  return pr.open && pr.reviewDecision === "REVIEW_REQUIRED" && pr.approvers.length > 0;
}
function heldFinding(pr: ApprovedRequiredPr, now: number): boolean {
  return isApprovedRequired(pr) && pr.heldSince !== null && pr.heldHead === pr.head && now - pr.heldSince > APPROVED_REQUIRED_WINDOW_MS;
}

/** SIGNAL D: AN APPROVED PULL REQUEST IS HELD AT `REVIEW_REQUIRED` PAST THE WINDOW. The approval is on the head and is not counting, which is a permission or a rule excluding the approver, not a red check. */
export function approvedRequiredReading({ now, prs }: { now: number; prs: ApprovedRequiredPr[] | null; }): Reading {
  const signal = APPROVED_REQUIRED_SIGNAL;
  if (prs === null) return unknown(signal, "the open pull requests' review decisions could not be read");
  const tripped = prs.filter((pr) => heldFinding(pr, now)).sort((a, b) => (a.heldSince as number) - (b.heldSince as number));
  if (tripped.length === 0) {
    const undated = prs.filter((pr) => isApprovedRequired(pr) && pr.heldSince === null);
    return undated.length === 0 ? clear(signal) : unknown(signal, `${undated.length} approved PR(s) are held at REVIEW_REQUIRED and no tick has seen when they started to be held, so how long they have been held is not known`);
  }
  const first = (tripped[0].heldSince as number) + APPROVED_REQUIRED_WINDOW_MS;
  const named = tripped.slice(0, MAX_NAMED).map((pr) => `#${pr.number} (approved by ${pr.approvers.join(", ")}, held ${ageText(pr.heldSince as number, now)})`);
  const more = tripped.length > MAX_NAMED ? `, and ${tripped.length - MAX_NAMED} more` : "";
  return { signal, status: "tripped", firstTrippedAt: first, discriminator: `${signal}@${hourOf(first)}`,
    detail: `${tripped.length} approved PR(s) held at REVIEW_REQUIRED over ${APPROVED_REQUIRED_MINUTES} min with an approval on their head that does not count toward the merge rule: ${named.join("; ")}${more}` };
}

/** The reading when the switch is decided on; NONE when it is OFF, which is what makes the shipped-OFF change a no-op. */
export function approvedRequiredReadings({ now, enabled, prs }: ApprovedRequiredFacts & { now: number; }): Reading[] {
  if (!enabled) return [];
  return [approvedRequiredReading({ now, prs })];
}

/** agent-org#1667: `enabled` is `reviews.outsideSessionPr`'s decision; `prs` names each same-repository pull request with a `session:` label that is classed OUTSIDE, and `since` is when the canary first saw it so (`now` while the canary keeps no clock yet). `null` is a refused read. */
export type SessionPrOutsideFact = { enabled: boolean, prs: { number: number; author: string; session: string; since: number; }[] | null };

/** agent-org#1667, THE NAMED READING OF `session-pr-classed-outside`: a pull request classed OUTSIDE for `SESSION_PR_OUTSIDE_MINUTES` trips, named by author and session, so `ceo` reads whose it is. */
export function sessionPrOutsideReading({ now, prs }: { now: number; prs: SessionPrOutsideFact["prs"]; }): Reading {
  const signal = MACHINERY_SIGNALS.SESSION_PR_CLASSED_OUTSIDE;
  if (prs === null) return unknown(signal, "the open pull requests could not be read, so the ones classed OUTSIDE are not known");
  const window = SESSION_PR_OUTSIDE_MINUTES * MS_PER_MINUTE;
  const tripped = prs.filter((pr) => now - pr.since >= window).sort((a, b) => a.since - b.since);
  if (tripped.length === 0) return clear(signal);
  const first = tripped[0].since + window;
  const named = tripped.slice(0, MAX_NAMED).map((pr) => `#${pr.number} by ${pr.author} as ${pr.session}, ${Math.floor((now - pr.since) / MS_PER_MINUTE)} min`);
  const more = tripped.length > MAX_NAMED ? `, and ${tripped.length - MAX_NAMED} more` : "";
  return { signal, status: "tripped", firstTrippedAt: first, discriminator: `${signal}@${hourOf(first)}`,
    detail: `${tripped.length} same-repository PR(s) with a session: label classed OUTSIDE for ${SESSION_PR_OUTSIDE_MINUTES} min or more: ${named.join("; ")}${more}` };
}

/** The reading when `reviews.outsideSessionPr` is ON; NONE when it is OFF, so the shipped-OFF change adds no order to any tick. */
export function sessionPrOutsideReadings({ now, enabled, prs }: SessionPrOutsideFact & { now: number; }): Reading[] {
  if (!enabled) return [];
  return [sessionPrOutsideReading({ now, prs })];
}

/**
 * SIGNAL 11: A POOL IS BELOW `POOL_LOW_FRACTION` OF ITS LIMIT (#3448). A session that meets an exhausted pool sleeps on the reset, and three standing seats did at
 * once on 2026-10-04 with nothing in the org knowing why its inbox was three orders deep. The reading names the account, the pool and the reset, because "low"
 * with no window is not a measurement. `pools` is `null` when no pool was read this tick.
 *
 * A POOL AT EXACTLY THE FRACTION IS NOT RAISED (at or above clears), and a limit of 0 is unread and never a divide. Keyed on the account, the pool and the
 * reset time, so one spent window is one signal however many ticks it lasts and the next window starts a new one.
 *
 * (#4148) A LOW POOL NAMES ITS SPENDER: for a GRAPHQL pool the detail adds who spent that account's last hour, off the `host/gh` ledger beside the config this tick ran under
 * (`spenderOf`; the default reads it). "Low" with no name is a signal nobody can act on, and the first reading of the burner took a hand-run awk. Only the DETAIL carries it:
 * the discriminator is unchanged, so one spent window is still one signal. A ledger that cannot be read leaves the detail as it was and says so, never a guess.
 *
 * (agent-org#1420) THE SENTENCE STATES THE POOL'S OWN USED POINTS (`limit - remaining`) beside the ledger's total and the share of them the ledger accounts for, and says so when
 * that is under 90%. `poolLowReading` hands `spenderOf` the used points; the sentence is built where the ledger's total is (`gh-ledger.ts` `spenderPhraseFor`).
 */
export function poolLowReading({ pools, spenderOf = (account, used) => ledgerSpender(account, undefined, used) }: { pools: PoolReading[] | null; spenderOf?: (account: string, used?: number) => string | null; }): Reading {
  if (pools === null) return unknown(SIGNALS.POOL_LOW, "no API pool was read this tick");
  const low = pools.filter((p) => p.limit > 0 && p.remaining / p.limit < POOL_LOW_FRACTION).sort((a, b) => `${a.account}/${a.resource}`.localeCompare(`${b.account}/${b.resource}`));
  if (low.length === 0) return clear(SIGNALS.POOL_LOW);
  const named = low.slice(0, MAX_NAMED).map((p) => `${p.account ?? "an unnamed account"}'s ${p.resource} pool has ${p.remaining} of ${p.limit} left`
    + ` (${Math.round((p.remaining / p.limit) * 100)}%), resetting ${p.resetAt ?? "at a time the answer did not give"}`);
  const key = low.map((p) => `${p.account}/${p.resource}/${p.resetAt}`).join(",");
  return { signal: SIGNALS.POOL_LOW, status: "tripped", firstTrippedAt: null, discriminator: `${SIGNALS.POOL_LOW}@${key}`,
    detail: `${low.length} API pool(s) are below ${Math.round(POOL_LOW_FRACTION * 100)}% of their limit: ${named.join("; ")}${spendersOf(low, spenderOf)}` };
}

/** The config directory `host/gh` writes this process's ledger under: the one `gh` itself reads, else the default. */
const ledgerDir = () => process.env.GH_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gh");

/** @param {HostConfig} host @returns {string} the reviewer's `gh` config directory, `<home>/reviewer/gh` */
export const reviewerGhDir = (host: HostConfig): string => join(host.home, "reviewer", "gh");

/**
 * (#4916) EVERY LEDGER A DECLARED ROLE'S CALLS ARE WRITTEN TO: this process's own config directory and the workers', leads' and reviewer's (`host/gh` routes a role to
 * whichever of them its session runs under, and `app:<role>` lines are in each). A directory that does not exist is not a ledger of this host and is left out; this
 * process's own stays, so a ledger it cannot read is still said. The reviewer's is `wake.ts`'s `REVIEWER_GH_CONFIG_DIR`, derived from `home` because `wake.ts` imports
 * this file; `org-health-app-spender.test.ts` pins the two together.
 * @param {{host: HostConfig, ownDir: string}} where @returns {string[]} the `gh-calls.tsv` paths, each once
 */
export function ledgerPathsOf({ host, ownDir }: { host: HostConfig; ownDir: string; }): string[] {
  const dirs = [ownDir, join(host.gh.workers, "gh"), join(host.gh.leads, "gh"), reviewerGhDir(host)].map((dir) => resolve(dir));
  return [...new Set(dirs)].filter((dir) => dir === resolve(ownDir) || existsSync(dir)).map((dir) => join(dir, "gh-calls.tsv"));
}

/** A config directory that exists and holds no `gh-calls.tsv` has had no call written to it, which is a ledger with nothing in it; a directory that is not there is unread. */
const readLedgerFile = (path: string): string => (existsSync(dirname(path)) && !existsSync(path) ? "" : readFileSync(path, "utf8"));

/** @param {HostConfig} host @returns {string[]} the roles `host.json` declares as `github-apps` */
const declaredAppRoles = (host: HostConfig): string[] => GITHUB_ROLES.filter((role) => roleIdentity(host, role).mode === "github-apps");

/**
 * The spender sentence for ONE pool's login: an account is read from its own ledger line name, an App (`<slug>[bot]`) from the `app:<role>` lines of the role that
 * owns it, and both from every ledger `ledgerPathsOf` names. `read` is the seam a test uses.
 * @param {{account: string, host: HostConfig, ownDir: string, now?: number, read?: (path: string) => string}} where
 */
export function spenderOfAccount({ account, host, ownDir, now, read = readLedgerFile, used }: { account: string; host: HostConfig; ownDir: string; now?: number; read?: (path: string) => string; used?: number; }): string | null {
  return spenderPhraseFor({ ledgers: ledgerPathsOf({ host, ownDir }), login: account, appRoles: declaredAppRoles(host), now, read, used });
}

export function ledgerSpender(account: string, hostOf: () => HostConfig = homeHostConfig, used?: number): string | null {
  const ownDir = ledgerDir();
  let host: HostConfig;
  try {
    host = hostOf();
  } catch (cause) {
    // The declaration could not be read: an ordinary account still has this process's own ledger, but an App's role cannot be named from nothing.
    if (isAppLogin(account)) return `${account} is an App and the host declaration that names its role could not be read (${(cause as Error).message}), so its spender is UNREADABLE`;
    return spenderPhraseFor({ ledgers: [join(ownDir, "gh-calls.tsv")], login: account, read: readLedgerFile, used });
  }
  return spenderOfAccount({ account, host, ownDir, used });
}

/**
 * `. Spender: ...` for each low GRAPHQL pool whose account is named, else "". An account the ledger cannot say anything of reads `UNREADABLE`, because the omission would look
 * like a clean answer.
 */
function spendersOf(low: PoolReading[], spenderOf: (account: string, used?: number) => string | null) {
  const graphql = low.filter((p) => p.resource === "graphql" && p.account !== null);
  const accounts = [...new Set(graphql.map((p) => (p.account as string)))];
  if (accounts.length === 0) return "";
  // an account's used points are its first low graphql pool's: one account has one graphql pool per reset window and this reading keys on the window
  const usedOf = (a: string) => { const p = graphql.find((q) => q.account === a) as PoolReading; return p.limit - p.remaining; };
  return `. Spender: ${accounts.map((a) => spenderOf(a, usedOf(a)) ?? `${a}'s call ledger could not be read, so the spender is UNREADABLE`).join("; ")}`;
}

/**
 * SIGNAL: AN OPEN ROW IS NOT IN EXACTLY ONE STATE (#3942). THE RULE IS `stateLabelFindings`' (the leaf the audit reads too), over the open rows
 * the tick already read, so it costs no call. It trips THE TICK A ROW APPEARS, with one grace (#4048: a row `row-file` is still filing, below): a row in no state is absent from the Ready lane and
 * the claim pool and nothing else will ever name it (fifteen stood for days behind `labellessRows`, which a `lane:any` label satisfied), and a
 * row in two is read two ways by two readers. KEYED ON THE NUMBERS AND THEIR KIND, not an hour: the set changes only when a row enters, leaves
 * or changes kind, so one standing set is one order however many ticks it lasts. `null` is a refused read, which is unknown and never clear.
 * #4048: GIVEN `now`, a row with no state label younger than `FILING_GRACE_MS` is a row `row-file` is still filing (it adds the label last), not a finding.
 */
export function stateLabelReading({ rows, now }: { rows: { number: number; state?: string; createdAt?: string; labels?: (string | { name?: string; })[]; }[] | null; now?: number; }): Reading {
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
 */
export function boardTruthReading({ audit, day = "today" }: { audit: { findings: { question: string; number: number; }[]; unread: string[]; } | null; day?: string; }): Reading {
  if (audit === null) return unknown(SIGNALS.BOARD_TRUTH, "the board could not be read, so no row is known to agree with reality");
  if (audit.findings.length === 0) {
    return audit.unread.length === 0 ? clear(SIGNALS.BOARD_TRUTH)
      : unknown(SIGNALS.BOARD_TRUTH, `0 disagree on what was read, but ${audit.unread.join(", ")} could not be read`);
  }
  return { signal: SIGNALS.BOARD_TRUTH, status: "tripped", firstTrippedAt: null,
    discriminator: `${SIGNALS.BOARD_TRUTH}@${audit.findings.map((f) => `${f.number}${f.question}`).join(",")}`,
    detail: `\n${boardTruthTable((audit as any), day)}\n` };
}

/**
 * agent-org#1670: THE READINGS OF THE BOARD TRUTH SIGNAL. `offers` OMITTED (or `null`, a pair state that could not be read) is `boardTruthReading`, byte for byte: the
 * flag `BOARD_TRUTH_PAIR_FLAG` is OFF. With `offers` given, one tripped reading per pair OFFERED this tick (`boardTruthPairStep`), each keyed on its own pair, so
 * `orgHealthOrders` makes one order per pair; a tick whose disagreeing pairs were all offered already reads CLEAR, because they were said and are not new.
 */
export function boardTruthReadings({ audit, day = "today", offers }: { audit: Parameters<typeof boardTruthTable>[0] | null; day?: string; offers?: BoardTruthOffer[] | null; }): Reading[] {
  if (offers === undefined || offers === null || audit === null || audit.findings.length === 0) return [boardTruthReading({ audit, day })];
  if (offers.length === 0) return [clear(SIGNALS.BOARD_TRUTH)];
  return offers.map((offer) => ({ signal: SIGNALS.BOARD_TRUTH, status: "tripped", firstTrippedAt: null,
    discriminator: offer.discriminator, detail: `\n${boardTruthTable(audit, day)}\n` }));
}

/** agent-org#1670: the flag that keys the board-disagrees offer on each (row, question) pair. OFF is the set-keyed order `boardTruthReading` has always made. */
export const BOARD_TRUTH_PAIR_FLAG = "orgHealth.boardTruthPairKey";
/** agent-org#1670: the pairs the board has offered, kept in the state directory beside the canary's file. */
export const BOARD_TRUTH_PAIRS_FILE = "board-truth-pairs.json";
/** agent-org#1670: a pair the board does not disagree on for this long is CLEARED, so its next disagreement is offered again. A judgment call: two hours, the hold the org-health orders keep. */
export const BOARD_TRUTH_CLEAR_MINUTES = 120;

/** One pair the board disagreed on: how many times it has been offered, and the last tick it was on the board (epoch ms). */
export type BoardTruthPairs = Record<string, { offers: number; lastSeen: number; }>;
/** One offer the pair step makes: the `(row, question)` pair, and the discriminator it is keyed on (`board-disagrees-with-reality@<pair>`, with `:<n>` from its second offer). */
export type BoardTruthOffer = { pair: string; discriminator: string; };

/**
 * agent-org#1670: THE PAIR STEP, PURE. A pair on the board is OFFERED when it is first seen, or when it returns after `BOARD_TRUTH_CLEAR_MINUTES` off the board; a pair that
 * stands is not offered again, however many ticks it lasts, and a pair that leaves the board costs nothing but its clock. @returns the pairs with this tick's sightings
 * recorded (an absent pair keeps its entry, so a flicker inside the clear period is not a new offer), and the offers this tick makes.
 * @param present the `<number><question>` keys of the disagreeing pairs this tick
 */
export function boardTruthPairStep({ pairs, present, now }: { pairs: BoardTruthPairs; present: string[]; now: number; }): { pairs: BoardTruthPairs; offers: BoardTruthOffer[]; } {
  const next: BoardTruthPairs = { ...pairs };
  const offers: BoardTruthOffer[] = [];
  for (const pair of new Set(present)) {
    const seen = pairs[pair];
    const offered = seen === undefined || now - seen.lastSeen > BOARD_TRUTH_CLEAR_MINUTES * MS_PER_MINUTE;
    const count = offered ? (seen?.offers ?? 0) + 1 : seen.offers;
    if (offered) offers.push({ pair, discriminator: count === 1 ? `${SIGNALS.BOARD_TRUTH}@${pair}` : `${SIGNALS.BOARD_TRUTH}@${pair}:${count}` });
    next[pair] = { offers: count, lastSeen: now };
  }
  return { pairs: next, offers };
}


/**
 * SIGNAL: THE ORG IS IDLE WHILE ROWS ARE OPEN (#3943). `idle` is `idleWithOpenRowsReading`'s answer over the open rows the tick already read, so it costs no call:
 * `null` is an engineer holding a row (clear); `{ kind: "unread" }` is a read that did not return, which is unknown and NEVER an idle org; an idle org
 * with nothing unoffered is finished and clear. It trips THE TICK THE CONDITION HOLDS, with no grace (the chairman's order: within one tick), and clears the tick an
 * engineer holds a row. KEYED ON THE KINDS OF REASON (and the `READY_UNOFFERED` numbers, the one defect), not on every row, so a backlog row filed while idle is not a
 * second order; a new KIND of reason is.
 */
export function idleWithOpenRowsSignal({ idle }: { idle: import("./idle-with-open-rows.ts").IdleRows; }): Reading {
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
 * A pull request as the circle reading needs it: the fields the gate's `prsRead` already carries (`repo` is on a PR of any repository but the first).
 */
export type CirclePr = { number: number, repo?: string, labels?: (string | { name?: string })[], body?: string, statusCheckRollup?: any[] };
export type CircleRow = { number: number, body?: string, blockedBy?: { nodes?: { number?: number }[] } };
export type ShelvedCircle = { row: number, pr: string, waits: string, declared: string };

/** How a PR's `Closes` line reads for the row: why B4's own-PR exemption (`isOwnPrOf`) stayed off. */
function whyNotOwnPr({ pr, row, trackerRepo }: { pr: CirclePr; row: number; trackerRepo: string; }): string {
  const declaration = extractClosesDeclaration(pr.body);
  if (declaration.kind === "none") return "it declares `Closes: none`, which closes nothing";
  if (declaration.kind !== "closes") return `its \`Closes\` is ${declaration.kind}`;
  const bare = closesReferences(declaration).some((ref) => ref.repo === null && ref.number === row);
  if (bare && pr.repo !== undefined && pr.repo !== trackerRepo) {
    return `its bare \`#${row}\` names ${pr.repo}'s own issue, not the tracker's row (write \`${trackerRepo}#${row}\`)`;
  }
  return `its \`Closes\` names other rows than #${row}`;
}

/** The route from the PR back to the row -- a `Waiting-for`, a closed row's `blockedBy` edge, or its `Waits-on-done-when` -- or `null` when none leads there. */
function routeBack({ pr, closed, rows, row, trackerRepo }: { pr: CirclePr; closed: number[]; rows: CircleRow[]; row: number; trackerRepo: string; }): string | null {
  const wait = parseWaits(pr.body).find((w) => isItemWait(w) && w.number === row && (w.repo ?? trackerRepo) === trackerRepo);
  if (wait) return `\`Waiting-for: ${wait.text}\``;
  for (const number of closed) {
    const closing = rows.find((r) => r.number === number);
    if ((closing?.blockedBy?.nodes ?? []).some((n) => Number(n.number) === row)) return `the row it closes, #${number}, is blockedBy #${row}`;
    if (namedDoneWhens(String(closing?.body ?? "")).some((n) => n.row === row)) return `the row it closes, #${number}, \`Waits-on-done-when: ${row}.*\``;
  }
  return null;
}

const nameOf = (pr: CirclePr) => (pr.repo === undefined ? `#${pr.number}` : `#${pr.number} in ${pr.repo}`);
const labelNames = (pr: CirclePr) => (pr.labels ?? []).map((l) => (typeof l === "string" ? l : String(l?.name)));

/**
 * #4401: A ROW SHELVED BY B4 AGAINST A PULL REQUEST THAT WAITS ON THAT ROW IS A CIRCLE, and nobody could claim either end of it. Measured 2026-10-09: #4372 was shelved on 71 ticks,
 * `overlaps #39 in a11ign/lab`, while lab#39 was held (`hold:ceo`, `Waiting-for: closed #4372`) and declared `Closes: none`, which turned off `isHeldPrWaitingOn` (a PR that closes nothing waits on
 * nothing) and `isOwnPrOf`. The first repair, a bare `Closes: #4305, #4372` in a LAYER repository's PR, did nothing either: a bare number there is that repository's issue.
 *
 * THE FINDING IS THE STRUCTURE, NOT A CLOCK: the row's reason names the PR (`overlaps ${name},` -- the words B4 writes), the PR is held, parked or red (an UNHELD, green PR on the same file is a
 * real collision and is not named), and a route leads from the PR back to the row. That cannot clear itself, so no bound is waited for before it is said; the order is the tick's and holds two hours.
 * It decides on what the gate already read (the shelved map, the PRs, the open rows) and makes no call.
 */
export function shelvedCircles({ shelved, prs, rows, trackerRepo = homeProjectDeclaration().tracker[0].repo }: { shelved: ReadonlyMap<number, string>; prs: CirclePr[]; rows: CircleRow[]; trackerRepo?: string; }): ShelvedCircle[] {
  const circles: ShelvedCircle[] = [];
  for (const pr of prs) {
    const names = labelNames(pr);
    if (holdersOf(names).length === 0 && !names.includes(PARKED_LABEL) && redSinceOf(pr) === null) continue;
    const closed = declaredClosedRows(pr.body, { ...(pr.repo === undefined ? {} : { prRepo: pr.repo }), trackerRepo });
    for (const [row, reason] of shelved) {
      if (!reason.includes(`overlaps ${nameOf(pr)},`) || closed.includes(row)) continue;
      const waits = routeBack({ pr, closed, rows, row, trackerRepo });
      if (waits !== null) circles.push({ row, pr: nameOf(pr), waits, declared: whyNotOwnPr({ pr, row, trackerRepo }) });
    }
  }
  return circles;
}

/**
 * SIGNAL: A ROW SHELVED AGAINST THE PR THAT WAITS ON IT (#4401). `circles` is {@link shelvedCircles}' answer; `null` is a tick whose pull-request or Ready read was refused, which is unknown and NEVER clear.
 */
export function shelvedCircleReading({ circles }: { circles: ShelvedCircle[] | null; }): Reading {
  if (circles === null) return unknown(SIGNALS.SHELVED_CIRCLE, "the pull requests or the gate's own shelving list could not be read");
  if (circles.length === 0) return clear(SIGNALS.SHELVED_CIRCLE);
  const key = circles.map((c) => `${c.row}:${c.pr}`).sort().join(",");
  return { signal: SIGNALS.SHELVED_CIRCLE, status: "tripped", firstTrippedAt: null, discriminator: `${SIGNALS.SHELVED_CIRCLE}@${key}`,
    detail: circles.map((c) => `row #${c.row} is shelved by B4 against ${c.pr}, which waits on it (${c.waits}) and is not its own PR because ${c.declared}`).join("; ") };
}

/**
 * One declared copy: where it came from and where it sits (both relative to the checkout), how many lines its own header says it changed (`null` when the header says none), the original's text (`null` when it could not be read) and the copy's text.
 */
export type CopyPair = { original: string, copy: string, allowedLines: number | null, originalText: string | null, copyText: string, comparedIn?: string | null };

/**
 * An original that moved into an installed package is named by its specifier (`@a11ign/toolchain/lib/<stem>`), never by a path of the
 * checkout. The package ships COMPILED output, so no line of it is a line of the copy: it is compared by a test that reads names and
 * behaviour, which the copy's header names (`COMPARED IN`).
 */
const isInstalledOriginal = (original: string): boolean => original.startsWith("@");
const COPY_COMPARED_IN = /^\/\/ COMPARED IN `([^`]+)`/;

/**
 * SIGNAL (#3533): A RUNNER OF `agent-org` THAT IS NOT ON THE NEWEST RELEASE FOR LONGER THAN ONE RELEASE CYCLE, whichever of the three kinds it is (the tool checkout, a worktree's resolved
 * copy, the last `ci.yml` run on `main`). The comparison is `lib/tool-version-agreement.ts`'s, which `host:check` calls too; THIS only turns its result into a reading. `agreement` is `undefined`
 * when the caller does not ask (a host that declares no tool), `null` when the read was refused, else what the child read returned (`{ result }`). Keyed on the newest tag: one release, one signal,
 * and the next release is a new one. A runner the read could not say anything about is an `unknown` and never a clear.
 */
export function toolVersionReading({ agreement }: { agreement: { result: ToolAgreement; } | null; }): Reading {
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
 * THE READ, in a CHILD: `lib/tool-version-agreement.ts --json` asks the tool's remote for its tags, each worktree for its resolved copy and GitHub for the last CI run, and a gate that imported
 * those readers would carry the history readers into every test that reaches the tick (`host-units.ts`'s `jsonReport` is the precedent for the fence). `undefined` is "not asked" (a host that
 * declares no tool); `null` is a read that failed, which the reading says. NEVER THROWS.
 */
export function readToolAgreement(run: (args: string[]) => string = (args) => execFileSync(process.execPath, [...args], { encoding: "utf8", timeout: AGREEMENT_READ_MS, stdio: ["ignore", "pipe", "pipe"], env: process.env })): { now: number; result: ToolAgreement; } | null | undefined {
  try {
    const parsed = JSON.parse(run([resolve(TOOL_ROOT, "src/lib/tool-version-agreement.ts"), "--json"]));
    return parsed.asked === false ? undefined : parsed;
  } catch {
    return null;
  }
}

/**
 * SIGNAL (ADR 0043 Decision 8, a11ign/a11ign#4390): A `node` THE HOST RUNS CANNOT STRIP TYPES, so `node <file>.ts` would die there. The facts are `node-strips-types.ts`'s (the PATH `node` and every `node` a
 * rendered unit names, asked once per run); THIS turns them into a reading. `fact` is `undefined` when the caller does not ask and `null` when the read was refused. A binary that could not be run is
 * tripped, never clear: absence is not a pass. Keyed on the bad binaries, so the same breakage is one signal however many ticks see it and a different binary is a new one.
 */
export function nodeCannotStripReading({ fact }: { fact: NodeStripFact | null; }): Reading {
  if (fact === null) return unknown(SIGNALS.NODE_CANNOT_STRIP, "the read of what each `node` prints for `process.features.typescript` did not return");
  const bad = fact.readings.filter((reading) => !canStrip(reading));
  if (bad.length === 0) {
    return fact.unlisted === undefined ? clear(SIGNALS.NODE_CANNOT_STRIP)
      : unknown(SIGNALS.NODE_CANNOT_STRIP, `the PATH \`node\` strips types, but the units' \`node\` binaries were not listed: ${fact.unlisted}`);
  }
  const named = bad.slice(0, MAX_NAMED).map(describeBad).join("; ");
  const more = bad.length > MAX_NAMED ? `; and ${bad.length - MAX_NAMED} more` : "";
  return { signal: SIGNALS.NODE_CANNOT_STRIP, status: "tripped", firstTrippedAt: null, discriminator: `${SIGNALS.NODE_CANNOT_STRIP}@${bad.map((reading) => reading.binary).sort().join(",")}`,
    detail: `${bad.length} of ${fact.readings.length} \`node\` binaries cannot strip types: ${named}${more}` };
}

/** GitHub's `permissions` booleans on a team's repository, highest first: the team's level there is the first one that is true. */
const TEAM_LEVELS = Object.freeze(["admin", "maintain", "push", "triage", "pull"]);
/** One `full_name<TAB>admin<TAB>maintain<TAB>push<TAB>triage<TAB>pull` line per repository the team reaches. */
const TEAM_LISTING_JQ = ".[]|[.full_name,.permissions.admin,.permissions.maintain,.permissions.push,.permissions.triage,.permissions.pull]|@tsv";
const TEAM_PAGE_SIZE = 100;

export type TeamRepository = { repo: string, level: string };
/** `reached` is `null` for a read that could not run, and `why` then says what GitHub answered */
export type TeamAccess = { team: string, layer: string, exceptions?: Record<string, string>, declared: string[], reached: TeamRepository[] | null, why: string };
export type TeamAccessFact = { teams: TeamAccess[] } | { unreadable: string };

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
 * @param input `access` is `readTeamAccess`'s answer; `undefined` (not asked) never reaches here
 */
export function teamAccessReading({ access }: { access: TeamAccessFact; }): Reading {
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

/** One declared repository's last WHOLE read, as the webhook gate stamps it in `other-scopes-memory.json`. `readAtMs` is OMITTED when nothing is stamped for it. */
export type SweepRead = { name: string, readAtMs?: number };
/** agent-org#1418: `sweepMinutes` is `GRAPHQL_SWEEP_MINUTES`, the longest a repository may go unread on a webhook tick. */
export type SweepFact = { sweepMinutes: number, repos: SweepRead[] };

/**
 * SIGNAL 15 (agent-org#1418): A DECLARED REPOSITORY HAS GONE UNREAD LONGER THAN THE SWEEP PROMISES (a11ign/a11ign#5408: nine partial ticks, and three
 * agent pull requests waited about 20 minutes with no alert). A webhook tick reads a repository only where its events named it or it is due a sweep, and
 * a paced tick can refuse a whole read, which leaves the stamp old. The limit is the sweep plus one tick (`MINUTES_PER_TICK`), and "older than" is strict,
 * so a repository read on the tick's edge is not a trip. A trip names each repository and its age.
 *
 * A MISSING STAMP IS UNKNOWN, NEVER CLEAR: nothing is remembered as read, so the memory says nothing about that repository at all. A trip stands over
 * an unstamped repository, as a trip stands over an unread team in `teamAccessReading`.
 */
export function sweepOverdueReading({ now, sweeps }: { now: number; sweeps: SweepFact; }): Reading {
  const limit = (sweeps.sweepMinutes + MINUTES_PER_TICK) * MS_PER_MINUTE;
  const late = sweeps.repos.flatMap((r) => (r.readAtMs !== undefined && now - r.readAtMs > limit
    ? [{ name: r.name, text: `${r.name} (last whole read ${ageText(r.readAtMs, now)} ago)` }] : []));
  if (late.length > 0) {
    const named = late.slice(0, MAX_NAMED).map((l) => l.text).join("; ");
    const more = late.length > MAX_NAMED ? `, and ${late.length - MAX_NAMED} more` : "";
    return { signal: SIGNALS.SWEEP_OVERDUE, status: "tripped", firstTrippedAt: null,
      discriminator: `${SIGNALS.SWEEP_OVERDUE}@${late.map((l) => l.name).sort().join(",")}`,
      detail: `${late.length} repositor${late.length === 1 ? "y" : "ies"} unread for longer than the sweep plus one tick: ${named}${more}` };
  }
  const unstamped = sweeps.repos.filter((r) => r.readAtMs === undefined).map((r) => r.name);
  if (unstamped.length > 0) {
    return unknown(SIGNALS.SWEEP_OVERDUE, `CANNOT_TELL: no whole read is stamped for ${unstamped.slice(0, MAX_NAMED).join(", ")}, so its age is not known`);
  }
  return clear(SIGNALS.SWEEP_OVERDUE);
}

/** @returns one entry per repository, `team:repo` keyed so a second repository is a new trip */
function teamDifferences({ team, layer, exceptions = {}, declared, reached }: TeamAccess): { key: string; text: string; }[] {
  if (reached === null || reached.length === 0) return [];
  const held = new Map(reached.map(({ repo, level }) => [repo, level]));
  const found = new Map();
  for (const repo of declared) {
    const level = held.get(repo) ?? "none";
    const expected = exceptions[repo] ?? layer;
    if (level !== expected) found.set(repo, `${repo}: the ${team} team holds ${level}, declared ${expected}`);
  }
  for (const [repo, level] of held) {
    if (level === "admin" && !found.has(repo)) found.set(repo, `${repo}: the ${team} team holds admin${declared.includes(repo) ? "" : " and is not declared"}`);
  }
  return [...found].map(([repo, text]) => ({ key: `${team}:${repo}`, text }));
}

/** @returns `null` for a line that is not six fields: a partial listing is not a reading */
export function parseTeamListing(text: string): TeamRepository[] | null {
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
 * A team may carry `exceptions`, `{ "<owner>/<name>": "<level>" }`: the level it is DELIBERATELY kept at on that one repository instead of `layer`
 * (a11ign/a11ign#4467: `bots` stays off `a11ign/.github`, which would otherwise be a permanent trip). See `teamExceptionsOf` for what is refused.
 */
function readTeamDeclaration(root: string, read: (path: string) => string): { declaration: undefined; } | { unreadable: string; } | { org: string; declared: string[]; teams: { team: string; layer: string; exceptions: Record<string, string>; }[]; } {
  const project = `${root}/.agent-org/project.json`;
  try {
    const key = JSON.parse(read(project)).teamAccess;
    if (key === undefined) return { declaration: undefined };
    if (typeof key?.declaration !== "string" || key.declaration === "" || resolve(root, key.declaration).startsWith(`${resolve(root)}/`) === false) {
      return { unreadable: `${project}: teamAccess.declaration must be a path inside the project (CANNOT_TELL)` };
    }
    return teamDeclarationOf(JSON.parse(read(resolve(root, key.declaration))), key.declaration);
  } catch (err) {
    return { unreadable: `the team declaration could not be read: ${String((err as any)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS)} (CANNOT_TELL)` };
  }
}

function teamDeclarationOf(file: any, where: string): ReturnType<typeof readTeamDeclaration> {
  const declared = Object.keys(file?.repositories ?? {}).filter((k) => !k.startsWith("_"));
  const orgs = new Set(declared.map((repo) => repo.split("/")[0]));
  const teams = Object.entries(file?.teams ?? {}).filter(([k]) => !k.startsWith("_"))
    .map(([team, level]) => ({ team, layer: (level as any)?.layer, exceptions: (level as any)?.exceptions }));
  if (orgs.size !== 1 || teams.some((t) => typeof t.layer !== "string")) {
    return { unreadable: `${where}: it must declare \`repositories\` of one org and each \`teams.<slug>.layer\` as a string (CANNOT_TELL)` };
  }
  const refused = teams.map((t) => teamExceptionsOf(t, declared)).find((r) => typeof r === "string");
  if (refused !== undefined) return { unreadable: `${where}: ${refused} (CANNOT_TELL)` };
  return { org: [...orgs][0], declared, teams: teams.map((t) => ({ ...t, exceptions: t.exceptions ?? {} })) };
}

/** The levels an exception may name: `admin` is a trip anywhere (`teamDifferences`), so declaring it as the expected level would bless the thing the signal exists to catch. */
const EXCEPTION_LEVELS = Object.freeze(["none", ...TEAM_LEVELS.filter((level) => level !== "admin")]);

/**
 * @returns why the team's `exceptions` cannot be believed, or `undefined` when it is absent or sound. An exception naming a repository the declaration
 * does not list is refused rather than ignored: it would expect nothing of anything, and a mistyped name must be told on the next tick, not believed to be watching.
 */
function teamExceptionsOf({ team, exceptions }: { team: string; exceptions?: any; }, declared: string[]): string | undefined {
  if (exceptions === undefined) return undefined;
  if (exceptions === null || typeof exceptions !== "object" || Array.isArray(exceptions)) return `teams.${team}.exceptions must map an owner/name to a level`;
  const entries = Object.entries(exceptions).filter(([repo]) => !repo.startsWith("_"));
  const strange = entries.find(([repo]) => !declared.includes(repo));
  if (strange) return `teams.${team}.exceptions names ${strange[0]}, which \`repositories\` does not list`;
  const level = entries.find(([, l]) => typeof l !== "string" || !EXCEPTION_LEVELS.includes(l));
  if (level) return `teams.${team}.exceptions.${level[0]} must be one of ${EXCEPTION_LEVELS.join(", ")} (admin is a trip anywhere and is not an exception)`;
  return undefined;
}

/**
 * THE FACT FOR `teamAccessReading`: the declaration, then ONE paginated REST call per declared team on the core pool (`gh api` spends core, never GraphQL, `gh-api-budget.md`).
 * `undefined` is "not asked" (the project declares no `teamAccess`), `{ unreadable }` a read that failed, and a team GitHub refused is `reached: null` with its own reason.
 * NEVER THROWS.
 */
export function readTeamAccess(run: (args: string[]) => string, { root = HOME_CHECKOUT, read = (path) => readFileSync(path, "utf8") }: { root?: string; read?: (path: string) => string; } = {}): TeamAccessFact | undefined {
  const found = readTeamDeclaration(root, read);
  if ("declaration" in found) return undefined;
  if ("unreadable" in found) return found;
  return { teams: found.teams.map(({ team, layer, exceptions }) => ({ team, layer, exceptions, declared: found.declared, ...readTeamRepositories(run, found.org, team) })) };
}

function readTeamRepositories(run: (args: string[]) => string, org: string, team: string): { reached: TeamRepository[] | null; why: string; } {
  try {
    const reached = parseTeamListing(run(["api", `orgs/${org}/teams/${team}/repos?per_page=${TEAM_PAGE_SIZE}`, "--paginate", "--jq", TEAM_LISTING_JQ]));
    return reached === null ? { reached, why: "GitHub answered a line that is not a repository's permissions" } : { reached, why: "" };
  } catch (err) {
    return { reached: null, why: String((err as any)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS) };
  }
}

/** @returns the text with the copy header block removed, wherever it sits */
function withoutCopyHeader(text: string): { body: string; complete: boolean; } {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => COPY_HEADER_START.test(line));
  const end = lines.indexOf(COPY_HEADER_END);
  if (start < 0 || end < start) return { body: text, complete: false };
  return { body: [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n"), complete: true };
}

/**
 * How many lines of `lines` have no counterpart left in `against`, counted as a MULTISET so a moved or duplicated line is not
 * mistaken for an edit and an edit is one line on each side.
 */
function linesWithoutCounterpart(lines: string[], against: string[]): number {
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
 * A copy drifts when more of the ORIGINAL'S lines are changed or gone than its OWN HEADER names, or when a header that names NOTHING
 * sits above a copy with lines the original lacks. THE HEADER'S COUNT IS THE ALLOWANCE, which is what lets the pair list be discovered
 * rather than declared a second time -- and its price is stated here: a one-byte change ON a line the header already names is inside
 * the allowance, and so are the copy's own extra lines once the header names any change, because the header counts the original's
 * lines it changed and ONE of them can become several (`changed-packages.ts`'s `REPO` became four lines under "3 NAMED LINES", #2884). `agent-org-outward-edges.test.ts` applies each sanctioned edit exactly and
 * is the exact check; this is the cheap one that runs on every tick.
 */
function judgePair(pair: CopyPair): { verdict: "same" | "drifted" | "unknown"; why: string; } {
  if (pair.originalText === null) return { verdict: "unknown", why: `${pair.original} could not be read` };
  if (isInstalledOriginal(pair.original)) {
    return pair.comparedIn ? { verdict: "same", why: "" }
      : { verdict: "unknown", why: `${pair.original} is installed compiled and no test that is still reading this stem is named by its header, so nothing compares it` };
  }
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
 * SIGNAL 6: A DECLARED COPY NO LONGER MATCHES ITS ORIGINAL (#2937). `packages/guards/src/isolation-gate.ts` and
 * `packages/agent-org/src/lib/isolation-gate.ts` were edited identically BY HAND in #2921: a drift waiting to happen unless a question
 * reads it. `pairs` is `null` for a read that could not run; an EMPTY list is stated as unknown too, because a discovery that finds
 * no copy in a tree that holds nineteen has not found a clean tree.
 */
export function copyDriftReading({ pairs }: { pairs: CopyPair[] | null; }): Reading {
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

/**
 * WHERE AN INSTALLED ORIGINAL IS: `<root>/node_modules/<package>/` plus what the package's own `exports` map gives for the subpath, so the
 * module counts as present only where the package says it ships it. `null` for anything that cannot be read, a package that is not
 * installed and a subpath it no longer exports alike.
 */
function readInstalledOriginal(read: (path: string) => string, root: string, specifier: string): string | null {
  const [scope, name, ...subpath] = specifier.split("/");
  if (name === undefined) return null;
  const dir = `${root}/node_modules/${scope}/${name}`;
  const manifest = readOrNull(read, `${dir}/package.json`);
  if (manifest === null) return null;
  try {
    const entry = JSON.parse(manifest).exports?.[`./${subpath.join("/")}`];
    const target = typeof entry === "string" ? entry : entry?.default;
    return typeof target === "string" ? readOrNull(read, `${dir}/${target.replace(/^\.\//, "")}`) : null;
  } catch {
    return null;
  }
}

/**
 * THE TEST A COPY SAYS COMPARES IT, or `null`: the header names it (`COMPARED IN`), the file must be readable in the tool, and it must still
 * name the copy's stem as a key (`"<stem>":`), so a test that stopped probing this copy, or a header naming a file that is gone, is not "compared".
 */
function comparerOf(read: (path: string) => string, toolRoot: string, copy: string, copyText: string): string | null {
  const lines = copyText.split("\n");
  const named = lines.slice(0, Math.max(lines.indexOf(COPY_HEADER_END), 0)).map((line) => COPY_COMPARED_IN.exec(line)?.[1]).find(Boolean);
  if (named === undefined) return null;
  const stem = copy.split("/").pop()?.replace(/\.[^.]+$/, "");
  const text = readOrNull(read, `${toolRoot}/${named}`);
  return text !== null && text.includes(`"${stem}":`) ? named : null;
}

/** @returns the text, or `null` for a file that cannot be read: absent is not empty */
function readOrNull(read: (path: string) => string, path: string): string | null {
  try {
    return read(path);
  } catch {
    return null;
  }
}

/**
 * THE DECLARED COPIES OF A CHECKOUT, discovered from the headers: every file in `COPIES_DIR` whose header names its original. `null`
 * when the directory cannot be listed. Each pair's original is read here and is `null` in the pair when it cannot be.
 * `root` is the PROJECT, where each copy's original is read (an original named by package specifier is read from the package installed
 * under it); `toolRoot` is where the copies themselves are.
 */
export function readDeclaredCopies({ root = DEFAULT_ROOT, toolRoot = TOOL_ROOT, list = (dir) => readdirSync(dir), read = (path) => readFileSync(path, "utf8") }: { root?: string; toolRoot?: string; list?: (dir: string) => string[]; read?: (path: string) => string; } = {}): CopyPair[] | null {
  let names;
  try {
    names = list(`${toolRoot}/${COPIES_DIR}`).sort();
  } catch {
    return null; // an unlistable directory is not an empty one
  }
  const pairs: CopyPair[] = [];
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
    const installed = isInstalledOriginal(original);
    pairs.push({ original, copy, originalText: installed ? readInstalledOriginal(read, root, original) : readOrNull(read, `${root}/${original}`), copyText,
      ...(installed ? { comparedIn: comparerOf(read, toolRoot, copy, copyText) } : {}), allowedLines: changed === null ? null : Number(changed[1] ?? (/ONE LINE/.test(changed[0]) ? 1 : 0)) });
  }
  return pairs;
}

/**
 * WHEN THE PRIMARY STOPPED BEING CURRENT: the committer date of the oldest commit `origin/main` has that HEAD lacks, else the
 * oldest modified time among its dirty tracked files. INFERRED from git and the filesystem, not logged: nothing records the moment
 * `primary:update` first failed. `null` when neither can be read.
 */
export function primaryStandingSince(drift: { behind: number; dirty: string[]; } | null, { root, run = (args) => execFileSync("git", args, { cwd: root, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  mtimeOf = (path) => statSync(`${root}/${path}`).mtimeMs }: { root: string; run?: (args: string[]) => string; mtimeOf?: (path: string) => number; }): number | null {
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
 * THE LAST MERGE OF ONE REPOSITORY: `{ at }` (`at` is `null` for a repository with no merged PR among the newest-updated), or `null` when the
 * read was refused or unparseable. The two are told apart because only the second says nothing about the repository.
 */
function askLastMerge(run: (args: string[]) => string, repo: string): { at: number | null; } | null {
  try {
    const out = run(["api", `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${MERGED_WINDOW}`,
      "--jq", "[.[] | select(.merged_at != null) | .merged_at] | max"]);
    // `gh --jq` prints a string RAW (no quotes) and the word `null` for an empty list, both of which `Date.parse` reads as NaN or a time.
    if (out.trim() === "null") return { at: null };
    const at = Date.parse(out.trim());
    return Number.isFinite(at) ? { at } : null;
  } catch {
    return null;
  }
}

/**
 * THE LAST MERGE, as epoch ms, or `null`. ONE REST CALL on the core pool: the newest-UPDATED closed PRs, of which the latest
 * `merged_at` is the answer (merging updates the PR, so every recent merge is among them). `null` -- refused, unparseable, or no
 * merged PR in the window -- is a stated unknown, never "long ago": a refusal says nothing about when the last merge was.
 */
export function readLastMergedAt(run: (args: string[]) => string, repo: string): number | null {
  return askLastMerge(run, repo)?.at ?? null;
}

/**
 * THE ORG'S LATEST MERGE across `repos` (#4047): the work that could land includes rows whose code merges in `agent-org`, so a gap measured
 * in the project's repository alone tripped `no-merge-while-work-exists` falsely twice in a day. ONE call per repository. A repository
 * whose read is refused makes the answer `null` (unknown): the others' older times would put a merge further back than it may be, and that
 * is a false trip. A repository with no merged PR in its window says nothing and is skipped; none anywhere is `null` too.
 */
export function readLatestMerge(run: (args: string[]) => string, repos: readonly string[]): { at: number; repo: string; } | null {
  const asked = repos.map((repo) => ({ repo, merge: askLastMerge(run, repo) }));
  if (asked.some(({ merge }) => merge === null)) return null;
  let latest: { at: number; repo: string; } | null = null;
  for (const { repo, merge } of asked) {
    if (merge?.at != null && (latest === null || merge.at > latest.at)) latest = { at: merge.at, repo };
  }
  return latest;
}

/** How many of the newest `release.yml` runs on `main` the release read looks at: the `status` runs it skips on every commit crowd the list, so the window is wide. */
const RELEASE_RUN_WINDOW = 30;
const RELEASE_JOBS_WINDOW = 100;
/** The job that publishes. A publishing run's jobs are named `release / <job>` (run 38332090768: `release / publish`, see {@link releaseJobPublished}). */
const RELEASE_PUBLISH_JOB = "release / publish";
/**
 * A run that says whether a release happened: any failure, and a success that PUBLISHED. A push to `main` publishes when it concludes success. A dispatch on `main` publishes only when its
 * `release / publish` job did (a dispatch carrying `action-tag-version` is the promote-only run, whose `release / publish` job is skipped by its `needs`). A `status` run's success is a promotion, never a release,
 * so it neither clears a streak nor joins one (a11ign/agent-org#1273: it cleared a streak of two on 2026-10-12). `cancelled`, `skipped`, `neutral` and a run still going say nothing (#4001).
 */
const isVerdict = (r: ReleaseRun): boolean => r.conclusion === "failure" || (r.conclusion === "success" && (r.event === "push" || (r.event === "workflow_dispatch" && r.published === true)));

/**
 * `published` is set only on a `workflow_dispatch` that concluded success: whether its `release / publish` job did too (see {@link isVerdict}). Absent on every other run.
 */
export type ReleaseRun = { id: number, event: string, status: string, conclusion: string | null, sha: string, createdAt: string, updatedAt: string, url: string, published?: boolean };
export type FailedJob = { id?: number, name: string, steps: string[] };
/**
 * `jobs` and `pending` are read only when the newest verdict is a failure; `null` is a read that was refused
 */
export type ReleaseRuns = { runs: ReleaseRun[], jobs?: FailedJob[] | null, pending?: string[] | null };

/** @returns the newest run that says whether a release happened (see {@link isVerdict}): the one that says whether the last release happened */
export function newestReleaseVerdict(runs: ReleaseRun[]): ReleaseRun | undefined {
  return [...runs].filter(isVerdict).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

/**
 * SIGNAL 18 (#4001): THE LAST RELEASE RUN ON `main` FAILED AND NOTHING HAS SUCCEEDED SINCE. The newest run that says whether a release happened decides (see {@link isVerdict}): a later
 * publishing `success` clears it, and a `status` run's success, or a run that was cancelled, skipped or is still going, neither trips nor clears it (a promotion is not a release). Any event
 * counts, because a failed release is a failed release whatever started it. A list with no verdict in it is UNKNOWN, never clear: a window of skipped runs says nothing.
 * The jobs and the pending changesets are the DETAIL of a failure already certain, so a refusal of either is said in the detail and does not turn the trip into an unknown.
 */
export function releaseFailedReading({ releaseRuns }: { releaseRuns: ReleaseRuns | null; }): Reading {
  const signal = SIGNALS.RELEASE_FAILED;
  if (releaseRuns === null) return unknown(signal, "the runs of release.yml on main could not be read, so the last release is not known to have succeeded");
  const verdict = newestReleaseVerdict(releaseRuns.runs);
  if (verdict === undefined) return unknown(signal, `none of the newest ${releaseRuns.runs.length} release.yml run(s) on main concluded success or failure, so no release is known to have happened or failed`);
  if (verdict.conclusion === "success") return clear(signal);
  const failedAt = Date.parse(verdict.updatedAt);
  return { signal, status: "tripped", firstTrippedAt: Number.isFinite(failedAt) ? failedAt : null, discriminator: `${signal}@${verdict.id}`,
    detail: `release.yml on main FAILED and no later run succeeded: run ${verdict.id} (${verdict.event}) at ${verdict.sha.slice(0, 9)}, ${failedJobsText(releaseRuns.jobs)}; ${pendingText(releaseRuns.pending)}; ${verdict.url}` };
}

function failedJobsText(jobs: FailedJob[] | null | undefined): string {
  if (!jobs) return "the failing job could not be read (read the run)";
  if (jobs.length === 0) return "no job of it reports failure (read the run)";
  const named = jobs.slice(0, MAX_NAMED).map(({ name, steps }) => `job \`${name}\`${steps.length > 0 ? ` (step ${steps.map((s) => `"${s}"`).join(", ")})` : ""}`);
  return `${named.join("; ")}${jobs.length > MAX_NAMED ? `; and ${jobs.length - MAX_NAMED} more` : ""}`;
}

function pendingText(pending: string[] | null | undefined): string {
  if (!pending) return "the pending changesets could not be read";
  if (pending.length === 0) return "no changeset is pending in .changeset/";
  return `${pending.length} changeset(s) pending in .changeset/: ${pending.slice(0, MAX_NAMED).join(", ")}${pending.length > MAX_NAMED ? ", ..." : ""}`;
}

/**
 * THE FACT FOR `releaseFailedReading`: ONE REST CALL on the core pool for the newest `release.yml` runs on `main`, and, only while the newest verdict is a failure, TWO MORE
 * (that run's jobs, and `.changeset/` on `main`). `null` is a refused or unparseable list, a stated unknown and never "no failure". NEVER THROWS.
 */
export function readReleaseRuns(run: (args: string[]) => string, repo: string): ReleaseRuns | null {
  const runs: ReleaseRun[] | null = tryJson(() => run(["api", "--method", "GET", `repos/${repo}/actions/workflows/release.yml/runs`, "-f", "branch=main", "-f", `per_page=${RELEASE_RUN_WINDOW}`,
    "--jq", "[.workflow_runs[] | {id, event, status, conclusion, sha: .head_sha, createdAt: .created_at, updatedAt: .updated_at, url: .html_url}]"]));
  if (!Array.isArray(runs)) return null;
  for (const r of runs) if (r.event === "workflow_dispatch" && r.conclusion === "success") r.published = releaseJobPublished(run, repo, r.id);
  const verdict = newestReleaseVerdict(runs);
  if (verdict?.conclusion !== "failure") return { runs };
  const jobs = releaseJobsOf(run, repo, verdict.id, "[.jobs[] | select(.conclusion == \"failure\") | {id, name, steps: [.steps[] | select(.conclusion == \"failure\") | .name]}]");
  const files = tryJson(() => run(["api", `repos/${repo}/contents/.changeset?ref=main`, "--jq", "[.[].name]"]));
  return { runs, jobs: Array.isArray(jobs) ? jobs : null,
    pending: Array.isArray(files) ? files.filter((name) => name.endsWith(".md") && name !== "README.md") : null };
}

/**
 * @returns whether the run's publishing job concluded success: the one answer that tells a publishing dispatch from a promote-only one. A refused read is `false`, which neither clears nor trips.
 * The job is `release / publish`, not `release`: a called workflow's jobs are named `<caller job> / <job>`, so no job of a publishing run is named exactly `release`
 * (a11ign/agent-org#1298: that name matched nothing, so every dispatch read as promote-only and a release that shipped still read as failing).
 */
function releaseJobPublished(run: (args: string[]) => string, repo: string, id: number): boolean {
  const jobs = releaseJobsOf(run, repo, id, "[.jobs[] | {name, conclusion}]");
  return Array.isArray(jobs) && jobs.some((job) => job.name === RELEASE_PUBLISH_JOB && job.conclusion === "success");
}

/** @returns the jobs of one run as `jq` shapes them: the one read of a run's jobs, so the `gh` call site is counted once (agent-org#1273, gh-call-baseline). `null` for a refusal or text that is not JSON. */
function releaseJobsOf(run: (args: string[]) => string, repo: string, id: number, jq: string): any {
  return tryJson(() => run(["api", `repos/${repo}/actions/runs/${id}/jobs?per_page=${RELEASE_JOBS_WINDOW}`, "--jq", jq]));
}

/** @returns the parsed output, or `null` for a refusal or text that is not JSON: a stated gap for the caller, never an empty answer */
function tryJson(read: () => string): any {
  try {
    return JSON.parse(read());
  } catch {
    return null;
  }
}

// --- agent-org#887: A FAILED RELEASE ON ANY REPOSITORY THE ORG RELEASES, NAMING THE RUN'S FIRST ERROR LINE, AND THE SECOND ONE IN A ROW WAKES `ceo` ---------------------------------
//
// THE GAP (a11ign/agent-org#885 class 1, chairman 2026-10-11): `readReleaseRuns` is asked of ONE repository, the project's, so five failed `release.yml` runs of agent-org's own `main` were read by nobody for
// 50+ minutes. THE READING IS NOW ONE PER REPOSITORY, each with its own discriminator (`release-run-failed@<repo>@<first failed run of the streak>`), so one repository's failure neither hides nor re-keys
// another's, and a later success on one clears only that one. A FIRST failure is an INCIDENT ONLY (`fileReleaseIncidents`: an `incident` item in the tracker, no order); THE SECOND CONSECUTIVE FAILURE
// is also an order to `ceo`, keyed on the streak, so a third and a fourth failure are the same order and not a page each.

/** The key the incident item carries on its `Incident:` line, so `priority:emergency` can link it and the chairman's messaging finds it (`ORG_BLOCKING_INCIDENT_KEYS`, `readFixRow`). */
export const RELEASE_INCIDENT_KEY = `incident:${SIGNALS.RELEASE_FAILED}`;
/** How many failed releases in a row on one repository make the order to `ceo` (the chairman's "a second consecutive failure"). */
export const RELEASE_FAILURES_TO_WAKE = 2;
const LOG_STAMP = /^﻿?\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/;
const ANSI = /\u001b\[[0-9;]*m/g;
const STEP_GROUP = "##[group]";
const STEP_END = "##[endgroup]";
const STEP_ERROR = "##[error]";
/** What makes a line of a failing step an ERROR line: pnpm's `ERR_*` and npm's `ERR!`, the word `error`, and git's `fatal:`. */
const ERROR_LINE = /\bERR_|\berr(?:or)?\b|\bfatal\b/i;
const ERROR_LINE_CHARS = 240;

/** What a failed run's log says: the first error line of the step that failed, or why none is quoted (never an empty quote). */
export type FirstError = { line: string } | { unread: string };
/** One repository's release read: its runs (`null` is a refused list) and, while the newest verdict is a failure, the failed job's first error line. */
export type ReleaseFailureRead = { repo: string, runs: ReleaseRuns | null, firstError?: FirstError };

/**
 * THE FIRST ERROR LINE OF THE STEP THAT FAILED, from a job's log. GitHub marks the failure with a `##[error]` line (usually "Process completed with exit code 1", which says nothing), and the line
 * that names the cause is inside the same step, before it: the step is the span from the nearest `##[group]` above the marker, and its output starts after that group's `##[endgroup]` (the lines
 * between are the command echoed, which may say "error" without one). The first line of that output that reads as an error is quoted, else the marker's own text.
 */
export function firstErrorLine(log: string): FirstError {
  const lines = log.split(/\r?\n/).map((line) => line.replace(LOG_STAMP, "").replace(ANSI, ""));
  const marked = lines.findIndex((line) => line.startsWith(STEP_ERROR));
  if (marked === -1) return { unread: "the failed job's log holds no `##[error]` line" };
  let start = marked;
  while (start > 0 && !lines[start].startsWith(STEP_GROUP)) start -= 1;
  const ended = lines.slice(start, marked).findIndex((line) => line.startsWith(STEP_END));
  const output = lines.slice(ended === -1 ? start + 1 : start + ended + 1, marked);
  const found = output.find((line) => !line.startsWith("##[") && ERROR_LINE.test(line)) ?? lines[marked].slice(STEP_ERROR.length);
  const text = found.trim();
  if (text === "") return { unread: "the failed step's error line is empty" };
  return { line: text.length > ERROR_LINE_CHARS ? `${text.slice(0, ERROR_LINE_CHARS - 1)}…` : text };
}

function readFirstError(run: (args: string[]) => string, repo: string, job: FailedJob | undefined): FirstError {
  if (job?.id === undefined) return { unread: "the failed job's id was not read" };
  try {
    return firstErrorLine(jobLogOf(repo, job.id, run)); // the colour codes the log carries are stripped by `firstErrorLine`
  } catch {
    return { unread: "the failed job's log could not be read" };
  }
}

/**
 * THE FACT FOR `releaseFailureReadings`: each repository's `release.yml` runs, and, only for one whose newest verdict is a failure, the failed job's log (ONE MORE CALL beside the jobs and
 * `.changeset/` reads `readReleaseRuns` already makes). `known` is a repository's runs the tick already read (the project's, kept for the canary), so it is not asked twice. NEVER THROWS.
 */
export function readReleaseFailures(run: (args: string[]) => string, repos: readonly string[], { known = {} }: { known?: Record<string, ReleaseRuns | null | undefined> } = {}): ReleaseFailureRead[] {
  return repos.map((repo) => {
    const prior = known[repo];
    const runs = prior !== undefined ? prior : readReleaseRuns(run, repo);
    if (runs === null || newestReleaseVerdict(runs.runs)?.conclusion !== "failure") return { repo, runs };
    return { repo, runs, firstError: runs.jobs ? readFirstError(run, repo, runs.jobs[0]) : { unread: "the failed job could not be read" } };
  });
}

/**
 * THE FAILED RELEASES IN A ROW on one repository, newest first: the verdict runs back to the newest success. A cancelled, skipped, neutral or unfinished run neither joins the streak nor breaks it.
 * `ended` is whether a success closed it: false is a window with no success in it, so the streak is a floor.
 */
export function failureStreak(runs: ReleaseRun[]): { failures: ReleaseRun[]; ended: boolean } {
  const verdicts = runs.filter(isVerdict).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const failures = [];
  for (const verdict of verdicts) {
    if (verdict.conclusion !== "failure") return { failures, ended: true };
    failures.push(verdict);
  }
  return { failures, ended: false };
}

const firstErrorText = (error: FirstError | undefined): string => (error === undefined ? "its first error line was not read" : "line" in error ? `its first error line: "${error.line}"` : `its first error line is not quoted (${error.unread})`);

/**
 * SIGNAL 18 FOR EVERY REPOSITORY THE ORG RELEASES (agent-org#887): ONE READING PER REPOSITORY, tripped while that repository's newest release verdict is a failure. The discriminator names the repository
 * and the FIRST failed run of its streak, so it holds while the streak grows (one order, not a page per failure) and is a new key for the next streak. A first failure is `incidentOnly`; the
 * {@link RELEASE_FAILURES_TO_WAKE}th in a row is an order to `ceo`. A repository whose list was refused, or in which no run concluded, is UNKNOWN and never clear, and does not hide another's trip.
 */
export function releaseFailureReadings({ failures }: { failures: ReleaseFailureRead[] | null; }): Reading[] {
  const signal = SIGNALS.RELEASE_FAILED;
  if (failures === null) return [unknown(signal, "the repositories the org releases could not be listed, so no release is known to have succeeded")];
  const tripped: Reading[] = [];
  const unread: string[] = [];
  for (const { repo, runs, firstError } of failures) {
    if (runs === null) { unread.push(`${repo}: the runs of release.yml on main could not be read`); continue; }
    const verdict = newestReleaseVerdict(runs.runs);
    if (verdict === undefined) { unread.push(`${repo}: none of the newest ${runs.runs.length} release.yml run(s) on main concluded success or failure`); continue; }
    if (verdict.conclusion === "success") continue;
    const { failures: streak, ended } = failureStreak(runs.runs);
    const first = streak[streak.length - 1];
    const startedAt = Date.parse(first.updatedAt);
    const times = streak.length;
    const running = times >= RELEASE_FAILURES_TO_WAKE ? ` ${times}${ended ? "" : " or more"} times running (since run ${first.id})` : "";
    tripped.push({ signal, status: "tripped", firstTrippedAt: Number.isFinite(startedAt) ? startedAt : null, discriminator: `${signal}@${repo}@${first.id}`,
      ...(times < RELEASE_FAILURES_TO_WAKE && { incidentOnly: true as const }),
      detail: `release.yml on ${repo}'s main FAILED${running} and no later run succeeded: run ${verdict.id} (${verdict.event}) at ${verdict.sha.slice(0, 9)}, ${failedJobsText(runs.jobs)}; ${firstErrorText(firstError)}; ${pendingText(runs.pending)}; ${verdict.url}` });
  }
  const gap = unread.length === 0 ? [] : [unknown(signal, `${unread.join("; ")}, so those repositories are not known to have released`)];
  if (tripped.length === 0 && gap.length === 0) return [{ ...clear(signal), detail: `${failures.map(({ repo }) => repo).join(", ")}: the newest release run of each succeeded` }];
  return [...tripped, ...gap];
}

/** The line of an incident item that names the failure it was raised for: `Release-failure: <repo>@<first failed run of the streak>`. */
const RELEASE_FAILURE_LINE = /^Release-failure:[ \t]*(\S+)@(\d+)[ \t]*$/m;
const releaseFailureOf = (body: string): { repo: string; episode: number } | null => {
  const found = RELEASE_FAILURE_LINE.exec(body);
  return found === null ? null : { repo: found[1], episode: Number(found[2]) };
};

/**
 * THE INCIDENT ITEM of one failed streak: its title names the repository and the first error line, and the body carries what the order's detail does, the `Incident:` key
 * ({@link RELEASE_INCIDENT_KEY}) and the `Release-failure:` line this file finds it again by.
 */
function releaseIncidentOf({ repo, runs, firstError }: ReleaseFailureRead & { runs: ReleaseRuns }): { title: string; body: string; episode: number } | null {
  const verdict = newestReleaseVerdict(runs.runs);
  if (verdict?.conclusion !== "failure") return null;
  const { failures: streak } = failureStreak(runs.runs);
  const episode = streak[streak.length - 1].id;
  const quoted = firstError !== undefined && "line" in firstError ? `: ${firstError.line.slice(0, 100)}` : "";
  return { episode, title: `Release failed on ${repo}${quoted}`,
    body: [`release.yml on ${repo}'s main FAILED: run ${verdict.id} (${verdict.event}) at ${verdict.sha.slice(0, 9)}, ${failedJobsText(runs.jobs)}.`,
      `The run's ${firstErrorText(firstError)}.`, `Failed releases in a row: ${streak.length}. ${pendingText(runs.pending)}.`, verdict.url, "",
      `Incident: ${RELEASE_INCIDENT_KEY}`, `Release-failure: ${repo}@${episode}`, "",
      `Raised by the gate's \`${SIGNALS.RELEASE_FAILED}\` reading (agent-org#887). A second consecutive failure on ${repo} also wakes \`ceo\`. The gate closes this item when a later release.yml run on ${repo} succeeds.`].join("\n") };
}

/**
 * RAISE THE INCIDENT OF EACH FAILED RELEASE, ONCE, AND CLOSE IT WHEN THAT REPOSITORY RELEASES AGAIN. `tracker` is where incidents live (the project's tracker, as the canary's and the fleet's are). An item is
 * found by its `Release-failure:` line: an OPEN one for the repository (any streak: a streak that slid out of the run window must not be filed again) or a CLOSED one for the same streak (a person who
 * closed it did not ask for it again) means nothing is filed. A list that cannot be read files nothing and closes nothing: absence is not proof. Reads only when a repository's newest verdict is a failure
 * or a success, and NEVER THROWS.
 * @returns the titles filed and the numbers closed, for the caller's log
 */
export function fileReleaseIncidents(failures: ReleaseFailureRead[], { run, tracker, say = (line: string) => { process.stderr.write(line); } }:
  { run: (args: string[]) => string; tracker: string; say?: (line: string) => void; }): { filed: string[]; closed: number[] } {
  const out = { filed: [] as string[], closed: [] as number[] };
  try {
    const failed: { repo: string; episode: number; title: string; body: string }[] = [];
    for (const f of failures) {
      const incident = f.runs === null ? null : releaseIncidentOf({ ...f, runs: f.runs });
      if (incident !== null) failed.push({ repo: f.repo, ...incident });
    }
    const released = new Set(failures.flatMap(({ repo, runs }) => (runs !== null && newestReleaseVerdict(runs.runs)?.conclusion === "success" ? [repo] : [])));
    if (failed.length === 0 && released.size === 0) return out;
    const open = openIncidentsOf(tracker, run);
    if (open === null) {
      say(`org-health: ${SIGNALS.RELEASE_FAILED} could not read the open incidents of ${tracker}, so none is filed or closed this tick.\n`);
      return out;
    }
    const openFor = (repo: string) => open.some((item) => releaseFailureOf(item.body)?.repo === repo);
    for (const item of open) {
      const named = releaseFailureOf(item.body);
      if (named === null || !released.has(named.repo)) continue;
      closeIncident(tracker, item.number, `release.yml on ${named.repo}'s main succeeded again, so the failure this was raised for is over.`, run);
      out.closed.push(item.number);
    }
    for (const { repo, episode, title, body } of failed) {
      if (openFor(repo)) continue;
      const closed = closedIncidentsOf(tracker, run);
      if (closed === null) {
        say(`org-health: ${SIGNALS.RELEASE_FAILED} could not read the closed incidents of ${tracker}, so the incident of ${repo} is not filed this tick.\n`);
        continue;
      }
      if (closed.some((item) => { const named = releaseFailureOf(String(item?.body ?? "")); return named?.repo === repo && named.episode === episode; })) continue;
      createIncident(tracker, { title, body }, run);
      out.filed.push(title);
    }
  } catch (err) {
    say(`org-health: ${SIGNALS.RELEASE_FAILED} could not file its incident (${String((err as any)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS)}).\n`);
  }
  return out;
}

/** An open build incident, as `readFleetBuildIncidents` keeps it: its body was read for the line and is not kept. `createdAt` is ISO, as the API gives it. */
export type FleetBuildIncident = { number: number; title: string; createdAt: string; };

/**
 * THE FACT FOR `fleetBuildMixedReading` (#4405): ONE REST CALL on the core pool for the OPEN issues labelled `incident` in `repo`, KEPT WHEN THEIR BODY CARRIES
 * {@link FLEET_BUILD_INCIDENT_LINE} on a line of its own. A pull request is not an incident and is dropped. `null` is a refused or unparseable list, a stated unknown and never "no incident".
 */
export function readFleetBuildIncidents(run: (args: string[]) => string, repo: string): FleetBuildIncident[] | null {
  const issues = openIncidentsOf(repo, run);
  if (issues === null) return null;
  return issues.filter((issue) => typeof issue.body === "string" && issue.body.split(/\r?\n/).some((line) => line.trim() === FLEET_BUILD_INCIDENT_LINE))
    .map(({ number, title, createdAt }) => ({ number, title, createdAt }));
}

/** The box count the incident's title names (`Mixed Windows build across the fleet: <n> boxes behind <target>`), as the reading says it. */
const boxesBehindOf = (title: string): string => {
  const count = /(\d+) boxes? behind/.exec(title);
  return count ? `${count[1]} boxes behind` : "box count not in its title";
};

/**
 * SIGNAL 22 (#4405, the chairman's ruling): THE FLEET HAS STAYED ON MIXED WINDOWS BUILDS FOR `FLEET_BUILD_MIXED_HOURS`. An OPEN incident issue IS the stopped line: `fleet-watch` files it on the
 * first mismatch, and it is closed only when the fleet reads one build, so an open one over the bound is a fleet that did not move forward. `incident` is {@link readFleetBuildIncidents}' answer,
 * `null` for a refused read, which is unknown and NEVER clear. An incident with no creation time makes the answer unknown unless another trips, as the sibling readings do.
 */
export function fleetBuildMixedReading({ now, incident }: { now: number; incident: FleetBuildIncident[] | null; }): Reading {
  const signal = SIGNALS.FLEET_BUILD_MIXED;
  if (incident === null) return unknown(signal, "the open incident issues could not be read, so whether the fleet is on one Windows build is not known");
  if (incident.length === 0) return clear(signal);
  const dated = incident.map((issue) => ({ issue, openedAt: Date.parse(issue.createdAt) }));
  const over = dated.filter(({ openedAt }) => Number.isFinite(openedAt) && now - openedAt >= FLEET_BUILD_MIXED_HOURS * MS_PER_HOUR).sort((a, b) => a.openedAt - b.openedAt);
  if (over.length === 0) {
    const undated = dated.filter(({ openedAt }) => !Number.isFinite(openedAt));
    return undated.length === 0 ? clear(signal)
      : unknown(signal, `${undated.length} open incident(s) carry no creation time, so how long the fleet has been mixed is not known`);
  }
  const oldest = over[0];
  const named = over.slice(0, MAX_NAMED).map(({ issue, openedAt }) => `#${issue.number} (${boxesBehindOf(issue.title)}, open ${ageText(openedAt, now)})`);
  const more = over.length > MAX_NAMED ? `, and ${over.length - MAX_NAMED} more` : "";
  return { signal, status: "tripped", firstTrippedAt: oldest.openedAt + FLEET_BUILD_MIXED_HOURS * MS_PER_HOUR,
    discriminator: `${signal}@${oldest.issue.number}`,
    detail: `${over.length} build incident(s) have stood open over ${FLEET_BUILD_MIXED_HOURS} h with the fleet still on mixed Windows builds: ${named.join("; ")}${more}` };
}

/**
 * SIGNAL 21 (#4128, class fix for a11ign/a11ign#4084): A DORA REPOSITORY'S `main` HOLDS A SHIPPED-PATH COMMIT THAT NO RELEASE CARRIES, AND THE OLDEST IS OVER 24 HOURS OLD. Beside
 * `release-run-failed` (signal 18), which sees a release that ran and failed; this sees one that never started. ONE READING PER TRIPPED REPOSITORY, each with its own discriminator
 * (`release-behind-main@<repo>@<oldest sha>`), so a later commit does not re-raise it and one repository's order does not re-key another's. The verdicts are `release-behind-main.ts`'s.
 * A repository whose read was refused is UNKNOWN, never clear, and its being unknown does not hide another's trip: a trip and the unknowns are both returned.
 */
export function releaseBehindReadings({ now, behind }: { now: number; behind: import("./release-behind-main.ts").RepoFact[] | null; }): Reading[] {
  const signal = SIGNALS.RELEASE_BEHIND_MAIN;
  if (behind === null) return [unknown(signal, "the dora repositories could not be listed, so no repository is known to be level with its releases")];
  const verdicts = behind.map((fact) => repoVerdict(fact, now));
  const tripped = verdicts.flatMap((v) => (v.verdict === "tripped"
    ? [{ signal, status: ("tripped" as const), firstTrippedAt: v.firstTrippedAt, discriminator: `${signal}@${v.discriminator}`, detail: v.detail }] : []));
  const unread = verdicts.filter((v) => v.verdict === "unknown");
  const unreadReading = unread.length === 0 ? [] : [unknown(signal, `${unread.map((v) => v.detail).join("; ")}, so those repositories are not known to be level with their releases`)];
  return tripped.length === 0 && unread.length === 0 ? [{ ...clear(signal), detail: verdicts.map((v) => v.detail).join("; ") }] : [...tripped, ...unreadReading];
}

/**
 * SIGNAL 20 (#4126, child B of #4122): A SECOND CLOSED ROW UNDER ONE `class:<id>` LABEL, WHICH MEANS THE CLASS'S GUARD FAILED. One reading PER CLASS, so each class has its own
 * discriminator and a class whose offer lapses cannot re-key another's. THE DISCRIMINATOR IS THE CLASS AND ITS NEWEST ROW (`class-repeat/<id>@<number>`): the same newest row is the
 * same order, and a THIRD row is a new newest row and a new offer. A closed row stays closed, so the condition never clears on its own and an order for it would be re-sent every
 * two hours; it is therefore TRIPPED only while the newest instance closed within `CLASS_REPEAT_WINDOW_MS` (see there), and is `clear` after, which is what makes it one offer.
 *
 * WHAT IT WILL NOT DO. A label naming no class in the index is `unknown class`, reported by name and in no way a class (a typo must not invent a repeat, and must not hide one: the row
 * stays unread until relabelled). A refused read of the labels or the file is `unknown`, never "no repeats". An OPEN row is not an instance (`readClassRepeat` lists closed rows only).
 * The detail ends with the instance counts of every class read, so "which class has the most" is printed beside the offer.
 */
export function classRepeatReadings({ now, classRepeat }: { now: number; classRepeat: import("./class-repeat.ts").ClassRepeatFact | null; }): Reading[] {
  const signal = SIGNALS.CLASS_REPEAT;
  if (classRepeat === null) return [unknown(signal, "the closed rows labelled class:<id> could not be read, so no class is known to be free of a repeat")];
  if ("unreadable" in classRepeat) return [unknown(signal, `${classRepeat.unreadable}, so no class is known to be free of a repeat`)];
  const ledger = classRepeat.ledger;
  const groups = groupByClass(classRepeat.index, classRepeat.rows, Array.isArray(ledger) ? ledger : []);
  const ledgerGap = ledger === undefined || Array.isArray(ledger) ? [] : [unknown(signal, `${ledger.unreadable}, so no event kind is known to be free of a repeat`)];
  const undated = groups.flatMap((g) => g.rows).filter((row) => row.closedAt === null);
  if (undated.length > 0) return [unknown(signal, `closed row(s) ${[...new Set(undated.map((r) => `#${r.number}`))].join(", ")} carry a class label and no close time, so their order cannot be read`), ...ledgerGap];
  const strangers = groups.filter((g) => g.entry === null);
  const fresh = groups.filter((g) => g.entry !== null && occurrencesOf(g) >= 2 && now - (newestOccurrence(g).at as number) <= CLASS_REPEAT_WINDOW_MS);
  const covered = fresh.filter((g) => rowCovering(classRepeat, g) !== null);
  const tripped = fresh.filter((g) => !covered.includes(g));
  const counts = classCountsText(groups);
  const strangerText = strangers.map((g) => `\`${CLASS_LABEL_PREFIX}${g.id}\` on ${rowsText(g.rows)}`).join("; ");
  const unknownClass = `unknown class (in no way a class, tripping nothing): ${strangerText} (not in ${FAILURE_CLASSES_PATH}: fix the label or add the class)`;
  const beside = [counts, ...(strangers.length > 0 ? [unknownClass] : [])].join("; ");
  if (tripped.length > 0) return [...tripped.map((g) => classRepeatTripped(signal, g, beside, classRepeat.filings?.[g.id])), ...ledgerGap];
  if (strangers.length > 0) return [unknown(signal, unknownClass), ...ledgerGap];
  if (covered.length > 0) return [{ ...clear(signal), detail: covered.map((g) => `class \`${g.id}\` repeated and was filed as ${rowCovering(classRepeat, g)}`).join("; ") }, ...ledgerGap];
  return [clear(signal), ...ledgerGap];
}

/** The row a repeating group's class was already filed as, when that row covers the group's NEWEST occurrence (a later occurrence is a new offer, not covered); else `null`. */
function rowCovering(classRepeat: { filings?: Record<string, import("./class-repeat.ts").Filing> }, group: import("./class-repeat.ts").ClassGroup): string | null {
  const filing = classRepeat.filings?.[group.id];
  return filing !== undefined && "filed" in filing && filing.covers === newestOccurrence(group).key ? filing.filed : null;
}

const rowsText = (rows: import("./class-repeat.ts").ClassRow[]): string => rows.map((r) => `#${r.number}`).join(", ");

/** @returns what the group holds: its closed rows, and its failure-ledger refs when it has any */
function occurrencesText(group: import("./class-repeat.ts").ClassGroup): string {
  if (group.events.length === 0) return `${group.rows.length} closed rows, ${rowsText(group.rows)}, newest first`;
  const rows = group.rows.length === 0 ? "" : `${group.rows.length} closed rows ${rowsText(group.rows)}, newest first; `;
  return `${occurrencesOf(group)} occurrences (${rows}${group.events.length} failure-ledger refs: ${group.events.join(", ")})`;
}

/** @returns every class read with its instance count, the most first */
function classCountsText(groups: import("./class-repeat.ts").ClassGroup[]): string {
  const counted = groups.filter((g) => g.entry !== null).sort((a, b) => occurrencesOf(b) - occurrencesOf(a) || a.id.localeCompare(b.id));
  return `instances per class, most first: ${counted.map((g) => `${g.id} ${occurrencesOf(g)}`).join(", ")}`;
}

/** What the class row said about this offer: it was refused (and why, so `ceo` knows nothing was filed), or it exists for an EARLIER occurrence. Empty when nothing was tried. */
function filingText(filing: import("./class-repeat.ts").Filing | undefined): string {
  if (filing === undefined) return "";
  return "refused" in filing
    ? `THE CLASS ROW WAS NOT FILED: \`row-file\` refused (${filing.refused}), so nobody has it. `
    : `A class row, ${filing.filed}, was filed for an earlier occurrence and does not cover this one. `;
}

function classRepeatTripped(signal: string, group: import("./class-repeat.ts").ClassGroup, beside: string, filing?: import("./class-repeat.ts").Filing): Reading {
  const entry = (group.entry as import("./class-repeat.ts").FailureClass);
  const guard = entry.guard ?? `NONE IN FORCE (${entry.guardNote ?? "the index says nothing more"}), so the first thing to fix is that there is no guard`;
  const { at, key } = newestOccurrence(group);
  return { signal, status: "tripped", firstTrippedAt: at, discriminator: `${signal}/${group.id}@${key}`,
    detail: `THE GUARD FAILED: class \`${group.id}\` (${entry.name}) has ${occurrencesText(group)}, and a second occurrence under one class is a repeat. `
      + `Its guard: ${guard}. ${filingText(filing)}${beside}` };
}

/**
 * One OPEN row of the primary milestone. `state` is why nobody is building it (`parked`, `date-held`, `blocked by #7`, `ready, unclaimed` ...) and `owes` who owes its next move.
 */
export type ClockRow = { number: number, createdAt: number | null, claimed: boolean, state: string, owes: string, epic?: boolean };
/**
 * `primaries` are the milestones marked `Primary: yes` that the open rows name, `rows` the open rows of the one primary (empty unless there is exactly one), `prsClose` the row numbers open pull requests declare they close (`null`: the pull requests were not read), and `endedAt` when the last claim or pull request ended (`null`: not read).
 */
export type MilestoneClockFact = { primaries: { number: number, title: string }[], rows: ClockRow[], prsClose: number[] | null, endedAt: number | null };

/**
 * SIGNAL: THE PRIMARY MILESTONE HAS OPEN ROWS AND NOTHING CLAIMED OR IN A PULL REQUEST FOR `MILESTONE_CLOCK_MINUTES` (#4231). The outcome clock runs on open PRs and CLAIMED
 * rows, so a milestone whose rows are all unclaimed, parked or date-held had no clock at all: v3 sat that way for hours on 2026-10-08 and the chairman found it. THIS ONE
 * CLOCKS THE MILESTONE AND NOT AN ITEM, and names the oldest open row with its state and whose move it is: the oldest that is not an `epic`, and the oldest epic only when every open row is one (product-manager's ruling on #4231).
 *
 * THE CLOCK STARTS AT THE LATER OF the last claim or pull request ending (`endedAt`) and the milestone's newest row opening: a row filed ten minutes ago has not been idle.
 * EACH REFUSED READ IS TESTED ONLY WHEN IT COULD MATTER, as `noMergeReading` tests its gap first: a start that has not reached the bound is clear whatever the pull-request
 * read says, so a refusal cannot turn a healthy tick into an unknown. Past it, an unread `endedAt` or an unread pull-request list is UNKNOWN: either could be what restarts it.
 *
 * NO PRIMARY MILESTONE IS CLEAR AND SAYS SO, and so is a primary milestone with no open row (nothing to alarm about). TWO marked primary is UNKNOWN: the rule is one at a time,
 * and a clock that picked one would be answering for `ceo`. THE KEY IS THE MILESTONE AND THE NAMED ROW, so a changed named row re-asks and a later tick naming the same one does not.
 *
 * @param input `fact` is `null` for an open-row list that was not read
 */
export function milestoneClockReading({ now, fact }: { now: number; fact: MilestoneClockFact | null; }): Reading {
  const signal = SIGNALS.MILESTONE_CLOCK;
  if (fact === null) return unknown(signal, "the open rows could not be read, so the primary milestone's rows are not known");
  if (fact.primaries.length > 1) {
    return unknown(signal, `milestones ${fact.primaries.map((m) => m.number).join(" and ")} are all marked \`Primary: yes\`: the rule is one at a time, so the clock does not choose`);
  }
  const [primary] = fact.primaries;
  if (primary === undefined) {
    return { signal, status: "clear", detail: "no open row belongs to a milestone marked `Primary: yes` (none is marked, or the marked one has no open row)" };
  }
  if (fact.rows.length === 0) return { signal, status: "clear", detail: `milestone ${primary.number} has no open row` };
  if (fact.rows.some((r) => r.claimed)) return clear(signal);
  if (fact.rows.some((r) => r.createdAt === null)) return unknown(signal, `a row of milestone ${primary.number} carries no creation time, so when it opened is not known`);
  const rowsOpened = Math.max(...fact.rows.map((r) => (r.createdAt as number)));
  const bound = MILESTONE_CLOCK_MINUTES * MS_PER_MINUTE;
  if (now - rowsOpened < bound) return clear(signal);
  if (fact.endedAt === null) return unknown(signal, `milestone ${primary.number} has been unclaimed since its newest row opened, but when the last claim or pull request ended was not read`);
  const since = Math.max(rowsOpened, fact.endedAt);
  if (now - since < bound) return clear(signal);
  if (fact.prsClose === null) return unknown(signal, `milestone ${primary.number} looks idle, but the open pull requests could not be read`);
  const owned = new Set(fact.rows.map((r) => r.number));
  if (fact.prsClose.some((n) => owned.has(n))) return clear(signal);
  const byAge = [...fact.rows].sort((a, b) => (a.createdAt as number) - (b.createdAt as number) || a.number - b.number);
  const oldest = byAge.find((row) => row.epic !== true) ?? byAge[0]; // an epic is a container, not the next move: named only when every open row is one
  const tripAt = since + bound;
  return { signal, status: "tripped", firstTrippedAt: tripAt, discriminator: `${signal}/${primary.number}@${oldest.number}`,
    detail: `milestone ${primary.number} (${primary.title}) has ${fact.rows.length} open row(s) and none is claimed or in a pull request for ${ageText(since, now)} (since ${isoOf(since)}, bound `
      + `${MILESTONE_CLOCK_MINUTES} min). The oldest open row is #${oldest.number}, ${oldest.state}; the next move is owed by ${oldest.owes}` };
}

/**
 * THE READINGS, in a fixed order: the four of #2936, then the two of #2937 and the outcome clock (#3486, which replaced #2970's) WHEN ITS FACT IS GIVEN. An OMITTED fact (`undefined`) is
 * "this caller does not ask", which is silent; `null` is "asked and refused", which is a stated unknown. The two must not share a
 * value, or a gate that never wired the fleet read would log an unknown every tick for a fault nobody can fix from the log.
 * @param facts `claimRefusals` (agent-org#889) is `readClaimRefusals()`'s answer, which `orgHealthTick` reads itself when the caller gives none; `shelvedCircle` (#4401) is `shelvedCircles`' answer over the shelving list and pull requests the tick already read, `null` for a refused read and OMITTED when the caller does not ask; `milestoneClock` (#4231) is the primary milestone's rows and the pull requests that close them, `null` for a refused open-row read and OMITTED when the caller does not ask; `classRepeat` (#4126) is `readClassRepeat()`'s answer, `null` or `{ unreadable }` for a refused read and OMITTED when the caller does not ask; facts `boardTruth` (#4043) is `boardTruthAudit`'s answer over the rows the tick already read, `null` for a refused read and OMITTED when the caller does not ask; `releaseRuns` (#4001) is `readReleaseRuns()`'s answer, `null` for a refused read and OMITTED when the caller does not ask; `releaseFailures` (agent-org#887) is `readReleaseFailures()`'s answer, one entry per repository the org releases, `null` for a repository list that could not be made and OMITTED when the caller does not ask; WHEN GIVEN IT REPLACES `releaseRuns`' reading; `idle` (#3943) is `idleWithOpenRowsReading`'s answer over the rows the tick already read, OMITTED when the caller does not ask; `stateRows` (#3942) is the open rows the tick already read, `null` for a refused read and OMITTED when the caller does not ask; `autoOff` (#3853) is `readAutoOffRefusal()`'s answer, which `orgHealthTick` reads itself when the caller gives none; `teamAccess` (#3634) is `readTeamAccess()`'s answer, OMITTED when the project declares none; `toolAgreement` (#3533) is `readToolAgreement()`'s answer, OMITTED when the caller does not ask; `pools` (#3448) is the API budgets the tick read, `null` when none was; the order-stall reading is the WAKER's and rides `orderStallOrders`
 */
export function orgHealthReadings(facts: {
        now: number; lastMergedAt: number | null; lastMergedIn?: string | null; work: { greenPrs: number; claimableRows: number; } | null; redPrs: RedPr[] | null;
        /** agent-org#1538: the review-gated red PRs and whether each was asked; OMITTED is "does not ask", `null` a refused read */
        reviewGated?: ReviewGatedPr[] | null;
        refusals: Record<string, { reason: string; ticks: number; }> | null;
        drift: { behind: number; ahead: number; dirty: string[]; } | null; primarySince: number | null;
        fleet?: FleetCaptures | null; waiting?: FleetWaiting | null; copies?: CopyPair[] | null; overdue?: { items: OverdueCandidate[] | null; unread?: string[]; };
        waits?: { stale: Parameters<typeof staleWaitReading>[0]["stale"]; bare: Parameters<typeof waitWithoutReasonReading>[0]["bare"]; manual: number; } | null;
        /** agent-org#1418: each declared repository's last whole read; OMITTED is "does not ask" (a poll host stamps nothing, so the live gate asks only on a webhook host) */
        sweeps?: SweepFact;
        pools?: PoolReading[] | null; toolAgreement?: { result: ToolAgreement; } | null; nodeStrips?: NodeStripFact | null; teamAccess?: TeamAccessFact; autoOff?: AutoOffFact; stateRows?: Parameters<typeof stateLabelReading>[0]["rows"]; idle?: import("./idle-with-open-rows.ts").IdleRows; shelvedCircle?: ShelvedCircle[] | null; releaseRuns?: ReleaseRuns | null; releaseFailures?: ReleaseFailureRead[] | null; fleetBuildIncident?: FleetBuildIncident[] | null; releaseBehind?: import("./release-behind-main.ts").RepoFact[] | null; boardTruth?: Parameters<typeof boardTruthTable>[0] | null; /** agent-org#1670: the pairs offered this tick when `BOARD_TRUTH_PAIR_FLAG` is on (`orgHealthTick` makes them); OMITTED keeps the set-keyed reading. */ boardTruthOffers?: BoardTruthOffer[] | null;
        classRepeat?: import("./class-repeat.ts").ClassRepeatFact | null; milestoneClock?: Omit<MilestoneClockFact, "endedAt"> | null;
        claimRefusals?: ClaimRefusal[] | null;
        /** agent-org#1218: `readRerunsOn5xx()`'s answer, `null` for an unreadable ledger and OMITTED when the caller does not ask (a default read would put a signal into every tick test, #1073). */
        rerunsOn5xx?: RerunOn5xx[] | null;
        /** agent-org#1218: reruns the code host shows (`RerunSeen`), `null` for a refused read and OMITTED when the caller does not ask; read with `rerunsOn5xx`, whose absence makes it unknown. */
        rerunsSeen?: RerunSeen[] | null;
        /**
         * agent-org#1135: `readFlagLedger()`'s answer, `null` for a refused read and OMITTED when the caller does not ask. THE TICK DOES NOT READ IT ITSELF, unlike the copies and the refusal ledger:
         * a default read of the project's declarations put a signal into 25 tests that assert the exact orders of a tick (the shape of agent-org#1073), so the live gate hands it over (`work-gate.ts`).
         */
        flagSwitches?: FlagLedger | null;
        /** agent-org#1208: the tick record's state file as `readTickRecordState` reads it; OMITTED when the caller does not ask, and handed over by the live gate for the reason `flagSwitches` is. */
        tickRecord?: TickRecordState;
        /** agent-org#1208: the tick wall's p50/p95 and the `tick-overran` wakes of the last 24 h (`tickHealthOf`); `null` is a cost file that could not be read, OMITTED is "does not ask". */
        tickHealth?: TickHealth | null;
        /** agent-org#1168: the approved-DIRTY readings. `enabled` is `health.approvedDirty`'s decision; OFF gives no reading, so the caller may always pass it. */
        approvedDirty?: ApprovedDirtyFacts;
        /** agent-org#1248: the approved-REVIEW_REQUIRED reading. `enabled` is `health.approvedRequired`'s decision; OFF gives no reading, so the caller may always pass it. */
        approvedRequired?: ApprovedRequiredFacts;
        /** agent-org#1667: the named classed-OUTSIDE pull requests. `enabled` is `reviews.outsideSessionPr`'s decision; OFF gives no reading, so the caller may always pass it. */
        sessionPrOutside?: SessionPrOutsideFact;
    }): Reading[] {
  const readings = [noMergeReading(facts), redPrReading(facts), refusedRowReading(facts),
    primaryReading({ now: facts.now, drift: facts.drift, since: facts.primarySince })];
  if (facts.fleet !== undefined) readings.push(fleetIdleReading({ now: facts.now, fleet: facts.fleet, waiting: facts.waiting ?? null }));
  if (facts.copies !== undefined) readings.push(copyDriftReading({ pairs: facts.copies }));
  if (facts.overdue !== undefined) readings.push(overdueReading({ now: facts.now, ...facts.overdue }));
  if (facts.reviewGated !== undefined) readings.push(reviewGatedUnaskedReading({ now: facts.now, prs: facts.reviewGated }));
  if (facts.waits !== undefined) {
    readings.push(staleWaitReading({ now: facts.now, stale: facts.waits?.stale ?? null }),
      waitWithoutReasonReading({ now: facts.now, bare: facts.waits?.bare ?? null, manual: facts.waits?.manual }));
  }
  if (facts.pools !== undefined) readings.push(poolLowReading({ pools: facts.pools }));
  if (facts.toolAgreement !== undefined) readings.push(toolVersionReading({ agreement: facts.toolAgreement }));
  if (facts.nodeStrips !== undefined) readings.push(nodeCannotStripReading({ fact: facts.nodeStrips }));
  if (facts.teamAccess !== undefined) readings.push(teamAccessReading({ access: facts.teamAccess }));
  if (facts.sweeps !== undefined) readings.push(sweepOverdueReading({ now: facts.now, sweeps: facts.sweeps }));
  if (facts.autoOff !== undefined) readings.push(autoOffRefusalReading({ now: facts.now, autoOff: facts.autoOff }));
  if (facts.stateRows !== undefined) readings.push(stateLabelReading({ rows: facts.stateRows, now: facts.now }));
  if (facts.boardTruth !== undefined) readings.push(...boardTruthReadings({ audit: facts.boardTruth, day: isoOf(facts.now).slice(0, 10), offers: facts.boardTruthOffers }));
  if (facts.idle !== undefined) readings.push(idleWithOpenRowsSignal({ idle: facts.idle }));
  if (facts.shelvedCircle !== undefined) readings.push(shelvedCircleReading({ circles: facts.shelvedCircle }));
  // agent-org#887: the per-repository reading REPLACES the project-only one when the caller asks for it (the gate does); a caller that gives only `releaseRuns` still gets the old reading
  if (facts.releaseFailures !== undefined) readings.push(...releaseFailureReadings({ failures: facts.releaseFailures }));
  else if (facts.releaseRuns !== undefined) readings.push(releaseFailedReading({ releaseRuns: facts.releaseRuns }));
  if (facts.fleetBuildIncident !== undefined) readings.push(fleetBuildMixedReading({ now: facts.now, incident: facts.fleetBuildIncident }));
  if (facts.releaseBehind !== undefined) readings.push(...releaseBehindReadings({ now: facts.now, behind: facts.releaseBehind }));
  if (facts.classRepeat !== undefined) readings.push(...classRepeatReadings({ now: facts.now, classRepeat: facts.classRepeat }));
  if (facts.milestoneClock !== undefined) readings.push(milestoneClockReading({ now: facts.now, fact: facts.milestoneClock === null ? null : { ...facts.milestoneClock, endedAt: facts.lastMergedAt } }));
  if (facts.claimRefusals !== undefined) readings.push(claimRefusalStormReading({ now: facts.now, refusals: facts.claimRefusals }));
  if (facts.rerunsOn5xx !== undefined) readings.push(requiredRedOn5xxReading({ now: facts.now, reruns: facts.rerunsOn5xx }));
  if (facts.rerunsSeen !== undefined) readings.push(manualRerunsReading({ now: facts.now, seen: facts.rerunsSeen, ledger: facts.rerunsOn5xx ?? null }));
  if (facts.flagSwitches !== undefined) readings.push(flagSwitchReading({ day: isoOf(facts.now).slice(0, 10), ledger: facts.flagSwitches }));
  if (facts.tickRecord !== undefined) readings.push(tickRecordReading({ now: facts.now, state: facts.tickRecord }));
  if (facts.tickHealth !== undefined) readings.push(tickWallReading({ day: isoOf(facts.now).slice(0, 10), health: facts.tickHealth }));
  if (facts.approvedDirty !== undefined) readings.push(...approvedDirtyReadings({ now: facts.now, ...facts.approvedDirty }));
  if (facts.approvedRequired !== undefined) readings.push(...approvedRequiredReadings({ now: facts.now, ...facts.approvedRequired }));
  if (facts.sessionPrOutside !== undefined) readings.push(...sessionPrOutsideReadings({ now: facts.now, ...facts.sessionPrOutside }));
  return readings;
}

/** What a prompt says about each signal, in the chairman's words where they have them. */
const REMEDY = (Object.freeze({
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
  [SIGNALS.REVIEW_GATED_UNASKED]: "A red PR whose failing checks name a review as their remedy has had no reviewer ordered at its head for over two hours. The "
    + "gate has the answer and asked nobody: read why (`gh pr checks <n>`, and the `Cleared-by:` line each named check's summary carries), then order a reviewer "
    + "by hand, or re-lane the PR to a session that can, or make the check name a different remedy if the review is the wrong one.",
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
    + "is not true of it. READ `node src/lib/tool-version-agreement.ts` (or `host:check`) in the tool checkout for the whole list. A `tool` runner is the work-tick's `update-tool`, which should have moved the checkout to "
    + "the newest tag: read the tick's first journal line and why it did not. A `worktree` runner resolves a COPY of the dependency through its `node_modules`: until the removal row (#3534) merges it is the pin, "
    + "and after it a copy that is still there is stale (`pnpm install` in that worktree, or remove it). A `ci` runner names the version the last `ci.yml` run on `main` used: its lockfile's, or the tag its resolver step printed.",
  [SIGNALS.NODE_CANNOT_STRIP]: "Each `node` named cannot strip types (`process.features.typescript` is not `strip` or `transform`, or the binary could not be run), so any unit or script that runs a `.ts` "
    + "file with it dies at start: ADR 0043 Decision 8 chose upstream Node 24 for exactly this. READ `/usr/bin/node -p process.features.typescript` (and the path named), then reinstall upstream Node 24 "
    + "for the agent user (" + homeProjectDeclaration().tracker[0].repo + "#4388) or correct the `ExecStart` that names the wrong binary: a distro `nodejs +dfsg` package is the usual cause and it comes back with an apt upgrade. A host action for `orchestrator`.",
  [SIGNALS.SWEEP_OVERDUE]: "A declared repository has gone unread for longer than the sweep promises, so the pull requests and rows in it wait unseen. Find why its whole read "
    + "is not landing (a refused read or a paced skip in this tick's log, or the webhook queue that should have named it), then FIX IT: the next whole read stamps the repository and clears this.",
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
    + `(\`${READY_LABEL}\` if it is startable, else \`${BACKLOG_LABEL}\`), and for a row in several keep the ONE that is true (\`epic\` REPLACES \`${BACKLOG_LABEL}\`, and so does \`parked\` ONLY while its wait is real: READ the wait first, and a \`Waiting-for:\` that is true, free text or absent, or a passed \`Not-before:\`, leaves \`parked\` untrue, #4230), by hand with the reason on the row. `
    + "Do not script the repair; read `ready:audit`'s `state labels` line for the count against what GitHub reports.",
  [SIGNALS.IDLE_WITH_OPEN_ROWS]: "Nobody is building and rows are open: each row named is the reason it is not being built, from a closed list. MOST ARE STATES THE ORG CHOSE (`BACKLOG`, `PARKED`, `EPIC`, "
    + "`BLOCKED_BY` an open row, `WAITING_FOR` a declared condition, `ANSWER_OWED`, `LANE`, `B4 overlaps`): read whether the one holding the most is still true, and PROMOTE or UNBLOCK it if it is not. "
    + "`NO_STATE_LABEL` and `TWO_STATE_LABELS` are `row-without-exactly-one-state`'s. **`READY_UNOFFERED` IS A DEFECT, NOT A STATE**: a `" + READY_LABEL + "` row the gate has no reason to withhold while no one works, "
    + "so the offer is wrong or is not being taken; read `work:tick`'s own output for it and FILE what you find `" + READY_LABEL + "` WITH AN OWNER in this turn. Rows waiting on a `Not-before:` date are counted and not named. "
    + "It clears the tick an engineer holds a row.",
  [SIGNALS.SHELVED_CIRCLE]: "A row B4 shelves against a pull request that WAITS ON THAT ROW is a circle: the row cannot be claimed while the PR is open on its file, and the PR cannot merge until the row closes. Each row and PR is named above, with the route from the PR "
    + "back to the row and why the PR is not counted as the row's own work. `product-manager` reads it first and breaks the circle at ONE end: the PR declares `Closes:` for the row it is the vehicle of (in a LAYER repository's PR the row is written QUALIFIED, "
    + "`<tracker owner/repo>#<n>`, because a bare number there is that repository's own issue and the gate drops it), or the row's Region is narrowed to files the PR does not touch. Do not lift the PR's hold to escape it: say on the row which end you broke.",
  [SIGNALS.RELEASE_FAILED]: "The newest `release.yml` run on `main` that concluded failed, and no later run has succeeded, so what merged since is NOT released and the tag the org follows is behind. "
    + "The job (and step) are named above: READ THE RUN'S LOG for that step before choosing. A cause that was TRANSIENT (a runner lost, a registry or network error) is retried from the SAME run: "
    + "`gh run rerun <run id> --failed -R <the repository in the URL above>`. A cause FIXED ON `main` since (the run is at an older sha) needs a NEW run, which a rerun of the old one does not give: "
    + "`gh workflow run release.yml --ref main -R <repository>`. If the cause is not fixed yet, FILE THE FIX `" + READY_LABEL + "` WITH AN OWNER in this turn. "
    + "Do not wait for the next changeset: a run is only ever started by a merge that carries one, so waiting leaves it red for as long as nobody merges one. It clears the tick a later run succeeds.",
  [SIGNALS.FLEET_BUILD_MIXED]: "An OPEN `incident` issue whose body carries `" + FLEET_BUILD_INCIDENT_LINE + "` has stood open for " + FLEET_BUILD_MIXED_HOURS + " hours or more, so the fleet has stayed on MIXED Windows builds that long and did not move forward. "
    + "The incident is named above with its box count and its age. READ THE INCIDENT and the fleet's build status before choosing: `fleet-watch` files it on the first mismatch and closes it only when the fleet reads one build. "
    + "Do not close the incident by hand to clear this; the signal clears when the incident is closed by the fleet, and a close the fleet did not earn only hides the mismatch. Offer the fix that moves the lagging boxes to the target build as a row, `" + READY_LABEL + "`, with an owner. "
    + "It clears the tick no open incident is over the bound.",
  [SIGNALS.RELEASE_BEHIND_MAIN]: "A repository's `main` holds a commit on a releasable path that no release carries, and the oldest is over a day old: a consumer is on the old version. The release, the oldest commit "
    + "and its pull request are named above. FIND WHY IT WAS NOT RELEASED before choosing: the pull request carried no changeset (`changeset-required` is the gate that stops that, and this repository may not have adopted it), "
    + "a release run failed after the merge (`release-run-failed` would be tripped too), or the change should not ship and its pull request lacks a `no-release: <reason>` line. Then ADD THE CHANGESET in a pull request "
    + "(`.changeset/<name>.md`) so the release run takes it, or put `no-release: <reason>` in the pull request's body if the change ships nothing, and FILE what you find `" + READY_LABEL + "` WITH AN OWNER in this turn. "
    + "It clears the tick a release is newer than the commit, and a commit a `no-release:` line declares is not counted.",
  [SIGNALS.CLASS_REPEAT]: "A class of failure in `" + FAILURE_CLASSES_PATH + "` now has a SECOND closed row, and a repeat means THE GUARD THE INDEX NAMES FAILED (or, where the guard is `null`, was never in force). "
    + "Do NOT fix the newest instance and stop: that is what the first one got. READ BOTH ROWS and the guard above, and decide which it is: the guard exists and did not fire (find why and fix it, so the NEXT instance is stopped), "
    + "the guard covers a narrower population than the class (widen it), or the second row is not the class at all (remove its `" + CLASS_LABEL_PREFIX + "<id>` label and say why on the row). "
    + "FILE what you find `" + READY_LABEL + "` WITH AN OWNER in this turn, and say on #928 which class it was. It is offered ONCE for this newest row: a third row under the class is a new offer, "
    + "and it stops being repeated after ninety minutes whether or not anyone acted, so the row you file is the record.",
  [SIGNALS.MILESTONE_CLOCK]: "The primary milestone is the chairman's goal, and for longer than two hours no row of it has been claimed or in a pull request: the outcome clock cannot see that, because it clocks only items that are being worked. "
    + "The oldest open row is named with its state and who owes its next move: THAT SESSION READS THIS ALARM, so route it (`" + ANSWER_PREFIX + "<session>` on the row), and do not act on the row yourself unless it is yours. "
    + "A parked or backlog row needs `product-manager` to PROMOTE it or say why not; a date-held row is correctly waiting, so ask whether another row of the milestone could start now; a blocked row's blocker is the row to read. "
    + "It is keyed on the milestone and the named row, so it is re-asked when the named row changes, and it clears the tick a row is claimed or a pull request opens against one.",
  [SIGNALS.WAIT_WITHOUT_REASON]: "Each item named holds a wait (`hold:*`, `" + ANSWER_PREFIX + "*`, the blocked label or `parked`) that says nothing about what it waits for, and nothing "
    + "has moved on it for hours (a `parked` row with no reason is named at once: the park with no reason is the defect). A wait nobody can check is how the 2026-10-02 freeze stood four hours after it ended. Ask its setter what ends it and write "
    + "`Waiting-for: <closed|merged|labelled <label>|unlabelled <label>> <#n>` on it, or remove the wait.",
  [SIGNALS.CLAIM_REFUSAL_STORM]: "More than " + CLAIM_REFUSAL_STORM_REFUSALS + " claims were refused inside " + CLAIM_REFUSAL_STORM_MINUTES + " minutes, so rows are Ready and no engineer can take them, which includes the one who would fix this. "
    + "The most frequent reason is quoted above: READ IT FIRST. A `COULD NOT DETERMINE` / `BEHIND THE RELEASE` reason is the stale-rule guard (`src/row-claim/stale-rule-guard.ts`) refusing from a checkout that is behind the newest release: "
    + "run `update-tool` in the tool checkout, or find why the release did not cut (`release-run-failed`). Any other reason is the claim's own rule: fix the cause or file it `" + READY_LABEL + "` with an owner in this turn, and "
    + "do not clear the signal by editing the ledger, which only hides the storm.",
  [SIGNALS.FLAG_WITHOUT_SWITCH]: "Each flag named shipped without its switch: the code reads it as OFF when absent, so the change it guards is merged and not running, and nobody decided that. "
    + "The chairman's rule (a11ign#928, 2026-10-12) is that a flagged change ships with its a11ign switch row, filed at the same time. For each key, file that row `" + READY_LABEL + "` WITH AN OWNER in this turn "
    + "(or find the one already filed and say so on it), naming the declaration file that carries the key and the value to set. `false` counts as decided, so a flag the org means to leave off is set to `false`, "
    + "not left absent. A flag switched by `machinery:flag` is not counted (`FLAGS_WITH_ANOTHER_HOME`); one that is, and should not be, is a change to that map and not to a declaration.",
  [SIGNALS.TICK_RECORD_UNWRITTEN]: "The tick could not write its record: a slow tick is recorded on one standing row (a comment the tick edits in place) and wakes nobody, so a write that fails is "
    + "this line and not an order per overrun. The reason is quoted above. A `units.tickRecordIssue` that is not declared is a change to the project declaration (`.agent-org/project.json`, the "
    + "first tracker's row); a refused `gh` write is the token or the row, and the next tick retries by itself. Do NOT clear it by deleting `tick-record.json`, which only hides the outage.",
  [SIGNALS.TICK_WALL_HIGH]: "The tick's wall is past its limit at the 95th percentile over the last 24 h: more than one tick in twenty overran. The figures are above (p50, p95, the slow ticks "
    + "recorded on the standing row, and `tick-overran` wakes per day, where slow reads 0 and killed is the one case that still wakes). This is a trend to read, not a tick to act on: open the "
    + "standing row's table (the longest phase of each slow tick is named there) and file one row for the phase that dominates, or say it is the host and not the code. A single overrun is never an order.",
  [SIGNALS.QUEUE_ENTRY_NO_RUN]: "A merge-queue entry's group never got its checks requested, so no run was ever created and the queue sat behind it (a11ign#5227, 50 minutes, 2026-10-12). The gate dequeues and "
    + "re-queues such an entry ONCE with no model turn (flag `queue.queueEntryNoRun`) and counts each; the count above is how often GitHub drops the event. An INCIDENT line is the same pull request with no run AGAIN "
    + "after that one re-queue, which the gate does not repeat: read why it came to (`why`), look at the pull request's merge-queue timeline and the repository's Actions status, re-queue it by hand "
    + "(`gh pr merge <n> --auto --merge` after the dequeue) if the queue is still stuck, and FILE what you find `" + READY_LABEL + "` WITH AN OWNER in this turn. "
    + "A count with no incident needs no act: it is the measurement, and `queue-entry-no-run.json` in the state directory keeps the day's number.",
  [SIGNALS.QUEUE_HEAD_AGE]: "The merge queue's position-1 entry has stood longer than the detector's limit, so everything behind it waits. The detail says whether any run exists on its group: none is "
    + "`queue-entry-no-run`'s shape (the gate re-queues it once, if its flag is on); a run that is queued or hung is the runner or the workflow, and a run that is red leaves the queue by itself. "
    + "Read the entry's pull request and its newest `merge_group` run before choosing, and FILE what you find `" + READY_LABEL + "` WITH AN OWNER in this turn. It clears the tick the head entry is younger than the limit or gone.",
  [SIGNALS.REQUIRED_RED_ON_5XX]: "The tick reran a required check once because its last error was a GitHub 5xx, not the code (`checks rerun on 5xx` in the ledger beside the delivery ledger). "
    + "A count with no incident needs no act: it is the measurement of how often GitHub breaks a required check, and the run ids are in the detail. A day that climbs is GitHub's and goes on the row that owns the rerun.",
  [SIGNALS.MANUAL_RERUNS]: "A person reran a run whose last error was a GitHub 5xx, so the detector did not answer it first: the switch `ci.rerunOn5xx` was off, the tick was not running, or it read the log differently. "
    + "Read each run's log, and if the tick should have rerun it FILE the miss `" + READY_LABEL + "` WITH AN OWNER in this turn; if the switch is simply off, say so on the switch row.",
  [APPROVED_DIRTY_SIGNAL]: "An approved pull request has been DIRTY (it conflicts with main) for more than " + APPROVED_DIRTY_MINUTES + " minutes and nobody has pushed to its head inside that window, so it cannot land and nothing is rebasing it. "
    + "The named PRs are above. Rebase each one onto main, or if its author is away, say so on the PR and name who takes it; a push to the head clears the finding, and so does a merge. "
    + "Do not clear it by approving again, which changes nothing about the conflict.",
  [HOLDS_PER_PR_SIGNAL]: "A pull request carries " + HOLDS_PER_PR + " or more `hold:` labels at once, so each hold is someone's stop on it and nobody is moving it. "
    + "For each named PR, read the holds, drop the ones that are no longer true, and name in a comment the one that still stops it and who lifts it.",
  [SAME_WAY_RERUN_SIGNAL]: "The last two runs on a pull request's head failed the same jobs, so another rerun repeats the same failure and answers nothing. "
    + "Read the failing job's log and fix the cause on the branch; do not rerun the job again until a push changes the code.",
  [APPROVED_REQUIRED_SIGNAL]: "An approved pull request has been held at REVIEW_REQUIRED for more than " + APPROVED_REQUIRED_MINUTES + " minutes, so it cannot land. The approval on its head does not count toward "
    + "the merge rule: usually a permission or a rule that excludes the approving identity, not a failing check. The named PRs are above. Read which rule or permission excludes the approver, say it on each PR, "
    + "and fix that setting (not the PR). A new head, a merge or a close clears the finding. Do not approve again, which changes nothing about the rule.",
}) as Readonly<Record<string, string>>);

/** @returns who is ordered: the signal's first reader if it has one, then `ceo`, who takes every signal */
const readersOf = (signal: string): string[] => [...(FIRST_READERS[signal] ? [FIRST_READERS[signal]] : []), OFFERED_TO];

/**
 * ONE ORDER PER TRIPPED SIGNAL, to `ceo` (and to the signal's first reader where `FIRST_READERS` names one), the numbers in the prompt. THE PROMPT CARRIES THE OTHER TRIPPED SIGNALS, because a
 * session is delivered one order per tick (`repeating-lines.ts`' reason). An unknown or clear reading emits nothing here.
 */
export function orgHealthOrders(readings: Reading[]): { session: string; cause: string; subject: string; discriminator: string; prompt: string; causeKey: string; }[] {
  const tripped = readings.filter((r) => r.status === "tripped" && r.incidentOnly !== true); // agent-org#887: an incident-only reading is raised as an incident and orders no one
  return tripped.flatMap((r) => readersOf(r.signal).map((session) => {
    const others = tripped.filter((o) => o !== r).map((o) => o.signal);
    const when = r.firstTrippedAt ? ` It first tripped at ${isoOf(r.firstTrippedAt)}.` : "";
    return {
      session,
      cause: "org-health",
      subject: r.signal,
      discriminator: (r.discriminator as string),
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
 */
function copiesToCompare(pairs: CopyPair[] | null): CopyPair[] | null | undefined {
  if (pairs !== null && pairs.length > 0 && pairs.every((pair) => pair.originalText === null)) return undefined;
  return pairs;
}

/** agent-org#1670: the state the pair offers read and write: the canary's file, which holds the flag, and `BOARD_TRUTH_PAIRS_FILE`, both in the state directory. */
export type BoardTruthPairIo = { readCanary: () => string | null; readPairs: () => string | null; writePairs: (text: string) => void; };

/** @returns the IO of a real tick: an absent file is `null`, and a write goes through a rename so a killed tick leaves the old file whole (`realCanaryIo`'s rule). */
export function realBoardTruthPairIo(): BoardTruthPairIo {
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  const pairsPath = () => stateEntryPath(BOARD_TRUTH_PAIRS_FILE);
  return {
    readCanary: () => read(stateEntryPath(CANARY_STATE_FILE)),
    readPairs: () => read(pairsPath()),
    writePairs: (text) => {
      const path = pairsPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, text);
      renameSync(`${path}.tmp`, path);
    },
  };
}

/** A pair key is the row number then the question name, as `boardTruthPairOffers` builds it (`5577wait-already-true`). */
const BOARD_TRUTH_PAIR_KEY = /^\d+[a-z][a-z-]*$/;

/**
 * @returns the pairs file as it stands: `{}` when absent. A file that is not an object of pairs, or holds an entry that is not `{offers, lastSeen}` (a whole
 * count of at least 1, a finite clock), THROWS, because a pairs state read wrong would offer every standing pair again, or rewrite a NaN count that offers nothing.
 */
function parseBoardTruthPairs(text: string | null): BoardTruthPairs {
  if (text === null || text.trim() === "") return {};
  const raw = JSON.parse(text) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${BOARD_TRUTH_PAIRS_FILE} is not an object of pairs`);
  for (const [pair, seen] of Object.entries(raw)) {
    const { offers, lastSeen } = (typeof seen === "object" && seen !== null ? seen : {}) as { offers?: unknown; lastSeen?: unknown; };
    const wellFormed = BOARD_TRUTH_PAIR_KEY.test(pair) && typeof offers === "number" && Number.isInteger(offers) && offers >= 1
      && typeof lastSeen === "number" && Number.isFinite(lastSeen);
    if (!wellFormed) throw new Error(`${BOARD_TRUTH_PAIRS_FILE} entry "${pair}" is not {offers, lastSeen} for a row and question`);
  }
  return raw as BoardTruthPairs;
}

/**
 * agent-org#1670: THE PAIR OFFERS OF THIS TICK. `undefined` when the flag is OFF (or its state is unreadable, which reads OFF, `machineryFlagOn`'s rule), so the set-keyed
 * reading stands as it always has; otherwise the offers `boardTruthPairStep` makes, with the pairs file written. A pairs file that cannot be read or written makes NO offer this
 * tick, said on stderr, and the next tick offers again: a state read wrong would forget a pair already offered, so a failure never falls back to the set-keyed order.
 */
export function boardTruthPairOffers({ audit, now, io, log = (line) => process.stderr.write(line) }: { audit: Parameters<typeof boardTruthReading>[0]["audit"]; now: number; io: BoardTruthPairIo; log?: (line: string) => void; }): BoardTruthOffer[] | undefined {
  if (audit === null || audit.findings.length === 0) return undefined;
  let on: boolean;
  try {
    on = machineryFlagOn(parseCanaryState(io.readCanary()), BOARD_TRUTH_PAIR_FLAG);
  } catch (error) {
    log(`org-health: ${CANARY_STATE_FILE} is unreadable (${String((error as Error).message).split("\n")[0].slice(0, MAX_REASON_CHARS)}); ${BOARD_TRUTH_PAIR_FLAG} reads OFF.\n`);
    return undefined;
  }
  if (!on) return undefined;
  try {
    const step = boardTruthPairStep({ pairs: parseBoardTruthPairs(io.readPairs()), present: audit.findings.map((f) => `${f.number}${f.question}`), now });
    io.writePairs(`${JSON.stringify(step.pairs, null, 1)}\n`);
    return step.offers;
  } catch (error) {
    log(`org-health: ${BOARD_TRUTH_PAIRS_FILE} could not be read or written (${String((error as Error).message).split("\n")[0].slice(0, MAX_REASON_CHARS)}) -- no board order this tick; the next tick offers again.\n`);
    return [];
  }
}

/**
 * THE WHOLE TICK: say each unknown on stderr, return the orders. NEVER THROWS -- a detector that can crash the gate stops every
 * order behind it (`repeatingLinesTick`'s rule). Only unknowns are written: a tripped signal's report is its order, and a
 * line written every tick for a standing condition would be offered by `repeating-lines.ts` as a fault of its own.
 * THE COPIES ARE READ HERE, from disk, when the caller gives none: they are files of the checkout the tick runs from, so no
 * caller has them already, and a leaf that reads them keeps `work-gate.ts` out of it. In an extracted tree no original is
 * found, so the reading is left out rather than stated unknown every tick (`copiesToCompare`).
 */
export function orgHealthTick(facts: Parameters<typeof orgHealthReadings>[0], { log = (line) => process.stderr.write(line), readCopies = () => readDeclaredCopies(), readAutoOff = () => readAutoOffRefusal(), readRefusals = () => readClaimRefusals(), boardTruthIo = realBoardTruthPairIo() }: { log?: (line: string) => void; readCopies?: () => CopyPair[] | null; readAutoOff?: () => AutoOffFact; readRefusals?: () => ClaimRefusal[] | null; boardTruthIo?: BoardTruthPairIo; } = {}) {
  try {
    const copies = facts.copies !== undefined ? facts.copies : copiesToCompare(readCopies());
    const autoOff = facts.autoOff !== undefined ? facts.autoOff : readAutoOff();
    const claimRefusals = facts.claimRefusals !== undefined ? facts.claimRefusals : readRefusals();
    const boardTruthOffers = facts.boardTruth === undefined ? undefined : boardTruthPairOffers({ audit: facts.boardTruth, now: facts.now, io: boardTruthIo, log }); // agent-org#1670
    const readings = orgHealthReadings({ ...facts, autoOff, claimRefusals, ...(copies === undefined ? {} : { copies }), ...(boardTruthOffers === undefined ? {} : { boardTruthOffers }) });
    for (const r of readings) if (r.status === "unknown") log(`org-health: ${r.signal} UNKNOWN -- ${r.detail}; it is not read as clear.\n`);
    return orgHealthOrders(readings);
  } catch (err) {
    log(`org-health: could not run (${String((err as any)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS)}) -- no order this tick.\n`);
    return [];
  }
}

// =====================================================================================================================
// MACHINERY CANARY (a11ign#5100): A CHANGE TO THE ORG'S OWN MACHINERY SHIPS BEHIND A FLAG, AND THE GATE WATCHES THE HOUR AFTER IT TURNS ON.
//
// Four regressions on 2026-10-11 were fixes, each green in its tests and broken live, and each found by the chairman: the verify row ran 24 hours after the merge and nothing watched the first hour.
//
//   THE FLAG: a named record in `machinery-canary.json` (the state directory), DEFAULT OFF. A change that touches the gate, claims, the tick, waking, arming, releases or identities reads `machineryFlagOn`
//   and keeps its old behaviour while it is off (`pr-open.ts` refuses such a pull request without a `Flag:`, `Health-signals:` and `Revert:` line). It is state beside the tick's other state rather than a key of a
//   tracked file because THE GATE TURNS IT OFF, and a write to a file of the primary checkout would trip `primary-not-at-main` and could not land past the merge queue.
//   THE SIGNALS: each tick appends ONE SAMPLE of the standard signals (`MACHINERY_SIGNALS`); a signal the tick could not read is `null`, which is not zero and is never counted as clean.
//   THE CANARY: the tick a flag is read `on` with no `onAt` starts it. The hour BEFORE is read from the samples already recorded; the hour AFTER is read as it fills. A signal whose after-count reaches
//   `degradeFactor` times its before-rate, or the day's hourly mean if that is higher (a11ign#5444), and `minRise` more, turns the flag OFF, files an incident carrying both readings, and orders `ceo`. Counts only grow, so a degraded reading half way through the hour is
//   degraded at its end, and the revert need not wait for the hour.
//   THE EXPIRY (`expireSuppressions`): a suppression that keeps an order from its holder for `suppressionMinutes` with no claimed row working its reason hands the holder the reason and the original order.
// =====================================================================================================================

/** The signals every machinery change may name (the row's table). `Health-signals:` is checked against this list, so a signal the gate does not record cannot be promised. */
export const MACHINERY_SIGNALS = Object.freeze({
  CLAIMS_REFUSED: "claims-refused",
  BLIND_TICKS: "blind-ticks",
  WAKES_HELD: "wakes-held",
  APPROVED_UNQUEUED: "approved-unqueued",
  INCIDENTS_NOT_REAL: "incidents-not-real",
  RATE_LIMIT_REFUSALS: "rate-limit-refusals",
  RELEASE_FAILURES: "release-failures",
  OWNERLESS_PR_UNREACHED: "ownerless-pr-unreached", // agent-org#1648: a red pull request the chairman opened with no session on it, that no order reaches for UNQUEUED_MINUTES
  EJECTED_NETWORK_NOT_REQUEUED: "ejected-network-not-requeued", // agent-org#1647: a queue ejection that stayed the owner's although its install failed on the network (`pr-ejected.ts`)
  GH_AUTHOR_FALLBACK: "gh-author-fallback", // agent-org#1666: an account-attributed pr create/merge/review in the ledgers, at most ten minutes old (`gh-author-fallback.ts`)
  VERDICT_WRITTEN_UNDELIVERED: "verdict-written-undelivered",
  CONFLICTING_PR_WORKER_IDLE: "conflicting-pr-worker-idle",
  SESSION_PR_CLASSED_OUTSIDE: "session-pr-classed-outside", // agent-org#1667: a same-repository pull request with a `session:` label classed OUTSIDE for SESSION_PR_OUTSIDE_MINUTES (`outside-session-pr.ts`)
  BOARD_TRUTH: "board-disagrees-with-reality", // agent-org#1670: a row or question the board disagrees with reality on (`boardTruthReadings`); not sampled, see `machineryValues`
});
export const STANDARD_MACHINERY_SIGNALS: readonly string[] = Object.freeze(Object.values(MACHINERY_SIGNALS));
/** The signals no source in this tool reads yet: recorded as `null` every tick, so a change that names one is told it is UNKNOWN and not that it passed. */
export const UNSOURCED_MACHINERY_SIGNALS: readonly string[] = Object.freeze([MACHINERY_SIGNALS.INCIDENTS_NOT_REAL, MACHINERY_SIGNALS.RATE_LIMIT_REFUSALS]);

export const CANARY_STATE_FILE = CANARY_STATE_NAME;
/** The key of `host.json` that carries the options; read as raw JSON so a host that never set it is unchanged. */
export const CANARY_OPTIONS_KEY = "machineryCanary";
/** How long a green, approved pull request may stand unqueued before it counts toward `approved-unqueued` (the row's figure). */
export const UNQUEUED_MINUTES = 15;
/** How long a verdict an outside reviewer WROTE may stand off its pull request before it counts toward `verdict-written-undelivered` (agent-org#1649). */
export const VERDICT_UNDELIVERED_MINUTES = 15;
/** How long a conflicting pull request may wait on an idle owner before it counts toward `conflicting-pr-worker-idle` (agent-org#1649). */
export const CONFLICT_IDLE_MINUTES = 15;
/** How long a same-repository pull request with a `session:` label may be classed OUTSIDE before `session-pr-classed-outside` counts it (agent-org#1667). */
export const SESSION_PR_OUTSIDE_MINUTES = 10;
/** How long a canary's revert order is repeated, as every org-health order is: two hours, then it is the incident that carries it. */
const CANARY_ORDER_HOURS = 2;
/** The samples kept: the hour before and the hour after, and one more hour for a flag turned on late in a tick. */
const SAMPLE_WINDOWS_KEPT = 3;
/** The day a canary's baseline is read over (a11ign#5444): one quiet hour is not the org's norm, so the bar also takes the day's hourly mean. A day that is less than half recorded is unread. */
const BASELINE_MS = 24 * MS_PER_HOUR;

export type CanaryOptions = { enabled: boolean, windowMinutes: number, degradeFactor: number, minRise: number, suppressionMinutes: number };
/** ON BY DEFAULT, because it protects any adopter (the row, change 4). */
export const DEFAULT_CANARY_OPTIONS: Readonly<CanaryOptions> = Object.freeze({ enabled: true, windowMinutes: 60, degradeFactor: 2, minRise: 3, suppressionMinutes: 15 });
const OPTION_BOUNDS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({ windowMinutes: [5, 1440], degradeFactor: [1, 100], minRise: [1, 100000], suppressionMinutes: [1, 1440] });

/**
 * The options of a `host.json`'s text: `machineryCanary: { enabled?, windowMinutes?, degradeFactor?, minRise?, suppressionMinutes? }`. A key that is not one of them, or a value out of its bounds, is a
 * `problem` and the DEFAULTS stand, because a mistyped threshold ignored in silence is a canary that never bites (`project-config.ts`'s rule for `routing`). Absent is the defaults, with no problem.
 */
export function parseCanaryOptions(text: string | null): { options: Readonly<CanaryOptions>, problem: string | null } {
  const fallback = (problem: string | null) => ({ options: DEFAULT_CANARY_OPTIONS, problem });
  if (text === null) return fallback(null);
  let block: unknown;
  try {
    block = (JSON.parse(text) as Record<string, unknown>)[CANARY_OPTIONS_KEY];
  } catch (error) {
    return fallback(`host.json is not JSON (${String((error as Error).message).slice(0, MAX_REASON_CHARS)})`);
  }
  if (block === undefined) return fallback(null);
  if (typeof block !== "object" || block === null || Array.isArray(block)) return fallback(`${CANARY_OPTIONS_KEY} is not an object`);
  const given = block as Record<string, unknown>;
  const unknownKey = Object.keys(given).find((key) => key !== "enabled" && OPTION_BOUNDS[key] === undefined);
  if (unknownKey !== undefined) return fallback(`${CANARY_OPTIONS_KEY}.${unknownKey} is not an option (${["enabled", ...Object.keys(OPTION_BOUNDS)].join(", ")})`);
  if (given.enabled !== undefined && typeof given.enabled !== "boolean") return fallback(`${CANARY_OPTIONS_KEY}.enabled is not true or false`);
  const outOfBounds = Object.keys(OPTION_BOUNDS).find((key) => given[key] !== undefined && !(typeof given[key] === "number" && given[key] >= OPTION_BOUNDS[key][0] && given[key] <= OPTION_BOUNDS[key][1]));
  if (outOfBounds !== undefined) return fallback(`${CANARY_OPTIONS_KEY}.${outOfBounds} must be a number from ${OPTION_BOUNDS[outOfBounds][0]} to ${OPTION_BOUNDS[outOfBounds][1]}`);
  return { options: { ...DEFAULT_CANARY_OPTIONS, ...given } as CanaryOptions, problem: null };
}

/** @returns the options of the host's `host.json`, and the problem with them if there is one; an unreadable file is the defaults and says so. */
export function readCanaryOptions({ path = hostConfigPath(), read = (file) => readFileSync(file, "utf8") }: { path?: string; read?: (path: string) => string; } = {}): { options: Readonly<CanaryOptions>, problem: string | null } {
  try {
    return parseCanaryOptions(read(path));
  } catch (error) {
    return { options: DEFAULT_CANARY_OPTIONS, problem: `${path} could not be read (${String((error as Error).message).split("\n")[0].slice(0, MAX_REASON_CHARS)})` };
  }
}

/**
 * One tick's reading of each signal over the span `from`..`to`; `null` is "not read", never zero. `held` (a11ign#5497) is set when the account pause held Claude work at
 * that tick: a stock read in a held hour is the pause's doing, not the norm, so that hour is no baseline.
 */
export type CanarySample = { from: number, to: number, values: Record<string, number | null>, held?: true };
export type SignalReading = { signal: string, status: "degraded" | "ok" | "unknown", before: number | null, after: number, detail: string };
export type FlagRecord = {
  on: boolean, signals: string[], onAt: number | null, verdict: "watching" | "passed" | "reverted" | null, decidedAt: number | null, readings: SignalReading[], incident: string | null,
};
export type CanaryState = { flags: Record<string, FlagRecord>, samples: CanarySample[], memo: Record<string, number> };

export const emptyCanaryState = (): CanaryState => ({ flags: {}, samples: [], memo: {} });

/** @returns the state of a file's text; an absent file is empty, and one that is not the shape THROWS (a state read wrong would forget a flag that is on). */
export function parseCanaryState(text: string | null): CanaryState {
  if (text === null || text.trim() === "") return emptyCanaryState();
  const raw = JSON.parse(text) as Partial<CanaryState>;
  if (typeof raw !== "object" || raw === null || typeof raw.flags !== "object" || !Array.isArray(raw.samples)) throw new Error(`${CANARY_STATE_FILE} is not { flags, samples, memo }`);
  return { flags: raw.flags ?? {}, samples: raw.samples, memo: raw.memo ?? {} };
}

/** @returns whether a flag is ON: a flag nobody turned on, or one the gate turned off, is OFF. Absence of the record is OFF, so a change reads `false` until it is switched on. */
export const machineryFlagOn = (state: CanaryState, name: string): boolean => state.flags[name]?.on === true;

/** Turn a flag on or off. Turning it ON starts a fresh canary (`onAt` is set by the gate's next tick, which is when the hour begins). PURE. */
export function withMachineryFlag(state: CanaryState, { name, on, signals = STANDARD_MACHINERY_SIGNALS }: { name: string; on: boolean; signals?: readonly string[]; }): CanaryState {
  const record: FlagRecord = { on, signals: [...signals], onAt: null, verdict: null, decidedAt: null, readings: [], incident: null };
  return { ...state, flags: { ...state.flags, [name]: record } };
}

/** The recorded counts of `signal` over `(lo, hi]`, by the sample's end, and the span of that window the samples actually cover. */
function windowOf(samples: CanarySample[], signal: string, [lo, hi]: [number, number]): { sum: number; coveredMs: number; } {
  const read = samples.filter((sample) => sample.to > lo && sample.to <= hi && typeof sample.values[signal] === "number");
  return {
    sum: read.reduce((total, sample) => total + (sample.values[signal] as number), 0),
    coveredMs: read.reduce((total, sample) => total + Math.min(sample.to, hi) - Math.max(sample.from, lo), 0),
  };
}

const oneDecimal = (n: number): number => Math.round(n * 10) / 10;

/**
 * ONE SIGNAL, BEFORE AND AFTER. `before` is the count per window of the hour before `onAt`, scaled by how much of that hour was recorded (and UNKNOWN when less than half of it was: a rate from ten minutes
 * is not a baseline). The BASELINE is the higher of that and the trailing day's hourly mean before `onAt` (a11ign#5444; the day is read only when half of it was recorded). DEGRADED when the after-count so far reaches
 * `degradeFactor` times the baseline and `minRise` more. Because the count only grows, degraded at minute 20 is degraded at minute 60.
 * A signal read as `null` for the whole of a window is UNKNOWN, which is neither degraded nor clean.
 */
export function signalReading({ signal, samples, onAt, now, options }: { signal: string; samples: CanarySample[]; onAt: number; now: number; options: CanaryOptions; }): SignalReading {
  const windowMs = options.windowMinutes * MS_PER_MINUTE;
  const before = windowOf(samples, signal, [onAt - windowMs, onAt]);
  const after = windowOf(samples, signal, [onAt, now]);
  const minutes = (ms: number) => Math.round(ms / MS_PER_MINUTE);
  // A HELD HOUR IS NO BASELINE (a11ign#5497): while the account pause held every Claude order, `wakes-held` read 0 for the whole hour, and the hour after the pause read any steady
  // stock as a surge. Only the hour BEFORE is read here: a pause that begins inside the hour after the flag is on is what the flag exists to catch.
  if (samples.some((sample) => sample.held === true && sample.from < onAt && sample.to > onAt - windowMs)) {
    return { signal, status: "unknown", before: null, after: after.sum, detail: `not a baseline: the account pause held Claude work in the ${options.windowMinutes} min before` };
  }
  if (before.coveredMs < windowMs / 2) {
    return { signal, status: "unknown", before: null, after: after.sum, detail: `${minutes(before.coveredMs)} of the ${options.windowMinutes} min before was recorded, which is not a baseline` };
  }
  const perWindow = (before.sum * windowMs) / before.coveredMs;
  // ONE QUIET HOUR IS NOT THE NORM (a11ign#5444): a zero hour set the bar at 3, the org's own base rate, so three ordinary refusals reverted a flag that cannot touch a claim.
  // The bar is built from the higher of the hour and the day's hourly mean; a day less than half recorded is no baseline, and the hour alone stands.
  const day = windowOf(samples, signal, [onAt - BASELINE_MS, onAt]);
  const dayPerWindow = day.coveredMs >= BASELINE_MS / 2 ? (day.sum * windowMs) / day.coveredMs : null;
  const baseline = Math.max(perWindow, dayPerWindow ?? 0);
  const limit = Math.max(baseline * options.degradeFactor, baseline + options.minRise);
  const status = after.sum >= limit ? "degraded" : now - onAt >= windowMs && after.coveredMs === 0 ? "unknown" : "ok";
  const why = status === "degraded" ? `reached ${oneDecimal(limit)} (${options.degradeFactor}x and +${options.minRise})` : status === "unknown" ? "was not read in the hour after" : `stayed under ${oneDecimal(limit)}`;
  const hour = dayPerWindow !== null && dayPerWindow > perWindow ? `${oneDecimal(perWindow)} in the hour before; 24 h mean ${oneDecimal(dayPerWindow)}/h is the baseline` : `${oneDecimal(perWindow)} in the hour before`;
  return { signal, status, before: oneDecimal(perWindow), after: after.sum, detail: `${hour}, ${after.sum} since (${minutes(now - onAt)} min): ${why}` };
}

/**
 * ONE FLAG'S NEXT RECORD. ON with no `onAt` starts the hour; WATCHING is read against the samples and ends REVERTED (turned off, readings kept) or, an hour on with nothing degraded, PASSED. A flag somebody
 * turned off while it was watched is simply not watched any more. PURE.
 */
export function evaluateFlag({ record, samples, now, options }: { record: FlagRecord; samples: CanarySample[]; now: number; options: CanaryOptions; }): FlagRecord {
  if (!record.on) return record.verdict === "watching" ? { ...record, onAt: null, verdict: null } : record;
  if (record.verdict === "passed") return record;
  const started = record.onAt === null ? { ...record, onAt: now, verdict: "watching" as const } : record;
  const onAt = started.onAt as number;
  const readings = started.signals.map((signal) => signalReading({ signal, samples, onAt, now, options }));
  if (readings.some((reading) => reading.status === "degraded")) return { ...started, on: false, verdict: "reverted", decidedAt: now, readings };
  // Every signal UNKNOWN at the hour's end is not PASSED (a11ign#5497): nothing was read, so nothing was clean. It stays WATCHING, and its readings say why.
  const nothingRead = readings.length > 0 && readings.every((reading) => reading.status === "unknown");
  if (now - onAt >= options.windowMinutes * MS_PER_MINUTE && !nothingRead) return { ...started, verdict: "passed", decidedAt: now, readings };
  return { ...started, verdict: "watching", readings };
}

/** What a tick read: each is `null` when that read was refused or not made, which a sample records as unread. `unarmed` are the numbers of the green, approved pull requests not in the queue. */
export type CanaryFacts = {
  claimRefusals: ClaimRefusal[] | null; unread: string[] | null; deferredWakes: number | null; unarmed: number[] | null; releaseRuns: ReleaseRuns | null;
  /** agent-org#1648: the numbers of the red, chairman-opened pull requests no order reaches; `null` (or absent) when unread. */
  ownerless?: number[] | null;
  /** agent-org#1666: the times (epoch ms) of the account's authoring calls in the ledgers (`accountAuthoringTimes`); `null` (or absent) when unread. */
  authorFallbacks?: number[] | null;
  /** agent-org#1647: the removal times (epoch ms) of the queue ejections that stayed the owner's although the install failed on the network; `null` (or absent) when the arming read was refused. */
  ejectedNetwork?: number[] | null;
  /** agent-org#1649: the times the verdicts an outside reviewer wrote and that are not on their pull request were first written; absent or `null` is unread */
  verdictUndelivered?: number[] | null;
  /** agent-org#1649: the numbers of the conflicting pull requests whose owner is idle this tick; absent or `null` is unread */
  conflictingIdle?: number[] | null;
  /** agent-org#1667: the numbers of the same-repository pull requests with a `session:` label that are classed OUTSIDE this tick (`sessionPrOutsideNow`); absent or `null` is unread */
  sessionPrOutside?: number[] | null;
};

/** The standard signals of one tick over `(since, now]`. A pull request counts as unqueued once the memo has seen it unarmed for `UNQUEUED_MINUTES`; the memo is returned with the departed dropped. */
export function machineryValues({ facts, since, now, memo }: { facts: CanaryFacts; since: number; now: number; memo: Record<string, number>; }): { values: Record<string, number | null>; memo: Record<string, number>; } {
  const inSpan = (at: number) => at > since && at <= now;
  const failedRuns = facts.releaseRuns?.runs.filter((run) => run.conclusion === "failure" && inSpan(Date.parse(run.updatedAt))).length ?? null;
  // A refused read says nothing about the clocks (#1332): when `unarmed` is unread they are kept, not restarted.
  // agent-org#1649: a conflicting pull request's clock is kept the same way `unarmed:`'s is. A verdict's clock is the time it was written, on the record.
  const conflicting = facts.conflictingIdle ?? null;
  const outside = facts.sessionPrOutside ?? null; // agent-org#1667: its own clock, kept the same way the conflict clock is
  const written = facts.verdictUndelivered ?? null;
  const kept = Object.fromEntries(Object.entries(memo).filter(([key]) => !(facts.unarmed !== null && key.startsWith("unarmed:")) && !(facts.ownerless != null && key.startsWith("ownerless:")) && !(conflicting !== null && key.startsWith("conflict:")) && !(outside !== null && key.startsWith("outside:"))));
  const clocks = (keys: string[]) => Object.fromEntries(keys.map((key) => [key, memo[key] ?? now]));
  const seen = clocks((facts.unarmed ?? []).map((pr) => `unarmed:${pr}`));
  const ownerlessSeen = clocks((facts.ownerless ?? []).map((pr) => `ownerless:${pr}`)); // agent-org#1648: its own clock, the same as `unarmed`'s
  const idleSeen = conflicting === null ? null : clocks(conflicting.map((pr) => `conflict:${pr}`)); // agent-org#1649: its own clock, the same as `unarmed`'s
  const outsideSeen = outside === null ? null : clocks(outside.map((pr) => `outside:${pr}`)); // agent-org#1667: its own clock
  const aged = (clock: Record<string, number>, minutes = UNQUEUED_MINUTES) => Object.values(clock).filter((first) => now - first >= minutes * MS_PER_MINUTE).length;
  const unqueued = facts.unarmed === null ? null : aged(seen);
  const idleConflicts = idleSeen === null ? null : aged(idleSeen, CONFLICT_IDLE_MINUTES);
  const classedOutside = outsideSeen === null ? null : aged(outsideSeen, SESSION_PR_OUTSIDE_MINUTES); // agent-org#1667
  const undelivered = written === null ? null : written.filter((at) => now - at >= VERDICT_UNDELIVERED_MINUTES * MS_PER_MINUTE).length;
  return {
    memo: { ...kept, ...seen, ...ownerlessSeen, ...idleSeen, ...outsideSeen },
    values: {
      [MACHINERY_SIGNALS.VERDICT_WRITTEN_UNDELIVERED]: undelivered,
      [MACHINERY_SIGNALS.CONFLICTING_PR_WORKER_IDLE]: idleConflicts,
      [MACHINERY_SIGNALS.SESSION_PR_CLASSED_OUTSIDE]: classedOutside,
      [MACHINERY_SIGNALS.CLAIMS_REFUSED]: facts.claimRefusals === null ? null : facts.claimRefusals.filter((refusal) => inSpan(refusal.at)).length,
      [MACHINERY_SIGNALS.BLIND_TICKS]: facts.unread === null ? null : facts.unread.length > 0 ? 1 : 0,
      [MACHINERY_SIGNALS.WAKES_HELD]: facts.deferredWakes,
      [MACHINERY_SIGNALS.APPROVED_UNQUEUED]: unqueued,
      [MACHINERY_SIGNALS.INCIDENTS_NOT_REAL]: null,
      [MACHINERY_SIGNALS.BOARD_TRUTH]: null, // agent-org#1670: the canary's facts carry no board audit (the gate passes none), so this reads unknown, never zero
      [MACHINERY_SIGNALS.RATE_LIMIT_REFUSALS]: null,
      [MACHINERY_SIGNALS.RELEASE_FAILURES]: failedRuns,
      [MACHINERY_SIGNALS.OWNERLESS_PR_UNREACHED]: facts.ownerless == null ? null : aged(ownerlessSeen),
      // agent-org#1666: counted in the tick whose window holds it, and only while it is at most ten minutes old (a call older than that is not this tick's)
      // agent-org#1647: counted in the tick whose window holds the removal, so a pull request that stays the owner's for hours is one reading and not one a tick
      [MACHINERY_SIGNALS.EJECTED_NETWORK_NOT_REQUEUED]: facts.ejectedNetwork == null ? null : facts.ejectedNetwork.filter(inSpan).length,
      [MACHINERY_SIGNALS.GH_AUTHOR_FALLBACK]: facts.authorFallbacks == null ? null : facts.authorFallbacks.filter((at) => inSpan(at) && now - at <= AUTHOR_FALLBACK_MS).length,
    },
  };
}

/** A flag's two readings, one line a signal: what the incident row and the order to `ceo` both carry. */
export const readingsText = (readings: SignalReading[]): string => readings.map((reading) => `- \`${reading.signal}\` ${reading.status.toUpperCase()}: ${reading.detail}`).join("\n");

export function canaryIncidentText({ name, record }: { name: string; record: FlagRecord; }): { title: string; body: string; } {
  return {
    title: `Machinery flag \`${name}\` was turned off by the canary: ${record.readings.filter((r) => r.status === "degraded").map((r) => r.signal).join(", ")} degraded`,
    body: `The gate turned \`${name}\` OFF at ${isoOf(record.decidedAt as number)}, ${Math.round(((record.decidedAt as number) - (record.onAt as number)) / MS_PER_MINUTE)} minutes after it was turned on at ${isoOf(record.onAt as number)}.\n\n`
      + `BOTH READINGS (the hour before, then what has been counted since):\n${readingsText(record.readings)}\n\nThe change stays in the code and is OFF. The flag is turned back on by whoever fixed the cause, `
      + "which starts a new hour; the pull request that shipped it names its revert. The 24-hour verify row stays as the second reading.\n",
  };
}

/** The order to `ceo` for a flag the gate turned off. Keyed on the flag and the tick it was turned on, so a second revert of the same flag is a second order. */
export function canaryOrder({ name, record }: { name: string; record: FlagRecord; }) {
  return {
    session: OFFERED_TO, cause: "org-health", subject: "machinery-canary", discriminator: `${name}@${record.onAt}`, causeKey: `${OFFERED_TO}/org-health/machinery-canary/${name}@${record.onAt}`, // an existing cause carries it: no new order kind to profile (githubIncidentOrder's rule)
    prompt: `MACHINERY CANARY: THE GATE TURNED \`${name}\` OFF at ${isoOf(record.decidedAt as number)}. A named health signal degraded in the hour after the flag was turned on:\n${readingsText(record.readings)}\n`
      + `${record.incident === null || record.incident === "unfiled" ? "The incident row could not be filed this tick and is retried." : `Incident: ${record.incident}`}\n`
      + "Nothing here is a decision yet: the flag is off, so the machinery is as it was before the change. Read both readings, then fix the cause forward or leave the change off, and say on #928 which. "
      + "It holds for two hours unchanged.",
  };
}

/** One thing that keeps an order from its holder: a hold, deferral, shelving, grouping or a hold label. `order` is the one that was kept back, when the suppressor still has it. */
export type Suppression = { key: string, kind: "hold" | "deferral" | "shelving" | "grouping" | "hold-label", holder: string, reason: string, order: Record<string, any> | null, claimedRow: number | null };

const HELD_PREFIX = "held:";

/**
 * EVERY SUPPRESSION FAILS OPEN. A suppression first seen `minutes` ago with NO CLAIMED ROW working its reason is released: the holder is ordered with the reason and the ORIGINAL ORDER. A suppression with a
 * claimed row is the org working it and is left, however long it stands. The memo is returned holding exactly the suppressions seen this tick, so one that ended starts its clock again if it comes back. PURE.
 * @returns `released` orders to put with the tick's own, and the `memo` to keep
 */
export function expireSuppressions({ suppressed, memo, now, minutes }: { suppressed: Suppression[]; memo: Record<string, number>; now: number; minutes: number; }): { released: Record<string, any>[]; memo: Record<string, number>; } {
  const kept = Object.fromEntries(Object.entries(memo).filter(([key]) => !key.startsWith(HELD_PREFIX)));
  const seen = Object.fromEntries(suppressed.map((entry) => [`${HELD_PREFIX}${entry.key}`, memo[`${HELD_PREFIX}${entry.key}`] ?? now]));
  const due = suppressed.filter((entry) => entry.claimedRow === null && now - seen[`${HELD_PREFIX}${entry.key}`] >= minutes * MS_PER_MINUTE);
  const released = due.map((entry) => {
    const since = seen[`${HELD_PREFIX}${entry.key}`];
    const said = `A ${entry.kind.toUpperCase()} KEPT THIS FROM YOU FOR ${Math.round((now - since) / MS_PER_MINUTE)} MINUTES and nothing claimed was working its reason: ${entry.reason}. THE ORIGINAL ORDER FOLLOWS.\n`;
    if (entry.order !== null) return { ...entry.order, prompt: `${said}${entry.order.prompt ?? ""}` };
    return { session: entry.holder, cause: "org-health", subject: "suppression-expired", discriminator: entry.key, causeKey: `${entry.holder}/org-health/suppression-expired/${entry.key}`, prompt: said };
  });
  return { released, memo: { ...kept, ...seen } };
}

/** The tick's ports: file reads and writes, the incident filer and a way to say something. Each is replaced by a table in a test. */
export type CanaryIo = { read: (path: string) => string | null; write: (path: string, text: string) => void; fileIncident: (title: string, body: string) => string; log: (line: string) => void };

/** @returns the IO of a real tick: an absent file is `null`, a write goes through a rename so a killed tick leaves the old file whole. */
export function realCanaryIo({ fileIncident, log = (line) => process.stderr.write(line) }: { fileIncident: CanaryIo["fileIncident"]; log?: CanaryIo["log"]; }): CanaryIo {
  return {
    fileIncident, log,
    read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
    write: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, text);
      renameSync(`${path}.tmp`, path);
    },
  };
}

/** The incident of a flag the gate turned off, once: `null` when it is filed already, the reference when it is filed now, `"unfiled"` when the filer refused (retried next tick). */
function filedIncident({ name, record, io }: { name: string; record: FlagRecord; io: CanaryIo; }): string | null {
  if (record.verdict !== "reverted" || (record.incident !== null && record.incident !== "unfiled")) return null;
  try {
    const { title, body } = canaryIncidentText({ name, record });
    return io.fileIncident(title, body).trim() || "unfiled";
  } catch (error) {
    io.log(`machinery-canary: could not file the incident for ${name} (${String((error as Error).message).split("\n")[0].slice(0, MAX_REASON_CHARS)}); the next tick retries.\n`);
    return "unfiled";
  }
}

/** @returns the state with this tick's sample appended and every flag evaluated, and the flags that moved to a verdict this tick. */
function advance({ state, facts, now, options, held }: { state: CanaryState; facts: CanaryFacts; now: number; options: CanaryOptions; held: boolean; }): CanaryState {
  const windowMs = options.windowMinutes * MS_PER_MINUTE;
  const since = state.samples.at(-1)?.to ?? now - windowMs; // the first sample backfills one window of the events it can date
  const { values, memo } = machineryValues({ facts, since, now, memo: state.memo });
  // The day's baseline needs a day of samples (a11ign#5444), and a flag's watched hour sits inside it.
  const kept = Math.max(SAMPLE_WINDOWS_KEPT * windowMs, BASELINE_MS + windowMs);
  const samples = [...state.samples, { from: since, to: now, values, ...(held ? { held: true as const } : {}) }].filter((sample) => sample.to > now - kept);
  const flags = Object.fromEntries(Object.entries(state.flags).map(([name, record]) => [name, evaluateFlag({ record, samples, now, options })]));
  return { flags, samples, memo };
}

/**
 * THE GATE'S ONE CALL, PER TICK: sample the signals, evaluate every flag, file the incident of a revert, expire the suppressions, and return the orders. NEVER THROWS -- a canary that can crash the gate
 * stops every order behind it (`orgHealthTick`'s rule). A state file that cannot be read stops the canary this tick and says so; a flag is OFF unless the state says on, so the failure is the safe one.
 * @param tick `suppressed` is what the tick's own suppressors report they are keeping back. ABSENT means the tick did not ask them (a `CANNOT_ASK` tick, #1332): nothing is released and the held-order clocks are kept as they are, not read as ended
 */
export function machineryCanaryTick({ now, facts, suppressed, dir, options, io }: {
  now: number; facts: CanaryFacts; suppressed?: Suppression[]; dir: string; options: CanaryOptions; io: CanaryIo;
}): Record<string, any>[] {
  if (!options.enabled) return [];
  const path = `${dir}/${CANARY_STATE_FILE}`;
  try {
    const before = parseCanaryState(io.read(path));
    // The account pause holds the hour it covers (a11ign#5497): the flag is read from `before`, the state the tick starts with, so it is not unknown here.
    const held = machineryFlagOn(before, ACCOUNT_LIMIT_FLAG) && pauseRecorded(now, dir) !== null;
    const moved = advance({ state: before, facts, now, options, held });
    const flags = Object.fromEntries(Object.entries(moved.flags).map(([name, record]) => {
      const incident = filedIncident({ name, record, io });
      return [name, incident === null ? record : { ...record, incident }];
    }));
    const { released, memo } = suppressed === undefined ? { released: [], memo: moved.memo } : expireSuppressions({ suppressed, memo: moved.memo, now, minutes: options.suppressionMinutes });
    io.write(path, `${JSON.stringify({ flags, samples: moved.samples, memo }, null, 1)}\n`);
    const standing = Object.entries(flags).filter(([, record]) => record.verdict === "reverted" && now - (record.decidedAt as number) < CANARY_ORDER_HOURS * MS_PER_HOUR);
    return [...standing.map(([name, record]) => canaryOrder({ name, record })), ...released];
  } catch (error) {
    io.log(`machinery-canary: could not run (${String((error as Error).message).split("\n")[0].slice(0, MAX_REASON_CHARS)}) -- nothing is sampled this tick, and every flag reads as it was set.\n`);
    return [];
  }
}
