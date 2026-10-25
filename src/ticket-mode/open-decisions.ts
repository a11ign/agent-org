// @ts-check
// module: the decisions a ticket still holds open, and whether its screen's behaviour is grilled -- what a Grill has to settle, and what a plan must say instead (A11-134, A11-257)
//
// A TICKET WITH AN OPEN DECISION IS QUEUED, AND ITS PLANNER SETTLES IT (A11-257). Before, a ticket whose Acceptance, Done-when or Open-check still asked a person to decide something, or a screen ticket with no grilled
// behaviour, was held until its Grill wrote the answers into it. Now the planner decides every question that is not on the escalation list (`escalation.ts`), taking the option it would have recommended, and a screen's plan says so
// with `**Behaviour:** settled by the planner` (`missingBehaviour`). The Grill stays as a person's own choice. It records its answers with two markers, which this module reads: `**Decisions:** settled` settles every open line,
// and `**Behaviour:** settled` records a screen's behaviour pass. The browser page never imports this.

import type { Ticket } from "./source.ts";

/** The line a Grill writes into a ticket once its decisions are answered: every open line no longer counts. */
export const DECISIONS_MARK = "**Decisions:** settled";
/** The line a Grill writes into a screen ticket once its behaviour is answered. */
export const BEHAVIOUR_MARK = "**Behaviour:** settled";
/** The line that marks a ticket as changing a screen, for a tracker with no `ui` label. The create-ticket skill writes it. */
export const SCREEN_MARK = "**Screen:** yes";

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

/** The line a plan carries for a screen ticket whose behaviour no Grill settled (A11-257): the planner settled it, and the decisions follow, each with its reason. */
export const BEHAVIOUR_BY_PLANNER = "**Behaviour:** settled by the planner";
/** The line may be a bullet or a quote and may end in a full stop: a plan is not refused for how it spells the line. */
const BEHAVIOUR_BY_PLANNER_LINE = /^\s*(?:[-*>]\s+)?\*\*Behaviour:\*\*\s*settled by the planner\.?\s*$/m;

/**
 * Why a plan is refused for a screen's behaviour, or null (A11-257). A ticket that changes a screen and has no `**Behaviour:** settled` line has had no Grill, and there is no behaviour grill to wait for: the planner settles what the person sees,
 * what each control does and the empty and failed states, and says so with the line {@link BEHAVIOUR_BY_PLANNER}. A plan without it, in all of its `plans` files, is refused. A ticket that does not change a screen, or one whose behaviour was grilled, needs no such line. PURE.
 */
export function missingBehaviour(plans: readonly string[], ticket: Pick<Ticket, "description" | "labels">): string | null {
  if (!behaviourOpen(ticket) || plans.some((plan) => BEHAVIOUR_BY_PLANNER_LINE.test(plan))) return null;
  return `the ticket changes a screen and has no \`${BEHAVIOUR_MARK}\` line, so the plan must settle its behaviour: add the line \`${BEHAVIOUR_BY_PLANNER}\`, followed by each decision with its reason (what the person sees, what each control does, and the empty and failed states)`;
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
