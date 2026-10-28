// no-token: gh -- the code host, the reviewer and the clock are injected fakes; nothing is spawned
// module: the reviewer is told which word names the ticket, `Refs` or `Closes`, from the run's other pull requests (A11-274) -- the last of a run's pull requests to merge says Closes, and every other says Refs
//
// A11-253's step was nine pull requests in nine repositories, held by one run. The reviewer approved eight with `Refs A11-253` and blocked the last, a11ign.github.io#3, for the same word, because it could not see the
// siblings. The brief now carries the word, worked out from the states the run last read (`pullStates`), else the host's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeReviewer } from "../plugins/fakes/reviewer.ts";
import { poolFixture } from "./pool-fixture.ts";
import type { PoolContext } from "./pool-context.ts";
import type { Entry } from "./queue/queue-entries-and-outcomes.ts";
import type { ReviewState } from "./reviewer-port.ts";
import { briefOf } from "./pool-reviewers.ts";
import { loadReviewerGate } from "./reviewer-port.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";

const REPOS = ["a11ign/one", "a11ign/two", "a11ign/three"];
const URLS = REPOS.map((repo) => `https://github.com/${repo}/pull/1`);
const [FIRST, SECOND, THIRD] = URLS;
const LAST_STEP = "Refs A11-253\n\nPartial: step 2 of 2\n";

/** A context whose one run, A11-253, holds the three pull requests the host has seeded (every one open, or as `states` says), with the run's own reads of their states in `pullStates` when given. */
function holdingThree(states: Partial<Record<string, "open" | "merged" | "closed">> = {}, pullStates?: Entry["pullStates"]) {
  const host = createFakeCodeHost("worker-bot");
  REPOS.forEach((repo, at) => host.seedPull(repo, 1, { state: states[URLS[at]] ?? "open" }));
  const entry = { ticket: { key: "A11-253", description: "" }, review: REPOS.map((repo, at) => ({ repo, url: URLS[at] })), ...(pullStates === undefined ? {} : { pullStates }) } as unknown as Entry;
  const ctx = { codeHost: host, settings: { plan: null, stateDir: tmpDir("brief-closing-") }, store: { get: () => ({ entries: [entry] }) } } as unknown as PoolContext;
  return { ctx, host };
}

const bodied = (body: string) => ({ view: { body } }) as unknown as ReviewState;

test("A11-274: a run holding three pull requests, two of them open, briefs the third's reviewer Refs, naming the two still open", async () => {
  const { ctx } = holdingThree();
  assert.deepEqual((await briefOf(ctx, THIRD, bodied(LAST_STEP))).closing, { key: "A11-253", word: "refs", open: [FIRST, SECOND], merged: [] });
});

test("A11-274: once the other two have merged, the third's brief is Closes, naming them", async () => {
  const { ctx } = holdingThree({ [FIRST]: "merged", [SECOND]: "merged" });
  assert.deepEqual((await briefOf(ctx, THIRD, bodied(LAST_STEP))).closing, { key: "A11-253", word: "closes", open: [], merged: [FIRST, SECOND] });
});

test("A11-274: a sibling the run read merged is merged, and the host is not asked for it", async () => {
  const { ctx, host } = holdingThree({}, { [FIRST]: "merged", [SECOND]: "merged" });
  assert.equal((await briefOf(ctx, THIRD, bodied(LAST_STEP))).closing?.word, "closes", "the run read both merged, whatever the host's seed says");
  assert.deepEqual(host.calls.filter((call) => call.startsWith("readPullState")), [], "a merge is final, so the host is not asked");
});

test("A11-274: a sibling the run read open or closed is read from the host again, since it may have merged or reopened since", async () => {
  const { ctx } = holdingThree({ [FIRST]: "merged", [SECOND]: "open" }, { [FIRST]: "open", [SECOND]: "closed" });
  assert.deepEqual((await briefOf(ctx, THIRD, bodied(LAST_STEP))).closing, { key: "A11-253", word: "refs", open: [SECOND], merged: [FIRST] });
});

test("A11-274: a sibling whose state cannot be read leaves the word out, and the reviewer judges it as before", async () => {
  const { ctx } = holdingThree();
  const unread = { ...ctx, codeHost: { ...ctx.codeHost, readPullState: async (url: string) => (url === SECOND ? null : "MERGED") } } as PoolContext;
  assert.equal("closing" in await briefOf(unread, THIRD, bodied(LAST_STEP)), false);
});

test("A11-274: a pull request no run holds has no word, and neither has a run's only pull request whose body names no step", async () => {
  const { ctx } = holdingThree();
  assert.equal("closing" in await briefOf(ctx, "https://github.com/a11ign/four/pull/1", bodied(LAST_STEP)), false, "one a person opened");
  const alone = { ...ctx, store: { get: () => ({ entries: [{ ticket: { key: "A11-1", description: "" }, review: [{ repo: "a11ign/one", url: FIRST }] }] }) } } as unknown as PoolContext;
  assert.equal("closing" in await briefOf(alone, FIRST, bodied("Closes A11-1\n")), false);
  assert.equal((await briefOf(alone, FIRST, bodied("Refs A11-1\n\nPartial: step 1 of 3\n"))).closing?.word, "refs", "a step that is not the last says Refs, with no sibling");
});

test("A11-274: the word reaches the reviewer the pool starts on a sweep", async () => {
  await loadReviewerGate();
  const fixture = poolFixture({ keys: ["NBF-1"], tickets: { reviewer: "atomic", drafts: false }, now: () => 0 });
  const host = createFakeCodeHost("worker-bot");
  const urls = [1, 2].map((number) => host.seedPull("a11ign/nbl-ui-netbox", number, { head: `h${number}`, body: "Refs NBF-1\n\nPartial: step 1 of 1\n", settled: true, trust: "inside" }).url);
  const reviewer = createFakeReviewer();
  await reviewer.load();
  const queue = fixture.store.get();
  fixture.store.set({ ...queue, entries: [{ ...queue.entries[0], phase: "finished", review: urls.map((url) => ({ repo: "nbl-ui-netbox", url })) }] });
  await fixture.restart({ codeHost: host, reviewer }).reviewNewHeads();
  const told = new Map(reviewer.started.map(({ pr }, at) => [pr, reviewer.briefs[at]?.closing]));
  assert.deepEqual([...told.keys()].sort(), [...urls].sort(), "both heads are started");
  assert.deepEqual(told.get(urls[1]), { key: "NBF-1", word: "refs", open: [urls[0]], merged: [] });
});
