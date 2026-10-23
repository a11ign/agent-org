// @ts-check
// module: the in-memory code host's operations for the chairman's watch and answers (A11-160, step 8)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. A row is the world's row (its labels, state, comments and the author association of each), a pull request the world's pull
// request. What the readers of the watch read beyond them is `world.reports.messaging`: the runs and the latest releases, the review decisions and (for a document no fact explains) a REST document by exact path, seeded as
// the facts they are. The REST reads are MODELED over the world: the issues endpoint lists the rows AND the pull requests (a pull request carries `pull_request`), pages them and filters them by state and label; the pulls
// endpoint lists by state and base; a comment, a row's comments, a row, a pull request, a run and the latest release are documents of what the world holds. What the world holds none of is GitHub's 404, and an operation the
// world names in `failures` throws that error (applied by `createFakeRows`, to every operation).
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { FakeRow, FakeRowPull, FakeRowsWorld } from "./code-host-rows.ts";

/** What the chairman's watch and answers read beyond the world's rows and pull requests. */
export type FakeMessaging = {
  /** The REST documents by exact path, query string included (`repos/o/n/issues/7/comments?per_page=100&page=2`): what `restGetAsync` answers for a path, FIRST, before the world's own rows, pull requests, runs and releases. */
  rest: Map<string, unknown>;
  /** The workflow runs by id, as `repos/o/n/actions/runs/<id>` reads them: a run still going has a null conclusion. A run the world holds none of is a 404. */
  runs: Map<number, { status: string; conclusion: string | null }>;
  /** The newest PUBLISHED release of a repository (`owner/name`) by its tag, as `repos/o/n/releases/latest` reads it. A repository with none is a 404. */
  latestReleases: Map<string, string>;
  /** The review decision of a pull request by number (`""` where the base requires none), as `pullReviewDecisionAsync` reads it. */
  reviewDecisions: Map<number, string | null>;
  /** The association GitHub gives the commenter of a comment an operation posts. */
  commenterAssociation: string;
};

export const emptyMessaging = (): FakeMessaging => ({ rest: new Map(), runs: new Map(), latestReleases: new Map(), reviewDecisions: new Map(), commenterAssociation: "MEMBER" });

/** Whether `repo` names the world's own repository. */
const isHome = (world: FakeRowsWorld, repo: string): boolean => ["", "{owner}/{repo}", world.repo].includes(repo);

/** The row `repo#number` of the world, or a foreign row it holds. */
function rowIn(world: FakeRowsWorld, repo: string, number: number): FakeRow {
  const row = isHome(world, repo) ? world.rows.get(number) : world.foreignRows.get(`${repo}#${number}`);
  if (row === undefined) throw new Error(`the fake holds no row ${repo}#${number}`);
  return row;
}

const iso = (world: FakeRowsWorld): string => new Date(world.now()).toISOString();

/** What GitHub answers for a document it does not hold. */
const notFound = (path: string): Error => Object.assign(new Error(`gh: Not Found (HTTP 404): the fake holds no document at ${path}`), { status: 1, stderr: "gh: Not Found (HTTP 404)" });

const stateOfPull = (pull: FakeRowPull): "open" | "closed" => (pull.merged || pull.closedAt != null ? "closed" : "open");

/** The page `params` ask of `items`, as the REST listings page: `per_page` (30 when absent) and `page` (1 when absent). */
function pageOf<T>(items: T[], params: URLSearchParams): T[] {
  const perPage = Number(params.get("per_page") ?? 30);
  const page = Number(params.get("page") ?? 1);
  return items.slice((page - 1) * perPage, page * perPage);
}

