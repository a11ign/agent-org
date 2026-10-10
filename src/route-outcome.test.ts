// #4627 use 4: what came of a routed row, written when it closes. A temp directory and injected dependencies only: no network, no key, no `gh`.
// EVERY CLAIM HAS ITS NEGATIVE CONTROL: the line that is written beside the row for which nothing is, and the second close-out beside the first.
// The routed rows are routed by the REAL `routeEngineer`, so the route line this module looks for is the one production writes, not a copy of its format.
// no-token: gh -- nothing here calls `gh`; every dependency is injected
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decisionSwitchesPath, recordOutcome } from "./decision-provider.ts";
import { routeEngineer, windowReadings, type RouteRow } from "./engineer-route.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";
import { recordClosedRow, ROUTE_OUTCOMES, routeOutcomeOf, rowLockPath, type RouteOutcome, type RouteOutcomeFacts } from "./route-outcome.ts";
import { EFFORT_UNKNOWN, summarise } from "./trace/haiku-tier-report.ts";

const BODY = "## Region\n\n```\nsrc/a.ts\nsrc/a.test.ts\n```\n\n## Acceptance\n\n```bash\npnpm test\n```\n\n## Done-when\n\n1. The Acceptance passes.\n";
const rowOf = (number: number): RouteRow => ({ number, title: "Rename a helper", labels: ["ready"], body: BODY });
const ON = { "model-routing": true } as const;
const MERGED_CLEAN: RouteOutcomeFacts = { mergedPr: true, rejectedReviews: 0, escalated: false, compactions: 0 };

/** A host with a decision log and the routes of `routed` rows already in it, written by the production router with no provider declared (a fallback route line). */
async function rig(routed: readonly number[] = []) {
  const dir = tmpDir("route-outcome-");
  const logPath = join(dir, "decisions");
  const said: string[] = [];
  const deps = { logPath, switches: ON, now: () => 1_000, diagnostic: (line: string) => { said.push(line); } };
  for (const number of routed) await routeEngineer(rowOf(number), { host: {}, ...deps });
  const text = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : null);
  const lines = () => (text() ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { use: string; id?: string; outcome?: string });
  const outcomesOf = (row: number) => lines().filter((l) => l.id === `row-${row}` && (ROUTE_OUTCOMES as readonly unknown[]).includes(l.outcome)).map((l) => l.outcome);
  return { dir, logPath, deps, said, text, lines, outcomesOf };
}

// --- the vocabulary, from facts ---

test("routeOutcomeOf: each string of the vocabulary comes from its facts, and one fact away is the neighbouring string", () => {
  const cases: [string, RouteOutcomeFacts, RouteOutcome][] = [
    ["merged, no rejection", MERGED_CLEAN, "merged-first-pass"],
    ["merged after one rejection", { ...MERGED_CLEAN, rejectedReviews: 1 }, "not-first-pass"],
    ["merged after three", { ...MERGED_CLEAN, rejectedReviews: 3 }, "not-first-pass"],
    ["not merged", { ...MERGED_CLEAN, mergedPr: false }, "closed-without-merge"],
    ["not merged, with a rejection on the way", { ...MERGED_CLEAN, mergedPr: false, rejectedReviews: 2 }, "closed-without-merge"],
    ["escalated, merged clean", { ...MERGED_CLEAN, escalated: true }, "escalated"],
    ["escalated, not merged", { ...MERGED_CLEAN, escalated: true, mergedPr: false }, "escalated"],
    ["compactions alone decide nothing", { ...MERGED_CLEAN, compactions: 12 }, "merged-first-pass"],
  ];
  for (const [name, facts, expected] of cases) assert.equal(routeOutcomeOf(facts), expected, name);
  assert.deepEqual([...new Set(cases.map(([, , outcome]) => outcome))].sort(), [...ROUTE_OUTCOMES].sort(), "the cases reach every string of the vocabulary, and no other");
});

