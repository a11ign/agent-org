// @ts-check
// module: a person's answer as an entry of the ticket's Decisions (A11-250) -- PURE
//
// THE BOARD WRITES THE ENTRY, FROM THE RUN'S OWN QUESTION AND THE PERSON'S ANSWER. The entry is the heading `## Decisions (<who>, <date>)` and two bullets, `**Question:**` and `**Answer:**`, the form
// `decisionsOf` (`ticket-decisions.ts`) reads for the reviewer and the briefs quote for planners and workers. It goes in as the ticket's last section, or under the last section when that holds the same heading.
// The pair that is already the description's last entry is not added again, so a retry after a failed delivery writes nothing twice.

/** What the entry records: the question the run asked as the board held it, the answer the person gave as they gave it, whom it is from and the day (`YYYY-MM-DD`). */
export type AnsweredDecision = Readonly<{ question: string; answer: string; who: string; date: string }>;

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^#{1,6}\s/;

/** The text with its code fence closed when it opens one it does not close: an open fence would hide every later line of the description, and the entries after this one, from `decisionsOf`. PURE. */
function closedFences(text: string): string {
  const fences = text.split("\n").filter((line) => FENCE.test(line)).length;
  return fences % 2 === 0 ? text : `${text}\n\`\`\``;
}

/** One bullet: the label, the text's first line, and every later line indented to stay inside the bullet. PURE. */
const bulletOf = (label: string, text: string): string =>
  `* **${label}:** ${closedFences(text.trim()).split("\n").map((line, at) => (at === 0 || line === "" ? line : `  ${line}`)).join("\n")}`;

/** The entry's heading. */
export const decisionHeading = ({ who, date }: Pick<AnsweredDecision, "who" | "date">): string => `## Decisions (${who}, ${date})`;

/** The two bullets of an entry. PURE. */
const bulletsOf = ({ question, answer }: Pick<AnsweredDecision, "question" | "answer">): string => `${bulletOf("Question", question)}\n${bulletOf("Answer", answer)}`;

/** The text of the last heading outside a code fence, or null when the description has none. PURE. */
function lastHeading(description: string): string | null {
  let inFence = false;
  let last: string | null = null;
  for (const line of description.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence && HEADING.test(line)) last = line.trimEnd();
  }
  return last;
}

/**
 * The description with the entry added: under its own heading when that is the description's last section, else as a new last section. `added` is false, and the description unchanged, when its last entry is
 * the same question and answer already. `heading` is the heading the entry stands under, which for a pair already there is the heading it was written under. PURE.
 */
export function withAnswer(description: string, decision: AnsweredDecision): Readonly<{ description: string; added: boolean; heading: string }> {
  const bullets = bulletsOf(decision);
  const heading = decisionHeading(decision);
  const body = description.trimEnd();
  // Only the latest entry counts: the same question answered one way, then another, then the first way again is a new answer, not a repeat.
  if (body.endsWith(bullets)) return { description, added: false, heading: lastHeading(body) ?? heading };
  if (body === "") return { description: `${heading}\n\n${bullets}\n`, added: true, heading };
  const underIt = lastHeading(body) === heading;
  return { description: `${body}\n\n${underIt ? "" : `${heading}\n\n`}${bullets}\n`, added: true, heading };
}