/** `repos/o/n/issues?...`: the repository's rows AND its pull requests, as the issues endpoint lists both (a pull request carries `pull_request`), newest number first, filtered by `state` (open when absent) and `labels`. */
function issuesListing(world: FakeRowsWorld, params: URLSearchParams): unknown[] {
  const state = params.get("state") ?? "open";
  const wanted = (params.get("labels") ?? "").split(",").filter((name) => name !== "");
  const listed = [
    ...[...world.rows.values()].map((row) => ({ number: row.number, title: row.title, state: row.state.toLowerCase(), labels: row.labels, created_at: row.createdAt, updated_at: row.updatedAt ?? row.createdAt, pull: false })),
    ...[...world.pulls.values()].map((pull) => ({ number: pull.number, title: pull.title ?? `Pull ${pull.number}`, state: stateOfPull(pull), labels: pull.labels, created_at: pull.createdAt, updated_at: pull.mergedAt ?? pull.closedAt ?? pull.createdAt, pull: true })),
  ].filter((item) => (state === "all" || item.state === state) && wanted.every((name) => item.labels.includes(name))).sort((a, b) => b.number - a.number);
  return pageOf(listed, params).map(({ labels, pull, ...item }) => ({ ...item, labels: labels.map((name) => ({ name })), ...(pull ? { pull_request: {} } : {}) }));
}

/** `repos/o/n/pulls?...`: the repository's pull requests of a `state` (open when absent) against a `base` (any when absent), the most recently updated first. */
function pullsListing(world: FakeRowsWorld, params: URLSearchParams): unknown[] {
  const state = params.get("state") ?? "open";
  const base = params.get("base");
  const updatedAt = (pull: FakeRowPull): string => pull.mergedAt ?? pull.closedAt ?? pull.createdAt;
  const listed = [...world.pulls.values()].filter((pull) => (state === "all" || stateOfPull(pull) === state) && (base === null || (pull.baseRefName ?? "main") === base))
    .sort((a, b) => Date.parse(updatedAt(b)) - Date.parse(updatedAt(a)));
  return pageOf(listed, params).map((pull) => ({ number: pull.number, state: stateOfPull(pull), merged_at: pull.mergedAt, updated_at: updatedAt(pull), base: { ref: pull.baseRefName ?? "main" }, labels: pull.labels.map((name) => ({ name })) }));
}

/** The rows of a repository the world holds (the home repository's, or a foreign row's). */
function rowsOf(world: FakeRowsWorld, repo: string): FakeRow[] {
  return isHome(world, repo) ? [...world.rows.values()] : [...world.foreignRows.entries()].filter(([key]) => key.startsWith(`${repo}#`)).map(([, row]) => row);
}

/** One comment the way the comments endpoint gives it. */
const commentDocument = (repo: string, row: FakeRow, comment: FakeRow["comments"][number]) => ({ id: comment.id, body: comment.body, created_at: comment.createdAt, author_association: comment.association ?? "NONE",
  user: { login: comment.author ?? "" }, html_url: `https://github.com/${repo}/issues/${row.number}#issuecomment-${comment.id}` });

/**
 * The REST document the world gives for `path`: what a test seeded for that exact path (query string included) first; else a LISTING of the rows and pull requests (`issues?...`, `pulls?...`), a comment, a row's comments,
 * a row, a pull request, a run or the latest release the world holds. What it holds none of is GitHub's 404.
 */
function restDocumentOf(world: FakeRowsWorld, path: string): unknown {
  if (world.reports.messaging.rest.has(path)) return world.reports.messaging.rest.get(path);
  const [route, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  let match: RegExpExecArray | null;
  if ((match = /^repos\/([^/]+\/[^/]+)\/issues$/.exec(route)) !== null && isHome(world, match[1])) return issuesListing(world, params);
  if ((match = /^repos\/([^/]+\/[^/]+)\/pulls$/.exec(route)) !== null && isHome(world, match[1])) return pullsListing(world, params);
  if ((match = /^repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/.exec(route)) !== null) {
    for (const row of rowsOf(world, match[1])) {
      const comment = row.comments.find((held) => held.id === Number(match![2]));
      if (comment !== undefined) return commentDocument(match[1], row, comment);
    }
    throw notFound(path);
  }
  if ((match = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(route)) !== null) {
    const row = isHome(world, match[1]) ? world.rows.get(Number(match[2])) : world.foreignRows.get(`${match[1]}#${match[2]}`);
    if (row === undefined) throw notFound(path);
    return pageOf(row.comments, params).map((comment) => commentDocument(match![1], row, comment));
  }
  if ((match = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(route)) !== null) {
    const row = isHome(world, match[1]) ? world.rows.get(Number(match[2])) : world.foreignRows.get(`${match[1]}#${match[2]}`);
    if (row !== undefined) return { number: row.number, state: row.state.toLowerCase(), labels: row.labels.map((name) => ({ name })) };
    const pull = isHome(world, match[1]) ? world.pulls.get(Number(match[2])) : undefined;
    if (pull !== undefined) return { number: pull.number, state: stateOfPull(pull), labels: pull.labels.map((name) => ({ name })), pull_request: {} };
  }
  if ((match = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(route)) !== null && isHome(world, match[1]) && world.pulls.has(Number(match[2]))) {
    const held = world.pulls.get(Number(match[2]))!;
    return { number: held.number, state: stateOfPull(held), merged_at: held.mergedAt };
  }
  if ((match = /^repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)$/.exec(route)) !== null && world.reports.messaging.runs.has(Number(match[2]))) {
    return { id: Number(match[2]), ...world.reports.messaging.runs.get(Number(match[2])) };
  }
  if ((match = /^repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(route)) !== null && world.reports.messaging.latestReleases.has(match[1])) {
    return { tag_name: world.reports.messaging.latestReleases.get(match[1]), draft: false, prerelease: false };
  }
  throw notFound(path);
}

