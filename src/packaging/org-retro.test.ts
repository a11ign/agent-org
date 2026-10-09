// no-token: gh -- `org-retro.ts` calls `gh`, `journalctl` and reads transcripts only inside `readAll`, which every test here replaces with a fixture seam; nothing imported reaches the real one
/**
 * `packages/agent-org/src/org-retro.ts` and its wiring in `work-gate.ts`, #2938: THE DAILY RETROSPECTIVE. Once per UTC date the gate hands `ceo`
 * the last 24 hours' numbers, already computed, and `ceo` is ordered to find the CLASS behind each number that worsened.
 *
 * EVERY NUMBER BELOW IS CHECKED BY HAND AGAINST A FIXTURE WINDOW, written out as a literal. A test built from the module's own constants moves
 * with them: `TICK_MINUTES` is 2 here as a literal so that dropping the idle-minute term, or changing the tick, goes red.
 *
 * THE POSITIVE CONTROL IS THE 2026-10-01 WINDOW: zero merges, and #2824 offered and refused for 211 ticks (`UNDELIVERED engineers/ready-row-unclaimed/2824`,
 * counted from `a11ign-work-tick.service`'s journal in #2845). It must report a stall AND a non-zero idle-minute figure; every "not offered / not counted"
 * below is only worth anything because that window IS read as a stall through the same entry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildReport, renderReport, retrospectiveDue, retrospectiveOrder, retrospectiveKey, retrospectiveTick, ledgerEntries, ledgerStats,
  idleStats, journalLines, releaseStats, redPrStats, mergedStats, tokenStats, CLASS_FIX_INSTRUCTION, RETRO_CAUSE, RETRO_DESTINATION, UNKNOWN,
  utcDate, NUMBERS, READINGS_FILE, compareReadings, previousReading, parseReadings, readReadings, recordReading, undeclaredDirections,
  verdictFor } from "../org-retro.ts";
import { isBrokenRed, isHeldRed, HOLD_OWN_JOBS } from "../red-pr.ts";
import { readLedger as readHandFixLedger, ledgerLine as handFixLine } from "../hand-fix-ledger.ts";
import { CAUSES, JUDGMENT_CAUSES, START_CAUSES, HOLD_RED_JOBS } from "../work-gate.ts";
import { PROFILES } from "../worker-profile.ts";
import { HOME_CHECKOUT, HOST_ENV } from "../project-config.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";

const HOUR_MS = 3_600_000;
const NOW = Date.parse("2026-10-02T00:00:00Z");
const SINCE = NOW - 24 * HOUR_MS; // 2026-10-01T00:00:00Z
const WINDOW = { since: SINCE, until: NOW };
const at = (iso: string) => Date.parse(iso);

/** One merged change a human account authored, inside the ledger's 14-day window ending at NOW: the ledger's own reading of it is a count of 1. */
const HUMAN_CHANGE = { key: "pr:2883", number: 2883, title: "a hand fix", at: "2026-09-30T12:00:00Z", author: "DanBeckDev", actors: ["DanBeckDev"], body: "" };
const HAND_FIXES_ONE = readHandFixLedger({ read: () => [HUMAN_CHANGE], now: new Date(NOW) });
const HAND_FIXES_REFUSED = readHandFixLedger({ read: () => { throw new Error("gh: HTTP 403"); }, now: new Date(NOW) });

// --- the journal fixture: `journalctl -o short-iso`, one tick = systemd's start line + the node lines --------------------------------------------

const row = (when: string, unit: string, message: string) => `${when} agents ${unit}[1]: ${message}`;
const tick = (when: string, lines: string[]) =>
  [row(when, "systemd", "Starting a11ign-work-tick.service - a11ign: ask work-gate whether there is work..."), ...lines.map((l) => row(when, "node", l))].join("\n");
const IDLE_OFFER = (rowNo: number) => `UNDELIVERED engineers/ready-row-unclaimed/${rowNo}: no engineer is idle and allowed to claim (worker-2879=has held #2879)`;

/** Hand-checked: five ticks in the window, one before it. Ticks 2, 3 and 5 carry an idle offer (tick 3 carries TWO, which still count once). */
const JOURNAL = [
  tick("2026-09-30T23:58:00+00:00", [IDLE_OFFER(2824)]), // BEFORE the window: never counted
  tick("2026-10-01T10:00:00+00:00", ["WOKE worker-1 <- engineers/ready-row-unclaimed/1 (STARTED sonnet/high)"]),
  tick("2026-10-01T10:02:00+00:00", [IDLE_OFFER(2824), "RELEASED #1 (worker-1, merged): worktree KEPT at /home/agent/repos/wt-1"]),
  tick("2026-10-01T10:04:00+00:00", [IDLE_OFFER(2824), IDLE_OFFER(2940), "RELEASED #2 (worker-2, gone): worktree KEPT at /x", "UNDELIVERED engineers/pr-checks-failing/9: nowhere"]),
  tick("2026-10-01T10:06:00+00:00", ["SHELVED row #2937: blocked by #2936 -- declared on the row"]),
  tick("2026-10-01T10:08:00+00:00", [IDLE_OFFER(2824), "RELEASED #3 (worker-3, blocked): nothing kept", "RELEASED #4 (worker-4, gone): worktree KEPT at /y"]),
].join("\n");

