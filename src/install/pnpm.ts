// @ts-check
// module: the pnpm agent-org installs its own dependencies with -- one pinned version, run by version through the first runner this machine has
//
// NOT THE PNPM ON PATH, AND NOT COREPACK'S DEFAULT. Either can be any version the machine happens to have: on 2026-10-17 a Mac's PATH led to
// corepack 0.34's shim, whose last-known-good pnpm was 12.4.2, which that corepack cannot start, so `agent-org update` held with "install
// FAILED". Asking for an exact version uses neither.
//
// NOT EVERY NODE SHIPS COREPACK (A11-185). Homebrew's `node` formula has none, and Node 25 and later do not bundle it, so a Mac with Homebrew Node
// had nothing at `<node>/../lib/node_modules/corepack`. The runners are tried in this order, and `install.sh` holds the same order in bash:
//
//   1. the corepack beside node, as every install ran it before: a machine where this works today does not change;
//   2. a `corepack` on PATH, where `brew install corepack` and `npm install -g corepack` put it;
//   3. `npm exec --yes pnpm@<pinned> --`, which every npm has, so it is the floor.
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { npmCliScriptCandidates } from "../lib/npm-cli-executable.ts";

/** The pnpm agent-org's releases are built with: `release.yml`'s `pnpm-version`. A test holds this, install.sh and CI to one value. */
export const TOOL_PNPM_VERSION = "10.34.5";

/** The three ways to reach the pinned pnpm, in the order they are tried. */
export type PnpmRunner = "corepack beside node" | "corepack on PATH" | "npm exec";

/** What the choice reads from the machine: `node`, the directories `PATH` names, and whether a file is there. A test passes its own. */
export interface PnpmSearch { node: string; path: string; exists: (path: string) => boolean }

/** The commands that give a machine a runner, shown first on a Homebrew Node. Both are what the ticket (A11-185) names. */
export const COREPACK_FIXES = ["brew install corepack", "npm install -g corepack"];

function realSearch(): PnpmSearch {
  return { node: process.execPath, path: process.env.PATH ?? "", exists: existsSync };
}

/** Run the pinned pnpm with `args` through the first runner that exists, and say which. Throws, naming both fixes, when none does. */
export function pinnedPnpm(args: readonly string[], search: PnpmSearch = realSearch()): { command: string; args: string[]; via: PnpmRunner } {
  const pinned = `pnpm@${TOOL_PNPM_VERSION}`;
  const beside = join(dirname(search.node), "..", "lib", "node_modules", "corepack", "dist", "corepack.js");
  if (search.exists(beside)) return { command: search.node, args: [beside, pinned, ...args], via: "corepack beside node" };
  const onPath = search.path.split(delimiter).filter((dir) => dir !== "").map((dir) => join(dir, "corepack")).find(search.exists);
  if (onPath !== undefined) return { command: onPath, args: [pinned, ...args], via: "corepack on PATH" };
  const npm = npmCliScriptCandidates("npm").find(search.exists);
  if (npm !== undefined) return { command: search.node, args: [npm, "exec", "--yes", pinned, "--", ...args], via: "npm exec" };
  throw new Error(`pnpm ${TOOL_PNPM_VERSION} cannot run: there is no corepack beside node or on PATH, and no npm to run \`npm exec\` with. To fix it, run one of: ${COREPACK_FIXES.join(" ; ")}`);
}
