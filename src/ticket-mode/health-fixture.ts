// @ts-check
// module: the figures a test's health view carries when the test is about something else (A11-363)
import { CALL_SERVICES, type CallFigures } from "./call-outcomes.ts";
import type { MeasuredFigures } from "./health-figures.ts";
import type { LoopReading } from "./loop-delay.ts";

const QUIET_CALLS = Object.fromEntries(CALL_SERVICES.map((service) => [service, { calls: 0, failures: 0, failuresPer100: 0 }])) as CallFigures;

/** The measured part of a health view whose board loop reads `loop`: a quiet hour with no holds and no calls. */
export const measuredOver = (loop: LoopReading): MeasuredFigures => ({ loop, hour: { p50Ms: loop.p50Ms, p99Ms: loop.p99Ms, maxMs: loop.maxMs, windowMs: loop.windowMs }, holds: 0, calls: QUIET_CALLS });
