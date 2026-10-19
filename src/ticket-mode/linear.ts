// @ts-check
// module: Linear as a ticket source -- GraphQL over an injected `fetch`, with a personal API key
//
// A PERSONAL KEY, NOT AN APP. A Linear agent app is installed by a workspace admin, which a person on a work account cannot do, so ticket mode reads
// as the person: their key, and by default the open tickets they can see, which the Pick view filters to their own (`tickets.pick` can narrow the list
// to a team or a project). It writes only what the board hands the tracker, each on a planning run's or a verified outcome's behalf or a person's: the
// plan's files, attached to the ticket, the ticket's move to the planner's state, a batch's order as "blocks" relations, once a run's pull request
// merged without closing its ticket or a worker verified its `done` (A11-91), the ticket's move to its completed state with a comment (A11-92), and,
// once a person applies a worker's proposed edit, the ticket's title and description (A11-91), and, once a person approves a draft a new-ticket run
// wrote, the ticket that draft becomes, with its project, goal, labels, relations and parent (`createTicket`, A11-94). Workers write nothing. Linear's
// own GitHub integration links each pull request, because the worker's branch is the ticket's `branchName`.
//
// THE KEY NEVER LEAVES THIS MODULE. It is read once, from the macOS Keychain or a file the host file names, and sent only to api.linear.app and uploads.linear.app.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { KeySource, PickScope } from "./settings.ts";
import type { Assignee, Blocker, Keywords, NewTicket, PullState, StateMove, Ticket, TicketLabel, TicketSource } from "./source.ts";

export const LINEAR_API = "https://api.linear.app/graphql";
/** The words Linear's GitHub integration reads in a pull request's body: `Closes` completes its ticket on merge, `Refs` only links it. */
const KEYWORDS: Keywords = Object.freeze({ closing: "Closes", nonClosing: "Refs" });
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
const ISSUE_FIELDS = `identifier title description url branchName priority state { name position } team { key } project { name } assignee { id name } parent { identifier } ${OPEN_CHILDREN} ${ATTACHMENTS} ${LABELS}`;
/** A file name that is safe as it stands: no folder, and an extension. A plan's attachment title is one. */
const FILE_NAME = /^[\w.-]+\.\w{1,8}$/;

type Fetch = typeof fetch;

/** The key, from where the host file says it lives. `security` prints the secret on stdout, which this returns and never logs. */
export function readLinearKey(source: KeySource, security: (args: string[]) => string = (args) => execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  read: (path: string) => string = (path) => readFileSync(path, "utf8")): string {
  let stored: string;
  try {
    stored = "keychain" in source ? security(["find-generic-password", "-s", source.keychain, "-w"]) : read(source.path);
  } catch {
    throw new Error("keychain" in source
      ? `ticket mode: no Linear key in the Keychain under ${source.keychain}. Store one with: security add-generic-password -a "$USER" -s ${source.keychain} -w`
      : `ticket mode: the Linear key file ${source.path} cannot be read`);
  }
  const key = stored.trim();
  if (key === "") throw new Error(`ticket mode: the Linear key at ${"keychain" in source ? `Keychain service ${source.keychain}` : source.path} is empty`);
  return key;
}

type IssueNode = {
  identifier: string; title: string; description: string | null; url: string; branchName: string; priority: number;
  state: { name: string; position: number }; team: { key: string }; project: { name: string } | null; assignee: Assignee | null; parent: { identifier: string } | null;
  /** Absent from an answer to a query that did not ask for it: such a ticket is read as having none. */
  children?: { nodes: { identifier: string }[] };
  /** Absent from an answer to a query that did not ask for them: such a ticket is read as having none. */
  labels?: { nodes: { name: string; parent: { name: string } | null }[] };
} & Attachments;

type Attachments = { attachments?: { nodes: { url: string; title: string }[] } };

/** A ticket this module has just created, read back with its id. */
type CreatedIssue = IssueNode & { id: string };

/**
 * The attachments that are uploads, as Linear lists them beside a ticket's description; a link to elsewhere, such as a pull request, is left out.
 * Anchored at the upload origin, because every download carries the key: a link that only mentions an upload goes somewhere else. PURE.
 */
const uploadsIn = (node: Attachments): { url: string; title: string }[] => (node.attachments?.nodes ?? []).filter(({ url }) => url.startsWith(UPLOAD_ORIGIN));

