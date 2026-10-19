// no-token: gh
//
// Nothing here reaches the network or a real `gh`. The tick under test runs from a temporary `src/` whose `work-gate.ts` and `wake.ts` are stubs
// (the `wake` one records what it was handed), with the PATH pointed at an empty directory. ERASABLE TYPESCRIPT ONLY: node strips the types itself.

/**
 * a11ign/a11ign#3567, split by agent-org#1208: a tick over `TICK_SLOW_SECONDS` is RECORDED, as an edit of one standing comment, and wakes nobody; a tick killed
 * by the timeout still wakes `ceo` once, read by the NEXT tick from the start marker it left. The control comes first (a 60 s tick writes nothing), then
 * 181 s is one edit and no order, a refused write is a state the next tick retries, and a dead tick's marker still says it once and is cleared.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEARTBEAT_COMMENT_ID, writeHeartbeat } from "./work-tick.ts";
import { SIGNALS } from "./org-health/thresholds.ts";
import { orgHealthOrders, orgHealthReadings } from "./org-health/fleet-build-readings.ts";
import { tickRecordReading, tickWallReading } from "./org-health/claim-refusal.ts";
import { tickHealthFooter } from "./trace/trace.ts";
import { createRow } from "./ticket-port/approved-unqueued-reads.ts";
import { ORG_HEALTH_CLASSES } from "./work-gate/org-health-suppression.ts";
import { workGateSource } from "./lib/work-gate-source.ts";
import { TICK_KILLED, TICK_MARKER_FILE, TICK_OVERRAN, TICK_RECORD_FILE, TICK_RECORD_MARKER, TICK_RECORD_TABLE_ROWS, TICK_SLOW_SECONDS, clearOwnMarker,
  deliverTickOrders, isSlowTick, killedTickOrders, parseCostLines, percentile, readKilledTick, readMarker, readTickRecordState, recordSlowTick, renderTickRecord,
  slowThresholdSeconds, standingRowFor, tickHealthLine, tickHealthOf, tickMarkerPath, tickRecordOf, tickRecordTargetFrom, tickRecordUnwrittenLine, tickWallIsHigh,
  overranWakesOf, TICK_RECORD_ROW_TITLE, tickRecordRowBody, phaseMarker, writeStartMarker, type CostLine, type RecordIo } from "./work-tick-health.ts";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const PRELOAD = join(SRC, "lib", "crash-exit.ts");
const COST_PATH = "/state/agent-org/tick-cost.jsonl";
const START = Date.parse("2026-10-04T21:40:04Z");

/** A `tick-cost` line as `work-tick.ts` writes it, with only what the health reading reads; `wallS` is the wall in seconds. */
const costLine = (wallS: number, extra: Record<string, unknown> = {}) => ({
  at: START + wallS * 1000, wallMs: wallS * 1000, prestartMs: null, cpuMs: { self: 4000, children: 21_000 },
  phases: { startup: { wallMs: 900, cpuMs: 800 }, gate: { wallMs: wallS * 800, cpuMs: 15_000 }, wake: { wallMs: 700, cpuMs: 100 } }, ...extra,
});
const NOW = START + 3600_000;

/** A record sink that says what it was asked: `calls` in order, an id for `find`, and a `post` that answers `posted`. `fail` makes the named call throw like a refused `gh`. */
function sink({ found = null, posted = null, fail = null }: { found?: number | null; posted?: number | null; fail?: "find" | "post" | "edit" | null } = {}) {
  const calls: string[] = [];
  const bodies: string[] = [];
  const refuse = (name: "find" | "post" | "edit") => { if (fail === name) throw Object.assign(new Error("gh failed"), { stderr: "gh: HTTP 403: Resource not accessible\nsecond line" }); };
  const io: RecordIo = {
    // eslint-disable-next-line clean-code/names-describe-side-effects -- implements RecordIo.find, whose name the type fixes; the fake records the call so the test can check the order
    find: () => { calls.push("find"); refuse("find"); return found; },
    post: (body) => { calls.push("post"); bodies.push(body); refuse("post"); return posted; },
    edit: (id, body) => { calls.push(`edit ${id}`); bodies.push(body); refuse("edit"); },
  };
  return { io, calls, bodies };
}

/** `recordSlowTick` over a temp state file; `costLines` is what the cost file holds. Returns what it did and said. */
function recording(dir: string, line: CostLine | null, io: RecordIo | { refusal: string }, { costLines = line === null ? [] : [line], now = NOW }: { costLines?: CostLine[]; now?: number } = {}) {
  const said: string[] = [];
  const statePath = join(dir, TICK_RECORD_FILE);
  const outcome = recordSlowTick({ line, costText: costLines.map((entry) => JSON.stringify(entry)).join("\n"), now, costPath: COST_PATH, statePath, io, say: (text) => said.push(text) });
  return { outcome, said, state: readTickRecordState(statePath, now), statePath };
}

// --- SLOW: THE CONTROL FIRST ---------------------------------------------------------------------------------------------------------------------

test("#3567 CONTROL: a 60 s tick is not slow, and neither is one of exactly the limit", () => {
  assert.equal(TICK_SLOW_SECONDS, 180, "the limit is the row's named constant");
  assert.equal(isSlowTick(costLine(60)), false);
  assert.equal(isSlowTick(costLine(TICK_SLOW_SECONDS)), false, "over the limit, not at it");
  assert.equal(isSlowTick(costLine(181)), true);
  assert.equal(isSlowTick(costLine(100, { prestartMs: 90_000 })), true, "ExecStartPre counts toward the wall, because `TimeoutStartSec` counts it");
});

