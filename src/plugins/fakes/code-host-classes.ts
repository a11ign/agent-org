// @ts-check
// module: the in-memory code host's operations for the classes section (A11-160, step 9)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. A row is the world's row, a merged pull request is the world's pull request, and a comment is a comment of a row of the
// world. What the CI facts of a red pull request read beyond them (the check that is red and its log, the runs on `main`, the steps of a job, the files and the state of a pull request of another repository) is
// {@link FakeClasses}, in the contract's shapes and not GitHub's JSON. An entry that is an `Error` is a read that throws it; a read of something the test did not seed throws, as GitHub's "not found" does.
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { CommentBodyRead, CommitLoginRead, RecentRunRead, RedCheckRead, RowsClasses } from "../contracts/code-host-rows-classes.ts";
import type { FakeRow, FakeRowsWorld } from "./code-host-rows.ts";

/** The red check of a pull request: the head it was read at, and what its check says. A `null` read is a head with nothing red, or a red check that is not a workflow job. */
export type FakeRedCheck = { headSha: string; read: RedCheckRead | null };

/** A pull request of another repository as the refresh of a merged fix reads it, and the refusal a branch update meets (a conflict). */
export type FakeRefreshPull = { open: boolean; mergedAt: string | null; behindBy: number; updateRefusal: string | null };

/** What a test seeds for this section beyond the world's rows and pull requests. */
export type FakeClasses = {
  /** The red check of a pull request, by `<owner/name>#<number>`. */
  failingChecksOf: Map<string, FakeRedCheck | Error>;
  /** The newest workflow runs on `main`, and the newest that failed for a pull request. */
  recentRuns: { onMain: RecentRunRead[] | Error; failingForPullRequests: RecentRunRead[] | Error };
  /** A workflow job by its id: the first failed step (`null` for none) and its log. */
  jobs: Map<string, { failedStep: string | null; log: string } | Error>;
  /** The files a pull request changes, by `<owner/name>#<number>`; `null` is an answer that is not a list. */
  pullFiles: Map<string, string[] | null | Error>;
  /** The pull requests a refresh reads, by `<owner/name>#<number>`, and the ones whose branch was updated, in order. */
  refreshPulls: Map<string, FakeRefreshPull | Error>;
  branchUpdates: string[];
  /** The pull requests that closed a row, by the row's number. */
  closedBy: Map<number, { number: number; repo?: string }[]>;
  /** The commits of `main` with the login that authored each (its head is the queue section's `mainSha`). */
  commitLogins: CommitLoginRead[] | Error;
  /** A comment as the safe edit reads it, by id, where a test seeds an answer that is not a comment; a comment of a row of the world is a body. */
  commentReads: Map<number, CommentBodyRead | Error>;
  /** The comments handed over on standard input to a row of the checkout `cwd` belongs to, in order. */
  checkoutComments: { number: string; body: string; cwd: string }[];
  /** The listings of closed rows that answer `null`, as the code host's answer does when it is not a listing of rows. */
  notAListing: ("class-rows" | "titled-rows")[];
  /** Called as a listing of closed rows is read, before it answers: which listing, and the class label it narrows to (`null`: the newest-updated closed rows). Throws to refuse that one read and no other. */
  onClosedRowsRead: ((listing: "class-rows" | "titled-rows", classLabel: string | null) => void) | null;
};

export const emptyClasses = (): FakeClasses => ({
  failingChecksOf: new Map(), recentRuns: { onMain: [], failingForPullRequests: [] }, jobs: new Map(), pullFiles: new Map(), refreshPulls: new Map(), branchUpdates: [], closedBy: new Map(),
  commitLogins: [], commentReads: new Map(), checkoutComments: [], notAListing: [], onClosedRowsRead: null,
});

const RUN_AND_JOB = /\/actions\/runs\/(\d+)\/job\/(\d+)/;
const REPOSITORY_OF_ADDRESS = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//;

const answer = <T>(found: T | Error): T => {
  if (found instanceof Error) throw found;
  return found;
};

const seeded = <T>(found: T | undefined, what: string): T => {
  if (found === undefined) throw new Error(`the fake holds no ${what}`);
  return found;
};

const iso = (world: FakeRowsWorld): string => new Date(world.now()).toISOString();

/** When a row last changed, for the listings that sort by it. */
const updatedOf = (row: FakeRow): number => Date.parse(row.updatedAt ?? row.closedAt ?? row.createdAt);

