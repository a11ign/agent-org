// @ts-check
// module: the in-memory code host's operations for the board's reads and posts (A11-160, step 8)
//
// THEY ACT ON THE WORLD A TEST SEEDS (`FakeRowsWorld`) and ignore the `run` their caller hands them. The board's issues, comments and label history are the world's rows and `world.gate.events`; what it reads beyond them
// (milestones, the Discussions of the edition, draft releases, workflow runs, the Roadmap values, the pull requests of a repository other than the world's own) is `world.reports.board`, seeded as the facts they are.
// A repository or a document the world holds nothing for is a refused read, and a repository the code host REFUSES (a 502, a 403) is `board.refusals`; one state of a listing is refused by naming it in `world.failures`
// (`rowsListedIn closed`, `pullsListedIn merged`). The posts (`commentOnIssue`) are the rows' own operation (`code-host-rows.ts`): a comment on the row of the world.
import type { CodeHostRows } from "../contracts/code-host-rows.ts";
import type { FakeRow, FakeRowPull, FakeRowsWorld } from "./code-host-rows.ts";

/** A Discussion of the edition's category; `categoryId` is the category a created one was filed in. */
export type FakeDiscussion = { id: string; title: string; url: string; body: string; categoryId?: string };

/** A release as the board's draft delivery reads it: whether it is a draft, and the files attached to it. */
export type FakeRelease = { isDraft: boolean; assets: string[] };

/** What the board reads of the world beyond its rows and the label history. */
export type FakeBoard = {
  /** The milestones by repository, as REST states them. */
  milestones: Map<string, any[]>;
  /** The Discussions of a repository: its id, its categories and the editions in the edition category, newest first. A repository with no entry has no Discussions: a refused read. */
  discussions: Map<string, { repositoryId: string; categories: { id: string; slug: string }[]; editions: FakeDiscussion[] }>;
  /** The releases by `repo@tag`. */
  releases: Map<string, FakeRelease>;
  /** The runs of a workflow by `repo@workflow`, newest first, as `gh run list --json` states them; and when a workflow was registered. */
  workflowRuns: Map<string, any[]>;
  workflowCreated: Map<string, string | null>;
  /**
   * The `Roadmap` of each row's project items, and the row's parent, by number. A row that holds an entry here is among those the code host can answer for, whether or not the world holds it as a row (a parent in another
   * repository is only an entry); a row the world holds with no entry is boarded nowhere and under no epic; `repo` is the repository an entry lives in where it is not the world's own. Only the first twenty items are answered, with the count of them all, as the code host asks for twenty.
   */
  roadmaps: Map<number, { items: { owner: string; project: number; value: string | null }[]; parent: number | null; repo?: string }>;
  /** The pull requests of a repository other than the world's own (the world's are `world.pulls`), by repository. */
  pullsByRepo: Map<string, FakeRowPull[]>;
  /** A repository the code host refuses every read of (a 502, a 403): the error it throws, by repository. A read of one that is not named here answers what the world holds. */
  refusals: Map<string, Error>;
};

export const emptyBoard = (): FakeBoard => ({ milestones: new Map(), discussions: new Map(), releases: new Map(), workflowRuns: new Map(), workflowCreated: new Map(),
  roadmaps: new Map(), pullsByRepo: new Map(), refusals: new Map() });

const isHome = (world: FakeRowsWorld, repo: string): boolean => ["", "{owner}/{repo}", world.repo].includes(repo);

function rowsOf(world: FakeRowsWorld, repo: string): FakeRow[] {
  if (isHome(world, repo)) return [...world.rows.values()];
  return [...world.foreignRows].filter(([key]) => key.startsWith(`${repo}#`)).map(([, row]) => row);
}

const seeded = <T>(held: T | undefined, what: string): T => {
  if (held === undefined) throw new Error(`the fake holds no ${what}`);
  return held;
};

const updatedOf = (row: FakeRow): string => row.updatedAt ?? row.closedAt ?? row.createdAt;

