// agent-org#688: the routing provider's accuracy over a FIXTURE decision log and fixture merges. No network, no live log, no `gh`: the lines are written here, in the shape `decision-provider.ts` writes them,
// and the merged diffs are handed in (`mergesOf` is run against a fake `git`).
// no-token: none -- reads lines this file builds and, for the CLI, one temporary file; nothing here reaches `gh`, `herdr` or `git`
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  criteriaOf, formatRouteAccuracy, MECHANICAL_MAX_FILES, MECHANICAL_MAX_LINES, mergesOf, MIN_SAMPLE, rowOfMergeSubject, routeAccuracy, routingDecisionsIn, truthMechanical, truthScore,
  type AccuracyReading, type Criteria, type MergedDiff, type RoutingDecision,
} from "./route-accuracy.ts";
import { tmpDirForFile } from "./lib/tmp-fixture.ts";

// The CLI as a process: by absolute path, because the suite is run from the project's root and not from this package.
const CLI = fileURLToPath(new URL("./route-accuracy.ts", import.meta.url));

// The criteria's own examples, as sizes: level 1 first (the numbers `SCORE_LEVEL_DATA` carries, "2 files, +3 -3" being 2 files and 6 lines).
const CRITERIA: Criteria = {
  scoreExamples: [
    [{ files: 2, lines: 6 }, { files: 2, lines: 18 }],
    [{ files: 2, lines: 22 }, { files: 8, lines: 47 }],
    [{ files: 2, lines: 478 }, { files: 2, lines: 187 }],
    [{ files: 3, lines: 496 }, { files: 5, lines: 754 }],
    [{ files: 11, lines: 435 }, { files: 473, lines: 15624 }],
  ],
  exampleRows: new Set([4522, 4748]),
};
/** A diff each level's examples bracket. */
const DIFF_OF_LEVEL: Record<number, MergedDiff> = {
  1: { files: 1, lines: 4, merges: 1 }, 2: { files: 4, lines: 30, merges: 1 }, 3: { files: 2, lines: 300, merges: 1 },
  4: { files: 4, lines: 600, merges: 1 }, 5: { files: 40, lines: 2000, merges: 1 },
};

const NOW = Date.parse("2026-10-10T08:00:00Z");
const decisionOf = (row: number, answers: RoutingDecision["answers"], at = NOW): RoutingDecision => ({ row, at, answers });
const score = (value: number, confidence: number) => ({ score: { value, confidence } });
const mechanical = (value: "yes" | "no", confidence: number) => ({ mechanical: { value, confidence } });
const mergesOfRows = (entries: [number, MergedDiff][]): Map<number, MergedDiff> => new Map(entries);
const bucketNamed = (reading: AccuracyReading, question: "score" | "mechanical", label: string) => {
  const found = reading.questions.find((q) => q.question === question)?.buckets.find((b) => b.label === label);
  assert.ok(found, `no bucket ${label} for ${question}`);
  return found;
};

/** `count` rows from `first`, each merged as a level-3 diff, whose decisions answer `values[i % values.length]` at `confidence`. */
function level3Rows(first: number, count: number, values: number[], confidence: number): { decisions: RoutingDecision[]; merges: [number, MergedDiff][] } {
  const rows = Array.from({ length: count }, (_unused, i) => first + i);
  return { decisions: rows.map((row, i) => decisionOf(row, score(values[i % values.length], confidence))), merges: rows.map((row) => [row, DIFF_OF_LEVEL[3]]) };
}

test("agreement is computed per confidence bucket, and an answer on an edge falls in the bucket above it", () => {
  const top = level3Rows(1000, 10, [3, 3, 3, 3, 3, 3, 3, 3, 4, 4], 0.9);
  const bottom = level3Rows(2000, 10, [3, 5, 5], 0.2);
  const reading = routeAccuracy([...top.decisions, ...bottom.decisions], mergesOfRows([...top.merges, ...bottom.merges]), CRITERIA);
  const high = bucketNamed(reading, "score", "0.7 and over");
  assert.deepEqual([high.n, high.agreed, high.near, high.rate, high.nearRate], [10, 8, 10, 0.8, 1]);
  const low = bucketNamed(reading, "score", "under 0.4");
  // 4 of the 10 are a 3 (i % 3 === 0), the other 6 a 5: two levels from the truth, so not even near
  assert.deepEqual([low.n, low.agreed, low.near, low.rate, low.nearRate], [10, 4, 4, 0.4, 0.4]);
  // NEGATIVE CONTROL: the buckets are not one pool. A reading that pooled them would give both the same rate.
  assert.notEqual(high.rate, low.rate);
  const edges = routeAccuracy(
    [0.399, 0.4, 0.549, 0.55, 0.699, 0.7].map((confidence, i) => decisionOf(3000 + i, score(3, confidence))),
    mergesOfRows([3000, 3001, 3002, 3003, 3004, 3005].map((row) => [row, DIFF_OF_LEVEL[3]])), CRITERIA,
  );
  assert.deepEqual(edges.questions[0].buckets.map((b) => b.n), [1, 2, 2, 1]);
});

