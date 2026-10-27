// module: the GitHub plugin's doctor check for the merge flow -- every repository of the host's organisations has a merge flow: auto-merge, the merge queue ruleset requiring `gate`, and the arm workflow, or, for a private repository, the merge bot (A11-291, A11-274)
//
// FOUR OF THIRTEEN REPOSITORIES HAD NO MERGE FLOW, AND NOTHING SAID SO: an approved pull request in one sat for a day (a11ign/plugin#10), because auto-merge was off and there was no `auto-arm.yml`. Doctor now asks, as the
// workers' account, about every repository of each organisation that owns a clone of this host, and names every one that lacks any part of the flow, with what to add. THE ORGANISATION IS LISTED, NOT A DECLARED LIST (A11-274):
// a repository made tomorrow fails the row until it is set up, although no clone, `code` list or file names it. An archived repository takes no pull request, so it is passed over. An owner that is a person's account is
// never listed: only the repositories its clones name are read. A cloned repository the listing does not hold (moved to another owner, or an organisation too large or failing to list) is read by its own name, so it is
// never dropped. `merge-flow-command.ts` prints the row for one organisation from a checkout.
import type { PluginCheck, PluginDeps, PluginSettings } from "../../src/plugins/manifest.ts";
import { githubRepositoriesOf } from "./checks.ts";
import { ghRunner, type Gh } from "./gh.ts";
import { ARM_WORKFLOW_PATH, MERGE_BOT_WORKFLOW_PATH, readOrganisationFlows, readRepositoryFlows, type RepositoryFlow } from "./merge-flow.ts";
import { workerAccount } from "./stack-extension.ts";

const NAME = "merge flow";

/** One repository the row judges, with its flow, or null where it could not be read. */
type Reading = Readonly<{ repository: string; flow: RepositoryFlow | null }>;

/** What the row read: each repository, and each owner whose repositories could not be listed. */
export type Readings = Readonly<{ repositories: readonly Reading[]; unlisted: readonly string[] }>;

/** The repository `owner/name`'s settings page for pull requests, where "Allow auto-merge" is. */
const settingsOf = (repository: string): string => `https://github.com/${repository}/settings#merge-button-settings`;

/** Whether a public repository's own flow is whole: auto-merge, the arm workflow, and an active ruleset with a merge queue that requires `gate` (A11-237's flow, which A11-274 gives every repository). */
const hasArmFlow = (flow: RepositoryFlow): boolean => flow.autoMerge && flow.armWorkflow && flow.mergeQueue && flow.gateRequired;

/** Whether a repository has a merge flow (A11-291): the arm flow, or, private, the merge bot. A private repository on GitHub Free is offered no ruleset or merge queue, so the merge bot is its flow. */
const hasMergeFlow = (flow: RepositoryFlow): boolean => hasArmFlow(flow) || (flow.private && flow.mergeBot);

/** The command that applies the merge queue ruleset a repository's default branch holds, as the chairman's session runs it (the workers' account holds no admin). */
const applyRuleset = (repository: string): string => `\`gh api -X POST repos/${repository}/rulesets --input <(gh api -H "Accept: application/vnd.github.raw" repos/${repository}/contents/.github/rulesets/merge-queue-main.json)\``;

/** What a repository without a flow needs, said as the fix: for a private one with no arm workflow the merge bot with its gate and policy, else each part of the arm flow it lacks. */
function whatToAdd(repository: string, flow: RepositoryFlow): string {
  if (flow.private && !flow.armWorkflow) return `${repository}: add ${MERGE_BOT_WORKFLOW_PATH} with its \`gate\` check and \`.github/chainguard/merge-bot.sts.yaml\` (copy a11ign/plugin's flow, A11-291; a private repository on GitHub Free has no ruleset, so no arm bot; a person merges that first pull request)`;
  const add = [
    ...(flow.armWorkflow ? [] : [`add ${ARM_WORKFLOW_PATH} with its \`gate\` check, \`.github/rulesets/merge-queue-main.json\` and \`.github/chainguard/auto-arm.sts.yaml\` (copy a11ign/announcement-emulator's flow, A11-237; a person merges that first pull request)`]),
    ...(flow.autoMerge ? [] : [`turn on "Allow auto-merge" (${settingsOf(repository)}, or \`gh api -X PATCH repos/${repository} -F allow_auto_merge=true\`)`]),
    ...(flow.mergeQueue ? [] : [`apply the ruleset: ${applyRuleset(repository)}`]),
    ...(!flow.mergeQueue || flow.gateRequired ? [] : ["add `gate` to the merge queue ruleset's required checks"]),
  ];
  return `${repository}: ${add.join("; ")}`;
}