test("idle minutes: a tick that offered a Ready row nobody could take counts TWO minutes, once however many offers it held", () => {
  const idle = idleStats(journalLines(JOURNAL, WINDOW));
  assert.equal(idle.ticks, 5, "the tick before the window is not in it");
  assert.equal(idle.ticksWithIdleOffer, 3, "ticks 2, 3 and 5; the two offers in one tick are one tick; an UNDELIVERED for another cause is not an idle offer");
  assert.equal(idle.idleMinutes, 6, "3 ticks x 2 minutes -- a literal, so dropping the term or changing the tick goes red");
});

test("claim-stall voidings: every release whose reason is not `merged`, by reason", () => {
  const releases = releaseStats(journalLines(JOURNAL, WINDOW));
  assert.deepEqual(releases, { voided: 3, byReason: { gone: 2, blocked: 1 } }, "#1 merged is a row finishing, not a voiding");
});

// --- the ledger fixture: the SHAPE the live wake ledger has, `<epochMs>\t<causeKey>[\t<recipient>]`, markers carrying their key second ------------

const ledgerLine = (iso: string, ...fields: string[]) => `${[at(iso), ...fields].join("\t")}\n`;
const LEDGER = [
  ledgerLine("2026-09-30T20:00:00Z", "ceo/org-stalled/40"), // outside the window
  ledgerLine("2026-10-01T09:00:00Z", "ceo/org-stalled/12"),
  ledgerLine("2026-10-01T15:00:00Z", "ceo/org-stalled/9", "ceo"),
  ledgerLine("2026-10-01T15:30:00Z", "RESET", "ceo/org-stalled/9"), // a marker is not a delivery
  ledgerLine("2026-10-01T11:00:00Z", "worker-5/claim-stalled/5", "worker-5"),
  ledgerLine("2026-10-01T12:00:00Z", "ceo/org-health/merge-gap:2026-10-01T10"),
  ledgerLine("2026-10-01T14:00:00Z", "ceo/org-health/merge-gap:2026-10-01T10"),
  ledgerLine("2026-10-01T16:00:00Z", "ceo/org-health/red-age:2026-10-01T15"),
  ledgerLine("2026-10-01T17:00:00Z", "engineers/ready-row-unclaimed/2938", "worker-2938"),
].join("");

test("stalls and org-health offers are read from the ledger's DELIVERIES inside the window, markers and other causes excluded", () => {
  const stats = ledgerStats(ledgerEntries(LEDGER, WINDOW));
  assert.equal(stats.orgStalled, 2, "12 and 9; the 09-30 line is outside, the RESET marker is not a delivery");
  assert.equal(stats.claimStalled, 1);
  assert.deepEqual(stats.healthBySignal, { "merge-gap": 2, "red-age": 1 });
});

// --- merged PRs, red PRs, tokens ----------------------------------------------------------------------------------------------------------------

const MERGED = [
  { number: 1, createdAt: "2026-10-01T10:00:00Z", mergedAt: "2026-10-01T10:30:00Z" }, // 30 min
  { number: 2, createdAt: "2026-10-01T11:00:00Z", mergedAt: "2026-10-01T12:00:00Z" }, // 60 min
  { number: 3, createdAt: "2026-10-01T12:00:00Z", mergedAt: "2026-10-01T12:10:00Z" }, // 10 min
  { number: 4, createdAt: "2026-09-30T22:00:00Z", mergedAt: "2026-09-30T23:00:00Z" }, // outside the window
];

test("PRs merged and the median open-to-merge: 3 in the window, median of 10, 30 and 60 minutes is 30", () => {
  assert.deepEqual(mergedStats(MERGED, WINDOW), { count: 3, medianMinutes: 30 });
  assert.deepEqual(mergedStats(MERGED.slice(0, 2), WINDOW), { count: 2, medianMinutes: 45 }, "an even count averages the middle two");
  assert.deepEqual(mergedStats([], WINDOW), { count: 0, medianMinutes: null }, "no merge has no median, which is not 0 minutes");
});

const check = (name: string, conclusion: string, completedAt: string) => ({ name, conclusion, completedAt });
const OPEN_PRS = [
  { number: 10, statusCheckRollup: [check("ci", "FAILURE", "2026-10-01T22:00:00Z"), check("lint", "FAILURE", "2026-10-01T23:00:00Z")] }, // red since 22:00: 120 min
  { number: 11, statusCheckRollup: [check("ci", "FAILURE", "2026-10-01T21:00:00Z"), check("ci", "SUCCESS", "2026-10-01T21:30:00Z")] }, // re-run passed: not red
  { number: 12, statusCheckRollup: [check("ci", "FAILURE", "2026-10-01T23:30:00Z")] }, // 30 min
  { number: 13, statusCheckRollup: [{ name: "ci", conclusion: "", completedAt: "" }] }, // still running
];

test("red-PR age: from the earliest failing check of its NEWEST run per name; median, max and which PR", () => {
  const red = redPrStats(OPEN_PRS, NOW);
  assert.deepEqual(red, { count: 2, medianMinutes: 75, oldest: { number: 10, minutes: 120 }, held: [] }, "(120 + 30) / 2 = 75; #11's re-run passed and #13 is running");
  assert.deepEqual(redPrStats([], NOW), { count: 0, medianMinutes: null, oldest: null, held: [] });
});

// --- #2954: a PR red ON PURPOSE is not a broken one, and the hand-fix line is a reading, not a file ------------------------------------------------

const labelled = (labels: string[], checks: ReturnType<typeof check>[]) => ({ number: 2883, labels: labels.map((name) => ({ name })), statusCheckRollup: checks });
const HOLD = "hold:product-manager";
const holdsOwnRed = [check("deliberateRefusals", "FAILURE", "2026-10-01T18:27:00Z"), check("gate", "FAILURE", "2026-10-01T18:30:00Z"), check("ts / run", "SUCCESS", "2026-10-01T18:20:00Z")];

