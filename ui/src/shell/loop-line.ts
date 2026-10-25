import type { LoopReading } from "../../../src/ticket-mode/loop-delay.ts";

/** At this p99, in ms, the line warns: the after-merge target of A11-282. */
export const WARN_MS = 100;

/** What the two `/api/health` reads gave: the instance's request thread and board loop, and the page service's own loop, each only when it was read. */
export type LoopHealth = Readonly<{ requests?: LoopReading; board?: LoopReading; page?: LoopReading }>;

/** The line under the connection pill: its words, whether it warns, and its tooltip. */
export type LoopLine = Readonly<{ text: string; warn: boolean; title: string }>;

/** A delay as the line says it: whole ms below a second, seconds with one decimal place from a second up. PURE. */
export function delayText(ms: number): string {
  const whole = Math.round(ms);
  return whole < 1000 ? `${whole} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const PARTS = [["Requests", "requests"], ["Board", "board"], ["Page", "page"]] as const;

/**
 * The loop line (A11-282): the p99 of the loop that answers requests (the request thread, or the board loop on an instance that has none), warning at WARN_MS, with every reading
 * in its tooltip. Null when the instance gave no reading, so nothing is drawn: before the first read, on an instance with no `/api/health`, or when the read failed. PURE.
 */
export function loopLine(health: LoopHealth): LoopLine | null {
  const shown = health.requests ?? health.board;
  if (shown === undefined) return null;
  const warn = shown.p99Ms >= WARN_MS;
  const text = `Loop p99 ${delayText(shown.p99Ms)}${warn ? ": background work is holding the board" : ""}`;
  const title = PARTS.flatMap(([label, part]) => {
    const reading = health[part];
    return reading === undefined ? [] : [`${label} p50 ${delayText(reading.p50Ms)} / p99 ${delayText(reading.p99Ms)} / max ${delayText(reading.maxMs)}`];
  }).join(", ");
  return { text, warn, title };
}
