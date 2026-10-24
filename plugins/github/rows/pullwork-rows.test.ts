// no-token: none -- `run` answers from a recorded table or a stub: no GitHub CLI runs
/**
 * A11-160, step 9: WHAT `pr-open`, `pr-hold`, `carry-branch`, `stranded-branches` AND THE WORKER'S `Stop` HOOK ASK OF GITHUB, in GitHub's own words. Each caller DECIDES (which body to refuse, who holds a
 * pull request, which branch is stranded, what a refusal exits with); its tests run on the fake code host's rows. What the argument lists say, which flags select what, and how a raw answer is read are the operations'
 * (`src/pr-open.test.ts`, `src/pr-hold.test.ts`, `src/packaging/stranded-branches.test.ts`, ... held them over a stubbed `gh` before). The cases were moved out of those core tests, each with
 * the assertion it had; the argument lists are copied from the callers they were moved from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RowsHelpers, RowsRun } from "../../../src/plugins/contracts/code-host-rows.ts";
import { rowsReadHelpers } from "../../../src/plugins/rows-light-helpers.ts";
import { createRows } from "./index.ts";

const rows = () => createRows(() => rowsReadHelpers() as unknown as RowsHelpers);
const REPO = "a11ign/a11ign";
const OTHER = "a11ign/agent-org";

/** A `run` that keeps every argument list it was handed and answers `answer` (text, or a function of the arguments); a function that throws is a refused call. */
function recording(answer: string | ((args: string[]) => string) = "") {
  const calls: string[][] = [];
  const run: RowsRun = (args) => { calls.push([...args]); return typeof answer === "function" ? answer(args) : answer; };
  return { run, calls };
}
/** What `gh` throws for a call it refused: the status, and what it printed on stderr. */
const refusal = (stderr: string) => Object.assign(new Error(`Command failed: gh\n${stderr}`), { status: 1, stderr });

// --- pr-open: the arguments of the writes -------------------------------------------------------------------------------

test("a pull request write is `gh pr <mode>` with the arguments the author gave, in their order", () => {
  assert.deepEqual(rows().pullWriteArgs("create", ["--head", "agent/x", "--title", "t", "--body", "b"]), ["pr", "create", "--head", "agent/x", "--title", "t", "--body", "b"]);
  assert.deepEqual(rows().pullWriteArgs("edit", ["12", "--body", "b"]), ["pr", "edit", "12", "--body", "b"]);
});

test("#4968: the arm after a create is auto-merge with a merge commit, named by `--head`", () => {
  assert.deepEqual(rows().armArgsAfterCreate({ rest: ["--head", "agent/x", "--title", "t", "--body", "b"], branch: null }), [["pr", "merge", "--auto", "--merge", "agent/x"]]);
  assert.deepEqual(rows().armArgsAfterCreate({ rest: ["--head=agent/x"], branch: "agent/other" }), [["pr", "merge", "--auto", "--merge", "agent/x"]], "the fused spelling names it too");
});

test("#952: a create with --repo and no --head arms the branch it was made from; --head still wins over the tree's branch", () => {
  assert.deepEqual(rows().armArgsAfterCreate({ rest: ["--repo", OTHER, "--title", "t"], branch: "agent/x" }), [["pr", "merge", "--auto", "--merge", "agent/x", "--repo", OTHER]]);
  assert.deepEqual(rows().armArgsAfterCreate({ rest: ["--head", "agent/h", "--repo", OTHER], branch: "agent/x" }), [["pr", "merge", "--auto", "--merge", "agent/h", "--repo", OTHER]]);
});

