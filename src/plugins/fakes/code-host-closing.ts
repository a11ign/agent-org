// @ts-check
// module: the in-memory code host's operations for the closing section (A11-160, step 9)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. A row is the world's row (or, for another repository, one of `world.foreignRows`), a merged pull request is the world's
// pull request with the rows it `closes`, and what GitHub's timeline adds (when a row was last reopened, the merge commit, the epic above a row) is `world.tail.closing`. A read the world does not hold is a refused read,
// except where the operation says a missing one is `null` (an issue that does not exist). The shape of GitHub's own answers (a page that is not JSON, a comment-less reply) is the plugin's to test, not the fake's.
import type { ClosedRowPage, DeclaredRow, PullHeadRead, RowsClosing } from "../contracts/code-host-rows-closing.ts";
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { FakeRow, FakeRowsWorld } from "./code-host-rows.ts";

/** What a test seeds for this section beyond the world's rows and pull requests. */
export type FakeClosing = {
  /** The headers-and-body text the rate-limit read answers. */
  rateLimitDump: string;
  /** The merge commit of a pull request, by number; absent is a merge GitHub gave none for. */
  mergeShas: Map<number, string>;
  /** When a row was last reopened, by number; absent is a row never reopened. */
  reopenedAt: Map<number, string>;
  /** The epic above a row, by number; absent is a row with no parent. */
  parents: Map<number, number>;
  /** The base branch of a pull request, by number; absent is `main`. */
  baseRefNames: Map<number, string>;
  /** The files of other repositories, by `owner/name:path` (or `owner/name:path@ref` for a file at a commit), as the consumer-declaration check reads them. */
  consumerFiles: Map<string, string>;
  /** The pages of closed rows on the project, in the order they are read (or the error reading one throws); null derives one page from the world's closed rows that are on the board. */
  closedRowPages: (ClosedRowPage | Error)[] | null;
  /** How many pages were read so far, and the cursors they were asked from. */
  pagesRead: (string | null)[];
  /** The rows a close was refused for, by number, and the error each throws. */
  closeRefusals: Map<number, Error>;
  /** The sub-issue edges made, as `[parent, child]`. */
  subIssues: [number, number][];
};

export const emptyClosing = (): FakeClosing => ({ rateLimitDump: "HTTP/2.0 200 OK\nX-Ratelimit-Used: 7\nX-Ratelimit-Reset: 1700000000\n\n{}", mergeShas: new Map(), reopenedAt: new Map(), parents: new Map(),
  baseRefNames: new Map(), consumerFiles: new Map(), closedRowPages: null, pagesRead: [], closeRefusals: new Map(), subIssues: [] });

/** Whether `repo` names the world's own repository: by name, by `gh`'s own placeholder, or by naming none. */
const isHome = (world: FakeRowsWorld, repo: string | undefined): boolean => [undefined, "", "{owner}/{repo}", world.repo].includes(repo);

/** The row `repo#number`, in this repository's world or among the foreign rows; `null` when the world holds none. */
const findRow = (world: FakeRowsWorld, repo: string | undefined, number: number): FakeRow | null =>
  (isHome(world, repo) ? world.rows.get(number) : world.foreignRows.get(`${repo}#${number}`)) ?? null;

function rowIn(world: FakeRowsWorld, repo: string | undefined, number: number): FakeRow {
  const row = findRow(world, repo, number);
  if (row === null) throw new Error(`the fake holds no row ${repo ?? world.repo}#${number}`);
  return row;
}

const iso = (world: FakeRowsWorld): string => new Date(world.now()).toISOString();

const declaredOf = (world: FakeRowsWorld, row: FakeRow): DeclaredRow =>
  ({ number: row.number, state: row.state, labels: [...row.labels], reopenedAt: world.tail.closing.reopenedAt.get(row.number) ?? null });

