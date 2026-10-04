#!/usr/bin/env node
// @ts-check
// command: wakes:per-row -- how many model turns the org started for each merged row, and what they cost in bytes (a11ign/a11ign#3452, chairman 2026-10-04).
//
// WHY IT EXISTS: every wake re-reads the worker's whole window (~80-100k tokens), and nobody could say how many a merged row received, so none of the rows meant
// to stop wakes could show they had. The number is a reading taken twice from this one script (before the sibling rows, after them) and posted on #928.
//
// THE DEFINITIONS are `DEFINITIONS` below, printed at the top of every report so a figure never travels without them. Three of them decide the number:
//   THE TRANSCRIPT IS THE SOURCE of a wake; the wake ledger is the cross-check and the cause label, and a ledger line matching a transcript wake is that wake.
//   ATTRIBUTION IS BY CLAIM for a worker (the latest-claimed row at or before the wake, until the instance ended): a wake delivered after the row MERGED still
//     belongs to the row, because it is exactly the wake that carried no news. A reviewer is attributed inside its pull request's own open-to-merge window.
//   UNMEASURED, NEVER ZERO: a row whose claimant's transcript is unreadable or absent is left out of the mean and the median and listed.
//
// A LEAF: it imports nothing from the tool, and `measure` is pure, so the test runs it on fixtures and never reads `~/.claude`.
//
// GITHUB IS READ THROUGH `gh api` ONLY (the REST pool): `gh pr list` spends GRAPHQL, and a session that reads this with that pool exhausted has read nothing.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFINITIONS = [
  "WAKE: a delivery that starts a model turn in a session -- a transcript `user` record wrapped in `<pasted_content`. /compact, /clear, local-command echoes, the continuation summary and tool results are not wakes.",
  "SOURCE: the transcript. The wake ledger only labels a wake with its cause; a line seen in both is one wake.",
  "WHICH SESSIONS: Claude sessions. Codex reviewer rollouts carry no org session name and are their own line.",
  "ATTRIBUTION: worker-<n> by claim, until its instance ended (a wake after the merge still counts for the row, and is counted as after-merge); reviewer-<n> inside its pull request's open-to-merge window.",
  "REMAINDER: every wake delivered in the window that belongs to no merged row, with its session and reason. The standing leads are probably a large share, and silence about them would flatter the number.",
  "UNMEASURED: a row whose claimant's transcript is unreadable or absent. Never counted as zero wakes, and left out of the mean and median.",
  "STALE AT TYPING: a `blocker-cleared` or `claim-stalled` wake typed after a pull request closing the row had already opened.",
  "NO MEASURABLE CHANGE: a before/after difference inside the day-to-day spread of the before window (max - min of the daily means).",
];