test("#952 (NEGATIVE CONTROL): with no --repo and no --head the arm names no pull request (gh reads the checkout's branch), and --repo with no branch to name arms nothing, rather than the argv gh refuses", () => {
  assert.deepEqual(rows().armArgsAfterCreate({ rest: ["--title", "t"], branch: null }), [["pr", "merge", "--auto", "--merge"]]);
  assert.deepEqual(rows().armArgsAfterCreate({ rest: ["--title", "t"], branch: "agent/x" }), [["pr", "merge", "--auto", "--merge"]], "the tree's branch is named only with --repo");
  assert.deepEqual(rows().armArgsAfterCreate({ rest: ["--repo", OTHER], branch: null }), []);
});

test("the session label after a create is `pr edit --add-label`, aimed as the arm is", () => {
  assert.deepEqual(rows().labelArgsAfterCreate({ rest: ["--repo", OTHER], branch: "agent/x", label: "session:ceo" }), [["pr", "edit", "agent/x", "--repo", OTHER, "--add-label", "session:ceo"]]);
  assert.deepEqual(rows().labelArgsAfterCreate({ rest: ["--head", "agent/h"], branch: null, label: "session:ceo" }), [["pr", "edit", "agent/h", "--add-label", "session:ceo"]]);
  assert.deepEqual(rows().labelArgsAfterCreate({ rest: ["--title", "t"], branch: null, label: "session:ceo" }), [["pr", "edit", "--add-label", "session:ceo"]]);
  assert.deepEqual(rows().labelArgsAfterCreate({ rest: ["--repo", OTHER], branch: null, label: "session:ceo" }), [], "no branch to name with --repo: the step is not sent");
});

test("#3639: the label a repository lacks is made with its description, in the repository the label step is aimed at", () => {
  assert.deepEqual(rows().labelCreateArgs({ name: "session:ceo", description: "The session that owns the pull request (pr:open)", repo: null }),
    ["label", "create", "session:ceo", "--description", "The session that owns the pull request (pr:open)"]);
  assert.deepEqual(rows().labelCreateArgs({ name: "session:ceo", description: "d", repo: OTHER }), ["label", "create", "session:ceo", "--description", "d", "--repo", OTHER]);
});

// --- pr-open: what its refusals read --------------------------------------------------------------------------------------

test("#3639: whether a repository has a label is one REST read of the label (its name encoded), silent; a 404 is no, and any other failure is thrown, never 'absent'", () => {
  const ok = recording();
  assert.equal(rows().labelExistsForOpening({ name: "session:ceo", repo: OTHER, run: ok.run }), true);
  assert.deepEqual(ok.calls, [["api", `repos/${OTHER}/labels/session%3Aceo`, "--silent"]]);
  const own = recording();
  rows().labelExistsForOpening({ name: "x", run: own.run });
  assert.deepEqual(own.calls, [["api", "repos/{owner}/{repo}/labels/x", "--silent"]], "the checkout's own repository, as gh expands the placeholders");
  assert.equal(rows().labelExistsForOpening({ name: "x", run: () => { throw refusal("gh: Not Found (HTTP 404)"); } }), false);
  assert.equal(rows().labelExistsForOpening({ name: "x", run: () => { throw refusal("HTTP 404: Not Found"); } }), false);
  assert.throws(() => rows().labelExistsForOpening({ name: "x", run: () => { throw refusal("HTTP 502: bad gateway"); } }), /502/, "could not ask is not absent");
  assert.throws(() => rows().labelExistsForOpening({ name: "x", run: () => { throw new Error("spawn gh ENOENT"); } }), /ENOENT/);
});

test("a pull request's head is read over REST, projected to its ref and commit; a refusal and an answer that is not JSON throw", () => {
  const { run, calls } = recording('{"ref":"agent/x","oid":"abc"}');
  assert.deepEqual(rows().pullHeadForOpening({ repo: OTHER, number: "7", run }), { ref: "agent/x", oid: "abc" });
  assert.deepEqual(calls, [["api", `repos/${OTHER}/pulls/7`, "--jq", "{ref: .head.ref, oid: .head.sha}"]]);
  assert.throws(() => rows().pullHeadForOpening({ repo: OTHER, number: "7", run: () => "not json" }));
  assert.throws(() => rows().pullHeadForOpening({ repo: OTHER, number: "7", run: () => { throw refusal("HTTP 403"); } }), /403/);
});

