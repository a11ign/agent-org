// @ts-check
// module: what a queued run records of its ticket's text, and of what its blockers' pull requests found (A11-167, ADR 0005)
//
// THE TYPES ARE THE ENTRY'S, THE TRANSITIONS ARE THE QUEUE'S. `Entry` (`queue-entries-and-outcomes.ts`) names the three types below for its `plannedAgainst`, `ticketChange` and `learned` fields; the
// transitions record them. They sit apart from the rest of the queue so each of those modules stays within the public API a module may have.
import type { PlanStamp } from "../plan-stamp.ts";
import type { TicketRead } from "../ticket-read.ts";
import { replace, type Queue, type RunChoice } from "./queue-entries-and-outcomes.ts";

/** A change to a ticket's description the board noticed (A11-167): when, the description before and the description after. */
export type TicketChange = Readonly<{ at: number; from: string; to: string }>;

/**
 * What a queued run's planner was given from a merged pull request of one of its blockers (A11-167): the blocker's key, the pull request's number and title, and the file under the ticket's folder that holds
 * its title, body and the sections it added. Recorded by the pull request's address.
 */
export type Learned = Readonly<{ key: string; number: number; title: string; file: string }>;

/** What an attached plan says of the text it was planned against: its stamp, and the pull requests its `## What the blockers found` section names. */
export type PlannedAgainst = PlanStamp & Readonly<{ named: readonly string[] }>;

/**
 * Record what each queued run's attached plan says of the text it was planned against (A11-167), for each run whose plan was read: its stamp, or `null` for a plan with none, which is never read as
 * stale. A stale mark the plan no longer deserves goes with it. A run that has started keeps what it started with.
 */
export function recordPlannedAgainst(queue: Queue, stamps: ReadonlyMap<string, PlannedAgainst | null>): Queue {
  return { ...queue, entries: queue.entries.map((entry) => {
    const found = stamps.get(entry.ticket.key);
    if (entry.phase !== "queued" || found === undefined) return entry;
    const { plannedAgainst: _read, ...rest } = entry;
    return found === null ? rest : { ...rest, plannedAgainst: found };
  }) };
}

/** Record the stamp the board wrote into the plan a planning run left, which the run keeps as it is queued again: it knows the text it was planned against without reading its plan back (A11-167). */
export function recordStampedPlan(queue: Queue, key: string, stamp: PlannedAgainst): Queue {
  return replace(queue, key, (entry) => ({ ...entry, plannedAgainst: stamp }));
}

/** Record the text of its ticket each of `keys` was briefed with (A11-167). */
export function recordBriefed(queue: Queue, keys: readonly string[], read: TicketRead): Queue {
  return { ...queue, entries: queue.entries.map((entry) => (keys.includes(entry.ticket.key) ? { ...entry, briefedAgainst: read } : entry)) };
}

/** Mark a queued run's plan stale with the change that made it so, or clear the mark with `undefined` once the ticket holds the text it was planned against again (A11-167). */
export function markTicketChanged(queue: Queue, key: string, change: TicketChange | undefined): Queue {
  return replace(queue, key, (entry) => {
    if (entry.phase !== "queued") return entry;
    const { ticketChange: _before, ...rest } = entry;
    return change === undefined ? rest : { ...rest, ticketChange: change };
  });
}

/** A change to a live run's ticket was sent to its worker: it is recorded, and the run is now briefed against the new text (A11-167). */
export function recordTicketChange(queue: Queue, key: string, change: TicketChange, read: TicketRead): Queue {
  return replace(queue, key, (entry) => ({ ...entry, ticketChanges: [...(entry.ticketChanges ?? []), change], briefedAgainst: read }));
}

/** Record what a queued run's planner is given from a merged pull request of one of its blockers, by the pull request's address (A11-167). */
export function recordLearned(queue: Queue, key: string, url: string, learned: Learned): Queue {
  return replace(queue, key, (entry) => (entry.phase === "queued" ? { ...entry, learned: { ...entry.learned, [url]: learned } } : entry));
}

/** The pull requests a planning brief gave its planner the findings of (A11-167): the plan is held to naming each. */
export function recordFindingsGiven(queue: Queue, key: string, urls: readonly string[]): Queue {
  return replace(queue, key, (entry) => ({ ...entry, findingsGiven: urls }));
}

/**
 * A queued run's plan is written again (A11-167): it becomes a planning run on `plan`, with its stale plan's paths and stamp dropped, since the plan they were read from is detached. The mark of what
 * changed stays, so the run says why it plans again.
 */
export function replan(queue: Queue, key: string, plan: RunChoice, previous: readonly string[], change: TicketChange | undefined): Queue {
  return replace(queue, key, ({ paths: _paths, pathsFailure: _failed, plannedAgainst: _stamp, planned: _planned, ticketChange: _before, ...entry }) =>
    ({ ...entry, plan, previousPlan: previous, ...(change ? { ticketChange: change } : {}) }));
}
