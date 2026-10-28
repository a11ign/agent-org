import type { HealthFigures } from "../../../src/ticket-mode/health-figures.ts";
import { healthFlags } from "../../../src/ticket-mode/health-flags.ts";
import type { LoopReading } from "../../../src/ticket-mode/loop-delay.ts";
import type { WatchdogView } from "../../../src/ticket-mode/watchdog-record.ts";

/** At this p99, in ms, the line warns: the after-merge target of A11-282. */
export const WARN_MS = 100;

/** What the two `/api/health` reads gave: the instance's request thread and board loop, and the page service's own loop, each only when it was read. */
export type LoopHealth = Readonly<{ requests?: LoopReading; board?: LoopReading; page?: LoopReading; figures?: HealthFigures; watchdog?: WatchdogView }>;

/**
 * The lines under the connection pill: the loop's words, whether they warn, and the tooltip; then the rolling figures (A11-363) as `details`, one short line each, and `flags`, a sentence for each
 * figure over its limit (a loop p99 over 100 ms, call failures over 1%, a watchdog restart in the last day).
 */
export type LoopLine = Readonly<{ text: string; warn: boolean; title: string; details: readonly string[]; flags: readonly string[] }>;

/** A delay as the line says it: whole ms below a second, seconds with one decimal place from a second up. PURE. */
export function delayText(ms: number): string {
  const whole = Math.round(ms);
  return whole < 1000 ? `${whole} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** A time since, as the details say it: seconds below a minute, whole minutes below an hour, hours with one decimal place from an hour up. PURE. */
export function ageText(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** The figures as short lines: the loop over a minute and an hour with the holds, the failed calls, and the runs and the fill passes. PURE. */
export function figureDetails(figures: HealthFigures): readonly string[] {
  const { loop, syncHolds, calls, runs, fill } = figures;
  const failing = (["linear", "github"] as const).map((service) => `${service === "linear" ? "Linear" : "GitHub"} ${calls[service].failuresPer100}`).join(", ");
  const early = fill.lastEarlyReturn === null ? "" : `; its last pass returned early: ${fill.lastEarlyReturn.reason}`;
  return [
    `Loop p50/p99: ${delayText(loop.lastMinute.p50Ms)} / ${delayText(loop.lastMinute.p99Ms)} over 1 min, ${delayText(loop.lastHour.p50Ms)} / ${delayText(loop.lastHour.p99Ms)} over 1 h; ${plural(syncHolds.lastHour, "hold", "holds")} an hour`,
    `Failed calls per 100: ${failing}`,
    `Last run start ${runs.sinceLastStartMs === null ? "never" : `${ageText(runs.sinceLastStartMs)} ago`}; ${plural(runs.startable, "startable run", "startable runs")}, ${plural(runs.freeSlots, "free slot", "free slots")}; last fill ${fill.sinceLastCompletedMs === null ? "not yet" : `${ageText(fill.sinceLastCompletedMs)} ago`}${early}`,
  ];
}

const PARTS = [["Requests", "requests"], ["Board", "board"], ["Page", "page"]] as const;

/**
 * The loop line (A11-282): the p99 of the loop that answers requests (the request thread, or the board loop on an instance that has none), warning at WARN_MS, with every reading
 * in its tooltip. Null when the instance gave no reading, so nothing is drawn: before the first read, on an instance with no `/api/health`, or when the read failed. PURE.
 */
export function loopLine(health: LoopHealth): LoopLine | null {
  const shown = health.requests ?? health.board;
  if (shown === undefined) return null;
  const flags = healthFlags(health.figures, health.watchdog).map((flag) => flag.text);
  const warn = shown.p99Ms >= WARN_MS;
  const text = `Loop p99 ${delayText(shown.p99Ms)}${warn ? ": background work is holding the board" : ""}`;
  const title = PARTS.flatMap(([label, part]) => {
    const reading = health[part];
    return reading === undefined ? [] : [`${label} p50 ${delayText(reading.p50Ms)} / p99 ${delayText(reading.p99Ms)} / max ${delayText(reading.maxMs)}`];
  }).join(", ");
  return { text, warn, title, details: health.figures === undefined ? [] : figureDetails(health.figures), flags };
}
