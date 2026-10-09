// a11ign/a11ign#4074: the seeded triage sample. Fixtures only: nothing here reads `~/.cache/a11ign`, a transcript or GitHub.
// no-token: gh -- every source is an injected fixture; `drawTriageSample` is a pure function and calls no `gh`
//
// THE FIXTURE is 6 causes over the three managers in a window of one day: three common (`answer-owed` 120 wakes, `org-health` 60, `pr-checks-failing` 30) and three RARE ones (`trunk-red` 1,
// `chairman-blocked` 2, and wakes with no cause at all, 3): 216 wakes. At size 20 the proportional share of each rare cause is far under one place, so only the one-place-each rule puts them
// in; at size 151 their share exceeds what they have, so they give ALL of it. The hand-computed quotas are in the comments beside each test.
import { TSX_IMPORT } from "../tsx-import.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { allocate, COST, drawTriageSample, Figures, MANAGERS, NO_CAUSE, parseArgs, renderProvenance, renderSheet, SHOWN } from "./triage-sample.mjs";

const FROM = Date.parse("2026-10-07T00:00:00Z");
const TO = Date.parse("2026-10-08T00:00:00Z");
const SPAN = TO - FROM;
const MINUTE = 60_000;

const made: string[] = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

let serial = 0;
/** A manager wake at `at` ms from FROM. `cause` null is a wake whose ledger line named none. */
const wake = ({ session = "ceo", cause, at, bytes = 1000, lag = 10 }) => {
  serial += 1;
  const id = `wake:${session}:${FROM + at}:${serial}`;
  return { id, kind: "wake", source: "wake-ledger", at: FROM + at, session, row: 4000 + serial, pr: null, repo: null, cause, causeKey: cause === null ? null : `${session}/${cause}/row-${4000 + serial}`, wakeId: id, bytes, deliveryLagMs: lag };
};
const turn = ({ of, cost, sidechain = false, session = of.session, n = 0 }) => ({
  id: `turn:${of.id}:${n}`, kind: "turn", source: "transcript", at: of.at + MINUTE, session, row: null, pr: null, repo: null, cause: null, causeKey: null, wakeId: of.id,
  model: "claude-fable-5-1", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, costUsd: cost, sidechain,
});

const SESSIONS = ["ceo", "product-manager", "orchestrator"];
/** `count` wakes of one cause, spread over the day and over the three managers. */
const wakesOf = (cause: string|null, count: number) => Array.from({ length: count }, (_, i) => wake({ cause, session: SESSIONS[i % SESSIONS.length], at: Math.floor((i * SPAN) / (count + 1)) + MINUTE }));

const WAKES = [...wakesOf("answer-owed", 120), ...wakesOf("org-health", 60), ...wakesOf("pr-checks-failing", 30), ...wakesOf("trunk-red", 1), ...wakesOf("chairman-blocked", 2), ...wakesOf(null, 3)];
const TURNS = WAKES.map((one, i) => turn({ of: one, cost: 0.01 * ((i % 7) + 1) }));
const EVENTS = [...WAKES, ...TURNS];
const BASE = { events: EVENTS, from: FROM, to: TO, size: 20 };
const idsOf = (sample: { rows: any; strata?: { cause: string; wakes: number; drawn: number; }[]; population?: number; }) => sample.rows.map((row: { wakeId: any; }) => row.wakeId);
const countBy = (sample: { rows: any; strata?: { cause: string; wakes: number; drawn: number; }[]; population?: number; }) => sample.rows.reduce((by: { set: (arg0: any,arg1: any) => any; get: (arg0: any) => any; }, row: { cause: any; }) => by.set(row.cause, (by.get(row.cause) ?? 0) + 1), new Map());

