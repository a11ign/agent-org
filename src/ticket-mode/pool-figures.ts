// @ts-check
// module: what the pool remembers of its `fill()` passes, and the figures it gives `/api/health` (A11-363)
//
// A PASS THAT RETURNS EARLY IS NOT A COMPLETED PASS. `fill` says why it gave up (`noteFillEarly`) and when it ran to its end (`noteFillCompleted`), so "no pass has completed for five minutes" is a pass that is hung, or one that
// gives up at every try, and the reason is on the board. A pass the board ends on purpose (an update draining, a failing preflight) says so in `holding`: nothing a restart would mend, so no start is waited for.
import { availableParallelism, loadavg } from "node:os";
import { fillFiguresOf, runFiguresOf, type PoolFigures } from "./health-figures.ts";
import type { PoolContext } from "./pool-context.ts";
import { nextStarts } from "./queue.ts";
import { pathsUnread } from "./queue/queue-transitions.ts";

/** A pass ran to its end. */
export function noteFillCompleted({ fillState, now }: Pick<PoolContext, "fillState" | "now">): void {
  fillState.completedAt = now();
  fillState.early = null;
}

/** A pass gave up before its end, for `reason`. */
export function noteFillEarly({ fillState, now }: Pick<PoolContext, "fillState" | "now">, reason: string): void {
  fillState.early = { reason, at: now() };
}

/** The pass is not starting anything on purpose, for `reason`, or is again (null). */
export function noteFillHolding({ fillState }: Pick<PoolContext, "fillState">, reason: string | null): void {
  fillState.holding = reason;
}

/** The instance is stopping: the pool starts nothing from now on. */
export function noteStopping({ fillState }: Pick<PoolContext, "fillState">): void {
  fillState.stopping = true;
}

/** A run was recorded as starting just now. */
export function noteRunStarted({ fillState, now }: Pick<PoolContext, "fillState" | "now">): void {
  fillState.lastStartAt = now();
}

/** The queued entries a pass would start now: the ones `fill` filters to, whose blockers and plan paths are read. */
export function startableNow(ctx: Pick<PoolContext, "store" | "deps">): number {
  const { load, cores } = (ctx.deps.load ?? (() => ({ load: loadavg()[0], cores: availableParallelism() })))();
  return nextStarts(ctx.store.get(), load, cores).filter((entry) => entry.blockers !== undefined && !pathsUnread(entry)).length;
}

/** The figures the pool gives `/api/health`: the runs (the latest start, who could start, the free slots) and the passes. */
export function poolFigures(ctx: Pick<PoolContext, "store" | "deps" | "fillState" | "now">): PoolFigures {
  const now = ctx.now();
  return { runs: runFiguresOf(ctx.store.get(), startableNow(ctx), ctx.fillState.holding, ctx.fillState.lastStartAt, now), fill: fillFiguresOf(ctx.fillState, now) };
}
