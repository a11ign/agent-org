// The checks failing on the head of a repository's default branch (contract 1.13), and the ones passing there (contract 1.15): what the board compares a pull request's red check with, to tell a check main fails too, which no diff of the run's can mend,
// from one the run caused. Read through an injected `run` (the plugin's `gh`), so this file spawns nothing. Which checks are red is core's to decide, so it asks the `policy` it is given, as `pull-feedback.ts`
// does, and a commit status is read as a check run there.
import type { DefaultBranchRed } from "../../src/plugins/contracts/code-host.ts";
import type { CodeHostPolicy } from "../../src/plugins/manifest.ts";
import type { AsyncGh } from "./gh.ts";
import { failingChecks, settledChecks, type Check } from "./pull-feedback.ts";

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

/** The `gh` arguments that ask the head of `named`'s default branch for its checks. */
const argsOf = (named: { owner: string; name: string }): string[] => ["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${named.owner}`, "-f", `repo=${named.name}`];

/** What the head of the default branch holds, from the text `gh` printed, or null for an answer of another shape. */
function redIn(text: string, policy: CodeHostPolicy): DefaultBranchRed | null {
  const answer = JSON.parse(text);
  const branch = answer?.data?.repository?.defaultBranchRef;
  const commit = branch?.target;
  if (typeof branch?.name !== "string" || commit?.__typename !== "Commit" || typeof commit.oid !== "string") return null;
  const contexts: Check[] = commit.statusCheckRollup?.contexts?.nodes ?? [];
  const failing = [...new Set(failingChecks(contexts, policy).map(({ name }) => name))];
  const { passing, pending } = settledChecks(contexts, policy, new Set(failing));
  return { branch: branch.name, head: commit.oid, failing, passing: [...new Set(passing)], pending: [...new Set(pending)] };
}

/**
 * THE CHECKS FAILING ON THE HEAD OF `repository`'S DEFAULT BRANCH, and those whose newest run passed there (`passing`, which is positive evidence: a check still running or never run is in neither, and `pending`, those still to conclude), or null for "could not ask": a repository that is not `owner/name`, a refused `run`, a repository with no default branch or a branch whose
 * head is not a commit, and an answer of another shape. A head with no check run on it is a branch with nothing failing, not null.
 */
export function readDefaultBranchRed(repository: string, run: (args: string[]) => string, policy: CodeHostPolicy): DefaultBranchRed | null {
  const named = repositoryOf(repository);
  if (named === null) return null;
  try {
    return redIn(run(argsOf(named)), policy);
  } catch {
    // An answer of an unexpected shape is no reading either.
    return null;
  }
}

/** {@link readDefaultBranchRed} without holding the process still (A11-395). */
export async function readDefaultBranchRedAsync(repository: string, run: AsyncGh, policy: CodeHostPolicy): Promise<DefaultBranchRed | null> {
  const named = repositoryOf(repository);
  if (named === null) return null;
  try {
    return redIn(await run(argsOf(named)), policy);
  } catch {
    return null;
  }
}
