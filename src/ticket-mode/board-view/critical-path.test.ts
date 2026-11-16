// no-token: gh -- the queue's view, in memory; nothing is read or spawned
// A11-442: the critical path of the runs on the board, read from their blockers
import { test } from "node:test";
import assert from "node:assert/strict";
import { criticalPathNote, criticalPaths } from "./critical-path.ts";
import type { ViewEntry } from "./view-types-and-filters.ts";

const entry = (key: string, over: Record<string, unknown> = {}) => ({ ticket: { key }, phase: "queued", ...over }) as unknown as ViewEntry;
const after = (...keys: string[]) => ({ blockers: keys.map((key) => ({ key, state: "unstarted", status: "Todo" })) });
const paths = (entries: readonly ViewEntry[]) => Object.fromEntries(criticalPaths(entries));

/** A planned batch: the chain A11-500 then A11-501 then A11-502, beside a lone A11-503. */
const chainBesideLone = () => [entry("A11-500", { phase: "running" }), entry("A11-501", after("A11-500")), entry("A11-502", after("A11-501")), entry("A11-503", { phase: "running" })];

test("A11-442: a chain of three beside a lone ticket: the three are the critical path, first run first, and the lone ticket is on none", () => {
  const chain = ["A11-500", "A11-501", "A11-502"];
  assert.deepEqual(paths(chainBesideLone()), { "A11-500": chain, "A11-501": chain, "A11-502": chain });
});

test("A11-442: each run on the path says so, naming the path, and a run on none says nothing", () => {
  const entries = chainBesideLone();
  const [, second, , lone] = entries;
  assert.equal(criticalPathNote(second, entries), "On the critical path: A11-500 → A11-501 → A11-502");
  assert.equal(criticalPathNote(lone, entries) ?? "no line", "no line");
});

test("A11-442: tickets with no blocker among them have no critical path", () => {
  assert.deepEqual(paths([entry("A-1"), entry("A-2", { phase: "running" })]), {});
});

test("A11-442: in a set joined by blockers, only the longest chain is the path: a short branch off it is not", () => {
  // A-1 -> A-2 -> A-3, and A-4 waits on A-1 alone.
  const entries = [entry("A-1"), entry("A-2", after("A-1")), entry("A-3", after("A-2")), entry("A-4", after("A-1"))];
  assert.deepEqual(Object.keys(paths(entries)).sort(), ["A-1", "A-2", "A-3"]);
});

test("A11-442: two chains that tie are both on the path, and each run names the chain through it", () => {
  const entries = [entry("A-1"), entry("A-2", after("A-1")), entry("A-3", after("A-1"))];
  assert.deepEqual(paths(entries), { "A-1": ["A-1", "A-2"], "A-2": ["A-1", "A-2"], "A-3": ["A-1", "A-3"] });
});

test("A11-442: a run that waits on two chains is on the longer one", () => {
  // A-1 -> A-2 -> A-4 and A-3 -> A-4.
  const entries = [entry("A-1"), entry("A-2", after("A-1")), entry("A-3"), entry("A-4", after("A-2", "A-3"))];
  assert.deepEqual(paths(entries), { "A-1": ["A-1", "A-2", "A-4"], "A-2": ["A-1", "A-2", "A-4"], "A-4": ["A-1", "A-2", "A-4"] });
});

test("A11-442: two separate sets each have their own path", () => {
  const entries = [entry("A-1"), entry("A-2", after("A-1")), entry("B-1"), entry("B-2", after("B-1")), entry("B-3", after("B-2"))];
  assert.deepEqual(Object.keys(paths(entries)).sort(), ["A-1", "A-2", "B-1", "B-2", "B-3"]);
});

test("A11-442: a Completed run is off the path, so the path is what is left to finish", () => {
  const done = entry("A11-500", { phase: "finished", outcome: { kind: "ready-pr", prs: [] }, trackerState: "completed" });
  const entries = [done, entry("A11-501", after("A11-500")), entry("A11-502", after("A11-501"))];
  assert.deepEqual(paths(entries), { "A11-501": ["A11-501", "A11-502"], "A11-502": ["A11-501", "A11-502"] });
});

test("A11-442: a blocker the board holds no run for joins nothing", () => {
  assert.deepEqual(paths([entry("A-1", after("Z-9"))]), {});
});

test("A11-442: blockers that go round in a cycle do not loop: the walk ends, and no path names a run twice (the cycle's own note reports it, `wait-cycles.ts`)", () => {
  const entries = [entry("A-1", after("A-2")), entry("A-2", after("A-1")), entry("A-3", after("A-2"))];
  const chains = [...criticalPaths(entries).values()];
  for (const chain of chains) assert.equal(new Set(chain).size, chain.length, `${chain.join(" → ")} names a run twice`);
});
