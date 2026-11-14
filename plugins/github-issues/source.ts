// @ts-check
// module: GitHub Issues as a ticket source -- the tracker contract over GitHub's REST API, for the issues of one repository (A11-447)
//
// ONE REPOSITORY'S ISSUES ARE THE TRACKER. A ticket is an issue of `tickets.providers.tracker.repo`, keyed `<prefix>-<number>`; a project is a milestone, whose description is the project's
// summary; a plan is a comment that keeps the file (`issues.ts`); a claim is a comment, as the Linear plugin writes it; "blocked by" is GitHub's issue dependencies, and a sub-issue is GitHub's.
// The states, priorities and label groups are kept in labels (`mapping.ts`, README.md). It writes only what the board hands the tracker, as the Linear plugin does.
//
// GITHUB CLOSES AN ISSUE ITSELF only for a closing word followed by `#<number>` or the issue's address. The board's bodies name the key (`Closes GH-12`), which GitHub does not read, so the
// board's `complete` closes the ticket once its pull request merges; `undoAutomaticCompletion` reopens one GitHub closed from a commit or a pull request.
import { basename, join } from "node:path";
import { writeFileSync } from "node:fs";
import type { PickScope } from "../../src/ticket-mode/settings.ts";
import type { AutomaticCompletionUndo, Blocker, Keywords, PullState, ScopePage, Ticket, TicketComments, TicketSource, TicketText } from "../../src/plugins/contracts/tracker.ts";
import { type Client, PAGE_SIZE, callGitHub, fetchAllPages } from "./client.ts";
import { type IssueJson, type Repository, CLAIM_PREFIX, attachmentBody, attachmentIn, fetchComments, fetchEachIssue, fetchIssue, fetchLinkedPulls, fetchOpenChildren, fetchTicketsOf, repoPath, ticketOf } from "./issues.ts";
import { branchOf, keyOf, numberOf, stateNamed } from "./mapping.ts";
import { BEFORE_PLANNING, BEFORE_WORK, currentState, fetchIssueOrThrow, moveIssueFrom, restoreIssueState, writeState } from "./moves.ts";

/**
 * The words GitHub reads in a pull request's body. GitHub closes an issue on merge for any of `closingWords` followed by `#<number>` or the issue's address: close, fix and resolve, each with
 * its -s and -d forms.
 */
