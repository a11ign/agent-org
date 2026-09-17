#!/usr/bin/env node
// @ts-check
// command: rescue one file's change off a stranded branch WITHOUT reverting what main gained since
//
// `git checkout <branch> -- <file>` takes the branch's WHOLE FILE. Every edit main has made to that file
// since the branch diverged is reverted, and the resulting diff reads as the rescue's own insertions.
// Nothing catches it: `resolve-toward-main` in `pre-push` fires on a MERGE whose resolution kept the
// branch's side, and a rescue never merges -- so that door is unwatched (#705).
//
// ## THE REVERTS THIS MAKES SILENTLY ARE THE ONES THAT CHANGE NO BEHAVIOUR
//
// Measured on the real pair (#698, rescuing `audit-rule-coverage.ts` from `lead/inventory-bootstrap`):
//
//     main    * ... `<the lab's address>:5050` serves OUR pages over http, so
//     branch  * ... `192.0.2.79:5050` serves OUR pages over http, so
//
// The wholesale take UN-REDACTS the lab's address, restoring a literal main had deliberately replaced.
// (The address shown is 192.0.2.x -- TEST-NET-1, RFC 5737 -- because `tracked-source-leak-guard`
// refused the real one HERE, in the header of the tool written to stop exactly this. Quoting the
// subject verbatim felt like accuracy and was the leak; the guard was right and I was not.)
// It is a comment: no build breaks, no test fails, no guard fires, and `--shortstat` reads
// `12 insertions(+), 2 deletions(-)` either way.
//
// The same take would also have reverted four `@a11ign/*` imports to `@a11y-witness/*` -- and that one is
// NOT silent: the old scope is `MODULE_NOT_FOUND` and the file is `.ts`, so `tsc` catches it at pre-push.
// **That asymmetry is the whole design constraint.** A rescue's dangerous reverts are precisely the ones
// the build cannot see, so this tool must not lean on the build, and reporting "it typechecks" would be
// answering a different question.
//
// ## `git merge-file` IS THE PRIMITIVE, DELIBERATELY
//
// `git merge-file -p <main> <base> <branch>` is exactly "apply the branch's own changes onto main's copy,
// relative to their common base", and its EXIT STATUS IS THE CONFLICT COUNT. So the refusal this tool
// exists for is a status read rather than a three-way diff re-derived here and got subtly wrong. A rescue
// helper that reimplements merging would be the cleverness the SRE Workbook note in CLAUDE.md warns about,
// in the one place where being wrong reverts somebody's work.
//
//   npm run rescue:hunk -- --from=<branch> --file=<path>            # report only, writes nothing
//   npm run rescue:hunk -- --from=<branch> --file=<path> --apply    # write the merged file
//
// A conflicted hunk -- one replacing a line main changed since the base -- is REFUSED, and the override
// is `A11Y_RESCUE_REASON="<why>"`, which is PRINTED, so a deliberate override is in the log rather than in
// somebody's memory. Same shape as `A11Y_RESOLVE_REASON` and `A11Y_PRIMARY_COMMIT_REASON`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags, flagValue } from "@a11ign/worker-fleet/cli-flags";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";

/** `git merge-file` returns >127 for a real error; anything up to it is the conflict count. */
const GIT_ERROR_STATUS = 128;

/** Enough to recognise a redaction or a rename; the full list is the diff. */
const GAINED_SHOWN = 12;

/** Long enough to recognise a redaction or an import; the full line is in the file. */
const GAINED_LINE_WIDTH = 110;

/**
 * The conflicted regions of a `--diff3` merge, as text, so a refusal can SHOW what it refused rather than
 * counting it. "3 conflicts" sends the reader to open the file; the region tells them whether main's line
 * is a redaction they must keep or a rename the branch predates.
 * @param {string} merged
 * @returns {string[]}
 */
export function conflictRegions(merged) {
  const regions = [];
  const lines = merged.split("\n");
  let current = null;
  for (const line of lines) {
    if (line.startsWith("<<<<<<<")) current = [line];
    else if (current) {
      current.push(line);
      if (line.startsWith(">>>>>>>")) { regions.push(current.join("\n")); current = null; }
    }
  }
  return regions;
}

/**
 * May this rescue be applied? Pure, so the refusal is testable without a repository.
 *
 * A conflict is not an error to be worked around -- it IS the finding, and the reason this tool exists.
 * `reason` does not make it safe; it makes it ATTRIBUTABLE.
 * @param {{ conflicts: number, reason: string | undefined }} state
 * @returns {{ apply: boolean, why: string }}
 */
export function decide({ conflicts, reason }) {
  if (conflicts === 0) return { apply: true, why: "no hunk touches a line main changed since the base" };
  if (reason) return { apply: true, why: `overridden: ${reason}` };
  return {
    apply: false,
    why: `${conflicts} hunk(s) would replace a line main changed since the base. Read the region(s) above: `
      + "if main's side is a redaction, a rename or a correction, the branch's line is STALE and must not "
      + "win. To take the branch's side anyway, name why:\n"
      + '  A11Y_RESCUE_REASON="<why>" npm run rescue:hunk -- --from=<branch> --file=<path> --apply',
  };
}