test("the same seed over the same store draws the same sample, whatever order the store is read in", () => {
  const first = drawTriageSample({ ...BASE, seed: "4074" });
  assert.equal(first.rows.length, 20);
  assert.deepEqual(drawTriageSample({ ...BASE, seed: "4074" }), first, "positive control: a second run is identical, rows AND their order");
  assert.deepEqual(idsOf(drawTriageSample({ ...BASE, events: EVENTS.toReversed(), seed: "4074" })), idsOf(first), "a store read backwards draws the same wakes in the same order");
});

test("a different seed draws a different set", () => {
  const a = new Set(idsOf(drawTriageSample({ ...BASE, seed: "4074" })));
  const b = new Set(idsOf(drawTriageSample({ ...BASE, seed: "4075" })));
  assert.notDeepEqual([...a].toSorted(), [...b].toSorted(), "negative control: another seed is another set");
  assert.ok([...a].some((id) => !b.has(id)), "at least one wake differs");
});

test("every cause with a wake appears, and the places are shared as computed by hand", () => {
  const sample = drawTriageSample({ ...BASE, seed: "4074" });
  // One place each first (6), leaving 14 over weights 120/60/30/3/2/1 (216). Pass 1: `trunk-red` has 0 spare room and its share is 0.065, so it is capped (it has given all it has) and
  // takes nothing more. Pass 2 over the other five (weight 215): 7.81, 3.91, 1.95, 0.195 (3 wakes), 0.130 (2 wakes), none capped; floors 7+3+1 = 11, three left to the largest
  // remainders .95 (pr-checks-failing), .91 (org-health), .81 (answer-owed). So 1+8, 1+4, 1+2 and one place each for the three rare causes: 9, 5, 3, 1, 1, 1 = 20.
  assert.deepEqual([...countBy(sample)].toSorted(), [["answer-owed", 9], ["chairman-blocked", 1], ["org-health", 5], ["pr-checks-failing", 3], ["trunk-red", 1], [NO_CAUSE, 1]].toSorted());
  assert.equal(sample.rows.length, 20);
  assert.equal(sample.population, 216);
  for (const stratum of sample.strata) assert.ok(stratum.drawn >= 1, `${stratum.cause} appears`);
});

test("a cause with fewer wakes than its share contributes all of them, and never the same wake twice", () => {
  const sample = drawTriageSample({ ...BASE, seed: "4074", size: 151 });
  // Size 151: 145 spare over 216. Pass 1: the three rare causes' shares (0.67, 1.34, 2.01) are at least their spare room (0, 1, 2), so each gives ALL it has: 1, 2, 3 places and 3 spare used.
  // Pass 2: 142 over weight 210: 81.14, 40.57, 20.29; floors 141; the last place to the largest remainder (.57, org-health). So 82, 42, 21, 1, 2, 3 = 151.
  assert.deepEqual([...countBy(sample)].toSorted(), [["answer-owed", 82], ["chairman-blocked", 2], ["org-health", 42], ["pr-checks-failing", 21], ["trunk-red", 1], [NO_CAUSE, 3]].toSorted());
  const all = (cause: string) => WAKES.filter((one) => (one.cause ?? NO_CAUSE) === cause).map((one) => one.id).toSorted();
  for (const cause of ["trunk-red", "chairman-blocked", NO_CAUSE]) {
    assert.deepEqual(sample.rows.filter((row) => row.cause === cause).map((row) => row.wakeId).toSorted(), all(cause), `${cause}: every wake is drawn`);
  }
  assert.equal(new Set(idsOf(sample)).size, sample.rows.length, "no wake is drawn twice");
  assert.ok(sample.rows.filter((row) => row.cause === "answer-owed").length < 120, "negative control: a common cause is only SAMPLED");
});

