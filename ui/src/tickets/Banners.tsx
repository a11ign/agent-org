import type { ReactNode } from "react";
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
