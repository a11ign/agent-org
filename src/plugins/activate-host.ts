// @ts-check
// module: the code host, activated for a host program that is called and not constructed (A11-160)
//
// `host:install`, `host:check` and the instance's start-up check of the routing wrapper reach the code host from functions many of the host's tests call with fixtures, so no deps chain carries it: the
// program's entry point awaits this once, and the code reads `activeCodeHost()` (`active.ts`). The providers are the host file's, read LEASHED (a file that does not read names the defaults, and the program's
// own read of the declaration says why): the code host is the only block built, so no tracker's key is read for a wrapper.
import { readFileSync } from "node:fs";
import { hostConfigPath } from "../host-config.ts";
import { providersOfText } from "../ticket-mode/providers.ts";
import { activatePlugins, realPluginDeps } from "./active.ts";
import { defaultCatalog } from "./registry.ts";

/** Activates the code host the host file names, for this process. REFUSES, by name, a plugin the loader refuses. */
export async function activateCodeHost(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let text: string | null = null;
  try {
    text = readFileSync(hostConfigPath({ env }), "utf8");
  } catch {
    text = null;
  }
  await activatePlugins(providersOfText(text), defaultCatalog(), realPluginDeps({ env, stateDir: "", pick: "assigned" }), undefined, ["codeHost"]);
}