test("a row's body is read over REST (the core pool, not the GraphQL one that runs out); its label names are `restLabelNamesOf` (plumbing-rows.test.ts)", () => {
  const body = recording("the body\n");
  assert.equal(rows().rowBodyForOpening({ repo: REPO, number: 923, run: body.run }), "the body\n", "as printed, untrimmed");
  assert.deepEqual(body.calls, [["api", `repos/${REPO}/issues/923`, "--jq", ".body"]]);
});

test("agent-org#753: the commit a repository holds a branch at is one REST read, each path segment encoded and the slashes kept; a 404 is no such branch, anything else is thrown", () => {
  const { run, calls } = recording("deadbeef\n");
  assert.equal(rows().branchHeadForOpening({ repo: OTHER, branch: "agent/a b#c", run }), "deadbeef");
  assert.deepEqual(calls, [["api", `repos/${OTHER}/branches/agent/a%20b%23c`, "--jq", ".commit.sha"]]);
  assert.equal(rows().branchHeadForOpening({ repo: OTHER, branch: "b", run: () => "\n" }), null, "an empty answer holds no commit");
  assert.equal(rows().branchHeadForOpening({ repo: OTHER, branch: "b", run: () => { throw refusal("gh: Branch not found (HTTP 404)"); } }), null);
  assert.equal(rows().branchHeadForOpening({ repo: OTHER, branch: "b", run: () => { throw new Error("Command failed: gh api\nHTTP 404: Not Found"); } }), null, "the 404 may be in the message and not in stderr");
  assert.throws(() => rows().branchHeadForOpening({ repo: OTHER, branch: "b", run: () => { throw refusal("HTTP 500"); } }), /500/, "a failure to ask is never read as absent");
});

test("#811: the login a pull request is authored as is `GET /user`'s; where that is refused, the GraphQL viewer's; the reads are made in that order", () => {
  const user = recording("a11ign-ai-workers\n");
  assert.deepEqual(rows().authoringLoginOf({ run: user.run }), { login: "a11ign-ai-workers" });
  assert.deepEqual(user.calls, [["api", "user", "--jq", ".login"]], "a user token pays one call");
  const viewer = recording((args) => {
    if (args[1] === "user") throw refusal("HTTP 403 Resource not accessible by integration");
    return "a11ign-workers[bot]\n";
  });
  assert.deepEqual(rows().authoringLoginOf({ run: viewer.run }), { login: "a11ign-workers[bot]" });
  assert.deepEqual(viewer.calls, [["api", "user", "--jq", ".login"], ["api", "graphql", "-f", "query={ viewer { login } }", "--jq", ".data.viewer.login"]]);
});

test("#811: when neither read says, every failure is answered, named by the read, with gh's first stderr line (else the error's first line); an empty answer is a failure too", () => {
  const refused = rows().authoringLoginOf({ run: (args) => { throw args[1] === "user" ? refusal("HTTP 403 Resource not accessible\nsecond line") : new Error("spawn gh ENOENT\nmore"); } });
  assert.deepEqual(refused, { failures: ["`gh api user`: HTTP 403 Resource not accessible", "the GraphQL `viewer` read: spawn gh ENOENT"] });
  assert.deepEqual(rows().authoringLoginOf({ run: () => "  \n" }), { failures: ["`gh api user` answered no login", "the GraphQL `viewer` read answered no login"] });
});

// --- pr-hold ------------------------------------------------------------------------------------------------------------------