/** A wake is a transcript user record whose text starts with this (leading whitespace is part of the real shape). */
const WAKE_WRAPPER = /^\s*<pasted_content/;
const SESSION_NAME = /You are `([^`]+)`/;
/** The ledger stamps a wake when `wake` TYPES it; the transcript stamps it when the harness DELIVERS it (34s later after a `/compact` in the measured case). */
const LEDGER_LEAD_MS = 10 * 60 * 1000;
const LEDGER_SKEW_MS = 2000;
/** Causes whose text says "pick this row up" or "you are idle with no wait": both are false once a pull request for the row is open. */
const STALE_WHEN_PR_OPEN = new Set(["blocker-cleared", "claim-stalled"]);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_SECOND = 1000;
const MIDPOINT_DIVISOR = 2;
const DECIMALS = 2;
const GH_MAX_BUFFER = 64 * 1024 * 1024;
const GH_TIMEOUT_MS = 120 * 1000;
const SEARCH_PAGE = 100;
const CLAIM_MARKER = "<!-- row-claim: claim record -->";

/**
 * @typedef {{ at: number, bytes: number, session: string | null }} Wake
 * @typedef {{ ok: true, file: string, session: string | null, wakes: Wake[], compactions: number }
 *   | { ok: false, file: string, session: string | null, reason: string }} Transcript
 * @typedef {{ at: number, key: string, session: string, cause: string }} LedgerEntry
 * @typedef {{ repo: string, number: number, createdAt: string, mergedAt: string, body: string }} PullRequest
 * @typedef {{ session: string, rows: number[], spawnedAt: number | null, endedAt: number | null }} Instance
 */

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Reading a transcript: what is a wake

/**
 * @param {any} record
 * @returns {boolean}
 */
export function isWake(record) {
  const content = record?.message?.content;
  return record?.type === "user" && !record.isCompactSummary && !record.isMeta && typeof content === "string" && WAKE_WRAPPER.test(content);
}

/**
 * Parse one transcript. ANY line that is not JSON makes the whole file unreadable: a wake count read off half a file is a lower bound wearing a count's clothes.
 * @param {string} text
 * @param {string} file
 * @returns {Transcript}
 */
export function parseTranscript(text, file) {
  /** @type {Wake[]} */
  const wakes = [];
  let compactions = 0;
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (cause) {
      return { ok: false, file, session: sessionHint(text), reason: `line ${index + 1} is not JSON (${/** @type {Error} */ (cause).message})` };
    }
    if (record?.isCompactSummary === true) compactions += 1;
    if (!isWake(record)) continue;
    const at = Date.parse(record.timestamp);
    if (Number.isNaN(at)) return { ok: false, file, session: sessionHint(text), reason: `a wake at line ${index + 1} has no readable timestamp` };
    wakes.push({ at, bytes: Buffer.byteLength(record.message.content), session: sessionOf(record.message.content) });
  }
  const session = wakes.map((wake) => wake.session).find(Boolean) ?? null;
  return { ok: true, file, session, wakes, compactions };
}

/** @param {string} content */
function sessionOf(content) {
  return SESSION_NAME.exec(content)?.[1] ?? null;
}

/** An unreadable file can still say who it was: the first order names its session. @param {string} text */
function sessionHint(text) {
  return SESSION_NAME.exec(text)?.[1] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The ledger: the cross-check and the cause

/**
 * `ts<TAB>key[<TAB>session...]`. `RESET` and `ESCALATED` lines are bookkeeping about an earlier line, not a delivery. A key under the `engineers` group names its
 * session in the third field (the first order of a row).
 * @param {string} text
 * @returns {LedgerEntry[]}
 */
export function parseLedger(text) {
  /** @type {LedgerEntry[]} */
  const entries = [];
  for (const line of text.split("\n")) {
    const [stamp, key, third] = line.split("\t");
    const at = Number(stamp);
    if (!key || key === "RESET" || key === "ESCALATED" || !Number.isFinite(at)) continue;
    const [group, cause = ""] = key.split("/");
    const session = group === "engineers" ? third : group;
    if (session) entries.push({ at, key, session, cause });
  }
  return entries;
}

/**
 * Pair each wake of ONE session with the nearest unused ledger line typed at or before it. A paired line is the same wake, so it is consumed and never counted
 * again; a line left over is reported by the caller as ledger-only (emitted, not seen delivered).
 * @param {Wake[]} wakes
 * @param {LedgerEntry[]} entries
 * @returns {{ wakes: (Wake & { cause: string, typedAt: number })[], unmatched: LedgerEntry[] }}
 */
export function matchLedger(wakes, entries) {
  const free = [...entries].sort((a, b) => a.at - b.at);
  const labelled = [...wakes].sort((a, b) => a.at - b.at).map((wake) => {
    const found = free.findLastIndex((entry) => entry.at <= wake.at + LEDGER_SKEW_MS && entry.at >= wake.at - LEDGER_LEAD_MS);
    if (found < 0) return { ...wake, cause: "unknown", typedAt: wake.at };
    const [entry] = free.splice(found, 1);
    return { ...wake, cause: entry.cause, typedAt: entry.at };
  });
  return { wakes: labelled, unmatched: free };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Merged rows

/**
 * The rows a pull request body closes. `Closes: none -- ...` closes nothing, and a reference to another repository's issue is not a row.
 * @param {string} body
 * @param {string} rowRepo the repository rows live in (the first tracker of the project's declaration): a bare `#n` is one of ITS rows
 * @returns {number[]}
 */
