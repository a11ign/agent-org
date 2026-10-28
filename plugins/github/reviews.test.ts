// no-token: none -- `gh` is a scripted stand-in that answers the snapshot's GraphQL: no GitHub CLI runs
//
// THE REVIEW READS ARE SHARED (A11-356, A11-365): the open pull requests of a repository are read with ONE query, shared by every pull request of it and every caller, with the checks its base requires and its merge flow in the same answer,
// where each caller read each pull request with a `gh pr view` of its own (35 a minute, each holding the loop for a second).
import { test } from "node:test";
import assert from "node:assert/strict";
import { corePolicy } from "../../src/plugins/policy.ts";
import type { AsyncGh } from "./gh.ts";
import { createPullSnapshots, SNAPSHOT_TTL_MS } from "./pull-snapshot.ts";
import { createReviewReads, PEEK_MS } from "./reviews.ts";

const REPO = "owner/repo";
const urlOf = (number: number, repo = REPO) => `https://github.com/${repo}/pull/${number}`;
const head = (number: number) => String(number).padStart(40, "0");
const policy = corePolicy(() => ({ fields: "headRefOid,reviews", trustOf: () => "inside", settledOf: () => true, unrequiredRedOf: () => [] }));

/** A pull request as the snapshot's query answers it: green, with one review. */
const pull = (number: number, state = "OPEN") => ({ number, state, headRefOid: head(number), author: { login: "worker", __typename: "User" }, isCrossRepository: false,
  reviews: { nodes: [{ author: { login: "reviewer" }, state: "APPROVED", commit: { oid: head(number) }, submittedAt: "2026-10-28T10:00:00Z" }] }, baseRef: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] } });

/** A `gh` that answers the list of open pull requests per repository and a query by number for any pull request it holds, and records every call. */
function github(held: Record<string, ReturnType<typeof pull>[]>, options: { listFails?: boolean } = {}) {
  const calls: string[][] = [];
  const gh: AsyncGh = async (args) => {
    calls.push(args);
    const value = (name: string) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
    const repo = `${value("owner")}/${value("repo")}`;
    const query = value("query") ?? "";
    if (query.includes("pullRequests(states: OPEN")) {
      if (options.listFails === true) throw new Error("gh is down");
      return JSON.stringify({ data: { repository: { isPrivate: false, bot: null, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: (held[repo] ?? []).filter(({ state }) => state === "OPEN") } } } });
    }
    const found = (held[repo] ?? []).find(({ number }) => String(number) === value("number"));
    return JSON.stringify({ data: { repository: { isPrivate: false, bot: null, pullRequest: found ?? null } } });
  };
  return { calls, gh };
}

const readsOver = (gh: AsyncGh, clock = { now: 0 }) => createReviewReads({ snapshots: createPullSnapshots({ gh, now: () => clock.now }), now: () => clock.now });
const listsOf = (calls: readonly string[][]) => calls.filter((call) => call.some((arg) => arg.includes("pullRequests(states: OPEN")));
const byNumber = (calls: readonly string[][]) => calls.filter((call) => call.some((arg) => arg.startsWith("number=")));

test("A11-356: the review state of every open pull request of a repository, asked by several callers, is read with one query and none by number", async () => {
  const { calls, gh } = github({ [REPO]: [pull(1), pull(2), pull(3), pull(4), pull(5)] });
  const reads = readsOver(gh);
  const urls = [1, 2, 3, 4, 5].map((n) => urlOf(n));
  // Two callers of the same pass (a sweep and the early start of a green head) each ask for every pull request, and the state of one is asked for a third time.
  const [sweep, early] = await Promise.all([Promise.all(urls.map((url) => reads.state(url, policy))), Promise.all(urls.map((url) => reads.state(url, policy)))]);
  const again = await reads.state(urls[2], policy);
  assert.deepEqual(sweep.map((state) => state?.head), [1, 2, 3, 4, 5].map(head));
  assert.deepEqual(early.map((state) => state?.head), [1, 2, 3, 4, 5].map(head));
  assert.equal(again?.head, head(3));
  assert.equal(calls.length, 1, "one call for the five pull requests and the eleven reads, though the first reads were in flight together");
  assert.equal(byNumber(calls).length, 0, "no pull request is read on its own");
});

