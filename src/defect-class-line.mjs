// @ts-check
// leaf: the `Class:` line a pull request must carry when it closes a defect row (#4123, child A of #4122)
//
// WHY (chairman, 2026-10-08: "you've just figured out the fix; why was the system not able to figure that out?"). #4107 was fixed as an
// INSTANCE in under an hour, nobody asked what class of failure it was or where else the class can occur, and it was the second instance of its
// class. A pull request that closes a row `row-file --kind defect` marked therefore says, in one line, which class it was and what stops it
// everywhere -- or says plainly that no class applies.
//
// ONE DEFINITION FOR BOTH READERS, the way `hand-fix-ledger.mjs` serves `pr-open` and `org-retro`: CI's acceptance job reaches this through
// `CI_BODY_REPORTS` and `pr-open` through `checkBody`, which runs that same list, so a body cannot pass one and fail the other.
//
// THE LABELS ARE READ THROUGH AN INJECTED READER, and its three states are kept apart:
//   no reader      the caller cannot ask (CI's acceptance step runs tracker-less on purpose). NOT CHECKED, printed, never a pass in disguise.
//   a refused read UNKNOWN, and a refusal: "could not ask" is not "no defect label" (ABSENCE IS NOT ZERO).
//   an answer      a defect label on any named row requires the line; none on all of them does not.
// This file imports nothing: `acceptance-commands.mjs` does the `Closes` parse and hands the rows in, so there is no cycle.

/** The label `row-file --kind defect` adds and this check reads: one spelling for both. */
export const DEFECT_LABEL = "defect";

const CLASS_LINE = /^\s*(?:[-*>]\s+)?(?:\*\*|__)?Class:(?:\*\*|__)?\s*(.*)$/i;
/** `none — <reason>`: an EM DASH and a reason, the shape `Closes: none — <reason>` has. A hyphen does not clear it. */
const NONE_SHAPE = /^none\s+—\s+(\S.*)$/;
/** `<id> — <where else it can occur>; guard: <what stops it everywhere>`: `<id>` is a kebab-case slug, both halves non-empty. */
const CLASS_SHAPE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\s+—\s+(\S.*?)\s*;\s*guard:\s*(\S.*)$/;

/** The spelling every refusal prints, so an author learns the format from the first one. */
export const CLASS_FORMAT = "Class: <id> — <where else it can occur>; guard: <the detector, rule or row # that stops it everywhere>\n"
  + "  Class: none — <reason no class applies>";

/**
 * @typedef {{ id: string, where: string, guard: string } | { id: "none", reason: string }} ClassDeclaration
 * @typedef {{ repo: string | null, number: number }} RowReference
 */

/**
 * Every `Class:` line in a body. `malformed` keeps the lines that NAME the field and miss its shape, so a refusal can quote them and a
 * count never silently drops one.
 * @param {string | null | undefined} body
 * @returns {{ declared: ClassDeclaration[], malformed: string[] }}
 */
export function classLinesIn(body) {
  /** @type {ClassDeclaration[]} */
  const declared = [];
  /** @type {string[]} */
  const malformed = [];
  for (const line of String(body ?? "").split(/\r\n|\r|\n/)) {
    const named = CLASS_LINE.exec(line);
    if (!named) continue;
    const value = named[1].trim();
    const none = NONE_SHAPE.exec(value);
    const shaped = none ? null : CLASS_SHAPE.exec(value);
    if (none) declared.push({ id: "none", reason: none[1].trim() });
    else if (shaped) declared.push({ id: shaped[1], where: shaped[2].trim(), guard: shaped[3].trim() });
    else malformed.push(line.trim());
  }
  return { declared, malformed };
}

/** @param {string} label @param {string} wanted gh folds label case, so a comparison here does too */
const sameLabel = (label, wanted) => label.toLowerCase() === wanted.toLowerCase();

/** @param {RowReference} row */
const rowName = (row) => `${row.repo ?? ""}#${row.number}`;

/**
 * The refusal text for a body that closes a defect row and does not carry exactly one well-formed `Class:` line.
 * @param {{ declared: ClassDeclaration[], malformed: string[] }} reading @param {RowReference[]} defects
 * @returns {string}
 */
function refusalLine(reading, defects) {
  const named = defects.map(rowName).join(", ");
  const count = reading.declared.length + reading.malformed.length;
  if (count === 0) {
    return `CLASS: MISSING -- this PR closes a defect row without the Class line (${named} carries \`${DEFECT_LABEL}\`). Write one:\n  ${CLASS_FORMAT}`;
  }
  if (count > 1) {
    return `CLASS: MALFORMED -- ${count} \`Class:\` lines; a defect row's PR carries exactly one (${named} carries \`${DEFECT_LABEL}\`).\n  ${CLASS_FORMAT}`;
  }
  return `CLASS: MALFORMED -- \`${reading.malformed[0]}\` misses the shape: an em dash, a kebab-case id, and both halves are required `
    + `(${named} carries \`${DEFECT_LABEL}\`).\n  ${CLASS_FORMAT}`;
}

/**
 * Which of `rows` carry the defect label, and which could not be read. A row is read once.
 * @param {RowReference[]} rows @param {(row: RowReference) => string[]} rowLabels
 * @returns {{ defects: RowReference[], unreadable: { row: RowReference, why: string }[] }}
 */
function readDefects(rows, rowLabels) {
  /** @type {RowReference[]} */
  const defects = [];
  /** @type {{ row: RowReference, why: string }[]} */
  const unreadable = [];
  for (const row of rows) {
    try {
      if (rowLabels(row).some((label) => sameLabel(label, DEFECT_LABEL))) defects.push(row);
    } catch (error) {
      unreadable.push({ row, why: String(/** @type {Error} */ (error)?.message ?? error).split("\n")[0] });
    }
  }
  return { defects, unreadable };
}

/**
 * THE VERDICT. `rows` is what the body's `Closes` names (empty for `Closes: none`, missing or malformed, which `closes` refuses in its own
 * words). A body with exactly one well-formed line passes WITHOUT a label read: the read could only change the answer for a body that lacks it.
 * @param {{ body: string | null | undefined, rows: RowReference[],
 *   rowLabels?: (row: RowReference) => string[] }} input `rowLabels` throws when the read is refused; absent when the caller cannot ask
 * @returns {{ ok: boolean, line: string }}
 */
export function defectClassReport({ body, rows, rowLabels }) {
  if (rows.length === 0) return { ok: true, line: "CLASS: not required -- the body closes no row" };
  const reading = classLinesIn(body);
  if (reading.declared.length === 1 && reading.malformed.length === 0) {
    const [only] = reading.declared;
    return { ok: true, line: `CLASS: ${only.id}` };
  }
  if (rowLabels === undefined) {
    return { ok: true, line: `CLASS: NOT CHECKED -- no reader of ${rows.map(rowName).join(", ")}'s labels here, so whether it is a defect row is not known` };
  }
  const { defects, unreadable } = readDefects(rows, rowLabels);
  if (defects.length > 0) return { ok: false, line: refusalLine(reading, defects) };
  if (unreadable.length > 0) {
    const which = unreadable.map(({ row, why }) => `${rowName(row)} (${why})`).join(", ");
    return { ok: false, line: `CLASS: UNKNOWN -- could not read the labels of ${which}, so whether this PR closes a defect row is not known. `
      + "That is a refusal, not a pass; retry once GitHub answers." };
  }
  return { ok: true, line: `CLASS: not required -- ${rows.map(rowName).join(", ")} carries no \`${DEFECT_LABEL}\` label` };
}
