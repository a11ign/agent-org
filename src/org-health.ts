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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hostConfigPath } from "./host-config.ts";
import { AUTHOR_FALLBACK_MS } from "./gh-author-fallback.ts";
import { ACCOUNT_LIMIT_FLAG, pauseRecorded } from "./account-limit-record.ts";
import { MAX_REASON_CHARS, MS_PER_HOUR, MS_PER_MINUTE, OFFERED_TO, isoOf } from "./org-health/no-merge-hours.ts";
import { STANDARD_MACHINERY_SIGNALS, machineryFlagOn, parseCanaryState, type CanarySample, type CanaryState, type FlagRecord, type SignalReading } from "./org-health/fleet-build-incident.ts";
import { CANARY_STATE_FILE, type ClaimRefusal } from "./org-health/claim-refusal.ts";
import type { ReleaseRuns } from "./org-health/sweep-fact.ts";
import { MACHINERY_SIGNALS, SESSION_PR_OUTSIDE_MINUTES } from "./org-health/hold-count.ts";

/** The key of `host.json` that carries the options; read as raw JSON so a host that never set it is unchanged. */
export const CANARY_OPTIONS_KEY = "machineryCanary";
/** How long a green, approved pull request may stand unqueued before it counts toward `approved-unqueued` (the row's figure). */
export const UNQUEUED_MINUTES = 15;
/** How long a verdict an outside reviewer WROTE may stand off its pull request before it counts toward `verdict-written-undelivered` (agent-org#1649). */
export const VERDICT_UNDELIVERED_MINUTES = 15;
/** How long a conflicting pull request may wait on an idle owner before it counts toward `conflicting-pr-worker-idle` (agent-org#1649). */
export const CONFLICT_IDLE_MINUTES = 15;
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
 * is not a baseline), except a NEW signal, first recorded inside that hour, whose unrecorded part counts as zero (agent-org#1684). The BASELINE is the higher of that and the trailing day's hourly mean before `onAt` (a11ign#5444; the day is read only when half of it was recorded). DEGRADED when the after-count so far reaches
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
  // A NEW SIGNAL (agent-org#1684): one with no sample of it recorded before the window began, so its first recording falls inside the hour before `onAt` (or after it, which reads nothing).
  // `onAt` fixes that window, so the hour can never fill: the part of it that was not recorded counts as ZERO events, and `before` is the recorded count, unscaled. Nothing read in the hour
  // before is still `unknown`: nothing was clean.
  const windowStart = onAt - windowMs;
  const isNew = before.coveredMs > 0 && !samples.some((sample) => sample.from < windowStart && typeof sample.values[signal] === "number");
  if (!isNew && before.coveredMs < windowMs / 2) {
    return { signal, status: "unknown", before: null, after: after.sum, detail: `${minutes(before.coveredMs)} of the ${options.windowMinutes} min before was recorded, which is not a baseline` };
  }
  const perWindow = isNew ? before.sum : (before.sum * windowMs) / before.coveredMs;
  // ONE QUIET HOUR IS NOT THE NORM (a11ign#5444): a zero hour set the bar at 3, the org's own base rate, so three ordinary refusals reverted a flag that cannot touch a claim.
  // The bar is built from the higher of the hour and the day's hourly mean; a day less than half recorded is no baseline, and the hour alone stands.
  const day = windowOf(samples, signal, [onAt - BASELINE_MS, onAt]);
  const dayPerWindow = day.coveredMs >= BASELINE_MS / 2 ? (day.sum * windowMs) / day.coveredMs : null;
  const baseline = Math.max(perWindow, dayPerWindow ?? 0);
  const limit = Math.max(baseline * options.degradeFactor, baseline + options.minRise);
  const status = after.sum >= limit ? "degraded" : now - onAt >= windowMs && after.coveredMs === 0 ? "unknown" : "ok";
  const why = status === "degraded" ? `reached ${oneDecimal(limit)} (${options.degradeFactor}x and +${options.minRise})` : status === "unknown" ? "was not read in the hour after" : `stayed under ${oneDecimal(limit)}`;
  const hour = dayPerWindow !== null && dayPerWindow > perWindow ? `${oneDecimal(perWindow)} in the hour before; 24 h mean ${oneDecimal(dayPerWindow)}/h is the baseline`
    : isNew ? `${oneDecimal(perWindow)} in the hour before (a new signal: ${minutes(before.coveredMs)} min recorded, the rest zero)`
      : `${oneDecimal(perWindow)} in the hour before`;
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
  /** a11ign#5681: the board offers the tick made (`boardTruthOfferCount`); absent or `null` is unread, which is unknown and never zero */
  boardTruthOffers?: number | null;
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
      [MACHINERY_SIGNALS.BOARD_TRUTH]: facts.boardTruthOffers ?? null, // a11ign#5681: the offers the tick made; unread is unknown, never zero
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
