#!/usr/bin/env node
// @ts-check
// command: org-retro -- the last 24 hours of the org, as numbers, for `ceo`'s daily retrospective (#2938).
//
// CHAIRMAN, 2026-10-01: "why isn't the agent org self healing and doing the boy scout rule? ... surely the ceo should be
// optimising?" The record (#2841, #2842, #2845, #2847, #2853, #2882/#2912) is six rows, each closing the exact instance the
// chairman's session found. THE ORG FIXES WHAT IT IS TOLD ABOUT AND DOES NOT LOOK. Nothing woke `ceo` to look at the org: it ran
// only when the gate named a cause, and no cause measured the org's own health.
//
// SO OPTIMISING IS A SCHEDULED DUTY, AND THE SCHEDULE IS A GATE CAUSE, NOT A CRON (`org-routing-and-timers.md`: a wall-clock
// event is the one legitimate timer, and the tick was never the defect, the tick being a model turn was). `org-retrospective`
// is offered to `ceo` once per UTC date with these numbers ALREADY COMPUTED: no model reads a log, and `ceo` is woken with the
// answer in its prompt rather than to go and look.
//
// THE REPORT HAS A YESTERDAY (#2955): the gate's offer appends one `{date, numbers}` line to `org-retro-readings.jsonl`, and the next report prints,
// per number, the previous reading, the delta and `better | worse | same | no baseline | unknown`. `NUMBERS` is the ONE table that says what each number
// is and which way is better, so a number the report prints with no direction cannot be written (and a fixture that has one goes red).
//
// A LEAF, RELATIVE IMPORTS ONLY, like `repeating-lines.ts`: `work-gate.ts` imports it and runs before any `pnpm install`/build.
//
// EVERY READ CAN BE REFUSED, AND A REFUSED READ IS `unknown`, NEVER 0 (#1286). A retrospective that printed "0 red PRs" because
// the PR list could not be read would be the org's own health reported as good by an absence, which is the defect it exists to find.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stateEntryPath } from "./host-config.ts";
import { ACCOUNT_LIMIT_LOG, accountLimitLogPath } from "./account-limit.ts";
// A LEAF (`claim-labels.ts` imports nothing): the label is read from where it is declared, `repeating-lines.ts`'s own reason.
import { CLAIM_LABEL, CLAIM_RECORD_MARKER, READY_LABEL } from "./claim-labels.ts";
import { brokenChecks, redChecks as redChecksOf, isBrokenRed, isHeldRed, holdsOn } from "./red-pr.ts";
// THE SIBLING ROW'S MODULE (#2939): it DERIVES the count from git and gh and writes no file, so the report calls it rather than reading a path.
import { gatherChanges, readLedger as readHandFixLedger, ledgerLine as handFixLine } from "./hand-fix-ledger.ts";
import { claudeTurns, codexTurns, transcriptFiles } from "./token-audit.ts";
import { refuseUnknownFlags, flagValue } from "./lib/cli-flags.ts";
// THE DORA BLOCK (a11ign/a11ign#3135): measured from the registry and GitHub, per declared repository, by its own leaf module.
import { EMERGENCY_PRIORITY_NOT_HONOURED_KIND, EMERGENCY_PRIORITY_USED_KIND, FAILURE_LEDGER_FILE, SPEC_LINT_REFUSED_KIND, parseFailureLedger, recordFailures, type FailureEntry, type FailureEvent } from "./failure-ledger.ts";
// THE IDLE-CLAIM INCIDENTS (#4642): the pure detector, and the two things its live read borrows -- the gate's idle memory and the herdr listing.
import { IDLE_CLAIM_INCIDENT_MINUTES, idleClaimIncidents, idleClaimedHours, incidentEvents, incidentSummary, type ClaimedRow, type HolderState, type IdleClaim, type IdleClaimIncident } from "./idle-claim-incident.ts";
import { WORKER_STATE_DIR, lastDeliveredTo, readDeclarations } from "./worker-state.ts";
import { IDLE_CLAIMANT_MS, type Agent, type IdlePr } from "./idle-claimant.ts";
// THE ROWS LEFT OPEN AFTER THEIR DELIVERABLE MERGED (#4769): the pure detector, and the claim-record marker its live read borrows.
import { lookupConsumerFile } from "./closes-mismatch-check.ts";
import { safetyCheckDenialEvents, safetyCheckDenials, safetyCheckDenialSummary, type SafetyCheckDenialReading } from "./safety-check-denial-incident.ts";
import { CLOSED_ON_MERGE_NOT_OUTCOME, INERT_OPTION_MINUTES, inertOptionEvents, inertOptionIncidents, inertOptionSummary, type InertOptionReading, type MergedOptionPr } from "./inert-option-incident.ts";
import { MERGED_ROW_OPEN_MINUTES, mergedRowOpenEvents, mergedRowOpenIncidents, mergedRowOpenSummary, type MergedRowOpenIncident, type NamingPr, type OpenRow } from "./merged-row-open-incident.ts";
import { readJsonObject, STALL_STATE_FILE, type StallState } from "./claim-stall.ts";
import { readAgents } from "./herdr-agents.ts";
import { newestPerName } from "./newest-check-run.ts";
import { SESSION_PREFIX } from "./project-vocabulary.ts";
import { correctionsPerDay, correctionsLine } from "./found-by-chairman.ts";
// THE TOP BLOCKER (#4602): the gate's per-tick record of rows shelved behind each holder, summed over the window by its own leaf.
import { BLOCKING_FILE, deadlockSummary, type DeadlockSummary, parseRecord as parseBlockingRecord, topBlocker, type TopBlocker } from "./blocking-impact.ts";
import { readDora, readRepository, doraReport, READ_TIMEOUT_MS, renderDora, doraNumbers, doraDeclarations } from "./dora.ts";
import { homeProjectDeclaration } from "./project-config.ts";
// THE STOCK-ROW READING (#4175): its own leaf, because it asks the tracker per row and a refused read there names the row.
import { unwaitedStockRows, unwaitedLines, ghTrackerReader } from "./unwaited-stock-rows.ts";
import { untieredReadyRows, untieredLines, ghReadyReader, untieredOffer, untieredSweepKey, parseUntieredMemory, UNTIERED_MEMORY_FILE, type UntieredRow } from "./untiered-ready-rows.ts";
import { HAIKU_TIER_LABEL } from "./worker-profile.ts";
// THE "UNDERSPECIFIED" FEEDBACK LOOP (a11ign#5117): a leaf, so the retro stays importable before any install.
// THE PIN/BUMP COUNT (agent-org#1245): the leaf that counts it, and the one flag that puts it on #928 (`machinery:flag`, default OFF).
import { UNNAMED_FIELD, underspecifiedLines, underspecifiedReading, underspecifiedStops, type UnderspecifiedReading } from "./spec-lint.ts";
import { commentsSince } from "./ticket-port/comments-since.ts";
import { readRowsByLabel } from "./ticket-port/rows-by-label.ts"; // #5076: the claimed rows and the merged list are connections, never a search
// THE SHARED-FAILURE LABEL (agent-org#997): the gate's own constant, so the closed rows the retro counts are the rows the gate files.
import { SHARED_FAILURE_LABEL } from "./ci-failure-class.ts";
import { asListJson, readMergedPullRequests, readRowsSince, type SinceRead, SINCE_PAGE_SIZE, WindowCutShort } from "./ticket-port/rows-since.ts";

/** The cause this file feeds (`cause-declaration.ts` declares it), addressed to `ceo`. */
export const RETRO_CAUSE = "org-retrospective";

/** What an unreadable source prints. Never `0`: "could not read" and "none" are different states and never share a value. */
export const UNKNOWN = "unknown";

/** The window every number covers. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MINUTES_PER_HOUR = 60;

/**
 * Minutes one tick stands for. The tick runs about every 2.1 minutes (`repeating-lines.ts` measured it), so 2 UNDERSTATES
 * idle time slightly: the figure is a floor, and a floor is the honest direction for "how long did the org sit idle".
 */
export const TICK_MINUTES = 2;

/** `journalctl`'s own `-o short-iso` line: `2026-10-01T23:14:05+01:00 host unit[pid]: message`. */
const JOURNAL_LINE = /^(\d{4}-\d\d-\d\dT[\d:]+(?:[+-]\d\d:?\d\d|Z)) \S+ [^:]+: (.*)$/;
const TICK_START = /^Starting a11ign-work-tick\.service/;
/** A ready row was offered and no engineer could take it: the org's idle capacity next to claimable work. */
const IDLE_OFFER = /^(?:UNDELIVERED|DEFERRED) \S*\/?ready-row-unclaimed\//;
/** A claim the org took back from its holder. `merged` is the ordinary end of a row, every other reason is a claim that stopped. */
const RELEASE = /^RELEASED #(\d+) \(([^,)]+), ([^)]+)\)/;

/** @param {number} ms @returns {string} the UTC date, `YYYY-MM-DD` */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** @param {number[]} numbers @returns {number | null} `null` for none, never `0` */
export function median(numbers: number[]): number | null {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** @param {number} minutes @returns {string} `1h30m`, or `45m` under an hour */
function duration(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole < MINUTES_PER_HOUR) return `${whole}m`;
  return `${Math.floor(whole / MINUTES_PER_HOUR)}h${String(whole % MINUTES_PER_HOUR).padStart(2, "0")}m`;
}

/**
 * Pull requests merged in the window and the median open-to-merge. `null` input is a refused read.
 * @param {{ number: number, createdAt: string, mergedAt: string }[] | null} merged
 * @param {{ since: number, until: number }} window
 * @returns {{ count: number, medianMinutes: number | null } | null}
 */
export function mergedStats(merged: { number: number; createdAt: string; mergedAt: string; }[] | null, { since, until }: { since: number; until: number; }): { count: number; medianMinutes: number | null; } | null {
  if (merged === null) return null;
  const inWindow = merged.filter((pr) => {
    const at = Date.parse(pr.mergedAt);
    return at >= since && at <= until;
  });
  const minutes = inWindow.map((pr) => (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / MS_PER_MINUTE);
  return { count: inWindow.length, medianMinutes: median(minutes) };
}

/**
 * The most merged PRs one repository's read may return. `gh` pages through them to reach it; the old read stopped at 200, which a multi-repository count
 * reaches in a day. A read that returns this many may have stopped short, so it is `unknown` and never a count that is quietly too low.
 */
export const MERGED_READ_LIMIT = 1000;

/** What a merged-list read says when the window did not fit {@link MERGED_READ_LIMIT}: the rows past it were not seen, so the count is `unknown` and `limitHit` says why. */
export const MERGED_LIMIT_HIT = "limit-hit";

/**
 * One repository's merged pull requests since `since`, as the connection gives them (#5076: `pr list -R repo --search merged:>=` was a GitHub SEARCH). `-R` NAMED the repository
 * because a read with none answers for the working directory's alone; the connection names it in its variables. {@link MERGED_LIMIT_HIT} for a window of more than the limit.
 * @param {string} repo @param {number} since @param {(args: string[]) => any} [read] the seam: parsed JSON, `null` when refused
 */
export function readMergedSince(repo: string, since: number, read: (args: string[]) => any = ghJson): any[] | null | typeof MERGED_LIMIT_HIT {
  try {
    return readMergedPullRequests({ repo, select: "number createdAt", run: runThrough(read), window: { since: new Date(since).toISOString(), maxPages: MERGED_READ_LIMIT / SINCE_PAGE_SIZE } }) as any[];
  } catch (error) {
    return error instanceof WindowCutShort ? MERGED_LIMIT_HIT : null; // any other failure is `unknown`: a refused read, a payload that was not a connection
  }
}

/**
 * The connection readers take a `run` that answers text; this file's seam answers parsed JSON and `null` for a refusal, so the text is its re-serialisation and a refusal is a
 * THROW, the reader's own "could not read" (the cause is not narrated per read, as `ghJson` says).
 * @param {(args: string[]) => any} read @returns {(args: string[]) => string}
 */
const runThrough = (read: (args: string[]) => any) => (args: string[]): string => {
  const answer = read(args);
  if (answer === null) throw new Error("the read was refused");
  return JSON.stringify(answer);
};

/**
 * THE REPOSITORIES WHOSE MERGES ARE COUNTED: the project's primary plus every `dora` entry, the primary first and once (#3593). The primary leads because the
 * count before this change was its alone, and its entry is that old figure.
 * @param {{ repo: string, dora: { repo: string }[] }} declaration @returns {string[]}
 */
export function mergedPopulation({ repo, dora }: { repo: string; dora: { repo: string; }[]; }): string[] {
  return [...new Set([repo, ...dora.map((entry) => entry.repo)])];
}

/**
 * Every population repository's merged list since `since`. `prs` is `null` for one that could not be read, and `limitHit` says why when it was the limit.
 * @param {{ declaration: Parameters<typeof mergedPopulation>[0], since: number, readPrs?: (repo: string, since: number) => any[] | null }} input
 * @returns {{ repo: string, prs: any[] | null, limitHit: boolean }[]}
 */
export function readMerged({ declaration, since, readPrs = (repo, from) => readMergedSince(repo, from) }: { declaration: Parameters<typeof mergedPopulation>[0]; since: number; readPrs?: (repo: string, since: number) => any[] | null | typeof MERGED_LIMIT_HIT; }): { repo: string; prs: any[] | null; limitHit: boolean; }[] {
  return mergedPopulation(declaration).map((repo) => {
    const read = readPrs(repo, since);
    const limitHit = read === MERGED_LIMIT_HIT || (read !== null && read.length >= MERGED_READ_LIMIT);
    return { repo, prs: limitHit ? null : (read as any[] | null), limitHit };
  });
}

/**
 * The merged count over every repository read, and each one's own. THE TOTAL IS `null` WHEN ANY REPOSITORY'S LIST WAS NOT READ: nine merges and an unreadable
 * repository are not nine, and an empty population is not a total of 0.
 * @param {ReturnType<typeof readMerged>} repositories @param {{ since: number, until: number }} window
 */
export function mergedAcross(repositories: ReturnType<typeof readMerged>, window: { since: number; until: number; }) {
  const readAll = repositories.length > 0 && repositories.every((r) => r.prs !== null);
  return {
    total: readAll ? mergedStats(repositories.flatMap((r) => r.prs ?? []), window) : null,
    byRepository: repositories.map(({ repo, prs, limitHit }) => ({ repo, count: mergedStats(prs, window)?.count ?? null, limitHit })),
  };
}

/**
 * The tick journal's lines inside the window, as `{at, message}`. A line that is not in `-o short-iso` shape is dropped, and
 * so is one that falls outside the window.
 * @param {string} text @param {{ since: number, until: number }} window
 * @returns {{ at: number, message: string }[]}
 */
export function journalLines(text: string, { since, until }: { since: number; until: number; }): { at: number; message: string; }[] {
  const lines = [];
  for (const line of text.split("\n")) {
    const match = JOURNAL_LINE.exec(line);
    if (match === null) continue;
    const at = Date.parse(match[1]);
    if (at >= since && at <= until) lines.push({ at, message: match[2] });
  }
  return lines;
}

/**
 * IDLE MINUTES WHILE A CLAIMABLE ROW EXISTED, and what that means precisely: the ticks in which a `ready-row-unclaimed` offer
 * went `UNDELIVERED` or `DEFERRED` (the gate offered a Ready row, and no engineer was idle and allowed to take it; `DEFERRED` is the
 * wait for a seat that is merely busy, which `wake.ts` stopped counting as a fault in a11ign/a11ign#3266 and which is still idle
 * capacity beside claimable work), each counted as `TICK_MINUTES`. INFERRED FROM THE JOURNAL, NOT MEASURED PER SESSION: it says a claimable row waited through a tick, not how
 * many sessions sat idle in it -- so it is a floor on lost time, and the number to read it against is the day before.
 * A TICK STARTED INSIDE A PAUSE (`paused`, from `pausedIntervals`) is not a tick the org could have filled: the Claude allowance held the work, so
 * it is neither counted in `ticks` nor in `idleMinutes`, and its idle offers are counted apart as `pausedIdleMinutes` (excluded, and said so).
 * @param {{ at: number, message: string }[]} lines @param {PausedInterval[]} [paused]
 * @returns {{ ticksWithIdleOffer: number, idleMinutes: number, ticks: number, pausedIdleMinutes: number }}
 */
export function idleStats(lines: { at: number; message: string; }[], paused: PausedInterval[] = []): { ticksWithIdleOffer: number; idleMinutes: number; ticks: number; pausedIdleMinutes: number; } {
  const held = (at: number) => paused.some(({ from, to }) => at >= from && at < to);
  let index = 0; // every tick, paused or not, so each offer is read against its own tick
  let current = -1;
  let inPause = false;
  let ticks = 0;
  const idleTicks = new Set<number>();
  const pausedIdleTicks = new Set<number>();
  for (const { at, message } of lines) {
    if (TICK_START.test(message)) {
      index += 1;
      current = index;
      inPause = held(at);
      if (!inPause) ticks += 1;
    } else if (IDLE_OFFER.test(message) && current > 0) (inPause ? pausedIdleTicks : idleTicks).add(current);
  }
  return { ticksWithIdleOffer: idleTicks.size, idleMinutes: idleTicks.size * TICK_MINUTES, ticks, pausedIdleMinutes: pausedIdleTicks.size * TICK_MINUTES };
}

/** A stretch in which the Claude allowance held Claude work, clipped to the window it was read for. */
export type PausedInterval = { from: number; to: number; };

/**
 * THE CLAUDE PAUSE, read from `account-limit.ndjson`: one `enter` and one `leave` line each time the allowance is spent and resumed, and the pause
 * runs from an `enter` to the next `leave`. An `enter` with NO `leave` after it runs to `until`, the end of the window: the pause has not been said to end.
 * Clipped to the window, so a pause that began before it counts only from its start.
 * @param {string} text the log's text, which the caller has read
 * @param {{ since: number, until: number }} window
 * @returns {PausedInterval[] | null} `null` when a line does not parse: UNKNOWN, never "not paused"
 */
export function pausedIntervals(text: string, { since, until }: { since: number; until: number; }): PausedInterval[] | null {
  const spans: PausedInterval[] = [];
  let open: number | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let event: { kind?: unknown; at?: unknown; } | null;
    try { event = JSON.parse(line); } catch { return null; }
    const at = typeof event?.at === "string" ? Date.parse(event.at) : Number.NaN;
    if (!Number.isFinite(at)) return null;
    if (event?.kind === "enter") open ??= at;
    else if (event?.kind === "leave") { if (open !== null) spans.push({ from: open, to: at }); open = null; }
    else return null;
  }
  if (open !== null) spans.push({ from: open, to: until });
  return spans.map(({ from, to }) => ({ from: Math.max(from, since), to: Math.min(to, until) })).filter(({ from, to }) => to > from);
}