test("the floor split pools the buckets under 0.7 against 0.7 and over", () => {
  const under = level3Rows(1000, 12, [3, 5, 5], 0.5);
  const over = level3Rows(2000, 10, [3], 0.8);
  const { underFloor, atOrOver } = routeAccuracy([...under.decisions, ...over.decisions], mergesOfRows([...under.merges, ...over.merges]), CRITERIA).questions[0];
  assert.deepEqual([underFloor.n, underFloor.agreed, atOrOver.n, atOrOver.agreed], [12, 4, 10, 10]);
  assert.ok((underFloor.rate ?? 1) < (atOrOver.rate ?? 0));
});

test("the answer scored is the one the provider GAVE, not the fallback that replaced it", () => {
  const lines = Array.from({ length: 10 }, (_unused, i) => JSON.stringify({
    use: "model-routing", id: `row-${1000 + i}`, via: "jev", at: NOW, answers: {
      score: { value: 5, confidence: 0.5, fellBack: true, asked: 3, reason: "3 at 0.5, under the floor 0.7" },
      mechanical: { value: "no", confidence: 0.3, fellBack: true, asked: "yes", reason: "yes at 0.3, under the floor 0.7" },
    },
  }));
  const { decisions } = routingDecisionsIn(lines);
  const merges = mergesOfRows(decisions.map(({ row }): [number, MergedDiff] => [row, { files: 2, lines: 300, merges: 1 }]));
  const reading = routeAccuracy(decisions, merges, CRITERIA);
  // asked 3 at a level-3 diff: right. The fallback, 5, would have been wrong on every one.
  assert.equal(bucketNamed(reading, "score", "0.4 to 0.55").agreed, 10);
  // asked `yes` at a 300-line diff: wrong. The fallback, `no`, would have been right on every one.
  assert.equal(bucketNamed(reading, "mechanical", "under 0.4").agreed, 0);
});

test("an answer with no confidence (a 422, a refusal) is not the provider's and is neither scored nor bucketed", () => {
  const lines = [
    { use: "model-routing", id: "row-1", via: "jev", at: NOW, answers: { score: { value: 5, fellBack: true, reason: "the API answered HTTP 422" }, mechanical: { value: "yes", confidence: 0.9, fellBack: false } } },
  ];
  const { decisions } = routingDecisionsIn(lines);
  assert.deepEqual(decisions[0].answers, { mechanical: { value: "yes", confidence: 0.9 } });
  const reading = routeAccuracy(decisions, mergesOfRows([[1, DIFF_OF_LEVEL[1]]]), CRITERIA);
  assert.deepEqual(reading.questions[0].noAnswer, [1]);
  assert.equal(reading.questions[0].buckets.reduce((n, b) => n + b.n, 0), 0);
  assert.equal(reading.questions[1].noAnswer.length, 0);
});

test("a repeated ask counts once, by its latest decision, with its ask count printed beside it", () => {
  const { merges } = level3Rows(1000, 1, [3], 0.9);
  const repeated = [decisionOf(1000, score(5, 0.9), NOW - 2000), decisionOf(1000, score(1, 0.9), NOW - 1000), decisionOf(1000, score(3, 0.9), NOW)];
  const reading = routeAccuracy(repeated, mergesOfRows(merges), CRITERIA);
  assert.equal(reading.decisions, 3);
  assert.equal(reading.rows, 1);
  assert.equal(bucketNamed(reading, "score", "0.7 and over").n, 1);
  assert.equal(bucketNamed(reading, "score", "0.7 and over").agreed, 1);
  assert.deepEqual(reading.repeated, [{ row: 1000, asks: 3 }]);
  assert.match(formatRouteAccuracy(reading), /row-1000 \(asked 3 times\)/);
  // NEGATIVE CONTROL: the same three decisions in another time order settle on another answer, so it is the LATEST that is read and not the first or the last line of the file.
  const reordered = [decisionOf(1000, score(3, 0.9), NOW - 2000), decisionOf(1000, score(1, 0.9), NOW - 1000), decisionOf(1000, score(5, 0.9), NOW)];
  assert.equal(bucketNamed(routeAccuracy(reordered, mergesOfRows(merges), CRITERIA), "score", "0.7 and over").agreed, 0);
  assert.equal(bucketNamed(routeAccuracy([...repeated].reverse(), mergesOfRows(merges), CRITERIA), "score", "0.7 and over").agreed, 1);
});

