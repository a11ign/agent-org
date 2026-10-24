// @ts-check
// module: Linear as a ticket source -- GraphQL over an injected `fetch`, with a personal API key (the Linear plugin's, moved out of core by A11-159)
//
// A PERSONAL KEY, NOT AN APP. A Linear agent app is installed by a workspace admin, which a person on a work account cannot do, so ticket mode reads
// as the person: their key, and by default the open tickets they can see, which the Pick view filters to their own (`tickets.pick` can narrow the list
// to a team or a project). It writes only what the board hands the tracker, each on a planning run's or a verified outcome's behalf or a person's: the
// plan's files, attached to the ticket, the ticket's move to the planner's state, a batch's order as "blocks" relations, once a run's pull request
// merged without closing its ticket or a worker verified its `done` (A11-91), the ticket's move to its completed state with a comment (A11-92), and,
// once a person applies a worker's proposed edit, the ticket's title and description (A11-91), and, as a run starts, a comment that names the instance holding the ticket
// (A11-168, ADR A11-168-0001). Workers write nothing, and a new-ticket run files its own
// ticket through its own tracker tools (A11-135), not through this module. Linear's
// own GitHub integration links each pull request, because the worker's branch is the ticket's `branchName`.
//
// THE KEY NEVER LEAVES THIS MODULE. It is read once, from the macOS Keychain or a file the host file names, and sent only to api.linear.app and uploads.linear.app.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { PickScope } from "../../src/ticket-mode/settings.ts";
import type { Assignee, AutomaticCompletionUndo, Blocker, People, ScopePage, Keywords, PullState, StateMove, Ticket, TicketLabel, TicketSource, TicketText } from "../../src/plugins/contracts/tracker.ts";

export const LINEAR_API = "https://api.linear.app/graphql";
/**
 * The words Linear's GitHub integration reads in a pull request's body: `Closes` completes its ticket on merge, `Refs` only links it. Linear reads any of `closingWords` followed by a key ANYWHERE in the
 * body, a code span or a quoted example included, and completes the ticket on merge whatever else the body says (A11-178): its documented magic words are close, fix, resolve, complete and implement,
 * each with its -s, -d or -ed, and -ing forms.
 */
const KEYWORDS: Keywords = Object.freeze({
  closing: "Closes", nonClosing: "Refs",
  closingWords: Object.freeze([
    "close", "closes", "closed", "closing", "fix", "fixes", "fixed", "fixing", "resolve", "resolves", "resolved", "resolving",
    "complete", "completes", "completed", "completing", "implement", "implements", "implemented", "implementing",
  ]),
});
/** Linear stores uploads here, and only a request carrying the key may read one. */
const UPLOADS = /https:\/\/uploads\.linear\.app\/[^\s)"'<>]+/g;
const UPLOAD_ORIGIN = "https://uploads.linear.app/";
/** A tracker key, split into its team and number. */
const TICKET_KEY = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
const PAGE = 100;

/** Keys read in one batched request: each is an aliased query, and a long query text is one Linear may refuse. */
const STATE_BATCH = 25;
/** A ticket's attachments: Linear's first page of 50, read the same way for the board's list and for a worker's download. */
const ATTACHMENTS = "attachments(first: 50) { nodes { url title } }";
/**
 * A ticket's open sub-issues, by key: Linear's first page of 50, filtered by state type as the Pick list is, so a sub-issue finished, canceled or
 * a duplicate does not count and an epic whose parts are all done reads as an ordinary ticket. Read with the list, in the same request.
 */
const OPEN_CHILDREN = 'children(first: 50, filter: { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }) { nodes { identifier } }';
/**
 * A ticket's labels, each with the label group above it (Linear's parent label), so the Pick view can make a filter row of each group: Linear's
 * first page of 50, which no ticket comes near. Read with the list, in the same request. Only a group's name is read, as only its name is shown.
 */
const LABELS = "labels(first: 50) { nodes { name parent { name } } }";
const ISSUE_FIELDS = `identifier title description updatedAt url branchName priority state { name position type } team { key } project { name summary: description } assignee { id name } parent { identifier } ${OPEN_CHILDREN} ${ATTACHMENTS} ${LABELS}`;
/** The words a claim comment starts with: `agent-org: claimed by <claimant>` (A11-168). The tracker is asked only for comments that start with them. */
const CLAIM_PREFIX = "agent-org: claimed by ";
/** A ticket's claim comments with their times: Linear's first page of 50, which a ticket comes nowhere near, since a claim is written only when the claimant changes. */
const CLAIMS = `comments(first: 50, filter: { body: { startsWith: ${JSON.stringify(CLAIM_PREFIX)} } }) { nodes { body createdAt } }`;
/** A file name that is safe as it stands: no folder, and an extension. A plan's attachment title is one. */
const FILE_NAME = /^[\w.-]+\.\w{1,8}$/;

