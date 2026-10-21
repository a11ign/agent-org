// @ts-check
// module: the local plugin -- the exposure that serves the board on loopback only, and the concern's default (A11-162)
//
// A BUNDLED AGENT-ORG PLUGIN (`plugins/README.md`). `package.json`'s `agentOrg` field is the manifest's data half: the settings the Settings page draws (`port`, `uiPort`, `terminal`).
// This is the code half. A host that names no exposure runs this plugin; so does a host whose exposure block is disabled. It has no onboard steps: loopback needs nothing installed.
//
// IT IMPORTS CORE'S TYPES ONLY (ADR 0001), and it never calls Tailscale.
import type { Exposure } from "../../src/plugins/contracts/exposure.ts";
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { localChecks } from "./checks.ts";
import { createExposure } from "./exposure.ts";

/** The local exposure: it serves nothing, answers no name, and refuses to serve a port. */
export const create = (_settings: PluginSettings, _deps: PluginDeps): Exposure => createExposure();

/** The rows doctor shows for the plugin: the instance and the page answer on loopback, and the terminal address is this machine's. */
export const doctorChecks = (settings: PluginSettings, deps: PluginDeps): Promise<readonly PluginCheck[]> => localChecks(settings, deps);

export const onboardSteps = [] as const;
