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
const DECISIONS_HEADING = /^#{2,4}\s+decisions\s*(?:\(.*\))?\s*$/i;
const CHAIRMAN_DECISION = /chairman['’]s decision|the chairman decided|decided by the chairman/i;

/** One line of a description, and whether a code fence holds it (a fence's own opening and closing lines are held). */
export type Line = Readonly<{ text: string; fenced: boolean }>;

/** The lines of `description`, each marked with whether a code fence holds it. PURE. */
export function linesOf(description: string): Line[] {
  let inFence = false;
  return description.split("\n").map((text) => {
    const edge = FENCE.test(text);
    const fenced = inFence || edge;
    if (edge) inFence = !inFence;
    return { text, fenced };
  });
}

/** The index past the last line of the section whose heading is at `from`: the next heading of its own level or a higher one, outside a fence. PURE. */
export function sectionEnd(lines: readonly Line[], from: number, level: number): number {
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

/** Whether the description has a section headed `Decisions`, outside a code fence: the heading form {@link decisionsOf} reads, without `Behaviour` and the chairman's one-line decisions (A11-250). PURE. */
export const hasDecisionsSection = (description: string | null | undefined): boolean =>
  !!description && linesOf(description).some(({ text, fenced }) => !fenced && DECISIONS_HEADING.test(text));

/** The phrases that claim a person decided something, in any case: the chairman's own marker, and the ways a reply words it ("the chairman said", "per the chairman", "decided by the chairman"). */
const DECISION_CLAIM = /chairman['’]s decision|\bthe chairman (?:decided|said|answered|confirmed|chose|ruled)|\bper the chairman|\bdecided by (?:the )?chairman/i;

/** "decided by" and a person's name, which is capitalised: "decided by ADR-12" and "decided by design" name no person. */
const DECIDED_BY_NAME = /\b[Dd]ecided by [A-Z][a-z]+\b/;

/**
 * Which of `texts` (the replies a re-review quotes, and the lines the pull request body gained) claim that a person decided something without linking the ticket (A11-250): each is returned as written. A claim is
 * supported only by a link to the ticket's decisions, so `ticketUrl` is the ticket's address, or null (or empty) when the ticket records no decision at all and nothing can support a claim. The link is the ticket's `/issue/<KEY>`
 * path, so the address with or without the tracker's slug counts. PURE.
 */
export function unsupportedClaims(texts: readonly string[], ticketUrl: string | null): string[] {
  const linked = ticketUrl ? ticketUrl.replace(/^(.*\/issue\/[^/\s]+).*$/, "$1").toLowerCase() : null;
  return texts.filter((text) => (DECISION_CLAIM.test(text) || DECIDED_BY_NAME.test(text)) && (linked === null || !text.toLowerCase().includes(linked)));
}
