// no-token: gh -- imports `work-gate/pacing.ts`, which reads the GraphQL pool through an injected `run`; every probe here is a stub, and nothing is spawned (agent-org#1240)
/**
 * agent-org#1240: THE GATE PACES ITS GRAPHQL SPEND AGAINST A NAMED RESERVE, AND A WEBHOOK TICK READS THE OTHER REPOSITORIES ONLY WHERE ITS EVENTS NAMED THEM.
 *
 * Each rule is pinned by a positive assertion and a RED CONTROL: the same rule with its condition removed, which the assertion must refuse.
 *   - the flag is OFF by default, and a poll tick or a test's `run` reads every repository as it always has;
 *   - below the reserve the pool is paced, at the reserve it is not (the boundary is named, not implied);
 *   - a paced tick names what it did not read, and never names nothing;
 *   - a webhook tick reads a repository its events named, and one due a sweep, and no other;
 *   - a repository an event-gated tick drops is REPORTED unread, with its reason, as a paced skip is;
 *   - an event-gated tick that names neither the home repository nor a due sweep skips the primary's tracker lanes and `orgHealth`, and reports both;
 *   - the sweep is every `GRAPHQL_SWEEP_MINUTES`, and a repository read inside that window is not read again;
 *   - the memory of read times survives a write of another repository's, and a missing or malformed file reads every repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRAPHQL_RESERVE, GRAPHQL_SWEEP_MINUTES, OTHER_SCOPES_MEMORY, PACING_FLAG, orgHealthSkipped, pacedUnread, pacingNow, pacingOn, primaryUnread, readOtherScopesMemory, rememberOtherScopes, scopesToRead } from "../work-gate/pacing.ts";
import { defaultRun, eventGateOf, otherScopesToRead, primaryDue, primaryLanes, unreadScopes, type GateFacts } from "../work-gate/reads.ts";
import type { Scope as TickScope } from "../event-queue.ts";
import type { Scope } from "../work-gate/vocabulary.ts";
import { emptyCanaryState, withMachineryFlag } from "../org-health.ts";

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
  assert.deepEqual(pacingNow(run, false), { paced: false, remaining: null });
  assert.equal(calls.length, 0, "the probe is not made with the flag off");
  // RED CONTROL: the same pool, flag on, IS paced: the flag is the only thing that stood between this tick and the skip
  assert.equal(pacingNow(probe(GRAPHQL_RESERVE - 1).run, true).paced, true);
});

test("the reserve is a boundary: below it the pool is paced, at it the pool is not", () => {
  assert.equal(GRAPHQL_RESERVE, 1000, "the reserve is named, and the PR says so");
  assert.deepEqual(pacingNow(probe(999).run, true), { paced: true, remaining: 999 });
  assert.deepEqual(pacingNow(probe(1000).run, true), { paced: false, remaining: 1000 });
  // RED CONTROL: a reserve of zero would pace nothing at 999, and this assertion would refuse it
  assert.notEqual(pacingNow(probe(999).run, true).paced, false);
});

test("a probe that cannot be read is not paced: the reads then refuse on their own and are reported as they are", () => {
  assert.deepEqual(pacingNow(probe(null).run, true), { paced: false, remaining: null });
  // RED CONTROL: a pool read as 0 IS paced, so the null case above is not paced by the same rule
  assert.equal(pacingNow(probe(0).run, true).paced, true);
});

test("a paced tick names what it did not read, and a tick that was not paced names nothing", () => {
  assert.deepEqual(pacedUnread({ paced: true, remaining: 10 }, true), ["the other repositories' lanes", "the org-health reads"]);
  // a one-project host has no other repositories to be unread, so only the org-health reads are named
  assert.deepEqual(pacedUnread({ paced: true, remaining: 10 }, false), ["the org-health reads"]);
  assert.deepEqual(pacedUnread({ paced: false, remaining: 5000 }, true), []);
  // RED CONTROL: a paced tick that named nothing would read as clean, which is the defect the row forbids
  assert.notDeepEqual(pacedUnread({ paced: true, remaining: 10 }, false), []);
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
    assert.equal(orgHealthSkipped({ paced: false, remaining: null }, false), true, "orgHealth is skipped with them");
    assert.deepEqual(primaryUnread({ paced: false, remaining: null }, false), ["the primary's tracker lanes (promotable rows, chairman-blocked rows, open rows)", "the org-health reads"]);
    // RED CONTROL: the same tick naming the primary's tracker repository reads them, and orgHealth runs
    const named = webhookTick(dir, { named: [{ repo: "org/home-rows", kind: "issue", number: 3 }], memory: { "": NOW - MINUTE } });
    assert.equal(primaryDue(defaultRun, HOME, named), true);
    assert.deepEqual(primaryLanes(defaultRun, HOME, lanes, SKIPPED_PRIMARY, named), { promotableRows: [], chairmanBlocked: [], openRowsRead: [] });
    assert.equal(reads, 1);
    assert.equal(orgHealthSkipped({ paced: false, remaining: null }, true), false);
    assert.deepEqual(primaryUnread({ paced: false, remaining: null }, true), []);
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
