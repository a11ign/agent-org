// @ts-check
// module: a plan's `## After-merge checks` section (A11-277, A11-302) -- who runs each After-merge line, read out of the plan and checked against the ticket at plan time. PURE
//
// THE PLANNER NAMES EACH CHECK'S RUNNER, AND THE ORG VERIFIES ITS OWN WORK (A11-302). One bullet per After-merge line, the line quoted exactly, with its runner (`board`, `agent` or `person`), the escalation item of a person's, what
// the board watches for of a board's (with the pass condition and window of a windowed spec), and what would close it. `session` is no runner: the plan check refuses it, and any field that names the chairman's session. The plan check
// refuses a plan that leaves an After-merge line out of the section, since an unattended planner cannot edit the ticket and a line with no runner would wait on no one. The sweep reads the section again from the attached plan when it
// copies a run's lines into checks, so a planned line's record carries what the plan says.
import { afterMergeLines } from "../done-when.ts";
import { ESCALATION_IDS } from "../escalation.ts";
import { isBoardMoved, type Move } from "../after-merge-move.ts";
import { linesOf, sectionEnd, type Line } from "../ticket-decisions.ts";
import { OBSERVE_FORMS, parseObserve, parseWindow } from "./observe.ts";
import { lineKey, namesLine, needsPlannedRunner, type PlannedCheck, type Runner } from "./checks.ts";

/** The plan section the planner names each After-merge check's runner in. */
export const AFTER_MERGE_CHECKS_HEADING = "## After-merge checks";

/** The longest a plan's `Evidence:` line may be. */
export const PLANNED_EVIDENCE_CHARS = 200;

/**
 * The exact shape of the section, as the planner brief shows it and as the board's send-back file repeats it (A11-288), so the two can never describe two formats. The worked examples are generic: agent-org is public,
 * so none of an organisation's own names go in them (`escalation.ts`). Their examples sit inside fences, which {@link sectionLines} skips, so a plan that copies them into its prose is not read as a check.
 */
export const AFTER_MERGE_CHECKS_FORMAT = [
  `The exact format of the \`${AFTER_MERGE_CHECKS_HEADING}\` section:`,
  "",
  "```md",
  AFTER_MERGE_CHECKS_HEADING,
  "",
  "- `<the After-merge line, copied verbatim from the ticket>`",
  "  - Runner: board | agent | person",
  "  - Escalation: <id>            (only for a `person` runner)",
  "  - Observe: <spec>             (only for a `board` runner)",
  "  - Pass: absent | present      (only for a windowed `Observe:` spec)",
  "  - Window: <30m | 6h | 7d>     (for a windowed `Observe:` spec, or for an `agent` check that cannot be run until that long after release)",
  `  - Evidence: <one line, at most ${PLANNED_EVIDENCE_CHARS} characters: what would close it>`,
  "```",
  "",
  "- Copy the line from the ticket's `### After merge` (or from your `## Moved to After merge`); inner quotes and spacing are matched forgivingly, but the words must be the ticket's.",
  "- A line that holds a backtick goes inside double backticks.",
  `- \`Evidence:\` is one line of at most ${PLANNED_EVIDENCE_CHARS} characters, with no line break.`,
  "- `Escalation:`, `Observe:`, `Pass:` and `Window:` only when they apply.",
  "- `session` is not a runner, and no field names the chairman's session: the org verifies its own work.",
  "",
  "A worked example of a `board` check, and of an `agent` check:",
  "",
  "```md",
  AFTER_MERGE_CHECKS_HEADING,
  "",
  "- `For a week after release, no run is lost in a restart.`",
  "  - Runner: board",
  "  - Observe: run-log finished \"lost in a restart\"",
  "  - Pass: absent",
  "  - Window: 7d",
  "  - Evidence: the run log of every ticket, quoted if a run was lost",
  "",
  "- `The next release's settings page shows the new field.`",
  "  - Runner: agent",
  "  - Evidence: a screenshot of the settings page on the host, quoted on this ticket",
  "```",
].join("\n");

