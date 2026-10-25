// no-token: gh -- `closePull` is handed a stub `gh`; nothing here spawns `gh` or needs a token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closePull } from "./close-pull.ts";
import { GhFailure } from "./gh.ts";

const URL = "https://github.com/a11ign/agent-org/pull/1851";
const COMMENT = "Closed by agent-org: everything #1851 held merged with #1850, so it has no changes of its own left.";

/** A `gh` that fails as `gh pr close` does when GitHub refuses: its message on stderr. */
const refusing = (stderr: string) => (args: string[]) => { throw new GhFailure(args, { status: 1, stdout: "", stderr }); };

test("A11-248: the pull request is closed first, with one PATCH of its state, and the comment is posted on it after", () => {
  const calls: string[][] = [];
  closePull(URL, COMMENT, (args) => { calls.push(args); return ""; });
  assert.deepEqual(calls, [
    ["api", "-X", "PATCH", "repos/a11ign/agent-org/pulls/1851", "-f", "state=closed"],
    ["api", "-X", "POST", "repos/a11ign/agent-org/issues/1851/comments", "-f", `body=${COMMENT}`],
  ]);
});

test("A11-248: a close GitHub refuses throws in GitHub's first line and posts no comment, and a gh that could not start throws its own", () => {
  const calls: string[][] = [];
  const asked = (stderr: string) => (args: string[]) => { calls.push(args); return refusing(stderr)(args); };
  assert.throws(() => closePull(URL, COMMENT, asked("\n gh: Resource not accessible by integration (HTTP 403)\nmore\n")), { message: "gh: Resource not accessible by integration (HTTP 403)" });
  assert.equal(calls.length, 1, "the comment is not posted on a pull request that is still open");
  assert.throws(() => closePull(URL, COMMENT, () => { throw new Error("spawnSync gh ENOENT"); }), { message: "spawnSync gh ENOENT" });
  assert.throws(() => closePull(URL, COMMENT, refusing("")), { message: "GitHub refused to close the pull request" }, "and a refusal that printed nothing still has a reason");
});

test("A11-248: a comment that cannot be posted after the close does not undo it, and is not an error", () => {
  const calls: string[][] = [];
  closePull(URL, COMMENT, (args) => { calls.push(args); if (args.includes("POST")) throw new GhFailure(args, { status: 1, stdout: "", stderr: "gh: Forbidden (HTTP 403)\n" }); return ""; });
  assert.equal(calls.length, 2);
});

test("A11-248: an address that is no pull request throws and nothing is asked", () => {
  const calls: string[][] = [];
  assert.throws(() => closePull("https://github.com/a11ign/agent-org/issues/9", COMMENT, (args) => { calls.push(args); return ""; }), { message: /is not a GitHub pull request address/ });
  assert.deepEqual(calls, []);
});
