// no-token: gh -- the code host, the reviewer, herdr and the clock are all injected fakes; nothing is spawned
// module: a reviewer stopped on a dialog it cannot answer reaches the board as Needs you (A11-221)
//
// Built on `pool-fixture.ts`: a pool over the in-memory code host and reviewer, with the one run NBF-1 finished and holding the pull request. The reviewer is started for the head and then shows a dialog (`showing`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import type { Reviewer } from "../plugins/contracts/reviewer.ts";
import { createFakeReviewer, reviewerOver } from "../plugins/fakes/reviewer.ts";
import { runStatus } from "./board-view/pull-status-and-notes.ts";
import { reasonOf } from "./board-view/run-reason.ts";
import { poolFixture } from "./pool-fixture.ts";
import type { Outcome } from "./queue/queue-entries-and-outcomes.ts";
import { loadReviewerGate, REVIEWER_LOGIN } from "./reviewer-port.ts";

const REPO = "a11ign/nbl-ui-netbox";
const HEAD = "h1";
const STUCK = "Trust this folder? Codex can read, edit, and run files here. Trusting will apply to the repository root: /srv/stranger";
const NOW = 1_000_000;
const NOTE = `the reviewer of ${REPO} #1 stopped on a dialog it cannot answer: "${STUCK}": a person answers it in herdr`;

/** A finished run NBF-1 holding pull request 1 of `REPO`, over a pool whose reviewer is `reviewerOf`'s: the fixture, the code host and the pull request's url. */
function finishedRun(reviewerOf: Reviewer) {
  const fixture = poolFixture({ keys: ["NBF-1"], tickets: { reviewer: "atomic", drafts: false }, now: () => NOW });
  const host = createFakeCodeHost("worker-bot");
  const { url } = host.seedPull(REPO, 1, { head: HEAD, settled: true, trust: "inside" });
  const queue = fixture.store.get();
  const outcome = { kind: "ready-pr", prs: [{ repo: "nbl-ui-netbox", url }] } as Outcome;
  fixture.store.set({ ...queue, entries: [{ ...queue.entries[0], phase: "finished", finishedAt: NOW / 2, outcome }] });
  return { fixture, host, url, pool: fixture.restart({ codeHost: host, reviewer: reviewerOf }) };
}

/** The run with the fake reviewer, which the first sweep started for `HEAD`. */
async function reviewedRun() {
  await loadReviewerGate();
  const reviewer = createFakeReviewer();
  await reviewer.load();
  const { fixture, host, url, pool } = finishedRun(reviewer);
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1, "the first sweep starts the reviewer");
  return { fixture, host, reviewer, pool, ref: { pr: url, head: HEAD }, url, entry: () => fixture.store.get().entries[0] };
}

/** The reviewer shows the dialog the port cannot answer, the pool looks at it and watches the run, and the run carries the note. */
function stopAndWatch({ reviewer, pool, ref, entry }: Pick<Awaited<ReturnType<typeof reviewedRun>>, "reviewer" | "pool" | "ref" | "entry">): void {
  reviewer.showing(ref, { stuck: STUCK });
  pool.reviewNewHeads();
  pool.watchFeedback();
  assert.equal(entry().handedBack, NOTE);
}

test("A11-221: a reviewer stuck on a dialog the port cannot answer makes the run read Needs you with the dialog's first line, and the pull request's review line says it", async () => {
  const { reviewer, pool, ref, url, entry } = await reviewedRun();
  assert.equal(pool.pullReviews()[url], "reviewing");
  reviewer.showing(ref, { stuck: STUCK });
  pool.reviewNewHeads();
  assert.equal(pool.pullReviews()[url], `the reviewer stopped on a dialog it cannot answer: "${STUCK}"`);
  pool.watchFeedback();
  assert.equal(entry().handedBack, NOTE);
  assert.equal(runStatus(entry() as never), "needs-you");
  assert.equal(reasonOf(entry() as never).line, NOTE);
  const written = JSON.stringify(entry());
  pool.reviewNewHeads();
  pool.watchFeedback();
  assert.equal(JSON.stringify(entry()), written, "a later look at the same dialog rewrites nothing");
});

