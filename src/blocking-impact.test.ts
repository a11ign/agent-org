// no-token: gh -- no `gh` call is made here; the tick is handed its blocked list, a resolver and a scratch directory (a11ign/a11ign#4602)
// #4602 (fix 3 of 4 for the lock-gridlock class, epic #4437): the gate counts rows shelved per holder and minutes. 5 rows for 30 minutes is a ledger incident.
//
// POSITIVE CONTROLS: the boundary is the control. 5 rows at 29 minutes does not fire and at 31 does, 4 rows at 31 does not, and an episode that fired once does not fire on the next
// tick. A counter that never fires fails the 31-minute test; one that fires on a count of 1 or at minute 0 fails the three negatives. The mutations, both directions, are in the pull request.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildReport, renderReport } from "./org-retro.ts";
import { FAILURE_LEDGER_FILE, parseFailureLedger, repeatsIn } from "./failure-ledger.ts";
import {
  advance, BLOCKING_FILE, BLOCKING_MIN_MINUTES, BLOCKING_MIN_ROWS, blockingImpactTick, heldRefOf, holdingsOf, LOCK_GRIDLOCK_KIND, MAX_TICK_GAP_MS, parseRecord, resolverOf, rowComment,
  topBlocker, wakeOrder, wakeText, type BlockingRecord, type Held, type Incident, type Ref, type Shelved,
} from "./blocking-impact.ts";

const T0 = Date.parse("2026-10-09T10:00:00Z");
const MINUTE = 60_000;
const B4_ROW = (held: number) => `overlaps the Region of #${held}, a row already claimed (\`in-progress\`) that has no open pull request declaring \`Closes #${held}\` yet, and which declares: src/work-gate.ts. B4: no two rows are worked on the same file at once`;
const B4_PR = (held: number) => `overlaps #${held}, which already touches: src/work-gate.ts. B4: no two open pull requests touch the same file`;

/** `count` ready rows (#1001, #1002, ...) shelved behind row `held`. */
const behind = (held: number, count: number, first = 1001): Shelved[] => Array.from({ length: count }, (_, i) => ({ number: first + i, reason: B4_ROW(held) }));
/** The holder table of the fixture: rows 100 and 200 are held by `worker-a` and `worker-b`, pull request 300 by `worker-a` and stands for row 100. */
const HOLDERS: Record<number, Held> = { 100: { holder: "worker-a", row: 100 }, 200: { holder: "worker-b", row: 200 }, 300: { holder: "worker-a", row: 100 } };
const resolve = (ref: Ref): Held | null => HOLDERS[ref.number] ?? null;

/** Run one tick a minute for `minutes` minutes from `T0` over the same blocked list, collecting every incident. */
function runFor(blocked: Shelved[], minutes: number): { record: BlockingRecord | null; incidents: Incident[] } {
  let record: BlockingRecord | null = null;
  const incidents: Incident[] = [];
  const { holdings } = holdingsOf(blocked, resolve);
  for (let minute = 0; minute <= minutes; minute += 1) {
    const step = advance(record, { now: T0 + minute * MINUTE, holdings });
    record = step.record;
    incidents.push(...step.incidents);
  }
  return { record, incidents };
}

test("the thresholds are the row's: 5 rows, 30 minutes", () => {
  assert.equal(BLOCKING_MIN_ROWS, 5);
  assert.equal(BLOCKING_MIN_MINUTES, 30);
});

test("5 shelved rows at 29 minutes do not fire, and at 31 minutes they do", () => {
  assert.deepEqual(runFor(behind(100, 5), 29).incidents, [], "29 minutes is under the line");
  const { incidents } = runFor(behind(100, 5), 31);
  assert.equal(incidents.length, 1, "positive control: 31 minutes fires");
  assert.deepEqual(incidents[0], { holder: "worker-a", since: T0, minutes: 30, rows: [1001, 1002, 1003, 1004, 1005], heldRows: [100] }, "it fires at the first tick that reaches 30 minutes");
});

test("4 shelved rows at 31 minutes do not fire", () => {
  assert.deepEqual(runFor(behind(100, 4), 31).incidents, []);
  assert.equal(runFor(behind(100, 5), 31).incidents.length, 1, "positive control: the same minutes with a fifth row fire");
});

test("an episode is ONE incident, not one per tick", () => {
  assert.equal(runFor(behind(100, 5), 120).incidents.length, 1, "two hours of ticks, one incident");
});