/** @param {string[]} args */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8", env: sandboxGitEnv() });
}

/**
 * The three-way merge, and the count of hunks that could not be applied without overwriting main.
 * @param {{ base: string, main: string, branch: string }} texts
 * @returns {{ merged: string, conflicts: number }}
 */
export function mergeThreeWay({ base, main, branch }) {
  const dir = mkdtempSync(join(tmpdir(), "rescue-hunk-"));
  try {
    const paths = { base: join(dir, "base"), main: join(dir, "main"), branch: join(dir, "branch") };
    writeFileSync(paths.base, base); writeFileSync(paths.main, main); writeFileSync(paths.branch, branch);
    try {
      // `-p` prints rather than editing `main` in place: this tool writes the working tree ONLY on --apply.
      const merged = execFileSync("git",
        ["merge-file", "-p", "--diff3", "-L", "main", "-L", "base", "-L", "branch",
          paths.main, paths.base, paths.branch],
        { encoding: "utf8", env: sandboxGitEnv() });
      return { merged, conflicts: 0 };
    } catch (error) {
      const status = /** @type {{ status?: number, stdout?: string }} */ (error).status ?? GIT_ERROR_STATUS;
      if (status >= GIT_ERROR_STATUS) throw error;
      return { merged: /** @type {{ stdout: string }} */ (error).stdout, conflicts: status };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Lines present in `after` and not in `before`, ignoring order and whitespace-only difference.
 *
 * Deliberately a SET comparison rather than a diff: the question a rescue asks is "what did main gain
 * that I am about to overwrite", not "where". A moved line is not a loss and would be noise here.
 * @param {string} before
 * @param {string} after
 * @returns {string[]}
 */
export function linesGained(before, after) {
  const seen = new Set(before.split("\n").map((l) => l.trim()));
  return after.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !seen.has(l));
}

function main() {
  refuseUnknownFlags(["--from=", "--file=", "--apply"],
    { entry: import.meta.url, command: "npm run rescue:hunk --" });
  const from = flagValue(process.argv, "from");
  const file = flagValue(process.argv, "file");
  if (!from || !file) {
    process.stderr.write("rescue:hunk needs --from=<branch> and --file=<path>.\n");
    process.exit(2);
  }
  const apply = process.argv.includes("--apply");

  // `origin/`-prefixed on both sides: a rescue reasons about what is PUBLISHED, and a local branch of the
  // same name may be an older copy -- the `fleet:recover` trap CLAUDE.md records, where a stale local
  // `main` pinned by a worktree answered for the real one.
  const branchRef = from.startsWith("origin/") ? from : `origin/${from}`;
  const baseSha = git(["merge-base", "origin/main", branchRef]).trim();
  const texts = {
    base: git(["show", `${baseSha}:${file}`]),
    main: git(["show", `origin/main:${file}`]),
    branch: git(["show", `${branchRef}:${file}`]),
  };

  process.stdout.write(`\n  rescue:hunk  ${file}\n  from ${branchRef}   base ${baseSha.slice(0, 12)}\n\n`);

  // WHAT MAIN GAINED, printed BEFORE the verdict and whether or not anything conflicts. A CLEAN merge
  // still means main moved, and the reader is about to commit a file they did not write all of. This is
  // the line the manual procedure got right by hand in #698 and that nobody would run twice.
  //
  // AND IT IS NOT REDUNDANT WITH THE CONFLICT MARKERS, which was the first thing asked about it. At a
  // conflict site the `main` side of a `--diff3` block already IS "what only main has" there -- but THE
  // REAL PAIR THIS TOOL EXISTS FOR HAS ZERO CONFLICTS. The branch's hunk and main's edits are in
  // different parts of the file, so the merge is clean, no marker is printed, and main's gain still
  // includes the un-redacted address. A report that fires only at conflict sites is silent on exactly the
  // case that motivated the row. The markers explain a REFUSAL; this explains a PASS.
  const gained = linesGained(texts.base, texts.main);
  process.stdout.write(`  main has gained ${gained.length} line(s) in this file since the base`
    + `${gained.length ? ":" : "."}\n`);
  for (const line of gained.slice(0, GAINED_SHOWN)) process.stdout.write(`    + ${line.slice(0, GAINED_LINE_WIDTH)}\n`);
  if (gained.length > GAINED_SHOWN) process.stdout.write(`    ... and ${gained.length - GAINED_SHOWN} more\n`);
  process.stdout.write("\n");

  const { merged, conflicts } = mergeThreeWay(texts);
  for (const region of conflictRegions(merged)) process.stdout.write(`${region}\n\n`);

  const verdict = decide({ conflicts, reason: process.env.A11Y_RESCUE_REASON });
  process.stdout.write(`  ${verdict.apply ? "OK" : "REFUSING"} — ${verdict.why}\n`);
  if (!verdict.apply) process.exit(1);
  if (!apply) { process.stdout.write("  (report only; pass --apply to write the file)\n"); return; }
  writeFileSync(file, merged);
  process.stdout.write(`  wrote ${file}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
