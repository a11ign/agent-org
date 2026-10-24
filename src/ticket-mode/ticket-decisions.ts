// @ts-check
// module: a ticket's explicit decisions, read out of its description (PURE) -- what the reviewer is told binds it ahead of its own general rules (A11-213)
//
// THE REVIEWER CANNOT READ LINEAR, and a rule it holds in general ("a baseline only shrinks") must yield to a decision the ticket states for this change. A decision is written in one of two forms: a section
// headed `Decisions` or `Behaviour` (the Grill writes both), which is quoted whole, and a line that marks itself as the chairman's ("by the chairman's decision on 2026-10-24"). Nothing looser is read: a
// line that merely mentions the chairman, such as a quoted "Why (the chairman, date)", is not a decision. A line inside a code fence is an example, and is not read.

/** A heading of level 2 to 4 whose text starts with `Decisions` or `Behaviour`: the group is the hashes, which give its level. */
const DECISION_HEADING = /^(#{2,4})\s+(?:decisions|behaviou?r)\b/i;
const ANY_HEADING = /^(#{1,6})\s/;
const FENCE = /^\s*(```|~~~)/;
const CHAIRMAN_DECISION = /chairman['’]s decision|the chairman decided|decided by the chairman/i;

/** One line of a description, and whether a code fence holds it (a fence's own opening and closing lines are held). */
type Line = Readonly<{ text: string; fenced: boolean }>;

/** The lines of `description`, each marked with whether a code fence holds it. PURE. */
function linesOf(description: string): Line[] {
  let inFence = false;
  return description.split("\n").map((text) => {
    const edge = FENCE.test(text);
    const fenced = inFence || edge;
    if (edge) inFence = !inFence;
    return { text, fenced };
  });
}

/** The index past the last line of the section whose heading is at `from`: the next heading of its own level or a higher one, outside a fence. PURE. */
function sectionEnd(lines: readonly Line[], from: number, level: number): number {
  const next = lines.findIndex(({ text, fenced }, at) => at > from && !fenced && (ANY_HEADING.exec(text)?.[1].length ?? Infinity) <= level);
  return next === -1 ? lines.length : next;
}

/**
 * The ticket's explicit decisions, as the ticket words them, or null when it has none (or no description): every `Decisions` or `Behaviour` section, heading included and running to the next heading of its own
 * level or a higher one, and every other line that marks a chairman's decision. Each comes once, in the order the ticket has them, apart by a blank line. PURE.
 */
export function decisionsOf(description: string | null | undefined): string | null {
  if (!description) return null;
  const lines = linesOf(description);
  const quoted: string[] = [];
  let at = 0;
  while (at < lines.length) {
    const { text, fenced } = lines[at];
    const heading = fenced ? null : DECISION_HEADING.exec(text);
    if (heading !== null) {
      const end = sectionEnd(lines, at, heading[1].length);
      quoted.push(lines.slice(at, end).map((line) => line.text).join("\n").trim());
      at = end;
      continue;
    }
    if (!fenced && CHAIRMAN_DECISION.test(text)) quoted.push(text.trim());
    at += 1;
  }
  const once = [...new Set(quoted)];
  return once.length === 0 ? null : once.join("\n\n");
}
