// module: a ticket's CI budget (A11-261) -- when the board warns the worker, when it holds the run, and the words it says both in -- PURE
//
// THE BUDGET IS A NUMBER OF WEIGHTED MINUTES PER TICKET (`tickets.ciBudgetMinutes`; 0 is none). Passing it warns the worker once. Reaching twice the budget holds the run until the board's next round, and a run that goes on pushing is held
// again at each further whole budget (three times, four times), because a hold that fired once and never again would let a loop run on unchecked. The hold is the board's own act and no person's: it stops a live run and queues it again.
import type { TicketCi } from "./store.ts";

/** The weighted CI minutes a ticket may run before the board warns its worker when the host file names no budget (`tickets.ciBudgetMinutes`). */
export const DEFAULT_CI_BUDGET_MINUTES = 300;

/** What the board does about a ticket's CI at `weighted` minutes: nothing, the one warning, or a hold at `multiple` times the budget (2 for the first hold). */
export type BudgetStep = Readonly<{ kind: "none" }> | Readonly<{ kind: "warn" }> | Readonly<{ kind: "hold"; multiple: number }>;

/** How a card shows a ticket's CI against its budget: under it, over it, or at twice it and held. */
export type BudgetState = "ok" | "over" | "held";

/** What the board holds of a ticket's warning and holds, which decide whether a step is due. */
export type BudgetRecord = Pick<TicketCi, "warned" | "held">;

/**
 * The step due for a ticket that has run `weighted` weighted minutes against `budget`, given what it was already warned and held at. Past the budget (strictly) and not yet warned it is the warning; at twice the budget, and again at
 * each further whole budget, it is a hold, which also stands for the warning if none was sent. A budget of 0 is none, and so is a total the ticket was already warned or held for. PURE.
 */
export function budgetStep(weighted: number, budget: number, record: BudgetRecord | undefined): BudgetStep {
  if (budget <= 0) return { kind: "none" };
  const multiple = Math.floor(weighted / budget);
  if (multiple >= 2 && multiple > (record?.held ?? 1)) return { kind: "hold", multiple };
  return weighted > budget && record?.warned === undefined && multiple < 2 ? { kind: "warn" } : { kind: "none" };
}

/** How the card shows `weighted` minutes against `budget`. PURE. */
export function budgetState(weighted: number, budget: number): BudgetState {
  if (budget <= 0 || weighted <= budget) return "ok";
  return weighted >= 2 * budget ? "held" : "over";
}

/** The line a worker is told in its pane when its ticket passes the budget: one line, as the board's other prompts are. PURE. */
export const warnPrompt = (weighted: number, budget: number): string =>
  `CI budget: this ticket has run ~${weighted} weighted CI minutes of its ${budget}. Run the tests locally and batch your fixes into one push; at ${2 * budget} the board holds this run.`;

const timesWords = (multiple: number): string => (multiple === 2 ? "twice" : `${multiple} times`);

/** Why a run is held, as the card and the next round's brief give it. PURE. */
export const holdReason = (weighted: number, budget: number, multiple: number): string =>
  `Held: CI ~${weighted} min, over ${timesWords(multiple)} this ticket's budget of ${budget}`;
