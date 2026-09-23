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
//
// #2101: A ROW AND ITS OWN PULL REQUEST ARE ONE PIECE OF WORK, AND ONE PIECE OF WORK CANNOT COLLIDE WITH
// ITSELF. B4 compared a row's Region against EVERY open PR, its own included, so a PR opened before the
// claim -- the two in the wrong order -- made its own row permanently unclaimable by everybody, the
// session that would finish that PR included. Measured 2026-09-23: #2077 opened 32 seconds after #2076
// was filed, one file each side and the same file; the row sat `backlog` for 1h41m with a
// CHANGES_REQUESTED on its PR and nobody able to take either, and #2084/#2083 shelved behind the same
// file, until `product-manager` closed #2077 by hand. NEITHER ESCAPE THE REFUSAL NAMES EXISTS THERE:
// "sequence with that PR's author" names a bot account, and "narrow this row's region" is impossible when
// the Region is one file.
//
// SO THE EXCLUSION IS BY DECLARATION, NEVER BY GUESS. A PR is this row's own only when its body says
// `Closes #<this row>`, read by `extractClosesDeclaration` -- the same parser B7 already gates every merge
// on (#1966), so it is a field the org relies on rather than a convention invented here. A PR that
// declares NOTHING, or declares ANOTHER row, still collides exactly as before: B4's value is that it is
// unconditional about two SESSIONS touching one file, and this row is one `if` away from disabling it.
import { REPO } from "../../../../scripts/repo-identity.mjs";
import { extractClosesDeclaration } from "../acceptance-commands.mjs";
import { gh, lookup } from "../merge-guard/lookups.mjs";
import { declaredRegionFiles, regionCovers } from "../region-paths.mjs";

/** @type {(path: string) => boolean} */
const isChangeset = (path) => path.startsWith(".changeset/");

/**
 * #2101: THE ROWS A PULL REQUEST DECLARES IT CLOSES, as numbers -- `[]` for a body that declares nothing,
 * a `Closes: none` opt-out, or a malformed one. NO SECOND PARSER: `extractClosesDeclaration` is B7's own,
 * and a divergence between what B4 excludes and what the merge gate reads is exactly the drift that would
 * let a PR be its own row here and somebody else's row there.
 *
 * @param {string | null | undefined} body
 * @returns {number[]}
 */
export function declaredClosedRows(body) {
  const declaration = extractClosesDeclaration(body);
  return declaration.kind === "closes" ? declaration.numbers : [];
}

/**
 * #2101: is this open PR the row's OWN work? Only a declaration says so, and only about a row we were
 * actually told the number of -- an absent `rowNumber` excludes nothing, which is what keeps every caller
 * that does not know its row (and every existing test) refusing exactly as it did.
 *
 * `closes` is a LIST because a PR may declare several rows; a caller holding one may write it bare, which
 * is how the hand-run fixtures and Open-checks in the rows themselves are written.
 *
 * @param {{ number: number, closes?: number[] | number | null }} other
 * @param {number | null | undefined} rowNumber
 * @returns {boolean}
 */
function isOwnPrOf(other, rowNumber) {
  if (!Number.isInteger(rowNumber)) return false;
  const declared = Array.isArray(other.closes) ? other.closes
    : Number.isInteger(other.closes) ? [Number(other.closes)] : [];
  return declared.includes(Number(rowNumber));
}

/**
 * THE VERDICT, PURE.
 *
 * @param {string[]} myFiles this row's own declared Region paths -- files, and (#941) directory prefixes
 *   ending in `/` (changeset entries already excluded by
 *   the caller is NOT required -- this function excludes them itself, so either side can pass a raw list)
 * @param {{ number: number, files: string[], changedFiles: number, closes?: number[] | number | null }[]} otherPrFiles
 *   every OTHER open PR, its changed files, the count GitHub reports for them -- #1419: the list is only
 *   comparable when it matches the count -- and (#2101) the rows its body declares it closes
 * @param {{ rowNumber?: number | null }} [options] the number of the row being asked about, so its OWN
 *   pull request can be excluded (#2101). ABSENT EXCLUDES NOTHING: a caller that does not know which row
 *   it is comparing for gets the unconditional B4 of before.
 * @returns {{ reason: string | null, emptyOtherPrs: number[] }}
 */
export function fileOverlapReason(myFiles, otherPrFiles, { rowNumber = null } = {}) {
  const mine = new Set(myFiles.filter((p) => !isChangeset(p)));
  /** @type {number[]} */
  const emptyOtherPrs = [];
  if (mine.size === 0) return { reason: null, emptyOtherPrs };

  for (const other of otherPrFiles) {
    // #2101: BEFORE THE COMPARABILITY CHECK, not after. A row's own PR with a truncated file list would
    // otherwise be refused as NOT COMPARABLE -- the same deadlock arriving through #1419's door -- and
    // there is nothing to compare either way: this is the row's own work.
    if (isOwnPrOf(other, rowNumber)) continue;
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
 * #2101: and `body`, for the same reason -- ANOTHER FIELD ON THE CALL ALREADY BEING MADE, never another call. It
 * is what tells a row's own pull request from a competitor for its files.
 *
 * @param {{ run?: (args: string[]) => string, log?: (line: string) => void }} [deps]
 * @returns {{ number: number, files: string[], changedFiles: number, closes: number[] }[] | null}
 */
export function lookupOpenPrFiles({ run = gh, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  return lookup(() => {
    const raw = run(["pr", "list", "--repo", REPO, "--state", "open", "--json", "number,changedFiles,files,body"]);
    /** @type {{ number: number, changedFiles: number, files: { path: string }[], body?: string }[]} */
    const parsed = JSON.parse(raw);
    return parsed.map((pr) => {
      const listed = pr.files.map((f) => f.path);
      const files = listed.length < pr.changedFiles ? pagedPrFiles(pr.number, listed, { run, log }) : listed;
      return { number: pr.number, files, changedFiles: pr.changedFiles, closes: declaredClosedRows(pr.body) };
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