test("A11-356: each repository is its own list, and the state of a pull request is asked of the list of its own repository", async () => {
  const { calls, gh } = github({ "owner/a": [pull(1)], "owner/b": [pull(1)] });
  const reads = readsOver(gh);
  await Promise.all([reads.state(urlOf(1, "owner/a"), policy), reads.state(urlOf(1, "owner/b"), policy), reads.state(urlOf(1, "owner/a"), policy)]);
  assert.deepEqual(listsOf(calls).map((call) => call.find((arg) => arg.startsWith("repo="))).sort(), ["repo=a", "repo=b"]);
});

test("A11-356: a pull request the list does not hold is read by its number once, and a merged one is remembered", async () => {
  const { calls, gh } = github({ [REPO]: [pull(1), pull(2, "MERGED")] });
  const reads = readsOver(gh);
  const merged = urlOf(2);
  assert.equal(await reads.pullState(merged), "MERGED");
  assert.equal(await reads.pullState(merged), "MERGED");
  assert.equal((await reads.state(merged, policy))?.head, head(2), "the review state of a merged pull request is read too");
  assert.equal(byNumber(calls).length, 1, "the merged pull request is read on its own once");
});

test("A11-356: the state of an open pull request comes from the list, and one the host cannot find reads as null", async () => {
  const { gh } = github({ [REPO]: [pull(1)] });
  const reads = readsOver(gh);
  assert.equal(await reads.pullState(urlOf(1)), "OPEN");
  assert.equal(await reads.pullState(urlOf(404)), null);
  assert.equal(await reads.state(urlOf(404), policy), null);
});

test("A11-356: a list that could not be read is no reading, never read pull request by pull request instead, and is asked again after the wait", async () => {
  const { calls, gh } = github({ [REPO]: [pull(1)] }, { listFails: true });
  const clock = { now: 0 };
  const reads = readsOver(gh, clock);
  assert.equal(await reads.state(urlOf(1), policy), null);
  assert.equal(await reads.state(urlOf(1), policy), null);
  assert.equal(calls.length, 1, "one call, and no read of the pull request on its own");
  clock.now = 10_000;
  await reads.state(urlOf(1), policy);
  assert.equal(listsOf(calls).length, 2, "a failed list is not kept: it is asked again once the wait is over");
});

test("A11-356: after the sweep the list is read again, so a sweep reads what GitHub says now", async () => {
  const held = { [REPO]: [pull(1)] };
  const { calls, gh } = github(held);
  const clock = { now: 0 };
  const reads = readsOver(gh, clock);
  assert.equal((await reads.state(urlOf(1), policy))?.head, head(1));
  held[REPO] = [{ ...pull(1), headRefOid: head(9) }];
  clock.now = SNAPSHOT_TTL_MS - 1;
  assert.equal((await reads.state(urlOf(1), policy))?.head, head(1), "within the sweep");
  clock.now = SNAPSHOT_TTL_MS;
  assert.equal((await reads.state(urlOf(1), policy))?.head, head(9), "past it");
  assert.equal(listsOf(calls).length, 2);
});

test("A11-356: each read answers a state of its own, so a caller that changes the one it was given changes nothing for the next", async () => {
  const { gh } = github({ [REPO]: [pull(1)] });
  const reads = readsOver(gh);
  const first = await reads.state(urlOf(1), policy);
  (first!.reviews as unknown[]).length = 0;
  assert.equal((await reads.state(urlOf(1), policy))?.reviews.length, 1);
});