type Fetch = typeof fetch;

type IssueNode = {
  identifier: string; title: string; description: string | null; updatedAt: string; url: string; branchName: string; priority: number;
  state: { name: string; position: number; type: string }; team: { key: string }; project: { name: string; summary: string | null } | null; assignee: Assignee | null; parent: { identifier: string } | null;
  /** Absent from an answer to a query that did not ask for it: such a ticket is read as having none. */
  children?: { nodes: { identifier: string }[] };
  /** Absent from an answer to a query that did not ask for them: such a ticket is read as having none. */
  labels?: { nodes: { name: string; parent: { name: string } | null }[] };
} & Attachments;

type Attachments = { attachments?: { nodes: { url: string; title: string }[] } };

/**
 * The attachments that are uploads, as Linear lists them beside a ticket's description; a link to elsewhere, such as a pull request, is left out.
 * Anchored at the upload origin, because every download carries the key: a link that only mentions an upload goes somewhere else. PURE.
 */
const uploadsIn = (node: Attachments): { url: string; title: string }[] => (node.attachments?.nodes ?? []).filter(({ url }) => url.startsWith(UPLOAD_ORIGIN));

function toTicket(node: IssueNode): Ticket {
  return Object.freeze({
    key: node.identifier, title: node.title, description: node.description ?? "", updatedAt: node.updatedAt, url: node.url, branch: node.branchName,
    status: node.state.name, statusType: node.state.type, statusOrder: node.state.position, team: node.team.key, project: node.project?.name ?? null, projectSummary: node.project?.summary ?? null, priority: node.priority,
    assignee: node.assignee ?? null, parent: node.parent?.identifier ?? null,
    children: (node.children?.nodes ?? []).map(({ identifier }) => identifier),
    uploads: uploadsIn(node).map(({ title }) => title),
    labels: (node.labels?.nodes ?? []).map(({ name, parent }): TicketLabel => Object.freeze({ name, group: parent?.name ?? null })),
  });
}

/** Every Linear upload a description links to, once each, in the order they appear. PURE. */
export function uploadLinks(description: string): string[] {
  return [...new Set(description.match(UPLOADS) ?? [])];
}

/** A pull request's state from Linear's word for it: `merged` and `closed` are final, and anything else, a draft included, is still open. PURE. */
export function pullState(status: string | undefined): PullState {
  return status === "merged" || status === "closed" ? status : "open";
}

/** A ticket's links, as read for the state of its pull requests. Linear's GitHub integration keeps each one's state in its metadata. */
type Attached = { attachments: { nodes: { url: string; sourceType: string; title?: string | null; metadata: { status?: string } | null }[] } };
const ATTACHED_PULLS = "attachments { nodes { url sourceType title metadata } }";

/** The state of each pull request a ticket links, by URL. Its other links, such as an upload, are left out. PURE. */
function linkedPulls(node: Attached): Record<string, PullState> {
  return Object.fromEntries(node.attachments.nodes.filter(({ sourceType }) => sourceType === "github").map(({ url, metadata }) => [url, pullState(metadata?.status)]));
}

/** The title of each pull request a ticket links, by URL, from the GitHub attachment's title (A11-207). A pull request whose attachment has no title is left out. PURE. */
function linkedTitles(node: Attached): Record<string, string> {
  const titled = node.attachments.nodes.flatMap(({ url, sourceType, title }) => (sourceType === "github" && title?.trim() ? [[url, title.trim()] as const] : []));
  return Object.fromEntries(titled);
}

/** What attaching a plan reads of its ticket: its id, its state's type, its team's states, and the files already attached. */
type Planning = Stateful & Attachments;
/** What moving a ticket's state reads of it: its id, its state's type and name, and the states its team has, with each one's type and position. */
type Stateful = { id: string; state: { type: string; name: string }; team: { states: { nodes: { id: string; name: string; type: string; position: number }[] } } };
const STATEFUL = "id state { type name } team { states { nodes { id name type position } } }";
/** The state types a ticket is finished in: a ticket of one is left alone when a run's pull request merges. */
const FINISHED_TYPES = new Set(["completed", "canceled", "duplicate"]);
/** Linear's answer to a request to upload a file: where to PUT it, with which headers, and the address it is then read from. */
type Upload = { fileUpload: { success: boolean; uploadFile: { uploadUrl: string; assetUrl: string; headers: { key: string; value: string }[] } | null } };

