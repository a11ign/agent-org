import { reviewerBanner } from "../../../src/ticket-mode/board-view/pull-review-state.ts";
import type { ConfigView, QueueView } from "../api/types.ts";
import { HeldBanner, StatusBanner } from "../tickets/Banners.tsx";

/** What the notices of the Runs page need: the queue (the check holding runs, and the claims GitHub refuses) and the machine's reviewer state. */
type Notices = Readonly<{ queue: Pick<QueueView, "held" | "claimWarning">; reviewer: ConfigView["reviewer"] | undefined }>;

/**
 * The notices `ui.html` draws above the runs, in its warning banner: the check that holds every run, reviews required with the reviewer off, and the review claims GitHub refuses. A notice with
 * nothing to say is not drawn. The update banner is the shell's drain banner (A11-217), not drawn here.
 */
export function RunsNotices({ queue, reviewer }: Notices) {
  const off = reviewerBanner(reviewer);
  const claims = queue.claimWarning ?? null;
  return (
    <>
      <HeldBanner held={queue.held} />
      {off === null ? null : <StatusBanner>{off}</StatusBanner>}
      {claims === null ? null : <StatusBanner>{claims}</StatusBanner>}
    </>
  );
}
