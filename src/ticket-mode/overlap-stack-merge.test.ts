// no-token: gh -- A11-374: approved, overlapping pull requests are enqueued one at a time, over the fake code host
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost, fakePullUrl } from "../plugins/fakes/code-host.ts";
import type { Entry, Queue } from "./queue/queue-entries-and-outcomes.ts";
import type { PoolContext } from "./pool-context.ts";
import { retargetStacked } from "./pool-tracker.ts";

const REPO = "agent-org";
const SLUG = `a11ign/${REPO}`;
const pullOf = (number: number): string => fakePullUrl(SLUG, number);

/** A finished run with one open pull request, which changes `files`. */
const finishedWith = (key: string, number: number, files: readonly string[], over: Record<string, unknown> = {}): Entry => ({
  ticket: { key, title: key, description: "", url: `https://linear.app/a11ign/issue/${key}`, branch: `admin/${key.toLowerCase()}` }, repos: [], model: "opus", effort: "high", phase: "finished", queuedAt: 1, finishedAt: 5, projectRepo: REPO,
  outcome: { kind: "ready-pr", prs: [{ repo: REPO, url: pullOf(number) }] }, pullStates: { [pullOf(number)]: "open" }, pullFiles: { [pullOf(number)]: files }, ...over }) as unknown as Entry;

const queueOf = (...entries: Entry[]): Queue => ({ entries, max: 6, paused: false }) as unknown as Queue;

/** The fake host's world for the approved, overlapping pull requests: #11 on `main`, #12 above it on its branch, both approved and green. */
function world() {
  const host = createFakeCodeHost();
  host.seedPull(SLUG, 11, { head: "a".repeat(40) });
  host.seedPull(SLUG, 12, { head: "b".repeat(40), base: "admin/a11-1" });
  host.stackMerges.facts.set(pullOf(11), { stacked: true });
  host.stackMerges.facts.set(pullOf(12), { stacked: true });
  const ready = (head: string) => ({ head, approved: true, review: "approved" as const, red: [], pending: [] });
  const below = finishedWith("A11-1", 11, ["src/a.ts"], { pullHeads: { [pullOf(11)]: ready("a".repeat(40)) } });
  const above = finishedWith("A11-2", 12, ["src/a.ts"], { pullHeads: { [pullOf(12)]: ready("b".repeat(40)) },
    overlapStack: { key: "A11-1", repo: REPO, branch: "admin/a11-1", head: null, url: pullOf(11), shared: "src/a.ts", others: [] } });
  let queue = queueOf(below, above);
  const ctx = { codeHost: host, store: { get: () => queue, set: (next: Queue) => { queue = next; } }, now: () => 1_000_000, stackMergeAsked: new Map() } as unknown as PoolContext;
  return { host, ctx, queue: () => queue, merge: () => { queue = { ...queue, entries: queue.entries.map((entry) => (entry.ticket.key === "A11-1" ? { ...entry, pullStates: { [pullOf(11)]: "merged" } } : entry)) } as Queue; } };
}

test("A11-374: approved, overlapping pull requests are enqueued one at a time, bottom first, and the upper is moved onto main once the lower has merged", async () => {
  const { host, ctx, merge } = world();
  await retargetStacked(ctx);
  assert.deepEqual(host.stackMerges.requests.map(({ number }) => number), [11], "only the bottom pull request is handed to the arm bot");
  assert.deepEqual(host.retargets, [], "and the upper keeps its base while the lower is open");
  merge();
  host.seedPull(SLUG, 11, { head: "admin/a11-1", state: "merged" });
  await retargetStacked(ctx);
  assert.deepEqual(host.retargets, [{ url: pullOf(12), base: "main" }], "once the lower has merged the upper is based on main, where its restack follows");
});
