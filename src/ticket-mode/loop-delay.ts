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
//
// THE LAST HOUR IS THE LAST SIXTY WINDOWS MERGED (A11-363). Each finished window is copied into a histogram of its own and kept, and `readHour` merges them with the window so far, so the hour's p50 and p99 are the
// percentiles of every sample in it and not an average of the minutes' percentiles. Node cannot add the sampling histogram (`monitorEventLoopDelay`) into another, so a window is copied by its quantiles: QUANTILES equal
// slices of its samples, each recorded as the value at the slice's middle, and its max once. The hour's p99 is therefore read to the nearest half percent, and its max exactly.
import { createHistogram, monitorEventLoopDelay, type RecordableHistogram } from "node:perf_hooks";

/** How often the loop is sampled, in ms: the histogram's resolution, and the least delay it can tell from none. */
const RESOLUTION_MS = 10;
/** How long one reading covers, in ms. */
export const LOOP_WINDOW_MS = 60_000;
const NS_PER_MS = 1e6;

/** One thread's loop delay: p50, p99 and max in ms over `windowMs` ending at `at` (ms since the epoch), and the worst since the monitor started. */
export type LoopReading = Readonly<{ p50Ms: number; p99Ms: number; maxMs: number; windowMs: number; sinceStartMaxMs: number; at: number }>;

/** The part of `perf_hooks`' histogram the monitor reads: nanoseconds, as Node gives them. */
export type DelayHistogram = Readonly<{ count: number; max: number; percentile: (percentile: number) => number; reset: () => void; enable: () => unknown; disable: () => unknown }>;

/** How many whole windows make the hour. */
export const HOUR_WINDOWS = 60;
/** How many slices a window's samples are copied in. */
const QUANTILES = 200;

/** The loop's delay over a stretch longer than one window: p50, p99 and max in ms, and how long the stretch is, in ms. */
export type LoopSpan = Readonly<{ p50Ms: number; p99Ms: number; maxMs: number; windowMs: number }>;

export type LoopMonitorDeps = Readonly<{
  histogram?: () => DelayHistogram;
  now?: () => number;
  /** Calls `run` every `ms`, and answers how to stop it: an unref'd `setInterval` unless a test drives the windows itself. */
  every?: (run: () => void, ms: number) => () => void;
  /** Keep the finished windows for the hour (`readHour`): off unless asked, since sixty windows are some 9 MB of native memory and only the board thread reads the hour. Without it `readHour` is the window so far. */
  keepHour?: boolean;
  /** A histogram to merge windows into: Node's own unless a test gives its own. */
  merged?: () => RecordableHistogram;
  /** Adds the samples of `from` into `into`: `into.add(from)`, which Node does only for its own histograms, unless a test gives its own. */
  merge?: (into: RecordableHistogram, from: DelayHistogram) => void;
}>;

export type LoopMonitor = Readonly<{
  read: () => LoopReading;
  /** The last hour: the finished windows (at most HOUR_WINDOWS) and the one so far, merged. */
  readHour: () => LoopSpan;
  stop: () => void;
}>;

/**
 * Adds the samples of `from` into `into`. A histogram of Node's own recordable kind is added whole; the sampling histogram is copied by its quantiles ({@link QUANTILES} slices and its max), since Node adds
 * only a recordable histogram. Values are at least 1 ns: a histogram records none lower.
 */
export function mergeHistogram(into: RecordableHistogram, from: DelayHistogram): void {
  if (typeof (from as { record?: unknown }).record === "function") return into.add(from as unknown as RecordableHistogram);
  if (from.count === 0) return;
  const perSlice = Math.max(1, Math.round(from.count / QUANTILES));
  for (let slice = 0; slice < QUANTILES; slice++) {
    const value = Math.max(1, from.percentile(((slice + 0.5) / QUANTILES) * 100));
    for (let sample = 0; sample < perSlice; sample++) into.record(value);
  }
  into.record(Math.max(1, from.max));
}

/** A delay in ns as ms past the sampling timer, to one decimal place, and never below 0. PURE. */
const pastResolution = (ns: number): number => Math.max(0, Math.round((ns / NS_PER_MS - RESOLUTION_MS) * 10) / 10);

const unrefInterval = (run: () => void, ms: number): (() => void) => {
  const timer = setInterval(run, ms);
  timer.unref();
  return () => clearInterval(timer);
};

/** Starts measuring this thread's loop. `read` answers the last whole window, or the one so far before the first ends; `stop` ends the sampling. */
export function startLoopMonitor({ histogram = () => monitorEventLoopDelay({ resolution: RESOLUTION_MS }), now = Date.now, every = unrefInterval, keepHour = false, merged = createHistogram,
  merge = mergeHistogram }: LoopMonitorDeps = {}): LoopMonitor {
  const samples = histogram();
  samples.enable();
  let windowStart = now();
  let kept: LoopReading | null = null;
  let sinceStartMaxMs = 0;
  /** The finished windows, oldest first, each as a histogram of its own with the time it ended. */
  const finished: { histogram: RecordableHistogram; endedAt: number }[] = [];

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
  /** Keeps the finished window's samples for the hour. Measuring is never worth a throw out of a timer: a window that cannot be kept is left out of the hour. */
  const keep = (endedAt: number): void => {
    try {
      const window = merged();
      merge(window, samples);
      finished.push({ histogram: window, endedAt });
      if (finished.length > HOUR_WINDOWS) finished.shift();
    } catch {
      // The hour misses this minute; the minute's own reading was taken above.
    }
  };
  const stopWindows = every(() => {
    kept = takeWindow();
    if (keepHour) keep(kept.at);
    samples.reset();
    windowStart = kept.at;
  }, LOOP_WINDOW_MS);

  /** The finished windows and the one so far, merged, as a span. */
  const hour = (): LoopSpan => {
    const all = merged();
    for (const { histogram: window } of finished) merge(all, window as unknown as DelayHistogram);
    merge(all, samples);
    const at = now();
    const empty = all.count === 0;
    return { p50Ms: empty ? 0 : pastResolution(all.percentile(50)), p99Ms: empty ? 0 : pastResolution(all.percentile(99)), maxMs: empty ? 0 : pastResolution(all.max), windowMs: at - (finished[0] === undefined ? windowStart : finished[0].endedAt - LOOP_WINDOW_MS) };
  };

  return {
    // The window so far is taken every time, so a stall in it counts towards the worst since start before its window ends.
    read: () => {
      const live = takeWindow();
      return kept === null ? live : { ...kept, sinceStartMaxMs };
    },
    readHour: hour,
    stop: () => {
      stopWindows();
      samples.disable();
    },
  };
}
