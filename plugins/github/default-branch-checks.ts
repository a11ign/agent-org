// The checks failing on the head of a repository's default branch (contract 1.13): what the board compares a pull request's red check with, to tell a check main fails too, which no diff of the run's can mend,
// from one the run caused. Read through an injected `run` (the plugin's `gh`), so this file spawns nothing. Which checks are red is core's to decide, so it asks the `policy` it is given, as `pull-feedback.ts`
// does, and a commit status is read as a check run there.
import type { DefaultBranchRed } from "../../src/plugins/contracts/code-host.ts";
import type { CodeHostPolicy } from "../../src/plugins/manifest.ts";
import { failingChecks, type Check } from "./pull-feedback.ts";

const QUERY = `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { defaultBranchRef { name target {
  __typename
  ... on Commit { oid statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name conclusion startedAt completedAt detailsUrl }
    ... on StatusContext { context state createdAt }
  } } } }
} } } }`;

/** The owner and name of a repository written `owner/name`, or null for any other text. */
function repositoryOf(repository: string): { owner: string; name: string } | null {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repository);
  return match === null ? null : { owner: match[1], name: match[2] };
}

/**
 * THE CHECKS FAILING ON THE HEAD OF `repository`'S DEFAULT BRANCH, or null for "could not ask": a repository that is not `owner/name`, a refused `run`, a repository with no default branch or a branch whose
 * head is not a commit, and an answer of another shape. A head with no check run on it is a branch with nothing failing, not null.
 */
export function readDefaultBranchRed(repository: string, run: (args: string[]) => string, policy: CodeHostPolicy): DefaultBranchRed | null {
  const named = repositoryOf(repository);
  if (named === null) return null;
  try {
    const answer = JSON.parse(run(["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${named.owner}`, "-f", `repo=${named.name}`]));
    const branch = answer?.data?.repository?.defaultBranchRef;
    const commit = branch?.target;
    if (typeof branch?.name !== "string" || commit?.__typename !== "Commit" || typeof commit.oid !== "string") return null;
    const contexts: Check[] = commit.statusCheckRollup?.contexts?.nodes ?? [];
    return { branch: branch.name, head: commit.oid, failing: [...new Set(failingChecks(contexts, policy).map(({ name }) => name))] };
  } catch {
    // An answer of an unexpected shape is no reading either.
    return null;
  }
}
