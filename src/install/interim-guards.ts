// module: the two interim guards that were set by hand on the agents host, and that onboard retires once their replacements are proven (A11-145)
//
// THE GUARDS: the `gh-wrapper-watchdog` timer and service and its script (a stop-gap until A11-84 checked the gh wrapper at start), and the instance unit's
// `keep-herdr.conf` drop-in, `KillMode=process`, which kept herdr alive across an instance restart before herdr had its own scope (A11-90).
//
// A GUARD IS REMOVED ONLY WHEN ITS REPLACEMENT HOLDS, and the check is read here, never assumed: the watchdog's replacement is the start-time wrapper check,
// proven by the installed wrapper being the one the host file declares (`ghWrapperDivergence`, asked of the code host plugin's wrapper); the drop-in's is herdr's own scope, proven by the herdr server of
// the instance's session being outside the instance's cgroup (`hostIsolation`). A guard whose replacement is not proven is left, with a sentence saying what
// to do. Nothing here stops herdr or touches a running worker, and only Linux with systemd has either guard.
import { join } from "node:path";
import { agentOrgHome, type Env } from "./paths.ts";
import type { RunResult } from "./service.ts";

/** The replacements, each proven by a read: the installed `gh` wrapper declares the roles the host file does, and herdr sits outside the instance's cgroup. */
export type Replacements = Readonly<{ ghWrapperDeclared: boolean; herdrOutsideInstance: boolean }>;

export type GuardDeps = Readonly<{
  platform: NodeJS.Platform;
  env: Env;
  home: string;
  exists: (path: string) => boolean;
  remove: (path: string) => void;
  run: (file: string, args: string[]) => RunResult;
  /** The replacements, read now. Asked only when a guard is present. */
  replacements: () => Promise<Replacements>;
}>;

const WATCHDOG_TIMER = "gh-wrapper-watchdog.timer";
const WATCHDOG_SERVICE = "gh-wrapper-watchdog.service";
const DROP_IN_NAME = "keep-herdr.conf";

/** The watchdog's three files, and the drop-in, under the user's systemd directory and the agent-org home. */
export function guardPaths(env: Env, home: string): Readonly<{ watchdog: readonly string[]; dropIn: string }> {
  const units = join(home, ".config", "systemd", "user");
  return {
    watchdog: [join(units, WATCHDOG_TIMER), join(units, WATCHDOG_SERVICE), join(agentOrgHome(env, home), "bin", "gh-wrapper-watchdog")],
    dropIn: join(units, "agent-org-instance.service.d", DROP_IN_NAME),
  };
}

/** The reload systemd needs after a unit or drop-in changed on disk. A failure is said by its caller, never thrown. */
const daemonReload = (deps: GuardDeps) => deps.run("systemctl", ["--user", "daemon-reload"]);

/**
 * Removes each guard present whose replacement is proven, and says what it did and what it kept. Returns the lines to print. A host with neither guard, or a
 * platform with no systemd user units, says nothing and changes nothing.
 */
export async function retireGuards(deps: GuardDeps): Promise<string[]> {
  if (deps.platform !== "linux") return [];
  const paths = guardPaths(deps.env, deps.home);
  const lines: string[] = [];
  const watchdogPresent = paths.watchdog.some((path) => deps.exists(path));
  const dropInPresent = deps.exists(paths.dropIn);
  if (!watchdogPresent && !dropInPresent) return lines;
  const proof = await deps.replacements();
  if (watchdogPresent) {
    if (proof.ghWrapperDeclared) {
      deps.run("systemctl", ["--user", "disable", "--now", WATCHDOG_TIMER]);
      for (const path of paths.watchdog) deps.remove(path);
      daemonReload(deps);
      lines.push("retired the gh-wrapper watchdog: the start-time wrapper check holds, since the installed wrapper is the one host.json declares");
    } else {
      lines.push("kept the gh-wrapper watchdog: the installed gh wrapper is not the one host.json declares, so its check is not proven. Run `agent-org host:install`, then run onboard again");
    }
  }
  if (dropInPresent) {
    if (proof.herdrOutsideInstance) {
      deps.remove(paths.dropIn);
      daemonReload(deps);
      lines.push("retired the KillMode drop-in: herdr's own scope holds, since the herdr server is outside the instance's cgroup");
    } else {
      lines.push("kept the KillMode drop-in: a herdr server is still inside the instance's cgroup. Restart herdr when no run is working (`herdr --session <session> server stop`), then run onboard again");
    }
  }
  return lines;
}