const buildOf = (world: FakeRowsWorld, row: FakeRow) =>
  ({ number: row.number, title: row.title, body: row.body, labels: [...row.labels], milestone: row.milestone?.title ?? null, parent: world.tail.closing.parents.get(row.number) ?? null });

const pullOf = (world: FakeRowsWorld, number: number | string) => {
  const pull = world.pulls.get(Number(number));
  if (pull === undefined) throw new Error(`the fake holds no pull request #${number}`);
  return pull;
};

/** The rows a pull request resolves as closing, each as the world holds it (the row the pull request's `closes` entry names, else that entry's own labels, open). */
function closingRowsOf(world: FakeRowsWorld, number: number | string) {
  const pull = pullOf(world, number);
  return (pull.merged ? pull.closes ?? [] : []).map((entry) => {
    const held = findRow(world, entry.repo, entry.number);
    const row = held ?? { number: entry.number, title: entry.title ?? "", body: "", state: "OPEN" as const, labels: entry.labels, milestone: null } as unknown as FakeRow;
    return { entry, row };
  });
}

/** The world's next page of closed rows on the board: a seeded one in order, else every closed boarded row on one page. */
function closedPage(world: FakeRowsWorld, after: string | null): ClosedRowPage {
  const closing = world.tail.closing;
  closing.pagesRead.push(after);
  world.calls.push(`closedRowPageOf ${after ?? "(first)"}`);
  if (closing.closedRowPages === null) return { numbers: [...world.rows.values()].filter((row) => row.state === "CLOSED" && row.onBoard).map((row) => row.number), hasNextPage: false, endCursor: null };
  const page = closing.closedRowPages[closing.pagesRead.length - 1];
  if (page === undefined) throw new Error("the fake holds no further page of closed rows");
  if (page instanceof Error) throw page;
  return page;
}

function mergedPull(world: FakeRowsWorld, number: number | string) {
  const pull = pullOf(world, number);
  const closing = world.tail.closing;
  return { merged: pull.merged, baseRefName: closing.baseRefNames.get(pull.number) ?? pull.baseRefName ?? "main", mergedAt: pull.mergedAt, headRefName: pull.headRefName || null, body: pull.body,
    mergeSha: closing.mergeShas.get(pull.number) ?? null };
}

/** The writes: a close, a row filed, an edge made. */
function closingWrites(world: FakeRowsWorld): Pick<CodeHostRows, "closeCompletedRow" | "fileRowInMilestone" | "addBlockedByEdge" | "addSubIssueTo"> {
  return {
    closeCompletedRow: ({ repo, row, comment }) => {
      const refusal = world.tail.closing.closeRefusals.get(row);
      if (refusal !== undefined) throw refusal;
      const held = rowIn(world, repo, row);
      held.comments.push({ id: world.nextCommentId++, body: comment, createdAt: iso(world) });
      held.state = "CLOSED";
      held.closedAt = iso(world);
      world.calls.push(`closeCompletedRow #${row}`);
    },
    fileRowInMilestone: ({ repo, title, body, labels, milestone }) => {
      const number = world.nextNumber++;
      const row: FakeRow = { number, title, body, state: "OPEN", labels: [...labels], createdAt: iso(world), closedAt: null, comments: [], blockedBy: [], onBoard: false, boardStatus: null,
        milestone: milestone === null ? null : { number: 0, title: milestone, description: null, dueOn: null } };
      if (isHome(world, repo)) world.rows.set(number, row);
      else world.foreignRows.set(`${repo}#${number}`, row);
      return number;
    },
    addBlockedByEdge: ({ repo, row, blocker }) => {
      rowIn(world, repo, row).blockedBy.push(blocker);
    },
    addSubIssueTo: ({ repo, parent, child }) => {
      rowIn(world, repo, child);
      world.tail.closing.subIssues.push([parent, child]);
    },
  };
}

