// no-token: gh -- the queue's view, in memory; nothing is read or spawned
// A11-442: the critical path of the runs on the board, read from their blockers
import { test } from "node:test";
import assert from "node:assert/strict";
import { criticalPathNote, criticalPaths } from "./critical-path.ts";
import { stackedOn, waitsOn } from "./pull-status-and-notes.ts";
import { stackWaitNote } from "./stack-wait.ts";
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

test("A11-442: a run on a cycle of blockers is on no path, nor is a run whose only chain leads into the cycle (the cycle's own note reports it, `wait-cycles.ts`)", () => {
  const entries = [entry("A-1", after("A-2")), entry("A-2", after("A-1")), entry("A-3", after("A-2"))];
  assert.deepEqual(paths(entries), {});
  assert.deepEqual(paths([entry("A-2", after("A-1")), entry("A-1", after("A-2")), entry("A-3", after("A-2"))]), {}, "whichever run the walk starts from");
});

test("A11-442: a blocker is on the path when the run's Waits on line names it, whatever its state, as `waitsOn` reads it", () => {
  const canceled = entry("A-2", { blockers: [{ key: "A-1", state: "canceled", status: "Canceled" }] });
  const entries = [entry("A-1"), canceled];
  assert.deepEqual(waitsOn(canceled, entries).map(({ key }) => key), ["A-1"], "the card says it waits on A-1 (Canceled)");
  assert.deepEqual(paths(entries), { "A-1": ["A-1", "A-2"], "A-2": ["A-1", "A-2"] });
});

test("A11-442: a blocker the run was stopped for stays on the path while that wait lasts, as `waitsOn` keeps it", () => {
  const stopped = { blockers: [{ key: "A-1", state: "started", status: "In Progress" }], stoppedForBlocker: { at: 1, keys: ["A-1"] } };
  assert.deepEqual(paths([entry("A-1", { phase: "running" }), entry("A-2", stopped)]), { "A-1": ["A-1", "A-2"], "A-2": ["A-1", "A-2"] });
});

const PULL = "https://github.com/a11ign/agent-org/pull/7";
const MEMBER = "https://github.com/a11ign/agent-org/pull/8";

test("A11-442: a run the board starts stacked on its blocker is still after it on the path: it starts on the blocker's open pull request, but merges after it", () => {
  const base = entry("A-1", { phase: "finished", outcome: { kind: "ready-pr", prs: [{ repo: "a11ign/agent-org", url: PULL }] } });
  const member = entry("A-2", { plannedRepo: "agent-org", blockers: [{ key: "A-1", state: "started", status: "In Review", branch: "a-1", pulls: { [PULL]: "open" } }] });
  const entries = [base, member];
  assert.deepEqual(stackedOn(member, entries).map(({ key }) => key), ["A-1"], "the board shows it as Stacked on A-1");
  assert.deepEqual(waitsOn(member, entries), [], "and not as waiting on it");
  assert.deepEqual(paths(entries), { "A-1": ["A-1", "A-2"], "A-2": ["A-1", "A-2"] });
});

test("A11-442: a run whose open pull request is built on another run's, with no blocker listed, is after it on the path while its pull request waits on that one", () => {
  const base = entry("A-1", { phase: "finished", outcome: { kind: "ready-pr", prs: [{ repo: "a11ign/agent-org", url: PULL }] } });
  const stackBase = { key: "A-1", repo: "agent-org", branch: "a-1", sha: "abc" };
  const member = entry("A-2", { phase: "finished", outcome: { kind: "ready-pr", prs: [{ repo: "a11ign/agent-org", url: MEMBER }] }, stackBase });
  assert.ok(stackWaitNote(member, [base, member])?.startsWith("waits on #7"));
  assert.deepEqual(paths([base, member]), { "A-1": ["A-1", "A-2"], "A-2": ["A-1", "A-2"] });
  const merged = entry("A-1", { ...base, pullStates: { [PULL]: "merged" } });
  assert.deepEqual(paths([merged, member]), {}, "once the base has merged, the member waits on nothing");
});

test("A11-442: only a ticket's newest run is marked: the row of an older run of it, that failed before it was queued again, has no line", () => {
  const old = entry("A-1", { phase: "finished", outcome: { kind: "failed" }, queuedAt: 1 });
  const again = entry("A-1", { queuedAt: 2 });
  const entries = [old, again, entry("A-2", { ...after("A-1"), queuedAt: 3 })];
  assert.equal(criticalPathNote(again, entries), "On the critical path: A-1 → A-2");
  assert.equal(criticalPathNote(old, entries) ?? "no line", "no line");
});

test("A11-442: a Checked run found nothing to change, so it is off the path", () => {
  const checked = entry("A-1", { phase: "finished", outcome: { kind: "checked", reason: "nothing to change" } });
  assert.deepEqual(paths([checked, entry("A-2", after("A-1"))]), {});
});
