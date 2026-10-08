// @ts-check
// read the board against reality and name every open row whose state disagrees with it (a11ign/a11ign#4043)
// THE BOARD IS TRUSTED ONLY IF SOMETHING CHECKS IT EVERY DAY (the chairman, 2026-10-08, point 4). Point 3 was a one-off audit by
// `product-manager`, a reading at a moment; this is the standing form. It finds the rows the chairman found by hand: #2899, an epic
// whose 13 children were all closed and which stayed open, and #3425, a `ready` row carrying `no-code-left`, a label that only a
// claimed row has.
//
// SIX QUESTIONS, EACH A PURE FUNCTION OF ROWS THE CALLER ALREADY READ, so the rule is testable without a tracker and the reader that
// fetches them (`readBoardFacts`, below) is the only part that spends a call:
//   epic-all-closed       an open `epic` whose sub-issues are all closed                      -> product-manager (close it)
//   closing-pr-merged     an open row a merged PR names in `Closes #n`                        -> product-manager (close it)
//   no-live-claimant      `in-progress` with no live `session:` holder and no fresh claim record, or a claim-only label
//                         (`started`, `session:*`, `no-code-left`) on a row that is not `in-progress`          -> the row's owner
//   wait-already-true     a `parked`/`backlog` row whose `Waiting-for:`/`Not-before:` is already true -> product-manager (lift it)
//   state-label           no state label, or two (`stateLabelFindings`, the leaf the tick reads too)  -> product-manager
//                         a row younger than the filing grace is not judged (#4048) and is COUNTED, `N filing, not judged`
//   duplicate-or-superseded  a near-duplicate title of another row, or `Superseded by #n` with #n closed completed -> the row's owner
//
// ABSENCE IS NOT PROOF: a fact that could not be read is `null`, and its question is listed as UNREAD, never counted as agreeing. The
// table says `0 disagree` only for a board every question read and found true, so silence cannot be read as health.
//
// THE TICK SUPPLIES IT (#4045): `work-gate/org-health.mjs` passes `boardTruth` to `org-health` from the rows the tick already read, and `postDaysTable` (below) comments
// the day's table on #928 once per edition day.
// A LEAF, as `org-health.mjs` (which imports it) is: relative imports of leaves only, never `close-rows-for-merged-pr.mjs`, `row-claim.mjs` or anything that reaches `wake.mjs`.
import { execFileSync } from "node:child_process";
import { STATE_LABELS, CLAIM_LABEL, CLAIM_RECORD_MARKER, STARTED_LABEL, stateLabelFindings, rowsBeingFiled } from "./claim-labels.mjs";
import { conditionHolds, declaredWaitsOf, waitItemOf } from "./wait-condition.mjs";
import { notBeforeDate, notBeforeIso } from "./waiting-condition.mjs";
import { BACKLOG_LABEL, LANE_ANY_LABEL, LANE_PREFIX, SESSION_PREFIX } from "./project-vocabulary.mjs";
import { readAgents, listingIsComplete } from "./herdr-agents.mjs";

export const QUESTIONS = Object.freeze({
  EPIC_DONE: "epic-all-closed",
  CLOSER_MERGED: "closing-pr-merged",
  NO_CLAIMANT: "no-live-claimant",
  WAIT_TRUE: "wait-already-true",
  STATE_LABEL: "state-label",
  DUPLICATE: "duplicate-or-superseded",
});

export const NO_CODE_LEFT_LABEL = "no-code-left";
/** Labels only a claimed row has: `started`, `session:*` (the strip list of `claim-label-strip.mjs`) and the holder's `no-code-left`. */
const CLAIM_ONLY = (/** @type {string} */ label) => label === STARTED_LABEL || label === NO_CODE_LEFT_LABEL || label.startsWith(SESSION_PREFIX);