test("agent-org#1208 CONTROL: a fast tick with nothing owed touches nothing: no read, no write, no state file", () => inDir((dir) => {
  const { io, calls } = sink();
  const done = recording(dir, costLine(60), io);
  assert.equal(done.outcome, "not-due");
  assert.deepEqual(calls, []);
  assert.equal(existsSync(done.statePath), false);
}));

test("agent-org#1208: a 181 s tick is ONE write to the standing comment and carries no order (the first one posts it, the next ones EDIT it)", () => inDir((dir) => {
  const first = sink();
  const one = recording(dir, costLine(181), first.io);
  assert.equal(one.outcome, "written");
  assert.deepEqual(first.calls, ["find", "post"], "no cached id: look for the comment by its marker once, then post it");
  assert.equal(first.bodies[0].split("\n")[0], TICK_RECORD_MARKER);

  // The comment is now known by id (what `find` answered on a later tick is cached): every later slow tick is an EDIT of that one comment.
  writeFileSync(one.statePath, JSON.stringify({ commentId: 6_100_000_001, unwritten: null }));
  const second = sink();
  const two = recording(dir, costLine(200), second.io);
  assert.equal(two.outcome, "written");
  assert.deepEqual(second.calls, ["edit 6100000001"], "an edit in place: no find, no post, so the row does not grow");
  assert.equal(two.state.commentId, 6_100_000_001);
}));

test("agent-org#1208: the body is the 24 h table: marker first, p50/p95 over EVERY tick of the window, the slow ones listed with their longest phase, older ticks left out", () => {
  const old = costLine(500, { at: NOW - 25 * 3600_000 });
  const lines = [60, 70, 80, 90, 190, 250].map((wallS, index) => costLine(wallS, { at: NOW - (index + 1) * 600_000 }));
  const record = tickRecordOf([old, ...lines], { now: NOW });
  assert.equal(record.ticks, 6, "the 25 h old tick is outside the window");
  assert.equal(record.p50Ms, 80_000);
  assert.equal(record.p95Ms, 250_000);
  assert.deepEqual(record.slow.map((tick) => tick.wallMs), [190_000, 250_000], "the slow ones, newest first");
  const body = renderTickRecord(record, { now: NOW, costPath: COST_PATH });
  assert.equal(body.split("\n")[0], TICK_RECORD_MARKER);
  assert.match(body, /\*\*6\*\* ticks, wall \*\*p50 80\.0 s, p95 250\.0 s\*\*/);
  assert.match(body, /\*\*2\*\* over the 180 s limit/);
  assert.match(body, /\| 190\.0 \| 25\.0 \| `gate` \| 152\.0 \| 15\.0 \|/);
  assert.doesNotMatch(body, /NaN/);
});

test("agent-org#1208: this tick's own line counts once when the cost file holds it and once when appending it failed", () => {
  const own = costLine(181);
  assert.equal(tickRecordOf([own], { now: NOW, current: own }).ticks, 1, "the file holds it: not counted twice");
  assert.equal(tickRecordOf([], { now: NOW, current: own }).ticks, 1, "the file does not: the tick's own line is still the record");
  assert.deepEqual(tickRecordOf([], { now: NOW }), { ticks: 0, p50Ms: null, p95Ms: null, slow: [] }, "no tick is `null`, never a zero");
});

test("agent-org#1208: the table is capped, and the body says how many older slow ticks it left out", () => {
  const lines = Array.from({ length: TICK_RECORD_TABLE_ROWS + 5 }, (_unused, index) => costLine(200, { at: NOW - (index + 1) * 60_000 }));
  const body = renderTickRecord(tickRecordOf(lines, { now: NOW }), { now: NOW, costPath: COST_PATH });
  assert.equal(body.split("\n").filter((row) => row.startsWith("| 20")).length, TICK_RECORD_TABLE_ROWS);
  assert.match(body, /and 5 older slow ticks/);
});

test("agent-org#1208: percentiles are nearest-rank, and an empty list has none", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile(Array.from({ length: 100 }, (_unused, index) => index + 1), 95), 95);
});

test("agent-org#1208: lines of the cost file that are not cost lines (a cut first line, a blank) are skipped, not fatal", () => {
  const good = JSON.stringify(costLine(60));
  assert.equal(parseCostLines(`ms":123}\n\n${good}\n{"at":1}\n`).length, 1);
});

test("#3730: a longest phase some other process timed has a wall and NO CPU, and the table says n/a rather than printing NaN", () => {
  const line = costLine(181);
  line.phases = { ...line.phases, "github-status": { wallMs: 999_999 } } as typeof line.phases;
  const body = renderTickRecord(tickRecordOf([line], { now: NOW }), { now: NOW, costPath: COST_PATH });
  assert.match(body, /`github-status` \| 1000\.0 \| n\/a/);
  assert.doesNotMatch(body, /NaN/);
});

// --- A REFUSED WRITE IS A STATE, RETRIED, AND NEVER A WAKE -----------------------------------------------------------------------------------------

test("agent-org#1208: a refused write is `unwritten` with the reason, said once, and the NEXT tick (a fast one) retries it and clears it", () => inDir((dir) => {
  const refused = sink({ fail: "find" });
  const first = recording(dir, costLine(181), refused.io);
  assert.equal(first.outcome, "unwritten");
  assert.equal(first.state.unwritten?.since, NOW);
  assert.match(first.state.unwritten?.why ?? "", /HTTP 403/);
  assert.doesNotMatch(first.state.unwritten?.why ?? "", /second line/, "one line of what gh said");
  assert.match(first.said.join(""), /TICK RECORD NOT WRITTEN .*the next tick retries it/);

  // A fast tick, later: nothing of its own to say, but the record is owed, so it is retried, and `since` is the FIRST refusal's until a write lands.
  const still = sink({ fail: "post" });
  const second = recording(dir, costLine(60, { at: NOW + 120_000 }), still.io, { now: NOW + 120_000 });
  assert.equal(second.outcome, "unwritten");
  assert.equal(second.state.unwritten?.since, NOW, "the unwritten line says since when, not since the last retry");

  const landing = sink({ found: 42 });
  const third = recording(dir, costLine(60, { at: NOW + 240_000 }), landing.io, { now: NOW + 240_000 });
  assert.equal(third.outcome, "written");
  assert.deepEqual(landing.calls, ["find", "edit 42"]);
  assert.equal(third.state.unwritten, null);
  assert.equal(third.state.commentId, 42);
}));

