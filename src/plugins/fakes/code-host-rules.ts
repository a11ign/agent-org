// @ts-check
// module: the in-memory code host's operations for the claim's rules (A11-160, step 7)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. B2 reads a session's held rows (their labels, `blockedBy` edge, sub-issues, the pull requests that close them or
// cross-reference them and what those change) and the review health of the open pull requests; B4 reads the open pull requests of each code repository with the files they change. The world's own rows and pull
// requests answer for the tracker's repository; another repository's rows are `foreignRows` and its pull requests are `rules.otherRepos`. A pull request closes the rows its `closes` names, and B2's closing read is
// derived from that. A test that wants one read to fail names the operation in `world.failures`, or the repository, row or pull request in `rules`.
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { ClosingPullRead, CrossReferencingPull, OpenPullReview, PullCommit } from "../contracts/code-host-rows-facts.ts";
import type { FakeRow, FakeRowPull, FakeRowsWorld } from "./code-host-rows.ts";
import { labelExists, refusal } from "./code-host-claim.ts";

/** What the claim's rules read of the world beyond its rows and pull requests. */
export type FakeRules = {
  /** The pull requests of repositories other than the world's own, by `owner/name` then number. */
  otherRepos: Map<string, Map<number, FakeRowPull>>;
  /** What the list of open pull requests answers for a pull request beyond what the pull request itself holds (its head, decision and author): its reviews, or any field laid over the derived answer. */
  reviews: Map<number, Partial<OpenPullReview>>;
  /** The commits of a pull request. */
  commits: Map<number, PullCommit[]>;
  /** The items that cross-reference a row, by `owner/name#number`; an `Error` is a refused read of just that timeline. */
  crossReferences: Map<string, CrossReferencingPull[] | Error>;
  /** Rows whose answer carries no `body` key at all, as a `gh` that was asked the wrong question answers. */
  bodyless: Set<number>;
  /** Rows whose shape is answered with the body alone: no labels and no `blockedBy` edge, as a lookup that did not carry them. */
  uncarried: Set<number>;
  /** The sub-issues of a row, by number. */
  subIssues: Map<number, number>;
  /** What the listing of open pull requests answers where it differs from the files a pull request changes: the first page, and how many it changes in all. */
  listings: Map<number, { listed: string[]; changedFiles: number }>;
  /** Repositories whose list of open pull requests cannot be read, and pull requests whose files cannot be paged. */
  listRefused: Map<string, Error>;
  pagedFilesRefused: Map<number, Error>;
  /** What comparing a commit with `main` answers, by sha: the answer, or `null` for "GitHub cannot say". */
  compare: Map<string, { status: string; files: string[] } | null>;
};

export const emptyRules = (): FakeRules => ({ otherRepos: new Map(), reviews: new Map(), commits: new Map(), crossReferences: new Map(), subIssues: new Map(), bodyless: new Set(), uncarried: new Set(), listings: new Map(), listRefused: new Map(), pagedFilesRefused: new Map(), compare: new Map() });

const isHome = (world: FakeRowsWorld, repo: string): boolean => ["", "{owner}/{repo}", world.repo].includes(repo);

const stateOf = (pull: FakeRowPull): "OPEN" | "MERGED" | "CLOSED" => (pull.merged ? "MERGED" : pull.closedAt != null ? "CLOSED" : "OPEN");

/** The pull requests of `repo`, in number order. */
const pullsIn = (world: FakeRowsWorld, repo: string): FakeRowPull[] => [...(isHome(world, repo) ? world.pulls : (world.rules.otherRepos.get(repo) ?? new Map<number, FakeRowPull>())).values()].sort((a, b) => a.number - b.number);

const openIn = (world: FakeRowsWorld, repo: string): FakeRowPull[] => pullsIn(world, repo).filter((pull) => stateOf(pull) === "OPEN");

function pullIn(world: FakeRowsWorld, repo: string, number: number): FakeRowPull {
  const pull = pullsIn(world, repo).find((candidate) => candidate.number === number);
  if (pull === undefined) throw new Error(`the fake holds no pull request ${repo}#${number}`);
  return pull;
}

function rowIn(world: FakeRowsWorld, repo: string, number: number): FakeRow {
  const row = isHome(world, repo) ? world.rows.get(number) : world.foreignRows.get(`${repo}#${number}`);
  if (row === undefined) throw new Error(`the fake holds no row ${repo}#${number}`);
  return row;
}

const labelNodes = (labels: string[]): { name: string }[] => labels.map((name) => ({ name }));

/** The `blockedBy` edge of a row as GitHub answers it: each blocker with the state it is in (a blocker the world does not hold is open). */
function blockedByNodes(world: FakeRowsWorld, row: FakeRow): { nodes: { number: number; state: string }[] } {
  return { nodes: row.blockedBy.map((number) => ({ number, state: world.rows.get(number)?.state ?? "OPEN" })) };
}

const noted = <T>(world: FakeRowsWorld, line: string, read: () => T): T => {
  world.calls.push(line);
  return read();
};

