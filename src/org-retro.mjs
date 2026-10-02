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
// A LEAF, RELATIVE IMPORTS ONLY, like `repeating-lines.mjs`: `work-gate.mjs` imports it and runs before any `npm ci`/build.
//
// EVERY READ CAN BE REFUSED, AND A REFUSED READ IS `unknown`, NEVER 0 (#1286). A retrospective that printed "0 red PRs" because
// the PR list could not be read would be the org's own health reported as good by an absence, which is the defect it exists to find.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stateEntryPath } from "./host-config.mjs";
// A LEAF (`claim-labels.mjs` imports nothing): the label is read from where it is declared, `repeating-lines.mjs`'s own reason.
import { READY_LABEL } from "./claim-labels.mjs";
import { brokenChecks, redChecks as redChecksOf, isBrokenRed, isHeldRed, holdsOn } from "./red-pr.mjs";
// THE SIBLING ROW'S MODULE (#2939): it DERIVES the count from git and gh and writes no file, so the report calls it rather than reading a path.
import { gatherChanges, readLedger as readHandFixLedger, ledgerLine as handFixLine } from "./hand-fix-ledger.mjs";
import { claudeTurns, codexTurns, transcriptFiles } from "./token-audit.mjs";
import { refuseUnknownFlags, flagValue } from "./lib/cli-flags.mjs";

/** The cause this file feeds (`cause-declaration.mjs` declares it), addressed to `ceo`. */
export const RETRO_CAUSE = "org-retrospective";

/** What an unreadable source prints. Never `0`: "could not read" and "none" are different states and never share a value. */
export const UNKNOWN = "unknown";

/** The window every number covers. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

const MS_PER_MINUTE = 60 * 1000;
const MINUTES_PER_HOUR = 60;

/**
 * Minutes one tick stands for. The tick runs about every 2.1 minutes (`repeating-lines.mjs` measured it), so 2 UNDERSTATES
 * idle time slightly: the figure is a floor, and a floor is the honest direction for "how long did the org sit idle".
 */
export const TICK_MINUTES = 2;

/** `journalctl`'s own `-o short-iso` line: `2026-10-01T23:14:05+01:00 host unit[pid]: message`. */
const JOURNAL_LINE = /^(\d{4}-\d\d-\d\dT[\d:]+(?:[+-]\d\d:?\d\d|Z)) \S+ [^:]+: (.*)$/;
const TICK_START = /^Starting a11ign-work-tick\.service/;
/** A ready row was offered and no engineer could take it: the org's idle capacity next to claimable work. */
const IDLE_OFFER = /^UNDELIVERED \S*\/?ready-row-unclaimed\//;
/** A claim the org took back from its holder. `merged` is the ordinary end of a row, every other reason is a claim that stopped. */
const RELEASE = /^RELEASED #(\d+) \(([^,)]+), ([^)]+)\)/;

