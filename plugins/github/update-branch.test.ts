// no-token: gh -- `updateBranch` is handed a stub `gh`; nothing here spawns `gh` or needs a token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { updateBranch } from "./update-branch.ts";
import { GhFailure } from "./gh.ts";

const URL = "https://github.com/a11ign/agent-org/pull/1851";
const HEAD = "1a2b3c4d".padEnd(40, "0");

/** A `gh` that fails as `gh api` does on a 4xx: its message on stderr, the body GitHub answered on stdout. */
const refusing = (stderr: string, stdout = "") => (args: string[]) => { throw new GhFailure(args, { status: 1, stdout, stderr }); };

test("A11-215: the update is one PUT to the pull request's update-branch, carrying the head it was read at, and 202 is updated", () => {
  const calls: string[][] = [];
  const answer = updateBranch(URL, HEAD, (args) => { calls.push(args); return '{"message":"Updating pull request branch.","url":"https://github.com/a11ign/agent-org/pull/1851"}'; });
  assert.deepEqual(answer, { kind: "updated" });
  assert.deepEqual(calls, [["api", "-X", "PUT", "repos/a11ign/agent-org/pulls/1851/update-branch", "-f", `expected_head_sha=${HEAD}`]]);
});

test("A11-215: a 422 that says merge conflict is a conflict, and one that says there is nothing to take from the base is up to date", () => {
  assert.deepEqual(updateBranch(URL, HEAD, refusing("gh: merge conflict between base and head (HTTP 422)\n", '{"message":"merge conflict between base and head"}')), { kind: "conflict" });
  assert.deepEqual(updateBranch(URL, HEAD, refusing("gh: There are no new commits on the base branch. (HTTP 422)\n")), { kind: "up-to-date" });
});

test("A11-215: any other answer is a refusal in GitHub's first line, a head that moved included, and it never throws", () => {
  const moved = updateBranch(URL, HEAD, refusing("gh: expected head sha didn't match current head ref. (HTTP 422)\n"));
  assert.deepEqual(moved, { kind: "refused", reason: "gh: expected head sha didn't match current head ref. (HTTP 422)" }, "the head moved: not raced, and not a conflict");
  assert.deepEqual(updateBranch(URL, HEAD, refusing("gh: Resource not accessible by integration (HTTP 403)\n")), { kind: "refused", reason: "gh: Resource not accessible by integration (HTTP 403)" });
  assert.deepEqual(updateBranch(URL, HEAD, () => { throw new Error("spawnSync gh ENOENT"); }), { kind: "refused", reason: "spawnSync gh ENOENT" }, "a gh that could not start");
  assert.deepEqual(updateBranch(URL, HEAD, refusing("")), { kind: "refused", reason: "GitHub refused the update" }, "and a refusal that printed nothing still has a reason");
});

test("A11-215: an address that is no pull request is refused and nothing is asked", () => {
  const calls: string[][] = [];
  const answer = updateBranch("https://github.com/a11ign/agent-org/issues/9", HEAD, (args) => { calls.push(args); return ""; });
  assert.equal(answer.kind, "refused");
  assert.deepEqual(calls, []);
});
