// @ts-check
// module: the GitHub Issues plugin's reads -- an issue as a ticket, its sub-issues, its comments, the plans kept in them, and the pull requests that cross-reference it (A11-447)
//
// GITHUB'S ISSUE LIST ALSO LISTS PULL REQUESTS. Every read here leaves an item with `pull_request` out, so a pull request is never taken for a ticket and its number reads as no ticket.
// A PLAN IS A COMMENT. GitHub Issues has no attachments its API can write, so a plan file is kept as a comment whose first line names the file (`attachmentBody`), and its uploads are those names.
import type { PullState, Ticket } from "../../src/plugins/contracts/tracker.ts";
import { type Client, callGitHub, fetchAllPages, isStatus } from "./client.ts";
import { branchOf, keyOf, numberInUrl, priorityOf, stateOf, ticketLabelsOf } from "./mapping.ts";

/** What the plugin reads of an issue, as GitHub's REST API answers it. */
export type IssueJson = Readonly<{
  id: number; number: number; title: string; body: string | null; updated_at: string; html_url: string; repository_url: string;
  state: string; state_reason: string | null; labels: readonly (string | { name: string })[];
  assignee: { id: number; login: string } | null; milestone: { number: number; title: string; description: string | null } | null;
  parent_issue_url?: string | null; sub_issues_summary?: { total: number; completed: number }; pull_request?: unknown;
}>;

/** A comment on an issue, as GitHub answers it. */
export type CommentJson = Readonly<{ id: number; body: string | null; created_at: string; user: { login: string; type?: string } | null }>;

/** The repository the plugin's issues are in, the prefix of their keys, and the client that reaches it. */
export type Repository = Readonly<{ client: Client; owner: string; repo: string; prefix: string }>;

/** The path of the repository's API, which every issue's path starts with. */
export const repoPath = (at: Repository): string => `/repos/${at.owner}/${at.repo}`;

/** The words a claim comment starts with: `agent-org: claimed by <claimant>` (A11-168), as the Linear plugin writes them. */
export const CLAIM_PREFIX = "agent-org: claimed by ";
const ATTACHMENT_LINE = /^<!-- agent-org attachment: (\S+) -->\n?/;

/** The body of a comment that keeps the file `name`: a first line naming it, then the file's text. */
export const attachmentBody = (name: string, text: string): string => `<!-- agent-org attachment: ${name} -->\n${text}`;

/** The file a comment keeps, as its name and its text, or null for any other comment. */
export function attachmentIn(comment: CommentJson): { name: string; text: string } | null {
  const body = comment.body ?? "";
  const match = ATTACHMENT_LINE.exec(body);
  return match === null ? null : { name: match[1], text: body.slice(match[0].length) };
}

/** The names of an issue's labels, whichever shape GitHub gives each in. */
export const labelNames = (issue: IssueJson): string[] => issue.labels.map((label) => (typeof label === "string" ? label : label.name));

/** An issue as the board shows it. `children` and `uploads` are given only by a read that read them. */
export function ticketOf(at: Repository, issue: IssueJson, extra: Readonly<{ children?: readonly string[]; uploads?: readonly string[] }> = {}): Ticket {
  const labels = labelNames(issue);
  const state = stateOf(issue, labels);
  const parent = numberInUrl(issue.parent_issue_url);
  return Object.freeze({
    key: keyOf(at.prefix, issue.number), title: issue.title, description: issue.body ?? "", updatedAt: issue.updated_at, url: issue.html_url, branch: branchOf(at.prefix, issue.number),
    status: state.name, statusType: state.type, statusOrder: state.position, team: at.prefix, project: issue.milestone?.title ?? null, projectSummary: issue.milestone?.description ?? null,
    priority: priorityOf(labels), parent: parent === null ? null : keyOf(at.prefix, parent),
    assignee: issue.assignee === null ? null : { id: issue.assignee.login, name: issue.assignee.login }, labels: ticketLabelsOf(labels), ...extra,
  });
}

