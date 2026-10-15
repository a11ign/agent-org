// no-token: none -- `org-retro.ts`'s pure readers and the report over fixtures; the log is a temp file, and nothing here reaches `gh` or a tracker
/**
 * THE CLAUDE PAUSE IS NOT AN ORG FAILURE (the row's five numbers, 2026-10-15): the allowance held Claude work for 23 hours of the day, and the
 * retrospective read the idle minutes and the claimed hours as the org's own. The positive control is a journal in which every tick offers a
 * claimable row, so the only thing that can lower the idle figure is the pause, and the cases below assert exactly what it may lower.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WINDOW_MS, buildReport, compareReadings, idleStats, pauseOf, pausedIntervals, readAccountLimitLog, renderReport } from "./org-retro.ts";

const MINUTE = 60 * 1000;
const NOW = Date.parse("2026-10-15T08:10:00Z");
const SINCE = NOW - WINDOW_MS;
const TICKS = 20;
const TICK_GAP = 72 * MINUTE; // 20 ticks across the 24 hours
/** `journalctl -o short-iso` stamps have no milliseconds, which the journal reader's pattern needs. */
const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const iso = (ms: number) => new Date(ms).toISOString();

// the two lines of the real `account-limit.ndjson` on the org's host, verbatim except for the account
const REAL_LOG = [
  `{"kind":"enter","account":"/home/agent","at":"2026-10-13T20:54:14.786Z","limitedUntil":1792047600000,"seenOn":"ceo","text":"You've hit your weekly limit · resets Oct 15, 8am (Europe/London)","line":"Claude allowance spent on \\"ceo\\" until 2026-10-15T07:00:00.000Z: Claude work is paused account-wide; Codex reviews and merges go on, and Claude work resumes by itself at that reset."}`,
  `{"kind":"leave","account":"/home/agent","at":"2026-10-15T07:01:12.074Z","limitedUntil":1792047600000,"seenOn":"ceo","text":"You've hit your weekly limit · resets Oct 15, 8am (Europe/London)","line":"Claude allowance spent on \\"ceo\\" until 2026-10-15T07:00:00.000Z: Claude work is paused account-wide; Codex reviews and merges go on, and Claude work resumes by itself at that reset."}`,
].join("\n") + "\n";

const made: string[] = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
function madeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "org-retro-account-pause-"));
  made.push(dir);
  return dir;
}

const enter = (at: number) => JSON.stringify({ kind: "enter", account: "/home/agent", at: iso(at), limitedUntil: at + 1, seenOn: "ceo", text: "limit", line: "entered" });
const leave = (at: number) => JSON.stringify({ kind: "leave", account: "/home/agent", at: iso(at), limitedUntil: at + 1, seenOn: "ceo", text: "limit", line: "left" });

/** The 20-tick journal: every tick starts, and offers a Ready row that nobody takes (UNDELIVERED), one minute into the tick. */
function journal(ticks: number = TICKS): string {
  const out: string[] = [];
  for (let i = 0; i < ticks; i += 1) {
    const at = SINCE + i * TICK_GAP;
    out.push(`${stamp(at)} host a11ign-work-tick[1]: Starting a11ign-work-tick.service`);
    out.push(`${stamp(at + MINUTE)} host a11ign-work-tick[1]: UNDELIVERED engineers/ready-row-unclaimed/${2000 + i}`);
  }
  return out.join("\n") + "\n";
}

/** The report's inputs for the journal and a pause log; every other read is nobody's, which the report says `unknown`. */
function reportWith(accountLimitLog: string | null | undefined, text: string = journal()) {
  return buildReport({ merged: null, openPrs: null, journal: text, ledger: null, turns: null, handFixes: null, accountLimitLog }, NOW);
}

// THE PAUSE LOG'S READER

test("a log with an enter and a leave clips to the window and keeps the leave's end", () => {
  const intervals = pausedIntervals(REAL_LOG, { since: SINCE, until: NOW });
  assert.deepEqual(intervals, [{ from: SINCE, to: Date.parse("2026-10-15T07:01:12.074Z") }]);
});

test("an enter with no leave after it runs to the end of the window", () => {
  const intervals = pausedIntervals(`${enter(SINCE + 2 * 60 * MINUTE)}\n`, { since: SINCE, until: NOW });
  assert.deepEqual(intervals, [{ from: SINCE + 2 * 60 * MINUTE, to: NOW }]);
});

test("a pause that ended before the window, or is not in the log, covers nothing", () => {
  assert.deepEqual(pausedIntervals(`${enter(SINCE - 5 * 60 * MINUTE)}\n${leave(SINCE - 4 * 60 * MINUTE)}\n`, { since: SINCE, until: NOW }), []);
  assert.deepEqual(pausedIntervals("", { since: SINCE, until: NOW }), []);
});

