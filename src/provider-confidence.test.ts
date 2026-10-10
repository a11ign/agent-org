// #4748: the confidence reading over a FIXTURE decision log. No network, no live log, no `gh`: the lines are written here, in the shape `decision-provider.ts`'s `logged` and `settle` write them.
// no-token: none -- reads lines this file builds and, for the CLI, one temporary file; nothing here reaches `gh`, `herdr` or `git`
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { confidenceReading, formatConfidenceReading, parseWindow, type ConfidenceReading } from "./provider-confidence.ts";
import { tmpDirForFile } from "./lib/tmp-fixture.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-10T08:00:00Z");
const DAY = 24 * HOUR;

type Answer = Record<string, unknown>;
/** An answer the provider gave at or over the floor. */
const given = (value: string | number, confidence: number): Answer => ({ value, confidence, fellBack: false });
/** An answer the provider gave and the floor replaced: it keeps `asked` and the confidence, which is how it is told from a refusal. */
const underFloor = (confidence: number, floor = 0.7): Answer =>
  ({ value: "no", confidence, fellBack: true, asked: "yes", reason: `yes at ${confidence}, under the floor ${floor}` });
/** An answer the provider never gave: a 422, a timeout or a refusal. No confidence, no `asked`. */
const refused = (reason = "the API answered HTTP 422"): Answer => ({ value: "no", fellBack: true, reason });
const decision = (use: string, answers: Record<string, Answer>, at = NOW - HOUR, id = "row-1") =>
  ({ use, id, fields: ["title"], questions: Object.keys(answers), answers, via: "jev", fellBack: false, at });
const readingOf = (lines: readonly unknown[], options: { windowMs?: number; declaredFloor?: number } = {}): ConfidenceReading =>
  confidenceReading(lines, { now: NOW, windowMs: options.windowMs ?? DAY, declaredFloor: options.declaredFloor });
const rowFor = (reading: ConfidenceReading, use: string, question: string) => {
  const row = reading.rows.find((r) => r.use === use && r.question === question);
  assert.ok(row, `no row for ${use}/${question}: ${JSON.stringify(reading.rows.map((r) => [r.use, r.question]))}`);
  return row;
};

test("one row per use and question, each counting the decisions that asked it", () => {
  const reading = readingOf([
    decision("model-routing", { score: given(3, 0.9), subsystems: given("no", 0.9) }),
    decision("model-routing", { score: given(4, 0.9) }),
    // the SAME question name under another use is its own row, not folded into the first
    decision("wake-triage", { score: given(2, 0.9) }),
  ]);
  assert.equal(reading.decisions, 3);
  assert.deepEqual(reading.rows.map((r) => [r.use, r.question, r.asked]), [
    ["model-routing", "score", 2], ["model-routing", "subsystems", 1], ["wake-triage", "score", 1],
  ]);
});

test("the under-floor share counts answers the floor held back and NOT a 422, a refusal or a timeout", () => {
  const reading = readingOf([
    decision("model-routing", { score: underFloor(0.61) }),
    decision("model-routing", { score: refused("the API answered HTTP 422") }),
    decision("model-routing", { score: refused("the request timed out") }),
    decision("model-routing", { score: given(4, 0.95) }),
  ]);
  const row = rowFor(reading, "model-routing", "score");
  assert.equal(row.asked, 4);
  assert.equal(row.underFloor, 1, "only the answer carrying a confidence and an `asked` fell for the floor");
  assert.equal(row.otherFallback, 2, "the 422 and the timeout are counted apart");
  assert.equal(row.underFloorShare, 0.25);
});

test("a question that only ever 422s has no confidence and no under-floor share, so it is not read as confident", () => {
  const row = rowFor(readingOf([decision("model-routing", { score: refused() }), decision("model-routing", { score: refused() })]), "model-routing", "score");
  assert.deepEqual([row.asked, row.underFloor, row.otherFallback, row.answered], [2, 0, 2, 0]);
  assert.equal(row.meanConfidence, undefined);
  assert.equal(row.medianConfidence, undefined);
});

