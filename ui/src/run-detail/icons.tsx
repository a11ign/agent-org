import type { ReactNode } from "react";
import type { PullTone, RunBoard, StepMark } from "./run-detail-model.ts";

// The Run detail boards' icons, as inline SVG (the page's policy allows no image file), drawn as the boards draw them and coloured by class.

const MARK_SIZE = 24;
const STEP_SIZE = 16;
const PULL_SIZE = 16;

/** The words of each board's header icon for a screen reader, as the boards name them. */
const ICON_NAME: Readonly<Record<Exclude<RunBoard, "awaiting">, string>> = {
  running: "Running", needs: "Needs you", handback: "Needs you", ready: "Ready to merge", done: "Completed", failed: "Failed", cancelled: "Cancelled", queued: "Queued", blocked: "Queued",
};

/** The board's spinner: a ring with its track, turning (`.spin` stops for reduced motion). */
function Spinner({ size, label }: Readonly<{ size: number; label: string }>) {
  return (
    <svg className="spin run-icon tone-warn" width={size} height={size} viewBox="0 0 18 18" fill="none" role="img" aria-label={label}>
      <circle className="spinner-track-warn" cx="9" cy="9" r="7" strokeWidth="2" />
      <path className="spinner-arc" d="M9 2a7 7 0 0 1 7 7" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** The 18-unit shapes of the header icon of each board that has a mark. Needs and Handed back share one, Queued and Blocked the dashed ring, and the Awaiting board draws none. */
type Drawn = Readonly<{ tone: string; shape: ReactNode }>;

const NEEDS: Drawn = {
  tone: "tone-warn",
  shape: (
    <>
      <circle cx="9" cy="9" r="8" fill="currentColor" />
      <path d="M9 4.6v5" stroke="var(--color-page)" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="9" cy="12.6" r="1" fill="var(--color-page)" />
    </>
  ),
};

const QUEUED: Drawn = { tone: "tone-muted", shape: <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.6 2.6" /> };

const SHAPES: Readonly<Partial<Record<RunBoard, Drawn>>> = {
  needs: NEEDS,
  handback: NEEDS,
  queued: QUEUED,
  blocked: QUEUED,
  ready: {
    tone: "tone-success",
    shape: (
      <>
        <circle cx="5" cy="4" r="1.8" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="5" cy="14" r="1.8" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="13" cy="14" r="1.8" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5 5.8v6.4M13 12.2V9.5a2.5 2.5 0 0 0-2.5-2.5H8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </>
    ),
  },
  done: {
    tone: "tone-success",
    shape: (
      <>
        <circle cx="9" cy="9" r="8" fill="currentColor" />
        <path d="M5.6 9.2l2.4 2.4 4.4-4.8" stroke="var(--color-page)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
  failed: {
    tone: "tone-danger",
    shape: (
      <>
        <circle cx="9" cy="9" r="8" fill="currentColor" />
        <path d="M6 6l6 6M12 6l-6 6" stroke="var(--color-page)" strokeWidth="1.8" strokeLinecap="round" />
      </>
    ),
  },
  cancelled: {
    tone: "tone-muted",
    shape: (
      <>
        <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.8" />
        <path d="M4.5 13.5l9-9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </>
    ),
  },
};

/** The icon in a run's header: the board's own, or none for the Awaiting board. */
export function RunIcon({ board }: Readonly<{ board: RunBoard }>) {
  if (board === "running") return <Spinner size={MARK_SIZE} label={ICON_NAME.running} />;
  const drawn = SHAPES[board];
  if (drawn === undefined || board === "awaiting") return null;
  return (
    <svg className={`run-icon ${drawn.tone}`} width={MARK_SIZE} height={MARK_SIZE} viewBox="0 0 18 18" fill="none" role="img" aria-label={ICON_NAME[board]}>
      {drawn.shape}
    </svg>
  );
}

/** The mark of a planned step: the board's spinner for the one the worker is on, its ring for one not started, and the Completed check for one the worker has passed. */
export function StepMarkIcon({ mark }: Readonly<{ mark: StepMark }>) {
  if (mark === "now") return <Spinner size={STEP_SIZE} label="Running now" />;
  if (mark === "next") {
    return (
      <svg className="step-ring" width={STEP_SIZE} height={STEP_SIZE} viewBox="0 0 16 16" fill="none" role="img" aria-label="Not started">
        <circle cx="8" cy="8" r="6" strokeWidth="1.5" />
      </svg>
    );
  }
  return (
    <svg className="tone-success" width={STEP_SIZE} height={STEP_SIZE} viewBox="0 0 18 18" fill="none" role="img" aria-label="Done">
      <circle cx="9" cy="9" r="8" fill="currentColor" />
      <path d="M5.6 9.2l2.4 2.4 4.4-4.8" stroke="var(--color-page)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The branch mark of a pull request row, in the colour of its state. */
export function PullMark({ tone }: Readonly<{ tone: PullTone }>) {
  return (
    <svg className={`pull-mark pull-${tone}`} width={PULL_SIZE} height={PULL_SIZE} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.6" strokeWidth="1.4" />
      <circle cx="4" cy="12.5" r="1.6" strokeWidth="1.4" />
      <circle cx="12" cy="12.5" r="1.6" strokeWidth="1.4" />
      <path d="M4 5.1v5.8M12 10.9V8a2 2 0 0 0-2-2H8" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
