import type { ReactNode } from "react";
import type { RunAction } from "../api/types.ts";
import type { RunStatus } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";
import { labelOf } from "./runs-model.ts";

// The Runs page's icons, as inline SVG (the page's policy allows no image file). The Runs board draws In progress, Planning, Ready to merge and Completed, and the icons of Talk to it, Stop and Dismiss;
// every other status and action takes the icon `ui.html` gives it.

const STATUS_SIZE = 18;
const ACTION_SIZE = 14;

/** The colour class of each status's icon and label: the boards' (In progress, Planning, Ready to merge, Completed, and the Run detail boards' Queued, Awaiting review, Cancelled and Failed) or `ui.html`'s mapped to them. */
export const STATUS_TONE: Readonly<Record<RunStatus, string>> = {
  "needs-you": "tone-warn", talking: "tone-planning", working: "tone-warn", planning: "tone-planning", reviewing: "tone-warn", blocked: "tone-quiet", queued: "tone-quiet",
  "awaiting-review": "tone-planning", "ready-to-merge": "tone-success", publishing: "tone-warn", published: "tone-success", checked: "tone-success", completed: "tone-success", failed: "tone-danger", cancelled: "tone-muted",
};

/** The board's spinner: a ring in the status colour with its track, turning (`.spin` stops for reduced motion). */
function Spinner({ track }: Readonly<{ track: string }>) {
  return (
    <>
      <circle className={track} cx="9" cy="9" r="7" strokeWidth="2" fill="none" />
      <path className="spinner-arc" d="M9 2a7 7 0 0 1 7 7" strokeWidth="2" strokeLinecap="round" fill="none" />
    </>
  );
}

/** The 16-unit icons `ui.html` draws for a status, in `currentColor`. */
const OWN_SHAPES: Partial<Record<RunStatus, ReactNode>> = {
  queued: <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" />,
  blocked: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M5 8h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  talking: <path d="M2.5 3.5h11v7.5h-6l-3 2.5V11h-2z" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  "needs-you": (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M8 4.5v4.5" stroke="var(--color-page)" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="8" cy="11.6" r="1" fill="var(--color-page)" />
    </>
  ),
  "awaiting-review": (
    <>
      <circle cx="4.5" cy="3.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="4.5" cy="12.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="11.5" cy="12.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.5 5.3v5.4M11.5 10.7V6.5a2 2 0 0 0-2-2H7.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  published: (
    <>
      <path d="M2 7.5L14 2l-3.5 12-3-4.5z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M7.5 9.5L14 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  checked: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M5.2 8.2l1.9 1.9 3.7-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  failed: (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="var(--color-page)" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  cancelled: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M4 12L12 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
};

/** The statuses in which a worker is at work, whose icon turns. */
const SPINNING: ReadonlySet<RunStatus> = new Set(["working", "planning", "reviewing", "publishing"]);

/** The icon of a status, with its words for a screen reader: a spinner for the statuses in which a worker is at work, the board's branch and tick for Ready to merge and Completed. */
export function StatusIcon({ status }: Readonly<{ status: RunStatus }>) {
  const tone = STATUS_TONE[status];
  const common = { className: `status-icon ${tone}`, width: STATUS_SIZE, height: STATUS_SIZE, role: "img", "aria-label": labelOf(status) } as const;
  if (SPINNING.has(status)) {
    return (
      <svg {...common} className={`status-icon spin ${tone}`} viewBox="0 0 18 18" fill="none">
        <Spinner track={status === "planning" ? "spinner-track-planning" : "spinner-track-warn"} />
      </svg>
    );
  }
  if (status === "ready-to-merge") {
    return (
      <svg {...common} viewBox="0 0 18 18" fill="none">
        <circle cx="5" cy="4" r="1.8" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="5" cy="14" r="1.8" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="13" cy="14" r="1.8" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5 5.8v6.4M13 12.2V9.5a2.5 2.5 0 0 0-2.5-2.5H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "completed") {
    return (
      <svg {...common} viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="9" r="8" fill="currentColor" />
        <path d="M5.6 9.2l2.4 2.4 4.4-4.8" stroke="var(--color-page)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg {...common} viewBox="0 0 16 16" fill="none">
      {OWN_SHAPES[status]}
    </svg>
  );
}

/** The pull request mark of a pill. */
export function PullIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 5.1v5.8M12 10.9V8a2 2 0 0 0-2-2H8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** The pause mark of the pool bar's button, which the board draws whether it reads Pause or Start workers. */
export function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M4 2.5v7M8 2.5v7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

const ACTION_SHAPES: Readonly<Record<RunAction, ReactNode>> = {
  talk: <path d="M3 4.5l4 3.5-4 3.5M8.5 12H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
  stop: <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />,
  dismiss: <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
  respond: (
    <>
      <path d="M6.5 3.5L2.5 7.5l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.8 7.5H9a4.5 4.5 0 0 1 4.5 4.5v.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  remove: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  retry: <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.8v2.7h-2.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  close: <path d="M8 2v5.5M4.6 4.4a5 5 0 1 0 6.8 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  approve: <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  "start-anyway": <path d="M5 3.2l7.5 4.8L5 12.8z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  "apply-edit": <path d="M3 3h10v10H3zM5.5 8l2 2 3-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  "discard-edit": <path d="M3 3h10v10H3zM5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
};

/** The icon of a run's action. */
export function ActionIcon({ verb }: Readonly<{ verb: RunAction }>) {
  return (
    <svg width={ACTION_SIZE} height={ACTION_SIZE} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {ACTION_SHAPES[verb]}
    </svg>
  );
}