test("agent-org#1208: an edit refused for a cached id forgets the id, so the retry looks the comment up again (it may have been deleted)", () => inDir((dir) => {
  writeFileSync(join(dir, TICK_RECORD_FILE), JSON.stringify({ commentId: 7, unwritten: null }));
  const done = recording(dir, costLine(181), sink({ fail: "edit" }).io);
  assert.equal(done.outcome, "unwritten");
  assert.equal(done.state.commentId, null);
}));

test("agent-org#1208: a row the project does not declare is a refused write with its reason, and calls nothing", () => inDir((dir) => {
  const done = recording(dir, costLine(181), { refusal: "the project declaration does not declare units.tickRecordIssue" });
  assert.equal(done.outcome, "unwritten");
  assert.match(done.state.unwritten?.why ?? "", /units\.tickRecordIssue/);
}));

test("agent-org#1208: org-health's one line names the reason and since when, and there is none while the record is written", () => {
  assert.equal(tickRecordUnwrittenLine({ commentId: 1, row: null, unwritten: null }, NOW), null);
  const line = tickRecordUnwrittenLine({ commentId: null, row: null, unwritten: { since: NOW - 10 * 60_000, why: "gh: HTTP 403" } }, NOW);
  assert.match(line ?? "", /unwritten since 2026-10-04T22:30:04\.000Z \(10 min\): gh: HTTP 403\. Slow ticks are not being recorded and wake nobody\./);
});

test("agent-org#1208: an unreadable state file is an unwritten record, never a quiet one", () => inDir((dir) => {
  const path = join(dir, TICK_RECORD_FILE);
  writeFileSync(path, "{not json");
  assert.match(readTickRecordState(path, NOW).unwritten?.why ?? "", /not valid JSON/);
  assert.deepEqual(readTickRecordState(join(dir, "absent.json"), NOW), { commentId: null, row: null, unwritten: null }, "CONTROL: no file is nothing owed");
}));

test("agent-org#1208: the standing row is read from `units.tickRecordIssue` in the FIRST tracker's repository, and an absent or malformed one is a reason", () => {
  const declared = (units: object) => JSON.stringify({ tracker: [{ key: "", repo: "a11ign/a11ign" }, { key: "agent-org", repo: "a11ign/agent-org" }], units });
  assert.deepEqual(tickRecordTargetFrom(declared({ tickRecordIssue: 1208 })), { repo: "a11ign/a11ign", issue: 1208 });
  for (const bad of [{ tickRecordIssue: "1208" }, { tickRecordIssue: 0 }, { tickRecordIssue: 1.5 }]) {
    assert.match((tickRecordTargetFrom(declared(bad)) as { refusal: string }).refusal, /units\.tickRecordIssue/, JSON.stringify(bad));
  }
  assert.deepEqual(tickRecordTargetFrom(declared({})), { repo: "a11ign/a11ign", issue: null }, "not declared and none created: nothing named yet, which is the one create");
  assert.deepEqual(tickRecordTargetFrom(declared({}), 77), { repo: "a11ign/a11ign", issue: 77 }, "the row the tick created before is the one it keeps using");
  assert.deepEqual(tickRecordTargetFrom(declared({ tickRecordIssue: 1208 }), 77), { repo: "a11ign/a11ign", issue: 1208 }, "a declared row wins over a kept one");
  assert.match((tickRecordTargetFrom("{not json") as { refusal: string }).refusal, /not valid JSON/);
  assert.match((tickRecordTargetFrom(JSON.stringify({ tracker: [], units: { tickRecordIssue: 1 } })) as { refusal: string }).refusal, /no tracker/);
});

test("#3567: the limit is overridable only by a positive number, and a bad one falls back to the constant", () => {
  assert.equal(slowThresholdSeconds({}), TICK_SLOW_SECONDS);
  assert.equal(slowThresholdSeconds({ A11Y_TICK_SLOW_SECONDS: "2" }), 2);
  for (const bad of ["", "0", "-5", "soon"]) assert.equal(slowThresholdSeconds({ A11Y_TICK_SLOW_SECONDS: bad }), TICK_SLOW_SECONDS, bad);
});

// --- ORG-HEALTH CARRIES THE ONE LINE (agent-org#1208) ----------------------------------------------------------------------------------------------

const HEALTH_FACTS = { now: NOW, lastMergedAt: NOW - 600_000, work: null, redPrs: [], refusals: {}, drift: null, primarySince: null };
const UNWRITTEN = { commentId: null, row: null, unwritten: { since: NOW - 30 * 60_000, why: "gh: HTTP 403" } };

test("agent-org#1208: the reading is clear while the record is written and trips, with the reason and the first refusal's time, while it is not", () => {
  assert.equal(tickRecordReading({ now: NOW, state: { commentId: 5, row: null, unwritten: null } }).status, "clear");
  const tripped = tickRecordReading({ now: NOW, state: UNWRITTEN });
  assert.equal(tripped.status, "tripped");
  assert.match(tripped.detail, /unwritten since .*\(30 min\): gh: HTTP 403/);
  assert.equal(tripped.firstTrippedAt, UNWRITTEN.unwritten.since);
  assert.equal(tripped.discriminator, `${SIGNALS.TICK_RECORD_UNWRITTEN}@2026-10-04`, "one outage is one key for the day, however many ticks retry");
});

