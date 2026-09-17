#!/usr/bin/env node
// command: produce the #623 four-fact inventory of every branch on origin with no open PR and commits
//          main lacks -- read-only, modifies nothing -- `npm run branches:inventory`
//
// THE FETCHING HALF. The classification lives in `branch-inventory.mjs`, which spawns nothing, so the
// row's acceptance runs in a job with no token (#1009). This file reads git and `gh` and therefore does
// carry that requirement.
//
// READ-ONLY ON ORIGIN BY CONSTRUCTION: every git command here is a read (`for-each-ref`, `rev-list`, `log`)
// except `git fetch --prune origin`, which writes only this checkout's remote-tracking refs (#1282), and
// every `gh` call is a `list`/`view`. #623 is explicit that deleting is NOT in scope -- a branch is
// deleted by its owner having said so on the row, or it is kept -- so this tool has no closing path at
// all rather than a guarded one.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { refuseUnknownFlags } from "@a11ign/worker-fleet/cli-flags";
import { REPO } from "../../../scripts/repo-identity.mjs";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
import { branchFacts, renderInventory, rowNumberFromBranch, sessionFromLabels, reconcile }
  from "./branch-inventory.mjs";

/** @type {(cmd: string, args: string[]) => string} */
const MAX_BUFFER = 64 * 1024 * 1024; // a paginated listing is megabytes; the 1 MB default is an ENOBUFS
const defaultRun = (cmd, args) =>
  execFileSync(cmd, args,
    { encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_BUFFER });

/**
 * Every branch on `origin` except `main`, with the tip sha and its commit date in ONE read.
 *
 * `%(refname:lstrip=3)` rather than `%(refname:short)`, and `--exclude` rather than a grep: #623's own
 * open-check recorded that `refs/remotes/origin/HEAD` has a short name of `origin`, so a grep for
 * `^HEAD$` never matches it, `origin/origin` is not a revision, and the error goes to stderr while the
 * line is counted anyway. A phantom in the population and a visible error that changed no number.
 *
 * PRUNED FIRST, #1282. A remote-tracking ref is a local cache, not a fact about the remote, and `git fetch`
 * without `--prune` never removes one. Measured 2026-09-13T12:40Z: 208 refs read here, 202 after
 * `git fetch --prune`, and the six were branches already deleted on origin. The returned list looks the
 * same either way, which is why the test pins the argv rather than the answer.
 *
 * THE FETCH LIVES HERE, NOT IN A CALLER, because both counts and the facts sweep read through this
 * function: the end-of-sweep count in `inventory` then sees what landed or left DURING the sweep, rather
 * than re-reading the cache the start fetched.
 */
export function branchesWithTips({ run = defaultRun } = {}) {
  run("git", ["fetch", "--prune", "origin"]);
  const out = run("git", ["for-each-ref", "--format=%(refname:lstrip=3)\t%(objectname:short)\t%(committerdate:iso-strict)",
    "refs/remotes/origin", "--exclude=refs/remotes/origin/HEAD"]);
  return out.split("\n").filter((l) => l.trim() !== "").map((line) => {
    const [branch, sha, at] = line.split("\t");
    return { branch, lastCommit: { sha, at } };
  }).filter((b) => b.branch !== "main");
}

/**
 * Head refs of every OPEN PR -- the branches already visible to review.
 *
 * REST, not `gh pr list --json`, and that is not a style choice: `--json` routes through GraphQL, and on
 * 2026-09-13 at 11:25Z the org's shared GraphQL budget was exhausted while REST still had 4,641 of 5,000.
 * This tool failed on exactly that call. A read-only inventory that cannot run when the board is busy is
 * a tool for quiet afternoons, so every call here is REST.
 */
export function openPrHeads({ run = defaultRun } = {}) {
  const refs = run("gh", ["api", `repos/${REPO}/pulls?state=open&per_page=100`, "--paginate",
    "--jq", ".[].head.ref"]);
  return new Set(refs.split("\n").filter((r) => r.trim() !== ""));
}

/** How many commits this branch carries that `origin/main` does not. */
export function aheadOf(branch, { run = defaultRun } = {}) {
  return Number(run("git", ["rev-list", "--count", `origin/main..origin/${branch}`]).trim());
}

/**
 * THE ROWS THE BRANCHES NAME, in ONE paginated REST listing rather than one call per branch.
 *
 * Measured 2026-09-13: 54 of the 93 branches carry a row number, so the per-number route cost 54 calls;
 * the listing costs about 13 at `per_page=100` over ~1,280 issues. That matters beyond tidiness — this
 * account's GraphQL budget was exhausted by the org at 11:25Z while REST still had 4,641 of 5,000, and a
 * tool that spends 54 calls per run is part of why a shared limit runs out.
 *
 * REST, DELIBERATELY, AND `gh api` RATHER THAN `gh issue list`: the `--json` flag routes through GraphQL,
 * which is the budget that empties first and the one the board already needs. This path stayed usable
 * through the outage that refused every `gh pr view`.
 *
 * THE LISTING RETURNS PULL REQUESTS TOO, and that is carried rather than filtered: a branch whose
 * trailing number names a PR must be REPORTED as naming a PR, not silently dropped into "does not
 * exist". `pull_request` is the discriminator; `archive/gate-ages-rebased-137` is the case that found it.
 *
 * @param {number[]} numbers the row numbers actually wanted -- the listing is indexed, never scanned
 */