/** The pause read for the window and the window before it: `null` when the log is unknown, and a share of 0 to 1 for each. */
export type PauseReading = { intervals: PausedInterval[]; current: number; previous: number; };

/** @param {PausedInterval[]} intervals @returns {number} the share of a window `WINDOW_MS` long that the intervals cover */
function pausedShare(intervals: PausedInterval[]): number {
  return intervals.reduce((sum, { from, to }) => sum + (to - from), 0) / WINDOW_MS;
}

/**
 * @param {string | null | undefined} text the log's text: `null` when it could not be read, `undefined` when nobody read it (both are unknown)
 * @returns {PauseReading | null}
 */
export function pauseOf(text: string | null | undefined, now: number): PauseReading | null {
  if (text === undefined || text === null) return null;
  const intervals = pausedIntervals(text, { since: now - WINDOW_MS, until: now });
  if (intervals === null) return null;
  const previous = pausedIntervals(text, { since: now - 2 * WINDOW_MS, until: now - WINDOW_MS }) ?? [];
  return { intervals, current: pausedShare(intervals), previous: pausedShare(previous) };
}

/**
 * What a `RELEASED #N (session, reason)` line's reason means for the retro (#4689). Keyed by `ReleaseRequest["why"]` in `claim-stall.ts`,
 * whose union `org-retro-release-reasons.test.ts` parses, so a reason added there without a classification here fails.
 * `voiding` is a claim that stopped moving (the holder went quiet, or its session vanished); the rest are releases that are not stalls:
 * a row finishing (`merged`), a row closed under the holder (`closed`), and a holder who declared a native edge or a date (`blocked`, `wait`).
 */
export const RELEASE_REASON_KINDS: Record<string, "voiding" | "released"> = {
  stalled: "voiding", gone: "voiding", merged: "released", closed: "released", blocked: "released", wait: "released",
};

/**
 * Claims taken back from their holder, by reason, from the journal's `RELEASED #N (session, reason)` lines. Only the reasons
 * {@link RELEASE_REASON_KINDS} calls `voiding` are `voided` (and listed in `byReason`); every other reason except `merged`, which is a row
 * finishing and is not reported, is counted beside them in `otherReleases` so a declared wait does not move the headline number.
 * An unclassified reason is a voiding: a release nobody has explained is worth a reader's attention.
 * @param {{ at: number, message: string }[]} lines
 * @returns {{ voided: number, byReason: Record<string, number>, otherReleases: Record<string, number> }}
 */
export function releaseStats(lines: { at: number; message: string; }[]): { voided: number; byReason: Record<string, number>; otherReleases: Record<string, number>; } {
  // Maps, not plain objects: a journal reason is data, and `constructor` or `__proto__` must count as a reason, not as an inherited property.
  const byReason = new Map<string, number>();
  const otherReleases = new Map<string, number>();
  for (const { message } of lines) {
    const match = RELEASE.exec(message);
    if (match === null || match[3] === "merged") continue;
    const known = Object.hasOwn(RELEASE_REASON_KINDS, match[3]);
    const into = !known || RELEASE_REASON_KINDS[match[3]] === "voiding" ? byReason : otherReleases;
    into.set(match[3], (into.get(match[3]) ?? 0) + 1);
  }
  const voided = [...byReason.values()].reduce((sum, n) => sum + n, 0);
  return { voided, byReason: Object.fromEntries(byReason), otherReleases: Object.fromEntries(otherReleases) };
}

/** The gate's `ci-shared-failure: holding N red order(s) of a shared failure: <subjects>` line (`ci-failure-class.ts`), whose subjects are space-separated. */
const SHARED_HOLD = /^ci-shared-failure: holding \d+ red order\(s\) of a shared failure:((?: \S+)*)$/;
/** The gate's `ci-shared-failure: released N red order(s), their hold is over: <subject> (<why>)...` line. */
const SHARED_RELEASE = /^ci-shared-failure: released \d+ red order\(s\), their hold is over:((?: \S+ \((?:closed|expired|unrecorded)\))*)$/;
const RELEASED_SUBJECT = /(\S+) \((?:closed|expired|unrecorded)\)/g;
/** The failure-ledger class keys of the two shared-failure counts (agent-org#997). Not in `FAILURE_KINDS`, for the reason `CHAIRMAN_LABEL_NOT_CHAIRMAN_KIND` (`failure-ledger.ts`) states. */
export const SHARED_FAILURE_HELD_KIND = "shared-failure-held-then-released";
export const SHARED_FAILURE_NOT_SAME_KIND = "shared-failure-not-same";

/** One red PR the gate held for a shared-failure incident and then released, at the release line's time. */
export type SharedFailureWake = { subject: string; at: number };
/** One shared-failure incident row closed as "not the same failure", at its closing time. */
export type NotSameFailureClosure = { number: number; closedAt: number };

/**
 * THE RED-PR WAKES HELD THEN RELEASED (agent-org#997, split from #5098): a red PR the gate HELD for a shared-failure incident and later RELEASED, read from the gate's own
 * log lines, which `ci-failure-class.ts` writes as the hold happens. The journal is the record of what the gate SAID, so the count is what the org did.
 * A PR is counted ONCE per window, however many holds it had: a PR held, released and held again is one red PR. A release with no hold before it inside the
 * window is not counted, because its hold began before the window and this window did not see it held.
 * @param {{ at: number, message: string }[]} lines @returns {SharedFailureWake[]} in the order they were released
 */
export function sharedFailureWakes(lines: { at: number; message: string; }[]): SharedFailureWake[] {
  const held = new Set<string>();
  const counted = new Set<string>();
  const wakes: SharedFailureWake[] = [];
  for (const { at, message } of lines) {
    const hold = SHARED_HOLD.exec(message);
    if (hold !== null) for (const subject of hold[1].split(" ").filter(Boolean)) held.add(subject);
    const release = SHARED_RELEASE.exec(message);
    if (release === null) continue;
    for (const [, subject] of release[1].matchAll(RELEASED_SUBJECT)) {
      if (!held.has(subject)) continue;
      held.delete(subject);
      if (!counted.has(subject)) { counted.add(subject); wakes.push({ subject, at }); }
    }
  }
  return wakes;
}

/**
 * THE SHARED-FAILURE INCIDENTS CLOSED AS "NOT THE SAME FAILURE" (agent-org#997): a closed `ci-shared-failure` row whose closing comment says so, closed inside the window.
 * NOTHING IN THE CODE WRITES THAT SENTENCE: the closer writes it by hand, so the match is on its words, case-blind. A row with no readable closing time is not counted.
 * @param {{ number: number, closedAt?: string | null, comments?: { body?: string }[] }[]} rows the closed rows, each with its comments
 * @param {{ since: number, until: number }} window @returns {NotSameFailureClosure[]}
 */
export function notSameFailureClosures(rows: { number: number; closedAt?: string | null; comments?: { body?: string; }[]; }[], { since, until }: { since: number; until: number; }): NotSameFailureClosure[] {
  const closures: NotSameFailureClosure[] = [];
  for (const row of rows) {
    const closedAt = Date.parse(row.closedAt ?? "");
    if (!(closedAt >= since && closedAt <= until)) continue; // NaN, an unreadable time, is outside every window
    if ((row.comments ?? []).some((comment) => /not the same failure/i.test(comment.body ?? ""))) closures.push({ number: row.number, closedAt });
  }
  return closures;
}

/** The two counts the report prints. `null` is a read nobody could make (`unknown`, never 0). */
export type SharedFailures = { wakes: SharedFailureWake[] | null; notSameFailure: NotSameFailureClosure[] | null };

/** The ledger events of the two counts: one per wake (a PR and the day it was released) and one per closure (the row), so each is one incident. */
export function sharedFailureEvents({ wakes, notSameFailure }: SharedFailures): FailureEvent[] {
  return [
    ...(wakes ?? []).map(({ subject, at }) => ({ classKey: SHARED_FAILURE_HELD_KIND, ref: `${subject} ${utcDate(at)}` })),
    ...(notSameFailure ?? []).map(({ number }) => ({ classKey: SHARED_FAILURE_NOT_SAME_KIND, ref: `#${number}` })),
  ];
}

/**
 * What the wake ledger says was DELIVERED in the window: `<epochMs>\t<causeKey>[\t...]`, with the three marker lines
 * (`RESET`, `ESCALATED`, `VOIDED`) carrying their key second. THE LEDGER'S FORMAT IS `wake.ts`'s, which this leaf cannot
 * import (`wake` imports the gate), so the shape is read here and `org-retro.test.ts` pins it with a fixture.
 * @param {string} text @param {{ since: number, until: number }} window
 * @returns {{ at: number, key: string, marker: string | null }[]}
 */
export function ledgerEntries(text: string, { since, until }: { since: number; until: number; }): { at: number; key: string; marker: string | null; }[] {
  const markers = new Set(["RESET", "ESCALATED", "VOIDED"]);
  const entries = [];
  for (const line of text.split("\n")) {
    const [stamp, first, second] = line.trim().split("\t");
    const at = Number(stamp);
    if (!Number.isFinite(at) || first === undefined || at < since || at > until) continue;
    entries.push(markers.has(first) ? { at, key: second ?? "", marker: first } : { at, key: first, marker: null });
  }
  return entries;
}

/**
 * Stalls and `org-health` offers, from the ledger: `org-stalled` and `claim-stalled` deliveries, and each `org-health` signal
 * (its causeKey is `ceo/org-health/<signal...>`, so the third segment up to its first `:` names the signal).
 * @param {{ at: number, key: string, marker: string | null }[]} entries
 * @returns {{ orgStalled: number, claimStalled: number, healthBySignal: Record<string, number> }}
 */
export function ledgerStats(entries: { at: number; key: string; marker: string | null; }[]): { orgStalled: number; claimStalled: number; healthBySignal: Record<string, number>; } {
  let orgStalled = 0;
  let claimStalled = 0;
  const healthBySignal: Record<string, number> = {};
  for (const { key, marker } of entries) {
    if (marker !== null) continue;
    const [, cause, subject = ""] = key.split("/");
    if (cause === "org-stalled") orgStalled += 1;
    else if (cause === "claim-stalled") claimStalled += 1;
    else if (cause === "org-health") {
      const signal = subject.split(":")[0];
      healthBySignal[signal] = (healthBySignal[signal] ?? 0) + 1;
    }
  }
  return { orgStalled, claimStalled, healthBySignal };
}

/**
 * How long each BROKEN open PR has been red, as of `now`, from the EARLIEST completion among the red checks that make it broken (`red-pr.ts`:
 * a held PR's own two jobs do not). A PR red only because it is held is not counted: it is returned in `held`, with who holds it and for how
 * long, so the hold is reported and never silently dropped.
 * @param {{ number: number, labels?: any[], statusCheckRollup?: { name?: string, conclusion?: string, completedAt?: string }[] }[] | null} openPrs
 * @param {number} now
 * @returns {{ count: number, medianMinutes: number | null, oldest: { number: number, minutes: number } | null,
 *   held: { number: number, holders: string[], minutes: number | null }[] } | null}
 */
export function redPrStats(openPrs: { number: number; labels?: any[]; statusCheckRollup?: { name?: string; conclusion?: string; completedAt?: string; }[]; }[] | null, now: number): {
    count: number; medianMinutes: number | null; oldest: { number: number; minutes: number; } | null;
    held: { number: number; holders: string[]; minutes: number | null; }[];
} | null {
  if (openPrs === null) return null;
  const reds: { number: number; minutes: number; }[] = [];
  for (const pr of openPrs.filter(isBrokenRed)) {
    const minutes = minutesRed(brokenChecks(pr), now);
    if (minutes !== null) reds.push({ number: pr.number, minutes });
  }
  const held = openPrs.filter(isHeldRed).map((pr) => ({ number: pr.number, holders: holdsOn(pr), minutes: minutesRed(redChecksOf(pr), now) }));
  const oldest = reds.reduce((top, red) => (top === null || red.minutes > top.minutes ? red : top), (null as typeof reds[number] | null));
  return { count: reds.length, medianMinutes: median(reds.map((r) => r.minutes)), oldest, held };
}

/** @param {{ failedAt: number }[]} checks @param {number} now @returns {number | null} null when no check says when it failed */
function minutesRed(checks: { failedAt: number; }[], now: number): number | null {
  const failedAt = checks.map((c) => c.failedAt).filter(Number.isFinite);
  return failedAt.length === 0 ? null : (now - Math.min(...failedAt)) / MS_PER_MINUTE;
}

/**
 * Tokens in the window, from `token-audit.ts`'s reading of the transcripts. `fresh + cacheRead + cacheWrite + output` is every
 * token the model handled; the cache split stays visible in `token-audit` itself, and a figure that dropped `cacheRead` would be
 * wrong by an order of magnitude in the flattering direction.
 * @param {{ at: number, fresh: number, cacheRead: number, cacheWrite: number, output: number, thinking: number }[] | null} turns
 * @param {{ since: number, until: number }} window
 * @returns {{ turns: number, total: number } | null}
 */
export function tokenStats(turns: { at: number; fresh: number; cacheRead: number; cacheWrite: number; output: number; thinking: number; }[] | null, { since, until }: { since: number; until: number; }): { turns: number; total: number; } | null {
  if (turns === null) return null;
  const inWindow = turns.filter((t) => t.at >= since && t.at <= until);
  return { turns: inWindow.length, total: inWindow.reduce((sum, t) => sum + t.fresh + t.cacheRead + t.cacheWrite + t.output + t.thinking, 0) };
}

/** @param {string | null | undefined} text @returns {FailureEntry[] | null} `null` when the ledger was not read or a line of it does not parse: a ledger read wrong is not a count */
function parsedFailureLedger(text: string | null | undefined): FailureEntry[] | null {
  if (text === null || text === undefined) return null;
  try { return parseFailureLedger(text); } catch { return null; }
}

/** The spec lint's refusals in a window (agent-org#1017): the DISTINCT rows, and the lines by field. A line's ref is `#<row> <field> <rule>`. */
type SpecLintRefusalReading = { rows: number; total: number; byField: Record<string, number> };

/** @returns {SpecLintRefusalReading | null} `null` when the ledger was not read or does not parse: a refusal count nobody could read is not a quiet day */
function specLintRefusalsOf(entries: FailureEntry[] | null, { since, until }: { since: number; until: number; }): SpecLintRefusalReading | null {
  if (entries === null) return null;
  const refusals = entries.filter((entry) => entry.classKey === SPEC_LINT_REFUSED_KIND && entry.at >= since && entry.at <= until);
  const byField: Record<string, number> = {};
  for (const { ref } of refusals) {
    const field = ref.split(" ")[1] ?? UNNAMED_FIELD;
    byField[field] = (byField[field] ?? 0) + 1;
  }
  return { rows: new Set(refusals.map(({ ref }) => ref.split(" ")[0])).size, total: refusals.length, byField };
}

/** The report's line beside the underspecified-stops line. `null` is `unknown`, never `0`. */
function specLintRefusedLines(reading: SpecLintRefusalReading | null | undefined): string[] {
  const label = "- Rows refused by the spec lint (24h)";
  if (reading === null || reading === undefined) return [`${label}: unknown (the failure ledger could not be read)`];
  if (reading.total === 0) return [`${label}: 0`];
  const counts = Object.entries(reading.byField).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([field, count]) => `${field} ${count}`).join(", ");
  return [`${label}: ${reading.rows} ${reading.rows === 1 ? "row" : "rows"} (${reading.total} ${reading.total === 1 ? "finding" : "findings"} refused: ${counts})`];
}