test("a held pull request's labels are `pr view --json labels`, as names; an answer that is not that, and a refusal, are null and never an empty list", () => {
  const { run, calls } = recording('{"labels":[{"name":"hold:a"},{"name":"ready"}]}');
  assert.deepEqual(rows().heldPullLabelsOf({ repo: OTHER, number: 7, run }), ["hold:a", "ready"]);
  assert.deepEqual(calls, [["pr", "view", "7", "--repo", OTHER, "--json", "labels"]]);
  assert.deepEqual(rows().heldPullLabelsOf({ repo: OTHER, number: 7, run: () => '{"labels":[]}' }), [], "a pull request with no label is the empty list");
  for (const answer of ['{"labels":"x"}', '{"labels":[{"name":1}]}', "null", "not json", '{"labels":[null]}']) assert.equal(rows().heldPullLabelsOf({ repo: OTHER, number: 7, run: () => answer }), null, answer);
  assert.equal(rows().heldPullLabelsOf({ repo: OTHER, number: 7, run: () => { throw refusal("HTTP 502"); } }), null);
});

test("a label on a held pull request is one `pr edit`, `--add-label` or `--remove-label`, in the pull request's repository; a refusal throws", () => {
  const { run, calls } = recording();
  rows().editHeldPullLabel({ repo: OTHER, number: 7, label: "hold:a", how: "add", run });
  rows().editHeldPullLabel({ repo: OTHER, number: 7, label: "hold:a", how: "remove", run });
  assert.deepEqual(calls, [["pr", "edit", "7", "--repo", OTHER, "--add-label", "hold:a"], ["pr", "edit", "7", "--repo", OTHER, "--remove-label", "hold:a"]]);
  assert.throws(() => rows().editHeldPullLabel({ repo: OTHER, number: 7, label: "x", how: "add", run: () => { throw refusal("HTTP 403"); } }), /403/);
});

test("#3862: a first hold's label the repository lacks is made (forced, with the description) and added ONCE MORE; any other failure, a failed make and a second 'not found' are thrown", () => {
  const edits: string[][] = [];
  let missing = true;
  const run: RowsRun = (args) => {
    edits.push([...args]);
    if (args[0] === "pr" && missing) throw refusal("'hold:worker-x' not found");
    if (args[0] === "label") missing = false;
    return "";
  };
  rows().editHeldPullLabel({ repo: OTHER, number: 7, label: "hold:worker-x", how: "add", createdWith: "This PR is HELD by worker-x and must not merge.", run });
  assert.deepEqual(edits, [
    ["pr", "edit", "7", "--repo", OTHER, "--add-label", "hold:worker-x"],
    ["label", "create", "hold:worker-x", "--repo", OTHER, "--force", "--description", "This PR is HELD by worker-x and must not merge."],
    ["pr", "edit", "7", "--repo", OTHER, "--add-label", "hold:worker-x"],
  ]);
  const twice = recording((args) => { if (args[0] === "pr") throw refusal("'hold:worker-x' not found"); return ""; });
  assert.throws(() => rows().editHeldPullLabel({ repo: OTHER, number: 7, label: "hold:worker-x", how: "add", createdWith: "d", run: twice.run }), /not found/);
  assert.equal(twice.calls.length, 3, "one retry, not a loop");
  /** An edit of `label` by `how` (with a description to make it with) that GitHub refuses with `stderr`: how many calls it cost, and what it threw. */
  const refusedWith = (stderr: string, how: "add" | "remove" = "add", label = "hold:worker-x") => {
    const { run, calls } = recording(() => { throw refusal(stderr); });
    assert.throws(() => rows().editHeldPullLabel({ repo: OTHER, number: 7, label, how, createdWith: "d", run }), new RegExp(stderr.includes("not found") ? "not found" : "403"));
    return calls.length;
  };
  assert.equal(refusedWith("HTTP 403"), 1, "no label is made for a failure that is not 'not found'");
  assert.equal(refusedWith("'hold:someone-else' not found"), 1, "it is THIS label that must be the one not found");
  assert.equal(refusedWith("'hold:worker-x' not found", "remove"), 1, "a label is made only to be added");
  const withoutDescription = recording(() => { throw refusal("'rearm-on-release' not found"); });
  assert.throws(() => rows().editHeldPullLabel({ repo: OTHER, number: 7, label: "rearm-on-release", how: "add", run: withoutDescription.run }), /not found/);
  assert.equal(withoutDescription.calls.length, 1, "the rearm marker's write is never retried with a made label");
  const failedMake = recording((args) => { throw args[0] === "pr" ? refusal("'hold:worker-x' not found") : refusal("HTTP 422 make"); });
  assert.throws(() => rows().editHeldPullLabel({ repo: OTHER, number: 7, label: "hold:worker-x", how: "add", createdWith: "d", run: failedMake.run }), /422 make/);
});

