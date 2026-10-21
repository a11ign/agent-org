// @ts-check
// module: a ticket's Done-when section, read out of its description (PURE) -- what the reviewer is told of the contract a pull request is held to (A11-156)
//
// THE REVIEWER CANNOT READ LINEAR. The pool holds each run's ticket as the tracker stores it, so the section is quoted from that description, whole: both parts a ticket writes under
// `## Done-when`, `### Before merge` and `### After merge (who runs it)`, up to the next heading of its own level. A ticket with no such section has none to quote.

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