const KEYWORDS: Keywords = Object.freeze({ closing: "Closes", nonClosing: "Refs", closingWords: Object.freeze(["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) });
/** The largest comment GitHub keeps, less room for the line that names the file. */
const MAX_PLAN_CHARS = 65_000;
const SEARCH_PAGE = 50;

export type IssuesSourceOptions = Readonly<{ owner: string; repo: string; prefix: string; client: Client; pick: PickScope; readFile: (path: string) => string }>;

type Milestone = Readonly<{ number: number; title: string; description: string | null }>;
type CloseEvent = Readonly<{ event: string; commit_id: string | null; actor: { type?: string } | null }>;

/** What every operation shares: the repository, the options, and the reads and writes several of them make. */
type Scope = ReturnType<typeof scopeOf>;

/** The shared reads and writes of one repository's source. The viewer's login is asked once and kept. */
function scopeOf(options: IssuesSourceOptions) {
  const at: Repository = { client: options.client, owner: options.owner, repo: options.repo, prefix: options.prefix };
  const base = repoPath(at);
  const numberFor = (key: string): number | null => numberOf(at.prefix, key);
  const call = <T>(method: string, path: string, body?: unknown): Promise<T> => callGitHub<T>(at.client, method, path, body);
  let login: string | null = null;
  return {
    at, base, options, numberFor, call,
    issueOf: (key: string): Promise<IssueJson> => fetchIssueOrThrow(at, numberFor(key), key),
    fetchLogin: async (): Promise<string> => (login ??= (await call<{ login: string }>("GET", "/user")).login),
    fetchMilestones: (): Promise<Milestone[]> => fetchAllPages<Milestone>(at.client, `${base}/milestones?state=open`),
    postComment: (number: number, body: string): Promise<unknown> => call("POST", `${base}/issues/${number}/comments`, { body }),
    fetchBlockedBy: (number: number): Promise<IssueJson[]> => fetchAllPages<IssueJson>(at.client, `${base}/issues/${number}/dependencies/blocked_by`),
    async fetchClaimant(number: number): Promise<string | null> {
      const claims = (await fetchComments(at, number)).filter((comment) => (comment.body ?? "").startsWith(CLAIM_PREFIX));
      return claims.length === 0 ? null : claims[claims.length - 1].body!.slice(CLAIM_PREFIX.length).trim();
    },
    async byKey<T>(keys: readonly string[], value: (issue: IssueJson) => T | Promise<T>): Promise<Map<string, T>> {
      const issues = await fetchEachIssue(at, keys, numberFor);
      return new Map(await Promise.all([...issues].map(async ([key, issue]) => [key, await value(issue)] as const)));
    },
    async fetchTicket(key: string): Promise<Ticket | null> {
      const number = numberFor(key);
      const issue = number === null ? null : await fetchIssue(at, number);
      if (issue === null) return null;
      const uploads = (await fetchComments(at, issue.number)).flatMap((comment) => attachmentIn(comment)?.name ?? []);
      return ticketOf(at, issue, { children: await fetchOpenChildren(at, issue), uploads });
    },
  };
}

/** The open tickets of the repository a list query narrows (`&assignee=...`, `&milestone=...`), every page of them. */
const fetchOpenTickets = async (scope: Scope, query: string): Promise<Ticket[]> => fetchTicketsOf(scope.at, await fetchAllPages<IssueJson>(scope.at.client, `${scope.base}/issues?state=open${query}`));

/** The open tickets of a milestone, one page at a time: the cursor is the next page's number. */
async function fetchMilestonePage(scope: Scope, project: string, after: string | null): Promise<ScopePage> {
  const milestone = (await scope.fetchMilestones()).find(({ title }) => title === project);
  if (milestone === undefined) return { tickets: [], next: null };
  const page = after === null ? 1 : Number(after);
  const issues = await scope.call<IssueJson[]>("GET", `${scope.base}/issues?state=open&milestone=${milestone.number}&per_page=${PAGE_SIZE}&page=${page}`);
  return { tickets: await fetchTicketsOf(scope.at, issues), next: issues.length < PAGE_SIZE ? null : String(page + 1) };
}

/** A blocker as the board reads it: an issue of this repository by its key and branch, and one of another repository by its address. */
async function fetchBlocker(scope: Scope, issue: IssueJson): Promise<Blocker> {
  const state = currentState(issue);
  const { pulls, titles } = await fetchLinkedPulls(scope.at, issue.number);
  if (!issue.repository_url.endsWith(scope.base)) return { key: issue.html_url, state: state.type, status: state.name, pulls, titles };
  return { key: keyOf(scope.at.prefix, issue.number), state: state.type, status: state.name, branch: branchOf(scope.at.prefix, issue.number), pulls, titles };
}

/** The Pick view's reads: the list, the viewer, the milestones as projects, and search. */
function pickOperations(scope: Scope): Pick<TicketSource, "assigned" | "viewer" | "me" | "projects" | "projectPage" | "search"> {
  return {
    async assigned() {
      const pick = scope.options.pick;
      if (pick === "assigned") return fetchOpenTickets(scope, `&assignee=${encodeURIComponent(await scope.fetchLogin())}`);
      if ("team" in pick) return fetchOpenTickets(scope, "");
      const milestone = (await scope.fetchMilestones()).find(({ title }) => title === pick.project);
      return milestone === undefined ? [] : fetchOpenTickets(scope, `&milestone=${milestone.number}`);
    },
    viewer: () => scope.fetchLogin(),
    async me() {
      const name = await scope.fetchLogin();
      return { id: name, name };
    },
    projects: async () => (await scope.fetchMilestones()).map(({ number, title }) => ({ id: String(number), name: title })),
    projectPage: (project, after) => fetchMilestonePage(scope, project, after),
    async search(text) {
      const words = text.trim();
      if (words === "") return [];
      const exact = scope.numberFor(words) === null ? null : await scope.fetchTicket(words);
      const query = encodeURIComponent(`${words} repo:${scope.at.owner}/${scope.at.repo} is:issue is:open`);
      const found = await scope.call<{ items: IssueJson[] }>("GET", `/search/issues?q=${query}&per_page=${SEARCH_PAGE}`);
      const tickets = await fetchTicketsOf(scope.at, found.items);
      return exact === null || !isOpenType(exact.statusType) ? tickets : [exact, ...tickets.filter((ticket) => ticket.key !== exact.key)];
    },
  };
}

const isOpenType = (type: string | undefined): boolean => !["completed", "canceled", "duplicate"].includes(type ?? "");

/** The reads of a ticket and of several by key, and the download of its plans. */
function ticketOperations(scope: Scope): Pick<TicketSource, "read" | "download" | "stateTypes" | "texts" | "pullStates" | "blockers" | "projectSummaries" | "readComments"> {
  return {
    read: (key) => scope.fetchTicket(key),
    async download(ticket, dir) {
      const comments = await fetchComments(scope.at, (await scope.issueOf(ticket.key)).number);
      return comments.flatMap((comment) => attachmentIn(comment) ?? []).map(({ name, text }, index) => {
        const path = join(dir, `attachment-${index + 1}-${basename(name)}`);
        writeFileSync(path, text);
        return path;
      });
    },
    stateTypes: (keys) => scope.byKey(keys, (issue) => currentState(issue).type),
    texts: (keys) => scope.byKey(keys, (issue): TicketText => ({ description: issue.body ?? "", updatedAt: issue.updated_at })),
    pullStates: (keys) => scope.byKey(keys, async (issue): Promise<Readonly<Record<string, PullState>>> => (await fetchLinkedPulls(scope.at, issue.number)).pulls),
    blockers: (keys) => scope.byKey(keys, async (issue) => Promise.all((await scope.fetchBlockedBy(issue.number)).map((blocker) => fetchBlocker(scope, blocker)))),
    async projectSummaries(keys) {
      const issues = await fetchEachIssue(scope.at, keys, scope.numberFor);
      return new Map([...issues].flatMap(([key, issue]) => (issue.milestone === null ? [] : [[key, issue.milestone.description] as const])));
    },
    async readComments(key): Promise<TicketComments> {
      const issue = await scope.issueOf(key);
      const comments = (await fetchComments(scope.at, issue.number)).filter((comment) => attachmentIn(comment) === null && !(comment.body ?? "").startsWith(CLAIM_PREFIX));
      return { comments: comments.map((comment) => ({ author: comment.user?.login ?? "unknown", createdAt: comment.created_at, body: comment.body ?? "" })), complete: true };
    },
  };
}

/** A plan's files kept as comments, and their removal before a re-plan. */
function planOperations(scope: Scope): Pick<TicketSource, "attachPlan" | "detachPlan"> {
  return {
    async attachPlan(key, files, state) {
      const issue = await scope.issueOf(key);
      const attached = new Set((await fetchComments(scope.at, issue.number)).flatMap((comment) => attachmentIn(comment)?.name ?? []));
      for (const file of files.filter((path) => !attached.has(basename(path)))) {
        const text = scope.options.readFile(file);
        if (text.length > MAX_PLAN_CHARS) throw new Error(`GitHub Issues: ${basename(file)} is ${text.length} characters, past the ${MAX_PLAN_CHARS} a comment keeps, so it cannot be attached to ${key}`);
        await scope.postComment(issue.number, attachmentBody(basename(file), text));
      }
      return state === null ? null : (await moveIssueFrom(scope.at, issue, state, BEFORE_PLANNING)).note;
    },
    async detachPlan(key, titles) {
      const issue = await scope.issueOf(key);
      const plans = (await fetchComments(scope.at, issue.number)).filter((comment) => titles.includes(attachmentIn(comment)?.name ?? ""));
      for (const comment of plans) await scope.call("DELETE", `${scope.base}/issues/comments/${comment.id}`);
    },
  };
}

/** Who closed a completed issue: GitHub from a commit or a pull request, or an app, is the integration; a person is anyone else. The board's own `complete` is a person's. */
async function findCloser(scope: Scope, issue: IssueJson): Promise<AutomaticCompletionUndo["by"]> {
  const events = await fetchAllPages<CloseEvent>(scope.at.client, `${scope.base}/issues/${issue.number}/events`);
  const closed = events.filter(({ event }) => event === "closed").at(-1);
  if (closed === undefined) return "unknown";
  return closed.commit_id !== null || closed.actor?.type === "Bot" ? "integration" : "person";
}

/** The state moves: a worker starting, the move put back, completion, and undoing GitHub's own completion. */
function stateOperations(scope: Scope): Pick<TicketSource, "moveToWorkingState" | "restoreState" | "complete" | "undoAutomaticCompletion"> {
  return {
    moveToWorkingState: async (key, state) => moveIssueFrom(scope.at, await scope.issueOf(key), state, BEFORE_WORK),
    restoreState: async (key, move) => restoreIssueState(scope.at, await scope.issueOf(key), move),
    async complete(key, comment) {
      const issue = await scope.issueOf(key);
      if (issue.state !== "open") return null;
      await scope.postComment(issue.number, comment);
      await writeState(scope.at, issue, stateNamed("Done")!);
      return null;
    },
    async undoAutomaticCompletion(key, comment): Promise<AutomaticCompletionUndo> {
      const issue = await scope.issueOf(key);
      if (currentState(issue).type !== "completed") return { reopened: null, by: "none", note: null };
      const by = await findCloser(scope, issue);
      if (by !== "integration") return { reopened: null, by, note: by === "unknown" ? "GitHub holds no event that closed the issue" : null };
      await scope.call("PATCH", `${scope.base}/issues/${issue.number}`, { state: "open" });
      await scope.postComment(issue.number, comment);
      return { reopened: { from: currentState(issue).name, to: currentState({ ...issue, state: "open", state_reason: null }).name }, by, note: null };
    },
  };
}

/** The writes that change no state: comments, the ticket's text, claims and blocking relations. */
function writeOperations(scope: Scope): Pick<TicketSource, "comment" | "updateTicketText" | "claim" | "claims" | "addBlockers"> {
  return {
    comment: async (key, body) => void await scope.postComment((await scope.issueOf(key)).number, body),
    async updateTicketText(key, text) {
      const issue = await scope.issueOf(key);
      await scope.call("PATCH", `${scope.base}/issues/${issue.number}`, { ...(text.title === undefined ? {} : { title: text.title }), ...(text.description === undefined ? {} : { body: text.description }) });
    },
    async claim(key, claimant) {
      const issue = await scope.issueOf(key);
      if ((await scope.fetchClaimant(issue.number)) !== claimant) await scope.postComment(issue.number, `${CLAIM_PREFIX}${claimant}`);
    },
    async claims(keys) {
      const claimants = await scope.byKey(keys, (issue) => scope.fetchClaimant(issue.number));
      return new Map([...claimants].flatMap(([key, claimant]) => (claimant === null ? [] : [[key, claimant] as const])));
    },
    async addBlockers(key, blockerKeys) {
      const issue = await scope.issueOf(key);
      const held = new Set((await scope.fetchBlockedBy(issue.number)).map(({ id }) => id));
      for (const blockerKey of blockerKeys) {
        const blocker = await scope.issueOf(blockerKey);
        if (held.has(blocker.id)) continue;
        await scope.call("POST", `${scope.base}/issues/${issue.number}/dependencies/blocked_by`, { issue_id: blocker.id });
        held.add(blocker.id);
      }
    },
  };
}

/** The GitHub Issues source of one repository. */
export function issuesSource(options: IssuesSourceOptions): TicketSource {
  const scope = scopeOf(options);
  return { keywords: KEYWORDS, ...pickOperations(scope), ...ticketOperations(scope), ...planOperations(scope), ...stateOperations(scope), ...writeOperations(scope) };
}
