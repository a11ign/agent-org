// agent-org#752: the host-side pass that writes a closed routed row's outcome. A temp directory and injected reads only: no network, no key, no `gh`, no real trace store.
// EVERY CLAIM HAS ITS NEGATIVE CONTROL: the row that is written beside the row for which nothing is, a failed read beside the same rig with a healthy one, and the second tick beside the first.
// The routed rows are routed by the REAL `routeEngineer`, so the route line the pass looks for is the one production writes, and the escalation line is the real `escalationLogLine`.
// no-token: gh -- nothing here calls `gh`; every read is injected
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { escalationLogLine } from "../engineer-escalation.ts";
import { routeEngineer, type RouteRow } from "../engineer-route.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { ROUTE_OUTCOMES } from "../route-outcome.ts";
import type { ClosedRow } from "../trace/haiku-tier-report.ts";
import { readStore, type TraceEvent } from "../trace/store.ts";
import { GRACE_MS, HORIZON_MS, ROWS_PER_TICK, readStoreFor, routeOutcomePass, type RouteOutcomePassInput } from "./route-outcome-pass.ts";
import { workGateSource } from "../lib/work-gate-source.ts";

const BODY = "## Region\n\n```\nsrc/a.ts\nsrc/a.test.ts\n```\n\n## Acceptance\n\n```bash\npnpm test\n```\n\n## Done-when\n\n1. The Acceptance passes.\n";
const rowOf = (number: number): RouteRow => ({ number, title: "Rename a helper", labels: ["ready"], body: BODY });
const REPO = "a11ign/a11ign";
const NOW = 9_000;
const closedWith = (number: number, pr: number | null = number + 100_000, closedAt = 5_000): ClosedRow => ({ number, haiku: false, closedAt, pr: pr === null ? null : { repo: REPO, number: pr } });

/** What the store holds of a pull request, as `github-events.ts` writes it: ids carry the repository and the number, `source` is `github`. */
function pullEvents(pr: number, { merged = false, rejections = 0, approvals = 0, closed = merged }: { merged?: boolean; rejections?: number; approvals?: number; closed?: boolean }): TraceEvent[] {
  const event = (kind: string, key: string, extra: object = {}) => ({ id: `gh:${REPO}#${pr}:${kind}:${key}`, kind, source: "github", at: 1, session: "", pr, repo: REPO, ...extra }) as unknown as TraceEvent;
  return [
    ...Array.from({ length: rejections }, (_, i) => event("reviewed", `r${i}`, { state: "CHANGES_REQUESTED" })),
    ...Array.from({ length: approvals }, (_, i) => event("reviewed", `a${i}`, { state: "APPROVED" })),
    ...(merged ? [event("merged", "m")] : []),
    ...(closed ? [event("closed", "c")] : []),
  ];
}
const compaction = (row: number, n: number): TraceEvent => ({ id: `compaction-${row}-${n}`, kind: "compaction", source: "transcript", at: 1, session: `s${row}`, row, pr: null, repo: null }) as unknown as TraceEvent;

type Rig = Awaited<ReturnType<typeof rig>>;