/** A row as `gh issue list --json` states it, for the fields a caller names. */
function listed(world: FakeRowsWorld, row: FakeRow, fields: string): Record<string, unknown> {
  const all: Record<string, unknown> = {
    number: row.number, title: row.title, body: row.body, state: row.state, createdAt: row.createdAt, closedAt: row.closedAt, labels: row.labels.map((name) => ({ name })),
    comments: row.comments.map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, author: { login: c.author ?? "" }, url: `https://github.com/${world.repo}/issues/${row.number}#issuecomment-${c.id}` })),
    blockedBy: { totalCount: row.blockedBy.length, nodes: row.blockedBy.map((number) => ({ number, state: world.rows.get(number)?.state ?? "OPEN" })) }, stateReason: world.misc.stateReasons.get(row.number) ?? null, url: `https://github.com/${world.repo}/issues/${row.number}`,
    subIssuesSummary: { total: 0, completed: 0, percentCompleted: 0 },
  };
  return Object.fromEntries(fields.split(",").filter((field) => field in all).map((field) => [field, all[field]]));
}

/** A row as the board's issues page states it (GraphQL: labels and milestone as nodes). */
const issueNode = (world: FakeRowsWorld, repo: string, row: FakeRow): Record<string, unknown> => ({
  number: row.number, title: row.title, state: row.state, createdAt: row.createdAt, closedAt: row.closedAt, url: `https://github.com/${repo}/issues/${row.number}`,
  labels: { totalCount: row.labels.length, nodes: row.labels.map((name) => ({ name })) }, milestone: row.milestone ?? null,
});

const PAGE = 100;
/** How many project items of a row the code host asks for. */
const ROADMAP_ITEMS_ASKED = 20;

/** The Roadmap node of a row and, nested, its parents'. */
function roadmapNode(world: FakeRowsWorld, number: number): Record<string, unknown> {
  const held = world.reports.board.roadmaps.get(number) ?? { items: [], parent: null };
  const asked = held.items.slice(0, ROADMAP_ITEMS_ASKED);
  return { number, repository: { nameWithOwner: ("repo" in held ? held.repo : undefined) ?? world.repo },
    projectItems: { totalCount: held.items.length, nodes: asked.map((item) => ({ project: { number: item.project, owner: { login: item.owner } }, value: item.value === null ? null : { name: item.value } })) },
    parent: held.parent === null ? null : roadmapNode(world, held.parent) };
}

type Operations = Pick<CodeHostRows, "issuePageOf" | "allMilestonesOf" | "discussionCategoriesOf" | "discussionEditionsOf" | "createDiscussion" | "updateDiscussion" | "draftReleaseOf" | "createDraftRelease" | "uploadReleaseAsset"
  | "rowsListedIn" | "pullsListedIn" | "windowRowsTextOf" | "editionCommentCountOf" | "commentBodiesOfIssue" | "workflowRunListOf" | "workflowCreatedAtOf" | "roadmapFactsOf"
  | "commentAuthorOf" | "headedCommentIdsText" | "orgCommentsSinceOf" | "issuesSinceOf" | "labeledEventsOfRow">;

/** A read aimed at `repo` is refused when the world says that repository refuses, and a read of one state of a listing is refused when `world.failures` names it (`rowsListedIn closed`, `pullsListedIn merged`). */
const reachOf = (world: FakeRowsWorld) => (repo: string, operation?: string): void => {
  const refusal = world.reports.board.refusals.get(repo);
  if (refusal !== undefined) throw refusal;
  const failure = operation === undefined ? undefined : world.failures.get(operation);
  if (failure !== undefined) throw failure;
};

const commentsOfRow = (world: FakeRowsWorld, repo: string, number: string | number) => {
  const row = rowsOf(world, repo).find((held) => held.number === Number(number));
  if (row === undefined) throw new Error(`the fake holds no row ${repo}#${number}`);
  return row.comments;
};

