// @ts-check
// module: what the board's header and `doctor` flag in the health figures (A11-363) -- a loop p99 over 100 ms, call failures over 1%, any watchdog restart in the last day
//
// PURE, AND IMPORTS TYPES ONLY, because the board's UI bundles it: the header and `doctor` say the same words for the same figures. The 100 ms is the after-merge target of A11-282, the figure the header has always warned at.
import type { CallService } from "./call-outcomes.ts";
import type { HealthFigures } from "./health-figures.ts";
import type { WatchdogView } from "./watchdog-record.ts";

/** The loop p99 the header and `doctor` flag above, in ms. */
export const LOOP_P99_WARN_MS = 100;
/** The failures per 100 calls the header and `doctor` flag above. */
export const CALL_FAILURES_WARN_PER_100 = 1;

/** One thing worth a person's eye: which figure, and a sentence that says what it reads. */
export type HealthFlag = Readonly<{ figure: "loop" | "calls" | "watchdog"; text: string }>;

const SERVICE_WORDS: Readonly<Record<CallService, string>> = { linear: "Linear", github: "GitHub" };

/** A delay as the flags say it: whole ms below a second, seconds with one decimal place from a second up. */
const delay = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** The flags the figures and the watchdog's record call for, in the order the header shows them. Nothing is flagged when a figure is not there. PURE. */
export function healthFlags(figures: HealthFigures | null | undefined, watchdog: Pick<WatchdogView, "restartsLastDay" | "last"> | null | undefined): readonly HealthFlag[] {
  const flags: HealthFlag[] = [];
  if (figures !== null && figures !== undefined) {
    const { lastMinute, lastHour } = figures.loop;
    const over = [lastMinute.p99Ms > LOOP_P99_WARN_MS ? `${delay(lastMinute.p99Ms)} over the last minute` : null, lastHour.p99Ms > LOOP_P99_WARN_MS ? `${delay(lastHour.p99Ms)} over the last hour` : null].filter((part) => part !== null);
    if (over.length > 0) flags.push({ figure: "loop", text: `Event loop lag p99 is ${over.join(" and ")}, over ${LOOP_P99_WARN_MS} ms: background work is holding the board` });
    for (const [service, call] of Object.entries(figures.calls) as [CallService, HealthFigures["calls"][CallService]][]) {
      if (call.failuresPer100 > CALL_FAILURES_WARN_PER_100) flags.push({ figure: "calls", text: `${SERVICE_WORDS[service]} calls fail ${call.failuresPer100} in 100 (${call.failures} of ${call.calls} in the last hour), over ${CALL_FAILURES_WARN_PER_100}` });
    }
  }
  if (watchdog !== null && watchdog !== undefined && watchdog.restartsLastDay > 0) {
    const last = watchdog.last === null ? "" : `; the last was for ${watchdog.last.reason}: ${watchdog.last.detail}`;
    flags.push({ figure: "watchdog", text: `The watchdog restarted the board ${watchdog.restartsLastDay} time${watchdog.restartsLastDay === 1 ? "" : "s"} in the last day${last}` });
  }
  return flags;
}