/** A claim record newer than this keeps a row claimed: the claim-stall's untold-release bound (4 h), pinned equal by the test. */
export const CLAIM_FRESH_MS = 240 * 60 * 1000;
/** Title words in common, over all words, at or above which two rows are the same row; and the fewest words a title needs to say so. */
const DUPLICATE_SIMILARITY = 0.8;
const DUPLICATE_MIN_WORDS = 6;
const PARKED_STATES = Object.freeze(["parked", BACKLOG_LABEL]);
const PRODUCT_MANAGER = "product-manager";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{ number: number, title?: string, body?: string, state?: string, stateReason?: string, labels?: (string | { name?: string })[],
 *             comments?: { body?: string, createdAt?: string }[], subIssuesSummary?: { total: number, completed: number } | null, createdAt?: string }} BoardRow
 * @typedef {{ number: number, body?: string }} MergedPr
 * @typedef {{ now: number, openRows: BoardRow[], closedRows: BoardRow[] | null, mergedPrs: MergedPr[] | null, liveSessions: string[] | null,
 *             waitFacts: import("./wait-condition.mjs").WaitFacts | null }} BoardFacts
 * @typedef {{ question: string, number: number, field: string, detail: string, route: string }} Finding
 */

/** @param {BoardRow} row @returns {string[]} */
const labelsOf = (row) => (row.labels ?? []).map((l) => (typeof l === "string" ? l : String(l?.name)));

/** The session that must act on a row the gate cannot fix with a field: its holder, else its lane owner, else `product-manager`. @param {BoardRow} row */
function ownerOf(row) {
  const labels = labelsOf(row);
  const holder = labels.find((l) => l.startsWith(SESSION_PREFIX));
  if (holder) return holder.slice(SESSION_PREFIX.length);
  const lane = labels.find((l) => l.startsWith(LANE_PREFIX) && l !== LANE_ANY_LABEL);
  return lane ? lane.slice(LANE_PREFIX.length) : PRODUCT_MANAGER;
}

/** @param {BoardRow} row @param {string} question @param {string} field @param {string} detail @param {string} [route] @returns {Finding} */
const finding = (row, question, field, detail, route = PRODUCT_MANAGER) => ({ question, number: row.number, field, detail, route });

/** @param {BoardFacts} facts @returns {Finding[]} */
function epicsDone({ openRows }) {
  return openRows.filter((row) => labelsOf(row).includes("epic") && (row.subIssuesSummary?.total ?? 0) > 0
    && row.subIssuesSummary?.completed === row.subIssuesSummary?.total).map((row) => finding(row, QUESTIONS.EPIC_DONE, "state (open)",
    `an epic whose ${row.subIssuesSummary?.completed} of ${row.subIssuesSummary?.total} children are closed`));
}

/**
 * THE ROWS A PULL REQUEST BODY CLOSES: `close-rows-for-merged-pr.mjs`'s `declaredRowsFromBody`, COPIED because that module's graph reaches `wake.mjs`, which imports
 * `org-health.mjs`, which imports this: a cycle that left 51 test files unable to load (`Cannot access 'ORDER_STALL_MINUTES' before initialization`). The test pins the
 * two equal on the same fixtures. @param {string | null | undefined} body @returns {number[]}
 */
