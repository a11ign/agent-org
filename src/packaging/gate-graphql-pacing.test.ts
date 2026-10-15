// no-token: gh -- imports `work-gate/pacing.ts`, which reads the GraphQL pool through an injected `run`; every probe here is a stub, and nothing is spawned (agent-org#1240)
/**
 * agent-org#1240: THE GATE PACES ITS GRAPHQL SPEND AGAINST A NAMED RESERVE, AND A WEBHOOK TICK READS THE OTHER REPOSITORIES ONLY WHERE ITS EVENTS NAMED THEM.
 *
 * Each rule is pinned by a positive assertion and a RED CONTROL: the same rule with its condition removed, which the assertion must refuse.
 *   - the flag is OFF by default, and a poll tick or a test's `run` reads every repository as it always has;
 *   - below the reserve the pool is paced, at the reserve it is not (the boundary is named, not implied);
 *   - agent-org#1417: between the floor and the reserve a paced tick skips `orgHealth` and still reads the other repositories; below the floor it skips both;
 *   - a paced tick names what it did not read, and never names nothing;
 *   - a webhook tick reads a repository its events named, and one due a sweep, and no other;
 *   - a repository an event-gated tick drops is REPORTED unread, with its reason, as a paced skip is;
 *   - an event-gated tick that names neither the home repository nor a due sweep skips the primary's tracker lanes and `orgHealth`, and reports both;
 *   - agent-org#1401: a tick that SKIPPED the primary's lanes by pacing reads none of them as refused, and a refused primary lane is still named as refused;
 *   - the sweep is every `GRAPHQL_SWEEP_MINUTES`, and a repository read inside that window is not read again;
 *   - the memory of read times survives a write of another repository's, and a missing or malformed file reads every repository;
 *   - agent-org#1418: a repository whose whole read is older than the sweep plus one tick is tripped and named with its age, a fresh one is clear, and a missing stamp is UNKNOWN, each with its own output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRAPHQL_FLOOR, GRAPHQL_RESERVE, GRAPHQL_SWEEP_MINUTES, OTHER_SCOPES_MEMORY, PACING_FLAG, orgHealthSkipped, pacedUnread, pacingNow, pacingOn, primaryRefusedLanes, primaryUnread, readOtherScopesMemory, rememberOtherScopes, scopesToRead } from "../work-gate/pacing.ts";
import { defaultRun, eventGateOf, eventUnreadForTick, otherScopesForTick, otherScopesToRead, primaryDue, primaryLanes, readOpenRows, unreadScopes, type GateFacts } from "../work-gate/reads.ts";
import type { Scope as TickScope } from "../event-queue.ts";
import type { Scope } from "../work-gate/vocabulary.ts";
import { SIGNALS, emptyCanaryState, sweepOverdueReading, withMachineryFlag, type CanaryIo } from "../org-health.ts";
import { EXIT as GATE_EXIT, offeredByShare, tickLanes } from "../work-gate.ts";
import { exitPartial, outageThisTick } from "../work-gate/tick.ts";
import { claimStallsNow } from "../work-gate/claim-stall-tick.ts";
import { loadAllowlist, normaliseLine } from "../repeating-lines.ts";
import { workGateSource } from "../lib/work-gate-source.ts";

const MINUTE = 60_000;
const NOW = Date.parse("2026-10-12T12:00:00Z");

/** A `gh api graphql -i` answer carrying the pool's headers, as `poolFromHeaders` reads them. */
const answer = (remaining: number) => `HTTP/2.0 200 OK\nX-Ratelimit-Limit: 5000\nX-Ratelimit-Remaining: ${remaining}\nX-Ratelimit-Resource: graphql\nX-Ratelimit-Reset: 1800000000\n\n{"data":{}}`;

/** A `run` that answers with `remaining` and counts its calls, so "the probe was never made" is itself a checked fact. */
function probe(remaining: number | null) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (remaining === null) throw Object.assign(new Error("refused"), { stdout: "" });
    return answer(remaining);
  };
  return { run, calls };
}

/** A declared other repository: its key, and the code and tracker repositories it names. */
const scope = (key: string, code: string | null, tracker: string | null): Scope => ({ key, code: code === null ? null : { repo: code }, tracker: tracker === null ? null : { repo: tracker } });

test("the flag is OFF by default: a canary state with no record for it is OFF, and a state that cannot be read is OFF too", () => {
  assert.equal(pacingOn(() => emptyCanaryState()), false);
  assert.equal(pacingOn(() => withMachineryFlag(emptyCanaryState(), { name: PACING_FLAG, on: false })), false);
  // RED CONTROL: the same state with the flag switched on IS on, so a `pacingOn` that always answered false would fail the line above
  assert.equal(pacingOn(() => withMachineryFlag(emptyCanaryState(), { name: PACING_FLAG, on: true })), true);
  assert.equal(pacingOn(() => { throw new Error("no state directory"); }), false);
  assert.equal(PACING_FLAG, "gate.graphqlPacing");
});