test("an episode that ended and began again is a second incident", () => {
  const blocked = behind(100, 5);
  const { holdings } = holdingsOf(blocked, resolve);
  const quiet = holdingsOf(behind(100, 2), resolve).holdings;
  let record: BlockingRecord | null = null;
  const incidents: Incident[] = [];
  // 35 minutes shelved, one tick below the row count, then 35 minutes shelved again
  const ticks = [...Array(36).fill(holdings), quiet, ...Array(36).fill(holdings)];
  ticks.forEach((held, i) => {
    const step = advance(record, { now: T0 + i * MINUTE, holdings: held });
    record = step.record;
    incidents.push(...step.incidents);
  });
  assert.equal(incidents.length, 2);
  assert.notEqual(incidents[0].since, incidents[1].since, "the second episode has its own start");
});

test("a gap between ticks breaks the episode: unobserved minutes are not shelved minutes", () => {
  const { holdings } = holdingsOf(behind(100, 5), resolve);
  const first = advance(null, { now: T0, holdings });
  const after = advance(first.record, { now: T0 + MAX_TICK_GAP_MS + MINUTE, holdings });
  assert.equal(after.record.episodes["worker-a"].since, T0 + MAX_TICK_GAP_MS + MINUTE, "the episode began again after the gap");
  const unreadable = advance(null, { now: T0 + 40 * MINUTE, holdings });
  assert.deepEqual(unreadable.incidents, [], "no record is no history: 40 minutes is not claimed on a first tick");
});

test("holdings are per holder, and a pull request is resolved to its holder too", () => {
  const blocked = [...behind(100, 3), ...behind(200, 2, 2001), { number: 3001, reason: B4_PR(300) }];
  const { holdings, unattributed } = holdingsOf(blocked, resolve);
  assert.deepEqual(holdings.get("worker-a"), { rows: [1001, 1002, 1003, 3001], heldRows: [100] });
  assert.deepEqual(holdings.get("worker-b"), { rows: [2001, 2002], heldRows: [200] });
  assert.equal(unattributed, 0);
});

test("a shelving that names no holder is not counted, and one naming a holder nobody knows is counted as unattributed", () => {
  const blocked: Shelved[] = [{ number: 1, reason: "has no `## Open-check` -- `row-claim` refuses it" }, { number: 2, reason: B4_ROW(999) }, { number: 3, reason: B4_ROW(100) }];
  const { holdings, unattributed } = holdingsOf(blocked, resolve);
  assert.deepEqual([...holdings.keys()], ["worker-a"]);
  assert.equal(unattributed, 1, "the template gap is nobody's; the unknown holder is shown, not dropped");
});

test("the resolver places a claimed row by its own label, a pull request by its label and Closes, and nothing else", () => {
  const sessionOf = (item: { session?: string }) => item.session ?? null;
  const closesOf = (pr: { closes?: number[] }) => pr.closes ?? [];
  const resolveOpen = resolverOf({
    rows: [{ number: 100, session: "worker-a" }, { number: 101 }] as any, sessionOf, closesOf,
    prs: [{ number: 300, session: "worker-a", closes: [100] }, { number: 301, session: "worker-c" }, { number: 12, repo: "a11ign/agent-org", session: "worker-d", closes: [4602] }] as any,
  });
  assert.deepEqual(resolveOpen({ number: 100 }), { holder: "worker-a", row: 100 });
  assert.deepEqual(resolveOpen({ number: 300 }), { holder: "worker-a", row: 100 }, "a pull request stands for the row it closes");
  assert.deepEqual(resolveOpen({ number: 301 }), { holder: "worker-c", row: null });
  assert.deepEqual(resolveOpen({ number: 12, repo: "a11ign/agent-org" }), { holder: "worker-d", row: 4602 });
  assert.equal(resolveOpen({ number: 12 }), null, "a bare number is not another repository's pull request");
  assert.equal(resolveOpen({ number: 101 }), null, "a row with no session label has no holder");
  assert.equal(resolveOpen({ number: 999 }), null);
});

test("heldRefOf reads both B4 texts and nothing else", () => {
  assert.deepEqual(heldRefOf(B4_ROW(321)), { number: 321 });
  assert.deepEqual(heldRefOf(B4_PR(322)), { number: 322 });
  assert.deepEqual(heldRefOf("overlaps #12 in a11ign/agent-org, which already touches: src/x.ts"), { number: 12, repo: "a11ign/agent-org" });
  assert.equal(heldRefOf("waiting on #5 -- declared on the row"), null);
});

test("the wake text names the count and the rows", () => {
  const incident: Incident = { holder: "worker-a", since: T0, minutes: 31, rows: [1001, 1002, 1003, 1004, 1005], heldRows: [100] };
  const text = wakeText(incident);
  assert.match(text, /you are blocking 5 rows; land, split or release/);
  for (const row of incident.rows) assert.ok(text.includes(`#${row}`), `names #${row}`);
  assert.match(text, /31 minutes/);
  assert.match(rowComment(incident), /shelves 5 ready rows/);
  const order = wakeOrder(incident);
  assert.equal(order.session, "worker-a");
  assert.equal(order.subject, "row-100");
  assert.equal(order.prompt, text);
});

