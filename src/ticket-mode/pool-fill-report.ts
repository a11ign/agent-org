// @ts-check
// module: what the last fill of the free slots decided, and why (A11-364) -- kept for `/api/health`, and said in the log whenever it changes while runs are queued and none starts

import { log } from "./pool-state.ts";
import type { PoolContext } from "./pool-context.ts";

/** A queued run the last fill held back for what the board knows of its blockers or plan, and why. */
export type FillHeld = Readonly<{ key: string; reason: string }>;

/** What the last fill decided: when, in a sentence why it started what it did (or nothing), the queued runs it saw, those it started, and those it held for an unread or stale read. */
export type FillReport = Readonly<{ at: number; decision: string; queued: number; started: readonly string[]; held: readonly FillHeld[] }>;

/** The fill's memory: the last report, and the signature of the last decision said in the log, so a decision that stands is said once. */
export type FillState = { report: FillReport | null; said: string | null };

export const newFillState = (): FillState => ({ report: null, said: null });

/** How many held runs the log line names before it counts the rest. */
const NAMED = 3;

/** The log line of a report: its decision, and the first {@link NAMED} runs it held, each with its reason. PURE. */
export function fillLine({ decision, held }: Pick<FillReport, "decision" | "held">): string {
  const named = held.slice(0, NAMED).map(({ key, reason }) => `${key}: ${reason}`).join("; ");
  const more = held.length > NAMED ? ` (and ${held.length - NAMED} more)` : "";
  return `fill: ${decision}${held.length === 0 ? "" : ` -- held: ${named}${more}`}`;
}

/** Keep what this fill decided, for `/api/health`, and say it in the log when it differs from the last said (the decision, or the runs it held). A fill that stands says nothing more. */
export function noteFill(ctx: PoolContext, decision: string, queued: number, started: readonly string[], held: readonly FillHeld[]): void {
  const report: FillReport = { at: ctx.now(), decision, queued, started, held };
  ctx.fillState.report = report;
  // A pass that starts a run, or finds none queued, has nothing to explain: the start is the log's own, and an empty queue is not a refusal. The next pass that starts nothing with runs queued says why.
  if (queued === 0 || started.length > 0) {
    ctx.fillState.said = null;
    return;
  }
  const signature = `${decision}|${held.map(({ key }) => key).join(",")}`;
  if (ctx.fillState.said === signature) return;
  ctx.fillState.said = signature;
  log(fillLine(report));
}
