#!/usr/bin/env node
// @ts-check
// EVERY REPO-RELATIVE PATH NAMED IN A ROW'S PROSE -- a LEAF module, deliberately: no other import in this
// tree, so anything reaching for this one fact does not also drag in whatever else its original owner
// needed.
//
// This started life inside `row-reachability.mjs`, and moving it here (#462, B4) is not a style choice:
// `row-claim/file-overlap-rule.mjs` needs the identical extraction -- a row's Region must mean the same
// set of files to both tools, or the fact-stated-twice shape recurs with a second regex that can disagree
// about what counts as a path -- but `row-reachability.mjs` itself imports
// `@a11ign/worker-fleet/cli-flags` (a package specifier, fine for its own CLI parsing, fatal before
// `npm ci`/`npm run build`) for its own `main()`. Importing `regionPathsFromBody` FROM that file would
// have pulled that specifier into `row-claim.mjs`'s own import graph, which is reachable from a
// pre-install entry: `pre-install-import-graph.test.ts` caught exactly this the first time it was tried.
// `row-reachability.mjs` was also built to run as a SEPARATE PROCESS on purpose (see its own header on
// `reportReachability`) precisely so importing it would not become the default; reaching into it for one
// regex would have quietly defeated that.

// The one import, and it stays leaf-shaped: `git-env.mjs` imports nothing itself, so `row-claim.mjs`'s
// pre-install import graph gains no package specifier. Every git spawn in this repo scrubs `GIT_*`
// (`git-spawn-classification.test.ts`), including a read-only one: an inherited `GIT_DIR` would have this
// module list another repository's root files and report on them as though they were ours.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sandboxGitEnv } from "../../guards/src/git-env.mjs";

/**
 * The repository's own top-level directories, from git rather than from a list.
 *
 * #1158: `PATH_IN_PROSE` carried `packages|scripts|docs|\.github` as literals, so a Region naming
 * `.claude/rules/agent-practices.md` **inline** declared NOTHING while the same path **fenced** declared
 * normally -- two spellings of one intent, disagreeing in silence. `row-file` accepted the row, the author
 * saw their path in the body, and B4 reserved nothing.
 *
 * **Adding `.claude` to the list would fix today and rebuild the trap for the next directory**, which is
 * exactly what happened between #975 and this. So the list is derived: a directory exists in this repo or
 * it does not, and that question has an answer git can give.
 *
 * Memoised on first use -- one `ls-files` per process, and this module is imported by a dozen test files.
 * @returns {string[]}
 */
/** @type {string[] | null} */
let topLevelCache = null;
export function trackedTopLevelDirs() {
  if (topLevelCache) return topLevelCache;
  const out = execFileSync("git", ["ls-files"], { encoding: "utf8", env: sandboxGitEnv() });
  const dirs = new Set();
  for (const line of out.split("\n")) {
    const slash = line.indexOf("/");
    if (slash > 0) dirs.add(line.slice(0, slash));
  }
  topLevelCache = [...dirs].sort();
  return topLevelCache;
}

