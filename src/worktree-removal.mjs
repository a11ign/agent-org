// #2782: WHO DELETED THIS WORKTREE, AND WAS ITS ROW STILL CLAIMED? Two questions every remover of a worktree
// directory (`prune-worktrees.mjs`, `prune-tmp.mjs`, `row-claim.mjs`) now answers through this one file.
//
// The incident: `wt-2623` was deleted under its live claim twice (2026-09-28 and 2026-09-29), and NOTHING
// recorded the removal. The prune's own journal could not convict or clear it -- its summary lines read
// `removed N worktree(s)` and its trees are listed in interleaved blocks -- and `prune-tmp.mjs` and
// `row-claim.mjs` write no line at all. A second investigation was the price of the first having left nothing.
//
// TWO PARTS, both here so the three removers cannot drift apart:
//   1. `recordRemoval` -- one JSON line per removal under `~/.cache/a11ign/worktree-removals`: the path, the
//      caller, the reason, the owner file's content, the branch and the verdict.
//   2. `claimRefusal` -- a tree whose row still carries a `session:` claim is not removed. The row's label is
//      the source of truth; `.a11y-owner` is the COPY that a claim's re-creation can lose (#2020 reads only
//      that copy, which is what this closes).

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { worktreeOwner } from "./worktree-owner.mjs";
import { REPO } from "./project-identity.mjs";
import { SESSION_PREFIX } from "./project-vocabulary.mjs";

/** The log's default home, beside the other host state (`claim-stalls.json`, `kept-claims.json`, `salvage/`). */
const DEFAULT_LOG = `${process.env.HOME}/.cache/a11ign/worktree-removals`;

/** Overrides the log's path: a test must not write the host's real record. */
export const REMOVAL_LOG_ENV = "A11Y_WORKTREE_REMOVAL_LOG";

/** `git worktree` directories are named for the row, so `wt-2623` names #2623 even with no branch to read. */
const ROW_FROM_DIRECTORY = /^wt-(\d+)$/;

/** Sub-directories searched for worktrees inside a tree a remover deletes whole -- a scratchpad holds them one or two deep. */
const NESTED_DEPTH = 3;

/**
 * @typedef {{ path: string, caller: string, reason: string, event: "removing" | "removed" | "refused" | "failed",
 *   branch?: string | null, owner?: string | null, detail?: string }} RemovalRecord
 */

/** @param {NodeJS.ProcessEnv} [env] @returns {string} */
export function removalLogPath(env = process.env) {
  return env[REMOVAL_LOG_ENV] ?? DEFAULT_LOG;
}

/**
 * APPEND one line saying who asked for a removal, and what the tree's own owner file read at that moment.
 * THROWS when the line cannot be written: the caller refuses the removal, because a delete nobody can see in
 * the log is the defect this file exists to end, and a disk that cannot take a line is not a moment to delete.
 *
 * @param {RemovalRecord} record
 * @param {{ env?: NodeJS.ProcessEnv, now?: () => Date, append?: typeof appendFileSync, owner?: typeof worktreeOwner }} [deps]
 */
export function recordRemoval(record, { env = process.env, now = () => new Date(), append = appendFileSync, owner = worktreeOwner } = {}) {
  const file = removalLogPath(env);
  mkdirSync(dirname(file), { recursive: true });
  const line = { at: now().toISOString(), pid: process.pid, ...record,
    owner: record.owner !== undefined ? record.owner : safeOwner(record.path, owner) };
  append(file, `${JSON.stringify(line)}\n`);
}

/**
 * The owner file's content, or `null` when it is gone. A failed read must not stop the LOG: the line is most
 * valuable exactly when the tree is already in an odd state.
 * @param {string} path @param {typeof worktreeOwner} owner @returns {string | null}
 */
function safeOwner(path, owner) {
  try {
    return owner(path);
  } catch {
    return null;
  }
}

/**
 * The rows a tree could belong to, read off its name and its branch: `agent/<slug>-<n>`, the older
 * `agent/<n>-<slug>`, and the directory `wt-<n>`. More than one is possible and any claimed one refuses.
 * @param {{ path: string, branch?: string | null }} tree @returns {number[]}
 */
