// module: the GitHub plugin's doctor check for the merge flow -- every repository of the host allows auto-merge and holds the arm workflow (A11-291)
//
// FOUR OF THIRTEEN REPOSITORIES HAD NO MERGE FLOW, AND NOTHING SAID SO: an approved pull request in one sat for a day (a11ign/plugin#10), because auto-merge was off and there was no `auto-arm.yml`. Doctor now asks each
// repository a clone of this host names, as the workers' account, and names every one that lacks either, with what to add. The repositories are the clones' because those are the ones the board opens pull requests in: a project's
// `code` list names the repositories a tracker reads, and four of the thirteen were in none.
import type { MergeFlow } from "../../src/plugins/contracts/code-host.ts";
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { githubRepositoriesOf } from "./checks.ts";
import { ghRunner } from "./gh.ts";
import { ARM_WORKFLOW_PATH, readMergeFlows } from "./merge-flow.ts";
import { workerAccount } from "./stack-extension.ts";

const NAME = "merge flow";

/** The repository `owner/name`'s settings page for pull requests, where "Allow auto-merge" is. */
const settingsOf = (repository: string): string => `https://github.com/${repository}/settings#merge-button-settings`;

/** What a repository that lacks part of the flow needs, one clause each, said as the fix: the arm workflow with its gate, ruleset and policy, and the setting. */
function whatToAdd(repository: string, flow: MergeFlow): string {
  const add = [
    ...(flow.armWorkflow ? [] : [`add ${ARM_WORKFLOW_PATH} with its \`gate\` check, \`.github/rulesets/merge-queue-main.json\` and \`.github/chainguard/auto-arm.sts.yaml\` (copy a11ign/announcement-emulator's flow, A11-237; a person merges that first pull request)`]),
    ...(flow.autoMerge ? [] : [`turn on "Allow auto-merge" (${settingsOf(repository)}), and apply the ruleset`]),
  ];
  return `${repository}: ${add.join("; ")}`;
}

/** What a repository lacks, as the row's detail says it. */
function lacking(repository: string, flow: MergeFlow): string {
  const missing = [...(flow.autoMerge ? [] : ["auto-merge is not allowed"]), ...(flow.armWorkflow ? [] : [`no ${ARM_WORKFLOW_PATH} on its default branch`])];
  return `${repository}: ${missing.join(", ")}`;
}

/**
 * The `merge flow` row: it passes when every GitHub repository a clone of this host names allows auto-merge and holds the arm workflow, and it fails naming each repository that does not, and each one it could not read, with what to add. Nothing on a host
 * with no GitHub clone. The account is the workers' (the code host block's `gh.workers`), as the other rows read GitHub.
 */
export function mergeFlowChecks(settings: PluginSettings, deps: PluginDeps): PluginCheck[] {
  const repositories = githubRepositoriesOf(deps);
  if (repositories.length === 0) return [];
  const account = workerAccount(settings.gh, deps.env);
  const run = ghRunner(deps, account.GH_CONFIG_DIR === undefined ? {} : { GH_CONFIG_DIR: account.GH_CONFIG_DIR });
  const flows = readMergeFlows(repositories, run);
  const readings = repositories.map((repository) => ({ repository, flow: flows[repository] ?? null }));
  const unread = readings.flatMap(({ repository, flow }) => (flow === null ? [repository] : []));
  const without = readings.flatMap(({ repository, flow }) => (flow !== null && !(flow.autoMerge && flow.armWorkflow) ? [{ repository, flow }] : []));
  if (unread.length === 0 && without.length === 0) return [{ name: NAME, ok: true, detail: `${repositories.join(", ")} allow auto-merge and hold ${ARM_WORKFLOW_PATH}`, fix: null }];
  const details = [...without.map(({ repository, flow }) => lacking(repository, flow)), ...unread.map((repository) => `${repository}: could not be read`)];
  const fixes = [...without.map(({ repository, flow }) => whatToAdd(repository, flow)), ...unread.map((repository) => `${repository}: run \`gh api repos/${repository} --jq .allow_auto_merge\` with the workers' GH_CONFIG_DIR to see why`)];
  const said = [
    ...(without.length === 0 ? [] : [`${without.length} of ${repositories.length} repositories have no merge flow, so an approved pull request in one waits for a person`]),
    ...(unread.length === 0 ? [] : [`${unread.length} of ${repositories.length} could not be read`]),
  ];
  return [{ name: NAME, ok: false, detail: `${said.join("; ")}: ${details.join("; ")}`, fix: fixes.join(" | ") }];
}