/** The milestones, the editions as Discussions, the draft releases and the schedule's runs. */
function publishingOperations(world: FakeRowsWorld): Pick<Operations, "allMilestonesOf" | "discussionCategoriesOf" | "discussionEditionsOf" | "createDiscussion" | "updateDiscussion" | "draftReleaseOf" | "createDraftRelease" | "uploadReleaseAsset" | "workflowRunListOf" | "workflowCreatedAtOf"> {
  const board = world.reports.board;
  const reach = reachOf(world);
  const discussionsOf = (owner: string, name: string) => seeded(board.discussions.get(`${owner}/${name}`), `Discussions of ${owner}/${name}`);
  return {
    allMilestonesOf: ({ repo }) => reach(repo) ?? structuredClone(seeded(board.milestones.get(repo), `milestones of ${repo}`)),
    discussionCategoriesOf: ({ owner, name }) => {
      const held = discussionsOf(owner, name);
      return { repository: { id: held.repositoryId, discussionCategories: { nodes: held.categories.map((c) => ({ ...c })) } } };
    },
    discussionEditionsOf: ({ owner, name }) => ({ repository: { discussions: { nodes: discussionsOf(owner, name).editions.map(({ id, title, url }) => ({ id, title, url })) } } }),
    createDiscussion: ({ repositoryId, categoryId, title, body }) => {
      const held = [...board.discussions.values()].find((entry) => entry.repositoryId === repositoryId);
      if (held === undefined) throw new Error(`the fake holds no repository ${repositoryId}`);
      const id = `D_fake_${held.editions.length + 1}`;
      const url = `https://github.com/fake/discussions/${held.editions.length + 1}`;
      held.editions.unshift({ id, title, url, body, categoryId });
      return { createDiscussion: { discussion: { url } } };
    },
    updateDiscussion: ({ discussionId, body }) => {
      const edition = [...board.discussions.values()].flatMap((entry) => entry.editions).find((held) => held.id === discussionId);
      if (edition === undefined) throw new Error(`the fake holds no Discussion ${discussionId}`);
      edition.body = body;
      return { updateDiscussion: { discussion: { url: edition.url } } };
    },
    draftReleaseOf: ({ repo, tag }) => {
      const held = board.releases.get(`${repo}@${tag}`);
      return held === undefined ? null : { isDraft: held.isDraft };
    },
    createDraftRelease: ({ repo, tag, file }) => {
      board.releases.set(`${repo}@${tag}`, { isDraft: true, assets: [file] });
    },
    uploadReleaseAsset: ({ repo, tag, file }) => {
      const held = seeded(board.releases.get(`${repo}@${tag}`), `release ${repo}@${tag}`);
      held.assets = [...held.assets.filter((asset) => asset !== file), file];
    },
    workflowRunListOf: ({ repo, workflow, fields, limit }) => seeded(board.workflowRuns.get(`${repo}@${workflow}`), `runs of ${repo}@${workflow}`).slice(0, limit)
      .map((run) => Object.fromEntries(fields.split(",").filter((field) => field in run).map((field) => [field, run[field]]))),
    workflowCreatedAtOf: ({ repo, workflow }) => seeded(board.workflowCreated.get(`${repo}@${workflow}`), `workflow ${repo}@${workflow}`),
  };
}

