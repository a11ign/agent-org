// no-token: gh -- the histogram and the clock are injected; the one real monitor measures this worker's own loop; nothing is spawned
import { test } from "node:test";
import { createHistogram, type RecordableHistogram } from "node:perf_hooks";
import assert from "node:assert/strict";
import { HOUR_WINDOWS, LOOP_WINDOW_MS, startLoopMonitor, type DelayHistogram, type LoopMonitorDeps } from "./loop-delay.ts";

const MS = 1e6;

/** A histogram that answers the delays it is given, in ms, as Node's does in ns, and records what the monitor asked of it. */
function histogramOf(delaysMs: number[]) {
  const asked = { enabled: 0, disabled: 0, resets: 0 };
  let samples = [...delaysMs];
  const histogram: DelayHistogram & { add: (ms: number) => void; values: () => number[] } = {
    values: () => samples,
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

/** Adds `from` into `into` as Node does, except that a stand-in histogram (which has `values`, in ms) is recorded sample by sample: Node adds only its own. */
function mergeInto(into: RecordableHistogram, from: DelayHistogram): void {
  const values = (from as { values?: () => number[] }).values;
  if (values === undefined) into.add(from as unknown as RecordableHistogram);
  else for (const ms of values()) into.record(Math.round(ms * MS));
}

/** A monitor over `delaysMs` whose clock and window timer the test moves. */
function monitorOver(delaysMs: number[], over: Partial<LoopMonitorDeps> = {}) {
  const { histogram, asked } = histogramOf(delaysMs);
  let clock = 1_000;
  let endWindow = (): void => { throw new Error("no window timer was started"); };
  let windowMs = 0;
  let stopped = false;
  const monitor = startLoopMonitor({ histogram: () => histogram, now: () => clock, every: (run, ms) => { endWindow = run; windowMs = ms; return () => { stopped = true; }; }, merge: mergeInto, keepHour: true, ...over });
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

/** Holds this thread's loop for `ms`, as a synchronous spawn does, between two short turns of it. */
async function holdLoop(ms: number): Promise<void> {
  await new Promise((done) => { setTimeout(done, 30); });
  const until = performance.now() + ms;
  while (performance.now() < until) { /* hold the loop */ }
  await new Promise((done) => { setTimeout(done, 30); });
}

test("the real monitor sees a loop held 300 ms", async () => {
  const monitor = startLoopMonitor();
  try {
    await holdLoop(300);
    const reading = monitor.read();
    assert.ok(reading.maxMs >= 250, `max ${reading.maxMs} ms`);
    assert.ok(reading.sinceStartMaxMs >= reading.maxMs);
  } finally {
    monitor.stop();
  }
});

test("the last hour's p50 and p99 are the percentiles of every sample in the finished windows and the one so far, not an average of the minutes'", () => {
  // Minute one: 98 quiet samples and two 510 ms holds. Minute two (still running): 100 quiet samples. The hour has 200 samples and two holds, so its p99 is the 198th, a quiet one, where minute one's own p99 reads a hold.
  const quiet = Array.from({ length: 98 }, () => 10);
  const { monitor, histogram, tick, endWindow } = monitorOver([...quiet, 510, 510]);
  tick(LOOP_WINDOW_MS);
  endWindow();
  for (let sample = 0; sample < 100; sample++) histogram.add(10);
  tick(5_000);
  assert.equal(monitor.read().p99Ms, 500, "the minute that was kept reads its hold at p99");
  const hour = monitor.readHour();
  assert.equal(hour.p99Ms, 0, "the hour's p99 is a quiet sample: two holds in 200 samples");
  assert.ok(Math.abs(hour.maxMs - 500) < 1, `the hour's max keeps the hold, ${hour.maxMs}`);
  assert.equal(hour.windowMs, LOOP_WINDOW_MS + 5_000, "it covers the finished minute and the part of the next");
});

test("the hour keeps sixty finished windows, and a stall older than that is out of it", () => {
  const { monitor, histogram, tick, endWindow } = monitorOver([3_010]);
  tick(LOOP_WINDOW_MS);
  endWindow();
  for (let window = 0; window < HOUR_WINDOWS; window++) {
    histogram.add(10);
    tick(LOOP_WINDOW_MS);
    endWindow();
  }
  assert.ok(monitor.readHour().maxMs < 1, "the 3 s stall was in the first window, which the sixty after it have pushed out");
  assert.equal(monitor.readHour().windowMs, HOUR_WINDOWS * LOOP_WINDOW_MS);
});

test("the real monitor's hour merges real histograms: a held loop is in the hour", async () => {
  const monitor = startLoopMonitor();
  try {
    await holdLoop(200);
    assert.ok(monitor.readHour().maxMs >= 150, `hour max ${monitor.readHour().maxMs} ms`);
  } finally {
    monitor.stop();
  }
});

test("a monitor made without keepHour keeps no finished windows: its hour is the window so far", () => {
  const made = monitorOver([10, 510], { keepHour: false });
  made.tick(LOOP_WINDOW_MS);
  made.endWindow();
  const { monitor } = made;
  assert.equal(monitor.readHour().maxMs, 0, "the first minute is not in it: only the samples since the window ended");
  assert.equal(monitor.read().maxMs, 500, "and the minute's own reading is as it always was");
});

test("a window that cannot be merged into the hour is left out of it, and the minute still ends: the timer never throws", () => {
  const { histogram, tick, endWindow } = monitorOver([10, 510], { merge: () => { throw new Error("a value Node does not accept"); } });
  tick(LOOP_WINDOW_MS);
  assert.doesNotThrow(() => endWindow());
  assert.deepEqual(histogram.values(), [], "the samples were reset: the next minute starts clean");
});
