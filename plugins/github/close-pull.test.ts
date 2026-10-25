// no-token: gh -- `closePull` is handed a stub `gh`; nothing here spawns `gh` or needs a token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closePull } from "./close-pull.ts";
import { GhFailure } from "./gh.ts";

const URL = "https://github.com/a11ign/agent-org/pull/1851";
const COMMENT = "Closed by agent-org: everything #1851 held merged with #1850, so it has no changes of its own left.";

/** A `gh` that fails as `gh pr close` does when GitHub refuses: its message on stderr. */
const refusing = (stderr: string) => (args: string[]) => { throw new GhFailure(args, { status: 1, stdout: "", stderr }); };

test("A11-248: the close is one `gh pr close` of the pull request's number in its repository, carrying the comment", () => {
  const calls: string[][] = [];
  closePull(URL, COMMENT, (args) => { calls.push(args); return ""; });
  assert.deepEqual(calls, [["pr", "close", "1851", "--repo", "a11ign/agent-org", "--comment", COMMENT]]);
});

test("A11-248: a close GitHub refuses throws in GitHub's first line, and a gh that could not start throws its own", () => {
  assert.throws(() => closePull(URL, COMMENT, refusing("\n GraphQL: Resource not accessible by integration (closePullRequest)\nmore\n")), { message: "GraphQL: Resource not accessible by integration (closePullRequest)" });
  assert.throws(() => closePull(URL, COMMENT, () => { throw new Error("spawnSync gh ENOENT"); }), { message: "spawnSync gh ENOENT" });
  assert.throws(() => closePull(URL, COMMENT, refusing("")), { message: "GitHub refused to close the pull request" }, "and a refusal that printed nothing still has a reason");
});

test("A11-248: an address that is no pull request throws and nothing is asked", () => {
  const calls: string[][] = [];
  assert.throws(() => closePull("https://github.com/a11ign/agent-org/issues/9", COMMENT, (args) => { calls.push(args); return ""; }), { message: /is not a GitHub pull request address/ });
  assert.deepEqual(calls, []);
});
