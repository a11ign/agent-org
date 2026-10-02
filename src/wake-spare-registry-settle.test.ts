// no-token: gh -- no `gh` runs here; every fact the teardown reads is an injected seam
/**
 * `packages/agent-org/src/wake.mjs`, #2860: `endFinishedSpares` settles a spare-registry entry whose workspace is gone.
 * Since #2469 a spare is named `worker-<row>`, so an address is never spawned twice and `settleAbsentInstance` (which
 * `registerSpawn` runs for the SAME address) never fired: the registry kept one stale entry per finished engineer, and
 * `targetState` read each of them `absent` rather than `ended` (#2853's source).
 *
 * Three conditions, each with its own control: the listing is COMPLETE, the entry's rows were READ, and every one is
 * CLOSED. Each is varied alone against the one fixture that settles, so each mutation breaks its own case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { endFinishedSpares, spareInstances } from "./wake.mjs";

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const HOUR = 3_600_000;

const panes = (...labels: string[]) => labels.map((label) => ({ label, status: "idle" }));
/** The org with both standing panes and NO `worker-7` workspace: a complete listing that does not show the spare. */
const COMPLETE = panes("ceo", "orchestrator", "worker-tooling");
/** Neither standing pane: herdr answered partially, which reads every instance as absent. */
const PARTIAL = panes("worker-tooling");

/** `worker-7` is registered for #7 and absent from `listing`. Override a fact per test. */
function run(listing: { label: string; status: string }[], over: Record<string, unknown> = {}) {
  const cycles: unknown[] = [];
  const closes: string[][] = [];
  const registry = { "worker-7": { spawnedAt: NOW - 5 * HOUR, rows: [7] } };
  const deps = {
    spares: spareInstances(listing), registry, now: NOW,
    run: (args: string[]) => { closes.push(args); return "{}"; },
    heldRows: () => [] as number[] | null, rowState: () => "CLOSED" as string | null,
    worktrees: () => [], record: (c: unknown) => cycles.push(c), warn: () => {}, ...over,
  };
  return { got: endFinishedSpares(listing, deps as never), cycles, closes };
}

test("#2860 ACCEPTANCE: a registry entry with no workspace, in a complete listing, whose row is closed is SETTLED", () => {
  const { got, cycles, closes } = run(COMPLETE);
  assert.deepEqual(cycles, [{ role: "worker-7", row: 7, at: NOW, clean: false, rows: [7],
    why: "the previous instance left without the teardown (closed by hand or crashed)" }],
  "one failed-cycle ledger line, the one `settleAbsentInstance` writes");
  assert.deepEqual(got.ended, cycles);
  assert.equal(got.registry["worker-7"], undefined, "the entry is removed, so `targetState` can read the label as ended");
  assert.deepEqual(closes, [], "there is no workspace, so nothing is closed");
});

test("#2860 CONTROL: the same entry with row #7 OPEN is kept", () => {
  const { got, cycles } = run(COMPLETE, { rowState: () => "OPEN" });
  assert.deepEqual(cycles, []);
  assert.deepEqual(got.registry["worker-7"], { spawnedAt: NOW - 5 * HOUR, rows: [7] });
});

test("#2860 CONTROL: the same entry in a PARTIAL listing is kept", () => {
  const { got, cycles } = run(PARTIAL);
  assert.deepEqual(cycles, []);
  assert.deepEqual(got.registry["worker-7"], { spawnedAt: NOW - 5 * HOUR, rows: [7] });
});

test("#2860 CONTROL: a row read that returned NOTHING keeps the entry (absence is not closed)", () => {
  const { got, cycles } = run(COMPLETE, { rowState: () => null });
  assert.deepEqual(cycles, []);
  assert.deepEqual(got.registry["worker-7"], { spawnedAt: NOW - 5 * HOUR, rows: [7] });
});

test("#2860 CONTROL: ONE open row among several keeps the entry, and an entry with no rows has nothing to ask about", () => {
  const two = { "worker-7": { spawnedAt: NOW - HOUR, rows: [7, 8] } };
  const mixed = run(COMPLETE, { registry: two, rowState: (row: number) => (row === 7 ? "CLOSED" : "OPEN") });
  assert.deepEqual(mixed.cycles, []);
  const none = run(COMPLETE, { registry: { "worker-7": { spawnedAt: NOW - HOUR, rows: [] } } });
  assert.deepEqual(none.cycles, [], "an empty row list is vacuously all-closed, which is not a reading");
  assert.deepEqual(Object.keys(none.got.registry), ["worker-7"]);
});

test("#2860 CONTROL: a role STILL LISTED is not this path's -- the ordinary teardown owns it", () => {
  const listed = [...COMPLETE, { label: "worker-7", status: "working" }];
  const { got, cycles } = run(listed, { heldRows: () => [7] });
  assert.deepEqual(cycles, []);
  assert.deepEqual(got.registry["worker-7"], { spawnedAt: NOW - 5 * HOUR, rows: [7] });
});
