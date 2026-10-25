// @ts-check
// module: what the instance's `GET /api/health` answers (A11-282) -- the board loop's delay, and the synchronous spawns that held it the longest
//
// THE BOARD'S STATUS LINE READS THIS, and so do `scripts/loop-load.ts` and `scripts/loop-watch.ts`. The page's service answers its own loop at its root `/api/health` (`ui-server.ts`).
//
// TWO THREADS, TWO LOOPS. The request thread answers every read, so its delay (`requests`) is how long a request waits. The board thread runs the pool and every sweep, so its delay
// (`board`) is how long background work holds the board, and `blocking` names what held it. The board thread's reading comes in its snapshot, so `boardSnapshotAgeMs`, how long ago
// the last one came, rises while the board thread is held. `requestThreadSyncCalls` counts the synchronous spawns on the request thread since it listened, which should be none.
import { startLoopMonitor, type LoopMonitor, type LoopReading } from "./loop-delay.ts";
import { createBlockingLedger, type BlockingLedger, type BlockingSite } from "./blocking-ledger.ts";
import type { BoardSnapshot } from "./thread-messages.ts";

/** How many call sites the health view names. */
export const HEALTH_SITES = 10;

/** The board thread's health: its loop's reading as `board`, and the call sites that held it the longest in total, the worst first. Its snapshot carries both. */
export type HealthView = Readonly<{ loop: Readonly<{ board: LoopReading }>; blocking: readonly BlockingSite[] }>;

/** The health view of a monitor and a ledger. */
export function healthView(monitor: Pick<LoopMonitor, "read">, ledger: Pick<BlockingLedger, "worst">): HealthView {
  return { loop: { board: monitor.read() }, blocking: ledger.worst(HEALTH_SITES) };
}

/**
 * Starts measuring the instance: the loop monitor, and the ledger installed on `node:child_process`, so every synchronous spawn from here on is timed. Answers the
 * health view's reader. Made once, at the start of `ticket:serve`.
 */
export function startHealth(name: string): () => HealthView {
  const monitor = startLoopMonitor();
  const ledger = createBlockingLedger({ name });
  ledger.install();
  return () => healthView(monitor, ledger);
}

/** What the instance's `/api/health` answers: both threads' loop readings, how old the board thread's snapshot is, the spawns that held the board thread, and the request thread's own. */
export type RequestHealthView = Readonly<{
  loop: Readonly<{ requests: LoopReading; board: LoopReading }>;
  boardSnapshotAgeMs: number;
  blocking: readonly BlockingSite[];
  requestThreadSyncCalls: number;
}>;

/** The latest snapshot as the request thread holds it, and when it came, in ms since the epoch. */
export type LatestSnapshot = Readonly<{ snapshot: Pick<BoardSnapshot, "loop" | "blocking">; receivedAt: number }>;

/** The health view of the request thread's reading, the latest snapshot at `now`, and the request thread's synchronous spawns since it listened. PURE. */
export function requestHealthView(requests: LoopReading, latest: LatestSnapshot, now: number, syncCalls: number): RequestHealthView {
  return { loop: { requests, board: latest.snapshot.loop }, boardSnapshotAgeMs: Math.max(0, now - latest.receivedAt), blocking: latest.snapshot.blocking, requestThreadSyncCalls: syncCalls };
}

export type RequestHealthDeps = Readonly<{ latest: () => LatestSnapshot; now?: () => number; err?: (line: string) => void }>;

/**
 * Starts measuring the request thread: its own loop monitor, and a ledger on its own `node:child_process` (each thread has its own) that counts every synchronous spawn after
 * `listening` and says each as an ERROR. Answers the health view's reader. Made once, at the start of the request thread.
 */
export function startRequestHealth({ latest, now = Date.now, err = (line) => process.stderr.write(line) }: RequestHealthDeps): Readonly<{ listening: () => void; view: () => RequestHealthView }> {
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
  return { listening: () => { answering = true; }, view: () => requestHealthView(monitor.read(), latest(), now(), syncCalls) };
}
