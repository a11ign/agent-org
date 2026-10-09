// no-token: gh -- `ready-when-unblocked.mjs` reaches GitHub only through the `ReadyIo` it is given; every one this file builds is a fake over an in-memory world, so nothing here writes a row (a11ign/a11ign#4064)
// a11ign/a11ign#4064: a cleared row whose filer declared `Ready-when-unblocked: yes` is promoted by the gate; every other cleared row is offered to `product-manager` exactly as before.
//
// THE POSITIVE CONTROL for every "not promoted" below is the first test: the SAME harness (`world`, `tick`) promotes a row there, so an empty `calls` is a reading of a wired pass and not of one
// that cannot write. Each negative differs from the promoting case by ONE fact. The ORDER is read through the gate's own `unclaimedBlockerClearedOrders`, after the same `unclaimedClearings`
// the tick uses, so "offered as before" is the real cause and not a restatement of it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NOT_STARTABLE, unclaimedBlockerClearedOrders, unclaimedClearings } from "../work-gate.mjs";
import { PROMOTED_REASON, declaresReadyWhenUnblocked, promoteReadyWhenUnblocked, reportReadyWhenUnblocked } from "./ready-when-unblocked.mjs";

const NOW = Date.parse("2026-10-11T00:05:00Z");
const TODAY = "2026-10-11";
const FUTURE = "2026-10-14T00:00:00Z";
const LINE = "Ready-when-unblocked: yes";

/** A body the claim rule accepts: Region, Acceptance and Open-check (a pasted transcript) each with content, and the declaration. */
const COMPLETE = `## What it is\n\nthe work\n\n## Region\n\n\`\`\`\nsrc/thing.mjs\n\`\`\`\n\n## Acceptance\n\n\`\`\`bash\nnode --test src/thing.test.mjs\n\`\`\`\n\n## Open-check\n\n\`\`\`\n$ ls src/thing.mjs\nls: cannot access\n\`\`\`\n\n${LINE}\n`;
const WITHOUT_OPEN_CHECK = `${COMPLETE.split("## Open-check")[0]}${LINE}\n`;

/** @param {number} number @param {Record<string, any>} [more] a row as the tick's open-row read gives it: backlog, one edge, closed */
const tickRow = (number: number, more: Record<string, any> = {}) => ({ number, title: `row ${number}`, labels: [{ name: "backlog" }], body: COMPLETE, blockedBy: { nodes: [{ number: 1, state: "CLOSED" }] }, ...more });

/**
 * A GitHub in memory. `live` is what a fresh read of each row says (labels, body), defaulting to the tick's own; `calls` logs every call; `refuse` makes the promotion refuse; `fail` makes a call throw.
 * @param {{ rows: any[], live?: Record<number, { labels?: string[], body?: string, state?: string, blockedBy?: any }>, merged?: Record<number, { number: number, mergedAt: string }>, refuse?: Record<number, string>, fail?: string[] }} setup
 */
function world({ rows, live = {}, merged = {}, refuse = {}, fail = [] }: { rows: any[]; live?: Record<number, { labels?: string[]; body?: string; state?: string; blockedBy?: any; }>; merged?: Record<number, { number: number; mergedAt: string; }>; refuse?: Record<number, string>; fail?: string[]; }) {
  /** @type {string[]} */
  const calls: string[] = [];
  /** @type {import("./ready-when-unblocked.mjs").ReadyIo} */
  const io: import("./ready-when-unblocked.mjs").ReadyIo = {
    read: (n) => {
      calls.push(`read ${n}`);
      if (fail.includes("read")) throw new Error(`HTTP 502 on read #${n}`);
      const row = rows.find((r) => r.number === n);
      return { labels: live[n]?.labels ?? row.labels.map((/** @type {any} */ l: any) => l.name), state: live[n]?.state ?? "OPEN", body: live[n]?.body ?? row.body, blockedBy: live[n]?.blockedBy ?? row.blockedBy };
    },
    mergedClosers: (n) => { calls.push(`mergedClosers ${n}`); return merged[n] ? [merged[n]] : []; },
    promote: (n) => { calls.push(`promote ${n}`); return refuse[n] ? { ok: false, refusal: refuse[n] } : { ok: true }; },
  };
  return { io, calls };
}

/** The tick's two steps in the tick's order: promote what is declared, then ask the order cause about whatever is left. */
function tick(/** @type {Parameters<typeof world>[0]} */ setup: Parameters<typeof world>[0]) {
  const { io, calls } = world(setup);
  const clearings = unclaimedClearings(setup.rows, TODAY, NOW).filter(({ row }) => declaresReadyWhenUnblocked(row.body));
  const result = promoteReadyWhenUnblocked({ clearings, notStartable: NOT_STARTABLE, now: NOW }, io);
  /** @type {string[]} */
  const log: string[] = [];
  reportReadyWhenUnblocked(result, (line) => log.push(line));
  const asked = unclaimedBlockerClearedOrders(setup.rows, TODAY, { now: NOW }).map((o) => o.subject);
  return { result, calls, log, asked };
}

