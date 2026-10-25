// no-token: none -- the queue in memory, and the script run on a fixture through a pipe
// A11-272: the After-merge check of the ticket, as a function of the queue and as a command that can be run on a branch's fixture before merge
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitStateProblems } from "./wait-state.ts";
import type { ViewEntry } from "./view-types-and-filters.ts";

const FILES = ["lab:middleware/runtime/main.py"];
const SCRIPT = join(fileURLToPath(new URL("../../..", import.meta.url)), "scripts", "check-wait-state.ts");
const entry = (key: string, over: Record<string, unknown> = {}) => ({ ticket: { key }, phase: "queued", ...over }) as unknown as ViewEntry;
const parked = (key: string, waits: Record<string, unknown>[], over: Record<string, unknown> = {}) => entry(key, { phase: "running", working: { reason: "w", at: 1, waiting: true, waits }, ...over });

/** The board of 2026-10-25 before the fix: A11-231 running and parked on A11-229, which is held behind its files. */
const DEADLOCK = [parked("A11-231", [{ kind: "ticket", key: "A11-229" }], { paths: FILES }), entry("A11-229", { paths: FILES })];
/** The same board after it: A11-231 queued behind A11-229, which runs. */
const HEALED = [entry("A11-231", { stoppedForBlocker: { at: 1, keys: ["A11-229"] }, paths: FILES }), entry("A11-229", { phase: "running", paths: FILES })];

const run = (entries: unknown) => spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(entries), encoding: "utf8" });

test("A11-272: a run running and parked on a ticket wait, and the cycle it makes with the ticket held behind its files, are both reported", () => {
  assert.deepEqual(waitStateProblems(DEADLOCK), [
    "A11-231 is running and waits on ticket A11-229: the board should have queued it behind A11-229",
    "Wait cycle A11-229 → A11-231 → A11-229: A11-229 is held behind A11-231's files; A11-231's worker waits on A11-229.",
  ]);
});

test("A11-272: a healed board, a run parked on a fleet job, and a queued ticket held by a run that does not wait on it report nothing", () => {
  assert.deepEqual(waitStateProblems(HEALED), []);
  const onJob = [parked("A-1", [{ kind: "fleetJob" }], { paths: FILES }), entry("B-1", { paths: FILES })];
  assert.deepEqual(waitStateProblems(onJob), [], "by design: it holds its files against a ticket it does not wait for");
});

test("A11-272: a batch's shared run, which the board never releases, and a wait on a ticket the tracker already completed, which it wakes, are not problems", () => {
  const shared = [parked("A-1", [{ kind: "ticket", key: "B-1" }], { batch: "batch-1" }), entry("B-1")];
  assert.deepEqual(waitStateProblems(shared), []);
  const over = [parked("A-1", [{ kind: "ticket", key: "B-1" }]), entry("B-1", { phase: "finished", trackerState: "completed" })];
  assert.deepEqual(waitStateProblems(over), []);
});

test("A11-272: the script exits 1 naming the problems on the deadlock, and 0 on the healed board, whether it is given the queue's answer or its entries", () => {
  const failed = run({ entries: DEADLOCK });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /A11-231 is running and waits on ticket A11-229/);
  assert.match(failed.stdout, /Wait cycle A11-229 → A11-231 → A11-229/);
  for (const queue of [{ entries: HEALED }, HEALED]) {
    const clean = run(queue);
    assert.deepEqual([clean.status, clean.stdout.trim()], [0, "the waits are clean: 2 runs, none parked on a ticket wait, no wait cycle"]);
  }
});