test("allocate: places are conserved, capped at what a cause has, and the same counts give the same places", () => {
  const counts = new Map([["a", 500], ["b", 40], ["c", 1], ["d", 2]]);
  const sum = (quota: any[]|Map<string,number>) => [...quota.values()].reduce((total, n) => total + n, 0);
  // Size 100: 96 spare over 543. c is capped (0 room). The others over 542: a 88.45, b 7.08, d 0.35; floors 88+7+0 = 95, the last place to a (.45). So a 90, b 8, c 1, d 1.
  const quota = allocate(counts, 100);
  assert.deepEqual([...quota].toSorted(), [["a", 90], ["b", 8], ["c", 1], ["d", 1]]);
  assert.equal(sum(quota), 100, "all 100 places are used");
  assert.deepEqual([...allocate(counts, 100)], [...quota], "the same counts, the same places");
  // Size 400: d's share (1.46) exceeds its one spare place, so it gives all it has.
  const large = allocate(counts, 400);
  assert.equal(sum(large), 400);
  assert.deepEqual([large.get("c"), large.get("d")], [1, 2]);
  for (const [cause, places] of large) assert.ok(places >= 1 && places <= counts.get(cause), `${cause}: 1 <= ${places} <= ${counts.get(cause)}`);
  assert.deepEqual(allocate(new Map([["a", 3], ["b", 4]]), 100), new Map([["a", 3], ["b", 4]]), "fewer wakes than places: all of them");
});

test("the window is from-inclusive to-exclusive and only the three managers' wakes count", () => {
  const edge = [wake({ cause: "edge-in", at: 0 }), wake({ cause: "edge-out", at: SPAN }), wake({ cause: "worker-cause", session: "worker-4074", at: MINUTE }), wake({ cause: "before", at: -MINUTE })];
  const sample = drawTriageSample({ ...BASE, events: [...EVENTS, ...edge], seed: "4074", size: 50 });
  const causes = new Set(sample.rows.map((row) => row.cause));
  assert.ok(causes.has("edge-in"), "positive control: a wake AT `from` is in");
  for (const out of ["edge-out", "worker-cause", "before"]) assert.ok(!causes.has(out), `${out} is outside the population`);
  assert.deepEqual(MANAGERS, SESSIONS);
});

test("the printed row carries no order text and none of the fields a labeller could be biased by", () => {
  const sample = drawTriageSample({ ...BASE, seed: "4074" });
  for (const row of sample.rows) {
    assert.deepEqual(Object.keys(row).filter((key) => key !== "wakeId").toSorted(), [...SHOWN].toSorted(), "exactly the shown facts, plus the id that joins a label back");
    for (const hidden of ["bytes", "deliveryLagMs", "at", "row", "pr", "repo", "text", "body", "stratum"]) assert.ok(!(hidden in row), `${hidden} is not on a row`);
  }
  const sheet = renderSheet(sample);
  assert.ok(!sheet.includes("wake:"), "the sheet does not print the wake id, which carries the time");
  assert.ok(!/\b(bytes|lag|of \d+)\b/.test(sheet), "no size, lag or stratum size on the sheet");
  assert.ok(renderProvenance(sample, { seed: "4074", from: FROM, to: TO }).includes("answer-owed: 9 of 120"), "positive control: the stratum sizes ARE in the provenance, which the labeller is not given");
  // The marker above would also pass on an empty sheet: pin that the facts are there.
  assert.equal(sheet.split("\n").filter((line) => /^\s*\d+\. \[   \]/.test(line)).length, 20);
  assert.ok(sheet.includes("cost $"));
});

test("the order of the rows says nothing about their cause: it is a seeded shuffle, not grouped", () => {
  const rows = drawTriageSample({ ...BASE, seed: "4074" }).rows;
  assert.deepEqual(rows.map((row) => row.n), Array.from({ length: 20 }, (_, i) => i + 1));
  const runs = rows.filter((row, i) => i > 0 && row.cause !== rows[i - 1].cause).length;
  assert.ok(runs > 6, `the causes alternate (${runs} changes of cause in 20 rows); a grouped list would change cause 5 times`);
});