test("POSITIVE CONTROL: a declared row with every edge closed and a complete body is promoted, logged, and no longer offered to product-manager", () => {
  const { result, calls, log, asked } = tick({ rows: [tickRow(10)] });
  assert.deepEqual(result.promoted, [10]);
  assert.ok(calls.includes("promote 10"));
  assert.deepEqual(log, [`PROMOTED #10 (${PROMOTED_REASON})\n`]);
  assert.equal(log[0], "PROMOTED #10 (blockers cleared, Ready-when-unblocked)\n");
  assert.deepEqual(asked, [], "the tick's own row now carries `ready`, which `unclaimedClearings` excludes");
});

test("ONE EDGE STILL OPEN: not a clearing at all, so nothing is read or written", () => {
  const rows = [tickRow(10, { blockedBy: { nodes: [{ number: 1, state: "CLOSED" }, { number: 2, state: "OPEN" }] } })];
  const { result, calls, asked } = tick({ rows });
  assert.deepEqual(result, { promoted: [], kept: [], errors: [] });
  assert.deepEqual(calls, []);
  assert.deepEqual(asked, []);
});

test("NO DECLARATION: today's order, unchanged, and not one call is made", () => {
  const undeclared = COMPLETE.replace(LINE, "");
  const rows = [tickRow(10, { body: undeclared })];
  const { result, calls, log, asked } = tick({ rows });
  assert.deepEqual(result, { promoted: [], kept: [], errors: [] });
  assert.deepEqual(calls, []);
  assert.deepEqual(log, []);
  assert.deepEqual(asked, ["row-10"], "the cause that asks product-manager still fires for a row that never declared it");
  assert.deepEqual(unclaimedBlockerClearedOrders(rows, TODAY, { now: NOW }), unclaimedBlockerClearedOrders([tickRow(10, { body: undeclared })], TODAY, { now: NOW }));
});

test("ANY OTHER VALUE IS NOT A DECLARATION: `no`, prose about it, and a line inside a word", () => {
  for (const body of [COMPLETE.replace(LINE, "Ready-when-unblocked: no"), COMPLETE.replace(LINE, "Ready-when-unblocked: yes, probably"), COMPLETE.replace(LINE, "not-Ready-when-unblocked: yes")]) {
    assert.equal(declaresReadyWhenUnblocked(body), false, body.slice(-40));
  }
  assert.equal(declaresReadyWhenUnblocked(COMPLETE), true);
  assert.equal(declaresReadyWhenUnblocked(COMPLETE.replace(LINE, "### Ready-when-unblocked: yes")), true);
});