/** A host with a decision log holding the production route lines of `routed`; `closed` is what GitHub says has closed, `store` is what the trace store holds. */
async function rig({ routed, closed = [], store = [], listed = true, on = true }: { routed: readonly number[]; closed?: ClosedRow[]; store?: TraceEvent[]; listed?: boolean; on?: boolean }) {
  const dir = tmpDir("route-outcome-pass-");
  const logPath = join(dir, "decisions");
  const said: string[] = [];
  const switches = on ? ({ "model-routing": true } as const) : {};
  const base = { logPath, switches: { "model-routing": true } as const, now: () => 1_000, diagnostic: (line: string) => { said.push(line); } };
  for (const number of routed) await routeEngineer(rowOf(number), { host: {}, ...base });
  const calls = { closedRows: [] as [number, number][], events: [] as (readonly string[])[] };
  const state = { closed: closed as ClosedRow[] | Error, store: store as TraceEvent[] | null };
  const input = (): RouteOutcomePassInput => ({
    listed,
    record: { logPath, switches, now: () => NOW, diagnostic: base.diagnostic },
    closedRows: (from, to) => {
      calls.closedRows.push([from, to]);
      if (state.closed instanceof Error) throw state.closed;
      return state.closed;
    },
    events: (prefixes) => {
      calls.events.push(prefixes);
      return state.store;
    },
  });
  const text = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
  const outcomesOf = (row: number) => text().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id?: string; outcome?: string })
    .filter((l) => l.id === `row-${row}` && (ROUTE_OUTCOMES as readonly unknown[]).includes(l.outcome)).map((l) => l.outcome);
  const asked = () => [calls.closedRows.length, calls.events.length];
  return { dir, logPath, said, calls, state, input, run: () => routeOutcomePass(input()), text, outcomesOf, asked };
}

// --- the write, and the four strings it can write ---

test("a closed routed row with a merged first-pass pull request writes `merged-first-pass` (positive control)", async () => {
  const r = await rig({ routed: [4999], closed: [closedWith(4999, 7)], store: [...pullEvents(7, { merged: true, approvals: 2 }), compaction(4999, 1)] });
  const result = r.run();
  assert.deepEqual(result.written, [{ row: 4999, outcome: "merged-first-pass" }]);
  assert.deepEqual(r.outcomesOf(4999), ["merged-first-pass"]);
  assert.deepEqual(r.calls.closedRows, [[1_000, NOW]], "the closed rows are read from the row's routing to now, in one read");
  assert.deepEqual(r.calls.events, [[`gh:${REPO}#7:`]], "the store is asked for that pull request's events only");
  assert.deepEqual(r.said, []);
});

test("each other outcome comes from its own fact, and the row beside it is untouched", async () => {
  const r = await rig({
    routed: [10, 11, 12, 13],
    closed: [closedWith(10, 110), closedWith(11, 111), closedWith(12, null), closedWith(13, 113)],
    store: [...pullEvents(110, { merged: true, rejections: 1, approvals: 1 }), ...pullEvents(111, { closed: true }), ...pullEvents(113, { merged: true }), compaction(13, 1)],
  });
  appendFileSync(r.logPath, `${JSON.stringify(escalationLogLine({ row: 13, reason: "it has compacted 10 times", at: 2_000 }))}\n`);
  r.run();
  assert.deepEqual(r.outcomesOf(10), ["not-first-pass"], "merged after a CHANGES_REQUESTED review");
  assert.deepEqual(r.outcomesOf(11), ["closed-without-merge"], "its pull request closed with no merge");
  assert.deepEqual(r.outcomesOf(12), ["closed-without-merge"], "no closing pull request at all");
  assert.deepEqual(r.outcomesOf(13), ["escalated"], "the log's own escalation line wins over a clean merge");
});

test("another repository's pull request of the same number is not this row's (control: its own is read)", async () => {
  const foreign = pullEvents(7, { merged: true, rejections: 2 }).map((event) => ({ ...event, id: event.id.replace(REPO, "someone/else") }) as TraceEvent);
  const r = await rig({ routed: [4999], closed: [closedWith(4999, 7)], store: [...foreign, ...pullEvents(7, { merged: true })] });
  r.run();
  assert.deepEqual(r.outcomesOf(4999), ["merged-first-pass"], "the other repository's two rejections are not counted");
});

// --- what it writes nothing for ---

test("a closed row with no decision line writes nothing, and exactly one line is appended (control: the routed row beside it does write)", async () => {
  const r = await rig({ routed: [4999], closed: [closedWith(4999, 7), closedWith(5000, 8)], store: [...pullEvents(7, { merged: true }), ...pullEvents(8, { merged: true })] });
  const before = r.text();
  const { written } = r.run();
  assert.deepEqual(written, [{ row: 4999, outcome: "merged-first-pass" }], "the control: the routed row, same facts, same call");
  assert.deepEqual(r.outcomesOf(5000), [], "row 5000 was never routed");
  assert.equal(r.text().split("\n").filter(Boolean).length, before.split("\n").filter(Boolean).length + 1);
  assert.deepEqual(r.calls.events, [[`gh:${REPO}#7:`]], "and the store was not asked about a pull request of a row nothing is owed for");
});