test("routeOutcomeOf: first pass is the report's own definition, so a row is first-pass exactly when `summarise` says its rate is 1", () => {
  for (const rejections of [0, 1, 2]) {
    const rate = summarise([{ number: 1, haiku: false, merged: true, rejections, compactions: 0, oversize: 0, turns: 0, costUsd: 0, unpriced: 0, effort: EFFORT_UNKNOWN }]).firstPassRate;
    assert.equal(routeOutcomeOf({ ...MERGED_CLEAN, rejectedReviews: rejections }) === "merged-first-pass", rate === 1, `rejections ${rejections}`);
  }
});

test("routeOutcomeOf: a count that is not a count is refused, never read as no rejections", () => {
  for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(() => routeOutcomeOf({ ...MERGED_CLEAN, rejectedReviews: bad }), RangeError, `rejectedReviews ${bad}`);
    assert.throws(() => routeOutcomeOf({ ...MERGED_CLEAN, compactions: bad }), RangeError, `compactions ${bad}`);
  }
  assert.equal(routeOutcomeOf({ ...MERGED_CLEAN, rejectedReviews: 0 }), "merged-first-pass", "the control: zero is a count");
});

// --- the write ---

test("recordClosedRow: a routed row gets its outcome, once, and the window report reads it as the row's outcome", async () => {
  const r = await rig([4999]);
  const before = r.lines().length;
  assert.equal(recordClosedRow(4999, MERGED_CLEAN, r.deps), "merged-first-pass");
  assert.deepEqual(r.lines().slice(before), [{ use: "model-routing", id: "row-4999", outcome: "merged-first-pass", at: 1_000 }]);
  const reading = windowReadings(r.lines()).find((found) => found.row === 4999);
  assert.equal(reading?.outcome, "merged-first-pass", "the line the report counts, which is what the floor is tuned from");
});

test("recordClosedRow: each outcome string is the one written, not only the first", async () => {
  const r = await rig([11, 12, 13, 14]);
  const facts: [number, RouteOutcomeFacts, RouteOutcome][] = [
    [11, MERGED_CLEAN, "merged-first-pass"], [12, { ...MERGED_CLEAN, rejectedReviews: 1 }, "not-first-pass"],
    [13, { ...MERGED_CLEAN, escalated: true }, "escalated"], [14, { ...MERGED_CLEAN, mergedPr: false }, "closed-without-merge"]];
  for (const [row, given, expected] of facts) {
    assert.equal(recordClosedRow(row, given, r.deps), expected);
    assert.deepEqual(r.outcomesOf(row), [expected]);
  }
});

test("recordClosedRow: a row with no route line writes nothing, and the log is byte-identical (control: the routed row beside it does write)", async () => {
  const r = await rig([4999]);
  const before = r.text();
  assert.equal(recordClosedRow(5000, MERGED_CLEAN, r.deps), null, "row 5000 was never routed");
  assert.equal(r.text(), before);
  assert.equal(recordClosedRow(4999, MERGED_CLEAN, r.deps), "merged-first-pass", "the control: a routed row, same facts, same log, same call");
  assert.notEqual(r.text(), before);
});

test("recordClosedRow: another row's route line is not this row's decision (control: row 49 is not row 4999)", async () => {
  const r = await rig([4999]);
  const before = r.text();
  assert.equal(recordClosedRow(49, MERGED_CLEAN, r.deps), null);
  assert.equal(recordClosedRow(499, MERGED_CLEAN, r.deps), null);
  assert.equal(r.text(), before);
});