test("flag OFF reads nothing and paces nothing, even on a pool the reserve would refuse", () => {
  const { run, calls } = probe(GRAPHQL_RESERVE - 1);
  assert.deepEqual(pacingNow(run, false), { paced: false, belowFloor: false, remaining: null });
  assert.equal(calls.length, 0, "the probe is not made with the flag off");
  // RED CONTROL: the same pool, flag on, IS paced: the flag is the only thing that stood between this tick and the skip
  assert.equal(pacingNow(probe(GRAPHQL_RESERVE - 1).run, true).paced, true);
});

test("the reserve is a boundary: below it the pool is paced, at it the pool is not", () => {
  assert.equal(GRAPHQL_RESERVE, 1000, "the reserve is named, and the PR says so");
  assert.deepEqual(pacingNow(probe(999).run, true), { paced: true, belowFloor: false, remaining: 999 });
  assert.deepEqual(pacingNow(probe(1000).run, true), { paced: false, belowFloor: false, remaining: 1000 });
  // RED CONTROL: a reserve of zero would pace nothing at 999, and this assertion would refuse it
  assert.notEqual(pacingNow(probe(999).run, true).paced, false);
});

test("a probe that cannot be read is not paced: the reads then refuse on their own and are reported as they are", () => {
  assert.deepEqual(pacingNow(probe(null).run, true), { paced: false, belowFloor: false, remaining: null });
  // RED CONTROL: a pool read as 0 IS paced, so the null case above is not paced by the same rule
  assert.equal(pacingNow(probe(0).run, true).paced, true);
});

test("a paced tick names what it did not read, and a tick that was not paced names nothing", () => {
  assert.deepEqual(pacedUnread({ paced: true, belowFloor: true, remaining: 10 }, true), ["the other repositories' lanes", "the org-health reads"]);
  // a one-project host has no other repositories to be unread, so only the org-health reads are named
  assert.deepEqual(pacedUnread({ paced: true, belowFloor: true, remaining: 10 }, false), ["the org-health reads"]);
  assert.deepEqual(pacedUnread({ paced: false, belowFloor: false, remaining: 5000 }, true), []);
  // RED CONTROL: a paced tick that named nothing would read as clean, which is the defect the row forbids
  assert.notDeepEqual(pacedUnread({ paced: true, belowFloor: true, remaining: 10 }, false), []);
});

test("agent-org#1417: above the reserve nothing is paced; between the floor and the reserve only orgHealth is skipped; below the floor the other repositories go too", () => {
  assert.equal(GRAPHQL_FLOOR, 500, "the floor is named, and the PR says so");
  assert.ok(GRAPHQL_FLOOR < GRAPHQL_RESERVE, "the floor sits BELOW the reserve, so the bands are ordered");
  const band = (remaining: number) => pacingNow(probe(remaining).run, true);
  // above the reserve: nothing is paced, and every repository is read
  assert.deepEqual(band(GRAPHQL_RESERVE), { paced: false, belowFloor: false, remaining: GRAPHQL_RESERVE });
  // between: orgHealth is skipped, and the other repositories are NOT named unread, because they are read
  assert.deepEqual(band(GRAPHQL_RESERVE - 1), { paced: true, belowFloor: false, remaining: GRAPHQL_RESERVE - 1 });
  assert.deepEqual(band(GRAPHQL_FLOOR), { paced: true, belowFloor: false, remaining: GRAPHQL_FLOOR });
  assert.deepEqual(pacedUnread(band(GRAPHQL_FLOOR + 1), true), ["the org-health reads"]);
  assert.equal(orgHealthSkipped(band(GRAPHQL_FLOOR + 1), true), true);
  // below the floor: both are skipped and both are named
  assert.deepEqual(band(GRAPHQL_FLOOR - 1), { paced: true, belowFloor: true, remaining: GRAPHQL_FLOOR - 1 });
  assert.deepEqual(pacedUnread(band(GRAPHQL_FLOOR - 1), true), ["the other repositories' lanes", "the org-health reads"]);
  // RED CONTROL: the old order (the floor at the reserve) would name the other repositories at 999, and this assertion refuses it
  assert.notDeepEqual(pacedUnread(band(GRAPHQL_RESERVE - 1), true), ["the other repositories' lanes", "the org-health reads"]);
});