/**
 * The emergency-priority lines in a window (a11ign#5032, agent-org#990): `emergency-priority-used` is a label the gate HONOURED and
 * `emergency-priority-not-honoured` is a misuse. The gate writes one line per row and incident, so a DISTINCT ref is one use or one misuse, however many lines carry it.
 */
type EmergencyPriorityReading = { used: number; notHonoured: number };

/** @returns {EmergencyPriorityReading | null} `null` when the ledger was not read or does not parse: a count nobody could read is not a quiet day */
function emergencyPriorityOf(entries: FailureEntry[] | null, { since, until }: { since: number; until: number; }): EmergencyPriorityReading | null {
  if (entries === null) return null;
  const inWindow = entries.filter((entry) => entry.at >= since && entry.at <= until);
  const distinctRefs = (classKey: string) => new Set(inWindow.filter((entry) => entry.classKey === classKey).map(({ ref }) => ref)).size;
  return { used: distinctRefs(EMERGENCY_PRIORITY_USED_KIND), notHonoured: distinctRefs(EMERGENCY_PRIORITY_NOT_HONOURED_KIND) };
}

/** The two emergency-priority lines beside the spec-lint line. `null` is `unknown`, never `0`. */
function emergencyPriorityLines(reading: EmergencyPriorityReading | null | undefined): string[] {
  const unknown = "unknown (the failure ledger could not be read)";
  if (reading === null || reading === undefined) return [`- Emergency-priority honoured uses (24h): ${unknown}`, `- Emergency-priority misuses (24h): ${unknown}`];
  return [`- Emergency-priority honoured uses (24h): ${reading.used}`, `- Emergency-priority misuses (24h): ${reading.notHonoured}`];
}

/**
 * Every number, each `unknown` when its source was refused. `reads` holds the RAW reads (`null` for a refused one), so what is
 * computed here is pure and a test drives it with a fixture window whose answers are checked by hand.
 * @param {{ merged: any[] | null, mergedRepositories?: ReturnType<typeof readMerged> | null, openPrs: any[] | null, journal: string | null, ledger: string | null,
 *   turns: any[] | null, handFixes: ReturnType<typeof readHandFixLedger> | null, readings?: Readings, dora?: ReturnType<typeof readDora> | null,
 *   unwaited?: ReturnType<typeof unwaitedStockRows> | null, untiered?: ReturnType<typeof untieredReadyRows> | null, failureLedger?: string | null, blockingRecord?: string | null }} reads
 * `blockingRecord` absent or `null` is a record nobody read or that could not be parsed: the top-blocker line says `unknown`, never "nothing was shelved".
 * `failureLedger` absent or `null` is a ledger nobody read or that could not be read (a line that does not parse included): the corrections line and the spec-lint refusals line say `unknown`, never `0`.
 * `unwaited` absent or `null` is a stock-row read nobody made or that was refused: `unknown`, never 0.
 * `untiered` absent or `null` is a ready-row read nobody made or that was refused (a tracker that could not be listed included): `unknown`, never 0.
 * IT IS PRINTED AND NOT YET IN `NUMBERS`: `packaging/org-retro.test.ts` requires a bound for every `NUMBERS` id in `ceo.md`'s retrospective section, which is `ceo`'s to word, so the trend waits for that line.
 * `idleClaims` absent or `null` is a read nobody made or that was refused (no listing, no open-PR list): `unknown`, never 0 (#4642).
 * `idleClaimedHours` absent or `null` is a read nobody made or that was refused (a tracker, a repository's pull requests or the declarations could not be read): `unknown`, never 0 (#4957).
 * `mergedRowOpen` absent or `null` is a read nobody made or that was refused (a tracker or repository could not be listed): `unknown`, never 0 (#4769).
 * `inertOptions` absent or `null` is a read nobody made or that was refused (a repository could not be listed): `unknown`, never 0 (agent-org#839).
 * `safetyDenials` absent or `null` is a read nobody made or that found no transcript root: `unknown`, never 0; transcripts it could not read are counted apart (a11ign#4957).
 * `dora` absent is a read nobody asked for (no block); `dora: null` is one that was REFUSED, which prints `unknown`.
 * `merged` is the PRIMARY repository's list alone, the count's definition before #3593, and `mergedRepositories` is every declared one: absent is a project read
 * the old way (the total IS `merged`), `null` is a declaration that could not be read.
 * @param {number} now
 */
export function buildReport(reads: {
        merged: any[] | null; mergedRepositories?: ReturnType<typeof readMerged> | null; openPrs: any[] | null; journal: string | null; ledger: string | null;
        turns: any[] | null; handFixes: ReturnType<typeof readHandFixLedger> | null; readings?: Readings; dora?: ReturnType<typeof readDora> | null;
        unwaited?: ReturnType<typeof unwaitedStockRows> | null; untiered?: ReturnType<typeof untieredReadyRows> | null; failureLedger?: string | null; blockingRecord?: string | null; idleClaims?: IdleClaimIncident[] | null; idleClaimedHours?: IdleClaimedHours | null; mergedRowOpen?: MergedRowOpenIncident[] | null; inertOptions?: InertOptionReading | null; safetyDenials?: SafetyCheckDenialReading | null;
        underspecified?: UnderspecifiedReading | null; closedSharedRows?: any[] | null; accountLimitLog?: string | null;
    }, now: number) {
  const window = { since: now - WINDOW_MS, until: now };
  const lines = reads.journal === null ? null : journalLines(reads.journal, window);
  // the Claude pause (`account-limit.ndjson`): `null` is unknown, and the idle figures are corrected only when it is known
  const pause = pauseOf(reads.accountLimitLog, now);
  const closed = reads.closedSharedRows ?? null;
  const across = reads.mergedRepositories === undefined ? undefined : mergedAcross(reads.mergedRepositories ?? [], window);
  const report = {
    date: utcDate(now),
    window,
    merged: across === undefined ? mergedStats(reads.merged, window) : across.total,
    mergedRepositories: across?.byRepository,
    mergedPrimaryOnly: mergedStats(reads.merged, window),
    idle: lines === null ? null : idleStats(lines, pause?.intervals ?? []),
    pause,
    releases: lines === null ? null : releaseStats(lines),
    stalls: reads.ledger === null ? null : ledgerStats(ledgerEntries(reads.ledger, window)),
    red: redPrStats(reads.openPrs, now),
    tokens: tokenStats(reads.turns, window),
    handFixes: reads.handFixes,
    corrections: correctionsPerDay(parsedFailureLedger(reads.failureLedger), new Date(now)),
    unwaited: reads.unwaited ?? null,
    untiered: reads.untiered ?? null,
    blocking: topBlockerOf(reads.blockingRecord, now),
    circularWaits: circularWaitsOf(reads.blockingRecord, now),
    idleClaims: incidentSummary(reads.idleClaims),
    idleClaimedHours: reads.idleClaimedHours ?? null,
    mergedRowOpen: mergedRowOpenSummary(reads.mergedRowOpen),
    inertOptions: inertOptionSummary(reads.inertOptions),
    safetyDenials: safetyCheckDenialSummary(reads.safetyDenials),
    sharedFailures: { wakes: lines === null ? null : sharedFailureWakes(lines), notSameFailure: closed === null ? null : notSameFailureClosures(closed, window) } satisfies SharedFailures,
    underspecified: reads.underspecified ?? null, // a read nobody made or that was refused is `unknown` in the report, never `none`
    specLintRefused: specLintRefusalsOf(parsedFailureLedger(reads.failureLedger), window),
    emergencyPriority: emergencyPriorityOf(parsedFailureLedger(reads.failureLedger), window),
    dora: reads.dora,
  };
  // `readings` absent is a read nobody made, which says `unknown` and never `no baseline`: only a read that found no file may say that.
  return { ...report, numbers: { ...readingNumbers(report), ...doraNumbers(report.dora) }, previous: previousReading(reads.readings, report.date) };
}

// ---------------------------------------------------------------------------------------------------------------------
// THE NUMBERS, their direction, and the comparison with the previous reading (#2955).

/** The file the report keeps its own readings in, one JSON line per UTC date, beside the wake ledger. */
export const READINGS_FILE = "org-retro-readings.jsonl";

/** @param {number | null | undefined} n @returns {number | null} whole units, `null` staying `null` */
const wholeOrNull = (n: number | null | undefined): number | null => (n === null || n === undefined ? null : Math.round(n));

/**
 * THE ONE TABLE: every number the report trends, which way is better, and where it comes from. A number is `null` when its source was refused
 * or has nothing to say (no merge, so no median), and `null` is never `0`. `of` takes the report as built before `numbers` is attached.
 * @type {readonly { id: string, label: string, better: "lower" | "higher", of: (report: any) => number | null }[]}
 */
export const NUMBERS: readonly { id: string; label: string; better: "lower" | "higher"; of: (report: any) => number | null; }[] = Object.freeze([
  { id: "prsMerged", label: "PRs merged", better: "higher", of: (r) => r.merged?.count ?? null },
  { id: "medianOpenToMergeMinutes", label: "Median open-to-merge (minutes)", better: "lower", of: (r) => wholeOrNull(r.merged?.medianMinutes) },
  { id: "idleMinutes", label: "Idle minutes while a claimable row existed", better: "lower", of: (r) => r.idle?.idleMinutes ?? null },
  { id: "idleClaimedHours", label: "Worker-hours idle on a claimed row with no declaration", better: "lower", of: (r) => r.idleClaimedHours?.hours ?? null },
  { id: "orgStalledWakes", label: "Stalls (org-stalled wakes)", better: "lower", of: (r) => r.stalls?.orgStalled ?? null },
  { id: "claimStalledWakes", label: "Claim-stalled wakes", better: "lower", of: (r) => r.stalls?.claimStalled ?? null },
  { id: "claimStallVoidings", label: "Claim-stall voidings", better: "lower", of: (r) => r.releases?.voided ?? null },
  { id: "orgHealthOffers", label: "org-health offers", better: "lower",
    of: (r) => (r.stalls ? Object.values((r.stalls.healthBySignal as Record<string, number>)).reduce((sum, n) => sum + n, 0) : null) },
  { id: "redPrs", label: "Red PRs now", better: "lower", of: (r) => r.red?.count ?? null },
  { id: "tokensPerMergedPr", label: "Tokens per merged PR", better: "lower",
    of: (r) => (r.tokens && r.merged && r.merged.count > 0 ? Math.round(r.tokens.total / r.merged.count) : null) },
  { id: "handFixes", label: "Hand fixes (last 14d)", better: "lower", of: (r) => r.handFixes?.count ?? null },
  { id: "unwaitedStockRows", label: "Unwaited stock rows", better: "lower", of: (r) => (r.unwaited?.status === "read" ? r.unwaited.count : null) },
]);

/** @param {object} report the report before `numbers` is attached @returns {Record<string, number | null>} */
export function readingNumbers(report: object): Record<string, number | null> {
  return Object.fromEntries(NUMBERS.map((n) => [n.id, n.of(report)]));
}

/** @param {Record<string, unknown>} numbers @returns {string[]} the ids in `numbers` the table gives no direction: a defect, never a default */
export function undeclaredDirections(numbers: Record<string, unknown>): string[] {
  return Object.keys(numbers).filter((id) => !NUMBERS.some((n) => n.id === id));
}

/**
 * `mergedRepositories` is the population PRs-merged counted (#3593); a reading without it counted the primary alone
 */
export type Reading = { date: string, numbers: Record<string, number | null>, mergedRepositories?: string[] };
/**
 * What the readings file said: `none` is a file that is absent or empty (a first day), `unreadable` is one that could not be read or holds no line that parses, and the two NEVER share a verdict. `ioError` marks the unreadable that is the disk's, where appending could write a second line for a date.
 */
export type Readings = { status: "none" | "read" | "unreadable", entries: Reading[], ioError: boolean, text: string };

/** @param {unknown} value @returns {value is Reading} */
function isReading(value: unknown): value is Reading {
  const entry = (value as any);
  return typeof entry?.date === "string" && /^\d{4}-\d\d-\d\d$/.test(entry.date) && typeof entry.numbers === "object" && entry.numbers !== null;
}

/** @param {string} text @returns {Readings} */
export function parseReadings(text: string): Readings {
  const entries: Reading[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (isReading(parsed)) entries.push(parsed);
    } catch { /* a line that is not JSON is skipped; a file where NO line reads is `unreadable` below */ }
  }
  if (text.trim() === "") return { status: "none", entries, ioError: false, text };
  return { status: entries.length === 0 ? "unreadable" : "read", entries, ioError: false, text };
}

/** @param {string} path @returns {Readings} an absent file is a first day; any other failure to read is `unreadable`, never a first day */
export function readReadings(path: string): Readings {
  try {
    return parseReadings(readFileSync(path, "utf8"));
  } catch (err: any) {
    return err?.code === "ENOENT" ? { status: "none", entries: [], ioError: false, text: "" } : { status: "unreadable", entries: [], ioError: true, text: "" };
  }
}

/**
 * The reading to compare against: the latest line from BEFORE `date`. A line for `date` itself is today's own (the offer repeating until it is
 * delivered) and is never its own baseline.
 * @param {Readings | undefined} readings @param {string} date
 * @returns {{ status: "none" | "unreadable" } | { status: "read", date: string, numbers: Record<string, number | null>, mergedRepositories?: string[] }}
 */
export function previousReading(readings: Readings | undefined, date: string): { status: "none" | "unreadable"; } | { status: "read"; date: string; numbers: Record<string, number | null>; mergedRepositories?: string[]; } {
  if (readings === undefined || readings.status === "unreadable") return { status: "unreadable" };
  const earlier = readings.entries.filter((e) => e.date < date).sort((a, b) => (a.date < b.date ? -1 : 1));
  const latest = earlier[earlier.length - 1];
  return latest === undefined ? { status: "none" } : { status: "read", date: latest.date, numbers: latest.numbers, ...(latest.mergedRepositories && { mergedRepositories: latest.mergedRepositories }) };
}

/**
 * `undefined` is a metric with nothing to measure today (no regression opened), which is neither a failure to read nor a 0
 */
export type Verdict = "better" | "worse" | "same" | "no baseline" | "unknown" | "undefined" | "paused";

/** A `worse` read on a day the Claude allowance held work for more than half of is `paused`: the org was not the cause, so it is not filed as a regression. */
const PAUSED_SHARE = 0.5;

/**
 * `unknown` is a number or a previous file that could not be read; `no baseline` is a read that found nothing earlier. Neither is `same`, and
 * neither is a delta against 0: a comparison needs two numbers that were READ.
 * @param {{ better: "lower" | "higher", previous: { status: string, numbers?: Record<string, number | null> }, id: string, current: number | null }} input
 * @returns {Verdict}
 */
export function verdictFor({ better, previous, id, current }: { better: "lower" | "higher"; previous: { status: string; numbers?: Record<string, number | null>; }; id: string; current: number | null; }): Verdict {
  if (previous.status === "unreadable" || current === null) return "unknown";
  const before = previous.numbers?.[id];
  if (previous.status === "none" || before === null || before === undefined) return "no baseline";
  if (current === before) return "same";
  return (current < before) === (better === "lower") ? "better" : "worse";
}

/**
 * Each number the report holds against the previous reading. The population is the REPORT's own `numbers`, so a number with no declared direction
 * is found here, in the report, and printed as a defect. `declarations` are the numbers whose direction is decided at run time: the DORA metrics
 * of the repositories the project declares (`dora.ts`'s own table), each of which may be `undefinedToday`.
 * @param {Record<string, number | null>} numbers @param {ReturnType<typeof previousReading>} previous
 * `pause` (from `pauseOf`) turns a `worse` into `paused` when the pause covers more than half of either window; `null` (unknown) leaves every verdict as it was.
 * @param {readonly { id: string, label: string, better: "lower" | "higher", undefinedToday?: boolean }[]} [declarations]
 * @param {PauseReading | null} [pause]
 */
export function compareReadings(numbers: Record<string, number | null>, previous: ReturnType<typeof previousReading>, declarations: readonly { id: string; label: string; better: "lower" | "higher"; undefinedToday?: boolean; }[] = [], pause: PauseReading | null = null) {
  return Object.entries(numbers).map(([id, current]) => {
    const declared = NUMBERS.find((n) => n.id === id) ?? declarations.find((n) => n.id === id);
    const before = previous.status === "read" ? (previous.numbers[id] ?? null) : null;
    const direct = declared === undefined ? ("undeclared" as const)
      : "undefinedToday" in declared && declared.undefinedToday ? ("undefined" as const) : verdictFor({ better: declared.better, previous, id, current });
    const pausedDay = pause !== null && (pause.current > PAUSED_SHARE || pause.previous > PAUSED_SHARE);
    const verdict = direct === "worse" && pausedDay ? ("paused" as const) : direct;
    const delta = current !== null && before !== null ? current - before : null;
    return { id, label: declared?.label ?? id, current, previous: before, delta, verdict };
  });
}

/** @param {number | null} n @returns {string} */
const shown = (n: number | null): string => (n === null ? UNKNOWN : grouped(n));