/** The rows and pull requests listed, the issues paged, the window of rows touched, the editions posted, and the truth audit's reads. */
function readingOperations(world: FakeRowsWorld): Pick<Operations, "issuePageOf" | "rowsListedIn" | "pullsListedIn" | "windowRowsTextOf" | "editionCommentCountOf" | "commentBodiesOfIssue" | "roadmapFactsOf" | "commentAuthorOf"
  | "headedCommentIdsText" | "orgCommentsSinceOf" | "issuesSinceOf" | "labeledEventsOfRow"> {
  const board = world.reports.board;
  const reach = reachOf(world);
  const pullsOf = (repo: string): FakeRowPull[] => (isHome(world, repo) ? [...world.pulls.values()] : board.pullsByRepo.get(repo) ?? []);
  return {
    issuePageOf: ({ repo, after }) => {
      reach(repo);
      const rows = rowsOf(world, repo).sort((a, b) => a.number - b.number);
      const from = after === null ? 0 : Number(after);
      const nodes = rows.slice(from, from + PAGE).map((row) => issueNode(world, repo, row));
      const next = from + PAGE;
      return { data: { repository: { issues: { totalCount: rows.length, pageInfo: { hasNextPage: next < rows.length, endCursor: next < rows.length ? String(next) : null }, nodes } } } };
    },
    rowsListedIn: ({ repo, state, limit, fields }) => {
      reach(repo, `rowsListedIn ${state}`);
      return rowsOf(world, repo).filter((row) => row.state === state.toUpperCase()).sort((a, b) => b.number - a.number).slice(0, limit).map((row) => listed(world, row, fields));
    },
    pullsListedIn: ({ repo, state, limit, fields }) => {
      reach(repo, `pullsListedIn ${state}`);
      return pullsOf(repo).filter((pull) => (state === "merged" ? pull.merged : !pull.merged && pull.closedAt == null)).sort((a, b) => b.number - a.number).slice(0, limit)
        .map((pull) => Object.fromEntries(fields.split(",").map((field) => [field, ({ number: pull.number, title: pull.title, body: pull.body, mergedAt: pull.mergedAt, headRefName: pull.headRefName, labels: pull.labels.map((name) => ({ name })) } as Record<string, unknown>)[field]]).filter(([, value]) => value !== undefined)));
    },
    windowRowsTextOf: ({ repo, since }) => reach(repo) ?? rowsOf(world, repo).filter((row) => Date.parse(updatedOf(row)) >= Date.parse(since))
      .map((row) => `${JSON.stringify({ number: row.number, state: row.state, createdAt: row.createdAt, closedAt: row.closedAt, labels: row.labels.map((name) => ({ name })) })}\n`).join(""),
    editionCommentCountOf: ({ repo, issue, since, title }) => commentsOfRow(world, repo, issue).filter((c) => c.body.startsWith(title) && Date.parse(c.createdAt) >= Date.parse(since)).length,
    commentBodiesOfIssue: ({ repo, number }) => commentsOfRow(world, repo, number).map((c) => c.body),
    roadmapFactsOf: ({ repo, numbers }) => {
      reach(repo);
      const known = new Set(rowsOf(world, repo).map((row) => row.number));
      return Object.fromEntries(numbers.filter((number) => known.has(number) || board.roadmaps.has(number)).map((number) => [`r${number}`, roadmapNode(world, number)]));
    },
    commentAuthorOf: ({ id }) => {
      const found = [...world.rows.values()].flatMap((row) => row.comments).find((comment) => String(comment.id) === id);
      if (found === undefined) throw new Error(`the fake holds no comment ${id}`);
      return found.author ?? "";
    },
    headedCommentIdsText: ({ repo, row, since, heading }) => commentsOfRow(world, repo, row).filter((c) => c.body.startsWith(heading) && Date.parse(c.createdAt) >= Date.parse(since)).map((c) => `${c.id}\n`).join(""),
    orgCommentsSinceOf: ({ repo, since, loginPrefix }) => reach(repo) ?? rowsOf(world, repo).flatMap((row) => row.comments.filter((c) => (c.author ?? "").startsWith(loginPrefix) && Date.parse(c.createdAt) >= Date.parse(since))
      .map((c) => ({ number: row.number, author: { login: c.author }, body: c.body, createdAt: c.createdAt, url: `https://github.com/${repo}/issues/${row.number}#issuecomment-${c.id}` }))),
    issuesSinceOf: ({ repo, since }) => reach(repo) ?? rowsOf(world, repo).filter((row) => Date.parse(updatedOf(row)) >= Date.parse(since))
      .map((row) => ({ number: row.number, state: row.state.toLowerCase(), author: row.openedBy ?? "", createdAt: row.createdAt, text: `${row.title}\n${row.body}` })),
    labeledEventsOfRow: ({ number }) => {
      const events = world.gate.events.get(number) ?? [];
      if (events instanceof Error) throw events;
      return events.filter((event) => event.event === "labeled").map((event) => ({ number, label: event.label, actor: event.actor, createdAt: event.at }));
    },
  };
}

export const boardOperations = (world: FakeRowsWorld): Operations => ({ ...publishingOperations(world), ...readingOperations(world) });
