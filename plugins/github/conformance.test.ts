// no-token: none -- GitHub is a recorded `exec` that answers the gh calls from one pull request held in memory; nothing reaches GitHub
//
// THE CODE HOST CONTRACT'S SUITE, RUN ON THE GITHUB PLUGIN (A11-160, Decision 11 of A11-157): `runCodeHostConformance` is the only definition of "a code host", so GitHub passes the same
// checks the fake does. The emulator below answers each `gh` call the plugin makes from pull request 7 of `owner/repo`, and refuses every other one, as GitHub does a pull request the
// account cannot see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runCodeHostConformance } from "../../src/plugins/conformance/code-host.ts";
import { ContractError } from "../../src/plugins/conformance/suite.ts";
import type { WrapperInputs } from "../../src/plugins/contracts/code-host.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { corePolicy } from "../../src/plugins/policy.ts";
import "../../src/plugins/row-mode.ts"; // registers what core owns of row mode that reads the project, which the conformance of the rows asks for
import { create } from "./index.ts";

export const REPOSITORY = "owner/repo";
export const PULL = `https://github.com/${REPOSITORY}/pull/7`;
export const MISSING = `https://github.com/${REPOSITORY}/pull/999`;
export const MERGED = `https://github.com/${REPOSITORY}/pull/8`;
const HEAD = "a".repeat(40);
/** The head a claim is written on, the failing check's address, and its log's text. */
export const CLAIM_HEAD = "c".repeat(40);
export const CHECK_URL = `https://github.com/${REPOSITORY}/actions/runs/31/job/32`;
export const CHECK_LOG = "Error: the build failed";
/** A pull request in a stack, with the arm bot's refusal of its stack merge on it at `STACK_REFUSAL_HEAD`, and a repository the arm bot's workflow cannot be dispatched in. */
export const STACKED = `https://github.com/${REPOSITORY}/pull/9`;
export const STACK_REFUSAL_HEAD = "d".repeat(40);
export const STACK_REFUSAL_REASON = "a member below has changes requested";
export const NO_ARM_BOT = { repo: "owner/no-arm-bot", number: 1 };
/** A merged pull request whose body names a ticket's key (contract 1.18). */
export const NAMED_KEY = "A11-240";
export const NAMED = `https://github.com/${REPOSITORY}/pull/10`;
/** A pull request the dependency bot opened, and one a person opened in the same repository with a bot-like title (contract 1.19). */
export const DEPENDENCY_PULLS = { bot: `https://github.com/${REPOSITORY}/pull/11`, foreign: `https://github.com/${REPOSITORY}/pull/12` };
/** A pull request closed without merging that still holds two commits, with its head and its base (contract 1.20). */
export const CLOSED = `https://github.com/${REPOSITORY}/pull/13`;
export const CLOSED_HEAD = "9".repeat(40);
export const CLOSED_COMMITS = [{ sha: "8".repeat(40), subject: "feat: check-report refuses unknown options" }, { sha: CLOSED_HEAD, subject: "test: a browser.newContext() suite" }];
/** The merge group a removal of pull request 7 was from, the `merge_group` run on its commit, and the job of it that failed (contract 1.21). */
export const QUEUE_GROUP = "e".repeat(40);
export const QUEUE_RUN_ID = 55;
export const QUEUE_JOB = "middleware";
/** A workflow run GitHub holds, halfway through (contract 1.17). */
export const CI_RUN_ID = 77;

const REFUSED = { status: 1, stdout: "", stderr: "gh: Could not resolve to a PullRequest (HTTP 404)\n" };

type Answer = { status: number; stdout: string; stderr: string };

