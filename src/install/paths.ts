// @ts-check
// module: where an install made by `install.sh` keeps its files -- the tool's checkout, the host file and the services' logs
//
// ONE HOME, `~/.agent-org`, or `$AGENT_ORG_HOME` when it is set. `install.sh` clones the tool into `<home>/agent-org` and writes a launcher that exports
// `AGENT_ORG_HOME`, so every command it runs agrees with the installer on where the home is. The host file is `$AGENT_ORG_HOST` when that is set,
// because every other reader of the host file names it that way, and `<home>/host.json` otherwise.
//
// It imports nothing from the project-config chain: `onboard`, `doctor` and the service commands run on a machine that declares no project.
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Env = Readonly<Record<string, string | undefined>>;

/** The checkout this module runs from: `update` moves it, and the services run its `src/bin.ts`. */
export const TOOL_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** `$AGENT_ORG_HOME` when it is an absolute path, `~/.agent-org` otherwise. */
export function agentOrgHome(env: Env = process.env, home: string = homedir()): string {
  const named = env.AGENT_ORG_HOME;
  return named !== undefined && isAbsolute(named) ? named : join(home, ".agent-org");
}

/** The host file: `$AGENT_ORG_HOST` when set, `<home>/host.json` otherwise. */
export function hostFilePath(env: Env = process.env, home: string = homedir()): string {
  const named = env.AGENT_ORG_HOST;
  return named !== undefined && named !== "" ? named : join(agentOrgHome(env, home), "host.json");
}
