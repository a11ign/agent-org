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