export function rowsFor(numbers, { run = defaultRun } = {}) {
  const wanted = new Set(numbers);
  const rows = new Map(numbers.map((n) => [n, null]));
  // PROJECTED SERVER-SIDE-ISH WITH `--jq`, because the raw listing is megabytes of issue BODIES and
  // `execFileSync` met it as `spawnSync gh ENOBUFS` -- loudly, which is the only reason this is a fixed
  // bug rather than a silent truncation. Four fields per row, one JSON object per line.
  const projected = run("gh", ["api", `repos/${REPO}/issues?state=all&per_page=100`, "--paginate",
    "--jq", '.[] | {number, state, isPullRequest: has("pull_request"), labels: [.labels[].name]}']);
  for (const line of projected.split("\n")) {
    if (line.trim() === "") continue;
    const issue = JSON.parse(line);
    if (!wanted.has(issue.number)) continue;
    rows.set(issue.number, { ...issue, state: String(issue.state).toUpperCase() });
  }
  return rows; // a number the listing never produced stays null: "#N does not exist", reported as a fact
}

/**
 * The claim HISTORY for a row, fetched only when its live labels carry no session.
 *
 * Closing a row strips its `session:` label, so for a finished row the live labels cannot say who worked
 * it -- 64 of 93 branches read UNKNOWN before this was added. The `labeled` event survives every close.
 * One call per row that needs it, never for a row that already answers.
 */
export function timelineFor(number, { run = defaultRun } = {}) {
  try {
    return JSON.parse(run("gh", ["api", `repos/${REPO}/issues/${number}/timeline`, "--paginate"]));
  } catch {
    return []; // a row whose timeline cannot be read is UNKNOWN, which is a weaker claim than a wrong owner
  }
}

/**
 * The counts alone, cheaply -- one git read plus one REST call. Taken at the START and again at the END
 * of a sweep, because the sweep itself takes about a minute and branches land during it.
 */
export function countsNow({ run = defaultRun } = {}) {
  const open = openPrHeads({ run });
  const all = branchesWithTips({ run });
  const noOpenPr = all.filter((b) => !open.has(b.branch));
  const ahead = noOpenPr.map((b) => aheadOf(b.branch, { run }));
  const unmerged = ahead.filter((n) => n > 0);
  return { candidates: all.length, noOpenPR: noOpenPr.length,
    merged: ahead.length - unmerged.length, unmerged: unmerged.length,
    commits: unmerged.reduce((a, b) => a + b, 0) };
}

/** The whole inventory: the four facts for every branch with no open PR and commits main lacks. */
export function inventory({ run = defaultRun } = {}) {
  const start = countsNow({ run });
  const open = openPrHeads({ run });
  const noOpenPr = branchesWithTips({ run }).filter((b) => !open.has(b.branch));
  const withAhead = noOpenPr.map((b) => ({ ...b, ahead: aheadOf(b.branch, { run }) }));
  const unmerged = withAhead.filter((b) => b.ahead > 0);
  const rows = rowsFor([...new Set(unmerged.map((b) => rowNumberFromBranch(b.branch)).filter((n) => n !== null))],
    { run });
  const timelines = new Map();
  for (const [number, row] of rows) {
    if (row !== null && sessionFromLabels(row.labels) === null) timelines.set(number, timelineFor(number, { run }));
  }
  // THE SECOND READ, and `reconcile` is what compares them. #623: "the count at the end reconciles with
  // the count at the start, or the difference is explained" -- a sum inside one read cannot do that, and
  // printing one under the word `reconcile` is what worker-judge refused on #1273.
  const end = countsNow({ run });
  return {
    counts: end,
    reconciliation: reconcile(start, end),
    facts: unmerged.map((b) => branchFacts({ ...b,
      row: rows.get(rowNumberFromBranch(b.branch)) ?? null,
      timeline: timelines.get(rowNumberFromBranch(b.branch)) ?? [] })),
  };
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "npm run branches:inventory" });
  const { counts, reconciliation, facts } = inventory();
  const drift = Object.entries(reconciliation.drift).filter(([, n]) => n !== 0)
    .map(([k, n]) => `${k} ${n > 0 ? "+" : ""}${n}`).join(", ");
  process.stdout.write(`Read ${new Date().toISOString()} from origin after \`git fetch --prune origin\`, so deleted branches are not counted.\n\n`
    + `branches on origin (excluding main): ${counts.candidates}\n`
    + `  with no OPEN PR:                   ${counts.noOpenPR}\n`
    + `    merged (0 commits main lacks):   ${counts.merged}\n`
    + `    UNMERGED:                        ${counts.unmerged} carrying ${counts.commits} commits\n`
    + `    partition: ${counts.merged} + ${counts.unmerged} = ${counts.merged + counts.unmerged}`
    + `${reconciliation.endBalanced ? "" : "  <- DOES NOT BALANCE"}\n`
    + `    reconcile (two reads, start vs end of this sweep): `
    + `${drift === "" ? "no drift -- nothing landed while this ran" : drift}\n\n`
    + `${renderInventory(facts)}\n`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
