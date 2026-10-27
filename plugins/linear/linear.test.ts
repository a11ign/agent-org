// no-token: gh -- `fetch` and `security` are injected; nothing reaches Linear or the Keychain
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../../src/lib/tmp-fixture.ts";
import type { Ticket } from "../../src/plugins/contracts/tracker.ts";
import { LINEAR_API, completionOf, downloadName, linearSource, pickQuery, scopedQuery, pullState, uploadLinks } from "./linear.ts";

const node = (identifier: string, extra: Record<string, unknown> = {}) => ({
  identifier, title: `Title ${identifier}`, description: null, url: `https://linear.app/x/issue/${identifier}`, branchName: identifier.toLowerCase(),
  priority: 2, state: { name: "Backlog", position: 0 }, team: { key: identifier.split("-")[0] }, project: { name: "Visual Explorer - GA" }, parent: null, ...extra,
});
/** Linear's answer to the read of a ticket's attachments. */
const attached = (...nodes: { url: string; title: string }[]) => ({ data: { issues: { nodes: [{ attachments: { nodes } }] } } });

/** The GraphQL request a recorded call sent, read back as its query and variables. */
const queried = (requests: { init: RequestInit }[]): { query: string; variables: Record<string, unknown> } => JSON.parse(String(requests[0].init.body));

/** A Linear that answers GraphQL from `pages` in order, and recording every request. */
function linear(pages: unknown[], uploads: Record<string, { status: number; body?: string; type?: string }> = {}) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    requests.push({ url, init });
    if (url === LINEAR_API) return new Response(JSON.stringify(pages.shift()), { status: 200 });
    const upload = uploads[url] ?? { status: 404 };
    return new Response(upload.body ?? "", { status: upload.status, headers: { "content-type": upload.type ?? "image/png" } });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

test("assigned() reads every page of the key's own open tickets, each with its assignee, sending the key and nothing else", async () => {
  const { fetch, requests } = linear([
    { data: { viewer: { assignedIssues: { nodes: [node("NBF-1"), node("VE-2", { project: null })], pageInfo: { hasNextPage: true, endCursor: "c1" } } } } },
    { data: { viewer: { assignedIssues: { nodes: [node("NBF-3")], pageInfo: { hasNextPage: false, endCursor: null } } } } },
  ]);
  const tickets = await linearSource({ key: "lin_api_secret", fetch }).assigned();
  assert.deepEqual(tickets.map((t) => t.key), ["NBF-1", "VE-2", "NBF-3"]);
  assert.equal(tickets[1].project, null);
  assert.equal(tickets[0].branch, "nbf-1", "the branch Linear links a pull request by");
  assert.equal(requests.length, 2);
  assert.equal((requests[0].init.headers as Record<string, string>).Authorization, "lin_api_secret");
  const second = JSON.parse(String(requests[1].init.body));
  assert.equal(second.variables.after, "c1", "the second page starts where the first ended");
  assert.match(second.query, /nin: \["completed", "canceled", "duplicate"\]/, "finished tickets are not offered, nor duplicates, which Linear types on their own");
  assert.ok(queried(requests).query.includes("viewer { assignedIssues"), "the key's own tickets: a workspace's every open ticket is too large to list (A11-108)");
});

test("A11-108: each ticket names its assignee, read with the list, and an unassigned ticket has a null assignee", async () => {
  const { fetch, requests } = linear([{ data: { viewer: { assignedIssues: { nodes: [
    node("NBF-1", { assignee: { id: "u-1", name: "Dan Beck" } }),
    node("NBF-2", { assignee: null }),
    node("NBF-3"),
  ], pageInfo: { hasNextPage: false, endCursor: null } } } } }]);
  const [assigned, nobody, unread] = await linearSource({ key: "k", fetch }).assigned();
  assert.deepEqual(assigned.assignee, { id: "u-1", name: "Dan Beck" });
  assert.equal(nobody.assignee, null, "a ticket nobody has been given is unassigned");
  assert.equal(unread.assignee, null, "an answer that names no assignee reads as unassigned");
  assert.equal(requests.length, 1, "read with the list, not one request per ticket");
  assert.ok(queried(requests).query.includes("assignee { id name }"), "the assignee is asked for in the list's own request");
});

test("each ticket names the files uploaded to it, read in the same request as the list, and not its other links, such as a pull request", async () => {
  const { fetch, requests } = linear([{ data: { viewer: { assignedIssues: { nodes: [
    node("NBF-1", { attachments: { nodes: [
      { url: "https://uploads.linear.app/org/a/plan", title: "NBF-1-0001-plan-fit-to-view.md" },
      { url: "https://github.com/netboxlabs/nbl-ui-netbox/pull/1", title: "feat: fit to view" },
    ] } }),
    node("NBF-2"),
  ], pageInfo: { hasNextPage: false, endCursor: null } } } } }]);
  const [one, two] = await linearSource({ key: "k", fetch }).assigned();
  assert.deepEqual(one.uploads, ["NBF-1-0001-plan-fit-to-view.md"]);
  assert.deepEqual(two.uploads, [], "a ticket with nothing attached has no uploads");
  assert.equal(requests.length, 1, "read with the list, not one request per ticket");
});

test("A11-76: each ticket carries its open sub-issues, read with the list in the same request, counting none finished, canceled or a duplicate", async () => {
  const { fetch, requests } = linear([{ data: { viewer: { assignedIssues: { nodes: [
    node("A11-24", { children: { nodes: [{ identifier: "A11-25" }, { identifier: "A11-26" }] } }),
    node("A11-30", { children: { nodes: [] } }),
    node("A11-31"),
  ], pageInfo: { hasNextPage: false, endCursor: null } } } } }]);
  const [epic, done, unread] = await linearSource({ key: "k", fetch }).assigned();
  assert.deepEqual(epic.children, ["A11-25", "A11-26"], "a parent names its open sub-issues, so the board counts them");
  assert.deepEqual(done.children, [], "an epic whose sub-issues are all done or canceled has none open, and is an ordinary ticket again");
  assert.deepEqual(unread.children, [], "an answer that holds no children reads as none");
  assert.equal(requests.length, 1, "read with the list, not one request per ticket");
  const { query } = JSON.parse(String(requests[0].init.body));
  assert.ok(query.includes('children(first: 50, filter: { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }) { nodes { identifier } }'),
    "Linear filters the sub-issues by their state's type, as the list itself is filtered");
  const read = linear([{ data: { issues: { nodes: [node("A11-24", { children: { nodes: [{ identifier: "A11-25" }] } })] } } }]);
  assert.deepEqual((await linearSource({ key: "k", fetch: read.fetch }).read("A11-24"))?.children, ["A11-25"], "a ticket read by key carries them too");
});

test("each ticket carries its labels, each with its label group, read with the list in the same request; a label with no group has a null group", async () => {
  const { fetch, requests } = linear([{ data: { viewer: { assignedIssues: { nodes: [
    node("A11-40", { labels: { nodes: [{ name: "Fleet", parent: { name: "Goal" } }, { name: "Bug", parent: null }] } }),
    node("A11-41", { labels: { nodes: [] } }),
    node("A11-42"),
  ], pageInfo: { hasNextPage: false, endCursor: null } } } } }]);
  const [labelled, bare, unread] = await linearSource({ key: "k", fetch }).assigned();
  assert.deepEqual(labelled.labels, [{ name: "Fleet", group: "Goal" }, { name: "Bug", group: null }], "a child label names its group; a label on its own names none");
  assert.deepEqual(bare.labels, [], "a ticket with no labels has none");
  assert.deepEqual(unread.labels, [], "an answer that holds no labels reads as none");
  assert.equal(requests.length, 1, "read with the list, not one request per ticket");
  assert.ok(JSON.parse(String(requests[0].init.body)).query.includes("labels(first: 50) { nodes { name parent { name } } }"), "each label's group is its parent label");
  const read = linear([{ data: { issues: { nodes: [node("A11-40", { labels: { nodes: [{ name: "Ticket mode", parent: { name: "Goal" } }] } })] } } }]);
  assert.deepEqual((await linearSource({ key: "k", fetch: read.fetch }).read("A11-40"))?.labels, [{ name: "Ticket mode", group: "Goal" }], "a ticket read by key carries them too");
});