test("a pull request's auto-merge is read with its state (`autoMergeRequest,state`), null when it could not be had; the read-back after a disarm names only `autoMergeRequest` and throws", () => {
  const { run, calls } = recording('{"autoMergeRequest":null,"state":"MERGED"}');
  assert.deepEqual(rows().autoMergeOfHeldPull({ repo: OTHER, number: 7, run }), { autoMergeRequest: null, state: "MERGED" });
  assert.deepEqual(calls, [["pr", "view", "7", "--repo", OTHER, "--json", "autoMergeRequest,state"]]);
  assert.equal(rows().autoMergeOfHeldPull({ repo: OTHER, number: 7, run: () => { throw refusal("HTTP 502"); } }), null);
  assert.equal(rows().autoMergeOfHeldPull({ repo: OTHER, number: 7, run: () => "not json" }), null);
  const back = recording('{"autoMergeRequest":null}');
  assert.deepEqual(rows().autoMergeRequestOfHeldPull({ number: 7, run: back.run }), { autoMergeRequest: null });
  rows().autoMergeRequestOfHeldPull({ number: 7, repo: OTHER, run: back.run });
  assert.deepEqual(back.calls, [["pr", "view", "7", "--json", "autoMergeRequest"], ["pr", "view", "7", "--repo", OTHER, "--json", "autoMergeRequest"]], "the first repository's call never carried --repo; a keyed one is aimed before --json");
  assert.throws(() => rows().autoMergeRequestOfHeldPull({ number: 7, run: () => { throw refusal("HTTP 502"); } }), /502/);
  assert.throws(() => rows().autoMergeRequestOfHeldPull({ number: 7, run: () => "not json" }));
});

test("#645: arming is `pr merge --auto --merge <n>` (merge commits only, named at the call) and disarming is `--disable-auto`; the keyed repository is aimed AFTER the number, the first's never is", () => {
  const { run, calls } = recording();
  rows().armHeldPull({ number: 7, run });
  rows().armHeldPull({ number: 7, repo: OTHER, run });
  rows().disarmHeldPull({ number: 7, run });
  rows().disarmHeldPull({ number: 7, repo: OTHER, run });
  assert.deepEqual(calls, [
    ["pr", "merge", "--auto", "--merge", "7"], ["pr", "merge", "--auto", "--merge", "7", "--repo", OTHER],
    ["pr", "merge", "--disable-auto", "7"], ["pr", "merge", "--disable-auto", "7", "--repo", OTHER],
  ]);
  assert.throws(() => rows().armHeldPull({ number: 7, run: () => { throw refusal("HTTP 405"); } }), /405/);
  assert.throws(() => rows().disarmHeldPull({ number: 7, run: () => { throw refusal("Pull request is not in the correct state"); } }), /correct state/);
});