/** @param {ReturnType<typeof buildReport>} report @returns {string[]} */
function trendLines({ numbers, previous, dora, pause }: ReturnType<typeof buildReport>): string[] {
  const against = previous.status === "read" ? `the previous reading, ${previous.date}` : previous.status === "none" ? "the previous reading (none yet)" : `the previous reading (${UNKNOWN}: ${READINGS_FILE} could not be read)`;
  const lines = compareReadings(numbers, previous, doraDeclarations(dora), pause).map((c) => {
    if (c.verdict === "undefined") return `- ${c.label}: undefined (nothing to measure today; not 0)`;
    if (c.verdict === "undeclared") return `- ${c.label}: NO DIRECTION DECLARED -- a defect in org-retro.ts's NUMBERS table, not a reading (now ${shown(c.current)})`;
    const was = c.previous === null || previous.status !== "read" ? "" : `, previous ${shown(c.previous)} on ${previous.date}${c.delta === null ? "" : `, delta ${c.delta > 0 ? "+" : ""}${grouped(c.delta)}`}`;
    return `- ${c.label}: ${c.verdict} (now ${shown(c.current)}${was})`;
  });
  return ["", `Against ${against}:`, ...lines];
}

/** @param {Record<string, number>} counts @returns {string} `a x2, b x1`, or `none` */
function counted(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([name, n]) => `${name} x${n}`);
  return parts.length === 0 ? "none" : parts.join(", ");
}

/** @param {number} n @returns {string} `12,345` */
function grouped(n: number): string {
  return n.toLocaleString("en-US");
}

/** @param {ReturnType<typeof buildReport>["mergedRepositories"]} repositories @returns {string} why each repository that was not read was not */
function unreadReasons(repositories: ReturnType<typeof buildReport>["mergedRepositories"]): string {
  return (repositories ?? []).filter((r) => r.count === null)
    .map((r) => (r.limitHit ? `${r.repo} hit the ${grouped(MERGED_READ_LIMIT)}-PR read limit` : `${r.repo} could not be read`)).join("; ");
}

/**
 * THE COUNT'S DEFINITION CHANGED (#3593): through 2026-10-04 it was the primary repository alone. The first reading after the change prints the old and the new
 * figure, so that a day's "worse" is not read across a change of definition. It ends itself: today's reading records the repositories it counted, and a previous
 * reading that holds them is one taken the new way.
 * @param {ReturnType<typeof buildReport>} report @returns {string[]}
 */
function definitionLines({ mergedRepositories, merged, mergedPrimaryOnly, previous }: ReturnType<typeof buildReport>): string[] {
  if (previous.status !== "read" || previous.mergedRepositories !== undefined || (mergedRepositories?.length ?? 0) < 2) return [];
  return [`- PRs merged CHANGED DEFINITION: through ${previous.date} it counted ${mergedRepositories?.[0].repo} only (previous reading ${shown(previous.numbers.prsMerged ?? null)}); `
    + `this reading counts every declared repository (${shown(merged?.count ?? null)}); read the old way this window is ${shown(mergedPrimaryOnly?.count ?? null)}. `
    + "The \"PRs merged\" and \"Tokens per merged PR\" verdicts below compare across the change and are not a trend."];
}

/** @param {ReturnType<typeof buildReport>} report @returns {string[]} */
function mergedLines({ merged, mergedRepositories, ...rest }: ReturnType<typeof buildReport>): string[] {
  const several = (mergedRepositories?.length ?? 0) > 1;
  const perRepository = several ? [`  per repository: ${mergedRepositories?.map((r) => `${r.repo} ${r.count === null ? UNKNOWN : r.count}`).join(", ")}`] : [];
  if (merged === null) {
    const why = several ? unreadReasons(mergedRepositories) : "the merged-PR list could not be read";
    return [`- PRs merged: ${UNKNOWN} (${why})`, ...perRepository, ...definitionLines({ merged, mergedRepositories, ...rest })];
  }
  const median = merged.medianMinutes === null ? "no merge to take a median of" : `median open-to-merge ${duration(merged.medianMinutes)}`;
  const across = several ? ` across ${mergedRepositories?.length} repositories` : "";
  return [`- PRs merged: ${merged.count}${across}; ${median}`, ...perRepository, ...definitionLines({ merged, mergedRepositories, ...rest })];
}

/**
 * THE STALL LINE: a window in which NOTHING MERGED is a stall whatever else the numbers say, and the idle minutes beside it say how
 * much claimable work waited through it. Printed only for a window that READ as zero merges: an unreadable list is `unknown` above
 * and is never a stall (#1286). The 2026-10-01 window is the positive control: zero merges while #2824 was refused for 211 ticks.
 * @param {ReturnType<typeof buildReport>} report @returns {string[]}
 */
function stallLines({ merged, idle }: ReturnType<typeof buildReport>): string[] {
  if (merged === null || merged.count > 0) return [];
  const waited = idle !== null && idle.idleMinutes > 0 ? `; a claimable row waited ${idle.idleMinutes} idle minutes through it` : "";
  return [`- STALL: no PR merged in the window${waited}`];
}

/** @param {ReturnType<typeof buildReport>["red"]} red @returns {string[]} */
function redLines(red: ReturnType<typeof buildReport>["red"]): string[] {
  if (red === null) return [`- Red PRs now: ${UNKNOWN} (the open-PR list could not be read)`];
  const broken = red.count === 0 || red.oldest === null ? "- Red PRs now: 0"
    : `- Red PRs now: ${red.count}; age median ${duration(red.medianMinutes ?? 0)}, max ${duration(red.oldest.minutes)} (#${red.oldest.number})`;
  return [broken, ...heldLines(red.held)];
}

/**
 * A PR red ONLY because it carries a hold is not a breakage, and is never silently dropped either: it is named here with its holder and for how
 * long it has been held red. Printed only when there is one, so an ordinary day's report does not grow a line of zeros.
 * @param {NonNullable<ReturnType<typeof redPrStats>>["held"]} held @returns {string[]}
 */
function heldLines(held: NonNullable<ReturnType<typeof redPrStats>>["held"]): string[] {
  if (held.length === 0) return [];
  const each = held.map((h) => `#${h.number} (${h.holders.join(", ")}${h.minutes === null ? "" : `, red ${duration(h.minutes)}`})`);
  return [`- Red PRs held on purpose (not counted above): ${held.length}: ${each.join("; ")}`];
}

/** @param {ReturnType<typeof buildReport>} report @returns {string[]} */
function journalDerivedLines(report: ReturnType<typeof buildReport>): string[] {
  const { idle, releases, stalls } = report;
  const unreadJournal = `${UNKNOWN} (the tick journal could not be read)`;
  const unreadLedger = `${UNKNOWN} (the wake ledger could not be read)`;
  return [
    idle === null ? `- Idle minutes while a claimable row existed: ${unreadJournal}`
      : `- Idle minutes while a claimable row existed: ${idle.idleMinutes} (${idle.ticksWithIdleOffer} of ${idle.ticks} ticks offered a Ready row nobody could take; inferred from the journal at ${TICK_MINUTES} min a tick, a floor${idle.pausedIdleMinutes > 0 ? `; ${idle.pausedIdleMinutes} min in the pause, excluded` : ""})`,
    stalls === null ? `- Stalls (org-stalled wakes): ${unreadLedger}` : `- Stalls (org-stalled wakes): ${stalls.orgStalled}; claim-stalled wakes: ${stalls.claimStalled}`,
    releases === null ? `- Claim-stall voidings (claims that stopped moving: stalled, gone): ${unreadJournal}`
      : `- Claim-stall voidings (claims that stopped moving: stalled, gone): ${releases.voided} (${counted(releases.byReason)}); other releases, not voidings: ${counted(releases.otherReleases)}`,
    stalls === null ? `- org-health offers by signal: ${unreadLedger}` : `- org-health offers by signal: ${counted(stalls.healthBySignal)}`,
  ];
}

/** @param {ReturnType<typeof buildReport>} report @returns {string[]} */
function spendLines({ tokens, merged, handFixes, corrections }: ReturnType<typeof buildReport>): string[] {
  // `ledgerLine` IS the line, wording and all: it says the window, the target, the trend and what was left out, and a refused read says UNKNOWN and "not zero".
  const handFix = handFixes === null ? `- HAND FIXES: ${UNKNOWN} (the hand-fix ledger could not be run)` : `- ${handFixLine(handFixes)}`;
  const chairman = `- ${correctionsLine(corrections)}`;
  if (tokens === null) return [`- Tokens per merged PR: ${UNKNOWN} (no transcript could be read)`, handFix, chairman];
  const perPr = merged === null ? UNKNOWN : merged.count === 0 ? "n/a, no PR merged" : grouped(Math.round(tokens.total / merged.count));
  return [`- Tokens per merged PR: ${perPr} (${grouped(tokens.total)} tokens over ${grouped(tokens.turns)} turns; the transcripts' own usage fields via token-audit.ts, cache reads included)`,
    handFix, chairman];
}

/** @param {ReturnType<typeof buildReport>["dora"]} report @returns {string[]} nothing when no DORA read was asked for; `unknown` when it was refused */
function doraLines(report: ReturnType<typeof buildReport>["dora"]): string[] {
  if (report === undefined) return [];
  if (report === null) return ["", `DORA: ${UNKNOWN} (the declaration or the DORA reader could not be read)`];
  return ["", ...renderDora(report)];
}

/** @returns `undefined` for a record nobody read or that does not parse (`unknown`), `null` for one that read and holds nothing shelved in the window */
function topBlockerOf(text: string | null | undefined, now: number): TopBlocker | null | undefined {
  if (text === null || text === undefined) return undefined;
  try { return topBlocker(parseBlockingRecord(text), now); } catch { return undefined; }
}

/** @param {ReturnType<typeof buildReport>["blocking"]} blocking @returns {string[]} */
function blockingLines(blocking: ReturnType<typeof buildReport>["blocking"]): string[] {
  if (blocking === undefined) return [`- Top blocker: ${UNKNOWN} (${BLOCKING_FILE} could not be read, so "nothing was shelved" cannot be said)`];
  if (blocking === null) return ["- Top blocker: none (nothing was shelved behind a claim in the window)"];
  const row = blocking.row === null ? "" : ` holding #${blocking.row}`;
  return [`- Top blocker: ${blocking.holder}${row}; shelved up to ${blocking.rows} rows for ${duration(blocking.minutes)} (${grouped(Math.round(blocking.rowMinutes))} row-minutes; measured from the gate's per-tick count)`];
}

/** @returns `undefined` for a record nobody read or that does not parse (`unknown`), otherwise the cycles the daily pass counts (agent-org#930) */
function circularWaitsOf(text: string | null | undefined, now: number): DeadlockSummary | undefined {
  if (text === null || text === undefined) return undefined;
  try { return deadlockSummary(parseBlockingRecord(text), now); } catch { return undefined; }
}

/** @param {ReturnType<typeof buildReport>["circularWaits"]} circularWaits @returns {string[]} */
function circularWaitLines(circularWaits: ReturnType<typeof buildReport>["circularWaits"]): string[] {
  if (circularWaits === undefined) return [`- Circular waits: ${UNKNOWN} (${BLOCKING_FILE} could not be read, so "no cycle was found" cannot be said)`];
  if (circularWaits.found === 0) return ["- Circular waits: 0 found"];
  const longest = Math.max(...circularWaits.standing.map((c) => c.minutes), ...circularWaits.broken.map((c) => c.minutes));
  return [`- Circular waits: ${circularWaits.found} found (${circularWaits.broken.length} broken, longest ${longest} minutes; ${circularWaits.standing.length} standing)`];
}

/**
 * THE WORKER-HOURS IDLE ON A CLAIMED ROW (#4957): the number, and how it was read, so a reader can set it beside a hand count. `null` is a population nobody could read.
 * @param {IdleClaimedHours | null} reading @returns {string[]}
 */
function idleClaimedHoursLines(reading: IdleClaimedHours | null): string[] {
  const label = "- Worker-hours idle on a claimed row with no declaration";
  if (reading === null) return [`${label}: ${UNKNOWN} (a declared tracker, a repository's open pull requests or the worker declarations could not be read)`];
  const undated = reading.undated.length === 0 ? "" : `; not counted, claim undated: ${reading.undated.join(", ")}`;
  return [`${label}: ${reading.hours} (${reading.idleClaims} of ${reading.claims} claimed rows across every declared tracker; a floor, read now from each holder's claim, open pull requests and last declaration${undated})`];
}

/**
 * THE CLAIMS THAT WERE NOT FINISHING (#4642, class `row-not-finishable`): the count and the first three refs. `null` is a population nobody could read.
 * @param {ReturnType<typeof incidentSummary>} summary @returns {string[]}
 */
function idleClaimLines(summary: ReturnType<typeof incidentSummary>): string[] {
  if (summary === null) return [`- Claims idle past ${IDLE_CLAIM_INCIDENT_MINUTES} minutes with no open PR or nothing pending on it: ${UNKNOWN} (the claim memory, the herdr listing or the open-PR list could not be read)`];
  const first = summary.count === 0 ? "" : `; first: ${summary.first.join(", ")}`;
  return [`- Claims idle past ${IDLE_CLAIM_INCIDENT_MINUTES} minutes with no open PR or nothing pending on it: ${summary.count}${first}`];
}

/**
 * THE ROWS LEFT OPEN AFTER THEIR DELIVERABLE MERGED (#4769, class `row-not-finishable`): the count and the first three refs. `null` is a population nobody could read.
 * @param {ReturnType<typeof mergedRowOpenSummary>} summary @returns {string[]}
 */
function mergedRowOpenLines(summary: ReturnType<typeof mergedRowOpenSummary>): string[] {
  const label = `- Rows still open more than ${MERGED_ROW_OPEN_MINUTES} minutes after their deliverable merged`;
  if (summary === null) return [`${label}: ${UNKNOWN} (an open-row or pull-request list of a declared repository could not be read)`];
  const first = summary.count === 0 ? "" : `; first: ${summary.first.join(", ")}`;
  return [`${label}: ${summary.count}${first}`];
}

/**
 * AN OPTION A MERGED PULL REQUEST DECLARED AS A CONSUMER'S TO SET, STILL UNSET (agent-org#839, class `closed-on-merge-not-outcome`): the count, the files and keys and their fix. `null` is a
 * population nobody could read.
 * @param {ReturnType<typeof inertOptionSummary>} summary @returns {string[]}
 */
function inertOptionLines(summary: ReturnType<typeof inertOptionSummary>): string[] {
  const label = `- Merged options a consumer has not set, more than ${INERT_OPTION_MINUTES} minutes after the merge`;
  if (summary === null) return [`${label}: ${UNKNOWN} (a merged-pull-request list of a declared repository could not be read)`];
  const unread = summary.unknown === 0 ? "" : `; ${summary.unknown} could not be read (unknown, not counted)`;
  return [`${label}: ${summary.count}${unread}`, ...summary.details.map((line) => `  - ${line}`)];
}

/**
 * THE REMOVALS CLAUDE CODE'S SAFETY CHECK DENIED (a11ign#4957 sixth class, class `safety-check-denied`): how many denials in how many session-days, and the first three refs, each
 * `<cwd-dir>/<session id>@<day> <command shape>`. NOT a trended number. `null` is a read nobody could make; transcripts that could not be read are named, never counted as clean.
 * A removal a person APPROVED leaves no denial, so this is a floor.
 * @param {ReturnType<typeof safetyCheckDenialSummary>} summary @returns {string[]}
 */
function safetyDenialLines(summary: ReturnType<typeof safetyCheckDenialSummary>): string[] {
  const label = "- Removals Claude Code's safety check denied in session transcripts";
  if (summary === null) return [`${label}: ${UNKNOWN} (no transcript directory could be listed)`];
  const first = summary.count === 0 ? "" : `; first: ${summary.first.join(", ")}`;
  const unread = summary.unreadable === 0 ? "" : `; ${summary.unreadable} transcripts could not be read (unknown, not counted)`;
  return [`${label}: ${summary.denials} in ${summary.count} session-days${first}${unread}`];
}

/** How many refs the shared-failure lines name, as the safety-denial line does. */
const SHARED_FIRST_REFS = 3;

/**
 * THE SHARED-FAILURE COUNTS (agent-org#997): red PRs the gate held for a shared-failure incident and then released, and incident rows closed as "not the same failure",
 * each with its first refs. `null` in either is a read nobody made or that was refused, and says `unknown`, never 0.
 * @param {SharedFailures} shared @returns {string[]}
 */
function sharedFailureLines(shared: SharedFailures): string[] {
  const wakes = "- Red PRs a shared-failure incident held and then released (24h)";
  const closed = "- Shared-failure incidents closed as \"not the same failure\" (24h)";
  const line = (label: string, items: string[] | null, unknownWhy: string) => {
    if (items === null) return `${label}: ${UNKNOWN} (${unknownWhy})`;
    return `${label}: ${items.length}${items.length === 0 ? "" : `; first: ${items.slice(0, SHARED_FIRST_REFS).join(", ")}`}`;
  };
  return [
    line(wakes, shared.wakes?.map(({ subject }) => subject) ?? null, "the journal could not be read"),
    line(closed, shared.notSameFailure?.map(({ number }) => `#${number}`) ?? null, "the closed shared-failure rows could not be read"),
  ];
}