export function rulesOperations(world: FakeRowsWorld): Pick<CodeHostRows, "blockedByOf" | "bodyAndLabelsOf" | "rowShapeFactsOf" | "rowCarriesLabel" | "openPullReviewsOf" | "commitsOfPull" | "closingPullsOf"
  | "crossReferencingPullsOf" | "changedPathsOfPull" | "openPullsWithFilesOf" | "pullFilePathsOf" | "ensureLabelIn" | "addLabelToRowIn" | "compareShaWithMain"> {
  return {
    blockedByOf: ({ repo, number }) => noted(world, `blockedByOf ${repo}#${number}`, () => ({ blockedBy: blockedByNodes(world, rowIn(world, repo, number)) })),
    bodyAndLabelsOf: ({ repo, number }) => noted(world, `bodyAndLabelsOf ${repo}#${number}`, () => {
      const row = rowIn(world, repo, number);
      return world.rules.bodyless.has(number) ? { labels: labelNodes(row.labels) } : { body: row.body, labels: labelNodes(row.labels) };
    }),
    rowShapeFactsOf: ({ repo, number }) => noted(world, `rowShapeFactsOf ${repo}#${number}`, () => {
      const row = rowIn(world, repo, number);
      const subIssues = world.rules.subIssues.get(number) ?? 0;
      return world.rules.uncarried.has(number) ? { body: row.body, subIssues } : { body: row.body, labels: labelNodes(row.labels), blockedBy: blockedByNodes(world, row), subIssues };
    }),
    rowCarriesLabel: ({ repo, number, label }) => rowIn(world, repo, number).labels.includes(label),
    openPullReviewsOf: ({ repo, limit }) => noted(world, `openPullReviewsOf ${repo} limit ${limit}`, () => openIn(world, repo).slice(0, limit).map((pull): OpenPullReview => (
      { number: pull.number, headRefOid: pull.headRefOid, reviewDecision: pull.reviewDecision ?? null, reviews: [], ...(pull.author == null ? {} : { author: { login: pull.author } }), ...world.rules.reviews.get(pull.number) }))),
    commitsOfPull: ({ repo, number }) => noted(world, `commitsOfPull ${repo}#${number}`, () => world.rules.commits.get(number) ?? []),
    closingPullsOf: ({ repo, number }): ClosingPullRead[] => noted(world, `closingPullsOf ${repo}#${number}`, () => pullsIn(world, repo)
      .filter((pull) => (pull.closes ?? []).some((closed) => closed.number === number && (closed.repo === undefined || closed.repo === repo)))
      .map((pull) => ({ number: pull.number, state: stateOf(pull), headRefOid: pull.headRefOid ?? `head-${pull.number}` }))),
    crossReferencingPullsOf: ({ repo, number }) => noted(world, `crossReferencingPullsOf ${repo}#${number}`, () => {
      const found = world.rules.crossReferences.get(`${isHome(world, repo) ? world.repo : repo}#${number}`) ?? [];
      if (found instanceof Error) throw found;
      return found;
    }),
    changedPathsOfPull: ({ repo, number }) => noted(world, `changedPathsOfPull ${repo}#${number}`, () => [...(pullIn(world, repo, number).files ?? [])]),
    openPullsWithFilesOf: ({ repo }) => noted(world, `openPullsWithFilesOf ${repo}`, () => {
      const refused = world.rules.listRefused.get(isHome(world, repo) ? world.repo : repo);
      if (refused !== undefined) throw refused;
      return openIn(world, repo).map((pull) => {
        const files = pull.files ?? [];
        const listing = world.rules.listings.get(pull.number);
        return { number: pull.number, changedFiles: listing?.changedFiles ?? files.length, files: (listing?.listed ?? files).map((path) => ({ path })), body: pull.body, labels: labelNodes(pull.labels), ...(pull.headRefName === "" ? {} : { headRefName: pull.headRefName }) };
      });
    }),
    pullFilePathsOf: ({ repo, number }) => noted(world, `pullFilePathsOf ${repo}#${number}`, () => {
      const refused = world.rules.pagedFilesRefused.get(number);
      if (refused !== undefined) throw refused;
      return [...(pullIn(world, repo, number).files ?? [])];
    }),
    ensureLabelIn: ({ repo, name }) => {
      if (!world.labelsCreated.includes(name)) world.labelsCreated.push(name);
      world.filing.labelsCreatedIn.push(`${repo}:${name}`); // which repository it was made in, for a caller that files into another
    },
    addLabelToRowIn: ({ repo, number, label }) => {
      const row = rowIn(world, repo, number);
      // `gh issue edit --add-label` refuses a label that does not exist: the caller creates it first.
      if (!labelExists(world, label)) throw refusal(`issue edit ${number} --repo ${repo}`, `could not add label: '${label}' not found`);
      if (!row.labels.includes(label)) row.labels.push(label);
    },
    compareShaWithMain: ({ sha }) => world.rules.compare.get(sha) ?? null,
  };
}
