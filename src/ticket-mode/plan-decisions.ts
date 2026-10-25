// @ts-check
// module: the decisions a plan records, read out of its text (PURE) -- what the reviewer is told binds it beside the ticket's own decisions (A11-257)
//
// THE PLAN IS WHERE A PLANNER SETTLES WHAT THE TICKET LEFT OPEN, so a reviewer that re-raises a point the plan decided sends the chairman a question the planner already answered. The plan words its decisions in three places, which
// this module quotes: its `## Key decisions` section, its `## Decisions made without a person` section, and the block that follows `**Behaviour:** settled by the planner`. Nothing else of the plan is a decision: its text
// is the plan, which ranks below its decisions. A line inside a code fence is an example, and is not read. The ticket's own decisions are `decisionsOf` (`ticket-decisions.ts`), and they win where the two differ.
import { linesOf, sectionEnd } from "./ticket-decisions.ts";

/** A heading of level 2 to 4 that opens one of the plan's two decision sections: the group is the hashes, which give its level. */
const DECISION_SECTION = /^(#{2,4})\s+(?:key decisions|decisions made without a person)\b/i;
/** The line that opens the block of behaviour decisions the planner settled. */
const BEHAVIOUR_BLOCK = /^\s*\*\*Behaviour:\*\*\s*settled by the planner\s*$/;
/** The level that ends a block at the next heading of any level. */
const ANY_HEADING_LEVEL = 6;

/** The level at which the decision block that `text` opens ends, or null when `text` opens none: a decision section ends at a heading of its own level or higher, the behaviour block at any heading. PURE. */
function decisionLevel(text: string): number | null {
  const section = DECISION_SECTION.exec(text);
  if (section !== null) return section[1].length;
  return BEHAVIOUR_BLOCK.test(text) ? ANY_HEADING_LEVEL : null;
}

/**
 * The decisions a plan records, as the plan words them, or null when it records none: every `## Key decisions` and `## Decisions made without a person` section, heading included and running to the next heading of its own level or a
 * higher one, and every `**Behaviour:** settled by the planner` block, running to the next heading. Each comes once, in the order the plan has them, apart by a blank line. PURE.
 */
export function planDecisionsOf(plan: string): string | null {
  const lines = linesOf(plan);
  const quoted: string[] = [];
  let at = 0;
  while (at < lines.length) {
    const { text, fenced } = lines[at];
    const level = fenced ? null : decisionLevel(text);
    if (level === null) {
      at += 1;
      continue;
    }
    const end = sectionEnd(lines, at, level);
    quoted.push(lines.slice(at, end).map((line) => line.text).join("\n").trim());
    at = end;
  }
  const once = [...new Set(quoted)];
  return once.length === 0 ? null : once.join("\n\n");
}
