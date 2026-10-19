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
import { appendFileSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stateEntryPath } from "./host-config.ts";
import { ACCOUNT_LIMIT_LOG } from "./account-limit.ts";
import { READY_LABEL } from "./claim-labels.ts";
import { ledgerLine as handFixLine } from "./hand-fix-ledger.ts";
import { refuseUnknownFlags, flagValue } from "./lib/cli-flags.ts";
import { FAILURE_LEDGER_FILE, recordFailures } from "./failure-ledger.ts";
import { IDLE_CLAIM_INCIDENT_MINUTES, incidentEvents, incidentSummary } from "./idle-claim-incident.ts";
import { safetyCheckDenialEvents, safetyCheckDenialSummary } from "./safety-check-denial-incident.ts";
import { INERT_OPTION_MINUTES, inertOptionEvents, inertOptionSummary } from "./inert-option-incident.ts";
import { MERGED_ROW_OPEN_MINUTES, mergedRowOpenEvents, mergedRowOpenSummary } from "./merged-row-open-incident.ts";
import { correctionsLine } from "./found-by-chairman.ts";
import { BLOCKING_FILE } from "./blocking-impact.ts";
import { readDora, readRepository, doraReport, renderDora, doraDeclarations } from "./dora.ts";
import { homeProjectDeclaration } from "./project-config.ts";
import { unwaitedLines } from "./unwaited-stock-rows.ts";
import { untieredReadyRows, untieredLines, ghReadyReader, untieredOffer, untieredSweepKey, parseUntieredMemory, UNTIERED_MEMORY_FILE, type UntieredRow } from "./untiered-ready-rows.ts";
import { HAIKU_TIER_LABEL } from "./worker-profile.ts";
import { underspecifiedLines } from "./spec-lint.ts";
import { NUMBERS, PAUSED_SHARE, READINGS_FILE, buildReport, counted, emergencyPriorityLines, ledgerEntries, previousReading, readAll, readReadings, redPrStats, retroClasses, sharedFailureEvents, specLintRefusedLines, type SharedFailures, verdictFor } from "./org-retro/readings.ts";
import { MERGED_READ_LIMIT, MS_PER_SECOND, RETRO_CAUSE, RETRO_TALLY, TICK_MINUTES, UNKNOWN, attemptDora, duration, freshRetroReads, median, readDeclaredDora, readText, type ClassBudget, type IdleClaimedHours, type PauseReading, type ReadClass, type RetroReads, utcDate } from "./org-retro/retro-cause.ts";

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

/** @param {ReturnType<typeof buildReport>["blocking"]} blocking @returns {string[]} */
function blockingLines(blocking: ReturnType<typeof buildReport>["blocking"]): string[] {
  if (blocking === undefined) return [`- Top blocker: ${UNKNOWN} (${BLOCKING_FILE} could not be read, so "nothing was shelved" cannot be said)`];
  if (blocking === null) return ["- Top blocker: none (nothing was shelved behind a claim in the window)"];
  const row = blocking.row === null ? "" : ` holding #${blocking.row}`;
  return [`- Top blocker: ${blocking.holder}${row}; shelved up to ${blocking.rows} rows for ${duration(blocking.minutes)} (${grouped(Math.round(blocking.rowMinutes))} row-minutes; measured from the gate's per-tick count)`];
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
export function resetRetroTally() {
  for (const kind of Object.keys(RETRO_TALLY) as ReadClass[]) RETRO_TALLY[kind] = { n: 0, ms: 0 };
}

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
export const RETRO_READS_FILE = "retro-reads-cache.json";

/**
 * The memory the state entry holds, or an empty one that says it is `unreadable` (a missing file is unreadable too: the first tick reads in full). The
 * returned memory writes itself as it is read (`keep`), so the daily pass's reads are kept whether or not the tick finishes.
 */
export function readRetroReads(stateDir: string): RetroReads {
  const kept = attemptDora(() => JSON.parse(readFileSync(join(stateDir, RETRO_READS_FILE), "utf8")));
  const usable = kept !== null && typeof kept === "object" && kept.marks !== null && typeof kept.marks === "object" && kept.contents !== null && typeof kept.contents === "object";
  const memory = usable ? { ...freshRetroReads(), marks: kept.marks, contents: kept.contents } : freshRetroReads({ unreadable: true });
  memory.keep = () => keepRetroReads(stateDir, memory);
  return memory;
}

/** Writes what THIS tick has used so far, and nothing else: a repository or file no longer read is dropped, so the state entry is bounded by the window. Only the daily pass calls it (through `keep`). */
export function keepRetroReads(stateDir: string, memory: RetroReads) {
  const usedOnly = <T>(entries: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(entries).filter(([key]) => memory.used.has(key)));
  keepReadings(join(stateDir, RETRO_READS_FILE), { marks: usedOnly(memory.marks), contents: usedOnly(memory.contents) });
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