/** What the planner brief says of a ticket's After-merge lines (A11-277, A11-302), in the single brief and the batch's, and the exact format of the section that answers it (A11-288). */
export const AFTER_MERGE_CHECKS_RULE = "When the ticket's Done-when has `### After merge` lines, or your plan moves a line there, name who runs each one after merge: "
  + `list them in a plan section \`${AFTER_MERGE_CHECKS_HEADING}\`, one bullet per line, as \`\` - \`<the After-merge line, quoted exactly>\` \`\`, with these bullets indented under it: `
  + "`- Runner: board`, `agent` or `person`; `- Escalation: <id>`, for a `person` runner, the id of the escalation list's item the check needs the person for; "
  + `\`- Observe: <spec>\`, for a \`board\` runner only, one of ${OBSERVE_FORMS.map((form) => `\`${form}\``).join(", ")}; `
  + "`- Pass: absent | present` and `- Window: <30m | 6h | 7d>`, for the windowed specs (`run-log`, `merge-queue`, `ci-history`, `doctor`, `release-assets`); an `agent` check that cannot be run until some time after release (\"7 days after release\") takes `- Window:` alone, and the board does not start its verifier run until the window has ended; "
  + `and \`- Evidence: <one line of at most ${PLANNED_EVIDENCE_CHARS} characters saying what would close it>\`, always. `
  + "The org verifies its own work: `session` is not a runner, and the board sends the plan back if it names it or names the chairman's session in any field. "
  + "`board` is for a check the board sees by itself, and it never needs a person: it names its source in `Observe:`, a pass condition and a window. A week-long check (\"for a week, no X happens\") is a `board` check with `Pass: absent` and `Window: 7d`: it passes when the window closes clean, and fails on the first breach, citing the event. "
  + "The window begins when the ticket's change is in a release installed on the host. A source the board cannot read, or a window that closes without the event a `present` check waits for, hands the check to an `agent`. "
  + "`agent` is for everything else the org can do: once the change is in an installed release the board starts a short verifier run, which carries the line and your `Evidence:`, does what the line says on the host, and records passed or failed with evidence; write `Evidence:` so that run knows what to do and what to quote. "
  + "`person` is only for a check on the escalation list: something only a person may do (outward-facing, money or access, a product decision the person reserved, ...). A check a person would merely run is an `agent` check. "
  + "Quote a line that holds a backtick inside double backticks. The board refuses a plan whose section quotes a line that is not one of the ticket's After-merge lines or the lines your plan moves there, and a plan that leaves out an After-merge line. "
  + `A refusal comes back to you from the board, at most twice, with this format; fix the section and write \`planned\` again.\n\n${AFTER_MERGE_CHECKS_FORMAT}`;

const SECTION_LEVEL = 2;
const HEADING = /^##(?!#)\s+after[\s-]*merge\s+checks\s*$/i;
/** A bullet, with the indent before its marker and its text. */
const BULLET = /^(\s*)[-*]\s+(.*?)\s*$/;
/** A check's bullet: the line in a code span of any number of backticks. */
const QUOTE = /^(`+)\s?(.+?)\s?\1$/;
/** A field of a check: `<Name>: <value>`, the value maybe in a code span. */
const FIELD = /^(\w+):\s*(.*)$/;
const RUNNERS: readonly string[] = ["board", "agent", "person"] satisfies readonly Runner[];

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

/** The fields of one check as a plan writes them, before they are held to the rules: the values of `Runner:`, `Escalation:`, `Observe:`, `Pass:`, `Window:` and `Evidence:` by lower-case name. */
export type CheckFields = ReadonlyMap<string, string>;

/** The chairman's session, which no field of a check may name as who runs it (A11-302). */
const CHAIRMAN_SESSION = /\bchairman(?:'s|\u2019s)?\s+session\b/i;

/**
 * One check's fields read as a check the board can record, or why they are not (A11-302): the runner is `board`, `agent` or `person` (`session` is refused with the way to say it instead, and so is any field that names the
 * chairman's session), a `person` needs an item of the escalation list, a `board` needs an observe spec that parses with its pass condition and window, and the evidence is one line of the length the board keeps. PURE.
 */
export function plannedFrom(line: string, fields: CheckFields, spilled: ReadonlySet<string> = new Set()): PlannedCheck | string {
  const value = (name: string): string | undefined => (fields.has(name) ? unquoted(fields.get(name) ?? "") : undefined);
  const named = [...fields.entries()].find(([, text]) => CHAIRMAN_SESSION.test(text));
  if (named !== undefined) return `"${line}" names the chairman's session in its ${named[0]}, which runs no check: the org verifies its own work, so give the line the runner \`board\` or \`agent\``;
  const runner = value("runner") ?? "";
  if (runner.toLowerCase() === "session") return `"${line}" has the runner "${runner}", which is no runner: the person's session runs no check. Use \`board\` (with \`Observe:\`) for what the board can see, \`agent\` for a verifier run after release, or \`person\` with an \`Escalation:\` item`;
  if (!RUNNERS.includes(runner)) return `"${line}" has the runner "${runner}", which is not \`board\`, \`agent\` or \`person\``;
  const escalation = value("escalation");
  if (escalation !== undefined && !ESCALATION_IDS.includes(escalation)) return `"${line}" names the escalation item "${escalation}", which is not on the list (${ESCALATION_IDS.join(", ")})`;
  if (runner === "person" && escalation === undefined) return `"${line}" is the person's and names no escalation item: a check the person would run that is not on the list is an \`agent\` check`;
  if (runner !== "person" && escalation !== undefined) return `"${line}" is the ${runner}'s and names an escalation item, which only a \`person\` runner does`;
  const observeText = value("observe");
  const givesObserve = observeText !== undefined || fields.has("pass") || (runner !== "agent" && fields.has("window"));
  if (runner !== "board" && givesObserve) return `"${line}" is the ${runner}'s and names what the board observes (Observe, Pass or Window), which only a \`board\` runner does`;
  const observe = observeText === undefined ? undefined : parseObserve(observeText, { pass: value("pass"), window: value("window") });
  const unreadable = observe === undefined || typeof observe === "string";
  if (runner === "board" && unreadable) return `"${line}" is the board's and its observe spec ${observe ?? "is missing"}`;
  const evidence = fields.get("evidence") ?? "";
  if (evidence === "" || spilled.has("evidence")) return `"${line}" needs its evidence on one line`;
  if (evidence.length > PLANNED_EVIDENCE_CHARS) return `"${line}" gives evidence of ${evidence.length} characters, more than ${PLANNED_EVIDENCE_CHARS}: shorten it to one line of at most ${PLANNED_EVIDENCE_CHARS}`;
  const delay = runner === "agent" && fields.has("window") ? parseWindow(value("window")) : undefined;
  if (typeof delay === "string") return `"${line}" is the agent's and ${delay}`;
  return { line, runner: runner as Runner, ...(escalation === undefined ? {} : { escalation }), ...(typeof observe === "object" ? { observe } : {}), evidence, ...(delay === undefined ? {} : { window: delay }) };
}

