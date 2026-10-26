// @ts-check
// module: how often a person had to step in, by day (A11-257, `Queue.interventions`) -- PURE
//
// THE BOARD'S HEALTH NUMBER. A run that reaches a person (a Needs-you card) and a fix a chairman session makes by hand are each one intervention, and the target is none. Each is counted on the UTC day it
// happened, so the count does not change with the time zone of the machine that reads it. The run log cannot hold a week of them (it keeps 50 ended tickets' logs), so the tally is its own field of the queue,
// kept for {@link DAYS_KEPT} days. {@link logEvent} counts a Needs-you event as it logs it, which is why every transition into Needs you is counted once without each being edited.
import type { Queue } from "./queue-entries-and-outcomes.ts";

/** How many days the tally keeps: today and the 29 before it. */
export const DAYS_KEPT = 30;

/** How many days `/api/interventions` answers. */
export const DAYS_SHOWN = 7;

const DAY_MS = 86_400_000;

/** What one day holds: the runs that went to Needs you, and the fixes a chairman session recorded. */
export type DayCount = Readonly<{ needsYou: number; fixes: number }>;

/** The tally by UTC day, `YYYY-MM-DD`. */
export type Interventions = Readonly<Record<string, DayCount>>;

/** One day as `/api/interventions` answers it: its date, each kind and their total. */
export type DayView = Readonly<{ date: string; needsYou: number; fixes: number; total: number }>;

/** What `/api/interventions` answers: the last {@link DAYS_SHOWN} days, oldest first, and today's total. */
export type InterventionsView = Readonly<{ today: number; days: readonly DayView[] }>;

/** The UTC day, `YYYY-MM-DD`, of a time in milliseconds. */
export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** The tally with one more of `kind` on the day of `at`, and the days older than {@link DAYS_KEPT} dropped. */
function counted(queue: Queue, at: number, kind: keyof DayCount): Queue {
  const day = dayOf(at);
  const held = queue.interventions?.[day] ?? { needsYou: 0, fixes: 0 };
  const oldest = dayOf(at - (DAYS_KEPT - 1) * DAY_MS);
  const kept = Object.entries({ ...queue.interventions, [day]: { ...held, [kind]: held[kind] + 1 } }).filter(([each]) => each >= oldest);
  return { ...queue, interventions: Object.fromEntries(kept) };
}

/** The queue with one more run counted as gone to Needs you, on the day of `at`. PURE. */
export const countNeedsYou = (queue: Queue, at: number): Queue => counted(queue, at, "needsYou");

/** The queue with one more fix a chairman session made by hand counted, on the day of `at`. PURE. */
export const countFix = (queue: Queue, at: number): Queue => counted(queue, at, "fixes");

/** The last {@link DAYS_SHOWN} days at `now`, oldest first, a day with none counting 0, and today's total. PURE. */
export function interventionsView(queue: Queue, now: number): InterventionsView {
  const days = Array.from({ length: DAYS_SHOWN }, (_, back): DayView => {
    const date = dayOf(now - (DAYS_SHOWN - 1 - back) * DAY_MS);
    const { needsYou, fixes } = queue.interventions?.[date] ?? { needsYou: 0, fixes: 0 };
    return { date, needsYou, fixes, total: needsYou + fixes };
  });
  return { today: days.at(-1)?.total ?? 0, days };
}
