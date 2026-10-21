// @ts-check
// module: the exposure plugin the machine's host file enables, for a process that is not the board (A11-162)
//
// THE EVENT TUNNEL'S UNIT AND THE KERNEL NOTES SERVE AND READ THE MACHINE'S ADDRESSES, and they used to run `tailscale` themselves. They ask the exposure the host file enables instead,
// which is how a host on `local` refuses them by name rather than failing in a program it does not have. It builds the exposure and nothing else, so it reads no tracker key.
import { readTicketSettings } from "../ticket-mode/settings.ts";
import { activatePlugins, realPluginDeps } from "./active.ts";
import type { Exposure } from "./contracts/exposure.ts";
import { defaultCatalog } from "./registry.ts";

/** The exposure plugin this machine's host file (`AGENT_ORG_HOST`) enables, loaded. REFUSES, naming it, a host file the readers refuse and an exposure the loader refuses. */
export async function hostExposure(env: Readonly<Record<string, string | undefined>> = process.env): Promise<Exposure> {
  const settings = readTicketSettings(env);
  const active = await activatePlugins(settings.providers, defaultCatalog(), realPluginDeps({ env, stateDir: settings.stateDir, pick: settings.pick, clones: settings.clones }), undefined, ["exposure"]);
  return active.exposure();
}
