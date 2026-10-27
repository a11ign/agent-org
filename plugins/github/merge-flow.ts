// module: whether a repository has a merge flow (contract 1.25, A11-291) -- auto-merge allowed, and the arm workflow on its default branch
//
// AN APPROVED PULL REQUEST IN A REPOSITORY WITH NEITHER SITS UNTIL A PERSON MERGES IT (a11ign/plugin#10: approved at 91cfe96d, green, a day). A repository's flow is one of two: the repository must allow auto-merge for the arm to
// do anything and `.github/workflows/auto-arm.yml` is the bot that arms an approved pull request (A11-274); or, in a PRIVATE repository on a plan with no rulesets, `.github/workflows/merge-bot.yml` merges it itself (A11-291). The board reads this to say why an approved pull request is not merging, and doctor reads it for every repository of the host.
// ONE GRAPHQL CALL ANSWERS FOR ANY NUMBER OF REPOSITORIES (an alias each), because doctor's plugin checks run under a time limit and thirteen repositories at two REST reads each do not fit it. Read through an injected `run`
// (the plugin's `gh`), so this file spawns nothing.
import type { ARM_WORKFLOW_PATH as CONTRACT_ARM_WORKFLOW_PATH, MERGE_BOT_WORKFLOW_PATH as CONTRACT_MERGE_BOT_WORKFLOW_PATH, MergeFlow } from "../../src/plugins/contracts/code-host.ts";
import { GhFailure, type Gh } from "./gh.ts";

/** The arm workflow's path the contract names (`ARM_WORKFLOW_PATH`); a plugin imports core's types only, so the type holds it to the contract's spelling. */
export const ARM_WORKFLOW_PATH: typeof CONTRACT_ARM_WORKFLOW_PATH = ".github/workflows/auto-arm.yml";

/** The merge bot's path the contract names (`MERGE_BOT_WORKFLOW_PATH`), held to its spelling in the same way. */
export const MERGE_BOT_WORKFLOW_PATH: typeof CONTRACT_MERGE_BOT_WORKFLOW_PATH = ".github/workflows/merge-bot.yml";

/** The check the merge bot merges on (`.github/workflows/merge-bot.yml`'s `gate` job): in a repository whose flow is the merge bot, the one check the board waits on (A11-341). */
export const MERGE_BOT_GATE = "gate";

/** The query's selection of the merge bot's file on the default branch: null where the repository does not hold it. */
const MERGE_BOT_FILE = `bot: object(expression: "HEAD:${MERGE_BOT_WORKFLOW_PATH}") { __typename }`;
/** The query's selection of the merge bot's file on pull request `number`'s head (`refs/pull/<n>/head`, which GitHub keeps for a fork's pull request too): null where the head does not hold it, as it does not when the pull request deletes it. */
const headMergeBotFile = (number: number): string => `headBot: object(expression: "refs/pull/${number}/head:${MERGE_BOT_WORKFLOW_PATH}") { __typename }`;
/** The fields that say whether a repository is private and holds the merge bot, on its default branch or on the head of pull request `number` (A11-344); a query asks them and {@link answerRunsMergeBot} reads the answer. */
export const mergeBotFields = (number: number): string => `isPrivate ${MERGE_BOT_FILE} ${headMergeBotFile(number)}`;

const holds = (file: unknown): boolean => file !== null && typeof file === "object";

/**
 * Whether a repository's merge flow is the merge bot, for a pull request: it is private, which GitHub Free offers no ruleset or merge queue, and the bot is on its default branch (A11-291) or on the pull request's head
 * (`headBot`, A11-344). The pull request that adds the bot is the first one it covers: the default branch holds nothing until that pull request merges.
 */
export const runsMergeBot = (flow: Pick<MergeFlow, "private" | "mergeBot"> & { headBot?: boolean }): boolean => flow.private && (flow.mergeBot || flow.headBot === true);

/** {@link runsMergeBot}, read off a GraphQL `repository` answer that asked for {@link mergeBotFields}: false when the answer does not say. */
export const answerRunsMergeBot = (repository: any): boolean => runsMergeBot({ private: repository?.isPrivate === true, mergeBot: holds(repository?.bot), headBot: holds(repository?.headBot) });

