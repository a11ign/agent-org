// @ts-check
// module: Linear as a ticket source -- GraphQL over an injected `fetch`, with a personal API key
//
// A PERSONAL KEY, NOT AN APP. A Linear agent app is installed by a workspace admin, which a person on a work account cannot do, so ticket mode reads
// as the person: their key, and by default their assigned tickets (`tickets.pick` can widen the list to a team or a project). It writes only what the
// board hands the tracker, each on a planning run's or a verified outcome's behalf or a person's: the plan's files, attached to the ticket, the
// ticket's move to the planner's state, a batch's order as "blocks" relations, once a run's pull request merged without closing its ticket or a worker
// verified its `done` (A11-91), the ticket's move to its completed state with a comment (A11-92), and, once a person applies a worker's proposed edit,
// the ticket's title and description (A11-91). Workers write nothing. Linear's own GitHub integration links each pull request, because the
// worker's branch is the ticket's `branchName`.
//
// THE KEY NEVER LEAVES THIS MODULE. It is read once, from the macOS Keychain or a file the host file names, and sent only to api.linear.app and uploads.linear.app.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { KeySource, PickScope } from "./settings.ts";
import type { Blocker, Keywords, PullState, StateMove, Ticket, TicketLabel, TicketSource } from "./source.ts";

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
const ISSUE_FIELDS = `identifier title description url branchName priority state { name position } team { key } project { name } parent { identifier } ${OPEN_CHILDREN} ${ATTACHMENTS} ${LABELS}`;
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
  state: { name: string; position: number }; team: { key: string }; project: { name: string } | null; parent: { identifier: string } | null;
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
    key: node.identifier, title: node.title, description: node.description ?? "", url: node.url, branch: node.branchName,
    status: node.state.name, statusOrder: node.state.position, team: node.team.key, project: node.project?.name ?? null, priority: node.priority,
    parent: node.parent?.identifier ?? null,
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
 * `"assigned"` is the query the board has always sent, kept as it was, character for character: a machine that names no `tickets.pick` asks
 * Linear exactly what it asked before the setting existed, but for the fields every list reads, which grew each ticket's open sub-issues (A11-76) and then its labels with their groups. A team or a project reads `issues` with that team's key or that project's name added
 * to the same state filter, a page of the same size at a time. Both are passed as variables, never written into the query's text.
 */
