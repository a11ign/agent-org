// no-token: none -- `gh` is a stub that answers GraphQL from a table of repositories and records each call: no network
// A11-365: a repository's open pull requests are read once per sweep, in one query, and shared by every reader in the plugin
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { corePolicy } from "../../src/plugins/policy.ts";
import { createCodeHost } from "./code-host.ts";
import { type AsyncGh, GhFailure } from "./gh.ts";
import { createPullSnapshots, FAILURE_TTL_MS, MAX_PAGES, SNAPSHOT_TTL_MS, STALE_TTL_MS, TERMINAL_TTL_MS } from "./pull-snapshot.ts";

const HEAD = "a".repeat(40);
const at = (minute: number) => `2026-10-28T10:${String(minute).padStart(2, "0")}:00Z`;

/** A pull request as the snapshot's query answers it. */
const pull = (repo: string, number: number, over: Record<string, unknown> = {}) => ({
  number, state: "OPEN", url: `https://github.com/${repo}/pull/${number}`, title: `change ${number}`, body: "", isDraft: false, isCrossRepository: false, headRefName: `admin/x-${number}`, headRefOid: HEAD, baseRefName: "main",
  author: { login: "worker-bot", __typename: "User" }, reviewDecision: null, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", mergeQueueEntry: null, autoMergeRequest: null,
  files: { nodes: [{ path: "src/a.ts" }], pageInfo: { hasNextPage: false, endCursor: null } }, reviews: { nodes: [] }, comments: { nodes: [] }, reviewThreads: { nodes: [] },
  baseRef: { rules: { nodes: [{ type: "REQUIRED_STATUS_CHECKS", parameters: { requiredStatusChecks: [{ context: "gate" }] } }] }, branchProtectionRule: null },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "CheckRun", name: "gate", status: "IN_PROGRESS", conclusion: null, startedAt: at(1), completedAt: null, detailsUrl: null },
    { __typename: "CheckRun", name: "suite", status: "COMPLETED", conclusion: "FAILURE", startedAt: at(1), completedAt: at(2), detailsUrl: null },
  ] } } } }] }, ...over,
});

type Repo = { pulls: ReturnType<typeof pull>[]; closed?: ReturnType<typeof pull>[]; private?: boolean; bot?: boolean; pages?: ReturnType<typeof pull>[][] };

/** A `gh` that answers the snapshot's query for the repositories in `world`, and a query by number for any pull request it holds, and records each call. A repository `unreadable` refuses. */
function github(world: Record<string, Repo>, refused: string[] = []) {
  const calls: string[][] = [];
  const gh: AsyncGh = async (args) => {
    calls.push([...args]);
    const value = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    const repo = `${value("owner")}/${value("repo")}`;
    if (args[0] !== "api" || args[1] !== "graphql") throw new Error(`unexpected gh ${args.join(" ")}`);
    if (refused.includes(repo)) throw new GhFailure(args, { status: 1, stdout: "", stderr: "gh: HTTP 502" });
    const held = world[repo];
    if (held === undefined) return JSON.stringify({ data: { repository: null }, errors: [{ type: "NOT_FOUND" }] });
    const query = value("query") ?? "";
    const head = { isPrivate: held.private === true, bot: held.bot === true ? { __typename: "Blob" } : null };
    if (query.includes("pullRequests(states: OPEN")) {
      const after = value("after");
      const pages = held.pages ?? [held.pulls];
      const index = after === undefined ? 0 : Number(after);
      return JSON.stringify({ data: { repository: { ...head, pullRequests: { pageInfo: { hasNextPage: index + 1 < pages.length, endCursor: String(index + 1) }, nodes: pages[index] } } } });
    }
    const number = Number(value("number"));
    const found = [...held.pulls, ...(held.closed ?? [])].find((each) => each.number === number);
    return JSON.stringify({ data: { repository: { ...head, pullRequest: found ?? null } } });
  };
  return { gh, calls };
}

