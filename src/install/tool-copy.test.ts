// no-token: none -- git runs only in repositories this file builds in a temporary directory; nothing reaches the network, `gh` or the real home
/**
 * WHICH COPY OF THE TOOL A PATH IS, AND WHETHER IT IS AT LEAST AS NEW AS THE INSTALLED ONE (A11-285).
 *
 * The installed tool is `<tool>/current`. Two release folders are ordered by their tags; anything else by git ancestry against the installed release's source commit (the first parent of its
 * tag commit in the mirror), because a checkout of `main` says `0.2.0` in its package.json and a version number cannot place it against a release.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { compareWithInstalled, copyVersion, realCopySeams, type CopyComparison, type CopySeams } from "./tool-copy.ts";

const GIT_ENV = sandboxGitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=f", "-c", "user.email=f@example.invalid", ...args], { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** An install whose `current` names `versions/<installed>`; the mirror is wherever `repo.git` is. */
function install(installed: string): { tool: string; folder: (name: string) => string } {
  const tool = join(tmpDir("tool-copy-"), "tool");
  const folder = (name: string): string => join(tool, "versions", name);
  for (const name of [installed, "v0.276.0", "v0.310.0"]) mkdirSync(join(folder(name), "src"), { recursive: true });
  symlinkSync(`versions/${installed}`, join(tool, "current"));
  return { tool, folder };
}

/** Git is never asked: a case that reaches it fails by throwing. */
const NO_GIT: CopySeams = { realpath: realCopySeams.realpath, git: () => { throw new Error("git must not be asked for two release folders"); }, packageVersion: () => null };

test("a copy that is the folder current names is the installed tool, and that needs no git", () => {
  const { tool, folder } = install("v0.304.1");
  assert.deepEqual(compareWithInstalled(folder("v0.304.1"), { tool }, NO_GIT), { kind: "installed" });
  assert.deepEqual(compareWithInstalled(join(tool, "current"), { tool }, NO_GIT), { kind: "installed" }, "the link itself is the installed tool");
});

test("an install with no current link has nothing to compare with", () => {
  const tool = join(tmpDir("tool-copy-"), "tool");
  assert.deepEqual(compareWithInstalled("/anywhere", { tool }, NO_GIT), { kind: "no-install" });
});

test("two release folders are ordered by their tags: v0.276.0 is older than v0.304.1, v0.310.0 is not", () => {
  const { tool, folder } = install("v0.304.1");
  assert.deepEqual(compareWithInstalled(folder("v0.276.0"), { tool }, NO_GIT), { kind: "older", copy: "v0.276.0", installed: "v0.304.1" });
  assert.deepEqual(compareWithInstalled(folder("v0.310.0"), { tool }, NO_GIT), { kind: "newer-or-same", copy: "v0.310.0", installed: "v0.304.1" });
});

/**
 * The mirror holds `old`, then `source` (a merge on main), then the release commit built on top of it and tagged. A checkout of main that went on from `source` is ahead; one still at `old` is behind;
 * a clone of a different history lacks the commit.
 */
function history() {
  const { tool, folder } = install("v0.304.1");
  const work = join(tool, "..", "work");
  mkdirSync(work, { recursive: true });
  git(work, "init", "--quiet", "--initial-branch=main");
  const commit = (message: string, version: string): string => {
    writeFileSync(join(work, "package.json"), `{"name":"agent-org","version":"${version}"}\n`);
    writeFileSync(join(work, "message"), message);
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", message);
    return git(work, "rev-parse", "HEAD");
  };
  const old = commit("old", "0.2.0");
  const source = commit("source", "0.2.0");
  git(work, "checkout", "--quiet", "-b", "release");
  commit("Release v0.304.1", "0.304.1");
  git(work, "tag", "v0.304.1");
  git(work, "checkout", "--quiet", "main");
  const ahead = commit("work after the release", "0.2.0");
  git(tool, "clone", "--quiet", "--bare", work, "repo.git");
  const checkout = (name: string, at: string): string => {
    const path = join(tool, "..", name);
    git(tool, "clone", "--quiet", work, path);
    git(path, "checkout", "--quiet", "--detach", at);
    return path;
  };
  return { tool, folder, old, source, ahead, checkout };
}

/** The comparison for a clone of the history, detached at its `ahead`, `source` or `old` commit. */
function compareClone(at: "ahead" | "source" | "old"): CopyComparison {
  const world = history();
  return compareWithInstalled(world.checkout(`clone-${at}`, world[at]), { tool: world.tool });
}

test("a checkout ahead of the installed release's source commit is newer-or-same, though its package.json says 0.2.0", () => {
  const result = compareClone("ahead");
  assert.equal(result.kind, "newer-or-same");
  assert.match((result as { copy: string }).copy, /^main@[0-9a-f]{7}$/);
  assert.equal((result as { installed: string }).installed, "v0.304.1");
});

test("a checkout at the source commit itself is newer-or-same: the release is built on top of it", () => {
  assert.equal(compareClone("source").kind, "newer-or-same");
});

test("a checkout behind the installed release's source commit is older", () => {
  const result = compareClone("old");
  assert.equal(result.kind, "older");
  assert.equal((result as { installed: string }).installed, "v0.304.1");
});

test("a checkout that lacks the commit is unknown, and the fix is the fetch that settles it", () => {
  const { tool } = history();
  const stranger = join(tool, "..", "stranger");
  mkdirSync(stranger);
  git(stranger, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(stranger, "a"), "x");
  git(stranger, "add", "-A");
  git(stranger, "commit", "--quiet", "-m", "elsewhere");
  const result = compareWithInstalled(stranger, { tool });
  assert.equal(result.kind, "unknown");
  assert.equal((result as { fix: string }).fix, `git -C ${stranger} fetch origin --tags`);
});

test("a folder that is no git checkout is unknown, and the fix names the installed tool", () => {
  const { tool } = history();
  const plain = join(tool, "..", "plain");
  mkdirSync(join(plain, "src"), { recursive: true });
  const result = compareWithInstalled(plain, { tool });
  assert.equal(result.kind, "unknown");
  assert.match((result as { fix: string }).fix, /\/current\/src\/bin\.ts$/);
});

test("a copy displays as its folder, else its exact tag, else main@sha, else its package's version", () => {
  const { tool, folder, ahead, checkout } = history();
  assert.equal(copyVersion(folder("v0.276.0")), "v0.276.0");
  assert.match(copyVersion(checkout("display", ahead)), /^main@[0-9a-f]{7}$/);
  const none: CopySeams = { realpath: () => null, git: () => ({ status: 128, stdout: "" }), packageVersion: () => "v0.9.0" };
  assert.equal(copyVersion(join(tool, "..", "no-such"), none), "v0.9.0");
});

test("on the main channel, version folders named main-<sha> are ordered by the sha they name", () => {
  const { tool, folder, old, source, ahead } = history();
  const short = (sha: string): string => sha.slice(0, 7);
  for (const sha of [old, source, ahead]) mkdirSync(join(folder(`main-${short(sha)}`), "src"), { recursive: true });
  rmSync(join(tool, "current"));
  symlinkSync(`versions/main-${short(source)}`, join(tool, "current"));
  assert.deepEqual(compareWithInstalled(folder(`main-${short(ahead)}`), { tool }), { kind: "newer-or-same", copy: `main-${short(ahead)}`, installed: `main-${short(source)}` });
  assert.equal(compareWithInstalled(folder(`main-${short(old)}`), { tool }).kind, "older");
  assert.equal(compareWithInstalled(folder("v0.304.1"), { tool }).kind, "newer-or-same", "a release cut on top of the installed commit is newer");
});
