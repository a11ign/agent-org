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

/** The most words, and the most characters, an owner read from a line may have, so a whole clause or sentence is never read as one (A11-277). */
const OWNER_WORDS = 6;
const OWNER_CHARS = 40;

/** Whether `text` is short enough to be an owner: 1 to {@link OWNER_WORDS} words, and no more than {@link OWNER_CHARS} characters with no backtick. PURE. */
const ownerShaped = (text: string): boolean => text !== "" && text.length <= OWNER_CHARS && !text.includes("`") && text.split(/\s+/).length <= OWNER_WORDS;

/** The prefix form, `<owner>: <what is checked>`: the text before the line's first colon, which a space or the line's end follows (A11-277). */
const PREFIX = /^([^:]*):(?:\s|$)/;

/**
 * The subject form, `<runner> <verb> …`: a role's session ("The chairman's session", "The release manager's session", "Chairman's session"), the chairman or the person, at the head of the line
 * and followed by a word in lower case (A11-277). A session is tried before its owner, so "The chairman's session moves" reads the session.
 */
const SUBJECT = /^((?:The (?:\S+ ){0,2}\S+|\p{Lu}\S*)['’]s session|The (?:chairman|person))\s+(?=\p{Ll})/u;

/** The trailing form, A11-173's `<line>. <who runs it>, <when>, with <command>`: the clause after the first sentence, up to its first comma. "" when there is none. PURE. */
const trailingClause = (line: string): string => afterFirstSentence(line).split(",")[0].replace(/\.$/, "").trim();

/**
 * Who runs a line, read from the first of the forms tickets write it in that the line matches (A11-277): the prefix form ("Chairman session: …", "On the agents host: …"), the subject form
 * ("The chairman chooses …"), then the trailing form, each only when what it reads is shaped like an owner. Null when the line names no one. PURE.
 */
export function ownerOf(line: string): string | null {
  const read = [PREFIX.exec(line)?.[1]?.trim(), SUBJECT.exec(line)?.[1], trailingClause(line)];
  return read.find((owner): owner is string => owner !== undefined && ownerShaped(owner)) ?? null;
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
