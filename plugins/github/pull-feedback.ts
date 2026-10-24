// The feedback on one pull request that ticket mode's board answers on its own: the newest review, conversation comment and inline comment
// from anyone but the board's own account, and its failing checks. Read through an injected `run` (the plugin's `gh`), so this file spawns nothing. It moved here from
// `src/ticket-port/` with the rest of ticket mode's GitHub reads (A11-160). Which checks are red is core's to decide (`red-pr.ts`, #2956, which row mode shares), so this file
// asks the `policy` it is given, since a plugin imports core's types only (ADR 0001).
import type { FailingCheck, PullFeedback, ReviewDecision } from "../../src/plugins/contracts/code-host.ts";
import type { CodeHostPolicy } from "../../src/plugins/manifest.ts";

export type { FailingCheck, PullFeedback };

/** How much of each list one read takes, newest last. Only the newest item of each counts, so a long history is not read. */
const LAST = 50;

/** The most pages of changed files one read takes: a pull request beyond this many files is read in part, and says so. */
export const MAX_FILE_PAGES = 10;

const QUERY = `query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
  state
  body
  reviewDecision
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
/** GitHub's review decisions, as the board words them. */
const REVIEW_DECISIONS: Readonly<Record<string, ReviewDecision>> = { APPROVED: "approved", CHANGES_REQUESTED: "changes-requested", REVIEW_REQUIRED: "review-required" };
/** The conclusions of a check run that are neither a pass nor red (`red-pr.ts`'s `RED_CONCLUSIONS`): GitHub holds a merge on them, and the board does not read them as green. */
const NOT_PASSED_CONCLUSIONS: ReadonlySet<string> = new Set(["CANCELLED", "STALE"]);
/** The states of a commit status that have not concluded. */
const UNCONCLUDED_STATUSES: ReadonlySet<string> = new Set(["PENDING", "EXPECTED"]);
/** The states of a commit status that mean it failed, read as a check run's conclusion so `red-pr.ts` can decide on it. */
const FAILED_STATUSES: ReadonlySet<string> = new Set(["FAILURE", "ERROR"]);

type Login = { login?: string } | null;
export type Check = { __typename?: string; name?: string; context?: string; conclusion?: string | null; state?: string; startedAt?: string | null;
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

const nameOf = (check: Check): string => (check.__typename === "StatusContext" ? check.context : check.name) ?? "";

/** Each context as a check run, which the red-check decider and the newest-run comparator read: a commit status is a run named for its context, failed by its state, completed when it was created. */
const asCheckRuns = (contexts: readonly Check[]): Check[] => contexts.map((check) => (check.__typename === "StatusContext"
  ? { name: check.context ?? "", conclusion: FAILED_STATUSES.has(check.state ?? "") ? "FAILURE" : check.state, state: check.state, completedAt: check.createdAt, isRequired: check.isRequired }
  : check));

/**
 * The names of the checks the pull request waits on that have not passed, newest per name: a check run with no conclusion yet or that was cancelled (a cancelled gate blocks the merge, and no newer run
 * replaced it) or went stale, and a commit status that is pending or expected. They are the required checks, or every check where none is required, as {@link failingChecks} counts them. A rerun that is
 * under way replaces the failure it re-runs. A required check that has no run on the head yet is not in the rollup and is not named.
 */
function pendingRequired(contexts: readonly Check[], policy: CodeHostPolicy): string[] {
  const newest = new Map<string, Check>();
  for (const run of asCheckRuns(contexts)) {
    const seen = newest.get(run.name ?? "");
    if (seen === undefined || policy.isAtLeastAsNew(run, seen)) newest.set(run.name ?? "", run);
  }
  const anyRequired = contexts.some((check) => check.isRequired === true);
  const unpassed = (run: Check): boolean => (run.state !== undefined ? UNCONCLUDED_STATUSES.has(run.state) : run.conclusion == null || NOT_PASSED_CONCLUSIONS.has(run.conclusion));
  return [...newest.values()].filter((run) => (!anyRequired || run.isRequired === true) && unpassed(run)).map(({ name }) => name ?? "");
}

/**
 * Each check on the head commit, newest per name, that failed, as `red-pr.ts` decides it. `counted` says whether the board answers it: a pull request with required checks counts only
 * those, and one with none counts every check, because then nothing tells a gate from the rest, and the worker is told to leave every check passing. A check that is not counted
 * is still listed, so a round can name the job behind a roll-up that failed. A commit status is read as a check run: its context is its name, its failure its conclusion, and
 * its time its completion.
 */
export function failingChecks(contexts: readonly Check[], policy: CodeHostPolicy): { name: string; at: number | null; detailsUrl: string | null; counted: boolean }[] {
  const required = new Set(contexts.filter((check) => check.isRequired === true).map(nameOf));
  const asRuns = asCheckRuns(contexts);
  return policy.redChecksOf({ rollup: asRuns, labels: [] }).map(({ name, failedAt }) =>
    ({ name, at: Number.isNaN(failedAt) ? null : failedAt, detailsUrl: detailsUrlOf(asRuns, name, policy), counted: required.size === 0 || required.has(name) }));
}

/** The conclusions of a check run, and the states of a commit status, that are a pass: GitHub merges on them, and a skipped or neutral check does not hold a merge. */
const PASSED_CONCLUSIONS: ReadonlySet<string> = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * The checks whose newest run is not red (`red`, as {@link failingChecks} reads the newest of each name), split into the ones that passed and the ones that have not (contract 1.15): `passing` is the newest run concluded
 * green, `pending` is a run with no conclusion yet, a cancelled or stale one, and a commit status that is pending or expected. A name is in one of `red`, `passing` and `pending`, never two. A commit status is read as a check run, as it is there.
 */
export function settledChecks(contexts: readonly Check[], policy: CodeHostPolicy, red: ReadonlySet<string>): { passing: string[]; pending: string[] } {
  const newest = new Map<string, Check>();
  for (const run of asCheckRuns(contexts)) {
    const seen = newest.get(run.name ?? "");
    if (seen === undefined || policy.isAtLeastAsNew(run, seen)) newest.set(run.name ?? "", run);
  }
  const passed = (run: Check): boolean => run.state !== undefined ? run.state === "SUCCESS" : PASSED_CONCLUSIONS.has(run.conclusion ?? "");
  const notRed = [...newest.values()].filter((run) => !red.has(run.name ?? ""));
  return { passing: notRed.filter(passed).map(({ name }) => name ?? ""), pending: notRed.filter((run) => !passed(run)).map(({ name }) => name ?? "") };
}

/** The details address of the newest run of the check `name`, as the red-check decider reads the newest of each name, or null when it has none. */
function detailsUrlOf(runs: readonly Check[], name: string, policy: CodeHostPolicy): string | null {
  const newest = runs.filter((run) => run.name === name).reduce<Check | null>((latest, run) => (latest === null || policy.isAtLeastAsNew(run, latest) ? run : latest), null);
  return typeof newest?.detailsUrl === "string" ? newest.detailsUrl : null;
}

/**
 * THE FEEDBACK ON THE PULL REQUEST AT `url`, leaving out what `self` wrote and what `alsoIgnore` wrote, or null for "could not ask": an address that is not a GitHub pull
 * request, a refused `run`, and an answer without the pull request. Null is never "no feedback".
 */
export function readPullFeedback(url: string, self: string, run: (args: string[]) => string, policy: CodeHostPolicy, alsoIgnore: readonly string[] = []): PullFeedback | null {
  const pull = pullOf(url);
  if (pull === null) return null;
  try {
    const answer = JSON.parse(run(["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${pull.owner}`, "-f", `repo=${pull.repo}`, "-F", `number=${pull.number}`]));
    const pr = answer?.data?.repository?.pullRequest;
    if (pr === null || typeof pr !== "object" || typeof pr.state !== "string") return null;
    const files = changedFiles(pull, pr.files, run);
    return { ...feedbackOf(pr, self, alsoIgnore, policy), files: files.paths, filesComplete: files.complete };
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

