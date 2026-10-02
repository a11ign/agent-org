#!/usr/bin/env node
// @ts-check
// command: the one way to move the tool's own checkout: fetch, refuse a dirty tree, detach at origin/main
// THE ANALOGUE OF `primary:update` FOR THE TOOL'S CHECKOUT -- #2793 (child 5b of #2623; ADR 0040, decision 3). Once `host.json` names a
// `tool`, the `work-tick` unit runs from a checkout of the tool's own repository and its first `ExecStartPre` is this command, so the
// tool is live within two minutes of a merge to its `main`, as the product's `agent-org` is today because `primary:update` moves the
// checkout it lives in.
//
//   node src/update-tool.mjs
//
// IT UPDATES THE CHECKOUT THIS FILE LIVES IN, and no other. Not the working directory and not a path it is handed: a command that
// took a path could be pointed at a project's checkout, and "never touches a project's checkout" is the one promise it makes. The
// root is `git rev-parse --show-toplevel` of this file's own directory, and it refuses outside a primary checkout (a real `.git`
// directory) for the reason `update-primary.mjs` does: detaching a linked worktree takes it off the branch it is for.
//
// A DIRTY TREE IS REFUSED, NOT STASHED AND NOT RESET. The tool's checkout is read-only except fast-forward, so a modified tracked file
// is somebody's edit made where none belongs, and moving under it would either lose it or fail half way. Untracked files are not
// "dirty": git itself refuses a checkout that would overwrite one, and a build product in the tree must not stop the tool updating.
//
// NO INSTALL AND NO BUILD, unlike `primary:update`: the tool imports no third-party module (ADR 0040, decision 1) and its `.mjs` files
// run as they are, so there is nothing to install and nothing to compile.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandboxGitEnv } from "./lib/git-env.mjs";
import { refuseUnknownFlags } from "./lib/cli-flags.mjs";
import { isPrimaryWorktree } from "./prune-worktrees.mjs";

/** The directory this file is in, real-pathed: the tool is reached through a symlink on some hosts, and git resolves the real one. */
const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));

/** @param {string} cwd @returns {(args: string[]) => string} */
const gitIn = (cwd) => (args) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8" });

/**
 * The tracked files a checkout has modified, staged or not: what makes it dirty. A list, so a refusal can name them.
 * @param {(args: string[]) => string} run @returns {string[]}
 */
function dirtyPaths(run) {
  return run(["status", "--porcelain", "--untracked-files=no"]).split("\n").filter((line) => line !== "");
}

/**
 * @param {string} [root] the tool's checkout; the one holding this file when left to default
 * @param {(args: string[]) => string} [run] git, run in `root`
 * @returns {string} the commit the checkout is at
 */
export function updateTool(root = gitIn(HERE)(["rev-parse", "--show-toplevel"]).trim(), run = gitIn(root)) {
  if (!isPrimaryWorktree(root)) {
    throw new Error(`${root} is not a primary checkout (its .git is a linked worktree's, not a real directory) -- the tool's `
      + "checkout is a plain clone, and detaching a linked worktree would take it off the branch it is for.");
  }
  const dirty = dirtyPaths(run);
  if (dirty.length > 0) {
    throw new Error(`${root} has uncommitted changes to tracked files, so it was NOT moved:\n${dirty.join("\n")}\nThe tool's `
      + "checkout is read-only except fast-forward; commit the change where the tool is developed and discard it here.");
  }
  run(["fetch", "origin"]);
  run(["checkout", "--detach", "origin/main", "--quiet"]);
  return run(["rev-parse", "HEAD"]).trim();
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  // Guarded per #164: takes no flags -- a root argument is exactly what this command must not accept.
  refuseUnknownFlags([], { entry: import.meta.url, command: "node src/update-tool.mjs" });
  const sha = updateTool();
  console.log(`tool checkout detached at origin/main (${sha})`);
}