test("a row named as an example in the criteria is excluded and counted, and the same row is scored when it is not named", () => {
  const decisions = [decisionOf(4748, score(3, 0.9)), decisionOf(4748, score(3, 0.9), NOW - 1), decisionOf(1000, score(3, 0.9))];
  const merges = mergesOfRows([[4748, DIFF_OF_LEVEL[3]], [1000, DIFF_OF_LEVEL[3]]]);
  const reading = routeAccuracy(decisions, merges, CRITERIA);
  assert.deepEqual(reading.heldOut, [{ row: 4748, asks: 2 }]);
  assert.equal(reading.measured, 1);
  assert.equal(bucketNamed(reading, "score", "0.7 and over").n, 1);
  assert.match(formatRouteAccuracy(reading), /Held out, named as an example in the criteria \(1\): row-4748 \(asked 2 times\)/);
  // NEGATIVE CONTROL: with no example named, the same row is scored and nothing is held out.
  const unheld = routeAccuracy(decisions, merges, { ...CRITERIA, exampleRows: new Set() });
  assert.deepEqual(unheld.heldOut, []);
  assert.equal(bucketNamed(unheld, "score", "0.7 and over").n, 2);
  // an example with NO merge is still held out and not reported as unmerged
  const noMerge = routeAccuracy([decisionOf(4748, score(3, 0.9))], new Map(), CRITERIA);
  assert.deepEqual([noMerge.heldOut.length, noMerge.unjoined.length], [1, 0]);
});

test("a bucket under the minimum sample prints `n=<k>, not a rate`, and one at the minimum prints a rate", () => {
  const few = level3Rows(1000, MIN_SAMPLE - 1, [3], 0.9);
  const reading = routeAccuracy(few.decisions, mergesOfRows(few.merges), CRITERIA);
  const bucket = bucketNamed(reading, "score", "0.7 and over");
  assert.equal(bucket.n, MIN_SAMPLE - 1);
  assert.equal(bucket.rate, undefined);
  assert.match(formatRouteAccuracy(reading), new RegExp(`0\\.7 and over\\s+n=${MIN_SAMPLE - 1}, not a rate`));
  // NEGATIVE CONTROL: one more decision and the same bucket is a rate.
  const enough = level3Rows(1000, MIN_SAMPLE, [3], 0.9);
  const rated = routeAccuracy(enough.decisions, mergesOfRows(enough.merges), CRITERIA);
  assert.equal(bucketNamed(rated, "score", "0.7 and over").rate, 1);
  assert.match(formatRouteAccuracy(rated), new RegExp(`0\\.7 and over\\s+100% of ${MIN_SAMPLE}`));
  assert.doesNotMatch(formatRouteAccuracy(rated).split("\n").filter((line) => /0\.7 and over/.test(line))[0], /not a rate/);
});

test("a decision with no merged pull request is counted and named, not dropped", () => {
  const decisions = [decisionOf(1000, score(3, 0.9)), decisionOf(1001, score(3, 0.9)), decisionOf(1001, score(3, 0.9), NOW - 1)];
  const reading = routeAccuracy(decisions, mergesOfRows([[1000, DIFF_OF_LEVEL[3]]]), CRITERIA);
  assert.deepEqual(reading.unjoined, [{ row: 1001, asks: 2 }]);
  assert.equal(reading.measured, 1);
  assert.match(formatRouteAccuracy(reading), /No merged pull request found \(1\): row-1001 \(asked 2 times\)/);
  // NEGATIVE CONTROL: with the merge present the row is measured and nothing is named.
  const joined = routeAccuracy(decisions, mergesOfRows([[1000, DIFF_OF_LEVEL[3]], [1001, DIFF_OF_LEVEL[3]]]), CRITERIA);
  assert.deepEqual(joined.unjoined, []);
  assert.equal(joined.measured, 2);
  assert.doesNotMatch(formatRouteAccuracy(joined), /No merged pull request/);
});