/** GitHub answers these for an issue it has none of: never made, or deleted or moved. */
const NOT_FOUND = 404;
const GONE = 410;
/** How many issues are read at once by key. */
const READ_BATCH = 10;

/** The issue numbered `number`, or null when the repository has none by it or it is a pull request. Throws on any other failure. */
export async function fetchIssue(at: Repository, number: number): Promise<IssueJson | null> {
  try {
    const issue = await callGitHub<IssueJson>(at.client, "GET", `${repoPath(at)}/issues/${number}`);
    return issue.pull_request === undefined ? issue : null;
  } catch (err) {
    if (isStatus(err, NOT_FOUND) || isStatus(err, GONE)) return null;
    throw err;
  }
}

/** The keys of an issue's open sub-issues: asked only of an issue whose summary says it has one still open, so an ordinary issue costs no request. */
export async function fetchOpenChildren(at: Repository, issue: IssueJson): Promise<string[]> {
  const summary = issue.sub_issues_summary;
  if (summary === undefined || summary.total <= summary.completed) return [];
  const children = await fetchAllPages<IssueJson>(at.client, `${repoPath(at)}/issues/${issue.number}/sub_issues`);
  return children.filter((child) => child.state === "open").map((child) => keyOf(at.prefix, child.number));
}

/** Every comment on an issue, oldest first. */
export const fetchComments = (at: Repository, number: number): Promise<CommentJson[]> => fetchAllPages<CommentJson>(at.client, `${repoPath(at)}/issues/${number}/comments`);

/** The tickets of a list of issues, pull requests left out, each with its open sub-issues. */
export async function fetchTicketsOf(at: Repository, issues: readonly IssueJson[]): Promise<Ticket[]> {
  const only = issues.filter((issue) => issue.pull_request === undefined);
  return Promise.all(only.map(async (issue) => ticketOf(at, issue, { children: await fetchOpenChildren(at, issue) })));
}

/** One event of an issue's timeline, as far as a cross-reference from a pull request goes. */
type TimelineEvent = Readonly<{ event: string; source?: { issue?: { html_url: string; title: string; state: string; pull_request?: { merged_at: string | null } } } }>;

/** A pull request's state: merged once it has a merge time, closed when closed without one, and open otherwise, a draft included. */
const pullStateOf = (state: string, mergedAt: string | null): PullState => (mergedAt !== null ? "merged" : state === "closed" ? "closed" : "open");

/** The state and the title of each pull request that cross-references the issue, by its address: a pull request links an issue on GitHub by naming it. */
export async function fetchLinkedPulls(at: Repository, number: number): Promise<{ pulls: Record<string, PullState>; titles: Record<string, string> }> {
  const events = await fetchAllPages<TimelineEvent>(at.client, `${repoPath(at)}/issues/${number}/timeline`);
  const pulls: Record<string, PullState> = {};
  const titles: Record<string, string> = {};
  for (const { event, source } of events) {
    const pull = source?.issue;
    if (event !== "cross-referenced" || pull?.pull_request === undefined) continue;
    pulls[pull.html_url] = pullStateOf(pull.state, pull.pull_request.merged_at);
    if (pull.title.trim() !== "") titles[pull.html_url] = pull.title.trim();
  }
  return { pulls, titles };
}

/** The issues each key names, by key, for the keys of this prefix that name an issue: a key of another prefix, or one with no issue, is left out. Read a few at a time. */
export async function fetchEachIssue(at: Repository, keys: readonly string[], numberOfKey: (key: string) => number | null): Promise<Map<string, IssueJson>> {
  const found = new Map<string, IssueJson>();
  const wanted = keys.flatMap((key) => {
    const number = numberOfKey(key);
    return number === null ? [] : [[key, number] as const];
  });
  for (let start = 0; start < wanted.length; start += READ_BATCH) {
    const batch = wanted.slice(start, start + READ_BATCH);
    const issues = await Promise.all(batch.map(([, number]) => fetchIssue(at, number)));
    batch.forEach(([key], index) => {
      const issue = issues[index];
      if (issue !== null) found.set(key, issue);
    });
  }
  return found;
}