test("agent-org#1208: through `orgHealthReadings` an unwritten record is an order to ceo that names the reason, and a caller that does not ask adds no reading", () => {
  const orders = orgHealthOrders(orgHealthReadings({ ...HEALTH_FACTS, tickRecord: UNWRITTEN } as never)).filter((order) => order.subject === SIGNALS.TICK_RECORD_UNWRITTEN);
  assert.deepEqual(orders.map((order) => order.session), ["ceo"]);
  assert.match(orders[0].prompt, /HTTP 403/);
  assert.doesNotMatch(orders[0].prompt, /undefined/);
  const quiet = orgHealthOrders(orgHealthReadings({ ...HEALTH_FACTS, tickRecord: { commentId: 1, row: null, unwritten: null } } as never)).filter((order) => order.subject === SIGNALS.TICK_RECORD_UNWRITTEN);
  assert.deepEqual(quiet, [], "CONTROL: a written record orders nothing");
  const unasked = orgHealthOrders(orgHealthReadings(HEALTH_FACTS as never)).filter((order) => order.subject === SIGNALS.TICK_RECORD_UNWRITTEN);
  assert.deepEqual(unasked, []);
});

test("agent-org#1208: the class is a DIGEST, which rides the next order and wakes `ceo` only on churn: an unwritten record is never a wake per overrun", () => {
  assert.equal(ORG_HEALTH_CLASSES[SIGNALS.TICK_RECORD_UNWRITTEN].severity, "digest");
});

test("agent-org#1208: WIRING: the gate hands `orgHealthNow` the real record state, so the line is not dead for want of a fact (#2980's lesson)", () => {
  assert.match(workGateSource(), /readTickRecord: \(\) => readTickRecordState\(stateEntryPath\(TICK_RECORD_FILE\)\)/);
});

// --- KILLED: THE MARKER ------------------------------------------------------------------------------------------------------------------------

/** A pid that belonged to a process that has ended. */
function deadPid(): number {
  const ran = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(ran.stdout);
}

function inDir<T>(use: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "tick-health-"));
  try {
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#3567: no marker is no killed tick, and a marker whose process ENDED is one", () => inDir((dir) => {
  const path = join(dir, TICK_MARKER_FILE);
  assert.equal(readKilledTick(path), null, "CONTROL: nothing there");
  writeStartMarker(path, { at: START, pid: deadPid() });
  assert.deepEqual(readKilledTick(path), { at: START, pid: readMarker(path)?.pid, unreadable: false, phase: null, phaseAt: null });
}));

test("#3567: a marker whose process is still ALIVE is a tick running beside this one, not a killed one", () => inDir((dir) => {
  const path = join(dir, TICK_MARKER_FILE);
  // The worker's PARENT, which is alive: asking about a pid is `process.kill(pid, 0)`, and rstest's worker throws on that call for its own pid.
  writeStartMarker(path, { at: START, pid: process.ppid });
  assert.equal(readKilledTick(path), null);
}));

test("#3567: a marker that cannot be parsed is STILL a killed tick, said to be unreadable, and not a quiet one", () => inDir((dir) => {
  const path = join(dir, TICK_MARKER_FILE);
  writeFileSync(path, '{"at": 17');
  const marker = readKilledTick(path);
  assert.equal(marker?.unreadable, true);
  const [order] = killedTickOrders(marker, { foundAt: Date.now() + 5000, costPath: COST_PATH });
  assert.match(order.prompt, /MARKER WAS UNREADABLE/);
}));

test("#3567: a tick clears only ITS OWN marker", () => inDir((dir) => {
  const path = join(dir, TICK_MARKER_FILE);
  writeStartMarker(path, { at: START, pid: 4242 });
  clearOwnMarker(path, process.pid);
  assert.equal(existsSync(path), true, "another process's marker is left for its reader");
  clearOwnMarker(path, 4242);
  assert.equal(existsSync(path), false);
  clearOwnMarker(path, 4242); // idempotent
}));

test("#3567: a killed tick's order names when it started and how long it ran at most, once per start time", () => {
  assert.deepEqual(killedTickOrders(null, { foundAt: START, costPath: COST_PATH }), [], "CONTROL: no marker, no order");
  const found = START + 613_000;
  const [order] = killedTickOrders({ at: START, pid: 1, unreadable: false, phase: null, phaseAt: null }, { foundAt: found, costPath: COST_PATH });
  assert.equal(order.session, "ceo");
  assert.equal(order.subject, TICK_KILLED);
  assert.match(order.prompt, /started at 2026-10-04T21:40:04\.000Z never finished/);
  assert.match(order.prompt, /at most 613\.0 s/);
  assert.equal(order.causeKey, `ceo/${TICK_OVERRAN}/${TICK_KILLED}-${START}`);
});

test("#1542: a killed tick's marker names the phase it was in, and the order says how long it had been in it", () => inDir((dir) => {
  const path = join(dir, TICK_MARKER_FILE);
  // The real writer: `phaseMarker` stamps `phaseAt` with the clock, so the finding instant is read off the marker and 511 s is added to it.
  phaseMarker(path, { at: START, pid: deadPid() })("recover");
  const marker = readKilledTick(path);
  assert.equal(marker?.phase, "recover");
  const foundAt = (marker?.phaseAt ?? NaN) + 511_000;
  const [order] = killedTickOrders(marker, { foundAt, costPath: COST_PATH });
  assert.match(order.prompt, /recover/);
  assert.match(order.prompt, /8 m 31 s/);
  assert.match(order.prompt, /It was in phase "recover" for at most 8 m 31 s/);
  assert.equal(order.causeKey, `ceo/${TICK_OVERRAN}/${TICK_KILLED}-${START}`);
}));