export function pickQuery(scope: PickScope): PickQuery {
  if (scope === "assigned") {
    return {
      text: `query($after: String) { viewer { assignedIssues(first: ${PAGE}, after: $after, filter: { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }) {
            nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } } }`,
      variables: {},
      page: (data) => (data as { viewer: { assignedIssues: Connection } }).viewer.assignedIssues,
    };
  }
  const [name, type, filter] = "team" in scope
    ? ["team", "String!", "team: { key: { eq: $team } }"] as const : ["project", "String!", "project: { name: { eq: $project } }"] as const;
  return {
    text: `query($after: String, $${name}: ${type}) { issues(first: ${PAGE}, after: $after, filter: { ${filter}, ${OPEN} }) {
            nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
    variables: { [name]: "team" in scope ? scope.team : scope.project },
    page: (data) => (data as { issues: Connection }).issues,
  };
}

export function linearSource({ key, fetch: request = fetch, pick = "assigned" }: { key: string; fetch?: Fetch; pick?: PickScope }): TicketSource {
  async function query<T>(text: string, variables: Record<string, unknown>): Promise<T> {
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
  async function issue<T>(identifier: string, fields: string): Promise<T | null> {
    const parts = TICKET_KEY.exec(identifier);
    if (parts === null) return null;
    const data: { issues: { nodes: T[] } } = await query(
      `query($team: String!, $number: Float!) { issues(first: 1, filter: { team: { key: { eq: $team } }, number: { eq: $number } }) { nodes { ${fields} } } }`,
      { team: parts[1].toUpperCase(), number: Number(parts[2]) });
    return data.issues.nodes[0] ?? null;
  }

  /** `fields` of each ticket `keys` names, by key, in one request per batch, each key an aliased read by team and number as `issue` does it. */
  async function eachIssue<T>(keys: readonly string[], fields: string): Promise<Map<string, T>> {
    const found = new Map<string, T>();
    const parsed = keys.map((key) => [key, TICKET_KEY.exec(key)] as const).filter((pair): pair is readonly [string, RegExpExecArray] => pair[1] !== null);
    for (let start = 0; start < parsed.length; start += STATE_BATCH) {
      const batch = parsed.slice(start, start + STATE_BATCH);
      const params = batch.map((_, i) => `$t${i}: String!, $n${i}: Float!`).join(", ");
      const reads = batch.map((_, i) => `k${i}: issues(first: 1, filter: { team: { key: { eq: $t${i} } }, number: { eq: $n${i} } }) { nodes { ${fields} } }`).join(" ");
      const variables = Object.fromEntries(batch.flatMap(([, parts], i) => [[`t${i}`, parts[1].toUpperCase()], [`n${i}`, Number(parts[2])]]));
      const data: Record<string, { nodes: T[] }> = await query(`query(${params}) { ${reads} }`, variables);
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
  async function moveTo(identifier: string, found: Stateful, state: string, from: ReadonlySet<string>): Promise<Readonly<{ moved: StateMove | null; note: string | null }>> {
    if (!from.has(found.state.type)) return { moved: null, note: null };
    const target = found.team.states.nodes.find(({ name }) => name === state);
    if (target === undefined) return { moved: null, note: `${identifier}'s team has no state named ${state}, so it stays in ${found.state.name}` };
    await setState(identifier, found.id, target.id, state);
    return { moved: { from: found.state.name, to: state }, note: null };
  }

  /** Set the ticket `id` to the state `stateId`, which is named `state` for the error that says so. */
  async function setState(identifier: string, id: string, stateId: string, state: string): Promise<void> {
    const { issueUpdate }: { issueUpdate: { success: boolean } } = await query(
      "mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }", { id, stateId });
    // Linear can answer a mutation it did not carry out with success false and no error, so the answer is read, not assumed.
    if (!issueUpdate.success) throw new Error(`Linear did not move ${identifier} to ${state}`);
  }

  /** Post `body` as a comment on the ticket `id`, which is named `identifier` for the error that says so. */
  async function postComment(identifier: string, id: string, body: string): Promise<void> {
    const { commentCreate }: { commentCreate: { success: boolean } } = await query(
      "mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }", { issueId: id, body });
    if (!commentCreate.success) throw new Error(`Linear did not post a comment on ${identifier}`);
  }

  /** Upload the markdown file at `path` and attach it to the ticket `issueId` under `title`. */
  async function attachFile(issueId: string, path: string, title: string): Promise<void> {
    const body = readFileSync(path);
    const { fileUpload }: Upload = await query(
      "mutation($contentType: String!, $filename: String!, $size: Int!) { fileUpload(contentType: $contentType, filename: $filename, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }",
      { contentType: "text/markdown", filename: title, size: body.length });
    if (!fileUpload.success || fileUpload.uploadFile === null) throw new Error(`Linear would not take the upload of ${title}`);
    const { uploadUrl, assetUrl, headers } = fileUpload.uploadFile;
    // The file goes to the storage address Linear signed, without the key: the signature is the permission.
    const put = await request(uploadUrl, { method: "PUT", body, headers: { "Content-Type": "text/markdown", "Cache-Control": "public, max-age=31536000",
      ...Object.fromEntries(headers.map(({ key: name, value }) => [name, value])) } });
    if (!put.ok) throw new Error(`the upload of ${title} was refused (${put.status})`);
    const { attachmentCreate }: { attachmentCreate: { success: boolean } } = await query(
      "mutation($issueId: String!, $url: String!, $title: String!) { attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) { success } }",
      { issueId, url: assetUrl, title });
    if (!attachmentCreate.success) throw new Error(`Linear did not attach ${title}`);
  }

  /** The uploads attached to a ticket. */
  async function attachedUploads(identifier: string): Promise<{ url: string; title: string }[]> {
    const found = await issue<Attachments>(identifier, ATTACHMENTS);
    return found === null ? [] : uploadsIn(found);
  }

  return {
    keywords: KEYWORDS,

    async assigned() {
      const list = pickQuery(pick);
      const tickets: Ticket[] = [];
      let after: string | null = null;
      do {
        const page = list.page(await query<unknown>(list.text, { ...list.variables, after }));
        tickets.push(...page.nodes.map(toTicket));
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after !== null);
      return tickets;
    },

    async viewer() {
      const { viewer }: { viewer: { name: string | null; email: string | null } } = await query("query { viewer { name email } }", {});
      return viewer.name || viewer.email || "the key's user";
    },

    async read(identifier) {
      const found = await issue<IssueNode>(identifier, ISSUE_FIELDS);
      return found === null ? null : toTicket(found);
    },

    async stateTypes(keys) {
      const found = await eachIssue<{ state: { type: string } }>(keys, "state { type }");
      return new Map([...found].map(([key, node]) => [key, node.state.type]));
    },

    async pullStates(keys) {
      const found = await eachIssue<Attached>(keys, ATTACHED_PULLS);
      return new Map([...found].map(([key, node]) => [key, linkedPulls(node)]));
    },

    async addBlockers(identifier, blockerKeys) {
      type Blocked = { id: string; inverseRelations: { nodes: { type: string; issue: { identifier: string } }[] } };
      const found = await issue<Blocked>(identifier, "id inverseRelations { nodes { type issue { identifier } } }");
      if (found === null) throw new Error(`Linear has no ticket ${identifier}`);
      const already = new Set(found.inverseRelations.nodes.filter(({ type }) => type === "blocks").map(({ issue: blocker }) => blocker.identifier));
      const missing = [...new Set(blockerKeys)].filter((key) => !already.has(key));
      if (missing.length === 0) return;
      const ids = await eachIssue<{ id: string }>(missing, "id");
      for (const key of missing) {
        const blocker = ids.get(key);
        if (blocker === undefined) throw new Error(`Linear has no ticket ${key}`);
        // "A blocks B" is stored on A, with B as the related issue: the same relation `blockers` reads back from B.
        const { issueRelationCreate }: { issueRelationCreate: { success: boolean } } = await query(
          "mutation($issueId: String!, $relatedIssueId: String!) { issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: blocks }) { success } }",
          { issueId: blocker.id, relatedIssueId: found.id });
        if (!issueRelationCreate.success) throw new Error(`Linear did not record that ${key} blocks ${identifier}`);
      }
    },

    async blockers(keys) {
      // Linear stores "A blocks B" once, on A: B reads its blockers as the inverse relations of type `blocks`.
      type Related = { inverseRelations: { nodes: { type: string; issue: { identifier: string; branchName: string; state: { type: string; name: string } } & Attached }[] } };
      const found = await eachIssue<Related>(keys, `inverseRelations { nodes { type issue { identifier branchName state { type name } ${ATTACHED_PULLS} } } }`);
      return new Map([...found].map(([key, node]) => [key, node.inverseRelations.nodes.filter(({ type }) => type === "blocks")
        .map(({ issue }): Blocker => ({ key: issue.identifier, state: issue.state.type, status: issue.state.name, branch: issue.branchName, pulls: linkedPulls(issue) }))]));
    },

    async attachPlan(identifier, files, state) {
      const found = await issue<Planning>(identifier, `${STATEFUL} ${ATTACHMENTS}`);
      if (found === null) throw new Error(`Linear has no ticket ${identifier}`);
      const attached = new Set(uploadsIn(found).map(({ title }) => title));
      for (const path of files) {
        const title = basename(path);
        if (!attached.has(title)) await attachFile(found.id, path, title);
      }
      return state === null ? null : (await moveTo(identifier, found, state, BEFORE_PLANNING)).note;
    },

    async moveToWorkingState(identifier, state) {
      const found = await issue<Stateful>(identifier, STATEFUL);
      if (found === null) throw new Error(`Linear has no ticket ${identifier}`);
      return moveTo(identifier, found, state, BEFORE_WORK);
    },

    async restoreState(identifier, move) {
      const found = await issue<Stateful>(identifier, STATEFUL);
      // A ticket Linear no longer has has nothing to put back, and must not hold its run on the board for ever.
      if (found === null) return `Linear has no ticket ${identifier}, so nothing was put back to ${move.from}`;
      // Only while the ticket is still where the board put it: a person who has moved it since has moved it on, and that is theirs to keep.
      if (found.state.name !== move.to) return null;
      const target = found.team.states.nodes.find(({ name }) => name === move.from);
      if (target === undefined) return `${identifier}'s team has no state named ${move.from}, so it stays in ${found.state.name}`;
      await setState(identifier, found.id, target.id, move.from);
      return null;
    },

    async updateTicketText(identifier, text) {
      const found = await issue<{ id: string }>(identifier, "id");
      if (found === null) throw new Error(`Linear has no ticket ${identifier}`);
      const { issueUpdate }: { issueUpdate: { success: boolean } } = await query(
        "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", { id: found.id, input: text });
      if (!issueUpdate.success) throw new Error(`Linear did not update the text of ${identifier}`);
    },

    async complete(identifier, comment) {
      const found = await issue<Stateful>(identifier, STATEFUL);
      if (found === null) throw new Error(`Linear has no ticket ${identifier}`);
      // A ticket already finished is left as it is, and gets no comment: whoever finished it has said what they meant.
      if (FINISHED_TYPES.has(found.state.type)) return null;
      // The completed state Linear lists first by position, when a team has more than one.
      const [target] = found.team.states.nodes.filter(({ type }) => type === "completed").sort((a, b) => a.position - b.position);
      if (target === undefined) return `${identifier}'s team has no completed state, so it stays in ${found.state.name}`;
      // The move comes first: if the comment then fails, the next refresh finds the ticket completed and does nothing, rather than posting the comment twice.
      await setState(identifier, found.id, target.id, target.name);
      await postComment(identifier, found.id, comment);
      return null;
    },

    async download(ticket, dir) {
      const linked = uploadLinks(ticket.description);
      const attached = (await attachedUploads(ticket.key)).filter(({ url }) => !linked.includes(url));
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
    },
  };
}
