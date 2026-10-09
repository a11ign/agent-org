// @ts-check
// #3443: WHICH RELEASE THE TOOL IS RUNNING, READ OFF ITS CHECKOUT AND NEVER REMEMBERED. Its own file, and not in `update-tool.mjs`, because `work-tick.mjs` prints
// it and `update-tool.mjs` imports the worktree pruner: a tick that imported THAT would put the git-history readers in the closure of every test that reaches the
// tick (`work-gate.test.ts`'s #2174 population guard refused exactly that edge).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "./git-env.ts";
import { compareReleaseTags, isReleaseTag } from "./release-tag.ts";

/** @param {string} cwd @returns {(args: string[]) => string} */
export const gitIn = (cwd: string): (args: string[]) => string => (args) => execFileSync("git", args, { cwd, env: sandboxGitEnv(), encoding: "utf8" });

/** The tool's own `src` directory, which is inside whatever checkout it was run from. */
const TOOL_SRC = fileURLToPath(new URL("..", import.meta.url));

/**
 * THE VERSION THE TOOL IS RUNNING: the newest release tag pointing at HEAD, or `null` when HEAD is no release. This is the producer #928's readings and the
 * liaison's "what's going on?" (a11ign/a11ign#3420) call; `git describe --tags --exact-match` names ONE tag when several point at HEAD, and this names the
 * newest release among them.
 * @param {(args: string[]) => string} [run] git, in the directory whose version is asked (this tool's own when left to default)
 * @returns {string | null} `vX.Y.Z`
 */
export function liveToolVersion(run: (args: string[]) => string = gitIn(TOOL_SRC)): string | null {
  return run(["tag", "--points-at", "HEAD"]).split("\n").filter(isReleaseTag).toSorted(compareReleaseTags).at(-1) ?? null;
}

/**
 * The line a tick prints FIRST, so a journal read says which version made each decision: `agent-org vX.Y.Z`. A checkout at no release says so and
 * names its commit, and one whose version cannot be read says that; it never throws, because a tick must not fail on the line that reports on it.
 * @param {(args: string[]) => string} [run] @returns {string}
 */
export function toolVersionLine(run: (args: string[]) => string = gitIn(TOOL_SRC)): string {
  try {
    const tag = liveToolVersion(run);
    return tag === null ? `agent-org (at no release tag: ${run(["rev-parse", "--short", "HEAD"]).trim()})` : `agent-org ${tag}`;
  } catch (err) {
    return `agent-org (version unreadable: ${String(/** @type {any} */ (err)?.message ?? err).split("\n")[0]})`;
  }
}