test("isBrokenRed: a hold's own two red jobs are HELD, not red; a real red beside a hold IS red; a red deliberateRefusals with no hold IS red", () => {
  const held = labelled([HOLD], holdsOwnRed);
  assert.equal(isBrokenRed(held), false, "#2883's shape: held, and red only in the hold's own jobs");
  assert.equal(isHeldRed(held), true, "and it is reported as held, not dropped");
  const heldWithRealRed = labelled([HOLD], [...holdsOwnRed, check("ts / run", "FAILURE", "2026-10-01T19:00:00Z")]);
  assert.equal(isBrokenRed(heldWithRealRed), true, "the hold does not hide a real failure (the newest `ts / run` is the red one)");
  assert.equal(isHeldRed(heldWithRealRed), false, "a PR is on one line or the other, never both");
  const raceNotHold = labelled(["session:worker-1"], [check("deliberateRefusals", "FAILURE", "2026-10-01T19:00:00Z"), check("gate", "FAILURE", "2026-10-01T19:01:00Z")]);
  assert.equal(isBrokenRed(raceNotHold), true, "a head-vs-tip race (#294) fails the same job with no hold, and that is broken");
  assert.equal(isHeldRed(raceNotHold), false);
  assert.equal(isBrokenRed(labelled([HOLD], [check("ts / run", "SUCCESS", "2026-10-01T19:00:00Z")])), false, "a held PR that is green is neither");
  assert.equal(isHeldRed(labelled([HOLD], [check("ts / run", "SUCCESS", "2026-10-01T19:00:00Z")])), false, "...so the held line is for held RED PRs");
});

test("the hold's two jobs are the jobs ci.yml defines, and the same two the gate's own exemption uses", () => {
  const ci = readFileSync(join(HOME_CHECKOUT, ".github/workflows/ci.yml"), "utf8");
  assert.deepEqual([...HOLD_OWN_JOBS], [...HOLD_RED_JOBS], "red-pr.ts is a leaf and cannot import pr-orders.mjs, so the copy is pinned here");
  for (const job of HOLD_OWN_JOBS) assert.match(ci, new RegExp(`\\n {2}${job}:\\n`), `${job} is a job in ci.yml`);
  const from = ci.indexOf("\n  deliberateRefusals:\n");
  const next = ci.slice(from + 1).search(/\n {2}[\w-]+:\n/);
  assert.match(ci.slice(from, from + 1 + next), /merge-guard\.mjs --ci-gate/, "the job that runs the hold refusal is deliberateRefusals");
});

