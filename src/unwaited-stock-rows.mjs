// @ts-check
// UNWAITED STOCK ROWS: the `backlog` or `parked` rows that nothing will ever move, as a NUMBER in the daily retrospective (#4175, #4055 item 5).
//
// `idle-with-open-rows` (#3943) is clear as soon as ANY engineer holds a row and accepts `BACKLOG` as an explanation, so it cannot see a stock row whose
// wait never existed or ended. `ceo` ruled (#4055, 2026-10-08): a number in the retrospective, not an `org-health` wake, and N is 24 hours.
//
// A ROW IS UNWAITED WHEN ALL OF THESE HOLD, and each is a field a reader can see, never a sentence (`waiting-conditions.md`):
//   - it is open and carries `backlog` or `parked`, and the label was applied MORE THAN 24 HOURS before the reading. The age is the timeline's `labeled`
//     event, not `createdAt` and not `updatedAt`: a comment must not reset it, and a row filed `ready` and parked last week is not new.
//   - no `needs:chairman` or `meta` label (`STANDING_WAIT_LABELS`: a chairman wait the daily reminder moves, and a declared standing row; #4323),
//     no `answer:*` label, no OPEN native `blockedBy` edge (a closed one is a wait that ended), no READABLE `Waiting-for:` line, no `Waits-on-done-when:`
//     line, and no `Not-before:` still in the future (a past one is a wait that ended). `waitingOn` and `parseWaits` ARE those readers; nothing here re-spells them.
//   - A `Waiting-for:` line is readable when `parseWaits` gives it a state other than `unreadable` (`manual` is one: a wait said out loud). A row parked on a
//     SENTENCE ("ceo's dispatched run ... ends") has a field no one can ever clear, so it is counted, and `unwaitedLines` names it `unreadable wait` so the
//     reader knows which sentence to turn into a field (#4237; #4090 sat ten hours on one). A real wait beside the sentence still moves the row.
//
// A READ THE TOOL COULD NOT MAKE IS `unknown`, NEVER 0 (`org-retro.mjs`'s header, #1286). A refused list, a missing edge field or a refused timeline makes the
// whole reading `unknown` and NAMES the read; it does not drop the row, because a dropped row is the org's idleness reported as health by an absence.
//
// A LEAF: relative imports of leaves only, like `org-retro.mjs`, which imports it and runs before any install.
import { execFileSync } from "node:child_process";
import { waitingOn } from "./waiting-condition.mjs";
import { parseWaits, namedDoneWhens } from "./wait-condition.mjs";
import { BACKLOG_LABEL, NEEDS_CHAIRMAN_LABEL } from "./project-vocabulary.mjs";

/** The `parked` state label; `project-vocabulary.mjs` declares `backlog` and `work-gate.mjs` (not a leaf) the other. */
const PARKED_LABEL = "parked";
const STOCK_LABELS = [BACKLOG_LABEL, PARKED_LABEL];

/**
 * LABELS THAT ARE THEIR OWN WAIT (#4323). `needs:chairman` is a wait that moves the row (`chairman-blocked` wakes `ceo` about it every UTC day); `meta` declares a
 * standing row (the daily board report's issue) that has no condition to wait for and must stay `backlog` for the state-label audit. The exemption is the label a
 * row carries, never a number list, so a new standing row needs no code change. Before it, the count had a floor of 2 and a genuinely forgotten third row hid.
 */
const STANDING_WAIT_LABELS = [NEEDS_CHAIRMAN_LABEL, "meta"];

/** How long a stock label may stand before a row with no wait is called unwaited (`ceo`, #4055 item 5). */
export const UNWAITED_AFTER_MS = 24 * 60 * 60 * 1000;

