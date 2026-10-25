// no-token: gh -- the sweep over the fake code host: a stack world is seeded in memory, and the arm bot is asked only through the fake's `requestStackMerge`
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost, fakePullUrl } from "../plugins/fakes/code-host.ts";
import type { CodeHost } from "../plugins/contracts/code-host.ts";
import type { Entry, Queue } from "./queue/queue-entries-and-outcomes.ts";
import type { PoolContext } from "./pool-context.ts";
import { retargetStacked } from "./pool-tracker.ts";
import { retargetNote } from "./board-view/pull-status-and-notes.ts";
import { STACK_MERGE_ASK_AGAIN_MS } from "./stack-merge.ts";

const REPOSITORY = "a11ign/agent-org";
const BOTTOM = fakePullUrl(REPOSITORY, 1872);
const ABOVE = fakePullUrl(REPOSITORY, 1873);
const BOTTOM_HEAD = "a".repeat(40);
const ABOVE_HEAD = "b".repeat(40);
const MOVED_HEAD = "c".repeat(40);
const REASON = "a member below has changes requested";

/** What the watch recorded of a pull request that is approved at `head`, with no required check red or running there. */
const ready = (head: string) => ({ head, approved: true, review: "approved" as const, red: [], pending: [] });

/** A finished run with `urls` open, each approved and green at the head the fake holds for it (`heads`), unless `pullHeads` says otherwise. */
function finishedRun(urls: readonly string[], pullHeads: Record<string, ReturnType<typeof ready>>, over: Record<string, unknown> = {}): Entry {
  return ({
    ticket: { key: "A11-198" }, phase: "finished", outcome: { kind: "reviewed", prs: urls.map((url) => ({ repo: "agent-org", url })) },
    pullStates: Object.fromEntries(urls.map((url) => [url, "open"])), pullHeads, ...over,
  }) as unknown as Entry;
}

/**
 * The fake stack of #1872 on `main` with #1873 above it (its base is #1872's branch), both in a stack, a finished run holding both open and ready, and a clock a test moves. `ctx` is the part of the pool's context the sweep reads.
 */
function world(over: { run?: (urls: readonly string[]) => Entry; codeHost?: (host: ReturnType<typeof createFakeCodeHost>) => CodeHost } = {}) {
  const host = createFakeCodeHost();
  host.seedPull(REPOSITORY, 1872, { head: BOTTOM_HEAD });
  host.seedPull(REPOSITORY, 1873, { head: ABOVE_HEAD, base: "a11-198-the-bottom-member" });
  host.stackMerges.facts.set(BOTTOM, { stacked: true });
  host.stackMerges.facts.set(ABOVE, { stacked: true });
  const urls = [BOTTOM, ABOVE];
  const run = over.run?.(urls) ?? finishedRun(urls, { [BOTTOM]: ready(BOTTOM_HEAD), [ABOVE]: ready(ABOVE_HEAD) });
  let queue: Queue = { entries: [run] } as unknown as Queue;
  const clock = { at: 1_000_000 };
  const ctx = { codeHost: over.codeHost?.(host) ?? host, store: { get: () => queue, set: (next: Queue) => { queue = next; } }, now: () => clock.at, stackMergeAsked: new Map() } as unknown as PoolContext;
  const entry = (): Entry => queue.entries[0];
  return { host, ctx, clock, entry, queue: () => queue, sweep: () => retargetStacked(ctx) };
}

const requested = (host: ReturnType<typeof createFakeCodeHost>) => host.stackMerges.requests.map(({ repo, number }) => `${repo}#${number}`);

test("A11-238: a finished run's approved, green, stacked pull request on the default branch is handed to the arm bot, and the one above it in the stack is not", () => {
  const { host, sweep, entry } = world();
  sweep();
  assert.deepEqual(requested(host), [`${REPOSITORY}#1872`], "one request, for the bottom pull request alone");
  assert.equal(entry().retargets, undefined, "and nothing is said on the card");
  assert.ok(!host.calls.some((call) => call.includes(ABOVE) && call.startsWith("requestStackMerge")), "the member above is never named");
});

test("A11-238: the board asks once for a head, not on every sweep, and asks again once the window is over", () => {
  const { host, sweep, clock } = world();
  sweep();
  clock.at += 60_000;
  sweep();
  assert.equal(host.stackMerges.requests.length, 1, "a minute later the arm bot is still on it");
  clock.at += STACK_MERGE_ASK_AGAIN_MS;
  sweep();
  assert.equal(host.stackMerges.requests.length, 2, "the window is over, and the pull request is not settled: ask again");
});