test("recordClosedRow: a second close-out of the row writes nothing (control: the first did, and so does another row's first)", async () => {
  const r = await rig([21, 22]);
  assert.equal(recordClosedRow(21, MERGED_CLEAN, r.deps), "merged-first-pass");
  const afterFirst = r.text();
  assert.equal(recordClosedRow(21, { ...MERGED_CLEAN, rejectedReviews: 2 }, r.deps), null, "even with different facts: the first reading stands");
  assert.equal(r.text(), afterFirst);
  assert.deepEqual(r.outcomesOf(21), ["merged-first-pass"]);
  assert.equal(recordClosedRow(22, MERGED_CLEAN, r.deps), "merged-first-pass", "once is per row");
  assert.deepEqual(r.outcomesOf(22), ["merged-first-pass"]);
});

test("recordClosedRow: with the provider absent the log is left as it is, and a host with no log is not given one", async () => {
  // No log at all: the file is not created, which `recordRouteOutcome` alone would do.
  const none = await rig();
  assert.equal(recordClosedRow(4999, MERGED_CLEAN, none.deps), null);
  assert.equal(existsSync(none.logPath), false);
  assert.deepEqual(none.said, [], "an absent log is quiet: it is not a fault");
  // No log path at all (a caller that was given none).
  assert.equal(recordClosedRow(4999, MERGED_CLEAN, { ...none.deps, logPath: undefined }), null);
  // A log that holds other decisions and not this row's.
  const other = await rig();
  mkdirSync(other.dir, { recursive: true });
  recordOutcome("wake-triage", "ready-row-unclaimed/4999", "followed", other.deps);
  const before = other.text();
  assert.equal(recordClosedRow(4999, MERGED_CLEAN, other.deps), null);
  assert.equal(other.text(), before);
  // The control: the same call, once the row is routed.
  await routeEngineer(rowOf(4999), { host: {}, ...other.deps });
  assert.equal(recordClosedRow(4999, MERGED_CLEAN, other.deps), "merged-first-pass");
});

test("recordClosedRow: a host with the use switched off writes nothing, whichever way it is off (control: on writes)", async () => {
  const r = await rig([4999]);
  const before = r.text();
  for (const off of [{}, { "model-routing": false }] as const) assert.equal(recordClosedRow(4999, MERGED_CLEAN, { ...r.deps, switches: off }), null);
  assert.equal(recordClosedRow(4999, MERGED_CLEAN, { ...r.deps, switches: undefined }), null, "switches nobody read are off, as `decide` has them");
  assert.equal(r.text(), before);
  // The same answer when the caller hands the switch FILE: absent is off, a file that says so is on.
  const withFile = { ...r.deps, switches: undefined, switchesPath: decisionSwitchesPath(r.dir) };
  assert.equal(recordClosedRow(4999, MERGED_CLEAN, withFile), null, "no switches file");
  assert.equal(r.text(), before);
  mkdirSync(join(r.dir, ".agent-org"));
  writeFileSync(decisionSwitchesPath(r.dir), '{ "model-routing": true }');
  assert.equal(recordClosedRow(4999, MERGED_CLEAN, withFile), "merged-first-pass", "the control: the same call with the use on");
});

test("recordClosedRow: a half-written tail does not stop the read, and facts nobody read write nothing and say so", async () => {
  const r = await rig([4999, 5001]);
  appendFileSync(r.logPath, '{"use":"model-routing","id":"row-77","outc');
  assert.equal(recordClosedRow(4999, MERGED_CLEAN, r.deps), "merged-first-pass");
  const before = r.text();
  assert.equal(recordClosedRow(5001, { ...MERGED_CLEAN, rejectedReviews: Number.NaN }, r.deps), null);
  assert.equal(r.text(), before);
  assert.equal(r.said.length, 1);
  assert.match(r.said[0], /row 5001 has no outcome written/);
});

// --- two close-outs of one row at the same instant: the report keeps the LAST outcome, so the pair must not both write ---

const REJECTED_TWICE: RouteOutcomeFacts = { ...MERGED_CLEAN, rejectedReviews: 2 };