test("agent-org#1417: an ambient tick reads the other repositories above the reserve and between the floor and the reserve, and none below the floor", () => {
  // the decision is `otherScopesForTick` and the report is `eventUnreadForTick`: `readOtherScopes` reads exactly the first and `main` reports the second
  const scopes = [scope("a", "org/a-code", "org/a-rows"), scope("b", "org/b-code", null)];
  const named: TickScope[] = [{ repo: "org/a-code", kind: "pr", number: 7 }];
  const above = { belowFloor: false };
  const between = { belowFloor: false };
  const below = { belowFloor: true };
  withScratch((dir) => {
    // b's sweep is DUE: the event gate reads it although no event named it, so the reserve alone decides
    const due = webhookTick(dir, { named, memory: { a: NOW - 2 * MINUTE, b: NOW - 20 * MINUTE } });
    assert.deepEqual(otherScopesForTick(defaultRun, scopes, above, due).map((s) => s.key), ["a", "b"], "above the reserve: both read");
    assert.deepEqual(otherScopesForTick(defaultRun, scopes, between, due).map((s) => s.key), ["a", "b"],
      "between the floor and the reserve: both still read, so the settled-green pull request in b gets its order (RED CONTROL: keyed on `paced` this is [])");
    assert.deepEqual(otherScopesForTick(defaultRun, scopes, below, due), [], "below the floor: none read");
    assert.deepEqual(eventUnreadForTick(below, defaultRun, scopes, due), [], "below the floor the paced skip names them, so nothing is reported twice");

    // b's sweep is NOT due and no event named it: the event gate drops it, and it must be REPORTED, not read as clean
    const fresh = webhookTick(dir, { named, memory: { a: NOW - 2 * MINUTE, b: NOW - MINUTE } });
    assert.deepEqual(otherScopesForTick(defaultRun, scopes, above, fresh).map((s) => s.key), ["a"]);
    assert.deepEqual(otherScopesForTick(defaultRun, scopes, between, fresh).map((s) => s.key), ["a"]);
    assert.deepEqual(eventUnreadForTick(between, defaultRun, scopes, fresh).length, 1, "between: b is reported unread by the event gate");
    assert.match(eventUnreadForTick(between, defaultRun, scopes, fresh)[0], /org\/b-code.*no event named it/);
    assert.deepEqual(otherScopesForTick(defaultRun, scopes, below, fresh), [], "below the floor none are read");
    assert.deepEqual(eventUnreadForTick(below, defaultRun, scopes, fresh), []);

    // flag OFF: no gate, every repository is read and nothing is reported, at any pool
    const off = webhookTick(dir, { named, memory: { a: NOW - 2 * MINUTE, b: NOW - MINUTE }, on: false });
    assert.deepEqual(otherScopesForTick(defaultRun, scopes, above, off).map((s) => s.key), ["a", "b"], "flag off reads all: with the flag off the pool is never paced (belowFloor false)");
    assert.deepEqual(eventUnreadForTick(above, defaultRun, scopes, off), []);
  });
  // a run that is not the gate's own is never paced: a test's or a poll's `run` reads every repository, whatever the pool
  const notAmbient = (_args: string[]) => "";
  assert.deepEqual(otherScopesForTick(notAmbient, scopes, below).map((s) => s.key), ["a", "b"], "a run that is not the gate's own is never paced");
});

test("agent-org#1417: the call sites decide through the helpers, and orgHealth stays on the reserve", () => {
  // the read path itself needs the live pool and the host's declaration, so the call sites are pinned by their text; the rules are pinned by the behaviour above
  const gate = workGateSource().replace(/\s+/g, " ");
  assert.match(gate, /const wanted = otherScopesForTick\(run, scopes, tickPacing\(\)\)/);
  assert.match(gate, /const eventUnread = eventUnreadForTick\(pacing, defaultRun, declaredOthers\)/);
  assert.match(gate, /orgHealthSkipped\(pacing, primaryRead\) \? \[\] : orgHealthTogether/, "orgHealth stays on the reserve");
  // RED CONTROL: the old order skipped the other repositories on `paced`, so that text must NOT be there
  assert.doesNotMatch(gate, /tickPacing\(\)\.paced \? \[\]/);
});

test("a repository no event named, read inside the sweep window, is not read", () => {
  const scopes = [scope("a", "org/a-code", "org/a-rows"), scope("b", "org/b-code", null)];
  const fresh = ({ a: NOW - MINUTE, b: NOW - MINUTE });
  assert.deepEqual(scopesToRead({ scopes, named: [], lastReadAt: fresh, nowMs: NOW }), []);
  // RED CONTROL: with no memory at all every repository is due, so the same empty event list reads both
  assert.deepEqual(scopesToRead({ scopes, named: [], lastReadAt: {}, nowMs: NOW }).map((s) => s.key), ["a", "b"]);
});

test("a repository is read when an event names its code or its tracker repository", () => {
  const scopes = [scope("a", "org/a-code", "org/a-rows"), scope("b", "org/b-code", "org/b-rows")];
  const fresh = ({ a: NOW - MINUTE, b: NOW - MINUTE });
  const byCode = scopesToRead({ scopes, named: [{ repo: "org/a-code", kind: "pr", number: 7 }], lastReadAt: fresh, nowMs: NOW });
  assert.deepEqual(byCode.map((s) => s.key), ["a"]);
  const byTracker = scopesToRead({ scopes, named: [{ repo: "org/b-rows", kind: "issue", number: 3 }], lastReadAt: fresh, nowMs: NOW });
  assert.deepEqual(byTracker.map((s) => s.key), ["b"]);
  // RED CONTROL: a naming that matched nothing would leave both repositories out, which the first assertion of this test already refuses
  assert.notEqual(byCode.length, 0);
});

