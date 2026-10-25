// no-token: none -- `gh` is a stub that answers from a table and records each call: no network
import { test } from "node:test";
import assert from "node:assert/strict";
import { TICKET_PULLS_FIELDS, TICKET_PULLS_LIMIT, pullsNaming } from "./ticket-pulls.ts";
import { GhFailure, type Gh } from "./gh.ts";

const control = { name: "control", nameWithOwner: "a11ign/control" };
const agentOrg = { name: "agent-org", nameWithOwner: "a11ign/agent-org" };
/** The shape `gh search prs --json url,repository,state,body,title` prints. */
const pull = (number: number, over: Record<string, unknown> = {}) => ({ url: `https://github.com/a11ign/control/pull/${number}`, repository: control, state: "open", title: "fix: a thing", body: "Refs A11-240", ...over });

const answering = (answer: unknown): Gh => () => JSON.stringify(answer);

test("A11-240: the pull requests of the repositories asked are searched by the key, in title and body, for the fields the reader needs", () => {
  const calls: string[][] = [];
  pullsNaming("A11-240", ["a11ign/control", "a11ign/agent-org"], (args) => { calls.push(args); return "[]"; });
  assert.deepEqual(calls, [["search", "prs", '"A11-240"', "--repo", "a11ign/control", "--repo", "a11ign/agent-org", "--match", "title,body", "--limit", String(TICKET_PULLS_LIMIT), "--json", TICKET_PULLS_FIELDS]]);
  assert.equal(TICKET_PULLS_FIELDS, "url,repository,state,body,title");
});

test("A11-240: each pull request is read with its address, repository, state and body, in every state GitHub reports", () => {
  const found = [pull(140), pull(141, { state: "merged" }), pull(142, { state: "closed", repository: agentOrg, url: "https://github.com/a11ign/agent-org/pull/142" })];
  assert.deepEqual(pullsNaming("A11-240", ["a11ign/control"], answering(found)), [
    { url: "https://github.com/a11ign/control/pull/140", repo: "a11ign/control", state: "open", body: "Refs A11-240" },
    { url: "https://github.com/a11ign/control/pull/141", repo: "a11ign/control", state: "merged", body: "Refs A11-240" },
    { url: "https://github.com/a11ign/agent-org/pull/142", repo: "a11ign/agent-org", state: "closed", body: "Refs A11-240" },
  ]);
});

test("A11-240: GitHub's loose match is narrowed to a pull request that holds the key on word boundaries, in its title or its body, in any case", () => {
  const found = [pull(1, { body: "Refs A11-2401" }), pull(2, { body: "Refs A11-24" }), pull(3, { body: "see a11-240." }), pull(4, { body: "", title: "fix(A11-240): a thing" }), pull(5, { body: "nothing here but A11 and 240" }), pull(6, { body: null })];
  assert.deepEqual(pullsNaming("A11-240", ["a11ign/control"], answering(found))?.map(({ url }) => url.split("/").pop()), ["3", "4"]);
});

test("A11-240: no repository is nothing to ask, and asks GitHub nothing", () => {
  const calls: string[][] = [];
  assert.deepEqual(pullsNaming("A11-240", [], (args) => { calls.push(args); return "[]"; }), []);
  assert.deepEqual(calls, []);
});

test("A11-240: a search GitHub refuses, answers in a shape this cannot read, or fills to its limit is null and never none", () => {
  const refusing: Gh = (args) => { throw new GhFailure(args, { status: 1, stdout: "", stderr: "gh: Could not resolve to a Repository (HTTP 404)\n" }); };
  assert.equal(pullsNaming("A11-240", ["a11ign/control"], refusing), null);
  assert.equal(pullsNaming("A11-240", ["a11ign/control"], () => "not json"), null);
  assert.equal(pullsNaming("A11-240", ["a11ign/control"], answering({ items: [] })), null);
  assert.equal(pullsNaming("A11-240", ["a11ign/control"], answering([pull(1), pull(2, { state: "draft" })])), null, "a state this does not know fails the read");
  assert.equal(pullsNaming("A11-240", ["a11ign/control"], answering([pull(1), pull(2, { repository: null })])), null, "a pull request with no repository fails the read");
  const full = Array.from({ length: TICKET_PULLS_LIMIT }, (_, at) => pull(at + 1));
  assert.equal(pullsNaming("A11-240", ["a11ign/control"], answering(full)), null, "a list at the limit may be cut short");
  assert.equal(pullsNaming("A11-240", ["a11ign/control"], answering(full.slice(1)))?.length, TICKET_PULLS_LIMIT - 1, "one under the limit is a whole list");
});