/** Repo-relative source paths named anywhere in a row's prose — its Region, and whatever else it cites. */
export function pathInProse() {
  const alts = trackedTopLevelDirs().map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(?:^|[\\s\`"'(])((?:${alts})\\/[A-Za-z0-9/_.-]+\\.[A-Za-z]{2,4})`, "g");
}

/**
 * #1186: DIRECTORY ENTRIES IN A REGION, AND HOW MANY FILES EACH ONE RESERVES.
 *
 * A `/`-terminated entry is a DECLARATION OF EVERY FILE BENEATH IT -- `regionCovers` has a directory
 * branch and B4 uses it (`file-overlap-rule.mjs:56`, per #941, deliberately). So `packages/` in a Region
 * refuses any row whose PR touches anything under `packages/` for as long as that row is open.
 *
 * **That is not a no-op, it is a blanket reservation, and it reads as a small Region.** A one-line Region
 * that reserves a thousand files looks exactly like one that reserves one -- which is why the COUNT is the
 * message rather than the fact: the author's error is not knowing the scope they claimed, and telling them
 * it is a directory tells them nothing they did not type.
 *
 * The row was filed with the cause inverted -- that a directory claims NOTHING -- because the instrument
 * was `region.includes(f)`, plain string equality, standing in for `regionCovers`. Both readings produce
 * the same `declaredRegionFiles` output, so nothing about that output could have separated them.
 *
 * THIS DOES NOT CHANGE B4. `file-overlap-rule.mjs` is correct and is out of this row's Region; the fix is
 * at declaration time, where #1158 put the surfacing of a path the parser cannot place.
 *
 * @param {string} body a row body
 * @param {(prefix: string) => number} [countUnder] how many tracked files sit under a prefix
 * @returns {{entry: string, files: number}[]}
 */
export function directoryReservations(body, countUnder = trackedFilesUnder) {
  return (declaredRegionFiles(body) ?? [])
    .filter((entry) => entry.endsWith("/"))
    .map((entry) => ({ entry, files: countUnder(entry) }));
}

/**
 * #1193: A DIRECTORY DECLARED WITHOUT ITS TRAILING SLASH RESERVES NOTHING, AND NOTHING SAYS SO.
 *
 * `directoryReservations` keys on the slash, because that is what `regionCovers` keys on -- so
 * `packages/lab/src/training` is declared, reserves NOTHING, and is not reported stray either, since
 * `declaredRegionFiles` did take it. **Both guards are satisfied and the author reserved nothing.**
 *
 * It is the spelling an author reaches by FOLLOWING THE OTHER WARNING. Before #1193 the stray check
 * reported the slash-less form of every declared directory; the obvious way to satisfy *"declares
 * NOTHING: packages/lab"* is to drop the slash, which lands on the one cell with no witness at all.
 * A refusal that is followable and wrong to follow is worse than one that is merely unclear.
 *
 * Not folded into `unrecognisedRegionPaths`: that answers "nothing took this", and something did.
 * The two failures are different and a caller may want one without the other.
 *
 * @param {string} body a row body
 * @param {(entry: string) => boolean} [isDirectory] does this entry name a tracked directory
 * @returns {string[]} declared entries that name a directory but do not end in `/`
 */
export function slashlessDirectoryEntries(body, isDirectory = namesTrackedDirectory) {
  return (declaredRegionFiles(body) ?? []).filter(
    (entry) => !entry.endsWith("/") && isDirectory(entry),
  );
}

/**
 * Does `entry` name a tracked DIRECTORY rather than a file? Asked as "are there tracked files beneath
 * it", so a path that is itself a tracked file answers false -- `packages/agent-org/src/row-file.mjs/` holds nothing.
 * @param {string} entry @returns {boolean}
 */
function namesTrackedDirectory(entry) {
  return trackedFilesUnder(`${entry}/`) > 0;
}

/**
 * How many tracked files sit under `prefix`. Injected in tests so the count is not a corpus read.
 * @param {string} prefix @returns {number}
 */
function trackedFilesUnder(prefix) {
  try {
    const out = execFileSync("git", ["ls-files", "--", prefix],
      { encoding: "utf8", env: sandboxGitEnv() });
    return out.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Something in the Region that LOOKS like a repo path and that nothing declared.
 *
 * #1158 clause 3, and the clause that matters: **the failure mode is silence.** A Region that declares
 * less than it says must say so -- the author reads their own path back out of the body and believes it
 * is declared, and nothing in the tooling disagrees with them.
 *
 * Deliberately separate from the derivation above, so the two fail independently: deriving the prefixes
 * fixes every directory that EXISTS, and this catches the rest -- a typo, a path in a repo that is not
 * this one, a file moved since the row was filed.
 *
 * @param {string} body a row body
 * @returns {string[]} path-shaped tokens in the Region that `declaredRegionFiles` did not take
 */
export function unrecognisedRegionPaths(body) {
  const section = extractRegionSection(body);
  if (section === null) return [];
  const declared = new Set(declaredRegionFiles(body) ?? []);
  const shaped = section.matchAll(/(?:^|[\s`"'(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/g);
  /** @type {string[]} */
  const out = [];
  for (const [, token] of shaped) {
    if (declared.has(token)) continue;
    // #1193: THE TOKEN IS THE DECLARED DIRECTORY, MINUS ITS SLASH. The shape above ends each path at a
    // path SEGMENT (`\/[A-Za-z0-9_.-]+`), so it cannot capture a trailing slash: `packages/lab/` is read
    // out as `packages/lab`. That is a different string from the declaration, so neither test below saw
    // it -- `startsWith` fails because the token is SHORTER than the prefix -- and every directory Region
    // that reserved anything was also told it declared nothing. Measured at the time: 13 of 15 open rows.
    //
    // Only the eight tracked top-level names escaped, and not by being handled: `docs/` has no segment
    // after the slash, so the shape never matched it at all. The two cells that looked correct were the
    // two the instrument could not see.
    if (declared.has(`${token}/`)) continue;
    if ([...declared].some((d) => d.endsWith("/") && token.startsWith(d))) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * #975: A ROOT-LEVEL FILE NAMED IN A REGION IS A DECLARATION -- `package.json`, `CLAUDE.md`, `README.md`.
 *
 * `PATH_IN_PROSE` needs one of four prefixes, so a Region naming the repository's most-edited files declared
 * NOTHING for them and the claim-time overlap check was blind to them. Measured on 2026-09-11: 10 of 66 open
 * rows named a root file the parser dropped, found while matching #921's Region to PR #973.
 *
 * ANCHORED TO THE TREE, not to "any word with a dot". A candidate counts only when `origin/main` has a file
 * of that name at the root, so `evidence.json` in prose about a capture declares nothing, while
 * `eslint.config.js` does. That is the same discipline `DIRECTORY_ITEM` has: a rule a person can check against
 * something real, rather than a shape that happens to look like a path.
 */
const ROOT_FILE_CANDIDATE = /(?:^|[\s`"'([])([A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z0-9]{1,10})(?=$|[\s`"',.;:)\]])/g;

/** @typedef {{ files: Set<string>, source: "origin/main" | "HEAD" | null }} RootFileReading */

/** @type {RootFileReading | null} Only a SUCCESSFUL reading is memoised -- see `rootFilesOnMain`. */
let rootFilesReading = null;

/**
 * The files the repository has at its root, AND WHICH REF ANSWERED -- #995.
 *
 * `origin/main` rather than the working tree: a Region declares a file of THIS project, and an untracked
 * scratch file beside the checkout is not one. It falls back to `HEAD` (a clone with no `origin/main` ref,
 * which a fresh worktree can be mid-fetch), then to nothing.
 *
 * ## Why it returns the SOURCE and not just the files
 *
 * It used to return a bare `Set`, so **a fallback read, a failed read and a successful read of a tree with
 * no root files were the same value.** A caller could not tell "this repository has no root-level files"
 * -- which cannot happen here; there are eleven -- from "I could not ask." The empty answer then silently
 * declared that no Region names a root-level file, which is the exact state #975 had just fixed the parser
 * to avoid. A guard that skips quietly is indistinguishable from one that never ran, and this repository
 * has recorded that shape four times.
 *
 * `source` is `null` only when NOTHING answered. A caller that needs to know can ask; `declaredRegionFiles`
 * does not, because its own contract is unchanged either way -- but the fact now exists to be asserted, and
 * `region-paths.test.ts` asserts it.
 *
 * ## Why a FAILED reading is not memoised
 *
 * The memo was on the value, and `new Set()` is truthy -- so one failed read poisoned the process: every
 * later call returned the cached empty set without retrying, and every root file stayed undeclarable for
 * the life of that process. A worktree read mid-fetch, or a `git` that failed once, was permanent. Only a
 * reading with a source is cached now; a failure is re-asked next call.
 *
 * ## Why a SUCCESSFUL reading is still memoised
 *
 * Measured on this checkout: `git ls-tree origin/main --` costs **25.1 ms** per call (20 calls). A claim
 * check reads several rows' Regions, and `row-reachability` reads every open row's -- 67 of them tonight,
 * which is 1.7 s of git for an answer that cannot change while the process runs, since the ref is
 * `origin/main` and not the working tree. A tree that gains a root file mid-process is a test writing a
 * fixture, which is why the reading is exported: a test passes its own `rootFiles` rather than fighting a
 * memo, and `declaredRegionFiles` has taken that option since #975.
 * `repoRoot` exists so the failure path can be DRIVEN rather than stubbed: point it at a directory git
 * cannot answer about and the reading really does come back with no source, through the same `execFileSync`
 * every other call uses. A stub would prove the branch is reachable, not that git's refusal reaches it.
 * @param {{ repoRoot?: string }} [options]
 * @returns {RootFileReading}
 */
export function rootFilesOnMain({ repoRoot } = {}) {
  if (rootFilesReading && repoRoot === undefined) return rootFilesReading;
  const repo = repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  for (const ref of /** @type {const} */ (["origin/main", "HEAD"])) {
    try {
      const listing = execFileSync("git", ["ls-tree", ref, "--"],
        { cwd: repo, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const names = listing.split("\n")
        .filter((line) => line.includes(" blob "))
        .map((line) => line.slice(line.indexOf("\t") + 1).trim())
        .filter(Boolean);
      if (names.length === 0) continue;
      const reading = { files: new Set(names), source: ref };
      // The memo is for THIS repository's own reading; a caller that named a root is asking about a
      // different tree and must not fill, or read, the cache.
      return repoRoot === undefined ? (rootFilesReading = reading) : reading;
    } catch (error) {
      void error; // an unreadable ref is "cannot say", and the next one may answer
    }
  }
  // NOT MEMOISED. "Nothing answered" is a fact about this moment -- a fetch in flight, a git that failed
  // once -- and caching it would make one bad moment permanent for the process.
  return { files: new Set(), source: null };
}

/**
 * Every repo-relative path named anywhere in an issue's body text, deduplicated. `.matchAll` needs a
 * fresh regex state each call, hence a plain module-level constant with the global flag is safe here:
 * `matchAll` does not mutate `lastIndex` on the source regex.
 * @param {string} body
 * @returns {string[]}
 */
export function regionPathsFromBody(body) {
  return [...new Set([...body.matchAll(pathInProse())].map((m) => m[1]))];
}

// #710: `## Region` (any heading level, optional trailing colon and inline text) or a bare `Region:` /
// `**Region:**` line -- both seen in real issue bodies (compare #621's `## Region` heading against this
// row's own trailing `Region: ...` line). A markdown heading line, matched separately, is what bounds a
// heading-form Region section: the text runs until the next one or the end of the body.
const REGION_HEADING = /^\s*#{1,6}\s*Region\s*:?\s*(.*)$/i;
const REGION_INLINE = /^\s*(?:\*\*|__)?Region:(?:\*\*|__)?\s*(.*)$/i;
const MARKDOWN_HEADING = /^\s*#{1,6}\s+\S/;

/**
 * Every line after `startIndex`, up to (not including) the next markdown heading or the end.
 * @param {string[]} lines
 * @param {number} startIndex
 * @returns {string[]}
 */
function linesUntilNextHeading(lines, startIndex) {
  const rest = [];
  for (const later of lines.slice(startIndex)) {
    if (MARKDOWN_HEADING.test(later)) break;
    rest.push(later);
  }
  return rest;
}

/**
 * #710: the raw text of a row's OWN declared `## Region` (or inline `Region:`) section, or `null` when
 * the body has no Region section at all. Deliberately returns text, not paths -- `declaredRegionFiles`
 * (below) runs `regionPathsFromBody` over exactly this substring, so a Region section and a whole body
 * are read by the identical path grammar and can never disagree about what counts as a path.
 * @param {string} body
 * @returns {string | null}
 */
export function extractRegionSection(body) {
  const lines = body.split(/\r\n|\r|\n/);
  for (const [index, line] of lines.entries()) {
    const heading = REGION_HEADING.exec(line);
    if (heading) {
      const inline = heading[1].trim();
      return inline.length > 0 ? inline : linesUntilNextHeading(lines, index + 1).join("\n");
    }
    const plain = REGION_INLINE.exec(line);
    if (plain) return plain[1].trim();
  }
  return null;
}

/**
 * #941: a STANDALONE directory item -- a whole line, or a whole item of a list on one line (split at `,`,
 * `;`, `and`, `or`), that is exactly one path ending in `/`, bar a list bullet or backticks. `PATH_IN_PROSE`
 * needs a file extension, so `packages/control/ansible/` never matched it and vanished: on 2026-09-11, 14 of
 * 60 open rows with a Region declared nothing at all, 12 of them for this reason -- 5 written a directory
 * per line, 7 as one line of comma-separated directories.
 *
 * STANDALONE ONLY: an item with any other word in it -- "`scripts/` for the helper" -- is prose, not a
 * declaration. The Region's prose was read as a declaration twice on 2026-09-11 (#848, #920), and a prefix
 * must not reopen that.
 *
 * ANY ROOT, not a list of them. The standalone rule is what keeps prose out; a hand-written list of roots
 * only drops the ones nobody typed. The first version listed `packages|scripts|docs|.github` and read
 * `examples/`, `data/` and `.claude/skills/` as `[]` -- #941's own defect for three of the eight roots
 * the tree tracks (worker-judge's review of #945). `region-paths.test.ts` checks every tracked root.
 */
const DIRECTORY_ITEM = /^(?:[-*+]\s+)?`?((?:[A-Za-z0-9_.-]+\/)+)`?$/;

/**
 * #999: A FENCED LINE UNDER `## Region` IS A DECLARATION, NOT PROSE TO PATTERN-MATCH.
 *
 * `PATH_IN_PROSE` requires an extension of two to four letters, so a file that has none was never SEEN --
 * not dropped with a message, never a path at all. The live instance is #911, whose subject is
 * `scripts/git-hooks/pre-push`: its Region names that file and the test beside it, and `declaredRegionFiles`
 * returned ONE entry, the test. The file the row was actually about was invisible to every consumer of the
 * Region, `fileOverlapReason` (B4) included.
 *
 * Measured on `origin/main` at `40e36ba4`: 11 tracked files under the four declarable prefixes have no
 * extension, and FOUR are the git hooks -- `pre-push`, `pre-commit`, `post-checkout`,
 * `reference-transaction`. Those are files rows change. A hook's filename is its contract with git, so
 * renaming one to suit a parser is not available: `pre-push.sh` is run by nothing.
 *
 * WHY THE FENCE, AND NOT A LOOSER `PATH_IN_PROSE`. Deleting `\.[A-Za-z]{2,4}` from that regex is the
 * obvious fix and it is the wrong one: it runs over PROSE as well, so every mention of a directory --
 * `packages/lab/src`, `docs/adr` -- would become a declared FILE, silently undoing #941/#945's prefix rule
 * in the same direction as the bug. The Region's prose has already been read as a declaration twice
 * (#848, #920). A fenced block is structured: a line inside it is something a person wrote AS a path, in
 * the section whose whole purpose is naming paths, which is the one place the guess is not a guess.
 *
 * STANDALONE, the same discipline `DIRECTORY_ITEM` carries: the whole line is one path, bar a list bullet
 * or backticks. `scripts/git-hooks/pre-push and the test beside it` is prose that happens to sit in a
 * fence, and it declares nothing here.
 *
 * A `/` IS REQUIRED, which is what keeps this from reading any fenced word as a path. A root-level file
 * has none, and needs none: #975's `ROOT_FILE_CANDIDATE` already declares those, ANCHORED to the tree.
 * These are deliberately NOT anchored -- a row routinely declares a file it is about to CREATE (#911's own
 * test file did not exist when its Region was written), and a rule that reads the tree would refuse
 * exactly the new files a Region exists to reserve.
 */
const FENCE_LINE = /^\s*(?:```|~~~)/;
const FENCED_PATH_ITEM = /^(?:[-*+]\s+)?`?([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)`?$/;

/**
 * Every path declared by a line inside a fenced block of `section`. Lines outside a fence are left to the
 * prose grammar, which is the point of the split.
 * @param {string} section @returns {string[]}
 */
function fencedPaths(section) {
  const out = [];
  let inFence = false;
  for (const line of section.split(/\r\n|\r|\n/)) {
    if (FENCE_LINE.test(line)) { inFence = !inFence; continue; }
    if (!inFence) continue;
    const path = FENCED_PATH_ITEM.exec(line.trim())?.[1];
    if (path !== undefined && isTreePath(path)) out.push(path);
  }
  return out;
}
/** `.` and `..` name no directory in the tree: `../x/` is outside it and `./` is all of it. */
const isTreePath = (/** @type {string} */ path) => !path.split("/").some((segment) => segment === "." || segment === "..");
const LIST_SEPARATOR = /[,;]|\band\b|\bor\b/;

/**
 * #941: does a declared Region entry cover this repo-relative file? A directory entry (`docs/`) covers
 * everything under it and nothing that merely shares its spelling (`docsite/`); a file entry covers itself.
 * The ONE answer, so the overlap rule and the lane derivation cannot read a prefix two ways.
 * @param {string} entry @param {string} file
 */
export function regionCovers(entry, file) {
  return entry.endsWith("/") ? file.startsWith(entry) : entry === file;
}

/**
 * #710: the paths a row's OWN `## Region` section declares it will touch -- NOT every path its prose
 * mentions anywhere (that question is `regionPathsFromBody`'s, unchanged, and still what
 * `row-reachability.mjs`'s STARTABLE check wants). A row citing a file as a worked example, a fixture, or
 * something someone else's PR already touches is not declaring intent to change it, and
 * `fileOverlapReason` needs exactly that narrower question. `null` when the body has no Region section at
 * all -- CANNOT_ASK, distinct from `[]` (a Region section that names no source path).
 *
 * #941: a standalone directory item is declared as that PREFIX (`packages/control/ansible/`), after the
 * files -- see `DIRECTORY_ITEM` and `regionCovers`. It used to vanish, so a Region of only directories
 * declared the empty set and overlap-checked as touching nothing.
 *
 * #975: so is a ROOT-LEVEL file the tree has (`package.json`) -- see `ROOT_FILE_CANDIDATE`.
 *
 * #999: and so is a standalone path on a line inside a FENCED block, extension or no extension -- see
 * `FENCED_PATH_ITEM`. That is how `scripts/git-hooks/pre-push` declares; prose still needs an extension.
 * @param {string} body
 * @param {{ rootFiles?: Set<string> }} [options] the tree's root files; defaults to `origin/main`'s, and a test
 *   passes its own so the rule can be checked without the repository it runs in
 * @returns {string[] | null}
 */
export function declaredRegionFiles(body, { rootFiles: known = rootFilesOnMain().files } = {}) {
  const section = extractRegionSection(body);
  if (section === null) return null;
  // #975: root-level files, which have no prefix for `PATH_IN_PROSE` to match. Anchored to the tree: a
  // candidate declares only when `origin/main` has a file of that name at the root.
  const roots = [...section.matchAll(ROOT_FILE_CANDIDATE)].map((m) => m[1]).filter((name) => known.has(name));
  const directories = section.split(/\r\n|\r|\n/)
    .flatMap((line) => line.split(LIST_SEPARATOR))
    .map((item) => DIRECTORY_ITEM.exec(item.trim())?.[1])
    .filter((path) => path !== undefined)
    .filter(isTreePath);
  return [...new Set([...regionPathsFromBody(section), ...directories, ...roots, ...fencedPaths(section)])];
}

/**
 * #707: the raw text of a row's OWN section for ANY of the three required template fields -- Region,
 * Acceptance, or Open-check -- or `null` when the body has none. The same heading/inline shape as
 * `extractRegionSection` above (`## <Field>`, any heading level, optional trailing colon and inline text,
 * OR a bare `Field:` / `**Field:**` line), generalised to a field name so a third and fourth copy of the
 * identical regex pair do not drift from each other or from Region's. `extractRegionSection` itself is
 * left untouched rather than rewritten to call this -- #710's tests pin its exact behaviour, and the risk
 * of a subtle regression there outweighs the small duplication of the pattern-building logic here.
 * @param {string} body @param {string} fieldName exact label as it appears in a heading or inline colon
 *   line, e.g. "Acceptance" or "Open-check" -- matched case-insensitively, word-bounded
 * @returns {string | null}
 */
export function extractLabeledSection(body, fieldName) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The trailing inline VALUE is captured ONLY after an explicit colon -- `## Field: value`. Without the
  // colon required, a real template heading's own descriptive suffix (the actual text this repo's
  // template uses: "## Open-check — the command that shows this row is still open", em-dash, no colon)
  // was captured AS the value, reading a heading with real content on the FOLLOWING lines as though it
  // had none. `.*$` after the optional group still consumes the rest of the line either way, so a
  // colon-less descriptive heading is recognised as a bare heading and this function correctly falls
  // through to the lines beneath it.
  const heading = new RegExp(`^\\s*#{1,6}\\s*${escaped}\\b(?::\\s*(.*))?.*$`, "i");
  const inline = new RegExp(`^\\s*(?:\\*\\*|__)?${escaped}:(?:\\*\\*|__)?\\s*(.*)$`, "i");
  const lines = body.split(/\r\n|\r|\n/);
  for (const [index, line] of lines.entries()) {
    const headingMatch = heading.exec(line);
    if (headingMatch) {
      const trailingInline = (headingMatch[1] ?? "").trim();
      return trailingInline.length > 0 ? trailingInline : linesUntilNextHeading(lines, index + 1).join("\n").trim();
    }
    const inlineMatch = inline.exec(line);
    if (inlineMatch) return inlineMatch[1].trim();
  }
  return null;
}

/**
 * #707: does `body` state a non-empty value for `fieldName` -- naming the field itself is not enough, the
 * "I checked" shape #603's owned-path sign-off already refuses by name. `null`/empty-after-trim text (a
 * heading with nothing under it before the next one) reads as absent, not present-but-blank.
 * @param {string} body @param {string} fieldName
 * @returns {boolean}
 */
export function hasTemplateField(body, fieldName) {
  const section = extractLabeledSection(body, fieldName);
  return section !== null && section.trim().length > 0;
}
