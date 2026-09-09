/**
 * #790: EVERY CHECK THIS ORGANISATION RUNS ENUMERATES SOMETHING BY A KEY -- and where the thing being
 * counted can exist without that key, the check cannot report it. Not as a failure, not as an unknown,
 * not at all. It is absent from the population, and absence is the one state an enumeration cannot
 * describe by itself. #788 was the instance the LABEL key produced: three open rows carried none,
 * including #623, the most irreversible row on the 15 September transfer milestone, reachable by no
 * label query in the organisation. This row asks the identical question of every other key this
 * organisation's own tooling enumerates by.
 *
 * THE CENSUS, measured 2026-09-09 and re-verified against `main` before this file was written -- two of
 * the six rows read as open work when this row was filed and were themselves already fixed by the time
 * building started (the exact shape this row exists to catch, one layer up: a TRACKER row going stale
 * between being filed and being read, not a check's population). Re-reading before building rather than
 * trusting the issue's own prose is this repo's own "audit first, then fix" rule.
 *
 * | key                    | enumerated by                                              | completeness state |
 * |------------------------|-------------------------------------------------------------|--------------------|
 * | issue labels           | `ready:audit`, the Ready lane, WIP, dead-claim, the hourly table | FIXED -- #788. `fetchOpenIssuesChecked` (`ready-label-audit.mjs`) states examined-vs-GitHub's-own-reported-count and refuses on mismatch; `labellessRows`/`reportLabelless` name a row with no label at all. |
 * | Project items          | the board view, `openRowsAbsentFromBoard`                  | FIXED -- #788, same commit. `openRowsAbsentFromBoard` reads EVERY open issue via `fetchOpenIssuesChecked`, not a `ready`-only subset (`ready-label-audit.mjs:812`, "EVERY OPEN ROW, not just `ready`"); `reportAbsentFromBoard` prints `OK N of M open issue(s) checked` or names each absent row. |
 * | branch prefixes        | `queue:table`'s owner column, the stranded-branch sweep, `worktrees:prune`'s exemptions | BUILT HERE. `fetchRemoteBranchesChecked` (`queue-table.mjs`) states the local mirror's count against `git ls-remote`'s own independent read and refuses on a mismatch (a stale `fetch`); `branchPrefixCensus`/`renderBranchPrefixes` name any branch with no owner prefix at all -- section 6 of `queue-table.mjs`'s own output. Deliberately does NOT classify which prefix is "correct" (a judgement, not a census -- see the issue's own "What this row is NOT"); it only answers whether one exists. |
 * | `reported/` kinds      | `board-data.mjs`'s `REPORTED_KINDS`, the appendix, section 3 | ALREADY THE MODEL. `board-style.test.ts` already compares the directory listing on disk against the declared kinds and fails on a mismatch -- the one enumeration on this table that already asserted its own completeness before this row existed. Nothing to build; cited as the shape the rest of this table copies. |
 * | workflow / check names | `checkReasons`, the arm path, `gh pr checks`                | ALREADY THE RIGHT SHAPE. A required context that never ran is handled as its OWN state (`checkReasons`'s "no run reported" branch, distinct from a check that ran and failed) rather than folded into either -- the exact "the thing can be absent, name that too" property this row asks for, already present because a required-but-silent context is a state this project was already forced to build for `arm-pr.mjs` to be safe at all. |
 * | session sockets        | `ListAgents`, every cross-session message                  | ACCEPTED, NOT BUILDABLE HERE. See the note below this table. |
 *
 * ## Why session sockets is accepted rather than built
 *
 * `ListAgents`'s socket population and "the sessions this organisation knows about" are both LIVE,
 * interactive-tool state with no representation in this repository's tree -- unlike every other row on
 * this table, there is no `git`-visible or `gh`-visible source to read a second time and compare against.
 * A completeness statement needs an INDEPENDENT second reading of the same population (the pattern every
 * other row above uses: GitHub's search index beside `gh issue list`, `git ls-remote` beside
 * `for-each-ref`); no second reading of "which sockets currently exist" is available from inside a
 * process that is itself one of the sessions being counted. Building one would mean adding a session
 * registry this organisation does not otherwise need, to answer a question a human already asks by
 * running `ListAgents` and reading the answer -- the cost of the gap (a stale or unattributable socket
 * sitting unexplained for one reading) is smaller than the cost of the registry required to close it.
 * Recorded here rather than left silent, per this row's own acceptance ("or is recorded as accepted, with
 * the reason and what the absence would cost").
 */
