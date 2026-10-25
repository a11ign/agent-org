// @ts-check
// module: the plan check against the ticket's Decisions (A11-250) -- PURE
//
// A DECISION OVERRIDES THE PLAN, AND THE PLAN SAYS WHETHER IT DOES. Text matching cannot tell that a plan contradicts a decision, so the planner states it: a ticket that has a `## Decisions` section gets a plan with a
// `## Ticket decisions` section, one bullet per decision, each starting `Follows:` or `Conflicts:`. The board checks the plan's own statement, as it checks the other things a plan says of itself: a `Conflicts:` bullet
// or no such section is a defect, and the plan is not attached.
import { hasDecisionsSection, linesOf, sectionEnd } from "./ticket-decisions.ts";

const SECTION_HEADING = /^##\s+ticket decisions\b/i;
/** A bullet that states a conflict: `Conflicts:` followed by something other than "none". */
const CONFLICTS_BULLET = /^\s*[-*]\s+(?:\*\*)?conflicts:\**\s*(?!(?:none|no|n\/a|nothing)\b)[^\s*]/i;

/** The lines of every `## Ticket decisions` section in `plan`, or null when it has none. PURE. */
function sectionLinesOf(plan: string): string[] | null {
  const lines = linesOf(plan);
  const found: string[] = [];
  let at = 0;
  let any = false;
  while (at < lines.length) {
    if (lines[at].fenced || !SECTION_HEADING.test(lines[at].text)) { at += 1; continue; }
    const end = sectionEnd(lines, at, 2);
    found.push(...lines.slice(at + 1, end).filter(({ fenced }) => !fenced).map(({ text }) => text));
    any = true;
    at = end;
  }
  return any ? found : null;
}

/**
 * What is wrong with the plan's files, written against the ticket's `description` as the planner read it, or null: the first `Conflicts:` bullet of the plan's `## Ticket decisions`, or that it has no such section. A
 * ticket with no `## Decisions` section has nothing to follow, so any plan passes. `plans` are the texts of the plan's files. PURE.
 */
export function ticketDecisionsDefect(plans: readonly string[], description: string): string | null {
  if (!hasDecisionsSection(description)) return null;
  const sections = plans.map(sectionLinesOf).filter((lines): lines is string[] => lines !== null);
  if (sections.length === 0) return "the plan has no `## Ticket decisions` section, which the ticket's Decisions require: one bullet for each decision, `Follows:` or `Conflicts:`";
  const conflict = sections.flat().find((line) => CONFLICTS_BULLET.test(line));
  return conflict === undefined ? null : `the plan conflicts with a decision of the ticket: ${conflict.trim()}`;
}
