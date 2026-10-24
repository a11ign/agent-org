// @ts-check
// module: the in-memory code host's operations for the readouts section (A11-160, step 9)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. The rows, their comments and the pull requests of the world (and the foreign rows of other repositories) are the
// world's; a row's label history is the gate's (`world.gate.events`). What the read-only reporters read beyond them is `world.tail.readouts`: the tracked files of a repository, its workflows and their scheduled runs,
// its releases and the history of its `main`, the detail of a pull request, and the answers of a conditional probe. A repository or a commit the world holds nothing for is a refused read, never an empty one: "could not
// ask" is not "nothing is there". A read refused on ONE repository is `world.failures` naming `<operation> <owner/name>`; on every repository, the operation alone.
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { AssociatedPull, CommitFile, CommitPull, ProbeReading, RowsReadouts, TimelineEvent } from "../contracts/code-host-rows-readouts.ts";
import type { FakeRow, FakeRowsWorld } from "./code-host-rows.ts";

/** A workflow as the CI-health reading reads it: the path of its file, whether it is enabled, and the runs a `schedule` started (newest first, as REST lists them). */
export type FakeWorkflow = { path: string; state: string; scheduledRuns: { id: number; event: string; created_at: string; conclusion?: string | null; status?: string | null }[] };

/** A commit of `main` as release-behind-main reads it: when it was committed, how many parents it has (a merge commit has two; absent is one), the files it changed and the pull requests it came in by. */
export type FakeCommit = { sha: string; at: string; parents?: number; files: CommitFile[]; pulls: CommitPull[] };

/** A repository's history as release-behind-main reads it: its releases (`draft` ones are left out of the listing) and the commits of `main`. */
export type FakeHistory = { releases: { tag: string; publishedAt: string; draft?: boolean }[]; commits: FakeCommit[] };

/** A pull request as the review depth and the authorship check read it, where the world's own pull request does not hold it (another repository's, or one with line counts). */
export type FakePullDetail = { title: string; body: string; additions: number; deletions: number; files: string[]; changedFiles?: number };

/** What the read-only reporters read of the world beyond its rows and pull requests. */
export type FakeReadouts = {
  /** The tracked files of a repository's default branch, or the error reading them throws; by `owner/name`. */
  trees: Map<string, readonly string[] | Error>;
  /** The workflows of a repository, by `owner/name/<file name>`; and the text of a file, by `owner/name:<path>`. */
  workflows: Map<string, FakeWorkflow>;
  files: Map<string, string>;
  /** The releases and commits of a repository, by `owner/name`. */
  histories: Map<string, FakeHistory>;
  /** A pull request's detail, by `owner/name#number`; the pull requests GitHub associates with a commit, by `owner/name@sha`. */
  pulls: Map<string, FakePullDetail>;
  associated: Map<string, AssociatedPull[]>;
  /** What a conditional probe of a REST path answers, by path; and every ask made so far, in order (`etag` is what the caller sent as `If-None-Match`, `undefined` when it sent none). */
  probes: Map<string, ProbeReading>;
  probeAsks: { path: string; etag: string | undefined }[];
};

export const emptyReadouts = (): FakeReadouts => ({ trees: new Map(), workflows: new Map(), files: new Map(), histories: new Map(), pulls: new Map(), associated: new Map(), probes: new Map(), probeAsks: [] });

/** Records the read in the world's calls (the operation and what it was about), then makes it. */
const noted = <T>(world: FakeRowsWorld, line: string, read: () => T): T => {
  world.calls.push(line);
  return read();
};

/** A read refused: the error `world.failures` names for the operation on this repository, or for the operation on every repository. */
function refusal(world: FakeRowsWorld, operation: string, repo: string): void {
  const refused = world.failures.get(`${operation} ${repo}`) ?? world.failures.get(operation);
  if (refused !== undefined) throw refused;
}

const seeded = <T>(held: T | undefined, what: string): T => {
  if (held === undefined) throw new Error(`the fake holds no ${what}`);
  return held;
};

/** The row `number` of `repo`: the world's own, or a foreign one a test seeded. */
function rowOf(world: FakeRowsWorld, repo: string, number: number | string): FakeRow {
  const key = Number(number);
  return seeded(repo === world.repo ? world.rows.get(key) : world.foreignRows.get(`${repo}#${key}`), `row ${repo}#${key}`);
}

