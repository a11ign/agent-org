// module: the GitHub plugin's onboard step, and what `agent-org update` keeps true for it -- the stacking extension is installed for the workers' account (A11-160)
//
// Moved out of `install/onboard.ts` (`stackLine`) and `install/update.ts` (`keepStackExtension`) with their words unchanged. The extension serves stacked pull requests only, so a failure to
// install it is said with its reason and the command to run by hand, and is never thrown: doctor fails on it until it is there.
import type { OnboardStep, PluginDeps, PluginSettings, StepResult } from "../../src/plugins/manifest.ts";
import { accountRunner } from "./gh.ts";
import { type Account, ensureStackExtension, installCommand, STACK_EXTENSION, type StackExtension, stackRequired, workerAccount } from "./stack-extension.ts";

/** What onboard says of the extension, whatever the install did. */
function line(stack: StackExtension, account: Account): string {
  if (stack.state === "present") return `the ${STACK_EXTENSION} extension is installed (${stack.version}), which a worker links a stacked pull request with`;
  if (stack.state === "installed") return `installed the ${STACK_EXTENSION} extension (${stack.version}), which a worker links a stacked pull request with`;
  return `could not install the ${STACK_EXTENSION} extension: ${stack.reason}. Run \`${installCommand(account)}\` by hand, then \`agent-org doctor\`.`;
}

/** The extension, ensured for the workers' account. */
function ensured(settings: PluginSettings, deps: Pick<PluginDeps, "exec" | "env">): { stack: StackExtension; account: Account } {
  const account = workerAccount(settings.gh, deps.env);
  return { stack: ensureStackExtension(accountRunner(deps, account)), account };
}

export const ONBOARD_STEPS: readonly OnboardStep[] = [{
  name: "gh stack extension",
  explain: `Installs ${STACK_EXTENSION} for the workers' account when it is missing, which a worker links a stacked pull request with. Skipped when the stack setting is false.`,
  async run(settings, deps): Promise<StepResult> {
    if (!stackRequired(settings)) return { ok: true, detail: "" };
    const { stack, account } = ensured(settings, deps);
    return { ok: stack.state !== "failed", detail: line(stack, account) };
  },
}];

/**
 * What `agent-org update` keeps true: the extension is present on every run (A11-106), whatever the `stack` setting says, as update always kept it. Said when it was installed, and as an
 * error when it is missing and could not be installed; a present one says nothing. Never throws.
 */
export function keep(settings: PluginSettings, deps: PluginDeps): readonly StepResult[] {
  const { stack } = ensured(settings, deps);
  if (stack.state === "installed") return [{ ok: true, detail: `installed the ${STACK_EXTENSION} extension (${stack.version})` }];
  if (stack.state === "failed") return [{ ok: false, detail: `the ${STACK_EXTENSION} extension is missing and could not be installed: ${stack.reason}` }];
  return [];
}
