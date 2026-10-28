// no-token: none -- `gh` is a scripted stand-in: no GitHub CLI runs
//
// THE REVIEW READS ARE BATCHED (A11-356): the open pull requests of a repository are read with ONE `gh pr list`, shared by every pull request of it and every caller, where each caller read each pull request with a `gh pr view` of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { corePolicy } from "../../src/plugins/policy.ts";
import type { AsyncGh } from "./gh.ts";
import { BATCH_LIMIT, createReviewReads, PEEK_MS } from "./reviews.ts";
import { sharedReads } from "./shared-reads.ts";

const REPO = "owner/repo";
const urlOf = (number: number, repo = REPO) => `https://github.com/${repo}/pull/${number}`;
const head = (number: number) => String(number).padStart(40, "0");
const policy = corePolicy(() => ({ fields: "headRefOid,reviews", trustOf: () => "inside", settledOf: () => true, unrequiredRedOf: () => [] }));

/** A pull request as `gh pr list --json` and `gh pr view --json` give it: green, with one review. */
const pull = (number: number, state = "OPEN") => ({ number, state, headRefOid: head(number), reviews: [{ author: { login: "reviewer" }, state: "APPROVED", commit: { oid: head(number) }, submittedAt: "2026-10-27T10:00:00Z" }] });

