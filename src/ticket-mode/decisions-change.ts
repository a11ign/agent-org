// @ts-check
// module: a change to a ticket's Decisions since a run last read it (A11-305) -- PURE
//
// A DECISION A PERSON ADDS TO A TICKET IS WORK FOR ITS OPEN PULL REQUESTS, AND A ROUND THAT DOES NOT SAY SO FINDS "NO NEW FEEDBACK". A11-291's rework was asked for by a new Decisions entry; the round that followed it was told to answer feedback, saw
// none, and ended `reviewed` after 48 seconds. So every round's brief opens with the lines of the Decisions that differ from what the run was last briefed with, and the instruction that goes with them; the board starts a round of its own when
// a finished run's ticket gains such lines (`pool-ticket-text.ts`); the Stop hook refuses a `reviewed` that pushed nothing and does not quote them (`hook.ts`); and the first-merge-flow card waits while a change is unanswered (`board-view/not-merging.ts`).
// "The Decisions" are what `decisionsOf` reads for the reviewer (A11-213, A11-250): the sections headed Decisions or Behaviour, and a line that marks itself as the chairman's.
import { diffLines } from "./board-view/ticket-change.ts";
import { diffText } from "./brief-ticket-text.ts";
import { decisionsOf } from "./ticket-decisions.ts";

/** The lines of a ticket's Decisions that changed: the new ones (`added`, which the pull requests must meet), the old ones that are gone, and the change as a `diff` block with the lines around it. */
export type DecisionsChange = Readonly<{ added: readonly string[]; removed: readonly string[]; diff: string }>;

/** The words a brief opens with when the Decisions changed (A11-305): make the pull requests meet them, or reply quoting why they already do. */
export const DECISIONS_CHANGED = "The ticket's Decisions changed: make the pull requests meet them, or reply quoting why they already do.";

/** The most lines the unmet-quote refusal names, so a long decision does not fill the hook's reply. */
const NAMED_MISSES = 5;

const HEADING = /^#{1,6}\s/;

/**
 * What changed in the Decisions of a ticket between its description `before` and `after`, or null when they read the same. A line of spacing is no change. A ticket with no Decisions before has all of them added; one with none now has all of them removed. PURE.
 */
export function decisionsChange(before: string | null | undefined, after: string | null | undefined): DecisionsChange | null {
  const was = decisionsOf(before) ?? "";
  const now = decisionsOf(after) ?? "";
  if (was === now) return null;
  const changed = diffLines(was, now).filter(({ kind, text }) => kind !== "same" && text.trim() !== "");
  if (changed.length === 0) return null;
  const lines = (kind: "added" | "removed"): string[] => changed.filter((line) => line.kind === kind).map(({ text }) => text.trim());
  return { added: lines("added"), removed: lines("removed"), diff: diffText(was, now) };
}

/** Whether the change asks for work: it adds a line. A decision taken out leaves nothing for a pull request to meet. PURE. */
export const asksForWork = (change: DecisionsChange | null): change is DecisionsChange => change !== null && change.added.length > 0;

/** The brief's first section when the Decisions changed (A11-305): the instruction, the lines that differ, and what a reply that disputes the change must hold. PURE. */
export function decisionsChangedSection(change: DecisionsChange): string {
  return `## The ticket's Decisions changed

${DECISIONS_CHANGED}

These lines of the ticket's Decisions differ from the text your last round read:

${change.diff}

${change.added.length === 0 ? "A decision was taken out; nothing is added for the pull requests to meet.\n\n" : ""}A reply that says the pull requests already meet the change quotes the new lines above, word for word, and says why each is met. The Stop hook refuses a \`reviewed\` that pushed nothing and does not quote them in your final message.
`;
}

/** The text of a line as it is compared when a reply quotes it: its list, quote and heading marks off, its spacing and case ignored. PURE. */
const plain = (text: string): string => text.replace(/^\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)?/, "").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** The lines of the change a reply must quote: the new ones, headings aside (a heading only names the entry), or the headings when that is all there is. PURE. */
export function linesToQuote(added: readonly string[]): string[] {
  const body = added.filter((line) => !HEADING.test(line.trim()));
  return body.length > 0 ? body : [...added];
}

/** The new lines `reply` does not quote, each as written in the ticket. A reply is searched with its quote marks, backticks and spacing ignored. PURE. */
export function unquotedLines(added: readonly string[], reply: string): string[] {
  const haystack = plain(reply.split("\n").map((line) => line.replace(/^\s*(?:>\s*)+/, "")).join(" "));
  return linesToQuote(added).filter((line) => !haystack.includes(plain(line)));
}

/** The refusal of a reply that quotes too little of the change, naming the first lines it left out. PURE. */
export function missingQuoteAsk(missed: readonly string[]): string {
  const named = missed.slice(0, NAMED_MISSES).map((line) => `> ${line}`).join("\n");
  const more = missed.length > NAMED_MISSES ? `\n(and ${missed.length - NAMED_MISSES} more)` : "";
  return `${DECISIONS_CHANGED} Your \`reviewed\` pushed nothing, and your final message does not quote these new lines of the Decisions:\n\n${named}${more}\n\nEither make the pull requests meet them, commit and push, or end with a message that quotes each line and says why the pull requests already meet it.`;
}

/** How much of a reply must be its own words, once the quoted lines are taken out of it, for it to say why the pull requests meet the change: a sentence. */
const REASON_CHARS = 40;

/** Whether `reply` says something beyond the lines it quotes: the reason the pull requests already meet them. PURE. */
export function saysWhy(added: readonly string[], reply: string): boolean {
  const rest = linesToQuote(added).reduce((left, line) => left.split(plain(line)).join(" "), plain(reply.split("\n").map((line) => line.replace(/^\s*(?:>\s*)+/, "")).join(" ")));
  return rest.replace(/[^\p{L}\p{N}]+/gu, " ").trim().length >= REASON_CHARS;
}

/** The refusal of a reply that quotes the new lines and gives no reason for them. PURE. */
export const missingReasonAsk = `${DECISIONS_CHANGED} Your \`reviewed\` pushed nothing, and your final message quotes the new lines but does not say why the pull requests already meet them. Say, for each line, which part of the diff, the description or the tests meets it, or make the pull requests meet it, commit and push.`;