test("read() finds a ticket by its team and number, returns null for a key Linear has no ticket for, and throws when Linear cannot be asked", async () => {
  const found = linear([{ data: { issues: { nodes: [node("NBF-1270")] } } }]);
  assert.equal((await linearSource({ key: "k", fetch: found.fetch }).read("NBF-1270"))?.title, "Title NBF-1270");
  assert.deepEqual(JSON.parse(String(found.requests[0].init.body)).variables, { team: "NBF", number: 1270 });
  assert.equal(await linearSource({ key: "k", fetch: linear([{ data: { issues: { nodes: [] } } }]).fetch }).read("NBF-0"), null);
  const unasked = linear([]);
  assert.equal(await linearSource({ key: "k", fetch: unasked.fetch }).read("not a key"), null);
  assert.equal(unasked.requests.length, 0, "a string that is not a key is not sent");
  await assert.rejects(linearSource({ key: "k", fetch: linear([{ errors: [{ message: "Authentication required" }] }]).fetch }).read("NBF-1"), /Authentication required/);
});

test("a ticket carries its parent's key, and null when it has none", async () => {
  const { fetch } = linear([{ data: { issues: { nodes: [node("VE-65", { parent: { identifier: "NBF-1917" } })] } } }, { data: { issues: { nodes: [node("NBF-1917")] } } }]);
  const tracker = linearSource({ key: "k", fetch });
  assert.equal((await tracker.read("VE-65"))?.parent, "NBF-1917");
  assert.equal((await tracker.read("NBF-1917"))?.parent, null);
});

test("download() fetches each Linear upload the description links to, with the key, and skips one that will not load", async () => {
  const a = "https://uploads.linear.app/org/a/one";
  const b = "https://uploads.linear.app/org/b/two.jpg";
  const ticket = { key: "NBF-1", description: `![one](${a}) text ![two](${b}) again ${a} and https://example.com/not-ours.png` } as Ticket;
  assert.deepEqual(uploadLinks(ticket.description), [a, b], "each upload once, in order, and only Linear's");
  const { fetch, requests } = linear([attached()], { [a]: { status: 200, body: "PNG", type: "image/png" }, [b]: { status: 403 } });
  const dir = tmpDir("ticket-linear-download-");
  const paths = await linearSource({ key: "k", fetch }).download(ticket, dir);
  assert.equal(paths.length, 1);
  assert.match(paths[0], /attachment-1\.png$/);
  assert.equal(readFileSync(paths[0], "utf8"), "PNG");
  assert.ok(!existsSync(`${dir}/attachment-2.jpg`));
  assert.ok(requests.every(({ init }) => (init.headers as Record<string, string>).Authorization === "k"), "uploads are only readable with the key");
});

test("download() also fetches the uploads attached to the ticket, after the description's, and never sends the key off Linear", async () => {
  const inline = "https://uploads.linear.app/org/a/inline";
  const plan = "https://uploads.linear.app/org/b/plan";
  const pull = "https://github.com/netboxlabs/nbl-ui-platform-libs/pull/775";
  const lookalike = `https://example.com/redirect?to=${plan}`;
  const ticket = { key: "NBF-1936", description: `![shot](${inline})` } as Ticket;
  const { fetch, requests } = linear(
    [attached({ url: plan, title: "NBF-1936-0001-plan-shared-config-lint-rules.md" }, { url: inline, title: "shot" }, { url: pull, title: "feat: lint" }, { url: lookalike, title: "x.md" })],
    { [inline]: { status: 200, body: "PNG" }, [plan]: { status: 200, body: "# Plan", type: "text/markdown" } });
  const dir = tmpDir("ticket-linear-attached-");
  const paths = await linearSource({ key: "k", fetch }).download(ticket, dir);
  assert.deepEqual(paths, [`${dir}/attachment-1.png`, `${dir}/attachment-2-NBF-1936-0001-plan-shared-config-lint-rules.md`], "an upload the description links to is fetched once");
  assert.equal(readFileSync(paths[1], "utf8"), "# Plan");
  assert.deepEqual(JSON.parse(String(requests[0].init.body)).variables, { team: "NBF", number: 1936 });
  assert.deepEqual(requests.slice(1).map(({ url }) => url), [inline, plan], "a pull request link, or a link that only mentions an upload, is never fetched with the key");
});

test("a download keeps its attachment title as its name only when the title is a plain file name", () => {
  const link = "https://uploads.linear.app/org/a/file";
  assert.equal(downloadName(2, link, "NBF-1-0001-plan-x.md", "text/markdown"), "attachment-2-NBF-1-0001-plan-x.md");
  assert.equal(downloadName(2, link, "../../escape.md", "text/markdown"), "attachment-2", "a title with a folder in it names nothing");
  assert.equal(downloadName(2, link, "Screenshot", "image/png"), "attachment-2.png");
  assert.equal(downloadName(1, "https://uploads.linear.app/org/a/two.jpg", null, "image/png"), "attachment-1.jpg", "the link's own extension comes first");
});

test("pullStates() reads each linked pull request's state by URL from Linear's GitHub attachments, a draft as open, and nothing else", async () => {
  const merged = "https://github.com/netboxlabs/nbl-ui-platform-libs/pull/775";
  const draft = "https://github.com/netboxlabs/nbl-ui-netbox/pull/790";
  const { fetch, requests } = linear([{ data: {
    k0: { nodes: [{ attachments: { nodes: [
      { url: merged, sourceType: "github", metadata: { status: "merged", draft: false } },
      { url: "https://uploads.linear.app/org/a/plan", sourceType: "oauthClient", metadata: {} },
    ] } }] },
    k1: { nodes: [{ attachments: { nodes: [{ url: draft, sourceType: "github", metadata: { status: "draft", draft: true } }] } }] },
    k2: { nodes: [] },
  } }]);
  const pulls = await linearSource({ key: "k", fetch }).pullStates!(["NBF-1936", "VE-65", "NBF-9999"]);
  assert.deepEqual([...pulls], [["NBF-1936", { [merged]: "merged" }], ["VE-65", { [draft]: "open" }]]);
  assert.equal(requests.length, 1, "one request for the whole batch");
  assert.deepEqual(JSON.parse(String(requests[0].init.body)).variables, { t0: "NBF", n0: 1936, t1: "VE", n1: 65, t2: "NBF", n2: 9999 });
});