export function rowsClosedBy(body, rowRepo) {
  const rows = new Set();
  for (const line of body.split("\n")) {
    const closing = /^\s*closes\b:?\s*(.*)$/i.exec(line);
    if (!closing || /^none\b/i.test(closing[1])) continue;
    for (const ref of closing[1].matchAll(/(?:([\w.-]+\/[\w.-]+))?#(\d+)/g)) {
      if (!ref[1] || ref[1] === rowRepo) rows.add(Number(ref[2]));
    }
  }
  return [...rows];
}

/**
 * One entry per row closed by a merged pull request. A row two pull requests close is read at its LAST merge, in that pull request's repository, and its
 * `lastOpenedAt` is the latest opening: "the work was already open" is true from the FIRST opening, which is `firstOpenedAt`.
 * @param {PullRequest[]} pulls
 * @param {{ from: number, to: number }} window by merge time
 * @param {string} rowRepo
 */
export function mergedRows(pulls, window, rowRepo) {
  /** @type {Map<number, { row: number, repo: string, pulls: number[], firstOpenedAt: number, lastOpenedAt: number, mergedAt: number }>} */
  const rows = new Map();
  for (const pull of pulls) {
    const mergedAt = Date.parse(pull.mergedAt);
    const openedAt = Date.parse(pull.createdAt);
    for (const row of rowsClosedBy(pull.body, rowRepo)) {
      const known = rows.get(row);
      if (!known) rows.set(row, { row, repo: pull.repo, pulls: [pull.number], firstOpenedAt: openedAt, lastOpenedAt: openedAt, mergedAt });
      else rows.set(row, laterMerge(known, { repo: pull.repo, number: pull.number, openedAt, mergedAt }));
    }
  }
  return [...rows.values()].filter((entry) => entry.mergedAt >= window.from && entry.mergedAt < window.to);
}

/**
 * @param {{ repo: string, pulls: number[], firstOpenedAt: number, lastOpenedAt: number, mergedAt: number, row: number }} known
 * @param {{ repo: string, number: number, openedAt: number, mergedAt: number }} next
 */
function laterMerge(known, next) {
  const later = next.mergedAt > known.mergedAt;
  return {
    ...known,
    repo: later ? next.repo : known.repo,
    mergedAt: later ? next.mergedAt : known.mergedAt,
    pulls: [...known.pulls, next.number],
    firstOpenedAt: Math.min(known.firstOpenedAt, next.openedAt),
    lastOpenedAt: Math.max(known.lastOpenedAt, next.openedAt),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Attribution

/**
 * `reviewer-3402` is pull request 3402 of the primary repository, `reviewer-agent-org-141` is agent-org#141.
 * @param {string} session
 * @param {string} rowRepo the primary repository; a keyed reviewer's repository is named in the same organisation
 * @returns {{ repo: string, number: number } | null}
 */
export function reviewerTarget(session, rowRepo) {
  const named = /^reviewer-(?:([a-z0-9-]+?)-)?(\d+)$/.exec(session);
  // A key ending in -<digits> cannot be declared (project-config.mjs), because the name would parse two ways: `reviewer-tool-2-9` is no reviewer.
  if (!named || (named[1] && /-[0-9]+$/.test(named[1]))) return null;
  return { repo: named[1] ? `${rowRepo.split("/")[0]}/${named[1]}` : rowRepo, number: Number(named[2]) };
}

/**
 * The row a worker wake belongs to: the latest-claimed row at or before it, among the rows of an instance that had not yet ended.
 * @param {Wake} wake
 * @param {Instance[]} instances every instance of this session
 * @param {Map<number, number | null>} claimedAt row -> claim time, null when unread
 * @returns {{ row: number } | { reason: string }}
 */
export function workerRowFor(wake, instances, claimedAt) {
  const live = instances.filter((instance) => instance.endedAt === null || wake.at < instance.endedAt);
  if (live.length === 0) return { reason: "after-instance-ended" };
  const candidates = live.flatMap((instance) => instance.rows.map((row) => ({ row, start: claimedAt.get(row) ?? instance.spawnedAt ?? -Infinity })));
  const started = candidates.filter((candidate) => candidate.start <= wake.at).sort((a, b) => b.start - a.start);
  return started.length > 0 ? { row: started[0].row } : { reason: "before-any-claim" };
}

/**
 * @typedef {{ row: number, repo: string, firstOpenedAt: number, lastOpenedAt: number, mergedAt: number, pulls: number[] }} MergedRow
 * @typedef {Wake & { cause: string, typedAt: number, session: string }} SessionWake
 * @typedef {{ row: number, repo: string, measured: boolean, unmeasured?: string, wakes: number, workerWakes: number, reviewerWakes: number,
 *   afterOpened: number, afterMerged: number, stale: number, bytes: number, causes: Record<string, number>, mergedAt: number }} RowReading
 */

/**
 * @param {{ window: { from: number, to: number }, pulls: PullRequest[], transcripts: Transcript[], ledger: LedgerEntry[], instances: Instance[],
 *   claimedAt: Map<number, number | null>, rowRepo: string, codexRollouts?: number }} input
 */
export function measure(input) {
  const { window, pulls, transcripts, ledger, instances, claimedAt, rowRepo } = input;
  const rows = mergedRows(pulls, window, rowRepo);
  const bySession = wakesBySession(transcripts, ledger);
  const claimants = new Map(rows.map((row) => [row.row, instances.filter((instance) => instance.rows.includes(row.row))]));
  const readings = new Map(rows.map((row) => [row.row, emptyReading(row, claimants.get(row.row) ?? [], bySession, transcripts)]));
  /** @type {{ wake: SessionWake, reason: string }[]} */
  const remainder = [];
  for (const [session, wakes] of bySession.wakes) {
    for (const wake of wakes) {
      const placed = place(wake, { session, instances, claimedAt, rows, pulls, rowRepo });
      const reading = "row" in placed ? readings.get(placed.row) : undefined;
      if (reading && "row" in placed) addWake(reading, wake, rows.find((row) => row.row === placed.row), placed.as);
      else if (wake.at >= window.from && wake.at < window.to) remainder.push({ wake, reason: "reason" in placed ? placed.reason : "on-a-row-not-merged-in-the-window" });
    }
  }
  return report({ window, readings: [...readings.values()], remainder, transcripts, bySession, codexRollouts: input.codexRollouts ?? null });
}

/**
 * @param {Transcript[]} transcripts
 * @param {LedgerEntry[]} ledger
 */
function wakesBySession(transcripts, ledger) {
  // A ledger line typed long before any wake this reading can see is old news, not a wake that went missing.
  const earliest = Math.min(...transcripts.flatMap((transcript) => (transcript.ok ? transcript.wakes.map((wake) => wake.at) : [])));
  /** @type {Map<string, Wake[]>} */
  const raw = new Map();
  for (const transcript of transcripts) {
    if (!transcript.ok || !transcript.session) continue;
    raw.set(transcript.session, [...(raw.get(transcript.session) ?? []), ...transcript.wakes]);
  }
  /** @type {Map<string, SessionWake[]>} */
  const wakes = new Map();
  let ledgerOnly = 0;
  for (const [session, list] of raw) {
    const matched = matchLedger(list, ledger.filter((entry) => entry.session === session && entry.at >= earliest - LEDGER_LEAD_MS));
    ledgerOnly += matched.unmatched.length;
    wakes.set(session, matched.wakes.map((wake) => ({ ...wake, session })));
  }
  return { wakes, ledgerOnly };
}

/**
 * @param {SessionWake} wake
 * @param {{ session: string, instances: Instance[], claimedAt: Map<number, number | null>, rows: MergedRow[], pulls: PullRequest[], rowRepo: string }} context
 * @returns {{ row: number, as: "worker" | "reviewer" } | { reason: string }}
 */
function place(wake, context) {
  const target = reviewerTarget(context.session, context.rowRepo);
  if (target) return placeReviewer(wake, target, context);
  const mine = context.instances.filter((instance) => instance.session === context.session);
  if (mine.length === 0) return { reason: `standing:${context.session}` };
  const chosen = workerRowFor(wake, mine, context.claimedAt);
  if ("reason" in chosen) return chosen;
  return context.rows.some((row) => row.row === chosen.row) ? { row: chosen.row, as: "worker" } : { reason: "on-a-row-not-merged-in-the-window" };
}

/**
 * @param {SessionWake} wake
 * @param {{ repo: string, number: number }} target
 * @param {{ rows: MergedRow[], pulls: PullRequest[], rowRepo: string }} context
 */
function placeReviewer(wake, target, context) {
  const pull = context.pulls.find((candidate) => candidate.repo === target.repo && candidate.number === target.number);
  if (!pull) return { reason: "reviewer-of-a-pull-request-that-did-not-merge" };
  const closed = rowsClosedBy(pull.body, context.rowRepo).find((row) => context.rows.some((merged) => merged.row === row));
  if (closed === undefined) return { reason: "reviewer-of-a-pull-request-closing-no-merged-row" };
  const inside = wake.at >= Date.parse(pull.createdAt) && wake.at <= Date.parse(pull.mergedAt);
  return inside ? { row: closed, as: /** @type {const} */ ("reviewer") } : { reason: "reviewer-outside-its-pull-request-window" };
}

/**
 * @param {MergedRow} row
 * @param {Instance[]} claimants
 * @param {{ wakes: Map<string, SessionWake[]> }} bySession
 * @param {Transcript[]} transcripts
 * @returns {RowReading}
 */
function emptyReading(row, claimants, bySession, transcripts) {
  const base = { row: row.row, repo: row.repo, mergedAt: row.mergedAt, wakes: 0, workerWakes: 0, reviewerWakes: 0, afterOpened: 0, afterMerged: 0, stale: 0, bytes: 0, causes: {} };
  if (claimants.length === 0) return { ...base, measured: false, unmeasured: "no claimant recorded for the row" };
  for (const { session } of claimants) {
    const own = transcripts.filter((transcript) => transcript.session === session);
    if (own.some((transcript) => !transcript.ok)) return { ...base, measured: false, unmeasured: `${session}: a transcript is unreadable` };
    if (!bySession.wakes.has(session)) return { ...base, measured: false, unmeasured: `${session}: no transcript found` };
  }
  return { ...base, measured: true };
}

/**
 * @param {RowReading} reading
 * @param {SessionWake} wake
 * @param {MergedRow | undefined} row
 * @param {"worker" | "reviewer"} as
 */
function addWake(reading, wake, row, as) {
  if (!row || !reading.measured) return;
  reading.wakes += 1;
  reading[as === "worker" ? "workerWakes" : "reviewerWakes"] += 1;
  reading.bytes += wake.bytes;
  reading.causes[wake.cause] = (reading.causes[wake.cause] ?? 0) + 1;
  if (wake.at > row.lastOpenedAt) reading.afterOpened += 1;
  if (wake.at > row.mergedAt) reading.afterMerged += 1;
  if (STALE_WHEN_PR_OPEN.has(wake.cause) && wake.typedAt > row.firstOpenedAt) reading.stale += 1;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The report

/** @param {number[]} values */
export function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** @param {number[]} values */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / MIDPOINT_DIVISOR);
  return sorted.length % MIDPOINT_DIVISOR ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / MIDPOINT_DIVISOR;
}

/**
 * @param {{ window: { from: number, to: number }, readings: RowReading[], remainder: { wake: SessionWake, reason: string }[], transcripts: Transcript[],
 *   bySession: { ledgerOnly: number }, codexRollouts: number | null }} input
 */
function report(input) {
  const measured = input.readings.filter((reading) => reading.measured);
  const wakes = measured.map((reading) => reading.wakes);
  const totalWakes = wakes.reduce((sum, value) => sum + value, 0);
  const totalBytes = measured.reduce((sum, reading) => sum + reading.bytes, 0);
  return {
    window: input.window,
    rows: input.readings.sort((a, b) => a.row - b.row),
    mergedRows: input.readings.length,
    measuredRows: measured.length,
    unmeasured: input.readings.filter((reading) => !reading.measured).map((reading) => ({ row: reading.row, reason: reading.unmeasured })),
    attributedWakes: totalWakes,
    wakesPerRow: { mean: mean(wakes), median: median(wakes) },
    afterOpened: measured.reduce((sum, reading) => sum + reading.afterOpened, 0),
    afterMerged: measured.reduce((sum, reading) => sum + reading.afterMerged, 0),
    stale: measured.reduce((sum, reading) => sum + reading.stale, 0),
    bytesPerWake: totalWakes === 0 ? null : totalBytes / totalWakes,
    daily: dailyMeans(measured),
    byCause: tally(measured.flatMap((reading) => Object.entries(reading.causes).flatMap(([cause, count]) => Array(count).fill(cause)))),
    remainder: {
      total: input.remainder.length,
      bySession: tally(input.remainder.map((entry) => entry.wake.session)),
      byReason: tally(input.remainder.map((entry) => entry.reason)),
    },
    ledgerOnly: input.bySession.ledgerOnly,
    unreadableTranscripts: input.transcripts.filter((transcript) => !transcript.ok).map((transcript) => ({ file: transcript.file, session: transcript.session, reason: transcript.ok ? "" : transcript.reason })),
    compactions: input.transcripts.reduce((sum, transcript) => sum + (transcript.ok ? transcript.compactions : 0), 0),
    codexRollouts: input.codexRollouts,
  };
}

/** @param {string[]} items */
function tally(items) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const item of items) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}

