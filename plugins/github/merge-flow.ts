// module: whether a repository has a merge flow (contract 1.25, A11-291) -- auto-merge allowed, and the arm workflow on its default branch
//
// AN APPROVED PULL REQUEST IN A REPOSITORY WITH NEITHER SITS UNTIL A PERSON MERGES IT (a11ign/plugin#10: approved at 91cfe96d, green, a day). Both are what the arm bot needs: the repository must allow auto-merge for the arm to
// do anything, and `.github/workflows/auto-arm.yml` is the bot that arms an approved pull request. The board reads this to say why an approved pull request is not merging, and doctor reads it for every repository of the host.
// ONE GRAPHQL CALL ANSWERS FOR ANY NUMBER OF REPOSITORIES (an alias each), because doctor's plugin checks run under a time limit and thirteen repositories at two REST reads each do not fit it. Read through an injected `run`
// (the plugin's `gh`), so this file spawns nothing.
import type { ARM_WORKFLOW_PATH as CONTRACT_ARM_WORKFLOW_PATH, MergeFlow } from "../../src/plugins/contracts/code-host.ts";
import { GhFailure, type Gh } from "./gh.ts";

/** The arm workflow's path the contract names (`ARM_WORKFLOW_PATH`); a plugin imports core's types only, so the type holds it to the contract's spelling. */
export const ARM_WORKFLOW_PATH: typeof CONTRACT_ARM_WORKFLOW_PATH = ".github/workflows/auto-arm.yml";

/** The owner and name of a repository written `owner/name`, or null for any other text (which also keeps a quote out of the query). */
function repositoryOf(repository: string): { owner: string; name: string } | null {
  const match = /^([^/\s"\\]+)\/([^/\s"\\]+)$/.exec(repository);
  return match === null ? null : { owner: match[1], name: match[2] };
}

/** The query for the repositories: an alias `r<n>` each, with the setting, the default branch and whether its head holds the arm workflow (`object` is null where the file is not). */
const queryOf = (repositories: readonly { owner: string; name: string }[]): string => `query { ${repositories.map(({ owner, name }, n) =>
  `r${n}: repository(owner: "${owner}", name: "${name}") { autoMergeAllowed defaultBranchRef { name } object(expression: "HEAD:${ARM_WORKFLOW_PATH}") { __typename } }`).join(" ")} }`;

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
  if (typeof answer?.autoMergeAllowed !== "boolean" || typeof answer.defaultBranchRef?.name !== "string") return null;
  return { autoMerge: answer.autoMergeAllowed, armWorkflow: answer.object !== null && typeof answer.object === "object", defaultBranch: answer.defaultBranchRef.name };
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
