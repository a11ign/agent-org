// @ts-check
// module: the atomic reviewer plugin -- the gate's codex reviewer, behind the reviewer contract (A11-161)
//
// A BUNDLED AGENT-ORG PLUGIN (`plugins/README.md`), NAMED `atomic` THOUGH ITS FOLDER IS `atomic-reviewer`: live host files name it `atomic` (`tickets.reviewer: "atomic"`, `provider: "atomic"`),
// so its manifest's `agentOrg.name` keeps the name and no host file is migrated. `package.json`'s `agentOrg` field is the manifest's data half, which the registry reads without importing
// this file; it declares no settings (`required` is the reviewer CONCERN's, core's) and no agent tooling, since the reviewer runs Codex through the gate and not through an MCP server. This is the code
// half, imported only when a host enables the plugin: `create` builds the reviewer, `doctorChecks` are the rows doctor shows, and `onboardSteps` is what onboard runs for it. It has no `release`:
// disabling the reviewer stops NEW starts only, and a reviewer still running finishes and posts through the gate's door.
//
// IT IMPORTS CORE'S TYPES ONLY (ADR 0001). THE GATE STAYS CORE'S, shared with the org's own reviewer, and reaches the plugin through `deps.reviewing`, with the board's collaborators.
import type { Reviewer } from "../../src/plugins/contracts/reviewer.ts";
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { atomicChecks } from "./checks.ts";
import { ONBOARD_STEPS } from "./onboard.ts";
import { atomicReviewerPort, portWhereGateLoads } from "./port.ts";

/**
 * The atomic reviewer. `load` reads the gate's modules and keeps a refusal rather than throwing it, and `refusal` says it: a host with no `primary` cannot load the gate, so the reviewer starts
 * none there. Building it asks the gate nothing, since the plugin is built at activation, before `load`; each call of the port asks it when it is used.
 */
export function create(_settings: PluginSettings, deps: PluginDeps): Reviewer {
  const { reviewing } = deps;
  const port = portWhereGateLoads(atomicReviewerPort(reviewing), reviewing.gateRefusal);
  return { ...port, load: reviewing.loadGate, refusal: reviewing.gateRefusal };
}

/** The rows doctor shows for the plugin: the gate's modules load, and Codex is on the path and logged in. */
export const doctorChecks = (settings: PluginSettings, deps: PluginDeps): Promise<readonly PluginCheck[]> => atomicChecks(settings, deps);

export const onboardSteps = ONBOARD_STEPS;