test("subsystems and debugging are printed NOT MEASURED, and no number is given for them", () => {
  const text = formatRouteAccuracy(routeAccuracy([decisionOf(1000, score(3, 0.9))], mergesOfRows([[1000, DIFF_OF_LEVEL[3]]]), CRITERIA));
  assert.match(text, /^subsystems: NOT MEASURED/m);
  assert.match(text, /^debugging: NOT MEASURED/m);
  assert.deepEqual(routeAccuracy([], new Map(), CRITERIA).questions.map((q) => q.question), ["score", "mechanical"]);
});

test("the score a diff earns is the level of the nearest example, the lower level on a tie, and a diff past the largest example is that example's level", () => {
  for (const [level, diff] of Object.entries(DIFF_OF_LEVEL)) assert.equal(truthScore(diff, CRITERIA), Number(level), `level ${level}`);
  assert.equal(truthScore({ files: 1, lines: 2 }, CRITERIA), 1);
  assert.equal(truthScore({ files: 900, lines: 40000 }, CRITERIA), 5);
  assert.equal(truthScore({ files: 2, lines: 6 }, { scoreExamples: [[{ files: 2, lines: 6 }], [{ files: 2, lines: 6 }]] }), 1);
  assert.equal(truthScore({ files: 2, lines: 6 }, { scoreExamples: [] }), undefined);
});

test("mechanical is true of a diff at most MECHANICAL_MAX_FILES files and MECHANICAL_MAX_LINES lines, and of nothing past either", () => {
  assert.equal(truthMechanical({ files: MECHANICAL_MAX_FILES, lines: MECHANICAL_MAX_LINES }), true);
  assert.equal(truthMechanical({ files: MECHANICAL_MAX_FILES + 1, lines: 2 }), false);
  assert.equal(truthMechanical({ files: 1, lines: MECHANICAL_MAX_LINES + 1 }), false);
  const rows = Array.from({ length: 10 }, (_unused, i) => 1000 + i);
  const reading = routeAccuracy(rows.map((row) => decisionOf(row, mechanical("yes", 0.9))), mergesOfRows(rows.map((row) => [row, { files: 1, lines: 2, merges: 1 }])), CRITERIA);
  assert.equal(bucketNamed(reading, "mechanical", "0.7 and over").rate, 1);
  // NEGATIVE CONTROL: the same `yes` answers over a 400-line diff are all wrong.
  const large = routeAccuracy(rows.map((row) => decisionOf(row, mechanical("yes", 0.9))), mergesOfRows(rows.map((row) => [row, { files: 2, lines: 400, merges: 1 }])), CRITERIA);
  assert.equal(bucketNamed(large, "mechanical", "0.7 and over").rate, 0);
});

test("the log is read as routing decisions: only a `via jev` request on a row, with an unreadable line counted", () => {
  const request = { use: "model-routing", id: "row-4785", via: "jev", at: 5, answers: { score: { value: 3, confidence: 0.8, fellBack: false } } };
  const { decisions, unreadable } = routingDecisionsIn([
    JSON.stringify(request),
    JSON.stringify({ ...request, via: "none" }),
    JSON.stringify({ ...request, use: "wake-triage" }),
    JSON.stringify({ use: "model-routing", id: "row-4785", outcome: "route sonnet/high via jev", at: 6 }),
    JSON.stringify({ ...request, id: "not-a-row" }),
    "{not json",
    "",
  ]);
  assert.deepEqual(decisions, [{ row: 4785, at: 5, answers: { score: { value: 3, confidence: 0.8 } } }]);
  assert.equal(unreadable, 2);
  assert.match(formatRouteAccuracy(routeAccuracy(decisions, new Map(), CRITERIA, unreadable)), /2 log lines could not be read and are not in this reading/);
});

test("the provider absent is an empty reading that says so, quietly", () => {
  assert.equal(formatRouteAccuracy(routeAccuracy([], new Map(), CRITERIA)), "no provider decisions in the log");
});

test("the criteria's view: sizes from the merged text, rows from every question's examples, and an example with no diff has no size but is still named", () => {
  const level = (...examples: { row: string; merged: string }[]) => ({ examples });
  const view = criteriaOf({
    score: [level({ row: "a11ign#4522", merged: "2 files, +3 -3" }), level({ row: "a11ign#4389", merged: "473 files, +6132 -9492" }), level({ row: "agent-org#564", merged: "1 file, +1 -0" })],
    others: [level({ row: "a11ign#3228", merged: "no diff of its own: the cause was read on the box" })],
  });
  assert.deepEqual(view.scoreExamples, [[{ files: 2, lines: 6 }], [{ files: 473, lines: 15624 }], [{ files: 1, lines: 1 }]]);
  assert.deepEqual([...view.exampleRows].sort((a, b) => a - b), [3228, 4389, 4522]);
});

