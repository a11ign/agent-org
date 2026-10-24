// @ts-check
// module: the code host contract's optional `rows` group, the readouts section -- row mode's GitHub operations that the last callers of `src/` ask (contract 1.12, A11-160 step 9)
//
// A TYPE FILE: it imports nothing at run time. Each member is a named operation of what a caller asks, never a `gh` command line; it takes the `run` its caller hands it where the caller keeps its own executor, and
// THROWS (or answers `null` where its name says so) when the read is refused: none returns an empty list for "could not ask".
//
// THIS SECTION IS THE READ-ONLY REPORTERS: the blast-radius gate's tree read (`blast-radius.ts`), the CI-health liveness reads (`ci-health-liveness.ts`), the release-behind-main facts (`release-behind-main.ts`),
// the reviewer's review-depth state (`review-depth.ts`), the commit-liveness watchdog (`workflow-run-liveness.ts`), the lane authorship check (`lane-ownership.ts`), the branch inventory
// (`branch-inventory-report.ts`) and the tick snapshot's conditional probes (`tick-snapshot.ts`). Every read takes the `run` its caller hands it and answers the facts below; what a caller DECIDES from a refusal
// (CANNOT TELL, unknown, null) stays in the caller.
import type { RowsRun } from "./code-host-rows.ts";

/** A workflow as REST states it: the path of its file and whether it is enabled (`state`); either is absent where the answer carries none. */
export type WorkflowDefinition = { path?: string; state?: string };

/** A release as the release-behind-main reading lists it: its tag and when it was published, each `null` where GitHub gave none. */
export type PublishedRelease = { tag: string | null; at: string | null };

/** A commit of `main` under one path, as the listing projects it: its sha, its committer date (ISO) and how many parents it has (a merge commit has two). */
export type PathCommit = { sha: string; at: string; parents: number };

/** A file one commit changed, with the path it had before when it was renamed. */
export type CommitFile = { filename?: string; previous_filename?: string };

/** A pull request a commit came in by, with its body (`null` where it has none). */
export type CommitPull = { number: number; body: string | null };

/** A pull request GitHub associates with a commit, with the sha of its head. */
export type AssociatedPull = { number: number; headRefOid: string };

/** What the reviewer's depth reads of a pull request, as numbers and text (an absent count is `NaN`, an absent title or body `""`). */
export type PullDepthFacts = { changedFiles: number; additions: number; deletions: number; title: string; body: string };

/** A row or pull request of the issues listing, projected to what the branch inventory reads: its state upper-cased, whether it is a pull request, and its label names. */
export type ProjectedIssue = { number: number; state: "OPEN" | "CLOSED"; isPullRequest: boolean; labels: string[] };

/** A timeline event of a row as the branch inventory reads the claim history: what happened and, for a label event, which label. */
export type TimelineEvent = { event: string; label?: { name: string } };

/** What a probe's page lists besides its tag (agent-org#1207): the newest `updated_at` among its items and how many there are. */
export type ProbeFacts = { newest: string | null; count: number };

/** How one conditional probe answered: the HTTP status (`null` when none was printed), the tag with its `W/` removed (`null` when none), and what a 200 body listed (`undefined` when it listed nothing readable). */
export type ProbeReading = { status: number | null; etag: string | null; facts: ProbeFacts | undefined };

export interface RowsReadouts {
  // --- the blast-radius gate (`blast-radius.ts`) ---------------------------------------------------------------------------------------

  /** Every tracked file of the default branch of `repo`, from its recursive tree. THROWS when the read is refused or the tree was cut short (GitHub's `truncated`): a cut tree is never a shorter list. */
  treeFilesOf(request: { repo: string; run: RowsRun }): string[];

  // --- the CI-health liveness reads (`ci-health-liveness.ts`) --------------------------------------------------------------------------

  /** The workflow file `workflow` of `repo`, as REST states it. THROWS when the read is refused or is not JSON. */
  workflowDefinitionOf(request: { repo: string; workflow: string; run: RowsRun }): WorkflowDefinition | null;
  /** `path` of `repo` as its default branch holds it, raw text. THROWS when the read is refused. */
  rawFileTextOf(request: { repo: string; path: string; run: RowsRun }): string;
  /** The newest `perPage` runs of `workflow` that a `schedule` started, as REST lists them (`id`, `event`, `created_at`, `conclusion`, `status`); `undefined` when the answer carries no list. THROWS when the read is refused or is not JSON. */
  scheduledRunsOf(request: { repo: string; workflow: string; perPage: number; run: RowsRun }): { id: number; event: string; created_at: string; conclusion?: string | null; status?: string | null }[] | undefined;
  /** The bodies of the comments of row `issue` of `repo`, every page, from `since` (ISO) on when it names one. THROWS when the read is refused or an answer is not a list of pages. */
  reportCommentBodiesOf(request: { repo: string; issue: number; perPage: number; since: string | null; run: RowsRun }): string[];