/** The state types a plan moves a ticket on from: new work only, never work already planned or started back. */
const BEFORE_PLANNING = new Set(["backlog", "triage"]);
/** The state types a worker starting moves a ticket on from: any work not yet started, a planned ticket included. */
const BEFORE_WORK = new Set([...BEFORE_PLANNING, "unstarted"]);

/** The name the `n`th download is saved as: its attachment title when that names a file, or else `attachment-<n>` and an extension. PURE. */
export function downloadName(n: number, link: string, title: string | null, contentType: string): string {
  if (title !== null && FILE_NAME.test(title)) return `attachment-${n}-${title}`;
  const extension = extname(new URL(link).pathname) || (contentType.startsWith("image/") ? `.${contentType.slice(6).split(";")[0]}` : "");
  return `attachment-${n}${extension}`;
}

/** One page of a list of tickets, as Linear answers it. */
type Connection = { nodes: IssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

/** How the Pick view's list is read: the query, its variables beside the page cursor `after`, and where the page sits in the answer. */
export type PickQuery = Readonly<{ text: string; variables: Readonly<Record<string, string>>; page: (data: unknown) => Connection }>;

/** The state filter every list shares: no ticket finished, canceled, or a duplicate, which Linear types on its own. */
const OPEN = 'state: { type: { nin: ["completed", "canceled", "duplicate"] } }';

/**
 * The query the Pick view's list is read with, for the host file's `tickets.pick`. PURE.
 *
 * With no `tickets.pick`, or `"assigned"`: the key's own open tickets, as the board always asked. Reading every open ticket the key can see
 * (A11-108's first version) is 19 MB and 53 s on a workspace of this size, past the page's 30 s and 8 MB limits, so the Pick view showed nothing. The
 * other people's tickets are read one scope at a time instead (`people()` and `scoped()`).
 * For a team or a project: every open ticket of it, which is bounded, in one `issues` list paged a page at a time, each ticket carrying its assignee
 * so the Pick view can choose the assignee in the page. The team or the project is passed as a variable, never written into the query's text.
 */
export function pickQuery(scope: PickScope): PickQuery {
  if (scope === "assigned") {
    return {
      text: `query($after: String) { viewer { assignedIssues(first: ${PAGE}, after: $after, filter: { ${OPEN} }) {
            nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } } }`,
      variables: {},
      page: (data) => (data as { viewer: { assignedIssues: Connection } }).viewer.assignedIssues,
    };
  }
  const narrowed = "team" in scope ? { name: "team", filter: "team: { key: { eq: $team } }", value: scope.team }
    : { name: "project", filter: "project: { name: { eq: $project } }", value: scope.project };
  return {
    text: `query($after: String, $${narrowed.name}: String!) { issues(first: ${PAGE}, after: $after, filter: { ${narrowed.filter}, ${OPEN} }) {
            nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
    variables: { [narrowed.name]: narrowed.value },
    page: (data) => (data as { issues: Connection }).issues,
  };
}

/** Pages of the people read, which carry only the assignee, so a page can be large. */
const PEOPLE_PAGE = 250;

/**
 * The query one scope's page is read with: a person's open tickets, the unassigned ones, or every open one. The person is passed as a variable, never
 * written into the query's text. PURE.
 */
export function scopedQuery(scope: string): { text: string; variables: Record<string, string> } {
  const person = scope !== "unassigned" && scope !== "anyone";
  const filter = scope === "unassigned" ? `assignee: { null: true }, ${OPEN}` : person ? `assignee: { id: { eq: $who } }, ${OPEN}` : OPEN;
  return {
    text: `query($after: String${person ? ", $who: ID!" : ""}) { issues(first: ${PAGE}, after: $after, filter: { ${filter} }) {
            nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
    variables: person ? { who: scope } : {},
  };
}

/** The seams every call to Linear goes through: the key, which goes only to Linear, and the `fetch` that sends it. */
type Client = Readonly<{ key: string; request: Fetch }>;

/** An error that carries the HTTP `status` the server answered with, as data, so the board tries a 5xx again without reading the message (tracker contract 1.7). */
const answered = (message: string, status: number): Error => Object.assign(new Error(message), { status });

async function query<T>(client: Client, text: string, variables: Record<string, unknown>): Promise<T> {
  const { key, request } = client;
  const response = await request(LINEAR_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query: text, variables }),
  });
  const body = await response.json().catch(() => null) as { data?: T; errors?: { message: string }[] } | null;
  if (!response.ok || body === null || body.errors?.length) {
    throw answered(`Linear answered ${response.status}: ${body?.errors?.map((e) => e.message).join("; ") ?? "no JSON"}`, response.status);
  }
  return body.data as T;
}

