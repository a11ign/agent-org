// @ts-check
// module: the board's sweep over a ticket that holds queued runs back, is In Progress and has no run (A11-347)
//
// WHAT TO DO IS `board-view/idle-blocker.ts`'s DECISION, which the sentence on the Runs page reads too. This file acts on it, once for each ticket each tick: a ticket whose pull requests have all merged, one of them closing it, is
// COMPLETED in the tracker (its dependents start on the next refresh, which reads the blockers afresh), and any other is QUEUED on the saved choice (`choice.json`'s model and effort, as a person's add queues it), with no plan run
// first: it was started and has merged work, and a ticket that has no plan is not planned on a dependent's account. A ticket another instance holds (ADR A11-168-0001) is left to that instance. A refusal is said once and the next tick
// tries again; a tick never overlaps another.
import { idleBlockerOf, idleBlockers, type IdleBlocker } from "./board-view/idle-blocker.ts";
import { pullLabel } from "./board-view/pull-label.ts";
import { firstLine } from "./dependency-updates/context.ts";
import { takenState } from "./pick-taken.ts";
import type { Queue, RunChoice } from "./queue/queue-entries-and-outcomes.ts";
import type { Ticket, TicketSource } from "./source.ts";

/** What the sweep needs of the board: the tracker's reads and its completion, the queue and its one add, the saved choice, and who this instance is. */
export type IdleBlockerDeps = Readonly<{
  source: Pick<TicketSource, "read" | "complete" | "claims">;
  store: Readonly<{ get: () => Queue }>;
  /** The board's one queue add (`POST /api/queue` uses it). */
  queueTickets: (tickets: readonly Ticket[], choice: RunChoice, options: { plan: boolean }) => void;
  /** The saved choice, read fresh: the model and effort a queued ticket runs with. */
  runChoice: () => RunChoice;
  /** The states `tickets.providers.tracker.takenStates` names, and this instance's own claimant name: what tells a ticket another instance holds. */
  takenStates: readonly string[];
  claimant: () => string;
  log: (line: string) => void;
}>;

/** The sweep: call it on the feedback cadence. It never throws for a read that failed; it says why and tries again next tick. */
export function idleBlockerSweep(deps: IdleBlockerDeps): () => Promise<void> {
  const said = new Set<string>();
  const sayOnce = (line: string): void => {
    if (said.has(line)) return;
    said.add(line);
    deps.log(line);
  };
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      for (const idle of idleBlockers(deps.store.get().entries)) await act(deps, idle, sayOnce);
    } finally {
      running = false;
    }
  };
}

/** Do what the decision says of one ticket, if it still says it once the tracker has answered: a run queued meanwhile leaves the ticket alone. */
async function act(deps: IdleBlockerDeps, idle: IdleBlocker, sayOnce: (line: string) => void): Promise<void> {
  try {
    if (idle.action === "complete") await completeIdle(deps, idle);
    else if (idle.action === "queue") await queueIdle(deps, idle, sayOnce);
  } catch (err) {
    sayOnce(`${idle.key}: it has no run and blocks ${idle.blocks.join(", ")}, but the board could not ${idle.action} it (${firstLine(err)}); it tries again at the next sweep`);
  }
}

/** Complete the ticket, with a comment that names the pull requests and the tickets it was holding back. A tracker that cannot complete a ticket leaves it to a person, and says so. */
async function completeIdle(deps: IdleBlockerDeps, idle: IdleBlocker): Promise<void> {
  const { complete } = deps.source;
  if (complete === undefined) throw new Error("this tracker cannot complete a ticket");
  if (idleBlockerOf(idle.key, deps.store.get().entries)?.action !== "complete") return;
  const note = await complete(idle.key, `${idle.merged.map(pullLabel).join(", ")} merged, one of them closing ${idle.key}, but the tracker had not completed it and the board had no run for it, so the ticket board completed it. It was holding back ${idle.blocks.join(", ")}.`);
  deps.log(`${idle.key}: all ${idle.pulls} of its pull requests merged and it had no run, so the board completed it; it was holding back ${idle.blocks.join(", ")}${note === null ? "" : ` (${note})`}`);
}

/** Queue the ticket on the saved choice, unless another instance holds it or the tracker has no such ticket. */
async function queueIdle(deps: IdleBlockerDeps, idle: IdleBlocker, sayOnce: (line: string) => void): Promise<void> {
  const ticket = await deps.source.read(idle.key);
  if (ticket === null) throw new Error("the tracker has no such ticket");
  const claimant = deps.source.claims === undefined ? undefined : (await deps.source.claims([idle.key])).get(idle.key);
  const taken = takenState(ticket, deps.takenStates, claimant, deps.claimant());
  if (taken !== null) {
    sayOnce(`${idle.key}: it has no run here and blocks ${idle.blocks.join(", ")}, but ${claimant} claimed it and it is ${taken}, so another instance holds it and the board leaves it`);
    return;
  }
  if (idleBlockerOf(idle.key, deps.store.get().entries)?.action !== "queue") return;
  const choice = deps.runChoice();
  deps.queueTickets([ticket], choice, { plan: false });
  deps.log(`${idle.key}: it has open work and no run and blocks ${idle.blocks.join(", ")}, so the board queued it on ${choice.model} at ${choice.effort}`);
}