/** The gh calls of the merge queue's failure read and the hold (contract 1.21), or null for any other: the `merge_group` run on the group's commit, its jobs, and the labels of pull request 7, which `labels` keeps. */
function queueCalls(args: readonly string[], labels: string[]): Answer | null {
  const ok = (stdout: string): Answer => ({ status: 0, stdout, stderr: "" });
  const labelPath = `repos/${REPOSITORY}/issues/7/labels`;
  if (args[0] === "api" && args.includes(`repos/${REPOSITORY}/actions/runs?event=merge_group&head_sha=${QUEUE_GROUP}&per_page=100`)) {
    return ok(JSON.stringify({ workflow_runs: [{ id: QUEUE_RUN_ID, html_url: `https://github.com/${REPOSITORY}/actions/runs/${QUEUE_RUN_ID}`, conclusion: "failure" }] }));
  }
  if (args[0] === "api" && args.some((arg) => arg.startsWith(`repos/${REPOSITORY}/actions/runs?event=merge_group`))) return ok(JSON.stringify({ workflow_runs: [] }));
  if (args[0] === "api" && args.includes(`repos/${REPOSITORY}/actions/runs/${QUEUE_RUN_ID}/jobs?filter=latest&per_page=100`)) {
    return ok(JSON.stringify({ jobs: [
      { id: 56, name: QUEUE_JOB, conclusion: "failure", steps: [{ name: "Set up job", number: 1, conclusion: "success" }, { name: "The Dependabot config is what the toolchain generates", number: 2, conclusion: "failure" }] },
      { id: 57, name: "lint", conclusion: "success", steps: [] },
    ] }));
  }
  if (args[0] === "label" && args[1] === "create") return args.includes(REPOSITORY) ? ok("") : { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" };
  if (args[0] === "api" && args.includes(`${labelPath}?per_page=100`)) return ok(JSON.stringify(labels.map((name) => ({ name }))));
  if (args[0] === "api" && args.includes("POST") && args.includes(labelPath)) {
    labels.push(...args.filter((arg) => arg.startsWith("labels[]=")).map((arg) => arg.slice("labels[]=".length)));
    return ok("[]");
  }
  const lifted = args.find((arg) => arg.startsWith(`${labelPath}/`));
  if (args[0] === "api" && args.includes("DELETE") && lifted !== undefined) {
    const at = labels.indexOf(decodeURIComponent(lifted.slice(labelPath.length + 1)));
    if (at === -1) return { status: 1, stdout: "", stderr: "gh: Label does not exist (HTTP 404)\n" };
    labels.splice(at, 1);
    return ok("[]");
  }
  return null;
}

/** The gh calls the plugin makes, answered from pull request 7: its feedback, its fields, its state and the list it is in. */
function github(calls: string[][] = []) {
  /** The statuses on the claim head, as GitHub keeps them: a POST adds one, and the listing prints one tab-separated line for each. */
  const statuses: { id: number; context: string; created_at: string; description: string }[] = [];
  /** The labels on pull request 7, as GitHub keeps them: the hold is added by a POST and removed by a DELETE. */
  const labels: string[] = [];
  return (file: string, args: readonly string[]) => {
    calls.push([file, ...args]);
    if (file !== "gh") return { status: null, stdout: "", stderr: `${file} cannot start` };
    const text = args.join(" ");
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
    if (text === "api user --jq .login") return ok("worker-bot\n");
    // The stack merge's reads (contract 1.16): pull request 7 is in no stack and pull request 9 is in one, with the arm bot's refusal on it.
    if (args[0] === "api" && args.includes(`repos/${REPOSITORY}/pulls/7`)) return ok(JSON.stringify({ stack: null, merged: false, base: { ref: "main", repo: { default_branch: "main" } }, head: { sha: HEAD } }));
    if (args[0] === "api" && args.includes(`repos/${REPOSITORY}/pulls/9`)) return ok(JSON.stringify({ stack: { number: 12 }, merged: false, base: { ref: "main", repo: { default_branch: "main" } }, head: { sha: STACK_REFUSAL_HEAD } }));
    if (args[0] === "api" && args[1] === "graphql" && args.includes("n=9")) return ok(JSON.stringify({ merged: false, autoMergeRequest: null, mergeQueueEntry: null }));
    if (args[0] === "api" && args.includes(`repos/${REPOSITORY}/issues/9/comments`)) return ok(`${JSON.stringify(`<!-- agent-org:stack-merge head=${STACK_REFUSAL_HEAD} -->\nGitHub refused the stack merge of #9: ${STACK_REFUSAL_REASON}`)}\n`);
    if (args[0] === "run" && args[1] === "view") return args[2] === String(CI_RUN_ID) ? ok(JSON.stringify({ status: "in_progress", conclusion: "", url: `https://github.com/${REPOSITORY}/actions/runs/${CI_RUN_ID}`, name: "ci", jobs: [{ status: "completed" }, { status: "in_progress" }] })) : REFUSED;
    const queued = queueCalls(args, labels);
    if (queued !== null) return queued;
    if (args[0] === "search" && args[1] === "prs") {
      const repositories = args.flatMap((arg, at) => (args[at - 1] === "--repo" ? [arg] : []));
      if (repositories.some((repository) => repository !== REPOSITORY)) return REFUSED;
      return ok(JSON.stringify([{ url: NAMED, repository: { name: "repo", nameWithOwner: REPOSITORY }, state: "merged", title: "feat: step one", body: `Refs ${NAMED_KEY}` }]));
    }
    if (args[0] === "workflow" && args[1] === "run") return args.includes(REPOSITORY) ? ok("") : REFUSED;
    if (args[0] === "api" && args[1] === "graphql") {
      const found = args.includes("number=7");
      return ok(JSON.stringify({ data: { repository: { pullRequest: found ? {
        state: "OPEN", headRefOid: HEAD, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", baseRefName: "main",
        files: { nodes: [{ path: "src/a.ts" }], pageInfo: { hasNextPage: false, endCursor: null } },
        reviews: { nodes: [] }, comments: { nodes: [] }, reviewThreads: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] },
      } : null } } }));
    }
    // A closed pull request's read (contract 1.20): the pull request, then the compare of its base with its head commit, one line per commit and file as the plugin's jq prints them.
    if (args[0] === "pr" && args[1] === "view" && args[2] === CLOSED) return ok(JSON.stringify({ number: 13, state: "CLOSED", baseRefName: "main", headRefName: "admin/a11-229-x", headRefOid: CLOSED_HEAD }));
    if (args[0] === "api" && args.includes(`repos/${REPOSITORY}/compare/main...${CLOSED_HEAD}?per_page=100`)) {
      return ok([`T ${CLOSED_COMMITS.length}`, ...CLOSED_COMMITS.map((commit) => `C ${JSON.stringify(commit)}`), `F ${JSON.stringify("src/check-report.ts")}`, ""].join("\n"));
    }
    if (args[0] === "pr" && args[1] === "view" && args[2] === MERGED) return ok(JSON.stringify({ number: 8, title: "feat: replay", body: "What it found", state: "MERGED" }));
    if (args[0] === "pr" && args[1] === "diff" && args[2] === MERGED) return ok("diff --git a/docs/spike.md b/docs/spike.md\n--- a/docs/spike.md\n+++ b/docs/spike.md\n@@ -1 +1,3 @@\n+### Scripted replay\n+Cookie dialogs drop pages.\n");
    if (args[0] === "pr" && args[1] === "view") {
      if (args[2] !== "7" && args[2] !== PULL) return REFUSED;
      return ok(JSON.stringify({ state: "OPEN", headRefOid: HEAD, reviews: [], author: { login: "worker-bot" }, isCrossRepository: false, baseRefName: "main" }));
    }
    if (args.slice(0, 2).join(" ") === "pr list" && /headRefOid/.test(args.join(" "))) {
      if (!args.includes(REPOSITORY)) return REFUSED;
      // A person's pull request is listed beside the bot's, as a plain list does: the suite holds the plugin to the author check of its own.
      return ok(JSON.stringify([
        { number: 11, title: "deps: bump @x/y from 1.4.0 to 2.0.0", headRefName: "dependabot/npm_and_yarn/x/y-2.0.0", headRefOid: HEAD, url: DEPENDENCY_PULLS.bot, body: "Release notes", author: { login: "app/dependabot", is_bot: true } },
        { number: 12, title: "deps: bump @x/y from 1.4.0 to 2.0.0", headRefName: "someone/bump", headRefOid: HEAD, url: DEPENDENCY_PULLS.foreign, body: "", author: { login: "someone", is_bot: false } },
      ]));
    }
    if (args[0] === "pr" && args[1] === "list") return ok(JSON.stringify([{ number: 7, body: "" }]));
    if (text === `api repos/${REPOSITORY}/actions/jobs/32/logs --allow-escape-sequences`) return ok(`2026-10-22T10:00:00Z ${CHECK_LOG}\n`);
    if (args[0] === "api" && args.includes(`repos/${REPOSITORY}/commits/${CLAIM_HEAD}/statuses?per_page=100`)) {
      return ok(statuses.map((status) => [status.id, status.created_at, status.description].join("\t")).join("\n") + (statuses.length > 0 ? "\n" : ""));
    }
    if (args[0] === "api" && args.includes("POST") && args.includes(`repos/${REPOSITORY}/statuses/${CLAIM_HEAD}`)) {
      const field = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
      statuses.push({ id: statuses.length + 1, context: field("context"), created_at: "2026-10-22T10:00:00Z", description: field("description") });
      return ok("");
    }
    return REFUSED;
  };
}