test("A11-356: the state a read answered can be peeked for a minute, and not after", async () => {
  const { gh } = github({ [REPO]: [pull(1)] });
  const clock = { now: 0 };
  const reads = readsOver(gh, clock);
  assert.equal(reads.peek(urlOf(1)), null, "nothing is peeked before a read");
  const read = await reads.state(urlOf(1), policy);
  clock.now = PEEK_MS - 1;
  assert.equal(reads.peek(urlOf(1)), read);
  clock.now = PEEK_MS;
  assert.equal(reads.peek(urlOf(1)), null);
});

test("A11-356: a fresh read asks for the list again, though the list was read within the sweep, and a read that is not fresh does not", async () => {
  const held = { [REPO]: [pull(1)] };
  const { calls, gh } = github(held);
  const reads = readsOver(gh);
  assert.equal((await reads.state(urlOf(1), policy))?.reviews.length, 1);
  held[REPO] = [{ ...pull(1), reviews: { nodes: [] } }];
  assert.equal((await reads.state(urlOf(1), policy))?.reviews.length, 1, "within the sweep, the list of before");
  assert.equal((await reads.state(urlOf(1), policy, { fresh: true }))?.reviews.length, 0, "fresh, the list of now");
  assert.equal(listsOf(calls).length, 2);
});

test("A11-356: the states kept for peeking are let go once they expire, whether or not anyone peeks", async () => {
  const { gh } = github({ [REPO]: [pull(1), pull(2)] });
  const clock = { now: 0 };
  const reads = readsOver(gh, clock);
  await reads.state(urlOf(1), policy);
  clock.now = PEEK_MS;
  await reads.state(urlOf(2), policy);
  clock.now = 0;
  assert.equal(reads.peek(urlOf(1)), null, "the first was dropped when the second was read, after it had expired");
});

test("A11-365: a pull request whose head is read as `gh` printed it: the reviews keep their text, a bot author is `app/<login>`, a run in flight has an empty conclusion", async () => {
  const judged: Record<string, any>[] = [];
  const judging = corePolicy(() => ({ fields: "headRefOid,reviews,author,statusCheckRollup", trustOf: (pr) => { judged.push(pr); return "inside"; }, settledOf: () => true, unrequiredRedOf: () => [] }));
  const node = { ...pull(1), author: { login: "dependabot", __typename: "Bot" }, reviews: { nodes: [{ author: { login: "reviewer" }, state: "CHANGES_REQUESTED", body: "no", commit: { oid: head(1) }, submittedAt: "2026-10-28T10:00:00Z" }] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", name: "suite", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-10-28T10:01:00Z", completedAt: null }] } } } }] } };
  const { gh } = github({ [REPO]: [node as unknown as ReturnType<typeof pull>] });
  const state = await readsOver(gh).state(urlOf(1), judging);
  assert.deepEqual(judged[0].author, { login: "app/dependabot", is_bot: true });
  assert.deepEqual(state?.view.reviews, [{ author: { login: "reviewer" }, state: "CHANGES_REQUESTED", body: "no", commit: { oid: head(1) }, submittedAt: "2026-10-28T10:00:00Z" }]);
  assert.deepEqual(judged[0].statusCheckRollup, [{ __typename: "CheckRun", name: "suite", status: "IN_PROGRESS", conclusion: "", startedAt: "2026-10-28T10:01:00Z", completedAt: "0001-01-01T00:00:00Z", detailsUrl: undefined }]);
});

test("A11-365: a policy that reads a field of the pull request the snapshot does not hold refuses the read by name", async () => {
  const { gh } = github({ [REPO]: [pull(1)] });
  const labels = corePolicy(() => ({ fields: "headRefOid,labels", trustOf: () => "inside", settledOf: () => true, unrequiredRedOf: () => [] }));
  await assert.rejects(() => readsOver(gh).state(urlOf(1), labels), /reads labels of a pull request, which the snapshot of its repository does not hold/);
});
