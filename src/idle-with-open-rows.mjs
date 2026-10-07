// IDLE IS A SIGNAL (#3943): no engineer holds a row, and open rows exist that are not waiting on a date. A PURE LEAF over rows the tick already read: it
// makes no call, so `org-health.mjs` can import it and the test can hand it fixtures. WHAT COUNTS AS A REASON is each row's own declared field, read by
// the readers the gate reads them with (`waitingOn`, `parseWaits`, `STATE_LABELS`), never by a second regex of this file's own.
import { CLAIM_LABEL, STATE_LABELS } from "./claim-labels.mjs";
import { SESSION_PREFIX, LANE_PREFIX } from "./project-vocabulary.mjs";
import { waitingOn } from "./waiting-condition.mjs";
import { parseWaits } from "./wait-condition.mjs";

/**
 * THE CLOSED LIST OF REASONS A ROW IS NOT BEING BUILT. Every one but `READY_UNOFFERED` is a STATE the org chose and says on the row; that one is the claim
 * that the gate's own offer is wrong (a ready row nothing explains while nobody works), the only reason that is a defect. `SHELVED` and `BLOCKED_LABEL`
 * are the two the row's text did not list: the gate shelves a ready row for a template gap or a branch already on `origin` (`partitionUnclaimed`'s
 * `blocked`), and the `blocked` state label has no referent a reader can follow. Each would otherwise have been `READY_UNOFFERED`, which is false.
 */
export const IDLE_REASONS = Object.freeze({
  NO_STATE_LABEL: "NO_STATE_LABEL", TWO_STATE_LABELS: "TWO_STATE_LABELS", BACKLOG: "BACKLOG", PARKED: "PARKED", EPIC: "EPIC",
  BLOCKED_LABEL: "BLOCKED_LABEL", BLOCKED_BY: "BLOCKED_BY", WAITING_FOR: "WAITING_FOR", ANSWER_OWED: "ANSWER_OWED", LANE: "LANE",
  B4_OVERLAPS: "B4 overlaps", SHELVED: "SHELVED", READY_UNOFFERED: "READY_UNOFFERED",
});

/** The state labels that are themselves the reason, each to the reason it names. */
const REASON_OF_STATE = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
  backlog: IDLE_REASONS.BACKLOG, parked: IDLE_REASONS.PARKED, epic: IDLE_REASONS.EPIC, blocked: IDLE_REASONS.BLOCKED_LABEL,
}));

/**
 * @typedef {{ number: number, state?: string, body?: string, labels?: (string | { name?: string })[], blockedBy?: { nodes?: { number?: number, state?: string }[] } }} OpenRow
 * @typedef {{ number: number, reason: string, kind: string }} IdleFinding `kind` is the closed key and `reason` its printed form, with the thing it names (`BLOCKED_BY #3920`)
 * @typedef {{ kind: "idle", findings: IdleFinding[], dateHeld: number } | { kind: "unread", why: string } | null} IdleRows
 */

const names = (/** @type {OpenRow} */ row) => (row.labels ?? []).map((l) => (typeof l === "string" ? l : String(l?.name)));

/**
 * IS THIS OPEN ROW HELD BY AN ENGINEER? A `session:<engineer>` label, or a claim (`in-progress`) that names NO session at all: an unnamed holder is not
 * proof of an idle org, so it counts as held and the signal stays quiet (absence is not proof). A claim whose session label names a seat that is NOT an
 * engineer (`orchestrator` holding a lab row) is a lead's and does not count.
 * @param {OpenRow} row @param {ReadonlySet<string>} engineers
 */
function heldByEngineer(row, engineers) {
  const sessions = names(row).filter((l) => l.startsWith(SESSION_PREFIX)).map((l) => l.slice(SESSION_PREFIX.length));
  if (sessions.some((s) => engineers.has(s))) return true;
  return names(row).includes(CLAIM_LABEL) && sessions.length === 0;
}