test("#4661: the row a hold waits on is one `issue view` of its state, labels, closing pull requests, body and comments, read as the hold reads it", () => {
  const answer = { state: "OPEN", labels: [{ name: "in-progress" }], body: "b", comments: [],
    closedByPullRequestsReferences: [{ number: 12, repository: { name: "agent-org", owner: { login: "a11ign" } } }] };
  const { run, calls } = recording(JSON.stringify(answer));
  assert.deepEqual(rows().holdTargetRowOf({ repo: REPO, number: 2867, run }), { state: "open", labels: ["in-progress"], openPullRequests: [{ number: 12, repo: OTHER }], row: answer });
  assert.deepEqual(calls, [["issue", "view", "2867", "--repo", REPO, "--json", "state,labels,closedByPullRequestsReferences,body,comments"]]);
  assert.equal(rows().holdTargetRowOf({ repo: REPO, number: 1, run: () => JSON.stringify({ ...answer, state: "CLOSED" }) })?.state, "closed");
  for (const bad of [{ ...answer, state: "MERGED" }, { ...answer, labels: null }, { ...answer, closedByPullRequestsReferences: undefined }, {}]) {
    assert.equal(rows().holdTargetRowOf({ repo: REPO, number: 1, run: () => JSON.stringify(bad) }), null, JSON.stringify(bad));
  }
  assert.equal(rows().holdTargetRowOf({ repo: REPO, number: 1, run: () => { throw refusal("Could not resolve to an Issue (a pull request number)"); } }), null);
  assert.equal(rows().holdTargetRowOf({ repo: REPO, number: 1, run: () => "not json" }), null);
});

// --- carry-branch, stranded-branches and the worker's Stop hook ----------------------------------------------------------------

test("the open pull request of a branch is `pr list --head <branch> --state open --json number` in the repository; none is null, and an answer that is not JSON throws", () => {
  const { run, calls } = recording('[{"number":42},{"number":43}]');
  assert.equal(rows().openPullNumberOfBranch({ repo: REPO, branch: "agent/x", run }), 42);
  assert.deepEqual(calls, [["pr", "list", "--repo", REPO, "--head", "agent/x", "--state", "open", "--json", "number"]]);
  assert.equal(rows().openPullNumberOfBranch({ repo: REPO, branch: "b", run: () => "[]" }), null);
  assert.equal(rows().openPullNumberOfBranch({ repo: REPO, branch: "b", run: () => '{"not":"a list"}' }), null, "an answer that is not a list has no pull request in it");
  assert.throws(() => rows().openPullNumberOfBranch({ repo: REPO, branch: "b", run: () => "not json" }));
  assert.throws(() => rows().openPullNumberOfBranch({ repo: REPO, branch: "b", run: () => { throw refusal("HTTP 502"); } }), /502/);
});

test("#321: every pull request's head ref is paged over REST, ASCENDING by creation, projected in the request (`--jq`), 100 to a page", () => {
  const { run, calls } = recording('[{"ref":"agent/x"},{"ref":"lead/y"}]');
  assert.deepEqual(rows().pullHeadRefsPageOf({ repo: REPO, page: 3, pageSize: 100, run }), { refs: ["agent/x", "lead/y"] });
  assert.deepEqual(calls, [["api", `repos/${REPO}/pulls?state=all&per_page=100&sort=created&direction=asc&page=3`, "--jq", "[.[] | {ref: .head.ref}]"]],
    "REST (core), never `gh pr list` (GraphQL); ASCENDING, since a pull request opened mid-walk shifts every later page of the newest-first order");
  assert.deepEqual(rows().pullHeadRefsPageOf({ repo: REPO, page: 1, pageSize: 100, run: () => "[]" }), { refs: [] });
  assert.throws(() => rows().pullHeadRefsPageOf({ repo: REPO, page: 1, pageSize: 100, run: () => { throw refusal("gh: authentication required"); } }), /authentication required/);
});

