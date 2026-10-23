// @ts-check
// module: a ticket's Done-when section, read out of its description (PURE) -- what the reviewer is told of the contract a pull request is held to (A11-156)
//
// THE REVIEWER CANNOT READ LINEAR. The pool holds each run's ticket as the tracker stores it, so the section is quoted from that description, whole: both parts a ticket writes under
// `## Done-when`, `### Before merge` and `### After merge (who runs it)`, up to the next heading of its own level. A ticket with no such section has none to quote.

import type { AfterMergeLine } from "./board-view/view-types-and-filters.ts";

/** A level-2 heading, which ends a section; the `###` headings under it do not. */
const LEVEL_TWO = /^##(?!#)\s/;
const DONE_WHEN = /^##\s+done[\s-]*when\s*$/i;

/** The ticket's `## Done-when` section, its heading included, or null when the description has none (or is empty). */
export function doneWhenOf(description: string | null | undefined): string | null {
  if (!description) return null;
  const lines = description.split("\n");
  const from = lines.findIndex((line) => DONE_WHEN.test(line.trimEnd()));
  if (from === -1) return null;
  const rest = lines.slice(from + 1);
  const next = rest.findIndex((line) => LEVEL_TWO.test(line));
  const section = [lines[from], ...(next === -1 ? rest : rest.slice(0, next))].join("\n").trim();
  return section;
}

const AFTER_MERGE_HEADING = /^###(?!#)\s+after[\s-]*merge\b/i;
const ANY_HEADING = /^#{1,6}\s/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NONE = /^none\b/i;

/** Whether the character at `at` is a full stop that ends a sentence: the last character, or followed by a space. PURE. */
const endsSentence = (text: string, at: number): boolean => text[at] === "." && (at === text.length - 1 || text[at + 1] === " ");

/** The text from the first sentence's end: a full stop followed by a space or the end, outside a pair of backticks. Empty when the line has one sentence. PURE. */
function afterFirstSentence(text: string): string {
  let inCode = false;
  for (let at = 0; at < text.length; at++) {
    if (text[at] === "`") inCode = !inCode;
    if (!inCode && endsSentence(text, at)) return text.slice(at + 1).trim();
  }
  return "";
}

/** Who runs a line, read by the format a ticket writes it in, `<line>. <who runs it>, <when>, with <command>`: the clause after the first sentence, up to its first comma. Null when there is none. PURE. */
function ownerOf(line: string): string | null {
  const owner = afterFirstSentence(line).split(",")[0].replace(/\.$/, "").trim();
  return owner === "" ? null : owner;
}

/** Whether a line goes on with the bullet above it: it is indented and not blank. PURE. */
const continuesBullet = (text: string): boolean => /^\s/.test(text) && text.trim() !== "";

/**
 * The lines under the After-merge heading of a ticket's `## Done-when` section, each with who runs it (A11-173). A bullet that continues on indented lines is one line. A section that
 * says `None.`, an empty one, a missing one and a ticket with no Done-when give none. The Before-merge lines are not read: they are merge conditions, which a merged pull request met. PURE.
 */
export function afterMergeLines(description: string | null | undefined): AfterMergeLine[] {
  const section = doneWhenOf(description);
  if (section === null) return [];
  const lines = section.split("\n");
  const from = lines.findIndex((line) => AFTER_MERGE_HEADING.test(line.trimEnd()));
  if (from === -1) return [];
  const rest = lines.slice(from + 1);
  const next = rest.findIndex((line) => ANY_HEADING.test(line));
  const bullets: string[] = [];
  for (const text of next === -1 ? rest : rest.slice(0, next)) {
    const bullet = BULLET.exec(text);
    if (bullet !== null) bullets.push(bullet[1].trim());
    else if (continuesBullet(text) && bullets.length > 0) bullets[bullets.length - 1] += ` ${text.trim()}`;
  }
  return bullets.filter((line) => line !== "" && !NONE.test(line)).map((line) => ({ line, owner: ownerOf(line) }));
}
