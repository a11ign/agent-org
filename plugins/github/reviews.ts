// module: what the reviewer reads of a pull request -- its head, its reviews, its trust and whether its required checks settled, and its state (A11-160, A11-175, A11-365)
//
// Moved out of `ticket-mode/reviewer-port.ts` (`readReviewState`, `readPullState`). WHAT IS TRUSTED AND WHAT IS SETTLED IS CORE'S: the pull request is judged by the fields the reviewer's policy names (`policy.review().fields`), and the same policy
// judges it (`trustOf`, `settledOf`). Asking for the policy THROWS where the reviewer's gate does not load, before anything is read, as the read always did.
// THE PULL REQUEST IS THE REPOSITORY'S SNAPSHOT'S (`pull-snapshot.ts`), not a read of its own: this file asks GitHub for nothing, so the reviewer's reads of ten pull requests of a repository are one call (A11-365, after 35 a minute of `gh pr view` on 2026-10-27).
// The snapshot answers GraphQL's shape, and `ghViewOf` gives the policy the shape `gh pr view --json` gave it.
import type { Review, ReviewState } from "../../src/plugins/contracts/code-host.ts";
import type { CodeHostPolicy } from "../../src/plugins/manifest.ts";
import { flowGateOf, rollupOf, type PullNode, type PullSnapshots, type RepoFlow } from "./pull-snapshot.ts";

/** The fields of `gh pr view --json` that {@link ghViewOf} supplies: the policy may name no other (a field it names that is not here THROWS the read, which a test of the real policy holds to). */
export const VIEW_FIELDS: readonly string[] = ["headRefOid", "reviews", "author", "isCrossRepository", "isDraft", "statusCheckRollup", "body", "state", "number", "baseRefName", "headRefName", "title", "url"];

/** The login `gh` prints for an author: a bot is `app/<login>`, as `gh pr view --json author` spells it, and the policy's declared identities are written for that. */
const authorOf = (author: { login?: unknown; __typename?: unknown } | null | undefined): { login: string; is_bot: boolean } | null => {
  if (typeof author?.login !== "string") return null;
  const bot = author.__typename === "Bot";
  return { login: bot ? `app/${author.login}` : author.login, is_bot: bot };
};

/** The time `gh pr view --json statusCheckRollup` prints for a check run that has not started or finished, where GraphQL answers null. */
const NO_TIME = "0001-01-01T00:00:00Z";

/** One check of GraphQL's rollup as `gh pr view --json statusCheckRollup` prints it: a check run by its `name`, with an empty conclusion and no time as `gh` words them, a commit status by its `context`, started when it was created. */
const checkOf = (check: Record<string, any>): Record<string, unknown> => (check.__typename === "StatusContext"
  ? { __typename: check.__typename, context: check.context, state: check.state, startedAt: check.createdAt, targetUrl: check.targetUrl }
  : { __typename: check.__typename, name: check.name, status: check.status, conclusion: check.conclusion ?? "", startedAt: check.startedAt ?? NO_TIME, completedAt: check.completedAt ?? NO_TIME, detailsUrl: check.detailsUrl });

/** The pull request as `gh pr view --json` gave it to the policy. */
function ghViewOf(node: PullNode): Record<string, any> {
  return {
    number: node.number, url: node.url, title: node.title, body: node.body, state: node.state, headRefOid: node.headRefOid, headRefName: node.headRefName, baseRefName: node.baseRefName,
    isCrossRepository: node.isCrossRepository, isDraft: node.isDraft, author: authorOf(node.author),
    reviews: (node.reviews?.nodes ?? []).map((r: Record<string, any>) => ({ author: r.author === null ? null : { login: r.author?.login }, state: r.state, body: r.body, commit: r.commit, submittedAt: r.submittedAt })),
    statusCheckRollup: rollupOf(node).checks.map(checkOf),
  };
}