test("a routed row that has not closed writes nothing and does not read the store (control: it writes the tick it closes)", async () => {
  const r = await rig({ routed: [31], closed: [], store: pullEvents(131, { merged: true }) });
  assert.deepEqual(r.run().written, []);
  assert.deepEqual(r.calls.events, []);
  r.state.closed = [closedWith(31, 131)];
  assert.deepEqual(r.run().written, [{ row: 31, outcome: "merged-first-pass" }], "the control: the same log, the row now closed");
});

test("a closing pull request the store has not reached is HELD, not written as unmerged, and is written when its events arrive (control: the merged one beside it writes)", async () => {
  const r = await rig({ routed: [7, 8], closed: [closedWith(7, 107), closedWith(8, 108)], store: pullEvents(108, { merged: true }) });
  assert.deepEqual(r.run().written, [{ row: 8, outcome: "merged-first-pass" }], "row 7's merge is not in the store yet");
  assert.deepEqual(r.outcomesOf(7), [], "and `closed-without-merge` is not guessed for it");
  assert.deepEqual(r.said, [], "a pull request the store has not reached is not a fault");
  r.state.store = [...pullEvents(108, { merged: true }), ...pullEvents(107, { merged: true, rejections: 1 })];
  assert.deepEqual(r.run().written, [{ row: 7, outcome: "not-first-pass" }], "the same row, the tick its events are in");
});

test("a failed read writes nothing and says so, and the row is still owed on the next tick (control: the same rig with the read healthy writes)", async () => {
  const faults: [string, (r: Rig) => void, RegExp][] = [
    ["the closed rows' read refused", (r) => { r.state.closed = new Error("HTTP 403 rate limited\nsecond line"); }, /the closed rows could not be read \(HTTP 403 rate limited\), so no outcome was written this tick/],
    ["the trace store could not be read", (r) => { r.state.store = null; }, /the trace store could not be read, so the 1 closed row\(s\) owed an outcome got none this tick/],
    ["the closing pull request's repository could not be read", (r) => { r.state.closed = [{ ...closedWith(7, null), unresolved: true }]; }, /row 7 has no outcome written this tick: its closing pull request names no repository/],
  ];
  for (const [name, break_, said] of faults) {
    const r = await rig({ routed: [7], closed: [closedWith(7, 107)], store: pullEvents(107, { merged: true }) });
    break_(r);
    const before = r.text();
    assert.deepEqual(r.run().written, [], name);
    assert.equal(r.text(), before, `${name}: the log is byte-identical`);
    assert.match(r.said.join("\n"), said, name);
    const control = await rig({ routed: [7], closed: [closedWith(7, 107)], store: pullEvents(107, { merged: true }) });
    assert.deepEqual(control.run().written, [{ row: 7, outcome: "merged-first-pass" }], `${name}: the control rig, unbroken`);
  }
});

test("one row's unreadable pull request does not hold the row beside it, and the held row is written when it recovers", async () => {
  const r = await rig({ routed: [7, 8], closed: [{ ...closedWith(7, null), unresolved: true }, closedWith(8, 108)], store: pullEvents(108, { merged: true }) });
  assert.deepEqual(r.run().written, [{ row: 8, outcome: "merged-first-pass" }]);
  r.state.closed = [closedWith(7, 107), closedWith(8, 108)];
  r.state.store = [...pullEvents(108, { merged: true }), ...pullEvents(107, { merged: true, rejections: 1 })];
  assert.deepEqual(r.run().written, [{ row: 7, outcome: "not-first-pass" }]);
});

// --- once per row, and when the pass is not asked ---

