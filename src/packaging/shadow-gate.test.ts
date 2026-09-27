/**
 * `shadow-gate.mjs` is the rehearsal instrument for ADR 0040 decision 5 (row #2622, child 4 of #69): a
 * read-only runner that feeds a live gate and a candidate gate the SAME reads and diffs their orders, tick
 * for tick, and a second mode that replays a recorded sequence of ticks across a simulated cut-over on a
 * COPY of the state directory. The extracted gate does not exist yet (that is child 5, #2623) -- this
 * proves the INSTRUMENT against injected fixture gates, which is exactly what it must still do once the
 * extraction lands.
 *
 * Every fixture below writes REAL files to a real temp directory and reads them back with `wake.mjs`'s
 * own formats (`ledgerLine`, `VOIDED`, `queueHandoff`, `readHandoffs`) rather than inventing a shape --
 * so "the marker crossed the cut" and "the handoff was still there" are checks against the format the
 * live ledger and queue actually use, not a stand-in for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffOrders, shadowRun, simulateCutover, stateSnapshot, refuseLiveStateDir, LIVE_STATE_DIR }
  from "../shadow-gate.mjs";
import { VOIDED, ledgerLine, handoffId, queueHandoff, readHandoffs, HANDOFF_QUEUE_FILE } from "../wake.mjs";

/** A fresh, empty directory nothing else uses -- never the live `~/.cache/a11ign`. */
function copyDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "a11y-shadow-gate-")));
}

/** An order in `decide()`'s shape, for a fixture tick. */
function order(causeKey: string, prompt = causeKey): { causeKey: string; session: string; cause: string; subject: string; discriminator: string; prompt: string } {
  return { causeKey, session: "worker-1", cause: "fixture", subject: causeKey, discriminator: "d", prompt };
}

