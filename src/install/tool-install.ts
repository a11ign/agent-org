// @ts-check
// module: the install's steps (A11-169) -- a bare mirror of the repository, one built folder per release, the `current` link, and the prune
//
// The layout these steps work in (`<tool>/repo.git`, `versions/<tag>`, `current`) is `tool-versions.ts`'s. Each step leaves the install whole if it fails: a folder is built beside and renamed into
// place, `current` moves with one rename, and a prune removes only what nothing names.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { pinnedPnpm } from "./pnpm.ts";
import { isReleaseTag } from "../lib/release-tag.ts";
import { declaresUiBuild, ensureUiBuild, hasUiBuild, releasesUrl, uiBuildAttached, type UiAttached, type UiSource } from "./ui-asset.ts";
import { currentLink, mirrorPath, versionFolder, versionsDir } from "./tool-versions.ts";

/** A program run as `execFileSync` runs it; a test passes one that records what it was asked to run. */
export type Exec = (file: string, args: string[], options: object) => unknown;
/** git in the bare mirror. */
export type Git = (args: string[]) => string;

/** The dependency install every release folder is given: production dependencies only, from no lockfile, running no script. The flags `update-tool.ts` has always used. */
export const PNPM_INSTALL = ["install", "--prod", "--no-frozen-lockfile", "--ignore-scripts", "--ignore-workspace"];
/** Inside what a person waits for on a first install, and inside a timer's run. */
const INSTALL_TIMEOUT_MS = 240_000;

/** git in `<tool>/repo.git`. */
export const mirrorGit = (tool: string, exec: Exec = execFileSync): Git => (args) =>
  String(exec("git", ["-C", mirrorPath(tool), ...args], { encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }));

/**
 * Make the mirror when there is none, from `remote` (a clone's `origin`, or the repository `install.sh` names), and say so. A mirror that is there is left as it is. A bare clone keeps no branch
 * refspec, so each fetch names what it wants (`fetchMirror`).
 */
export function seedMirror(tool: string, remote: string, exec: Exec = execFileSync): boolean {
  if (existsSync(join(mirrorPath(tool), "HEAD"))) return false;
  mkdirSync(tool, { recursive: true });
  exec("git", ["clone", "--bare", "--quiet", "--", remote, mirrorPath(tool)], { cwd: tool, env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });
  return true;
}

/** Fetch the release tags into the mirror (`--tags` NAMES them: a release commit is reachable from no branch), and `main` on the main channel. `--force`: a tag the remote moved is the remote's word. */
export function fetchMirror(git: Git, channel: "release" | "main"): void {
  git(["fetch", "--force", "--tags", "--quiet", "origin", ...(channel === "main" ? ["+refs/heads/main:refs/heads/main"] : [])]);
}

/** The tags the mirror holds. */
export const mirrorTags = (git: Git): string[] => git(["tag", "--list"]).split("\n").filter((name) => name !== "");

/** The short commit `main` is at in the mirror, for the main channel's folder name `main-<sha>`. */
export const mainVersionName = (git: Git): string => `main-${git(["rev-parse", "--short=8", "refs/heads/main"]).trim()}`;

/** What building a version folder did, and a line to say about its UI build when there is one (A11-191). A `failed` build leaves nothing behind but the reason. */
export type Build = Readonly<{ state: "built" | "present"; folder: string; said?: string }> | Readonly<{ state: "failed"; folder: string; reason: string }>;

/** The URL the mirror was cloned from, or null when it has none. */
function originOf(tool: string, exec: Exec): string | null {
  try {
    return String(exec("git", ["-C", mirrorPath(tool), "remote", "get-url", "origin"], { encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] })).trim();
  } catch {
    return null;
  }
}

/** Where the UI builds are fetched from: `AGENT_ORG_RELEASES_URL`, else the releases of the repository the mirror was cloned from (A11-191). */
export const mirrorUiSource = (tool: string, env: NodeJS.ProcessEnv = process.env, exec: Exec = execFileSync): UiSource => ({ releases: () => releasesUrl(originOf(tool, exec), env), exec });

