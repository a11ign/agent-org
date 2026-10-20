// @ts-check
// module: the decisions a ticket still holds open, and whether its screen's behaviour is grilled -- what the board checks before a ticket can be queued (A11-134)
//
// A ticket whose Acceptance, Done-when or Open-check still asks a person to decide something cannot be queued: a worker may not settle a product decision
// (`worker-files.ts`'s brief), so the board holds the ticket until its Grill writes the answers into it. The Grill records them with two markers, which this
// module reads: `**Decisions:** settled` settles every open line, and `**Behaviour:** settled` records a screen's behaviour pass. The planner's check on a
// plan (`pool-settle.ts`) covers what a phrase cannot. The browser page never imports this: the server puts `needsDecision` on each ticket it sends.

import type { Ticket } from "./source.ts";

/** The line a Grill writes into a ticket once its decisions are answered: every open line no longer counts. */
export const DECISIONS_MARK = "**Decisions:** settled";
/** The line a Grill writes into a screen ticket once its behaviour is answered. */
export const BEHAVIOUR_MARK = "**Behaviour:** settled";
/** The line that marks a ticket as changing a screen, for a tracker with no `ui` label. The create-ticket skill writes it. */
export const SCREEN_MARK = "**Screen:** yes";
/** The heading of the plan's section that records the decisions a planning run made without a person, lowercased. */
export const DECISIONS_WITHOUT_PERSON = "decisions made without a person";

/** The sections whose lines are checked for an open decision, by their heading, lowercased. `Acceptance criteria` is Acceptance. */
const CHECKED = new Set(["acceptance", "acceptance criteria", "done-when", "open-check"]);
/** The phrases that leave a decision open. */
const OPEN_PHRASE = /\bdecide (whether|if)\b|\bchoose between\b|\btbd\b|\bto be decided\b|\bopen question\b|\bstill to decide\b/i;
/** A quoted or backticked span: a phrase inside one is a mention of the phrase, not a decision still open. */
const QUOTED = /"[^"\n]*"|`[^`\n]*`/g;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const DECISIONS_LINE = /^\s*\*\*Decisions:\*\*\s*settled\s*$/m;
const BEHAVIOUR_LINE = /^\s*\*\*Behaviour:\*\*\s*settled\s*$/m;
const SCREEN_LINE = /^\s*\*\*Screen:\*\*\s*yes\s*$/m;

/** One line of a document that is not a heading, with the name of the section it is in, lowercased. */
type SectionLine = Readonly<{ section: string; line: string }>;

/**
 * The lines of `text` that lie in a tracked section. A section starts at a heading `tracked` names and runs to the next heading of the same or a higher
 * level, so a sub-heading inside it is part of it. PURE.
 */
function sectionLines(text: string, tracked: (name: string) => boolean): SectionLine[] {
  const lines: SectionLine[] = [];
  let open: Readonly<{ name: string; level: number }> | null = null;
  for (const raw of text.split("\n")) {
    const heading = HEADING.exec(raw);
    if (heading !== null) {
      const level = heading[1].length;
      const name = heading[2].replace(/:$/, "").trim().toLowerCase();
      if (open !== null && level <= open.level) open = null;
      if (open === null) {
        if (tracked(name)) open = { name, level };
        continue;
      }
      // A sub-heading of an open section is one of its lines: a numbered item such as `### 4. Decide whether ...` is one.
    }
    if (open !== null) lines.push({ section: open.name, line: raw.trim() });
  }
  return lines;
}

/** The first line of a checked section that leaves a decision open, with its section's name, or null. A `**Decisions:** settled` line settles them all. PURE. */
export function openDecisionOf(description: string): Readonly<{ section: string; line: string }> | null {
  if (DECISIONS_LINE.test(description)) return null;
  return sectionLines(description, (name) => CHECKED.has(name)).find(({ line }) => OPEN_PHRASE.test(line.replace(QUOTED, ""))) ?? null;
}

/** Whether the ticket changes a screen: it has a `ui` label, or its description has the `**Screen:** yes` line. PURE. */
export const changesScreen = (ticket: Pick<Ticket, "description" | "labels">): boolean =>
  (ticket.labels ?? []).some((label) => label.name === "ui") || SCREEN_LINE.test(ticket.description);

/** Whether a screen ticket's behaviour is still to be grilled: it changes a screen, and no `**Behaviour:** settled` line records the grill. PURE. */
export const behaviourOpen = (ticket: Pick<Ticket, "description" | "labels">): boolean => changesScreen(ticket) && !BEHAVIOUR_LINE.test(ticket.description);

/** Why a ticket cannot be queued yet: an open decision, which names its line, or a screen's behaviour not yet grilled. */
export type NeedsDecision = Readonly<{ kind: "decision"; line: string; reason: string }> | Readonly<{ kind: "behaviour"; reason: string }>;

/** The reason a ticket cannot be queued yet, or null when it can be. A decision comes before a screen's behaviour. PURE. */
export function needsDecision(ticket: Pick<Ticket, "description" | "labels">): NeedsDecision | null {
  const open = openDecisionOf(ticket.description);
  if (open !== null) {
    return { kind: "decision", line: open.line, reason: `An open decision is still in ${open.section}: "${open.line}". Grill it to settle the decision before it is queued.` };
  }
  if (behaviourOpen(ticket)) {
    return { kind: "behaviour", reason: "It changes a screen, and its behaviour is not grilled yet. Grill what the person sees, what each control does, and the empty and failed states before it is queued." };
  }
  return null;
}

/** The sections of a Grill's `decisions.md` the ticket needs: `Decisions` while an open line stands, `Behaviour` while the screen's behaviour is open. PURE. */
export function sectionsNeeded(ticket: Pick<Ticket, "description" | "labels">): string[] {
  return [openDecisionOf(ticket.description) === null ? null : "Decisions", behaviourOpen(ticket) ? "Behaviour" : null]
    .filter((section): section is string => section !== null);
}

/**
 * The description once a Grill's answers are written into it: the old text, a blank line, the answers as `decisions.md` holds them, then the marker of
 * each section they hold. The open lines stay as they were: the markers settle them. PURE.
 */
export function settledDescription(description: string, decisions: string): string {
  const marks = [
    /^## Decisions\s*$/m.test(decisions) ? DECISIONS_MARK : null,
    /^## Behaviour\s*$/m.test(decisions) ? BEHAVIOUR_MARK : null,
  ].filter((mark): mark is string => mark !== null);
  return [description.trimEnd(), decisions.trim(), marks.join("\n")].filter((part) => part !== "").join("\n\n");
}

/**
 * The first bullet of a plan's "Decisions made without a person" section that is a product decision, as the bullet's first line, or null. Each bullet
 * starts `Technical:` or `Product:`, and a product decision is never recorded as made without a person (A11-134). PURE.
 */
export function productDecisionIn(plan: string): string | null {
  const bullet = sectionLines(plan, (name) => name === DECISIONS_WITHOUT_PERSON).find(({ line }) => /^[-*]\s+Product:/.test(line));
  return bullet?.line ?? null;
}
