// @ts-check
// read the board against reality and name every open row whose state disagrees with it (a11ign/a11ign#4043)
// THE BOARD IS TRUSTED ONLY IF SOMETHING CHECKS IT EVERY DAY (the chairman, 2026-10-08, point 4). Point 3 was a one-off audit by
// `product-manager`, a reading at a moment; this is the standing form. It finds the rows the chairman found by hand: #2899, an epic
// whose 13 children were all closed and which stayed open, and #3425, a `ready` row carrying `no-code-left`, a label that only a
// claimed row has.
//
// NINE QUESTIONS, EACH A PURE FUNCTION OF ROWS THE CALLER ALREADY READ, so the rule is testable without a tracker and the reader that
// fetches them (`readBoardFacts`, below) is the only part that spends a call:
//   epic-all-closed       an open `epic` whose sub-issues are all closed                      -> product-manager (close it)
//   closing-pr-merged     an open row a merged PR names in `Closes #n`                        -> product-manager (close it)
//   no-live-claimant      `in-progress` with no live `session:` holder and no fresh claim record, or a claim-only label
//                         (`started`, `session:*`, `no-code-left`) on a row that is not `in-progress`          -> the row's owner
//   wait-already-true     a `parked`/`backlog` row whose `Waiting-for:`/`Not-before:` is already true -> product-manager (lift it)
//   state-label           no state label, or two (`stateLabelFindings`, the leaf the tick reads too)  -> product-manager
//                         a row younger than the filing grace is not judged (#4048) and is COUNTED, `N filing, not judged`
//                         (and `closing-pr-merged` withholds a row whose PR merged inside the merge grace, #4116: `N merging, not judged`)
//   duplicate-or-superseded  a near-duplicate title of another row, or `Superseded by #n` with #n closed completed -> the row's owner
//   parked-without-condition a `parked` row with no `Not-before:`, no `Waiting-for:`, no open `blockedBy` edge and no `answer:<session>`, and not
//                         `needs:chairman` (chairman rule 1, 2026-10-08, #4049)                       -> product-manager (give it one)
//   parked-on-the-chairman   a `parked` row, not `needs:chairman`, with a `Blocked-on:` line naming the chairman, whatever date or condition it also
//                         carries (#4201, class fix A: a wait on the chairman is never a date)         -> product-manager (`needs:chairman` and a brief)
//   roadmap-value         an open row under a roadmap epic (its parent, or its parent's parent, has a `Roadmap` value on a Project the row is boarded to)
//                         whose own value on that Project is absent or another one (a11ign/agent-org#517, chairman on a11ign#928, 2026-10-09, item 3)  -> product-manager (one `gh project item-edit`)
//
// TWO MORE READ THE LAST DAY'S COMMENTS (`PROSE_QUESTIONS`, a11ign/a11ign#4232): a HANDOFF WRITTEN AS A SENTENCE moves nobody, so a comment by an org account that hands off in
// prose (`goes to <session>`, `<session> will file`, `<session> to file`, `for <session> to`, `I will ask <session>`, `Asked of <session>`) is flagged unless the same author filed
// a row or labelled `answer:<session>` within 15 minutes (`handoff-in-prose`), and a READING comment (`reading N of M`, `Ruling`) with no `Defect-row:` line is flagged
// (`reading-without-defect-row`). A plain pattern set, no model; a fenced block is never read. They are kept out of `QUESTIONS` so a caller that does not hand in `proseEvidence` is not asked.
//
// ABSENCE IS NOT PROOF: a fact that could not be read is `null`, and its question is listed as UNREAD, never counted as agreeing. The
// table says `0 disagree` only for a board every question read and found true, so silence cannot be read as health.
//
// THE TICK SUPPLIES IT (#4045): `work-gate/org-health.ts` passes `boardTruth` to `org-health` from the rows the tick already read, and `postDaysTable` (below) comments
// the day's table on #928 once per edition day.
// A LEAF, as `org-health.ts` (which imports it) is: relative imports of leaves only, never `close-rows-for-merged-pr.ts`, `row-claim.ts` or anything that reaches `wake.ts`.
import { execFileSync } from "node:child_process";
import { STATE_LABELS, CLAIM_LABEL, CLAIM_RECORD_MARKER, STARTED_LABEL, stateLabelFindings, rowsBeingFiled } from "./claim-labels.ts";
import { conditionHolds, declaredWaitsOf, waitItemOf } from "./wait-condition.ts";
import { notBeforeDate, notBeforeIso } from "./waiting-condition.ts";
import { ANSWER_PREFIX, BACKLOG_LABEL, LANE_ANY_LABEL, LANE_PREFIX, NEEDS_CHAIRMAN_LABEL, SESSION_PREFIX } from "./project-vocabulary.ts";
import { readAgents, listingIsComplete } from "./herdr-agents.ts";
import { homeProjectDeclaration } from "./project-config.ts";

export const QUESTIONS = Object.freeze({
  EPIC_DONE: "epic-all-closed",
  CLOSER_MERGED: "closing-pr-merged",
  NO_CLAIMANT: "no-live-claimant",
  WAIT_TRUE: "wait-already-true",
  STATE_LABEL: "state-label",
  DUPLICATE: "duplicate-or-superseded",
  PARKED_BARE: "parked-without-condition",
  PARKED_ON_CHAIRMAN: "parked-on-the-chairman",
  ROADMAP: "roadmap-value",
});

/**
 * A row its closing PR merged less than this ago is MERGING, not disagreeing (#4116): GitHub closes the row a second or so after the merge, so a tick that read in that gap
 * raised `closing-pr-merged` four times on 2026-10-08 (#4091/#4092, #4093, #4104, #4102), each waking `product-manager` and `ceo` for a repair the merge had already made. Five
 * minutes, the filing grace's length and for the same reason: longer than the gap, shorter than a tick pair, so a row a merge really failed to close is found by the second tick.
 */
export const MERGE_GRACE_MS = 5 * 60 * 1000;

export const NO_CODE_LEFT_LABEL = "no-code-left";
/** Labels only a claimed row has: `started`, `session:*` (the strip list of `claim-label-strip.ts`) and the holder's `no-code-left`. */
const CLAIM_ONLY = (label: string) => label === STARTED_LABEL || label === NO_CODE_LEFT_LABEL || label.startsWith(SESSION_PREFIX);