test("#1542: a marker with only `{at,pid}` gets today's prompt, said to name no phase, under the same causeKey", () => inDir((dir) => {
  const path = join(dir, TICK_MARKER_FILE);
  writeStartMarker(path, { at: START, pid: deadPid() });
  const marker = readKilledTick(path);
  assert.equal(marker?.phase, null, "CONTROL: an older marker names no phase");
  const [order] = killedTickOrders(marker, { foundAt: START + 613_000, costPath: COST_PATH });
  assert.match(order.prompt, /No phase was recorded, so the marker cannot say where it was killed\./);
  assert.match(order.prompt, /A killed tick writes no cost line, so look at the ones before it:/, "today's advice is kept");
  assert.doesNotMatch(order.prompt, /It was in phase/);
  assert.equal(order.causeKey, `ceo/${TICK_OVERRAN}/${TICK_KILLED}-${START}`);
}));

test("#1542: a marker is replaced WHOLE at each boundary through a temporary file, and a refused write leaves the old one whole", () => inDir((dir) => {
  const path = join(dir, TICK_MARKER_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  writeStartMarker(path, { at: START, pid: 4242, phase: "gate", phaseAt: START });
  mkdirSync(temporary); // a directory where the temporary file goes: the write is refused before the rename
  assert.throws(() => writeStartMarker(path, { at: START, pid: 4242, phase: "version", phaseAt: START + 1 }));
  assert.equal(readMarker(path)?.phase, "gate", "CONTROL: the refused write left the marker as it was, whole");
  rmSync(temporary, { recursive: true });
  writeStartMarker(path, { at: START, pid: 4242, phase: "version", phaseAt: START + 1 });
  assert.equal(readMarker(path)?.phase, "version");
  assert.equal(readMarker(path)?.phaseAt, START + 1);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "the rename leaves no temporary file behind");
}));

test("#1542: a phase write that cannot be made does not throw, is SAID once, and the tick goes on", () => inDir((dir) => {
  const said: string[] = [];
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "");
  const phase = phaseMarker(join(blocker, TICK_MARKER_FILE), { at: START, pid: 4242 }, (text) => said.push(text));
  assert.doesNotThrow(() => phase("gate"));
  assert.doesNotThrow(() => phase("wake"));
  assert.equal(said.length, 1, "said once, not per phase");
  assert.match(said[0], /TICK PHASE NOT RECORDED at .*A killed tick will not say which phase it was in\./);
  const good: string[] = [];
  phaseMarker(join(dir, "fine", TICK_MARKER_FILE), { at: START, pid: 4242 }, (text) => good.push(text))("gate");
  assert.deepEqual(good, [], "CONTROL: a marker that can be written says nothing");
  assert.equal(readMarker(join(dir, "fine", TICK_MARKER_FILE))?.phase, "gate");
}));

// --- DELIVERY ----------------------------------------------------------------------------------------------------------------------------------

test("#3567: delivery hands `wake` one JSON line per order, and a `wake` that refuses is SAID, never swallowed", () => {
  const [order] = killedTickOrders({ at: START, pid: 1, unreadable: false, phase: null, phaseAt: null }, { foundAt: START + 613_000, costPath: COST_PATH });
  const said: string[] = [];
  const seen: { input: string }[] = [];
  const fake = (status: number) => ((_node: string, _args: string[], options: { input: string }) => { seen.push(options); return { status, stdout: "", stderr: "" }; }) as unknown as typeof spawnSync;
  assert.equal(deliverTickOrders([], { node: "n", args: [], spawn: fake(0), say: (text) => said.push(text) }), false, "no order, no wake");
  assert.equal(seen.length, 0);
  assert.equal(deliverTickOrders([order], { node: "n", args: [], spawn: fake(0), say: (text) => said.push(text) }), true);
  assert.deepEqual(JSON.parse(seen[0].input), order);
  assert.deepEqual(said, []);
  const refused: string[] = [];
  assert.equal(deliverTickOrders([order], { node: "n", args: [], spawn: fake(1), say: (text) => refused.push(text) }), false);
  assert.match(refused.join(""), /TICK HEALTH NOT DELIVERED \(tick-killed\).*nowhere to go/);
});

// --- THROUGH THE REAL TICK ---------------------------------------------------------------------------------------------------------------------

