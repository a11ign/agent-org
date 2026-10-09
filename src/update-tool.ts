#!/usr/bin/env node
// @ts-check
// command: the one way to move the tool's own checkout: fetch the release tags, refuse a dirty tree, detach at the newest tag (or the pinned one)
// THE ANALOGUE OF `primary:update` FOR THE TOOL'S CHECKOUT -- #2793 (child 5b of #2623; ADR 0040, decision 3), changed by #3443 to follow RELEASES. Once
// `host.json` names a `tool`, the `work-tick` unit runs from a checkout of the tool's own repository and its first `ExecStartPre` is this command.
//
// THE HOST RUNS ONE AGENT-ORG VERSION, THE NEWEST RELEASE TAG (chairman, 2026-10-04, #3443). This used to detach at `origin/main`, so every merge was live within
// two minutes whether or not it was released, while a project that pins `github:a11ign/agent-org#semver:^0.7.0` ran the last RELEASE: two versions of one tool on
// one host, and the older one ran everything the chairman touches. Now `host.json`'s `toolVersion` is `"latest"` (the newest tag) or `"vX.Y.Z"` (that tag: the
// whole of a rollback), and a fix goes forward in the next tag. `release.yml` tags the merge that carries a changeset about nine minutes after it lands (measured
// from the tag history, #3443), so a shipped-code merge is live then; a merge with NO changeset is never tagged and never live, which is the point.
//
//   node src/update-tool.ts
//
// A RELEASE TAG IS NOT AN ANCESTOR OF `main`: the release workflow commits the version bump on top of the merge and pushes that commit as the tag alone, so it is
// reachable from no branch, and a plain `git fetch origin` does not bring it down. The fetch here NAMES TAGS (`--tags`), and the checkout is of the tag.
//
// A ROLLBACK TARGET MUST ITSELF FOLLOW TAGS: the checkout is a tag's tree, so the NEXT run is that tag's own `update-tool.mjs`. Pin a release cut after #3443; a
// pin to an older one is held for exactly one run and then moved to `origin/main` by that release's own code (measured in a scratch clone, 2026-10-04).
//
// NO TAG, NO MOVE, AND NO FALLBACK TO `origin/main`. With no `vX.Y.Z` tag, or a pinned one that is absent, it refuses by name and leaves the checkout where it is.
// The unit's `-` prefix means the tick then runs the last good version, and the refusal is in the journal. A fallback would put a second version back on the host.
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
// A PROCESS THAT KEEPS ITS OLD MODULES LOADED IS A SECOND VERSION AGAIN, so when the checkout MOVES this command restarts the long-running units
// (`LONG_RUNNING_TEMPLATES`: the chairman listener) with `systemctl --user try-restart`, which does nothing to a unit that is not running. It is done HERE, in the
// work-tick's `ExecStartPre`, because that is the one place that knows the checkout moved; a path unit would have been a unit class of its own.
//
// NO INSTALL AND NO BUILD, unlike `primary:update`: the tool imports no third-party module (ADR 0040, decision 1) and its `.mjs` files
// run as they are, so there is nothing to install and nothing to compile.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "./lib/cli-flags.mjs";
import { LATEST, chooseReleaseTag, isReleaseTag } from "./lib/release-tag.mjs";
import { gitIn } from "./lib/tool-version.mjs";
import { isPrimaryWorktree } from "./prune-worktrees.ts";

/** The directory this file is in, real-pathed: the tool is reached through a symlink on some hosts, and git resolves the real one. */
const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));

/**
 * The tracked files a checkout has modified, staged or not: what makes it dirty. A list, so a refusal can name them.
 * @param {(args: string[]) => string} run @returns {string[]}
 */
function dirtyPaths(run: (args: string[]) => string): string[] {
  return run(["status", "--porcelain", "--untracked-files=no"]).split("\n").filter((line) => line !== "");
}

/** @param {(args: string[]) => string} run @returns {string[]} */
const tagNames = (run: (args: string[]) => string): string[] => run(["tag", "--list"]).split("\n").filter((name) => name !== "");

/**
 * WHY NO TAG WAS CHOSEN, naming the pin or the missing release, and saying that nothing moved and that `origin/main` was not used instead.
 * @param {string} root @param {string} toolVersion @param {string[]} tags
 */
function noTagRefusal(root: string, toolVersion: string, tags: string[]) {
  const why = toolVersion === LATEST
    ? `it holds no release tag (v<major>.<minor>.<patch>) after fetching them; the tags it has: ${tags.join(", ") || "none"}`
    : `\`toolVersion\` pins ${toolVersion} and no such release tag exists after fetching them; the release tags it has: ${tags.filter(isReleaseTag).join(", ") || "none"}`;
  return new Error(`${root} was NOT moved: ${why}. It stays where it is and does NOT fall back to origin/main: the host runs a release, or the last one it ran.`);
}

