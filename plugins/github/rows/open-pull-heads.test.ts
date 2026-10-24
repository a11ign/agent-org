// no-token: gh -- agent-org#1193: `readOpenPullHeads` is handed a stub `run`; nothing here spawns `gh` or needs a token.
/**
 * agent-org#1193 (agent-org#1167's open-PR hold): THE OPEN-PULL-REQUEST READ, which lives in the GitHub plugin's rows (A11-160).
 *
 * Four claims, each with a case that can fail:
 *   1. a listing that reads is a `read: true` list of the fields the hold reads (number, url, head branch, label names), and the call asks for them;
 *   2. a refused runner is a named failure, never an empty list;
 *   3. an answer that is not a list is a named failure, never an empty list;
 *   4. a list that fills `limit` is a named failure, because a full page may be cut short.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readOpenPullHeads } from "./open-pull-heads.ts";

const REPO = "a11ign/agent-org";

test("#1193: a readable listing is every open pull request, with the fields the hold reads", () => {
  const argv: string[][] = [];
  const reply = JSON.stringify([
    { number: 1184, url: `https://github.com/${REPO}/pull/1184`, headRefName: "agent/class-prune-removes-open-agent-org-1167", labels: [{ name: "session:worker-agent-org-1167" }, { name: "lane:any" }] },
    { number: 1190, url: `https://github.com/${REPO}/pull/1190`, headRefName: "agent/other-branch", labels: [] },
  ]);
  const result = readOpenPullHeads(REPO, (args) => { argv.push(args); return reply; }, 1000);

  assert.deepEqual(argv, [["pr", "list", "--repo", REPO, "--state", "open", "--limit", "1000", "--json", "number,url,headRefName,labels"]]);
  assert.deepEqual(result, {
    read: true,
    pulls: [
      { number: 1184, url: `https://github.com/${REPO}/pull/1184`, headRefName: "agent/class-prune-removes-open-agent-org-1167", labels: ["session:worker-agent-org-1167", "lane:any"] },
      { number: 1190, url: `https://github.com/${REPO}/pull/1190`, headRefName: "agent/other-branch", labels: [] },
    ],
  });
});

test("#1193: a refused runner is `read: false` with a reason, never an empty list", () => {
  const result = readOpenPullHeads(REPO, () => { throw new Error("gh pr list exited 4: HTTP 403"); }, 1000);

  assert.equal(result.read, false, "a refused read is not a reading");
  assert.match(result.read ? "" : result.reason, /HTTP 403/, "the reason carries the runner's own first line");
});

test("#1193: an answer that is not a list is `read: false` with a reason, never an empty list", () => {
  const result = readOpenPullHeads(REPO, () => '{"message":"Not Found"}', 1000);

  assert.equal(result.read, false);
  assert.match(result.read ? "" : result.reason, /did not return a list/);
});

test("#1193: a list that fills the limit is `read: false`, because a full page may be cut short", () => {
  const full = JSON.stringify([
    { number: 1, url: "u1", headRefName: "a", labels: [] },
    { number: 2, url: "u2", headRefName: "b", labels: [] },
  ]);
  const result = readOpenPullHeads(REPO, () => full, 2);

  assert.equal(result.read, false, "two pulls at a limit of two is a page that may have been cut");
  assert.match(result.read ? "" : result.reason, /listing limit/);
});

test("a refused runner's reason is its message's FIRST line, behind the words the prune's report quotes", () => {
  const result = readOpenPullHeads(REPO, () => { throw new Error("gh: authentication required\nmore"); }, 1000);

  assert.deepEqual(result, { read: false, reason: "the open pull request listing failed: gh: authentication required" });
});

test("a listing of one page short of the limit is read whole, and every pull request's labels are flattened to their names (an absent list is none)", () => {
  const result = readOpenPullHeads(REPO, () => JSON.stringify([{ number: 7, url: "u", headRefName: "h", labels: [{ name: "session:x" }, { name: "lane:y" }] }, { number: 8, url: "v", headRefName: "g" }]), 3);

  assert.deepEqual(result, { read: true, pulls: [{ number: 7, url: "u", headRefName: "h", labels: ["session:x", "lane:y"] }, { number: 8, url: "v", headRefName: "g", labels: [] }] });
});