/**
 * The first date-held reading of a row: `Not-before:` in the future, by `waitingOn`'s own reader. `blockedBy` is stripped so a row that is ALSO blocked
 * still reads its date, which is the more specific wait and the one that clears by itself.
 * @param {OpenRow} row @param {number} now
 */
function isDateHeld(row, now) {
  const { blockedBy: _blockedBy, ...rest } = row;
  const today = new Date(now).toISOString().slice(0, 10);
  return waitingOn(rest, today, now)?.kind === "date";
}

/**
 * THE REASON ONE NOT-DATE-HELD ROW IS NOT BEING BUILT. THE ORDER IS THE DESIGN: the row's state label first (a `backlog` row is not offered for being
 * `backlog`, whatever else it also carries), then what the row DECLARES (an edge, an answer owed, a `Waiting-for:`, a lane), then what the gate
 * decided about it (`shelved`), and only a ready row none of those explains is `READY_UNOFFERED`.
 * @param {OpenRow} row @param {{ now: number, engineers: ReadonlySet<string>, shelved: ReadonlyMap<number, string> }} ctx
 * @returns {{ kind: string, reason: string }}
 */
function reasonOf(row, { now, engineers, shelved }) {
  const labels = names(row);
  const held = STATE_LABELS.filter((s) => labels.includes(s));
  if (held.length === 0) return { kind: IDLE_REASONS.NO_STATE_LABEL, reason: IDLE_REASONS.NO_STATE_LABEL };
  if (held.length > 1) return { kind: IDLE_REASONS.TWO_STATE_LABELS, reason: `${IDLE_REASONS.TWO_STATE_LABELS} ${held.join("+")}` };
  const state = REASON_OF_STATE[held[0]];
  if (state !== undefined) return { kind: state, reason: state };
  return declaredReasonOf(row, { now, engineers, shelved, labels });
}

/**
 * The reasons a `ready` row can carry, in the order they are read. `waitingOn`'s answer is read once: its `row` kind is the native `blockedBy` edge (open
 * blockers only), its `answer` kind the `answer:<session>` label. A `Waiting-for:` is reported by its TEXT and not evaluated: whether its condition has
 * come true is `stale-wait`'s question, which needs reads this signal must not add.
 * @param {OpenRow} row @param {{ now: number, engineers: ReadonlySet<string>, shelved: ReadonlyMap<number, string>, labels: string[] }} ctx
 * @returns {{ kind: string, reason: string }}
 */
