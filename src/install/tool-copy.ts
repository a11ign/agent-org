// @ts-check
// module: which copy of the tool a path is, and whether it is at least as new as the installed one (A11-285)
//
// THE INSTALLED TOOL IS `<tool>/current`, resolved. A COPY is the root a `bin.ts` lives in: a version folder, a checkout, or anything else. On 2026-10-25 a person's `agent-org`
// was an alias to a checkout at v0.276.0 while the install was v0.304.1, and `agent-org update` run from that copy moved `current` without the UI build. So doctor, the install
// and the bin's guard all ask the one question here: is this copy the installed tool, and if it is not, is it older?
//
// HOW TWO VERSIONS ARE ORDERED. Two release tags are ordered numerically (`compareReleaseTags`). Anything else is ordered by git ancestry, because a checkout of `main` says
// `0.2.0` in its package.json (`release.yml` says main's version lags the last tag) and a version number cannot place it against a release. The installed release's SOURCE commit is
// the first parent of its tag commit in the mirror (the release commit is built on top of the merge); a `main-<sha>` folder is that sha. A copy is at least as new when that
// commit is an ancestor of the copy's own commit. A copy that lacks the commit is `unknown`, and `unknown` is refused as older: a copy not shown to be newer is not allowed.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { compareReleaseTags, isReleaseTag } from "../lib/release-tag.ts";
import { currentLink, mirrorPath, toolVersionAt, versionNameOf } from "./tool-versions.ts";

const GIT_TIMEOUT_MS = 10_000;
const SHORT_SHA = 7;
const MAIN_FOLDER = /^main-([0-9a-f]{7,40})$/;

export type GitResult = Readonly<{ status: number | null; stdout: string }>;

/** What a copy was compared with, and how it came out. `copy` and `installed` are display versions (`v0.276.0`, `main@1a2b3c4`). */
export type CopyComparison =
  | Readonly<{ kind: "installed" }>
  | Readonly<{ kind: "no-install" }>
  | Readonly<{ kind: "newer-or-same" | "older"; copy: string; installed: string }>
  | Readonly<{ kind: "unknown"; copy: string; installed: string; reason: string; fix: string }>;

/** The three things a comparison asks of the machine; a test injects each, so no git runs. */
export type CopySeams = Readonly<{
  /** The real path of `path`, or null when it does not resolve. */
  realpath: (path: string) => string | null;
  /** `git -C <cwd> <args>`, with a timeout and a scrubbed environment. */
  git: (cwd: string, args: readonly string[]) => GitResult;
  /** The version a checkout's `package.json` says (`v0.2.0`), or null. */
  packageVersion: (root: string) => string | null;
}>;

export const realCopySeams: CopySeams = {
  realpath: (path) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  },
  git: (cwd, args) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: sandboxGitEnv(), stdio: ["ignore", "pipe", "ignore"] });
    return { status: result.status, stdout: result.stdout ?? "" };
  },
  packageVersion: (root) => toolVersionAt(root),
};

const succeeded = (result: GitResult): boolean => result.status === 0;
const firstLine = (result: GitResult): string | null => (succeeded(result) ? result.stdout.trim().split("\n")[0] || null : null);

/** The version a copy displays as: its version folder's name, else its exact tag, else `main@<short sha>`, else its package's version. */
export function copyVersion(root: string, seams: CopySeams = realCopySeams): string {
  const folder = versionNameOf(root);
  if (folder !== null) return folder;
  const tag = firstLine(seams.git(root, ["describe", "--tags", "--exact-match"]));
  if (tag !== null) return tag;
  const sha = firstLine(seams.git(root, ["rev-parse", `--short=${SHORT_SHA}`, "HEAD"]));
  return sha !== null ? `main@${sha}` : seams.packageVersion(root) ?? "an unknown version";
}

/** The commit the installed release was built from: a `main-<sha>` folder's sha, else the first parent of the tag's commit in the mirror. Null when the mirror cannot say. */
function installedSource(tool: string, name: string, seams: CopySeams): string | null {
  const main = MAIN_FOLDER.exec(name);
  if (main !== null) return main[1];
  return firstLine(seams.git(mirrorPath(tool), ["rev-parse", "--verify", "--quiet", `${name}^{commit}^1`]));
}

/** The commit a copy is at, and the repository that holds it: the mirror for a release or `main-<sha>` folder, the copy itself otherwise. */
function copyCommit(tool: string, root: string, seams: CopySeams): { repo: string; commit: string } | null {
  const folder = versionNameOf(root);
  const main = folder === null ? null : MAIN_FOLDER.exec(folder);
  if (main !== null) return { repo: mirrorPath(tool), commit: main[1] };
  const fromMirror = folder !== null && isReleaseTag(folder);
  const repo = fromMirror ? mirrorPath(tool) : root;
  const commit = firstLine(seams.git(repo, ["rev-parse", "--verify", "--quiet", fromMirror ? `${folder}^{commit}` : "HEAD"]));
  return commit === null ? null : { repo, commit };
}

/**
 * How the copy at `copyRoot` stands against the installed tool of `tool` (`<agent-org home>/tool`).
 * @returns `installed` when it is the tool `current` names, `no-install` when there is no `current` (nothing to compare with), else whether it is `older`.
 */
export function compareWithInstalled(copyRoot: string, { tool }: Readonly<{ tool: string }>, seams: CopySeams = realCopySeams): CopyComparison {
  const installedReal = seams.realpath(currentLink(tool));
  if (installedReal === null) return { kind: "no-install" };
  if (seams.realpath(copyRoot) === installedReal) return { kind: "installed" };
  const installedName = versionNameOf(installedReal) ?? basename(installedReal);
  const copy = copyVersion(copyRoot, seams);
  const bothTags = isReleaseTag(copy) && isReleaseTag(installedName);
  if (bothTags) return { kind: compareReleaseTags(copy, installedName) >= 0 ? "newer-or-same" : "older", copy, installed: installedName };
  return byAncestry({ tool, copyRoot, copy, installedName }, seams);
}

function byAncestry({ tool, copyRoot, copy, installedName }: Readonly<{ tool: string; copyRoot: string; copy: string; installedName: string }>, seams: CopySeams): CopyComparison {
  const unknown = (reason: string, fix: string): CopyComparison => ({ kind: "unknown", copy, installed: installedName, reason, fix });
  const source = installedSource(tool, installedName, seams);
  if (source === null) return unknown(`the install's mirror (${mirrorPath(tool)}) does not name the commit ${installedName} was built from`, `agent-org update`);
  const at = copyCommit(tool, copyRoot, seams);
  if (at === null) return unknown(`${copyRoot} is not a git checkout, so its age cannot be told from ${installedName}`, `use the installed tool: node ${currentLink(tool)}/src/bin.ts`);
  const ancestry = seams.git(at.repo, ["merge-base", "--is-ancestor", source, at.commit]);
  if (succeeded(ancestry)) return { kind: "newer-or-same", copy, installed: installedName };
  // Exit 1 is "not an ancestor"; any other status is git saying it does not have the commit (or could not run), which is not the same as older.
  if (ancestry.status === 1) return { kind: "older", copy, installed: installedName };
  return unknown(`${copyRoot} does not hold ${installedName}'s source commit ${source.slice(0, SHORT_SHA)}`, `git -C ${copyRoot} fetch origin --tags`);
}
