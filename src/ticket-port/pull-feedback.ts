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
  /** Whether GitHub says it merges cleanly: `MERGEABLE`. `UNKNOWN` (still being computed) is not mergeable, as it is not a conflict either. */
  mergeable: boolean;
  /** The commit its branch is at, or null when GitHub does not say. */
  head: string | null;
  /** Whether the newest approving or changes-requesting review on the head commit, by someone other than the board's account, approves. */
  approvedAtHead: boolean;
  /** The branch it merges into, or null when GitHub does not say. */
  base: string | null;
  /** The files it changes, by path within its repository. */
  files: readonly string[];
  /** Whether `files` is all of them. Read a page of 100 at a time, up to {@link MAX_FILE_PAGES}: a list cut off there is not complete. */
  filesComplete: boolean;
}>;

/** How much of each list one read takes, newest last. Only the newest item of each counts, so a long history is not read. */
const LAST = 50;

/** The most pages of changed files one read takes: a pull request beyond this many files is read in part, and says so. */
export const MAX_FILE_PAGES = 10;

const QUERY = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
  state
  headRefOid
  mergeable
  mergeStateStatus
  baseRefName
  files(first: 100) { pageInfo { hasNextPage endCursor } nodes { path } }
  reviews(last: ${LAST}) { nodes { state submittedAt author { login } commit { oid } } }
  comments(last: ${LAST}) { nodes { createdAt author { login } } }
  reviewThreads(last: ${LAST}) { nodes { comments(last: 20) { nodes { createdAt author { login } } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name conclusion startedAt completedAt detailsUrl isRequired(pullRequestNumber: $number) }
    ... on StatusContext { context state createdAt isRequired(pullRequestNumber: $number) }
  } } } } } }
} } }`;

/** The page of changed files after `cursor`, read the same way as the first page in `QUERY`. */
const FILES_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
  files(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { path } }
} } }`;

/** A review is feedback when it asks for something: an approval or a dismissed review is not. */
const FEEDBACK_REVIEWS: ReadonlySet<string> = new Set(["COMMENTED", "CHANGES_REQUESTED"]);
/** The reviews that take a side on a commit: the newest of them on the head commit says whether it is approved. */
const VERDICT_REVIEWS: ReadonlySet<string> = new Set(["APPROVED", "CHANGES_REQUESTED"]);
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
    if (pr === null || typeof pr !== "object" || typeof pr.state !== "string") return null;
    const files = changedFiles(pull, pr.files, run);
    return { ...feedbackOf(pr, self), files: files.paths, filesComplete: files.complete };
  } catch {
    // An answer of an unexpected shape is no reading either.
    return null;
  }
}

/** A page of changed files as GitHub gives it: its paths, and whether another page follows. Any other shape is not a page. */
type FilesPage = { nodes: { path: string }[]; pageInfo: { hasNextPage: boolean; endCursor?: unknown } };

const isFilesPage = (page: any): page is FilesPage =>
  page !== null && typeof page === "object" && Array.isArray(page.nodes) && page.nodes.every((file: any) => typeof file?.path === "string")
  && page.pageInfo !== null && typeof page.pageInfo === "object" && typeof page.pageInfo.hasNextPage === "boolean";

/**
 * Every file the pull request changes: the page the first read returned, then the pages after it, one read each, up to {@link MAX_FILE_PAGES}.
 * `complete` is true only when the last page read says no page follows. A page that is missing or of another shape, the first included, and pages
 * left past the cap, leave it false with the paths read so far: files not seen are unknown, never none. A page that cannot be read throws, so the
 * read is no reading at all.
 */
function changedFiles(pull: { owner: string; repo: string; number: number }, first: unknown, run: (args: string[]) => string):
  { paths: string[]; complete: boolean } {
  const paths: string[] = [];
  let page = first;
  for (let pages = 1; ; pages += 1) {
    if (!isFilesPage(page)) return { paths, complete: false };
    paths.push(...page.nodes.map((file) => file.path));
    if (!page.pageInfo.hasNextPage) return { paths, complete: true };
    if (pages >= MAX_FILE_PAGES || typeof page.pageInfo.endCursor !== "string") return { paths, complete: false };
    const answer = JSON.parse(run(["api", "graphql", "-f", `query=${FILES_QUERY}`, "-f", `owner=${pull.owner}`, "-f", `repo=${pull.repo}`,
      "-F", `number=${pull.number}`, "-f", `cursor=${page.pageInfo.endCursor}`]));
    page = answer?.data?.repository?.pullRequest?.files;
    if (page === null || typeof page !== "object") throw new Error("a page of the changed files did not answer");
  }
}

type Review = { state: string; submittedAt?: string; author: Login; commit?: { oid?: string } | null };

/** Whether `review` takes a side on commit `head`, and an author `counts` for wrote it. A review on an earlier commit says nothing of this one. */
const rulesOn = (review: Review, head: string, counts: (author: Login) => boolean): boolean =>
  VERDICT_REVIEWS.has(review.state) && review.commit?.oid === head && counts(review.author);

/** Whether the newest review that {@link rulesOn} commit `head` is an approval. */
function approvedAt(reviews: readonly Review[], head: string, counts: (author: Login) => boolean): boolean {
  const at = (review: Review): number => time(review.submittedAt) ?? 0;
  const newer = (latest: Review | null, review: Review): Review => (latest === null || at(review) >= at(latest) ? review : latest);
  return reviews.filter((review) => rulesOn(review, head, counts)).reduce<Review | null>(newer, null)?.state === "APPROVED";
}

/** The feedback in one pull request as the query returns it, its files aside. Throws on an answer of another shape, which the caller reads as no reading. */
function feedbackOf(pr: Record<string, any>, self: string): Omit<PullFeedback, "files" | "filesComplete"> {
  const others = (author: Login) => author?.login !== undefined && author.login !== self;
  const items: { at: number | null; author: string }[] = [
    ...(pr.reviews?.nodes ?? []).filter((r: { state: string; author: Login }) => FEEDBACK_REVIEWS.has(r.state) && others(r.author))
      .map((r: { submittedAt: string; author: Login }) => ({ at: time(r.submittedAt), author: r.author?.login ?? "" })),
    ...[...(pr.comments?.nodes ?? []), ...(pr.reviewThreads?.nodes ?? []).flatMap((t: { comments?: { nodes?: unknown[] } }) => t.comments?.nodes ?? [])]
      .filter((c: { author: Login }) => others(c.author))
      .map((c: { createdAt: string; author: Login }) => ({ at: time(c.createdAt), author: c.author?.login ?? "" })),
  ];
  // The branch's own head, which a review's commit is compared with: the commits connection can lag the ref by a few seconds after a push.
  const head = typeof pr.headRefOid === "string" ? pr.headRefOid : null;
  const failing = failingChecks(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []);
  const newest = (times: (number | null)[]): number | null => times.reduce<number | null>((max, at) => (at !== null && (max === null || at > max) ? at : max), null);
  return {
    state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open",
    feedbackAt: newest(items.map(({ at }) => at)),
    authors: [...new Set(items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).map(({ author }) => author))],
    failing: failing.map(({ name }) => name),
    failedAt: newest(failing.map(({ at }) => at)),
    conflicting: pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY",
    mergeable: pr.mergeable === "MERGEABLE",
    head,
    approvedAtHead: head !== null && approvedAt(pr.reviews?.nodes ?? [], head, others),
    base: typeof pr.baseRefName === "string" ? pr.baseRefName : null,
  };
}
