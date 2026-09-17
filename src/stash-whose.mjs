#!/usr/bin/env node
// @ts-check
// command: list every git stash entry with the branch it was made on, since git alone will not say
/**
 * WHOSE STASH IS THAT? — every entry with the branch it was made on (#290).
 *
 *   npm run stash:whose
 *
 * `refs/stash` is in the COMMON git directory, so the pile is shared between every worktree, and
 * `git stash list` shows a position (`stash@{0}`) rather than an owner. In a repository where several
 * agents hold several worktrees at once, position is exactly the wrong key: `stash@{0}` is whoever
 * pushed last, and `git stash pop` takes it.
 *
 * ## The branch is already recorded — it is the LABEL that hides it
 *
 * An unlabelled stash's subject is `WIP on <branch>: <sha> <subject>`, so git has always carried the
 * branch. `git stash push -m "<msg>"` replaces that subject with `On <branch>: <msg>` — the branch
 * survives, which is what makes the #290 guard's advice safe: naming a stash does NOT cost you the
 * ownership information, it adds to it.
 *
 * So this reads the branch out of the subject in both shapes rather than asking the caller to have
 * recorded it, and prints the message separately. A stash made before the guard existed still resolves.
 *
 * ## What it deliberately does NOT claim
 *
 * **A branch is not a worktree and not a session.** Two worktrees can hold the same branch, and nothing
 * in a stash commit records which directory it was made in — git does not write it. So this answers
 * "which branch was checked out when this was stashed", which is the strongest fact available, and says
 * so rather than implying an owner it cannot know. That is why the #290 guard asks for a MESSAGE: the
 * message is the only place a human can put what git cannot derive.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { refuseUnknownFlags } from "@a11ign/worker-fleet/cli-flags";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";

const EXIT = { DONE: 0, CANNOT_ASK: 2 };

/**
 * Split a stash subject into the branch it was made on and whatever the author called it.
 *
 * Both shapes, because the corpus of stashes on any machine here contains both — one made before the
 * guard and one after. An unrecognised shape yields a null branch rather than a guess: "I could not tell"
 * and "made on no branch" are different answers, and only one of them should send somebody looking.
 *
 * @param {string} subject
 * @returns {{branch: string | null, label: string | null}}
 */
export function ownerOf(subject) {
  const wip = /^WIP on ([^:]+): /.exec(subject);
  if (wip) return { branch: wip[1], label: null };
  const named = /^On ([^:]+): (.*)$/.exec(subject);
  if (named) return { branch: named[1], label: named[2] };
  return { branch: null, label: null };
}

/**
 * Render one line per stash. PURE, so the formatting is testable without making real stashes — the
 * fixture that would be needed otherwise is two worktrees and a shared ref, which is the #290 test's
 * job rather than this one's.
 *
 * @param {{ref: string, subject: string}[]} entries
 * @returns {string[]}
 */
export function stashLines(entries) {
  if (entries.length === 0) return ["No stashes. The shared pile is empty."];
  return entries.map(({ ref, subject }) => {
    const { branch, label } = ownerOf(subject);
    const who = branch === null ? "branch UNKNOWN (unrecognised subject)" : `on ${branch}`;
    // An unlabelled stash is called out HERE too, not only at creation: the guard stops new ones, and
    // every stash predating it is still in the pile and still anonymous.
    const what = label === null ? "  <- NO MESSAGE: nothing says whose this is or what it holds" : `  ${label}`;
    return `${ref}  ${who}${what}`;
  });
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "npm run stash:whose" });
  /** @type {string} */
  let raw;
  try {
    raw = execFileSync("git", ["stash", "list", "--format=%gd%x09%s"],
      { encoding: "utf8", env: sandboxGitEnv() });
  } catch (error) {
    process.stderr.write("CANNOT SAY what is in the stash: `git stash list` failed. This is "
      + `INCONCLUSIVE, not "no stashes" -- the two need opposite responses. ${
        /** @type {Error} */ (error).message}\n`);
    process.exit(EXIT.CANNOT_ASK);
  }
  const entries = raw.split("\n").filter(Boolean).map((line) => {
    const [ref, ...rest] = line.split("\t");
    return { ref, subject: rest.join("\t") };
  });
  process.stdout.write(`${stashLines(entries).join("\n")}\n`);
  process.exit(EXIT.DONE);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
