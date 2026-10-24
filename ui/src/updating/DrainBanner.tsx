import { updateBanner } from "../../../src/ticket-mode/board-view/update-banner.ts";
import { useShell } from "../shell/ShellProvider.tsx";

/**
 * The banner at the top of the Tickets and Runs pages while a breaking update drains (A11-217): the amber box and dot of `AtomautTicketsDraining` and `AtomautRunsDraining`, with the words
 * `updateBanner()` builds from the drain note the queue read carries ("Updating to v0.280 (breaking): no new runs start; 3 runs finishing; forced at 14:30"). It is gone when the note is.
 */
export function DrainBanner() {
  const { queue } = useShell();
  const text = updateBanner(queue.data?.update?.note);
  if (text === null) return null;
  return (
    <div role="status" className="drain-banner">
      <span className="drain-banner-dot" />
      <div className="drain-banner-text">{text}</div>
    </div>
  );
}