/** A written check read as one the board can record, or why it is not. PURE. */
const plannedOf = ({ line, fields, spilled }: Written): PlannedCheck | string => plannedFrom(line, fields, spilled);

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
 * The checks the plans' sections name that the board can record, for a plan attached before the board held it to today's rules (A11-302): a bullet that is refused is left out and its line runs as an agent's, instead of the whole section being lost.
 * A section whose bullets cannot be told apart names nothing. PURE.
 */
export function plannedChecksLeniently(plans: readonly string[]): PlannedCheck[] {
  return plans.flatMap((plan) => {
    const written = writtenChecks(sectionLines(plan));
    return typeof written === "string" ? [] : written.flatMap((each) => {
      const planned = plannedOf(each);
      return typeof planned === "string" ? [] : [planned];
    });
  });
}

/**
 * Why the plans' `## After-merge checks` sections are refused against the ticket's `description` as the planner read it and the lines the plan moves to After merge (A11-275), or null when they are not: a check
 * the board cannot record, a quoted line that is not one of the ticket's After-merge lines (compared by {@link lineKey}: quotes, backticks and white space aside), a moved one, or one the board moved already, or an
 * After-merge line that the section leaves out and whose owner is nobody, a session or the person (A11-302): such a line waited on the session or the person, so the plan gives it a runner. A line the board moved names its `who`, however
 * long, so it needs no bullet. PURE.
 */
export function afterMergeChecksRefusal(plans: readonly string[], description: string, moves: readonly Move[]): string | null {
  const read = plannedChecks(plans);
  if ("refusal" in read) return read.refusal;
  const ticketLines = afterMergeLines(description);
  const known = (quoted: string): boolean => moves.some(({ line }) => lineKey(line) === lineKey(quoted)) || ticketLines.some(({ line }) => namesLine(quoted, line));
  const stranger = read.checks.find(({ line }) => !known(line));
  if (stranger !== undefined) return `the plan's \`${AFTER_MERGE_CHECKS_HEADING}\` section quotes "${stranger.line}", which is not one of the ticket's After-merge lines`;
  const unlisted = ticketLines.find(({ line, owner }) => needsPlannedRunner(owner) && !isBoardMoved(line) && !read.checks.some((check) => namesLine(check.line, line)));
  return unlisted === undefined ? null
    : `the ticket's After-merge line "${unlisted.line}" has no runner in the plan: add it to the plan's \`${AFTER_MERGE_CHECKS_HEADING}\` section with its runner (\`board\`, \`agent\` or \`person\`)`;
}