test("the wake text cuts a long list and says how many more", () => {
  const rows = Array.from({ length: 28 }, (_, i) => 1001 + i);
  const text = wakeText({ holder: "worker-a", since: T0, minutes: 90, rows, heldRows: [100] });
  assert.match(text, /you are blocking 28 rows/);
  assert.match(text, /\+16 more/);
});

test("the daily pass names the top blocker from a two-holder fixture, by row-minutes", () => {
  const holdings = holdingsOf([...behind(100, 6), ...behind(200, 12, 2001)], resolve).holdings;
  let record: BlockingRecord | null = null;
  for (let minute = 0; minute <= 10; minute += 1) record = advance(record, { now: T0 + minute * MINUTE, holdings }).record;
  const top = topBlocker(record!, T0 + 10 * MINUTE);
  assert.deepEqual(top, { holder: "worker-b", row: 200, rows: 12, minutes: 10, rowMinutes: 120 }, "worker-b: 12 rows x 10 minutes beats worker-a's 6 x 10");
  const flipped = holdingsOf([...behind(100, 12), ...behind(200, 6, 2001)], resolve).holdings;
  let other: BlockingRecord | null = null;
  for (let minute = 0; minute <= 10; minute += 1) other = advance(other, { now: T0 + minute * MINUTE, holdings: flipped }).record;
  assert.equal(topBlocker(other!, T0 + 10 * MINUTE)?.holder, "worker-a", "positive control: the order follows the numbers, not the holder's name");
  assert.equal(topBlocker({ at: T0, episodes: {}, samples: [] }, T0), null, "nothing shelved is null, not a holder with zero");
});

test("the top blocker counts only the last 24 hours", () => {
  const old = { at: T0 - 25 * 60 * MINUTE, holder: "worker-b", row: 200, rows: 20, minutes: 500 };
  const recent = { at: T0 - MINUTE, holder: "worker-a", row: 100, rows: 5, minutes: 2 };
  assert.equal(topBlocker({ at: T0, episodes: {}, samples: [old, recent] }, T0)?.holder, "worker-a");
});

test("the record keeps 24 hours of samples and no more, so the file does not grow for ever", () => {
  const old = { at: T0 - 25 * 60 * MINUTE, holder: "worker-b", row: 200, rows: 20, minutes: 2 };
  const { record } = advance({ at: T0 - MINUTE, episodes: {}, samples: [old] }, { now: T0, holdings: holdingsOf(behind(100, 2), resolve).holdings });
  assert.deepEqual(record.samples.map((sample) => sample.holder), ["worker-a"], "the 25-hour-old sample is dropped and this tick's is kept");
});

