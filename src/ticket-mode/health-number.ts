// @ts-check
// module: the board's health number -- how often a person had to step in, and how often the board settled a disagreement without one (A11-257, A11-290) -- PURE
//
// THE MEASURE OF "FULLY AUTONOMOUS" IS HOW OFTEN A PERSON IS ASKED. A11-257 counts the person-interventions per day: the Needs-you cards the runs logged (`needs-you` in the run log). A11-290 adds the other side, so the chairman can see the route work: the STAND-OFFS the board
// settled with no person (`standoff` events with step `settled`: a re-review that stayed not convinced at an unchanged head, routed to the planner and the worker, and ended on a new head or an approval). Both are counted by the day they were logged, in UTC,
// from the logs of every ticket, so a ticket that left the queue still counts for the day it was logged.
import type { Queue } from "./queue/queue-entries-and-outcomes.ts";
import { logOf } from "./queue/run-log.ts";

const DAY_MS = 24 * 60 * 60_000;

/** One day (UTC, `YYYY-MM-DD`): the Needs-you cards the runs logged, and the stand-offs settled with no person. */
export type HealthDay = Readonly<{ day: string; personInterventions: number; standoffsSettled: number }>;

/** The UTC day of a time. */
const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/**
 * The last `days` days up to and including the day of `now`, oldest first, each with its counts. A day with nothing logged is there with zeros, so the series has no gaps. PURE.
 */
export function healthNumber(queue: Queue, now: number, days = 7): readonly HealthDay[] {
  const counts = new Map<string, { personInterventions: number; standoffsSettled: number }>();
  for (let back = days - 1; back >= 0; back -= 1) counts.set(dayOf(now - back * DAY_MS), { personInterventions: 0, standoffsSettled: 0 });
  for (const key of Object.keys(queue.runLog ?? {})) {
    for (const event of logOf(queue, key)) {
      const held = counts.get(dayOf(event.at));
      if (held === undefined) continue;
      if (event.kind === "needs-you") held.personInterventions += 1;
      else if (event.kind === "standoff" && event.step === "settled") held.standoffsSettled += 1;
    }
  }
  return [...counts].map(([day, held]) => ({ day, ...held }));
}
