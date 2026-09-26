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
//
// #2493: A HELD PR THAT IS WAITING ON THIS ROW CANNOT MERGE FIRST, SO IT IS NOT A COMPETITOR EITHER. #2399 was
// refused for a file #2376 held, and #2376 was waiting on #2399: it declared `Closes #2359`, so it was a stranger
// to the asking row, and the wait lived in a comment nothing reads. The exclusion needs BOTH facts (`ceo`, #2400
// section 2), because either alone is a hole: a `hold:` label with no edge is a PR that may still merge when the
// hold lifts, and an edge with no hold is a PR that `deliberateRefusals` will let merge first. See
// `isHeldPrWaitingOn`. The gate reads the same two facts (`work-gate.mjs`'s `blockedOnOpenPr`).
//
// #2617 (child 3b of #69): B4 READS EVERY CODE REPOSITORY THE PROJECT DECLARES, NOT THE FIRST. "No two open pull requests touch the
// same file" is a claim about the PROJECT's open work, and the project's work is in every repository `.agent-org/project.json`'s
// `code` lists (a layer repository's pull requests hold files a row of the tracker's Region can name, `nvda-worker:src/x.ts`).
// THE FIRST REPOSITORY'S ENTRIES ARE UNCHANGED IN SHAPE -- no `repo`, no `repoKey` -- so every reader written for one repository, and
// every fixture, sees what it always saw; an entry from another repository carries both, and a refusal names the repository as well
// as the pull request, because `#7` alone would name two different pull requests.
// A REPOSITORY THAT CANNOT BE READ MAKES THE WHOLE READ `null`, which every caller already reads as INCONCLUSIVE and never as "no
// overlap": a second repository that fails must not become a quiet pass on the strength of the first one answering. It says WHICH one.
import { REPO } from "../project-identity.mjs";
import { homeProjectDeclaration } from "../project-config.mjs";
import { extractClosesDeclaration, closesReferences } from "../acceptance-commands.mjs";
import { gh, lookup } from "../merge-guard/lookups.mjs";
import { holdersOf } from "../pr-hold-state.mjs";
import { declaredRegionFiles, regionCoversIn, splitRegionEntry } from "../region-paths.mjs";
import { lookupBlockedByEdge } from "./blocked-by-edge-rule.mjs";

/** @type {(path: string) => boolean} */
const isChangeset = (path) => path.startsWith(".changeset/");

/** #2617: the tracker the project's own rows live in -- the first entry, which the empty key names (ADR 0040, decision 2). */
const primaryTrackerRepo = () => homeProjectDeclaration().tracker[0].repo;

/**
 * #2101: THE ROWS A PULL REQUEST DECLARES IT CLOSES, as numbers -- `[]` for a body that declares nothing,
 * a `Closes: none` opt-out, or a malformed one. NO SECOND PARSER: `extractClosesDeclaration` is B7's own,
 * and a divergence between what B4 excludes and what the merge gate reads is exactly the drift that would
 * let a PR be its own row here and somebody else's row there.
 *
 * #2617: ONLY THE ROWS OF `trackerRepo`. A bare `#7` names an issue of the PULL REQUEST'S OWN repository (`prRepo`) and
 * `owner/repo#7` names that repository's, so a pull request of a layer repository that says `Closes #7` closes ITS #7 -- not the
 * tracker's row 7 -- and must not be excused from a claim on that row. Both default to the project's first, so a body that names
 * no repository, read for the first repository, returns what it always did.
 *
 * @param {string | null | undefined} body
 * @param {{ prRepo?: string, trackerRepo?: string }} [where] the repository the body is on, and the tracker whose rows are asked about
 * @returns {number[]}
 */
export function declaredClosedRows(body, { prRepo = REPO, trackerRepo = primaryTrackerRepo() } = {}) {
  const declaration = extractClosesDeclaration(body);
  if (declaration.kind !== "closes") return [];
  return closesReferences(declaration)
    .filter((reference) => (reference.repo ?? prRepo) === trackerRepo)
    .map((reference) => reference.number);
}

/**
 * The rows a listed PR declares it closes. `closes` is a LIST because a PR may declare several rows; a
 * caller holding one may write it bare, which is how the hand-run fixtures and Open-checks in the rows
 * themselves are written.
 *
 * @param {{ closes?: number[] | number | null }} other
 * @returns {number[]}
 */
