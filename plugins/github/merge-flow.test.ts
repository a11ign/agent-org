// no-token: gh -- `readMergeFlow` is handed a stub `run`; nothing here spawns `gh` or needs a token.
//
// A11-291: whether a repository can merge a pull request by itself -- it allows auto-merge and its default branch holds the arm workflow, or it is private and holds the merge bot. a11ign/plugin#10 sat approved and
// green for a day in a repository with neither.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GhFailure } from "./gh.ts";
import { ARM_WORKFLOW_PATH, MERGE_BOT_WORKFLOW_PATH, readHeadHoldsMergeBot, readMergeFlow, readMergeFlows, readOrganisationFlows, readRepositoryFlows, runsMergeBot } from "./merge-flow.ts";

/** What GitHub answers for one repository: the setting, whether it is private, the default branch, and `arm` and `bot`, which are null where the head holds no such workflow. */
const repository = ({ autoMerge = true, isPrivate = false, arm = true, bot = false, branch = "main" } = {}) => ({
  autoMergeAllowed: autoMerge, isPrivate, defaultBranchRef: { name: branch }, object: arm ? { __typename: "Blob" } : null, bot: bot ? { __typename: "Blob" } : null,
});

/** A `run` that answers the one query with `data` (its aliases `r0`, `r1`, ...), and records each call. `failing` makes `gh` exit non-zero WITH the answer, as it does when GitHub could not read one repository. */
function answering(data: Record<string, unknown>, failing = false) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    const text = JSON.stringify({ data, ...(failing ? { errors: [{ type: "NOT_FOUND" }] } : {}) });
    if (failing) throw new GhFailure(args, { status: 1, stdout: text, stderr: "gh: Could not resolve to a Repository" });
    return text;
  };
  return { calls, run };
}

const flowOf = (answer: Record<string, unknown>) => readMergeFlow("a11ign/plugin", answering({ r0: answer }).run);