/** What the newest review that {@link rulesOn} commit `head` says, or null when none does. */
function verdictAt(reviews: readonly Review[], head: string, counts: (author: Login) => boolean): "approved" | "changes-requested" | null {
  const at = (review: Review): number => time(review.submittedAt) ?? 0;
  const newer = (latest: Review | null, review: Review): Review => (latest === null || at(review) >= at(latest) ? review : latest);
  const newest = reviews.filter((review) => rulesOn(review, head, counts)).reduce<Review | null>(newer, null);
  return newest === null ? null : newest.state === "APPROVED" ? "approved" : "changes-requested";
}

/** The feedback in one pull request as the query returns it, its files aside. Throws on an answer of another shape, which the caller reads as no reading. */
function feedbackOf(pr: Record<string, any>, self: string, alsoIgnore: readonly string[], policy: CodeHostPolicy): Omit<PullFeedback, "files" | "filesComplete"> {
  const others = (author: Login) => author?.login !== undefined && author.login !== self && !alsoIgnore.includes(author.login);
  const items: { at: number | null; author: string }[] = [
    ...(pr.reviews?.nodes ?? []).filter((r: { state: string; author: Login }) => FEEDBACK_REVIEWS.has(r.state) && others(r.author))
      .map((r: { submittedAt: string; author: Login }) => ({ at: time(r.submittedAt), author: r.author?.login ?? "" })),
    ...[...(pr.comments?.nodes ?? []), ...(pr.reviewThreads?.nodes ?? []).flatMap((t: { comments?: { nodes?: unknown[] } }) => t.comments?.nodes ?? [])]
      .filter((c: { author: Login }) => others(c.author))
      .map((c: { createdAt: string; author: Login }) => ({ at: time(c.createdAt), author: c.author?.login ?? "" })),
  ];
  // The branch's own head, which a review's commit is compared with: the commits connection can lag the ref by a few seconds after a push.
  const head = typeof pr.headRefOid === "string" ? pr.headRefOid : null;
  const contexts: Check[] = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const red = failingChecks(contexts, policy);
  const failing = red.filter(({ counted }) => counted);
  const newest = (times: (number | null)[]): number | null => times.reduce<number | null>((max, at) => (at !== null && (max === null || at > max) ? at : max), null);
  return {
    state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open",
    feedbackAt: newest(items.map(({ at }) => at)),
    authors: [...new Set(items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).map(({ author }) => author))],
    failing: failing.map(({ name }) => name),
    failures: red.map(({ name, detailsUrl }) => ({ name, detailsUrl })),
    failedAt: newest(failing.map(({ at }) => at)),
    conflicting: pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY",
    mergeable: pr.mergeable === "MERGEABLE",
    head,
    approvedAtHead: head !== null && verdictAt(pr.reviews?.nodes ?? [], head, others) === "approved",
    base: typeof pr.baseRefName === "string" ? pr.baseRefName : null,
    // A decision GitHub does not give, or gives in words this does not know, is left out: absent is not the same as null, which is a branch that requires no review.
    ...(pr.reviewDecision === null || Object.hasOwn(REVIEW_DECISIONS, String(pr.reviewDecision)) ? { reviewDecision: pr.reviewDecision === null ? null : REVIEW_DECISIONS[String(pr.reviewDecision)] } : {}),
    // The reviewer's own verdict counts for readiness, which is why this leaves out the workers' account alone.
    verdictAtHead: head === null ? null : verdictAt(pr.reviews?.nodes ?? [], head, (author) => author?.login !== undefined && author.login !== self),
    pendingRequired: pendingRequired(contexts, policy),
    body: typeof pr.body === "string" ? pr.body : "",
  };
}