test("a line that does not parse is UNKNOWN (null), never not paused", () => {
  assert.equal(pausedIntervals(`${enter(SINCE + MINUTE)}\nnot json\n`, { since: SINCE, until: NOW }), null);
});

test("the real file reader: a readable log is its text, no file is no pause, and a directory at its path is unknown", () => {
  const dir = madeDir();
  writeFileSync(join(dir, "account-limit.ndjson"), REAL_LOG);
  assert.equal(readAccountLimitLog(dir), REAL_LOG);

  const empty = madeDir();
  assert.equal(readAccountLimitLog(empty), "");

  const unreadable = madeDir();
  mkdirSync(join(unreadable, "account-limit.ndjson"));
  assert.equal(readAccountLimitLog(unreadable), null);
});

test("the real log, read from a file, is paused for most of the day that ends at its leave", () => {
  const dir = madeDir();
  writeFileSync(join(dir, "account-limit.ndjson"), REAL_LOG);
  const pause = pauseOf(readAccountLimitLog(dir), NOW);
  assert.ok(pause !== null);
  assert.ok(pause.current > 0.9, `current share ${pause.current}`);
});

// POSITIVE CONTROL: the journal, the pause that covers 15 of its 20 ticks, and the verdict it must give

test("positive control: the pause holds 15 of the 20 ticks, so only the 5 outside it are idle, and the 15 are excluded", () => {
  const pauseText = `${enter(SINCE - 60 * MINUTE)}\n${leave(SINCE + 17 * 60 * MINUTE)}\n`;
  const report = reportWith(pauseText);
  assert.equal(report.idle?.ticks, 5);
  assert.equal(report.idle?.idleMinutes, 10);
  assert.equal(report.idle?.pausedIdleMinutes, 30);
  assert.ok((report.pause?.current ?? 0) > 0.5, `current share ${report.pause?.current}`);
});

test("positive control: the verdict for idle minutes reads paused, not worse, and the pause line says so first", () => {
  const pauseText = `${enter(SINCE - 60 * MINUTE)}\n${leave(SINCE + 17 * 60 * MINUTE)}\n`;
  const report = reportWith(pauseText);
  const previous = { status: "read", date: "2026-10-14", numbers: { idleMinutes: 4 } } as never;
  const idle = compareReadings({ idleMinutes: report.idle?.idleMinutes ?? null }, previous, [], report.pause).find((r) => r.id === "idleMinutes");
  assert.equal(idle?.verdict, "paused");
  const text = renderReport(report);
  // the enter is an hour before the window, so the pause is shown from the window's start
  assert.match(text, /^ORG RETROSPECTIVE .*\n\nClaude work paused 17h00m of 24h \(2026-10-14T08:10Z to 2026-10-15T01:10Z\)/);
  assert.match(text, /Idle minutes while a claimable row existed: 10 .*30 min in the pause, excluded/);
});

// CASE 2: the same journal and no pause: every tick is the org's own

test("case 2: no pause file, the same journal: all 20 ticks are idle, and the verdict is worse", () => {
  const report = reportWith("");
  assert.equal(report.idle?.ticks, TICKS);
  assert.equal(report.idle?.idleMinutes, 40);
  assert.equal(report.idle?.pausedIdleMinutes, 0);
  const previous = { status: "read", date: "2026-10-14", numbers: { idleMinutes: 4 } } as never;
  const idle = compareReadings({ idleMinutes: 40 }, previous, [], report.pause).find((r) => r.id === "idleMinutes");
  assert.equal(idle?.verdict, "worse");
  assert.match(renderReport(report), /Claude work pause: not paused/);
});

// CASE 3: a pause log that cannot be read is unknown, and the figures are not corrected for it

test("case 3: an unreadable pause log prints unknown and the idle minutes whole, with the verdict unchanged", () => {
  const report = reportWith(null);
  assert.equal(report.pause, null);
  assert.equal(report.idle?.idleMinutes, 40);
  assert.equal(report.idle?.pausedIdleMinutes, 0);
  const previous = { status: "read", date: "2026-10-14", numbers: { idleMinutes: 4 } } as never;
  const idle = compareReadings({ idleMinutes: 40 }, previous, [], report.pause).find((r) => r.id === "idleMinutes");
  assert.equal(idle?.verdict, "worse");
  assert.match(renderReport(report), /Claude work pause: unknown \(account-limit\.ndjson could not be read/);
});

// the reader on its own: a pause outside the window does not move the idle count

test("idleStats with no pause intervals is the count it was before the pause existed", () => {
  const lines = [0, 1, 2].flatMap((i) => [
    { at: SINCE + i * TICK_GAP, message: "Starting a11ign-work-tick.service" },
    { at: SINCE + i * TICK_GAP + MINUTE, message: "UNDELIVERED engineers/ready-row-unclaimed/1" },
  ]);
  assert.deepEqual(idleStats(lines), { ticksWithIdleOffer: 3, idleMinutes: 6, ticks: 3, pausedIdleMinutes: 0 });
});