/**
 * Give the version folder `name` the UI build its release ships, when the release declares one and the folder has none (A11-191). Used on the current folder when an update finds nothing newer: the
 * release that first ships the build is installed by the previous version's update, which fetches nothing, so the new version's own update completes it.
 */
export function completeUiBuild({ tool, name, ui = mirrorUiSource(tool) }: { tool: string; name: string; ui?: UiSource }): Build {
  const folder = versionFolder(tool, name);
  const step = ensureUiBuild({ folder, name, source: ui });
  return step.state === "failed" ? { state: "failed", folder, reason: step.reason } : { state: "present", folder, ...(step.said === undefined ? {} : { said: step.said }) };
}

/** Whether the release `tag` has its UI build for this machine (A11-284): a version folder that holds the build is attached, whatever the release now answers, and any other is asked for. */
export const uiBuildReleased = ({ tool, tag, ui = mirrorUiSource(tool) }: { tool: string; tag: string; ui?: UiSource }): UiAttached => (hasUiBuild(versionFolder(tool, tag)) ? "attached" : uiBuildAttached(ui, tag));

/** `dependencies` of the `package.json` in `folder`: none when there is no file or it names none. */
function dependenciesIn(folder: string): string[] {
  try {
    return Object.keys((JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {});
  } catch {
    return [];
  }
}

/**
 * Build `versions/<name>` from `ref` in the mirror: `git archive` into `<name>.partial`, the pinned pnpm install when the release declares dependencies, then a rename into place, so a failed or killed
 * build never leaves a half folder and a folder that is there is whole. A folder that is there is not built again, but it is given its UI build when its release declares one and it has none.
 * `pnpm` is the install's command (the pinned one in production); `exec` runs it; `ui` is where the release's UI build is fetched from, which a release before the marker never asks.
 *
 * THE UI BUILD IS FETCHED BEFORE THE DEPENDENCY INSTALL (A11-191): the likeliest failure is a release whose asset CI has not attached yet, and it should cost an unpack, not a pnpm install, each time
 * the timer tries again. A build that cannot be had fails the whole build, so the version never becomes current without it.
 */
export function buildVersion({ tool, name, ref, exec = execFileSync, pnpm = pinnedPnpm, ui = mirrorUiSource(tool) }: {
  tool: string; name: string; ref: string; exec?: Exec; pnpm?: (args: string[]) => { command: string; args: string[] }; ui?: UiSource;
}): Build {
  const folder = versionFolder(tool, name);
  if (existsSync(join(folder, "src", "bin.ts"))) return completeUiBuild({ tool, name, ui });
  const partial = `${folder}.partial`;
  const archive = `${partial}.tar`;
  try {
    rmSync(partial, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    execFileSync("git", ["-C", mirrorPath(tool), "archive", "--format=tar", `--output=${archive}`, ref], { env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("tar", ["-xf", archive, "-C", partial], { stdio: ["ignore", "pipe", "pipe"] });
    rmSync(archive, { force: true });
    if (!existsSync(join(partial, "src", "bin.ts"))) throw new Error(`${ref} holds no src/bin.ts, so it is not a release of agent-org`);
    const fetched = ensureUiBuild({ folder: partial, name, source: ui });
    if (fetched.state === "failed") throw new Error(fetched.reason);
    if (dependenciesIn(partial).length > 0) {
      const invocation = pnpm(PNPM_INSTALL);
      // pnpm's shim is `#!/usr/bin/env node`, and a unit's PATH need not hold the node this process runs on: put its directory first.
      const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", PATH: [dirname(process.execPath), process.env.PATH ?? ""].filter((dir) => dir !== "").join(delimiter) };
      exec(invocation.command, invocation.args, { cwd: partial, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: INSTALL_TIMEOUT_MS });
      if (!existsSync(join(partial, "node_modules"))) throw new Error(`\`pnpm ${PNPM_INSTALL.join(" ")}\` finished and left no node_modules in ${partial}`);
    }
    renameSync(partial, folder);
    return { state: "built", folder, ...(fetched.said === undefined ? {} : { said: fetched.said }) };
  } catch (err) {
    rmSync(partial, { recursive: true, force: true });
    rmSync(archive, { force: true });
    const text = String((err as { stderr?: unknown })?.stderr || (err as Error)?.message || err).trim();
    return { state: "failed", folder, reason: text.split("\n").filter((line) => line.trim() !== "").slice(-3).join(" | ") || "no output" };
  }
}

/**
 * Run `work` holding `<tool>/update.lock`, so two updates (the timer's and a person's, or the drain's forced start) never build the same folder at once. A lock whose process is gone is taken over. REFUSES,
 * naming the process, while another update holds it.
 */
export function withUpdateLock<T>(tool: string, work: () => T, alive: (pid: number) => boolean = processAlive): T {
  const lock = join(tool, "update.lock");
  mkdirSync(tool, { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = Number(readFileSync(lock, "utf8").trim());
      if (alive(holder) && attempt === 0) throw new Error(`another agent-org update is running (pid ${holder}): ${lock}`);
      rmSync(lock, { force: true });
    }
  }
  try {
    return work();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Whether a process id is running: signal 0 only asks, and a process that exists but is not this user's still counts. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The version `<tool>/current` names, or null when there is no link. */
export function currentVersionName(tool: string): string | null {
  try {
    return basename(readlinkSync(currentLink(tool)));
  } catch {
    return null;
  }
}

/** Whether the release `name`, unpacked in `folder`, declares a UI build and has none. The main channel never does: it has no Release to fetch a build from. */
const lacksDeclaredUiBuild = (name: string, folder: string): boolean => isReleaseTag(name) && declaresUiBuild(folder) && !hasUiBuild(folder);

/**
 * Point `<tool>/current` at `versions/<name>`: a new link is made beside it and renamed over it, the one atomic swap a link allows, so a service starting at any moment finds a whole tool. The target is
 * relative, so the home can move. REFUSES a version that is not built, and a release that declares a UI build and has none (A11-266): this is the one place `current` moves, so no caller can make a
 * board that shows "The UI build is missing". The main channel is exempt: it has no Release to fetch a build from (`ensureUiBuild`), and `doctor` fails on it.
 */
export function swapCurrent(tool: string, name: string): void {
  const folder = versionFolder(tool, name);
  if (!existsSync(join(folder, "src", "bin.ts"))) throw new Error(`versions/${name} is not built, so current stays where it is`);
  if (lacksDeclaredUiBuild(name, folder)) throw new Error(`versions/${name} declares a UI build and has none, so current stays where it is`);
  const link = currentLink(tool);
  const next = `${link}.${randomBytes(4).toString("hex")}.new`;
  symlinkSync(join("versions", name), next, "dir");
  try {
    renameSync(next, link);
  } catch (err) {
    rmSync(next, { force: true });
    throw err;
  }
}

/**
 * Remove each version folder nothing uses (A11-169): not `current`, not the folder of the process pruning, and not one a run that still has a workspace (live or parked) names. A parked run
 * counts as using its version, because an answer resumes it on its old settings. `inUse` is the queue's, read by the caller; a caller that could not read it prunes nothing. A leftover
 * `.partial` folder of an earlier failed build is removed too. @returns the names removed
 */
export function pruneVersions({ tool, inUse, self }: { tool: string; inUse: readonly string[]; self: string }): string[] {
  const dir = versionsDir(tool);
  if (!existsSync(dir)) return [];
  const keep = new Set([self, ...inUse, ...[currentVersionName(tool)].flatMap((name) => (name === null ? [] : [versionFolder(tool, name)]))].map((path) => resolve(path)));
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    const folder = join(dir, name);
    if (name.endsWith(".partial") || name.endsWith(".partial.tar")) {
      rmSync(folder, { recursive: true, force: true });
      continue;
    }
    if (keep.has(resolve(folder)) || keep.has(safeRealpath(folder))) continue;
    rmSync(folder, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