/** A clock the test moves. */
function clock() {
  let now = Date.parse("2026-10-28T10:00:00Z");
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

test("A11-365: with 10 open pull requests across 3 repositories, a sweep of every reader makes 3 GitHub calls for pull-request state: one per repository", async () => {
  const world: Record<string, Repo> = {
    "a11ign/one": { pulls: [1, 2, 3, 4].map((number) => pull("a11ign/one", number)) },
    "a11ign/two": { pulls: [5, 6, 7].map((number) => pull("a11ign/two", number)) },
    "a11ign/three": { pulls: [8, 9, 10].map((number) => pull("a11ign/three", number, number === 9 ? { author: { login: "dependabot", __typename: "Bot" } } : {})) },
  };
  const { gh, calls } = github(world);
  const policy = corePolicy(() => ({ fields: "headRefOid,reviews,author,isCrossRepository,statusCheckRollup", trustOf: () => "inside", settledOf: () => false, unrequiredRedOf: () => [] }));
  const host = createCodeHost(fakePluginDeps({ policy, execAsync: async (_file, args) => ({ status: 0, stdout: await gh([...args]), stderr: "" }) }));
  const everyUrl = Object.entries(world).flatMap(([repo, { pulls }]) => pulls.map(({ number }) => `https://github.com/${repo}/pull/${number}`));
  assert.equal(everyUrl.length, 10);

  const sweep = async () => {
    for (const [repo] of Object.entries(world)) {
      await host.openPullUrlsOf(repo);
      await host.openDependencyPulls?.(repo);
    }
    for (const url of everyUrl) {
      assert.notEqual(await host.readReviewState(url), null, url);
      assert.notEqual(await host.readPullFeedback(url, "worker-bot"), null, url);
      assert.equal(await host.readPullState(url), "OPEN", url);
      assert.notEqual(await host.readReplies?.(url, { since: 0, authors: ["worker-bot"] }), null, url);
    }
  };
  await sweep();
  assert.equal(calls.length, 3, `${calls.map((args) => args.find((arg) => arg.startsWith("repo="))).join(", ")}`);
  assert.deepEqual(calls.map((args) => args.find((arg) => arg.startsWith("repo="))).sort(), ["repo=one", "repo=three", "repo=two"]);
  assert.ok(calls.every((args) => args[0] === "api" && args[1] === "graphql"), "each is the one GraphQL query");
  assert.deepEqual(host.readCallCounts?.()?.total, 3, "and the plugin counts three");
  assert.deepEqual(host.readCallCounts?.()?.byKind, { graphql: 3, rest: 0, cli: 0 });
  await sweep();
  assert.equal(calls.length, 3, "a second sweep in the same window is served by the same snapshots: it costs nothing");
});

test("A11-365: a snapshot is kept for a sweep, then read again, and a repository is read when it is first asked for and not before", async () => {
  const { gh, calls } = github({ "o/r": { pulls: [pull("o/r", 1)] }, "o/s": { pulls: [pull("o/s", 2)] } });
  const time = clock();
  const snapshots = createPullSnapshots({ gh, now: time.now });
  assert.equal(calls.length, 0, "nothing is read until it is asked");
  await snapshots.pull("o/r", 1);
  await snapshots.pull("o/r", 1);
  assert.equal(calls.length, 1);
  time.advance(SNAPSHOT_TTL_MS - 1);
  await snapshots.snapshot("o/r");
  assert.equal(calls.length, 1, "still the same sweep");
  time.advance(1);
  await snapshots.snapshot("o/r");
  assert.equal(calls.length, 2, "the next sweep reads it again");
  await snapshots.snapshot("o/s");
  assert.equal(calls.length, 3);
});

test("A11-365: the checks the base requires are named by its rulesets and its branch protection, per pull request's own base, and a base that requires none names none", async () => {
  const own = (base: string, baseRef: unknown) => pull("o/r", base === "main" ? 1 : 2, { baseRefName: base, baseRef });
  const ruleset = { rules: { nodes: [{ type: "PULL_REQUEST", parameters: {} }, { type: "REQUIRED_STATUS_CHECKS", parameters: { requiredStatusChecks: [{ context: "gate" }, { context: "lint" }] } }] }, branchProtectionRule: null };
  const protection = { rules: { nodes: [] }, branchProtectionRule: { requiredStatusChecks: [{ context: "suite" }] } };
  const none = { rules: { nodes: [] }, branchProtectionRule: null };
  const requiredOf = async (node: ReturnType<typeof pull>) => (await createPullSnapshots({ gh: github({ "o/r": { pulls: [node] } }).gh }).pull("o/r", node.number))?.node.commits.nodes[0].commit.statusCheckRollup.contexts.nodes
    .filter((check: { isRequired: boolean }) => check.isRequired).map((check: { name: string }) => check.name);
  assert.deepEqual(await requiredOf(own("main", ruleset)), ["gate"], "gate is a check of the pull request and required by the ruleset; lint is required and has not reported, so it is not in the rollup");
  assert.deepEqual(await requiredOf(own("release/2", protection)), ["suite"], "a stacked pull request's base has its own protection");
  assert.deepEqual(await requiredOf(own("main", none)), []);
  assert.deepEqual(await requiredOf(own("gone", null)), [], "a base branch that no longer exists requires nothing");
});

test("A11-365: a pull request the open list does not hold is read by its number once: a merged one is remembered, and an open one opened since is kept until the next sweep", async () => {
  const world = { "o/r": { pulls: [pull("o/r", 1), pull("o/r", 3)], closed: [pull("o/r", 2, { state: "MERGED" })] } };
  const { gh, calls } = github(world);
  const time = clock();
  const snapshots = createPullSnapshots({ gh, now: time.now });
  assert.equal((await snapshots.pull("o/r", 2))?.node.state, "MERGED");
  assert.equal(calls.length, 2, "the list, then the pull request by its number");
  await snapshots.pull("o/r", 2);
  await snapshots.pull("o/r", 2);
  assert.equal(calls.length, 2, "a merged pull request is remembered");
  snapshots.invalidate("o/r");
  await snapshots.pull("o/r", 2);
  assert.equal(calls.length, 3, "a write drops the repository's list, and not what a pull request that is no longer open once was: only the list is read again");
  time.advance(TERMINAL_TTL_MS);
  await snapshots.pull("o/r", 2);
  assert.equal(calls.length, 5, "and what was remembered of it lasts only so long: it is read again, a reopened pull request is then seen as open");
  world["o/r"].pulls.push(pull("o/r", 4));
  await snapshots.pull("o/r", 4);
  await snapshots.pull("o/r", 4);
  assert.equal(calls.length, 6, "a pull request opened after the list was read is read by its number, once");
  assert.equal(await snapshots.pull("o/r", 99), null, "a pull request that is none is null");
});

test("A11-365: a repository that cannot be read is null and is not asked again for a while, and its pull requests are never read one by one instead", async () => {
  const { gh, calls } = github({ "o/r": { pulls: [pull("o/r", 1)] } }, ["o/r"]);
  const time = clock();
  const snapshots = createPullSnapshots({ gh, now: time.now });
  assert.equal(await snapshots.pull("o/r", 1), null);
  assert.equal(await snapshots.snapshot("o/r"), null);
  assert.equal(await snapshots.pull("o/r", 2), null);
  assert.equal(calls.length, 1, "an outage costs one call, not one for each reader");
  assert.ok(calls[0].some((arg) => arg.includes("pullRequests(states: OPEN")), "and that one is the list");
  time.advance(FAILURE_TTL_MS);
  await snapshots.snapshot("o/r");
  assert.equal(calls.length, 2, "it is asked again once the wait is over");
  assert.equal(await createPullSnapshots({ gh: async () => "not json" }).snapshot("o/r"), null);
  assert.equal(await createPullSnapshots({ gh: async () => JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }) }).snapshot("o/r"), null, "an answer without the repository's privacy is no reading");
  assert.equal(await createPullSnapshots({ gh }).snapshot("not a repository"), null);
});