  // --- the release-behind-main facts (`release-behind-main.ts`) ------------------------------------------------------------------------

  /** The newest `window` releases of `repo` that are not drafts, with their tag and publish time. THROWS when the read is refused, is not JSON, or does not answer a list. */
  publishedReleasesOf(request: { repo: string; window: number; run: RowsRun }): PublishedRelease[];
  /** One page of the commits of `main` under `path`, newest first, since `since` (ISO) when it names one. THROWS when the read is refused, is not JSON, or does not answer a list. */
  pathCommitsPageOf(request: { repo: string; path: string; page: number; perPage: number; since: string | null; run: RowsRun }): PathCommit[];
  /** The files one commit changed (at most the three hundred GitHub lists). THROWS when the read is refused, is not JSON, or does not answer a list. */
  commitFilesOf(request: { repo: string; sha: string; run: RowsRun }): CommitFile[];
  /** The pull requests one commit came in by, with their bodies. THROWS when the read is refused, is not JSON, or does not answer a list. */
  commitPullsOf(request: { repo: string; sha: string; run: RowsRun }): CommitPull[];

  // --- the reviewer's review depth (`review-depth.ts`) ---------------------------------------------------------------------------------

  /** Pull request `number` of `repo`: how many files it changes, its added and removed lines, its title and body. THROWS when the read is refused or is not JSON. */
  pullDepthFactsOf(request: { repo: string; number: number; run: RowsRun }): PullDepthFacts;
  /** The file names of pull request `number`, the first `perPage` of them. THROWS when the read is refused or is not a list. */
  pullFilenamesPageOf(request: { repo: string; number: number; perPage: number; run: RowsRun }): string[];
  /** The body of row `number` of `repo` (`""` where it has none), over REST. THROWS when the read is refused or is not JSON. */
  restRowBodyOf(request: { repo: string; number: number | string; run: RowsRun }): string;

  // --- the commit-liveness watchdog and the lane authorship check ----------------------------------------------------------------------

  /** Every pull request GitHub associates with commit `sha` of `repo`, each with its number and the sha of its head. THROWS when the read is refused or does not answer a list. */
  commitAssociatedPullsOf(request: { repo: string; sha: string; run: RowsRun }): AssociatedPull[];
  /** EVERY file name of pull request `number`, through REST's pages. THROWS when the read is refused. */
  pullFilenamesOf(request: { repo: string; number: number | string; run: RowsRun }): string[];

  // --- the branch inventory (`branch-inventory-report.ts`) -----------------------------------------------------------------------------

  /** The head branch of every OPEN pull request of `repo`, over REST. THROWS when the read is refused. */
  openPullHeadRefsOf(request: { repo: string; run: RowsRun }): string[];
  /** Every row and pull request of `repo`, any state, over REST, in one paginated listing, projected to {@link ProjectedIssue}. THROWS when the read is refused or a line is not JSON. */
  issueProjectionOf(request: { repo: string; run: RowsRun }): ProjectedIssue[];
  /** The timeline of row `number` of `repo`, every page. THROWS when the read is refused or is not JSON. */
  rowTimelineEventsOf(request: { repo: string; number: number; run: RowsRun }): TimelineEvent[];

  // --- the tick snapshot's probes (`tick-snapshot.ts`) ---------------------------------------------------------------------------------

  /**
   * ONE conditional GET of REST `path`, with its response headers: `etag` is sent as `If-None-Match` when it names one. The code host starts the program itself (the caller needs the status line of the answer, which a
   * runner that throws on a non-zero exit cannot give: `gh api` exits 1 on a 304), cut at `timeoutMs`, with `maxBuffer` of output. NEVER THROWS: a program that could not start or was cut answers no status.
   */
  conditionalProbeOf(request: { path: string; etag: string | undefined; timeoutMs: number; maxBuffer: number }): ProbeReading;
}
