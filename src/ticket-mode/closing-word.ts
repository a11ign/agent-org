// @ts-check
// module: the word a pull request names its ticket with, `Refs` or `Closes` (PURE) -- worked out from its plan step and the run's other pull requests, so the reviewer judges it the same way on each of them (A11-274)
//
// THE LAST PULL REQUEST TO MERGE SAYS CLOSES, AND EVERY OTHER SAYS REFS. That is the chairman's rule for A11-253 (its Decisions, 2026-10-25): a step done by several pull requests across repositories names its
// ticket `Refs` on each but the last to merge, since a closing word on the first to merge would complete the ticket with the rest still open. The reviewer cannot read the tracker or the other pull requests' states,
// and judged the word by the pull request alone: eight siblings were approved with `Refs A11-253` and a11ign.github.io#3 was blocked for it. A closed sibling that never merged is neither open nor merged, and decides nothing.

import type { PlanStep } from "./board-view/plan-steps.ts";
import type { PullState } from "./source.ts";
import type { ReviewClosing } from "../plugins/contracts/reviewer.ts";

/** One other pull request of the run that holds the one reviewed: its url and its state. */
export type Sibling = Readonly<{ url: string; state: PullState }>;

/** A pull request whose body names no step finishes a one-step ticket. */
const ONE_STEP: PlanStep = { step: 1, of: 1 };

/**
 * The word the pull request names ticket `key` with: `refs` when it finishes a step that is not the plan's last, or another pull request of the run is still open; else `closes`. `open` and `merged` name the
 * siblings in each state, so the reviewer can say which. A pull request whose step is unknown (`step` null) is a one-step ticket's.
 */
export function closingWordOf({ key, step, siblings }: Readonly<{ key: string; step: PlanStep | null; siblings: readonly Sibling[] }>): ReviewClosing {
  const finished = step ?? ONE_STEP;
  const open = siblings.filter(({ state }) => state === "open").map(({ url }) => url);
  const merged = siblings.filter(({ state }) => state === "merged").map(({ url }) => url);
  return { key, word: finished.step < finished.of || open.length > 0 ? "refs" : "closes", open, merged };
}