test("redPrStats counts the broken and LISTS the held, with who holds it; the report prints both lines", () => {
  const prs = [{ ...labelled([HOLD], holdsOwnRed), number: 2883 }, { ...OPEN_PRS[2], labels: [] }];
  const red = redPrStats(prs, NOW)!;
  assert.equal(red.count, 1, "#12 is red and unheld; #2883 is held");
  assert.deepEqual(red.held, [{ number: 2883, holders: [HOLD], minutes: 333 }], "red since 18:27 = 5h33m = 333 min, from the hold's own earliest failure");
  const text = renderReport(buildReport({ merged: MERGED, openPrs: prs, journal: JOURNAL, ledger: LEDGER, turns: TURNS, handFixes: HAND_FIXES_ONE }, NOW));
  assert.match(text, /Red PRs now: 1; age median 30m, max 30m \(#12\)/);
  assert.match(text, /Red PRs held on purpose \(not counted above\): 1: #2883 \(hold:product-manager, red 5h33m\)/);
  const heldOnly = renderReport(buildReport({ merged: MERGED, openPrs: [prs[0]], journal: JOURNAL, ledger: LEDGER, turns: TURNS, handFixes: HAND_FIXES_ONE }, NOW));
  assert.match(heldOnly, /Red PRs now: 0\n/, "a held PR alone is a real zero of broken PRs");
  assert.match(heldOnly, /held on purpose[^\n]*#2883/);
});

test("the hand-fix line is the ledger's own: one human-authored change prints 1, a refused read prints UNKNOWN and never 0", () => {
  const counted = renderReport(buildReport({ merged: MERGED, openPrs: [], journal: JOURNAL, ledger: LEDGER, turns: TURNS, handFixes: HAND_FIXES_ONE }, NOW));
  assert.match(counted, /^- HAND FIXES \(last 14d, target 0\): 1 \(1 derived, 0 declared, 0 both\) of 1 changes, 1 of them PRs a human account authored/m);
  assert.doesNotMatch(counted, /ledger absent/, "the line the report printed on every day until #2954");
  const refused = renderReport(buildReport({ merged: MERGED, openPrs: [], journal: JOURNAL, ledger: LEDGER, turns: TURNS, handFixes: HAND_FIXES_REFUSED }, NOW));
  assert.match(refused, /^- HAND FIXES \(last 14d, target 0\): UNKNOWN -- the read was refused \(gh: HTTP 403\)\. This is not zero\./m);
  assert.ok(refused.includes(`- ${handFixLine(HAND_FIXES_REFUSED)}`));
  assert.doesNotMatch(refused, /HAND FIXES[^\n]*: 0\b/);
});

// --- THE CLASS: every file the report reads from the state directory is a file somebody writes ---------------------------------------------------

const AGENT_ORG_SRC = new URL("../", import.meta.url);
/** The scan's own subject: it reads files and is not the writer it looks for. Excluded in CODE, here, and not by an entry in a list it also matches. */
const SELF = "org-retro.ts";
const WRITE_CALL = /\b(writeFileSync|appendFileSync|renameSync)\(/;

/** Comments removed, so a name that survives only in a header ("until the sibling row lands") is not a reader and not a writer. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

/** Every `${stateDir}/<name>` (or `${dir}/<name>`) a source reads. */
function stateFilesRead(source: string): string[] {
  return [...new Set([...code(source).matchAll(/\$\{\w+\}\/([a-z][\w.-]*)/g)].map((m) => m[1]))];
}

function sourceFiles(dir: URL): { name: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".mjs") && e.name !== SELF)
    .map((e) => ({ name: e.name, text: readFileSync(join(e.parentPath, e.name), "utf8") }));
}

/** The names with no writer: no other source file names the file in code AND calls a write function. */
function readButNeverWritten(names: string[], writers: { text: string }[]): string[] {
  return names.filter((name) => !writers.some((w) => code(w.text).includes(name) && WRITE_CALL.test(code(w.text))));
}

test("every file org-retro.ts reads from the state directory is written by some module in agent-org (#2954)", () => {
  const source = readFileSync(new URL(SELF, AGENT_ORG_SRC), "utf8");
  const writers = sourceFiles(AGENT_ORG_SRC);
  const read = stateFilesRead(source);
  assert.ok(read.includes("wake-ledger"), "POSITIVE CONTROL: the scan finds the wake ledger, so the population is not empty");
  assert.deepEqual(readButNeverWritten(["wake-ledger"], writers), [], "POSITIVE CONTROL: and the writer search finds wake.ts writing it");
  assert.deepEqual(readButNeverWritten(read, writers), [], `read from the state directory and never written: ${readButNeverWritten(read, writers).join(", ")}`);
});

test("the scan notices the fault it exists for, and stops complaining when it is remedied", () => {
  const source = readFileSync(new URL(SELF, AGENT_ORG_SRC), "utf8");
  const writers = sourceFiles(AGENT_ORG_SRC);
  const restored = `${source}\nconst x = readText(\`\${stateDir}/hand-fix-ledger\`);\n`;
  assert.deepEqual(readButNeverWritten(stateFilesRead(restored), writers), ["hand-fix-ledger"], "the read #2954 removed, restored, goes red");
  const written = [...writers, { name: "fixture.mjs", text: 'appendFileSync(`${dir}/hand-fix-ledger`, "x");' }];
  assert.deepEqual(readButNeverWritten(stateFilesRead(restored), written), [], "a writer for it, and the scan stops complaining");
  const commentOnly = [...writers, { name: "fixture.mjs", text: '// hand-fix-ledger\nwriteFileSync(other, "x");' }];
  assert.deepEqual(readButNeverWritten(stateFilesRead(restored), commentOnly), ["hand-fix-ledger"], "a name only in a comment is not a writer");
});

const TURNS = [
  { at: at("2026-10-01T10:00:00Z"), fresh: 100, cacheRead: 900, cacheWrite: 0, output: 50, thinking: 0 }, // 1,050
  { at: at("2026-10-01T11:00:00Z"), fresh: 10, cacheRead: 0, cacheWrite: 20, output: 5, thinking: 15 }, // 50
  { at: at("2026-09-30T11:00:00Z"), fresh: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 }, // outside
];

test("tokens: every token the model handled in the window, cache reads included, per merged PR", () => {
  assert.deepEqual(tokenStats(TURNS, WINDOW), { turns: 2, total: 1100 });
  const report = buildReport({ merged: MERGED, openPrs: OPEN_PRS, journal: JOURNAL, ledger: LEDGER, turns: TURNS, handFixes: HAND_FIXES_ONE }, NOW);
  assert.match(renderReport(report), /Tokens per merged PR: 367 \(1,100 tokens over 2 turns/, "1,100 / 3 merged = 366.67");
});

// --- the whole report from the fixture window ------------------------------------------------------------------------------------------------------

test("the report computes each number from the fixture window with its hand-checked answer", () => {
  const text = renderReport(buildReport({ merged: MERGED, openPrs: OPEN_PRS, journal: JOURNAL, ledger: LEDGER, turns: TURNS, handFixes: HAND_FIXES_ONE }, NOW));
  assert.match(text, /PRs merged: 3; median open-to-merge 30m/);
  assert.match(text, /Idle minutes while a claimable row existed: 6 \(3 of 5 ticks/);
  assert.match(text, /Stalls \(org-stalled wakes\): 2; claim-stalled wakes: 1/);
  assert.match(text, /voidings .*: 3 \(gone x2, blocked x1\)/);
  assert.match(text, /org-health offers by signal: merge-gap x2, red-age x1/);
  assert.match(text, /Red PRs now: 2; age median 1h15m, max 2h00m \(#10\)/);
  assert.ok(text.includes(`- ${handFixLine(HAND_FIXES_ONE)}`), "the hand-fix line is the ledger's own line, verbatim (the next test pins what it says)");
  assert.doesNotMatch(text, /STALL: no PR merged/, "three merged is not a stall");
});

test("an unreadable source prints `unknown`, never 0 -- and never a stall", () => {
  const text = renderReport(buildReport({ merged: null, openPrs: null, journal: null, ledger: null, turns: null, handFixes: null }, NOW));
  for (const label of ["PRs merged", "Idle minutes while a claimable row existed", "Stalls \\(org-stalled wakes\\)", "voidings", "org-health offers by signal",
    "Red PRs now", "Tokens per merged PR", "HAND FIXES"]) {
    assert.match(text, new RegExp(`${label}[^\\n]*: ${UNKNOWN}`, "i"), `${label} must read unknown`);
  }
  assert.doesNotMatch(text, /STALL/, "an unreadable merged list is not a window with no merges");
  assert.doesNotMatch(text, /: 0\b/, "no refused read may print as a zero");
});

test("zero merges with a PR list that READ fine, and zero tokens-per-PR, never divides by zero", () => {
  const text = renderReport(buildReport({ merged: [], openPrs: [], journal: JOURNAL, ledger: LEDGER, turns: TURNS, handFixes: HAND_FIXES_ONE }, NOW));
  assert.match(text, /Tokens per merged PR: n\/a, no PR merged/);
  assert.match(text, /Red PRs now: 0/, "a list that read and holds no red PR is a real zero");
});

// --- THE POSITIVE CONTROL: the 2026-10-01 window --------------------------------------------------------------------------------------------------

test("POSITIVE CONTROL: the 2026-10-01 window (zero merges, #2824 refused for 211 ticks) reports a stall and a non-zero idle-minute figure", () => {
  const TICKS = 211;
  const ticks = Array.from({ length: TICKS }, (_, i) =>
    tick(`2026-10-01T${String(Math.floor((i * 2) / 60)).padStart(2, "0")}:${String((i * 2) % 60).padStart(2, "0")}:00+00:00`,
      ["UNDELIVERED engineers/ready-row-unclaimed/2824: --worktree=../wt-2824 ALREADY EXISTS, stamped by `worker-2824`"]));
  const text = renderReport(buildReport({ merged: [], openPrs: [], journal: ticks.join("\n"), ledger: "", turns: [], handFixes: HAND_FIXES_ONE }, NOW));
  assert.match(text, /PRs merged: 0/);
  assert.match(text, /STALL: no PR merged in the window; a claimable row waited 422 idle minutes through it/, "211 ticks x 2 minutes");
  assert.match(text, /Idle minutes while a claimable row existed: 422 \(211 of 211 ticks/);
});

// --- the offer: once per UTC date ------------------------------------------------------------------------------------------------------------------

const OFFER_NOW = at("2026-10-02T01:00:00Z");
const LATER_SAME_DATE = at("2026-10-02T17:30:00Z");
const NEXT_DATE = at("2026-10-03T00:05:00Z");
const fixtureRead = () => ({ merged: [], openPrs: [], journal: "", ledger: "", turns: [], handFixes: HAND_FIXES_ONE, readings: parseReadings("") });

test("the order is keyed on the UTC DATE: one key for the whole day, a new one at the next midnight", () => {
  assert.equal(retrospectiveKey("2026-10-02"), "ceo/org-retrospective/2026-10-02");
  assert.equal(utcDate(OFFER_NOW), utcDate(LATER_SAME_DATE), "01:00 and 17:30 are one date");
  assert.notEqual(utcDate(LATER_SAME_DATE), utcDate(NEXT_DATE));
  const first = retrospectiveOrder(utcDate(OFFER_NOW), "report");
  const later = retrospectiveOrder(utcDate(LATER_SAME_DATE), "report");
  assert.equal(first.causeKey, later.causeKey, "a key on the HOUR would offer it 24 times a day");
  assert.equal(first.discriminator, "2026-10-02");
  assert.equal(first.session, "ceo");
  assert.equal(first.cause, RETRO_CAUSE);
});

test("due once per UTC date: owed until the ledger records its delivery, then not again that date, and owed again the next date", () => {
  const delivered = ledgerLine("2026-10-02T01:00:03Z", "ceo/org-retrospective/2026-10-02", "ceo");
  assert.equal(retrospectiveDue(OFFER_NOW, ""), "2026-10-02", "an empty ledger: owed");
  assert.equal(retrospectiveDue(OFFER_NOW, delivered), null, "delivered this date");
  assert.equal(retrospectiveDue(LATER_SAME_DATE, delivered), null, "16 hours later, SAME date: not twice in one date");
  assert.equal(retrospectiveDue(NEXT_DATE, delivered), "2026-10-03", "the next UTC date is a new day");
  assert.equal(retrospectiveDue(OFFER_NOW, ledgerLine("2026-10-02T01:00:03Z", "RESET", "ceo/org-retrospective/2026-10-02")), "2026-10-02",
    "a RESET marker is not a delivery");
  assert.equal(retrospectiveDue(OFFER_NOW, null), null, "a ledger that cannot be read is CANNOT TELL, not 'not yet': offering blind would repeat it every tick");
});

test("the gate's tick offers once per date through the ledger: the same date later is quiet, the next date offers again", () => {
  const offered = retrospectiveTickWith(OFFER_NOW, "");
  assert.equal(offered.length, 1);
  assert.equal(offered[0].causeKey, "ceo/org-retrospective/2026-10-02");
  const ledgerAfter = ledgerLine("2026-10-02T01:00:03Z", offered[0].causeKey, "ceo");
  assert.equal(retrospectiveTickWith(LATER_SAME_DATE, ledgerAfter).length, 0, "same UTC date, delivered: not twice");
  assert.equal(retrospectiveTickWith(NEXT_DATE, ledgerAfter).length, 1, "next UTC date: offered again");
  assert.equal(retrospectiveTickWith(LATER_SAME_DATE, "").length, 1, "an offer the wake could not deliver is offered again, not lost");
});

function retrospectiveTickWith(now: number, ledger: string) {
  return retrospectiveTick({ now, stateDir: "/nonexistent", read: fixtureRead, log: () => undefined, readLedger: () => ledger });
}

test("a report that throws offers nothing and says so on stderr, rather than stopping the orders behind it", () => {
  const said: string[] = [];
  const orders = retrospectiveTick({ now: OFFER_NOW, stateDir: "/nonexistent", read: () => { throw new Error("boom\nsecond line"); }, log: (l) => said.push(l), readLedger: () => "" });
  assert.deepEqual(orders, []);
  assert.match(said.join(""), /org-retro: could not build today's retrospective \(boom\) -- no org-retrospective order this tick\./);
});

// --- the prompt, the role text, the classification --------------------------------------------------------------------------------------------------

test("the prompt carries the numbers, the class-fix instruction and the #928 destination", () => {
  const order = retrospectiveOrder("2026-10-02", "THE NUMBERS");
  assert.match(order.prompt, /THE NUMBERS/);
  assert.ok(order.prompt.includes(CLASS_FIX_INSTRUCTION), "the class-fix instruction, verbatim");
  assert.match(order.prompt, /Acceptance is a test that covers the class and not the instance/);
  assert.match(order.prompt, /positive control/);
  assert.ok(order.prompt.includes(RETRO_DESTINATION) && RETRO_DESTINATION === "#928", "the reading and the filed rows are posted on #928");
  assert.match(order.prompt, /nothing tripped/, "a quiet day is posted with its numbers, never silence");
});

/** A section of a markdown file: its heading line to the next `## ` heading. Null when absent -- the positive control below is what makes that visible. */
function section(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${heading}`));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

const CEO_ROLE = readFileSync(join(HOME_CHECKOUT, ".agent-org/roles/ceo.md"), "utf8");

test("ceo.md names the duty IN ITS OWN SECTION, not merely somewhere in the file", () => {
  const own = section(CEO_ROLE, "The daily retrospective");
  assert.notEqual(own, null, "the section exists -- the positive control for the extraction itself");
  assert.ok(own!.includes(CLASS_FIX_INSTRUCTION), "the class-fix instruction, verbatim, in the section");
  assert.match(own!, /#928/);
  assert.match(own!, /nothing tripped/);
  assert.match(own!, /org-retro\.mjs/);
  // The extraction must NOT be satisfiable by a copy elsewhere: another section holding the phrase must not make this one pass.
  const elsewhere = CEO_ROLE.replace(own!, "");
  assert.equal(section(elsewhere, "The daily retrospective"), null, "removing the section removes the heading it is found by");
  assert.equal(section("## Other\nfind the CLASS and file a `ready` row for the class fix\n", "The daily retrospective"), null);
});

test("ceo.md states a bound for EVERY number the report trends, citing the 2026-10-02 baseline on #928", () => {
  const own = section(CEO_ROLE, "The daily retrospective");
  assert.notEqual(own, null);
  const missing = NUMBERS.filter((n) => !own!.includes(`\`${n.id}\``)).map((n) => n.id);
  assert.deepEqual(missing, [], "a number added to NUMBERS without a bound in the role text goes red here");
  assert.ok(NUMBERS.some((n) => n.id === "idleMinutes"), "POSITIVE CONTROL: the loop above ran over a real population, the idle-minutes number among it");
  assert.match(own!, /2026-10-02 reading on #928/);
  assert.match(own!, /org-retro-readings\.jsonl/);
});

test("`org-retrospective` is a declared JUDGMENT cause with a profile, and not a start", () => {
  assert.ok(CAUSES.includes(RETRO_CAUSE));
  assert.ok(JUDGMENT_CAUSES.includes(RETRO_CAUSE), "a drain must not withhold the org looking at itself");
  assert.ok(!START_CAUSES.includes(RETRO_CAUSE));
  assert.equal(PROFILES[RETRO_CAUSE]?.kind, "claude");
});

// --- #2955: THE REPORT HAS A YESTERDAY -----------------------------------------------------------------------------------------------------------

/** The hand-checked yesterday: `ceo`'s 2026-10-02 retrospective numbers (#928), every one a literal. */
const YESTERDAY = { date: "2026-10-01", numbers: { prsMerged: 46, medianOpenToMergeMinutes: 37, idleMinutes: 470, orgStalledWakes: 1, claimStalledWakes: 4, claimStallVoidings: 4,
  orgHealthOffers: 0, redPrs: 1, tokensPerMergedPr: 10_393_972, handFixes: 0 } };
const readingsText = (...entries: object[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

/** `n` ticks that each offered a Ready row nobody could take, so idle minutes are `2 * n` (the literal tick length), and `merged` PRs merged inside the window. */
function reportWith({ idleTicks, merged, readings }: { idleTicks: number; merged: number; readings: ReturnType<typeof parseReadings> | undefined }) {
  const journal = Array.from({ length: idleTicks }, (_, i) => tick(`${new Date(SINCE + (i + 1) * 60_000).toISOString().slice(0, 19)}+00:00`, [IDLE_OFFER(2824)])).join("\n");
  const prs = Array.from({ length: merged }, (_, i) => ({ number: i + 1, createdAt: "2026-10-01T10:00:00Z", mergedAt: "2026-10-01T10:30:00Z" }));
  return buildReport({ merged: prs, openPrs: [], journal, ledger: "", turns: [], handFixes: HAND_FIXES_ONE, readings }, NOW);
}

test("POPULATION FROM THE REPORT: every number it carries has a declared direction, and a number it carries with none is a defect, printed as one", () => {
  const report = reportWith({ idleTicks: 5, merged: 3, readings: parseReadings(readingsText(YESTERDAY)) });
  const ids = Object.keys(report.numbers);
  const EIGHT = ["prsMerged", "medianOpenToMergeMinutes", "idleMinutes", "orgStalledWakes", "claimStalledWakes", "claimStallVoidings", "redPrs", "tokensPerMergedPr"];
  assert.deepEqual(EIGHT.filter((id) => !ids.includes(id)), [], "POSITIVE CONTROL: the report carries the eight numbers the 2026-10-02 reading named, so the population is not empty");
  assert.deepEqual(undeclaredDirections(report.numbers), [], "every number the report carries is in the direction table");
  for (const id of ids) assert.match(NUMBERS.find((n) => n.id === id)?.better ?? "", /^(lower|higher)$/, `${id} declares which way is better`);
  assert.deepEqual(NUMBERS.map((n) => n.id).filter((id) => !ids.includes(id)), [], "and no table entry is dead: each one is a number the report carries");
  // The population is also read back from the PRINTED report, so a number that was computed and never shown cannot pass.
  const printed = renderReport(report).split("\nAgainst ")[1].split("\n").filter((l) => l.startsWith("- "));
  assert.equal(printed.length, ids.length, "one verdict line per number the report carries");
  for (const { label } of NUMBERS) assert.ok(printed.some((l) => l.startsWith(`- ${label}: `)), `${label} is printed with a verdict`);

  const extra = { ...report, numbers: { ...report.numbers, queueDepth: 3 } };
  assert.deepEqual(undeclaredDirections(extra.numbers), ["queueDepth"], "a fixture report with one more number, and no direction for it, goes red");
  assert.match(renderReport(extra), /^- queueDepth: NO DIRECTION DECLARED -- a defect/m, "and the report says so rather than defaulting to a verdict");
});

test("verdicts on a pair of consecutive days: idle 470 -> 100 is better, 100 -> 470 is worse, PRs merged 46 -> 10 is worse, 10 -> 46 is better", () => {
  const yesterday = (numbers: object) => parseReadings(readingsText({ date: "2026-10-01", numbers: { ...YESTERDAY.numbers, ...numbers } }));
  const better = renderReport(reportWith({ idleTicks: 50, merged: 46, readings: yesterday({}) }));
  assert.match(better, /^- Idle minutes while a claimable row existed: better \(now 100, previous 470 on 2026-10-01, delta -370\)/m, "470 -> 100");
  assert.match(better, /^- PRs merged: same \(now 46, previous 46 on 2026-10-01, delta 0\)/m, "46 -> 46 is same");
  const worse = renderReport(reportWith({ idleTicks: 235, merged: 10, readings: yesterday({ idleMinutes: 100 }) }));
  assert.match(worse, /^- Idle minutes while a claimable row existed: worse \(now 470, previous 100 on 2026-10-01, delta \+370\)/m, "100 -> 470");
  assert.match(worse, /^- PRs merged: worse \(now 10, previous 46 on 2026-10-01, delta -36\)/m, "46 -> 10: HIGHER is better for merges");
  const recovered = renderReport(reportWith({ idleTicks: 235, merged: 46, readings: yesterday({ prsMerged: 10 }) }));
  assert.match(recovered, /^- PRs merged: better \(now 46, previous 10/m, "10 -> 46");
});

test("verdictFor is decided by the declared direction alone: the same pair reads the opposite way for the opposite direction", () => {
  const previous = { status: "read", numbers: { x: 5 } };
  assert.equal(verdictFor({ better: "lower", previous, id: "x", current: 3 }), "better");
  assert.equal(verdictFor({ better: "higher", previous, id: "x", current: 3 }), "worse");
  assert.equal(verdictFor({ better: "lower", previous, id: "x", current: 5 }), "same");
  assert.equal(verdictFor({ better: "lower", previous, id: "x", current: 0 }), "better", "a real zero is a number");
});

test("no previous line, or a readings file that cannot be read, prints `no baseline` / `unknown`: never `same`, never a delta against 0", () => {
  const dir = tmpDir("org-retro-");
  const unreadable = [
    ["an absent file is a first day", readReadings(join(dir, "absent.jsonl")), "no baseline"],
    ["an empty file is a first day", parseReadings(""), "no baseline"],
    ["a file holding no line that reads", parseReadings("not json\n{\"date\":1}\n"), "unknown"],
    ["a path the disk will not read as a file", readReadings(dir), "unknown"],
    ["no read made at all", undefined, "unknown"],
    ["only TODAY's own line (the offer repeating): today is not its own baseline", parseReadings(readingsText({ date: "2026-10-02", numbers: YESTERDAY.numbers })), "no baseline"],
  ] as const;
  for (const [why, readings, verdict] of unreadable) {
    const text = renderReport(reportWith({ idleTicks: 5, merged: 3, readings }));
    const verdicts = text.split("\nAgainst ")[1].split("\n").filter((l) => l.startsWith("- "));
    assert.equal(verdicts.length, NUMBERS.length, why);
    for (const l of verdicts) assert.match(l, new RegExp(`: (${verdict}|unknown) \\(now`), `${why}: ${l}`);
    assert.doesNotMatch(text.split("\nAgainst ")[1], /: same|delta/, `${why}: never same, never a delta`);
  }
  const partial = previousReading(parseReadings(readingsText({ date: "2026-10-01", numbers: { prsMerged: null } })), "2026-10-02");
  assert.equal(compareReadings({ prsMerged: 3 }, partial)[0].verdict, "no baseline", "a previous number that was itself unknown is no baseline");
  assert.equal(compareReadings({ prsMerged: null }, previousReading(parseReadings(readingsText(YESTERDAY)), "2026-10-02"))[0].verdict, "unknown", "a number unknown now is unknown, not 0");
});

test("the baseline is the latest line BEFORE today, however old, and a corrupt line does not hide the good ones", () => {
  const text = readingsText({ date: "2026-09-28", numbers: { prsMerged: 1 } }, { date: "2026-09-30", numbers: { prsMerged: 2 } }) + "garbage\n" + readingsText({ date: "2026-10-02", numbers: { prsMerged: 9 } });
  const previous = previousReading(parseReadings(text), "2026-10-02");
  assert.deepEqual(previous, { status: "read", date: "2026-09-30", numbers: { prsMerged: 2 } });
});

test("delivering the offer appends exactly one line per UTC date, and a manual run appends none", () => {
  const dir = tmpDir("org-retro-");
  const path = join(dir, READINGS_FILE);
  const read = ({ now, stateDir }: { now: number; stateDir: string }) => ({ ...fixtureRead(), readings: readReadings(join(stateDir, READINGS_FILE)), now });
  const tickAt = (now: number) => retrospectiveTick({ now, stateDir: dir, read: read as never, log: () => undefined, readLedger: () => "" });
  const lines = () => readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
  assert.equal(tickAt(OFFER_NOW).length, 1);
  assert.equal(lines().length, 1, "the first offer of the date writes one line");
  assert.deepEqual(Object.keys(JSON.parse(lines()[0])), ["date", "numbers"]);
  assert.equal(JSON.parse(lines()[0]).date, "2026-10-02");
  assert.equal(tickAt(LATER_SAME_DATE).length, 1, "the offer repeats until the ledger shows it delivered");
  assert.equal(lines().length, 1, "and the same date does not write a second line");
  assert.equal(tickAt(NEXT_DATE).length, 1);
  assert.deepEqual(lines().map((l) => JSON.parse(l).date), ["2026-10-02", "2026-10-03"], "the next UTC date writes its own");
  assert.match(retrospectiveTick({ now: NEXT_DATE, stateDir: dir, read: read as never, log: () => undefined, readLedger: () => "" })[0].prompt, /Against the previous reading, 2026-10-02:/,
    "and the order the model reads carries the comparison with the line just written");
  // The writer and the reader share ONE path: the scan above cannot see `join(stateDir, READINGS_FILE)`, so this round trip is what proves someone writes what is read.
  assert.equal(readReadings(path).entries.length, 2);
  assert.equal(recordReading({ stateDir: dir, date: "2026-10-03", numbers: {} }), "already recorded");
  // A file the disk would not read is left alone, never appended to blind: here the "file" is a directory, which reads as EISDIR and not as a first day.
  const blocked = tmpDir("org-retro-");
  mkdirSync(join(blocked, READINGS_FILE));
  assert.equal(recordReading({ stateDir: blocked, date: "2026-10-09", numbers: {} }), "not recorded");
});

test("a readings file with no line that parses is left as it is, not appended to (#2985)", () => {
  const dir = tmpDir("org-retro-");
  const path = join(dir, READINGS_FILE);
  writeFileSync(path, "not json\n");
  assert.equal(recordReading({ stateDir: dir, date: "2026-10-09", numbers: { prsMerged: 1 } }), "not recorded");
  assert.equal(readFileSync(path, "utf8"), "not json\n", "the corruption is not masked by a valid line beside it");
  assert.equal(readReadings(path).status, "unreadable", "so the next report still says unknown, never a baseline built on the line we wrote");
  // The other side: one bad line among good ones is still a file that reads, and today's line is appended.
  writeFileSync(path, `not json\n${JSON.stringify({ date: "2026-10-01", numbers: { prsMerged: 5 } })}\n`);
  assert.equal(recordReading({ stateDir: dir, date: "2026-10-09", numbers: { prsMerged: 1 } }), "recorded");
});

test("a failing write does not stop the offer, and says so", () => {
  const said: string[] = [];
  const orders = retrospectiveTick({ now: OFFER_NOW, stateDir: "/nonexistent", read: fixtureRead as never, log: (l) => said.push(l), readLedger: () => "",
    record: () => { throw new Error("ENOSPC: no space left\nsecond line"); } });
  assert.equal(orders.length, 1, "the order still goes out");
  assert.match(said.join(""), /today's reading was not recorded \(ENOSPC: no space left\)/);
});

test("a manual run of the CLI reads the previous line and writes nothing", () => {
  const home = tmpDir("org-retro-home-");
  const stateDir = join(home, ".cache", "a11ign");
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, READINGS_FILE);
  writeFileSync(path, readingsText(YESTERDAY));
  // PATH is empty so `gh`, `journalctl` and `git` cannot be found: every read is refused, which is `unknown`, and nothing real is reached.
  // The child finds the project the way this file does: through the host file, which a stripped environment would otherwise lose.
  const host = process.env[HOST_ENV] === undefined ? {} : { [HOST_ENV]: process.env[HOST_ENV] };
  const out = execFileSync(process.execPath, [new URL("../org-retro.ts", import.meta.url).pathname, "--now=2026-10-02T00:00:00Z"],
    { encoding: "utf8", env: { HOME: home, PATH: "", ...host } });
  assert.match(out, /Against the previous reading, 2026-10-01:/, "it compared against the line");
  assert.equal(readFileSync(path, "utf8"), readingsText(YESTERDAY), "and wrote nothing");
  assert.deepEqual(readdirSync(stateDir), [READINGS_FILE], "not even another file");
});