/**
 * Mean wakes per row for each UTC day by merge time: the day-to-day spread a before/after difference is read against.
 * @param {RowReading[]} measured
 * @returns {{ day: string, rows: number, mean: number }[]}
 */
export function dailyMeans(measured) {
  /** @type {Map<string, number[]>} */
  const days = new Map();
  for (const reading of measured) {
    const day = new Date(Math.floor(reading.mergedAt / MS_PER_DAY) * MS_PER_DAY).toISOString().slice(0, "YYYY-MM-DD".length);
    days.set(day, [...(days.get(day) ?? []), reading.wakes]);
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, values]) => ({ day, rows: values.length, mean: /** @type {number} */ (mean(values)) }));
}

/**
 * The difference in wakes per row, called a change only when it is bigger than the day-to-day spread of the before window.
 * @param {{ wakesPerRow: { mean: number | null }, bytesPerWake: number | null, daily: { mean: number }[] }} before
 * @param {{ wakesPerRow: { mean: number | null }, bytesPerWake: number | null }} after
 */
export function compareReadings(before, after) {
  const spreadValues = before.daily.map((day) => day.mean);
  const spread = spreadValues.length < 2 ? null : Math.max(...spreadValues) - Math.min(...spreadValues);
  if (before.wakesPerRow.mean === null || after.wakesPerRow.mean === null) return { verdict: "unmeasured", wakesDelta: null, bytesDelta: null, spread };
  const wakesDelta = after.wakesPerRow.mean - before.wakesPerRow.mean;
  const bytesDelta = before.bytesPerWake === null || after.bytesPerWake === null ? null : after.bytesPerWake - before.bytesPerWake;
  if (spread === null) return { verdict: "no spread to read it against (fewer than two days)", wakesDelta, bytesDelta, spread };
  return { verdict: Math.abs(wakesDelta) <= spread ? "no measurable change" : wakesDelta < 0 ? "improved" : "worse", wakesDelta, bytesDelta, spread };
}

