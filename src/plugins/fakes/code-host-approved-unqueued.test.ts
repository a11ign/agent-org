// no-token: none -- the fake acts on a world held in memory; nothing here reaches GitHub
/**
 * A11-160 (step 9, part B): THE FAKE CODE HOST'S READS FOR THE DAILY APPROVED-UNQUEUED READING. Core's tests of the reading seed the world's pull requests with their reviews and queue entries; these cases hold what
 * they rely on: the reviews of one pull request in the REST list's spelling, and the window of merged pull requests newest-updated first with the reviews in the GraphQL window's spelling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "./code-host.ts";
import type { FakeRowPull } from "./code-host-rows.ts";

const refused = (): string => {
  throw new Error("the fake acts on its own state: no run is made");
};
const pull = (number: number, over: Partial<FakeRowPull> = {}): FakeRowPull => ({ number, body: "", headRefName: `agent/p${number}`, labels: [], isDraft: false, armed: false, merged: false, mergedAt: null, createdAt: "2026-10-11T08:00:00Z", comments: [], ...over });

test("the reviews of a pull request are listed as the REST read spells them, and a pull request the world does not hold is refused", () => {
  const host = createFakeCodeHost();
  host.rowsWorld.pulls.set(7, pull(7, { reviews: [{ state: "APPROVED", submittedAt: "2026-10-11T09:00:00Z" }] }));
  host.rowsWorld.pulls.set(8, pull(8));
  assert.deepEqual(host.rows!.reviewsOf({ repo: "o/r", number: 7, run: refused }), [{ state: "APPROVED", submitted_at: "2026-10-11T09:00:00Z" }]);
  assert.deepEqual(host.rows!.reviewsOf({ repo: "o/r", number: 8, run: refused }), [], "a pull request with no review has none");
  assert.throws(() => host.rows!.reviewsOf({ repo: "o/r", number: 9, run: refused }), /no pull request #9/);
});

test("the merged window holds merged pull requests only, most recently updated first, cut to the window, with their reviews and queue entries", () => {
  const host = createFakeCodeHost();
  const { pulls } = host.rowsWorld;
  const review = { state: "APPROVED", submittedAt: "2026-10-11T08:40:00Z" };
  pulls.set(1, pull(1, { merged: true, mergedAt: "2026-10-11T09:00:00Z", reviews: [review], queuedAt: ["2026-10-11T08:43:00Z"] }));
  pulls.set(2, pull(2, { merged: true, mergedAt: "2026-10-11T07:00:00Z", updatedAt: "2026-10-11T10:00:00Z" }));
  pulls.set(3, pull(3));
  pulls.set(4, pull(4, { merged: true, mergedAt: "2026-10-10T07:00:00Z" }));
  const window = host.rows!.mergedWindowOf({ repo: "o/r", window: 2, run: refused }) as { number: number; mergedAt: string; reviews: unknown[]; queuedAt: string[] }[];
  assert.deepEqual(window.map((node) => node.number), [2, 1], "an update after the merge puts it first; an open pull request is not in it; the window cuts the oldest");
  assert.deepEqual(window[1], { number: 1, mergedAt: "2026-10-11T09:00:00Z", reviews: [review], queuedAt: ["2026-10-11T08:43:00Z"] });
  assert.deepEqual([window[0].reviews, window[0].queuedAt], [[], []]);
});
