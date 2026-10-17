// @ts-check
// module: the pnpm agent-org installs its own dependencies with -- one pinned version, run by version through the corepack Node ships
//
// NOT THE PNPM ON PATH, AND NOT COREPACK'S DEFAULT. Either can be any version the machine happens to have: on 2026-10-17 a Mac's PATH led to
// corepack 0.34's shim, whose last-known-good pnpm was 12.4.2, which that corepack cannot start, so `agent-org update` held with "install
// FAILED". Asking corepack for an exact version uses neither, and Node 24 always ships corepack beside `node`.
import { dirname, join } from "node:path";

/** The pnpm agent-org's releases are built with: `release.yml`'s `pnpm-version`. A test holds this, install.sh and CI to one value. */
export const TOOL_PNPM_VERSION = "10.34.5";

/** Run that pnpm with `args`, through the corepack beside `node`, without asking the shell's PATH for either. */
export function pinnedPnpm(args: readonly string[], node: string = process.execPath): { command: string; args: string[] } {
  const corepack = join(dirname(node), "..", "lib", "node_modules", "corepack", "dist", "corepack.js");
  return { command: node, args: [corepack, `pnpm@${TOOL_PNPM_VERSION}`, ...args] };
}