test("A11-365: a repository with more open pull requests than a page holds is read page by page, up to a cap, and says when the list is cut", async () => {
  const page = (offset: number) => Array.from({ length: 2 }, (_, at) => pull("o/r", offset + at));
  const paged = github({ "o/r": { pulls: [], pages: [page(1), page(3)] } });
  const whole = await createPullSnapshots({ gh: paged.gh }).snapshot("o/r");
  assert.deepEqual([...whole!.pulls.keys()], [1, 2, 3, 4]);
  assert.equal(whole!.complete, true);
  assert.equal(paged.calls.length, 2);
  assert.ok(paged.calls[1].includes("after=1"), "the second page is asked after the first's cursor");
  const endless = github({ "o/r": { pulls: [], pages: Array.from({ length: MAX_PAGES + 3 }, (_, index) => page(index * 2 + 1)) } });
  const cut = await createPullSnapshots({ gh: endless.gh }).snapshot("o/r");
  assert.deepEqual([cut!.complete, endless.calls.length, cut!.pulls.size], [false, MAX_PAGES, MAX_PAGES * 2]);
});

test("A11-365: a write the plugin makes to a pull request drops its repository's snapshot, so the next read is a fresh one", async () => {
  const { gh, calls } = github({ "a11ign/agent-org": { pulls: [pull("a11ign/agent-org", 7)] } });
  const host = createCodeHost(fakePluginDeps({ execAsync: async (_file, args) => ({ status: 0, stdout: args[0] === "api" && args[1] === "graphql" ? await gh([...args]) : "", stderr: "" }), exec: () => ({ status: 0, stdout: "", stderr: "" }) }));
  const url = "https://github.com/a11ign/agent-org/pull/7";
  await host.readPullState(url);
  await host.readPullState(url);
  assert.equal(calls.length, 1);
  host.commentOnPull?.(url, "a comment");
  await host.readPullState(url);
  assert.equal(calls.length, 2, "a comment changes the pull request: the next read asks");
  host.closePull?.(url, "closing");
  await host.readPullState(url);
  assert.equal(calls.length, 3);
  host.updateBranch?.(url, HEAD);
  await host.readPullState(url);
  assert.equal(calls.length, 4);
});