test("THE BODY CHECK IS RE-RUN ON THE LIVE BODY: an Open-check lost since the tick read it is not promoted, and the order stays", () => {
  assert.notEqual(WITHOUT_OPEN_CHECK, COMPLETE, "the fixture really dropped the section");
  assert.ok(!/## Open-check/.test(WITHOUT_OPEN_CHECK));
  assert.ok(declaresReadyWhenUnblocked(WITHOUT_OPEN_CHECK), "it still declares the line, so only the body check can stop it");
  const { result, calls, log, asked } = tick({ rows: [tickRow(10)], live: { 10: { body: WITHOUT_OPEN_CHECK } } });
  assert.deepEqual(result.promoted, []);
  assert.match(result.kept[0].reason, /Open-check/);
  assert.ok(!calls.includes("promote 10"));
  assert.match(log[0], /^NOT PROMOTED #10 /);
  assert.deepEqual(asked, ["row-10"]);
});

test("THE DECLARATION IS RE-READ TOO: a line removed since the tick read the row is not promoted", () => {
  const { result, calls } = tick({ rows: [tickRow(10)], live: { 10: { body: COMPLETE.replace(LINE, "") } } });
  assert.deepEqual(result.promoted, []);
  assert.match(result.kept[0].reason, /no longer declares/);
  assert.ok(!calls.includes("promote 10"));
});

test("AN EDGE THAT REOPENED SINCE THE TICK READ IT IS A WAIT AGAIN: the fresh read's `blockedBy` is what decides, not the tick's snapshot", () => {
  const reopened = { nodes: [{ number: 1, state: "OPEN" }] };
  const { result, calls, log, asked } = tick({ rows: [tickRow(10)], live: { 10: { blockedBy: reopened } } });
  assert.deepEqual(result.promoted, []);
  assert.match(result.kept[0].reason, /waiting again \(row\)/);
  assert.ok(!calls.includes("promote 10"));
  assert.match(log[0], /^NOT PROMOTED #10 /);
  assert.deepEqual(asked, ["row-10"], "left alone, so product-manager is asked as before (the tick's snapshot still says cleared)");
  const stillClosed = tick({ rows: [tickRow(10)], live: { 10: { blockedBy: { nodes: [{ number: 1, state: "CLOSED" }] } } } });
  assert.deepEqual(stillClosed.result.promoted, [10], "the same fresh read with the edge still closed promotes, so only the reopened edge stopped it");
});

test("a `Not-before:` still in the future is not promoted, whether the tick saw it or only the fresh read did", () => {
  const dated = COMPLETE.replace(LINE, `Not-before: ${FUTURE}\n${LINE}`);
  const seen = tick({ rows: [tickRow(10, { body: dated })] });
  assert.deepEqual(seen.result, { promoted: [], kept: [], errors: [] }, "the tick's own waitingOn already excludes it");
  assert.deepEqual(seen.asked, []);
  const added = tick({ rows: [tickRow(10)], live: { 10: { body: dated } } });
  assert.deepEqual(added.result.promoted, []);
  assert.match(added.result.kept[0].reason, /waiting again \(date\)/);
});

test("`parked`, `needs:chairman` and an `answer:` label stop it, on the tick's read and on the fresh one", () => {
  for (const label of ["parked", "needs:chairman", "answer:ceo"]) {
    const seen = tick({ rows: [tickRow(10, { labels: [{ name: "backlog" }, { name: label }] })] });
    assert.deepEqual(seen.result.promoted, [], `${label} on the tick's read`);
    assert.ok(!seen.calls.includes("promote 10"), label);
    const added = tick({ rows: [tickRow(10)], live: { 10: { labels: ["backlog", label] } } });
    assert.deepEqual(added.result.promoted, [], `${label} added since`);
    assert.ok(!added.calls.includes("promote 10"), label);
    assert.match(added.result.kept[0].reason, new RegExp(label));
  }
});

test("a label that means not startable or not pickable stops it", () => {
  for (const label of ["blocked", "epic", "fleet-gated", "disputed", "awaiting-merge"]) {
    const { result, calls, asked } = tick({ rows: [tickRow(10, { labels: [{ name: "backlog" }, { name: label }] })] });
    assert.deepEqual(result.promoted, [], label);
    assert.ok(!calls.includes("promote 10"), label);
    assert.deepEqual(asked, ["row-10"], `${label}: the order that names what hides it still fires`);
  }
});

test("a merged PR that already names the row stops it (#2905's shape: closed edges and nothing left to build)", () => {
  const { result, calls } = tick({ rows: [tickRow(10)], merged: { 10: { number: 77, mergedAt: "2026-10-10T00:00:00Z" } } });
  assert.deepEqual(result.promoted, []);
  assert.match(result.kept[0].reason, /PR #77/);
  assert.ok(!calls.includes("promote 10"));
});

test("the promotion's own refusal (row-file re-runs the filing rule) keeps the order, and says why", () => {
  const { result, log, asked } = tick({ rows: [tickRow(10)], refuse: { 10: "row-file: REFUSING to promote -- body" } });
  assert.deepEqual(result.promoted, []);
  assert.match(log[0], /NOT PROMOTED #10 .*REFUSING to promote/);
  assert.deepEqual(asked, ["row-10"]);
});

test("a failed read is an error NAMING the row, the order stays, and the next row is still tried", () => {
  const { io, calls } = world({ rows: [tickRow(10), tickRow(11)], fail: ["read"] });
  const clearings = unclaimedClearings([tickRow(10), tickRow(11)], TODAY, NOW);
  const result = promoteReadyWhenUnblocked({ clearings, notStartable: NOT_STARTABLE, now: NOW }, io);
  assert.deepEqual(result.errors.map((e) => e.number), [10, 11]);
  assert.match(result.errors[0].message, /HTTP 502/);
  assert.deepEqual(calls, ["read 10", "read 11"]);
});

test("a closed row, and a claimed one, is never promoted", () => {
  assert.deepEqual(tick({ rows: [tickRow(10)], live: { 10: { state: "CLOSED" } } }).result.promoted, []);
  assert.deepEqual(tick({ rows: [tickRow(10)], live: { 10: { labels: ["backlog", "in-progress"] } } }).result.promoted, []);
});

test("only the declaring row is promoted when two have cleared; the other is still asked about", () => {
  const rows = [tickRow(10), tickRow(11, { body: COMPLETE.replace(LINE, "") })];
  const { result, asked } = tick({ rows });
  assert.deepEqual(result.promoted, [10]);
  assert.deepEqual(asked, ["row-11"]);
});

test("the module skips an undeclared row ITSELF, not only because the caller pre-filtered (positive control: the declared row beside it is promoted)", () => {
  const rows = [tickRow(10, { body: COMPLETE.replace(LINE, "") }), tickRow(11)];
  const { io, calls } = world({ rows });
  const result = promoteReadyWhenUnblocked({ clearings: unclaimedClearings(rows, TODAY, NOW), notStartable: NOT_STARTABLE, now: NOW }, io);
  assert.deepEqual(result.promoted, [11]);
  assert.deepEqual(calls.filter((c) => c.endsWith(" 10")), [], "nothing was read or written for the undeclared row");
});