test("MUTATIONS of the page: an answer that is not JSON, not a list, or has an entry with no head ref is `unreadable` with the words the caller refuses in -- never a page read as empty", () => {
  const page = (answer: string, number = 2) => rows().pullHeadRefsPageOf({ repo: REPO, page: number, pageSize: 100, run: () => answer });
  assert.deepEqual(page("not json at all"), { unreadable: "gh's PR list (page 2) was not JSON -- refusing to guess. First 200 chars: not json at all" });
  assert.deepEqual(page(`x${"y".repeat(300)}`), { unreadable: `gh's PR list (page 2) was not JSON -- refusing to guess. First 200 chars: x${"y".repeat(199)}` });
  assert.deepEqual(page('{"not":"an array"}'), { unreadable: 'gh\'s PR list (page 2) was not an array -- refusing to guess. Got: {"not":"an array"}' });
  assert.deepEqual(page('[{"ref":"a"},{"ref":null}]', 4), { unreadable: 'PR entry 1 on page 4 has no head ref -- refusing to guess. Got: {"ref":null}' }, "a missing ref is not a branch named 'null'");
  assert.deepEqual(page("[null]"), { unreadable: "PR entry 0 on page 2 has no head ref -- refusing to guess. Got: null" });
});

test("#1409: the open pull requests of the checkout's repository are `pr list --state open --limit <n>` with the fields the sweep decides on (and no statusCheckRollup, which unions superseded runs)", () => {
  const listed = [{ number: 9, headRefName: "agent/old", createdAt: "2026-09-08T00:00:00Z", isDraft: false, labels: [], mergeStateStatus: "DIRTY" }];
  const { run, calls } = recording(JSON.stringify(listed));
  assert.deepEqual(rows().openPullsForSweep({ limit: 400, run }), listed);
  assert.deepEqual(calls, [["pr", "list", "--state", "open", "--limit", "400", "--json", "number,headRefName,createdAt,isDraft,labels,mergeStateStatus"]]);
  assert.ok(!calls[0].join(",").includes("statusCheckRollup"), "#450: the rollup reads a superseded failing run as the PR's state");
  assert.throws(() => rows().openPullsForSweep({ limit: 400, run: () => '{"not":"a list"}' }), /gh pr list did not return an array/);
  assert.throws(() => rows().openPullsForSweep({ limit: 400, run: () => "not json" }));
});

test("#1480: the sweep's closure comment and close are `pr comment <n> --body` and `pr close <n>`, in the checkout's repository, and the branch is KEPT (no --delete-branch)", () => {
  const { run, calls } = recording();
  rows().commentOnCheckoutPull({ number: 9, body: "STALE by the lifetime sweep", run });
  rows().closeCheckoutPull({ number: 9, run });
  assert.deepEqual(calls, [["pr", "comment", "9", "--body", "STALE by the lifetime sweep"], ["pr", "close", "9"]]);
  assert.ok(!calls.some((args) => args.includes("--delete-branch")), "the branch must survive: `gh pr close` without --delete-branch is the whole safety property");
  assert.throws(() => rows().commentOnCheckoutPull({ number: 9, body: "b", run: () => { throw refusal("HTTP 403"); } }), /403/);
  assert.throws(() => rows().closeCheckoutPull({ number: 9, run: () => { throw refusal("HTTP 403"); } }), /403/);
});

test("agent-org#1713: the Stop hook lists the newest hundred pull requests of a repository in any state with the fields ownership is decided on; an answer that is not a list throws", () => {
  const listed = [{ number: 77, state: "OPEN", headRefName: "agent/x", title: "t", labels: [], body: "Closes #1" }];
  const { run, calls } = recording(JSON.stringify(listed));
  assert.deepEqual(rows().pullsListedForStop({ repo: REPO, limit: 100, run }), listed);
  assert.deepEqual(calls, [["pr", "list", "--repo", REPO, "--state", "all", "--limit", "100", "--json", "number,state,headRefName,title,labels,body"]]);
  assert.throws(() => rows().pullsListedForStop({ repo: REPO, limit: 100, run: () => '{"not":"a list"}' }), /`gh pr list` did not print a list/);
  assert.throws(() => rows().pullsListedForStop({ repo: REPO, limit: 100, run: () => { throw refusal("HTTP 502"); } }), /502/);
});
