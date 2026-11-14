// @ts-check
// module: an in-memory GitHub repository that answers the REST calls the GitHub Issues plugin makes (A11-447) -- for its tests; nothing reaches GitHub
//
// It answers each path the plugin calls with the fields the plugin reads, applies the writes, and REFUSES any other call by name (a 501), so a test that drifts from what the plugin
// asks fails loudly. Every request is recorded, so a test can say what was asked.

export type FakeComment = { id: number; body: string; created_at: string; user: { login: string; type: string } };
export type FakeIssue = {
  id: number; number: number; title: string; body: string; state: "open" | "closed"; state_reason: string | null; labels: string[]; assignee: string | null; milestone: number | null;
  parent: number | null; comments: FakeComment[]; blockedBy: number[]; events: { event: string; commit_id: string | null; actor: { type: string } }[]; pullRequest?: boolean;
  crossReferences: { html_url: string; title: string; state: string; merged_at: string | null }[];
};
type Milestone = { number: number; title: string; description: string | null };
type Answer = { status: number; body?: unknown };

const OWNER = "acme";
const REPO = "tracker";
const BASE = `/repos/${OWNER}/${REPO}`;
const VIEWER = "dan";

/** An issue of the fake repository, numbered `number`, open and unlabeled, with `over` replacing any field. */
export function fakeIssue(number: number, over: Partial<FakeIssue> = {}): FakeIssue {
  return {
    id: 1000 + number, number, title: `Title ${number}`, body: `About ${number}`, state: "open", state_reason: null, labels: [], assignee: VIEWER, milestone: null,
    parent: null, comments: [], blockedBy: [], events: [], crossReferences: [], ...over,
  };
}

/** The fake repository's settings, as a host's tracker block names it. */
export const FAKE_REPO = `${OWNER}/${REPO}`;

/** The fake repository's state, and how it answers an issue in GitHub's shape. */
type World = Readonly<{ held: Map<number, FakeIssue>; milestones: readonly Milestone[]; json: (issue: FakeIssue) => Record<string, unknown>; tick: () => string; nextCommentId: () => number }>;
type FakeRequest = Readonly<{ method: string; body: Record<string, unknown>; query: URLSearchParams }>;

/** One page of `items`, as `per_page` and `page` ask. */
function paged<T>(items: T[], query: URLSearchParams): T[] {
  const size = Number(query.get("per_page") ?? 30);
  const page = Number(query.get("page") ?? 1);
  return items.slice((page - 1) * size, page * size);
}

const listIssues = ({ held }: World, query: URLSearchParams) => [...held.values()].filter((issue) => (query.get("state") !== "open" || issue.state === "open")
  && (query.get("assignee") === null || issue.assignee === query.get("assignee")) && (query.get("milestone") === null || String(issue.milestone) === query.get("milestone")));

function answerIssue(world: World, issue: FakeIssue, rest: string, { method, body, query }: FakeRequest): Answer {
  const { held, json } = world;
  if (rest === "" && method === "GET") return { status: 200, body: json(issue) };
  if (rest === "" && method === "PATCH") {
    if (typeof body.title === "string") issue.title = body.title;
    if (typeof body.body === "string") issue.body = body.body;
    if (body.state === "closed" || body.state === "open") {
      Object.assign(issue, { state: body.state, state_reason: body.state === "open" ? "reopened" : body.state_reason ?? "completed" });
      issue.events.push({ event: body.state === "open" ? "reopened" : "closed", commit_id: null, actor: { type: "User" } });
    }
    return { status: 200, body: json(issue) };
  }
  if (rest === "/comments" && method === "GET") return { status: 200, body: paged(issue.comments, query) };
  if (rest === "/comments" && method === "POST") {
    const comment = { id: world.nextCommentId(), body: String(body.body), created_at: world.tick(), user: { login: VIEWER, type: "User" } };
    issue.comments.push(comment);
    return { status: 201, body: comment };
  }
  if (rest === "/labels" && method === "POST") {
    issue.labels.push(...(body.labels as string[]).filter((label) => !issue.labels.includes(label)));
    return { status: 200, body: issue.labels.map((name) => ({ name })) };
  }
  if (rest.startsWith("/labels/") && method === "DELETE") {
    const name = decodeURIComponent(rest.slice("/labels/".length));
    if (!issue.labels.includes(name)) return { status: 404 };
    issue.labels = issue.labels.filter((label) => label !== name);
    return { status: 200, body: [] };
  }
  if (rest === "/sub_issues" && method === "GET") return { status: 200, body: paged([...held.values()].filter((child) => child.parent === issue.number).map(json), query) };
  if (rest === "/dependencies/blocked_by" && method === "GET") return { status: 200, body: paged(issue.blockedBy.map((number) => json(held.get(number)!)), query) };
  if (rest === "/dependencies/blocked_by" && method === "POST") {
    const blocker = [...held.values()].find(({ id }) => id === body.issue_id);
    if (blocker === undefined) return { status: 404 };
    if (issue.blockedBy.includes(blocker.number)) return { status: 422 };
    issue.blockedBy.push(blocker.number);
    return { status: 201, body: json(blocker) };
  }
  if (rest === "/timeline" && method === "GET") return { status: 200, body: paged(issue.crossReferences.map((pull) => ({ event: "cross-referenced", source: { issue: { ...pull, pull_request: { merged_at: pull.merged_at } } } })), query) };
  if (rest === "/events" && method === "GET") return { status: 200, body: paged(issue.events, query) };
  return { status: 501, body: { message: `the fake does not answer ${method} ${BASE}/issues/${issue.number}${rest}` } };
}

