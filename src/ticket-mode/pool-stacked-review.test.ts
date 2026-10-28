// no-token: gh -- the code host, the reviewer, herdr and the clock are all injected fakes; nothing is spawned
// module: a stacked pull request is reviewed once its own checks are green, and keeps its review when it is retargeted to main (A11-370)
//
// Built on `pool-fixture.ts`. The reviewer starts when a head's required checks have settled green and no review is on it: nothing in that rule reads the pull request's BASE, so what kept agent-org#1984 (stacked on #1982) unreviewed was that
// `ci.yml` never ran on it (`ci-stacked-triggers.test.ts`). These tests hold the rest of the claim: a green head on a stacked base is started, and the retarget the board makes when the base merges changes the base and not the head, so the review stands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeReviewer } from "../plugins/fakes/reviewer.ts";
import { poolFixture } from "./pool-fixture.ts";
import type { Outcome } from "./queue/queue-entries-and-outcomes.ts";
import { loadReviewerGate, REVIEWER_LOGIN } from "./reviewer-port.ts";

const REPO = "a11ign/nbl-ui-netbox";
const HEAD = "h1";
const STACK_BASE = "admin/a11-363-health-figures";

/** A finished run NBF-1 holding pull request 1 of `REPO`, whose base is `base`, with checks `settled` or not. */
async function stackedRun({ base = STACK_BASE, settled = true }: { base?: string; settled?: boolean } = {}) {
  await loadReviewerGate();
  const fixture = poolFixture({ keys: ["NBF-1"], tickets: { reviewer: "atomic", drafts: false }, now: () => 10 * 60_000 });
  const host = createFakeCodeHost("worker-bot");
  const { url } = host.seedPull(REPO, 1, { head: HEAD, base, body: "Closes NBF-1\n", settled, trust: "inside" });
  const reviewer = createFakeReviewer();
  await reviewer.load();
  const queue = fixture.store.get();
  const outcome = { kind: "ready-pr", prs: [{ repo: "nbl-ui-netbox", url }] } as Outcome;
  fixture.store.set({ ...queue, entries: [{ ...queue.entries[0], phase: "finished", finishedAt: 15 * 60_000, outcome }] });
  const pool = fixture.restart({ codeHost: host, reviewer });
  return { host, reviewer, pool, pull: host.pullAt(url)!, url };
}

test("A11-370: a pull request stacked on another branch is reviewed once its own checks are green, as one based on main is", async () => {
  const { reviewer, pool } = await stackedRun();
  await pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1, "the green head of a pull request whose base is another branch gets its reviewer");
});

test("A11-370: a stacked pull request whose checks have not settled is not reviewed yet, and is once they do", async () => {
  const { reviewer, pool, pull } = await stackedRun({ settled: false });
  await pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 0, "a head with no green checks waits, whatever its base");
  pull.settled = true;
  await pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1);
});

test("A11-370: retargeting a reviewed stacked pull request to main keeps its review: the head is the same, and no second reviewer starts", async () => {
  const { host, reviewer, pool, pull, url } = await stackedRun();
  await pool.reviewNewHeads();
  reviewer.wrote({ pr: url, head: HEAD }, null);
  pull.reviews = [{ author: REVIEWER_LOGIN, state: "APPROVED", commit: HEAD, at: 20 * 60_000 }];
  await pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1);
  // The board moves the base when the one below merges (A11-106, A11-248's restack): the base changes, the head does not.
  pull.base = "main";
  // The retarget is an `edited` event, which now starts ci.yml on the same head: its checks run again while the review stands.
  pull.settled = false;
  assert.equal(host.pullAt(url)?.head, HEAD);
  await pool.reviewNewHeads();
  await pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1, "the review at the head stands after the retarget, so nothing is reviewed again");
  assert.equal(pull.reviews.filter((review) => review.state === "APPROVED" && review.commit === HEAD).length, 1);
});
