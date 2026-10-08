// @ts-check
// module: the class-repeat facts -- which failure classes have a SECOND closed row, read from the index and the tracker (#4126, child B of #4122)
//
// A CLASS is a way the org fails that has happened more than once; its definition (`id`, `name`, `guard`) is a row of the project's
// `.agent-org/failure-classes.json`, and an INSTANCE is a CLOSED row carrying the label `class:<id>`. The gate COUNTS labels, so no
// model judges membership, and a defect pull request never edits the index. A second closed row under one class is a repeat, and a
// repeat means the guard failed. `org-health.mjs` turns what this file reads into the `class-repeat` signal.
//
// A LEAF: it imports no org-health or work-gate name (the signal's name and the order text live there), so both can import it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_CHECKOUT } from "./project-config.mjs";

/** Where the index lives under the project checkout. */
export const FAILURE_CLASSES_PATH = ".agent-org/failure-classes.json";
/** The label an instance carries; what follows it is the class id. */
export const CLASS_LABEL_PREFIX = "class:";
/**
 * HOW LONG A REPEAT STAYS OFFERED, and it is what makes the offer ONE offer. A closed row stays closed, so the condition "two rows under one class"
 * never clears by itself, and an order for a condition that stands would be re-sent every two hours until `MAX_DELIVERIES`. The repeat is therefore
 * offered only while its NEWEST instance closed within this window, and the discriminator names that instance: the same newest row is the same key,
 * and a third row is a new key and a new offer. STRICTLY UNDER `wake.mjs`'s `JUDGMENT_TTL_MS` (two hours), as `ANSWER_GIVEN_WINDOW_MS` is and for the
 * same reason: past the TTL the ledger would send the same key a second time. The price is that a gate that did not tick for this long misses the offer.
 */
export const CLASS_REPEAT_WINDOW_MS = 90 * 60 * 1000;

const RECENT_CLOSED_WINDOW = 100;
const CLASS_ROWS_WINDOW = 100;
const MAX_REASON_CHARS = 160;
/** What `gh` is asked to keep of each row: the raw `issues` listing carries every body, which this never reads. */
const ROW_PROJECTION = "[.[] | {number, state, closed_at, pull_request: (.pull_request != null), labels: [.labels[].name]}]";

/**
 * @typedef {{ id: string, name: string, guard: string | null, guardNote: string | null }} FailureClass
 * @typedef {{ number: number, closedAt: number | null, classes: string[] }} ClassRow a CLOSED row and the class ids its `class:` labels name; `closedAt` is epoch ms
 * @typedef {{ index: FailureClass[], rows: ClassRow[] } | { unreadable: string }} ClassRepeatFact `unreadable` is a refused read of the labels or the file and says why: it is never "no repeats"
 */

/** @param {unknown} err @returns {string} */
const firstLine = (err) => String(/** @type {any} */ (err)?.message ?? err).split("\n")[0].slice(0, MAX_REASON_CHARS);

/**
 * THE INDEX, parsed. `null` is text that is not an index (a bad parse, no `classes` list, an entry without a string `id`): a stated gap, since an index
 * read as empty would call every class label an unknown class.
 * @param {string} text @returns {FailureClass[] | null}
 */
export function parseFailureClasses(text) {
  try {
    const classes = JSON.parse(text)?.classes;
    if (!Array.isArray(classes) || !classes.every((c) => typeof c?.id === "string" && c.id !== "")) return null;
    return classes.map((c) => ({ id: c.id, name: String(c.name ?? ""), guard: typeof c.guard === "string" ? c.guard : null,
      guardNote: typeof c.guardNote === "string" ? c.guardNote : null }));
  } catch {
    return null;
  }
}

/**
 * ONE CLOSED ROW PER GITHUB LISTING ENTRY THAT IS ONE: a pull request is in the `issues` listing too, and an open row is never an instance -- the
 * class step happens before a row closes (child A), so the count is of what was closed. Filtered here as well as in the query, because a fake that
 * answers every query would otherwise count an open row. `null` is an entry that is not the projection's shape.
 * @param {any} entry @returns {ClassRow | null | "skip"}
 */
function rowOf(entry) {
  if (typeof entry?.number !== "number" || !Array.isArray(entry.labels)) return null;
  if (entry.pull_request === true || entry.state !== "closed") return "skip";
  const classes = entry.labels.filter((/** @type {unknown} */ l) => typeof l === "string" && l.startsWith(CLASS_LABEL_PREFIX)).map((/** @type {string} */ l) => l.slice(CLASS_LABEL_PREFIX.length));
  const closedAt = Date.parse(entry.closed_at);
  return { number: entry.number, closedAt: Number.isFinite(closedAt) ? closedAt : null, classes };
}