test("a wake's cost is the sum of its own session's turns, a floor with an unpriced turn, and never 0 for no turn", () => {
  const [priced, floored, unpriced, bare, stray] = ["priced", "floored", "unpriced", "bare", "stray"].map((cause) => wake({ cause, at: MINUTE }));
  const events = [
    priced, turn({ of: priced, cost: 0.1, n: 1 }), turn({ of: priced, cost: 0.25, sidechain: true, n: 2 }),
    floored, turn({ of: floored, cost: 0.1, n: 1 }), turn({ of: floored, cost: null, n: 2 }),
    unpriced, turn({ of: unpriced, cost: null }),
    bare,
    stray, turn({ of: stray, cost: 9, session: "worker-1" }),
  ];
  const by = Object.fromEntries(drawTriageSample({ events, seed: "x", from: FROM, to: TO }).rows.map((row) => [row.cause, row.cost]));
  assert.deepEqual(by.priced, { usd: 0.35, state: COST.PRICED, turns: 2 }, "a subagent's turn is the wake's spend");
  assert.deepEqual(by.floored, { usd: 0.1, state: COST.FLOOR, turns: 2 });
  assert.deepEqual(by.unpriced, { usd: null, state: COST.UNPRICED, turns: 1 });
  assert.deepEqual(by.bare, { usd: null, state: COST.NO_TURN, turns: 0 }, "no turn is not free");
  assert.deepEqual(by.stray, { usd: null, state: COST.NO_TURN, turns: 0 }, "another session's turn under the same wake id is not this wake's");
  const sheet = renderSheet(drawTriageSample({ events, seed: "x", from: FROM, to: TO }));
  assert.ok(sheet.includes("cost >= $0.1000 (floor (a turn has no price))") && sheet.includes("cost no turn") && sheet.includes("cost not priced"));
});

test("it refuses what it cannot do honestly", () => {
  assert.throws(() => drawTriageSample({ ...BASE, seed: "" }), /seed is required/);
  assert.throws(() => drawTriageSample({ ...BASE, seed: "1", size: 0 }), /positive integer/);
  assert.throws(() => drawTriageSample({ ...BASE, seed: "1", from: TO, to: FROM }), /window is empty/);
  assert.throws(() => drawTriageSample({ ...BASE, events: [], seed: "1" }), /no manager wake/);
  assert.throws(() => drawTriageSample({ ...BASE, seed: "1", size: 5 }), /6 causes .* only 5 places/, "positive control: 6 causes fit 6 places");
  assert.equal(drawTriageSample({ ...BASE, seed: "1", size: 6 }).rows.length, 6);
});