export function closesOf(body) {
  const numbers = (body ?? "").split(/\r?\n/).flatMap((line) => {
    const match = /^\s*closes:?\s*(#\d+(?:\s*(?:,|and)\s*#\d+)*)(.*)$/i.exec(line);
    if (!match || /^\s*(?:,|and)\s*[A-Za-z0-9_./-]*#/i.test(match[2])) return [];
    return [...match[1].matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  });
  return [...new Set(numbers)];
}

/** @param {BoardFacts} facts @returns {Finding[]} */
function closersMerged({ openRows, mergedPrs }) {
  const closedBy = new Map((mergedPrs ?? []).flatMap((pr) => closesOf(pr.body).map((n) => [n, pr.number])));
  return openRows.filter((row) => closedBy.has(row.number)).map((row) => finding(row, QUESTIONS.CLOSER_MERGED, "state (open)",
    `merged PR #${closedBy.get(row.number)} says \`Closes #${row.number}\``));
}

/** @param {BoardRow} row @returns {number | null} the newest claim record's time, epoch ms */
function newestClaimRecord(row) {
  const times = (row.comments ?? []).filter((c) => String(c.body ?? "").includes(CLAIM_RECORD_MARKER)).map((c) => Date.parse(c.createdAt ?? ""));
  const known = times.filter(Number.isFinite);
  return known.length === 0 ? null : Math.max(...known);
}

/** @param {BoardRow} row @param {BoardFacts} facts @returns {Finding[]} */
function claimantOf(row, { now, liveSessions }) {
  const labels = labelsOf(row);
  if (!labels.includes(CLAIM_LABEL)) {
    const stray = labels.filter(CLAIM_ONLY);
    return stray.length === 0 ? [] : [finding(row, QUESTIONS.NO_CLAIMANT, `label ${stray.map((l) => `\`${l}\``).join(", ")}`,
      `${stray.join(", ")} on a row that is not \`${CLAIM_LABEL}\`: a claim's leftover`, ownerOf(row))];
  }
  if (liveSessions === null) return [];
  const holders = labels.filter((l) => l.startsWith(SESSION_PREFIX)).map((l) => l.slice(SESSION_PREFIX.length));
  const recordAt = newestClaimRecord(row);
  if (holders.some((h) => liveSessions.includes(h)) || (recordAt !== null && now - recordAt < CLAIM_FRESH_MS)) return [];
  return [finding(row, QUESTIONS.NO_CLAIMANT, `label \`${CLAIM_LABEL}\``,
    `claimed by ${holders.length === 0 ? `no \`${SESSION_PREFIX}\` label` : holders.join(", ")}, not live, and no claim record inside ${CLAIM_FRESH_MS / 60000} min`, ownerOf(row))];
}

/** @param {BoardFacts} facts @returns {Finding[]} */
function noClaimants(facts) {
  return facts.openRows.flatMap((row) => claimantOf(row, facts));
}

/** @param {BoardRow} row @param {BoardFacts} facts @returns {Finding[]} */
function waitsTrueOf(row, { now, waitFacts }) {
  if (!labelsOf(row).some((l) => PARKED_STATES.includes(l))) return [];
  const notBefore = notBeforeDate(row.body);
  const passed = notBefore !== null && Date.parse(notBeforeIso(notBefore)) <= now ? [finding(row, QUESTIONS.WAIT_TRUE, `\`Not-before: ${notBefore}\` line`, `the date has passed, so the row waits on nothing`)] : [];
  const items = waitItemOf({ ...row, labels: labelsOf(row) }, "row");
  const true_ = waitFacts === null ? [] : declaredWaitsOf(items).waits.filter((w) => conditionHolds(w, waitFacts) === true)
    .map((w) => finding(row, QUESTIONS.WAIT_TRUE, `\`Waiting-for: ${w.text}\` line`, `the condition is already true, so the row waits on nothing`));
  return [...passed, ...true_];
}

/** @param {BoardFacts} facts @returns {Finding[]} */
function waitsTrue(facts) {
  return facts.openRows.flatMap((row) => waitsTrueOf(row, facts));
}

/** @param {BoardFacts} facts @returns {Finding[]} */
function stateLabels({ openRows, now }) {
  const byNumber = new Map(openRows.map((row) => [row.number, row]));
  return stateLabelFindings(openRows, { now }).map((f) => finding(/** @type {BoardRow} */ (byNumber.get(f.number)), QUESTIONS.STATE_LABEL, "labels",
    f.kind === "NONE" ? `carries none of ${STATE_LABELS.join(", ")}` : `carries ${f.labels.join(" and ")}: keep the one that is true`));
}

/** @param {string | undefined} title @returns {Set<string>} */
const wordsOf = (title) => new Set(String(title ?? "").toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []);

/** @param {Set<string>} a @param {Set<string>} b @returns {number} words in common over all words */
function similarity(a, b) {
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / (a.size + b.size - shared);
}

/** @param {BoardRow} row @param {BoardRow} other @returns {boolean} */
function nearDuplicates(row, other) {
  const [a, b] = [wordsOf(row.title), wordsOf(other.title)];
  return a.size >= DUPLICATE_MIN_WORDS && b.size >= DUPLICATE_MIN_WORDS && similarity(a, b) >= DUPLICATE_SIMILARITY;
}

