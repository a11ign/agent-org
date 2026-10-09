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
import { appendFileSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stateEntryPath } from "./host-config.ts";
// A LEAF (`claim-labels.ts` imports nothing): the label is read from where it is declared, `repeating-lines.ts`'s own reason.
import { READY_LABEL } from "./claim-labels.ts";
import { brokenChecks, redChecks as redChecksOf, isBrokenRed, isHeldRed, holdsOn } from "./red-pr.ts";
// THE SIBLING ROW'S MODULE (#2939): it DERIVES the count from git and gh and writes no file, so the report calls it rather than reading a path.
import { gatherChanges, readLedger as readHandFixLedger, ledgerLine as handFixLine } from "./hand-fix-ledger.ts";
import { claudeTurns, codexTurns, transcriptFiles } from "./token-audit.ts";
import { refuseUnknownFlags, flagValue } from "./lib/cli-flags.mjs";
// THE DORA BLOCK (a11ign/a11ign#3135): measured from the registry and GitHub, per declared repository, by its own leaf module.
import { FAILURE_LEDGER_FILE, parseFailureLedger, type FailureEntry } from "./failure-ledger.ts";
import { correctionsPerDay, correctionsLine } from "./found-by-chairman.ts";
import { readDora, readRepository, doraReport, READ_TIMEOUT_MS, renderDora, doraNumbers, doraDeclarations } from "./dora.ts";
import { homeProjectDeclaration } from "./project-config.ts";
// THE STOCK-ROW READING (#4175): its own leaf, because it asks the tracker per row and a refused read there names the row.
import { unwaitedStockRows, unwaitedLines, ghTrackerReader } from "./unwaited-stock-rows.ts";

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

