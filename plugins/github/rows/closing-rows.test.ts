// no-token: gh -- every operation is handed a stub `run`; nothing here spawns `gh` or needs a token
/**
 * A11-160 (step 9): THE ARGUMENTS AND READINGS OF THE WRITES THE CLOSE PATHS MAKE, which core's tests of `close-rows-for-merged-pr.ts` and `close-rows-sweep.ts` used to assert over a stubbed `gh` and which are the plugin's
 * now (core's tests run on the fake code host's rows). The argument lists are copied from the code they were moved from. The reads of a merged pull request's closing references are in `closing-pull-reads.test.ts`, the
 * claim checks' in `closing-claim-reads.test.ts`, `worker:state`'s and the removers' in `closing-worker-reads.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { addBlockedByEdge, addSubIssueTo, closeCompletedRow, closingRowsOf, fileRowInMilestone, rateLimitDumpOf } from "./closing-rows.ts";
import type { RowsRunners } from "./index.ts";

/** A `run` that records the argument list it was given and answers what `answer` makes of it. */
const recording = (answer: (args: string[]) => string = () => "") => {
  const seen: string[][] = [];
  return { seen, run: (args: string[]): string => { seen.push(args); return answer(args); } };
};

const refusing = (): string => {
  throw new Error("HTTP 502");
};

test("the rate limit is read off the headers of ONE minimal GraphQL call, `--include`, never the rate-limit endpoint's body (#1275 measured it lying)", () => {
  const { seen, run } = recording(() => "HTTP/2.0 200 OK\nX-Ratelimit-Used: 7\n\n{}");
  assert.equal(rateLimitDumpOf({ run }), "HTTP/2.0 200 OK\nX-Ratelimit-Used: 7\n\n{}");
  assert.deepEqual(seen, [["api", "graphql", "-f", "query=query{rateLimit{limit cost remaining resetAt}}", "--include"]]);
  assert.throws(() => rateLimitDumpOf({ run: refusing }), /HTTP 502/);
});

test("a row is closed as COMPLETED with its comment in ONE call in its repository, and a refusal throws so the caller reports the row as not closed", () => {
  const { seen, run } = recording();
  closeCompletedRow({ repo: "a11ign/a11ign", row: 560, comment: "Closed by the pipeline.\n\nIf the work did not land, reopen.", run });
  assert.deepEqual(seen, [["issue", "close", "560", "--repo", "a11ign/a11ign", "--comment", "Closed by the pipeline.\n\nIf the work did not land, reopen.", "--reason", "completed"]]);
  assert.throws(() => closeCompletedRow({ repo: "r/r", row: 1, comment: "c", run: refusing }), /HTTP 502/);
});

test("a row is filed with one --label per label and a --milestone only where one is named, and the address it prints numbers it", () => {
  const filed = recording(() => "https://github.com/a11ign/agent-org/issues/4712\n");
  assert.equal(fileRowInMilestone({ repo: "a11ign/agent-org", title: "Verify x", body: "the body", labels: ["ready", "verify"], milestone: "v2", run: filed.run }), 4712);
  assert.deepEqual(filed.seen, [["issue", "create", "--repo", "a11ign/agent-org", "--title", "Verify x", "--body", "the body", "--label", "ready", "--label", "verify", "--milestone", "v2"]]);
  const plain = recording(() => "https://github.com/a11ign/agent-org/issues/9");
  assert.equal(fileRowInMilestone({ repo: "a11ign/agent-org", title: "t", body: "b", labels: [], milestone: null, run: plain.run }), 9);
  assert.deepEqual(plain.seen, [["issue", "create", "--repo", "a11ign/agent-org", "--title", "t", "--body", "b"]], "no labels and no milestone: neither flag is sent");
});

test("a row filed that printed no address THROWS (a row filed and not numbered would be filed again), and a refused call throws", () => {
  assert.throws(() => fileRowInMilestone({ repo: "r/r", title: "t", body: "b", labels: [], milestone: null, run: () => "created" }), /answered no issue URL: created/);
  assert.throws(() => fileRowInMilestone({ repo: "r/r", title: "t", body: "b", labels: [], milestone: null, run: refusing }), /HTTP 502/);
});

test("a blocker is an edit of the blocked row naming the blocker; a sub-issue is a POST naming the child's id, which is read first, trimmed", () => {
  const edge = recording();
  addBlockedByEdge({ repo: "a11ign/agent-org", row: 4712, blocker: 4700, run: edge.run });
  assert.deepEqual(edge.seen, [["issue", "edit", "4712", "--repo", "a11ign/agent-org", "--add-blocked-by", "4700"]]);
  const sub = recording((args) => (args[0] === "api" && args.includes("--jq") ? "9876543\n" : ""));
  addSubIssueTo({ repo: "a11ign/agent-org", parent: 4700, child: 4712, run: sub.run });
  assert.deepEqual(sub.seen, [["api", "repos/a11ign/agent-org/issues/4712", "--jq", ".id"], ["api", "-X", "POST", "repos/a11ign/agent-org/issues/4700/sub_issues", "-F", "sub_issue_id=9876543"]]);
  assert.throws(() => addBlockedByEdge({ repo: "r/r", row: 2, blocker: 1, run: refusing }), /HTTP 502/);
  assert.throws(() => addSubIssueTo({ repo: "r/r", parent: 1, child: 2, run: refusing }), /HTTP 502/);
  const idOnly = recording((args) => (args.includes("--jq") ? "1\n" : (() => { throw new Error("HTTP 422"); })()));
  assert.throws(() => addSubIssueTo({ repo: "r/r", parent: 1, child: 2, run: idOnly.run }), /HTTP 422/, "the POST's refusal throws after the id was read");
});

test("an operation whose caller hands no run uses the plugin's own, and one that hands a run uses it", () => {
  const own = recording();
  const handed = recording();
  const runners: RowsRunners = { own: own.run, queue: own.run };
  const rows = closingRowsOf(runners, () => { throw new Error("these operations read nothing of core's"); });
  rows.closeCompletedRow({ repo: "r/r", row: 1, comment: "c" });
  rows.addBlockedByEdge({ repo: "r/r", row: 2, blocker: 1, run: handed.run });
  assert.deepEqual(own.seen.map((args) => args[1]), ["close"]);
  assert.deepEqual(handed.seen.map((args) => args[1]), ["edit"]);
});