/** @param {BoardRow} row @param {Map<number, BoardRow>} known @returns {Finding[]} */
function supersededOf(row, known) {
  const named = /^\s*Superseded by\s+#(\d+)/im.exec(row.body ?? "");
  const by = named ? known.get(Number(named[1])) : undefined;
  if (!by || by.state !== "CLOSED" || String(by.stateReason ?? "").toUpperCase() !== "COMPLETED") return [];
  return [finding(row, QUESTIONS.DUPLICATE, "state (open)", `\`Superseded by #${by.number}\`, and #${by.number} is closed completed`, ownerOf(row))];
}

/** @param {BoardRow} row @param {BoardRow[]} others @returns {Finding[]} */
function duplicateOf(row, others) {
  const twin = others.find((other) => other.number !== row.number && (other.state === "CLOSED" || other.number < row.number) && nearDuplicates(row, other));
  return twin ? [finding(row, QUESTIONS.DUPLICATE, "state (open)", `title is a near-duplicate of ${twin.state === "CLOSED" ? "closed" : "open"} #${twin.number}`, ownerOf(row))] : [];
}

/** @param {BoardFacts} facts @returns {Finding[]} */
function duplicates({ openRows, closedRows }) {
  const all = [...openRows, ...(closedRows ?? [])];
  const known = new Map(all.map((row) => [row.number, row]));
  return openRows.flatMap((row) => [...(closedRows === null ? [] : supersededOf(row, known)), ...duplicateOf(row, all)]);
}

/** The questions and the fact each needs that may be unread, `null`. @type {[string, (f: BoardFacts) => Finding[], (f: BoardFacts) => boolean][]} */
const READERS = [
  [QUESTIONS.EPIC_DONE, epicsDone, () => true],
  [QUESTIONS.CLOSER_MERGED, closersMerged, (f) => f.mergedPrs !== null],
  [QUESTIONS.NO_CLAIMANT, noClaimants, (f) => f.liveSessions !== null],
  [QUESTIONS.WAIT_TRUE, waitsTrue, (f) => f.waitFacts !== null],
  [QUESTIONS.STATE_LABEL, stateLabels, () => true],
  [QUESTIONS.DUPLICATE, duplicates, (f) => f.closedRows !== null],
];

/**
 * ASK ALL SIX QUESTIONS. A question whose fact was not read still answers what it can from the rest (a `Not-before` date needs no
 * fact) and is named in `unread`, so the table never states health it did not read.
 * @param {BoardFacts} facts
 * `filing` is how many rows were EXCUSED from the state-label question because they are being filed (#4048), so the table can say it rather than read them as agreeing.
 * @returns {{ findings: Finding[], unread: string[], filing: number }}
 */
export function boardTruthAudit(facts) {
  const findings = READERS.flatMap(([, ask]) => ask(facts)).sort((a, b) => a.number - b.number || a.question.localeCompare(b.question));
  return { findings, unread: READERS.filter(([, , read]) => !read(facts)).map(([question]) => question), filing: rowsBeingFiled(facts.openRows, facts).length };
}

/** The first line of a table, which is what a second tick looks for on #928. @param {string} day */
const tableHeading = (day) => `### Board against reality, ${day}`;

/**
 * THE DAY'S TABLE: the count first, then one line per finding with the field to fix and who reads it. `0 disagree` is stated when it is true.
 * A row EXCUSED as being filed (#4048) is named `N filing, not judged` beside the count: it is neither a disagreement nor an agreement.
 * @param {{ findings: Finding[], unread: string[], filing?: number }} audit @param {string} day `YYYY-MM-DD`
 * @returns {string}
 */
export function boardTruthTable({ findings, unread, filing = 0 }, day) {
  const filingNote = filing === 0 ? "" : `, ${filing} filing, not judged`;
  const unreadNote = unread.length === 0 ? "" : ` -- NOT READ, so not counted as agreeing: ${unread.join(", ")}`;
  const head = [tableHeading(day), "", `**${findings.length} disagree**${filingNote}${unreadNote}`];
  if (findings.length === 0) return head.join("\n");
  const rows = findings.map((f) => `| #${f.number} | ${f.question} | ${f.field} | ${f.detail} | ${f.route} |`);
  return [...head, "", "| row | question | field to fix | what disagrees | to |", "|---|---|---|---|---|", ...rows].join("\n");
}