test("A11-365: the head's merge-bot file is read once for a head that holds it, and again after a sweep for one that does not", async () => {
  const asked: string[] = [];
  const holding = new Set<string>();
  const gh: AsyncGh = async (args) => {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    asked.push(query);
    return JSON.stringify({ data: { r0: { headBot: holding.has(query.match(/refs\/pull\/(\d+)\/head/)?.[1] ?? "") ? { __typename: "Blob" } : null } } });
  };
  const time = clock();
  const snapshots = createPullSnapshots({ gh, now: time.now });
  holding.add("5");
  assert.equal(await snapshots.headHoldsMergeBot("o/r", 5, HEAD), true);
  assert.equal(await snapshots.headHoldsMergeBot("o/r", 5, HEAD), true);
  assert.equal(await snapshots.headHoldsMergeBot("o/r", 6, HEAD), false);
  assert.equal(await snapshots.headHoldsMergeBot("o/r", 6, HEAD), false);
  assert.equal(asked.length, 2);
  time.advance(SNAPSHOT_TTL_MS);
  assert.equal(await snapshots.headHoldsMergeBot("o/r", 5, HEAD), true);
  assert.equal(await snapshots.headHoldsMergeBot("o/r", 6, HEAD), false);
  assert.equal(asked.length, 3, "a head that holds the bot always does; one that does not is asked again");
  assert.equal(await snapshots.headHoldsMergeBot("o/r", 5, "b".repeat(40)), true);
  assert.equal(asked.length, 4, "and a new head is a new question");
});

