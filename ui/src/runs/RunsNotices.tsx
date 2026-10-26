import { reviewerBanner } from "../../../src/ticket-mode/board-view/pull-review-state.ts";
import { longWaits, longWaitSentence } from "../../../src/ticket-mode/board-view/long-waits.ts";
import { cycleSentence, waitCycles } from "../../../src/ticket-mode/board-view/wait-cycles.ts";
import type { ConfigView, QueueView } from "../api/types.ts";
import { HeldBanner, StatusBanner } from "../tickets/Banners.tsx";

/** What the notices of the Runs page need: the queue (the check holding runs, the claims GitHub refuses, and the tickets that wait on each other), the machine's reviewer state, and the time the waits are counted to. */
type Notices = Readonly<{ queue: Pick<QueueView, "held" | "claimWarning" | "entries">; reviewer: ConfigView["reviewer"] | undefined; now: number }>;

/**
 * The notices `ui.html` draws above the runs, in its warning banner: the check that holds every run, reviews required with the reviewer off, and the review claims GitHub refuses. A notice with
 * nothing to say is not drawn. One banner for each wait cycle the queue holds (A11-272), which goes when the cycle does, and one for each queued run that has waited more than two hours on the same ticket (A11-298), with what it waits on and whether that ticket can move. The update banner is the shell's drain banner (A11-217), not drawn here.
 */
export function RunsNotices({ queue, reviewer, now }: Notices) {
  const off = reviewerBanner(reviewer);
  const claims = queue.claimWarning ?? null;
  return (
    <>
      <HeldBanner held={queue.held} />
      {off === null ? null : <StatusBanner>{off}</StatusBanner>}
      {claims === null ? null : <StatusBanner>{claims}</StatusBanner>}
      {waitCycles(queue.entries).map((cycle) => <StatusBanner key={cycle.id}>{cycleSentence(cycle)}</StatusBanner>)}
      {longWaits(queue.entries, now).map((wait) => <StatusBanner key={`${wait.key}-${wait.on}`}>{longWaitSentence(wait, now)}</StatusBanner>)}
    </>
  );
}