test("blockers() reads each ticket's \"blocked by\" from Linear's inverse relations of type blocks, with each blocker's state, branch and pull requests", async () => {
  const merged = "https://github.com/netboxlabs/nbl-ui-platform-libs/pull/775";
  const { fetch, requests } = linear([{ data: {
    k0: { nodes: [{ inverseRelations: { nodes: [
      { type: "blocks", issue: { identifier: "NBF-1936", branchName: "nbf-1936-libs", state: { type: "completed", name: "Done" }, attachments: { nodes: [
        { url: merged, sourceType: "github", title: "feat: libs release", metadata: { status: "merged" } },
        { url: "https://uploads.linear.app/org/a/plan", sourceType: "oauthClient", title: "plan.md", metadata: {} },
      ] } } },
      { type: "related", issue: { identifier: "VE-66", state: { type: "backlog", name: "Backlog" }, attachments: { nodes: [] } } },
      { type: "blocks", issue: { identifier: "NBF-1944", branchName: "nbf-1944-x", state: { type: "unstarted", name: "Planned" }, attachments: { nodes: [] } } },
    ] } }] },
    k1: { nodes: [{ inverseRelations: { nodes: [] } }] },
    k2: { nodes: [] },
  } }]);
  const blockers = await linearSource({ key: "k", fetch }).blockers!(["NBF-1940", "NBF-1", "NBF-9999"]);
  assert.deepEqual([...blockers], [
    ["NBF-1940", [{ key: "NBF-1936", state: "completed", status: "Done", branch: "nbf-1936-libs", pulls: { [merged]: "merged" }, titles: { [merged]: "feat: libs release" } }, { key: "NBF-1944", state: "unstarted", status: "Planned", branch: "nbf-1944-x", pulls: {} }]],
    ["NBF-1", []],
  ], "a related ticket is no blocker, and a key Linear has no ticket for is left out");
  assert.equal(requests.length, 1, "one request for the whole batch");
  assert.match(JSON.parse(String(requests[0].init.body)).query, /inverseRelations \{ nodes \{ type issue \{ identifier branchName state \{ type name \}/);
});

test("A11-207: a blocker's pull request carries its attachment's title, and one whose attachment has no title, or whose link is no pull request, carries none", async () => {
  const titled = "https://github.com/a11ign/agent-org/pull/1841";
  const untitled = "https://github.com/a11ign/agent-org/pull/1843";
  const blank = "https://github.com/a11ign/agent-org/pull/1845";
  const { fetch, requests } = linear([{ data: { k0: { nodes: [{ inverseRelations: { nodes: [
    { type: "blocks", issue: { identifier: "A11-185", branchName: "a11-185", state: { type: "completed", name: "Done" }, attachments: { nodes: [
      { url: titled, sourceType: "github", title: "  feat(ticket-mode): a title  ", metadata: { status: "merged" } },
      { url: untitled, sourceType: "github", metadata: { status: "open" } },
      { url: blank, sourceType: "github", title: "  ", metadata: { status: "open" } },
      { url: "https://uploads.linear.app/org/a/plan", sourceType: "oauthClient", title: "plan.md", metadata: {} },
    ] } } },
    { type: "blocks", issue: { identifier: "A11-190", branchName: "a11-190", state: { type: "started", name: "In Progress" }, attachments: { nodes: [{ url: untitled, sourceType: "github", metadata: { status: "open" } }] } } },
  ] } }] } } }]);
  const [first, second] = (await linearSource({ key: "k", fetch }).blockers!(["A11-207"])).get("A11-207")!;
  assert.deepEqual(first.titles, { [titled]: "feat(ticket-mode): a title" });
  assert.deepEqual(first.pulls, { [titled]: "merged", [untitled]: "open", [blank]: "open" }, "every pull request is listed, titled or not");
  assert.equal("titles" in second, false, "a blocker none of whose pull requests has a title carries no titles at all");
  assert.match(JSON.parse(String(requests[0].init.body)).query, /attachments \{ nodes \{ url sourceType title metadata \}/);
});

test("a pull request is merged or closed only on Linear's word, and open otherwise", () => {
  assert.deepEqual(["merged", "closed", "draft", "open", "inReview", undefined].map(pullState), ["merged", "closed", "open", "open", "open", "open"]);
});

test("stateTypes() reads every key's state type in one aliased request by team and number, and leaves out a key Linear has no ticket for", async () => {
  const { fetch, requests } = linear([{ data: {
    k0: { nodes: [{ identifier: "NBF-1270", state: { type: "completed" } }] },
    k1: { nodes: [] },
    k2: { nodes: [{ identifier: "VE-61", state: { type: "started" } }] },
  } }]);
  const states = await linearSource({ key: "lin_api_secret", fetch }).stateTypes!(["NBF-1270", "NBF-9999", "ve-61", "not a key"]);
  assert.deepEqual([...states], [["NBF-1270", "completed"], ["ve-61", "started"]]);
  assert.equal(requests.length, 1, "one request for the whole batch");
  const sent = JSON.parse(String(requests[0].init.body));
  assert.deepEqual(sent.variables, { t0: "NBF", n0: 1270, t1: "NBF", n1: 9999, t2: "VE", n2: 61 }, "keys travel as variables, never in the query text");
  assert.equal(sent.query.includes("NBF-1270"), false);
});

test("the Linear source reads updatedAt with a ticket and texts in one request", async () => {
  const read = linear([{ data: { issues: { nodes: [node("NBF-1", { updatedAt: "2026-10-21T09:30:00.000Z", description: "Plan this." })] } } }]);
  const ticket = await linearSource({ key: "k", fetch: read.fetch }).read("NBF-1");
  assert.equal(ticket?.updatedAt, "2026-10-21T09:30:00.000Z");
  assert.ok(queried(read.requests).query.includes("description updatedAt"), "updatedAt is asked for in the ticket's own read");
  const { fetch, requests } = linear([{ data: {
    k0: { nodes: [{ description: "Plan this.", updatedAt: "2026-10-21T09:30:00.000Z" }] },
    k1: { nodes: [] },
    k2: { nodes: [{ description: null, updatedAt: "2026-10-21T10:00:00.000Z" }] },
  } }]);
  const texts = await linearSource({ key: "k", fetch }).texts!(["NBF-1", "NBF-9999", "VE-2"]);
  assert.deepEqual([...texts], [["NBF-1", { description: "Plan this.", updatedAt: "2026-10-21T09:30:00.000Z" }], ["VE-2", { description: "", updatedAt: "2026-10-21T10:00:00.000Z" }]]);
  assert.equal(requests.length, 1, "one request for every key");
  assert.match(JSON.parse(String(requests[0].init.body)).query, /description updatedAt/);
});

test("detachPlan() deletes the uploads titled as asked, leaves every other attachment, and repeats without error", async () => {
  const links = { url: "https://github.com/a11ign/x/pull/3", title: "a pull request" };
  const upload = (id: string, title: string) => ({ id, url: `https://uploads.linear.app/org/${id}`, title });
  const listing = () => ({ data: { issues: { nodes: [{ attachments: { nodes: [upload("a1", "NBF-1-0001-plan-fit.md"), upload("a2", "notes.md"), { id: "a3", ...links }, upload("a4", "NBF-1-adr-0001-zoom.md")] } }] } } });
  const { fetch, requests } = linear([listing(), { data: { attachmentDelete: { success: true } } }, { data: { attachmentDelete: { success: true } } }, { data: { issues: { nodes: [{ attachments: { nodes: [upload("a2", "notes.md"), { id: "a3", ...links }] } }] } } }]);
  const source = linearSource({ key: "k", fetch });
  await source.detachPlan!("NBF-1", ["NBF-1-0001-plan-fit.md", "NBF-1-adr-0001-zoom.md", "NBF-1-not-there.md"]);
  const deleted = requests.slice(1).map(({ init }) => JSON.parse(String(init.body)));
  assert.deepEqual(deleted.map(({ variables }) => variables.id), ["a1", "a4"], "only the plan's two uploads are deleted: not notes.md, and not the pull request link");
  assert.match(deleted[0].query, /attachmentDelete/);
  await source.detachPlan!("NBF-1", ["NBF-1-0001-plan-fit.md"]);
  assert.equal(requests.length, 4, "a repeat finds nothing under the title, so it deletes nothing");
});

/** Linear's answer to the read attachPlan starts with: the ticket's id, its state's type, its team's states and its uploads. */
const planning = (type: string, ...uploads: { url: string; title: string }[]) => ({ data: { issues: { nodes: [{
  id: "uuid-1", state: { type, name: type === "backlog" ? "Backlog" : "In Progress" }, team: { states: { nodes: [{ id: "s-backlog", name: "Backlog" }, { id: "s-planned", name: "Planned" }] } }, attachments: { nodes: uploads },
}] } } });
const signed = (n: number) => ({ data: { fileUpload: { success: true, uploadFile: { uploadUrl: `https://storage.example/upload-${n}?sig=1`, assetUrl: `https://uploads.linear.app/org/asset-${n}`,
  headers: [{ key: "x-goog-content-length-range", value: "1,100" }] } } } });
/** Linear's answer to a mutation it carried out, and to one it did not. */
const done = { data: { issueUpdate: { success: true }, attachmentCreate: { success: true } } };
const notDone = { data: { issueUpdate: { success: false }, attachmentCreate: { success: false } } };
const planFiles = () => {
  const dir = tmpDir("linear-plan-");
  const plan = join(dir, "NBF-1-0001-plan-fit-to-view.md");
  const adr = join(dir, "NBF-1-adr-0001-zoom-anchor.md");
  writeFileSync(plan, "# Fit to view\n");
  writeFileSync(adr, "# Zoom anchor\n");
  return [plan, adr];
};

test("attachPlan() uploads each file to the address Linear signs, without the key, attaches it under its own name, and moves an unstarted ticket to the planner's state", async () => {
  const files = planFiles();
  const { fetch, requests } = linear([planning("backlog"), signed(1), done, signed(2), done, done], {
    "https://storage.example/upload-1?sig=1": { status: 200 }, "https://storage.example/upload-2?sig=1": { status: 200 },
  });
  await linearSource({ key: "lin_api_secret", fetch }).attachPlan!("NBF-1", files, "Planned");
  const puts = requests.filter((r) => r.init.method === "PUT");
  assert.deepEqual(puts.map((r) => r.url), ["https://storage.example/upload-1?sig=1", "https://storage.example/upload-2?sig=1"]);
  for (const put of puts) {
    const headers = put.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, undefined, "the key never goes to the storage address");
    assert.equal(headers["x-goog-content-length-range"], "1,100", "the headers Linear signed are sent as they are");
  }
  const bodies = requests.filter((r) => r.url === LINEAR_API).map((r) => JSON.parse(String(r.init.body)));
  assert.deepEqual(bodies.filter((b) => /attachmentCreate/.test(b.query)).map((b) => [b.variables.issueId, b.variables.title, b.variables.url]), [
    ["uuid-1", "NBF-1-0001-plan-fit-to-view.md", "https://uploads.linear.app/org/asset-1"],
    ["uuid-1", "NBF-1-adr-0001-zoom-anchor.md", "https://uploads.linear.app/org/asset-2"],
  ]);
  assert.deepEqual(bodies.filter((b) => /issueUpdate/.test(b.query)).map((b) => b.variables), [{ id: "uuid-1", stateId: "s-planned" }]);
});

test("attachPlan() attaches nothing twice, so a cut-off attempt can be repeated", async () => {
  const files = planFiles();
  const { fetch, requests } = linear([planning("backlog", { url: "https://uploads.linear.app/org/asset-1", title: "NBF-1-0001-plan-fit-to-view.md" }), signed(2), done, done], {
    "https://storage.example/upload-2?sig=1": { status: 200 },
  });
  await linearSource({ key: "k", fetch }).attachPlan!("NBF-1", files, "Planned");
  const titles = requests.filter((r) => r.url === LINEAR_API).map((r) => JSON.parse(String(r.init.body))).filter((b) => /attachmentCreate/.test(b.query)).map((b) => b.variables.title);
  assert.deepEqual(titles, ["NBF-1-adr-0001-zoom-anchor.md"]);
});

test("attachPlan() leaves a started ticket's state alone, and any state when the planner names none", async () => {
  for (const [type, state] of [["started", "Planned"], ["backlog", null]] as const) {
    const [plan] = planFiles();
    const { fetch, requests } = linear([planning(type), signed(1), done], { "https://storage.example/upload-1?sig=1": { status: 200 } });
    await linearSource({ key: "k", fetch }).attachPlan!("NBF-1", [plan], state);
    assert.equal(requests.some((r) => r.url === LINEAR_API && /issueUpdate/.test(String(r.init.body))), false, `${type}, ${state}`);
  }
});

test("attachPlan() says so when the storage refuses an upload, and attaches nothing for it", async () => {
  const [plan] = planFiles();
  const { fetch, requests } = linear([planning("backlog"), signed(1)], { "https://storage.example/upload-1?sig=1": { status: 403 } });
  await assert.rejects(linearSource({ key: "k", fetch }).attachPlan!("NBF-1", [plan], "Planned"), /the upload of NBF-1-0001-plan-fit-to-view\.md was refused \(403\)/);
  assert.equal(requests.some((r) => /attachmentCreate/.test(String(r.init.body ?? ""))), false);
});

test("attachPlan() rejects with the status Linear answered with, as data on the error, and the message as it was (A11-216)", async () => {
  const [plan] = planFiles();
  const unavailable = (async () => new Response("<html>upstream</html>", { status: 503 })) as unknown as typeof globalThis.fetch;
  const answered = await linearSource({ key: "k", fetch: unavailable }).attachPlan!("NBF-1", [plan], "Planned").catch((err: unknown) => err);
  assert.equal((answered as { status?: unknown }).status, 503);
  assert.equal((answered as Error).message, "Linear answered 503: no JSON");
  const { fetch } = linear([planning("backlog"), signed(1)], { "https://storage.example/upload-1?sig=1": { status: 403 } });
  const refused = await linearSource({ key: "k", fetch }).attachPlan!("NBF-1", [plan], "Planned").catch((err: unknown) => err);
  assert.equal((refused as { status?: unknown }).status, 403);
  assert.equal((refused as Error).message, "the upload of NBF-1-0001-plan-fit-to-view.md was refused (403)");
});

test("attachPlan() still attaches the plan when the ticket's team has no state of the planner's name, leaves the state alone and says so", async () => {
  const [plan] = planFiles();
  const { fetch, requests } = linear([planning("backlog"), signed(1), done], { "https://storage.example/upload-1?sig=1": { status: 200 } });
  const note = await linearSource({ key: "k", fetch }).attachPlan!("NBF-1", [plan], "Todo");
  assert.equal(note, "NBF-1's team has no state named Todo, so it stays in Backlog");
  assert.ok(requests.some((r) => /attachmentCreate/.test(String(r.init.body ?? ""))), "the plan is attached");
  assert.equal(requests.some((r) => /issueUpdate/.test(String(r.init.body ?? ""))), false);
});

test("attachPlan() says nothing when it did all it was asked", async () => {
  const [plan] = planFiles();
  const { fetch } = linear([planning("backlog"), signed(1), done, done], { "https://storage.example/upload-1?sig=1": { status: 200 } });
  assert.equal(await linearSource({ key: "k", fetch }).attachPlan!("NBF-1", [plan], "Planned"), null);
});

/** Linear's answer to moveToWorkingState's read: the ticket's id, its state, and its team's states. */
const working = (type: string, name: string) => ({ data: { issues: { nodes: [{
  id: "uuid-1", state: { type, name }, team: { states: { nodes: [{ id: "s-planned", name: "Planned" }, { id: "s-progress", name: "In Progress" }] } },
}] } } });

test("moveToWorkingState() moves a ticket not yet started, a planned one included, to the working state, and says what it moved from", async () => {
  for (const [type, name] of [["unstarted", "Planned"], ["backlog", "Backlog"], ["triage", "Triage"]]) {
    const { fetch, requests } = linear([working(type, name), done]);
    assert.deepEqual(await linearSource({ key: "k", fetch }).moveToWorkingState!("NBF-1", "In Progress"), { moved: { from: name, to: "In Progress" }, note: null }, type);
    const update = requests.map((r) => JSON.parse(String(r.init.body))).find((b) => /issueUpdate/.test(b.query));
    assert.deepEqual(update?.variables, { id: "uuid-1", stateId: "s-progress" }, type);
  }
});

test("moveToWorkingState() leaves a ticket already started or finished where it is, and records no move", async () => {
  for (const [type, name] of [["started", "In Review"], ["completed", "Done"]]) {
    const { fetch, requests } = linear([working(type, name)]);
    assert.deepEqual(await linearSource({ key: "k", fetch }).moveToWorkingState!("NBF-1", "In Progress"), { moved: null, note: null });
    assert.equal(requests.length, 1, `${type}: only read`);
  }
});

test("moveToWorkingState() keeps the ticket's state when its team has no state of that name, and says so", async () => {
  const { fetch, requests } = linear([working("unstarted", "Planned")]);
  assert.deepEqual(await linearSource({ key: "k", fetch }).moveToWorkingState!("NBF-1", "Doing"), { moved: null, note: "NBF-1's team has no state named Doing, so it stays in Planned" });
  assert.equal(requests.length, 1);
});

test("restoreState() moves a ticket back to the state the board moved it out of, while it is still in the state the board moved it to", async () => {
  const { fetch, requests } = linear([working("started", "In Progress"), done]);
  assert.equal(await linearSource({ key: "k", fetch }).restoreState!("NBF-1", { from: "Planned", to: "In Progress" }), null);
  const update = requests.map((r) => JSON.parse(String(r.init.body))).find((b) => /issueUpdate/.test(b.query));
  assert.deepEqual(update?.variables, { id: "uuid-1", stateId: "s-planned" });
});

test("restoreState() leaves a ticket a person has moved since where it is, and changes nothing", async () => {
  for (const [type, name] of [["completed", "Done"], ["started", "In Review"]]) {
    const { fetch, requests } = linear([working(type, name)]);
    assert.equal(await linearSource({ key: "k", fetch }).restoreState!("NBF-1", { from: "Planned", to: "In Progress" }), null, name);
    assert.equal(requests.length, 1, `${name}: only read`);
  }
});

test("restoreState() keeps the ticket where it is when its team has no state it came from, and says so", async () => {
  const { fetch, requests } = linear([working("started", "In Progress")]);
  assert.equal(await linearSource({ key: "k", fetch }).restoreState!("NBF-1", { from: "Doing", to: "In Progress" }), "NBF-1's team has no state named Doing, so it stays in In Progress");
  assert.equal(requests.length, 1);
});

test("restoreState() says so, and moves nothing, when Linear has no ticket by that key, so the run it belongs to can leave the board", async () => {
  const { fetch, requests } = linear([{ data: { issues: { nodes: [] } } }]);
  assert.equal(await linearSource({ key: "k", fetch }).restoreState!("NBF-1", { from: "Planned", to: "In Progress" }), "Linear has no ticket NBF-1, so nothing was put back to Planned");
  assert.equal(requests.length, 1, "only read");
});

test("a restore Linear answers with success false is a refusal, not a restore", async () => {
  const { fetch } = linear([working("started", "In Progress"), notDone]);
  await assert.rejects(linearSource({ key: "k", fetch }).restoreState!("NBF-1", { from: "Planned", to: "In Progress" }), /Linear did not move NBF-1 to Planned/);
});

test("moveToWorkingState() says so when Linear has no ticket by that key", async () => {
  const { fetch } = linear([{ data: { issues: { nodes: [] } } }]);
  await assert.rejects(linearSource({ key: "k", fetch }).moveToWorkingState!("NBF-404", "In Progress"), /Linear has no ticket NBF-404/);
});

test("a state move Linear answers with success false is a refusal, not a move", async () => {
  const { fetch } = linear([working("unstarted", "Planned"), notDone]);
  await assert.rejects(linearSource({ key: "k", fetch }).moveToWorkingState!("NBF-1", "In Progress"), /Linear did not move NBF-1 to In Progress/);
});

test("an attachment Linear answers with success false is a refusal, not an attached plan", async () => {
  const [plan] = planFiles();
  const { fetch } = linear([planning("backlog"), signed(1), notDone], { "https://storage.example/upload-1?sig=1": { status: 200 } });
  await assert.rejects(linearSource({ key: "k", fetch }).attachPlan!("NBF-1", [plan], "Planned"), /Linear did not attach NBF-1-0001-plan-fit-to-view\.md/);
});

/** Linear's answer to the read of the blocked ticket: its id, and the tickets already recorded as blocking it. */
const blocked = (...blockers: string[]) => ({ data: { issues: { nodes: [{ id: "uuid-blocked", inverseRelations: { nodes: [
  ...blockers.map((identifier) => ({ type: "blocks", issue: { identifier } })),
  { type: "related", issue: { identifier: "NBF-3" } },
] } }] } } });
const created = (success: boolean) => ({ data: { issueRelationCreate: { success } } });

test("addBlockers() records each blocker Linear does not have yet as blocking the ticket, on the blocker, with the blocked ticket as the related one", async () => {
  const { fetch, requests } = linear([blocked("NBF-1"), { data: { k0: { nodes: [{ id: "uuid-2" }] }, k1: { nodes: [{ id: "uuid-3" }] } } }, created(true), created(true)]);
  await linearSource({ key: "k", fetch }).addBlockers!("NBF-4", ["NBF-1", "NBF-2", "NBF-3", "NBF-2"]);
  const bodies = requests.map((r) => JSON.parse(String(r.init.body)));
  assert.match(bodies[0].query, /inverseRelations \{ nodes \{ type issue \{ identifier \} \} \}/, "it reads what Linear has first");
  assert.deepEqual(bodies[1].variables, { t0: "NBF", n0: 2, t1: "NBF", n1: 3 }, "a related ticket is no blocker, so NBF-3 is still recorded, and NBF-1 already is");
  const made = bodies.filter((b) => /issueRelationCreate/.test(b.query));
  assert.match(made[0].query, /issueRelationCreate\(input: \{ issueId: \$issueId, relatedIssueId: \$relatedIssueId, type: blocks \}\) \{ success \}/);
  assert.deepEqual(made.map((b) => b.variables), [{ issueId: "uuid-2", relatedIssueId: "uuid-blocked" }, { issueId: "uuid-3", relatedIssueId: "uuid-blocked" }]);
});

test("addBlockers() makes nothing when Linear has every relation already, so a cut-off attempt can be repeated", async () => {
  const { fetch, requests } = linear([blocked("NBF-1", "NBF-2")]);
  await linearSource({ key: "k", fetch }).addBlockers!("NBF-4", ["NBF-1", "NBF-2"]);
  assert.equal(requests.length, 1, "only read");
});

test("addBlockers() is refused when Linear answers success false, and when it has no ticket by either key", async () => {
  await assert.rejects(linearSource({ key: "k", fetch: linear([blocked(), { data: { k0: { nodes: [{ id: "uuid-2" }] } } }, created(false)]).fetch }).addBlockers!("NBF-4", ["NBF-2"]),
    /Linear did not record that NBF-2 blocks NBF-4/);
  await assert.rejects(linearSource({ key: "k", fetch: linear([{ data: { issues: { nodes: [] } } }]).fetch }).addBlockers!("NBF-404", ["NBF-2"]), /Linear has no ticket NBF-404/);
  await assert.rejects(linearSource({ key: "k", fetch: linear([blocked(), { data: { k0: { nodes: [] } } }]).fetch }).addBlockers!("NBF-4", ["NBF-404"]), /Linear has no ticket NBF-404/);
});

/**
 * The fields every list reads, as the board has always read them, each ticket's open sub-issues since A11-76, and its labels with their groups
 * since the Pick view filters by label group. Each addition is a field of the same request, never a request of its own, and is changed here on
 * purpose: this pin is what notices a field list that grew or shrank by accident.
 */
const FIELDS = "identifier title description updatedAt url branchName priority state { name position type } team { key } project { name summary: description } assignee { id name } parent { identifier } "
  + 'children(first: 50, filter: { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }) { nodes { identifier } } attachments(first: 50) { nodes { url title } } '
  + "labels(first: 50) { nodes { name parent { name } } }";

test("with no tickets.pick, the Pick view reads the key's own open tickets, the same request for the default and for a source built without the setting", async () => {
  const before = `query($after: String) { viewer { assignedIssues(first: 100, after: $after, filter: { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }) {
            nodes { ${FIELDS} } pageInfo { hasNextPage endCursor } } } }`;
  for (const source of [(fetch: typeof globalThis.fetch) => linearSource({ key: "k", fetch }), (fetch: typeof globalThis.fetch) => linearSource({ key: "k", fetch, pick: "assigned" })]) {
    const { fetch, requests } = linear([{ data: { viewer: { assignedIssues: { nodes: [node("NBF-1")], pageInfo: { hasNextPage: false, endCursor: null } } } } }]);
    assert.deepEqual((await source(fetch).assigned()).map((t) => t.key), ["NBF-1"]);
    assert.equal(String(requests[0].init.body), JSON.stringify({ query: before, variables: { after: null } }), "the same request, byte for byte");
  }
});

test("A11-69: a team or a project lists every open ticket of it, whoever it is assigned to, a page at a time, with the name sent as a variable", async () => {
  for (const [pick, filter, variables] of [
    [{ team: "A11" }, "team: { key: { eq: $team } }", { team: "A11" }],
    [{ project: "Witness \"GA\"" }, "project: { name: { eq: $project } }", { project: "Witness \"GA\"" }],
  ] as const) {
    const { fetch, requests } = linear([
      { data: { issues: { nodes: [node("A11-1"), node("A11-2")], pageInfo: { hasNextPage: true, endCursor: "c1" } } } },
      { data: { issues: { nodes: [node("A11-3")], pageInfo: { hasNextPage: false, endCursor: null } } } },
    ]);
    const tickets = await linearSource({ key: "k", fetch, pick }).assigned();
    assert.deepEqual(tickets.map((t) => t.key), ["A11-1", "A11-2", "A11-3"]);
    const [first, second] = requests.map(({ init }) => JSON.parse(String(init.body)));
    assert.ok(first.query.includes(`issues(first: 100, after: $after, filter: { ${filter}, state: { type: { nin: ["completed", "canceled", "duplicate"] } } })`), first.query);
    assert.equal(first.query.includes("viewer"), false, "not the key's own tickets");
    assert.equal(first.query.includes("Witness"), false, "the name is never written into the query");
    assert.deepEqual([first.variables, second.variables], [{ ...variables, after: null }, { ...variables, after: "c1" }]);
  }
  assert.equal(pickQuery({ team: "A11" }).text.includes(FIELDS), true, "the same fields as the key's own list");
});

test("A11-108: me() names the key's person by id and name, or by email when Linear has no name", async () => {
  assert.deepEqual(await linearSource({ key: "k", fetch: linear([{ data: { viewer: { id: "u-1", name: "Dan Beck", email: "dan@example.com" } } }]).fetch }).me!(), { id: "u-1", name: "Dan Beck" });
  assert.deepEqual(await linearSource({ key: "k", fetch: linear([{ data: { viewer: { id: "u-1", name: "", email: "dan@example.com" } } }]).fetch }).me!(), { id: "u-1", name: "dan@example.com" });
});

test("A11-69: viewer() names the key's person by name, or by email when Linear has no name", async () => {
  assert.equal(await linearSource({ key: "k", fetch: linear([{ data: { viewer: { name: "Dan Beck", email: "dan@example.com" } } }]).fetch }).viewer!(), "Dan Beck");
  assert.equal(await linearSource({ key: "k", fetch: linear([{ data: { viewer: { name: "", email: "dan@example.com" } } }]).fetch }).viewer!(), "dan@example.com");
});

/** A ticket in state `type` and `name`, with its team's states: a started one, and the completed states given, each with its position. */
const finishable = (type: string, name: string, completed: { id: string; name: string; position: number }[] = [{ id: "s-done", name: "Done", position: 3 }]) => ({
  data: { issues: { nodes: [{ id: "uuid-1", state: { type, name }, team: { states: { nodes: [
    { id: "s-progress", name: "In Progress", type: "started", position: 1 }, ...completed.map((state) => ({ ...state, type: "completed" })),
  ] } } }] } } });
const moved = { data: { issueUpdate: { success: true } } };
const commented = { data: { commentCreate: { success: true } } };

test("A11-92: complete() moves a started ticket to its team's completed state, and posts the comment on it", async () => {
  const { fetch, requests } = linear([finishable("started", "In Progress"), moved, commented]);
  assert.equal(await linearSource({ key: "k", fetch }).complete!("NBF-1", "PR merged without closing NBF-1"), null);
  const bodies = requests.map((r) => JSON.parse(String(r.init.body)));
  assert.deepEqual(bodies[1].variables, { id: "uuid-1", stateId: "s-done" }, "moved to the completed state");
  assert.deepEqual(bodies[2].variables, { issueId: "uuid-1", body: "PR merged without closing NBF-1" }, "the comment is on the ticket");
  assert.match(bodies[2].query, /commentCreate/);
});

test("A11-92: complete() takes the completed state listed first by position when a team has more than one", async () => {
  const { fetch, requests } = linear([finishable("unstarted", "Planned", [{ id: "s-late", name: "Shipped", position: 9 }, { id: "s-early", name: "Done", position: 4 }]), moved, commented]);
  await linearSource({ key: "k", fetch }).complete!("NBF-1", "c");
  assert.deepEqual(JSON.parse(String(requests[1].init.body)).variables, { id: "uuid-1", stateId: "s-early" });
});

test("A11-92: complete() leaves a ticket Linear or a person has finished, canceled or marked a duplicate alone, with no move and no comment", async () => {
  for (const type of ["completed", "canceled", "duplicate"]) {
    const { fetch, requests } = linear([finishable(type, "Done")]);
    assert.equal(await linearSource({ key: "k", fetch }).complete!("NBF-1", "c"), null, type);
    assert.equal(requests.length, 1, `${type}: only read`);
  }
});

test("A11-92: complete() says so, and moves and posts nothing, when its team has no completed state", async () => {
  const { fetch, requests } = linear([finishable("started", "In Progress", [])]);
  assert.equal(await linearSource({ key: "k", fetch }).complete!("NBF-1", "c"), "NBF-1's team has no completed state, so it stays in In Progress");
  assert.equal(requests.length, 1);
});

test("A11-92: complete() is refused when Linear answers success false to the move or to the comment", async () => {
  const refusedMove = linear([finishable("started", "In Progress"), { data: { issueUpdate: { success: false } } }]);
  await assert.rejects(linearSource({ key: "k", fetch: refusedMove.fetch }).complete!("NBF-1", "c"), /Linear did not move NBF-1 to Done/);
  const refusedComment = linear([finishable("started", "In Progress"), moved, { data: { commentCreate: { success: false } } }]);
  await assert.rejects(linearSource({ key: "k", fetch: refusedComment.fetch }).complete!("NBF-1", "c"), /Linear did not post a comment on NBF-1/);
});

test("A11-173: comment() posts the body through commentCreate on the ticket's id, in whatever state the ticket is in, and moves nothing", async () => {
  const { fetch, requests } = linear([{ data: { issues: { nodes: [{ id: "uuid-1" }] } } }, commented]);
  await linearSource({ key: "k", fetch }).comment!("NBF-1", "After-merge checks for NBF-1");
  const bodies = requests.map((r) => JSON.parse(String(r.init.body)));
  assert.equal(requests.length, 2, "one read of the ticket, one comment");
  assert.deepEqual(bodies[1].variables, { issueId: "uuid-1", body: "After-merge checks for NBF-1" });
  assert.match(bodies[1].query, /commentCreate/);
});

test("A11-173: comment() is refused when Linear has no ticket by that key, or answers success false", async () => {
  const none = linear([{ data: { issues: { nodes: [] } } }]);
  await assert.rejects(linearSource({ key: "k", fetch: none.fetch }).comment!("NBF-9", "c"), /Linear has no ticket NBF-9/);
  const refused = linear([{ data: { issues: { nodes: [{ id: "uuid-1" }] } } }, { data: { commentCreate: { success: false } } }]);
  await assert.rejects(linearSource({ key: "k", fetch: refused.fetch }).comment!("NBF-1", "c"), /Linear did not post a comment on NBF-1/);
});

test("A11-91: updateTicketText() writes only the title and description it is given, to the ticket's id", async () => {
  const { fetch, requests } = linear([{ data: { issues: { nodes: [{ id: "uuid-1" }] } } }, moved]);
  await linearSource({ key: "k", fetch }).updateTicketText!("NBF-1", { title: "New title" });
  const bodies = requests.map((r) => JSON.parse(String(r.init.body)));
  assert.deepEqual(bodies[1].variables, { id: "uuid-1", input: { title: "New title" } }, "the title alone, not the description");
  assert.match(bodies[1].query, /issueUpdate/);
  const described = linear([{ data: { issues: { nodes: [{ id: "uuid-1" }] } } }, moved]);
  await linearSource({ key: "k", fetch: described.fetch }).updateTicketText!("NBF-1", { description: "New text" });
  assert.deepEqual(JSON.parse(String(described.requests[1].init.body)).variables, { id: "uuid-1", input: { description: "New text" } }, "the description alone");
});

test("A11-91: updateTicketText() is refused when Linear has no ticket by that key, or answers success false", async () => {
  const missing = linear([{ data: { issues: { nodes: [] } } }]);
  await assert.rejects(linearSource({ key: "k", fetch: missing.fetch }).updateTicketText!("NBF-1", { title: "t" }), /Linear has no ticket NBF-1/);
  const refused = linear([{ data: { issues: { nodes: [{ id: "uuid-1" }] } } }, { data: { issueUpdate: { success: false } } }]);
  await assert.rejects(linearSource({ key: "k", fetch: refused.fetch }).updateTicketText!("NBF-1", { title: "t" }), /did not update the text of NBF-1/);
});

test("A11-92: Linear's own pull request words are the keywords a source hands the brief and pr:open", () => {
  const { closing, nonClosing } = linearSource({ key: "k", fetch: linear([]).fetch }).keywords!;
  assert.deepEqual([closing, nonClosing], ["Closes", "Refs"]);
});

test("A11-178: the closing words are Linear's twenty magic words, close, fix, resolve, complete and implement, each in its -s, -d or -ed, and -ing forms", () => {
  const words = linearSource({ key: "k", fetch: linear([]).fetch }).keywords?.closingWords;
  assert.deepEqual([...(words ?? [])].sort(), [
    "close", "closed", "closes", "closing", "complete", "completed", "completes", "completing", "fix", "fixed", "fixes", "fixing",
    "implement", "implemented", "implementing", "implements", "resolve", "resolved", "resolves", "resolving",
  ]);
});

/** A ticket Linear holds in Done (`s-done`), whose team has In Progress and Todo, with the history `moves` give. */
const completedWith = (moves: unknown[], state = { id: "s-done", type: "completed", name: "Done" }) => ({ data: { issues: { nodes: [{
  id: "uuid-1", state, team: { states: { nodes: [{ id: "s-todo", name: "Todo", type: "unstarted" }, { id: "s-progress", name: "In Progress", type: "started" }, { id: "s-done", name: "Done", type: "completed" }] } },
  history: { nodes: moves },
}] } } });
const move = (createdAt: string, over: Record<string, unknown> = {}) => ({ createdAt, toState: { id: "s-done" }, fromState: { id: "s-progress", name: "In Progress" }, actor: null, botActor: null, ...over });
const GITHUB_BOT = { name: "GitHub", type: "github" };

test("A11-178: undoAutomaticCompletion() moves a ticket the integration completed back to the state it left, then posts the comment, and says what it moved", async () => {
  const { fetch, requests } = linear([completedWith([move("2026-10-23T17:02:01Z", { botActor: GITHUB_BOT })]), done, { data: { commentCreate: { success: true } } }]);
  assert.deepEqual(await linearSource({ key: "k", fetch }).undoAutomaticCompletion!("NBF-1", "put back"), { reopened: { from: "In Progress", to: "Done" }, by: "integration", note: null });
  const sent = requests.map((r) => JSON.parse(String(r.init.body)));
  assert.deepEqual(sent[1].variables, { id: "uuid-1", stateId: "s-progress" }, "the move back is to the state the history says it left, by id");
  assert.deepEqual(sent[2].variables, { issueId: "uuid-1", body: "put back" }, "and the comment follows the move");
  assert.match(sent[0].query, /history\(first: 100\)/, "the history is read with the ticket, in the one request");
});

test("A11-178: undoAutomaticCompletion() leaves a completion a person made alone: no move, no comment", async () => {
  const { fetch, requests } = linear([completedWith([move("2026-10-23T17:02:01Z", { actor: { id: "u-1" } })])]);
  assert.deepEqual(await linearSource({ key: "k", fetch }).undoAutomaticCompletion!("NBF-1", "put back"), { reopened: null, by: "person", note: null });
  assert.equal(requests.length, 1, "only read");
});

test("A11-178: undoAutomaticCompletion() answers none for a ticket that is not completed, and changes nothing", async () => {
  const { fetch, requests } = linear([completedWith([], { id: "s-progress", type: "started", name: "In Progress" })]);
  assert.deepEqual(await linearSource({ key: "k", fetch }).undoAutomaticCompletion!("NBF-1", "put back"), { reopened: null, by: "none", note: null });
  assert.equal(requests.length, 1);
});

test("A11-178: undoAutomaticCompletion() says so and moves nothing when the history names nobody, or not the state the ticket left, or the team no longer has it", async () => {
  const names = async (moves: unknown[]) => linearSource({ key: "k", fetch: linear([completedWith(moves)]).fetch }).undoAutomaticCompletion!("NBF-1", "put back");
  assert.deepEqual(await names([]), { reopened: null, by: "unknown", note: "Linear's history does not say who moved NBF-1 to Done" });
  assert.deepEqual(await names([move("2026-10-23T17:02:01Z")]), { reopened: null, by: "unknown", note: "Linear's history does not say who moved NBF-1 to Done" });
  assert.deepEqual(await names([move("2026-10-23T17:02:01Z", { botActor: GITHUB_BOT, fromState: null })]),
    { reopened: null, by: "integration", note: "Linear's history does not say which state NBF-1 was in before Done" });
  assert.deepEqual(await names([move("2026-10-23T17:02:01Z", { botActor: GITHUB_BOT, fromState: { id: "s-gone", name: "In Review" } })]),
    { reopened: null, by: "integration", note: "NBF-1's team has no state In Review any more, so it stays in Done" });
});

test("A11-178: undoAutomaticCompletion() is refused when Linear has no ticket by that key, or answers success false to the move or the comment", async () => {
  await assert.rejects(linearSource({ key: "k", fetch: linear([{ data: { issues: { nodes: [] } } }]).fetch }).undoAutomaticCompletion!("NBF-404", "c"), /Linear has no ticket NBF-404/);
  const integration = [move("2026-10-23T17:02:01Z", { botActor: GITHUB_BOT })];
  await assert.rejects(linearSource({ key: "k", fetch: linear([completedWith(integration), notDone]).fetch }).undoAutomaticCompletion!("NBF-1", "c"), /Linear did not move NBF-1 to In Progress/);
  await assert.rejects(linearSource({ key: "k", fetch: linear([completedWith(integration), done, { data: { commentCreate: { success: false } } }]).fetch }).undoAutomaticCompletion!("NBF-1", "c"),
    /Linear did not post a comment on NBF-1/);
});

test("A11-178: completionOf reads the NEWEST move into the state the ticket is in, whatever order Linear lists them, and a person's move wins over a bot named beside it", () => {
  const first = move("2026-10-23T10:00:00Z", { botActor: GITHUB_BOT });
  const later = move("2026-10-23T18:00:00Z", { actor: { id: "u-1" }, fromState: { id: "s-todo", name: "Todo" } });
  assert.deepEqual(completionOf([later, first], "s-done"), { by: "person", from: { id: "s-todo", name: "Todo" } }, "a person completed it again after the integration did");
  assert.deepEqual(completionOf([first, later], "s-done"), { by: "person", from: { id: "s-todo", name: "Todo" } });
  assert.equal(completionOf([move("2026-10-23T18:00:00Z", { actor: { id: "u-1" }, botActor: GITHUB_BOT })], "s-done").by, "person");
  assert.equal(completionOf([move("2026-10-23T18:00:00Z", { botActor: GITHUB_BOT, toState: { id: "s-other" } })], "s-done").by, "unknown", "a move into another state says nothing of this one");
  assert.equal(completionOf([{ ...first, toState: null }], "s-done").by, "unknown", "a history entry that moved no state says nothing");
});

test("scopedQuery: a person's id is a variable and never in the text; Unassigned asks for tickets with no assignee; Anyone asks for every open ticket", () => {
  const person = scopedQuery("u-7");
  assert.deepEqual(person.variables, { who: "u-7" });
  assert.ok(person.text.includes("assignee: { id: { eq: $who } }") && !person.text.includes("u-7"));
  const nobody = scopedQuery("unassigned");
  assert.ok(nobody.text.includes("assignee: { null: true }"));
  assert.deepEqual(nobody.variables, {});
  const everyone = scopedQuery("anyone");
  assert.ok(!everyone.text.includes("assignee: {") && !everyone.text.includes("$who"));
  for (const query of [person, nobody, everyone]) assert.ok(query.text.includes('nin: ["completed", "canceled", "duplicate"]'), "finished tickets are never offered");
});

test("scoped() reads one page of a scope with the cursor of the next, and the last page has none", async () => {
  const { fetch, requests } = linear([
    { data: { issues: { nodes: [node("NBF-1", { assignee: { id: "u-7", name: "Ana Ruiz" } })], pageInfo: { hasNextPage: true, endCursor: "c1" } } } },
    { data: { issues: { nodes: [node("NBF-2")], pageInfo: { hasNextPage: false, endCursor: null } } } },
  ]);
  const source = linearSource({ key: "k", fetch });
  const first = await source.scoped!("u-7", null);
  assert.deepEqual([first.tickets.map((t) => t.key), first.next], [["NBF-1"], "c1"]);
  const last = await source.scoped!("u-7", "c1");
  assert.deepEqual([last.tickets.map((t) => t.key), last.next], [["NBF-2"], null]);
  assert.equal(queried(requests).variables.who, "u-7");
  assert.equal(JSON.parse(String(requests[1].init.body)).variables.after, "c1");
});

test("people() counts each person's open tickets and the unassigned ones across every page, reading only the assignee", async () => {
  const { fetch, requests } = linear([
    { data: { issues: { nodes: [{ assignee: { id: "a", name: "Ana" } }, { assignee: null }, { assignee: { id: "b", name: "Ben" } }], pageInfo: { hasNextPage: true, endCursor: "c1" } } } },
    { data: { issues: { nodes: [{ assignee: { id: "a", name: "Ana" } }, { assignee: null }, { assignee: null }], pageInfo: { hasNextPage: false, endCursor: null } } } },
  ]);
  const held = await linearSource({ key: "k", fetch }).people!();
  assert.deepEqual(held, { people: [{ id: "a", name: "Ana", count: 2 }, { id: "b", name: "Ben", count: 1 }], unassigned: 3, total: 6 });
  assert.equal(requests.length, 2);
  const text = queried(requests).query;
  assert.ok(text.includes("nodes { assignee { id name } }") && !text.includes("description"), "only the assignee is read, so a page stays small");
});

test("A11-116: a ticket carries its project's summary, where its repository is written, and a read of the projects names each one's summary by key", async () => {
  const found = linear([{ data: { issues: { nodes: [node("NBF-1", { project: { name: "agent-org", summary: "github.com/a11ign/agent-org" } })] } } }]);
  assert.equal((await linearSource({ key: "k", fetch: found.fetch }).read("NBF-1"))?.projectSummary, "github.com/a11ign/agent-org");
  const listed = linear([{ data: { viewer: { assignedIssues: { nodes: [node("NBF-2")], pageInfo: { hasNextPage: false, endCursor: null } } } } }]);
  assert.equal((await linearSource({ key: "k", fetch: listed.fetch }).assigned())[0].projectSummary, null, "a project with no summary names none");
  const read = linear([{ data: { k0: { nodes: [{ project: { summary: "github.com/a11ign/agent-org" } }] }, k1: { nodes: [{ project: null }] } } }]);
  const summaries = await linearSource({ key: "k", fetch: read.fetch }).projectSummaries!(["NBF-1", "NBF-2"]);
  assert.deepEqual([...summaries], [["NBF-1", "github.com/a11ign/agent-org"]], "a ticket with no project is left out");
});

test("a Linear project has no field called summary: its short text is `description`, asked for under the name `summary`, in every query that reads it", async () => {
  // Linear's GraphQL Project type has `description`, `content` and no `summary` (the Linear MCP's name for it); a query that names `summary` is answered 400 and fails every ticket read.
  const bare = /project \{[^}]*\bsummary\b(?!:)/;
  const listing = linear([{ data: { viewer: { assignedIssues: { nodes: [node("NBF-1")], pageInfo: { hasNextPage: false, endCursor: null } } } } }]);
  await linearSource({ key: "k", fetch: listing.fetch }).assigned();
  const one = linear([{ data: { issues: { nodes: [node("NBF-1")] } } }]);
  await linearSource({ key: "k", fetch: one.fetch }).read("NBF-1");
  const summaries = linear([{ data: { k0: { nodes: [{ project: null }] } } }]);
  await linearSource({ key: "k", fetch: summaries.fetch }).projectSummaries!(["NBF-1"]);
  const team = linear([{ data: { issues: { nodes: [node("NBF-1")], pageInfo: { hasNextPage: false, endCursor: null } } } }]);
  await linearSource({ key: "k", fetch: team.fetch, pick: { team: "NBF" } }).assigned();
  const people = linear([{ data: { issues: { nodes: [node("NBF-1")], pageInfo: { hasNextPage: false, endCursor: null } } } }]);
  await linearSource({ key: "k", fetch: people.fetch }).scoped!("anyone", null);
  for (const { requests } of [listing, one, summaries, team, people]) {
    const text = JSON.parse(String(requests[0].init.body)).query as string;
    assert.equal(bare.test(text), false, `a bare \`summary\` field in: ${text.slice(0, 80)}`);
    assert.ok(!text.includes("project {") || text.includes("summary: description"), "a project's text is read as `summary: description`");
  }
});

const claimed = (id: string, ...comments: { body: string; createdAt: string }[]) => ({ data: { issues: { nodes: [{ id, comments: { nodes: comments } }] } } });
const claimComment = (claimant: string, createdAt: string) => ({ body: `agent-org: claimed by ${claimant}`, createdAt });

test("A11-168: claim() posts `agent-org: claimed by <claimant>` on the ticket when it carries no claim, and reads only the comments that start with those words", async () => {
  const { fetch, requests } = linear([claimed("uuid-1"), commented]);
  await linearSource({ key: "k", fetch }).claim!("NBF-1", "laptop.ab12cd34");
  const bodies = requests.map((r) => JSON.parse(String(r.init.body)));
  assert.match(bodies[0].query, /comments\(first: 50, filter: \{ body: \{ startsWith: "agent-org: claimed by " \} \}\)/);
  assert.deepEqual(bodies[1].variables, { issueId: "uuid-1", body: "agent-org: claimed by laptop.ab12cd34" });
  assert.match(bodies[1].query, /commentCreate/);
});

test("A11-168: claim() writes nothing when the latest claim already names the claimant, so nine steps of one ticket make one comment", async () => {
  const { fetch, requests } = linear([claimed("uuid-1", claimComment("laptop.ab12cd34", "2026-10-21T10:00:00Z"))]);
  await linearSource({ key: "k", fetch }).claim!("NBF-1", "laptop.ab12cd34");
  assert.equal(requests.length, 1, "only the read");
});

test("A11-168: claim() writes again when the latest claim names someone else, even if this claimant held the ticket before, and the latest is found by time, not by the order Linear lists", async () => {
  const comments = [claimComment("desk.11111111", "2026-10-21T12:00:00Z"), claimComment("laptop.ab12cd34", "2026-10-21T10:00:00Z")];
  const { fetch, requests } = linear([claimed("uuid-1", ...comments), commented]);
  await linearSource({ key: "k", fetch }).claim!("NBF-1", "laptop.ab12cd34");
  assert.equal(requests.length, 2, "the other instance's claim is the latest, so this claimant claims again");
});

test("A11-168: claim() is refused when Linear has no ticket by that key, or answers success false", async () => {
  await assert.rejects(linearSource({ key: "k", fetch: linear([{ data: { issues: { nodes: [] } } }]).fetch }).claim!("NBF-1", "c.1"), /Linear has no ticket NBF-1/);
  await assert.rejects(linearSource({ key: "k", fetch: linear([claimed("uuid-1"), { data: { commentCreate: { success: false } } }]).fetch }).claim!("NBF-1", "c.1"), /Linear did not post a comment on NBF-1/);
});

test("A11-168: claims() answers the claimant of each key's latest claim in one aliased request, and leaves out a key with no claim, a missing ticket and a comment that names no claimant", async () => {
  const empty = { data: { k0: { nodes: [{ comments: { nodes: [] } }] }, k1: { nodes: [] }, k2: { nodes: [{ comments: { nodes: [{ body: "agent-org: claimed by ", createdAt: "2026-10-21T10:00:00Z" }] } }] },
    k3: { nodes: [{ comments: { nodes: [claimComment("old.1", "2026-10-20T10:00:00Z"), claimComment("new.2", "2026-10-21T10:00:00Z")] } }] } } };
  const { fetch, requests } = linear([empty]);
  const found = await linearSource({ key: "k", fetch }).claims!(["NBF-1", "NBF-404", "NBF-3", "NBF-4"]);
  assert.deepEqual([...found], [["NBF-4", "new.2"]]);
  assert.equal(requests.length, 1);
});

/** A fetch that fails the first `failures` calls to Linear with what Node throws for a dropped connection, then answers `page`, recording the headers of every call. */
function dropping(failures: number, failure: unknown, page: unknown) {
  const calls: Headers[] = [];
  const fetch = (async (_url: string, init: RequestInit = {}) => {
    calls.push(new Headers(init.headers));
    if (calls.length <= failures) throw failure;
    return new Response(JSON.stringify(page), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const staleSocket = () => new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
const FOUND = { data: { issues: { nodes: [node("NBF-1")] } } };

test("A11-345: a call that fails with fetch failed is sent once more on a connection that is closed after it, and the second answer is the call's", async () => {
  const { fetch, calls } = dropping(1, staleSocket(), FOUND);
  assert.equal((await linearSource({ key: "k", fetch }).read("NBF-1"))?.title, "Title NBF-1");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].get("connection"), null, "the first call keeps the pool's connections");
  assert.equal(calls[1].get("connection"), "close");
  assert.equal(calls[1].get("authorization"), "k", "the retry sends the key as the first call did");
});

test("A11-345: a second fetch failed is the caller's, not tried a third time", async () => {
  const { fetch, calls } = dropping(2, staleSocket(), FOUND);
  await assert.rejects(linearSource({ key: "k", fetch }).read("NBF-1"), /fetch failed/);
  assert.equal(calls.length, 2);
});

test("A11-345: an error that is not fetch failed is not sent again", async () => {
  const { fetch, calls } = dropping(1, new RangeError("bad"), FOUND);
  await assert.rejects(linearSource({ key: "k", fetch }).read("NBF-1"), /bad/);
  assert.equal(calls.length, 1);
  const refused = dropping(0, null, { errors: [{ message: "Authentication required" }] });
  await assert.rejects(linearSource({ key: "k", fetch: refused.fetch }).read("NBF-1"), /Authentication required/);
  assert.equal(refused.calls.length, 1, "an answer from Linear, even a refusal, is not a dropped connection");
});

test("A11-345: a mutation that fails with fetch failed is not sent again by the client, which cannot tell whether Linear applied it", async () => {
  const sent: string[] = [];
  const fetch = (async (_url: string, init: RequestInit = {}) => {
    const { query } = JSON.parse(String(init.body)) as { query: string };
    sent.push(query.trim().split("(")[0]);
    if (query.trim().startsWith("mutation")) throw staleSocket();
    return new Response(JSON.stringify({ data: { issues: { nodes: [{ id: "id-1" }] } } }), { status: 200 });
  }) as typeof globalThis.fetch;
  await assert.rejects(linearSource({ key: "k", fetch }).comment!("NBF-1", "hello"), /fetch failed/);
  assert.equal(sent.filter((each) => each === "mutation").length, 1, "the mutation was sent once");
});