test("the second tick writes nothing and asks for nothing (control: the first wrote)", async () => {
  const r = await rig({ routed: [21, 22], closed: [closedWith(21, 121), closedWith(22, 122)], store: [...pullEvents(121, { merged: true }), ...pullEvents(122, { merged: true })] });
  assert.equal(r.run().written.length, 2, "the control: the first tick");
  const afterFirst = r.text();
  const askedBefore = r.asked();
  assert.deepEqual(r.run(), { written: [], owed: 0 });
  assert.equal(r.text(), afterFirst, "the log is byte-identical");
  assert.deepEqual(r.asked(), askedBefore, "neither the closed rows nor the store were read: the owed list is empty");
});

test("a second close-out of a row another close-out already wrote is a no-op, even with different facts", async () => {
  const r = await rig({ routed: [21], closed: [closedWith(21, 121)], store: pullEvents(121, { merged: true }) });
  r.run();
  r.state.store = pullEvents(121, { merged: true, rejections: 2 });
  assert.deepEqual(r.run().written, []);
  assert.deepEqual(r.outcomesOf(21), ["merged-first-pass"], "the first reading stands");
});

test("an unlisted herdr or a host with the use off asks nothing and writes nothing (control: listed and on writes)", async () => {
  for (const [name, options] of [["herdr not listed", { listed: false }], ["the use off", { on: false }]] as const) {
    const r = await rig({ routed: [41], closed: [closedWith(41, 141)], store: pullEvents(141, { merged: true }), ...options });
    const before = r.text();
    assert.deepEqual(r.run().written, [], name);
    assert.equal(r.text(), before, name);
    assert.deepEqual([r.asked(), r.said], [[0, 0], []], `${name}: no read of any kind, and quiet`);
  }
  const control = await rig({ routed: [41], closed: [closedWith(41, 141)], store: pullEvents(141, { merged: true }) });
  assert.equal(control.run().written.length, 1);
});

test("a host with no decision log is not given one", async () => {
  const r = await rig({ routed: [], closed: [closedWith(41, 141)], store: pullEvents(141, { merged: true }) });
  assert.deepEqual(r.run(), { written: [], owed: 0 });
  assert.equal(existsSync(r.logPath), false);
  assert.deepEqual(r.asked(), [0, 0]);
});

test("a tick writes for at most ROWS_PER_TICK rows, and the rest are written by the next (control: none is lost)", async () => {
  const numbers = Array.from({ length: ROWS_PER_TICK + 5 }, (_, i) => 200 + i);
  const r = await rig({ routed: numbers, closed: numbers.map((n) => closedWith(n, n + 1000)), store: numbers.flatMap((n) => pullEvents(n + 1000, { merged: true })) });
  assert.equal(r.run().written.length, ROWS_PER_TICK);
  assert.equal(r.run().written.length, 5);
  assert.deepEqual(r.run().written, []);
  assert.deepEqual(numbers.filter((n) => r.outcomesOf(n).length !== 1), [], "every row has exactly one outcome");
});

// --- what bounds the reads ---

test("a row closed longer ago than GRACE_MS and still undecided does not ask for the store, but is decided with a read a newer row asks for (control: a fresh row asks)", async () => {
  const stale = closedWith(7, 107, NOW - GRACE_MS - 1);
  const r = await rig({ routed: [7], closed: [stale], store: [] });
  assert.deepEqual(r.run().written, []);
  assert.deepEqual(r.calls.events, [], "nothing recent to decide: the store is not read");
  r.state.closed = [stale, closedWith(8, 108, NOW - 1)];
  r.state.store = [...pullEvents(107, { closed: true }), ...pullEvents(108, { merged: true })];
  const withFresh = await rig({ routed: [7, 8], closed: [stale, closedWith(8, 108, NOW - 1)], store: r.state.store });
  assert.deepEqual(withFresh.run().written.map((w) => w.row), [7, 8], "the stale row rides along with the fresh row's read");
  assert.equal(withFresh.calls.events.length, 1, "one read of the store");
});

