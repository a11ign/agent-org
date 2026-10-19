import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brokenChecks, redChecks as redChecksOf, isBrokenRed, isHeldRed, holdsOn } from "../red-pr.ts";
import { gatherChanges, readLedger as readHandFixLedger } from "../hand-fix-ledger.ts";
import { EMERGENCY_PRIORITY_NOT_HONOURED_KIND, EMERGENCY_PRIORITY_USED_KIND, FAILURE_LEDGER_FILE, SPEC_LINT_REFUSED_KIND, parseFailureLedger, type FailureEntry, type FailureEvent } from "../failure-ledger.ts";
import { idleClaimedHours, incidentSummary, type IdleClaimIncident } from "../idle-claim-incident.ts";
import type { Agent } from "../idle-claimant.ts";
import { safetyCheckDenialSummary, type SafetyCheckDenialReading } from "../safety-check-denial-incident.ts";
import { CLOSED_ON_MERGE_NOT_OUTCOME, inertOptionSummary, type InertOptionReading } from "../inert-option-incident.ts";
import { mergedRowOpenSummary, type MergedRowOpenIncident } from "../merged-row-open-incident.ts";
import { readAgents } from "../herdr-agents.ts";
import { correctionsPerDay } from "../found-by-chairman.ts";
import { BLOCKING_FILE, deadlockSummary, type DeadlockSummary, parseRecord as parseBlockingRecord, topBlocker, type TopBlocker } from "../blocking-impact.ts";
import { readDora, doraNumbers } from "../dora.ts";
import { homeProjectDeclaration } from "../project-config.ts";
import { unwaitedStockRows, ghTrackerReader } from "../unwaited-stock-rows.ts";
import { untieredReadyRows, ghReadyReader } from "../untiered-ready-rows.ts";
import { UNNAMED_FIELD, type UnderspecifiedReading } from "../spec-lint.ts";
import { IDLE_OFFER, JOURNAL_LINE, MS_PER_MINUTE, RELEASE, TICK_MINUTES, TICK_START, WINDOW_MS, attemptDora, freshRetroReads, ghJson, median, mergedStats, pauseOf, readAccountLimitLog, readClosedSharedRows, readDeclaredDora, readIdleClaimedHours, readIdleClaims, readInertOptions, readJournal, readMerged, readMergedRowOpen, readSafetyCheckDenials, readText, readTurns, readUnderspecified, recordedRefs, type IdleClaimedHours, type PausedInterval, type Reading, type RetroReads, utcDate } from "./retro-cause.ts";

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
    const isOutsideWindow = !Number.isFinite(at) || first === undefined || at < since || at > until;
    if (isOutsideWindow) continue;
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
export function specLintRefusedLines(reading: SpecLintRefusalReading | null | undefined): string[] {
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
export function emergencyPriorityLines(reading: EmergencyPriorityReading | null | undefined): string[] {
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
export const PAUSED_SHARE = 0.5;

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

/** @param {Record<string, number>} counts @returns {string} `a x2, b x1`, or `none` */
export function counted(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([name, n]) => `${name} x${n}`);
  return parts.length === 0 ? "none" : parts.join(", ");
}

/** @returns `undefined` for a record nobody read or that does not parse (`unknown`), `null` for one that read and holds nothing shelved in the window */
function topBlockerOf(text: string | null | undefined, now: number): TopBlocker | null | undefined {
  if (text === null || text === undefined) return undefined;
  try { return topBlocker(parseBlockingRecord(text), now); } catch { return undefined; }
}

/** @returns `undefined` for a record nobody read or that does not parse (`unknown`), otherwise the cycles the daily pass counts (agent-org#930) */
function circularWaitsOf(text: string | null | undefined, now: number): DeadlockSummary | undefined {
  if (text === null || text === undefined) return undefined;
  try { return deadlockSummary(parseBlockingRecord(text), now); } catch { return undefined; }
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
