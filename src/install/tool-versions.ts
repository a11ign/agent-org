// @ts-check
// module: where the tool's versions live (A11-169) -- `<tool>/versions/<tag>`, the `current` link to the newest, and the version a folder is
//
// EACH RELEASE IS ITS OWN FOLDER, `<agent-org home>/tool/versions/<tag>` (`main-<short sha>` on the main channel), and `<tool>/current` is a symlink to the newest. Every unit
// and the launcher run `<tool>/current/src/bin.ts`. Node runs a script by its REAL path, so a process started through `current` has `TOOL_ROOT` (`paths.ts`) = its version
// folder: a run's hooks and brief commands name that folder, and an update that moves `current` changes nothing under a run that started before it.
//
// A CHECKOUT INSTALL (`install.sh` before this, and the agents host's own clone) is not under `versions/`: its version is its `package.json`'s.
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { agentOrgHome, TOOL_ROOT, type Env } from "./paths.ts";

/** The tool's install directory: `<agent-org home>/tool`. It holds the bare mirror `repo.git`, `versions/` and `current`. */
export const toolDir = (env: Env, home: string): string => join(agentOrgHome(env, home), "tool");
export const mirrorPath = (tool: string): string => join(tool, "repo.git");
export const versionsDir = (tool: string): string => join(tool, "versions");
export const versionFolder = (tool: string, name: string): string => join(versionsDir(tool), name);
/** The symlink to the newest version folder, which every unit and the launcher run through. */
export const currentLink = (tool: string): string => join(tool, "current");

/** The version folder's name (`v0.273.0`, or `main-1a2b3c4`) when `root` is a folder under a `versions/` directory, else null. */
export function versionNameOf(root: string): string | null {
  return basename(dirname(root)) === "versions" ? basename(root) : null;
}

/**
 * The version the code at `root` is: its folder's name when it is a version folder, else `v<package.json version>` (a checkout install). Null when neither can be read.
 * `read` is a seam for a test.
 */
export function toolVersionAt(root: string, read: (path: string) => string = (path) => readFileSync(path, "utf8")): string | null {
  const named = versionNameOf(root);
  if (named !== null) return named;
  try {
    const { version } = JSON.parse(read(join(root, "package.json"))) as { version?: unknown };
    return typeof version === "string" ? `v${version}` : null;
  } catch {
    return null;
  }
}

/** The version this process runs: {@link toolVersionAt} of `TOOL_ROOT`, which node sets to the real folder even when started through `current`. */
export const runningToolVersion = (): string | null => toolVersionAt(TOOL_ROOT);

/**
 * The path a unit or the launcher runs the tool through: `<tool>/current` when `root` is a version folder (so an update moves what they run without rewriting either), else `root` itself,
 * a checkout install that has not migrated yet.
 */
export function toolEntryOf(root: string): string {
  return versionNameOf(root) === null ? root : currentLink(dirname(dirname(root)));
}
