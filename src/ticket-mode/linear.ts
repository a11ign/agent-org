// @ts-check
// module: Linear as a ticket source -- GraphQL over an injected `fetch`, with a personal API key
//
// A PERSONAL KEY, NOT AN APP. A Linear agent app is installed by a workspace admin, which a person on a work account cannot do, so ticket mode reads
// as the person: their key, their assigned tickets. It writes only what a planning run hands the board: the plan's files, attached to the ticket,
// and the ticket's move to the planner's state. Workers write nothing. Linear's own GitHub integration links each pull request, because the
// worker's branch is the ticket's `branchName`.
//
// THE KEY NEVER LEAVES THIS MODULE. It is read once, from the macOS Keychain or a file the host file names, and sent only to api.linear.app and uploads.linear.app.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { KeySource } from "./settings.ts";
import type { Blocker, PullState, Ticket, TicketSource } from "./source.ts";

export const LINEAR_API = "https://api.linear.app/graphql";
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
const ISSUE_FIELDS = `identifier title description url branchName priority state { name position } team { key } project { name } parent { identifier } ${ATTACHMENTS}`;
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
    uploads: uploadsIn(node).map(({ title }) => title),
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
type Planning = { id: string; state: { type: string; name: string }; team: { states: { nodes: { id: string; name: string }[] } } } & Attachments;
/** Linear's answer to a request to upload a file: where to PUT it, with which headers, and the address it is then read from. */
type Upload = { fileUpload: { success: boolean; uploadFile: { uploadUrl: string; assetUrl: string; headers: { key: string; value: string }[] } | null } };

/** The state types a plan moves a ticket on from: new work only, never work already started back. */
const UNSTARTED = new Set(["backlog", "triage"]);

/** The name the `n`th download is saved as: its attachment title when that names a file, or else `attachment-<n>` and an extension. PURE. */
export function downloadName(n: number, link: string, title: string | null, contentType: string): string {
  if (title !== null && FILE_NAME.test(title)) return `attachment-${n}-${title}`;
  const extension = extname(new URL(link).pathname) || (contentType.startsWith("image/") ? `.${contentType.slice(6).split(";")[0]}` : "");
  return `attachment-${n}${extension}`;
}

export function linearSource({ key, fetch: request = fetch }: { key: string; fetch?: Fetch }): TicketSource {
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
    await query("mutation($issueId: String!, $url: String!, $title: String!) { attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) { success } }",
      { issueId, url: assetUrl, title });
  }

  /** The uploads attached to a ticket. */
  async function attachedUploads(identifier: string): Promise<{ url: string; title: string }[]> {
    const found = await issue<Attachments>(identifier, ATTACHMENTS);
    return found === null ? [] : uploadsIn(found);
  }

  return {
    async assigned() {
      const tickets: Ticket[] = [];
      let after: string | null = null;
      do {
        const data: { viewer: { assignedIssues: { nodes: IssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } } = await query(
          `query($after: String) { viewer { assignedIssues(first: ${PAGE}, after: $after, filter: { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }) {
            nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } } }`, { after });
        const page = data.viewer.assignedIssues;
        tickets.push(...page.nodes.map(toTicket));
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after !== null);
      return tickets;
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

    async blockers(keys) {
      // Linear stores "A blocks B" once, on A: B reads its blockers as the inverse relations of type `blocks`.
      type Related = { inverseRelations: { nodes: { type: string; issue: { identifier: string; state: { type: string; name: string } } & Attached }[] } };
      const found = await eachIssue<Related>(keys, `inverseRelations { nodes { type issue { identifier state { type name } ${ATTACHED_PULLS} } } }`);
      return new Map([...found].map(([key, node]) => [key, node.inverseRelations.nodes.filter(({ type }) => type === "blocks")
        .map(({ issue }): Blocker => ({ key: issue.identifier, state: issue.state.type, status: issue.state.name, pulls: linkedPulls(issue) }))]));
    },

    async attachPlan(identifier, files, state) {
      const found = await issue<Planning>(identifier, `id state { type name } team { states { nodes { id name } } } ${ATTACHMENTS}`);
      if (found === null) throw new Error(`Linear has no ticket ${identifier}`);
      const moves = state !== null && UNSTARTED.has(found.state.type);
      const target = moves ? found.team.states.nodes.find(({ name }) => name === state) : undefined;
      const attached = new Set(uploadsIn(found).map(({ title }) => title));
      for (const path of files) {
        const title = basename(path);
        if (!attached.has(title)) await attachFile(found.id, path, title);
      }
      // Teams name their states differently: a team without the planner's keeps the ticket's current state.
      if (moves && target === undefined) return `${identifier}'s team has no state named ${state}, so it stays in ${found.state.name}`;
      if (target !== undefined) await query("mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }", { id: found.id, stateId: target.id });
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