/**
 * The report as the text `ceo` is handed and posts on #928.
 * @param {ReturnType<typeof buildReport>} report @returns {string}
 */

/**
 * THE PAUSE LINE, the one line on the Claude allowance, printed first so no figure below it is read as an org failure by mistake: how long Claude work
 * was held in the window, or `not paused`, or `unknown` when `account-limit.ndjson` could not be read (a pause cannot then be ruled out).
 * @param {PauseReading | null} pause @returns {string}
 */
function pauseLine(pause: PauseReading | null): string {
  if (pause === null) return `Claude work pause: ${UNKNOWN} (${ACCOUNT_LIMIT_LOG} could not be read, so a pause cannot be ruled out and the idle figures are not corrected for one)`;
  if (pause.intervals.length === 0) return "Claude work pause: not paused";
  const minutes = pause.intervals.reduce((sum, { from, to }) => sum + (to - from), 0) / 60000;
  const minute = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
  return `Claude work paused ${duration(minutes)} of 24h (${minute(pause.intervals[0].from)} to ${minute(pause.intervals[pause.intervals.length - 1].to)})`;
}

export function renderReport(report: ReturnType<typeof buildReport>): string {
  const from = new Date(report.window.since).toISOString();
  const to = new Date(report.window.until).toISOString();
  return [`ORG RETROSPECTIVE ${report.date} -- the 24 hours ${from} to ${to}`, "", pauseLine(report.pause), "",
    ...mergedLines(report), ...stallLines(report), ...journalDerivedLines(report), ...redLines(report.red), ...blockingLines(report.blocking), ...circularWaitLines(report.circularWaits), ...idleClaimLines(report.idleClaims), ...idleClaimedHoursLines(report.idleClaimedHours), ...mergedRowOpenLines(report.mergedRowOpen), ...inertOptionLines(report.inertOptions), ...safetyDenialLines(report.safetyDenials), ...sharedFailureLines(report.sharedFailures), ...spendLines(report), ...unwaitedLines(report.unwaited), ...untieredLines(report.untiered), ...underspecifiedLines(report.underspecified), ...specLintRefusedLines(report.specLintRefused), ...emergencyPriorityLines(report.emergencyPriority), ...doraLines(report.dora), ...trendLines(report), ""].join("\n");
}

/**
 * IS TODAY'S RETROSPECTIVE STILL OWED? Answered from the wake ledger, the record of what was DELIVERED, so a retrospective the
 * wake could not deliver (`ceo` busy, a restart) is offered again next tick instead of being lost, and one delivered is never
 * offered a second time on the same UTC date. KEYED ON THE DATE: the same date is the same key for the whole day, so a key on
 * the hour would offer it twenty-four times.
 * @param {number} now @param {string | null} ledger the ledger's text, `null` when unreadable
 * @returns {string | null} the date to offer, or `null` when it was already delivered or the ledger cannot say
 */
export function retrospectiveDue(now: number, ledger: string | null): string | null {
  if (ledger === null) return null; // CANNOT TELL is not "not yet": offering blind would repeat it every tick of a bad read
  const date = utcDate(now);
  const delivered = ledgerEntries(ledger, { since: 0, until: Number.MAX_SAFE_INTEGER })
    .some((entry) => entry.marker === null && entry.key === retrospectiveKey(date));
  return delivered ? null : date;
}

/** @param {string} date @returns {string} */
export function retrospectiveKey(date: string): string {
  return `ceo/${RETRO_CAUSE}/${date}`;
}

/**
 * THE INSTRUCTION `ceo` IS ORDERED TO FOLLOW, also written into `.agent-org/roles/ceo.md`'s `## The daily retrospective`
 * section (a test pins both to the same words).
 */
export const CLASS_FIX_INSTRUCTION = "For each number worse than yesterday's, or beyond a bound you state, find the CLASS and file a `" + READY_LABEL + "` row for the class fix "
  + "whose Acceptance is a test that covers the class and not the instance: a population derived from the tree or the API, with a "
  + "positive control (#2912 fixed \"a closed row names the session\" and left every PR with no row falling back to `product-manager`).";

/** The sentence the order carries after `CLASS_FIX_INSTRUCTION`: a `paused` number is the allowance's pause, not an org defect (#1429). */
export const PAUSED_NUMBER_INSTRUCTION = "A number marked `paused` is not a class to file a row for: the Claude allowance was paused, so no org defect caused it.";

/** Where the reading and every filed row are posted: #928, the RECORD. */
export const RETRO_DESTINATION = "#928";

/**
 * The order the gate hands `ceo`. A JUDGMENT cause, discriminated on the UTC date.
 * @param {string} date @param {string} reportText
 */
export function retrospectiveOrder(date: string, reportText: string) {
  return {
    session: "ceo",
    cause: "org-retrospective", // A LITERAL: `worker-profile.test.ts` finds every cause the gate can emit by scanning for `cause: "<name>"`
    subject: "org",
    discriminator: date,
    prompt: `THE DAILY RETROSPECTIVE for ${date} (UTC). Optimising the org is your scheduled duty, not a thing the chairman has to ask for. `
      + "The numbers below were computed by `node packages/agent-org/src/org-retro.ts` from the GitHub, journal and ledger reads the gate "
      + "already makes; no model read a log, so do not re-derive them.\n\n"
      + `${reportText}\n${CLASS_FIX_INSTRUCTION} ${PAUSED_NUMBER_INSTRUCTION} The verdict beside each number is against the previous reading; \`no baseline\` and \`unknown\` are not good days.\n`
      + `Post the reading and every row you filed on ${RETRO_DESTINATION}. If nothing tripped, post "nothing tripped" WITH the numbers: a day with nothing to file is never silence. `
      + "An `unknown` is a source the script could not read, not a good day: say so, and file the unreadable source as the defect.",
    causeKey: retrospectiveKey(date),
  };
}

/**
 * THE ORDER THE GATE HANDS `product-manager` for the untiered-ready sweep (a11ign/agent-org#636): the count of `ready` rows with no tier decision was above zero on two
 * consecutive ticks. It names every row and carries the answer, so the session decides rather than re-derives. A JUDGMENT cause, discriminated on the sorted rows: the same stock is
 * the same `causeKey`, one question, and a stock that changed is a new one.
 * @param {UntieredRow[]} rows the rows to name, sorted (`untieredOffer`'s)
 */
export function untieredSweepOrder(rows: UntieredRow[]) {
  const key = untieredSweepKey(rows);
  return {
    session: "product-manager",
    cause: "ready-rows-untiered", // A LITERAL, for `retrospectiveOrder`'s reason
    subject: "ready-rows",
    discriminator: key,
    prompt: `${rows.length} \`${READY_LABEL}\` row(s) have made NO tier decision, and the count has been above zero on two consecutive ticks:\n`
      + rows.map((r) => `  ${r.name} ${r.title}`).join("\n") + "\n"
      + `The chairman's direction is that every mechanical row with a machine-checkable Acceptance is \`${HAIKU_TIER_LABEL}\`, rows already ready and not yet claimed included. `
      + `For each row above: put \`${HAIKU_TIER_LABEL}\` on it if it is mechanical and its Acceptance is machine-checkable, or write a line opening \`Tier: sonnet -- <reason>\` `
      + "(in the body or a comment, outside a code fence, with a reason) on the others. The decision is a field, not a sentence: a row with neither is counted again. "
      + "THIS ORDER DOES NOT TIER THE ROWS FOR YOU: which tier a row deserves is yours. It returns unchanged while the same rows are untiered, and as a new question when the set changes.",
    causeKey: `product-manager/ready-rows-untiered/${key}`,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The READS. Each returns `null` for a refused one and never throws; everything above is pure.

/**
 * THE RETRO READS (agent-org#1081): how many reads of each class this process made, and the seconds they took, for the one line each due tick prints. Counted where the
 * reads are MADE (`ghJson` for `pages` and `lists`, `readFileAt` for `contents`), so a test's fake is not counted. `resetRetroTally` starts a tick's count.
 */
type ReadClass = "pages" | "lists" | "contents";
const RETRO_TALLY: Record<ReadClass, { n: number; ms: number; }> = { pages: { n: 0, ms: 0 }, lists: { n: 0, ms: 0 }, contents: { n: 0, ms: 0 } };
export function resetRetroTally() {
  for (const kind of Object.keys(RETRO_TALLY) as ReadClass[]) RETRO_TALLY[kind] = { n: 0, ms: 0 };
}
function tallied<T>(kind: ReadClass, read: () => T): T {
  const began = performance.now();
  try {
    return read();
  } finally {
    RETRO_TALLY[kind].n += 1;
    RETRO_TALLY[kind].ms += performance.now() - began;
  }
}

/** @param {string[]} args @returns {any[] | null} */
function ghJson(args: string[]): any[] | null {
  return tallied(args[0] === "api" && args[1] === "graphql" ? "pages" : "lists", () => {
    try {
      return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: READ_TIMEOUT_MS }));
    } catch {
      return null; // a refused read is `unknown` in the report, which says so; the cause is not narrated per read, and a hung one is refused at the bound (#3736)
    }
  });
}

/** The refs of one kind a ledger text already holds; a ledger that is absent or does not parse holds none (`recordFailures` still skips a pair it can read). */
function recordedRefs(ledger: string | null, kind: string): string[] {
  try { return parseFailureLedger(ledger ?? "").filter((entry) => entry.classKey === kind).map((entry) => entry.ref); } catch { return []; }
}

/** @template T @param {() => T} read @returns {T | null} `null` for a refused read (a declaration that will not parse included) */
function attemptDora<T>(read: () => T): T | null {
  try { return read(); } catch { return null; }
}

/** @param {number} now @returns {ReturnType<typeof readDora>} every repository the project declares, through the real readers */
const readDeclaredDora = (now: number): ReturnType<typeof readDora> => readDora({ repositories: homeProjectDeclaration().dora, now });

/** Rows at or past this many are a list that may have been cut short, so it is refused, never a count quietly too low (`LIST_LIMIT`'s reason). */
const CLOSED_SHARED_ROWS_LIMIT = 500;

/**
 * The closed shared-failure rows as read, or `null` when they cannot be counted whole (agent-org#997). A row whose comments run past the first page has a closing
 * comment this read may not have seen, so the list is refused rather than counted as 0 for that row; so is a list at its ceiling.
 * @param {Record<string, unknown>[]} raw the rows as `readRowsByLabel` returned them, comments still in their connection shape
 * @returns {any[] | null}
 */
export function readableClosedSharedRows(raw: Record<string, unknown>[]): any[] | null {
  if (raw.length >= CLOSED_SHARED_ROWS_LIMIT) return null;
  const whole = raw.every((row) => {
    const comments = row.comments as { totalCount?: unknown; nodes?: unknown[]; } | null | undefined;
    return typeof comments?.totalCount === "number" && (comments.nodes?.length ?? 0) >= comments.totalCount;
  });
  return whole ? raw.map(asListJson) : null;
}

/**
 * THE CLOSED SHARED-FAILURE ROWS, each with its comments, for the "not the same failure" count (agent-org#997). `null` when the read is refused, or when the rows
 * cannot be read whole (`readableClosedSharedRows`). A refusal is `unknown` in the report, not 0.
 * @returns {any[] | null}
 */
const readClosedSharedRows = (): any[] | null => {
  try {
    const raw = readRowsByLabel({ label: SHARED_FAILURE_LABEL, state: "CLOSED", repo: homeProjectDeclaration().repo,
      select: "number closedAt comments(first:100){totalCount nodes{body}}", run: runThrough(ghJson) });
    return readableClosedSharedRows(raw);
  } catch {
    return null; // a refused read is `unknown`, as `ghJson` says
  }
};

/** The day's DORA reading, kept so that a retrospective offered tick after tick (until the wake delivers it) reads the registry and GitHub ONCE. */
export const DORA_CACHE_FILE = "dora-reading.json";

/**
 * THE DORA READING FOR `now`'s UTC DATE, read once. Measured 2026-10-03: two repositories took 40 seconds through the real readers, and `retrospectiveTick`
 * runs inside the work gate on every tick until the offer is delivered. One file, overwritten daily; a cache that cannot be read or written is a cache miss and never an error.
 * ONLY THE GATE'S TICK KEEPS IT (`retrospectiveTick`): a manual `org-retro` run writes nothing, which a test pins.
 * @param {{ stateDir: string, now: number, read?: (now: number) => ReturnType<typeof readDora> | null }} input
 */
export function cachedDora({ stateDir, now, read = readDeclaredDora }: { stateDir: string; now: number; read?: (now: number) => ReturnType<typeof readDora> | null; }) {
  const path = join(stateDir, DORA_CACHE_FILE);
  const date = utcDate(now);
  const kept = attemptDora(() => JSON.parse(readFileSync(path, "utf8")));
  if (kept?.date === date && kept.report) return kept.report;
  const report = read(now);
  if (report) attemptDora(() => writeFileSync(path, JSON.stringify({ date, report })));
  return report;
}

/**
 * The wall the DORA read may spend in ONE tick before it stops BETWEEN repositories (#3736). Derived from `tick-cost.jsonl`: a tick without the DORA read has a gate phase of
 * 22 to 24 s and the wake after it up to 46 s, against `TimeoutStartSec=600`, and one repository's read is itself bounded (`REPOSITORY_BUDGET_MS`, 240 s). So the worst tick is about
 * 24 + 60 + 240 + 46 = 370 s, with 230 s to spare, and a healthy one reads two or three repositories and leaves the rest to the next tick (every 2 minutes).
 * MEASURED 2026-10-06 (a cold cache, real `gh`, eight repositories): tick 1 read two (263 s: the budget is checked BETWEEN repositories, so one started at 59 s runs to its own end), tick 2 read the other six in 17 s.
 * At least ONE repository is read per tick whatever this is, so a budget below one repository's read still makes progress.
 */
export const DORA_TICK_BUDGET_MS = 60 * 1000;

/**
 * What the cache holds for `date`: the `now` the first repository was read at, and each repository's reading by name. The old shape (`{ date, report }`) has no
 * `readings`, so it reads as a miss, as does a file that cannot be read or parses to anything else.
 * @param {string} path @param {string} date @returns {{ now: number | null, readings: Record<string, any> }}
 */
function keptReadings(path: string, date: string): { now: number | null; readings: Record<string, any>; } {
  const kept = attemptDora(() => JSON.parse(readFileSync(path, "utf8")));
  const usable = kept?.date === date && Number.isFinite(kept.now) && kept.readings !== null && typeof kept.readings === "object";
  return usable ? { now: kept.now, readings: kept.readings } : { now: null, readings: {} };
}

/** Written to a sibling and renamed, so a tick killed mid-write leaves the readings it had. A cache that cannot be written is a miss, never an error. */
function keepReadings(path: string, content: object) {
  attemptDora(() => {
    writeFileSync(`${path}.tmp`, JSON.stringify(content));
    renameSync(`${path}.tmp`, path);
  });
}

/**
 * THE DORA READING FOR `now`'s UTC DATE, kept AS IT IS READ (#3736). Each repository's reading is written the moment it is taken, so a tick killed or out of budget leaves the
 * repositories it finished, and the next call resumes at the first unread one. Every repository is read at the SAME `now` (the first one's, kept with the readings), so a report
 * assembled over several ticks measures one window. A repository whose read is refused is `unknown` in the cache, never missing from it.
 * `complete` is true only when EVERY declared repository has a reading: there is no partial report to offer.
 * @param {{ stateDir: string, now: number, repositories?: Parameters<typeof readRepository>[0]["repository"][], readOne?: typeof readRepository, budgetMs?: number, clock?: () => number }} input
 * @returns {{ complete: true, report: ReturnType<typeof doraReport> } | { complete: false, read: number, of: number, readThisTick: number, elapsedMs: number }}
 */
export function resumableDora({ stateDir, now, repositories = homeProjectDeclaration().dora, readOne = readRepository, budgetMs = DORA_TICK_BUDGET_MS, clock = Date.now }: { stateDir: string; now: number; repositories?: Parameters<typeof readRepository>[0]["repository"][]; readOne?: typeof readRepository; budgetMs?: number; clock?: () => number; }): { complete: true; report: ReturnType<typeof doraReport>; } | { complete: false; read: number; of: number; readThisTick: number; elapsedMs: number; } {
  const path = join(stateDir, DORA_CACHE_FILE);
  const kept = keptReadings(path, utcDate(now));
  const readAt = kept.now ?? now;
  const began = clock();
  let readThisTick = 0;
  for (const repository of repositories) {
    if (Object.hasOwn(kept.readings, repository.repo)) continue;
    if (readThisTick > 0 && clock() - began >= budgetMs) break;
    kept.readings[repository.repo] = readOne({ repository, now: readAt });
    readThisTick += 1;
    keepReadings(path, { date: utcDate(now), now: readAt, readings: kept.readings });
  }
  const read = repositories.filter((repository) => Object.hasOwn(kept.readings, repository.repo)).length;
  if (read < repositories.length) return { complete: false, read, of: repositories.length, readThisTick, elapsedMs: clock() - began };
  return { complete: true, report: doraReport({ readings: repositories.map((repository) => kept.readings[repository.repo]), now: readAt }) };
}