/** A `gh` that answers a list of open pull requests per repository, a view of any pull request it holds, and records every call. */
function github(held: Readonly<Record<string, ReturnType<typeof pull>[]>>, options: { listFails?: boolean } = {}) {
  const calls: string[][] = [];
  const gh: AsyncGh = async (args) => {
    calls.push(args);
    const repo = args[args.indexOf("--repo") + 1];
    if (args[0] === "pr" && args[1] === "list") {
      if (options.listFails === true) throw new Error("gh is down");
      return JSON.stringify((held[repo] ?? []).filter(({ state }) => state === "OPEN"));
    }
    if (args[0] === "pr" && args[1] === "view") {
      const found = (held[repo] ?? []).find(({ number }) => String(number) === args[2]);
      if (found === undefined) throw new Error("Could not resolve to a PullRequest (HTTP 404)");
      return JSON.stringify(found);
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { calls, gh };
}

const readsOver = (gh: AsyncGh, clock = { now: 0 }) => createReviewReads({ gh, shared: sharedReads({ ttlMs: 10_000, now: () => clock.now }), now: () => clock.now });
const listsOf = (calls: readonly string[][]) => calls.filter(([a, b]) => a === "pr" && b === "list");
const viewsOf = (calls: readonly string[][]) => calls.filter(([a, b]) => a === "pr" && b === "view");

test("A11-356: the review state of every open pull request of a repository, asked by several callers, is read with one gh pr list and no gh pr view", async () => {
  const { calls, gh } = github({ [REPO]: [pull(1), pull(2), pull(3), pull(4), pull(5)] });
  const reads = readsOver(gh);
  const urls = [1, 2, 3, 4, 5].map((n) => urlOf(n));
  // Two callers of the same pass (a sweep and the early start of a green head) each ask for every pull request, and the state of one is asked for a third time.
  const [sweep, early] = await Promise.all([Promise.all(urls.map((url) => reads.state(url, policy))), Promise.all(urls.map((url) => reads.state(url, policy)))]);
  const again = await reads.state(urls[2], policy);
  assert.deepEqual(sweep.map((state) => state?.head), [1, 2, 3, 4, 5].map(head));
  assert.deepEqual(early.map((state) => state?.head), [1, 2, 3, 4, 5].map(head));
  assert.equal(again?.head, head(3));
  assert.equal(listsOf(calls).length, 1, "one list for the five pull requests and the eleven reads");
  assert.deepEqual(listsOf(calls)[0], ["pr", "list", "--repo", REPO, "--state", "open", "--limit", String(BATCH_LIMIT), "--json", "number,headRefOid,reviews"]);
  assert.equal(viewsOf(calls).length, 0, "no pull request is read on its own");
});

test("A11-356: each repository is its own list, and the state of a pull request is asked of the list of its own repository", async () => {
  const { calls, gh } = github({ "owner/a": [pull(1)], "owner/b": [pull(1)] });
  const reads = readsOver(gh);
  await Promise.all([reads.state(urlOf(1, "owner/a"), policy), reads.state(urlOf(1, "owner/b"), policy), reads.state(urlOf(1, "owner/a"), policy)]);
  assert.deepEqual(listsOf(calls).map((call) => call[call.indexOf("--repo") + 1]).sort(), ["owner/a", "owner/b"]);
});

test("A11-356: a pull request the list does not hold is read on its own, once in the time the answers are shared", async () => {
  const { calls, gh } = github({ [REPO]: [pull(1), pull(2, "MERGED")] });
  const reads = readsOver(gh);
  const merged = urlOf(2);
  assert.equal(await reads.pullState(merged), "MERGED");
  assert.equal(await reads.pullState(merged), "MERGED");
  assert.equal((await reads.state(merged, policy))?.head, head(2), "the review state of a merged pull request is read too");
  assert.equal(viewsOf(calls).filter((call) => call.includes("state")).length, 1, "the state of a merged pull request is read on its own once");
});

test("A11-356: the state of an open pull request comes from the list, and one the host cannot find reads as null", async () => {
  const { calls, gh } = github({ [REPO]: [pull(1)] });
  const reads = readsOver(gh);
  assert.equal(await reads.pullState(urlOf(1)), "OPEN");
  assert.equal(await reads.pullState(urlOf(404)), null);
  assert.equal(await reads.state(urlOf(404), policy), null);
  assert.equal(viewsOf(calls).length, 2, "the two views of the pull request that is not there: its state and its fields");
});

test("A11-356: a list that could not be read falls back to reading the pull request on its own, and is asked again at the next read", async () => {
  const { calls, gh } = github({ [REPO]: [pull(1)] }, { listFails: true });
  const clock = { now: 0 };
  const reads = readsOver(gh, clock);
  assert.equal((await reads.state(urlOf(1), policy))?.head, head(1));
  assert.equal(listsOf(calls).length, 1);
  clock.now = 1;
  await reads.state(urlOf(1), policy);
  assert.equal(listsOf(calls).length, 2, "a failed list is not kept: it is asked again");
});

test("A11-356: after the bound the list is read again, so a sweep reads what GitHub says now", async () => {
  const held = { [REPO]: [pull(1)] };
  const { calls, gh } = github(held);
  const clock = { now: 0 };
  const reads = readsOver(gh, clock);
  assert.equal((await reads.state(urlOf(1), policy))?.head, head(1));
  held[REPO] = [{ ...pull(1), headRefOid: head(9) }];
  clock.now = 9_999;
  assert.equal((await reads.state(urlOf(1), policy))?.head, head(1), "within the bound");
  clock.now = 10_000;
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

test("A11-356: a fresh read asks for the list again, though the list was read within the bound, and a read that is not fresh does not", async () => {
  const held = { [REPO]: [pull(1)] };
  const { calls, gh } = github(held);
  const reads = readsOver(gh);
  assert.equal((await reads.state(urlOf(1), policy))?.reviews.length, 1);
  held[REPO] = [{ ...pull(1), reviews: [] }];
  assert.equal((await reads.state(urlOf(1), policy))?.reviews.length, 1, "within the bound, the list of before");
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

test("A11-356: an answer that is not an object of fields is no reading: a view that prints null, and a list that holds a bare value", async () => {
  const gh: AsyncGh = async (args) => (args[1] === "list" ? JSON.stringify([null, 7, "x", pull(1)]) : "null");
  const reads = readsOver(gh);
  assert.equal((await reads.state(urlOf(1), policy))?.head, head(1), "the one pull request in the list is read, the others are skipped");
  assert.equal(await reads.state(urlOf(2), policy), null, "a view that printed null is read as no reading");
});
