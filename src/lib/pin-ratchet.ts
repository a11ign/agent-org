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
 *
 * THE TOOL'S REPOSITORY (#3245): `ci.yml`'s `gate` lays the tool out WITHOUT its `.git`, so the directory a pin scans is not a repository.
 * `AGENT_ORG_TOOL_REPO` names the checkout the tool was laid out FROM (`$GITHUB_WORKSPACE`); `judgePin` reads the base and the base's files
 * there, and nowhere else reads the variable. Unset, or naming something that is not a repository of its own, the strict form runs as before.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxGitEnv } from "./git-env.mjs";

export type Declaration = { name: string; reason: string };
export type Base = { ref: string } | { unreadable: string };
export type Scan = (root: string, base: { changed: Set<string> | null }) => string[];

const MERGE_GROUP = "merge_group";
/** The checkout a laid-out copy of the tool came from, for the one reader that needs a repository (`judgePin`). */
export const TOOL_REPO_ENV = "AGENT_ORG_TOOL_REPO";
/** An archive of `src` is a few MB; node's 1 MiB default would truncate it into a tar error that names nothing. */
const ARCHIVE_BUFFER_BYTES = 256 * 1024 * 1024;

/** @param {string} repo @param {string[]} args @returns {string} */
function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * The commit this change merges into, or why it cannot be read. `repo` must BE a repository (its own top level), not a directory inside another:
 * the tool laid out under a project's `packages/agent-org` sits inside the PROJECT's repository, whose first parent is not the tool's base.
 * @param {string} repo
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Base}
 */
export function resolveBase(repo: string, env: NodeJS.ProcessEnv = process.env): Base {
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
 * (#3549) THE PATHS THIS CHANGE TOUCHES, so a scan of the base can re-read only those. Repository-relative; the live tree against `ref` (committed and
 * uncommitted tracked edits) plus every untracked file. `null` when the answer is not a plain set of edits and additions: a DELETION or a rename
 * removes a file the base held and the live tree no longer shows, so "no visited file was touched" no longer proves a base entry unchanged, and the
 * caller must scan the whole base. Never a guess: when git cannot say, it is `null` too.
 * @param {string} repo @param {string} ref
 * @returns {Set<string> | null}
 */
export function changedSince(repo: string, ref: string): Set<string> | null {
  try {
    const rows = git(repo, ["diff", "--name-status", "--no-renames", ref]).split("\n").filter(Boolean);
    if (rows.some((row) => row.startsWith("D"))) return null;
    const untracked = git(repo, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
    return new Set([...rows.map((row) => row.split("\t")[1]), ...untracked]);
  } catch {
    return null;
  }
}

/**
 * `scan` run over `paths` as they were at `ref`, extracted into a throwaway directory (so the SAME scan that reads the live tree reads the base).
 * `changed` is handed to `scan` untouched, for a scan that can reuse what it already answered about the live tree (`changedSince`).
 * @param {{ repo: string, ref: string, paths: string[], scan: Scan, changed?: Set<string> | null }} at
 * @returns {string[]}
 */
export function scanAtBase({ repo, ref, paths, scan, changed = null }: { repo: string; ref: string; paths: string[]; scan: Scan; changed?: Set<string> | null; }): string[] {
  const root = mkdtempSync(join(tmpdir(), "pin-ratchet-"));
  try {
    const archive = execFileSync("git", ["archive", ref, ...paths], { cwd: repo, env: sandboxGitEnv(), maxBuffer: ARCHIVE_BUFFER_BYTES });
    execFileSync("tar", ["-x", "-C", root], { input: archive });
    return scan(root, { changed });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The entries of `current` that the base did not hold and that no declaration WITH A REASON covers. `base: null` grandfathers nothing.
 * @param {{ current: string[], base: string[] | null, declared: Declaration[] }} population
 * @returns {string[]}
 */
export function undeclaredGrowth({ current, base, declared }: { current: string[]; base: string[] | null; declared: Declaration[]; }): string[] {
  const held = new Set(base ?? []);
  const reasoned = new Set(declared.filter((entry) => entry.reason.trim() !== "").map((entry) => entry.name));
  return current.filter((name) => !held.has(name) && !reasoned.has(name)).sort();
}

/**
 * The whole ratchet for one pinned population.
 * @param {{ repo: string, paths: string[], scan: Scan, current: string[], declared: Declaration[], env?: NodeJS.ProcessEnv }} pin
 *   `scan(root, { changed })` lists the population under a tree laid out as `repo` is (`root/<path>`); `changed` is `changedSince` the base (`null`:
 *   scan everything), which a scan may ignore; `current` is what the live tree holds. `repo` is
 *   the tool's directory; `env[TOOL_REPO_ENV]`, where set, replaces it as the repository the base is read from.
 * @returns {{ undeclared: string[], judged: string }} `judged` says WHICH form ran, for the assertion message
 */
export function judgePin({ repo, paths, scan, current, declared, env = process.env }: { repo: string; paths: string[]; scan: Scan; current: string[]; declared: Declaration[]; env?: NodeJS.ProcessEnv; }): { undeclared: string[]; judged: string; } {
  const repository = env[TOOL_REPO_ENV] || repo;
  const base = resolveBase(repository, env);
  if ("unreadable" in base) return { undeclared: undeclaredGrowth({ current, base: null, declared }), judged: `strictly, with nothing grandfathered (${base.unreadable})` };
  const atBase = scanAtBase({ repo: repository, ref: base.ref, paths, scan, changed: changedSince(repository, base.ref) });
  return { undeclared: undeclaredGrowth({ current, base: atBase, declared }), judged: `as a ratchet against ${base.ref.slice(0, 9)}` };
}