test("A11-291: a repository that allows auto-merge and holds the arm workflow has a merge flow, read with one query for the setting, privacy, default branch and both files", () => {
  const { run, calls } = answering({ r0: repository() });
  assert.deepEqual(readMergeFlow("a11ign/plugin", run), { autoMerge: true, armWorkflow: true, defaultBranch: "main", private: false, mergeBot: false });
  assert.equal(calls.length, 1);
  const query = calls[0].find((arg) => arg.startsWith("query=")) ?? "";
  assert.match(query, /repository\(owner: "a11ign", name: "plugin"\) \{ autoMergeAllowed isPrivate defaultBranchRef \{ name \} object\(expression: "HEAD:\.github\/workflows\/auto-arm\.yml"\) \{ __typename \} bot: object\(expression: "HEAD:\.github\/workflows\/merge-bot\.yml"\)/);
  assert.deepEqual([ARM_WORKFLOW_PATH, MERGE_BOT_WORKFLOW_PATH], [".github/workflows/auto-arm.yml", ".github/workflows/merge-bot.yml"]);
});

test("A11-291: a repository with auto-merge off and no arm workflow (a11ign/plugin before A11-291) has neither, and one with only one of them says which", () => {
  assert.deepEqual(flowOf(repository({ autoMerge: false, arm: false })), { autoMerge: false, armWorkflow: false, defaultBranch: "main", private: false, mergeBot: false });
  assert.deepEqual(flowOf(repository({ arm: false, branch: "trunk" })), { autoMerge: true, armWorkflow: false, defaultBranch: "trunk", private: false, mergeBot: false });
  assert.deepEqual(flowOf(repository({ autoMerge: false })), { autoMerge: false, armWorkflow: true, defaultBranch: "main", private: false, mergeBot: false });
});

test("A11-291: a private repository is read as private, and whether it holds the merge bot is read apart from the arm workflow", () => {
  assert.deepEqual(flowOf(repository({ autoMerge: false, arm: false, isPrivate: true, bot: true })), { autoMerge: false, armWorkflow: false, defaultBranch: "main", private: true, mergeBot: true });
  assert.deepEqual(flowOf(repository({ autoMerge: false, arm: false, isPrivate: true })), { autoMerge: false, armWorkflow: false, defaultBranch: "main", private: true, mergeBot: false });
});

test("A11-291: many repositories are one call, each answered by its alias, and a repository GitHub would not read is null while the others are read", () => {
  const { run, calls } = answering({ r0: repository(), r1: null, r2: repository({ autoMerge: false, arm: false }) }, true);
  assert.deepEqual(readMergeFlows(["a11ign/lab", "a11ign/gone", "a11ign/plugin"], run), {
    "a11ign/lab": { autoMerge: true, armWorkflow: true, defaultBranch: "main", private: false, mergeBot: false }, "a11ign/gone": null,
    "a11ign/plugin": { autoMerge: false, armWorkflow: false, defaultBranch: "main", private: false, mergeBot: false },
  });
  assert.equal(calls.length, 1, "thirteen repositories do not take thirteen calls");
});

test("A11-291: a read that cannot be made is null, never 'no flow': a failed call, an answer that is not JSON or has no data, a missing setting, and a name that is not owner/name", () => {
  const failed = (args: string[]): never => { throw new GhFailure(args, { status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" }); };
  assert.equal(readMergeFlow("a11ign/plugin", failed), null, "a refused call");
  assert.equal(readMergeFlow("a11ign/plugin", () => "not json"), null);
  assert.equal(readMergeFlow("a11ign/plugin", () => JSON.stringify({ errors: [] })), null);
  assert.equal(flowOf({ defaultBranchRef: { name: "main" }, isPrivate: false, object: null }), null, "no setting is not 'off'");
  assert.equal(flowOf({ autoMergeAllowed: true, isPrivate: false, object: null }), null, "and no default branch is not one");
  assert.equal(flowOf({ autoMergeAllowed: true, defaultBranchRef: { name: "main" }, object: null }), null, "nor is an answer that does not say whether the repository is private");
  const stray = answering({});
  assert.deepEqual(readMergeFlows(["plugin", "a11ign/plugin/extra", 'a11ign/"x'], stray.run), { plugin: null, "a11ign/plugin/extra": null, 'a11ign/"x': null });
  assert.equal(stray.calls.length, 0, "a name that is not owner/name is not put in a query");
  const crashed = (): never => { throw new Error("spawn gh ENOENT"); };
  assert.equal(readMergeFlow("a11ign/plugin", crashed), null, "a gh that cannot start");
});

test("A11-344: a pull request head holds the merge bot when GitHub finds the file at its own ref, and a head GitHub cannot read holds none", () => {
  const { run, calls } = answering({ r0: { headBot: { __typename: "Blob" } } });
  assert.equal(readHeadHoldsMergeBot("a11ign/auth-capture-check", 20, run), true);
  const query = calls[0].find((arg) => arg.startsWith("query=")) ?? "";
  assert.match(query, /repository\(owner: "a11ign", name: "auth-capture-check"\) \{ headBot: object\(expression: "refs\/pull\/20\/head:\.github\/workflows\/merge-bot\.yml"\)/);
  assert.equal(readHeadHoldsMergeBot("a11ign/auth-capture-check", 20, answering({ r0: { headBot: null } }).run), false, "a head without the file (or one that deletes it)");
  assert.equal(readHeadHoldsMergeBot("a11ign/auth-capture-check", 20, answering({ r0: null }, true).run), false, "a repository GitHub would not read");
  assert.equal(readHeadHoldsMergeBot("not a repository", 20, run), false);
  assert.equal(readHeadHoldsMergeBot("a11ign/auth-capture-check", 20, () => { throw new Error("boom"); }), false);
});

test("A11-344: the merge bot is the flow when the repository is private and either its default branch or the pull request's head holds it", () => {
  assert.deepEqual([runsMergeBot({ private: true, mergeBot: false, headBot: true }), runsMergeBot({ private: true, mergeBot: true }), runsMergeBot({ private: true, mergeBot: false })], [true, true, false]);
  assert.equal(runsMergeBot({ private: false, mergeBot: false, headBot: true }), false, "a public repository is not the merge bot's");
});

/** A repository as an organisation's listing answers it, with its rulesets: `rules` are the rule types of one ruleset enforced as `enforcement`, `gate` adding the required `gate` check. */
const listed = (name: string, { archived = false, rules = ["MERGE_QUEUE"], gate = true, enforcement = "ACTIVE", ...rest }: { archived?: boolean; rules?: string[]; gate?: boolean; enforcement?: string; autoMerge?: boolean; arm?: boolean } = {}) => ({
  ...repository(rest), name, isArchived: archived,
  rulesets: { nodes: [{ enforcement, rules: { nodes: [...rules.map((type) => ({ type, parameters: null })), ...(gate ? [{ type: "REQUIRED_STATUS_CHECKS", parameters: { requiredStatusChecks: [{ context: "ci" }, { context: "gate" }] } }] : [])] } }] },
});

/** A `run` that answers an organisation's pages in turn, and records each call. */
function paging(pages: readonly unknown[][]) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    const n = calls.length - 1;
    return JSON.stringify({ data: { organization: { repositories: { pageInfo: { hasNextPage: n < pages.length - 1, endCursor: `c${n}` }, nodes: pages[n] } } } });
  };
  return { calls, run };
}

test("A11-274: an organisation's listing reads every repository, page by page, with its archive state, merge queue and required `gate`", () => {
  const { run, calls } = paging([[listed("lab"), listed("old", { archived: true })], [listed("a11ign.github.io", { autoMerge: false, arm: false, rules: [], gate: false })]]);
  assert.deepEqual(readOrganisationFlows("a11ign", run), [
    { repository: "a11ign/lab", archived: false, flow: { autoMerge: true, armWorkflow: true, defaultBranch: "main", private: false, mergeBot: false, mergeQueue: true, gateRequired: true } },
    { repository: "a11ign/old", archived: true, flow: { autoMerge: true, armWorkflow: true, defaultBranch: "main", private: false, mergeBot: false, mergeQueue: true, gateRequired: true } },
    { repository: "a11ign/a11ign.github.io", archived: false, flow: { autoMerge: false, armWorkflow: false, defaultBranch: "main", private: false, mergeBot: false, mergeQueue: false, gateRequired: false } },
  ]);
  assert.equal(calls.length, 2);
  const [first, second] = calls.map((args) => args.find((arg) => arg.startsWith("query=")) ?? "");
  assert.match(first, /organization\(login: "a11ign"\) \{ repositories\(first: 100\) \{ pageInfo \{ hasNextPage endCursor \} nodes \{ name isArchived autoMergeAllowed isPrivate/);
  assert.match(first, /rulesets\(first: 10\) \{ nodes \{ enforcement rules\(first: 20\) \{ nodes \{ type parameters \{ \.\.\. on RequiredStatusChecksParameters \{ requiredStatusChecks \{ context \} \} \} \} \} \} \}/);
  assert.match(second, /repositories\(first: 100, after: "c0"\)/);
});

test("A11-274: a ruleset that is not active gives no merge queue and requires nothing, and an empty repository is read with no default branch, not as unread", () => {
  const firstFlow = (listing: ReturnType<typeof readOrganisationFlows>) => (Array.isArray(listing) ? listing[0].flow : listing);
  assert.deepEqual(firstFlow(readOrganisationFlows("a11ign", paging([[listed("lab", { enforcement: "EVALUATE" })]]).run)), { autoMerge: true, armWorkflow: true, defaultBranch: "main", private: false, mergeBot: false, mergeQueue: false, gateRequired: false });
  assert.deepEqual(firstFlow(readOrganisationFlows("a11ign", paging([[{ ...listed("zz", { rules: [], gate: false, arm: false, autoMerge: false }), defaultBranchRef: null }]]).run)), { autoMerge: false, armWorkflow: false, defaultBranch: "", private: false, mergeBot: false, mergeQueue: false, gateRequired: false });
});

test("A11-274: a login GitHub finds no organisation by is 'not an organisation', and a listing that fails on any page is null, never a shorter list", () => {
  const person = (args: string[]): never => { throw new GhFailure(args, { status: 1, stdout: JSON.stringify({ data: { organization: null }, errors: [{ type: "NOT_FOUND" }] }), stderr: "gh: Could not resolve to an Organization" }); };
  assert.equal(readOrganisationFlows("someone", person), "not an organisation");
  assert.equal(readOrganisationFlows("a11ign", () => { throw new GhFailure([], { status: 1, stdout: "", stderr: "HTTP 502" }); }), null);
  let calls = 0;
  const secondFails = (args: string[]): string => {
    calls += 1;
    if (calls === 2) throw new GhFailure(args, { status: 1, stdout: "", stderr: "HTTP 502" });
    return JSON.stringify({ data: { organization: { repositories: { pageInfo: { hasNextPage: true, endCursor: "c0" }, nodes: [listed("lab")] } } } });
  };
  assert.equal(readOrganisationFlows("a11ign", secondFails), null);
  assert.equal(readOrganisationFlows("a11ign", () => JSON.stringify({ data: { organization: { repositories: { nodes: [{ isArchived: false }] } } } })), null, "a repository with no name");
  assert.equal(readOrganisationFlows('a11"ign', () => { throw new Error("not asked"); }), null, "a login that is not one is not put in a query");
});

test("A11-274: repositories read by name answer as an organisation's listing does, and one that cannot be read is null", () => {
  const { run, calls } = answering({ r0: listed("tool", { autoMerge: false, arm: false, rules: [], gate: false }), r1: null });
  assert.deepEqual(readRepositoryFlows(["someone/tool", "someone/gone"], run), {
    "someone/tool": { repository: "someone/tool", archived: false, flow: { autoMerge: false, armWorkflow: false, defaultBranch: "main", private: false, mergeBot: false, mergeQueue: false, gateRequired: false } }, "someone/gone": null,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(readRepositoryFlows(["someone/tool"], () => { throw new Error("spawn gh ENOENT"); }), { "someone/tool": null });
});
