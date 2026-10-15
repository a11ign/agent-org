/**
 * THE RUNS OF A RETIRED REVIEWER SEAT'S CAUSES (agent-org#1392).
 *
 * A cause is capped at `MAX_DELIVERIES` deliveries in one run, and the count is read from the ledger, so a cause whose seat was
 * retired kept its count and was REFUSED for ever: its seat was gone, and nothing could start a run that would reset it. Two
 * things end that: the retirement writes a RESET for each cause the seat owns that has a run (`endSeatRuns` in `wake.ts`), and a
 * capped cause whose seat is ABSENT is started again by the gate, which writes its RESET before its delivery line.
 *
 * Pure: the ledger is read and written by the caller, so this file holds only the questions asked of the counts and the listing.
 */
import { reviewerInstance } from "./review-attribution.ts";
import { listingIsComplete } from "./herdr-agents.ts";

/** The seat a cause is addressed to: the first `/` segment of its key (`reviewer-5446/draft-awaiting-verdict/pr-5446/1aa82fa1`). */
export function seatOfCause(causeKey: string): string {
  return causeKey.split("/")[0];
}

/** The causes of `session` that have a run in the counts -- the ones its retirement ends. */
export function seatRunKeys(session: string, counts: ReadonlyMap<string, number>): string[] {
  return [...counts].filter(([key, n]) => n > 0 && seatOfCause(key) === session).map(([key]) => key);
}

/**
 * A REVIEWER SEAT THAT IS GONE: its name is a reviewer instance's, it is not in the registry, and a COMPLETE listing does not show it.
 * A partial listing is not proof of absence (`listingIsComplete`, #2465), so an incomplete one answers `false`.
 */
export function isAbsentReviewerSeat(session: string, { registry, agents }: { registry: Record<string, unknown>; agents: { label: string; }[]; }): boolean {
  if (reviewerInstance(session) === null) return false;
  if (registry[session] !== undefined) return false;
  return listingIsComplete(agents) && !agents.some((a) => a.label === session);
}