type Operations = Pick<CodeHostRows, "readRowAsync" | "commentOnRowAsync" | "removeLabelAsync" | "addLabelAsync" | "issueCommentsAsync" | "openPullChecksAsync" | "restGetAsync" | "pullReviewDecisionAsync">;

export function messagingOperations(world: FakeRowsWorld): Operations {
  const comment = (repo: string, number: number, body: string): void => {
    rowIn(world, repo, number).comments.push({ id: world.nextCommentId++, body, createdAt: iso(world), association: world.reports.messaging.commenterAssociation });
  };
  const operations: Operations = {
    readRowAsync: async ({ repo, number }) => {
      const row = rowIn(world, repo, number);
      return { state: row.state.toLowerCase(), labels: [...row.labels], comments: row.comments.map((c) => ({ body: c.body, createdAt: c.createdAt, authorAssociation: c.association ?? "NONE" })) };
    },
    commentOnRowAsync: async ({ repo, number, body }) => comment(repo, number, body),
    removeLabelAsync: async ({ repo, number, label }) => {
      const row = rowIn(world, repo, number);
      row.labels = row.labels.filter((existing) => existing !== label);
    },
    addLabelAsync: async ({ repo, number, label }) => {
      const row = rowIn(world, repo, number);
      if (!row.labels.includes(label)) row.labels.push(label);
    },
    issueCommentsAsync: async ({ repo, number }) => rowIn(world, repo, number).comments.map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, authorAssociation: c.association ?? "NONE", author: { login: c.author ?? "" } })),
    openPullChecksAsync: async ({ limit }) => [...world.pulls.values()].filter((pull) => !pull.merged && pull.closedAt == null).slice(0, limit)
      .map((pull) => ({ number: pull.number, labels: pull.labels.map((name) => ({ name })), ...(pull.rollup === undefined ? {} : { statusCheckRollup: pull.rollup }) })),
    restGetAsync: async ({ path }) => structuredClone(restDocumentOf(world, path)),
    pullReviewDecisionAsync: async ({ number }) => {
      if (!world.pulls.has(number)) throw new Error(`the fake holds no pull request #${number}`);
      return world.reports.messaging.reviewDecisions.get(number) ?? world.pulls.get(number)!.reviewDecision ?? null;
    },
  };
  // A refused read or write is the world's `failures` (`world.failures.set("restGetAsync", new Error("HTTP 502"))`), which `createFakeRows` applies to every operation by its name.
  return operations;
}

/** An open pull request with nothing on it, against `main`, created at `2026-10-01T00:00:00Z`; `over` sets what a test is about (a merge: `merged: true, mergedAt`; the checks: `rollup`; a review: `reviewDecision`). */
export const fakeRowPull = (number: number, over: Partial<FakeRowPull> = {}): FakeRowPull => ({ number, body: "", headRefName: `agent/pull-${number}`, labels: [], isDraft: false, armed: false, merged: false, mergedAt: null,
  createdAt: "2026-10-01T00:00:00Z", comments: [], ...over });
