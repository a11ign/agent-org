// no-token: gh -- Linear is a recorded `fetch` that answers GraphQL from a small in-memory workspace; nothing reaches Linear
//
// THE TRACKER CONTRACT'S SUITE, RUN ON THE LINEAR PLUGIN (A11-159, Decision 11 of A11-157): `runTrackerConformance` is the only definition of "a tracker", so Linear passes the same
// checks the fake does. The workspace below answers each query the plugin sends with a node that holds every field any of them asks for, and applies the mutations the suite makes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTrackerConformance } from "../../src/plugins/conformance/tracker.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { defaultCatalog, pluginNamed } from "../../src/plugins/registry.ts";
import { create } from "./index.ts";

type Held = { id: string; identifier: string; title: string; description: string; state: string; blockedBy: string[]; comments: { body: string; createdAt: string }[] };

const STATES = [{ id: "s-todo", name: "Todo", type: "unstarted", position: 1 }, { id: "s-done", name: "Done", type: "completed", position: 5 }];
const TYPE_OF: Record<string, string> = { Todo: "unstarted", Done: "completed" };

/** A Linear workspace of the tickets named, and the `fetch` that answers the plugin's requests from it. */
function workspace(...identifiers: string[]) {
  const held = new Map<string, Held>(identifiers.map((identifier, index) => [identifier, { id: `uuid-${index + 1}`, identifier, title: `Title ${identifier}`, description: `About ${identifier}`, state: "Todo", blockedBy: [], comments: [] }]));
  const byId = (id: string) => [...held.values()].find((entry) => entry.id === id);
  const node = (entry: Held) => ({
    id: entry.id, identifier: entry.identifier, title: entry.title, description: entry.description, updatedAt: "2026-10-21T12:00:00.000Z", url: `https://linear.app/x/issue/${entry.identifier}`, branchName: entry.identifier.toLowerCase(), priority: 2,
    state: { name: entry.state, position: entry.state === "Done" ? 5 : 1, type: TYPE_OF[entry.state] }, team: { key: entry.identifier.split("-")[0], states: { nodes: STATES } },
    project: null, assignee: { id: "u-1", name: "Dan Beck" }, parent: null, children: { nodes: [] }, labels: { nodes: [] }, attachments: { nodes: [] },
    comments: { nodes: entry.comments },
    inverseRelations: { nodes: entry.blockedBy.map((blocker) => ({ type: "blocks", issue: { identifier: blocker, branchName: blocker.toLowerCase(), state: { type: TYPE_OF[held.get(blocker)?.state ?? "Todo"], name: held.get(blocker)?.state ?? "Todo" }, attachments: { nodes: [] } } })) },
  });
  const open = () => [...held.values()].filter((entry) => TYPE_OF[entry.state] !== "completed");
  const page = (entries: Held[]) => ({ nodes: entries.map(node), pageInfo: { hasNextPage: false, endCursor: null } });
  const lookup = (team: string, number: number) => held.get(`${team}-${number}`);
  const answer = (text: string, variables: Record<string, unknown>): unknown => {
    if (text.startsWith("mutation")) return mutate(text, variables);
    if (text === "query { viewer { id name email } }") return { viewer: { id: "u-1", name: "Dan Beck", email: "dan@example.invalid" } };
    if (text.includes("viewer { assignedIssues")) return { viewer: { assignedIssues: page(open()) } };
    if (text.includes("nodes { assignee { id name } } pageInfo")) return { issues: { nodes: open().map(() => ({ assignee: { id: "u-1", name: "Dan Beck" } })), pageInfo: { hasNextPage: false, endCursor: null } } };
    if (text.includes("$after: String")) return { issues: page(open()) };
    if (text.includes("$team: String!, $number: Float!")) {
      const found = lookup(String(variables.team), Number(variables.number));
      return { issues: { nodes: found === undefined ? [] : [node(found)] } };
    }
    const aliases = [...text.matchAll(/k(\d+): issues/g)].map((match) => Number(match[1]));
    return Object.fromEntries(aliases.map((index) => {
      const found = lookup(String(variables[`t${index}`]), Number(variables[`n${index}`]));
      return [`k${index}`, { nodes: found === undefined ? [] : [node(found)] }];
    }));
  };
  const mutate = (text: string, variables: Record<string, unknown>): unknown => {
    if (text.includes("issueUpdate")) {
      const entry = byId(String(variables.id))!;
      const input = (variables.input ?? {}) as { title?: string; description?: string };
      if (variables.stateId !== undefined) entry.state = STATES.find(({ id }) => id === variables.stateId)!.name;
      if (input.title !== undefined) entry.title = input.title;
      if (input.description !== undefined) entry.description = input.description;
      return { issueUpdate: { success: true } };
    }
    if (text.includes("commentCreate")) {
      byId(String(variables.issueId))!.comments.push({ body: String(variables.body), createdAt: new Date(Date.UTC(2026, 9, 21, 12, 0, comments += 1)).toISOString() });
      return { commentCreate: { success: true } };
    }
    if (text.includes("issueRelationCreate")) {
      byId(String(variables.relatedIssueId))!.blockedBy.push(byId(String(variables.issueId))!.identifier);
      return { issueRelationCreate: { success: true } };
    }
    if (text.includes("attachmentDelete")) return { attachmentDelete: { success: true } };
    throw new Error(`the workspace does not answer: ${text}`);
  };
  let comments = 0;
  const requests: { query: string; variables: Record<string, unknown> }[] = [];
  const fetch = (async (_url: string, init: RequestInit = {}) => {
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    requests.push({ query, variables });
    return new Response(JSON.stringify({ data: answer(query, variables) }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, requests, held };
}

const KEY_FILE = "/k/linear.key";
const depsOver = (fetch: typeof globalThis.fetch) => fakePluginDeps({ fetch, readFile: (path) => (path === KEY_FILE ? "lin_api_x\n" : (() => { throw new Error("ENOENT"); })()) });

test("the Linear plugin passes the tracker contract suite, every check of it that its operations take part in", async () => {
  const world = workspace("TST-1", "TST-2");
  const source = create({ key: { path: KEY_FILE } }, depsOver(world.fetch));
  const writing = pluginNamed(defaultCatalog(), "linear")?.tooling.writer;
  assert.ok(writing !== undefined, "the manifest declares the writer tooling");
  const result = await runTrackerConformance(source, { known: "TST-1", missing: "TST-404", other: "TST-2" }, writing);
  assert.deepEqual(result.skipped, [], "Linear implements every optional operation and declares its writing, so the suite skips none");
  assert.ok(result.passed.includes("writing reads a created ticket's key back by the shape it declares"));
  assert.ok(result.passed.includes("complete finishes a ticket once and leaves a finished one alone"));
  assert.ok(result.passed.includes("texts answers each key's description and updatedAt, as read gives the description, and leaves out a key with no ticket"));
  assert.ok(result.passed.includes("detachPlan of a title the ticket has no attachment under changes nothing and is no error"));
  assert.ok(result.passed.includes("addBlockers records a relation once, and again without error"));
  assert.ok(result.passed.includes("claim records the claimant, claims reads the latest one back, and a repeated claim changes nothing"));
  assert.deepEqual(world.held.get("TST-1")?.comments.map(({ body }) => body).filter((body) => body.startsWith("agent-org: claimed")), ["agent-org: claimed by conformance.a", "agent-org: claimed by conformance.b"], "the repeated claim wrote no comment");
  assert.equal(world.held.get("TST-1")?.state, "Done", "the suite's complete moved the ticket in the recorded workspace");
});
