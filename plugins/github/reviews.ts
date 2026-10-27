// module: what the reviewer reads of a pull request -- its head, its reviews, its trust and whether its required checks settled, and its state (A11-160, A11-175)
//
// Moved out of `ticket-mode/reviewer-port.ts` (`readReviewState`, `readPullState`), over the plugin's `gh`. WHAT IS TRUSTED AND WHAT IS SETTLED IS CORE'S: the pull request is read by
// the fields the reviewer's policy names (`policy.review().fields`), and the same policy judges it (`trustOf`, `settledOf`). Asking for the policy THROWS where the reviewer's gate does not
// load, before anything is read, as the read always did.
import type { Review, ReviewState } from "../../src/plugins/contracts/code-host.ts";
import type { CodeHostPolicy } from "../../src/plugins/manifest.ts";
import type { Gh } from "./gh.ts";
import { MERGE_BOT_GATE, readMergeFlow, runsMergeBot } from "./merge-flow.ts";

/**
 * The named `fields` (a `--json` list) of pull request `number` of `repo`, or null when they could not be had: a refused `gh`, or an answer that does not parse. Absence is not proof, so a
 * caller reads null as no reading. Private: row mode's own read of the same fields stays in core (`src/ticket-port/pull-request-fields.ts`) until its callers move into this plugin, and a
 * plugin imports core's types only (ADR 0001), so the two cannot be one file.
 */
function fieldsOf(repo: string, number: number, fields: string, gh: Gh): Record<string, any> | null {
  try {
    return JSON.parse(gh(["pr", "view", String(number), "--repo", repo, "--json", fields]));
  } catch {
    return null;
  }
}

/**
 * What GitHub says is required of a pull request, for each check of its head commit: `isRequired(pullRequestNumber:)` is GitHub's own answer from the base branch's protection rules and rulesets, so a
 * stacked pull request is judged by its own base (A11-175). `pull-feedback.ts` reads the same field for the board's failing checks.
 */
const REQUIRED_QUERY = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { pageInfo { hasNextPage } nodes {
    __typename
    ... on CheckRun { name isRequired(pullRequestNumber: $number) }
    ... on StatusContext { context isRequired(pullRequestNumber: $number) }
  } } } } } }
} } }`;

/**
 * The names of the checks the pull request's base requires, or null when GitHub did not say: a refused `gh`, or an answer that does not hold the head commit's checks. Null is never "nothing is
 * required", which is an empty list: the caller counts every check for both. Required checks that have not reported are not in the answer, so they are not named. A head with more checks than one page holds
 * is not read in full, so a required check could be missing from the list and counted as not required: that is null too.
 */
function readRequiredChecks(pull: { repository: string; number: number }, gh: Gh): string[] | null {
  const [owner, repo] = pull.repository.split("/");
  try {
    const answer = JSON.parse(gh(["api", "graphql", "-f", `query=${REQUIRED_QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${pull.number}`]));
    const page = answer?.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
    const contexts = page?.nodes;
    if (!Array.isArray(contexts) || page.pageInfo?.hasNextPage === true) return null;
    const required = contexts.filter((check: { isRequired?: boolean } | null) => check?.isRequired === true).map((check: { name?: string; context?: string }) => String(check.name ?? check.context ?? ""));
    return [...new Set(required.filter((name) => name !== ""))];
  } catch {
    return null;
  }
}

/**
 * The checks the pull request waits on: those its base requires, or, where it requires none and the repository's flow is the merge bot (A11-341), the bot's own condition, `gate`. A private repository on
 * GitHub Free has no ruleset to require anything, so every check would hold the review, and a red one that is not the merge condition would hold it for good. Null when GitHub did not say what is required;
 * a repository whose flow could not be read is read as one without the bot, which counts every check as before.
 */
function readWaitedOnChecks(pull: { repository: string; number: number }, gh: Gh): string[] | null {
  const required = readRequiredChecks(pull, gh);
  if (required === null || required.length > 0) return required;
  const flow = readMergeFlow(pull.repository, gh);
  return flow !== null && runsMergeBot(flow) ? [MERGE_BOT_GATE] : required;
}

/** The pull request's repository (`owner/name`) and number, or null for a url that is none. */
export function pullOf(url: string): { repository: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(url);
  return match === null ? null : { repository: match[1], number: Number(match[2]) };
}

/**
 * The pull request's state as the reviewer sees it: its head, whether its author is the org's own (`INSIDE`), its reviews, and whether its REQUIRED checks have settled green (A11-175). A rollup
 * that is all green is settled and asks nothing more; otherwise GitHub is asked which checks are required (`readWaitedOnChecks`: the base's required checks, or the merge bot's `gate` where it requires none), and a failing check that is not required is named in `unrequiredRed`
 * and holds nothing. An answer that cannot be had counts every check. Null when GitHub does not say, which the caller reads as no reading rather than as a verdict. THROWS the gate's refusal when the
 * gate does not load.
 */
export function readReviewState(url: string, gh: Gh, policy: CodeHostPolicy): ReviewState | null {
  const judge = policy.review();
  const pull = pullOf(url);
  if (pull === null) return null;
  const pr = fieldsOf(pull.repository, pull.number, judge.fields, gh);
  try {
    if (typeof pr?.headRefOid !== "string") return null;
    const reviews: Review[] = (pr.reviews ?? []).map((r: { author?: { login?: string }; state?: string; commit?: { oid?: string }; submittedAt?: string }) => ({
      author: String(r.author?.login ?? ""), state: String(r.state ?? ""), commit: String(r.commit?.oid ?? ""),
      at: Date.parse(String(r.submittedAt ?? "")) || 0,
    }));
    const allGreen = judge.settledOf(pr);
    const required = allGreen ? undefined : readWaitedOnChecks(pull, gh);
    const settled = allGreen || judge.settledOf(pr, required);
    const unrequiredRed = judge.unrequiredRedOf(pr, required);
    return { head: pr.headRefOid, trust: judge.trustOf(pr), reviews, settled, ...(unrequiredRed.length === 0 ? {} : { unrequiredRed }), view: { ...pr, number: pull.number } };
  } catch {
    return null;
  }
}

/**
 * The pull request's state as GitHub names it, `OPEN`, `MERGED` or `CLOSED`, or null when it does not say. A merged or closed pull request is the one `retire` is for; an unreadable one
 * is nothing to act on.
 */
export function readPullState(url: string, gh: Gh): string | null {
  const pull = pullOf(url);
  if (pull === null) return null;
  const state = fieldsOf(pull.repository, pull.number, "state", gh)?.state;
  return state === "OPEN" || state === "MERGED" || state === "CLOSED" ? state : null;
}