test("the command prints a sheet from a store file, the same twice, and refuses without a seed", () => {
  const dir = mkdtempSync(join(tmpdir(), "triage-sample-"));
  made.push(dir);
  const store = join(dir, "events.ndjson");
  writeFileSync(store, `${EVENTS.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const script = join(dirname(fileURLToPath(import.meta.url)), "triage-sample.mjs");
  const run = (...args: (string|undefined)[]) => spawnSync(process.execPath, [...TSX_IMPORT, script, "--store", store, "--from", new Date(FROM).toISOString(), "--to", new Date(TO).toISOString(), "--size", "20", ...args], { encoding: "utf8" });
  const first = run("--seed", "4074");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(run("--seed", "4074").stdout, first.stdout, "reproducible through the command");
  assert.notEqual(run("--seed", "4075").stdout, first.stdout);
  assert.equal(JSON.parse(run("--seed", "4074", "--json").stdout).rows.length, 20);
  const unseeded = run();
  assert.equal(unseeded.status, 1);
  assert.match(unseeded.stderr, /seed is required/);
  assert.equal(parseArgs(["--seed", "s", "--to", "2026-10-08T00:00:00Z"]).from, TO - 7 * 86_400_000, "the default window is the seven days before `--to`");
});

// ---- a11ign/a11ign#4183: the scorer, over the FROZEN #4074 fixture and fake predictions. No model, no `gh`, no store, no sampler.
import { readFileSync } from "node:fs";
import { BAR, loadLabels, renderPrompt, renderScore, scoreTriage } from "./triage-sample.mjs";

const { rows: SHEET, definitions: DEFINITIONS } = loadLabels();
const UNREADABLE = [3, 44, 45, 57, 88, 98];
const asPredictions = (rows = SHEET) => rows.map((row) => ({ position: row.position, label: row.label }));
/** The predictions with `position` answered `label`. */
const answering = (position: number, label: string|undefined) => asPredictions().map((one) => (one.position === position ? { ...one, label } : one));
const tally = (rows: any[], key: string) => rows.reduce((counts: { [x: string]: any; }, row: { [x: string]: string|number; }) => ({ ...counts, [row[key]]: (counts[row[key]] ?? 0) + 1 }), {});
const classOf = (score: { withExcluded?: Figures; withoutExcluded?: Figures; excluded?: { positions: number[]; predicted: { position: number; label: string; predicted: string|undefined; }[]; }; classes: any; bar?: Readonly<{ minRows: 5; }>; }, cause: string) => score.classes.find((one: { cause: any; }) => one.cause === cause);
/** A readable `wake` row of a class that passes the bar when nothing is missed: `answer-owed` has 14 of them. */
const A_WAKE = SHEET.find((row) => row.cause === "answer-owed" && row.label === "wake" && !row.excluded);

test("the fixture is the 100 rows of #4074: 60 wake, 36 digest, 4 drop, and exactly six unreadable ones", () => {
  assert.equal(SHEET.length, 100);
  assert.deepEqual(tally(SHEET, "label"), { wake: 60, digest: 36, drop: 4 });
  assert.deepEqual(SHEET.filter((row) => row.excluded).map((row) => row.position), UNREADABLE);
  assert.deepEqual(SHEET.map((row) => row.position), Array.from({ length: 100 }, (_, i) => i + 1), "positions are the sheet's numbering, 1 to 100");
  assert.ok(SHEET.filter((row) => row.excluded).every((row) => row.causeKey === "(no ledger line)" && row.label === "wake"), "an unreadable row is exactly one with no ledger line, labelled wake");
  assert.ok(SHEET.filter((row) => !row.excluded).every((row) => row.causeKey !== "(no ledger line)"));
  assert.notDeepEqual(tally(SHEET.slice(1), "label"), { wake: 60, digest: 36, drop: 4 }, "control: losing a row changes the count this test reads");
  assert.deepEqual(Object.keys(DEFINITIONS), ["wake", "digest", "drop"]);
});

test("predictions equal to the labels score 100% and 0 missed wakes, with and without the unreadable rows", () => {
  const score = scoreTriage(SHEET, asPredictions());
  assert.equal(score.withExcluded.n, 100);
  assert.equal(score.withExcluded.agree, 100);
  assert.equal(score.withoutExcluded.n, 94);
  assert.equal(score.withoutExcluded.agree, 94);
  assert.deepEqual([score.withExcluded.missedWakes, score.withoutExcluded.missedWakes], [[], []]);
  assert.match(renderScore(score), /agreement 100\/100 \(100\.0%\).*missed wakes 0/);
  assert.notEqual(scoreTriage(SHEET, answering(A_WAKE.position, "digest")).withExcluded.agree, 100, "control: a changed row moves the agreement");
});

test("ONE wake predicted digest is exactly one missed wake, in that row's class, and that class's bar reads fail", () => {
  const before = scoreTriage(SHEET, asPredictions());
  assert.equal(classOf(before, "answer-owed").bar.passed, true, "positive control: the class passes when nothing is missed");
  const after = scoreTriage(SHEET, answering(A_WAKE.position, "digest"));
  assert.deepEqual(after.withExcluded.missedWakes, [A_WAKE.position]);
  assert.deepEqual(classOf(after, "answer-owed").missedWakes, [A_WAKE.position]);
  assert.deepEqual(classOf(after, "answer-owed").bar, { passed: false, verdict: "fail: missed a wake" });
  assert.deepEqual(after.classes.filter((one) => one.missedWakes.length > 0).map((one) => one.cause), ["answer-owed"], "no other class is touched");
  assert.deepEqual(after.classes.filter((one) => one.cause !== "answer-owed").map((one) => one.bar), before.classes.filter((one) => one.cause !== "answer-owed").map((one) => one.bar));
  assert.deepEqual(scoreTriage(SHEET, answering(A_WAKE.position, "drop")).withExcluded.missedWakes, [A_WAKE.position], "a wake predicted drop is missed too");
  assert.equal(after.withExcluded.confusion.wake.digest, 1);
});

test("an OVER-wake is not a miss: a digest row predicted wake changes the agreement and no bar", () => {
  const digest = SHEET.find((row) => row.label === "digest" && row.cause === "org-health");
  const score = scoreTriage(SHEET, answering(digest.position, "wake"));
  assert.equal(score.withExcluded.missedWakes.length, 0);
  assert.equal(score.withExcluded.agree, 99);
  assert.deepEqual(score.classes.map((one) => one.bar), scoreTriage(SHEET, asPredictions()).classes.map((one) => one.bar));
});

test("the bar: five readable rows and no miss; a class under five fails and says why; no wake row is a pass that says it is untested", () => {
  const score = scoreTriage(SHEET, asPredictions());
  assert.equal(BAR.minRows, 5);
  const readable = (cause: string) => SHEET.filter((row) => row.cause === cause && !row.excluded).length;
  assert.deepEqual([readable("pr-codeowner-review-missing"), readable("row-call-count-signal")], [5, 4], "the two sides of the boundary exist in the fixture");
  assert.equal(classOf(score, "row-call-count-signal").bar.verdict, "fail: fewer than 5 readable rows");
  assert.match(classOf(score, "pr-codeowner-review-missing").bar.verdict, /^candidate \(no wake row in the class/);
  assert.equal(classOf(score, "answer-owed").bar.verdict, "candidate");
  assert.equal(classOf(score, "org-health").wakeRows, 3);
  assert.deepEqual(score.classes.filter((one) => one.bar.passed).map((one) => one.cause).sort(), ["answer-owed", "org-health", "pr-checks-failing", "pr-codeowner-review-missing"]);
  assert.equal(classOf(score, "(no cause)"), undefined, "the unreadable rows are in no class");
});

test("a prediction file that is partial, duplicated, outside the sheet or off the labels is REFUSED, not scored", () => {
  assert.equal(scoreTriage(SHEET, asPredictions()).withExcluded.n, 100, "positive control: the same rows, whole, score");
  assert.throws(() => scoreTriage(SHEET, asPredictions().slice(1)), /99 predictions for 100 rows/);
  const duplicated = asPredictions();
  duplicated[99] = { ...duplicated[0] };
  assert.throws(() => scoreTriage(SHEET, duplicated), /position 1 is predicted twice/, "100 rows with a duplicate, so one position is missing");
  assert.throws(() => scoreTriage(SHEET, answering(7, "maybe")), /position 7: label "maybe" is not one of wake \| digest \| drop/);
  assert.throws(() => scoreTriage(SHEET, answering(7, undefined)), /position 7/);
  assert.throws(() => scoreTriage(SHEET, [...asPredictions().slice(1), { position: 101, label: "wake" }]), /position 101 is not a row/);
  assert.throws(() => scoreTriage(SHEET, { rows: [] }), /must be a JSON array/);
  assert.throws(() => scoreTriage(SHEET, [...asPredictions().slice(1), null]), /position undefined is not a row/);
});

test("the figures with and without the unreadable rows differ by exactly those rows", () => {
  const score = scoreTriage(SHEET, answering(UNREADABLE[0], "digest"));
  assert.equal(score.withExcluded.n - score.withoutExcluded.n, UNREADABLE.length);
  assert.equal(score.withExcluded.agree - score.withoutExcluded.agree, UNREADABLE.length - 1, "five of the six agree");
  assert.equal(score.withExcluded.confusion.wake.wake - score.withoutExcluded.confusion.wake.wake, UNREADABLE.length - 1);
  assert.equal(score.withExcluded.confusion.wake.digest - score.withoutExcluded.confusion.wake.digest, 1);
  assert.deepEqual([score.withExcluded.missedWakes, score.withoutExcluded.missedWakes], [[UNREADABLE[0]], []], "a miss among the unreadable rows counts only WITH them");
  assert.deepEqual(score.excluded.positions, UNREADABLE);
  assert.deepEqual(score.excluded.predicted[0], { position: UNREADABLE[0], label: "wake", predicted: "digest" });
  assert.ok(score.classes.every((one) => one.missedWakes.length === 0), "and in no class's bar");
  const printed = renderScore(score);
  assert.match(printed, /WITH the six unreadable rows: n 100/);
  assert.match(printed, /WITHOUT them .*: n 94/);
});

test("the model is shown the three definitions and the five printed columns, and nothing else", () => {
  const prompt = renderPrompt({ definitions: DEFINITIONS, rows: SHEET });
  const lines = prompt.split("\n\n")[1].trimEnd().split("\n");
  assert.equal(lines.length, 100);
  assert.deepEqual(lines, SHEET.map((row) => `${String(row.position).padStart(3)}.  ${row.session}  ${row.cause}  ${row.causeKey}  cost ${row.cost}`));
  for (const label of ["wake", "digest", "drop"]) assert.ok(prompt.includes(`- ${label}: ${DEFINITIONS[label]}`), `definition of ${label}`);
  assert.doesNotMatch(prompt, /excluded|unreadable|6062884|#4074|stratified/, "no label, no exclusion mark, no provenance");
  assert.ok(renderPrompt({ definitions: DEFINITIONS, rows: SHEET.map((row) => ({ ...row, causeKey: `${row.causeKey} CHANGED` })) }).includes("CHANGED"), "control: the lines are built from the rows given");
});

test("--score reads the frozen labels and the predictions file, and never the store or the sampler", () => {
  const dir = mkdtempSync(join(tmpdir(), "triage-score-"));
  made.push(dir);
  const [store, good, bad] = ["events.ndjson", "good.json", "bad.json"].map((name) => join(dir, name));
  writeFileSync(store, "this is not json\n");
  writeFileSync(good, JSON.stringify(answering(A_WAKE.position, "digest")));
  writeFileSync(bad, JSON.stringify(asPredictions().slice(1)));
  const script = join(dirname(fileURLToPath(import.meta.url)), "triage-sample.mjs");
  const run = (...args: string[]) => spawnSync(process.execPath, [...TSX_IMPORT, script, ...args], { encoding: "utf8" });
  const sampler = run("--seed", "4074", "--store", store);
  assert.equal(sampler.status, 1, "positive control: the sampler DOES read this store, and it cannot");
  assert.match(sampler.stderr, /JSON/);
  const scored = run("--score", good, "--store", store);
  assert.equal(scored.status, 0, scored.stderr);
  assert.match(scored.stdout, /WITHOUT them .*missed wakes 1 \(positions /);
  assert.equal(JSON.parse(run("--score", good, "--json").stdout).withoutExcluded.missedWakes.length, 1);
  const refused = run("--score", bad);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /99 predictions for 100 rows/);
  assert.equal(refused.stdout, "", "a refused file prints no score");
  assert.equal(run("--score").status, 1, "--score without a file is refused");
  assert.equal(run("--prompt").stdout, renderPrompt(loadLabels()));
  assert.equal(readFileSync(new URL("./triage-labels-4074.json", import.meta.url), "utf8").includes('"label":"wake"'), true);
});
