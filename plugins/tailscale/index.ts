// @ts-check
// module: the Tailscale plugin -- the exposure that serves the board and the worker terminal on the tailnet, behind the exposure contract (A11-162)
//
// A BUNDLED AGENT-ORG PLUGIN (`plugins/README.md`). `package.json`'s `agentOrg` field is the manifest's data half, which the registry reads without importing this file: the settings the
// Settings page draws (`port`, `uiPort`, `terminal`, `tailnetPorts`). This is the code half, imported only when a host enables the plugin: `create` builds the exposure, `doctorChecks`
// are the rows doctor shows, `onboardSteps` are what onboard runs for it, and `release` takes its entries off the tailnet before it is switched off. EVERY `tailscale` CALL IS MADE IN
// THIS FOLDER AND NOWHERE ELSE.
//
// IT IMPORTS CORE'S TYPES ONLY (ADR 0001). `tailscale` is run through `deps.exec`, so core's tests and the contract suite run it against a stand-in.
import type { Exposure } from "../../src/plugins/contracts/exposure.ts";
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { tailnetChecks } from "./checks.ts";
import { createExposure } from "./exposure.ts";
import { ONBOARD_STEPS } from "./onboard.ts";

/** The Tailscale exposure for an exposure block: it asks Tailscale nothing until it is asked, so a host without it still starts, and doctor says what is missing. */
export const create = (settings: PluginSettings, deps: PluginDeps): Exposure => createExposure(settings, deps);

/** The rows doctor shows for the plugin: Tailscale is Running with a name, and each served port has this board's entry, is off Funnel and answers. */
export const doctorChecks = (settings: PluginSettings, deps: PluginDeps): Promise<readonly PluginCheck[]> => tailnetChecks(settings, deps);

export const onboardSteps = ONBOARD_STEPS;

export { release, restore } from "./onboard.ts";