/** @param {string[]} args @returns {string} gh's stdout */
const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/**
 * THE READS THE SIX QUESTIONS NEED; one that fails is `null` (UNREAD), never an empty list. Live sessions come from `herdr`'s workspace list, and a partial listing is
 * UNREAD too (it would read every holder as gone). Merged PRs are the newest 200 and closed rows the newest 500, which cover a day's closers and the rows a duplicate is
 * likely to repeat. The closed rows ask for no body (2.4 MB of the 2.5 MB the read measured on 2026-10-08, and no question reads it).
 * #4045: THE TICK HANDS ITS OWN READS IN. `openRows` is the open list the gate already holds (so the 1000-row read, comments and all, is not made a second time) and `waitFacts` the
 * facts its wait pass built; a caller that gives neither gets the old behaviour, the open rows read here and the wait facts `null` (unread).
 * @param {string} repo `owner/name`
 * @param {{ run?: (args: string[]) => string, agents?: typeof readAgents, now?: number, openRows?: BoardRow[], waitFacts?: BoardFacts["waitFacts"] }} [io]
 * @returns {BoardFacts} `openRows` is not guarded: a refused open-row read throws, because there is no board to read without it
 */
export function readBoardFacts(repo, { run = gh, agents = readAgents, now = Date.now(), openRows: given, waitFacts = null } = {}) {
  const json = (/** @type {string[]} */ args) => JSON.parse(run([...args, "--repo", repo]));
  const orUnread = (/** @type {string[]} */ args) => { try { return json(args); } catch { return null; } };
  const openRows = given ?? json(["issue", "list", "--state", "open", "--limit", "1000", "--json", "number,title,body,labels,state,comments,subIssuesSummary,createdAt"]);
  const closedRows = orUnread(["issue", "list", "--state", "closed", "--limit", "500", "--json", "number,title,state,stateReason"]);
  const mergedPrs = orUnread(["pr", "list", "--state", "merged", "--limit", "200", "--json", "number,body"]);
  const listed = agents();
  const liveSessions = listed !== null && listingIsComplete(listed) ? listed.map((a) => a.label) : null;
  return { now, openRows, closedRows, mergedPrs, liveSessions, waitFacts };
}

/** The record the day's table is posted on (#4045). A row the org owns, not a pull request: it is `ceo`'s and the chairman's reading place. */
export const TABLE_ROW = "928";
/** Comments on the record from the day before, so the look-back is one page whatever the row's length; the heading carries the exact day. @param {string} day */
const lookBackFrom = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().replace(/\.\d+Z$/, "Z");

/**
 * ONE TABLE PER EDITION DAY ON #928, posted by the tick (#4045). A day is posted once: the record is asked first (a REST `since=` page, so a long row costs one call), and a
 * table whose heading is already there is not posted again, so a restart, a second host or a tick a minute later posts nothing. The ask is the whole state: nothing is
 * kept locally to disagree with the row.
 * ONLY A COMPLETE READING IS POSTED: the day's table cannot be replaced, and a table carrying `NOT READ` at 00:02 because one call was refused would stand for the day. The
 * unread audit is the org-health signal's to say (`unknown`), so it is not posted and the next tick reads again. A failed ask posts nothing for the same reason in the other
 * direction: it could not tell whether the table is there.
 * @param {{ audit: { findings: Finding[], unread: string[] } | null, day: string, repo: string, run?: (args: string[]) => string }} input
 * @returns {"posted" | "already-posted" | "unread" | "no-audit"} what was done; a failed ask or post THROWS, and the caller says so
 */
export function postDaysTable({ audit, day, repo, run = gh }) {
  if (audit === null) return "no-audit";
  if (audit.unread.length > 0) return "unread";
  const path = `repos/${repo}/issues/${TABLE_ROW}/comments?per_page=100&since=${lookBackFrom(day)}`;
  const ids = run(["api", "--paginate", path, "--jq", `.[] | select(.body | startswith("${tableHeading(day)}")) | .id`]).trim();
  if (ids !== "") return "already-posted";
  run(["issue", "comment", TABLE_ROW, "--repo", repo, "--body", `${boardTruthTable(audit, day)}\n\n_Read by the work-gate tick, once per edition day (a11ign/a11ign#4045)._`]);
  return "posted";
}
