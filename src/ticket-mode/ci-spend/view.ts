// module: a run's CI as the page is sent it (A11-261) -- the run's and the ticket's figures and where the ticket stands against its budget -- PURE
//
// COMPUTED ON THE SERVER, from the runs the board holds, so the page is sent a few numbers per run and not every workflow run of every branch (`Queue.ciSpend` is not sent). The line the card shows is worded from this by `board-view/ci-note.ts`.
import type { CiView } from "../board-view/ci-note.ts";
import type { Entry, Queue } from "../queue/queue-entries-and-outcomes.ts";
import { budgetState } from "./budget.ts";
import { runsOf } from "./store.ts";
import { runsSince, totalsOf, type CiTotals } from "./weigh.ts";

/** When the run's CI count begins: its first start, or, for a run that started before the board recorded one, the time of its latest start. A run that has not started has none, so nothing is yet its own. */
export const ciSinceOf = (entry: Pick<Entry, "ciSince" | "startedAt">): number => entry.ciSince ?? entry.startedAt ?? Number.POSITIVE_INFINITY;

const figuresOf = ({ pushes, jobs, weighted }: CiTotals) => ({ pushes, jobs, weighted });

/** The run's CI for the page, or undefined for a ticket the board has read no workflow run of (nothing has run, or its code host reads none). `budget` is the host file's, 0 for none. PURE. */
export function ciViewOf(queue: Queue, entry: Entry, budget: number): CiView | undefined {
  const runs = runsOf(queue, entry.ticket.key);
  if (runs.length === 0) return undefined;
  const ticket = totalsOf(runs);
  return { run: figuresOf(totalsOf(runsSince(runs, ciSinceOf(entry)))), ticket: figuresOf(ticket), budget, state: budgetState(ticket.weighted, budget) };
}
