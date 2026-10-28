// @ts-check
// module: the Linear plugin -- the tracker, behind the tracker contract (A11-159)
//
// A BUNDLED AGENT-ORG PLUGIN (`plugins/README.md`). `package.json`'s `agentOrg` field is the manifest's data half, which the registry reads without importing this file: the settings
// the Settings page draws, the connector patterns, and what a new-ticket run files with. This is the code half, imported only when a host enables the plugin: `create` builds the
// Linear source from the block's `key` setting and the deps core gives it, `doctorChecks` are the rows doctor shows, and `onboardSteps` are what onboard runs for it.
//
// IT IMPORTS CORE'S TYPES ONLY (ADR 0001). The key is read, and Linear is asked, through `deps` (`exec`, `readFile`, `fetch`), so core's tests and the contract suite run it
// without the Keychain or the network.
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import type { TicketSource } from "../../src/plugins/contracts/tracker.ts";
import { callsCheck, keyCheck, keyOf, mcpCheck } from "./checks.ts";
import { keySource } from "./key.ts";
import { linearSource } from "./linear.ts";
import { ONBOARD_STEPS } from "./onboard.ts";

/** The Linear source for a tracker block: the key is read once, from where `key` says, and sent only to Linear. REFUSES a `key` of the wrong shape, and a key that cannot be read, by name. */
export const create = (settings: PluginSettings, deps: PluginDeps): TicketSource =>
  linearSource({ key: keyOf(keySource(settings.key), deps), fetch: deps.freshFetch ?? deps.fetch, pick: deps.pick, stateDir: deps.recordCalls === true ? deps.stateDir : "", log: deps.log });

/** The rows doctor shows for the plugin: the key is readable, Linear's MCP is connected, and the board's calls to Linear mostly succeed. */
export const doctorChecks = (settings: PluginSettings, deps: PluginDeps): readonly PluginCheck[] => [keyCheck(settings, deps), mcpCheck(deps), callsCheck(deps)];

export const onboardSteps = ONBOARD_STEPS;
