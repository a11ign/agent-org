// command: (not a command) the PURE half of the #623 branch inventory -- classification and
//          reconciliation over data somebody else fetched; `branch-inventory-report.mjs` is the CLI.
//
// #623: 93 branches on `origin` have no open PR and carry 291 commits that exist on no other ref, and the
// org transfer on 2026-09-15 rewrites history. **After the 15th, "was there anything in that branch" stops
// being an answerable question.** The row asks for FOUR facts about each one -- the branch, its last
// commit, its owner, and its row state -- so that each owner decides about their OWN branch.
//
// SEPARATED FROM THE FETCHING FOR ONE REASON: this file spawns nothing, so a test that imports it needs no
// token and the row's acceptance command can run in a job that has none (#1009). The CLI beside it reads
// git and `gh` and carries that requirement.
//
// THE OWNER IS DERIVED AND ITS SOURCE IS CARRIED, never guessed. `git` records who pushed a branch nowhere
// this repository can read -- every commit is authored by the one account, which is why the incident that
// produced #1128 could happen at all. So the owner comes from the ROW the branch names: a live `session:`
// label first, then the claim history of a closed row.
//
// A BRANCH THAT NAMES NO ROW IS GROUPED BY ITS PREFIX AND RANKED BELOW EVERY OWNER WHO CAN ANSWER.
// `lead/`, `dispatcher/` and `pm/` are RETIRED roles (org shape, 2026-09-10), so the prefix says which
// role pushed it and produces nobody who can answer today. This sentence used to say such a branch is
// "unknown rather than attributed to the prefix", and the code did not do that -- worker-judge drove it
// on #1273 and `lead/foo` came back as a named group sorted among the live sessions by size, so a retired
// role with 14 branches outranked a live session with 9. **Grouping by the prefix is more useful than
// UNKNOWN and the ORDER is what has to carry the distinction**: live owners, then retired roles, then
// unknown. `source` is the key that decides the rank, never the owner string.

/** A trailing `-<digits>` is the row the branch was cut for. `null` when the name carries none. */
export function rowNumberFromBranch(branch) {
  const m = /-(\d+)$/.exec(branch);
  return m === null ? null : Number(m[1]);
}

/** The `session:<name>` label on a row, or null. A row may carry none -- that is a fact, not an error. */
export function sessionFromLabels(labels = []) {
  const found = labels.find((l) => l.startsWith("session:"));
  return found === undefined ? null : found.slice("session:".length);
}

/**
 * THE OWNER OF A CLOSED ROW, RECOVERED FROM THE TIMELINE -- and without this the list is mostly UNKNOWN.
 *
 * Measured while building this: of 93 branches, 64 came back unowned, and the cause is not that nobody
 * claimed them. **Closing a row STRIPS its `session:` label** (`stripClaimLabels`), so the live labels of
 * every finished row say nothing about who worked it. The claim is still on the record as a `labeled`
 * EVENT, which no close removes:
 *
 *   #119, labels today: [backlog]
 *   timeline:  labeled backlog | labeled ready | labeled in-progress | labeled session:worker-audit
 *              | unlabeled ready | unlabeled in-progress | unlabeled session:worker-audit
 *
 * THE LAST ONE ADDED WINS, because a row can change hands and the most recent claim is the live one. An
 * `unlabeled` event is deliberately NOT treated as a disowning: that is what closing does to every row, so
 * reading it as "no owner" would throw away exactly the population this is for.
 *
 * @param {{ event: string, label?: { name: string } }[]} timeline
 */
export function sessionFromTimeline(timeline = []) {
  const claims = timeline.filter((e) => e.event === "labeled" && (e.label?.name ?? "").startsWith("session:"));
  const last = claims[claims.length - 1];
  return last === undefined ? null : last.label.name.slice("session:".length);
}

/** Roles that no longer run, so a branch carrying one has no owner who can answer for it today. */
const RETIRED_PREFIXES = new Set(["lead", "dispatcher", "pm", "measure", "marketing", "archive"]);

/**
 * WHO OWNS THIS BRANCH, and HOW THAT WAS DECIDED -- the second half is the point.
 *
 * `source` is returned beside `owner` because these are not equally good answers: a `session:` label on
 * the row is a record somebody wrote, and a branch prefix is an inference from a naming habit. A list that
 * flattened them would read as 93 attributions when it holds two kinds of claim.
 *
 * @param {{ branch: string, row: { number: number, state: string, labels: string[], isPullRequest?: boolean } | null | undefined,
 *           timeline?: { event: string, label?: { name: string } }[] }} input
 * @returns {{ owner: string | null,
 *             source: "row-label" | "claim-history" | "retired-role" | "unknown" }}
 */
export function ownerOfBranch({ branch, row, timeline = [] }) {
  // A PULL REQUEST'S labels are not a row claim: `session:` never appears on one, and treating a PR as a
  // row is the defect the comment in `branchFacts` records.
  // #1278: `row == null` catches undefined too. `row === null` missed it, so a caller omitting the
  // field got a TypeError out of the one function whose job is to answer "unknown" when it cannot tell.
  const fromRow = row == null || row.isPullRequest ? null : sessionFromLabels(row.labels);
  if (fromRow !== null) return { owner: fromRow, source: "row-label" };
  const fromHistory = sessionFromTimeline(timeline);
  if (fromHistory !== null) return { owner: fromHistory, source: "claim-history" };
  const prefix = branch.split("/")[0];
  if (RETIRED_PREFIXES.has(prefix)) return { owner: `${prefix} (retired role)`, source: "retired-role" };
  return { owner: null, source: "unknown" };
}

