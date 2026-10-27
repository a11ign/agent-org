// @ts-check
// module: what the instance's `GET /api/health` answers (A11-282) -- both threads' loop delays, and the synchronous spawns that held the board thread the longest
//
// THE BOARD'S STATUS LINE READS THIS, and so do `scripts/loop-load.ts` and `scripts/loop-watch.ts`. The page's service answers its own loop at its root `/api/health` (`ui-server.ts`).
//
// TWO THREADS, TWO LOOPS. The request thread answers every read, so its delay (`requests`) is how long a request waits. The board thread runs the pool and every sweep, so its delay
// (`board`) is how long background work holds the board, and `blocking` names what held it. The board thread's reading comes in its snapshot, so `boardSnapshotAgeMs`, how long ago
// the last one came, rises while the board thread is held. `requestThreadSyncCalls` counts the synchronous spawns on the request thread since it listened, which should be none.
import { startLoopMonitor, type LoopMonitor, type LoopReading } from "./loop-delay.ts";
import { createBlockingLedger, type BlockingLedger, type BlockingSite } from "./blocking-ledger.ts";
import { addCallFigures, callOutcomes, type CallFigures, type CallLedger } from "./call-outcomes.ts";
import { HOLD_MS, HOLD_WINDOW_MS, type HealthFigures, type MeasuredFigures } from "./health-figures.ts";
import { rollingCount, type RollingCount } from "./rolling-count.ts";
import type { BoardSnapshot } from "./thread-messages.ts";
import type { WatchdogView } from "./watchdog-record.ts";

/** How long the last hour's reading is kept before it is worked out again, in ms. */
export const HOUR_READ_MS = 5_000;

/** `read`, remembered for `ms`. */
export function memoOver<T>(read: () => T, ms: number, now: () => number = Date.now): () => T {
  let kept: Readonly<{ at: number; value: T }> | null = null;
  return () => {
    const at = now();
    if (kept === null || at - kept.at >= ms) kept = { at, value: read() };
    return kept.value;
  };
}

/** How many call sites the health view names. */
export const HEALTH_SITES = 10;

/**
 * The board thread's health: its loop's reading as `board`, the call sites that held it the longest in total, the worst first, and what it measured for the rolling figures (`measured`, A11-363): its loop over the last
 * hour, the synchronous holds of the last hour and the calls to Linear and GitHub. Its snapshot carries all of it.
 */
export type HealthView = Readonly<{ loop: Readonly<{ board: LoopReading }>; blocking: readonly BlockingSite[]; measured: MeasuredFigures }>;

/** What the rolling figures are counted from besides the loop and the ledger: the synchronous holds, and the calls. */
export type FigureSources = Readonly<{ holds: Pick<RollingCount, "total">; calls: Pick<CallLedger, "figures"> }>;

/** The health view of a monitor, a ledger and the figures' sources. */
export function healthView(monitor: Pick<LoopMonitor, "read" | "readHour">, ledger: Pick<BlockingLedger, "worst">, sources: FigureSources): HealthView {
  const loop = monitor.read();
  return { loop: { board: loop }, blocking: ledger.worst(HEALTH_SITES), measured: { loop, hour: monitor.readHour(), holds: sources.holds.total(), calls: sources.calls.figures() } };
}

/**
 * Starts measuring the board thread: the loop monitor, and the ledger installed on its `node:child_process`, so every synchronous spawn from here on is timed. Answers the
 * health view's reader, which the board thread's snapshot carries. Made once, at the start of `ticket:serve`.
 */
export function startHealth(name: string): () => HealthView {
  const monitor = startLoopMonitor({ keepHour: true });
  // The hour merges sixty histograms, and the snapshot is read at every queue change: it is worked out at most every HOUR_READ_MS.
  const hour = memoOver(() => monitor.readHour(), HOUR_READ_MS);
  // A call that held the loop HOLD_MS or longer is a hold: counted for the last hour, which `/api/health` serves and the watchdog's record keeps beside the restarts (A11-363).
  const holds = rollingCount(HOLD_WINDOW_MS);
  const ledger = createBlockingLedger({ name, onCall: ({ ms }) => { if (ms >= HOLD_MS) holds.add(); } });
  ledger.install();
  return () => healthView({ read: monitor.read, readHour: hour }, ledger, { holds, calls: callOutcomes });
}

/** What the instance's `/api/health` answers: both threads' loop readings, how old the board thread's snapshot is, the spawns that held the board thread, and the request thread's own. */
export type RequestHealthView = Readonly<{
  loop: Readonly<{ requests: LoopReading; board: LoopReading }>;
  boardSnapshotAgeMs: number;
  blocking: readonly BlockingSite[];
  requestThreadSyncCalls: number;
  /** The rolling figures (A11-363), as the board thread worked them out when it posted its snapshot; `boardSnapshotAgeMs` is how old they are. Null before the first snapshot that carries them. */
  figures: HealthFigures | null;
  /** The watchdog's record (A11-363): the restarts it has made and the reasons, or null when it has none on record. */
  watchdog: WatchdogView | null;
}>;

/** The latest snapshot as the request thread holds it, and when it came, in ms since the epoch. */
export type LatestSnapshot = Readonly<{ snapshot: Pick<BoardSnapshot, "loop" | "blocking"> & Partial<Pick<BoardSnapshot, "figures">>; receivedAt: number }>;

/** The health view of the request thread's reading, the latest snapshot at `now`, the request thread's synchronous spawns since it listened, and the watchdog's record. PURE. */
export function requestHealthView(requests: LoopReading, latest: LatestSnapshot, now: number, syncCalls: number, watchdog: WatchdogView | null = null, pageCalls: CallFigures | null = null): RequestHealthView {
  const figures = latest.snapshot.figures ?? null;
  // The request thread's own calls to Linear and GitHub (the page's reads) are added to the board thread's: both are the instance's calls.
  return { loop: { requests, board: latest.snapshot.loop }, boardSnapshotAgeMs: Math.max(0, now - latest.receivedAt), blocking: latest.snapshot.blocking, requestThreadSyncCalls: syncCalls,
    figures: figures === null || pageCalls === null ? figures : { ...figures, calls: addCallFigures(figures.calls, pageCalls) }, watchdog };
}

export type RequestHealthDeps = Readonly<{ latest: () => LatestSnapshot; now?: () => number; err?: (line: string) => void; watchdog?: () => WatchdogView | null }>;

/**
 * Starts measuring the request thread: its own loop monitor, and a ledger on its own `node:child_process` (each thread has its own) that counts every synchronous spawn after
 * `listening` and says each as an ERROR. Answers the health view's reader. Made once, at the start of the request thread.
 */
export function startRequestHealth({ latest, now = Date.now, err = (line) => process.stderr.write(line), watchdog = () => null }: RequestHealthDeps): Readonly<{ listening: () => void; view: () => RequestHealthView }> {
  const monitor = startLoopMonitor();
  let answering = false;
  let syncCalls = 0;
  const ledger = createBlockingLedger({
    name: "ticket:serve request thread",
    err,
    onCall: ({ site, program }) => {
      if (!answering) return;
      syncCalls += 1;
      err(`ERROR request thread: synchronous ${program} at ${site}\n`);
    },
  });
  ledger.install();
  return { listening: () => { answering = true; }, view: () => requestHealthView(monitor.read(), latest(), now(), syncCalls, watchdog(), callOutcomes.figures()) };
}