function closedRowsOf(other) {
  if (Array.isArray(other.closes)) return other.closes;
  return Number.isInteger(other.closes) ? [Number(other.closes)] : [];
}

/**
 * #2101: is this open PR the row's OWN work? Only a declaration says so, and only about a row we were
 * actually told the number of -- an absent `rowNumber` excludes nothing, which is what keeps every caller
 * that does not know its row (and every existing test) refusing exactly as it did.
 *
 * @param {{ number: number, closes?: number[] | number | null }} other
 * @param {number | null | undefined} rowNumber
 * @returns {boolean}
 */
function isOwnPrOf(other, rowNumber) {
  if (!Number.isInteger(rowNumber)) return false;
  return closedRowsOf(other).includes(Number(rowNumber));
}

/**
 * #2493: is this overlapping PR HELD AND WAITING ON THE ASKING ROW -- so it cannot merge first, and B4's
 * "sequence with that PR's author" would name somebody who is waiting on you?
 *
 * BOTH FACTS, NEVER ONE (`ceo`, #2400 section 2): (a) a `hold:` label, so `deliberateRefusals` will not let
 * it merge, AND (b) every row it closes is `blockedBy` the asking row, the edge being the data GitHub already
 * has and the thing `blocker-cleared` wakes the holder on. An unheld PR on the same file is a real collision.
 *
 * `every` IS VACUOUSLY TRUE OF AN EMPTY LIST, and a held PR declaring `Closes: none` closes nothing and so
 * waits on nothing: the empty case is refused HERE, by name, rather than left to fall out of `every`.
 * `blockersOf` answers `null` when the lookup failed, and a failed lookup reads as NOT excluded -- the
 * refusal stands -- because the exclusion is the one thing here that lets a claim through.
 *
 * WHO ANSWERS "WHAT BLOCKS THAT ROW": the caller's `blockersOf` option (the gate, from the rows it already read), else
 * the PR's own `blockersOf` (a held PR out of `lookupOpenPrFiles` carries a lazy one over the same `run`, so the claim,
 * `check` and the spawn filter get the exclusion without each having to be edited to ask for it).
 *
 * @param {{ held?: boolean, closes?: number[] | number | null, blockersOf?: (row: number) => number[] | null }} other
 * @param {number | null | undefined} rowNumber
 * @param {((row: number) => number[] | null) | undefined} blockersOf the rows blocking a given row, or `null`
 * @returns {boolean}
 */
function isHeldPrWaitingOn(other, rowNumber, blockersOf) {
  const resolve = blockersOf ?? other.blockersOf;
  if (other.held !== true || !Number.isInteger(rowNumber) || typeof resolve !== "function") return false;
  const closed = closedRowsOf(other);
  if (closed.length === 0) return false;
  return closed.every((row) => resolve(row)?.includes(Number(rowNumber)) === true);
}

/**
 * THE VERDICT, PURE.
 *
 * @param {string[]} myFiles this row's own declared Region paths -- files, and (#941) directory prefixes
 *   ending in `/` (changeset entries already excluded by
 *   the caller is NOT required -- this function excludes them itself, so either side can pass a raw list)
 * @param {{ number: number, files: string[], changedFiles: number, closes?: number[] | number | null,
 *   held?: boolean, blockersOf?: (row: number) => number[] | null, repo?: string, repoKey?: string }[]} otherPrFiles
 *   every OTHER open PR, its changed files, the count GitHub reports for them -- #1419: the list is only
 *   comparable when it matches the count -- (#2101) the rows its body declares it closes, and (#2493)
 *   whether it carries a `hold:` label. (#2617) `repo` and `repoKey` are on a pull request of any repository but the first: ABSENT
 *   IS THE FIRST'S (the empty key), and a Region entry is compared only with the files of the repository it is prefixed for
 * @param {{ rowNumber?: number | null, blockersOf?: (row: number) => number[] | null }} [options] the number
 *   of the row being asked about, so its OWN pull request can be excluded (#2101). ABSENT EXCLUDES NOTHING: a
 *   caller that does not know which row it is comparing for gets the unconditional B4 of before.
 *   `blockersOf` (#2493) is asked ONLY for a held PR that overlaps, and ABSENT EXCLUDES NOTHING likewise.
 * @returns {{ reason: string | null, emptyOtherPrs: (number | string)[] }} a number for a pull request of the first repository, `owner/repo#N` for another's
 */