test("mean and median run over every answer that carried a confidence, the held-back ones included", () => {
  const odd = rowFor(readingOf([
    decision("model-routing", { score: given(3, 0.9) }),
    decision("model-routing", { score: underFloor(0.5) }),
    decision("model-routing", { score: given(3, 1) }),
    decision("model-routing", { score: refused() }),
  ]), "model-routing", "score");
  assert.equal(odd.answered, 3);
  assert.ok(Math.abs((odd.meanConfidence ?? NaN) - 0.8) < 1e-9, `mean ${odd.meanConfidence}`);
  assert.equal(odd.medianConfidence, 0.9, "the middle of 0.5, 0.9 and 1, which is not the mean");
  const even = rowFor(readingOf([decision("model-routing", { score: given(3, 0.4) }), decision("model-routing", { score: given(3, 0.6) })]), "model-routing", "score");
  assert.ok(Math.abs((even.medianConfidence ?? NaN) - 0.5) < 1e-9, "an even count takes the middle two's mean");
});

test("the window keeps `[now - windowMs, now]` and leaves out older lines and lines from the future", () => {
  const lines = [
    decision("model-routing", { score: given(3, 0.9) }, NOW - DAY - 1),
    decision("model-routing", { score: given(3, 0.9) }, NOW - DAY),
    decision("model-routing", { score: given(3, 0.9) }, NOW),
    decision("model-routing", { score: given(3, 0.9) }, NOW + 1),
  ];
  assert.equal(readingOf(lines).decisions, 2, "the one on the start and the one at `now`");
  assert.equal(rowFor(readingOf(lines), "model-routing", "score").asked, 2);
  assert.equal(readingOf(lines, { windowMs: 1 }).decisions, 1, "a narrower window drops the one a day old");
});

test("a line it cannot read is counted and named by position, and a blank line or an outcome line is not one", () => {
  const lines = [
    JSON.stringify(decision("model-routing", { score: given(3, 0.9) })),
    "{not json",
    JSON.stringify({ use: "model-routing", id: "row-1", outcome: "route sonnet/high via jev", at: NOW - HOUR }),
    "",
    "null",
    JSON.stringify(["an", "array"]),
    JSON.stringify({ use: "model-routing", at: NOW - HOUR, answers: { score: { value: 3, fellBack: "yes" } } }),
    JSON.stringify({ use: "model-routing", at: "yesterday", answers: {} }),
  ];
  const reading = readingOf(lines);
  assert.deepEqual(reading.unreadable, { count: 5, lines: [2, 5, 6, 7, 8] });
  assert.equal(reading.decisions, 1, "the readable decision is still counted: an unreadable neighbour does not void the reading");
  assert.match(formatConfidenceReading(reading), /5 log lines could not be read and are not in this reading: line 2, 5, 6, 7, 8\./);
});

test("an unreadable line is named even when it is older than the window, because its time cannot be known", () => {
  assert.equal(readingOf(["{not json"], { windowMs: 1 }).unreadable.count, 1);
});

test("the provider absent is an empty reading that says so, and without any unreadable line says nothing more", () => {
  const reading = readingOf([]);
  assert.deepEqual([reading.decisions, reading.rows, reading.unreadable], [0, [], { count: 0, lines: [] }]);
  assert.match(formatConfidenceReading(reading), /\nno provider decisions in the window$/);
  assert.equal(formatConfidenceReading(readingOf(["{not json"])).includes("no provider decisions in the window"), true, "an empty reading still names what it could not read");
  assert.match(formatConfidenceReading(readingOf(["{not json"])), /1 log line could not be read and is not in this reading: line 1\./);
});