/**
 * One ticket's `fields`, or `null` for a string that is no key or a key Linear has no ticket for. It reads by team and number, so a missing
 * ticket is an empty list: nothing hangs on the wording of an error.
 */
async function issue<T>(client: Client, identifier: string, fields: string): Promise<T | null> {
  const parts = TICKET_KEY.exec(identifier);
  if (parts === null) return null;
  const data: { issues: { nodes: T[] } } = await query(client,
    `query($team: String!, $number: Float!) { issues(first: 1, filter: { team: { key: { eq: $team } }, number: { eq: $number } }) { nodes { ${fields} } } }`,
    { team: parts[1].toUpperCase(), number: Number(parts[2]) });
  return data.issues.nodes[0] ?? null;
}

/** `fields` of each ticket `keys` names, by key, in one request per batch, each key an aliased read by team and number as `issue` does it. */
async function eachIssue<T>(client: Client, keys: readonly string[], fields: string): Promise<Map<string, T>> {
  const found = new Map<string, T>();
  const parsed = keys.map((key) => [key, TICKET_KEY.exec(key)] as const).filter((pair): pair is readonly [string, RegExpExecArray] => pair[1] !== null);
  for (let start = 0; start < parsed.length; start += STATE_BATCH) {
    const batch = parsed.slice(start, start + STATE_BATCH);
    const params = batch.map((_, i) => `$t${i}: String!, $n${i}: Float!`).join(", ");
    const reads = batch.map((_, i) => `k${i}: issues(first: 1, filter: { team: { key: { eq: $t${i} } }, number: { eq: $n${i} } }) { nodes { ${fields} } }`).join(" ");
    const variables = Object.fromEntries(batch.flatMap(([, parts], i) => [[`t${i}`, parts[1].toUpperCase()], [`n${i}`, Number(parts[2])]]));
    const data: Record<string, { nodes: T[] }> = await query(client, `query(${params}) { ${reads} }`, variables);
    batch.forEach(([key], i) => {
      const [node] = data[`k${i}`]?.nodes ?? [];
      if (node !== undefined) found.set(key, node);
    });
  }
  return found;
}

/**
 * Move the ticket to its team's state named `state`, when its state's type is one of `from`. Teams name their states differently, so a team
 * without one of that name keeps the ticket's current state, and the returned note says so. `moved` is the state it moved from, and null when
 * it did not move.
 */
async function moveTo(client: Client, identifier: string, found: Stateful, state: string, from: ReadonlySet<string>): Promise<Readonly<{ moved: StateMove | null; note: string | null }>> {
  if (!from.has(found.state.type)) return { moved: null, note: null };
  const target = found.team.states.nodes.find(({ name }) => name === state);
  if (target === undefined) return { moved: null, note: `${identifier}'s team has no state named ${state}, so it stays in ${found.state.name}` };
  await setState(client, identifier, found.id, target.id, state);
  return { moved: { from: found.state.name, to: state }, note: null };
}

/** Set the ticket `id` to the state `stateId`, which is named `state` for the error that says so. */
async function setState(client: Client, identifier: string, id: string, stateId: string, state: string): Promise<void> {
  const { issueUpdate }: { issueUpdate: { success: boolean } } = await query(client,
    "mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }", { id, stateId });
  // Linear can answer a mutation it did not carry out with success false and no error, so the answer is read, not assumed.
  if (!issueUpdate.success) throw new Error(`Linear did not move ${identifier} to ${state}`);
}

/** Post `body` as a comment on the ticket `id`, which is named `identifier` for the error that says so. */
async function postComment(client: Client, identifier: string, id: string, body: string): Promise<void> {
  const { commentCreate }: { commentCreate: { success: boolean } } = await query(client,
    "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }", { issueId: id, body });
  if (!commentCreate.success) throw new Error(`Linear did not post a comment on ${identifier}`);
}