test("a merge is joined to a row by its branch's tail, and a tail naming another tracker is not a11ign's row", () => {
  assert.equal(rowOfMergeSubject("Merge pull request #595 from a11ign/agent/a-daily-confidence-reading-4748"), 4748);
  assert.equal(rowOfMergeSubject("Merge pull request #688 from a11ign/agent/the-routing-provider-s-agent-org-688"), undefined);
  assert.equal(rowOfMergeSubject("Merge pull request #1 from a11ign/agent/no-row-number"), undefined);
  assert.equal(rowOfMergeSubject("provider-confidence: a window (agent-org#595)"), undefined);
});

test("mergesOf reads `git diff --numstat <merge>^1 <merge>` less .acceptance/ and .changeset/, unions a row's files and sums its lines across merges", () => {
  const calls: string[][] = [];
  const log = [
    "aaa\tMerge pull request #2 from a11ign/agent/follow-up-4785",
    "bbb\tMerge pull request #1 from a11ign/agent/the-first-4785",
    "ccc\tMerge pull request #3 from a11ign/agent/other-4999",
    "ddd\tMerge pull request #4 from a11ign/agent/for-agent-org-4785",
  ].join("\n");
  const stats: Record<string, string> = {
    "bbb^1": "10\t2\tsrc/a.ts\n30\t0\tsrc/a.test.ts\n5\t0\t.acceptance/agent~x.md\n3\t0\t.changeset/x.md\n",
    "aaa^1": "1\t1\tsrc/a.ts\n-\t-\tdocs/logo.png\n",
  };
  const run = (repo: string, args: string[]): string => {
    calls.push([repo, ...args]);
    if (args[0] === "log") return log;
    return stats[args[2]] ?? "";
  };
  const wanted = mergesOf(new Set([4785]), ["/r/one"], { run });
  assert.deepEqual(wanted.get(4785), { files: 3, lines: 44, merges: 2 });
  assert.equal(wanted.has(4999), false);
  assert.deepEqual(calls.filter((call) => call[1] === "diff").map((call) => call[3]), ["aaa^1", "bbb^1"]);
  // the same path in two repositories is two files
  assert.equal(mergesOf(new Set([4785]), ["/r/one", "/r/two"], { run }).get(4785)?.files, 6);
});

test("the CLI with no provider decisions says so, and a log it cannot read is not that", () => {
  const dir = tmpDirForFile("route-accuracy-");
  const empty = join(dir, "empty-decisions");
  writeFileSync(empty, "");
  const ran = spawnSync(process.execPath, [CLI, `--log=${empty}`], { encoding: "utf8", env: { ...process.env, AGENT_ORG_HOST: "" } });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout.trim(), "no provider decisions in the log");
  const unreadable = spawnSync(process.execPath, [CLI, `--log=${dir}`], { encoding: "utf8" });
  assert.equal(unreadable.status, 2);
  assert.match(unreadable.stderr, /CANNOT READ: the decision log could not be read/);
});

// The real criteria need the host's checkout to be imported, so this one runs where AGENT_ORG_HOST is set and says so where it is not.
test("the real criteria give five levels of two examples each, and the held-out rows the row names", { skip: process.env.AGENT_ORG_HOST ? false : "AGENT_ORG_HOST is unset: engineer-route.ts cannot be imported" }, async () => {
  const route = await import("./engineer-route.ts");
  const view = criteriaOf({ score: route.SCORE_LEVEL_DATA, others: [route.MECHANICAL_DATA.yes, route.MECHANICAL_DATA.no, route.SUBSYSTEMS_DATA.yes, route.SUBSYSTEMS_DATA.no, route.DEBUGGING_DATA.yes, route.DEBUGGING_DATA.no] });
  assert.equal(view.scoreExamples.length, 5);
  assert.ok(view.scoreExamples.every((examples) => examples.length === 2));
  for (const row of [4522, 4748, 4629, 4389, 3228]) assert.ok(view.exampleRows.has(row), `row ${row} is an example`);
  assert.deepEqual(view.scoreExamples[2], [{ files: 2, lines: 478 }, { files: 2, lines: 187 }]);
});