function toTicket(node: IssueNode): Ticket {
  return Object.freeze({
    key: node.identifier, title: node.title, description: node.description ?? "", url: node.url, branch: node.branchName,
    status: node.state.name, statusOrder: node.state.position, team: node.team.key, project: node.project?.name ?? null, priority: node.priority,
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
type Attached = { attachments: { nodes: { url: string; sourceType: string; metadata: { status?: string } | null }[] } };
const ATTACHED_PULLS = "attachments { nodes { url sourceType metadata } }";

/** The state of each pull request a ticket links, by URL. Its other links, such as an upload, are left out. PURE. */
function linkedPulls(node: Attached): Record<string, PullState> {
  return Object.fromEntries(node.attachments.nodes.filter(({ sourceType }) => sourceType === "github").map(({ url, metadata }) => [url, pullState(metadata?.status)]));
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
 * Every open ticket the key can see, or, for a team or a project, every open ticket of it: one `issues` list, paged a page at a time, whose
 * tickets carry their assignee. The Pick view picks the assignee in the page, so one read serves every choice and no request is made per person.
 * The team or the project is passed as a variable, never written into the query's text.
 */
export function pickQuery(scope: PickScope): PickQuery {
  const narrowed = scope === "assigned" ? null
    : "team" in scope ? { name: "team", filter: "team: { key: { eq: $team } }", value: scope.team }
    : { name: "project", filter: "project: { name: { eq: $project } }", value: scope.project };
  const declared = narrowed === null ? "" : `, $${narrowed.name}: String!`;
  const filters = [...(narrowed === null ? [] : [narrowed.filter]), OPEN].join(", ");
  return {
    text: `query($after: String${declared}) { issues(first: ${PAGE}, after: $after, filter: { ${filters} }) {
            nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
    variables: narrowed === null ? {} : { [narrowed.name]: narrowed.value },
    page: (data) => (data as { issues: Connection }).issues,
  };
}

/** The seams every call to Linear goes through: the key, which goes only to Linear, and the `fetch` that sends it. */
type Client = Readonly<{ key: string; request: Fetch }>;

async function query<T>(client: Client, text: string, variables: Record<string, unknown>): Promise<T> {
  const { key, request } = client;
  const response = await request(LINEAR_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query: text, variables }),
  });
  const body = await response.json().catch(() => null) as { data?: T; errors?: { message: string }[] } | null;
  if (!response.ok || body === null || body.errors?.length) {
    throw new Error(`Linear answered ${response.status}: ${body?.errors?.map((e) => e.message).join("; ") ?? "no JSON"}`);
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

/**
 * The team a new ticket goes in, by its key: the one named, else the team of the project named when that project is in exactly one team, else the
 * only team the key's user is on. Null when none of those says, so the board refuses and names the team it needs.
 */
async function newTicketTeam(client: Client, named: string | null, project: string | null, mine: readonly { key: string }[]): Promise<string | null> {
  if (named !== null) return named;
  if (project !== null) {
    const { projects }: { projects: { nodes: { teams: { nodes: { key: string }[] } }[] } } = await query(client,
      "query($name: String!) { projects(filter: { name: { eq: $name } }) { nodes { teams { nodes { key } } } } }", { name: project });
    const keys = new Set(projects.nodes.flatMap(({ teams }) => teams.nodes.map(({ key: teamKey }) => teamKey)));
    if (keys.size === 1) return [...keys][0];
  }
  return mine.length === 1 ? mine[0].key : null;
}

/** The id of a label `name` that the team `team` may use: its own label, else the workspace's. Null when there is none of that name. */
const labelIdIn = (labels: readonly { id: string; name: string; team: { key: string } | null }[], name: string, team: string): string | null => {
  const named = labels.filter((label) => label.name === name);
  return (named.find((label) => label.team?.key === team) ?? named.find((label) => label.team === null))?.id ?? null;
};

/**
 * Create the ticket: `issueCreate` with the draft's own id, so a creation the tracker already made (answered "already exists") is read back as made, and
 * never made twice. Anything else the tracker refuses is thrown.
 */
async function createIssue(client: Client, input: Record<string, unknown>): Promise<CreatedIssue> {
  try {
    const { issueCreate } = await query<{ issueCreate: { success: boolean; issue: CreatedIssue | null } }>(client,
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id ${ISSUE_FIELDS} } } }`, { input });
    if (!issueCreate.success || issueCreate.issue === null) throw new Error(`Linear did not create ${String(input.title)}`);
    return issueCreate.issue;
  } catch (err) {
    const { issue } = await query<{ issue: CreatedIssue | null }>(client, `query($id: String!) { issue(id: $id) { id ${ISSUE_FIELDS} } }`, { id: input.id }).catch(() => ({ issue: null }));
    if (issue !== null) return issue;
    throw err;
  }
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
  if (!put.ok) throw new Error(`the upload of ${title} was refused (${put.status})`);
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
    .map(({ issue }): Blocker => ({ key: issue.identifier, state: issue.state.type, status: issue.state.name, branch: issue.branchName, pulls: linkedPulls(issue) }))]));
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

async function createTicketIn(client: Client, input: NewTicket): Promise<Readonly<{ ticket: Ticket; warnings: readonly string[] }>> {
  const { viewer } = await query<{ viewer: { id: string; teams: { nodes: { key: string }[] } } }>(client, "query { viewer { id teams { nodes { key } } } }", {});
  const teamKey = await newTicketTeam(client, input.team, input.project, viewer.teams.nodes);
  if (teamKey === null) throw new Error("name a team: none of the draft, its parent, tickets.pick, its project or your own teams names exactly one");
  // Everything a ticket names is resolved first, so a name that does not resolve creates nothing.
  const names = [...new Set([...(input.goal === null ? [] : [input.goal]), ...input.labels])];
  const { teams }: { teams: { nodes: { id: string; key: string; named: { nodes: { id: string }[] }; known: { nodes: { name: string }[] } }[] } } = await query(client,
    `query($key: String!, $project: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key named: projects(filter: { name: { eq: $project } }) { nodes { id } } known: projects(first: 8) { nodes { name } } } } }`,
    { key: teamKey, project: input.project ?? "" });
  const [team] = teams.nodes;
  if (team === undefined) throw new Error(`Linear has no team ${teamKey}`);
  let projectId: string | undefined;
  if (input.project !== null) {
    projectId = team.named.nodes[0]?.id;
    if (projectId === undefined) throw new Error(`${teamKey} has no project named ${input.project}; its projects are ${team.known.nodes.map(({ name }) => name).join(", ") || "none"}`);
  }
  const { issueLabels }: { issueLabels: { nodes: { id: string; name: string; team: { key: string } | null; parent: { name: string } | null }[] } } = await query(client,
    "query($names: [String!]!) { issueLabels(first: 250, filter: { name: { in: $names } }) { nodes { id name team { key } parent { name } } } }", { names });
  const labelIds = input.labels.map((name) => {
    const id = labelIdIn(issueLabels.nodes, name, teamKey);
    if (id === null) throw new Error(`${teamKey} has no label named ${name}`);
    return id;
  });
  if (input.goal !== null) {
    const goal = issueLabels.nodes.find((label) => label.name === input.goal && label.parent?.name === "Goal");
    if (goal === undefined) throw new Error(`${input.goal} is not a label in the group Goal`);
    labelIds.push(goal.id);
  }
  const parent = input.parent === null ? null : await issue<{ id: string }>(client, input.parent, "id");
  if (input.parent !== null && parent === null) throw new Error(`Linear has no ticket ${input.parent}`);
  const relations = [...input.blocks.map((key) => ({ key, blocked: true })), ...input.blockedBy.map((key) => ({ key, blocked: false }))];
  const related = await eachIssue<{ id: string }>(client, relations.map(({ key }) => key), "id");
  const missing = relations.find(({ key }) => !related.has(key));
  if (missing !== undefined) throw new Error(`Linear has no ticket ${missing.key}`);
  const created = await createIssue(client, {
    id: input.id, teamId: team.id, title: input.title, description: input.description, priority: input.priority, assigneeId: viewer.id,
    ...(projectId === undefined ? {} : { projectId }), ...(parent === null ? {} : { parentId: parent.id }), ...(labelIds.length === 0 ? {} : { labelIds }),
  });
  // A relation that fails after the ticket exists is a warning, shown on the board: the ticket is not made again to retry it.
  const warnings: string[] = [];
  for (const { key, blocked } of relations) {
    const other = related.get(key)?.id ?? "";
    const [issueId, relatedIssueId] = blocked ? [created.id, other] : [other, created.id];
    const { issueRelationCreate } = await query<{ issueRelationCreate: { success: boolean } }>(client,
      "mutation($issueId: String!, $relatedIssueId: String!) { issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: blocks }) { success } }",
      { issueId, relatedIssueId }).catch(() => ({ issueRelationCreate: { success: false } }));
    if (!issueRelationCreate.success) warnings.push(blocked ? `${created.identifier} was created, but it did not block ${key}` : `${created.identifier} was created, but ${key} did not block it`);
  }
  return { ticket: toTicket(created), warnings };
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

export function linearSource({ key, fetch: request = fetch, pick = "assigned" }: { key: string; fetch?: Fetch; pick?: PickScope }): TicketSource {
  const client: Client = { key, request };
  return {
    keywords: KEYWORDS,

    async assigned() {
      return assignedTickets(client, pick);
    },

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

    async attachPlan(identifier, files, state) {
      return attachPlanTo(client, identifier, files, state);
    },

    async moveToWorkingState(identifier, state) {
      return moveWorking(client, identifier, state);
    },

    async restoreState(identifier, move) {
      return restoreStateOf(client, identifier, move);
    },

    async updateTicketText(identifier, text) {
      return updateTicketTextOf(client, identifier, text);
    },

    async complete(identifier, comment) {
      return completeTicket(client, identifier, comment);
    },

    async createTicket(input: NewTicket) {
      return createTicketIn(client, input);
    },

    async download(ticket, dir) {
      return downloadTicket(client, ticket, dir);
    },
  };
}
