// @ts-check
// module: the host install an update runs after it, from the INSTALLED release (A11-354)
//
// A RELEASE THAT SHIPS A UNIT OR A HOST FILE DID NOT PUT IT ON THE HOST. On 2026-10-27 A11-348's `tmp-prune` unit shipped and the host kept running the copy of 2026-10-17: `host:install`
// is refused inside a ticket run (the hook's `HOST_INSTALL_REFUSAL`), and nothing else ran it. `host:check` listed the launcher, the workers README and the reviewers' door as DIVERGED or
// DRIFTED the same day, and the finding for each said to run the command a person could not run.
//
// So the update runs it, last, on every run: `node <tool>/current/src/bin.ts host:install --unattended`. FROM `current`, the release the update has just made current (or kept), and never
// from a checkout: `host.json`'s `tool` is a checkout that was at v0.277.0 on 2026-10-27 and holds nothing a release ships. It runs as a program of its own, not as a call: the code running this
// update is the PREVIOUS release's, and the units and files to install are the NEW release's templates. A pass over a host that is current writes nothing and runs no `systemctl`, so running it
// every ten minutes costs a process start.
//
// WHAT IT SAYS: the lines the install printed are the update's log (which unit was replaced, which lines changed, where the previous copy was kept), and a step that failed is an error line. Neither
// fails the update: the tool has moved, and `host:check` is where a file that stays different is reported.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hostFilePath } from "./paths.ts";
import { runProgram, type ConventionsUpdate, type Run } from "./plugin-install.ts";
import { currentLink } from "./tool-versions.ts";

/** The words of `text`, one line each, without the empty ones. */
const linesOf = (text: string): string[] => text.split("\n").map((line) => line.trimEnd()).filter((line) => line !== "");

/**
 * The host install of the release `current` names, as an update's upkeep step: what it printed, and what failed. Never throws.
 * @param {string} tool the tool's install directory (`<agent-org home>/tool`)
 * @param {{ run?: (file: string, args: string[], env?: Record<string, string | undefined>) => ReturnType<Run>, exists?: (path: string) => boolean, node?: string, env?: NodeJS.ProcessEnv }} [seams] the program runner, the file test, the node binary and the environment
 */
export function hostInstallUpkeep(tool: string, { run = runProgram, exists = existsSync, node = process.execPath, env = process.env }: {
  run?: (file: string, args: string[], env?: Record<string, string | undefined>) => ReturnType<Run>; exists?: (path: string) => boolean; node?: string; env?: NodeJS.ProcessEnv;
} = {}): ConventionsUpdate {
  const bin = join(currentLink(tool), "src", "bin.ts");
  if (!exists(bin)) return { said: [`host install: ${tool} has no current release, so nothing was installed`], failed: [] };
  const result = run(node, [bin, "host:install", "--unattended"], { AGENT_ORG_HOST: hostFilePath(env) });
  if (result.status === 0) return { said: linesOf(result.stdout), failed: [] };
  const why = result.status === null ? "it could not start" : `it exited ${result.status}`;
  return { said: linesOf(result.stdout), failed: [`host install FAILED (${why}), so the host may still run an earlier copy of what ${bin} ships:`, ...linesOf(result.stderr)] };
}
