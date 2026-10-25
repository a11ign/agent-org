// module: the line a run's card gives its CI (A11-261) -- pushes, jobs and weighted minutes, the ticket's total when it differs, and the budget when the ticket is over it -- PURE
//
// One wording everywhere: `CI: 3 pushes, 48 jobs, ~184 min`. Like the rest of `board-view/`, it is sent to the browser as one script with its relative imports dropped.

/** The jobs, pushes and weighted minutes of some CI work: macOS minutes counted ten times, Windows two, as GitHub bills (A11-261). */
type CiFigures = Readonly<{ pushes: number; jobs: number; weighted: number }>;

/** A run's CI as the card words it (A11-261): the run's figures and its ticket's, the ticket's budget in weighted minutes (0 for none), and where the ticket stands against it: `over` the budget, or `held` at twice it. */
export type CiView = Readonly<{ run: CiFigures; ticket: CiFigures; budget: number; state: "ok" | "over" | "held" }>;

/** "1 push", "3 pushes": the word is given the way it ends in the plural, `push` taking `es`. */
const counted = (count: number, word: string, plural = `${word}s`): string => `${count} ${count === 1 ? word : plural}`;

/**
 * The CI line of a run, or null when the board has read none: the run's pushes, jobs and weighted minutes (macOS counted ten times, Windows twice), then ` (ticket ~N min)` when the ticket's total differs, which it does once an earlier run
 * of the ticket pushed. Past the ticket's budget it ends ` · over budget (300)`, and at twice the budget, where the board holds the run, ` · over twice the budget (300)`. PURE.
 */
export function ciNote(ci: CiView | undefined): string | null {
  if (ci === undefined || (ci.run.pushes === 0 && ci.ticket.pushes === 0)) return null;
  const line = `CI: ${counted(ci.run.pushes, "push", "pushes")}, ${counted(ci.run.jobs, "job")}, ~${ci.run.weighted} min`;
  return `${line}${ci.ticket.weighted === ci.run.weighted ? "" : ` (ticket ~${ci.ticket.weighted} min)`}${budgetWords(ci)}`;
}

/** What the line adds about the budget: nothing while the ticket is under it, or has none. */
function budgetWords({ state, budget }: CiView): string {
  if (state === "over") return ` · over budget (${budget})`;
  return state === "held" ? ` · over twice the budget (${budget})` : "";
}