/** Pull request `number` of `repo`: a detail a test seeded, else the world's own pull request (with no changed lines). */
function pullDetailOf(world: FakeRowsWorld, repo: string, number: number | string): FakePullDetail {
  const seededDetail = world.tail.readouts.pulls.get(`${repo}#${number}`);
  if (seededDetail !== undefined) return seededDetail;
  const own = repo === world.repo ? world.pulls.get(Number(number)) : undefined;
  if (own === undefined) throw new Error(`the fake holds no pull request ${repo}#${number}`);
  return { title: own.title ?? "", body: own.body, additions: 0, deletions: 0, files: own.files ?? [] };
}

const isOpenPull = (pull: { merged: boolean; closedAt?: string | null }): boolean => !pull.merged && pull.closedAt == null;

type Operations = Pick<CodeHostRows, keyof RowsReadouts>;

/** The reads of a repository's history: its releases, and the commits of `main` under a path. */
function historyOperations(world: FakeRowsWorld): Pick<Operations, "publishedReleasesOf" | "pathCommitsPageOf" | "commitFilesOf" | "commitPullsOf"> {
  const historyOf = (operation: string, repo: string) => (refusal(world, operation, repo), seeded(world.tail.readouts.histories.get(repo), `history of ${repo}`));
  const commitOf = (operation: string, repo: string, sha: string): FakeCommit => seeded(historyOf(operation, repo).commits.find((commit) => commit.sha === sha), `commit ${sha} of ${repo}`);
  const touches = (commit: FakeCommit, path: string): boolean => commit.files.some((file) => [file.filename, file.previous_filename].some((name) => name?.startsWith(path)));
  return {
    publishedReleasesOf: ({ repo, window }) => noted(world, `publishedReleasesOf ${repo}`, () => historyOf("publishedReleasesOf", repo).releases.filter((release) => release.draft !== true).slice(0, window)
      .map(({ tag, publishedAt }) => ({ tag, at: publishedAt }))),
    pathCommitsPageOf: ({ repo, path, page, perPage, since }) => noted(world, `pathCommitsPageOf ${repo} ${path} page ${page}`, () => {
      const listed = historyOf("pathCommitsPageOf", repo).commits.filter((commit) => touches(commit, path) && (since === null || Date.parse(commit.at) >= Date.parse(since)))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      return listed.slice((page - 1) * perPage, page * perPage).map((commit) => ({ sha: commit.sha, at: commit.at, parents: commit.parents ?? 1 }));
    }),
    commitFilesOf: ({ repo, sha }) => noted(world, `commitFilesOf ${repo} ${sha}`, () => structuredClone(commitOf("commitFilesOf", repo, sha).files)),
    commitPullsOf: ({ repo, sha }) => noted(world, `commitPullsOf ${repo} ${sha}`, () => structuredClone(commitOf("commitPullsOf", repo, sha).pulls)),
  };
}

/** The reads of the CI-health liveness: a workflow, its file, its scheduled runs and the report issue's comments. */
function workflowOperations(world: FakeRowsWorld): Pick<Operations, "workflowDefinitionOf" | "rawFileTextOf" | "scheduledRunsOf" | "reportCommentBodiesOf"> {
  const workflowOf = (operation: string, repo: string, workflow: string): FakeWorkflow => {
    refusal(world, operation, repo);
    return seeded(world.tail.readouts.workflows.get(`${repo}/${workflow}`), `workflow ${workflow} of ${repo} (HTTP 404: Not Found)`);
  };
  return {
    workflowDefinitionOf: ({ repo, workflow }) => noted(world, `workflowDefinitionOf ${repo} ${workflow}`, () => {
      const { path, state } = workflowOf("workflowDefinitionOf", repo, workflow);
      return { path, state };
    }),
    rawFileTextOf: ({ repo, path }) => noted(world, `rawFileTextOf ${repo} ${path}`, () => (refusal(world, "rawFileTextOf", repo), seeded(world.tail.readouts.files.get(`${repo}:${path}`), `file ${path} of ${repo}`))),
    scheduledRunsOf: ({ repo, workflow, perPage }) => noted(world, `scheduledRunsOf ${repo} ${workflow}`, () => structuredClone(workflowOf("scheduledRunsOf", repo, workflow).scheduledRuns.filter((run) => run.event === "schedule").slice(0, perPage))),
    reportCommentBodiesOf: ({ repo, issue, since }) => noted(world, `reportCommentBodiesOf ${repo}#${issue}`, () => {
      refusal(world, "reportCommentBodiesOf", repo);
      return rowOf(world, repo, issue).comments.filter((comment) => since === null || Date.parse(comment.createdAt) >= Date.parse(since)).map((comment) => comment.body);
    }),
  };
}