/** @param {number | null} value */
const fixed = (value) => (value === null ? "n/a" : value.toFixed(DECIMALS));

/** @param {ReturnType<typeof measure>} reading */
export function renderReading(reading) {
  const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
  const lines = [
    "DEFINITIONS", ...DEFINITIONS.map((line) => `- ${line}`), "",
    `window by merge time: ${iso(reading.window.from)} .. ${iso(reading.window.to)}`,
    `merged rows: ${reading.mergedRows} (measured ${reading.measuredRows}, UNMEASURED ${reading.unmeasured.length})`,
    `wakes attributed: ${reading.attributedWakes}; wakes per merged row: mean ${fixed(reading.wakesPerRow.mean)}, median ${fixed(reading.wakesPerRow.median)}`,
    `wakes after the row's last pull request opened: ${reading.afterOpened}; after it merged: ${reading.afterMerged}; stale at typing: ${reading.stale}`,
    `bytes per wake: ${fixed(reading.bytesPerWake)}; compactions seen: ${reading.compactions}`,
    `daily mean wakes per row: ${reading.daily.map((day) => `${day.day}=${fixed(day.mean)} (n=${day.rows})`).join(", ") || "none"}`,
    `causes: ${JSON.stringify(reading.byCause)}`,
    `REMAINDER (no merged row): ${reading.remainder.total} wakes; by session ${JSON.stringify(reading.remainder.bySession)}; by reason ${JSON.stringify(reading.remainder.byReason)}`,
    `ledger lines with no transcript wake: ${reading.ledgerOnly}; Codex reviewer rollouts (own line, not folded in): ${reading.codexRollouts ?? "not read"}`,
  ];
  for (const entry of reading.unmeasured) lines.push(`UNMEASURED row #${entry.row}: ${entry.reason}`);
  for (const entry of reading.unreadableTranscripts) lines.push(`UNREADABLE transcript ${entry.file} (${entry.session ?? "session unknown"}): ${entry.reason}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// The host: where the sources are

/**
 * @param {string[]} args
 * @returns {string}
 */
function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: GH_MAX_BUFFER, timeout: GH_TIMEOUT_MS });
}

/**
 * Merged pull requests of one repository in the window, through the search API (REST, its own pool).
 * @param {string} repo
 * @param {{ from: number, to: number }} window
 * @returns {PullRequest[]}
 */
export function readMergedPulls(repo, window) {
  const range = `${new Date(window.from).toISOString()}..${new Date(window.to).toISOString()}`;
  const query = encodeURIComponent(`repo:${repo} is:pr is:merged merged:${range}`);
  const out = gh(["api", "--paginate", `search/issues?q=${query}&per_page=${SEARCH_PAGE}`, "--jq", ".items[] | {number, createdAt: .created_at, mergedAt: .pull_request.merged_at, body: (.body // \"\")}"]);
  return out.split("\n").filter(Boolean).map((line) => ({ repo, ...JSON.parse(line) }));
}

/**
 * When a row was claimed: the claim record the claim writes. `null` when it cannot be read, which the attribution takes as "from the instance's start".
 * @param {number} row
 * @param {string} rowRepo
 * @returns {number | null}
 */
export function readClaimedAt(row, rowRepo) {
  try {
    const out = gh(["api", "--paginate", `repos/${rowRepo}/issues/${row}/comments?per_page=${SEARCH_PAGE}`, "--jq", `.[] | select(.body | startswith("${CLAIM_MARKER}")) | .created_at`]);
    const first = out.split("\n").find(Boolean);
    return first ? Date.parse(first) : null;
  } catch {
    return null;
  }
}

/**
 * Every Claude transcript touched since the window opened, subagent transcripts excluded (a subagent is not woken by the org).
 * @param {string} root
 * @param {number} since
 * @returns {Transcript[]}
 */
export function readTranscripts(root, since) {
  /** @type {Transcript[]} */
  const found = [];
  for (const dir of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    for (const name of readdirSync(join(root, dir.name)).filter((file) => file.endsWith(".jsonl"))) {
      const file = join(root, dir.name, name);
      if (statSync(file).mtimeMs < since) continue;
      found.push(readOneTranscript(file));
    }
  }
  return found;
}

/** @param {string} file @returns {Transcript} */
function readOneTranscript(file) {
  try {
    return parseTranscript(readFileSync(file, "utf8"), file);
  } catch (cause) {
    return { ok: false, file, session: null, reason: `could not be read (${/** @type {Error} */ (cause).message})` };
  }
}

/**
 * Instances from the two org records: `spare-cycles` (one line per ending) and `spare-instances.json` (the live ones).
 * @param {string} cache
 * @returns {Instance[]}
 */
export function readInstances(cache) {
  /** @type {Instance[]} */
  const instances = [];
  for (const line of readFileSync(join(cache, "spare-cycles"), "utf8").split("\n").filter(Boolean)) {
    const ended = JSON.parse(line);
    const rows = ended.rows ?? (ended.row ? [ended.row] : []);
    instances.push({ session: ended.role, rows, spawnedAt: null, endedAt: ended.at });
  }
  const live = JSON.parse(readFileSync(join(cache, "spare-instances.json"), "utf8"));
  for (const [session, instance] of Object.entries(/** @type {Record<string, { spawnedAt: number, rows: number[] }>} */ (live))) {
    instances.push({ session, rows: instance.rows, spawnedAt: instance.spawnedAt, endedAt: null });
  }
  return instances;
}

/**
 * Codex reviewer rollouts delivered in the window, counted by the date in their path: they carry no org session name, so they are a line of their own.
 * @param {string} root
 * @param {{ from: number, to: number }} window
 */
export function countCodexRollouts(root, window) {
  let count = 0;
  for (let day = Math.floor(window.from / MS_PER_DAY) * MS_PER_DAY; day < window.to; day += MS_PER_DAY) {
    const [year, month, date] = new Date(day).toISOString().slice(0, "YYYY-MM-DD".length).split("-");
    try {
      count += readdirSync(join(root, year, month, date)).filter((name) => name.startsWith("rollout-")).length;
    } catch (cause) {
      if (/** @type {NodeJS.ErrnoException} */ (cause).code !== "ENOENT") throw cause;
    }
  }
  return count;
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) flags[argv[index].replace(/^--/, "")] = argv[index + 1];
  if (!flags.from || !flags.to) throw new Error("usage: wakes-per-row --from <ISO> --to <ISO> [--repos a/b,c/d] [--json 1]");
  const from = Date.parse(flags.from);
  const to = Date.parse(flags.to);
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) throw new Error(`--from and --to must be ISO times with from < to (got ${flags.from} .. ${flags.to})`);
  return { window: { from, to }, repos: flags.repos ? flags.repos.split(",") : null, json: flags.json === "1" };
}

/** The repositories to read and the one rows live in come from the project's declaration: this tool names no project. */
async function main() {
  const { window, repos: flagged, json } = parseArgs(process.argv.slice(2));
  const { homeProjectDeclaration } = await import("./project-config.mjs");
  const declaration = homeProjectDeclaration();
  const rowRepo = declaration.tracker[0].repo;
  const repos = flagged ?? declaration.code.map((code) => code.repo);
  const cache = join(homedir(), ".cache", "a11ign");
  const pulls = repos.flatMap((repo) => readMergedPulls(repo, window));
  const rows = mergedRows(pulls, window, rowRepo).map((row) => row.row);
  const claimedAt = new Map(rows.map((row) => [row, readClaimedAt(row, rowRepo)]));
  const reading = measure({
    window, pulls, claimedAt, rowRepo,
    transcripts: readTranscripts(join(homedir(), ".claude", "projects"), window.from),
    ledger: parseLedger(readFileSync(join(cache, "wake-ledger"), "utf8")),
    instances: readInstances(cache),
    codexRollouts: countCodexRollouts(join(homedir(), ".codex", "sessions"), window),
  });
  console.log(json ? JSON.stringify(reading, null, 2) : renderReading(reading));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