export function fileOverlapReason(myFiles, otherPrFiles, { rowNumber = null, blockersOf } = {}) {
  const mine = new Set(myFiles.filter((p) => !isChangeset(splitRegionEntry(p).path)));
  /** @type {(number | string)[]} */
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
      emptyOtherPrs.push(other.repo === undefined ? other.number : `${other.repo}#${other.number}`);
      continue;
    }
    const theirs = other.files.filter((p) => !isChangeset(p));
    if (theirs.length === 0) continue;
    // #941: an entry ending in `/` is a directory the row declared, and it covers every file under it.
    // #2617: an entry is compared only with the files of the repository it is prefixed for (a bare one is the first's).
    const overlap = theirs.filter((p) => [...mine].some((entry) => regionCoversIn(entry, other.repoKey ?? "", p)));
    // #2493: AFTER THE OVERLAP IS KNOWN, so the closed rows' `blockedBy` is read only for a held PR that
    // actually collides -- the one read this exclusion is allowed to add.
    if (overlap.length > 0 && isHeldPrWaitingOn(other, rowNumber, blockersOf)) continue;
    if (overlap.length > 0) {
      return {
        emptyOtherPrs,
        reason: `overlaps ${prName(other)}, which already touches: ${overlap.join(", ")}. B4: no two open `
          + "pull requests touch the same file -- sequence with that PR's author, or narrow this row's "
          + "region to what does not overlap.",
      };
    }
  }
  return { reason: null, emptyOtherPrs };
}

/**
 * #2617: A PULL REQUEST'S NAME IN A REFUSAL -- `#7` for the first repository's, which is what every refusal has always said, and
 * `#7 in owner/repo` for another's, because two repositories both have a #7 and a bare number would name either.
 * @param {{ number: number, repo?: string }} pr
 * @returns {string}
 */
function prName(pr) {
  return pr.repo === undefined ? `#${pr.number}` : `#${pr.number} in ${pr.repo}`;
}

/**
 * #1419: WHY A PR CANNOT BE COMPARED, IN NUMBERS. A reader must be able to check both against GitHub.
 * @param {{ number: number, files: string[], changedFiles: number, repo?: string }} other
 * @returns {string}
 */