function declaredReasonOf(row, { now, engineers, shelved, labels }) {
  const waiting = waitingOn(row, new Date(now).toISOString().slice(0, 10), now);
  if (waiting?.kind === "row") return { kind: IDLE_REASONS.BLOCKED_BY, reason: `${IDLE_REASONS.BLOCKED_BY} ${waiting.numbers.map((n) => `#${n}`).join(",")}` };
  if (waiting?.kind === "answer") return { kind: IDLE_REASONS.ANSWER_OWED, reason: `${IDLE_REASONS.ANSWER_OWED} ${waiting.session}` };
  const [wait] = parseWaits(row.body);
  if (wait !== undefined) return { kind: IDLE_REASONS.WAITING_FOR, reason: `${IDLE_REASONS.WAITING_FOR} ${wait.text}` };
  const owner = labels.filter((l) => l.startsWith(LANE_PREFIX)).map((l) => l.slice(LANE_PREFIX.length))
    .find((o) => o !== "any" && !engineers.has(o));
  if (owner !== undefined) return { kind: IDLE_REASONS.LANE, reason: `${IDLE_REASONS.LANE} ${owner}` };
  const gate = shelved.get(row.number);
  if (gate !== undefined) return gateReasonOf(gate);
  return { kind: IDLE_REASONS.READY_UNOFFERED, reason: IDLE_REASONS.READY_UNOFFERED };
}

/**
 * The gate's own shelving text, said by kind. A B4 overlap names the pull request or row it overlaps (`overlaps #3920, which ...`); any other shelving
 * (a template gap, a branch on `origin`) is `SHELVED` with its text cut to one clause.
 * @param {string} text
 */
function gateReasonOf(text) {
  const overlap = /^overlaps (?:the Region of )?(\S*#\d+)/.exec(text);
  if (overlap) return { kind: IDLE_REASONS.B4_OVERLAPS, reason: `${IDLE_REASONS.B4_OVERLAPS} ${overlap[1]}` };
  return { kind: IDLE_REASONS.SHELVED, reason: `${IDLE_REASONS.SHELVED} ${text.split(" -- ")[0].slice(0, SHELVED_TEXT_CHARS)}` };
}
const SHELVED_TEXT_CHARS = 100;

/**
 * IS THE ORG IDLE WHILE WORK IS OPEN, AND WHY IS EACH ROW NOT BEING BUILT? `null` when any engineer holds a row. Otherwise `{ kind: "idle", findings, dateHeld }`:
 * one finding per open row that is NOT date-held and NOT claimed (a claimed row is somebody's, not stock), and `dateHeld` the rows waiting correctly,
 * counted and never named. `findings` may be empty (an idle org with nothing open is FINISHED, not stalled; the caller reads it clear). A refused read is
 * `{ kind: "unread" }` and never an idle org: `openRows: null` or `engineers: null` is a read that did not return.
 * `shelved` is `partitionUnclaimed(...).blocked`'s `number -> reason`, which the tick already computed: no call is made here.
 * @param {{ now: number, engineers: readonly string[] | null, openRows: OpenRow[] | null, shelved?: ReadonlyMap<number, string> }} input
 * @returns {IdleRows}
 */
export function idleWithOpenRowsReading({ now, engineers, openRows, shelved = new Map() }) {
  if (openRows === null) return { kind: "unread", why: "the open rows could not be read, so an idle org cannot be told from a refused read" };
  if (engineers === null) return { kind: "unread", why: "the roster of engineer seats could not be read, so no row is known to be held by one" };
  const seats = new Set(engineers);
  const open = openRows.filter((row) => row.state !== "CLOSED");
  if (open.some((row) => heldByEngineer(row, seats))) return null;
  const stock = open.filter((row) => !names(row).includes(CLAIM_LABEL));
  const dateHeld = stock.filter((row) => isDateHeld(row, now));
  const findings = stock.filter((row) => !dateHeld.includes(row))
    .map((row) => ({ number: row.number, ...reasonOf(row, { now, engineers: seats, shelved }) }))
    .sort((a, b) => a.number - b.number);
  return { kind: "idle", findings, dateHeld: dateHeld.length };
}

/**
 * THE ONE LINE, grouped by reason with counts first (`31 unoffered (8 date-held): 16 BACKLOG, 5 PARKED | BACKLOG #1 #2 ...; PARKED #3`), so the reader sees the
 * shape before the numbers. `READY_UNOFFERED` is put FIRST in the detail, being the only reason that is a defect.
 * @param {IdleFinding[]} findings @param {number} dateHeld
 */
export function idleLine(findings, dateHeld) {
  const groups = new Map();
  for (const f of findings) groups.set(f.kind, [...(groups.get(f.kind) ?? []), f]);
  const ordered = [...groups.entries()].sort(([a, x], [b, y]) =>
    Number(b === IDLE_REASONS.READY_UNOFFERED) - Number(a === IDLE_REASONS.READY_UNOFFERED) || y.length - x.length || a.localeCompare(b));
  const counts = ordered.map(([kind, rows]) => `${rows.length} ${kind}`).join(", ");
  const detail = ordered.map(([, rows]) => rows.map((f) => `${f.reason} #${f.number}`).join("; ")).join("; ");
  return `${findings.length} unoffered${dateHeld > 0 ? ` (${dateHeld} date-held, not counted)` : ""}: ${counts} | ${detail}`;
}
