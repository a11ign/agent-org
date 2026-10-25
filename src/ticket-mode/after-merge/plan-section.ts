// @ts-check
// module: a plan's `## After-merge checks` section (A11-277) -- who runs each After-merge line, read out of the plan and checked against the ticket at plan time. PURE
//
// THE PLANNER NAMES EACH CHECK'S RUNNER. One bullet per After-merge line, the line quoted exactly, with its runner (`session`, `person` or `board`), the escalation item of a person's, what the board watches for of a
// board's, and what would close it. The plan check refuses a plan that leaves an owner-less After-merge line out of the section: that is "the planner refuses such a line at plan time", since an unattended planner
// cannot edit the ticket. The sweep reads the section again from the attached plan when it copies a run's lines into checks, so a planned line's record carries what the plan says.
import { afterMergeLines } from "../done-when.ts";
import { ESCALATION_IDS } from "../escalation.ts";
import { isBoardMoved, type Move } from "../after-merge-move.ts";
import { linesOf, sectionEnd, type Line } from "../ticket-decisions.ts";
import { OBSERVE_FORMS, parseObserve } from "./observe.ts";
import { namesLine, type PlannedCheck, type Runner } from "./checks.ts";

/** The plan section the planner names each After-merge check's runner in. */
export const AFTER_MERGE_CHECKS_HEADING = "## After-merge checks";

/** The longest a plan's `Evidence:` line may be. */
export const PLANNED_EVIDENCE_CHARS = 200;

/** What the planner brief says of a ticket's After-merge lines (A11-277), in the single brief and the batch's. */
export const AFTER_MERGE_CHECKS_RULE = "When the ticket's Done-when has `### After merge` lines, or your plan moves a line there, name who runs each one after merge: "
  + `list them in a plan section \`${AFTER_MERGE_CHECKS_HEADING}\`, one bullet per line, as \`\` - \`<the After-merge line, quoted exactly>\` \`\`, with these bullets indented under it: `
  + "`- Runner: session`, `person` or `board`; `- Escalation: <id>`, for a `person` runner, the id of the escalation list's item the check needs the person for; "
  + `\`- Observe: <spec>\`, for a \`board\` runner only, one of ${OBSERVE_FORMS.map((form) => `\`${form}\``).join(", ")}; `
  + `and \`- Evidence: <one line of at most ${PLANNED_EVIDENCE_CHARS} characters saying what would close it>\`, always. `
  + "`session` is the person's session, which runs every check that is not the person's or the board's, for a named role too. `person` is only for a check on the escalation list; a check the person would run that is not on it is written as `session`. "
  + "`board` is for a check the board sees by itself: a ticket the dependency sweep files (`sweep-ticket`), a review on a named pull request (`review`), a pull request in a repository merged with no person (`queue-merge`), or the board waking a worker on its declared wait (`wake`). "
  + "Quote a line that holds a backtick inside double backticks. The board refuses a plan whose section quotes a line that is not one of the ticket's After-merge lines or the lines your plan moves there, and a plan that leaves out an After-merge line which names nobody to run it.";

