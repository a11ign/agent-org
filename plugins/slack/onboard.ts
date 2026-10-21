// @ts-check
// module: the Slack plugin's onboard step (A11-161) -- the publish run: its instruction, and the connectors it may call
//
// ONE STEP. When `run` or `connectors` is missing: an interactive onboard that no profile has answered asks for both; otherwise it answers `ok: false` with the `agent-org plugin config slack`
// command that sets them, and onboard goes on (a step that is not ok is said and does not stop it). A11-145's rule stands: a profile's publisher other than `none` is written into the profile
// by hand, so a profile never asks this step's questions.
import type { OnboardStep, PluginSettings, StepResult } from "../../src/plugins/manifest.ts";
import { isConnectors, isRun } from "./checks.ts";

/** The command that sets both, said when onboard cannot ask. */
const CONFIG_COMMAND = "agent-org plugin config slack run='<the publish run\\'s instruction, naming {prs} and {dir}>' connectors='[\"^mcp__<server>__<send tool>\"]'";

const patternsOf = (answer: string): string[] => answer.split(/[\s,]+/).filter((pattern) => pattern !== "");

export const ONBOARD_STEPS: readonly OnboardStep[] = [
  {
    name: "the publish run",
    explain: "Asks for the publish run's instruction and the connector tools it may post with, when the publish block lacks either; without a terminal it says the `agent-org plugin config slack` command that sets them.",
    async run(settings: PluginSettings, deps): Promise<StepResult> {
      if (isRun(settings.run) && isConnectors(settings.connectors)) return { ok: true, detail: "" };
      if (!deps.interactive || deps.answered) return { ok: false, detail: `the Slack publisher has no run or no connectors: run \`${CONFIG_COMMAND}\`` };
      const answeredRun = (await deps.ask("The publish run's instruction, naming {prs} (the pull requests, one per line) and {dir} (its folder): ")).trim();
      const answeredConnectors = patternsOf(await deps.ask("The connector tools the publish run may call, patterns starting ^mcp__ separated by spaces: "));
      // An empty answer keeps what the block holds.
      const run = answeredRun === "" ? settings.run : answeredRun;
      const connectors = answeredConnectors.length === 0 ? settings.connectors : answeredConnectors;
      if (!isRun(run) || !isConnectors(connectors)) return { ok: false, detail: `the Slack publisher still has no usable run or connectors: run \`${CONFIG_COMMAND}\`` };
      return { ok: true, detail: "the publish run is set", settings: { run, connectors } };
    },
  },
];