test("a routing older than HORIZON_MS is not looked for a closing (control: a recent one is)", async () => {
  const r = await rig({ routed: [7], closed: [closedWith(7, 107)], store: pullEvents(107, { merged: true }) });
  const future = { ...r.input(), record: { ...r.input().record, now: () => 1_000 + HORIZON_MS + 1 } };
  assert.deepEqual(routeOutcomePass(future), { written: [], owed: 0 });
  assert.deepEqual(r.asked(), [0, 0], "the closed rows were not read for it");
  assert.equal(r.run().written.length, 1, "the control: the same log, a clock inside the horizon");
});

// --- the store reader ---

test("readStoreFor returns the events of the named pull requests and every compaction, as `readStore` would, and holds nothing else (positive control)", () => {
  const dir = tmpDir("route-outcome-store-");
  const path = join(dir, "events.ndjson");
  const turn = { id: "turn-1", kind: "turn", source: "transcript", at: 1, session: "s", row: 7, pr: null, repo: null };
  const events = [
    turn,
    ...pullEvents(7, { merged: true, rejections: 1 }),
    ...pullEvents(8, { merged: true }),
    compaction(7, 1),
    { ...pullEvents(7, { closed: true })[0], at: 99 },
    { ...pullEvents(7, { merged: true })[0], id: pullEvents(7, { merged: true })[0].id, at: 2 },
  ];
  writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const wanted = (event: TraceEvent) => event.kind === "compaction" || event.id.startsWith(`gh:${REPO}#7:`);
  const expected = readStore(path).filter(wanted);
  for (const chunk of [undefined, 64, 7]) {
    const got = readStoreFor(path, [`gh:${REPO}#7:`], chunk);
    assert.deepEqual(got, expected, `chunk ${chunk ?? "default"}: the same events in the same order, the last copy of an id winning`);
  }
  assert.ok(expected.length >= 3 && expected.every((event) => event.id !== "turn-1" && !event.id.includes("#8:")), "the control holds something and not the other pull request or the turn");
  assert.deepEqual(readStoreFor(join(dir, "absent.ndjson"), [`gh:${REPO}#7:`]), [], "an absent store is no events");
});

test("readStoreFor reads around a damaged line it does not need, and refuses one it does (control: both are in the same file)", () => {
  const dir = tmpDir("route-outcome-store-");
  const path = join(dir, "events.ndjson");
  const good = JSON.stringify(pullEvents(7, { merged: true })[0]);
  writeFileSync(path, `{"id":"turn-2","kind":"tu\n${good}\n`);
  assert.equal(readStoreFor(path, [`gh:${REPO}#7:`]).length, 1, "the damaged line names nothing wanted, and is not read");
  writeFileSync(path, `{"id":"gh:${REPO}#7:merged:9","kind":"mer\n${good}\n`);
  assert.throws(() => readStoreFor(path, [`gh:${REPO}#7:`]), SyntaxError, "a damaged line of a wanted pull request is reported, never read around");
});

// --- the gate calls it ---

test("the gate calls the pass once per tick, beside the closed-row strip and behind its listing condition (positive control: the call is matched; negative: a comment is not)", () => {
  const source = workGateSource();
  const call = /^\s*(?:const \w+ = )?recordRouteOutcomesOnHost\(/;
  const calls = source.split("\n").filter((line) => call.test(line));
  assert.equal(calls.length, 1, "exactly one call site");
  assert.match(calls[0], /recordRouteOutcomesOnHost\(\{ listed: closedClaimLabels !== null,/, "behind the listing the strip is asked behind");
  assert.ok(source.indexOf(calls[0]) > source.indexOf("stripClosedClaims(closedClaimLabels)"), "beside the strip, after the read it shares");
  assert.equal(call.test("  // recordRouteOutcomesOnHost({ listed: closedClaimLabels !== null, ...)"), false, "the marker does not take a comment for a call");
});