/**
 * Move the tool's checkout to the release `toolVersion` names, and say which: `agent-org vX.Y.Z (<sha>)`.
 * @param {string} [root] the tool's checkout; the one holding this file when left to default
 * @param {(args: string[]) => string} [run] git, run in `root`
 * @param {string} [toolVersion] `"latest"`, or the release tag to hold the host at (`host.json`)
 * @returns {string}
 */
export function updateTool(root: string = gitIn(HERE)(["rev-parse", "--show-toplevel"]).trim(), run: (args: string[]) => string = gitIn(root), toolVersion: string = LATEST): string {
  if (!isPrimaryWorktree(root)) {
    throw new Error(`${root} is not a primary checkout (its .git is a linked worktree's, not a real directory) -- the tool's `
      + "checkout is a plain clone, and detaching a linked worktree would take it off the branch it is for.");
  }
  const dirty = dirtyPaths(run);
  if (dirty.length > 0) {
    throw new Error(`${root} has uncommitted changes to tracked files, so it was NOT moved:\n${dirty.join("\n")}\nThe tool's `
      + "checkout is read-only except fast-forward; commit the change where the tool is developed and discard it here.");
  }
  // `--tags` NAMES THEM: a release commit is reachable from no branch, so a plain fetch never brings its tag down. `--force`, since a tag
  // the remote moved is the remote's word and this clone has no tag of its own to protect.
  run(["fetch", "--force", "--tags", "--quiet", "origin"]);
  const tags = tagNames(run);
  const tag = chooseReleaseTag(tags, toolVersion);
  if (tag === null) throw noTagRefusal(root, toolVersion, tags);
  run(["checkout", "--detach", `refs/tags/${tag}`, "--quiet"]);
  return `agent-org ${tag} (${run(["rev-parse", "HEAD"]).trim()})`;
}

/**
 * The long-running units' rendered names, read BEFORE the checkout moves: after it, `import()` would load the NEW tree's modules into this old process, and a
 * module that changed its exports would fail the restart this exists for. A host that cannot name them (no `units` declaration) is TOLD so and restarts none; the
 * move itself stands.
 * @returns {Promise<string[]>}
 */
async function longRunningUnits(): Promise<string[]> {
  try {
    const { LONG_RUNNING_TEMPLATES, renderedName, readUnitsDeclaration } = await import("./host-config.ts");
    const { prefix } = readUnitsDeclaration();
    return LONG_RUNNING_TEMPLATES.map((template) => renderedName(template, prefix));
  } catch (err) {
    console.error(`CANNOT NAME THE LONG-RUNNING UNITS (${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0]}): none will be restarted if the checkout moves.`);
    return [];
  }
}

/** `systemctl`'s exit status for a unit it has no file for. */
const NOT_INSTALLED = 5;

/**
 * `try-restart` EACH LONG-RUNNING UNIT, because a process holding the old modules is a second version. It does nothing to a unit that is not running (a host
 * with no `messaging` key has no listener). A restart that fails is SAID on stderr and does not undo the move: the checkout is the version, and the listener
 * keeps running the old one until somebody reads this line.
 * @param {string[]} units
 * @param {{ exec?: (file: string, args: string[], options: object) => unknown, out?: Pick<Console, "log" | "error"> }} [deps] `systemctl` and where the lines go
 */
export function restartLongRunning(units: string[], { exec = execFileSync, out = console }: { exec?: (file: string, args: string[], options: object) => unknown; out?: Pick<Console, "log" | "error">; } = {}) {
  for (const unit of units) {
    try {
      exec("systemctl", ["--user", "try-restart", unit], { encoding: "utf8", stdio: ["ignore", "inherit", "pipe"] });
      out.log(`restarted ${unit} (try-restart) so it runs the version above`);
    } catch (err) {
      // systemctl's exit 5 is "unit not found": a host with no `messaging` key has no listener, and there is nothing running the old version to restart.
      if (/** @type {any} */ (err)?.status === NOT_INSTALLED) { out.log(`${unit} is not installed; nothing to restart`); continue; }
      out.error(`COULD NOT RESTART ${unit}: ${String(/** @type {any} */ (err)?.message ?? err)}. It still runs the PREVIOUS agent-org version.`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  // Guarded per #164: takes no flags -- a root argument is exactly what this command must not accept.
  refuseUnknownFlags([], { entry: import.meta.url, command: "node src/update-tool.ts" });
  const root = gitIn(HERE)(["rev-parse", "--show-toplevel"]).trim();
  const run = gitIn(root);
  const before = run(["rev-parse", "HEAD"]).trim();
  const { homeHostConfig } = await import("./host-config.ts");
  const restartable = await longRunningUnits();
  console.log(updateTool(root, run, homeHostConfig().toolVersion));
  if (run(["rev-parse", "HEAD"]).trim() !== before) restartLongRunning(restartable);
}