/** Upload the markdown file at `path` and attach it to the ticket `issueId` under `title`. */
async function attachFile(client: Client, issueId: string, path: string, title: string): Promise<void> {
  const { request } = client;
  const body = readFileSync(path);
  const { fileUpload }: Upload = await query(client,
    "mutation($contentType: String!, $filename: String!, $size: Int!) { fileUpload(contentType: $contentType, filename: $filename, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }",
    { contentType: "text/markdown", filename: title, size: body.length });
  if (!fileUpload.success || fileUpload.uploadFile === null) throw new Error(`Linear would not take the upload of ${title}`);
  const { uploadUrl, assetUrl, headers } = fileUpload.uploadFile;
  // The file goes to the storage address Linear signed, without the key: the signature is the permission.
  const put = await request(uploadUrl, { method: "PUT", body, headers: { "Content-Type": "text/markdown", "Cache-Control": "public, max-age=31536000",
    ...Object.fromEntries(headers.map(({ key: name, value }) => [name, value])) } });
  if (!put.ok) throw answered(`the upload of ${title} was refused (${put.status})`, put.status);
  const { attachmentCreate }: { attachmentCreate: { success: boolean } } = await query(client,
    "mutation($issueId: String!, $url: String!, $title: String!) { attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) { success } }",
    { issueId, url: assetUrl, title });
  if (!attachmentCreate.success) throw new Error(`Linear did not attach ${title}`);
}

/** The uploads attached to a ticket. */
async function attachedUploads(client: Client, identifier: string): Promise<{ url: string; title: string }[]> {
  const found = await issue<Attachments>(client, identifier, ATTACHMENTS);
  return found === null ? [] : uploadsIn(found);
}

/** The key's person: their id, and the name Linear has for them, or their email when it has none. */
async function me(client: Client): Promise<Assignee> {
  const { viewer }: { viewer: { id: string; name: string | null; email: string | null } } = await query(client, "query { viewer { id name email } }", {});
  return { id: viewer.id, name: viewer.name || viewer.email || "the key's user" };
}

async function assignedTickets(client: Client, pick: PickScope): Promise<Ticket[]> {
  const list = pickQuery(pick);
  const tickets: Ticket[] = [];
  let after: string | null = null;
  do {
    const page = list.page(await query<unknown>(client, list.text, { ...list.variables, after }));
    tickets.push(...page.nodes.map(toTicket));
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after !== null);
  return tickets;
}

async function addBlockersTo(client: Client, identifier: string, blockerKeys: readonly string[]): Promise<void> {
  type Blocked = { id: string; inverseRelations: { nodes: { type: string; issue: { identifier: string } }[] } };
  const found = await issue<Blocked>(client, identifier, "id inverseRelations { nodes { type issue { identifier } } }");
  if (found === null) throw new Error(`Linear has no ticket ${identifier}`);
  const already = new Set(found.inverseRelations.nodes.filter(({ type }) => type === "blocks").map(({ issue: blocker }) => blocker.identifier));
  const missing = [...new Set(blockerKeys)].filter((key) => !already.has(key));
  if (missing.length === 0) return;
  const ids = await eachIssue<{ id: string }>(client, missing, "id");
  for (const key of missing) {
    const blocker = ids.get(key);
    if (blocker === undefined) throw new Error(`Linear has no ticket ${key}`);
    // "A blocks B" is stored on A, with B as the related issue: the same relation `blockers` reads back from B.
    const { issueRelationCreate }: { issueRelationCreate: { success: boolean } } = await query(client,
      "mutation($issueId: String!, $relatedIssueId: String!) { issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: blocks }) { success } }",
      { issueId: blocker.id, relatedIssueId: found.id });
    if (!issueRelationCreate.success) throw new Error(`Linear did not record that ${key} blocks ${identifier}`);
  }
}

async function blockersOf(client: Client, keys: readonly string[]): Promise<ReadonlyMap<string, readonly Blocker[]>> {
  // Linear stores "A blocks B" once, on A: B reads its blockers as the inverse relations of type `blocks`.
  type Related = { inverseRelations: { nodes: { type: string; issue: { identifier: string; branchName: string; state: { type: string; name: string } } & Attached }[] } };
  const found = await eachIssue<Related>(client, keys, `inverseRelations { nodes { type issue { identifier branchName state { type name } ${ATTACHED_PULLS} } } }`);
  return new Map([...found].map(([key, node]) => [key, node.inverseRelations.nodes.filter(({ type }) => type === "blocks")
    .map(({ issue }): Blocker => {
      const titles = linkedTitles(issue);
      return { key: issue.identifier, state: issue.state.type, status: issue.state.name, branch: issue.branchName, pulls: linkedPulls(issue), ...(Object.keys(titles).length === 0 ? {} : { titles }) };
    })]));
}

async function attachPlanTo(client: Client, identifier: string, files: readonly string[], state: string | null): Promise<string | null> {
  const found = await issue<Planning>(client, identifier, `${STATEFUL} ${ATTACHMENTS}`);
  if (found === null) throw new Error(`Linear has no ticket ${identifier}`);
  const attached = new Set(uploadsIn(found).map(({ title }) => title));
  for (const path of files) {
    const title = basename(path);
    if (!attached.has(title)) await attachFile(client, found.id, path, title);
  }
  return state === null ? null : (await moveTo(client, identifier, found, state, BEFORE_PLANNING)).note;
}

