// no-token: none -- the pull requests are the snapshot fixture's: no network, and no `gh`
// A11-255: the open pull requests the dependency bot opened, as the code host reads them (A11-365: from the repository's snapshot)
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDependencyPulls } from "./dependency-pulls.ts";
import { snapshotsOf } from "./pull-snapshot-fixture.ts";

const HEAD = "a".repeat(40);
/** An open pull request as the snapshot holds it: GraphQL's shape, where a bot is typed `Bot` and named without a prefix. */
const listed = (number: number, over: Record<string, unknown> = {}) => ({ number, state: "OPEN", title: "deps: bump @x/y from 1.4.0 to 2.0.0", headRefName: "dependabot/npm_and_yarn/x/y-2.0.0", headRefOid: HEAD, url: `https://github.com/o/r/pull/${number}`, body: "notes", author: { login: "dependabot", __typename: "Bot" }, ...over });

test("A11-255: each pull request is read with its address, number, title, branch, head and body, authored as dependabot[bot]", async () => {
  assert.deepEqual(await openDependencyPulls("o/r", snapshotsOf({ "o/r": [listed(11), listed(12, { body: null })] })), [
    { url: "https://github.com/o/r/pull/11", number: 11, title: "deps: bump @x/y from 1.4.0 to 2.0.0", headRefName: "dependabot/npm_and_yarn/x/y-2.0.0", headSha: HEAD, author: "dependabot[bot]", body: "notes" },
    { url: "https://github.com/o/r/pull/12", number: 12, title: "deps: bump @x/y from 1.4.0 to 2.0.0", headRefName: "dependabot/npm_and_yarn/x/y-2.0.0", headSha: HEAD, author: "dependabot[bot]", body: "" },
  ]);
});

test("A11-255: a pull request of any other author is left out, whatever its title says: the author check is this plugin's own", async () => {
  const found = [listed(11), listed(12, { author: { login: "someone", __typename: "User" } }), listed(13, { author: { login: "dependabot", __typename: "User" } }), listed(14, { author: null }),
    listed(15, { author: { login: "renovate", __typename: "Bot" } }), listed(16, { author: { login: "dependabot" } })];
  assert.deepEqual((await openDependencyPulls("o/r", snapshotsOf({ "o/r": found })))?.map(({ number }) => number), [11], "a person who holds the bot's name, and an author GitHub does not type as a bot, are not the bot");
});

test("A11-255: a list that cannot be read is null, never none: a repository the snapshots cannot read, a list read in part, and a bot's pull request it cannot read", async () => {
  assert.equal(await openDependencyPulls("o/r", snapshotsOf({})), null);
  assert.equal(await openDependencyPulls("o/r", snapshotsOf({ "o/r": [listed(11)] }, { complete: false })), null);
  assert.equal(await openDependencyPulls("o/r", snapshotsOf({ "o/r": [listed(11), listed(12, { headRefOid: undefined })] })), null);
  assert.deepEqual(await openDependencyPulls("o/r", snapshotsOf({ "o/r": [] })), [], "POSITIVE CONTROL: an empty list is none");
});

test("A11-365: the list is the snapshot's, so it asks for no pull request by number", async () => {
  const snapshots = snapshotsOf({ "o/r": [listed(11), listed(12)] });
  await openDependencyPulls("o/r", snapshots);
  assert.deepEqual(snapshots.reads.pulls, []);
});
