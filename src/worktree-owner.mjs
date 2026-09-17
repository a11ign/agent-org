// command: print which session stamped a worktree, so a session can tell whose tree it is standing in
//          before it moves HEAD -- `npm run worktree:whose [-- <path>]`, and stamp the tree you
//          just made with `npm run worktree:stamp [-- <path>]`
//
// #1128: WHOSE WORKTREE IS THIS? The question the incident needed answered and nothing could.
//
// A reviewer moved HEAD inside two worktrees another session was working in, 46 seconds after that
// session's own merge commit. Nothing was lost -- every tree was clean -- but they then counted in what
// they believed was their branch and got 16/21/8 against their tree's 21/22/9, and were minutes from
// filing a row on it. **The cost was a wrong measurement that looked exactly like a right one.**
//
// `git worktree list` shows the worktree, never who is using it. A detached checkout leaves the other
// session's files intact and correct for a DIFFERENT commit, so their next command answers honestly
// about the wrong tree, and `21` and `16` are both plausible counts.
//
// THE TREES THAT ALREADY EXIST ARE OUT OF SCOPE, and saying so is the point rather than an omission.
// A stamp is written by whoever MAKES a worktree; the 17 that predate this row were made by sessions
// that are no longer running, and nothing can recover who made them -- `git worktree list` never
// recorded it, which is the whole incident. They answer UNSTAMPED, and that is the honest answer rather
// than a gap: a stamp invented for them now would name whoever ran the sweep. One is adopted
// deliberately, by the session that knows it owns it, with `npm run worktree:stamp -- <path>`.
//
// ADVISORY, NOT ENFORCING, and that is the choice rather than the cheap option. A stamp answers "whose
// tree is this"; it does not answer "is anyone using it", and those are different questions -- the
// lesson the prune report's ACTIVE column taught this repo twice in one morning. A hook that refused on
// this would be answering the second with the first.

import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";

/** The stamp's filename, inside the worktree it names. */
export const OWNER_FILE = ".a11y-owner";

/**
 * What a scratchpad worktree gets from its PATH, supplied for `wt-*` trees that get nothing.
 *
 * A scratchpad tree's path carries the owning session's uuid, which is why the transcript-mtime check
 * works there -- and why it covers none of this population: `/private/tmp/wt-1009` is named for the ROW,
 * not the session, which is exactly why it was reached for.
 *
 * @param {string} worktree @param {string} session @param {{ write?: typeof writeFileSync }} [deps]
 */
export function stampWorktree(worktree, session, { write = writeFileSync } = {}) {
  write(join(worktree, OWNER_FILE), `${session}\n`);
}

/**
 * The session that stamped `worktree`, or null when nobody did.
 *
 * NULL IS NOT "nobody is using it" -- it is "nobody said". Every tree made before this shipped answers
 * null, and a caller that reads that as "free" has made the same substitution this row is about.
 *
 * @param {string} worktree @param {{ exists?: typeof existsSync, read?: typeof readFileSync }} [deps]
 * @returns {string | null}
 */
export function worktreeOwner(worktree, { exists = existsSync, read = (/** @type {string} */ p) => readFileSync(p, "utf8") } = {}) {
  const path = join(worktree, OWNER_FILE);
  if (!exists(path)) return null;
  const owner = String(read(path)).trim();
  return owner === "" ? null : owner;
}

/**
 * What `worktree:whose` prints. Three answers, never two.
 *
 * @param {string} worktree @param {string} asking the session running the command
 * @param {{ owner?: typeof worktreeOwner }} [deps] @returns {string}
 */
export function whoseWorktree(worktree, asking, { owner = worktreeOwner } = {}) {
  const who = owner(worktree);
  if (who === null) {
    return `${worktree}: UNSTAMPED -- nobody recorded an owner. That is not "free": every worktree made `
      + "before #1128 answers this, and reading it as unowned is the substitution this stamp exists to stop.";
  }
  if (who === asking) return `${worktree}: yours (${who}).`;
  return `${worktree}: ${who}'s -- NOT yours. Moving HEAD here leaves their files correct for a different `
    + "commit, and their next command answers honestly about the wrong tree.";
}

/**
 * `npm run worktree:whose [-- <path>]` reads; `npm run worktree:stamp [-- <path>]` writes. Both default
 * to the tree you are standing in.
 */
function main() {
  // ONE KNOWN FLAG, and the guard still runs for the reason #453 names: a typo'd `--stamp` falls through
  // to the READ, which prints a perfectly good answer and writes nothing -- the mode most likely to be
  // mistyped is the one that changes something.
  refuseUnknownFlags(["--stamp"], { entry: import.meta.url, command: "npm run worktree:whose -- <path>" });
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--")) ?? process.cwd();
  const session = process.env.A11Y_SESSION;
  if (args.includes("--stamp")) return stamp(target, session);
  const asking = session ?? "(no A11Y_SESSION set)";
  process.stdout.write(`${whoseWorktree(target, asking)}\n`);
}

/**
 * The writer, reached from `--stamp`. Extracted so `main` stays one level of abstraction, and because
 * the refusal below is the interesting half rather than the write.
 *
 * @param {string} target @param {string | undefined} session
 */
function stamp(target, session) {
  // A STAMP NAMING NOBODY IS WORSE THAN NO STAMP. Writing "(no A11Y_SESSION set)" would turn the honest
  // UNSTAMPED answer into a confident wrong one, and the next reader could not tell them apart -- the
  // substitution this whole file refuses, arriving through its own writer.
  if (!session) {
    process.stderr.write("worktree:stamp: A11Y_SESSION is not set, so there is no owner to record. "
      + "Refusing rather than stamping a placeholder -- UNSTAMPED is a true answer and "
      + "`(no A11Y_SESSION set)` would read as an owner.\n");
    process.exitCode = 2;
    return;
  }
  stampWorktree(target, session);
  process.stdout.write(`${target}: stamped ${session}.\n`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
