import type { ReactNode } from "react";
import type { FromSearch } from "../search/use-from-search.ts";
import { runsHref } from "../shell/routes.ts";

/** The board's status banner, in the warning colours: a sentence, and a link or nothing beside it. It is a `status`, so a screen reader hears it when it appears. */
export function StatusBanner({ children, action }: Readonly<{ children: ReactNode; action?: ReactNode }>) {
  return (
    <div role="status" className="status-banner">
      <div className="status-banner-text">{children}</div>
      {action}
    </div>
  );
}

/** The banner under the filters while workers are paused: what happens to tickets queued now, and the way to start workers. */
export function PausedBanner() {
  return (
    <StatusBanner action={<a className="status-banner-link" href={runsHref}>Start workers on Runs</a>}>
      Workers are paused. Tickets you queue wait until you start workers.
    </StatusBanner>
  );
}

/** What `tickets.preflight` holds: the check that failed and what it printed. `QueueView.held` is null while no run is held. */
export type Held = Readonly<{ name: string; reason: string }>;

/** The banner while the instance starts no run (its host's `tickets.preflight` fails), on Tickets and on Runs: which check failed and what it printed. Nothing is drawn while no run is held. */
export function HeldBanner({ held }: Readonly<{ held: Held | null | undefined }>) {
  if (held === null || held === undefined) return null;
  return <StatusBanner>No run starts while {held.name} fails: {held.reason}</StatusBanner>;
}

/** The indigo banner over a ticket opened from the "Search tickets" palette (A11-387): which ticket, where it is and whose, and the way back to the view the person came from. */
export function FromSearchBanner({ view }: Readonly<{ view: NonNullable<FromSearch> }>) {
  return (
    <div role="status" className="from-search-banner">
      <div className="from-search-text">Showing <strong>{view.key}</strong> from search. {view.sentence}</div>
      <button type="button" className="from-search-back" onClick={view.back}>Back to my tickets</button>
    </div>
  );
}
