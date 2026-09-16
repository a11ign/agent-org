#!/usr/bin/env node
// @ts-check
// RULE: DOES THIS ROW'S OWN REGION OVERLAP AN OPEN PR'S ACTUAL FILES? -- B4, #462.
//
// "No two open pull requests touch the same file." An intersection of changed-file lists, at claim time
// and at push time, naming the other PR -- no hotspot list to maintain, no registry, no judgement, and it
// catches the file nobody has flagged yet. It ALREADY found its first collision before it was built:
// `ceo` authorised a change to `.github/workflows/auto-arm.yml` while another PR held that exact file,
// two sessions independently intersected it, and #406 merged first with the second PR opened clear --
// no conflict was resolved, because none was allowed to happen.
//
// THE GATE IS USUALLY SILENT, so it cannot be validated by running it and watching it pass. Measured
// 2026-09-08T04:48:51Z: 4 open PRs, 23 files, ZERO pairwise overlap -- that is this check's normal
// reading, and a guard whose normal reading is silence is exactly the shape that shipped green against
// its own defect four times in this repository already. Its own test constructs the overlap.
//
// CHANGESET FILES ARE EXCLUDED, on both sides. Two PRs each adding their own `.changeset/*.md` do not
// collide; until A3 lands, treating them as a collision would block a dependency bump behind an unrelated
// script addition for no reason connected to this rule's own purpose.
//
// AN EMPTY FILE LIST IS REPORTED, NEVER FOLDED INTO "NO CONFLICT" -- #462's own finding: checking one PR's
// files and getting zero looked like "no overlap, proceed" and was actually a MERGED PR whose head had
// become an ancestor of `main`, so its diff read empty by construction. An OPEN PR reading zero files is
// the same shape and just as worth a second look, so it is surfaced as a diagnostic note rather than
// silently treated as clean -- never a hard refusal on its own, since a stale reading on someone ELSE's PR
// must not block every other claim in the queue.
//
// #1419: A LIST IS COMPARED WITH ITS OWN TOTAL BEFORE IT IS COMPARED WITH THE REGION. `gh pr list --json files` caps
// each PR's list at 100 and never says so. Measured on #1412 (113 changed files): the list returned its FIRST 100,
// every one a `.changeset/*.md`, so the changeset filter emptied it and every claim printed "#1412 reports ZERO
// changed files" -- while its 13 real files, `package.json` among them, sat at positions 101-113 and could never
// overlap anything. So the lookup reads each PR's `changedFiles` in the same call and pages REST `pulls/<n>/files`
// for any list shorter than it; and the rule REFUSES a PR whose list still does not match its count as NOT
// COMPARABLE, naming both numbers, rather than reading "no overlap". A PR whose count really is 0 is still only a note.
import { REPO } from "../../../../scripts/repo-identity.mjs";
import { gh, lookup } from "../merge-guard/lookups.mjs";
import { declaredRegionFiles, regionCovers } from "../region-paths.mjs";

/** @type {(path: string) => boolean} */
const isChangeset = (path) => path.startsWith(".changeset/");

/**
 * THE VERDICT, PURE.
 *
 * @param {string[]} myFiles this row's own declared Region paths -- files, and (#941) directory prefixes
 *   ending in `/` (changeset entries already excluded by
 *   the caller is NOT required -- this function excludes them itself, so either side can pass a raw list)
 * @param {{ number: number, files: string[], changedFiles: number }[]} otherPrFiles every OTHER open PR, its changed
 *   files, and the count GitHub reports for them -- #1419: the list is only comparable when it matches the count
 * @returns {{ reason: string | null, emptyOtherPrs: number[] }}
 */
export function fileOverlapReason(myFiles, otherPrFiles) {
  const mine = new Set(myFiles.filter((p) => !isChangeset(p)));
  /** @type {number[]} */
  const emptyOtherPrs = [];
  if (mine.size === 0) return { reason: null, emptyOtherPrs };

  for (const other of otherPrFiles) {
    if (!Number.isInteger(other.changedFiles) || other.files.length !== other.changedFiles) {
      return { emptyOtherPrs, reason: notComparableReason(other) };
    }
    // #1419: the empty-list path, decided explicitly. A PR whose OWN count is 0 is #462's shape (a merged head read as
    // an empty diff) and stays a note; a COMPLETE list that is all changesets simply cannot collide and is no note.
    if (other.changedFiles === 0) {
      emptyOtherPrs.push(other.number);
      continue;
    }
    const theirs = other.files.filter((p) => !isChangeset(p));
    if (theirs.length === 0) continue;
    // #941: an entry ending in `/` is a directory the row declared, and it covers every file under it.
    const overlap = theirs.filter((p) => [...mine].some((entry) => regionCovers(entry, p)));
    if (overlap.length > 0) {
      return {
        emptyOtherPrs,
        reason: `overlaps #${other.number}, which already touches: ${overlap.join(", ")}. B4: no two open `
          + "pull requests touch the same file -- sequence with that PR's author, or narrow this row's "
          + "region to what does not overlap.",
      };
    }
  }
  return { reason: null, emptyOtherPrs };
}

