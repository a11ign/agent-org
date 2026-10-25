// @ts-check
// module: a Before-merge line no pull request can meet, moved to After merge by the planner and written into the ticket by the board (A11-275) -- PURE
//
// A LINE THAT NEEDS A RELEASE IS NO MERGE CONDITION. A Done-when line under `### Before merge` that needs a published release, a person's own machine or anything else a worker cannot reach cannot be met by any branch:
// left there, the reviewer blocks the pull request on it and the card goes to a person, who has nothing to decide (A11-266, PR #1906). The planner names each such line in a plan section `## Moved to After merge`,
// one bullet per line: the line quoted exactly, a reason id, and who runs it. The board checks each bullet against the ticket and refuses a plan that quotes a line the ticket does not hold under `### Before merge`.
//
// THE BOARD WRITES THE TICKET, FROM FIXED WORDS. The line moves under `### After merge`, in the form A11-173's After-merge checks list reads its owner from (`<line>. <who>, after merge ...`), and one entry
// `## Decisions (the planner, <date>)` records each move. Every word is the ticket's own line, the reason's fixed words or the checked `who`: no planner prose reaches the ticket, as A11-250 requires of Decisions.
// A line already moved is not moved again, so a re-plan and a retried attach write nothing twice.
import { lastHeading, WHO_CHARS } from "./answer-decision.ts";
import { linesOf, sectionEnd, type Line } from "./ticket-decisions.ts";

/** The plan section the planner names its moves in. */
export const MOVED_HEADING = "## Moved to After merge";

/** Why a line cannot be met before merge, by the id the planner names it with, in the words the ticket is written with. */
export const MOVE_REASONS = {
  release: "needs a published release",
  machine: "needs a person's own machine",
  unreachable: "needs something a worker cannot reach",
} as const;

/** The id of one of {@link MOVE_REASONS}. */
export type MoveReason = keyof typeof MOVE_REASONS;

/** One line the planner moves: the Before-merge line as the ticket words it, why it cannot be met before merge, and who runs it after merge. */
export type Move = Readonly<{ line: string; reason: MoveReason; who: string }>;

/** What the planner brief says of a line no branch can meet before merge (A11-275), in the single brief and the batch's. */
export const MOVE_RULE = "A Before-merge line of the ticket's Done-when that needs a published release, a person's own machine, or anything else a worker cannot reach cannot be met before merge: no branch can meet it. "
  + `Do not plan a worker to meet it. Move it to After merge: list it in a plan section \`${MOVED_HEADING}\`, one bullet per line, as \`\` - \`<the Before-merge line, quoted exactly>\` — <reason> — <who runs it> \`\`. `
  + "`<reason>` is `release` (it needs a published release), `machine` (it needs a person's own machine) or `unreachable` (it needs something else a worker cannot reach). "
  + `\`<who runs it>\` is one line of at most ${WHO_CHARS} characters, such as \`the person's session\`. Quote a line that holds a backtick inside double backticks. `
  + "The board refuses a plan that quotes a line the ticket does not hold under `### Before merge`. Once the plan is attached, the board moves each line under `### After merge` with who runs it and records the move in the ticket's Decisions, before any worker starts. "
  + "A check a worker can run against its own branch, a test or a command with its cleanup, stays Before merge.";