/** What a repository lacks, as the row's detail says it: a private one with no arm workflow lacks the merge bot, any other the parts of the arm flow. */
function lacking(repository: string, flow: RepositoryFlow): string {
  if (flow.private && !flow.armWorkflow) return `${repository}: no ${MERGE_BOT_WORKFLOW_PATH} on its default branch (private)`;
  const missing = [
    ...(flow.autoMerge ? [] : ["auto-merge is not allowed"]),
    ...(flow.armWorkflow ? [] : [`no ${ARM_WORKFLOW_PATH} on its default branch`]),
    ...(flow.mergeQueue ? [] : ["no active ruleset with a merge queue"]),
    ...(flow.gateRequired ? [] : ["`gate` is not a required check"]),
  ];
  return `${repository}: ${missing.join(", ")}`;
}

/**
 * The repositories of `owners`: every repository of each owner that is an organisation, but the archived ones, and the repositories of `clones` the owner's listing does not hold, read by name. An organisation that
 * could not be listed is named in `unlisted`, and its repositories of `clones` are read by name, so a failed listing never passes the row and never hides what a cloned repository lacks.
 */
export function readingsOf(owners: readonly string[], clones: readonly string[], run: Gh): Readings {
  const repositories: Reading[] = [];
  const unlisted: string[] = [];
  for (const owner of owners) {
    const listing = readOrganisationFlows(owner, run);
    if (listing === null) unlisted.push(owner);
    const listed = Array.isArray(listing) ? listing : [];
    const held = new Set(listed.map(({ repository }) => repository.toLowerCase()));
    const byName = clones.filter((repository) => repository.toLowerCase().startsWith(`${owner.toLowerCase()}/`) && !held.has(repository.toLowerCase()));
    const read = byName.length === 0 ? {} : readRepositoryFlows(byName, run);
    repositories.push(...listed.flatMap(({ repository, archived, flow }) => (archived ? [] : [{ repository, flow }])),
      ...byName.flatMap((repository) => (read[repository]?.archived === true ? [] : [{ repository, flow: read[repository]?.flow ?? null }])));
  }
  return { repositories, unlisted };
}

/**
 * The `merge flow` row of what was read: it passes when every repository has a merge flow, and it fails naming each repository that does not, with what to add, each one it could not read, and each organisation it could
 * not list.
 */
export function mergeFlowRow({ repositories, unlisted }: Readings): PluginCheck {
  const names = repositories.map(({ repository }) => repository);
  const unread = repositories.flatMap(({ repository, flow }) => (flow === null ? [repository] : []));
  const without = repositories.flatMap(({ repository, flow }) => (flow !== null && !hasMergeFlow(flow) ? [{ repository, flow }] : []));
  if (unlisted.length === 0 && unread.length === 0 && without.length === 0) {
    return { name: NAME, ok: true, detail: `${names.join(", ")} have a merge flow (auto-merge, the merge queue ruleset requiring \`gate\` and ${ARM_WORKFLOW_PATH}, or, for a private repository, ${MERGE_BOT_WORKFLOW_PATH})`, fix: null };
  }
  const details = [...without.map(({ repository, flow }) => lacking(repository, flow)), ...unread.map((repository) => `${repository}: could not be read`), ...unlisted.map((owner) => `${owner}: its repositories could not be listed`)];
  const fixes = [
    ...without.map(({ repository, flow }) => whatToAdd(repository, flow)),
    ...unread.map((repository) => `${repository}: run \`gh api repos/${repository} --jq .allow_auto_merge\` with the workers' GH_CONFIG_DIR to see why`),
    ...unlisted.map((owner) => `${owner}: run \`gh api orgs/${owner}/repos --jq '.[].name'\` with the workers' GH_CONFIG_DIR to see why`),
  ];
  const said = [
    ...(without.length === 0 ? [] : [`${without.length} of ${names.length} repositories have no merge flow, so an approved pull request in one waits for a person`]),
    ...(unread.length === 0 ? [] : [`${unread.length} of ${names.length} could not be read`]),
    ...(unlisted.length === 0 ? [] : [`${unlisted.length} organisation${unlisted.length === 1 ? "" : "s"} could not be listed`]),
  ];
  return { name: NAME, ok: false, detail: `${said.join("; ")}: ${details.join("; ")}`, fix: fixes.join(" | ") };
}

/** The owners of `repositories` (`owner/name`), each once, in order. */
const ownersOf = (repositories: readonly string[]): string[] => [...new Set(repositories.map((repository) => repository.split("/")[0]))];

/**
 * The `merge flow` row: it passes when every repository of the organisations that own a clone of this host has a merge flow, and fails naming each repository that does not, and each one it could not read, with what to add.
 * Nothing on a host with no GitHub clone. The account is the workers' (the code host block's `gh.workers`), as the other rows read GitHub.
 */
export function mergeFlowChecks(settings: PluginSettings, deps: PluginDeps): PluginCheck[] {
  const clones = githubRepositoriesOf(deps);
  if (clones.length === 0) return [];
  const account = workerAccount(settings.gh, deps.env);
  const run = ghRunner(deps, account.GH_CONFIG_DIR === undefined ? {} : { GH_CONFIG_DIR: account.GH_CONFIG_DIR });
  return [mergeFlowRow(readingsOf(ownersOf(clones), clones, run))];
}