/** What the wrapper is asked about: a host whose tool is installed outside any temporary directory, with the workers' role an App. */
export const WRAPPER_INPUTS: WrapperInputs = {
  place: { binDir: "/opt/host/bin", tool: "/opt/agent-org", checkout: "/opt/project", stateEntry: (name) => `/opt/state/${name}` }, accounts: { workers: "/opt/workers", leads: "/opt/leads" },
  identity: { scheduler: { mode: "user-accounts" }, workers: { mode: "github-apps", appId: "1", keyPath: "/opt/workers.pem" }, managers: { mode: "user-accounts" }, reviewer: { mode: "user-accounts" } },
};

/** The policy a host with a loaded reviewer gate gives: the author is the org's own, and the checks have settled. */
const policy = corePolicy(() => ({ fields: "headRefOid,reviews,author,isCrossRepository", trustOf: () => "inside", settledOf: () => true, unrequiredRedOf: () => [] }));

test("the GitHub plugin passes the code host contract suite, and the checks that ran are the ones asserted", async () => {
  const host = create({}, fakePluginDeps({ exec: github(), policy, readFile: (path) => readFileSync(path, "utf8"), env: { A11Y_APP_NODE: "false" } }));
  const { passed, skipped } = await runCodeHostConformance(host, {
    pull: PULL, repository: REPOSITORY, missing: MISSING, self: "worker-bot", wrapper: WRAPPER_INPUTS, merged: MERGED, closed: CLOSED, queueFailure: { groupCommit: QUEUE_GROUP, job: QUEUE_JOB },
    stackRefusal: { pull: STACKED, head: STACK_REFUSAL_HEAD, reason: STACK_REFUSAL_REASON }, stackRequestRefused: NO_ARM_BOT, ciRun: { repository: REPOSITORY, runId: CI_RUN_ID },
    named: { key: NAMED_KEY, repository: REPOSITORY, url: NAMED, state: "merged" }, dependency: { repository: REPOSITORY, url: DEPENDENCY_PULLS.bot, foreign: DEPENDENCY_PULLS.foreign },
    remote: { urls: [`https://github.com/${REPOSITORY}.git`, `git@github.com:${REPOSITORY}.git`], repository: { name: "repo", fullName: REPOSITORY } },
    check: { detailsUrl: CHECK_URL, log: CHECK_LOG }, claim: { repository: REPOSITORY, head: CLAIM_HEAD, environment: { GH_CONFIG_DIR: "/opt/reviewer/gh" } },
  });
  assert.deepEqual(passed, [
    "shape", "readOwnLogin names the account or answers null", "repoViewArgs and repoCloneArgs name the repository they are asked about", "readPullFeedback reads a pull request", "readPullFeedback answers null for a pull request it cannot read", "readReplies answers a list of replies, and null for a pull request it cannot read",
    "readPullState names the state or answers null", "readReviewState reads the head, the reviews and whether the checks settled", "openPullUrlsOf lists a repository's open pull requests",
    "sweepRetargets keeps the note of a pull request it cannot read", "sweepRetargets with no pull requests has no notes",
    "readCheckLog answers null for an address that names no job", "rerunFailedChecks of no checks reruns nothing and says so", "readReviewClaims answers the entries of a head, or why it could not", "subscribe returns the function that cancels it",
    "the rows are the operations row mode asks of the code host", "a read the rows could not make answers null or throws, never an empty answer", "a write the rows could not make throws, so no caller reads it as done",
    "the rows' pure helpers answer as the callers that sweep approvals and fold pages expect",
    "a read the rows could not make for arming, the merge guard and the queue throws, never an empty answer", "a write the rows could not make for arming, the merge and the queue throws, so no caller reads it as done",
    "a read the rows could not make for the work gate throws or answers null, never an empty answer", "a write the rows could not make for the work gate throws, so no caller reads it as done",
    "a read the rows could not make for wake throws or answers null, never an empty answer", "a write the rows could not make for wake throws, so no caller reads it as done",
    "a read the rows could not make for the claim throws or answers null, never an empty answer", "a write the rows could not make for the claim throws, so no caller reads it as done",
    "a read the rows could not make for the filing of rows throws or answers null, never an empty answer", "a write the rows could not make for the filing of rows throws, so no caller reads it as done",
    "a read the rows could not make for the claim's rules throws or answers null, never an empty answer", "a write the rows could not make for the claim's rules throws, so no caller reads it as done",
    "a read the rows could not make for the other claim and row files throws or answers null, never an empty answer", "a write the rows could not make for the other claim and row files throws, so no caller reads it as done",
    "a read the rows could not make for the board, the health and retro readings, the DORA reader and the trace throws, never an empty answer", "a write the rows could not make for the board throws, so no caller reads it as done",
    "an async read or write the rows could not make rejects, so no caller reads it as done",
    "a read the rows could not make for opening a pull request throws, never an empty answer", "a read the rows could not make for a hold answers null, never nobody holds it", "a read the rows could not make for the branch tools and the Stop hook throws, never an empty listing", "a write the rows could not make for a hold, the sweep and the daily post throws, so no caller reads it as done", "a read the rows could not make for the audit, the retro's stock count and the un-park throws, never an empty answer", "a write the rows could not make for the tick's heartbeat throws, so no caller reads it as done", "a read the rows could not make for the close of a merged pull request throws, never an empty answer", "a read the rows could not make for the checks on a row's claim throws, never an empty answer", "a write the rows could not make for the close of a merged pull request throws, so no caller reads it as done", "a read the rows could not make for the classes section throws, never an empty answer", "a write the rows could not make for the classes section throws, so no caller reads it as done", "an answer that is JSON and not a comment is never a comment's body", "the repository and job a check's details address names are read without asking the code host", "a read the rows could not make for the trunk, the queue table and the red-trunk reading throws, never an empty answer", "a write the rows could not make for the trunk sweep throws, so no caller reads it as done", "a read the rows could not make for the read-only reporters throws, never an empty answer", "a read the rows could not make for the tool-version agreement, the host check and the review eval throws, never an empty answer", "the GraphQL pool's probe is a list of arguments the caller sends through a runner of its own",
    "the rows' rules for arming answer as the callers that arm and guard expect",
    "readCheckLog reads the log behind a failing check", "a claim written on a head is read back from it", "the verdict door is a file the plugin ships, with the program that installs it",
    "readMergedFindings reads what a merged pull request found, and answers null for one it cannot read or that has not merged", "readClosedWork answers null for a pull request it cannot read or that is open, and reads what a closed one still held",
    "readDefaultBranchRed answers the checks failing on a default branch's head, and null for a repository it cannot read", "readQueueFailure answers null for what it cannot read, and reads the failing job behind a removal", "holdFromQueue puts the hold on a pull request and takes it off, and throws for one it cannot read", "updateBranch refuses an address that is no pull request, and never throws", "stackMergeFactsOf answers null for a pull request it cannot read, and says a pull request in no stack is not stacked", "stackMergeFactsOf reads the refusal of the stack merge that the arm bot left on a stacked pull request", "requestStackMerge throws when the request is refused, so no caller reads it as made", "readCiRun answers null for a run it cannot read", "readCiRun reads a workflow run's status, conclusion, address, name and jobs", "pullsNaming answers null for a repository it cannot read", "pullsNaming lists the pull requests that name a key, with their state", "openDependencyPulls answers null for a repository it cannot read", "openDependencyPulls lists the pull requests the dependency bot opened, and no one else's", "readOwners lists the account first, and readRepositories answers null for an owner it cannot ask about", "repositoryOfRemote names the repository of its own remote URLs, and of no other host's",
    "the wrapper is an owned file its own text agrees with", "the wrapper keeps its own text, and writes it", "the wrapper answers whether each declared role mints",
  ]);
  assert.deepEqual(skipped.map(({ check }) => check), ["readChange reads a change, and answers null for one it cannot", "armMerge arms the merge and says it is armed"],
    "the plugin makes no change reads and arms no merge yet, so the checks that need a change are skipped with their reason and not passed");
  assert.ok(skipped.every(({ reason }) => /the probe names no change/.test(reason)));
});