test("the named list NOT KNOWN (null) reads every repository, as a poll tick does", () => {
  const scopes = [scope("a", "org/a-code", null), scope("b", "org/b-code", null)];
  const fresh = ({ a: NOW, b: NOW });
  assert.deepEqual(scopesToRead({ scopes, named: null, lastReadAt: fresh, nowMs: NOW }).map((s) => s.key), ["a", "b"]);
  // RED CONTROL: `[]` (nothing named) reads none of them, so `null` and `[]` are not the same answer
  assert.deepEqual(scopesToRead({ scopes, named: [], lastReadAt: fresh, nowMs: NOW }), []);
});

test("the sweep reads a repository no event named once it is GRAPHQL_SWEEP_MINUTES old, and not one minute before", () => {
  assert.equal(GRAPHQL_SWEEP_MINUTES, 15, "the sweep interval is named, and the PR says so");
  const scopes = [scope("a", "org/a-code", null)];
  const atBoundary = scopesToRead({ scopes, named: [], lastReadAt: { a: NOW - GRAPHQL_SWEEP_MINUTES * MINUTE }, nowMs: NOW });
  assert.deepEqual(atBoundary.map((s) => s.key), ["a"]);
  const justBefore = scopesToRead({ scopes, named: [], lastReadAt: { a: NOW - (GRAPHQL_SWEEP_MINUTES * MINUTE - 1) }, nowMs: NOW });
  assert.deepEqual(justBefore, []);
  // RED CONTROL: a sweep that never fired would leave the boundary repository unread, which the first assertion refuses
  assert.notDeepEqual(atBoundary, []);
});

test("a repository never read is due at once, so a host with no memory reads whole", () => {
  const scopes = [scope("new", "org/new-code", null)];
  assert.deepEqual(scopesToRead({ scopes, named: [], lastReadAt: {}, nowMs: NOW }).map((s) => s.key), ["new"]);
});