/** @param {string} path @returns {string | null} */
function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/**
 * The Claude pause's log. NO FILE is `""`, which is "not paused": nothing has ever been entered. A file that is there and cannot be read (a directory
 * at its path included) is `null`, which is unknown and never "not paused".
 * @param {string} stateDir @returns {string | null}
 */
export function readAccountLimitLog(stateDir: string): string | null {
  const path = accountLimitLogPath(stateDir);
  return existsSync(path) ? readText(path) : "";
}

/**
 * Transcripts untouched since before the window cannot hold a turn inside it, so their (large) text is never parsed.
 * @param {string} root @param {number} since @returns {string[]}
 */
function recentTranscripts(root: string, since: number): string[] {
  return transcriptFiles(root).filter((file) => {
    try { return statSync(file).mtimeMs >= since; } catch { return false; }
  });
}

/** @param {number} since @returns {any[] | null} `null` only when NO transcript root could be listed at all */
function readTurns(since: number): any[] | null {
  const home = process.env.HOME ?? "";
  const claudeRoot = join(home, ".claude", "projects");
  const codexRoot = join(home, ".codex", "sessions");
  try { readdirSync(claudeRoot); } catch { return null; }
  const turns = [];
  for (const file of recentTranscripts(claudeRoot, since)) {
    try { turns.push(...claudeTurns(readFileSync(file, "utf8"))); } catch { /* one unreadable transcript is skipped, the rest still count */ }
  }
  for (const file of recentTranscripts(codexRoot, since)) {
    try { turns.push(...codexTurns(readFileSync(file, "utf8"), "codex-reviewers")); } catch { /* as above */ }
  }
  return turns;
}

/**
 * THE LIVE READ OF THE SAFETY-CHECK DENIALS (a11ign#4957): every Claude transcript touched since `since`, through the pure `safetyCheckDenials`. `null` only when the transcript root
 * could not be listed at all; a transcript that cannot be read or parsed is counted in `unreadable` and contributes nothing. Codex transcripts are not read: the denial is Claude Code's.
 * @param {{ since: number, root?: string }} read @returns {SafetyCheckDenialReading | null}
 */
export function readSafetyCheckDenials({ since, root = join(process.env.HOME ?? "", ".claude", "projects") }: { since: number; root?: string; }): SafetyCheckDenialReading | null {
  try { readdirSync(root); } catch { return null; }
  const reading: SafetyCheckDenialReading = { incidents: [], unreadable: 0 };
  for (const file of recentTranscripts(root, since)) {
    let found: ReturnType<typeof safetyCheckDenials> = null;
    try { found = safetyCheckDenials({ text: readFileSync(file, "utf8"), file, since }); } catch { /* unreadable: counted below, never clean */ }
    if (found === null) reading.unreadable += 1; else reading.incidents.push(...found);
  }
  return reading;
}