/** More open rows than this and the list may be truncated, which is a read the tool could not complete. */
export const ROW_LIST_LIMIT = 500;
const READ_TIMEOUT_MS = 90 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * @typedef {{ number: number, title?: string, body?: string, labels?: ({ name?: string } | string)[],
 *   blockedBy?: { nodes?: { number?: number, state?: string }[] } | null }} StockRow an open issue as `gh issue list --json number,title,body,labels,blockedBy` returns it
 * @typedef {{ event?: string, created_at?: string, label?: { name?: string } | null }} TimelineEvent one raw timeline entry; only `labeled` ones are read
 * @typedef {{ listRows: () => StockRow[], timeline: (number: number) => TimelineEvent[] }} TrackerReader THE SEAM: each member THROWS for a refused read
 * @typedef {{ number: number, title: string, state: string, since: number, unreadableWait: boolean }} UnwaitedRow `since` is when the stock label was applied;
 *   `unreadableWait` is whether a `Waiting-for:` line outside the grammar is what the row is parked on
 * @typedef {{ status: "read", count: number, rows: UnwaitedRow[] } | { status: "unknown", reads: string[] }} UnwaitedStock
 */

const labelNames = (/** @type {StockRow} */ row) => (row.labels ?? []).map((l) => (typeof l === "string" ? l : String(l?.name)));

/**
 * Whether anything declares a wait that can end, or the row is a standing one. `waitingOn` is the reader for an OPEN `blockedBy` edge, a FUTURE `Not-before:` (a past one is none) and an
 * `answer:*` label; the two lines are `parseWaits`'s `Waiting-for:` and `namedDoneWhens`'s `Waits-on-done-when:`, both read outside code fences. An
 * `unreadable` `Waiting-for:` is `parseWaits` KEEPING a sentence as a wait that says nothing, so it is not one here (#4237).
 * @param {StockRow} row @param {number} now @returns {boolean}
 */
function waits(row, now) {
  return labelNames(row).some((l) => STANDING_WAIT_LABELS.includes(l))
    || waitingOn({ ...row, blockedBy: row.blockedBy ?? undefined }, new Date(now).toISOString().slice(0, 10), now) !== null
    || parseWaits(row.body).some((wait) => wait.state !== "unreadable")
    || namedDoneWhens(String(row.body ?? "")).length > 0;
}

/** @param {StockRow} row @returns {boolean} the row carries a `Waiting-for:` line outside the grammar; only asked of a row that `waits` found no wait for */
const hasUnreadableWait = (row) => parseWaits(row.body).some((wait) => wait.state === "unreadable");

/**
 * WHEN THE ROW'S STOCK LABEL WAS APPLIED: the newest `labeled` event among the stock labels it still carries, so a row that left `backlog` and came back
 * is aged from the return. `null` when the timeline holds no such event (absence is not proof, so the caller says `unknown`, not "old").
 * @param {StockRow} row @param {TimelineEvent[]} events @returns {number | null}
 */
function stockLabelledAt(row, events) {
  const carried = labelNames(row).filter((l) => STOCK_LABELS.includes(l));
  const times = events
    .filter((e) => e.event === "labeled" && carried.includes(String(e.label?.name)))
    .map((e) => Date.parse(String(e.created_at)))
    .filter(Number.isFinite);
  return times.length === 0 ? null : Math.max(...times);
}

/** @param {unknown} err @returns {string} the first line, so a refusal is named and a stack is not printed */
const firstLine = (err) => String(/** @type {any} */ (err)?.message ?? err).split("\n")[0];

/**
 * Every unwaited stock row at `now`, or `unknown` naming each read that was refused. The cheap waits are asked first, so a timeline is read only for a
 * row nothing else explains.
 * @param {{ reader: TrackerReader, now: number }} input
 * @returns {UnwaitedStock}
 */