test("A11-238: a pull request that is merged or queued is not asked about", () => {
  const { host, sweep } = world();
  host.stackMerges.facts.set(BOTTOM, { stacked: true, settled: "queued" });
  sweep();
  assert.deepEqual(requested(host), []);
});

test("A11-238: GitHub's refusal shows on the card with its reason, is not asked again at that head, and the board asks again once the head moves", () => {
  const { host, sweep, entry, ctx } = world();
  host.stackMerges.facts.set(BOTTOM, { stacked: true, refusal: { head: BOTTOM_HEAD, reason: REASON } });
  sweep();
  assert.deepEqual(requested(host), [], "no ask at a head GitHub refused");
  const note = `GitHub refused the stack merge of ${BOTTOM}: ${REASON}`;
  assert.deepEqual(entry().retargets, { [BOTTOM]: note }, "the run's per-pull-request note is GitHub's reason");
  assert.equal(retargetNote(entry() as never), note, "and the card shows it");
  // A member below changed and the worker pushed: the head moves, the watch reads the new head ready, and the refusal is stale.
  host.pullAt(BOTTOM)!.head = MOVED_HEAD;
  const run = entry();
  (ctx.store.set as (queue: Queue) => void)({ entries: [{ ...run, pullHeads: { ...run.pullHeads, [BOTTOM]: ready(MOVED_HEAD) } }] } as unknown as Queue);
  sweep();
  assert.deepEqual(requested(host), [`${REPOSITORY}#1872`], "a head the refusal was not given at is asked about");
  assert.equal(entry().retargets, undefined, "and the stale refusal is gone from the card");
});

test("A11-238: a head that moved since the watch read it ready is not asked about until the watch reads the new head", () => {
  const { host, sweep } = world();
  host.pullAt(BOTTOM)!.head = MOVED_HEAD;
  sweep();
  assert.deepEqual(requested(host), [], "the readiness is of the old head");
});

test("A11-238: a pull request that is not ready is not read and not asked about", () => {
  const { host, sweep } = world({ run: (urls) => finishedRun(urls, { [BOTTOM]: { ...ready(BOTTOM_HEAD), review: "none" as never }, [ABOVE]: ready(ABOVE_HEAD) }) });
  sweep();
  assert.deepEqual(requested(host), []);
  assert.ok(!host.calls.includes(`stackMergeFactsOf ${BOTTOM}`), "it is not even read");
});

test("A11-238: a refused hand-back is the pull request's note, and the board hands it back on the next sweep", () => {
  const { host, sweep, entry } = world();
  host.stackMerges.requestRefusal = "Resource not accessible by integration (HTTP 403)";
  sweep();
  assert.deepEqual(entry().retargets, { [BOTTOM]: `The board could not hand ${BOTTOM} to the arm bot: Resource not accessible by integration (HTTP 403)` });
  assert.deepEqual(requested(host), []);
  host.stackMerges.requestRefusal = null;
  sweep();
  assert.deepEqual(requested(host), [`${REPOSITORY}#1872`], "the ask was not remembered, so it is made again at once");
  assert.equal(entry().retargets, undefined, "and the note is cleared");
});

test("A11-238: a run whose pull request is not in a stack gets no request, and no note", () => {
  const { host, sweep, entry, queue } = world();
  host.stackMerges.facts.set(BOTTOM, { stacked: false });
  const before = queue();
  sweep();
  assert.deepEqual(requested(host), []);
  assert.ok(!host.calls.some((call) => call.startsWith("requestStackMerge")), "the arm bot's auto-merge is the only way for a pull request outside a stack");
  assert.equal(entry().retargets, undefined);
  assert.equal(queue(), before, "and the queue is not written");
});

test("A11-238: a pull request the code host cannot read keeps the note it had, and the others are told as before", () => {
  const unreadable = fakePullUrl(REPOSITORY, 1999);
  const kept = `GitHub refused the stack merge of ${unreadable}: ${REASON}`;
  const { host, sweep, entry } = world({
    run: (urls) => finishedRun([...urls, unreadable], { [BOTTOM]: ready(BOTTOM_HEAD), [ABOVE]: ready(ABOVE_HEAD), [unreadable]: ready("d".repeat(40)) }, { retargets: { [unreadable]: kept } }),
  });
  sweep();
  assert.deepEqual(entry().retargets, { [unreadable]: kept }, "the note it had is kept, so the card does not blink");
  assert.deepEqual(requested(host), [`${REPOSITORY}#1872`], "and the pull request that can be read is handed back");
});