/** The closed rows of the world that carry `label` (any, when none is named), newest-updated first, `perPage` of them: the listing narrows to the label BEFORE it pages. */
const closedRowsOf = (world: FakeRowsWorld, perPage: number, label: string | null = null): FakeRow[] =>
  [...world.rows.values()].filter((row) => row.state === "CLOSED" && (label === null || row.labels.includes(label))).sort((a, b) => updatedOf(b) - updatedOf(a)).slice(0, perPage);

/** Records the read in the world's calls, so a test finds the bound its caller asked for, then makes it. */
const noted = <T>(world: FakeRowsWorld, line: string, read: () => T): T => {
  world.calls.push(line);
  return read();
};

const rowIn = (world: FakeRowsWorld, repo: string, number: number): FakeRow => seeded(repo === world.repo ? world.rows.get(number) : world.foreignRows.get(`${repo}#${number}`), `row ${repo}#${number}`);

const commentsOf = (world: FakeRowsWorld) => [...world.rows.values()].flatMap((row) => row.comments);

function ciOperations(world: FakeRowsWorld): Pick<CodeHostRows, "redCheckOf" | "recentRunsOf" | "jobOfCheckUrl" | "jobFailedStepOf" | "jobLogTextOf" | "changedFilesPageOf" | "pullMergedAtOf" | "openPullBehindBy" | "updatePullBranch"> {
  const { classes } = world.tail;
  const refreshPull = (repo: string, number: number): FakeRefreshPull => answer(seeded(classes.refreshPulls.get(`${repo}#${number}`), `pull request ${repo}#${number}`));
  return {
    redCheckOf: ({ repo, number, head8 }) => {
      const found = answer(seeded(classes.failingChecksOf.get(`${repo}#${number}`), `pull request ${repo}#${number}`));
      return found.headSha.startsWith(head8) ? found.read : null;
    },
    recentRunsOf: ({ kind, limit }) => answer(kind === "on-main" ? classes.recentRuns.onMain : classes.recentRuns.failingForPullRequests).slice(0, limit),
    jobOfCheckUrl: (detailsUrl) => {
      const ids = RUN_AND_JOB.exec(detailsUrl);
      const repo = REPOSITORY_OF_ADDRESS.exec(detailsUrl)?.[1];
      return ids === null || repo === undefined ? null : { repo, jobId: ids[2] };
    },
    jobFailedStepOf: ({ jobId }) => answer(seeded(classes.jobs.get(String(jobId)), `job ${jobId}`)).failedStep,
    jobLogTextOf: ({ jobId }) => answer(seeded(classes.jobs.get(String(jobId)), `job ${jobId}`)).log,
    changedFilesPageOf: ({ repo, number, perPage }) => answer(seeded(classes.pullFiles.get(`${repo}#${number}`), `files of pull request ${repo}#${number}`))?.slice(0, perPage) ?? null,
    pullMergedAtOf: ({ repo, number }) => refreshPull(repo, number).mergedAt,
    openPullBehindBy: ({ repo, number }) => {
      const pull = refreshPull(repo, number);
      return pull.open ? pull.behindBy : null;
    },
    updatePullBranch: ({ repo, number }) => {
      const pull = refreshPull(repo, number);
      if (pull.updateRefusal !== null) throw new Error(pull.updateRefusal);
      pull.behindBy = 0;
      classes.branchUpdates.push(`${repo}#${number}`);
    },
  };
}

function incidentOperations(world: FakeRowsWorld): Pick<CodeHostRows, "sharedFailureRowsOf" | "fileSharedFailureRow"> {
  return {
    sharedFailureRowsOf: ({ label, state, newest }) => [...world.rows.values()].filter((row) => row.state === state.toUpperCase() && row.labels.includes(label)).sort((a, b) => b.number - a.number).slice(0, newest)
      .map((row) => ({ number: row.number, body: row.body, createdAt: row.createdAt, ...(row.closedAt === null ? {} : { closedAt: row.closedAt }), labels: [...row.labels], closedBy: [...(world.tail.classes.closedBy.get(row.number) ?? [])] })),
    fileSharedFailureRow: ({ label, title, body }) => {
      if (!world.labelsCreated.includes(label)) world.labelsCreated.push(label);
      const number = world.nextNumber++;
      world.rows.set(number, { number, title, body, state: "OPEN", labels: [label], createdAt: iso(world), closedAt: null, comments: [], blockedBy: [], onBoard: false, boardStatus: null });
      return number;
    },
  };
}