test("the memory keeps every repository's read time, and a missing or malformed file is empty, so every repository is then due", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-pacing-"));
  try {
    const path = join(dir, OTHER_SCOPES_MEMORY);
    assert.deepEqual(readOtherScopesMemory(path), {}, "a missing file is an empty memory");
    rememberOtherScopes({ path, keys: ["a"], nowMs: NOW });
    rememberOtherScopes({ path, keys: ["b"], nowMs: NOW + MINUTE });
    assert.deepEqual(readOtherScopesMemory(path), { a: NOW, b: NOW + MINUTE }, "a write of one repository keeps the others' times");
    // RED CONTROL: a write that replaced the file would have lost `a`, and `a` would then be due at once
    assert.equal(readOtherScopesMemory(path).a, NOW);
    writeFileSync(path, "{not json");
    assert.deepEqual(readOtherScopesMemory(path), {}, "a malformed file reads as empty");
    writeFileSync(path, JSON.stringify({ version: 1, readAtMs: { a: "yesterday" } }));
    assert.deepEqual(readOtherScopesMemory(path), {}, "a non-numeric stamp is dropped, not read as a time");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A WEBHOOK TICK, as the gate reads it: the event queue named `named`, the memory holds `memory` (each key's last whole read), and the flag is `on`.
 * `dir` holds the two files the gate reads from disk, so the tick goes through `readTickScopes` and the memory reader, as it does live.
 */
function webhookTick(dir: string, { named, memory, on = true }: { named: TickScope[]; memory: Record<string, number>; on?: boolean; }): GateFacts {
  const tickScopesPath = join(dir, "tick-scopes.json");
  const memoryPath = join(dir, OTHER_SCOPES_MEMORY);
  writeFileSync(tickScopesPath, JSON.stringify({ version: 1, scopes: named }));
  writeFileSync(memoryPath, JSON.stringify({ version: 1, readAtMs: memory }));
  return { on, webhook: true, tickScopesPath, memoryPath, nowMs: NOW };
}

/** A scratch directory for one test's files, removed when the test ends. */
function withScratch(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "gate-webhook-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HOME = scope("", "org/home-code", "org/home-rows");
const SKIPPED_PRIMARY = { promotableRows: null, chairmanBlocked: null, openRowsRead: null };

test("a webhook tick reads the repository its event named, and REPORTS the one no event named as unread, with its reason", () => {
  withScratch((dir) => {
    const scopes = [scope("a", "org/a-code", "org/a-rows"), scope("b", "org/b-code", null)];
    const tick = webhookTick(dir, { named: [{ repo: "org/a-code", kind: "pr", number: 7 }], memory: { a: NOW - 2 * MINUTE, b: NOW - MINUTE } });
    assert.deepEqual(otherScopesToRead(defaultRun, scopes, tick).map((s) => s.key), ["a"], "only the named repository is read");
    const unread = unreadScopes(defaultRun, scopes, tick);
    assert.equal(unread.length, 1, "the repository the events did not name is reported, not read as clean");
    assert.match(unread[0], /org\/b-code/);
    assert.match(unread[0], /no event named it/, "the report says why");
    // RED CONTROL: the same tick with the flag OFF reads both and reports nothing, which is the current behaviour
    const off = webhookTick(dir, { named: [{ repo: "org/a-code", kind: "pr", number: 7 }], memory: { a: NOW - 2 * MINUTE, b: NOW - MINUTE }, on: false });
    assert.deepEqual(otherScopesToRead(defaultRun, scopes, off).map((s) => s.key), ["a", "b"]);
    assert.deepEqual(unreadScopes(defaultRun, scopes, off), []);
  });
});

test("a webhook tick reads a repository no event named once its sweep is due, so it is not reported unread", () => {
  withScratch((dir) => {
    const scopes = [scope("b", "org/b-code", null)];
    const due = webhookTick(dir, { named: [], memory: { b: NOW - GRAPHQL_SWEEP_MINUTES * MINUTE } });
    assert.deepEqual(otherScopesToRead(defaultRun, scopes, due).map((s) => s.key), ["b"]);
    assert.deepEqual(unreadScopes(defaultRun, scopes, due), []);
    // RED CONTROL: one minute before the sweep the same repository is dropped and reported
    const fresh = webhookTick(dir, { named: [], memory: { b: NOW - (GRAPHQL_SWEEP_MINUTES * MINUTE - 1) } });
    assert.deepEqual(otherScopesToRead(defaultRun, scopes, fresh), []);
    assert.equal(unreadScopes(defaultRun, scopes, fresh).length, 1);
  });
});

test("an event-gated tick that named neither the primary nor its sweep skips the primary's tracker lanes and orgHealth, and says so", () => {
  withScratch((dir) => {
    const tick = webhookTick(dir, { named: [{ repo: "org/a-code", kind: "pr", number: 7 }], memory: { "": NOW - MINUTE } });
    let reads = 0;
    const lanes = () => { reads += 1; return { promotableRows: [], chairmanBlocked: [], openRowsRead: [] }; };
    assert.equal(primaryDue(defaultRun, HOME, tick), false);
    assert.deepEqual(primaryLanes(defaultRun, HOME, lanes, SKIPPED_PRIMARY, tick), SKIPPED_PRIMARY, "the lanes are refused, as a refused read is");
    assert.equal(reads, 0, "the tracker lanes are not asked");
    assert.equal(orgHealthSkipped({ paced: false, belowFloor: false, remaining: null }, false), true, "orgHealth is skipped with them");
    assert.deepEqual(primaryUnread({ paced: false, belowFloor: false, remaining: null }, false), ["the primary's tracker lanes (promotable rows, chairman-blocked rows, open rows)", "the org-health reads"]);
    // RED CONTROL: the same tick naming the primary's tracker repository reads them, and orgHealth runs
    const named = webhookTick(dir, { named: [{ repo: "org/home-rows", kind: "issue", number: 3 }], memory: { "": NOW - MINUTE } });
    assert.equal(primaryDue(defaultRun, HOME, named), true);
    assert.deepEqual(primaryLanes(defaultRun, HOME, lanes, SKIPPED_PRIMARY, named), { promotableRows: [], chairmanBlocked: [], openRowsRead: [] });
    assert.equal(reads, 1);
    assert.equal(orgHealthSkipped({ paced: false, belowFloor: false, remaining: null }, true), false);
    assert.deepEqual(primaryUnread({ paced: false, belowFloor: false, remaining: null }, true), []);
  });
});

test("the primary's sweep is due once it is GRAPHQL_SWEEP_MINUTES old, even when no event named it", () => {
  withScratch((dir) => {
    const stale = webhookTick(dir, { named: [], memory: { "": NOW - GRAPHQL_SWEEP_MINUTES * MINUTE } });
    assert.equal(primaryDue(defaultRun, HOME, stale), true);
    // RED CONTROL: a minute younger, nothing named, the primary is skipped
    const fresh = webhookTick(dir, { named: [], memory: { "": NOW - (GRAPHQL_SWEEP_MINUTES * MINUTE - 1) } });
    assert.equal(primaryDue(defaultRun, HOME, fresh), false);
  });
});

test("flag OFF, or a named list that cannot be read, drops nothing and reads the primary: the gate is then the one it always was", () => {
  withScratch((dir) => {
    const scopes = [scope("b", "org/b-code", null)];
    const off = webhookTick(dir, { named: [], memory: { "": NOW, b: NOW }, on: false });
    assert.deepEqual(otherScopesToRead(defaultRun, scopes, off).map((s) => s.key), ["b"]);
    assert.deepEqual(unreadScopes(defaultRun, scopes, off), []);
    assert.equal(primaryDue(defaultRun, HOME, off), true);
    // RED CONTROL: the same tick with the flag on and nothing named DOES drop it, so the flag is what the first assertion turns on
    const on = webhookTick(dir, { named: [], memory: { "": NOW, b: NOW } });
    assert.deepEqual(otherScopesToRead(defaultRun, scopes, on), []);
    // an event file that cannot be read is `null`: every repository is read, as a poll tick reads them
    const unreadable: GateFacts = { ...on, tickScopesPath: join(dir, "no-such-file.json") };
    assert.deepEqual(otherScopesToRead(defaultRun, scopes, unreadable).map((s) => s.key), ["b"]);
    assert.deepEqual(unreadScopes(defaultRun, scopes, unreadable), []);
  });
});

test("agent-org#1353: with no facts given, a host that declares webhook applies the event gate with the pacing flag ABSENT, and a polling host does not", () => {
  withScratch((dir) => {
    const path = join(dir, "tick-scopes.json");
    writeFileSync(path, JSON.stringify({ version: 1, scopes: [] }));
    const before = process.env.A11Y_TICK_SCOPES_FILE;
    process.env.A11Y_TICK_SCOPES_FILE = path;
    try {
      assert.equal(pacingOn(() => emptyCanaryState()), false, "the flag is absent, as it is on the host");
      const run = defaultRun;
      assert.notEqual(eventGateOf(run, undefined, () => true), null, "a webhook host with an empty feed is event-gated without the flag");
      assert.deepEqual(eventGateOf(run, undefined, () => true)?.named, [], "and the gate carries the feed's empty answer");
      // RED CONTROL: a polling host reads whole
      assert.equal(eventGateOf(run, undefined, () => false), null);
    } finally {
      if (before === undefined) delete process.env.A11Y_TICK_SCOPES_FILE;
      else process.env.A11Y_TICK_SCOPES_FILE = before;
    }
  });
});

// ---- agent-org#1414: A LANE SKIPPED BY PACING IS NOT "COULD NOT BE READ" ----------------------------------------------------------------------

/** What `exitPartial` wrote and the code it exited with, with `process.exit` and stderr stood in for. */
function partialSaid(split: { refused: string[]; paced: string[]; }, delivered = 2) {
  const written: string[] = [];
  const realWrite = process.stderr.write, realExit = process.exit;
  process.stderr.write = ((text: string) => { written.push(String(text)); return true; }) as typeof process.stderr.write;
  let code: number | undefined;
  process.exit = ((c: number) => { code = c; throw new Error("exit"); }) as typeof process.exit;
  try {
    exitPartial(split, delivered);
  } catch (err) {
    if ((err as Error).message !== "exit") throw err;
  } finally {
    process.stderr.write = realWrite;
    process.exit = realExit;
  }
  return { line: written.join("").trim(), code };
}

const PACED_LANES = ["the lanes of a11ign/control (no event named it, and it was read less than 15 minutes ago)", "the org-health reads"];

test("agent-org#1414: tickLanes hands the refused and the paced lanes apart, and `unread` is still both", () => {
  const io: CanaryIo = { read: () => null, write: () => {}, fileIncident: () => "https://example.test/1", log: () => {} };
  const lanes = (prs: any[] | null, pacedSkips: { refused: string[]; }[]) =>
    tickLanes({ prs, readyRows: [], others: [], pacedSkips, unarmed: [], releaseRuns: null, run: () => "", now: NOW, dir: "/state", io });
  const allPaced = lanes([], [{ refused: pacedUnread({ paced: true, belowFloor: true, remaining: 10 }, true) }, { refused: [] }]);
  assert.deepEqual(allPaced.refused, []);
  assert.deepEqual(allPaced.paced, ["the other repositories' lanes", "the org-health reads"]);
  assert.deepEqual(allPaced.unread, allPaced.paced, "PARTIAL still names every skipped lane");
  const both = lanes(null, [{ refused: ["the org-health reads"] }]);
  assert.deepEqual(both.refused, ["the pull-request list"]);
  assert.deepEqual(both.paced, ["the org-health reads"]);
  assert.deepEqual(both.unread, ["the pull-request list", "the org-health reads"]);
});

test("agent-org#1414: an all-paced PARTIAL says `skipped by pacing, none refused` and exits PACED; one refused lane keeps `could not read` and PARTIAL", () => {
  const paced = partialSaid({ refused: [], paced: PACED_LANES });
  assert.equal(paced.code, GATE_EXIT.PACED);
  assert.match(paced.line, /^PARTIAL: 2 lane\(s\) skipped by pacing, none refused: /);
  assert.doesNotMatch(paced.line, /could not read/);
  assert.match(paced.line, /NOT examined/, "a skip is still never reported clean");
  // the refused case, with a paced lane beside it: the refusal decides
  const refused = partialSaid({ refused: ["the Ready rows"], paced: PACED_LANES });
  assert.equal(refused.code, GATE_EXIT.PARTIAL);
  assert.match(refused.line, /^PARTIAL: could not read the Ready rows and the lanes of a11ign\/control/);
  assert.doesNotMatch(refused.line, /skipped by pacing/);
  assert.notEqual(GATE_EXIT.PACED, GATE_EXIT.PARTIAL);
});

test("agent-org#1414: the repeating-lines allowlist matches BOTH all-paced lines and NEITHER refused one", () => {
  const allow = loadAllowlist();
  const matched = (line: string) => allow.some((a) => a.pattern.test(normaliseLine(line)));
  assert.ok(matched(partialSaid({ refused: [], paced: PACED_LANES }).line), "the gate's all-paced line is allowlisted");
  assert.ok(matched(partialSaid({ refused: [], paced: PACED_LANES.slice(1) }, 39).line), "with one lane, and another order count");
  assert.ok(matched("lane(s) skipped by pacing, none refused; see the gate's stderr"), "the tick's reading of it");
  // POSITIVE CONTROL for the two below: the refused lines are real, and have the same prefix and the same tail
  const refused = partialSaid({ refused: ["the Ready rows"], paced: PACED_LANES });
  assert.match(refused.line, /^PARTIAL: could not read /);
  assert.ok(!matched(refused.line), "the gate's refused line is not allowlisted");
  assert.ok(!matched(partialSaid({ refused: ["the pull-request list"], paced: [] }).line), "nor is a plain refusal");
  assert.ok(!matched("one lane could not be read; see the gate's stderr"), "nor is the tick's refused reading");
});

// agent-org#1401: the paced skip of the primary's lanes was reported as refused reads (OUTAGE, `could not be read -- NO claim`, `NO PRODUCT ROW OFFERABLE`).
// A skipped lane is `null` in the same way a refused one is, so the pacing flag is what tells the two apart. Each assertion below has its RED CONTROL beside it.
test("agent-org#1401: a tick whose primary lanes the pacing SKIPPED reads none of them as refused: no OUTAGE, and no `could not be read -- NO claim` line", () => {
  const nulls = { prs: [], readyRows: [], promotableRows: null, chairmanBlocked: null, openRows: null, claimedComments: [], offBoard: [], others: [] };
  assert.equal(outageThisTick({ ...nulls, primaryRead: false }), false, "the primary was not asked, so its nulls are not a refusal");
  // RED CONTROL: the same nulls with the primary READ are refusals, and OUTAGE fires on them
  assert.equal(outageThisTick({ ...nulls, primaryRead: true }), true);

  const logged: string[] = [];
  const log = (line: string) => logged.push(line);
  claimStallsNow(null, [], [], { openRowsPaced: true, log });
  assert.ok(!logged.join("").includes("could not be read -- NO claim was evaluated"), "a skipped open-rows read is not `could not be read`");
  assert.match(logged.join(""), /the open rows were skipped by pacing this tick -- NO claim was evaluated/);
  // RED CONTROL: the same null with no pacing is a refusal, and is still reported as one
  logged.length = 0;
  claimStallsNow(null, [], [], { openRowsPaced: false, log });
  assert.match(logged.join(""), /could not be read -- NO claim was evaluated/);
});

test("agent-org#1401: the offer says `PRODUCT ROW OFFER NOT READ` for rows the pacing skipped, and `NO PRODUCT ROW OFFERABLE` only for rows that were read", () => {
  const declaration = {
    code: [{ key: "", repo: "a11ign/a11ign" }],
    dora: [{ repo: "a11ign/a11ign", releasablePaths: ["packages/judge/"] }],
  };
  const starts = Array.from({ length: 10 }, (_, i) => ({ at: i, kind: "org" }));
  const org = { number: 20, title: "row 20", labels: [{ name: "ready" }], body: "## Region\n\n```\npackages/guards/src/rule.ts\n```\n\n## Acceptance\n\nA command.\n\n## Open-check\n\nA check.\n" };
  const lineFor = (paced: boolean) => {
    const stateDir = mkdtempSync(join(tmpdir(), "offer-paced-"));
    const lines: string[] = [];
    try {
      offeredByShare([org], { starts, declaration, paced, shareLog: (line: string) => lines.push(line), shareMemory: { stateDir, now: NOW } });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
    return lines.join("");
  };
  assert.equal(lineFor(true), "PRODUCT ROW OFFER NOT READ (share 0/10): the open rows were skipped by pacing this tick\n");
  assert.ok(!lineFor(true).includes("NO PRODUCT ROW OFFERABLE"), "nor a claim that the shelf is empty, which nobody read");
  // RED CONTROL: the same offer with the rows read is the shelf-is-empty line
  assert.match(lineFor(false), /^NO PRODUCT ROW OFFERABLE \(share 0\/10\)/);
});

test("agent-org#1401: a refused primary lane is named on PARTIAL, and a skipped primary names none", () => {
  const io: CanaryIo = { read: () => null, write: () => {}, fileIncident: () => "https://example.test/1", log: () => {} };
  const lanes = (primaryRefused: string[]) =>
    tickLanes({ prs: [], readyRows: [], others: [], pacedSkips: [], primaryRefused, unarmed: [], releaseRuns: null, run: () => "", now: NOW, dir: "/state", io });
  const refused = lanes(["the open rows"]);
  assert.deepEqual(refused.refused, ["the open rows"]);
  assert.deepEqual(refused.unread, ["the open rows"]);
  assert.match(partialSaid({ refused: refused.refused, paced: refused.paced }).line, /^PARTIAL: could not read the open rows\. /);
  // RED CONTROL: a primary the pacing skipped names no refused lane, so PARTIAL does not say `could not read` about it
  assert.deepEqual(lanes([]).refused, []);
});

test("agent-org#1401: primaryRefusedLanes names each primary lane that was asked and came back null, and none when the primary was not asked", () => {
  const allNull = { promotableRows: null, chairmanBlocked: null, openRowsRead: null };
  assert.deepEqual(primaryRefusedLanes(allNull, true), ["the promotable rows", "the chairman-blocked rows", "the open rows"]);
  // RED CONTROL: a primary the pacing skipped names nothing, though its lanes are the same nulls
  assert.deepEqual(primaryRefusedLanes(allNull, false), []);
  assert.deepEqual(primaryRefusedLanes({ promotableRows: [], chairmanBlocked: [], openRowsRead: [] }, true), []);
});

test("agent-org#1401: a refused open-rows read says gh's reason on stderr and still returns null; a read that works says nothing", () => {
  const stderrOf = (run: () => string | void) => {
    const captured: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string) => { captured.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      return { value: run(), said: captured.join("") };
    } finally {
      process.stderr.write = write;
    }
  };
  const refused = stderrOf(() => readOpenRows(() => { throw new Error("HTTP 502: Bad Gateway\nmore"); }, null, { home: false, webhook: false }) as unknown as string);
  assert.equal(refused.value, null);
  assert.equal(refused.said, "NOTE: the open rows could not be read (HTTP 502: Bad Gateway); read as refused\n");
  // RED CONTROL: a read that works is not said to have been refused
  const answered = stderrOf(() => readOpenRows(() => "[]", null, { home: false, webhook: false }) as unknown as string);
  assert.deepEqual(answered.value, []);
  assert.equal(answered.said, "");
});

test("agent-org#1418: a repository unread past the sweep plus one tick is tripped and named with its age; a fresh one is clear; a missing stamp is UNKNOWN", () => {
  const sweeps = (repos: { name: string; readAtMs?: number; }[]) => ({ now: NOW, sweeps: { sweepMinutes: GRAPHQL_SWEEP_MINUTES, repos } });
  // stale: 40 minutes is past 15 + one tick, and the detail names the repository and its age; the fresh one beside it is not named
  const tripped = sweepOverdueReading(sweeps([{ name: "a11ign/a11ign", readAtMs: NOW - 40 * MINUTE }, { name: "a11ign/fresh", readAtMs: NOW - 5 * MINUTE }]));
  assert.equal(tripped.status, "tripped");
  assert.equal(tripped.signal, SIGNALS.SWEEP_OVERDUE);
  assert.match(tripped.detail, /^1 repository unread for longer than the sweep plus one tick: a11ign\/a11ign \(last whole read 40 min ago\)$/);
  assert.equal(tripped.discriminator, "repository-unread-past-sweep@a11ign/a11ign");
  // RED CONTROL: the same repository read 17 minutes ago is inside the limit (15 + 2.1 minutes), so it is clear
  assert.deepEqual(sweepOverdueReading(sweeps([{ name: "a11ign/a11ign", readAtMs: NOW - 17 * MINUTE }])), { signal: SIGNALS.SWEEP_OVERDUE, status: "clear", detail: "" });
  // fresh: every repository read inside the limit is clear, with no detail
  assert.deepEqual(sweepOverdueReading(sweeps([{ name: "a11ign/a11ign", readAtMs: NOW - 5 * MINUTE }])), { signal: SIGNALS.SWEEP_OVERDUE, status: "clear", detail: "" });
  // missing stamp: nothing is remembered for the repository, so its age is not known, and the reading says which repository
  const missing = sweepOverdueReading(sweeps([{ name: "a11ign/never-read" }]));
  assert.equal(missing.status, "unknown");
  assert.match(missing.detail, /^CANNOT_TELL: no whole read is stamped for a11ign\/never-read, so its age is not known$/);
  // RED CONTROL: a stamp that is there is not unknown, so the missing one is what made the reading unknown
  assert.notEqual(sweepOverdueReading(sweeps([{ name: "a11ign/a11ign", readAtMs: NOW - 5 * MINUTE }])).status, "unknown");
  // a trip stands over an unstamped repository: the stale one is still named
  const both = sweepOverdueReading(sweeps([{ name: "a11ign/a11ign", readAtMs: NOW - 40 * MINUTE }, { name: "a11ign/never-read" }]));
  assert.equal(both.status, "tripped");
  assert.match(both.detail, /a11ign\/a11ign \(last whole read 40 min ago\)/);
});
