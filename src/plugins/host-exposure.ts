// @ts-check
// module: the exposure plugin the machine's host file enables, for a process that is not the board (A11-162)
//
// THE EVENT TUNNEL'S UNIT AND THE KERNEL NOTES SERVE AND READ THE MACHINE'S ADDRESSES, and they used to run `tailscale` themselves. They ask the exposure the host file enables instead,
// which is how a host on `local` refuses them by name rather than failing in a program it does not have. It builds the exposure and nothing else, so it reads no tracker key.
//
// THE PROJECT'S HOST FILE MAY NAME NO EXPOSURE (A11-279). The tunnel's installed unit sets `AGENT_ORG_HOST` to the project's host file, which names no exposure provider; only the instance's own host file says
// `tailscale`. On 2026-10-25 the unit resolved `local` from the first and failed at boot ("local serves on loopback only"). So when `AGENT_ORG_HOST`'s file names no exposure, the instance's host file is read
// (the file the instance resolves without `AGENT_ORG_HOST`: `host-file`, its unit's, else `<home>/host.json`) and its exposure is used. A host that names none in either still resolves `local`.
import { homedir } from "node:os";
import { hostFilePath } from "../install/paths.ts";
import { readTicketSettings, type TicketSettings } from "../ticket-mode/settings.ts";
import { activatePlugins, realPluginDeps } from "./active.ts";
import type { Exposure } from "./contracts/exposure.ts";
import { defaultCatalog } from "./registry.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** Whether a host file names an exposure provider, in its block or by the `tickets.serve` alias. PURE. */
const namesExposure = (settings: TicketSettings): boolean => settings.providers.blocks.exposure.from !== "default";

/** The settings of the instance's own host file, or null when it is the same file as the project's, cannot be read, or names no exposure either. */
function instanceSettings(env: Env, home: string, project: string): TicketSettings | null {
  const path = hostFilePath({ ...env, AGENT_ORG_HOST: undefined }, home);
  if (path === project) return null;
  try {
    const settings = readTicketSettings({ ...env, AGENT_ORG_HOST: path }, undefined, home);
    return namesExposure(settings) ? settings : null;
  } catch {
    return null;
  }
}

/**
 * The exposure plugin this machine's host file (`AGENT_ORG_HOST`) enables, loaded; else the instance's host file's when that one names none. REFUSES, naming it, a host file the readers refuse and an exposure the loader
 * refuses. `home` is where the instance's host file is looked for.
 */
export async function hostExposure(env: Env = process.env, home: string = homedir()): Promise<Exposure> {
  const project = readTicketSettings(env);
  const settings = namesExposure(project) ? project : instanceSettings(env, home, hostFilePath(env, home)) ?? project;
  const active = await activatePlugins(settings.providers, defaultCatalog(), realPluginDeps({ env, stateDir: settings.stateDir, pick: settings.pick, clones: settings.clones }), undefined, ["exposure"]);
  return active.exposure();
}