export function rowCandidates({ path, branch }) {
  const name = (branch ?? "").replace(/^refs\/heads\//, "");
  const found = [/-(\d+)$/.exec(name)?.[1], /^agent\/(\d+)-/.exec(name)?.[1], ROW_FROM_DIRECTORY.exec(basename(path))?.[1]];
  return [...new Set(found.filter((n) => n !== undefined).map(Number))];
}

/**
 * @typedef {(args: string[]) => string} Gh
 * A LITERAL `spawnSync("gh", ...)`, on purpose: `host-units.mjs`'s `SPAWNS_GH` reads the quoted name, and a spawn it cannot read
 * is a unit that spends an API pool while the guard reports it clean (the prune unit does, since #2782).
 * @type {Gh}
 */
const defaultGh = (args) => {
  const ran = spawnSync("gh", args, { encoding: "utf8" });
  if (ran.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")} exited ${ran.status}: ${(ran.stderr ?? "").trim()}`);
  return ran.stdout;
};

/**
 * The `session:` claims on one row: `[]` when it is open and unclaimed or closed, else the sessions. Throws when the row
 * cannot be read -- the caller turns that into a refusal, never into "unclaimed".
 * @param {number} row @param {Gh} gh @returns {string[]}
 */
function sessionsHolding(row, gh) {
  const read = JSON.parse(gh(["issue", "view", String(row), "--repo", REPO, "--json", "state,labels"]));
  if (read.state === "CLOSED") return [];
  return read.labels.map((/** @type {{ name: string }} */ l) => l.name)
    .filter((/** @type {string} */ name) => name.startsWith(SESSION_PREFIX))
    .map((/** @type {string} */ name) => name.slice(SESSION_PREFIX.length));
}

/**
 * #2782 DONE-WHEN 3: is this tree's row still CLAIMED? Refuses when any row it could belong to is open and carries a
 * `session:` label, or when a row could not be read -- "could not ask" is never "nobody holds it", the tristate every
 * remover here keeps. A tree naming no row is not refused here: it has no claim to read, and the owner-file and
 * merge checks each remover already runs are all there is to ask.
 *
 * Costs one `gh issue view` per row, and only for a tree every other check has already passed for removal.
 *
 * @param {{ path: string, branch?: string | null }} tree
 * @param {{ gh?: Gh, except?: string }} [deps] `except` is the session entitled to remove its own tree (a `decline`)
 * @returns {{ refused: false } | { refused: true, reason: string }}
 */
export function claimRefusal(tree, { gh = defaultGh, except } = {}) {
  for (const row of rowCandidates(tree)) {
    /** @type {string[]} */
    let held;
    try {
      held = sessionsHolding(row, gh);
    } catch (cause) {
      return { refused: true, reason: `${tree.path} names row #${row} and its claim could not be read (${/** @type {Error} */ (cause).message}) -- refusing to remove a tree on an unanswered question (#2782)` };
    }
    const others = held.filter((session) => session !== except);
    if (others.length > 0) {
      return { refused: true, reason: `${tree.path} belongs to row #${row}, which still carries ${others.map((s) => `${SESSION_PREFIX}${s}`).join(", ")} -- the row's claim, not the tree's owner file, says somebody is working here (#2782). Refusing to remove it` };
    }
  }
  return { refused: false };
}

/**
 * #3850: have EVERY row this tree could belong to CLOSED? The question `claimRefusal` cannot answer, because it reads an open
 * row nobody claims and a closed row both as `refused: false`; a tree whose stamp outlived its claim is released only by the
 * second. A tree naming no row has nothing to read, so it is NOT closed -- absence of a row is never "the row finished".
 * Every candidate must be closed (a trailing number in a branch name need not be a row), and a row that cannot be read is not
 * closed: the tristate every remover here keeps.
 *
 * @param {{ path: string, branch?: string | null }} tree
 * @param {{ gh?: Gh }} [deps]
 * @returns {{ closed: true } | { closed: false, reason: string }}
 */
export function rowsClosed(tree, { gh = defaultGh } = {}) {
  const rows = rowCandidates(tree);
  if (rows.length === 0) return { closed: false, reason: `${tree.path} names no row, so no closed row releases it (#3850)` };
  for (const row of rows) {
    try {
      const { state } = JSON.parse(gh(["issue", "view", String(row), "--repo", REPO, "--json", "state"]));
      if (state !== "CLOSED") return { closed: false, reason: `row #${row} is ${String(state).toLowerCase()}, so the stamp is not stale (#3850)` };
    } catch (cause) {
      return { closed: false, reason: `row #${row} could not be read (${/** @type {Error} */ (cause).message}) -- not treated as closed (#3850)` };
    }
  }
  return { closed: true };
}

/**
 * Every directory at or under `dir` that IS a worktree (its `.git` is a file), for a remover that deletes a whole directory
 * and so can take worktrees with it: `prune-tmp.mjs` removes scratchpads recursively.
 * @param {string} dir @param {number} [depth] @returns {string[]}
 */
export function nestedWorktrees(dir, depth = NESTED_DEPTH) {
  if (depth < 0) return [];
  /** @type {import("node:fs").Dirent[]} */
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // unreadable or already gone: nothing there can be named
  }
  const here = entries.some((e) => e.name === ".git" && e.isFile()) ? [dir] : [];
  const below = entries.filter((e) => e.isDirectory() && e.name !== "node_modules" && e.name !== ".git")
    .flatMap((e) => nestedWorktrees(join(dir, e.name), depth - 1));
  return [...here, ...below];
}

/**
 * The branch a worktree has checked out, read from its gitdir's `HEAD` with no `git` spawn -- `null` when detached or unreadable.
 * @param {string} worktree @returns {string | null}
 */
export function worktreeBranch(worktree) {
  try {
    const pointer = /^gitdir: (.+)$/m.exec(readFileSync(join(worktree, ".git"), "utf8"));
    if (pointer === null) return null;
    const head = readFileSync(join(resolve(worktree, pointer[1].trim()), "HEAD"), "utf8");
    return /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1] ?? null;
  } catch {
    return null; // a tree whose gitdir cannot be read names no branch; the `wt-<n>` directory name still can
  }
}