test("A11-238: a base note the sweep no longer makes is cleared even when the stack of that pull request cannot be read", () => {
  const unreadable = fakePullUrl(REPOSITORY, 1999);
  const stale = `Needs retarget: ${unreadable} still targets nbf-1-fit, whose pull request merged; retarget failed, and agent-org tries again: gh: HTTP 403`;
  const { entry, sweep } = world({ run: (urls) => finishedRun([...urls, unreadable], { [BOTTOM]: ready(BOTTOM_HEAD), [ABOVE]: ready(ABOVE_HEAD), [unreadable]: ready("d".repeat(40)) }, { retargets: { [unreadable]: stale } }) });
  sweep();
  assert.equal(entry().retargets, undefined, "the retarget succeeded and left no note, and the stack merge does not keep a note it did not write");
});

test("A11-238: a refusal note is the stack merge's to clear, even when the sweep of the bases keeps the previous note of a pull request it cannot read", () => {
  const stale = `GitHub refused the stack merge of ${BOTTOM}: ${REASON}`;
  const { host, entry, sweep } = world({
    run: (urls) => finishedRun(urls, { [BOTTOM]: ready(BOTTOM_HEAD), [ABOVE]: ready(ABOVE_HEAD) }, { retargets: { [BOTTOM]: stale }, blockers: [{ key: "NBF-0", state: "started", status: "In Review", branch: "nbf-1-fit", pulls: {} }] }),
    codeHost: (fake) => ({ ...fake, sweepRetargets: ({ previous }) => ({ ...previous }) }),
  });
  sweep();
  assert.deepEqual(requested(host), [`${REPOSITORY}#1872`], "the refusal is gone from GitHub (the head moved on), so the pull request is handed back");
  assert.equal(entry().retargets, undefined, "and the card does not keep the note");
});

test("A11-238: a note about a pull request's base stands, and its stack merge waits for the base", () => {
  const note = `Needs retarget: ${BOTTOM} still targets nbf-1-fit, whose branch is gone: retarget it by hand`;
  const { host, sweep, entry } = world({
    run: (urls) => finishedRun(urls, { [BOTTOM]: ready(BOTTOM_HEAD), [ABOVE]: ready(ABOVE_HEAD) }, { blockers: [{ key: "NBF-0", state: "started", status: "In Review", branch: "nbf-1-fit", pulls: {} }] }),
    codeHost: (fake) => ({ ...fake, sweepRetargets: () => ({ [BOTTOM]: note }) }),
  });
  sweep();
  assert.deepEqual(entry().retargets, { [BOTTOM]: note }, "the retarget note is the card's");
  assert.deepEqual(requested(host), [], "and the pull request is not handed to the arm bot");
  assert.ok(!host.calls.includes(`stackMergeFactsOf ${BOTTOM}`), "its stack is not even read");
});

test("A11-238: a base the sweep retargeted this pass does not leave the pull request out of the stack merge", () => {
  const { host, sweep, entry } = world({
    run: (urls) => finishedRun(urls, { [BOTTOM]: ready(BOTTOM_HEAD), [ABOVE]: ready(ABOVE_HEAD) }, { blockers: [{ key: "NBF-0", state: "started", status: "In Review", branch: "nbf-1-fit", pulls: {} }] }),
  });
  host.pullAt(BOTTOM)!.base = "nbf-1-fit";
  host.seedPull(REPOSITORY, 1865, { head: "nbf-1-fit", state: "merged" });
  sweep();
  assert.deepEqual(host.retargets, [{ url: BOTTOM, base: "main" }], "its base merged, so the sweep moved it to the default branch");
  assert.equal(entry().retargets, undefined, "nothing needs saying about the base");
  assert.deepEqual(requested(host), [`${REPOSITORY}#1872`], "and, based on the default branch now, it is handed to the arm bot in the same pass");
});

test("A11-238: a code host without the stack merge asks the arm bot for nothing, and the sweep still records the notes of the bases", () => {
  const { host, sweep, entry } = world({ codeHost: (fake) => ({ ...fake, stackMergeFactsOf: undefined, requestStackMerge: undefined }) });
  sweep();
  assert.deepEqual(requested(host), []);
  assert.equal(entry().retargets, undefined);
});

test("A11-238: a run that is not finished, or that holds no open pull request, is not read", () => {
  const { host, sweep } = world({ run: (urls) => finishedRun(urls, { [BOTTOM]: ready(BOTTOM_HEAD), [ABOVE]: ready(ABOVE_HEAD) }, { phase: "running" }) });
  sweep();
  assert.deepEqual(host.calls, [], "the code host is not asked");
  const merged = world({ run: (urls) => finishedRun(urls, {}, { pullStates: Object.fromEntries(urls.map((url) => [url, "merged"])) }) });
  merged.sweep();
  assert.deepEqual(merged.host.calls, []);
});
