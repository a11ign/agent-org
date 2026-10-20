// @ts-check
// module: where an install made by `install.sh` keeps its files -- the tool's checkout, the host file and the services' logs
//
// ONE HOME, `~/.agent-org`, or `$AGENT_ORG_HOME` when it is set. `install.sh` clones the tool into `<home>/agent-org` and writes a launcher that exports
// `AGENT_ORG_HOME`, so every command it runs agrees with the installer on where the home is. The host file is `$AGENT_ORG_HOST` when that is set,
// because every other reader of the host file names it that way, and `<home>/host.json` otherwise.
//
// A SHELL WITH NO `AGENT_ORG_HOST` STILL FINDS THE HOST FILE ONBOARD WROTE (A11-68). `ssh <machine> agent-org ticket:remote-info`
// runs in a non-interactive shell, which reads no profile, so a machine whose host file is not `<home>/host.json` answered "cannot be read" while
// its instance service, which names the file in its unit, ran fine (measured on the agents host, 2026-10-17). So the host file is, in order:
// `$AGENT_ORG_HOST`; the path in `<home>/host-file`, which onboard writes; the `AGENT_ORG_HOST` the instance service's unit carries, which
// `agent-org start` wrote from the shell that started it; and `<home>/host.json`. A pointer or unit that cannot be read, or that names a relative
// path, is passed over, never guessed from.
//
// It imports nothing from the project-config chain: `onboard`, `doctor` and the service commands run on a machine that declares no project.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProviders } from "../ticket-mode/providers.ts";

export type Env = Readonly<Record<string, string | undefined>>;

/** The checkout this module runs from: `update` moves it, and the services run its `src/bin.ts`. */
export const TOOL_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** `$AGENT_ORG_HOME` when it is an absolute path, `~/.agent-org` otherwise. */
export function agentOrgHome(env: Env = process.env, home: string = homedir()): string {
  const named = env.AGENT_ORG_HOME;
  return named !== undefined && isAbsolute(named) ? named : join(home, ".agent-org");
}

/** The file onboard writes the host file's path into, so a shell with no `AGENT_ORG_HOST` finds the same one. */
export const hostPointerPath = (env: Env = process.env, home: string = homedir()) => join(agentOrgHome(env, home), "host-file");

/** A file's text, or null when it cannot be read: the reader the host file's fallbacks are asked through. */
export type ReadOrNull = (path: string) => string | null;
export const readOrNull: ReadOrNull = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** The instance service's unit, on either service manager: its name is `service.ts`'s, restated so this module imports nothing. */
export const instanceUnitPaths = (home: string) => [
  join(home, ".config", "systemd", "user", "agent-org-instance.service"),
  join(home, "Library", "LaunchAgents", "io.github.agent-org.instance.plist"),
];

const unescapeXml = (text: string) => text.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The `AGENT_ORG_HOST` a unit `service.ts` wrote carries, or null. It reads both spellings: systemd's quoted `Environment=` and a plist's key. */
export function unitHostFile(text: string): string | null {
  const systemd = /^Environment="AGENT_ORG_HOST=((?:[^"\\]|\\.)*)"$/m.exec(text);
  if (systemd) return systemd[1].replace(/\\(.)/g, "$1").replace(/%%/g, "%").replace(/\$\$/g, "$");
  const launchd = /<key>AGENT_ORG_HOST<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
  return launchd ? unescapeXml(launchd[1]) : null;
}

/**
 * The host file: `$AGENT_ORG_HOST` when set; else the path onboard recorded in `<home>/host-file`; else the `AGENT_ORG_HOST` of the instance
 * service's unit; else `<home>/host.json`. A recorded path that is not absolute is passed over.
 */
export function hostFilePath(env: Env = process.env, home: string = homedir(), read: ReadOrNull = readOrNull): string {
  const named = env.AGENT_ORG_HOST;
  if (named !== undefined && named !== "") return named;
  const recorded = read(hostPointerPath(env, home))?.trim();
  if (recorded && isAbsolute(recorded)) return recorded;
  for (const unit of instanceUnitPaths(home)) {
    const text = read(unit);
    const fromUnit = text === null ? null : unitHostFile(text);
    if (fromUnit && isAbsolute(fromUnit)) return fromUnit;
  }
  return join(agentOrgHome(env, home), "host.json");
}

/**
 * The `gh` account directory the host file declares for workers, `<gh.workers>/gh`, or null when it declares none. An org host routes every `gh`
 * through a wrapper (`host/gh`) that refuses a call with no workspace id and no `GH_CONFIG_DIR`, so a `ticket:*` command run from a plain shell,
 * or a service, must name the same account the workers use (measured 2026-10-17: `agent-org ticket:review <pr>` from an ssh shell could not read
 * the pull request). A laptop's host file declares no `gh`, and its `gh` is the person's own.
 */
export function hostGhConfigDir(hostText: string | null): string | null {
  if (hostText === null) return null;
  try {
    // `gh` is read where it now lives, the code host's block, or where it lived before (A11-144): the same account either way.
    const workers = (resolveProviders(JSON.parse(hostText)).blocks.codeHost.settings.gh?.value as { workers?: unknown } | undefined)?.workers;
    return typeof workers === "string" && isAbsolute(workers) ? join(workers, "gh") : null;
  } catch {
    return null;
  }
}
