// no-token: none -- `gh` is a stub that answers from a table of pull requests and records each call: no network, and no pull request is touched
import { test } from "node:test";
import assert from "node:assert/strict";
import { GhFailure, type Gh } from "./gh.ts";
import { refusalOf, requestStackMerge, stackMergeFactsOf, STACK_API_VERSION } from "./stack-merge.ts";

const URL = "https://github.com/a11ign/agent-org/pull/1872";
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);

type World = {
  /** The REST answer for the pull request, merged over a stacked, open one based on `main` at HEAD. Null: GitHub answers 404. */
  pull?: Record<string, unknown> | null;
  /** The armed query's pull request node. Null: GitHub has none. */
  node?: Record<string, unknown> | null;
  /** The bodies of the issue comments, oldest first. */
  comments?: string[];
  /** Calls that fail, matched on their text. */
  failing?: RegExp;
};

const marker = (head: string, reason: string, number = 1872) => `<!-- agent-org:stack-merge head=${head} -->\nGitHub refused the stack merge of #${number}: ${reason}`;

/** A `gh` that answers from `world` and records each call, as the three reads of the stack merge and the dispatch make them. */
function fakeGh(world: World = {}) {
  const calls: string[][] = [];
  const gh: Gh = (args) => {
    calls.push(args);
    const text = args.join(" ");
    if (world.failing?.test(text)) throw new GhFailure(args, { status: 1, stdout: "", stderr: "gh: Resource not accessible by integration (HTTP 403)\n" });
    if (args[0] === "api" && args[1] === "graphql") return JSON.stringify(world.node === undefined ? { merged: false, autoMergeRequest: null, mergeQueueEntry: null } : world.node);
    if (args[0] === "api" && args.includes("--paginate")) {
      const marked = (world.comments ?? []).filter((body) => body.startsWith("<!-- agent-org:stack-merge "));
      return marked.map((body) => JSON.stringify(body)).join("\n") + (marked.length > 0 ? "\n" : "");
    }
    if (args[0] === "api") {
      if (world.pull === null) throw new GhFailure(args, { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" });
      return JSON.stringify({ stack: { number: 1874 }, merged: false, base: { ref: "main", repo: { default_branch: "main" } }, head: { sha: HEAD }, ...world.pull });
    }
    if (args[0] === "workflow") return "";
    throw new Error(`unexpected gh ${text}`);
  };
  return { gh, calls };
}

test("A11-238: a stacked, open pull request on the default branch is read with the stacks API version, and its queue seat and refusal are read after", () => {
  const { gh, calls } = fakeGh({ comments: [marker(MOVED, "an older refusal"), marker(HEAD, "a member below has changes requested")] });
  assert.deepEqual(stackMergeFactsOf(URL, gh), { stacked: true, base: "main", defaultBranch: "main", head: HEAD, settled: null, refusal: { head: HEAD, reason: "a member below has changes requested" } });
  assert.deepEqual(calls[0], ["api", "-H", `X-GitHub-Api-Version: ${STACK_API_VERSION}`, "repos/a11ign/agent-org/pulls/1872"], "the pull request is read under the version the stack field is documented against");
  assert.equal(STACK_API_VERSION, "2026-03-10");
  assert.ok(calls[1].includes("graphql") && calls[1].includes("n=1872") && calls[1].includes("r=agent-org"), "the queue seat is asked of this pull request");
  assert.equal(calls[2][2], "repos/a11ign/agent-org/issues/1872/comments", "and so are its comments");
  assert.equal(calls.length, 3);
});

test("A11-238: the newest refusal comment is the one that stands", () => {
  const { gh } = fakeGh({ comments: [marker(MOVED, "first"), "a person's comment", marker(HEAD, "second")] });
  assert.deepEqual(stackMergeFactsOf(URL, gh)?.refusal, { head: HEAD, reason: "second" });
});

test("A11-238: a pull request with no refusal comment has none, and a comment whose marker carries no head is no refusal", () => {
  assert.equal(stackMergeFactsOf(URL, fakeGh().gh)?.refusal, null);
  assert.equal(stackMergeFactsOf(URL, fakeGh({ comments: ["<!-- agent-org:stack-merge -->\nGitHub refused the stack merge of #1872: no head"] }).gh)?.refusal, null);
});

test("A11-238: the marker comment is parsed as the arm bot writes it: the head, then GitHub's reason with its lead words left out, a reason of many lines whole", () => {
  assert.deepEqual(refusalOf(marker(HEAD, "Pull request is not mergeable")), { head: HEAD, reason: "Pull request is not mergeable" });
  assert.deepEqual(refusalOf(`<!-- agent-org:stack-merge head=${HEAD} -->\nGitHub refused the stack merge of #9: Required status check "gate" is expected.\nA second line.`), { head: HEAD, reason: 'Required status check "gate" is expected.\nA second line.' });
  assert.deepEqual(refusalOf(`<!-- agent-org:stack-merge head=${HEAD} -->`), { head: HEAD, reason: "no reason given" });
  assert.equal(refusalOf("GitHub refused the stack merge of #9: no marker"), null);
});

test("A11-238: a pull request in no stack is answered from the one read, and its queue seat and comments are not asked", () => {
  const { gh, calls } = fakeGh({ pull: { stack: null } });
  assert.deepEqual(stackMergeFactsOf(URL, gh), { stacked: false, base: "main", defaultBranch: "main", head: HEAD, settled: null, refusal: null });
  assert.equal(calls.length, 1);
  assert.equal(stackMergeFactsOf(URL, fakeGh({ pull: { stack: undefined } }).gh)?.stacked, false, "a pull request with no stack field is in none");
});

test("A11-238: a merged pull request is settled as merged, and its queue seat is not asked", () => {
  const { gh, calls } = fakeGh({ pull: { merged: true } });
  assert.equal(stackMergeFactsOf(URL, gh)?.settled, "merged");
  assert.equal(calls.length, 1);
});

test("A11-238: a pull request in the merge queue, or with auto-merge on, is settled as queued, and one that merged since is merged", () => {
  assert.equal(stackMergeFactsOf(URL, fakeGh({ node: { merged: false, autoMergeRequest: null, mergeQueueEntry: { state: "QUEUED" } } }).gh)?.settled, "queued");
  assert.equal(stackMergeFactsOf(URL, fakeGh({ node: { merged: false, autoMergeRequest: { enabledAt: "t" }, mergeQueueEntry: null } }).gh)?.settled, "queued");
  assert.equal(stackMergeFactsOf(URL, fakeGh({ node: { merged: true, autoMergeRequest: null, mergeQueueEntry: { state: "QUEUED" } } }).gh)?.settled, "merged");
});

test("A11-238: a base that is not the default branch is read as it is, so the board can tell a member that has others below it", () => {
  const facts = stackMergeFactsOf(URL, fakeGh({ pull: { base: { ref: "a11-198-the-bottom-member", repo: { default_branch: "main" } } } }).gh);
  assert.deepEqual([facts?.base, facts?.defaultBranch], ["a11-198-the-bottom-member", "main"]);
});

test("A11-238: a pull request that cannot be read is null, never 'not in a stack'", () => {
  assert.equal(stackMergeFactsOf(URL, fakeGh({ pull: null }).gh), null, "a 404");
  assert.equal(stackMergeFactsOf("https://example.com/not/a/pull", fakeGh().gh), null, "an address that is no GitHub pull request");
  assert.equal(stackMergeFactsOf(URL, fakeGh({ failing: /graphql/ }).gh), null, "a queue seat that could not be asked");
  assert.equal(stackMergeFactsOf(URL, fakeGh({ failing: /--paginate/ }).gh), null, "comments that could not be read");
  assert.equal(stackMergeFactsOf(URL, fakeGh({ node: null }).gh), null, "a pull request GitHub has no node for");
  assert.equal(stackMergeFactsOf(URL, fakeGh({ pull: { head: {} } }).gh), null, "an answer that names no head");
  assert.equal(stackMergeFactsOf(URL, fakeGh({ pull: { base: { ref: "main" } } }).gh), null, "an answer that names no default branch");
  assert.equal(stackMergeFactsOf(URL, () => "not json"), null, "an answer that is not JSON");
});

test("A11-238: the hand-back dispatches the arm bot's workflow on main for this pull request's number alone", () => {
  const { gh, calls } = fakeGh();
  requestStackMerge({ repo: "a11ign/agent-org", number: 1872 }, gh);
  assert.deepEqual(calls, [["workflow", "run", "auto-arm.yml", "--repo", "a11ign/agent-org", "--ref", "main", "-f", "pr=1872"]]);
});

test("A11-238: a refused dispatch throws GitHub's first line, not the command", () => {
  const { gh } = fakeGh({ failing: /workflow/ });
  assert.throws(() => requestStackMerge({ repo: "a11ign/agent-org", number: 1872 }, gh), { message: "gh: Resource not accessible by integration (HTTP 403)" });
  assert.throws(() => requestStackMerge({ repo: "a11ign/agent-org", number: 1872 }, () => { throw new Error("spawn gh ENOENT"); }), { message: "spawn gh ENOENT" });
});
