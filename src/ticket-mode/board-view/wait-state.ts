// @ts-check
// module: what is wrong with the board's waits right now (A11-272) -- the After-merge check of the ticket as a function of the queue, so it also runs on a branch's fixture before merge. PURE.
//
// THE TICKET'S DONE-WHEN: no ticket is `running` with a `waitingOn` ticket, and none sits `queued` behind the files of a parked run. The second half is a wait cycle (`wait-cycles.ts`): a queued ticket held by a run
// that does not wait on it is the ordinary overlap hold, and a run parked on a fleet job or a CI run still holds its files against tickets it does not wait for, by design. Like the rest of `board-view/`, it is
// sent to the browser as one script with its relative imports dropped.
import { cycleSentence, waitCycles } from "./wait-cycles.ts";
import type { ViewEntry } from "./view-types-and-filters.ts";

/** Whether a ticket's work is over on the board: the tracker completed or canceled it, so a wait on it ends at the board's next wake, not at a release. */
const isOver = (entries: readonly ViewEntry[], key: string): boolean => entries.some(({ ticket, trackerState }) => ticket.key === key && (trackerState === "completed" || trackerState === "canceled"));

/**
 * Each ticket a run is running and idle in a declared wait on, as the sentence that names it: the board should have queued it behind that ticket. A batch's run is shared by its tickets and the board never releases
 * it, and a wait on a ticket that is over is woken, not released, so neither is a problem.
 */
function parkedRuns(entries: readonly ViewEntry[]): string[] {
  return entries.flatMap(({ ticket, phase, batch, working }) => {
    const waits = phase === "running" && batch === undefined && working?.waiting === true ? (working.waits ?? []) : [];
    return waits.flatMap((wait) => (wait.kind === "ticket" && !isOver(entries, wait.key) ? [`${ticket.key} is running and waits on ticket ${wait.key}: the board should have queued it behind ${wait.key}`] : []));
  });
}

/** What is wrong with the waits among `entries`, one sentence each; empty when nothing is. PURE. */
export const waitStateProblems = (entries: readonly ViewEntry[]): string[] => [...parkedRuns(entries), ...waitCycles(entries).map(cycleSentence)];