/** A claim record newer than this keeps a row claimed: the claim-stall's untold-release bound (4 h), pinned equal by the test. */
export const CLAIM_FRESH_MS = 240 * 60 * 1000;
/** Title words in common, over all words, at or above which two rows are the same row; and the fewest words a title needs to say so. */
export const DUPLICATE_SIMILARITY = 0.8;
const DUPLICATE_MIN_WORDS = 6;
const PARKED_LABEL = "parked";
const PARKED_STATES = Object.freeze([PARKED_LABEL, BACKLOG_LABEL]);
const PRODUCT_MANAGER = "product-manager";
const BLOCKED_ON_LINE = /^[ \t]*Blocked-on:[ \t]*(.*)$/gim;
const CHAIRMAN_WORD = /\bchairman\b/i;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The time an author has to turn a handoff sentence into a row or an `answer:` label (#4232); a comment younger than this is not judged yet. */
export const HANDOFF_GRACE_MS = 15 * 60 * 1000;

export type BoardRow = { number: number, title?: string, body?: string, state?: string, stateReason?: string, labels?: (string | { name?: string })[], comments?: RowComment[], subIssuesSummary?: { total: number, completed: number } | null, createdAt?: string };
/** `mergedAt` is absent when a read omitted it */
export type MergedPr = { number: number, body?: string, mergedAt?: string | null };
/** `others` (#4080) is what each KEYED tracker answered; absent with one declared tracker */
export type BoardFacts = { now: number, openRows: BoardRow[], closedRows: BoardRow[] | null, mergedPrs: MergedPr[] | null, liveSessions: string[] | null, waitFacts: import("./wait-condition.ts").WaitFacts | null, others?: OtherTracker[], proseEvidence?: ProseEvidence | null, roadmaps?: RowRoadmaps | null };
/**
 * One row's `Roadmap` value on one Project it is boarded to (a11ign/agent-org#517). `project` is `owner/number`, so two Projects' values are never mixed: the field is the Project's, and a row
 * boarded to two carries two. `value` is `null` for an item with the field unset.
 */
export type RoadmapItem = { project: string, value: string | null };
/** A row's `Roadmap` items and its parent's, read as far as two levels up (the backfill's depth). `ref` is `owner/name#n`, so a parent in another repository is named whole. */
export type RoadmapNode = { ref: string, items: RoadmapItem[], parent: RoadmapNode | null };
/** by row number; `undefined` on `BoardFacts` is a caller that does not ask, `null` is a read that failed (UNREAD), and a row with no entry was not read */
export type RowRoadmaps = Record<number, RoadmapNode>;
/**
 * `codeRepo` is the code repository of the same key, where the pull requests that close this tracker's rows are
 */
export type DeclaredTracker = { key: string, repo: string, codeRepo?: string };
/** `facts` is `null` when its open rows could not be read, and `why` says what the read said */
export type OtherTracker = { key: string, repo: string, facts: BoardFacts | null, why?: string };
export type RowComment = { author?: { login?: string } | null, body?: string, createdAt?: string, url?: string };
/**
 * the rows filed and the labels added in the last day, by whom and when (#4232); `undefined` on `BoardFacts` is a caller that does not ask, `null` is a read that failed
 */
export type ProseEvidence = { rows: { author: string, createdAt: string, text?: string }[], labelEvents: { number: number, label: string, actor: string, createdAt: string }[] };
/** `key` is the tracker's, absent for the first tracker's own rows (#4080) */
export type Finding = { question: string, number: number, field: string, detail: string, route: string, key?: string };

/** @param {BoardRow} row @returns {string[]} */
const labelsOf = (row: BoardRow): string[] => (row.labels ?? []).map((l) => (typeof l === "string" ? l : String(l?.name)));

/** The session that must act on a row the gate cannot fix with a field: its holder, else its lane owner, else `product-manager`. @param {BoardRow} row */
function ownerOf(row: BoardRow) {
  const labels = labelsOf(row);
  const holder = labels.find((l) => l.startsWith(SESSION_PREFIX));
  if (holder) return holder.slice(SESSION_PREFIX.length);
  const lane = labels.find((l) => l.startsWith(LANE_PREFIX) && l !== LANE_ANY_LABEL);
  return lane ? lane.slice(LANE_PREFIX.length) : PRODUCT_MANAGER;
}

/** @param {BoardRow} row @param {string} question @param {string} field @param {string} detail @param {string} [route] @returns {Finding} */
const finding = (row: BoardRow, question: string, field: string, detail: string, route: string = PRODUCT_MANAGER): Finding => ({ question, number: row.number, field, detail, route });

/** @param {BoardFacts} facts @returns {Finding[]} */
function epicsDone({ openRows }: BoardFacts): Finding[] {
  return openRows.filter((row) => labelsOf(row).includes("epic") && (row.subIssuesSummary?.total ?? 0) > 0
    && row.subIssuesSummary?.completed === row.subIssuesSummary?.total).map((row) => finding(row, QUESTIONS.EPIC_DONE, "state (open)",
    `an epic whose ${row.subIssuesSummary?.completed} of ${row.subIssuesSummary?.total} children are closed`));
}

/**
 * THE ROWS A PULL REQUEST BODY CLOSES: `close-rows-for-merged-pr.ts`'s `declaredRowsFromBody`, COPIED because that module's graph reaches `wake.ts`, which imports
 * `org-health.ts`, which imports this: a cycle that left 51 test files unable to load (`Cannot access 'ORDER_STALL_MINUTES' before initialization`). The test pins the
 * two equal on the same fixtures. @param {string | null | undefined} body @returns {number[]}
 */
export function closesOf(body: string | null | undefined): number[] {
  const numbers = (body ?? "").split(/\r?\n/).flatMap((line) => {
    const match = /^\s*closes:?\s*(#\d+(?:\s*(?:,|and)\s*#\d+)*)(.*)$/i.exec(line);
    if (!match || /^\s*(?:,|and)\s*[A-Za-z0-9_./-]*#/i.test(match[2])) return [];
    return [...match[1].matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  });
  return [...new Set(numbers)];
}

/**
 * ABSENCE IS NOT PROOF: a `mergedAt` that is missing or does not parse is NOT "just merged", so a read that omitted it judges the row and never hides it. The age is read as a
 * distance (as `isBeingFiled` does), so a host clock a few seconds behind GitHub's does not turn a fresh merge into a finding.
 * @param {MergedPr} pr @param {number} now epoch ms
 */
function justMerged(pr: MergedPr, now: number) {
  const merged = Date.parse(pr.mergedAt ?? "");
  return Number.isFinite(merged) && Math.abs(now - merged) < MERGE_GRACE_MS;
}

/** @param {MergedPr[]} prs @returns {Map<number, number>} row number to the PR that says it closes it */
const closersOf = (prs: MergedPr[]): Map<number, number> => new Map(prs.flatMap((pr) => closesOf(pr.body).map((n) => [n, pr.number])));

/**
 * The open rows a merged PR closes, split by how long ago it merged: a row ANY settled PR closes is a disagreement, and one only a just-merged PR closes is `merging`.
 * @param {BoardFacts} facts @returns {{ settled: Map<number, number>, merging: BoardRow[] }}
 */
function mergedClosers({ openRows, mergedPrs, now }: BoardFacts): { settled: Map<number, number>; merging: BoardRow[]; } {
  const prs = mergedPrs ?? [];
  const settled = closersOf(prs.filter((pr) => !justMerged(pr, now)));
  const recent = closersOf(prs.filter((pr) => justMerged(pr, now)));
  return { settled, merging: openRows.filter((row) => !settled.has(row.number) && recent.has(row.number)) };
}

/** @param {BoardFacts} facts @returns {Finding[]} */
function closersMerged(facts: BoardFacts): Finding[] {
  const { settled } = mergedClosers(facts);
  return facts.openRows.filter((row) => settled.has(row.number)).map((row) => finding(row, QUESTIONS.CLOSER_MERGED, "state (open)",
    `merged PR #${settled.get(row.number)} says \`Closes #${row.number}\``));
}

/** @param {BoardRow} row @returns {number | null} the newest claim record's time, epoch ms */
function newestClaimRecord(row: BoardRow): number | null {
  const times = (row.comments ?? []).filter((c) => String(c.body ?? "").includes(CLAIM_RECORD_MARKER)).map((c) => Date.parse(c.createdAt ?? ""));
  const known = times.filter(Number.isFinite);
  return known.length === 0 ? null : Math.max(...known);
}

/** @param {BoardRow} row @param {BoardFacts} facts @returns {Finding[]} */
function claimantOf(row: BoardRow, { now, liveSessions }: BoardFacts): Finding[] {
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
function noClaimants(facts: BoardFacts): Finding[] {
  return facts.openRows.flatMap((row) => claimantOf(row, facts));
}

/** @param {BoardRow} row @param {BoardFacts} facts @returns {Finding[]} */
function waitsTrueOf(row: BoardRow, { now, waitFacts }: BoardFacts): Finding[] {
  if (!labelsOf(row).some((l) => PARKED_STATES.includes(l))) return [];
  const notBefore = notBeforeDate(row.body);
  const passed = notBefore !== null && Date.parse(notBeforeIso(notBefore)) <= now ? [finding(row, QUESTIONS.WAIT_TRUE, `\`Not-before: ${notBefore}\` line`, `the date has passed, so the row waits on nothing`)] : [];
  const items = waitItemOf({ ...row, labels: labelsOf(row) }, "row");
  const true_ = waitFacts === null ? [] : declaredWaitsOf(items).waits.filter((w) => conditionHolds(w, waitFacts) === true)
    .map((w) => finding(row, QUESTIONS.WAIT_TRUE, `\`Waiting-for: ${w.text}\` line`, `the condition is already true, so the row waits on nothing`));
  return [...passed, ...true_];
}

/** @param {BoardFacts} facts @returns {Finding[]} */
function waitsTrue(facts: BoardFacts): Finding[] {
  return facts.openRows.flatMap((row) => waitsTrueOf(row, facts));
}

/** @param {BoardFacts} facts @returns {Finding[]} */
function stateLabels({ openRows, now }: BoardFacts): Finding[] {
  const byNumber = new Map(openRows.map((row) => [row.number, row]));
  return stateLabelFindings(openRows, { now }).map((f) => finding((byNumber.get(f.number) as BoardRow), QUESTIONS.STATE_LABEL, "labels",
    f.kind === "NONE" ? `carries none of ${STATE_LABELS.join(", ")}` : `carries ${f.labels.join(" and ")}: keep the one that is true`));
}

/** @param {string | undefined} title @returns {Set<string>} */
export const wordsOf = (title: string | undefined): Set<string> => new Set(String(title ?? "").toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []);

/** @param {Set<string>} a @param {Set<string>} b @returns {number} words in common over all words */
export function similarity(a: Set<string>, b: Set<string>): number {
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / (a.size + b.size - shared);
}

/** Only the `a11ign/<name>` form is a repository: free prose is not read for one. A trailing `.` is the sentence's, `:` and `,` are not in a name. @param {string | undefined} title @returns {Set<string>} */
const reposNamedBy = (title: string | undefined): Set<string> => new Set([...String(title ?? "").toLowerCase().matchAll(/\ba11ign\/([a-z0-9][a-z0-9._-]*)/g)].map((m) => m[1].replace(/\.+$/, "")));

/**
 * Two titles that each name a repository and name different ones are two rows (#4137: the six per-repository adoption rows of #4127 differ in one word of thirty). A title naming none,
 * or two naming the same set, are compared by words alone: a real twin filed twice under one epic is the case the question exists for.
 * @param {BoardRow} row @param {BoardRow} other @returns {boolean}
 */
export function namesDifferentRepos(row: BoardRow, other: BoardRow): boolean {
  const [a, b] = [reposNamedBy(row.title), reposNamedBy(other.title)];
  return a.size > 0 && b.size > 0 && (a.size !== b.size || [...a].some((name) => !b.has(name)));
}

/** @param {BoardRow} row @param {BoardRow} other @returns {boolean} */
function nearDuplicates(row: BoardRow, other: BoardRow): boolean {
  const [a, b] = [wordsOf(row.title), wordsOf(other.title)];
  return a.size >= DUPLICATE_MIN_WORDS && b.size >= DUPLICATE_MIN_WORDS && similarity(a, b) >= DUPLICATE_SIMILARITY && !namesDifferentRepos(row, other);
}

/** @param {BoardRow} row @param {Map<number, BoardRow>} known @returns {Finding[]} */
function supersededOf(row: BoardRow, known: Map<number, BoardRow>): Finding[] {
  const named = /^\s*Superseded by\s+#(\d+)/im.exec(row.body ?? "");
  const by = named ? known.get(Number(named[1])) : undefined;
  if (!by || by.state !== "CLOSED" || String(by.stateReason ?? "").toUpperCase() !== "COMPLETED") return [];
  return [finding(row, QUESTIONS.DUPLICATE, "state (open)", `\`Superseded by #${by.number}\`, and #${by.number} is closed completed`, ownerOf(row))];
}

/** @param {BoardRow} row @param {BoardRow[]} others @returns {Finding[]} */
function duplicateOf(row: BoardRow, others: BoardRow[]): Finding[] {
  const twin = others.find((other) => other.number < row.number && nearDuplicates(row, other));
  return twin ? [finding(row, QUESTIONS.DUPLICATE, "state (open)", `title is a near-duplicate of ${twin.state === "CLOSED" ? "closed" : "open"} #${twin.number}`, ownerOf(row))] : [];
}

/** @param {BoardFacts} facts @returns {Finding[]} */
function duplicates({ openRows, closedRows }: BoardFacts): Finding[] {
  const all = [...openRows, ...(closedRows ?? [])];
  const known = new Map(all.map((row) => [row.number, row]));
  return openRows.flatMap((row) => [...(closedRows === null ? [] : supersededOf(row, known)), ...duplicateOf(row, all)]);
}

/**
 * RULE 1 (the chairman, 2026-10-08): `parked` REQUIRES A CONDITION THE GATE CAN READ. "Condition" is what the gate means by it: a `Not-before:` line, a `Waiting-for:` line
 * (`declaredWaitsOf`, even one outside the grammar: that is `wait-without-reason`'s defect, not this one), an OPEN native `blockedBy` edge, or an `answer:<session>` label.
 * `needs:chairman` is rule 2's answer (the label plus its brief; whether the brief is well formed is #3409's check). A `backlog` row is not asked: the rule is about `parked`.
 * @param {BoardRow} row @returns {boolean}
 */
function parkedWithoutCondition(row: BoardRow): boolean {
  const labels = labelsOf(row);
  if (!labels.includes(PARKED_LABEL) || labels.includes(NEEDS_CHAIRMAN_LABEL) || labels.some((l) => l.startsWith(ANSWER_PREFIX))) return false;
  const item = waitItemOf({ ...row, labels }, "row");
  return notBeforeDate(row.body) === null && declaredWaitsOf(item).waits.length === 0 && item.openBlockers === 0;
}

/** ABSENCE IS NOT PROOF: a row read without its `blockedBy` edges cannot be called condition-less. @param {BoardRow & { blockedBy?: unknown }} row @returns {boolean} */
const blockersRead = (row: BoardRow & { blockedBy?: unknown; }): boolean => row.blockedBy !== undefined && row.blockedBy !== null;

/** The parked rows that would be findings on the label and the body alone, and need the edge read to be sure. @param {BoardFacts} facts @returns {BoardRow[]} */
const parkedBare = ({ openRows }: BoardFacts): BoardRow[] => openRows.filter(parkedWithoutCondition);

/** @param {BoardFacts} facts @returns {Finding[]} */
function parkedWithoutConditions(facts: BoardFacts): Finding[] {
  return parkedBare(facts).filter(blockersRead).map((row) => finding(row, QUESTIONS.PARKED_BARE, `\`Not-before:\` or \`Waiting-for:\` line`,
    `parked with no \`Not-before:\`, no \`Waiting-for:\`, no open \`blockedBy\` edge and no \`${ANSWER_PREFIX}<session>\`: give it one, or \`${NEEDS_CHAIRMAN_LABEL}\` and a brief`));
}

/**
 * A wait on the chairman is never a date (`ceo`, #4201): #4159 sat `parked` behind `Not-before: 2026-10-15T00:00:00Z` while its `Blocked-on:` line said the chairman's session had to
 * mint a token, and a date does not move the chairman. `parkedWithoutCondition` could not see it, since the date IS a condition; this reads the line that SAYS who the wait is. Only a
 * `Blocked-on:` line counts: `Waiting-for: labelled needs:chairman #3229` is a DATA wait on the chairman's label (#3425), the right form, and `needs:chairman` on the row is the answer.
 * @param {BoardRow} row @returns {boolean}
 */
function parkedOnChairman(row: BoardRow): boolean {
  const labels = labelsOf(row);
  if (!labels.includes(PARKED_LABEL) || labels.includes(NEEDS_CHAIRMAN_LABEL)) return false;
  return [...String(row.body ?? "").matchAll(BLOCKED_ON_LINE)].some((m) => CHAIRMAN_WORD.test(m[1]));
}

/** @param {BoardFacts} facts @returns {Finding[]} */
function parkedOnChairmen({ openRows }: BoardFacts): Finding[] {
  return openRows.filter(parkedOnChairman).map((row) => finding(row, QUESTIONS.PARKED_ON_CHAIRMAN, "`Blocked-on:` line",
    `parked on the chairman: a date does not move the chairman, so give it \`${NEEDS_CHAIRMAN_LABEL}\` and a BRIEF, or a wait the gate can read`));
}

/** The epic whose value a row is held to: its parent's on a Project, else its parent's parent's (two levels, as the backfill was). @param {RoadmapNode} node @param {string} project @returns {{ epic: RoadmapNode, value: string } | null} */
function epicValueOn(node: RoadmapNode, project: string): { epic: RoadmapNode; value: string; } | null {
  for (const epic of [node.parent, node.parent?.parent ?? null]) {
    const value = epic?.items.find((item) => item.project === project)?.value;
    if (epic && value) return { epic, value };
  }
  return null;
}

/**
 * A ROW UNDER A ROADMAP EPIC CARRIES ITS EPIC'S `Roadmap` VALUE (a11ign/agent-org#517). `row-file` enforces it at filing and cannot see a row boarded by hand, linked as a sub-issue afterwards, or
 * whose epic's value changed; this is the net under it. The comparison is PER PROJECT, because the field is the Project's: a row is held to the value its epic has on a Project THE ROW IS BOARDED TO,
 * so an epic that has one on Project 2 and none on Project 1 asks nothing of a row on Project 1 (#517 itself is `Self-healing org` on 2 and unset on 1, with its epic the same). A row boarded to no
 * Project at all, or not to the epic's, has no item to read and is NOT JUDGED here: that is a different disagreement (a row off the board), and calling it a missing value would be a guess.
 * @param {BoardFacts} facts @returns {Finding[]}
 */
function roadmapMismatches({ openRows, roadmaps }: BoardFacts): Finding[] {
  if (!roadmaps) return [];
  return openRows.flatMap((row) => {
    const node = roadmaps[row.number];
    if (!node) return [];
    return node.items.flatMap((item) => {
      const held = epicValueOn(node, item.project);
      if (!held || held.value === item.value) return [];
      const via = held.epic === node.parent ? "" : ` (through ${node.parent?.ref})`;
      const own = item.value === null || item.value === "" ? "no `Roadmap` value" : `\`Roadmap\` \`${item.value}\``;
      return [finding(row, QUESTIONS.ROADMAP, `\`Roadmap\` on project ${item.project}`,
        `${own}, and its epic ${held.epic.ref}${via} has \`${held.value}\`: \`gh project item-edit\` it to \`${held.value}\``)];
    });
  });
}

/** ABSENCE IS NOT PROOF: a row the read has no entry for was not judged, so the question is UNREAD, never "agrees". `undefined` is a caller that does not ask. @param {BoardFacts} facts */
const roadmapsRead = ({ roadmaps, openRows }: BoardFacts): boolean => roadmaps === undefined || (roadmaps !== null && openRows.every((row) => roadmaps[row.number] !== undefined));

export const PROSE_QUESTIONS = Object.freeze({
  HANDOFF: "handoff-in-prose",
  READING_FIELD: "reading-without-defect-row",
});

/** The sessions a sentence can hand off to; a `goes to <word>` that is not one of these is a function or a file, not a handoff. */
const SESSION_NAME = "[`*]*(product-manager|orchestrator|ceo|(?:worker|reviewer|engineer)-\\d+)(?![\\w-])[`*]*";
const HANDOFF_PHRASES = [`goes to ${SESSION_NAME}`, `${SESSION_NAME}\\s+will file`, `${SESSION_NAME}\\s+to file`, `for ${SESSION_NAME}\\s+to\\b`, `I will ask ${SESSION_NAME}`,
  `Asked of ${SESSION_NAME}`].map((source) => new RegExp(source, "i"));
const READING_COMMENT = /\breading \d+ of \d+\b|^\W*ruling\b/im;
const DEFECT_ROW_LINE = /^[ \t]*\**Defect-row\**:[ \t]*(?:#\d+|none[ \t]+(?:--|—)[ \t]*\S)/im;
const ORG_ACCOUNT = /^a11ign-/;
/** A fenced block, closed or running to the end of the comment (markdown's own rule), so a comment that QUOTES a phrase is not one that hands off. */
const FENCED_BLOCK = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm;

/** @param {string} text @returns {string} the text outside its fenced blocks */
const outsideFences = (text: string): string => text.replace(FENCED_BLOCK, "");

/** The session a comment speaks for: its first words name it (`ceo, reading 2 of 2`), else the row's owner reads it. @param {string} body @param {BoardRow} row */
function authorSessionOf(body: string, row: BoardRow) {
  const named = /^\W*(product-manager|orchestrator|ceo|(?:worker|reviewer|engineer)-\d+)\b/i.exec(body);
  return named ? named[1].toLowerCase() : ownerOf(row);
}

export type JudgedComment = { row: BoardRow, comment: RowComment, author: string, at: number, text: string };
/**
 * The comments by org accounts in the last day, old enough that the author has had the grace (a younger one is not judged yet). A row whose `state` is `CLOSED` is not judged: the day's comment read
 * is `state=all`, and a handoff sentence under a row that has closed was either done or is a follow-up its author must file, so the flag (and the `answer:<route>` order it becomes) reaches nobody who can act
 * on it (21 orders about finished work reached one seat at once, 2026-10-09). A row with NO `state` is judged as before. @param {BoardFacts} facts @returns {JudgedComment[]}
 */
function commentsToJudge({ openRows, now }: BoardFacts): JudgedComment[] {
  return openRows.filter((row) => row.state !== "CLOSED").flatMap((row) => (row.comments ?? []).flatMap((comment) => {
    const at = Date.parse(comment.createdAt ?? "");
    const author = comment.author?.login ?? "";
    const aged = Number.isFinite(at) && now - at >= HANDOFF_GRACE_MS && now - at <= DAY_MS;
    return aged && ORG_ACCOUNT.test(author) ? [{ row, comment, author, at, text: outsideFences(comment.body ?? "") }] : [];
  }));
}

/** @param {string} text @returns {{ phrase: string, session: string }[]} one per session the comment hands off to, by the first phrase naming it */
function handoffsIn(text: string): { phrase: string; session: string; }[] {
  const found = HANDOFF_PHRASES.flatMap((pattern) => { const m = pattern.exec(text); return m ? [{ phrase: m[0].trim(), session: m[1].toLowerCase() }] : []; });
  return found.filter((h, i) => found.findIndex((other) => other.session === h.session) === i);
}

/**
 * A row the author filed THAT NAMES THE ROW THE COMMENT IS ON, or the `answer:<session>` label the author added, inside the grace after the comment. The account is shared by every session of a
 * lane (`a11ign-ai-leads` is `ceo` and its peers), so "any row by the same author" cleared #4090's own comment live: `ceo` filed #4110 and #4111, unrelated, five minutes after it (measured 2026-10-08).
 * A row counts when its title or body cites `#<n>` of the row commented on; a filed row that does not is the author's to add the citation to. @param {JudgedComment} judged @param {string} session @param {ProseEvidence} evidence */
function followedUp({ row, author, at }: JudgedComment, session: string, evidence: ProseEvidence) {
  const within = (when: string) => { const t = Date.parse(when) - at; return t >= 0 && t <= HANDOFF_GRACE_MS; };
  const cites = (text: string | undefined) => new RegExp(`#${row.number}(?!\\d)`).test(text ?? "");
  return evidence.rows.some((filed) => filed.author === author && within(filed.createdAt) && cites(filed.text))
    || evidence.labelEvents.some((e) => e.number === row.number && e.actor === author && e.label === `${ANSWER_PREFIX}${session}` && within(e.createdAt));
}

/** @param {JudgedComment} judged @param {string} detail @param {string} question @param {string} field @returns {Finding} */
const proseFinding = ({ row, comment, author }: JudgedComment, question: string, field: string, detail: string): Finding =>
  finding(row, question, field, `${detail} (${author}, ${comment.createdAt}${comment.url ? `, ${comment.url}` : ""})`, authorSessionOf(comment.body ?? "", row));

/** @param {BoardFacts} facts @returns {Finding[]} */
function handoffsInProse(facts: BoardFacts): Finding[] {
  const evidence = facts.proseEvidence;
  if (!evidence) return [];
  return commentsToJudge(facts).flatMap((judged) => handoffsIn(judged.text).filter((h) => !followedUp(judged, h.session, evidence)).map((h) => proseFinding(judged,
    PROSE_QUESTIONS.HANDOFF, `a row filed, or \`${ANSWER_PREFIX}${h.session}\`, in the same turn`, `a handoff written as a sentence, "${h.phrase}", and no row or order followed within 15 minutes`)));
}

/** @param {string} text @returns {boolean} a reading comment carrying no `Defect-row:` line */
const readingWithoutField = (text: string): boolean => READING_COMMENT.test(text) && !DEFECT_ROW_LINE.test(text);

/** @param {BoardFacts} facts @returns {Finding[]} */
function readingsWithoutField(facts: BoardFacts): Finding[] {
  if (facts.proseEvidence === undefined) return [];
  return commentsToJudge(facts).filter(({ text }) => readingWithoutField(text)).map((judged) => proseFinding(judged,
    PROSE_QUESTIONS.READING_FIELD, "`Defect-row: #N` or `Defect-row: none -- <reason>` line", "a reading with no `Defect-row:` field, which the org cannot read as prose"));
}

const PROSE_READERS: [string, (f: BoardFacts) => Finding[], (f: BoardFacts) => boolean][] = [
  [PROSE_QUESTIONS.HANDOFF, handoffsInProse, (f) => f.proseEvidence !== null],
  [PROSE_QUESTIONS.READING_FIELD, readingsWithoutField, () => true],
];

/**
 * THE TWO COMMENT QUESTIONS ALONE, over the facts `readProseFacts` built: the day's table adds them to the tick's audit, because asking them of the tick's rows would run the other eight over rows made of comments.
 * @param {BoardFacts} facts @returns {{ findings: Finding[], unread: string[] }}
 */
export function proseAudit(facts: BoardFacts): { findings: Finding[]; unread: string[]; } {
  const findings = PROSE_READERS.flatMap(([, ask]) => ask(facts)).sort((a, b) => a.number - b.number || a.question.localeCompare(b.question));
  return { findings, unread: PROSE_READERS.filter(([, , read]) => !read(facts)).map(([question]) => question) };
}

/** The questions and the fact each needs that may be unread, `null`. @type {[string, (f: BoardFacts) => Finding[], (f: BoardFacts) => boolean][]} */
const READERS: [string, (f: BoardFacts) => Finding[], (f: BoardFacts) => boolean][] = [
  [QUESTIONS.EPIC_DONE, epicsDone, () => true],
  [QUESTIONS.CLOSER_MERGED, closersMerged, (f) => f.mergedPrs !== null],
  [QUESTIONS.NO_CLAIMANT, noClaimants, (f) => f.liveSessions !== null],
  [QUESTIONS.WAIT_TRUE, waitsTrue, (f) => f.waitFacts !== null],
  [QUESTIONS.STATE_LABEL, stateLabels, () => true],
  [QUESTIONS.DUPLICATE, duplicates, (f) => f.closedRows !== null],
  [QUESTIONS.PARKED_BARE, parkedWithoutConditions, (f) => parkedBare(f).every(blockersRead)],
  [QUESTIONS.PARKED_ON_CHAIRMAN, parkedOnChairmen, () => true],
  [QUESTIONS.ROADMAP, roadmapMismatches, roadmapsRead],
  ...PROSE_READERS,
];

/**
 * ASK ALL NINE QUESTIONS. A question whose fact was not read still answers what it can from the rest (a `Not-before` date needs no fact) and is named in `unread`, so the table never states health it did not read.
 * @param {BoardFacts} facts
 * `filing` is how many rows were EXCUSED from the state-label question because they are being filed (#4048), so the table can say it rather than read them as agreeing.
 * #4080: EVERY KEYED TRACKER IS ASKED THE SAME QUESTIONS (`facts.others`), its findings tagged with its key. `notAsked` is what a keyed tracker is not asked on purpose: the wait facts are the gate's, read for the
 * first tracker's rows only, so that question is said NOT ASKED rather than listed unread (which would stop the day's table ever being posted).
 * `merging` is how many open rows were EXCUSED from `closing-pr-merged` because their PR merged inside `MERGE_GRACE_MS` (#4116), counted for the same reason.
 * @returns {{ findings: Finding[], unread: string[], filing: number, merging: number, notAsked?: string[] }} `notAsked` is absent with one declared tracker, so its audit is the one it always was
 */
export function boardTruthAudit(facts: BoardFacts): { findings: Finding[]; unread: string[]; filing: number; merging: number; notAsked?: string[]; } {
  const own = askAll(facts);
  const others = (facts.others ?? []).map(askOther);
  const findings = [...own.findings, ...others.flatMap((o) => o.findings)];
  const unread = [...own.unread, ...others.flatMap((o) => o.unread)];
  const notAsked = others.flatMap((o) => o.notAsked);
  const total = (field: "filing" | "merging") => own[field] + others.reduce((sum, o) => sum + o[field], 0);
  return { findings, unread, filing: total("filing"), merging: total("merging"), ...(notAsked.length > 0 && { notAsked }) };
}

/** @param {BoardFacts} facts @returns {{ findings: Finding[], unread: string[], filing: number, merging: number }} one tracker's own answers */
function askAll(facts: BoardFacts): { findings: Finding[]; unread: string[]; filing: number; merging: number; } {
  const findings = READERS.flatMap(([, ask]) => ask(facts)).sort((a, b) => a.number - b.number || a.question.localeCompare(b.question));
  return { findings, unread: READERS.filter(([, , read]) => !read(facts)).map(([question]) => question), filing: rowsBeingFiled(facts.openRows, facts).length,
    merging: mergedClosers(facts).merging.length };
}

/** @param {OtherTracker} other @returns {{ findings: Finding[], unread: string[], filing: number, merging: number, notAsked: string[] }} */
function askOther({ key, facts, why }: OtherTracker): { findings: Finding[]; unread: string[]; filing: number; merging: number; notAsked: string[]; } {
  if (facts === null) return { findings: [], unread: [`${key}: the open rows (${why})`], filing: 0, merging: 0, notAsked: [] };
  const answered = askAll(facts);
  const notWaits = (question: string) => question !== QUESTIONS.WAIT_TRUE;
  return { findings: answered.findings.map((f) => ({ ...f, key })), unread: answered.unread.filter(notWaits).map((q) => `${key}: ${q}`), filing: answered.filing, merging: answered.merging,
    notAsked: answered.unread.filter((q) => !notWaits(q)).map((q) => `${key}: ${q}`) };
}

/** A row's name in a table two trackers share: `agent-org#7` beside the first tracker's `#7`, because both trackers have a row 7 (#4080). @param {Finding} f */
const rowName = (f: Finding) => `${f.key ? `${f.key}#` : "#"}${f.number}`;

/** The first line of a table, which is what a second tick looks for on #928. @param {string} day */
const tableHeading = (day: string) => `### Board against reality, ${day}`;

/**
 * THE DAY'S TABLE: the count first, then one line per finding with the field to fix and who reads it. `0 disagree` is stated when it is true.
 * A row EXCUSED as being filed (#4048) is named `N filing, not judged` beside the count: it is neither a disagreement nor an agreement. So is one EXCUSED as merging (#4116),
 * `N merging, not judged`, and with both at 0 the line is the one it always was.
 * @param {{ findings: Finding[], unread: string[], filing?: number, merging?: number, notAsked?: string[] }} audit @param {string} day `YYYY-MM-DD`
 * @returns {string}
 */
export function boardTruthTable({ findings, unread, filing = 0, merging = 0, notAsked = [] }: { findings: Finding[]; unread: string[]; filing?: number; merging?: number; notAsked?: string[]; }, day: string): string {
  const filingNote = (filing === 0 ? "" : `, ${filing} filing, not judged`) + (merging === 0 ? "" : `, ${merging} merging, not judged`);
  const unreadNote = unread.length === 0 ? "" : ` -- NOT READ, so not counted as agreeing: ${unread.join(", ")}`;
  const notAskedNote = notAsked.length === 0 ? "" : ` -- NOT ASKED: ${notAsked.join(", ")}`;
  const head = [tableHeading(day), "", `**${findings.length} disagree**${filingNote}${unreadNote}${notAskedNote}`];
  if (findings.length === 0) return head.join("\n");
  const rows = findings.map((f) => `| ${rowName(f)} | ${f.question} | ${f.field} | ${f.detail} | ${f.route} |`);
  return [...head, "", "| row | question | field to fix | what disagrees | to |", "|---|---|---|---|---|", ...rows].join("\n");
}

/** @param {string[]} args @returns {string} gh's stdout */
const gh = (args: string[]): string => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/**
 * THE READS THE NINE QUESTIONS NEED; one that fails is `null` (UNREAD), never an empty list. Live sessions come from `herdr`'s workspace list, and a partial listing is
 * UNREAD too (it would read every holder as gone). Merged PRs are the newest 200 and closed rows the newest 500, which cover a day's closers and the rows a duplicate is
 * likely to repeat. The closed rows ask for no body (2.4 MB of the 2.5 MB the read measured on 2026-10-08, and no question reads it).
 * #4045: THE TICK HANDS ITS OWN READS IN. `openRows` is the open list the gate already holds (so the 1000-row read, comments and all, is not made a second time) and `waitFacts` the
 * facts its wait pass built; a caller that gives neither gets the old behaviour, the open rows read here and the wait facts `null` (unread).
 * a11ign/agent-org#517: THE `Roadmap` VALUES are one more read per tracker, `readRoadmaps`: the rows' own and their parents' (`gh issue list` carries neither), in ONE aliased GraphQL request per 50 rows.
 * #4080: EVERY KEYED TRACKER IS READ TOO, by the same three reads aimed at its own repository (its merged PRs from the code repository of the same key). `repo` stays the first tracker's: the
 * tick hands its rows in and the table is posted there. A tracker whose open rows are refused is `facts: null` with what `gh` said, so it is named unread and the first tracker's rows still stand.
 * @param {string} repo `owner/name`
 * @param {{ run?: (args: string[]) => string, agents?: typeof readAgents, now?: number, openRows?: BoardRow[], waitFacts?: BoardFacts["waitFacts"], trackers?: DeclaredTracker[] }} [io]
 * @returns {BoardFacts} `openRows` is not guarded: a refused open-row read throws, because there is no board to read without it
 */
export function readBoardFacts(repo: string, { run = gh, agents = readAgents, now = Date.now(), openRows: given, waitFacts = null, trackers = declaredTrackers() }: { run?: (args: string[]) => string; agents?: typeof readAgents; now?: number; openRows?: BoardRow[]; waitFacts?: BoardFacts["waitFacts"]; trackers?: DeclaredTracker[]; } = {}): BoardFacts {
  const json = (args: string[]) => JSON.parse(run([...args, "--repo", repo]));
  const orUnread = (args: string[]) => { try { return json(args); } catch { return null; } };
  const openRows = given ?? json(["issue", "list", "--state", "open", "--limit", "1000", "--json", OPEN_ROW_FIELDS]);
  const closedRows = orUnread(["issue", "list", "--state", "closed", "--limit", "500", "--json", "number,title,state,stateReason"]);
  const mergedPrs = orUnread(["pr", "list", "--state", "merged", "--limit", "200", "--json", "number,body,mergedAt"]);
  const listed = agents();
  const liveSessions = listed !== null && listingIsComplete(listed) ? listed.map((a) => a.label) : null;
  const roadmaps = readRoadmaps(repo, openRows, run);
  const others = trackers.filter((tracker) => tracker.key !== "").map((tracker) => readOtherTracker(tracker, { run, now, liveSessions }));
  return { now, openRows, closedRows, mergedPrs, liveSessions, waitFacts, roadmaps, ...(others.length > 0 && { others }) };
}

/**
 * THE DAY'S COMMENTS AND THE EVIDENCE THEY NEED (#4232), read once per edition day by `postDaysTable` and never by the tick: the tick's open rows carry comments for CLAIMED rows only, and a
 * handoff is as likely on a parked or closed one (#4090 was neither claimed nor open at the time). ONE paginated REST call lists every comment of the last day in the repository (measured 2026-10-08:
 * 899 comments, 9 pages, 1.0 MB, so it is not a per-tick read); the org accounts' are kept and grouped by row. Then ONE call for the issues created in the day (who filed what, when) and ONE per row
 * holding a handoff comment, for its `labeled` events. REST spends the core pool, not GraphQL's. A refused read is `null` (UNREAD), never "no evidence", which would flag every handoff.
 * THE ROWS CARRY THEIR STATE: the comment list has none, so the issues read (made whenever a comment could raise a finding, and then also the evidence) marks a row it lists as closed `CLOSED`, which
 * `commentsToJudge` skips, and the events are read for open rows only. A row the list does not hold keeps no `state` and is judged as before.
 * Orders are not evidence here: the queue is local state the audit cannot see, so a handoff answered ONLY by an order is flagged, and the label the order also needs is the remedy.
 * @param {{ repo: string, run: (args: string[]) => string, now: number }} input @returns {BoardFacts | null} facts for `proseAudit` alone: only `openRows` and `proseEvidence` mean anything
 */
export function readProseFacts({ repo, run, now }: { repo: string; run: (args: string[]) => string; now: number; }): BoardFacts | null {
  const lines = (args: string[]) => run(["api", "--paginate", ...args]).split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  const since = new Date(now - DAY_MS).toISOString().replace(/\.\d+Z$/, "Z");
  try {
    const comments = lines([`repos/${repo}/issues/comments?since=${since}&per_page=100`, "--jq", `.[] | select(.user.login | startswith("a11ign-"))
      | {number: (.issue_url | split("/") | last | tonumber), author: {login: .user.login}, body: .body, createdAt: .created_at, url: .html_url}`]);
    const byRow = new Map();
    for (const c of comments) byRow.set(c.number, [...(byRow.get(c.number) ?? []), c]);
    const openRows = [...byRow].map(([number, rowComments]) => ({ number, labels: [], comments: rowComments }));
    const facts: BoardFacts = { now, openRows, closedRows: null, mergedPrs: null, liveSessions: null, waitFacts: null };
    const askable = commentsToJudge(facts).some(({ text }) => handoffsIn(text).length > 0 || readingWithoutField(text));
    if (!askable) return { ...facts, proseEvidence: { rows: [], labelEvents: [] } };
    const issues = lines([`repos/${repo}/issues?state=all&since=${since}&per_page=100`, "--jq", ".[] | select(.pull_request | not) | {number: .number, state: .state, author: .user.login, createdAt: .created_at, text: (.title + \"\\n\" + (.body // \"\"))}"]);
    const closed = new Set(issues.filter((issue) => issue.state === "closed").map((issue) => issue.number));
    const stated = { ...facts, openRows: openRows.map((row) => closed.has(row.number) ? { ...row, state: "CLOSED" } : row) };
    const rows = issues.map(({ author, createdAt, text }) => ({ author, createdAt, text }));
    const needing = [...new Set(commentsToJudge(stated).filter(({ text }) => handoffsIn(text).length > 0).map(({ row }) => row.number))];
    const labelEvents = needing.flatMap((n) => lines([`repos/${repo}/issues/${n}/events?per_page=100`, "--jq",
      `.[] | select(.event == "labeled") | {number: ${n}, label: .label.name, actor: .actor.login, createdAt: .created_at}`]));
    return { ...stated, proseEvidence: { rows, labelEvents } };
  } catch {
    return null;
  }
}

const OPEN_ROW_FIELDS = "number,title,body,labels,state,comments,subIssuesSummary,createdAt,blockedBy";

/** The declared trackers with the code repository of the same key beside each. Read on use, so a file that never reads a second tracker never needs the declaration. @returns {DeclaredTracker[]} */
function declaredTrackers(): DeclaredTracker[] {
  const { tracker, code } = homeProjectDeclaration();
  return tracker.map(({ key, repo }) => ({ key, repo, ...(code.some((c) => c.key === key) && { codeRepo: code.find((c) => c.key === key)?.repo }) }));
}

/**
 * ONE KEYED TRACKER'S FACTS. Its open rows are read with their comments (nobody hands them in), its sessions are the org's, and its wait facts are `null`: they are built by the gate for the first tracker's rows.
 * @param {DeclaredTracker} tracker @param {{ run: (args: string[]) => string, now: number, liveSessions: string[] | null }} io @returns {OtherTracker}
 */
function readOtherTracker({ key, repo, codeRepo }: DeclaredTracker, { run, now, liveSessions }: { run: (args: string[]) => string; now: number; liveSessions: string[] | null; }): OtherTracker {
  const json = (aimed: string, args: string[]) => JSON.parse(run([...args, "--repo", aimed]));
  const orUnread = (aimed: string, args: string[]) => { try { return json(aimed, args); } catch { return null; } };
  let openRows: BoardRow[];
  try {
    openRows = json(repo, ["issue", "list", "--state", "open", "--limit", "1000", "--json", OPEN_ROW_FIELDS]);
  } catch (error) {
    return { key, repo, facts: null, why: (error instanceof Error ? error.message : String(error)).split("\n")[0] };
  }
  const closedRows = orUnread(repo, ["issue", "list", "--state", "closed", "--limit", "500", "--json", "number,title,state,stateReason"]);
  const mergedPrs = codeRepo === undefined ? null : orUnread(codeRepo, ["pr", "list", "--state", "merged", "--limit", "200", "--json", "number,body,mergedAt"]);
  return { key, repo, facts: { now, openRows, closedRows, mergedPrs, liveSessions, waitFacts: null, roadmaps: readRoadmaps(repo, openRows, run) } };
}

const ROADMAP_FIELD = "Roadmap";
const ROADMAP_ROWS_PER_REQUEST = 50;
const ROADMAP_ITEMS_ASKED = 20;
const ROADMAP_ISSUE_FIELDS = `number repository { nameWithOwner } projectItems(first: ${ROADMAP_ITEMS_ASKED}) { totalCount nodes {
  project { number owner { ... on Organization { login } ... on User { login } } }
  value: fieldValueByName(name: "${ROADMAP_FIELD}") { ... on ProjectV2ItemFieldSingleSelectValue { name } ... on ProjectV2ItemFieldTextValue { text } } } }`;

/** @param {any} issue a GraphQL `Issue` node with `ROADMAP_ISSUE_FIELDS` and up to two `parent` levels @returns {RoadmapNode} THROWS on a node that is not shaped so, or whose items were cut short */
function roadmapNodeOf(issue: any): RoadmapNode {
  const items = issue?.projectItems;
  if (typeof issue?.number !== "number" || !Array.isArray(items?.nodes) || (items.totalCount ?? items.nodes.length) > items.nodes.length) {
    throw new Error(`roadmap read: #${issue?.number} came back without all of its project items`);
  }
  return { ref: `${issue.repository?.nameWithOwner}#${issue.number}`,
    items: items.nodes.map((node: any) => ({ project: `${node.project.owner.login}/${node.project.number}`, value: node.value?.name ?? node.value?.text ?? null })),
    parent: issue.parent ? roadmapNodeOf(issue.parent) : null };
}

/**
 * THE `Roadmap` FACTS: each open row's items and its parent's and grandparent's, ONE aliased request per 50 rows (a board of 65 is two requests, about two points of GraphQL, each tick).
 * It is aliased by row number rather than a project-items walk because the walk pages every row the board ever held, closed ones included, and this asks only for the rows the audit judges.
 * A refused or misshapen answer is `null` (UNREAD), never an empty map: an empty map would say every row agrees.
 * @param {string} repo `owner/name` @param {BoardRow[]} openRows @param {(args: string[]) => string} run @returns {RowRoadmaps | null}
 */
function readRoadmaps(repo: string, openRows: BoardRow[], run: (args: string[]) => string): RowRoadmaps | null {
  const [owner, name] = repo.split("/");
  const found: RowRoadmaps = {};
  try {
    for (let from = 0; from < openRows.length; from += ROADMAP_ROWS_PER_REQUEST) {
      const aliases = openRows.slice(from, from + ROADMAP_ROWS_PER_REQUEST).map((row) =>
        `r${row.number}: issue(number: ${row.number}) { ...F parent { ...F parent { ...F } } }`).join("\n");
      const query = `fragment F on Issue { ${ROADMAP_ISSUE_FIELDS} }\nquery($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {\n${aliases}\n} }`;
      const answer = JSON.parse(run(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`]))?.data?.repository;
      if (typeof answer !== "object" || answer === null || Array.isArray(answer)) throw new Error("roadmap read: no repository in the answer");
      for (const row of openRows.slice(from, from + ROADMAP_ROWS_PER_REQUEST)) {
        if (answer[`r${row.number}`]) found[row.number] = roadmapNodeOf(answer[`r${row.number}`]);
      }
    }
  } catch {
    return null;
  }
  return found;
}

/** The record the day's table is posted on (#4045). A row the org owns, not a pull request: it is `ceo`'s and the chairman's reading place. */
export const TABLE_ROW = "928";
/** Comments on the record from the day before, so the look-back is one page whatever the row's length; the heading carries the exact day. @param {string} day */
const lookBackFrom = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().replace(/\.\d+Z$/, "Z");

/**
 * ONE TABLE PER EDITION DAY ON #928, posted by the tick (#4045). A day is posted once: the record is asked first (a REST `since=` page, so a long row costs one call), and a
 * table whose heading is already there is not posted again, so a restart, a second host or a tick a minute later posts nothing. The ask is the whole state: nothing is
 * kept locally to disagree with the row.
 * ONLY A COMPLETE READING IS POSTED: the day's table cannot be replaced, and a table carrying `NOT READ` at 00:02 because one call was refused would stand for the day. The
 * unread audit is the org-health signal's to say (`unknown`), so it is not posted and the next tick reads again. A failed ask posts nothing for the same reason in the other
 * direction: it could not tell whether the table is there.
 * #4232: THE DAY'S TABLE ALSO CARRIES THE COMMENT QUESTIONS, read here and nowhere else (`readProseFacts`: a day's comments is one paginated read, not a tick's). They are read AFTER the ask
 * above finds the table absent, so a tick that posts nothing spends none of it, and an unreadable comment list is `"unread"` for the same reason a table carrying `NOT READ` is not posted.
 * @param {{ audit: { findings: Finding[], unread: string[] } | null, day: string, repo: string, run?: (args: string[]) => string, now?: number, readProse?: typeof readProseFacts }} input
 * @returns {"posted" | "already-posted" | "unread" | "no-audit"} what was done; a failed ask or post THROWS, and the caller says so
 */
export function postDaysTable({ audit, day, repo, run = gh, now = Date.now(), readProse = readProseFacts }: { audit: { findings: Finding[]; unread: string[]; } | null; day: string; repo: string; run?: (args: string[]) => string; now?: number; readProse?: typeof readProseFacts; }): "posted" | "already-posted" | "unread" | "no-audit" {
  if (audit === null) return "no-audit";
  if (audit.unread.length > 0) return "unread";
  const path = `repos/${repo}/issues/${TABLE_ROW}/comments?per_page=100&since=${lookBackFrom(day)}`;
  const ids = run(["api", "--paginate", path, "--jq", `.[] | select(.body | startswith("${tableHeading(day)}")) | .id`]).trim();
  if (ids !== "") return "already-posted";
  const prose = readProse({ repo, run, now });
  if (prose === null) return "unread";
  const comments = proseAudit(prose);
  if (comments.unread.length > 0) return "unread";
  const whole = { ...audit, findings: [...audit.findings, ...comments.findings] };
  run(["issue", "comment", TABLE_ROW, "--repo", repo, "--body", `${boardTruthTable(whole, day)}\n\n_Read by the work-gate tick, once per edition day (a11ign/a11ign#4045)._`]);
  return "posted";
}