function answer(world: World, url: URL, request: FakeRequest): Answer {
  const { held, milestones, json } = world;
  const { method } = request;
  const path = url.pathname;
  if (path === "/user" && method === "GET") return { status: 200, body: { login: VIEWER } };
  if (path === "/search/issues" && method === "GET") {
    const words = (url.searchParams.get("q") ?? "").split(" ").filter((word) => !word.includes(":")).join(" ").toLowerCase();
    return { status: 200, body: { items: [...held.values()].filter((issue) => issue.state === "open" && issue.title.toLowerCase().includes(words)).map(json) } };
  }
  if (path === `${BASE}/milestones` && method === "GET") return { status: 200, body: paged([...milestones], url.searchParams) };
  if (path === `${BASE}/issues` && method === "GET") return { status: 200, body: paged(listIssues(world, url.searchParams).map(json), url.searchParams) };
  const comment = new RegExp(`^${BASE}/issues/comments/(\\d+)$`).exec(path);
  if (comment !== null && method === "DELETE") {
    const id = Number(comment[1]);
    const owner = [...held.values()].find((issue) => issue.comments.some((entry) => entry.id === id));
    if (owner === undefined) return { status: 404 };
    owner.comments = owner.comments.filter((entry) => entry.id !== id);
    return { status: 204 };
  }
  const issuePath = new RegExp(`^${BASE}/issues/(\\d+)(/.*)?$`).exec(path);
  const issue = issuePath === null ? undefined : held.get(Number(issuePath[1]));
  if (issuePath !== null && issue === undefined) return { status: 404, body: { message: "Not Found" } };
  if (issue !== undefined) return answerIssue(world, issue, issuePath![2] ?? "", request);
  return { status: 501, body: { message: `the fake does not answer ${method} ${path}` } };
}

/** A fake GitHub holding `issues` and `milestones`: its `fetch`, the requests it was sent, and its state. */
export function fakeGitHub(issues: readonly FakeIssue[], milestones: readonly Milestone[] = []) {
  const held = new Map(issues.map((issue) => [issue.number, issue]));
  const requests: { method: string; path: string; body: unknown }[] = [];
  let clock = 0;
  let commentIds = 0;
  const tick = () => new Date(Date.UTC(2026, 10, 13, 12, 0, (clock += 1))).toISOString();
  const json = (issue: FakeIssue) => {
    const children = [...held.values()].filter((child) => child.parent === issue.number);
    const milestone = milestones.find(({ number }) => number === issue.milestone) ?? null;
    return {
      id: issue.id, number: issue.number, title: issue.title, body: issue.body, updated_at: tick(), html_url: `https://github.com/${OWNER}/${REPO}/issues/${issue.number}`,
      repository_url: `https://api.github.com${BASE}`, state: issue.state, state_reason: issue.state_reason, labels: issue.labels.map((name) => ({ name })),
      assignee: issue.assignee === null ? null : { id: 7, login: issue.assignee }, milestone,
      parent_issue_url: issue.parent === null ? null : `https://api.github.com${BASE}/issues/${issue.parent}`,
      sub_issues_summary: { total: children.length, completed: children.filter((child) => child.state === "closed").length },
      ...(issue.pullRequest === true ? { pull_request: {} } : {}),
    };
  };
  const world: World = { held, milestones, json, tick, nextCommentId: () => (commentIds += 1) };
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = init.body === undefined || init.body === null ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push({ method, path: `${url.pathname}${url.search}`, body });
    if (url.origin !== "https://api.github.com") return new Response(JSON.stringify({ message: `not GitHub's API: ${url.origin}` }), { status: 501 });
    const answered = answer(world, url, { method, body, query: url.searchParams });
    return new Response(answered.body === undefined ? null : JSON.stringify(answered.body), { status: answered.status });
  }) as typeof globalThis.fetch;
  return { fetch, requests, held };
}