const BEFORE_MERGE = /^###(?!#)\s+before[\s-]*merge\b/i;
const AFTER_MERGE = /^###(?!#)\s+after[\s-]*merge\b/i;
const DONE_WHEN = /^##(?!#)\s+done[\s-]*when\s*$/i;
const MOVED = /^##(?!#)\s+moved\s+to\s+after[\s-]*merge\s*$/i;
/** A bullet: its marker with the indent before it, and its text, without the carriage return a tracker may end a line with. */
const BULLET = /^(\s*[-*]\s+)(.*?)\r?$/;
/** A move's bullet: the line in a code span of any number of backticks, then the reason and who, apart by a dash. */
const MOVE_BULLET = /^\s*[-*]\s+(`+)\s?(.+?)\s?\1\s*(?:—|–|--)\s*(\S+)\s*(?:—|–|--)\s*(.*?)\s*$/;
/** The words a moved line carries after its owner, which also mark it as moved. */
const MOVED_MARK = "after merge (moved by the planner:";

/** The lines a heading is looked for in: from `from` up to `to`. */
type Span = Readonly<{ from: number; to: number }>;

/** The index of the first line in `span` (the whole text by default) that is no fenced line and matches `heading`, or -1. PURE. */
const headingAt = (lines: readonly Line[], heading: RegExp, { from, to }: Span = { from: 0, to: lines.length }): number =>
  lines.findIndex(({ text, fenced }, at) => at >= from && at < to && !fenced && heading.test(text.trimEnd()));

/** The level of a `## <section>` heading, and of a `### <part>` heading under it. */
const SECTION_LEVEL = 2;
const PART_LEVEL = 3;

/** Where a `### <part>` heading of the ticket's Done-when is, and the index past its part's last line. */
type Part = Readonly<{ heading: number; end: number }>;

/** Where the `### <part>` heading of the ticket's Done-when is, and where its part ends; null when the ticket has no such part. PURE. */
function partOf(lines: readonly Line[], part: RegExp): Part | null {
  const doneWhen = headingAt(lines, DONE_WHEN);
  if (doneWhen === -1) return null;
  const heading = headingAt(lines, part, { from: doneWhen + 1, to: sectionEnd(lines, doneWhen, SECTION_LEVEL) });
  return heading === -1 ? null : { heading, end: sectionEnd(lines, heading, PART_LEVEL) };
}

/** The bullets of a part, each with where it starts, where it ends (its indented lines go with it), and its text, trimmed. PURE. */
function bulletsOf(lines: readonly Line[], part: Part | null): { start: number; end: number; text: string }[] {
  if (part === null) return [];
  const bullets: { start: number; end: number; text: string; indent: number }[] = [];
  for (let at = part.heading + 1; at < part.end; at++) {
    const { text, fenced } = lines[at];
    const bullet = fenced ? null : BULLET.exec(text);
    const last = bullets.at(-1);
    // A line indented past the bullet above it, a nested bullet among them, goes on with that bullet.
    const goesOn = last !== undefined && last.end === at && text.trim() !== "" && indentOf(text) > last.indent;
    if (goesOn) last.end = at + 1;
    else if (bullet !== null) bullets.push({ start: at, end: at + 1, text: bullet[2].trim(), indent: indentOf(text) });
  }
  return bullets.map(({ start, end, text }) => ({ start, end, text }));
}

/** How many characters of white space a line starts with. PURE. */
const indentOf = (text: string): number => text.length - text.trimStart().length;

/** The line without the full stop it ends with, so the owner's sentence follows it. PURE. */
const sentenceOf = (line: string): string => line.trim().replace(/\.$/, "");

/** Whether the ticket's After-merge part holds `line` as the board moves one. PURE. */
const alreadyMoved = (lines: readonly Line[], line: string): boolean =>
  bulletsOf(lines, partOf(lines, AFTER_MERGE)).some(({ text }) => text.startsWith(`${sentenceOf(line)}. `) && text.includes(MOVED_MARK));

/** One bullet of the plan's section read as a move, or why it is not one. PURE. */
function moveOf(bullet: string): Move | string {
  const parts = MOVE_BULLET.exec(bullet);
  if (parts === null) return `its \`${MOVED_HEADING}\` bullet "${bullet.trim()}" is not \`\` - \`<line>\` — <reason> — <who runs it> \`\``;
  const [, , line, reason, who] = parts;
  if (!(reason in MOVE_REASONS)) return `it moves "${line.trim()}" for the reason "${reason}", which is not one of ${Object.keys(MOVE_REASONS).map((id) => `\`${id}\``).join(", ")}`;
  if (who === "") return `it moves "${line.trim()}" and names nobody to run it`;
  if (who.length > WHO_CHARS) return `it moves "${line.trim()}" for someone named in more than ${WHO_CHARS} characters`;
  return { line: line.trim(), reason: reason as MoveReason, who };
}

/** Every bullet under a `## Moved to After merge` heading in `plan`, outside a fence. PURE. */
function movedBullets(plan: string): string[] {
  const lines = linesOf(plan);
  const bullets: string[] = [];
  for (let at = headingAt(lines, MOVED); at !== -1; at = headingAt(lines, MOVED, { from: at + 1, to: lines.length })) {
    bullets.push(...lines.slice(at + 1, sectionEnd(lines, at, SECTION_LEVEL)).filter(({ text, fenced }) => !fenced && BULLET.test(text)).map(({ text }) => text));
  }
  return bullets;
}

/**
 * The lines the plan's files move to After merge, checked against the ticket's `description` as the planner read it, or why the plan is refused: a bullet that is not one move, a reason that is not one of
 * {@link MOVE_REASONS}, a missing or over-long `who`, or a line the ticket holds neither under `### Before merge` nor as one the board moved already. The same line named twice is one move. PURE.
 */
