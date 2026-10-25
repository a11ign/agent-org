// @ts-check
// module: a plan's `## Blocked by` section (A11-272) -- the tickets the plan says its work waits on, read out of the plan, and the planner brief's rule for writing it. PURE
//
// A LEAF, ON PURPOSE. The brief builder (`worker-files.ts`) quotes the rule and the pool (`pool-plan-blockers.ts`) reads the section; the pool imports the brief builder's files, so the rule cannot live with the pool without a cycle.
// Only the section is read: a plan that explains the rule in prose, or quotes a `Blocked-by:` line, never blocks its own ticket on a key in its text.
import { linesOf, sectionEnd } from "./ticket-decisions.ts";
import { blockedByIn } from "./ticket-references.ts";

/** The plan section the planner names the tickets its work waits on in. */
const BLOCKED_BY_HEADING = "## Blocked by";

const SECTION_LEVEL = 2;
const HEADING = /^##(?!#)\s+blocked[\s-]*by\s*$/i;

/** What the single planner's brief says of a step that needs another ticket's work. A batch's planner orders its tickets in `order.json`, which the board records, and is not told this. */
export const BLOCKED_BY_RULE = `When a step of your plan needs another ticket's work, the plan has a section \`${BLOCKED_BY_HEADING}\`, placed before \`## Paths\`, with one line \`Blocked-by: <KEY>\` for each such ticket, the key alone on the line: `
  + "put the reason on the line below it, because a second key in the reason would be read as another blocker. The board records each key as a blocker of this ticket in the tracker when it attaches the plan, and holds the ticket until that "
  + "ticket's work has merged, so the queue orders the two before any run starts and no run has to wait on the other ticket while it holds files. A ticket whose plan needs no other ticket has no such section, and a `Blocked-by:` line anywhere else in the plan is not read.";

/** The lines under each `## Blocked by` heading of a plan, outside a fence. PURE. */
function sectionLines(plan: string): string[] {
  const lines = linesOf(plan);
  return lines.flatMap(({ text, fenced }, at) => (!fenced && HEADING.test(text.trimEnd()) ? lines.slice(at + 1, sectionEnd(lines, at, SECTION_LEVEL)) : []))
    .filter(({ fenced }) => !fenced).map(({ text }) => text);
}

/** The tickets the `## Blocked by` sections of `plans` name, other than the ticket `key` itself, each once, in upper case, and in the order written. PURE. */
export function plannedBlockers(plans: readonly string[], key: string): string[] {
  // A tracker's keys are upper case, and a key written in another case would be neither the tracker's blocker nor the one the queue waits to merge.
  const named = [...new Set(blockedByIn(plans.flatMap(sectionLines).join("\n")).map((name) => name.toUpperCase()))];
  return named.filter((name) => name !== key.toUpperCase());
}