/** The reads of a row, of a merged pull request's closing references and of the claim checks. */
function closingReads(world: FakeRowsWorld): Omit<Pick<CodeHostRows, keyof RowsClosing>, keyof ReturnType<typeof closingWrites>> {
  return {
    rateLimitDumpOf: () => world.tail.closing.rateLimitDump,
    rowNumberStateAndLabelsOf: ({ repo, number }) => {
      const row = rowIn(world, repo, number);
      return { number: row.number, state: row.state, labels: [...row.labels] };
    },
    rowStateAndLabelsOf: ({ repo, number }) => {
      world.calls.push(`rowStateAndLabelsOf ${repo}#${number}`);
      const row = rowIn(world, repo, number);
      return { state: row.state, labels: [...row.labels] };
    },
    commentsOfRowIn: ({ repo, number }) => rowIn(world, repo, number).comments.map((comment) => ({ id: String(comment.id), body: comment.body, createdAt: comment.createdAt,
      author: comment.author === undefined ? null : { login: comment.author } })),
    declaredRowOf: ({ repo, number }) => {
      const row = findRow(world, repo, number);
      return row === null ? null : declaredOf(world, row);
    },
    declaredBuildRowOf: ({ repo, number }) => {
      const row = findRow(world, repo, number);
      return row === null ? null : { row: declaredOf(world, row), build: buildOf(world, row) };
    },
    buildRowOf: ({ repo, number }) => {
      const row = findRow(world, repo, number);
      return row === null ? null : buildOf(world, row);
    },
    mergedPullClosingOf: ({ number }) => ({ ...mergedPull(world, number), closing: closingRowsOf(world, number).map(({ entry, row }) => ({ ...declaredOf(world, row), repo: entry.repo ?? null })) }),
    closingRowsOfMergedPull: ({ number }) => {
      const { mergedAt, headRefName, body, mergeSha } = mergedPull(world, number);
      return { mergedAt, headRefName, body, mergeSha, rows: closingRowsOf(world, number).map(({ row }) => ({ ...declaredOf(world, row), build: buildOf(world, row) })) };
    },
    closedRowPageOf: ({ after }) => closedPage(world, after),
    claimedRowsWithComments: ({ repo, label, count, window }) => {
      const open = [...(isHome(world, repo) ? world.rows.values() : [...world.foreignRows].filter(([key]) => key.startsWith(`${repo}#`)).map(([, row]) => row))].filter((row) => row.state === "OPEN" && row.labels.includes(label));
      return { total: open.length, rows: open.slice(0, count).map((row) => ({ number: row.number, commentsTotal: row.comments.length,
        comments: row.comments.slice(-window).map((comment) => ({ id: String(comment.id), body: comment.body, createdAt: comment.createdAt, author: { login: comment.author } })) })) };
    },
    headBranchAndForkOf: ({ number }): PullHeadRead => {
      const pull = pullOf(world, number);
      if (pull.headRefName === "") throw new Error("the PR names no head branch");
      return { branch: pull.headRefName, fork: pull.isCrossRepository === true };
    },
    consumerFileTextOf: ({ repo, path, ref }) => {
      const text = world.tail.closing.consumerFiles.get(`${repo}:${path}${ref === undefined ? "" : `@${ref}`}`);
      if (text === undefined) throw new Error(`the fake holds no file ${repo}:${path}${ref === undefined ? "" : `@${ref}`}`);
      return text;
    },
    rowWithCommentsOf: ({ repo, number }) => {
      const row = findRow(world, repo, number);
      if (row === null) return null;
      return { state: row.state, labels: [...row.labels], body: row.body, comments: row.comments.map((comment) => ({ id: String(comment.id), url: `https://github.com/${repo}/issues/${number}#issuecomment-${comment.id}`,
        body: comment.body, createdAt: comment.createdAt })) };
    },
  };
}

export const closingOperations = (world: FakeRowsWorld): Pick<CodeHostRows, keyof RowsClosing> => ({ ...closingReads(world), ...closingWrites(world) });