/** @param {string} repo @param {number} since @returns {string[]} the `gh` arguments: `-R` NAMES the repository, since a read with none answers for the working directory's alone */
export function mergedPrsArgs(repo: string, since: number): string[] {
  return ["pr", "list", "-R", repo, "--state", "merged", "--search", `merged:>=${new Date(since).toISOString()}`, "--limit", String(MERGED_READ_LIMIT), "--json", "number,createdAt,mergedAt"];
}

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
export function readMerged({ declaration, since, readPrs = (repo, from) => ghJson(mergedPrsArgs(repo, from)) }: { declaration: Parameters<typeof mergedPopulation>[0]; since: number; readPrs?: (repo: string, since: number) => any[] | null; }): { repo: string; prs: any[] | null; limitHit: boolean; }[] {
  return mergedPopulation(declaration).map((repo) => {
    const prs = readPrs(repo, since);
    const limitHit = prs !== null && prs.length >= MERGED_READ_LIMIT;
    return { repo, prs: limitHit ? null : prs, limitHit };
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
 * @param {{ at: number, message: string }[]} lines
 * @returns {{ ticksWithIdleOffer: number, idleMinutes: number, ticks: number }}
 */
export function idleStats(lines: { at: number; message: string; }[]): { ticksWithIdleOffer: number; idleMinutes: number; ticks: number; } {
  let ticks = 0;
  let current = -1;
  const idleTicks = new Set();
  for (const { message } of lines) {
    if (TICK_START.test(message)) { ticks += 1; current = ticks; }
    else if (IDLE_OFFER.test(message) && current > 0) idleTicks.add(current);
  }
  return { ticksWithIdleOffer: idleTicks.size, idleMinutes: idleTicks.size * TICK_MINUTES, ticks };
}

/**
 * Claims taken back from their holder, by reason, from the journal's `RELEASED #N (session, reason)` lines. Those that ended
 * `merged` are a row finishing; every other reason is a claim that stopped moving, which is what a `claim-stall` voiding is.
 * @param {{ at: number, message: string }[]} lines
 * @returns {{ voided: number, byReason: Record<string, number> }}
 */
export function releaseStats(lines: { at: number; message: string; }[]): { voided: number; byReason: Record<string, number>; } {
  const byReason: Record<string, number> = {};
  for (const { message } of lines) {
    const match = RELEASE.exec(message);
    if (match !== null && match[3] !== "merged") byReason[match[3]] = (byReason[match[3]] ?? 0) + 1;
  }
  return { voided: Object.values(byReason).reduce((sum, n) => sum + n, 0), byReason };
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

/**
 * Every number, each `unknown` when its source was refused. `reads` holds the RAW reads (`null` for a refused one), so what is
 * computed here is pure and a test drives it with a fixture window whose answers are checked by hand.
 * @param {{ merged: any[] | null, mergedRepositories?: ReturnType<typeof readMerged> | null, openPrs: any[] | null, journal: string | null, ledger: string | null,
 *   turns: any[] | null, handFixes: ReturnType<typeof readHandFixLedger> | null, readings?: Readings, dora?: ReturnType<typeof readDora> | null,
 *   unwaited?: ReturnType<typeof unwaitedStockRows> | null, failureLedger?: string | null }} reads
 * `failureLedger` absent or `null` is a ledger nobody read or that could not be read (a line that does not parse included): the corrections line says `unknown`, never `0`.
 * `unwaited` absent or `null` is a stock-row read nobody made or that was refused: `unknown`, never 0.
 * `dora` absent is a read nobody asked for (no block); `dora: null` is one that was REFUSED, which prints `unknown`.
 * `merged` is the PRIMARY repository's list alone, the count's definition before #3593, and `mergedRepositories` is every declared one: absent is a project read
 * the old way (the total IS `merged`), `null` is a declaration that could not be read.
 * @param {number} now
 */
export function buildReport(reads: {
        merged: any[] | null; mergedRepositories?: ReturnType<typeof readMerged> | null; openPrs: any[] | null; journal: string | null; ledger: string | null;
        turns: any[] | null; handFixes: ReturnType<typeof readHandFixLedger> | null; readings?: Readings; dora?: ReturnType<typeof readDora> | null;
        unwaited?: ReturnType<typeof unwaitedStockRows> | null; failureLedger?: string | null;
    }, now: number) {
  const window = { since: now - WINDOW_MS, until: now };
  const lines = reads.journal === null ? null : journalLines(reads.journal, window);
  const across = reads.mergedRepositories === undefined ? undefined : mergedAcross(reads.mergedRepositories ?? [], window);
  const report = {
    date: utcDate(now),
    window,
    merged: across === undefined ? mergedStats(reads.merged, window) : across.total,
    mergedRepositories: across?.byRepository,
    mergedPrimaryOnly: mergedStats(reads.merged, window),
    idle: lines === null ? null : idleStats(lines),
    releases: lines === null ? null : releaseStats(lines),
    stalls: reads.ledger === null ? null : ledgerStats(ledgerEntries(reads.ledger, window)),
    red: redPrStats(reads.openPrs, now),
    tokens: tokenStats(reads.turns, window),
    handFixes: reads.handFixes,
    corrections: correctionsPerDay(parsedFailureLedger(reads.failureLedger), new Date(now)),
    unwaited: reads.unwaited ?? null,
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
export type Verdict = "better" | "worse" | "same" | "no baseline" | "unknown" | "undefined";

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
 * @param {readonly { id: string, label: string, better: "lower" | "higher", undefinedToday?: boolean }[]} [declarations]
 */
export function compareReadings(numbers: Record<string, number | null>, previous: ReturnType<typeof previousReading>, declarations: readonly { id: string; label: string; better: "lower" | "higher"; undefinedToday?: boolean; }[] = []) {
  return Object.entries(numbers).map(([id, current]) => {
    const declared = NUMBERS.find((n) => n.id === id) ?? declarations.find((n) => n.id === id);
    const before = previous.status === "read" ? (previous.numbers[id] ?? null) : null;
    const verdict = declared === undefined ? ("undeclared" as const)
      : "undefinedToday" in declared && declared.undefinedToday ? ("undefined" as const) : verdictFor({ better: declared.better, previous, id, current });
    const delta = current !== null && before !== null ? current - before : null;
    return { id, label: declared?.label ?? id, current, previous: before, delta, verdict };
  });
}

/** @param {number | null} n @returns {string} */
const shown = (n: number | null): string => (n === null ? UNKNOWN : grouped(n));

/** @param {ReturnType<typeof buildReport>} report @returns {string[]} */
function trendLines({ numbers, previous, dora }: ReturnType<typeof buildReport>): string[] {
  const against = previous.status === "read" ? `the previous reading, ${previous.date}` : previous.status === "none" ? "the previous reading (none yet)" : `the previous reading (${UNKNOWN}: ${READINGS_FILE} could not be read)`;
  const lines = compareReadings(numbers, previous, doraDeclarations(dora)).map((c) => {
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
      : `- Idle minutes while a claimable row existed: ${idle.idleMinutes} (${idle.ticksWithIdleOffer} of ${idle.ticks} ticks offered a Ready row nobody could take; inferred from the journal at ${TICK_MINUTES} min a tick, a floor)`,
    stalls === null ? `- Stalls (org-stalled wakes): ${unreadLedger}` : `- Stalls (org-stalled wakes): ${stalls.orgStalled}; claim-stalled wakes: ${stalls.claimStalled}`,
    releases === null ? `- Claim-stall voidings (claims released for a reason other than merged): ${unreadJournal}`
      : `- Claim-stall voidings (claims released for a reason other than merged): ${releases.voided} (${counted(releases.byReason)})`,
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

/**
 * The report as the text `ceo` is handed and posts on #928.
 * @param {ReturnType<typeof buildReport>} report @returns {string}
 */
export function renderReport(report: ReturnType<typeof buildReport>): string {
  const from = new Date(report.window.since).toISOString();
  const to = new Date(report.window.until).toISOString();
  return [`ORG RETROSPECTIVE ${report.date} -- the 24 hours ${from} to ${to}`, "",
    ...mergedLines(report), ...stallLines(report), ...journalDerivedLines(report), ...redLines(report.red), ...spendLines(report), ...unwaitedLines(report.unwaited), ...doraLines(report.dora), ...trendLines(report), ""].join("\n");
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
      + "The numbers below were computed by `node --import tsx packages/agent-org/src/org-retro.ts` from the GitHub, journal and ledger reads the gate "
      + "already makes; no model read a log, so do not re-derive them.\n\n"
      + `${reportText}\n${CLASS_FIX_INSTRUCTION} The verdict beside each number is against the previous reading; \`no baseline\` and \`unknown\` are not good days.\n`
      + `Post the reading and every row you filed on ${RETRO_DESTINATION}. If nothing tripped, post "nothing tripped" WITH the numbers: a day with nothing to file is never silence. `
      + "An `unknown` is a source the script could not read, not a good day: say so, and file the unreadable source as the defect.",
    causeKey: retrospectiveKey(date),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The READS. Each returns `null` for a refused one and never throws; everything above is pure.

/** @param {string[]} args @returns {any[] | null} */
function ghJson(args: string[]): any[] | null {
  try {
    return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: READ_TIMEOUT_MS }));
  } catch {
    return null; // a refused read is `unknown` in the report, which says so; the cause is not narrated per read, and a hung one is refused at the bound (#3736)
  }
}

/** @template T @param {() => T} read @returns {T | null} `null` for a refused read (a declaration that will not parse included) */
function attemptDora<T>(read: () => T): T | null {
  try { return read(); } catch { return null; }
}

/** @param {number} now @returns {ReturnType<typeof readDora>} every repository the project declares, through the real readers */
const readDeclaredDora = (now: number): ReturnType<typeof readDora> => readDora({ repositories: homeProjectDeclaration().dora, now });

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

/** @param {string} unit @returns {string | null} */
function readJournal(unit: string): string | null {
  try {
    return execFileSync("journalctl", ["--user", "-u", unit, "--since", "-24h", "--no-pager", "-o", "short-iso"],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/**
 * Every read the report wants, once. `stateDir` holds the wake ledger. THE HAND-FIX COUNT IS NOT A FILE IN IT: `hand-fix-ledger.ts` derives
 * it from git and gh (#2939), and this line read a path nothing wrote for as long as the report existed (#2954). `readHandFixes` is the seam.
 * THE DORA READ IS THE DECLARATION'S (`dora.ts`): the repositories `.agent-org/project.json` lists, read from the registry and GitHub. `readDoraReport` is its seam.
 * @param {{ now: number, stateDir: string, unit?: string, readHandFixes?: (now: number) => ReturnType<typeof readHandFixLedger>,
 *   readDoraReport?: (now: number) => ReturnType<typeof readDora> | null, readUnwaited?: (now: number) => ReturnType<typeof unwaitedStockRows>, readMergedRepositories?: (now: number) => ReturnType<typeof readMerged> }} where
 * MERGED PRS ARE READ FROM EVERY DECLARED REPOSITORY (`readMerged`, #3593), each named with `-R`; `merged` stays the PRIMARY's list, the definition the count had before.
 */
export function readAll({ now, stateDir, unit = "a11ign-work-tick.service",
  readMergedRepositories = (at) => readMerged({ declaration: homeProjectDeclaration(), since: at - WINDOW_MS }),
  readHandFixes = (at) => readHandFixLedger({ read: gatherChanges(), now: new Date(at) }),
  readUnwaited = (at) => unwaitedStockRows({ reader: ghTrackerReader(homeProjectDeclaration().repo), now: at }),
  readDoraReport = readDeclaredDora }: {
        now: number; stateDir: string; unit?: string; readHandFixes?: (now: number) => ReturnType<typeof readHandFixLedger>;
        readDoraReport?: (now: number) => ReturnType<typeof readDora> | null; readUnwaited?: (now: number) => ReturnType<typeof unwaitedStockRows>; readMergedRepositories?: (now: number) => ReturnType<typeof readMerged>;
    }) {
  const since = now - WINDOW_MS;
  const mergedRepositories = attemptDora(() => readMergedRepositories(now));
  return {
    merged: mergedRepositories?.[0]?.prs ?? null,
    mergedRepositories,
    openPrs: ghJson(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,labels,statusCheckRollup"]),
    journal: readJournal(unit),
    ledger: readText(`${stateDir}/wake-ledger`),
    failureLedger: readText(`${stateDir}/${FAILURE_LEDGER_FILE}`),
    turns: readTurns(since),
    readings: readReadings(join(stateDir, READINGS_FILE)),
    handFixes: readHandFixes(now), // a refused read is a reading that says so (`status: "unknown"`), never a throw and never a 0
    unwaited: attemptDora(() => readUnwaited(now)), // a declaration that will not parse is a refused read, like the DORA one
    dora: attemptDora(() => readDoraReport(now)),
  };
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
 * @param {{ dora?: Partial<Parameters<typeof resumableDora>[0]>, readRest?: (where: Parameters<typeof readAll>[0]) => ReturnType<typeof readAll> }} [seams]
 */
export function readWhenDoraIsRead(where: { now: number; stateDir: string; }, { dora = {}, readRest = readAll }: { dora?: Partial<Parameters<typeof resumableDora>[0]>; readRest?: (where: Parameters<typeof readAll>[0]) => ReturnType<typeof readAll>; } = {}) {
  const progress = resumableDora({ stateDir: where.stateDir, now: where.now, ...dora });
  return progress.complete ? readRest({ ...where, readDoraReport: () => progress.report }) : { doraPending: progress };
}

/**
 * THE GATE'S WHOLE CONTACT WITH THIS FILE: the retrospective's order if today's is still owed, else none. NEVER THROWS: a broken
 * report must not stop the orders behind it, and it says so on stderr rather than offering a half-built one. The ledger is read
 * BEFORE the report, so a day already delivered costs one file read and not the day of PR, journal and transcript reads.
 * THE ONLY WRITER OF THE READINGS FILE (`main` below never writes): offering the retrospective IS recording today's reading.
 * A TICK THAT HAS NOT YET READ EVERY DECLARED REPOSITORY offers nothing and says how many it has (#3736): `read` answers `{ doraPending }` and the other reads are not made.
 * @param {{ now?: number, stateDir?: string, log?: (line: string) => void, read?: (where: Parameters<typeof readAll>[0]) => Parameters<typeof buildReport>[0] | { doraPending: Extract<ReturnType<typeof resumableDora>, { complete: false }> }, readLedger?: (stateDir: string) => string | null,
 *   record?: typeof recordReading }} [seams]
 * @returns {ReturnType<typeof retrospectiveOrder>[]}
 */
export function retrospectiveTick({ now = Date.now(), stateDir = stateEntryPath(""), log = (line) => process.stderr.write(line),
  read = (where) => readWhenDoraIsRead(where),
  readLedger = (dir) => readText(`${dir}/wake-ledger`), record = recordReading }: {
        now?: number; stateDir?: string; log?: (line: string) => void; read?: (where: Parameters<typeof readAll>[0]) => Parameters<typeof buildReport>[0] | { doraPending: Extract<ReturnType<typeof resumableDora>, { complete: false; }>; }; readLedger?: (stateDir: string) => string | null;
        record?: typeof recordReading;
    } = {}): ReturnType<typeof retrospectiveOrder>[] {
  try {
    const date = retrospectiveDue(now, readLedger(stateDir));
    if (date === null) return [];
    const inputs = read({ now, stateDir });
    if ("doraPending" in inputs) {
      const { read: done, of, readThisTick, elapsedMs } = inputs.doraPending;
      log(`org-retro: the DORA read has ${done} of ${of} repositories (${readThisTick} read this tick, ${Math.round(elapsedMs / MS_PER_SECOND)} s); no org-retrospective order until every declared repository is read.\n`);
      return [];
    }
    const report = buildReport(inputs, now);
    const text = renderReport(report);
    keepReading(record, { stateDir, date, numbers: report.numbers, mergedRepositories: report.mergedRepositories?.map((r) => r.repo) }, log);
    return [retrospectiveOrder(date, text)];
  } catch (err: any) {
    log(`org-retro: could not build today's retrospective (${String(err?.message ?? err).split("\n")[0]}) -- no org-retrospective order this tick.\n`);
    return [];
  }
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
  refuseUnknownFlags(["--now"], { entry: import.meta.url, command: "node --import tsx packages/agent-org/src/org-retro.ts" });
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