test("A11-365: the query asks for everything the readers read, so no reader needs a call of its own", async () => {
  const { gh, calls } = github({ "o/r": { pulls: [pull("o/r", 1)] } });
  await createPullSnapshots({ gh }).snapshot("o/r");
  const query = calls[0].find((arg) => arg.startsWith("query="))!;
  for (const wanted of ["headRefOid", "reviewDecision", "reviews(last: 50)", "statusCheckRollup", "contexts(first: 100)", "mergeable", "mergeStateStatus", "mergeQueueEntry { state }", "autoMergeRequest { enabledAt }",
    "itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT]", "on RemovedFromMergeQueueEvent { createdAt reason actor { login } beforeCommit { oid } }",
    "files(first: 100)", "comments(last: 50)", "reviewThreads(last: 50)", "isCrossRepository", "isDraft", "baseRef", "RequiredStatusChecksParameters", "requiredStatusChecks", "branchProtectionRule", "merge-bot.yml"]) {
    assert.ok(query.includes(wanted), `the query asks ${wanted}`);
  }
  assert.ok(!query.includes("isRequired("), "which checks are required comes from the base, so the query does not repeat the pull request's number for each check");
});

test("A11-365: the pages of changed files after the first are read by the pull request's number, through the snapshots", async () => {
  const seen: string[][] = [];
  const snapshots = createPullSnapshots({ gh: async (args) => { seen.push([...args]); return JSON.stringify({ data: { repository: { pullRequest: { files: { nodes: [{ path: "b.ts" }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }); } });
  assert.deepEqual(await snapshots.moreFiles("o/r", 5, "c1"), { nodes: [{ path: "b.ts" }], pageInfo: { hasNextPage: false, endCursor: null } });
  assert.ok(seen[0].includes("number=5") && seen[0].includes("cursor=c1") && seen[0].includes("owner=o") && seen[0].includes("repo=r"));
  await assert.rejects(() => snapshots.moreFiles("not a repository", 5, "c1"), /owner\/name/);
});

test("A11-365: a caller that records what it read to compare it later refreshes the repository first, and the next read is a fresh one", async () => {
  const { gh, calls } = github({ "a11ign/agent-org": { pulls: [pull("a11ign/agent-org", 7)] } });
  const host = createCodeHost(fakePluginDeps({ execAsync: async (_file, args) => ({ status: 0, stdout: await gh([...args]), stderr: "" }) }));
  const url = "https://github.com/a11ign/agent-org/pull/7";
  await host.readPullState(url);
  host.refreshPull?.(url);
  await host.readPullState(url);
  await host.readPullState(url);
  assert.equal(calls.length, 2);
  host.refreshPull?.("https://example.com/not-a-pull");
  assert.equal(calls.length, 2, "an address that is no pull request drops nothing");
});

test("A11-365: the account gh acts as is read once, and asked again only after a read that failed", async () => {
  let asks = 0;
  let answer: { status: number; stdout: string } = { status: 1, stdout: "" };
  const host = createCodeHost(fakePluginDeps({ execAsync: async () => { asks += 1; return { ...answer, stderr: "" }; } }));
  assert.equal(await host.readOwnLogin(), null);
  assert.equal(await host.readOwnLogin(), null);
  answer = { status: 0, stdout: "worker-bot\n" };
  assert.equal(await host.readOwnLogin(), "worker-bot");
  assert.equal(await host.readOwnLogin(), "worker-bot");
  assert.equal(asks, 3, "two refused reads and one that answered; the fourth was kept");
});

test("A11-365: the REST reads the host repeats are conditional: the second is sent with the ETag the first was given, and a 304 costs nothing", async () => {
  const calls: string[][] = [];
  const body = JSON.stringify({ total_count: 0, workflow_runs: [] });
  const host = createCodeHost(fakePluginDeps({ execAsync: async (_file, args) => {
    calls.push([...args]);
    if (args.some((arg) => arg.startsWith("If-None-Match: "))) return { status: 1, stdout: "HTTP/2.0 304 Not Modified\r\nEtag: \"runs\"\r\n\r\n", stderr: "gh: HTTP 304\n" };
    return { status: 0, stdout: `HTTP/2.0 200 OK\r\nEtag: "runs"\r\n\r\n${body}`, stderr: "" };
  } }));
  const first = await host.readBranchCi?.("a11ign/agent-org", "admin/a11-365", new Set());
  const second = await host.readBranchCi?.("a11ign/agent-org", "admin/a11-365", new Set());
  assert.deepEqual([first, second], [[], []]);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("If-None-Match: \"runs\"") && calls[1].includes("-i"));
  assert.deepEqual(host.readCallCounts?.()?.notModified, 1, "the count says how many were answered as unchanged");
});

test("A11-365: a hiccup of GitHub serves the snapshot the repository had for a while, then says nothing, and a write ends the grace", async () => {
  const refused = ["a/b"];
  const { gh, calls } = github({ "a/b": { pulls: [pull("a/b", 1)] } }, refused);
  const time = clock();
  refused.length = 0;
  const snapshots = createPullSnapshots({ gh, now: time.now });
  assert.equal((await snapshots.pull("a/b", 1))?.node.number, 1);
  refused.push("a/b");
  time.advance(SNAPSHOT_TTL_MS);
  assert.equal((await snapshots.pull("a/b", 1))?.node.number, 1, "the list could not be read again: the one it had is served");
  assert.equal((await snapshots.pull("a/b", 1))?.node.number, 1);
  assert.equal(calls.length, 2, "and it was not asked again meanwhile");
  time.advance(STALE_TTL_MS);
  assert.equal(await snapshots.pull("a/b", 1), null, "a repository that stays unreadable is no reading");
  refused.length = 0;
  time.advance(FAILURE_TTL_MS);
  assert.equal((await snapshots.pull("a/b", 1))?.node.number, 1, "and it is read again once it answers");
  refused.push("a/b");
  snapshots.invalidate("a/b");
  time.advance(SNAPSHOT_TTL_MS);
  assert.equal(await snapshots.pull("a/b", 1), null, "a snapshot dropped by a write is not served in its place");
});

test("A11-365: a list that cannot be read whole is no snapshot: a page with no pageInfo, a cursor that is missing, a pull request that cannot be read, never a list read as complete", async () => {
  const listed = (pageInfo: unknown, nodes: unknown[] = [pull("o/r", 1)]) => JSON.stringify({ data: { repository: { isPrivate: false, bot: null, pullRequests: { ...(pageInfo === undefined ? {} : { pageInfo }), nodes } } } });
  const read = (answer: string) => createPullSnapshots({ gh: async () => answer }).snapshot("o/r");
  assert.equal((await read(listed({ hasNextPage: false, endCursor: null })))?.complete, true, "POSITIVE CONTROL: a whole page says it is the last");
  assert.equal(await read(listed(undefined)), null, "no pageInfo does not say the page is the last");
  assert.equal(await read(listed({})), null, "a pageInfo that does not say if another page follows");
  assert.equal(await read(listed({ hasNextPage: "no" })), null);
  assert.equal(await read(listed({ hasNextPage: true })), null, "another page with no cursor to read it by");
  assert.equal(await read(listed({ hasNextPage: true, endCursor: 7 })), null);
  assert.equal(await read(listed({ hasNextPage: false }, [pull("o/r", 1), { number: 2 }])), null, "a pull request that has no state is not left out of the list");
  assert.equal(await read(listed({ hasNextPage: false }, [pull("o/r", 1), null])), null);
  const second = (page: string) => { let page1 = true; return createPullSnapshots({ gh: async () => { const now = page1 ? listed({ hasNextPage: true, endCursor: "c1" }) : page; page1 = false; return now; } }).snapshot("o/r"); };
  assert.equal((await second(listed({ hasNextPage: false })))?.pulls.size, 1, "POSITIVE CONTROL: two whole pages are one list");
  assert.equal(await second(listed(undefined)), null, "a later page that cannot be read makes the whole list unknown, not the part read");
});
