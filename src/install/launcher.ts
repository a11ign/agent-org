// @ts-check
// module: the text of the `agent-org` command (the shim), in one place (A11-285)
//
// The shim runs `<agent-org home>/tool/current/src/bin.ts`, so an update that moves `current` changes what it runs and the shim is never rewritten. `install.sh`'s `write_launcher`
// writes the same bytes from a heredoc, and `launcher.test.ts` runs that heredoc and compares the two, so they cannot drift. `onboard` and `command:check --fix` write it from here.
import { dirname } from "node:path";
import { writeAtomic } from "./write-atomic.ts";
import { currentLink } from "./tool-versions.ts";

const LAUNCHER_MODE = 0o755;

/** The shim's text for an install at `agentOrgHome`: it runs `current`, and exports the host file when `host.json` is there and none is set. */
export function launcherText({ agentOrgHome, current }: Readonly<{ agentOrgHome: string; current: string }>): string {
  return `#!/bin/sh
# The agent-org command, written by agent-org's install.sh. Running install.sh again rewrites it.
if [ -z "\${AGENT_ORG_HOME:-}" ]; then AGENT_ORG_HOME='${agentOrgHome}'; fi
export AGENT_ORG_HOME
if [ -z "\${AGENT_ORG_HOST:-}" ] && [ -f "$AGENT_ORG_HOME/host.json" ]; then
  AGENT_ORG_HOST="$AGENT_ORG_HOME/host.json"
  export AGENT_ORG_HOST
fi
exec node '${current}/src/bin.ts' "$@"
`;
}

/** The shim for an install whose tool folder is `tool` (`<agent-org home>/tool`). */
export const shimTextFor = (tool: string): string => launcherText({ agentOrgHome: dirname(tool), current: currentLink(tool) });

/** Writes the shim at `path`, through a temporary file and a rename, executable. */
export const writeLauncher = (path: string, text: string): void => writeAtomic(path, text, LAUNCHER_MODE);
