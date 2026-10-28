// no-token: none -- `gh` is a stub that answers from a table and records each call: no network
// A11-255: the open pull requests the dependency bot opened, as the code host reads them
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEPENDENCY_PULLS_FIELDS, DEPENDENCY_PULLS_LIMIT, openDependencyPulls } from "./dependency-pulls.ts";
import type { AsyncGh } from "./gh.ts";

const HEAD = "a".repeat(40);
/** The shape `gh pr list --json number,title,headRefName,headRefOid,author,body,url` prints. */
const listed = (number: number, over: Record<string, unknown> = {}) => ({ number, title: "deps: bump @x/y from 1.4.0 to 2.0.0", headRefName: "dependabot/npm_and_yarn/x/y-2.0.0", headRefOid: HEAD, url: `https://github.com/o/r/pull/${number}`, body: "notes", author: { login: "app/dependabot", is_bot: true }, ...over });
const answering = (answer: unknown): AsyncGh => async () => JSON.stringify(answer);

test("A11-255: the open pull requests are listed with the fields the board reads, and with no --author, which gh sends as a search", async () => {
  const calls: string[][] = [];
  await openDependencyPulls("o/r", async (args) => { calls.push(args); return "[]"; });
  assert.deepEqual(calls, [["pr", "list", "--repo", "o/r", "--state", "open", "--limit", String(DEPENDENCY_PULLS_LIMIT), "--json", DEPENDENCY_PULLS_FIELDS]]);
  assert.ok(!calls[0]!.some((arg) => ["--author", "-A", "--search", "-S", "--label", "-l", "--assignee", "-a"].includes(arg)), "no flag gh turns into a search");
  assert.equal(DEPENDENCY_PULLS_FIELDS, "number,title,headRefName,headRefOid,author,body,url");
});

test("A11-255: each pull request is read with its address, number, title, branch, head and body, authored as dependabot[bot]", async () => {
  assert.deepEqual(await openDependencyPulls("o/r", answering([listed(11), listed(12, { body: null, author: { login: "dependabot", is_bot: true } })])), [
    { url: "https://github.com/o/r/pull/11", number: 11, title: "deps: bump @x/y from 1.4.0 to 2.0.0", headRefName: "dependabot/npm_and_yarn/x/y-2.0.0", headSha: HEAD, author: "dependabot[bot]", body: "notes" },
    { url: "https://github.com/o/r/pull/12", number: 12, title: "deps: bump @x/y from 1.4.0 to 2.0.0", headRefName: "dependabot/npm_and_yarn/x/y-2.0.0", headSha: HEAD, author: "dependabot[bot]", body: "" },
  ]);
});

test("A11-255: a pull request of any other author is left out, whatever its title says: the author check is this plugin's own", async () => {
  const found = [listed(11), listed(12, { author: { login: "someone", is_bot: false } }), listed(13, { author: { login: "dependabot", is_bot: false } }), listed(14, { author: null }), listed(15, { author: { login: "renovate[bot]", is_bot: true } })];
  assert.deepEqual((await openDependencyPulls("o/r", answering(found)))?.map(({ number }) => number), [11]);
});

test("A11-255: a list that cannot be read is null, never none: a refused gh, text that is not JSON, a list at the limit, and a bot's pull request it cannot read", async () => {
  const refuses: AsyncGh = async () => { throw new Error("gh: Could not resolve to a Repository (HTTP 404)"); };
  assert.equal(await openDependencyPulls("o/r", refuses), null);
  assert.equal(await openDependencyPulls("o/r", async () => "not json"), null);
  assert.equal(await openDependencyPulls("o/r", answering({ message: "Not Found" })), null);
  assert.equal(await openDependencyPulls("o/r", answering(Array.from({ length: DEPENDENCY_PULLS_LIMIT }, (_, at) => listed(at + 1)))), null);
  assert.equal(await openDependencyPulls("o/r", answering([listed(11), listed(12, { headRefOid: undefined })])), null);
  assert.deepEqual(await openDependencyPulls("o/r", answering([])), [], "POSITIVE CONTROL: an empty list is none");
});