// no-token: gh
// no-token: git
//
// #827/#790. Every test here either passes its own injected `run` fixture to a fetcher
// (`fetchOpenIssuesChecked`, `fetchRemoteBranchesChecked`) or asserts on a cited function's `typeof`/on
// this file's own text -- nothing calls the real `gh`/`git` wrappers those fetchers default to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { fetchOpenIssuesChecked, fetchReportedOpenIssueCount, labellessRows, openRowsAbsentFromBoard }
  from "../../../../scripts/ready-label-audit.mjs";
import { fetchRemoteBranchesChecked, branchPrefixCensus, renderBranchPrefixes }
  from "../../../../scripts/queue-table.mjs";

const repoPath = (relative: string) => fileURLToPath(new URL(`../../../../${relative}`, import.meta.url));

/**
 * THIS FILE'S OWN VACUITY GUARD: every mechanism the table above cites, for a key this row calls FIXED or
 * ALREADY THE MODEL, must still exist and still be the shape described -- so a rename or a later
 * simplification that quietly removed the completeness statement is caught here, not just believed from
 * the table's own prose. Mirrors `derived-artifact-sweep.test.ts`'s own "a classified entry must still
 * correspond to a real thing" check, one layer up (a CITATION rather than a generated file).
 */
test("#790: every 'already fixed' or 'already the model' row on this file's own census table still names "
  + "a real, exported mechanism", () => {
  assert.equal(typeof fetchOpenIssuesChecked, "function");
  assert.equal(typeof fetchReportedOpenIssueCount, "function");
  assert.equal(typeof labellessRows, "function");
  assert.equal(typeof openRowsAbsentFromBoard, "function");
  assert.equal(typeof fetchRemoteBranchesChecked, "function");
  assert.equal(typeof branchPrefixCensus, "function");
  assert.equal(typeof renderBranchPrefixes, "function");
  assert.ok(existsSync(repoPath("packages/lab/src/packaging/board-style.test.ts")),
    "the 'reported/ kinds' row cites board-style.test.ts as the model -- it must still exist");
});

test("#790: the issue-labels and Project-items rows' own completeness statement still refuses on a "
  + "narrowed population -- re-run here so this file's claim that #788 already covers them is a fact "
  + "this suite checks, not only a sentence in its own header", () => {
  const run = () => JSON.stringify([{ number: 1, title: "a", labels: [] }]);
  assert.throws(() => fetchOpenIssuesChecked({ run, fetchReportedCount: () => 5 }),
    /examined 1 open issue\(s\) but GitHub's search index reports 5 open/);
});

test("#790: the branch-prefix row built here refuses on a narrowed population the identical way", () => {
  const run = (args: string[]) => (args[0] === "for-each-ref" ? "origin/main\n"
    : "abc\trefs/heads/agent/x\ndef\trefs/heads/main\n");
  assert.throws(() => fetchRemoteBranchesChecked({ run }),
    /examined 1 branch\(es\) from the local mirror but the remote reports 2/);
});

test("#790: session sockets is documented as accepted, not silently missing from this table", () => {
  const body = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.match(body, /session sockets\s+\| `ListAgents`/,
    "the census table must still list the session-sockets row");
  assert.match(body, /ACCEPTED, NOT BUILDABLE HERE/,
    "and it must still say so explicitly rather than the row quietly vanishing from the table");
});
