// @ts-check
// module: the GitHub plugin -- the code host, behind the codeHost contract (A11-160)
//
// A BUNDLED AGENT-ORG PLUGIN (`plugins/README.md`). `package.json`'s `agentOrg` field is the manifest's data half, which the registry reads without importing this file: the settings the
// Settings page draws (`identity`, `gh`, `stack`). This is the code half, imported only when a host enables the plugin: `create` builds the code host, `doctorChecks` are the rows doctor
// shows, `onboardSteps` are what onboard runs for it, and `keep` is what `agent-org update` keeps true. THE `gh` PROCESS IS STARTED IN THIS FOLDER AND NOWHERE ELSE (`gh.ts`).
//
// IT IMPORTS CORE'S TYPES ONLY (ADR 0001). `gh` and `git` are run through `deps.exec`, so core's tests and the contract suite run it with no GitHub.
import type { CodeHost } from "../../src/plugins/contracts/code-host.ts";
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { stackChecks } from "./checks.ts";
import { createCodeHost } from "./code-host.ts";
import { ONBOARD_STEPS } from "./onboard.ts";

/** The GitHub code host: it reads nothing until asked, so a host with no `gh` still starts, and doctor says what is missing. */
export const create = (_settings: PluginSettings, deps: PluginDeps): CodeHost => createCodeHost(deps);

/** The rows doctor shows for the plugin: the stacking extension for the workers' account, and whether GitHub makes stacked pull requests available. */
export const doctorChecks = (settings: PluginSettings, deps: PluginDeps): readonly PluginCheck[] => stackChecks(settings, deps);

export const onboardSteps = ONBOARD_STEPS;

export { keep } from "./onboard.ts";
