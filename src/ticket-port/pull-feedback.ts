// The feedback on one pull request that ticket mode's board answers on its own: the newest review, conversation comment and inline comment
// from anyone but the board's own account, and its failing checks. Read through an injected `run` (`gh`, as the caller hands it in). This file
// names no `gh` and spawns nothing: `ticket-port.test.ts` (#484) holds the port to that, and the spawn stays with whoever owns the runner.
// Which checks are red is `red-pr.ts`'s to decide (#2956), so this file asks it.
import { brokenChecks } from "../red-pr.ts";

/** What the board reads of one pull request. Times are epoch milliseconds, or null when there is none. */
export type PullFeedback = Readonly<{
  state: "open" | "merged" | "closed";
  /** The newest review (commented or changes requested), conversation comment or inline comment by someone other than the board's account. */
  feedbackAt: number | null;
  /** Who left feedback, each once, the author of the newest first. */
  authors: readonly string[];
  /** The checks failing on the head commit, by name: its required ones, or every one where none is required. */
  failing: readonly string[];
  /** When the newest of those failing checks finished. */
  failedAt: number | null;
  /** Whether it conflicts with its base: GitHub says `CONFLICTING` or `DIRTY`. `UNKNOWN` (still being computed) is not a conflict. */
  conflicting: boolean;
  /** The branch it merges into, or null when GitHub does not say. */
  base: string | null;
  /** The files it changes, by path within its repository. */
  files: readonly string[];
  /** Whether `files` is all of them: GitHub gives at most 100, and a pull request changing more is read in part. */
  filesComplete: boolean;
}>;

/** How much of each list one read takes, newest last. Only the newest item of each counts, so a long history is not read. */
const LAST = 50;

const QUERY = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
  state
  mergeable
  mergeStateStatus
  baseRefName
  files(first: 100) { totalCount nodes { path } }
  reviews(last: ${LAST}) { nodes { state submittedAt author { login } } }
  comments(last: ${LAST}) { nodes { createdAt author { login } } }
  reviewThreads(last: ${LAST}) { nodes { comments(last: 20) { nodes { createdAt author { login } } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name conclusion startedAt completedAt detailsUrl isRequired(pullRequestNumber: $number) }
    ... on StatusContext { context state createdAt isRequired(pullRequestNumber: $number) }
  } } } } } }
} } }`;

/** A review is feedback when it asks for something: an approval or a dismissed review is not. */
const FEEDBACK_REVIEWS: ReadonlySet<string> = new Set(["COMMENTED", "CHANGES_REQUESTED"]);
/** The states of a commit status that mean it failed, read as a check run's conclusion so `red-pr.ts` can decide on it. */
const FAILED_STATUSES: ReadonlySet<string> = new Set(["FAILURE", "ERROR"]);

type Login = { login?: string } | null;
type Check = { __typename?: string; name?: string; context?: string; conclusion?: string | null; state?: string; startedAt?: string | null;
  completedAt?: string | null; createdAt?: string; detailsUrl?: string | null; isRequired?: boolean };

/** The owner, repository and number of a GitHub pull request's web address, or null for any other address. */
export function pullOf(url: string): { owner: string; repo: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url);
  return match === null ? null : { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/** The login of the account `run` acts as, which is the board's workers' own, or null when it cannot be read. */
export function readOwnLogin(run: (args: string[]) => string): string | null {
  try {
    const login = run(["api", "user", "--jq", ".login"]).trim();
    return login === "" ? null : login;
  } catch {
    return null;
  }
}

const time = (value: string | null | undefined): number | null => {
  const at = Date.parse(value ?? "");
  return Number.isNaN(at) ? null : at;
};

/**
 * Each check on the head commit, newest per name, that failed, as `red-pr.ts` decides it. A pull request with required checks counts only those.
 * One with none counts every check, because then nothing tells a gate from the rest, and the worker is told to leave every check passing. A
 * commit status is read as a check run: its context is its name, its failure its conclusion, and its time its completion.
 */
function failingChecks(contexts: readonly Check[]): { name: string; at: number | null }[] {
  const counted = contexts.some((check) => check.isRequired === true) ? contexts.filter((check) => check.isRequired === true) : contexts;
  const asRuns = counted.map((check) => (check.__typename === "StatusContext"
    ? { name: check.context ?? "", conclusion: FAILED_STATUSES.has(check.state ?? "") ? "FAILURE" : check.state, completedAt: check.createdAt }
    : check));
  return brokenChecks({ statusCheckRollup: asRuns, labels: [] }).map(({ name, failedAt }) => ({ name, at: Number.isNaN(failedAt) ? null : failedAt }));
}

/**
 * THE FEEDBACK ON THE PULL REQUEST AT `url`, leaving out what `self` wrote, or null for "could not ask": an address that is not a GitHub pull
 * request, a refused `run`, and an answer without the pull request. Null is never "no feedback".
 */
export function readPullFeedback(url: string, self: string, run: (args: string[]) => string): PullFeedback | null {
  const pull = pullOf(url);
  if (pull === null) return null;
  try {
    const answer = JSON.parse(run(["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${pull.owner}`, "-f", `repo=${pull.repo}`, "-F", `number=${pull.number}`]));
    const pr = answer?.data?.repository?.pullRequest;
    return pr !== null && typeof pr === "object" && typeof pr.state === "string" ? feedbackOf(pr, self) : null;
  } catch {
    // An answer of an unexpected shape is no reading either.
    return null;
  }
}

/** The feedback in one pull request as the query returns it. Throws on an answer of another shape, which the caller reads as no reading. */
function feedbackOf(pr: Record<string, any>, self: string): PullFeedback {
  const others = (author: Login) => author?.login !== undefined && author.login !== self;
  const items: { at: number | null; author: string }[] = [
    ...(pr.reviews?.nodes ?? []).filter((r: { state: string; author: Login }) => FEEDBACK_REVIEWS.has(r.state) && others(r.author))
      .map((r: { submittedAt: string; author: Login }) => ({ at: time(r.submittedAt), author: r.author?.login ?? "" })),
    ...[...(pr.comments?.nodes ?? []), ...(pr.reviewThreads?.nodes ?? []).flatMap((t: { comments?: { nodes?: unknown[] } }) => t.comments?.nodes ?? [])]
      .filter((c: { author: Login }) => others(c.author))
      .map((c: { createdAt: string; author: Login }) => ({ at: time(c.createdAt), author: c.author?.login ?? "" })),
  ];
  const failing = failingChecks(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []);
  const newest = (times: (number | null)[]): number | null => times.reduce<number | null>((max, at) => (at !== null && (max === null || at > max) ? at : max), null);
  return {
    state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open",
    feedbackAt: newest(items.map(({ at }) => at)),
    authors: [...new Set(items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).map(({ author }) => author))],
    failing: failing.map(({ name }) => name),
    failedAt: newest(failing.map(({ at }) => at)),
    conflicting: pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY",
    base: typeof pr.baseRefName === "string" ? pr.baseRefName : null,
    files: (pr.files?.nodes ?? []).map((file: { path: string }) => file.path),
    filesComplete: (pr.files?.totalCount ?? 0) <= (pr.files?.nodes?.length ?? 0),
  };
}