/**
 * The four facts, for one branch. `rowState` distinguishes three things a reader will otherwise conflate:
 * a branch naming an OPEN row is live work, one naming a CLOSED row is work whose row is finished (so the
 * commits are either landed elsewhere or abandoned), and one naming NO row cannot be traced at all.
 *
 * @param {{ branch: string, ahead: number, lastCommit: { sha: string, at: string },
 *           row: { number: number, state: string, labels: string[], isPullRequest?: boolean } | null,
 *           timeline?: { event: string, label?: { name: string } }[] }} input
 */
export function branchFacts({ branch, ahead, lastCommit, row, timeline = [] }) {
  const rowNumber = rowNumberFromBranch(branch);
  // A TRAILING NUMBER MAY NAME A PULL REQUEST RATHER THAN A ROW, and the read does not say so by itself.
  //
  // Found in the first real sweep: `archive/gate-ages-rebased-137` reported `#137 MERGED`, a state no
  // issue has. GitHub's REST `/issues/<n>` answers for pull requests too, so `gh issue view 137` returned
  // the PR and the tool called it a row. One in 93 today -- and under the disposition rules it decides
  // whether a branch is kept, so a PR read as an open row would hold a branch nobody owns. `pull_request`
  // is the discriminator GitHub gives; `isPullRequest` carries it rather than inferring from the state.
  const rowState = rowNumber === null ? "no row number in the name"
    : row === null ? `#${rowNumber} does not exist`
    : row.isPullRequest ? `#${rowNumber} is a PULL REQUEST, not a row`
    : `#${rowNumber} ${row.state}`;
  return { branch, ahead, lastCommit, rowState, ...ownerOfBranch({ branch, row, timeline }) };
}

/**
 * THE RECONCILIATION THE ROW ASKS FOR, as a returned value rather than a sentence somebody checks.
 *
 * "The count at the end reconciles with the count at the start, or the difference is explained." Branches
 * land and are created during a sweep, so a difference is expected -- what must not happen is a total that
 * changed quietly. `balanced` is the arithmetic; `drift` is what moved between the two reads.
 *
 * TWO READS, AND THAT IS THE WHOLE POINT. `merged + unmerged === noOpenPR` inside ONE read is a PARTITION
 * check -- it says the two buckets cover the population without overlapping, which is worth printing and
 * is not reconciliation. It cannot see drift, because both numbers come from the same moment. The report
 * used to print a one-read sum under the word `reconcile` while this function had no caller at all;
 * worker-judge found it on #1273, and it is the exported-writer-with-no-caller shape made worse by output
 * that claims the missing thing was done.
 *
 * @param {{ candidates: number, noOpenPR: number, merged: number, unmerged: number }} start
 * @param {{ candidates: number, noOpenPR: number, merged: number, unmerged: number }} end
 */
export function reconcile(start, end) {
  const balanced = (c) => c.merged + c.unmerged === c.noOpenPR;
  return {
    startBalanced: balanced(start),
    endBalanced: balanced(end),
    drift: { candidates: end.candidates - start.candidates, noOpenPR: end.noOpenPR - start.noOpenPR,
      merged: end.merged - start.merged, unmerged: end.unmerged - start.unmerged },
  };
}

/**
 * The list, as the row wants to read it: grouped by owner, because the row's whole mechanism is that each
 * owner answers for their OWN branches. Unknown sorts LAST and is never omitted -- an unattributed branch
 * is exactly the one nobody will claim, so burying it at the top of a long table is how it goes unanswered.
 *
 * @param {ReturnType<typeof branchFacts>[]} facts
 */
export function groupByOwner(facts) {
  const groups = new Map();
  for (const f of facts) {
    const key = f.owner ?? "UNKNOWN -- nobody is recorded as owning this";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  // RANK BY SOURCE, NOT BY SIZE ALONE. A group's rank is the best evidence any of its branches carries:
  // an owner who can answer outranks a retired role, and a retired role outranks nobody at all. Within a
  // rank, the biggest group first. Keying on the owner STRING was the defect: `lead (retired role)` sorted
  // among the live sessions, so 14 branches nobody can answer for came above 9 that somebody can.
  const RANK = { "row-label": 0, "claim-history": 0, "retired-role": 1, unknown: 2 };
  const rankOf = (rows) => Math.min(...rows.map((r) => RANK[r.source] ?? RANK.unknown));
  return [...groups.entries()]
    .sort((a, b) => rankOf(a[1]) - rankOf(b[1]) || b[1].length - a[1].length);
}

/** One markdown table per owner, every branch on its own line with all four facts. */
export function renderInventory(facts) {
  const lines = [];
  for (const [owner, rows] of groupByOwner(facts)) {
    const commits = rows.reduce((n, r) => n + r.ahead, 0);
    lines.push(`### ${owner} — ${rows.length} branch(es), ${commits} commit(s) on no other ref`, "",
      "| branch | commits | last commit | row | owner known from |", "|---|---|---|---|---|");
    for (const r of [...rows].sort((a, b) => b.ahead - a.ahead)) {
      lines.push(`| \`${r.branch}\` | ${r.ahead} | \`${r.lastCommit.sha}\` ${r.lastCommit.at} `
        + `| ${r.rowState} | ${r.source} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