/** @param {number} ms @returns {string} the UTC date, `YYYY-MM-DD` */
export function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** @param {number[]} numbers @returns {number | null} `null` for none, never `0` */
export function median(numbers) {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** @param {number} minutes @returns {string} `1h30m`, or `45m` under an hour */
function duration(minutes) {
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
export function mergedStats(merged, { since, until }) {
  if (merged === null) return null;
  const inWindow = merged.filter((pr) => {
    const at = Date.parse(pr.mergedAt);
    return at >= since && at <= until;
  });
  const minutes = inWindow.map((pr) => (Date.parse(pr.mergedAt) - Date.parse(pr.createdAt)) / MS_PER_MINUTE);
  return { count: inWindow.length, medianMinutes: median(minutes) };
}

/**
 * The tick journal's lines inside the window, as `{at, message}`. A line that is not in `-o short-iso` shape is dropped, and
 * so is one that falls outside the window.
 * @param {string} text @param {{ since: number, until: number }} window
 * @returns {{ at: number, message: string }[]}
 */
export function journalLines(text, { since, until }) {
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
 * went `UNDELIVERED` (the gate offered a Ready row, and no engineer was idle and allowed to take it), each counted as
 * `TICK_MINUTES`. INFERRED FROM THE JOURNAL, NOT MEASURED PER SESSION: it says a claimable row waited through a tick, not how
 * many sessions sat idle in it -- so it is a floor on lost time, and the number to read it against is the day before.
 * @param {{ at: number, message: string }[]} lines
 * @returns {{ ticksWithIdleOffer: number, idleMinutes: number, ticks: number }}
 */
export function idleStats(lines) {
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
export function releaseStats(lines) {
  /** @type {Record<string, number>} */
  const byReason = {};
  for (const { message } of lines) {
    const match = RELEASE.exec(message);
    if (match !== null && match[3] !== "merged") byReason[match[3]] = (byReason[match[3]] ?? 0) + 1;
  }
  return { voided: Object.values(byReason).reduce((sum, n) => sum + n, 0), byReason };
}

/**
 * What the wake ledger says was DELIVERED in the window: `<epochMs>\t<causeKey>[\t...]`, with the three marker lines
 * (`RESET`, `ESCALATED`, `VOIDED`) carrying their key second. THE LEDGER'S FORMAT IS `wake.mjs`'s, which this leaf cannot
 * import (`wake` imports the gate), so the shape is read here and `org-retro.test.ts` pins it with a fixture.
 * @param {string} text @param {{ since: number, until: number }} window
 * @returns {{ at: number, key: string, marker: string | null }[]}
 */
export function ledgerEntries(text, { since, until }) {
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
export function ledgerStats(entries) {
  let orgStalled = 0;
  let claimStalled = 0;
  /** @type {Record<string, number>} */
  const healthBySignal = {};
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
 * How long each BROKEN open PR has been red, as of `now`, from the EARLIEST completion among the red checks that make it broken (`red-pr.mjs`:
 * a held PR's own two jobs do not). A PR red only because it is held is not counted: it is returned in `held`, with who holds it and for how
 * long, so the hold is reported and never silently dropped.
 * @param {{ number: number, labels?: any[], statusCheckRollup?: { name?: string, conclusion?: string, completedAt?: string }[] }[] | null} openPrs
 * @param {number} now
 * @returns {{ count: number, medianMinutes: number | null, oldest: { number: number, minutes: number } | null,
 *   held: { number: number, holders: string[], minutes: number | null }[] } | null}
 */
export function redPrStats(openPrs, now) {
  if (openPrs === null) return null;
  /** @type {{ number: number, minutes: number }[]} */
  const reds = [];
  for (const pr of openPrs.filter(isBrokenRed)) {
    const minutes = minutesRed(brokenChecks(pr), now);
    if (minutes !== null) reds.push({ number: pr.number, minutes });
  }
  const held = openPrs.filter(isHeldRed).map((pr) => ({ number: pr.number, holders: holdsOn(pr), minutes: minutesRed(redChecksOf(pr), now) }));
  const oldest = reds.reduce((top, red) => (top === null || red.minutes > top.minutes ? red : top), /** @type {typeof reds[number] | null} */ (null));
  return { count: reds.length, medianMinutes: median(reds.map((r) => r.minutes)), oldest, held };
}

/** @param {{ failedAt: number }[]} checks @param {number} now @returns {number | null} null when no check says when it failed */
function minutesRed(checks, now) {
  const failedAt = checks.map((c) => c.failedAt).filter(Number.isFinite);
  return failedAt.length === 0 ? null : (now - Math.min(...failedAt)) / MS_PER_MINUTE;
}

/**
 * Tokens in the window, from `token-audit.mjs`'s reading of the transcripts. `fresh + cacheRead + cacheWrite + output` is every
 * token the model handled; the cache split stays visible in `token-audit` itself, and a figure that dropped `cacheRead` would be
 * wrong by an order of magnitude in the flattering direction.
 * @param {{ at: number, fresh: number, cacheRead: number, cacheWrite: number, output: number, thinking: number }[] | null} turns
 * @param {{ since: number, until: number }} window
 * @returns {{ turns: number, total: number } | null}
 */
export function tokenStats(turns, { since, until }) {
  if (turns === null) return null;
  const inWindow = turns.filter((t) => t.at >= since && t.at <= until);
  return { turns: inWindow.length, total: inWindow.reduce((sum, t) => sum + t.fresh + t.cacheRead + t.cacheWrite + t.output + t.thinking, 0) };
}

/**
 * Every number, each `unknown` when its source was refused. `reads` holds the RAW reads (`null` for a refused one), so what is
 * computed here is pure and a test drives it with a fixture window whose answers are checked by hand.
 * @param {{ merged: any[] | null, openPrs: any[] | null, journal: string | null, ledger: string | null,
 *   turns: any[] | null, handFixes: ReturnType<typeof readHandFixLedger> | null }} reads
 * @param {number} now
 */
export function buildReport(reads, now) {
  const window = { since: now - WINDOW_MS, until: now };
  const lines = reads.journal === null ? null : journalLines(reads.journal, window);
  return {
    date: utcDate(now),
    window,
    merged: mergedStats(reads.merged, window),
    idle: lines === null ? null : idleStats(lines),
    releases: lines === null ? null : releaseStats(lines),
    stalls: reads.ledger === null ? null : ledgerStats(ledgerEntries(reads.ledger, window)),
    red: redPrStats(reads.openPrs, now),
    tokens: tokenStats(reads.turns, window),
    handFixes: reads.handFixes,
  };
}

/** @param {Record<string, number>} counts @returns {string} `a x2, b x1`, or `none` */
function counted(counts) {
  const parts = Object.entries(counts).map(([name, n]) => `${name} x${n}`);
  return parts.length === 0 ? "none" : parts.join(", ");
}

/** @param {number} n @returns {string} `12,345` */
function grouped(n) {
  return n.toLocaleString("en-US");
}

/** @param {ReturnType<typeof buildReport>["merged"]} merged @returns {string[]} */
function mergedLines(merged) {
  if (merged === null) return [`- PRs merged: ${UNKNOWN} (the merged-PR list could not be read)`];
  const median = merged.medianMinutes === null ? "no merge to take a median of" : `median open-to-merge ${duration(merged.medianMinutes)}`;
  return [`- PRs merged: ${merged.count}; ${median}`];
}

/**
 * THE STALL LINE: a window in which NOTHING MERGED is a stall whatever else the numbers say, and the idle minutes beside it say how
 * much claimable work waited through it. Printed only for a window that READ as zero merges: an unreadable list is `unknown` above
 * and is never a stall (#1286). The 2026-10-01 window is the positive control: zero merges while #2824 was refused for 211 ticks.
 * @param {ReturnType<typeof buildReport>} report @returns {string[]}
 */
function stallLines({ merged, idle }) {
  if (merged === null || merged.count > 0) return [];
  const waited = idle !== null && idle.idleMinutes > 0 ? `; a claimable row waited ${idle.idleMinutes} idle minutes through it` : "";
  return [`- STALL: no PR merged in the window${waited}`];
}

/** @param {ReturnType<typeof buildReport>["red"]} red @returns {string[]} */
function redLines(red) {
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
function heldLines(held) {
  if (held.length === 0) return [];
  const each = held.map((h) => `#${h.number} (${h.holders.join(", ")}${h.minutes === null ? "" : `, red ${duration(h.minutes)}`})`);
  return [`- Red PRs held on purpose (not counted above): ${held.length}: ${each.join("; ")}`];
}

/** @param {ReturnType<typeof buildReport>} report @returns {string[]} */
function journalDerivedLines(report) {
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
function spendLines({ tokens, merged, handFixes }) {
  // `ledgerLine` IS the line, wording and all: it says the window, the target, the trend and what was left out, and a refused read says UNKNOWN and "not zero".
  const handFix = handFixes === null ? `- HAND FIXES: ${UNKNOWN} (the hand-fix ledger could not be run)` : `- ${handFixLine(handFixes)}`;
  if (tokens === null) return [`- Tokens per merged PR: ${UNKNOWN} (no transcript could be read)`, handFix];
  const perPr = merged === null ? UNKNOWN : merged.count === 0 ? "n/a, no PR merged" : grouped(Math.round(tokens.total / merged.count));
  return [`- Tokens per merged PR: ${perPr} (${grouped(tokens.total)} tokens over ${grouped(tokens.turns)} turns; the transcripts' own usage fields via token-audit.mjs, cache reads included)`,
    handFix];
}

/**
 * The report as the text `ceo` is handed and posts on #928.
 * @param {ReturnType<typeof buildReport>} report @returns {string}
 */
export function renderReport(report) {
  const from = new Date(report.window.since).toISOString();
  const to = new Date(report.window.until).toISOString();
  return [`ORG RETROSPECTIVE ${report.date} -- the 24 hours ${from} to ${to}`, "",
    ...mergedLines(report.merged), ...stallLines(report), ...journalDerivedLines(report), ...redLines(report.red), ...spendLines(report), ""].join("\n");
}

/**
 * IS TODAY'S RETROSPECTIVE STILL OWED? Answered from the wake ledger, the record of what was DELIVERED, so a retrospective the
 * wake could not deliver (`ceo` busy, a restart) is offered again next tick instead of being lost, and one delivered is never
 * offered a second time on the same UTC date. KEYED ON THE DATE: the same date is the same key for the whole day, so a key on
 * the hour would offer it twenty-four times.
 * @param {number} now @param {string | null} ledger the ledger's text, `null` when unreadable
 * @returns {string | null} the date to offer, or `null` when it was already delivered or the ledger cannot say
 */
export function retrospectiveDue(now, ledger) {
  if (ledger === null) return null; // CANNOT TELL is not "not yet": offering blind would repeat it every tick of a bad read
  const date = utcDate(now);
  const delivered = ledgerEntries(ledger, { since: 0, until: Number.MAX_SAFE_INTEGER })
    .some((entry) => entry.marker === null && entry.key === retrospectiveKey(date));
  return delivered ? null : date;
}

/** @param {string} date @returns {string} */
export function retrospectiveKey(date) {
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
export function retrospectiveOrder(date, reportText) {
  return {
    session: "ceo",
    cause: "org-retrospective", // A LITERAL: `worker-profile.test.ts` finds every cause the gate can emit by scanning for `cause: "<name>"`
    subject: "org",
    discriminator: date,
    prompt: `THE DAILY RETROSPECTIVE for ${date} (UTC). Optimising the org is your scheduled duty, not a thing the chairman has to ask for. `
      + "The numbers below were computed by `node packages/agent-org/src/org-retro.mjs` from the GitHub, journal and ledger reads the gate "
      + "already makes; no model read a log, so do not re-derive them.\n\n"
      + `${reportText}\n${CLASS_FIX_INSTRUCTION}\n`
      + `Post the reading and every row you filed on ${RETRO_DESTINATION}. If nothing tripped, post "nothing tripped" WITH the numbers: a day with nothing to file is never silence. `
      + "An `unknown` is a source the script could not read, not a good day: say so, and file the unreadable source as the defect.",
    causeKey: retrospectiveKey(date),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The READS. Each returns `null` for a refused one and never throws; everything above is pure.

/** @param {string[]} args @returns {any[] | null} */
function ghJson(args) {
  try {
    return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null; // a refused read is `unknown` in the report, which says so; the cause is not narrated per read
  }
}

/** @param {string} path @returns {string | null} */
function readText(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/**
 * Transcripts untouched since before the window cannot hold a turn inside it, so their (large) text is never parsed.
 * @param {string} root @param {number} since @returns {string[]}
 */
function recentTranscripts(root, since) {
  return transcriptFiles(root).filter((file) => {
    try { return statSync(file).mtimeMs >= since; } catch { return false; }
  });
}

/** @param {number} since @returns {any[] | null} `null` only when NO transcript root could be listed at all */
function readTurns(since) {
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
function readJournal(unit) {
  try {
    return execFileSync("journalctl", ["--user", "-u", unit, "--since", "-24h", "--no-pager", "-o", "short-iso"],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/**
 * Every read the report wants, once. `stateDir` holds the wake ledger. THE HAND-FIX COUNT IS NOT A FILE IN IT: `hand-fix-ledger.mjs` derives
 * it from git and gh (#2939), and this line read a path nothing wrote for as long as the report existed (#2954). `readHandFixes` is the seam.
 * @param {{ now: number, stateDir: string, unit?: string, readHandFixes?: (now: number) => ReturnType<typeof readHandFixLedger> }} where
 */
export function readAll({ now, stateDir, unit = "a11ign-work-tick.service",
  readHandFixes = (at) => readHandFixLedger({ read: gatherChanges(), now: new Date(at) }) }) {
  const since = now - WINDOW_MS;
  return {
    merged: ghJson(["pr", "list", "--state", "merged", "--search", `merged:>=${new Date(since).toISOString()}`, "--limit", "200", "--json", "number,createdAt,mergedAt"]),
    openPrs: ghJson(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,labels,statusCheckRollup"]),
    journal: readJournal(unit),
    ledger: readText(`${stateDir}/wake-ledger`),
    turns: readTurns(since),
    handFixes: readHandFixes(now), // a refused read is a reading that says so (`status: "unknown"`), never a throw and never a 0
  };
}

/**
 * THE GATE'S WHOLE CONTACT WITH THIS FILE: the retrospective's order if today's is still owed, else none. NEVER THROWS: a broken
 * report must not stop the orders behind it, and it says so on stderr rather than offering a half-built one. The ledger is read
 * BEFORE the report, so a day already delivered costs one file read and not the day of PR, journal and transcript reads.
 * @param {{ now?: number, stateDir?: string, log?: (line: string) => void, read?: typeof readAll, readLedger?: (stateDir: string) => string | null }} [seams]
 * @returns {ReturnType<typeof retrospectiveOrder>[]}
 */
export function retrospectiveTick({ now = Date.now(), stateDir = stateEntryPath(""), log = (line) => process.stderr.write(line), read = readAll,
  readLedger = (dir) => readText(`${dir}/wake-ledger`) } = {}) {
  try {
    const date = retrospectiveDue(now, readLedger(stateDir));
    if (date === null) return [];
    return [retrospectiveOrder(date, renderReport(buildReport(read({ now, stateDir }), now)))];
  } catch (/** @type {any} */ err) {
    log(`org-retro: could not build today's retrospective (${String(err?.message ?? err).split("\n")[0]}) -- no org-retrospective order this tick.\n`);
    return [];
  }
}

function main() {
  refuseUnknownFlags(["--now"], { entry: import.meta.url, command: "node packages/agent-org/src/org-retro.mjs" });
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