test("identical gates over a recorded run of ticks produce an empty diff, and the run is not vacuously empty", () => {
  const recordedTicks = [
    { tick: 1, reads: { pr: 10 } },
    { tick: 2, reads: { pr: 11 } },
    { tick: 3, reads: { pr: 12 } },
  ];
  // POSITIVE CONTROL: more than one tick and at least one order, so an empty run could not have produced
  // this empty diff by having nothing to compare.
  assert.ok(recordedTicks.length > 1, "the recorded run must hold more than one tick");
  const sameGate = (reads: unknown) => [order(`row-${(reads as { pr: number }).pr}`)];
  const totalOrders = recordedTicks.reduce((n, t) => n + sameGate(t.reads).length, 0);
  assert.ok(totalOrders >= 1, "the recorded run must hold at least one order");

  const dir = copyDir();
  try {
    const result = shadowRun({ ticks: recordedTicks, liveGate: sameGate, candidateGate: sameGate, stateDir: dir });
    assert.deepEqual(result.differences, []);
    assert.equal(result.firstDifference, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one perturbed order is reported naming the tick and the order that differs", () => {
  const recordedTicks = [
    { tick: 1, reads: { pr: 10 } },
    { tick: 2, reads: { pr: 11 } },
    { tick: 3, reads: { pr: 12 } },
  ];
  const liveGate = (reads: unknown) => [order(`row-${(reads as { pr: number }).pr}`)];
  // THE PERTURBED FIXTURE IS THE RECORDED RUN WITH EXACTLY ONE ORDER CHANGED: tick 2's prompt differs,
  // every other tick's candidate order is byte-identical to the live one.
  const candidateGate = (reads: unknown) => {
    const { pr } = reads as { pr: number };
    return [pr === 11 ? order(`row-${pr}`, "a different prompt") : order(`row-${pr}`)];
  };

  const dir = copyDir();
  try {
    const result = shadowRun({ ticks: recordedTicks, liveGate, candidateGate, stateDir: dir });
    assert.equal(result.differences.length, 1, "exactly one order differs, so exactly one difference is reported");
    assert.equal(result.differences[0]?.tick, 2, "the difference must name the tick it happened on");
    assert.equal(result.differences[0]?.causeKey, "row-11", "the difference must name the order that differs");
    assert.equal(result.firstDifference?.tick, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diffOrders reports an order present on only one side as a difference too", () => {
  const differences = diffOrders([order("only-live")], [order("only-candidate")]);
  assert.equal(differences.length, 2);
  const keys = differences.map((d) => d.causeKey).sort();
  assert.deepEqual(keys, ["only-candidate", "only-live"]);
});

const REFUSES_BEFORE_ANY_READ = () => {
  throw new Error("a gate must never be called once the state directory is refused");
};

test("pointing the runner at the live state directory is refused before any read", () => {
  assert.throws(
    () => shadowRun({
      ticks: [{ tick: 1, reads: {} }],
      liveGate: REFUSES_BEFORE_ANY_READ,
      candidateGate: REFUSES_BEFORE_ANY_READ,
      stateDir: LIVE_STATE_DIR,
    }),
    /REFUSING.*resolves to the live state directory/,
  );
});

test("a path that resolves to the live state directory by symlink is refused too", () => {
  const live = copyDir();
  const link = join(tmpdir(), `a11y-shadow-gate-link-${process.pid}-${Date.now()}`);
  symlinkSync(live, link);
  try {
    assert.throws(
      () => shadowRun({
        ticks: [{ tick: 1, reads: {} }],
        liveGate: REFUSES_BEFORE_ANY_READ,
        candidateGate: REFUSES_BEFORE_ANY_READ,
        stateDir: link,
        liveStateDir: live,
      }),
      /REFUSING.*resolves to the live state directory/,
    );
    // Direct call too, proving the guard itself (not just shadowRun's ordering) catches the symlink case.
    assert.throws(() => refuseLiveStateDir(link, { liveStateDir: live }));
    // A genuinely unrelated directory is NOT refused.
    const other = copyDir();
    try {
      assert.doesNotThrow(() => refuseLiveStateDir(other, { liveStateDir: live }));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(link, { force: true });
    rmSync(live, { recursive: true, force: true });
  }
});

test("a run writes no state file: a copy holding a real ledger and handoff queue is byte-identical after", () => {
  const dir = copyDir();
  const ledgerPath = join(dir, "wake-ledger");
  const queuePath = join(dir, HANDOFF_QUEUE_FILE);
  writeFileSync(ledgerPath, ledgerLine(1000, "some-cause-key"));
  queueHandoff(queuePath, { session: "worker-1", prompt: "do the thing", now: 2000 });
  const before = stateSnapshot(dir);
  try {
    // Gates that ACTUALLY READ the copy, so the "no write" claim is checked against real reads, not a
    // fixture that never touches the directory it is supposedly rehearsing against.
    const readingGate = (_reads: unknown, stateDir: string) => {
      const ledger = readFileSync(join(stateDir, "wake-ledger"), "utf8");
      return [order(`ledger-bytes-${ledger.length}`)];
    };
    shadowRun({ ticks: [{ tick: 1, reads: {} }], liveGate: readingGate, candidateGate: readingGate, stateDir: dir });
    const after = stateSnapshot(dir);
    assert.deepEqual(after, before, "reading the copy must not change a single byte of it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a simulated cut-over on a copy with a VOIDED marker and a queued handoff in flight loses no tick and drops no order", () => {
  const dir = copyDir();
  const ledgerPath = join(dir, "wake-ledger");
  const queuePath = join(dir, HANDOFF_QUEUE_FILE);
  // A delivery, then a VOIDED line taking it back (a restart killed it) -- decision 5's marker, written
  // exactly as `wake.mjs`'s `actOnKilledWork` writes it.
  writeFileSync(ledgerPath, ledgerLine(1000, "stalled-row-9") + `${1500}\t${VOIDED}\t${"stalled-row-9"}\t${1000}\n`);
  // A handoff QUEUED before the cut and not yet delivered -- "in flight" at the moment of the swap.
  const inFlight = queueHandoff(queuePath, { session: "worker-2", prompt: "finish row 9", now: 1200 });

  // POSITIVE CONTROL: the fixtures actually hold what the test claims they hold, read back with the real
  // formats, before any rehearsal runs.
  assert.match(readFileSync(ledgerPath, "utf8"), new RegExp(VOIDED));
  assert.equal(readHandoffs(queuePath).length, 1, "the handoff must still be queued, not already delivered");

  const ticks = [1, 2, 3, 4, 5].map((tick) => ({ tick, reads: { tick } }));
  const cutAtTick = 3;
  const oldGate = (reads: unknown) => [order(`old-tick-${(reads as { tick: number }).tick}`)];
  // The new gate reads the copy's own queue and reports the in-flight handoff as an order it can now
  // deliver -- proving the handoff was visible to the gate answering AFTER the cut, not lost by it.
  const newGate = (reads: unknown, stateDir: string) => {
    const queued = readHandoffs(join(stateDir, HANDOFF_QUEUE_FILE));
    const crossing = queued.map((h) => order(h.id));
    return [order(`new-tick-${(reads as { tick: number }).tick}`), ...crossing];
  };

  const before = stateSnapshot(dir);
  const result = simulateCutover({ ticks, cutAtTick, oldGate, newGate, stateDir: dir });
  const after = stateSnapshot(dir);

  assert.deepEqual(result.skippedTicks, [], "no tick is skipped across the cut");
  assert.deepEqual(result.ticksCovered, [1, 2, 3, 4, 5]);
  assert.deepEqual(result.perTick.map((t) => t.gate), ["old", "old", "new", "new", "new"],
    "the old gate answers every tick before the cut and the new gate every tick at and after it");

  const causeKeys = result.allOrders.map((o) => o.causeKey);
  for (const tick of [1, 2]) assert.ok(causeKeys.includes(`old-tick-${tick}`), `tick ${tick}'s old-gate order was dropped`);
  for (const tick of [3, 4, 5]) assert.ok(causeKeys.includes(`new-tick-${tick}`), `tick ${tick}'s new-gate order was dropped`);
  assert.ok(causeKeys.includes(handoffId("worker-2", "finish row 9")), "the in-flight handoff never crossed the cut");
  assert.equal(inFlight.id, handoffId("worker-2", "finish row 9"));

  assert.deepEqual(after, before, "the rehearsal must not write the ledger, the marker or the queue it read");

  rmSync(dir, { recursive: true, force: true });
});