/** A `read` that runs `rival` at the `nth` read of the log, the way a second process's whole close-out lands between this one's steps. `stale` hands back what the log said BEFORE it. */
function readWithRival(logPath: string, nth: number, rival: () => void, { stale }: { stale: boolean }) {
  let calls = 0;
  return ((path: string, encoding: "utf8") => {
    calls += 1;
    const before = readFileSync(path, encoding);
    if (calls === nth) rival();
    return stale && calls === nth ? before : readFileSync(path, encoding);
  }) as NonNullable<Parameters<typeof recordClosedRow>[2]["read"]>;
}

test("recordClosedRow: a rival close-out that arrives while this one holds the row writes nothing, so the row has one outcome (control: this one's)", async () => {
  const r = await rig([31]);
  let rivalSaid: RouteOutcome | null | undefined;
  // The SECOND read of the log is the one inside the lock, so the rival lands exactly where the check and the append meet.
  const read = readWithRival(r.logPath, 2, () => { rivalSaid = recordClosedRow(31, REJECTED_TWICE, r.deps); }, { stale: false });
  assert.equal(recordClosedRow(31, MERGED_CLEAN, { ...r.deps, read }), "merged-first-pass");
  assert.equal(rivalSaid, null, "the rival found the row held");
  assert.deepEqual(r.outcomesOf(31), ["merged-first-pass"], "one outcome, and it is the holder's: the report is not left to whichever append landed second");
  assert.equal(r.said.filter((line) => line.includes(rowLockPath(r.logPath, 31))).length, 1, "the rival said which lock it found");
  assert.equal(existsSync(rowLockPath(r.logPath, 31)), false, "and the holder let it go");
});

test("recordClosedRow: a rival that landed between the first read and the lock is found by the read inside it (control: without it the row would take two)", async () => {
  const r = await rig([32]);
  let rivalSaid: RouteOutcome | null | undefined;
  // The FIRST read returns what the log said before the rival wrote, so this close-out believes the row is owed.
  const read = readWithRival(r.logPath, 1, () => { rivalSaid = recordClosedRow(32, REJECTED_TWICE, r.deps); }, { stale: true });
  assert.equal(recordClosedRow(32, MERGED_CLEAN, { ...r.deps, read }), null, "the row already had its outcome by the time this one held it");
  assert.equal(rivalSaid, "not-first-pass");
  assert.deepEqual(r.outcomesOf(32), ["not-first-pass"]);
});

test("recordClosedRow: a lock left behind stops that row's outcome loudly and no other row's (control: removed, it writes)", async () => {
  const r = await rig([21, 22]);
  const held = rowLockPath(r.logPath, 21);
  writeFileSync(held, "999\n");
  const before = r.text();
  assert.equal(recordClosedRow(21, MERGED_CLEAN, r.deps), null);
  assert.equal(r.text(), before, "nothing was appended behind a lock");
  assert.equal(r.said.length, 1);
  assert.ok(r.said[0].includes(held), "the diagnostic names the file to remove");
  assert.equal(existsSync(held), true, "and the lock is not this close-out's to remove");
  assert.equal(recordClosedRow(22, MERGED_CLEAN, r.deps), "merged-first-pass", "the lock is the row's, not the log's");
  unlinkSync(held);
  assert.equal(recordClosedRow(21, MERGED_CLEAN, r.deps), "merged-first-pass", "the control: the same call with the lock gone");
});

test("recordClosedRow: no lock is left in the log's directory after a write, and a row owed nothing touches nothing", async () => {
  const r = await rig([41]);
  assert.equal(recordClosedRow(5000, MERGED_CLEAN, r.deps), null, "never routed");
  assert.deepEqual(readdirSync(r.dir), ["decisions"]);
  assert.equal(recordClosedRow(41, MERGED_CLEAN, r.deps), "merged-first-pass");
  assert.deepEqual(readdirSync(r.dir), ["decisions"], "the lock was taken and let go");
  assert.equal(recordClosedRow(41, MERGED_CLEAN, r.deps), null);
  assert.deepEqual(readdirSync(r.dir), ["decisions"]);
});