/**
 * The names of the checks the pull request waits on: those its base requires (GitHub's own answer from the base branch's protection rules and rulesets, so a stacked pull request is judged by its own base, A11-175), or, where it requires none and the
 * repository's flow is the merge bot (A11-341), the bot's own condition, `gate`. The flow is the merge bot when the default branch holds it or the pull request's head does (A11-344: the pull request that adds the bot). A private repository on
 * GitHub Free has no ruleset to require anything, so every check would hold the review, and a red one that is not the merge condition would hold it for good. A required check that has not reported is not in the rollup, so it is not named.
 */
function waitedOnChecksOf(node: PullNode, flow: RepoFlow, repository: string, snapshots: PullSnapshots): string[] {
  const required = [...new Set<string>(rollupOf(node).checks.filter((check) => check?.isRequired === true).map((check) => String(check.name ?? check.context ?? "")).filter((name) => name !== ""))];
  return required.length > 0 ? required : flowGateOf(snapshots, repository, node, flow);
}

/** The pull request's repository (`owner/name`) and number, or null for a url that is none. */
export function pullOf(url: string): { repository: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(url);
  return match === null ? null : { repository: match[1], number: Number(match[2]) };
}

/**
 * The pull request's state as the reviewer sees it: its head, whether its author is the org's own (`INSIDE`), its reviews, and whether its REQUIRED checks have settled green (A11-175). A rollup
 * that is all green is settled and asks nothing more; otherwise the checks the base requires are the ones that count (`waitedOnChecksOf`: the base's required checks, or the merge bot's `gate` where it requires none), and a failing check that is not required is named in `unrequiredRed`
 * and holds nothing. An answer that cannot be had counts every check. Null when GitHub does not say, which the caller reads as no reading rather than as a verdict. THROWS the gate's refusal when the
 * gate does not load, and when the policy names a field of the pull request that the snapshot does not hold (`VIEW_FIELDS`).
 */
export function readReviewState(url: string, snapshots: PullSnapshots, policy: CodeHostPolicy): ReviewState | null {
  const judge = policy.review();
  const unheld = judge.fields.split(",").map((field) => field.trim()).filter((field) => field !== "" && !VIEW_FIELDS.includes(field));
  if (unheld.length > 0) throw new Error(`the reviewer's policy reads ${unheld.join(", ")} of a pull request, which the snapshot of its repository does not hold (plugins/github/reviews.ts VIEW_FIELDS)`);
  const pull = pullOf(url);
  if (pull === null) return null;
  const read = snapshots.pull(pull.repository, pull.number);
  if (read === null) return null;
  try {
    const pr = ghViewOf(read.node);
    if (typeof pr.headRefOid !== "string") return null;
    const reviews: Review[] = (pr.reviews ?? []).map((r: { author?: { login?: string }; state?: string; commit?: { oid?: string }; submittedAt?: string }) => ({
      author: String(r.author?.login ?? ""), state: String(r.state ?? ""), commit: String(r.commit?.oid ?? ""),
      at: Date.parse(String(r.submittedAt ?? "")) || 0,
    }));
    // A rollup of more than one page is not all seen: green checks seen say nothing of the ones not, so it is never settled, and no check is named unrequired.
    const { cut } = rollupOf(read.node);
    const allGreen = !cut && judge.settledOf(pr);
    const required = allGreen || cut ? undefined : waitedOnChecksOf(read.node, read.flow, pull.repository, snapshots);
    const settled = !cut && (allGreen || judge.settledOf(pr, required));
    const unrequiredRed = cut ? [] : judge.unrequiredRedOf(pr, required);
    return { head: pr.headRefOid, trust: judge.trustOf(pr), reviews, settled, ...(unrequiredRed.length === 0 ? {} : { unrequiredRed }), view: { ...pr, number: pull.number } };
  } catch {
    return null;
  }
}

/**
 * The pull request's state as GitHub names it, `OPEN`, `MERGED` or `CLOSED`, or null when it does not say. A merged or closed pull request is the one `retire` is for; an unreadable one
 * is nothing to act on.
 */
export function readPullState(url: string, snapshots: PullSnapshots): string | null {
  const pull = pullOf(url);
  if (pull === null) return null;
  const state = snapshots.pull(pull.repository, pull.number)?.node.state;
  return state === "OPEN" || state === "MERGED" || state === "CLOSED" ? state : null;
}