/**
 * #1419: WHY A PR CANNOT BE COMPARED, IN NUMBERS. A reader must be able to check both against GitHub.
 * @param {{ number: number, files: string[], changedFiles: number }} other
 * @returns {string}
 */
function notComparableReason(other) {
  const count = Number.isInteger(other.changedFiles) ? `its ${other.changedFiles} changed files` : "no changed-file count";
  return `cannot compare with #${other.number}: its file list came back with ${other.files.length} of ${count}, so B4 `
    + "cannot say whether this row overlaps it and refuses rather than reading \"no overlap\" (#1419). Retry once that "
    + "PR's list reads complete, or sequence with its author.";
}

/**
 * This row's own declared files, read from its issue body's `## Region` section -- #710: what this row
 * DECLARES it will change, never every path its prose merely mentions (a worked example, a fixture, a
 * quote of someone else's file). `null` on a failed lookup OR a body with no Region section at all -- the
 * caller (`sessionEligibilityReason`) already treats a `null` result as "cannot ask" and skips the
 * overlap check rather than refusing, so a genuinely Region-less row is never blocked over a comparison
 * it cannot make. `[]` for a Region section that names no source path (prose only) -- a real, comparable
 * answer, distinct from having nothing to read at all. A standalone directory line is a prefix since #941.
 *
 * @param {number} issueNumber
 * @param {{ run?: (args: string[]) => string }} [deps]
 * @returns {string[] | null}
 */
export function lookupMyRegionFiles(issueNumber, { run = gh } = {}) {
  return lookup(() => {
    const raw = run(["issue", "view", String(issueNumber), "--repo", REPO, "--json", "body"]);
    /** @type {{ body?: string }} */
    const parsed = JSON.parse(raw);
    return declaredRegionFiles(parsed.body ?? "");
  });
}

/**
 * Every OTHER open PR and its changed files, in ONE bulk call -- `gh pr list --json files` returns every
 * open PR's diff in a single round trip, so this never loops per PR the way a naive port of `gh pr view
 * <n> --json files` would. `null` on a failed lookup.
 *
 * #1419: the same call also reads each PR's `changedFiles`, and a list shorter than it is paged through REST, which
 * returns every file. Only a short PR costs that extra call.
 *
 * @param {{ run?: (args: string[]) => string, log?: (line: string) => void }} [deps]
 * @returns {{ number: number, files: string[], changedFiles: number }[] | null}
 */
export function lookupOpenPrFiles({ run = gh, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  return lookup(() => {
    const raw = run(["pr", "list", "--repo", REPO, "--state", "open", "--json", "number,changedFiles,files"]);
    /** @type {{ number: number, changedFiles: number, files: { path: string }[] }[]} */
    const parsed = JSON.parse(raw);
    return parsed.map((pr) => {
      const listed = pr.files.map((f) => f.path);
      const files = listed.length < pr.changedFiles ? pagedPrFiles(pr.number, listed, { run, log }) : listed;
      return { number: pr.number, files, changedFiles: pr.changedFiles };
    });
  });
}

/**
 * #1419: EVERY FILE OF ONE PR, THROUGH REST's PAGES. A failure here keeps the short list and says so: letting it throw
 * would make `lookup` return null for the whole read, and a null read skips B4 entirely -- the defect this row fixes,
 * arriving by a different door. The short list then reaches the rule, which refuses it as not comparable.
 * @param {number} number @param {string[]} listed
 * @param {{ run: (args: string[]) => string, log: (line: string) => void }} deps
 * @returns {string[]}
 */
function pagedPrFiles(number, listed, { run, log }) {
  try {
    return run(["api", "--paginate", `repos/${REPO}/pulls/${number}/files?per_page=100`, "--jq", ".[].filename"])
      .split("\n").filter(Boolean);
  } catch (error) {
    log(`row-claim: could not page #${number}'s files past ${listed.length} (${/** @type {Error} */ (error).message}) `
      + "-- B4 will refuse it as not comparable (#1419).");
    return listed;
  }
}