const SECTION_LEVEL = 2;
const HEADING = /^##(?!#)\s+after[\s-]*merge\s+checks\s*$/i;
/** A bullet, with the indent before its marker and its text. */
const BULLET = /^(\s*)[-*]\s+(.*?)\s*$/;
/** A check's bullet: the line in a code span of any number of backticks. */
const QUOTE = /^(`+)\s?(.+?)\s?\1$/;
/** A field of a check: `<Name>: <value>`, the value maybe in a code span. */
const FIELD = /^(\w+):\s*(.*)$/;
const RUNNERS: readonly string[] = ["session", "person", "board"] satisfies readonly Runner[];

/** A check's bullet as written: its quoted line, the fields under it by lower-case name, and the names of the fields that went on past their own line. */
type Written = { line: string; fields: Map<string, string>; spilled: Set<string> };

/** The value of a field, without the code span it may be written in. PURE. */
const unquoted = (value: string): string => value.trim().replace(/^`+\s?(.*?)\s?`+$/, "$1");

/** How many characters of white space a line starts with. PURE. */
const indentOf = (text: string): number => text.length - text.trimStart().length;

/** The lines under each `## After-merge checks` heading of a plan, outside a fence. PURE. */
function sectionLines(plan: string): Line[] {
  const lines = linesOf(plan);
  return lines.flatMap(({ text, fenced }, at) => (!fenced && HEADING.test(text.trimEnd()) ? lines.slice(at + 1, sectionEnd(lines, at, SECTION_LEVEL)) : []));
}

/** The checks a section's lines write, or why a bullet is not one: a top-level bullet is a quoted line, and the bullets indented under it are its fields. PURE. */
function writtenChecks(lines: readonly Line[]): Written[] | string {
  const written: Written[] = [];
  let top = -1;
  let field: string | null = null;
  for (const { text, fenced } of lines) {
    if (fenced || text.trim() === "") continue;
    const bullet = BULLET.exec(text);
    const last = written.at(-1);
    if (bullet !== null && (top === -1 || bullet[1].length <= top)) {
      const quote = QUOTE.exec(bullet[2]);
      if (quote === null) return `its bullet "${bullet[2]}" is not \`\` - \`<the After-merge line>\` \`\``;
      top = bullet[1].length;
      field = null;
      written.push({ line: quote[2].trim(), fields: new Map(), spilled: new Set() });
    } else if (bullet !== null && last !== undefined) {
      const [, name, value] = FIELD.exec(bullet[2]) ?? [];
      field = name === undefined ? null : name.toLowerCase();
      if (field !== null) last.fields.set(field, value.trim());
    } else if (last !== undefined && field !== null && indentOf(text) > top) {
      last.spilled.add(field);
    }
  }
  return written;
}

/** A written check read as one the board can record, or why it is not. PURE. */
function plannedOf({ line, fields, spilled }: Written): PlannedCheck | string {
  const runner = unquoted(fields.get("runner") ?? "");
  if (!RUNNERS.includes(runner)) return `"${line}" has the runner "${runner}", which is not \`session\`, \`person\` or \`board\``;
  const escalationText = fields.get("escalation");
  const escalation = escalationText === undefined ? undefined : unquoted(escalationText);
  if (escalation !== undefined && !ESCALATION_IDS.includes(escalation)) return `"${line}" names the escalation item "${escalation}", which is not on the list (${ESCALATION_IDS.join(", ")})`;
  if (runner === "person" && escalation === undefined) return `"${line}" is the person's and names no escalation item: a check the person would run that is not on the list is the session's`;
  const observeText = fields.get("observe");
  if (runner !== "board" && observeText !== undefined) return `"${line}" is the ${runner}'s and names what the board observes, which only a \`board\` runner does`;
  const observe = observeText === undefined ? undefined : parseObserve(unquoted(observeText));
  if (runner === "board" && (observe === undefined || typeof observe === "string")) return `"${line}" is the board's and its observe spec ${observe ?? "is missing"}`;
  const evidence = fields.get("evidence") ?? "";
  if (evidence === "" || spilled.has("evidence")) return `"${line}" needs its evidence on one line`;
  if (evidence.length > PLANNED_EVIDENCE_CHARS) return `"${line}" gives evidence of more than ${PLANNED_EVIDENCE_CHARS} characters`;
  return { line, runner: runner as Runner, ...(escalation === undefined ? {} : { escalation }), ...(typeof observe === "object" ? { observe } : {}), evidence };
}

/** The checks the plans' `## After-merge checks` sections name, in order, or why one is not one the board can record. A line named twice is decided by its last bullet. PURE. */
export function plannedChecks(plans: readonly string[]): { checks: PlannedCheck[] } | { refusal: string } {
  const checks: PlannedCheck[] = [];
  for (const plan of plans) {
    const written = writtenChecks(sectionLines(plan));
    if (typeof written === "string") return { refusal: `the plan's \`${AFTER_MERGE_CHECKS_HEADING}\` section is not one the board can read: ${written}` };
    for (const each of written) {
      const planned = plannedOf(each);
      if (typeof planned === "string") return { refusal: `the plan's \`${AFTER_MERGE_CHECKS_HEADING}\` section is not one the board can record: ${planned}` };
      checks.push(planned);
    }
  }
  return { checks };
}

/**
 * Why the plans' `## After-merge checks` sections are refused against the ticket's `description` as the planner read it and the lines the plan moves to After merge (A11-275), or null when they are not: a check
 * the board cannot record, a quoted line that is not one of the ticket's After-merge lines (compared trimmed), a moved one, or one the board moved already, or an After-merge line that names nobody to run it and
 * that the section leaves out. A line the board moved names its `who`, however long, so it is never one that names nobody. PURE.
 */
export function afterMergeChecksRefusal(plans: readonly string[], description: string, moves: readonly Move[]): string | null {
  const read = plannedChecks(plans);
  if ("refusal" in read) return read.refusal;
  const ticketLines = afterMergeLines(description);
  const known = (quoted: string): boolean => moves.some(({ line }) => line === quoted) || ticketLines.some(({ line }) => namesLine(quoted, line));
  const stranger = read.checks.find(({ line }) => !known(line));
  if (stranger !== undefined) return `the plan's \`${AFTER_MERGE_CHECKS_HEADING}\` section quotes "${stranger.line}", which is not one of the ticket's After-merge lines`;
  const ownerless = ticketLines.find(({ line, owner }) => owner === null && !isBoardMoved(line) && !read.checks.some((check) => namesLine(check.line, line)));
  return ownerless === undefined ? null
    : `the ticket's After-merge line "${ownerless.line}" names nobody to run it: add it to the plan's \`${AFTER_MERGE_CHECKS_HEADING}\` section with its runner`;
}