/** Each key's description and `updatedAt`, in the batched requests `stateTypes` uses (A11-167). */
async function textsOf(client: Client, keys: readonly string[]): Promise<ReadonlyMap<string, TicketText>> {
  const found = await eachIssue<{ description: string | null; updatedAt: string }>(client, keys, "description updatedAt");
  return new Map([...found].map(([key, node]): [string, TicketText] => [key, { description: node.description ?? "", updatedAt: node.updatedAt }]));
}

/**
 * Delete the ticket's uploads titled `titles` (A11-167). Only an upload is touched, as a plan's file is one, and a pull request link or a person's own upload under another title is left alone.
 * A title the ticket does not have is skipped, so an attempt that was cut off can be repeated.
 */
async function detachPlanOf(client: Client, identifier: string, titles: readonly string[]): Promise<void> {
  const found = await issue<{ attachments: { nodes: { id: string; url: string; title: string }[] } }>(client, identifier, "attachments(first: 50) { nodes { id url title } }");
  if (found === null) throw new Error(`Linear has no ticket ${identifier}`);
  const named = new Set(titles);
  for (const { id, url, title } of found.attachments.nodes) {
    if (!url.startsWith(UPLOAD_ORIGIN) || !named.has(title)) continue;
    const { attachmentDelete }: { attachmentDelete: { success: boolean } } = await query(client, "mutation($id: String!) { attachmentDelete(id: $id) { success } }", { id });
    if (!attachmentDelete.success) throw new Error(`Linear did not remove ${title} from ${identifier}`);
  }
}

async function moveWorking(client: Client, identifier: string, state: string): Promise<Readonly<{ moved: StateMove | null; note: string | null }>> {
  const found = await issue<Stateful>(client, identifier, STATEFUL);
  if (found === null) throw new Error(`Linear has no ticket ${identifier}`);
  return moveTo(client, identifier, found, state, BEFORE_WORK);
}

async function restoreStateOf(client: Client, identifier: string, move: StateMove): Promise<string | null> {
  const found = await issue<Stateful>(client, identifier, STATEFUL);
  // A ticket Linear no longer has has nothing to put back, and must not hold its run on the board for ever.
  if (found === null) return `Linear has no ticket ${identifier}, so nothing was put back to ${move.from}`;
  // Only while the ticket is still where the board put it: a person who has moved it since has moved it on, and that is theirs to keep.
  if (found.state.name !== move.to) return null;
  const target = found.team.states.nodes.find(({ name }) => name === move.from);
  if (target === undefined) return `${identifier}'s team has no state named ${move.from}, so it stays in ${found.state.name}`;
  await setState(client, identifier, found.id, target.id, move.from);
  return null;
}

/** A move Linear's history records: when, the states it left and entered, and who made it. A person is its `actor`; an integration is its `botActor`, with no person. */
export type HistoryMove = {
  createdAt: string; toState: { id: string } | null; fromState: { id: string; name: string } | null; actor: { id: string } | null; botActor: { name: string | null } | null;
};
/** What undoing a completion reads of its ticket: its id, the state it is in, its team's states, and the newest of its history. */
type Completed = { id: string; state: { id: string; type: string; name: string }; team: { states: { nodes: { id: string; name: string; type: string }[] } }; history: { nodes: HistoryMove[] } };
const COMPLETED = "id state { id type name } team { states { nodes { id name type } } } history(first: 100) { nodes { createdAt toState { id } fromState { id name } actor { id } botActor { name } } }";

/**
 * Who moved a ticket into the state `stateId` it is in now, and the state it left (A11-178): the newest history entry that entered `stateId`. A person's move has an `actor`; the integration's has a
 * `botActor` and no person, which is how Linear records the GitHub integration completing a ticket on merge. A person's move wins even where a bot is named beside it. An entry with neither, or no
 * entry at all, is `unknown`. PURE.
 */
