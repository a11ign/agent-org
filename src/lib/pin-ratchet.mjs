// @ts-check
/**
 * (#3232) A PIN ON A POPULATION'S CONTENT OR SIZE, AS A RATCHET AGAINST THE BASE THE CHANGE MERGES INTO.
 *
 * An exact pin (`assert.deepEqual(found, RECORDED)`, or a count) is true of ONE tree, so two honest pull requests that each add an entry are each
 * green against their own base and red together in the merge queue: the second is tested on top of the first, and the shared total (or the list a
 * textual merge reassembled) says something neither author wrote. It also fails on a SHRINK, which is a fault nobody has.
 *
 * The ratchet asks the question that stays true when changes compose: **which entries did THIS change add, and does each carry a declaration?**
 * The declaration (`{ name, reason }`) lives on the added entry itself and never in a shared total, so two changes that each add one are judged
 * each against its own base. An entry that is neither in the base nor declared fails; a shrink passes.
 *
 * THE BASE is `HEAD^1` on `merge_group` (the queue's merge commit, whose first parent is the tip it merges into) and the merge-base with
 * `origin/main` otherwise. A tree whose base cannot be read (the gate lays the tool into a project's tree, which has no repository of its
 * own: `resolveBase` says so) is judged STRICTLY, with nothing grandfathered, so every entry must be declared. That is never a skip: the
 * stricter form runs, and the reason it is the one that ran is returned for the message.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxGitEnv } from "./git-env.mjs";

/** @typedef {{ name: string, reason: string }} Declaration */
/** @typedef {{ ref: string } | { unreadable: string }} Base */

const MERGE_GROUP = "merge_group";
/** An archive of `src` is a few MB; node's 1 MiB default would truncate it into a tar error that names nothing. */
const ARCHIVE_BUFFER_BYTES = 256 * 1024 * 1024;

/** @param {string} repo @param {string[]} args @returns {string} */
function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * The commit this change merges into, or why it cannot be read. `repo` must BE a repository (its own top level), not a directory inside another:
 * the tool laid out under a project's `packages/agent-org` sits inside the PROJECT's repository, whose first parent is not the tool's base.
 * @param {string} repo
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Base}
 */
export function resolveBase(repo, env = process.env) {
  try {
    const top = realpathSync(git(repo, ["rev-parse", "--show-toplevel"]));
    if (top !== realpathSync(repo)) return { unreadable: `\`${repo}\` is inside the repository at \`${top}\`, not a repository of its own` };
    const ref = env.GITHUB_EVENT_NAME === MERGE_GROUP ? "HEAD^1" : git(repo, ["merge-base", "HEAD", "origin/main"]);
    return { ref: git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]) };
  } catch (cause) {
    return { unreadable: `git could not name the base in \`${repo}\`: ${String(cause instanceof Error ? cause.message : cause).split("\n")[0]}` };
  }
}

/**
 * `scan` run over `paths` as they were at `ref`, extracted into a throwaway directory (so the SAME scan that reads the live tree reads the base).
 * @param {{ repo: string, ref: string, paths: string[], scan: (root: string) => string[] }} at
 * @returns {string[]}
 */
export function scanAtBase({ repo, ref, paths, scan }) {
  const root = mkdtempSync(join(tmpdir(), "pin-ratchet-"));
  try {
    const archive = execFileSync("git", ["archive", ref, ...paths], { cwd: repo, env: sandboxGitEnv(), maxBuffer: ARCHIVE_BUFFER_BYTES });
    execFileSync("tar", ["-x", "-C", root], { input: archive });
    return scan(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The entries of `current` that the base did not hold and that no declaration WITH A REASON covers. `base: null` grandfathers nothing.
 * @param {{ current: string[], base: string[] | null, declared: Declaration[] }} population
 * @returns {string[]}
 */
export function undeclaredGrowth({ current, base, declared }) {
  const held = new Set(base ?? []);
  const reasoned = new Set(declared.filter((entry) => entry.reason.trim() !== "").map((entry) => entry.name));
  return current.filter((name) => !held.has(name) && !reasoned.has(name)).sort();
}

/**
 * The whole ratchet for one pinned population.
 * @param {{ repo: string, paths: string[], scan: (root: string) => string[], current: string[], declared: Declaration[], env?: NodeJS.ProcessEnv }} pin
 *   `scan(root)` lists the population under a tree laid out as `repo` is (`root/<path>`); `current` is what the live tree holds.
 * @returns {{ undeclared: string[], judged: string }} `judged` says WHICH form ran, for the assertion message
 */
export function judgePin({ repo, paths, scan, current, declared, env = process.env }) {
  const base = resolveBase(repo, env);
  if ("unreadable" in base) return { undeclared: undeclaredGrowth({ current, base: null, declared }), judged: `strictly, with nothing grandfathered (${base.unreadable})` };
  const atBase = scanAtBase({ repo, ref: base.ref, paths, scan });
  return { undeclared: undeclaredGrowth({ current, base: atBase, declared }), judged: `as a ratchet against ${base.ref.slice(0, 9)}` };
}
