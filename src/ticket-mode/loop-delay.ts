// @ts-check
// module: how long one thread's event loop waits before it runs what is ready (A11-282) -- p50, p99 and max over the last minute, and the worst since start
//
// A LOOP THAT IS HELD ANSWERS NOTHING. The instance answers every request and runs its sweeps on one loop, so a synchronous `gh` call of 2 s is a request that waits 2 s.
// This reads `perf_hooks.monitorEventLoopDelay`, which samples the loop every RESOLUTION_MS, so the board can show how long a request would have waited.
//
// THE READING IS THE DELAY PAST THE SAMPLE'S OWN TIMER. The histogram records the whole time between two samples, which is RESOLUTION_MS on a loop doing nothing, so
// that is taken off: an idle loop reads 0, and a call that held the loop 2 s reads 2 s.
//
// ONE MINUTE AT A TIME. At each window's end the reading is kept and the histogram starts again, so a stall an hour ago does not stand in today's p99. Until the first
// window ends, the reading is of the window so far. The worst since start is kept beside it. Each thread or process makes its own: a histogram measures the loop it was made on.
import { monitorEventLoopDelay } from "node:perf_hooks";

/** How often the loop is sampled, in ms: the histogram's resolution, and the least delay it can tell from none. */
const RESOLUTION_MS = 10;
/** How long one reading covers, in ms. */
export const LOOP_WINDOW_MS = 60_000;
const NS_PER_MS = 1e6;

/** One thread's loop delay: p50, p99 and max in ms over `windowMs` ending at `at` (ms since the epoch), and the worst since the monitor started. */
export type LoopReading = Readonly<{ p50Ms: number; p99Ms: number; maxMs: number; windowMs: number; sinceStartMaxMs: number; at: number }>;

/** The part of `perf_hooks`' histogram the monitor reads: nanoseconds, as Node gives them. */
export type DelayHistogram = Readonly<{ count: number; max: number; percentile: (percentile: number) => number; reset: () => void; enable: () => unknown; disable: () => unknown }>;

export type LoopMonitorDeps = Readonly<{
  histogram?: () => DelayHistogram;
  now?: () => number;
  /** Calls `run` every `ms`, and answers how to stop it: an unref'd `setInterval` unless a test drives the windows itself. */
  every?: (run: () => void, ms: number) => () => void;
}>;

export type LoopMonitor = Readonly<{ read: () => LoopReading; stop: () => void }>;

/** A delay in ns as ms past the sampling timer, to one decimal place, and never below 0. PURE. */
const pastResolution = (ns: number): number => Math.max(0, Math.round((ns / NS_PER_MS - RESOLUTION_MS) * 10) / 10);

const unrefInterval = (run: () => void, ms: number): (() => void) => {
  const timer = setInterval(run, ms);
  timer.unref();
  return () => clearInterval(timer);
};

/** Starts measuring this thread's loop. `read` answers the last whole window, or the one so far before the first ends; `stop` ends the sampling. */
export function startLoopMonitor({ histogram = () => monitorEventLoopDelay({ resolution: RESOLUTION_MS }), now = Date.now, every = unrefInterval }: LoopMonitorDeps = {}): LoopMonitor {
  const samples = histogram();
  samples.enable();
  let windowStart = now();
  let kept: LoopReading | null = null;
  let sinceStartMaxMs = 0;

  /** The window so far, with the worst since start as it was before this reading. */
  const windowSoFar = (): LoopReading => {
    const at = now();
    const empty = samples.count === 0;
    const maxMs = empty ? 0 : pastResolution(samples.max);
    return { p50Ms: empty ? 0 : pastResolution(samples.percentile(50)), p99Ms: empty ? 0 : pastResolution(samples.percentile(99)), maxMs, windowMs: at - windowStart, sinceStartMaxMs, at };
  };
  /** The window so far, counted towards the worst since start. */
  const takeWindow = (): LoopReading => {
    const live = windowSoFar();
    sinceStartMaxMs = Math.max(sinceStartMaxMs, live.maxMs);
    return { ...live, sinceStartMaxMs };
  };
  const stopWindows = every(() => {
    kept = takeWindow();
    samples.reset();
    windowStart = kept.at;
  }, LOOP_WINDOW_MS);

  return {
    // The window so far is taken every time, so a stall in it counts towards the worst since start before its window ends.
    read: () => {
      const live = takeWindow();
      return kept === null ? live : { ...kept, sinceStartMaxMs };
    },
    stop: () => {
      stopWindows();
      samples.disable();
    },
  };
}