/**
 * @param {string} text the projected listing @returns {ClassRow[] | null} the closed rows carrying a `class:` label, `null` for text that is not a listing
 */
function parseRows(text) {
  try {
    const entries = JSON.parse(text);
    if (!Array.isArray(entries)) return null;
    const rows = entries.map(rowOf);
    if (rows.includes(null)) return null;
    return /** @type {ClassRow[]} */ (rows.filter((r) => r !== null && r !== "skip" && r.classes.length > 0));
  } catch {
    return null;
  }
}

/**
 * @param {(args: string[]) => string} run @param {string} repo @param {string | null} classId the class to list ALL closed instances of, or `null` for the newest-updated closed rows
 * @returns {ClassRow[] | null}
 */
function listClosed(run, repo, classId) {
  const perPage = classId === null ? RECENT_CLOSED_WINDOW : CLASS_ROWS_WINDOW;
  const label = classId === null ? [] : ["-f", `labels=${CLASS_LABEL_PREFIX}${classId}`];
  return parseRows(run(["api", "--method", "GET", `repos/${repo}/issues`, "-f", "state=closed", "-f", "sort=updated", "-f", "direction=desc", "-f", `per_page=${perPage}`,
    ...label, "--jq", ROW_PROJECTION]));
}

/**
 * THE FACT FOR THE `class-repeat` SIGNAL: the index, then ONE REST CALL on the core pool for the newest-updated closed rows (every tick), then ONE MORE PER
 * CLASS whose newest instance closed inside the window (`CLASS_REPEAT_WINDOW_MS`), to count that class's instances over all time. A class with no
 * recent instance cannot be offered this tick, so it is not listed: `gh` cannot filter a label PREFIX, and listing every class each tick would be one call
 * per class for nothing. NEVER THROWS: a refused call, an unparseable listing or a missing index is `{ unreadable }`, a stated unknown.
 * @param {(args: string[]) => string} run @param {string} repo
 * @param {{ root?: string, read?: (path: string) => string, now?: number }} [io]
 * @returns {ClassRepeatFact}
 */
export function readClassRepeat(run, repo, { root = HOME_CHECKOUT, read = (path) => readFileSync(path, "utf8"), now = Date.now() } = {}) {
  let index;
  try {
    index = parseFailureClasses(read(join(root, FAILURE_CLASSES_PATH)));
  } catch (err) {
    return { unreadable: `${FAILURE_CLASSES_PATH} could not be read (${firstLine(err)})` };
  }
  if (index === null) return { unreadable: `${FAILURE_CLASSES_PATH} is not a failure-class index (no \`classes\` list of entries with an \`id\`)` };
  try {
    const recent = listClosed(run, repo, null);
    if (recent === null) return { unreadable: `the closed rows of ${repo} could not be read as a listing` };
    const byNumber = new Map(recent.map((row) => [row.number, row]));
    const inWindow = recent.filter((row) => row.closedAt !== null && now - row.closedAt <= CLASS_REPEAT_WINDOW_MS);
    const known = new Set(index.map((c) => c.id));
    for (const id of new Set(inWindow.flatMap((row) => row.classes).filter((c) => known.has(c)))) {
      const all = listClosed(run, repo, id);
      if (all === null) return { unreadable: `the closed rows labelled ${CLASS_LABEL_PREFIX}${id} could not be read as a listing` };
      for (const row of all) byNumber.set(row.number, row);
    }
    return { index, rows: [...byNumber.values()] };
  } catch (err) {
    return { unreadable: `the closed rows of ${repo} could not be read (${firstLine(err)})` };
  }
}

/**
 * @typedef {{ id: string, entry: FailureClass | null, rows: ClassRow[] }} ClassGroup `rows` newest first (by close time, then by number); `entry` is `null` for a label naming no class
 */

/**
 * EVERY CLASS ID THE ROWS NAME, with its rows newest first. One row under two classes is an instance of each. Membership is the label and nothing else.
 * @param {FailureClass[]} index @param {ClassRow[]} rows @returns {ClassGroup[]}
 */
export function groupByClass(index, rows) {
  /** @type {Map<string, ClassRow[]>} */
  const byId = new Map();
  for (const row of rows) for (const id of new Set(row.classes)) byId.set(id, [...(byId.get(id) ?? []), row]);
  const newestFirst = (/** @type {ClassRow} */ a, /** @type {ClassRow} */ b) => ((b.closedAt ?? 0) - (a.closedAt ?? 0)) || b.number - a.number;
  return [...byId].map(([id, group]) => ({ id, entry: index.find((c) => c.id === id) ?? null, rows: [...group].sort(newestFirst) }));
}