test("the daily report prints the top blocker line, and says so when nothing was shelved", () => {
  const holdings = holdingsOf(behind(100, 6), resolve).holdings;
  let record: BlockingRecord | null = null;
  for (let minute = 0; minute <= 10; minute += 1) record = advance(record, { now: T0 + minute * MINUTE, holdings }).record;
  const now = T0 + 10 * MINUTE;
  const reads = { merged: [], openPrs: [], journal: "", ledger: "", turns: [], handFixes: null };
  const line = (blockingRecord: string | null) => renderReport(buildReport({ ...reads, blockingRecord }, now)).split("\n").find((l) => l.startsWith("- Top blocker"));
  assert.match(line(JSON.stringify(record))!, /Top blocker.*worker-a.*#100.*6 rows.*10m/);
  assert.match(line(JSON.stringify({ at: now, episodes: {}, samples: [] }))!, /nothing was shelved/);
  assert.match(line(null)!, /unknown/, "an unread record is unknown, never 'nothing shelved'");
});

function inScratch(body: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "blocking-impact-"));
  try { body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** A tick over `behind(100, count)` at minute `minute`, with every effect recorded. */
function tickAt(dir: string, minute: number, count: number, seen: { comments: [number, string][]; log: string[] }) {
  return blockingImpactTick({ blocked: behind(100, count), resolve, stateDir: dir, now: T0 + minute * MINUTE,
    comment: (row, body) => { seen.comments.push([row, body]); }, log: (line) => seen.log.push(line) });
}

const STEP = 5;
/** Ticks every `STEP` minutes over [from, to] (a gap past `MAX_TICK_GAP_MS` would end the episode), returning every order. */
function tickThrough(dir: string, { from, to, count }: { from: number; to: number; count: number }, seen: { comments: [number, string][]; log: string[] }) {
  const orders = [];
  for (let minute = from; minute <= to; minute += STEP) orders.push(...tickAt(dir, minute, count, seen));
  return orders;
}

test("the live tick records the incident once, comments on the held row once, wakes the holder once, and prints each holder's count", () => {
  inScratch((dir) => {
    const seen = { comments: [] as [number, string][], log: [] as string[] };
    assert.deepEqual(tickThrough(dir, { from: 0, to: 25, count: 5 }, seen), [], "25 minutes is under the line");
    const orders = tickThrough(dir, { from: 30, to: 90, count: 5 }, seen);
    assert.equal(orders.length, 1, "one wake order across an hour of ticks");
    assert.equal(orders[0].session, "worker-a");
    assert.equal(seen.comments.length, 1, "one row write across an hour of ticks");
    assert.equal(seen.comments[0][0], 100);
    const ledger = parseFailureLedger(readFileSync(join(dir, FAILURE_LEDGER_FILE), "utf8"));
    assert.deepEqual(ledger.map((e) => e.classKey), [LOCK_GRIDLOCK_KIND], "one ledger event under the class key");
    assert.ok(seen.log.some((line) => /worker-a shelves 5 rows behind #100: #1001 #1002 #1003 #1004 #1005/.test(line)), `the count is printed: ${seen.log.join(" | ")}`);
    assert.ok(existsSync(join(dir, BLOCKING_FILE)));
  });
});

test("two episodes of one holder are two ledger refs, which is what makes the class a repeat", () => {
  inScratch((dir) => {
    const seen = { comments: [] as [number, string][], log: [] as string[] };
    tickThrough(dir, { from: 0, to: 35, count: 5 }, seen);
    tickAt(dir, 40, 1, seen);
    tickThrough(dir, { from: 45, to: 80, count: 5 }, seen);
    const entries = parseFailureLedger(readFileSync(join(dir, FAILURE_LEDGER_FILE), "utf8"));
    assert.equal(entries.length, 2);
    assert.deepEqual(repeatsIn(entries, { windowMs: 24 * 60 * MINUTE, now: T0 + 80 * MINUTE }).map((r) => r.classKey), [LOCK_GRIDLOCK_KIND]);
  });
});

test("a record that cannot be written is reported and writes no row comment", () => {
  inScratch((dir) => {
    const seen = { comments: [] as [number, string][], log: [] as string[] };
    const orders = blockingImpactTick({ blocked: behind(100, 5), resolve, stateDir: dir, now: T0, write: () => { throw new Error("disk full"); }, comment: (r, b) => { seen.comments.push([r, b]); }, log: (l) => seen.log.push(l) });
    assert.deepEqual(orders, [], "one tick is no episode");
    const record = advance(null, { now: T0, holdings: holdingsOf(behind(100, 5), resolve).holdings }).record;
    const open = { ...record, at: T0 + 31 * MINUTE - MINUTE };
    const later = blockingImpactTick({ blocked: behind(100, 5), resolve, stateDir: dir, now: T0 + 31 * MINUTE, read: () => JSON.stringify(open), write: () => { throw new Error("disk full"); },
      comment: (r, b) => { seen.comments.push([r, b]); }, log: (l) => seen.log.push(l) });
    assert.equal(later.length, 1, "the order still goes");
    assert.deepEqual(seen.comments, [], "the row comment would repeat every tick, so it waits for a record that holds");
    assert.ok(seen.log.some((l) => /was not written \(disk full\)/.test(l)));
  });
});

test("an unreadable record is reported and starts afresh, and a refused row write does not stop the order", () => {
  inScratch((dir) => {
    const log: string[] = [];
    const orders = blockingImpactTick({ blocked: behind(100, 5), resolve, stateDir: dir, now: T0, read: () => "not json", log: (l) => log.push(l) });
    assert.deepEqual(orders, []);
    assert.ok(log.some((l) => /could not be read/.test(l)), "a corrupt file is said, not mistaken for a first tick");
    assert.throws(() => parseRecord("{}"));
  });
  inScratch((dir) => {
    const log: string[] = [];
    const refused = { comments: [] as [number, string][], log };
    assert.deepEqual(tickThrough(dir, { from: 0, to: 25, count: 5 }, refused), []);
    const second = blockingImpactTick({ blocked: behind(100, 5), resolve, stateDir: dir, now: T0 + 30 * MINUTE, comment: () => { throw new Error("rate limited"); }, log: (l) => log.push(l) });
    assert.equal(second.length, 1);
    assert.ok(log.some((l) => /row write on #100 was refused \(rate limited\)/.test(l)));
  });
});