test("A11-221: the next look that finds no dialog clears the line and the note, and leaves the reviewer open", async () => {
  const made = await reviewedRun();
  const { reviewer, pool, ref, url, entry } = made;
  stopAndWatch(made);
  reviewer.showing(ref, null);
  pool.reviewNewHeads();
  assert.equal(pool.pullReviews()[url], "reviewing");
  pool.watchFeedback();
  assert.equal(entry().handedBack, undefined);
  assert.equal(runStatus(entry() as never), "awaiting-review");
  assert.deepEqual([reviewer.closed, reviewer.retired], [[], []], "nothing was closed: a person answers the dialog in herdr");
});

test("A11-221: a pull request the pool cannot read leaves the note where it was, and the next look that reads it finds the dialog gone", async () => {
  const made = await reviewedRun();
  const { fixture, host, reviewer, pool, ref, entry } = made;
  stopAndWatch(made);
  const unreadable = fixture.restart({ codeHost: { ...host, readReviewState: () => null }, reviewer });
  unreadable.watchFeedback();
  assert.equal(entry().handedBack, NOTE, "a pool that has read nothing does not clear it");
  reviewer.showing(ref, null);
  const readable = fixture.restart({ codeHost: host, reviewer });
  readable.reviewNewHeads();
  readable.watchFeedback();
  assert.equal(entry().handedBack, undefined);
});

test("A11-221: the note goes when the pull request is merged, since no reviewer waits on it any more", async () => {
  const made = await reviewedRun();
  const { fixture, pool, reviewer, ref, url, entry } = made;
  stopAndWatch(made);
  fixture.store.set({ ...fixture.store.get(), entries: [{ ...entry(), pullStates: { [url]: "merged" } }] });
  pool.watchFeedback();
  assert.equal(entry().handedBack, undefined);
});

test("A11-221: a re-reviewing reviewer, whose head already has the reviewer's block, is looked at too", async () => {
  const { host, reviewer, pool, ref, url } = await reviewedRun();
  host.pullAt(url)!.reviews = [{ author: REVIEWER_LOGIN, state: "CHANGES_REQUESTED", commit: HEAD, at: 400_000 }];
  host.pullAt(url)!.body = "Closes NBF-1\n";
  reviewer.wrote(ref, null);
  pool.reviewNewHeads();
  host.pullAt(url)!.body = "Closes NBF-1\n\nOutside-Region: none\n";
  reviewer.showing(ref, { stuck: STUCK });
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 2, "the edit started a re-review");
  assert.equal(pool.pullReviews()[url], `the reviewer stopped on a dialog it cannot answer: "${STUCK}"`);
});

test("A11-221: with no reviewer on the machine the note goes, since no look is coming to clear it", async () => {
  const made = await reviewedRun();
  const { fixture, host, pool, reviewer, ref, entry } = made;
  stopAndWatch(made);
  fixture.restart({ codeHost: host }).watchFeedback();
  assert.equal(entry().handedBack, undefined);
});

test("A11-221: a dialog the port answered is not Needs you: nothing is kept on the pull request or the run", async () => {
  const { reviewer, pool, ref, url, entry } = await reviewedRun();
  reviewer.showing(ref, { answered: "Trust this folder?" });
  pool.reviewNewHeads();
  pool.watchFeedback();
  assert.equal(pool.pullReviews()[url], "reviewing");
  assert.equal(entry().handedBack, undefined);
});

test("A11-221: a reviewer of contract 1.5, which has no unblock, never reports a dialog", async () => {
  await loadReviewerGate();
  const fake = createFakeReviewer();
  const { unblock: _unblock, ...without } = fake;
  const { pool, url } = finishedRun(reviewerOver(without));
  pool.reviewNewHeads();
  pool.reviewNewHeads();
  assert.equal(pool.pullReviews()[url], "reviewing");
  assert.equal(fake.unblocked.length, 0);
});

test("A11-221: a head with a review posted on it has its reviewer's pane left unread", async () => {
  const { host, reviewer, pool, ref, url } = await reviewedRun();
  host.pullAt(url)!.reviews = [{ author: REVIEWER_LOGIN, state: "APPROVED", commit: HEAD, at: 600_000 }];
  reviewer.showing(ref, { stuck: STUCK });
  const before = reviewer.unblocked.length;
  pool.reviewNewHeads();
  assert.equal(reviewer.unblocked.length, before, "no look once the verdict is on the pull request");
});
