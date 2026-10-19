// @ts-check
// module: one worktree per repository a ticket was queued to, all on the ticket's branch, each from that repository's live default branch
//
// THE DEFAULT BRANCH IS ASKED OF THE REMOTE, NOT READ OFF THE CLONE. A clone's `origin/HEAD` is set when it is cloned and never moves by itself:
// measured 2026-10-13, a clone of `nbl-ui-agent-platform` still said `main` while GitHub's default was `develop`. `ls-remote --symref` asks GitHub.
//
// ASYNCHRONOUS, because a fetch of a large repository takes seconds and the pool runs inside the board's server, which must keep answering.
//
// A BRANCH THAT ALREADY EXISTS IS NOT REUSED. It is somebody's work (an earlier run, or a person's), and a worker started on it would build on
// commits nobody briefed it about. The caller reports it and starts nothing.
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";

/** `git` run in `cwd`. Every call names its checkout: a `git` that names none asks whichever repository the process is in. */
export type Git = (cwd: string, args: string[]) => Promise<string>;

export const defaultGit: Git = (cwd, args) => new Promise((resolve, reject) => {
  execFile("git", args, { cwd, encoding: "utf8", env: sandboxGitEnv() }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/** A worktree made or reused: its repository, path and base branch, and, when it was made from a stacked branch (`from`), the commit it was branched at. */
export type Prepared = Readonly<{ repo: string; path: string; base: string; sha?: string }>;

/** The remote's default branch, e.g. `develop`, from `ls-remote --symref origin HEAD`. PURE over that command's output. */
export function parseDefaultBranch(lsRemote: string): string {
  const match = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(lsRemote);
  if (match === null) throw new Error(`the remote named no default branch: ${JSON.stringify(lsRemote.split("\n")[0])}`);
  return match[1];
}

/**
 * A worktree of `clone` at `path` on a new `branch`, from the remote's default branch, freshly fetched, or from the remote's branch `from`, such
 * as the branch of a ticket this one is stacked on. REFUSES, starting nothing, when the branch already exists in the clone or the path is taken.
 */
export async function addWorktree({ repo, clone, path, branch, from }: { repo: string; clone: string; path: string; branch: string; from?: string },
  git: Git = defaultGit): Promise<Prepared> {
  if (existsSync(path)) throw new Error(`${repo}: ${path} already exists; a run that was cut short left it, so remove it or retry under another name`);
  const base = from ?? parseDefaultBranch(await git(clone, ["ls-remote", "--symref", "origin", "HEAD"]));
  await git(clone, ["fetch", "--quiet", "origin", base]);
  const exists = await git(clone, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
  if (exists) throw new Error(`${repo}: branch ${branch} already exists in ${clone}; it is earlier work, so it is not reused`);
  await git(clone, ["worktree", "add", "--quiet", "-b", branch, path, `origin/${base}`]);
  // Recorded only for a stacked branch: the commit the worktree was branched at, which a later rebase is made from (`stack-rebase.ts`).
  if (from === undefined) return { repo, path, base };
  const sha = (await git(clone, ["rev-parse", `origin/${base}`])).trim();
  return { repo, path, base, sha };
}

/**
 * The worktree an earlier run of the same ticket left, to continue in on a retry: it must be at `path` and on `branch`. Throws when it is not,
 * because then it is not that run's.
 */
export async function reuseWorktree({ repo, clone, path, branch }: { repo: string; clone: string; path: string; branch: string }, git: Git = defaultGit): Promise<Prepared> {
  const on = (await git(path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (on !== branch) throw new Error(`${repo}: ${path} is on ${on}, not ${branch}, so it is not this ticket's earlier run`);
  return { repo, path, base: parseDefaultBranch(await git(clone, ["ls-remote", "--symref", "origin", "HEAD"])) };
}

/** Where a ticket's worktree for one repository goes: `<root>/<ticket>/<repo>`, so one ticket's repositories sit side by side. */
export function worktreePath(root: string, ticket: string, repo: string): string {
  return join(root, ticket, repo);
}

/** Add `line` to an exclude file, on a line of its own, once. */
function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (text.split("\n").includes(line)) return;
  appendFileSync(path, `${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`);
}

/** Keep a generated file out of the repository: add it to the clone's shared `info/exclude`, unless git already ignores it. */
export async function excludeFromGit(worktree: string, relative: string, { git = defaultGit, append = appendLine }: { git?: Git; append?: (path: string, line: string) => void } = {}): Promise<void> {
  const ignored = await git(worktree, ["check-ignore", "--quiet", relative]).then(() => true, () => false);
  if (ignored) return;
  const commonDir = (await git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  append(join(commonDir, "info", "exclude"), relative);
}
