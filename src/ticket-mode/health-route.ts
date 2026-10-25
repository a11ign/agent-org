// @ts-check
// module: what the instance's `GET /api/health` answers (A11-282) -- the board loop's delay, and the synchronous spawns that held it the longest
//
// THE BOARD'S STATUS LINE READS THIS, and so do `scripts/loop-load.ts` and `scripts/loop-watch.ts`. The instance's loop answers every request and runs every sweep, so its
// delay is how long a request waits; `blocking` names what held it. The page's service answers its own loop at its root `/api/health` (`ui-server.ts`).
import { startLoopMonitor, type LoopMonitor, type LoopReading } from "./loop-delay.ts";
import { createBlockingLedger, type BlockingLedger, type BlockingSite } from "./blocking-ledger.ts";

/** How many call sites the health view names. */
export const HEALTH_SITES = 10;

/** What the instance's `/api/health` answers: its loop's reading as `board`, and the call sites that held it the longest in total, the worst first. */
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
