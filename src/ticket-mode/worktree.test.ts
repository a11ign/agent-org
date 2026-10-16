// no-token: gh -- real git, in repositories this file builds in its own temporary directories; nothing reaches a network remote
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { addWorktree, excludeFromGit, parseDefaultBranch, reuseWorktree, worktreePath, type Git } from "./worktree.ts";

/** Real git with every `GIT_*` scrubbed, synchronous for the test's own setup. */
const gitSync = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** The same, as the module's asynchronous seam. */
const git: Git = async (cwd, args) => gitSync(cwd, args);
/** A commit with its identity given on the command, so no config is written anywhere. */
const commit = (cwd: string, message: string) => gitSync(cwd, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", message]);

test("the default branch is the one the remote's HEAD names", () => {
  assert.equal(parseDefaultBranch("ref: refs/heads/develop\tHEAD\n4e9bed32\tHEAD\n"), "develop");
  assert.throws(() => parseDefaultBranch("4e9bed32\tHEAD\n"), /named no default branch/);
});

/** A remote whose default is `develop` (with a stale `main` beside it), and a clone of it made while its HEAD was still `main`. */
function remoteAndClone() {
  const scratch = realpathSync(tmpDir("ticket-worktree-"));
  const remote = join(scratch, "remote");
  gitSync(scratch, ["init", "-q", "-b", "main", remote]);
  commit(remote, "on main");
  const clone = join(scratch, "clone");
  gitSync(scratch, ["clone", "-q", remote, clone]);
  gitSync(remote, ["checkout", "-q", "-b", "develop"]);
  commit(remote, "on develop");
  return { clone, root: join(scratch, "worktrees") };
}

test("a worktree is made on the ticket's branch from the remote's live default, not the clone's stale `origin/HEAD`", async () => {
  const { clone, root } = remoteAndClone();
  assert.equal(gitSync(clone, ["symbolic-ref", "refs/remotes/origin/HEAD"]).trim(), "refs/remotes/origin/main", "POSITIVE CONTROL: the clone's own HEAD is stale");
  const path = worktreePath(root, "NBF-1", "repo-a");
  const made = await addWorktree({ repo: "repo-a", clone, path, branch: "nbf-1-fix" }, git);
  assert.equal(made.base, "develop");
  assert.equal(gitSync(path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "nbf-1-fix");
  assert.equal(gitSync(path, ["log", "-1", "--format=%s"]).trim(), "on develop");
});

test("an existing branch or path is refused, and nothing is created for it", async () => {
  const { clone, root } = remoteAndClone();
  gitSync(clone, ["branch", "nbf-2-fix"]);
  await assert.rejects(addWorktree({ repo: "repo-a", clone, path: worktreePath(root, "NBF-2", "repo-a"), branch: "nbf-2-fix" }, git), /already exists/);
  assert.equal(gitSync(clone, ["worktree", "list"]).trim().split("\n").length, 1, "no worktree was added");
  const path = worktreePath(root, "NBF-3", "repo-a");
  await addWorktree({ repo: "repo-a", clone, path, branch: "nbf-3-fix" }, git);
  await assert.rejects(addWorktree({ repo: "repo-a", clone, path, branch: "nbf-3-other" }, git), /already exists/);
});

test("a retry reuses the worktree only when it is on the ticket's branch", async () => {
  const { clone, root } = remoteAndClone();
  const path = worktreePath(root, "NBF-5", "repo-a");
  await addWorktree({ repo: "repo-a", clone, path, branch: "nbf-5-fix" }, git);
  assert.deepEqual(await reuseWorktree({ repo: "repo-a", clone, path, branch: "nbf-5-fix" }, git), { repo: "repo-a", path, base: "develop" });
  await assert.rejects(reuseWorktree({ repo: "repo-a", clone, path, branch: "nbf-5-other" }, git), /not this ticket's earlier run/);
});

test("a generated file is excluded once through the clone's shared exclude, and an ignored one is left alone", async () => {
  // A name no global gitignore holds: `.claude/settings.local.json` is in many people's (this author's included), which is the second half below.
  const generated = ".ticket-mode-generated";
  const { clone, root } = remoteAndClone();
  const path = worktreePath(root, "NBF-4", "repo-a");
  await addWorktree({ repo: "repo-a", clone, path, branch: "nbf-4-fix" }, git);
  await excludeFromGit(path, generated, { git });
  await excludeFromGit(path, generated, { git });
  const exclude = readFileSync(join(clone, ".git", "info", "exclude"), "utf8");
  assert.equal(exclude.split("\n").filter((line) => line === generated).length, 1);
  const appended: string[] = [];
  await excludeFromGit(path, generated, { git, append: (_p, line) => appended.push(line) });
  assert.deepEqual(appended, [], "already ignored, so nothing is appended");
});

test("a worktree stacked on another ticket's work is made from that branch, freshly fetched, and a retry keeps it", async () => {
  const { clone, root } = remoteAndClone();
  const remote = join(clone, "..", "remote");
  gitSync(remote, ["checkout", "-q", "-b", "nbf-1-fit"]);
  commit(remote, "on nbf-1-fit");
  gitSync(remote, ["checkout", "-q", "develop"]);
  const path = worktreePath(root, "NBF-2", "repo-a");
  const made = await addWorktree({ repo: "repo-a", clone, path, branch: "nbf-2-zoom", from: "nbf-1-fit" }, git);
  assert.equal(made.base, "nbf-1-fit");
  assert.equal(gitSync(path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "nbf-2-zoom");
  assert.equal(gitSync(path, ["log", "-1", "--format=%s"]).trim(), "on nbf-1-fit", "the clone had never fetched that branch");
  assert.equal((await reuseWorktree({ repo: "repo-a", clone, path, branch: "nbf-2-zoom" }, git)).path, path);
});