/** A tick run from a temporary `src/`, whose `wake` appends whatever it is handed to `delivered.jsonl` beside the ledger. */
function tickIn(dir: string, gate = "process.exit(0);") {
  const src = join(dir, "src");
  mkdirSync(src);
  writeFileSync(join(src, "package.json"), '{"type":"module"}'); // tsx reads a loose .ts as CommonJS without it, and a .mjs it reaches then fails on its top-level await
  const own = new Set(["work-tick.ts", "work-gate.ts", "wake.ts"]);
  for (const name of readdirSync(SRC).filter((entry) => !own.has(entry))) symlinkSync(join(SRC, name), join(src, name));
  writeFileSync(join(src, "work-tick.ts"), readFileSync(join(SRC, "work-tick.ts"), "utf8"));
  writeFileSync(join(src, "work-gate.ts"), gate);
  writeFileSync(join(src, "wake.ts"),
    `export * from ${JSON.stringify(join(SRC, "wake.ts"))};\n`
    + `import { appendFileSync, readFileSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\n`
    + `if (process.argv[1] === fileURLToPath(import.meta.url)) appendFileSync(${JSON.stringify(join(dir, "delivered.jsonl"))}, readFileSync(0, "utf8"));\n`);
  mkdirSync(join(dir, "empty"));
  const ledger = join(dir, "ledger.jsonl");
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
    const base: NodeJS.ProcessEnv = { ...process.env, PATH: join(dir, "empty"), GH_CONFIG_DIR: "", ...extra }; // (#4148) none: a tick given an account directory probes GitHub and writes a read-cache under it; these tests must do neither
    delete base.INVOCATION_ID;
    return base;
  };
  const args = [`--import=${PRELOAD}`, join(src, "work-tick.ts"), `--ledger=${ledger}`];
  return {
    marker: tickMarkerPath(ledger),
    recordState: join(dirname(ledger), TICK_RECORD_FILE),
    run: (extra?: NodeJS.ProcessEnv) => spawnSync(process.execPath, args, { encoding: "utf8", cwd: dir, env: env(extra) }),
    runUntilKilled: (killAfterMs: number) => spawnSync(process.execPath, args, { encoding: "utf8", cwd: dir, env: env(), timeout: killAfterMs, killSignal: "SIGKILL" }),
    delivered: () => (existsSync(join(dir, "delivered.jsonl")) ? readFileSync(join(dir, "delivered.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []),
  };
}

test("#3567 CONTROL, through the tick: an ordinary tick tells nobody, and leaves no marker behind", () => inDir((dir) => {
  const tick = tickIn(dir);
  const ran = tick.run();
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(tick.delivered(), []);
  assert.equal(existsSync(tick.marker), false, "a tick that ends by itself clears its marker");
}));

test("agent-org#1208, through the tick: a tick over the limit wakes NOBODY, says its record is unwritten (this tick has no `gh` on its PATH, so the row can be neither written nor created), and clears its marker", () => inDir((dir) => {
  const tick = tickIn(dir, `setTimeout(() => process.exit(0), 1300);`);
  const ran = tick.run({ A11Y_TICK_SLOW_SECONDS: "1" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(tick.delivered(), [], "a slow tick is recorded, not delivered");
  assert.match(ran.stderr, /TICK RECORD NOT WRITTEN/);
  assert.notEqual(readTickRecordState(tick.recordState).unwritten, null, "the refusal is state, which org-health reads");
  assert.equal(existsSync(tick.marker), false);
}));

test("#3567, through the tick: a tick SIGKILLed mid-run leaves its marker, and the NEXT tick reports it ONCE and the one after reports nothing", () => inDir((dir) => {
  // The kill lands after the tsx loader has compiled the tick and written its marker: under a loaded suite that took over 1.2 s.
  const tick = tickIn(dir, `setTimeout(() => process.exit(0), 8000);`);
  const killed = tick.runUntilKilled(4000);
  assert.equal(killed.signal, "SIGKILL");
  assert.equal(existsSync(tick.marker), true, "a killed tick cannot clear its marker, and that is the whole signal");
  assert.notEqual(readMarker(tick.marker)?.phase, null, "the marker names the phase the killed tick had begun (agent-org#1542)");
  assert.deepEqual(tick.delivered(), [], "and it told nobody, which is why the next one must");

  const next = tick.run();
  assert.equal(next.status, 0, next.stderr);
  const delivered = tick.delivered();
  assert.equal(delivered.length, 1, JSON.stringify(delivered));
  assert.equal(delivered[0].subject, TICK_KILLED);
  assert.equal(delivered[0].session, "ceo");
  assert.match(delivered[0].prompt, /It was in phase "/, "the order names the phase");
  assert.equal(existsSync(tick.marker), false, "read, and cleared");

  assert.equal(tick.run().status, 0);
  assert.equal(tick.delivered().length, 1, "a third tick finds nothing: one report per killed tick");
}));

test("#3567, through the tick: a tick whose gate CRASHES clears its marker too, so it is not later reported as killed (`incident:gate-crash` reads a crash)", () => inDir((dir) => {
  const tick = tickIn(dir, `throw new Error("the gate crashed");`);
  const ran = tick.run();
  assert.notEqual(ran.status, 0, "CONTROL: the tick did not complete quietly");
  assert.equal(existsSync(tick.marker), false);
  assert.equal(tick.run().status, ran.status);
  assert.deepEqual(tick.delivered(), [], "and the next tick has no marker to read");
}));

// --- THE HEARTBEAT IS WRITTEN TO EVERY DECLARED TRACKER (a11ign/a11ign#4080, row 2 of #4056) ---------------------------------------------------------

/** `writeHeartbeat` over fake trackers and a fake `gh`: every call it makes, and every line it says on stderr. `refuse` names a repository whose writes `gh` refuses. */
function heartbeatTo(trackers: { key: string; repo: string }[], refuse: string[] = []) {
  const calls: string[] = [];
  const said: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { said.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    writeHeartbeat(1_700_000_000_000, (_file: string, args: string[]) => {
      calls.push(args[2] + " " + args[3]);
      if (refuse.some((repo) => args[3].includes(`repos/${repo}/`))) throw Object.assign(new Error("boom"), { stderr: Buffer.from("gh: HTTP 403") });
      return "";
    }, () => trackers);
  } finally {
    process.stderr.write = write;
  }
  return { calls, said };
}
const HOME = { key: "", repo: "a11ign/a11ign" };
const ORG = { key: "agent-org", repo: "a11ign/agent-org" };
const variableOf = (repo: string) => `PATCH repos/${repo}/actions/variables/GATE_LAST_TICK`;
const commentOf = (repo: string) => `PATCH repos/${repo}/issues/comments/${HEARTBEAT_COMMENT_ID}`;

test("#4080 CONTROL: with ONE declared tracker the heartbeat is the two writes it always was, the variable then the standing comment, both to that repository", () => {
  const { calls, said } = heartbeatTo([HOME]);
  assert.deepEqual(calls, [variableOf(HOME.repo), commentOf(HOME.repo)]);
  assert.deepEqual(said, []);
});

test("#4080: with TWO declared trackers the variable is written to BOTH repositories, and the standing comment to the first only (its id is an object of that repository)", () => {
  const { calls } = heartbeatTo([HOME, ORG]);
  assert.deepEqual(calls, [variableOf(HOME.repo), commentOf(HOME.repo), variableOf(ORG.repo)]);
});

test("#4080: a refusal on the SECOND tracker is a line naming that repository and the first tracker's writes are made; a refusal on the first does not stop the second", () => {
  const second = heartbeatTo([HOME, ORG], [ORG.repo]);
  assert.deepEqual(second.calls, [variableOf(HOME.repo), commentOf(HOME.repo), variableOf(ORG.repo)]);
  assert.equal(second.said.length, 1);
  assert.match(second.said[0], new RegExp(`HEARTBEAT NOT WRITTEN to ${ORG.repo} variable GATE_LAST_TICK: gh: HTTP 403`));
  const first = heartbeatTo([HOME, ORG], [HOME.repo]);
  assert.ok(first.calls.includes(variableOf(ORG.repo)), "the second tracker is written although the first refused");
  assert.equal(first.said.filter((line) => line.includes(HOME.repo)).length, 2, "the variable and the comment each say they were refused, naming the first repository");
});

// --- THE STANDING ROW IS NAMED OR CREATED ONCE (agent-org#1208 done-when 2) -----------------------------------------------------------------------

const DECLARATION = (units: object) => JSON.stringify({ tracker: [{ key: "", repo: "a11ign/a11ign" }], units });

test("agent-org#1208: with no row declared the tick creates the standing row ONCE, keeps its number, and never creates a second", () => inDir((dir) => {
  const statePath = join(dir, TICK_RECORD_FILE);
  const created: string[] = [];
  const create = (repo: string) => { created.push(repo); return 4242; };
  const first = standingRowFor({ declarationText: DECLARATION({}), state: readTickRecordState(statePath, NOW), statePath, create });
  assert.deepEqual(first, { repo: "a11ign/a11ign", issue: 4242 });
  assert.equal(readTickRecordState(statePath, NOW).row, 4242, "the number is on disk before anything else is done with it");
  const second = standingRowFor({ declarationText: DECLARATION({}), state: readTickRecordState(statePath, NOW), statePath, create });
  assert.deepEqual(second, { repo: "a11ign/a11ign", issue: 4242 });
  assert.deepEqual(created, ["a11ign/a11ign"], "ONE create across two ticks");
}));

test("agent-org#1208: a declared row is used and nothing is created; a refused create is a reason, retried next tick, never a wake", () => inDir((dir) => {
  const statePath = join(dir, TICK_RECORD_FILE);
  const never = () => { throw new Error("must not create"); };
  assert.deepEqual(standingRowFor({ declarationText: DECLARATION({ tickRecordIssue: 9 }), state: readTickRecordState(statePath, NOW), statePath, create: never }), { repo: "a11ign/a11ign", issue: 9 });
  const refused = standingRowFor({ declarationText: DECLARATION({}), state: readTickRecordState(statePath, NOW), statePath, create: () => { throw new Error("HTTP 403: label lane:ceo"); } });
  assert.match((refused as { refusal: string }).refusal, /could not be created in a11ign\/a11ign \(HTTP 403: label lane:ceo\)/);
  assert.equal(readTickRecordState(statePath, NOW).row, null, "nothing was recorded for a row that does not exist");
}));

test("agent-org#1208: through recordSlowTick the row is created lazily, only when a write is due, and the comment goes to the row it made", () => inDir((dir) => {
  const statePath = join(dir, TICK_RECORD_FILE);
  const asked: string[] = [];
  const io = () => { asked.push("io"); return { find: () => null, post: () => 1, edit: () => {} } as RecordIo; };
  assert.equal(recordSlowTick({ line: costLine(60), costText: "", now: NOW, costPath: COST_PATH, statePath, io, say: () => {} }), "not-due");
  assert.deepEqual(asked, [], "a fast tick with nothing owed does not ask for the row, so it neither reads the declaration nor creates anything");
  assert.equal(recordSlowTick({ line: costLine(181), costText: "", now: NOW, costPath: COST_PATH, statePath, io, say: () => {} }), "written");
  assert.deepEqual(asked, ["io"]);
}));

// --- THE TWO HEALTH SIGNALS, FROM THE ONE RECORD (agent-org#1208 done-when 5) -------------------------------------------------------------------

const HEALTH_NOW = NOW;
const ledgerLine = (agoMs: number, subject: string, cause = TICK_OVERRAN) => `${HEALTH_NOW - agoMs}\tceo/${cause}/${subject}\tceo`;

test("agent-org#1208: tick-overran wakes per day are counted by case from the ledger, a slow wake reads 0 once none is made, and the window is 24 h", () => {
  const ledger = [ledgerLine(60_000, `${TICK_KILLED}-1`), ledgerLine(2 * 3_600_000, `${TICK_KILLED}-2`), ledgerLine(25 * 3_600_000, `${TICK_KILLED}-3`),
    ledgerLine(60_000, "tick-slow-4"), ledgerLine(60_000, "ci-failed-5", "pr-ci"), "garbage", ""].join("\n");
  assert.deepEqual(overranWakesOf(ledger, { now: HEALTH_NOW }), { slow: 1, killed: 2 }, "the day-old killed wake and the other cause are outside it");
  assert.deepEqual(overranWakesOf(ledgerLine(60_000, `${TICK_KILLED}-1`), { now: HEALTH_NOW }), { slow: 0, killed: 1 }, "slow reads 0 when no slow wake was made");
});

test("agent-org#1208: the p50/p95 are read from the record's own cost file, and one line says them with the wakes per day", () => {
  const lines = [60, 70, 80, 90, 100, 110, 120, 130, 140, 250].map((seconds, index) => JSON.stringify({ ...costLine(seconds), at: HEALTH_NOW - (index + 1) * 60_000 }));
  const health = tickHealthOf({ costText: lines.join("\n"), ledgerText: ledgerLine(60_000, `${TICK_KILLED}-1`), now: HEALTH_NOW });
  assert.deepEqual([health.ticks, health.p50Ms, health.p95Ms, health.slow], [10, 100_000, 250_000, 1]);
  assert.deepEqual(health.wakes, { slow: 0, killed: 1 });
  assert.equal(tickWallIsHigh(health), true, "p95 250 s is past the 180 s limit");
  assert.match(tickHealthLine(health), /over 10 ticks in 24 h: p50 100\.0 s, p95 250\.0 s \(limit 180 s; 1 over it, recorded on the standing row and waking nobody\); tick-overran wakes per day: slow 0, killed 1/);
  const unread = tickHealthOf({ costText: lines.join("\n"), ledgerText: null, now: HEALTH_NOW });
  assert.equal(unread.wakes, null, "an unreadable ledger is not a zero");
  assert.match(tickHealthLine(unread), /wakes per day: not read/);
});

test("agent-org#1208: the org-health wall reading is clear below the limit (and still carries the figures), trips once a day above it, and is a DIGEST", () => {
  const fast = tickHealthOf({ costText: [60, 70, 80].map((s, i) => JSON.stringify({ ...costLine(s), at: HEALTH_NOW - (i + 1) * 60_000 })).join("\n"), ledgerText: "", now: HEALTH_NOW });
  const clear = tickWallReading({ day: "2026-10-04", health: fast });
  assert.equal(clear.status, "clear");
  assert.match(clear.detail, /p50 70\.0 s, p95 80\.0 s/);
  const slow = tickHealthOf({ costText: [60, 70, 200, 300].map((s, i) => JSON.stringify({ ...costLine(s), at: HEALTH_NOW - (i + 1) * 60_000 })).join("\n"), ledgerText: "", now: HEALTH_NOW });
  const tripped = tickWallReading({ day: "2026-10-04", health: slow });
  assert.equal(tripped.status, "tripped");
  assert.equal(tripped.discriminator, `${SIGNALS.TICK_WALL_HIGH}@2026-10-04`);
  assert.equal(tickWallReading({ day: "2026-10-04", health: null }).status, "clear", "no cost file is the tick's own line to say, not this reading's");
  assert.equal(tickWallReading({ day: "2026-10-04", health: tickHealthOf({ costText: "", ledgerText: "", now: HEALTH_NOW }) }).status, "clear");
  assert.equal(ORG_HEALTH_CLASSES[SIGNALS.TICK_WALL_HIGH].severity, "digest");
  const orders = orgHealthOrders(orgHealthReadings({ ...HEALTH_FACTS, tickHealth: slow } as never)).filter((order) => order.subject === SIGNALS.TICK_WALL_HIGH);
  assert.equal(orders.length, 1);
  assert.equal(orgHealthOrders(orgHealthReadings({ ...HEALTH_FACTS, tickHealth: fast } as never)).filter((order) => order.subject === SIGNALS.TICK_WALL_HIGH).length, 0);
});

test("agent-org#1208: the weekly report prints the same two figures from the same files, and says so when the cost file is unreadable", () => inDir((dir) => {
  writeFileSync(join(dir, "tick-cost.jsonl"), [60, 250].map((s, i) => JSON.stringify({ ...costLine(s), at: HEALTH_NOW - (i + 1) * 60_000 })).join("\n"));
  writeFileSync(join(dir, "wake-ledger"), `${ledgerLine(60_000, `${TICK_KILLED}-1`)}\n`);
  const [line] = tickHealthFooter(dir, HEALTH_NOW);
  assert.match(line, /^TICK HEALTH \(last 24 h, the record's own cost file\): tick wall over 2 ticks in 24 h: p50 60\.0 s, p95 250\.0 s .*tick-overran wakes per day: slow 0, killed 1$/);
  assert.match(tickHealthFooter(join(dir, "absent"), HEALTH_NOW)[0], /^TICK HEALTH: not read: .*tick-cost\.jsonl could not be read$/);
}));

test("agent-org#1208: the created row is `lane:ceo` with NO `ready` label, its number is read from the printed URL, and its body names the declaration key", () => {
  let argv: string[] = [];
  const number = createRow({ repo: "a11ign/a11ign", title: "t", labels: ["lane:ceo"], body: "b", run: (args) => { argv = args; return "https://github.com/a11ign/a11ign/issues/4321\n"; } });
  assert.equal(number, 4321);
  assert.deepEqual(argv.filter((arg, index) => argv[index - 1] === "--label"), ["lane:ceo"], "one label, the lane; `ready` would offer the row as work");
  assert.throws(() => createRow({ repo: "a/b", title: "t", labels: [], body: "b", run: () => "created" }), /printed no row URL/, "a create with no number is never taken for one");
  assert.match(tickRecordRowBody(), /units\.tickRecordIssue/);
  assert.match(TICK_RECORD_ROW_TITLE, /^Tick record/);
});