/** @param {string} unit @returns {string | null} */
function readJournal(unit: string): string | null {
  try {
    return execFileSync("journalctl", ["--user", "-u", unit, "--since", "-24h", "--no-pager", "-o", "short-iso"],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

const PR_RUNNING_STATUSES = ["IN_PROGRESS", "QUEUED", "PENDING"];

/** The gate's `checksPending` (`withChecksPending`): a check of the NEWEST run per name is still running. Restated, because this file is a leaf and `work-gate.ts` imports it. */
function checksPendingOf(pr: { statusCheckRollup?: { status?: string }[] }): boolean {
  return newestPerName((pr.statusCheckRollup ?? []) as any).some((c: any) => PR_RUNNING_STATUSES.includes(String(c?.status ?? "").toUpperCase()));
}

/**
 * WHEN A HOLDER'S IDLE RUN BEGAN, from what the gate remembers of it (`claim-stalls.json`, written every tick by `nextStallState`): an `idle-watch` entry carries `idleSince`; an
 * idle NUDGE carries only `nudgedAt`, sent when the run reached `IDLE_CLAIMANT_MS`, so the start is that long before it -- an ESTIMATE, and the short side (the run was at least that long).
 * Anything else (a stall nudge, a vacating row, no entry) is not an idle run, so `null`, which the detector reads as CANNOT TELL.
 */
function idleSinceOf(entry: StallState[string]): number | null {
  if (typeof entry.idleSince === "number") return entry.idleSince;
  return entry.idle === true && typeof entry.nudgedAt === "number" ? entry.nudgedAt - IDLE_CLAIMANT_MS : null;
}

/**
 * THE LIVE READ OF THE IDLE-CLAIM INCIDENTS (#4642): `null` when the open-PR list or the herdr listing could not be read (`unknown` in the report, never 0).
 * THE CLAIMS ARE THE GATE'S MEMORY, so a holder with a declared row wait is not among them (the gate drops its memory the tick it reads a wait; at most one tick stale).
 * A PULL REQUEST IS ATTRIBUTED TO A HOLDER BY ITS `session:` LABEL, as the gate does, so a session holding two rows credits its pull request to both: a quiet row of that
 * session can be hidden, never invented. The pure decision is `idle-claim-incident.ts`'s.
 * @param {{ now: number, stateDir: string, openPrs: any[] | null, agents: Agent[] | null }} reads
 */
export function readIdleClaims({ now, stateDir, openPrs, agents }: { now: number; stateDir: string; openPrs: any[] | null; agents: Agent[] | null; }): IdleClaimIncident[] | null {
  if (openPrs === null || agents === null) return null;
  const memory = readJsonObject(join(stateDir, STALL_STATE_FILE)) as StallState;
  const prsOf = (session: string): IdlePr[] => openPrs
    .filter((pr) => (pr.labels ?? []).some((l: any) => (typeof l === "string" ? l : l?.name) === `${SESSION_PREFIX}${session}`))
    .map((pr) => ({ number: pr.number, labels: pr.labels, reviewDecision: pr.reviewDecision, checksPending: checksPendingOf(pr) }));
  const claims: IdleClaim[] = Object.entries(memory).map(([row, entry]) => ({ row: Number(row), session: entry.session, idleSince: idleSinceOf(entry), prs: prsOf(entry.session) }));
  return idleClaimIncidents({ claims, agents, now });
}

/** How far back the merged pull requests are read (#4769): wider than the report's 24 hours, because a merge is not yet an incident when the pass that sees it first runs. */
export const MERGED_ROW_OPEN_LOOKBACK_MS = 7 * WINDOW_MS;
/** One list's ceiling: a list this long may have stopped short, so it is a refused read and never a count quietly too low (as `MERGED_READ_LIMIT`). */
const LIST_LIMIT = 1000;
const CLAIMED_BRANCH = /^Claimed-branch:\s*(.+)$/m;

/** @param {(args: string[]) => any[] | null} read @param {string[]} args @returns {any[] | null} `null` for a refused list, a list at its ceiling included */
const listRead = (read: (args: string[]) => any[] | null, args: string[]): any[] | null => {
  const list = read(args);
  return list === null || list.length >= LIST_LIMIT ? null : list;
};

/** The branch the NEWEST claim-record comment names, or `null`: a row's record is re-written by a re-claim and the last one is who holds it. */
function claimedBranchOf(comments: { body?: string }[]): string | null {
  const bodies = comments.map((comment) => comment.body ?? "").filter((body) => body.includes(CLAIM_RECORD_MARKER));
  return bodies.reduce<string | null>((branch, body) => CLAIMED_BRANCH.exec(body)?.[1].trim() ?? branch, null);
}

/** An open row of one tracker. `claimedAt` is present only on a row carrying the claim label (#4957): the newest claim record's own time, `null` when it could not be dated. */
type TrackerRow = OpenRow & { claimedAt?: number | null; };

/**
 * One tracker's open rows carrying the claim label, each with its comments (the claim record is one): `repository.issues(labels:)`, a connection, because `--label` was sent
 * as a GitHub SEARCH (#5076). `null` when refused or when the list may be cut short, as {@link listRead} says.
 */
function readClaimedWithComments({ repo, read }: { repo: string; read: (args: string[]) => any; }): any[] | null {
  try {
    const rows = readRowsByLabel({ label: CLAIM_LABEL, state: "OPEN", repo, select: "number comments(first:100){nodes{body createdAt}}", run: runThrough(read) });
    return rows.length >= LIST_LIMIT ? null : rows.map(asListJson);
  } catch {
    return null; // a refused read is `unknown`, as `ghJson` says
  }
}

/** One tracker's open rows, each with its claim record's branch (and, for a claimed one, its claim's time). `null` when either list was refused. */
function readOpenRows({ repo, read }: { repo: string; read: (args: string[]) => any[] | null; }): TrackerRow[] | null {
  const open = listRead(read, ["issue", "list", "-R", repo, "--state", "open", "--limit", String(LIST_LIMIT), "--json", "number,labels"]);
  const claimed = readClaimedWithComments({ repo, read });
  if (open === null || claimed === null) return null;
  const claims = new Map<number, any[]>(claimed.map((row) => [row.number, row.comments ?? []]));
  return open.map((row) => ({ repo, number: row.number, labels: (row.labels ?? []).map((l: any) => (typeof l === "string" ? l : l?.name)),
    claimedBranch: claims.has(row.number) ? claimedBranchOf(claims.get(row.number)!) : null,
    ...(claims.has(row.number) ? { claimedAt: claimedAtOf(claims.get(row.number)!) } : {}) }));
}

/**
 * THE RETRO'S MEMORY OF ITS MERGED READS AND ACCEPTANCE FILES (agent-org#1081), kept in the state entry (`RETRO_READS_FILE`) by the gate's daily pass only.
 * `marks`: per `repo|select`, the merged rows the last walk left and the newest `updatedAt` it saw; a later walk reads only the pages above that mark.
 * `contents`: per `repo|path|oid`, an acceptance file's text AT ITS MERGE COMMIT, which cannot change, so it is read once. Open pull requests are never cached.
 * `walked`, `used` and `fullReads` belong to THIS tick: a key walked already reads no page, a key touched is kept, and a repository read in full is named in the line.
 */
type MergedMark = { updatedAt: string; rows: Record<string, unknown>[]; };
/**
 * `keep` is set by `readRetroReads` (the daily pass only) and writes the memory as it is read (agent-org#1089): a cut gate leaves what it read for the next tick.
 * `budget` is the class being read this tick, set by `readRetroClasses` and never by a manual run (`ClassBudget`).
 */
export type RetroReads = {
  marks: Record<string, MergedMark>; contents: Record<string, string>; unreadable: boolean;
  walked: Set<string>; used: Set<string>; fullReads: string[]; keep?: () => void; budget?: ClassBudget;
};
export const RETRO_READS_FILE = "retro-reads-cache.json";

/**
 * A class's own budget this tick (agent-org#1089): `past()` is true once the tick has spent `RETRO_TICK_BUDGET_MS`. Each item the class reaches
 * (`acceptanceOf`, `readNamingPrs`) counts in `items`; an item it reaches past the budget is not read, counts in `refused`, and reads as `null` (`unknown`).
 */
export type ClassBudget = { past: () => boolean; items: number; refused: number; };

/** An empty memory: a manual run's (which writes nothing), a test's, and the one a tick starts from when the state entry is missing or unreadable. */
export function freshRetroReads(unreadable = false): RetroReads {
  return { marks: {}, contents: {}, unreadable, walked: new Set(), used: new Set(), fullReads: [] };
}

/**
 * The memory the state entry holds, or an empty one that says it is `unreadable` (a missing file is unreadable too: the first tick reads in full). The
 * returned memory writes itself as it is read (`keep`), so the daily pass's reads are kept whether or not the tick finishes.
 */
export function readRetroReads(stateDir: string): RetroReads {
  const kept = attemptDora(() => JSON.parse(readFileSync(join(stateDir, RETRO_READS_FILE), "utf8")));
  const usable = kept !== null && typeof kept === "object" && kept.marks !== null && typeof kept.marks === "object" && kept.contents !== null && typeof kept.contents === "object";
  const memory = usable ? { ...freshRetroReads(), marks: kept.marks, contents: kept.contents } : freshRetroReads(true);
  memory.keep = () => keepRetroReads(stateDir, memory);
  return memory;
}

/** Writes what THIS tick has used so far, and nothing else: a repository or file no longer read is dropped, so the state entry is bounded by the window. Only the daily pass calls it (through `keep`). */
export function keepRetroReads(stateDir: string, memory: RetroReads) {
  const usedOnly = <T>(entries: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(entries).filter(([key]) => memory.used.has(key)));
  keepReadings(join(stateDir, RETRO_READS_FILE), { marks: usedOnly(memory.marks), contents: usedOnly(memory.contents) });
}

/**
 * The pull requests MERGED and UPDATED at or after `since`, newest update first, in `gh pr list --json` shape, with NO merge-time filter (agent-org#1081). A merged row
 * is updated when it merges, and again when its body or comments change, so a caller that keeps the rows it has and walks only the pages above its mark (the newest
 * `updatedAt` it saw) reads what changed, and a body edited after the merge is among those rows. The caller keeps the rows whose own time it means (`mergedAt`).
 * A window longer than `maxPages` THROWS, as `readRowsSince` does: the caller reads in full instead.
 */
function readMergedUpdatedSince({ repo, select, run, since, maxPages }: { repo: string; select: string; run: Parameters<typeof readRowsSince>[0]["run"]; since: string; maxPages?: number; }): Record<string, unknown>[] {
  const ask: SinceRead = { kind: "pullRequests", states: ["MERGED"], orderBy: "UPDATED_AT", repo, select: `${select} mergedAt`, since, ...(maxPages === undefined ? {} : { maxPages }) };
  return readRowsSince({ ask, run }).map(asListJson);
}

/**
 * One code repository's pull requests merged since `since`, with the fields `select` asks, WALKED ONLY ABOVE ITS MARK when there is one (agent-org#1081). The rows
 * a walk reads are merged into the mark's rows by number, so a row the walk saw again replaces its old self. A mark that is missing, unusable, or whose walk was longer than
 * its pages is read IN FULL, and the repository is named in `fullReads`. `null` when refused: then the mark does not move.
 */
function readMergedPrs({ repo, since, read, select, memory }: { repo: string; since: number; read: (args: string[]) => any[] | null; select: string; memory: RetroReads; }): any[] | null {
  const key = `${repo}|${select}`;
  memory.used.add(key);
  const mark = memory.marks[key];
  const marked = mark !== undefined && Number.isFinite(Date.parse(mark.updatedAt)) && Array.isArray(mark.rows);
  const walk = (from: string) => readMergedUpdatedSince({ repo, select, run: runThrough(read), since: from, maxPages: LIST_LIMIT / SINCE_PAGE_SIZE }); // #5076: a connection read, not `--search merged:>=` (a GitHub SEARCH)
  try {
    if (marked && memory.walked.has(key)) return mark.rows.filter((row) => Date.parse(String(row.mergedAt)) >= since);
    let fresh: Record<string, unknown>[] | null = null;
    let base: Record<string, unknown>[] = [];
    if (marked) {
      try {
        fresh = walk(mark.updatedAt);
        base = mark.rows;
      } catch {
        fresh = null; // the walk above the mark was longer than its pages: read in full, as a missing mark is
      }
    }
    if (fresh === null) {
      memory.fullReads.push(repo);
      fresh = walk(new Date(since).toISOString());
    }
    const byNumber = new Map([...base, ...fresh].map((row) => [row.number, row]));
    const rows = [...byNumber.values()].filter((row) => Date.parse(String(row.mergedAt)) >= since);
    if (rows.length >= LIST_LIMIT) return null;
    const newest = fresh.reduce((max, row) => (String(row.updatedAt) > max ? String(row.updatedAt) : max), "");
    memory.marks[key] = { updatedAt: newest || (marked ? mark.updatedAt : new Date(since).toISOString()), rows: rows as Record<string, unknown>[] };
    memory.walked.add(key);
    memory.keep?.(); // a cut gate keeps this mark for the next tick (agent-org#1089)
    return rows;
  } catch {
    return null; // a refused read, or a window the pages did not hold, is `unknown`
  }
}

/** The GraphQL selection each merged-pull-request reader asks for: the naming read's (`readMergedRowOpen`) and the inert-option read's (`readInertOptions`: the files whose acceptance it reads, the commit they are read at, and the body it reads the switch row of). */
const NAMING_SELECT = "number body headRefName";
const INERT_SELECT = "number body mergeCommit{oid} files(first:100){nodes{path}}";

/**
 * One code repository's merged (since the look-back) and open pull requests, tagged with the repository. `null` when either list was refused.
 * THE MERGED SELECT IS `number body headRefName`: the one caller that reads it (`readMergedRowOpen`) reads the body and the branch, and no field else (#1081).
 * `readIdleClaimedHours` reads the open list only, for its labels, so the merged list is read for its refusal and nothing else.
 */
function readNamingPrs({ repo, since, read, memory }: { repo: string; since: number; read: (args: string[]) => any[] | null; memory: RetroReads; }): { merged: NamingPr[]; open: (NamingPr & { labels?: any[]; })[]; } | null {
  if (!admitItem(memory)) return null;
  const merged = readMergedPrs({ repo, since, read, select: NAMING_SELECT, memory });
  const open = listRead(read, ["pr", "list", "-R", repo, "--state", "open", "--limit", String(LIST_LIMIT), "--json", "number,body,headRefName,labels"]);
  if (merged === null || open === null) return null;
  return { merged: merged.map((pr) => ({ ...pr, repo })), open: open.map((pr) => ({ ...pr, repo })) };
}

/**
 * THE LIVE READ OF THE ROWS LEFT OPEN AFTER THEIR DELIVERABLE MERGED (#4769): every declared tracker's open rows against every declared code repository's merged and open
 * pull requests. `null` when ANY of those lists was refused (`unknown` in the report, never 0): a repository that could not be listed is a deliverable nobody could see.
 * The pure decision is `merged-row-open-incident.ts`'s. `read` is the seam (`ghJson` by default).
 * @param {{ now: number, declaration?: ReturnType<typeof homeProjectDeclaration>, read?: (args: string[]) => any[] | null }} reads
 */
export function readMergedRowOpen({ now, declaration = homeProjectDeclaration(), read = ghJson, memory = freshRetroReads() }: { now: number; declaration?: ReturnType<typeof homeProjectDeclaration>; read?: (args: string[]) => any[] | null; memory?: RetroReads; }): MergedRowOpenIncident[] | null {
  const rowLists = declaration.tracker.map(({ repo }) => readOpenRows({ repo, read }));
  const prLists = declaration.code.map(({ repo }) => readNamingPrs({ repo, since: now - MERGED_ROW_OPEN_LOOKBACK_MS, read, memory }));
  if (rowLists.includes(null) || prLists.includes(null)) return null;
  const prs = prLists as NonNullable<ReturnType<typeof readNamingPrs>>[];
  return mergedRowOpenIncidents({ rows: (rowLists as OpenRow[][]).flat(), mergedPrs: prs.flatMap((p) => p.merged), openPrs: prs.flatMap((p) => p.open), now });
}

/** The path a pull request ADDED under `.acceptance/` (ADR 0044): the file CI reads, so a later body edit cannot change what it declared. */
const ACCEPTANCE_FILE = /^\.acceptance\/[A-Za-z0-9_.~-]+\.md$/;
const COMMIT_OID = /^[0-9a-f]{40}$/;

/**
 * One file AS THE MERGE LEFT IT: the contents API at the merge commit, so a later pull request that edits or deletes the acceptance file cannot change what an earlier one declared
 * (agent-org#938 review). It is `lookupConsumerFile`'s optional `ref`, so it adds no `gh` call site. `null` when the commit is absent or malformed, or the file could not be read.
 */
function readFileAt({ repo, path, oid, readFile }: { repo: string; path: string; oid: unknown; readFile: (repo: string, path: string, ref?: string) => string | null; }): string | null {
  return typeof oid === "string" && COMMIT_OID.test(oid) ? tallied("contents", () => readFile(repo, path, oid)) : null;
}

/**
 * ONE acceptance file of a merged pull request, from the memory when this merge commit's text is kept (agent-org#1081). A text is kept only when it was read, never a
 * refusal, so an unreadable file is read again next tick. The key is the merge commit, so a later pull request cannot change what is kept.
 */
function acceptanceOf({ repo, path, oid, readFile, readAcceptance, memory }: { repo: string; path: string; oid: unknown; readFile: (repo: string, path: string, ref?: string) => string | null; readAcceptance: typeof readFileAt; memory: RetroReads; }): string | null {
  const key = `${repo}|${path}|${String(oid)}`;
  memory.used.add(key);
  const cached = memory.contents[key];
  if (!admitItem(memory, cached !== undefined)) return null; // a text the memory holds costs no budget; a read past the budget is `unknown`
  if (cached !== undefined) return cached;
  const text = readAcceptance({ repo, path, oid, readFile });
  if (text !== null) {
    memory.contents[key] = text;
    memory.keep?.(); // kept as it is read: a gate cut before the next file keeps this one (agent-org#1089)
  }
  return text;
}

/**
 * ONE ITEM OF THE CLASS BEING READ (agent-org#1089): `false` once this tick's budget has passed, and the item is counted as refused. `cached` items are counted and admitted,
 * since a kept text is no read. Outside `readRetroClasses` there is no budget and every item is admitted.
 */
function admitItem(memory: RetroReads, cached = false): boolean {
  const budget = memory.budget;
  if (budget === undefined) return true;
  budget.items += 1;
  if (cached || !budget.past()) return true;
  budget.refused += 1;
  return false;
}

/**
 * THE LIVE READ OF THE OPTIONS A MERGED PULL REQUEST DECLARED AS A CONSUMER'S TO SET (agent-org#839): every declared code repository's merged pull requests of the look-back, each with the
 * text of the `.acceptance/` file it touched, against the consumer's file on its default branch. `null` when a list was refused (`unknown`, never 0). A pull request whose acceptance file
 * could not be read carries `acceptanceText: null`, which the leaf reports as unknown. The pure decision is `inert-option-incident.ts`'s. `read`, `readFile` (the consumer's file on its default branch) and `readAcceptance` (the acceptance file at the merge commit) are the seams (`ghJson` and
 * `lookupConsumerFile`, which is the one reader of a file's text the refusal already uses, so this adds no `gh` call site). `recorded` are the refs the ledger already holds.
 * @param {{ now: number, declaration?: ReturnType<typeof homeProjectDeclaration>, read?: (args: string[]) => any[] | null, readFile?: (repo: string, path: string) => string | null, recorded?: Iterable<string> }} reads
 */
export function readInertOptions({ now, declaration = homeProjectDeclaration(), read = ghJson, readFile = lookupConsumerFile, readAcceptance = readFileAt, recorded = [], memory = freshRetroReads() }: {
  now: number; declaration?: ReturnType<typeof homeProjectDeclaration>; read?: (args: string[]) => any[] | null; readFile?: (repo: string, path: string, ref?: string) => string | null; readAcceptance?: typeof readFileAt; recorded?: Iterable<string>; memory?: RetroReads;
}): InertOptionReading | null {
  const lists = declaration.code.map(({ repo }) => ({ repo, merged: readMergedPrs({ repo, since: now - MERGED_ROW_OPEN_LOOKBACK_MS, read, select: INERT_SELECT, memory }) }));
  if (lists.some(({ merged }) => merged === null)) return null;
  const mergedPrs: MergedOptionPr[] = lists.flatMap(({ repo, merged }) => (merged as any[]).flatMap((pr): MergedOptionPr[] => {
    const paths: string[] = (pr.files ?? []).map((file: any) => String(file?.path)).filter((path: string) => ACCEPTANCE_FILE.test(path));
    if (paths.length === 0) return []; // no acceptance file added: nothing it declared can be read, and none is not unknown
    const texts = paths.map((path) => acceptanceOf({ repo, path, oid: pr.mergeCommit?.oid, readFile, readAcceptance, memory }));
    return [{ repo, number: pr.number, mergedAt: pr.mergedAt, body: pr.body, acceptanceText: texts.includes(null) ? null : texts.join("\n") }];
  }));
  return inertOptionIncidents({ mergedPrs, readConsumerFile: readFile, now, recorded });
}

export type IdleClaimedHours = ReturnType<typeof idleClaimedHours>;

/** The newest claim record's own time, or `null`: the clock of the claim a row's holder began (`claimedBranchOf`'s reading of the same comments). */
function claimedAtOf(comments: { body?: string; createdAt?: string; }[]): number | null {
  const at = comments.filter((c) => (c.body ?? "").includes(CLAIM_RECORD_MARKER)).map((c) => Date.parse(String(c.createdAt))).filter(Number.isFinite);
  return at.length === 0 ? null : Math.max(...at);
}

/**
 * THE LIVE READ OF WORKER-HOURS IDLE ON A CLAIMED ROW (#4957): every declared tracker's open claimed rows (the `session:` label names the holder, the claim record dates the
 * claim), every declared code repository's open pull requests by `session:` label, and the worker declarations and wake ledger of `stateDir`. IT SHARES `readOpenRows` AND
 * `readNamingPrs` WITH THE ROWS-LEFT-OPEN READ and adds no `gh` call site (`gh-call-ratchet.test.ts`). `null` when ANY list or the declarations could not be read (`unknown`,
 * never 0). The pure decision is `idle-claim-incident.ts`'s `idleClaimedHours`. `read` is the seam (`ghJson` by default).
 * @param {{ now: number, stateDir: string, declaration?: ReturnType<typeof homeProjectDeclaration>, read?: (args: string[]) => any[] | null }} reads
 */
export function readIdleClaimedHours({ now, stateDir, declaration = homeProjectDeclaration(), read = ghJson, memory = freshRetroReads() }: { now: number; stateDir: string; declaration?: ReturnType<typeof homeProjectDeclaration>; read?: (args: string[]) => any[] | null; memory?: RetroReads; }): IdleClaimedHours | null {
  const rowLists = declaration.tracker.map(({ repo }) => readOpenRows({ repo, read }));
  const prLists = declaration.code.map(({ repo }) => readNamingPrs({ repo, since: now - MERGED_ROW_OPEN_LOOKBACK_MS, read, memory }));
  const declarations = readDeclarations(join(stateDir, WORKER_STATE_DIR));
  if (rowLists.includes(null) || prLists.includes(null) || declarations === null) return null;
  const sessionsOf = (labels: any[] | undefined): string[] => (labels ?? []).map((l) => (typeof l === "string" ? l : l?.name))
    .filter((n) => typeof n === "string" && n.startsWith(SESSION_PREFIX)).map((n: string) => n.slice(SESSION_PREFIX.length));
  const claims: ClaimedRow[] = (rowLists as TrackerRow[][]).flat().flatMap((row) => {
    const sessions = sessionsOf(row.labels);
    return row.claimedAt !== undefined && sessions.length === 1 ? [{ repo: row.repo, row: row.number, session: sessions[0], claimedAt: row.claimedAt }] : [];
  });
  const ledger = readText(`${stateDir}/wake-ledger`) ?? "";
  const holders = new Map<string, HolderState>([...new Set(claims.map((c) => c.session))].map((session) => [session,
    { declaredAt: declarations.byClaimant.get(session)?.at ?? null, turnStartedAt: lastDeliveredTo(ledger, session) }]));
  const sessionsWithPr = new Set((prLists as NonNullable<ReturnType<typeof readNamingPrs>>[]).flatMap((p) => p.open).flatMap((pr) => sessionsOf(pr.labels)));
  // the pause is read here, so the claimed span is net of it; an unreadable log counts the span whole and the report's pause line says `unknown`
  const paused = pauseOf(readAccountLimitLog(stateDir), now)?.intervals ?? [];
  return idleClaimedHours({ claims, sessionsWithPr, holders, since: now - WINDOW_MS, now, paused });
}

/**
 * THE "UNDERSPECIFIED" STOPS BY FIELD (a11ign#5117): every declared tracker's issue comments since the window opened, in ONE paginated call each
 * (`commentsSince`, in the port's directory so this file gains no `gh` call), and the lines `Underspecified: <field>` in them (`underspecifiedStops`).
 * `null` when ANY tracker's list was refused (`unknown`, never 0). `read` is the seam (`ghJson` by default).
 */
export function readUnderspecified({ now, declaration = homeProjectDeclaration(), read = ghJson }: { now: number; declaration?: ReturnType<typeof homeProjectDeclaration>; read?: (args: string[]) => any[] | null; }): UnderspecifiedReading | null {
  const since = now - WINDOW_MS;
  const lists = declaration.tracker.map(({ repo }) => commentsSince({ repo, since, run: read }));
  if (lists.includes(null)) return null;
  return underspecifiedReading(underspecifiedStops(lists.flat(), { since, until: now }));
}

/**
 * Every read the report wants, once. `stateDir` holds the wake ledger. THE HAND-FIX COUNT IS NOT A FILE IN IT: `hand-fix-ledger.ts` derives
 * it from git and gh (#2939), and this line read a path nothing wrote for as long as the report existed (#2954). `readHandFixes` is the seam.
 * THE IDLE-CLAIM READ (#4642) is {@link readIdleClaims}: the gate's own idle memory, the herdr listing (`readAgentListing` is its seam) and the open-PR list already read here.
 * THE ROWS-LEFT-OPEN READ (#4769) is {@link readMergedRowOpen}, through `readOpenRowIncidents`, its seam.
 * THE INERT-OPTION READ (agent-org#839) is {@link readInertOptions}, through `readInertOptionReading`, its seam; the refs the ledger already holds are passed so an incident is surfaced once.
 * THE DORA READ IS THE DECLARATION'S (`dora.ts`): the repositories `.agent-org/project.json` lists, read from the registry and GitHub. `readDoraReport` is its seam.
 * @param {{ now: number, stateDir: string, unit?: string, readHandFixes?: (now: number) => ReturnType<typeof readHandFixLedger>,
 *   readDoraReport?: (now: number) => ReturnType<typeof readDora> | null, readUnwaited?: (now: number) => ReturnType<typeof unwaitedStockRows>, readUntiered?: () => ReturnType<typeof untieredReadyRows>, readMergedRepositories?: (now: number) => ReturnType<typeof readMerged> }} where
 * MERGED PRS ARE READ FROM EVERY DECLARED REPOSITORY (`readMerged`, #3593), each named with `-R`; `merged` stays the PRIMARY's list, the definition the count had before.
 */
export function retroClasses({ now, stateDir, unit = "a11ign-work-tick.service", memory = freshRetroReads(),
  readMergedRepositories = (at) => readMerged({ declaration: homeProjectDeclaration(), since: at - WINDOW_MS }),
  readHandFixes = (at) => readHandFixLedger({ read: gatherChanges(), now: new Date(at) }),
  readUnwaited = (at) => unwaitedStockRows({ reader: ghTrackerReader(homeProjectDeclaration().repo), now: at }),
  readUntiered = () => untieredReadyRows({ trackers: homeProjectDeclaration().tracker.map((tracker) => ghReadyReader(tracker)) }),
  readDoraReport = readDeclaredDora, readAgentListing = () => readAgents(), readIdleHours = (at) => attemptDora(() => readIdleClaimedHours({ now: at, stateDir, memory })), readOpenRowIncidents = (at) => attemptDora(() => readMergedRowOpen({ now: at, memory })),
  readInertOptionReading = (at, recorded) => attemptDora(() => readInertOptions({ now: at, recorded, memory })),
  readDenials = (at) => readSafetyCheckDenials({ since: at - WINDOW_MS }),
  readUnderspecifiedStops = (at) => attemptDora(() => readUnderspecified({ now: at })),
  readSharedRows = readClosedSharedRows,
  readOpenPrs = () => ghJson(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,labels,statusCheckRollup,reviewDecision"]) }: {
        now: number; stateDir: string; unit?: string; memory?: RetroReads; readHandFixes?: (now: number) => ReturnType<typeof readHandFixLedger>;
        readDoraReport?: (now: number) => ReturnType<typeof readDora> | null; readUnwaited?: (now: number) => ReturnType<typeof unwaitedStockRows>; readUntiered?: () => ReturnType<typeof untieredReadyRows>; readMergedRepositories?: (now: number) => ReturnType<typeof readMerged>;
        readAgentListing?: () => Agent[] | null; readIdleHours?: (now: number) => IdleClaimedHours | null; readOpenRowIncidents?: (now: number) => MergedRowOpenIncident[] | null;
        readInertOptionReading?: (now: number, recorded: string[]) => InertOptionReading | null; readDenials?: (now: number) => SafetyCheckDenialReading | null;
        readUnderspecifiedStops?: (now: number) => UnderspecifiedReading | null; readSharedRows?: () => any[] | null; readOpenPrs?: () => any[] | null;
    }) {
  const since = now - WINDOW_MS;
  return [
    { name: "merged lists", read: () => {
      const mergedRepositories = attemptDora(() => readMergedRepositories(now));
      return { merged: mergedRepositories?.[0]?.prs ?? null, mergedRepositories };
    } },
    { name: "open pull requests", read: () => {
      const openPrs = readOpenPrs();
      return { openPrs, idleClaims: readIdleClaims({ now, stateDir, openPrs, agents: readAgentListing() }) };
    } },
    { name: "idle claimed hours", read: () => ({ idleClaimedHours: readIdleHours(now) }) },
    { name: "rows left open", read: () => ({ mergedRowOpen: readOpenRowIncidents(now) }) },
    { name: "inert options", read: () => {
      const failureLedger = readText(`${stateDir}/${FAILURE_LEDGER_FILE}`);
      return { failureLedger, inertOptions: readInertOptionReading(now, recordedRefs(failureLedger, CLOSED_ON_MERGE_NOT_OUTCOME)) };
    } },
    { name: "safety denials", read: () => ({ safetyDenials: readDenials(now) }) },
    { name: "closed shared-failure rows", read: () => ({ closedSharedRows: readSharedRows() }) },
    { name: "underspecified stops", read: () => ({ underspecified: readUnderspecifiedStops(now) }) },
    { name: "journal", read: () => ({ journal: readJournal(unit) }) },
    { name: "transcripts", read: () => ({ turns: readTurns(since) }) },
    { name: "state files", read: () => ({
      ledger: readText(`${stateDir}/wake-ledger`),
      blockingRecord: readText(`${stateDir}/${BLOCKING_FILE}`),
      readings: readReadings(join(stateDir, READINGS_FILE)),
      accountLimitLog: readAccountLimitLog(stateDir),
    }) },
    // a refused read is a reading that says so (`status: "unknown"`), never a throw and never a 0
    { name: "hand fixes", read: () => ({ handFixes: readHandFixes(now) }) },
    // a declaration that will not parse is a refused read, like the DORA one
    { name: "unwaited", read: () => ({ unwaited: attemptDora(() => readUnwaited(now)) }) },
    { name: "untiered", read: () => ({ untiered: attemptDora(() => readUntiered()) }) },
    { name: "dora", read: () => ({ dora: attemptDora(() => readDoraReport(now)) }) },
  ];
}

/**
 * EVERY READ `retroClasses` makes, in one call and with no budget: the whole report's inputs. `main` (the manual run) takes this; the gate's tick takes
 * `readRetroClasses`, which is this read cut into ticks.
 */
export function readAll(where: Parameters<typeof retroClasses>[0]): Parameters<typeof buildReport>[0] {
  return Object.assign({}, ...retroClasses(where).map((cls) => cls.read())) as Parameters<typeof buildReport>[0];
}

/** THE RETRO READ'S OWN WALL PER TICK (agent-org#1089): well under `GATE_BUDGET_MS`, and the same shape as `DORA_TICK_BUDGET_MS`. A class that starts past it waits for the next tick. */
export const RETRO_TICK_BUDGET_MS = 60 * 1000;

/** The day's classes already read, kept between ticks (`RETRO_CLASSES_FILE`), keyed by UTC date like the DORA cache. */
export const RETRO_CLASSES_FILE = "retro-read-classes.json";

/** The classes read so far for `date`, and the memory keys they used. A file that cannot be read, or is for another date, is an empty day. */
function keptClasses(path: string, date: string): { classes: Record<string, any>; used: string[]; } {
  const kept = attemptDora(() => JSON.parse(readFileSync(path, "utf8")));
  const usable = kept?.date === date && kept.classes !== null && typeof kept.classes === "object" && Array.isArray(kept.used);
  return usable ? { classes: kept.classes, used: kept.used } : { classes: {}, used: [] };
}

/** What a budgeted tick left: the class it stopped before, the classes read so far (of this day), and the seconds this tick spent. */
export type ClassPending = { stopped: string; read: number; of: number; elapsedMs: number; /** Set when the class stopped INSIDE itself: the items it read of all it reached. */ files?: { read: number; of: number; }; };

/**
 * THE RETRO'S READ, CUT INTO TICKS (agent-org#1089). Each class is read in order, and a class is not started once `budgetMs` has passed in this tick (at
 * least ONE class is read per tick whatever the budget). A class that reaches an item past the budget stops INSIDE itself (`ClassBudget`): its reading is not kept as
 * read, so the next tick reads it again, and the memory answers the items this tick already read. Each class's fields are kept in the day's file as they are read, so the next tick resumes at the first unread one; the
 * memory's used keys are kept with them, so the state entry keeps the marks the earlier ticks read. The full report is offered only when EVERY class is read: until then the answer is
 * `{ classPending }`. `budgetMs` and `clock` are the seams a test supplies.
 */
export function readRetroClasses(where: Parameters<typeof retroClasses>[0], { budgetMs = RETRO_TICK_BUDGET_MS, clock = Date.now }: { budgetMs?: number; clock?: () => number; } = {}): Parameters<typeof buildReport>[0] | { classPending: ClassPending; } {
  const memory = where.memory ?? freshRetroReads();
  const path = join(where.stateDir, RETRO_CLASSES_FILE);
  const date = utcDate(where.now);
  const kept = keptClasses(path, date);
  for (const key of kept.used) memory.used.add(key);
  const classes = retroClasses({ ...where, memory });
  const began = clock();
  let readThisTick = 0;
  for (const cls of classes) {
    if (Object.hasOwn(kept.classes, cls.name)) continue;
    if (readThisTick > 0 && clock() - began >= budgetMs) {
      keepReadings(path, { date, classes: kept.classes, used: [...memory.used] });
      keepRetroReads(where.stateDir, memory);
      return { classPending: { stopped: cls.name, read: classes.filter((other) => Object.hasOwn(kept.classes, other.name)).length, of: classes.length, elapsedMs: clock() - began } };
    }
    const budget: ClassBudget = { past: () => clock() - began >= budgetMs, items: 0, refused: 0 };
    memory.budget = budget;
    let reading: ReturnType<typeof cls.read>;
    try {
      reading = cls.read();
    } finally {
      memory.budget = undefined;
    }
    if (budget.refused > 0) {
      keepReadings(path, { date, classes: kept.classes, used: [...memory.used] });
      keepRetroReads(where.stateDir, memory);
      const files = { read: budget.items - budget.refused, of: budget.items };
      return { classPending: { stopped: cls.name, read: classes.filter((other) => Object.hasOwn(kept.classes, other.name)).length, of: classes.length, elapsedMs: clock() - began, files } };
    }
    kept.classes[cls.name] = reading;
    readThisTick += 1;
  }
  return Object.assign({}, ...classes.map((cls) => kept.classes[cls.name])) as Parameters<typeof buildReport>[0];
}

/**
 * APPENDS TODAY'S READING, ONCE PER UTC DATE: the offer repeats every tick until the wake delivers it, and the first reading of the date is the one
 * kept. A readings file that is `unreadable` (the disk would not let us read it, or nothing in it parses) is left alone rather than appended to blind: a valid line added to
 * corrupt content would make the file read as a baseline and mask the corruption (reviewer, #2985).
 * @param {{ stateDir: string, date: string, numbers: Record<string, number | null>, mergedRepositories?: string[] }} reading
 * @returns {"recorded" | "already recorded" | "not recorded"}
 */
export function recordReading({ stateDir, date, numbers, mergedRepositories }: { stateDir: string; date: string; numbers: Record<string, number | null>; mergedRepositories?: string[]; }): "recorded" | "already recorded" | "not recorded" {
  const path = join(stateDir, READINGS_FILE);
  const existing = readReadings(path);
  if (existing.status === "unreadable") return "not recorded"; // an I/O error or a file where no line reads: appending would turn corruption into a baseline
  if (existing.entries.some((e) => e.date === date)) return "already recorded";
  const lead = existing.text === "" || existing.text.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${lead}${JSON.stringify({ date, numbers, mergedRepositories })}\n`);
  return "recorded";
}

/**
 * The gate's read: DORA FIRST, because it is the long one and the only one that resumes, and the others (merged lists, journal, transcripts) are not worth making on a tick
 * that cannot offer the report. `{ doraPending }` is how it says so. `dora` and `readRest` are the seams a test supplies.
 * @param {{ now: number, stateDir: string }} where
 * @param {{ dora?: Partial<Parameters<typeof resumableDora>[0]>, readRest?: (where: Parameters<typeof retroClasses>[0]) => ReturnType<typeof readRetroClasses> }} [seams]
 */
export function readWhenDoraIsRead(where: { now: number; stateDir: string; memory?: RetroReads; }, { dora = {}, readRest = (where) => readRetroClasses(where) }: { dora?: Partial<Parameters<typeof resumableDora>[0]>; readRest?: (where: Parameters<typeof retroClasses>[0]) => ReturnType<typeof readRetroClasses>; } = {}) {
  const progress = resumableDora({ stateDir: where.stateDir, now: where.now, ...dora });
  return progress.complete ? readRest({ ...where, readDoraReport: () => progress.report }) : { doraPending: progress };
}

/**
 * THE UNTIERED-READY SWEEP, once per gate tick (a11ign/agent-org#636): the order to `product-manager` when `untieredReadyRows` is `read` with a count above zero on this tick and
 * on the one before. THE PREVIOUS TICK'S COUNT IS KEPT IN THE STATE DIR (`UNTIERED_MEMORY_FILE`), written every tick and rewritten as `null` for an `unknown` one, so an unread
 * tick breaks the run. NEVER THROWS: a refused read offers nothing, and a memory that cannot be kept is a miss (the offer is one tick later), not an error.
 * @param {{ stateDir: string, log: (line: string) => void, readUntiered: () => ReturnType<typeof untieredReadyRows> | null }} where
 * @returns {ReturnType<typeof untieredSweepOrder>[]}
 */
function untieredSweepTick({ stateDir, log, readUntiered }: { stateDir: string; log: (line: string) => void; readUntiered: () => ReturnType<typeof untieredReadyRows> | null; }): ReturnType<typeof untieredSweepOrder>[] {
  try {
    const path = join(stateDir, UNTIERED_MEMORY_FILE);
    const previous = parseUntieredMemory(attemptDora(() => JSON.parse(readFileSync(path, "utf8"))));
    const { rows, memory } = untieredOffer(attemptDora(readUntiered), previous);
    keepReadings(path, memory);
    return rows === null ? [] : [untieredSweepOrder(rows)];
  } catch (err: any) {
    log(`org-retro: could not read the untiered ready rows (${String(err?.message ?? err).split("\n")[0]}) -- no ready-rows-untiered order this tick.\n`);
    return [];
  }
}

/**
 * THE GATE'S WHOLE CONTACT WITH THIS FILE: the retrospective's order if today's is still owed, and the untiered-ready sweep's if it is (`untieredSweepTick`; it is read on EVERY tick,
 * because two consecutive ticks is its condition and the retrospective is read once a day). NEVER THROWS: a broken
 * report must not stop the orders behind it, and it says so on stderr rather than offering a half-built one. The ledger is read
 * BEFORE the report, so a day already delivered costs one file read and not the day of PR, journal and transcript reads.
 * THE ONLY WRITER OF THE READINGS FILE (`main` below never writes): offering the retrospective IS recording today's reading.
 * A TICK THAT HAS NOT YET READ EVERY DECLARED REPOSITORY offers nothing and says how many it has (#3736): `read` answers `{ doraPending }` and the other reads are not made.
 * @param {{ now?: number, stateDir?: string, log?: (line: string) => void, read?: (where: Parameters<typeof retroClasses>[0]) => Parameters<typeof buildReport>[0] | { doraPending: Extract<ReturnType<typeof resumableDora>, { complete: false }> } | { classPending: ClassPending }, readLedger?: (stateDir: string) => string | null,
 *   record?: typeof recordReading, readUntiered?: () => ReturnType<typeof untieredReadyRows> | null }} [seams]
 * @returns {(ReturnType<typeof retrospectiveOrder> | ReturnType<typeof untieredSweepOrder>)[]}
 */
export function retrospectiveTick({ now = Date.now(), stateDir = stateEntryPath(""), log = (line) => process.stderr.write(line),
  read = (where) => readWhenDoraIsRead(where),
  readLedger = (dir) => readText(`${dir}/wake-ledger`), record = recordReading,
  readUntiered = () => untieredReadyRows({ trackers: homeProjectDeclaration().tracker.map((tracker) => ghReadyReader(tracker)) }) }: {
        now?: number; stateDir?: string; log?: (line: string) => void; read?: (where: Parameters<typeof retroClasses>[0]) => Parameters<typeof buildReport>[0] | { doraPending: Extract<ReturnType<typeof resumableDora>, { complete: false; }>; } | { classPending: ClassPending; }; readLedger?: (stateDir: string) => string | null;
        record?: typeof recordReading; readUntiered?: () => ReturnType<typeof untieredReadyRows> | null;
    } = {}): (ReturnType<typeof retrospectiveOrder> | ReturnType<typeof untieredSweepOrder>)[] {
  return [...dailyRetrospective({ now, stateDir, log, read, readLedger, record }), ...untieredSweepTick({ stateDir, log, readUntiered })];
}

/** The daily retrospective's half of `retrospectiveTick`. */
function dailyRetrospective({ now, stateDir, log, read, readLedger, record }: {
        now: number; stateDir: string; log: (line: string) => void; read: (where: Parameters<typeof retroClasses>[0]) => Parameters<typeof buildReport>[0] | { doraPending: Extract<ReturnType<typeof resumableDora>, { complete: false; }>; } | { classPending: ClassPending; };
        readLedger: (stateDir: string) => string | null; record: typeof recordReading;
    }): ReturnType<typeof retrospectiveOrder>[] {
  try {
    const date = retrospectiveDue(now, readLedger(stateDir));
    if (date === null) return [];
    const memory = readRetroReads(stateDir);
    resetRetroTally();
    const inputs = read({ now, stateDir, memory });
    if ("doraPending" in inputs) {
      const { read: done, of, readThisTick, elapsedMs } = inputs.doraPending;
      log(`org-retro: the DORA read has ${done} of ${of} repositories (${readThisTick} read this tick, ${Math.round(elapsedMs / MS_PER_SECOND)} s); no org-retrospective order until every declared repository is read.\n`);
      return [];
    }
    if ("classPending" in inputs) {
      const { stopped, files, read, of, elapsedMs } = inputs.classPending;
      if (files) log(`org-retro: ${stopped} stopped after ${files.read} of ${files.of} files; no org-retrospective order until every class is read.\n`);
      else log(`org-retro: read stopped at ${stopped} after ${Math.round(elapsedMs / MS_PER_SECOND)} s (${read} of ${of} classes read); no org-retrospective order until every class is read.\n`);
      return [];
    }
    log(`${retroReadsLine(memory)}\n`);
    const report = buildReport(inputs, now);
    keepRetroReads(stateDir, memory); // after the build: a tick that fails keeps the memory it started with
    const text = renderReport(report);
    // `recordFailures` never throws and skips an event already logged, so an episode the daily pass sees on two dates is one line (#4642).
    recordFailures({ logPath: join(stateDir, FAILURE_LEDGER_FILE), events: incidentEvents(inputs.idleClaims ?? []), now, report: (line) => log(`${line}\n`) });
    recordFailures({ logPath: join(stateDir, FAILURE_LEDGER_FILE), events: mergedRowOpenEvents(inputs.mergedRowOpen ?? []), now, report: (line) => log(`${line}\n`) });
    recordFailures({ logPath: join(stateDir, FAILURE_LEDGER_FILE), events: inertOptionEvents(inputs.inertOptions?.incidents ?? []), now, report: (line) => log(`${line}\n`) });
    recordFailures({ logPath: join(stateDir, FAILURE_LEDGER_FILE), events: safetyCheckDenialEvents(inputs.safetyDenials?.incidents ?? []), now, report: (line) => log(`${line}\n`) });
    recordFailures({ logPath: join(stateDir, FAILURE_LEDGER_FILE), events: sharedFailureEvents(report.sharedFailures), now, report: (line) => log(`${line}\n`) });
    keepReading(record, { stateDir, date, numbers: report.numbers, mergedRepositories: report.mergedRepositories?.map((r) => r.repo) }, log);
    return [retrospectiveOrder(date, text)];
  } catch (err: any) {
    log(`org-retro: could not build today's retrospective (${String(err?.message ?? err).split("\n")[0]}) -- no org-retrospective order this tick.\n`);
    return [];
  }
}

/**
 * THE RETRO READS LINE (agent-org#1081): the reads a due tick made, by class, with the seconds each class took, and the notes the memory earns: a repository read in
 * full, and a memory that was missing or unreadable. The journal keeps one per due tick, so the cost before and after the memory is in the record.
 */
export function retroReadsLine(memory: RetroReads): string {
  const part = (kind: ReadClass, label: string) => `${label} ${RETRO_TALLY[kind].n} in ${(RETRO_TALLY[kind].ms / MS_PER_SECOND).toFixed(1)} s`;
  const notes = [
    memory.unreadable ? "the state entry is missing or unreadable, so the merged lists and acceptance contents are read in full" : null,
    memory.fullReads.length > 0 ? `read in full, the mark missing or unreadable: ${[...new Set(memory.fullReads)].join(", ")}` : null,
  ].filter((note): note is string => note !== null);
  return `RETRO READS: ${part("pages", "pages")}, ${part("lists", "lists")}, ${part("contents", "acceptance contents")}${notes.map((note) => `; ${note}`).join("")}`;
}

/** A reading that could not be kept must not stop the offer: the report is still true, and tomorrow's comparison says `no baseline` rather than guessing. */
function keepReading(record: typeof recordReading, reading: Parameters<typeof recordReading>[0], log: (line: string) => void) {
  try {
    if (record(reading) === "not recorded") log(`org-retro: ${READINGS_FILE} could not be read, so today's reading was not recorded.\n`);
  } catch (err: any) {
    log(`org-retro: today's reading was not recorded (${String(err?.message ?? err).split("\n")[0]}).\n`);
  }
}

function main() {
  refuseUnknownFlags(["--now"], { entry: import.meta.url, command: "node packages/agent-org/src/org-retro.ts" });
  const stateDir = stateEntryPath("");
  const nowFlag = flagValue(process.argv, "now");
  const now = nowFlag === undefined ? Date.now() : Date.parse(nowFlag);
  if (!Number.isFinite(now)) {
    process.stderr.write(`org-retro: --now=${nowFlag} is not a date this can read.\n`);
    process.exit(2);
  }
  process.stdout.write(renderReport(buildReport(readAll({ now, stateDir }), now)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
