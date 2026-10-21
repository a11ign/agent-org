// module: the two interim guards that were set by hand on the agents host, and that onboard and `start herdr --move` retire once their replacements are proven (A11-145, A11-169)
//
// THE GUARDS: the `gh-wrapper-watchdog` timer and service and its script (a stop-gap until A11-84 checked the gh wrapper at start), and the instance unit's
// `keep-herdr.conf` drop-in, `KillMode=process`, which kept herdr alive across an instance restart before herdr had a unit of its own (A11-90).
//
// A GUARD IS REMOVED ONLY WHEN ITS REPLACEMENT HOLDS, and the check is read here, never assumed: the watchdog's replacement is the start-time wrapper check,
// proven by the installed wrapper being the one the host file declares (`ghWrapperDivergence`, asked of the code host plugin's wrapper); the drop-in's is herdr's own service (A11-169), proven by the herdr
// server of the instance's session running in `agent-org-herdr.service` (`hostHerdrPlace`). A guard whose replacement is not proven is left, with a sentence saying what
// to do. Nothing here stops herdr or touches a running worker, and only Linux with systemd has either guard.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hostHerdrPlace } from "./herdr-place.ts";
import { agentOrgHome, hostFilePath, type Env } from "./paths.ts";
import type { RunResult, ServiceDeps } from "./service.ts";

/** The replacements, each proven by a read: the installed `gh` wrapper declares the roles the host file does, and herdr's server runs in its own service. */
export type Replacements = Readonly<{ ghWrapperDeclared: boolean; herdrInOwnUnit: boolean }>;

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

/** The guards present, as `doctor` reads them: the watchdog's files that exist, and the drop-in when it does. */
export function guardsPresent(env: Env, home: string, exists: (path: string) => boolean): Readonly<{ watchdog: boolean; dropIn: boolean }> {
  const paths = guardPaths(env, home);
  return { watchdog: paths.watchdog.some((path) => exists(path)), dropIn: exists(paths.dropIn) };
}

/** The herdr session the host file names, or `tickets` when it names none or cannot be read. */
function herdrSessionOf(env: Env, home: string): string {
  try {
    const named = (JSON.parse(readFileSync(hostFilePath(env, home), "utf8")) as { tickets?: { herdrSession?: unknown } }).tickets?.herdrSession;
    return typeof named === "string" ? named : "tickets";
  } catch {
    return "tickets";
  }
}

/** Whether the installed `gh` wrapper is the one the host file declares, asked of the code host plugin's wrapper; a host that cannot be asked (no declaration, a plugin the loader refuses) has not proven it. */
async function wrapperDeclared(): Promise<boolean> {
  try {
    const { activateCodeHost } = await import("../plugins/activate-host.ts");
    await activateCodeHost();
    const { ghWrapperDivergence } = await import("../host-units/gh-wrapper-and-notes.ts");
    return ghWrapperDivergence() === null;
  } catch {
    return false;
  }
}

/** Which replacements hold now: the installed gh wrapper is the one host.json declares, and the herdr server runs in its own service. */
export async function replacementsNow(env: Env, home: string, services: Pick<ServiceDeps, "platform" | "run" | "read" | "uid">): Promise<Replacements> {
  return {
    ghWrapperDeclared: await wrapperDeclared(),
    herdrInOwnUnit: hostHerdrPlace(services, herdrSessionOf(env, home)).kind === "unit",
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
    if (proof.herdrInOwnUnit) {
      deps.remove(paths.dropIn);
      daemonReload(deps);
      lines.push("retired the KillMode drop-in: herdr has a service of its own, since the herdr server runs in agent-org-herdr.service");
    } else {
      lines.push("kept the KillMode drop-in: the herdr server does not run in agent-org-herdr.service yet. Run `agent-org start herdr --move` at a quiet moment, which moves it and retires the drop-in");
    }
  }
  return lines;
}