export function unwaitedStockRows({ reader, now }) {
  /** @type {StockRow[]} */
  let listed;
  try {
    listed = reader.listRows();
  } catch (err) {
    return { status: "unknown", reads: [`the open-row list (${firstLine(err)})`] };
  }
  if (listed.length >= ROW_LIST_LIMIT) return { status: "unknown", reads: [`the open-row list (${listed.length} rows reached the ${ROW_LIST_LIMIT} limit, so it may be cut short)`] };
  const stock = listed.filter((row) => labelNames(row).some((l) => STOCK_LABELS.includes(l)));
  const unreadEdges = stock.filter((row) => row.blockedBy === undefined || row.blockedBy === null).map((row) => `the blocked-by edges of #${row.number}`);
  if (unreadEdges.length > 0) return { status: "unknown", reads: unreadEdges };
  const candidates = stock.filter((row) => !waits(row, now));
  return ageCandidates({ candidates, reader, now });
}

/**
 * @param {{ candidates: StockRow[], reader: TrackerReader, now: number }} input
 * @returns {UnwaitedStock}
 */
function ageCandidates({ candidates, reader, now }) {
  /** @type {UnwaitedRow[]} */
  const rows = [];
  /** @type {string[]} */
  const refused = [];
  for (const row of candidates) {
    const aged = ageOf(row, reader);
    if (typeof aged === "string") refused.push(aged);
    else if (now - aged > UNWAITED_AFTER_MS) rows.push({ number: row.number, title: String(row.title ?? ""), state: labelNames(row).find((l) => STOCK_LABELS.includes(l)) ?? "", since: aged, unreadableWait: hasUnreadableWait(row) });
  }
  if (refused.length > 0) return { status: "unknown", reads: refused };
  rows.sort((a, b) => a.since - b.since);
  return { status: "read", count: rows.length, rows };
}

/** @param {StockRow} row @param {TrackerReader} reader @returns {number | string} the label's time, or the name of the read that could not be made */
function ageOf(row, reader) {
  try {
    const at = stockLabelledAt(row, reader.timeline(row.number));
    return at === null ? `the timeline of #${row.number} (no \`labeled\` event for its stock label)` : at;
  } catch (err) {
    return `the timeline of #${row.number} (${firstLine(err)})`;
  }
}

/**
 * The printed lines: the number and every row it counts, or the reads that made it unknown.
 * @param {UnwaitedStock | null | undefined} stock `null`/`undefined` is a read nobody made, which is `unknown` too
 * @returns {string[]}
 */
export function unwaitedLines(stock) {
  const label = "Unwaited stock rows (backlog or parked over 24h, no wait that moves them)";
  if (stock === null || stock === undefined) return [`- ${label}: unknown (the tracker was not read)`];
  if (stock.status === "unknown") return [`- ${label}: unknown (could not read ${stock.reads.join("; ")})`];
  if (stock.count === 0) return [`- ${label}: 0`];
  const each = stock.rows.map((r) => `#${r.number} (${r.state} since ${new Date(r.since).toISOString().slice(0, 16)}Z${r.unreadableWait ? ", unreadable wait" : ""})`);
  return [`- ${label}: ${stock.count}: ${each.join("; ")}`];
}

/** @param {string[]} args @returns {string} */
function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"], timeout: READ_TIMEOUT_MS });
}

/**
 * THE REAL READER, for `repo` (the tracker): one issue list carrying the edges, and per candidate row the timeline projected to the three fields read, so a
 * comment's body never crosses the pipe. A failure throws; `unwaitedStockRows` names it.
 * @param {string} repo `owner/name` @param {(args: string[]) => string} [run] @returns {TrackerReader}
 */
export function ghTrackerReader(repo, run = gh) {
  return {
    listRows: () => JSON.parse(run(["issue", "list", "--repo", repo, "--state", "open", "--limit", String(ROW_LIST_LIMIT), "--json", "number,title,body,labels,blockedBy"])),
    timeline: (number) => run(["api", `repos/${repo}/issues/${number}/timeline`, "--paginate", "--jq", ".[] | {event, created_at, label: (.label // null)}"])
      .split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line)),
  };
}
