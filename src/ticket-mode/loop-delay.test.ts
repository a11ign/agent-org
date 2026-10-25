// no-token: gh -- the histogram and the clock are injected; the one real monitor measures this worker's own loop; nothing is spawned
import { test } from "node:test";
import assert from "node:assert/strict";
import { LOOP_WINDOW_MS, startLoopMonitor, type DelayHistogram } from "./loop-delay.ts";

const MS = 1e6;

/** A histogram that answers the delays it is given, in ms, as Node's does in ns, and records what the monitor asked of it. */
function histogramOf(delaysMs: number[]) {
  const asked = { enabled: 0, disabled: 0, resets: 0 };
  let samples = [...delaysMs];
  const histogram: DelayHistogram & { add: (ms: number) => void } = {
    get count() { return samples.length; },
    get max() { return Math.max(...samples) * MS; },
    percentile: (p) => [...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil((p / 100) * samples.length) - 1)] * MS,
    reset: () => { asked.resets += 1; samples = []; },
    enable: () => { asked.enabled += 1; },
    disable: () => { asked.disabled += 1; },
    add: (ms) => { samples.push(ms); },
  };
  return { histogram, asked };
}

/** A monitor over `delaysMs` whose clock and window timer the test moves. */
function monitorOver(delaysMs: number[]) {
  const { histogram, asked } = histogramOf(delaysMs);
  let clock = 1_000;
  let endWindow = (): void => { throw new Error("no window timer was started"); };
  let windowMs = 0;
  let stopped = false;
  const monitor = startLoopMonitor({ histogram: () => histogram, now: () => clock, every: (run, ms) => { endWindow = run; windowMs = ms; return () => { stopped = true; }; } });
  return { monitor, histogram, asked, tick: (ms: number) => { clock += ms; }, endWindow: () => endWindow(), windowMs: () => windowMs, stopped: () => stopped };
}

test("before the first window ends, the reading is the window so far, past the sampling timer's own 10 ms", () => {
  const { monitor, tick, windowMs, asked } = monitorOver([10, 10, 12, 30, 2_010]);
  tick(5_000);
  assert.equal(asked.enabled, 1, "the histogram samples from the start");
  assert.equal(windowMs(), LOOP_WINDOW_MS, "a window is a minute");
  assert.deepEqual(monitor.read(), { p50Ms: 2, p99Ms: 2_000, maxMs: 2_000, windowMs: 5_000, sinceStartMaxMs: 2_000, at: 6_000 });
});

test("a loop doing nothing reads 0, and a histogram with no samples yet reads 0 rather than its empty bucket", () => {
  assert.deepEqual(monitorOver([10, 10, 10]).monitor.read(), { p50Ms: 0, p99Ms: 0, maxMs: 0, windowMs: 0, sinceStartMaxMs: 0, at: 1_000 });
  const empty = monitorOver([]).monitor.read();
  assert.equal(empty.p99Ms, 0);
  assert.equal(empty.maxMs, 0);
});

test("at a window's end its reading is kept and the histogram starts again, so the reading is the last whole minute", () => {
  const { monitor, histogram, asked, tick, endWindow } = monitorOver([10, 510]);
  tick(LOOP_WINDOW_MS);
  endWindow();
  assert.equal(asked.resets, 1);
  histogram.add(12);
  tick(10_000);
  const reading = monitor.read();
  assert.equal(reading.maxMs, 500, "the kept minute's, not the window still running");
  assert.equal(reading.windowMs, LOOP_WINDOW_MS);
  assert.equal(reading.at, 1_000 + LOOP_WINDOW_MS);
});

test("a stall in the window still running counts towards the worst since start before its window ends, and a quiet minute does not lower it", () => {
  const { monitor, histogram, tick, endWindow } = monitorOver([10, 110]);
  tick(LOOP_WINDOW_MS);
  endWindow();
  histogram.add(3_010);
  assert.equal(monitor.read().maxMs, 100, "the reading is still the kept minute");
  assert.equal(monitor.read().sinceStartMaxMs, 3_000, "but the worst since start has the stall");
  tick(LOOP_WINDOW_MS);
  endWindow();
  tick(LOOP_WINDOW_MS);
  endWindow();
  assert.equal(monitor.read().maxMs, 0, "a minute with no samples reads 0");
  assert.equal(monitor.read().sinceStartMaxMs, 3_000);
});

test("stop ends the window timer and the sampling", () => {
  const { monitor, asked, stopped } = monitorOver([10]);
  monitor.stop();
  assert.equal(stopped(), true);
  assert.equal(asked.disabled, 1);
});

test("the real monitor sees a loop held 300 ms", async () => {
  const monitor = startLoopMonitor();
  try {
    await new Promise((done) => { setTimeout(done, 50); });
    const until = performance.now() + 300;
    while (performance.now() < until) { /* hold the loop, as a synchronous spawn does */ }
    await new Promise((done) => { setTimeout(done, 50); });
    const reading = monitor.read();
    assert.ok(reading.maxMs >= 250, `max ${reading.maxMs} ms`);
    assert.ok(reading.sinceStartMaxMs >= reading.maxMs);
  } finally {
    monitor.stop();
  }
});