test("every call the plugin makes is to gh, and the contract's reads make no write", async () => {
  const calls: string[][] = [];
  const host = create({}, fakePluginDeps({ exec: github(calls), policy }));
  await runCodeHostConformance(host, { pull: PULL, repository: REPOSITORY, missing: MISSING, self: "worker-bot" });
  assert.ok(calls.length > 0, "POSITIVE CONTROL: the suite asked GitHub something");
  assert.deepEqual([...new Set(calls.map(([file]) => file))], ["gh"]);
  // The one write the suite makes of a pull request is the hold (contract 1.21): the label `hold:board`, made if the repository has none, then put on and taken off.
  const isHold = (args: readonly string[]) => args.some((arg) => arg.includes("hold:board") || arg.includes("hold%3Aboard"));
  for (const [, ...args] of calls.filter(([, ...args]) => !isHold(args))) assert.equal(args.some((arg) => ["--method", "-X", "edit", "merge", "close", "create"].includes(arg)), false, `a read of a pull request wrote: gh ${args.join(" ")}`);
  assert.ok(calls.some(([, ...args]) => isHold(args) && args.includes("POST")), "POSITIVE CONTROL: the hold was put on, so the filter above leaves a real write out");
});

// A rows that hides a refusal is wrong, and the suite says which: a read that answers an empty list for "could not ask" is how a caller files again what a person closed, and a write that swallows its
// refusal is how a caller reads a comment never posted as posted.
test("a rows whose refused read answers an empty list, or whose refused write is swallowed, fails the suite by name", async () => {
  const probe = { pull: PULL, repository: REPOSITORY, missing: MISSING, self: "worker-bot" };
  const host = create({}, fakePluginDeps({ exec: github(), policy }));
  const emptyForRefused = { ...host, rows: { ...host.rows!, openIncidentsOf: () => [] as never } };
  await assert.rejects(runCodeHostConformance(emptyForRefused, probe), (error: unknown) => error instanceof ContractError && error.failures.map(({ check }) => check).join() === "a read the rows could not make answers null or throws, never an empty answer");
  const swallowed = { ...host, rows: { ...host.rows!, closeRowWithComment: () => undefined } };
  await assert.rejects(runCodeHostConformance(swallowed, probe), (error: unknown) => error instanceof ContractError && error.failures.map(({ check }) => check).join() === "a write the rows could not make throws, so no caller reads it as done");
  const noOperation = { ...host, rows: { ...host.rows!, readRowsSince: undefined as never } };
  await assert.rejects(runCodeHostConformance(noOperation, probe), (error: unknown) => error instanceof ContractError && error.failures.some(({ check }) => check === "the rows are the operations row mode asks of the code host"));
});
