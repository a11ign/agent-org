// module: the GitHub plugin's onboard steps, and what `agent-org update` keeps true for it -- the stacking extension is installed for the workers' account, and each App's key is copied into the host's apps folder (A11-160)
//
// Moved out of `install/onboard.ts` (`stackLine`, `reviewerIdentity`) and `install/update.ts` (`keepStackExtension`) with their words unchanged. The extension serves stacked pull requests only, so a failure to
// install it is said with its reason and the command to run by hand, and is never thrown: doctor fails on it until it is there.
import { isAbsolute, join } from "node:path";
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

/** The App a profile names for the reviewer: its slug and the ids GitHub issued. Onboard hands it over as the `reviewerApp` flag. */
type ReviewerApp = Readonly<{ slug: string; appId: number; installationId: number }>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const expandHome = (path: string, home: string): string => (path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path);

/** The reviewer's identity the host file already holds, when its key is readable: nothing more is asked of a host that has it. */
function heldReviewer(settings: PluginSettings, deps: Pick<PluginDeps, "mode">): Record<string, unknown> | null {
  const current = isObject(settings.identity) && isObject(settings.identity.reviewer) ? settings.identity.reviewer : null;
  return current !== null && typeof current.keyPath === "string" && deps.mode(current.keyPath) !== null ? current : null;
}

/**
 * The reviewer App's key: the identity the host file holds when its key is readable, else the App the profile names with its key copied to `<AGENT_ORG_HOME>/apps/<slug>.pem` (mode 600). The key's path is
 * asked for, and its text is never printed. A key that cannot be asked for or read is a refusal: the step THROWS, and onboard refuses by that sentence.
 */
const APP_KEY_STEP: OnboardStep = {
  name: "App keys",
  explain: "Copies the reviewer App's private key into <AGENT_ORG_HOME>/apps/<slug>.pem (mode 600), asking for the path of the downloaded .pem file, and names it in the host file's identity setting. Skipped where the host file's key is readable or the profile names no App.",
  async run(settings, deps): Promise<StepResult> {
    const app = deps.flags.reviewerApp as ReviewerApp | undefined;
    if (heldReviewer(settings, deps) !== null || app === undefined) return { ok: true, detail: "" };
    if (!deps.interactive) {
      return { ok: true, detail: `NO reviewer App key is set for ${app.slug}. Run \`agent-org onboard --profile <name>\` at a terminal, which asks for the path of the App's downloaded .pem file.` };
    }
    const answer = (await deps.ask(`Path to the downloaded private key (.pem) of the reviewer App ${app.slug}, or an empty line to add it later: `)).trim();
    if (answer === "") return { ok: true, detail: "" };
    const source = expandHome(answer, deps.home);
    if (!isAbsolute(source)) throw new Error("the reviewer App's key must be an absolute path");
    let key: string;
    try {
      key = deps.readFile(source);
    } catch {
      throw new Error(`the reviewer App's key cannot be read at ${source}`);
    }
    const keyPath = join(deps.agentOrgHome, "apps", `${app.slug}.pem`);
    deps.writeFile(keyPath, key);
    const identity = isObject(settings.identity) ? settings.identity : {};
    return { ok: true, detail: `copied the reviewer App's key to ${keyPath}, mode 600; its text is not shown`,
      settings: { identity: { ...identity, reviewer: { mode: "github-apps", slug: app.slug, appId: app.appId, installationId: app.installationId, keyPath } } } };
  },
};

export const ONBOARD_STEPS: readonly OnboardStep[] = [{
  name: "gh stack extension",
  explain: `Installs ${STACK_EXTENSION} for the workers' account when it is missing, which a worker links a stacked pull request with. Skipped when the stack setting is false.`,
  async run(settings, deps): Promise<StepResult> {
    if (!stackRequired(settings)) return { ok: true, detail: "" };
    const { stack, account } = ensured(settings, deps);
    return { ok: stack.state !== "failed", detail: line(stack, account) };
  },
}, APP_KEY_STEP];

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
