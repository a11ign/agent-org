// @ts-check
// module: the Slack plugin -- the publisher that announces the pull requests a person chose, behind the publisher contract (A11-161)
//
// A BUNDLED AGENT-ORG PLUGIN (`plugins/README.md`). `package.json`'s `agentOrg` field is the manifest's data half, which the registry reads without importing this file: the settings the Settings
// page draws (`run`, `model`, `effort`, `connectors`) and the Claude Code skill its publish run uses (`tooling.skills`). This is the code half, imported only when a host enables the plugin:
// `create` builds the publisher, `doctorChecks` are the rows doctor shows, and `onboardSteps` is what onboard runs for it.
//
// PUBLISHING IS AN AGENT RUN THE BOARD STARTS, so this plugin makes no Slack call: it says what the run is told, which connectors it may call, what model and effort it runs on and how its outcome
// reads. THE PUBLISH PROTOCOL IS CORE'S, NOT SLACK'S (`deps.publishing`): the run writes `published.json` and an outcome file, which every publisher's run does the same way.
//
// IT IMPORTS CORE'S TYPES ONLY (ADR 0001).
import type { Publisher } from "../../src/plugins/contracts/publisher.ts";
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { slackChecks } from "./checks.ts";
import { ONBOARD_STEPS } from "./onboard.ts";

/** The model and effort the publish run runs on when the block names none: a cheap, quick run, since it only posts. */
export const DEFAULT_MODEL = "haiku";
export const DEFAULT_EFFORT = "low";

const words = (value: unknown, fallback: string): string => (typeof value === "string" && value !== "" ? value : fallback);
const patterns = (value: unknown): readonly string[] => (Array.isArray(value) ? value.filter((pattern): pattern is string => typeof pattern === "string") : []);

/** The Slack publisher for a publish block. It asks Slack nothing: the publish run does the posting. */
export function create(settings: PluginSettings, deps: PluginDeps): Publisher {
  const connectors = patterns(settings.connectors);
  const agent = { model: words(settings.model, DEFAULT_MODEL), effort: words(settings.effort, DEFAULT_EFFORT) };
  return {
    briefText: (request) => deps.publishing.briefText(request),
    connectors: () => connectors,
    agent: () => agent,
    result: (outcomeText, dir) => deps.publishing.result(outcomeText, dir),
  };
}

/** The rows doctor shows for the plugin: the run names {prs} and {dir}, and the connectors are a list of patterns anchored at ^mcp__. */
export const doctorChecks = (settings: PluginSettings, _deps: PluginDeps): readonly PluginCheck[] => slackChecks(settings);

export const onboardSteps = ONBOARD_STEPS;