test("the floor beside a row is the latest one a held-back answer named, else the host's declared one, else not known", () => {
  const reading = readingOf([
    decision("model-routing", { score: underFloor(0.5, 0.9), subsystems: given("no", 0.9), covered: given("no", 1) }, NOW - 2 * HOUR),
    decision("model-routing", { score: underFloor(0.6, 0.7) }, NOW - HOUR),
    decision("model-routing", { score: underFloor(0.4, 0.8) }, NOW - 3 * HOUR),
  ], { declaredFloor: 0.7 });
  assert.deepEqual(rowFor(reading, "model-routing", "score").floor, { value: 0.7, from: "lines" }, "the newest line's, not the last one read");
  assert.deepEqual(rowFor(reading, "model-routing", "subsystems").floor, { value: 0.7, from: "declared" });
  assert.equal(rowFor(readingOf([decision("model-routing", { covered: given("no", 1) })]), "model-routing", "covered").floor, undefined);
});

test("the table has one row per question with the floor in it, and a share that is a percentage", () => {
  const text = formatConfidenceReading(readingOf([
    decision("model-routing", { score: underFloor(0.61), subsystems: given("no", 0.9) }),
    decision("model-routing", { score: given(3, 0.9), subsystems: refused() }),
  ]));
  const score = text.split("\n").find((line) => /^model-routing\s+score\s/.test(line));
  const subsystems = text.split("\n").find((line) => /^model-routing\s+subsystems\s/.test(line));
  assert.match(score ?? "", /^model-routing\s+score\s+2\s+1\s+50%\s+0\s+2\s+0\.76\s+0\.76\s+0\.7$/);
  assert.match(subsystems ?? "", /^model-routing\s+subsystems\s+2\s+0\s+0%\s+1\s+1\s+0\.90\s+0\.90\s+not known$/);
  assert.match(text, /2 decisions asked in the window\./);
});

test("a window is a number and m, h or d, and anything else is refused rather than guessed", () => {
  assert.equal(parseWindow("30m"), 30 * 60_000);
  assert.equal(parseWindow("24h"), DAY);
  assert.equal(parseWindow("7d"), 7 * DAY);
  for (const bad of ["", "24", "h", "0h", "1.5h", "24 h", "-1h", "1w"]) assert.equal(parseWindow(bad), undefined, JSON.stringify(bad));
});

test("a window that is not a positive number is a programming error, not an empty reading", () => {
  for (const windowMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => readingOf([], { windowMs }), RangeError);
});

test("the CLI prints the reading of a log file, takes `--since 24h` as the row spells it, and refuses a window it cannot read", () => {
  const dir = tmpDirForFile("provider-confidence-");
  const log = join(dir, "decisions");
  const recent = decision("model-routing", { score: underFloor(0.61) }, Date.now() - HOUR);
  const old = decision("model-routing", { score: given(3, 0.99) }, Date.now() - 3 * DAY);
  writeFileSync(log, `${[recent, old].map((l) => JSON.stringify(l)).join("\n")}\n`);
  // HOME is the temporary directory so the host declaration is not the live one's.
  const run = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, "provider-confidence.ts"), ...args], { encoding: "utf8", env: { ...process.env, HOME: dir } });
  const day = run("--since", "24h", `--log=${log}`);
  assert.equal(day.status, 0, day.stderr);
  assert.match(day.stdout, /model-routing\s+score\s+1\s+1\s+100%/);
  const week = run("--since=7d", `--log=${log}`);
  assert.match(week.stdout, /model-routing\s+score\s+2\s+1\s+50%/);
  assert.equal(run(`--log=${join(dir, "absent")}`).stdout.includes("no provider decisions in the window"), true, "an absent log is the provider never asked");
  const bad = run("--since", "yesterday", `--log=${log}`);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /CANNOT ASK: --since takes a number and m, h or d/);
  assert.equal(run("--sinse", "24h", `--log=${log}`).status, 2, "an unknown flag is refused, not run on the default");
});