export function plannedMoves(plans: readonly string[], description: string): { moves: Move[] } | { refusal: string } {
  const lines = linesOf(description);
  const before = bulletsOf(lines, partOf(lines, BEFORE_MERGE)).map(({ text }) => text);
  const moves: Move[] = [];
  for (const bullet of plans.flatMap(movedBullets)) {
    const move = moveOf(bullet);
    if (typeof move === "string") return { refusal: `the plan's move to After merge is not one the board can write: ${move}` };
    if (!before.includes(move.line) && !alreadyMoved(lines, move.line)) {
      return { refusal: `the plan moves "${move.line}" to After merge, but the ticket holds no such line under its \`### Before merge\` heading` };
    }
    if (!moves.some(({ line }) => line === move.line)) moves.push(move);
  }
  return { moves };
}

/** A moved line as the ticket's After-merge part holds it: in A11-173's form, `<line>. <who>, after merge ...`, so the After-merge checks list reads who runs it. PURE. */
const movedLine = ({ line, reason, who }: Move): string => `${sentenceOf(line)}. ${who}, ${MOVED_MARK} it ${MOVE_REASONS[reason]}).`;

/** The Decisions bullet that records a move. PURE. */
const decisionLine = ({ line, reason, who }: Move): string => `* **${line}** is an After-merge check, run by ${who}: it ${MOVE_REASONS[reason]}. Reviewers do not block a pull request on it.`;

/** The text with `added` appended as the description's last section headed `heading`, or under that heading when it is the last one already. PURE. */
function withEntry(text: string, heading: string, added: readonly string[]): string {
  const body = text.trimEnd();
  return `${body}\n\n${lastHeading(body) === heading ? "" : `${heading}\n\n`}${added.join("\n")}\n`;
}

/**
 * The ticket's `description` with each of `moves` still under `### Before merge` moved under `### After merge` (made after the Before-merge part when the ticket has none), and one entry
 * `## Decisions (the planner, <date>)` recording them. A move whose line is no longer under Before merge is left out, so the text a rewrite gives is rewritten to itself. `date` is `YYYY-MM-DD`. PURE.
 */
export function withMoves(description: string, moves: readonly Move[], date: string): string {
  const lines = linesOf(description);
  const before = partOf(lines, BEFORE_MERGE);
  const moving = movingBullets(lines, before, moves);
  if (before === null || moving.length === 0) return description;
  const taken = new Set(moving.flatMap(({ start, end }) => Array.from({ length: end - start }, (_, at) => start + at)));
  const kept = lines.map(({ text }, at) => (taken.has(at) ? null : text));
  const rewritten = withAfterMerge(kept, { before, after: partOf(lines, AFTER_MERGE) }, moving.flatMap((bullet) => movedBullet(lines, bullet)));
  return withEntry(rewritten, `## Decisions (the planner, ${date})`, [...new Set(moving.map(({ move }) => decisionLine(move)))]);
}

/** A Before-merge bullet one of the moves names, with the move. */
type Moving = ReturnType<typeof bulletsOf>[number] & Readonly<{ move: Move }>;

/** The bullets of the Before-merge part that one of `moves` names, each with its move. PURE. */
const movingBullets = (lines: readonly Line[], before: Part | null, moves: readonly Move[]): Moving[] =>
  bulletsOf(lines, before).flatMap((bullet) => {
    const move = moves.find(({ line }) => line === bullet.text);
    return move === undefined ? [] : [{ ...bullet, move }];
  });

/** A moved bullet's lines as the After-merge part holds them: its own bullet marker and the moved line, then the indented lines that went on with it. PURE. */
function movedBullet(lines: readonly Line[], { start, end, move }: Moving): string[] {
  const marker = BULLET.exec(lines[start].text)![1].trimStart();
  return [`${marker}${movedLine(move)}`, ...lines.slice(start + 1, end).map(({ text }) => text)];
}

/**
 * The kept lines (null for a line moved out) with `added` at the end of the After-merge part, past its own trailing blank lines, or in a new `### After merge` part after the Before-merge one when the ticket
 * has none, joined into the description. PURE.
 */
function withAfterMerge(kept: readonly (string | null)[], { before, after }: Readonly<{ before: Part; after: Part | null }>, added: readonly string[]): string {
  const into = after === null ? before.end : lastFilled(kept, after.heading, after.end) + 1;
  const apart = kept.slice(0, into).filter((text) => text !== null).at(-1)?.trim() === "" ? [] : [""];
  const insert = after === null ? [...apart, "### After merge", "", ...added, ""] : [...(into === after.heading + 1 ? [""] : []), ...added];
  return [...kept.slice(0, into), ...insert, ...kept.slice(into)].filter((text): text is string => text !== null).join("\n");
}

/** The index of the last line from `from` up to `to` that is kept and not blank. PURE. */
function lastFilled(kept: readonly (string | null)[], from: number, to: number): number {
  for (let at = to - 1; at > from; at--) if (kept[at] !== null && kept[at]!.trim() !== "") return at;
  return from;
}
