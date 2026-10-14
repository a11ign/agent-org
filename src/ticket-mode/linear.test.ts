// no-token: gh -- `fetch` and `security` are injected; nothing reaches Linear or the Keychain
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { LINEAR_API, downloadName, linearSource, pullState, readLinearKey, uploadLinks } from "./linear.ts";
import type { Ticket } from "./source.ts";

const node = (identifier: string, extra: Record<string, unknown> = {}) => ({
  identifier, title: `Title ${identifier}`, description: null, url: `https://linear.app/x/issue/${identifier}`, branchName: identifier.toLowerCase(),
  priority: 2, state: { name: "Backlog", position: 0 }, team: { key: identifier.split("-")[0] }, project: { name: "Visual Explorer - GA" }, parent: null, ...extra,
});
/** Linear's answer to the read of a ticket's attachments. */
const attached = (...nodes: { url: string; title: string }[]) => ({ data: { issues: { nodes: [{ attachments: { nodes } }] } } });

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

test("assigned() reads every page of the viewer's unfinished tickets, sending the key and nothing else", async () => {
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

test("blockers() reads each ticket's \"blocked by\" from Linear's inverse relations of type blocks, with each blocker's state and pull requests", async () => {
  const merged = "https://github.com/netboxlabs/nbl-ui-platform-libs/pull/775";
  const { fetch, requests } = linear([{ data: {
    k0: { nodes: [{ inverseRelations: { nodes: [
      { type: "blocks", issue: { identifier: "NBF-1936", state: { type: "completed", name: "Done" }, attachments: { nodes: [
        { url: merged, sourceType: "github", metadata: { status: "merged" } },
        { url: "https://uploads.linear.app/org/a/plan", sourceType: "oauthClient", metadata: {} },
      ] } } },
      { type: "related", issue: { identifier: "VE-66", state: { type: "backlog", name: "Backlog" }, attachments: { nodes: [] } } },
      { type: "blocks", issue: { identifier: "NBF-1944", state: { type: "unstarted", name: "Planned" }, attachments: { nodes: [] } } },
    ] } }] },
    k1: { nodes: [{ inverseRelations: { nodes: [] } }] },
    k2: { nodes: [] },
  } }]);
  const blockers = await linearSource({ key: "k", fetch }).blockers!(["NBF-1940", "NBF-1", "NBF-9999"]);
  assert.deepEqual([...blockers], [
    ["NBF-1940", [{ key: "NBF-1936", state: "completed", status: "Done", pulls: { [merged]: "merged" } }, { key: "NBF-1944", state: "unstarted", status: "Planned", pulls: {} }]],
    ["NBF-1", []],
  ], "a related ticket is no blocker, and a key Linear has no ticket for is left out");
  assert.equal(requests.length, 1, "one request for the whole batch");
  assert.match(JSON.parse(String(requests[0].init.body)).query, /inverseRelations \{ nodes \{ type issue \{ identifier state \{ type name \}/);
});

test("a pull request is merged or closed only on Linear's word, and open otherwise", () => {
  assert.deepEqual(["merged", "closed", "draft", "open", "inReview", undefined].map(pullState), ["merged", "closed", "open", "open", "open", "open"]);
});

test("the key comes from the Keychain service or the file the host file names, and an empty one is refused", () => {
  const calls: string[][] = [];
  assert.equal(readLinearKey({ keychain: "agent-org-linear" }, (args) => { calls.push(args); return "lin_api_x\n"; }), "lin_api_x");
  assert.deepEqual(calls, [["find-generic-password", "-s", "agent-org-linear", "-w"]]);
  assert.equal(readLinearKey({ path: "/k" }, () => { throw new Error("not used"); }, () => " lin_api_y \n"), "lin_api_y");
  assert.throws(() => readLinearKey({ keychain: "s" }, () => "\n"), /is empty/);
  assert.throws(() => readLinearKey({ keychain: "agent-org-linear" }, () => { throw new Error("SecKeychainSearchCopyNext"); }),
    /no Linear key in the Keychain under agent-org-linear\. Store one with: security add-generic-password/, "a missing key names the one command that stores it");
  assert.throws(() => readLinearKey({ path: "/nope" }, () => "", () => { throw new Error("ENOENT"); }), /cannot be read/);
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

/** Linear's answer to the read attachPlan starts with: the ticket's id, its state's type, its team's states and its uploads. */
const planning = (type: string, ...uploads: { url: string; title: string }[]) => ({ data: { issues: { nodes: [{
  id: "uuid-1", state: { type, name: type === "backlog" ? "Backlog" : "In Progress" }, team: { states: { nodes: [{ id: "s-backlog", name: "Backlog" }, { id: "s-planned", name: "Planned" }] } }, attachments: { nodes: uploads },
}] } } });
const signed = (n: number) => ({ data: { fileUpload: { success: true, uploadFile: { uploadUrl: `https://storage.example/upload-${n}?sig=1`, assetUrl: `https://uploads.linear.app/org/asset-${n}`,
  headers: [{ key: "x-goog-content-length-range", value: "1,100" }] } } } });
const done = { data: { ok: { success: true } } };
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
