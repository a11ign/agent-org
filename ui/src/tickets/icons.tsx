import { PRIORITY_NAMES } from "../../../src/ticket-mode/board-view/view-types-and-filters.ts";

export function SearchIcon() {
  return (
    <svg className="search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** The small chevron of a filter's dashed button. */
export function MenuChevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The chevron of a section's collapse button: down while the section is open, right while it is closed. */
export function FoldChevron({ open }: Readonly<{ open: boolean }>) {
  return (
    <svg className={open ? "fold-chevron" : "fold-chevron fold-chevron-closed"} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** The sliders of the Options button. */
export function OptionsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="10.5" cy="4.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5.5" cy="11.5" r="1.6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/**
 * A section's status icon. The boards draw Backlog's, a dashed circle; the other statuses have the plain ring until a board draws theirs (the tracker names them, so there is no
 * telling which a workflow has).
 */
export function StatusIcon({ status }: Readonly<{ status: string }>) {
  const dashed = status === "Backlog";
  return (
    <svg className="status-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.3" {...(dashed ? { strokeDasharray: "2.2 2.2" } : {})} />
    </svg>
  );
}

/** How many of the priority mark's three dashes a priority lights: Low one, Medium two, High and Urgent all three; none lights none. */
const LIT: Readonly<Record<number, number>> = { 0: 0, 1: 3, 2: 3, 3: 2, 4: 1 };
const DASHES: readonly string[] = ["M2 7h2.2", "M5.9 7h2.2", "M9.8 7H12"];
const URGENT = 1;

/**
 * A ticket's priority, in the place the boards draw "No priority": three dashes, which the priority lights from the left (Urgent lights all three in the warning colour). The boards draw
 * only the dashes of a ticket with no priority, so the others are this mark lit.
 */
export function PriorityMark({ priority }: Readonly<{ priority: number }>) {
  const lit = LIT[priority] ?? 0;
  const tone = priority === URGENT ? "priority-urgent" : "priority-lit";
  return (
    <svg className="priority-mark" width="14" height="14" viewBox="0 0 14 14" fill="none" role="img" aria-label={PRIORITY_NAMES[priority] ?? PRIORITY_NAMES[0]}>
      {DASHES.map((d, index) => (
        <path key={d} className={index < lit ? tone : "priority-off"} d={d} strokeWidth="1.6" strokeLinecap="round" />
      ))}
    </svg>
  );
}

/** A document with a mark on it: the ticket has no plan of its own. Muted when its parent's plan covers it. */
export function NoPlanMark({ note, covered }: Readonly<{ note: string; covered: boolean }>) {
  return (
    <span className={covered ? "no-plan no-plan-covered" : "no-plan"} role="img" aria-label={note} title={note}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4 1.5h5.5L13 5v9.5H4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M8.5 6v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="8.5" cy="12.3" r=".9" fill="currentColor" />
      </svg>
    </span>
  );
}
