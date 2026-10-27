// @ts-check
// module: the pool's side of the round cap (A11-343) -- settling the planner's round, and starting a waiting run again when the ticket it waits on merges
//
// A ROUND CAP IS NOT ON THE ESCALATION LIST, so a run that used up the board's own rounds is routed to the planner (`queue-cap.ts`), whose round decides: one more round with a recorded Decision, a wait on a named ticket, or (a `needs-human` outcome that names an
// item of the escalation list) a person. `settleCapRound` takes the first two. `resumeTicketWaits` is the sweep that ends a wait: the ticket's pull request merged, or the tracker completed or canceled it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCapDecision } from "./cap-decision.ts";
import { CAP_DECISION_FILE } from "./cap-files.ts";
import { type PoolContext } from "./pool-context.ts";
import { log, messageOf, runPlace, update } from "./pool-state.ts";
import { capDecided, MAX_CAP_PLANS, ticketWaitEnded, ticketWaits, type CapDecision } from "./queue/queue-cap.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import { ticketDir } from "./ticket-paths.ts";
import { PLAN_DIR } from "./worker-files.ts";

/** What settling the planner's round at the cap decided: the decision it took, or the words that say why it could not be taken. */
export type CapSettled = Readonly<{ decided: CapDecision } | { refused: string }>;

/** Whether the planner's plan folder holds an amended plan file: a `round` Decision may be recorded in the plan too, and the board attaches it when it is there. */
const wrotePlan = (dir: string): boolean => existsSync(join(dir, PLAN_DIR)) && readdirSync(join(dir, PLAN_DIR)).length > 0;

/**
 * The planner's round at the cap ended `reviewed`: its decision is read from the run's folder. A `round` Decision that amended the plan has the plan attached first (`attachAmended` answers null once it is attached, else the words that refuse it). A `waiting`
 * decision that names the run's own ticket is no decision. Answers the decision for the caller to end the run with and record, or the refusal.
 */
export async function settleCapRound(ctx: PoolContext, entry: Entry, attachAmended: () => Promise<string | null>): Promise<CapSettled> {
  const dir = runPlace(ctx, entry).dir;
  const path = join(dir, CAP_DECISION_FILE);
  if (!existsSync(path)) return { refused: `the planner's round wrote no ${CAP_DECISION_FILE}` };
  const read = parseCapDecision(readFileSync(path, "utf8"), path);
  if (typeof read === "string") return { refused: read };
  if (read.decision === "waiting" && read.ticket === entry.ticket.key) return { refused: `${path} says the run waits on its own ticket, ${entry.ticket.key}` };
  if (read.decision === "round" && (entry.capPlans ?? 0) > MAX_CAP_PLANS) return { refused: `the board has asked the planner about ${entry.ticket.key} ${entry.capPlans} times at its round cap, so another round is refused: mark the run as waiting on a ticket, or escalate` };
  if (read.decision === "round" && wrotePlan(ticketDir(ctx.settings, entry.ticket.key))) {
    const refused = await attachAmended();
    if (refused !== null) return { refused };
  }
  return { decided: read };
}

/** The planner's round ended with `decided`: record it on the run, which has finished by now, and say so. */
export function recordCapDecision(ctx: PoolContext, key: string, decided: CapDecision): void {
  update(ctx, (queue) => capDecided(queue, key, decided, ctx.now()));
  log(decided.decision === "waiting" ? `${key}: the planner marked the run as waiting on ${decided.ticket}` : `${key}: the planner recorded a Decision and the board starts one more round with it`);
}

/** Whether the tracker's pull requests of a ticket all ended in a merge: at least one merged, and none is open. */
const mergedPulls = (pulls: Readonly<Record<string, string>> | undefined): boolean => {
  const states = Object.values(pulls ?? {});
  return states.includes("merged") && !states.includes("open");
};

/** The longest a run waits on a ticket before the planner is asked again (A11-343): a ticket that never merges must not hold a run for ever. */
export const WAIT_LIMIT_MS = 7 * 24 * 60 * 60_000;

/**
 * Why the wait on a ticket has ended, in words, or null when it has not: its pull request merged, every pull request it had closed unmerged, the tracker completed or canceled it or has no such ticket, or the wait ran `WAIT_LIMIT_MS`. `state` is
 * undefined for a ticket the tracker did not list; `known` is whether the tracker could say so at all.
 */
function endedBecause(read: Readonly<{ state: string | undefined; pulls: Readonly<Record<string, string>> | undefined; known: boolean; waited: number }>): string | null {
  const { state, pulls, known, waited } = read;
  if (mergedPulls(pulls)) return "merged its pull request";
  if (state === "completed") return "was completed";
  if (state === "canceled") return "was canceled";
  const closed = Object.values(pulls ?? {});
  if (closed.length > 0 && closed.every((each) => each === "closed")) return "had its pull requests closed without a merge";
  if (known && state === undefined && pulls === undefined) return "is not in the tracker";
  return waited >= WAIT_LIMIT_MS ? "has not merged in a week" : null;
}

/**
 * Start again every finished run waiting on a ticket (A11-343) whose wait has ended: that ticket's pull request merged, or the tracker completed or canceled it. The run goes back on the queue as a round of its worker (`ticketWaitEnded`). A read the tracker
 * refuses changes nothing, and the next sweep asks again.
 */
export async function resumeTicketWaits(ctx: PoolContext): Promise<void> {
  const { source, store } = ctx;
  const waits = ticketWaits(store.get());
  if (waits.length === 0 || (source.pullStates === undefined && source.stateTypes === undefined)) return;
  const keys = [...new Set(waits.map(({ on }) => on))];
  try {
    const pulls = source.pullStates === undefined ? new Map() : await source.pullStates(keys);
    const states = source.stateTypes === undefined ? new Map() : await source.stateTypes(keys);
    const known = source.stateTypes !== undefined;
    for (const { key, on, since } of waits) {
      const why = endedBecause({ state: states.get(on), pulls: pulls.get(on), known, waited: ctx.now() - since });
      if (why === null) continue;
      update(ctx, (queue) => ticketWaitEnded(queue, key, why, ctx.now()));
      log(`${key}: ${on} ${why}, so the run's wait on it is over and a round is queued`);
    }
  } catch (err) {
    log(`the tickets ${keys.join(", ")} could not be read for the runs waiting on them (${messageOf(err).split("\n")[0]}); the next sweep asks again`);
  }
}