function notComparableReason(other) {
  const count = Number.isInteger(other.changedFiles) ? `its ${other.changedFiles} changed files` : "no changed-file count";
  return `cannot compare with ${prName(other)}: its file list came back with ${other.files.length} of ${count}, so B4 `
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
 * #2617: the row is read from `repo`, the TRACKER it lives in (default the first), and its entries may carry a repository prefix
 * (`nvda-worker:src/x.ts`) -- returned as written, for `fileOverlapReason` to place. One `gh` call, whatever the repositories.
 *
 * @param {number} issueNumber
 * @param {{ run?: (args: string[]) => string, repo?: string }} [deps]
 * @returns {string[] | null}
 */
export function lookupMyRegionFiles(issueNumber, { run = gh, repo = REPO } = {}) {
  return lookup(() => {
    const raw = run(["issue", "view", String(issueNumber), "--repo", repo, "--json", "body"]);
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
 * #2617: THAT CALL IS MADE ONCE PER DECLARED CODE REPOSITORY (`repos`, default `.agent-org/project.json`'s `code`), the first's entries
 * first. A claim's whole B4 read is therefore `1 + (repositories)` `gh` calls -- the row's own Region and one `pr list` each -- plus
 * one REST page per pull request whose list came back short (#1419) and one `blockedBy` read per held pull request that overlaps
 * (#2493). `trackerRepo` is whose rows a body's `Closes` is read against (see {@link declaredClosedRows}).
 *
 * @param {{ run?: (args: string[]) => string, log?: (line: string) => void,
 *   repos?: readonly { key: string, repo: string }[], trackerRepo?: string }} [deps]
 * #2493: and `labels`, on that same call, for whether the PR is held.
 *
 * A HELD PR ALSO CARRIES `blockersOf`, lazy and over this same `run`, so every caller of the rule that got its PRs
 * from here can ask the one question the exclusion needs and no caller has to remember to pass it. It is CALLED only
 * for a held PR that overlaps (`fileOverlapReason`); merely carrying it costs nothing.
 *
 * @returns {{ number: number, files: string[], changedFiles: number, closes: number[], held: boolean,
 *   blockersOf?: (row: number) => number[] | null }[] | null}
 */
export function lookupOpenPrFiles({ run = gh, log = (line) => process.stderr.write(`${line}\n`),
  repos = homeProjectDeclaration().code, trackerRepo = primaryTrackerRepo() } = {}) {
  return lookup(() => repos.flatMap(({ key, repo }) => openPrsOf({ key, repo }, { run, log, trackerRepo })));
}

/**
 * #2617: ONE REPOSITORY'S OPEN PULL REQUESTS, in the shape `fileOverlapReason` reads. A failed read is said aloud WITH the repository
 * and re-thrown, so the caller's `lookup` makes the whole read `null` -- INCONCLUSIVE -- and the line says which repository it was:
 * with two, "the open pull requests could not be read" no longer says which half a person should go and look at.
 * @param {{ key: string, repo: string }} where
 * @param {{ run: (args: string[]) => string, log: (line: string) => void, trackerRepo: string }} deps
 */
function openPrsOf({ key, repo }, { run, log, trackerRepo }) {
  /** @type {string} */
  let raw;
  try {
    raw = run(["pr", "list", "--repo", repo, "--state", "open", "--json", "number,changedFiles,files,body,labels"]);
  } catch (error) {
    log(`row-claim: could not read ${repo}'s open pull requests (${String(/** @type {Error} */ (error).message).split("\n")[0]}) `
      + "-- B4 is INCONCLUSIVE, never \"no overlap\" (#2617).");
    throw error;
  }
  /** @type {{ number: number, changedFiles: number, files: { path: string }[], body?: string, labels?: { name: string }[] }[]} */
  const parsed = JSON.parse(raw);
  return parsed.map((pr) => {
    const listed = pr.files.map((f) => f.path);
    const files = listed.length < pr.changedFiles ? pagedPrFiles(pr.number, listed, { run, log, repo }) : listed;
    const held = holdersOf((pr.labels ?? []).map((l) => l.name)).length > 0;
    const entry = { number: pr.number, files, changedFiles: pr.changedFiles,
      closes: declaredClosedRows(pr.body, { prRepo: repo, trackerRepo }), held };
    const located = key === "" ? entry : { ...entry, repo, repoKey: key };
    return held ? { ...located, blockersOf: lookupBlockersOf({ run, repo: trackerRepo }) } : located;
  });
}

/**
 * #1419: EVERY FILE OF ONE PR, THROUGH REST's PAGES. A failure here keeps the short list and says so: letting it throw
 * would make `lookup` return null for the whole read, and a null read skips B4 entirely -- the defect this row fixes,
 * arriving by a different door. The short list then reaches the rule, which refuses it as not comparable.
 * @param {number} number @param {string[]} listed
 * @param {{ run: (args: string[]) => string, log: (line: string) => void, repo: string }} deps
 * @returns {string[]}
 */
function pagedPrFiles(number, listed, { run, log, repo }) {
  try {
    return run(["api", "--paginate", `repos/${repo}/pulls/${number}/files?per_page=100`, "--jq", ".[].filename"])
      .split("\n").filter(Boolean);
  } catch (error) {
    log(`row-claim: could not page #${number}'s files past ${listed.length} (${/** @type {Error} */ (error).message}) `
      + "-- B4 will refuse it as not comparable (#1419).");
    return listed;
  }
}

/**
 * #2493: THE ROWS BLOCKING A GIVEN ROW, read from GitHub's own `blockedBy` edge, for a caller that holds no
 * rows of its own (the claim, `check`, the spawn filter, all of which reach it through `lookupOpenPrFiles`). One
 * `gh issue view` per call, and `fileOverlapReason` makes a call only for a held PR that overlaps. `null` on a
 * failed lookup, which the rule reads as "not excluded". The gate does not use this: it already holds `blockedBy`
 * for every open row.
 *
 * #2617: `repo` is the TRACKER whose rows are asked about (default the first).
 *
 * @param {{ run?: typeof gh, repo?: string }} [deps]
 * @returns {(row: number) => number[] | null}
 */
export function lookupBlockersOf({ run = gh, repo = REPO } = {}) {
  return (row) => {
    const read = lookupBlockedByEdge(row, { run, repo });
    return read === null ? null : (read.blockedBy?.nodes ?? []).map((n) => Number(n.number));
  };
}