/** The reads of pull requests and rows: the review depth's state, the commit-liveness watchdog's associated pull requests and the authorship check's file names. */
function pullOperations(world: FakeRowsWorld): Pick<Operations, "pullDepthFactsOf" | "pullFilenamesPageOf" | "restRowBodyOf" | "commitAssociatedPullsOf" | "pullFilenamesOf"> {
  return {
    pullDepthFactsOf: ({ repo, number }) => noted(world, `pullDepthFactsOf ${repo}#${number}`, () => {
      refusal(world, "pullDepthFactsOf", repo);
      const pull = pullDetailOf(world, repo, number);
      return { changedFiles: pull.changedFiles ?? pull.files.length, additions: pull.additions, deletions: pull.deletions, title: pull.title, body: pull.body };
    }),
    pullFilenamesPageOf: ({ repo, number, perPage }) => noted(world, `pullFilenamesPageOf ${repo}#${number}`, () => (refusal(world, "pullFilenamesPageOf", repo), pullDetailOf(world, repo, number).files.slice(0, perPage))),
    restRowBodyOf: ({ repo, number }) => noted(world, `restRowBodyOf ${repo}#${number}`, () => (refusal(world, "restRowBodyOf", repo), rowOf(world, repo, number).body)),
    commitAssociatedPullsOf: ({ repo, sha }) => noted(world, `commitAssociatedPullsOf ${repo} ${sha}`, () => {
      refusal(world, "commitAssociatedPullsOf", repo);
      return structuredClone(seeded(world.tail.readouts.associated.get(`${repo}@${sha}`), `pull requests associated with ${repo}@${sha}`));
    }),
    pullFilenamesOf: ({ repo, number }) => noted(world, `pullFilenamesOf ${repo}#${number}`, () => (refusal(world, "pullFilenamesOf", repo), [...pullDetailOf(world, repo, number).files])),
  };
}

/** The reads of the branch inventory: the open pull requests' branches, the issues listing, a row's timeline. */
function inventoryOperations(world: FakeRowsWorld): Pick<Operations, "openPullHeadRefsOf" | "issueProjectionOf" | "rowTimelineEventsOf"> {
  return {
    openPullHeadRefsOf: ({ repo }) => noted(world, `openPullHeadRefsOf ${repo}`, () => [...world.pulls.values()].filter(isOpenPull).map((pull) => pull.headRefName)),
    issueProjectionOf: ({ repo }) => noted(world, `issueProjectionOf ${repo}`, () => [
      ...[...world.rows.values()].map((row) => ({ number: row.number, state: row.state, isPullRequest: false, labels: [...row.labels] })),
      ...[...world.pulls.values()].map((pull) => ({ number: pull.number, state: isOpenPull(pull) ? "OPEN" as const : "CLOSED" as const, isPullRequest: true, labels: [...pull.labels] })),
    ]),
    rowTimelineEventsOf: ({ repo, number }) => noted(world, `rowTimelineEventsOf ${repo}#${number}`, (): TimelineEvent[] => {
      const events = world.gate.events.get(number) ?? [];
      if (events instanceof Error) throw events;
      return events.map(({ event, label }) => ({ event, label: { name: label } }));
    }),
  };
}

export function readoutsOperations(world: FakeRowsWorld): Operations {
  return {
    treeFilesOf: ({ repo }) => noted(world, `treeFilesOf ${repo}`, () => {
      refusal(world, "treeFilesOf", repo);
      const tree = seeded(world.tail.readouts.trees.get(repo), `tree of ${repo}`);
      if (tree instanceof Error) throw tree;
      return [...tree];
    }),
    ...workflowOperations(world), ...historyOperations(world), ...pullOperations(world), ...inventoryOperations(world),
    conditionalProbeOf: ({ path, etag }) => {
      world.tail.readouts.probeAsks.push({ path, etag });
      return structuredClone(seeded(world.tail.readouts.probes.get(path), `probe of ${path}`));
    },
  };
}
