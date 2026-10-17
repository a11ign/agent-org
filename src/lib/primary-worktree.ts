// @ts-check
// module: whether a checkout is a repository's primary one or a linked worktree, moved out of `prune-worktrees.ts` so `update-tool.ts` reads it
// without importing that file's project-config chain (`agent-org update` runs on a machine that declares no project).
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

/**
 * git's own mechanism for telling a linked worktree from the repository it belongs to: the primary's
 * `.git` is a real directory, a linked worktree's is a text file. Never a guess from the path.
 *
 * @param {string} worktreePath
 * @returns {boolean}
 */
export function isPrimaryWorktree(worktreePath: string): boolean {
  const gitPath = join(worktreePath, ".git");
  if (!existsSync(gitPath)) return false;
  return lstatSync(gitPath).isDirectory();
}