/** Whether pull request `number` of `repository` (`owner/name`) holds the merge bot on its head: false when it does not, and when GitHub does not say (which is read as a head without the bot, so every check counts as before). */
export function readHeadHoldsMergeBot(repository: string, number: number, run: Gh): boolean {
  const parsed = repositoryOf(repository);
  if (parsed === null) return false;
  try {
    const data = dataOf(run, `query { r0: repository(owner: "${parsed.owner}", name: "${parsed.name}") { ${headMergeBotFile(number)} } }`);
    return holds((data?.r0 as { headBot?: unknown } | null | undefined)?.headBot);
  } catch {
    return false;
  }
}

/** The owner and name of a repository written `owner/name`, or null for any other text (which also keeps a quote out of the query). */
function repositoryOf(repository: string): { owner: string; name: string } | null {
  const match = /^([^/\s"\\]+)\/([^/\s"\\]+)$/.exec(repository);
  return match === null ? null : { owner: match[1], name: match[2] };
}

/** The query for the repositories: an alias `r<n>` each, with the setting, whether it is private, the default branch and whether its head holds the arm workflow (`object`) and the merge bot (`bot`), each null where the file is not. */
const queryOf = (repositories: readonly { owner: string; name: string }[]): string => `query { ${repositories.map(({ owner, name }, n) =>
  `r${n}: repository(owner: "${owner}", name: "${name}") { autoMergeAllowed isPrivate defaultBranchRef { name } object(expression: "HEAD:${ARM_WORKFLOW_PATH}") { __typename } ${MERGE_BOT_FILE} }`).join(" ")} }`;

/** The answer's `data`, from the text `gh` printed: a repository GitHub could not read makes `gh` exit non-zero WITH the rest of the answer, so a failure that printed an answer is read too. Null when there is none. */
function dataOf(run: Gh, query: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = run(["api", "graphql", "-f", `query=${query}`]);
  } catch (error) {
    if (!(error instanceof GhFailure)) throw error;
    text = error.stdout;
  }
  try {
    const data: unknown = JSON.parse(text)?.data;
    return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One repository's answer as a merge flow, or null when it says neither whether auto-merge is allowed nor a default branch (a repository GitHub could not read). */
function flowOf(answer: any): MergeFlow | null {
  if (typeof answer?.autoMergeAllowed !== "boolean" || typeof answer.isPrivate !== "boolean" || typeof answer.defaultBranchRef?.name !== "string") return null;
  return { autoMerge: answer.autoMergeAllowed, armWorkflow: holds(answer.object), defaultBranch: answer.defaultBranchRef.name, private: answer.isPrivate, mergeBot: holds(answer.bot) };
}

/**
 * WHETHER EACH OF `repositories` CAN MERGE A PULL REQUEST BY ITSELF: it allows auto-merge, and its default branch holds the arm workflow. A repository maps to null for "could not ask": a name that is not `owner/name`, a repository
 * GitHub would not read, and an answer without the setting. Null is never "it has no flow". One call is made for all of them.
 */
export function readMergeFlows(repositories: readonly string[], run: Gh): Readonly<Record<string, MergeFlow | null>> {
  const named = repositories.flatMap((repository) => {
    const parsed = repositoryOf(repository);
    return parsed === null ? [] : [{ repository, ...parsed }];
  });
  const none = Object.fromEntries(repositories.map((repository) => [repository, null]));
  if (named.length === 0) return none;
  try {
    const data = dataOf(run, queryOf(named));
    return data === null ? none : { ...none, ...Object.fromEntries(named.map(({ repository }, n) => [repository, flowOf(data[`r${n}`])])) };
  } catch {
    return none;
  }
}

/** Whether one repository has a merge flow, as {@link readMergeFlows} reads it: null for "could not ask". */
export const readMergeFlow = (repository: string, run: Gh): MergeFlow | null => readMergeFlows([repository], run)[repository] ?? null;