export function completionOf(history: readonly HistoryMove[], stateId: string): Readonly<{ by: "integration" | "person" | "unknown"; from: { id: string; name: string } | null }> {
  const [newest] = history.filter(({ toState }) => toState?.id === stateId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (newest === undefined) return { by: "unknown", from: null };
  const by = newest.actor !== null ? "person" : newest.botActor !== null ? "integration" : "unknown";
  return { by, from: newest.fromState };
}

async function undoAutomaticCompletionOf(client: Client, identifier: string, comment: string): Promise<AutomaticCompletionUndo> {
  const found = await issue<Completed>(client, identifier, COMPLETED);
  if (found === null) throw new Error(`Linear has no ticket ${identifier}`);
  if (found.state.type !== "completed") return { reopened: null, by: "none", note: null };
  const { by, from } = completionOf(found.history.nodes, found.state.id);
  if (by === "person") return { reopened: null, by, note: null };
  if (by === "unknown") return { reopened: null, by, note: `Linear's history does not say who moved ${identifier} to ${found.state.name}` };
  if (from === null) return { reopened: null, by, note: `Linear's history does not say which state ${identifier} was in before ${found.state.name}` };
  const target = found.team.states.nodes.find(({ id }) => id === from.id);
  if (target === undefined) return { reopened: null, by, note: `${identifier}'s team has no state ${from.name} any more, so it stays in ${found.state.name}` };
  // The move comes first, as `completeTicket`'s does: a comment that then fails leaves the ticket put back, and the next refresh finds nothing completed to undo.
  await setState(client, identifier, found.id, target.id, target.name);
  await postComment(client, identifier, found.id, comment);
  return { reopened: { from: target.name, to: found.state.name }, by, note: null };
}

async function updateTicketTextOf(client: Client, identifier: string, text: Readonly<{ title?: string; description?: string }>): Promise<void> {
  const found = await issue<{ id: string }>(client, identifier, "id");
  if (found === null) throw new Error(`Linear has no ticket ${identifier}`);
  const { issueUpdate }: { issueUpdate: { success: boolean } } = await query(client,
    "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", { id: found.id, input: text });
  if (!issueUpdate.success) throw new Error(`Linear did not update the text of ${identifier}`);
}

async function completeTicket(client: Client, identifier: string, comment: string): Promise<string | null> {
  const found = await issue<Stateful>(client, identifier, STATEFUL);
  if (found === null) throw new Error(`Linear has no ticket ${identifier}`);
  // A ticket already finished is left as it is, and gets no comment: whoever finished it has said what they meant.
  if (FINISHED_TYPES.has(found.state.type)) return null;
  // The completed state Linear lists first by position, when a team has more than one.
  const [target] = found.team.states.nodes.filter(({ type }) => type === "completed").sort((a, b) => a.position - b.position);
  if (target === undefined) return `${identifier}'s team has no completed state, so it stays in ${found.state.name}`;
  // The move comes first: if the comment then fails, the next refresh finds the ticket completed and does nothing, rather than posting the comment twice.
  await setState(client, identifier, found.id, target.id, target.name);
  await postComment(client, identifier, found.id, comment);
  return null;
}

/** Post `body` on the ticket `identifier`, in whatever state it is in (A11-173). */
async function commentOn(client: Client, identifier: string, body: string): Promise<void> {
  const found = await issue<{ id: string }>(client, identifier, "id");
  if (found === null) throw new Error(`Linear has no ticket ${identifier}`);
  await postComment(client, identifier, found.id, body);
}

type Claims = { comments: { nodes: { body: string; createdAt: string }[] } };

/**
 * The claimant the latest claim comment names, or undefined when the ticket has none. The latest is found by its time, not by the order Linear lists them in, and a
 * comment that starts with the words but names no claimant is no claim. PURE.
 */
export function latestClaimant({ comments }: Claims): string | undefined {
  const named = comments.nodes.flatMap(({ body, createdAt }) => {
    const claimant = body.startsWith(CLAIM_PREFIX) ? body.slice(CLAIM_PREFIX.length).trim() : "";
    return claimant === "" || /\s/.test(claimant) ? [] : [{ claimant, at: Date.parse(createdAt) }];
  });
  return named.sort((a, b) => b.at - a.at)[0]?.claimant;
}

/** Record that `claimant` holds the ticket, unless its latest claim already names them, so nine steps of one ticket make one comment. */
async function claimTicket(client: Client, identifier: string, claimant: string): Promise<void> {
  const found = await issue<{ id: string } & Claims>(client, identifier, `id ${CLAIMS}`);
  if (found === null) throw new Error(`Linear has no ticket ${identifier}`);
  if (latestClaimant(found) === claimant) return;
  await postComment(client, identifier, found.id, `${CLAIM_PREFIX}${claimant}`);
}

async function claimsOf(client: Client, keys: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const found = await eachIssue<Claims>(client, keys, CLAIMS);
  return new Map([...found].flatMap(([key, node]) => {
    const claimant = latestClaimant(node);
    return claimant === undefined ? [] : [[key, claimant] as const];
  }));
}

async function downloadTicket(client: Client, ticket: Ticket, dir: string): Promise<string[]> {
  const { key, request } = client;
  const linked = uploadLinks(ticket.description);
  const attached = (await attachedUploads(client, ticket.key)).filter(({ url }) => !linked.includes(url));
  const files = [...linked.map((url) => ({ url, title: null })), ...attached];
  const paths: string[] = [];
  for (const [index, { url, title }] of files.entries()) {
    const response = await request(url, { headers: { Authorization: key } });
    if (!response.ok) continue;
    const path = join(dir, downloadName(index + 1, url, title, response.headers.get("content-type") ?? ""));
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    paths.push(path);
  }
  return paths;
}

/**
 * Who holds the open tickets: each assignee with the count of their open tickets, and how many have none. Read a page at a time.
 */
async function peopleOf(client: Client): Promise<People> {
  const text = `query($after: String) { issues(first: ${PEOPLE_PAGE}, after: $after, filter: { ${OPEN} }) { nodes { assignee { id name } } pageInfo { hasNextPage endCursor } } }`;
  const held = new Map<string, { id: string; name: string; count: number }>();
  let unassigned = 0;
  let total = 0;
  let after: string | null = null;
  do {
    const answer: { issues: { nodes: { assignee: Assignee | null }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await query(client, text, { after });
    const { issues } = answer;
    for (const { assignee } of issues.nodes) {
      total += 1;
      if (assignee === null) unassigned += 1;
      else held.set(assignee.id, { id: assignee.id, name: assignee.name, count: (held.get(assignee.id)?.count ?? 0) + 1 });
    }
    after = issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null;
  } while (after !== null);
  return { people: [...held.values()], unassigned, total };
}

/** One page of a scope's tickets, with the cursor of the next. */
async function scopedPage(client: Client, scope: string, after: string | null): Promise<ScopePage> {
  const list = scopedQuery(scope);
  const { issues } = await query<{ issues: Connection }>(client, list.text, { ...list.variables, after });
  return { tickets: issues.nodes.map(toTicket), next: issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null };
}

export function linearSource({ key, fetch: request = fetch, pick = "assigned" }: { key: string; fetch?: Fetch; pick?: PickScope }): TicketSource {
  const client: Client = { key, request };
  return {
    keywords: KEYWORDS,

    async assigned() {
      return assignedTickets(client, pick);
    },

    people: () => peopleOf(client),

    scoped: (scope, after) => scopedPage(client, scope, after),

    async viewer() {
      return (await me(client)).name;
    },

    me: () => me(client),

    async read(identifier) {
      const found = await issue<IssueNode>(client, identifier, ISSUE_FIELDS);
      return found === null ? null : toTicket(found);
    },

    async stateTypes(keys) {
      const found = await eachIssue<{ state: { type: string } }>(client, keys, "state { type }");
      return new Map([...found].map(([key, node]) => [key, node.state.type]));
    },

    texts: (keys) => textsOf(client, keys),

    async detachPlan(identifier, titles) {
      return detachPlanOf(client, identifier, titles);
    },

    async pullStates(keys) {
      const found = await eachIssue<Attached>(client, keys, ATTACHED_PULLS);
      return new Map([...found].map(([key, node]) => [key, linkedPulls(node)]));
    },

    async addBlockers(identifier, blockerKeys) {
      return addBlockersTo(client, identifier, blockerKeys);
    },

    async blockers(keys) {
      return blockersOf(client, keys);
    },

    async projectSummaries(keys) {
      const found = await eachIssue<{ project: { summary: string | null } | null }>(client, keys, "project { summary: description }");
      return new Map([...found].flatMap(([key, node]) => (node.project === null ? [] : [[key, node.project.summary] as const])));
    },

    async attachPlan(identifier, files, state) {
      return attachPlanTo(client, identifier, files, state);
    },

    async moveToWorkingState(identifier, state) {
      return moveWorking(client, identifier, state);
    },

    restoreState: (identifier, move) => restoreStateOf(client, identifier, move),

    undoAutomaticCompletion: (identifier, comment) => undoAutomaticCompletionOf(client, identifier, comment),

    async updateTicketText(identifier, text) {
      return updateTicketTextOf(client, identifier, text);
    },

    async complete(identifier, comment) {
      return completeTicket(client, identifier, comment);
    },

    async comment(identifier, body) {
      return commentOn(client, identifier, body);
    },

    async claim(identifier, claimant) {
      return claimTicket(client, identifier, claimant);
    },

    async claims(keys) {
      return claimsOf(client, keys);
    },

    async download(ticket, dir) {
      return downloadTicket(client, ticket, dir);
    },
  };
}