function rowListOperations(world: FakeRowsWorld): Pick<CodeHostRows, "closedClassRowsOf" | "closedRowsTitledOf" | "labelledRowsOf" | "openRowsCarryingLabel"> {
  const closedAtOf = (row: FakeRow): number | null => (row.closedAt === null ? null : Date.parse(row.closedAt));
  const { classes } = world.tail;
  return {
    closedClassRowsOf: ({ classLabel, perPage }) => noted(world, `closedClassRowsOf ${classLabel ?? "-"}`, () => {
      classes.onClosedRowsRead?.("class-rows", classLabel);
      if (classes.notAListing.includes("class-rows")) return null;
      return closedRowsOf(world, perPage, classLabel)
        .map((row) => ({ number: row.number, title: row.title, closedAt: closedAtOf(row), labels: [...row.labels] }));
    }),
    closedRowsTitledOf: ({ perPage }) => noted(world, "closedRowsTitledOf", () => {
      classes.onClosedRowsRead?.("titled-rows", null);
      if (classes.notAListing.includes("titled-rows")) return null;
      return closedRowsOf(world, perPage).map((row) => ({ number: row.number, title: row.title, labels: [...row.labels] }));
    }),
    labelledRowsOf: ({ label }) => noted(world, `labelledRowsOf ${label}`, () => (["OPEN", "CLOSED"] as const).flatMap((state) => [...world.rows.values()].filter((row) => row.state === state && row.labels.includes(label)).sort((a, b) => b.number - a.number))
      .map((row) => ({ number: row.number, title: row.title, state: row.state, closedAt: row.closedAt }))),
    openRowsCarryingLabel: ({ label, limit }) => noted(world, `openRowsCarryingLabel ${label} limit=${limit}`, () => [...world.rows.values()].filter((row) => row.state === "OPEN" && row.labels.includes(label)).sort((a, b) => b.number - a.number).slice(0, limit)
      .map((row) => ({ number: row.number, comments: row.comments.map((comment) => ({ body: comment.body })) }))),
  };
}

function mainOperations(world: FakeRowsWorld): Pick<CodeHostRows, "mainCommitLoginsSince" | "mergedPullsSince"> {
  return {
    mainCommitLoginsSince: () => [...answer(world.tail.classes.commitLogins)],
    mergedPullsSince: ({ since }) => [...world.pulls.values()].filter((pull) => pull.merged && pull.mergedAt !== null && Date.parse(pull.mergedAt) >= Date.parse(since.toISOString().slice(0, 10)))
      .map((pull) => ({ number: pull.number, author: pull.author ?? null, title: pull.title ?? "", body: pull.body })),
  };
}

function commentOperations(world: FakeRowsWorld): Pick<CodeHostRows, "postMarkedIssueComment" | "commentBodyOf" | "commentOnCheckoutRowByInput"> {
  const { classes } = world.tail;
  const commentIn = (id: number) => seeded(commentsOf(world).find((comment) => comment.id === id), `comment ${id}`);
  return {
    postMarkedIssueComment: ({ repo, issue, marker, day, text }) => {
      const row = rowIn(world, repo, issue);
      if (row.comments.some((comment) => comment.body.startsWith(marker) && comment.createdAt >= `${day}T00:00:00Z`)) return { posted: false };
      const id = world.nextCommentId++;
      row.comments.push({ id, body: `${marker}\n${text}`, createdAt: iso(world) });
      return { posted: true, ref: String(id) };
    },
    commentBodyOf: ({ id }) => answer(classes.commentReads.get(id) ?? { kind: "body", body: commentIn(id).body } as CommentBodyRead),
    commentOnCheckoutRowByInput: ({ number, body, cwd }) => {
      rowIn(world, world.repo, Number(number)).comments.push({ id: world.nextCommentId++, body, createdAt: iso(world) });
      classes.checkoutComments.push({ number: String(number), body, cwd });
    },
  };
}

export function classesOperations(world: FakeRowsWorld): Pick<CodeHostRows, keyof RowsClasses> {
  return { ...ciOperations(world), ...incidentOperations(world), ...rowListOperations(world), ...mainOperations(world), ...commentOperations(world) };
}
