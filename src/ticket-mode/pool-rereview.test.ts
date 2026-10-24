// no-token: gh -- the code host, the reviewer, herdr and the clock are all injected fakes; nothing is spawned
// module: a finding answered without a commit is re-reviewed on the same head (A11-235) -- the sweep over a blocked head whose pull request description changed, or that a reply answered
//
// Built on `pool-fixture.ts`: a pool over the in-memory code host and reviewer, with the one run NBF-1 finished and holding the pull request. The reviewer reviews the head once, blocks it, and the worker
// answers by editing the description (or replying) and ends its round, as a worker does on a finding that is a missing line of the description. Nothing here pushes a commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeReviewer } from "../plugins/fakes/reviewer.ts";
import { poolFixture } from "./pool-fixture.ts";
import type { Outcome } from "./queue/queue-entries-and-outcomes.ts";
import { MAX_FEEDBACK_ROUNDS } from "./queue/queue-transitions.ts";
import { loadReviewerGate, noReviewerMemory, readReviewerMemory, REVIEWER_LOGIN, reviewerMemoryPath, writeReviewerMemory } from "./reviewer-port.ts";

const REPO = "a11ign/nbl-ui-netbox";
const HEAD = "h1";
const MINUTE = 60_000;
const BODY = "Closes NBF-1\n\n## Outside-Region\n\nnone\n";
const FIXED = `${BODY}Outside-Region: src/a.ts — the type moved with it\n`;

/** The clock of a test, in milliseconds: every look is stamped with it, so a reply is new only when it is posted after the head was last looked at. */
const clock = { ms: 0 };

/** A finished run NBF-1 that holds pull request 1 of `REPO`, over a code host that has the reviewer's first look at `HEAD` behind it: the reviewer started, ended and blocked. */
async function blockedRun({ held = true, rounds = 0 }: { held?: boolean; rounds?: number } = {}) {
  await loadReviewerGate();
  clock.ms = 10 * MINUTE;
  const fixture = poolFixture({ keys: ["NBF-1"], tickets: { reviewer: "atomic", drafts: false }, now: () => clock.ms });
  const host = createFakeCodeHost("worker-bot");
  const { url } = host.seedPull(REPO, 1, { head: HEAD, body: BODY, settled: true, trust: "inside" });
  const reviewer = createFakeReviewer();
  await reviewer.load();
  const queue = fixture.store.get();
  const outcome = { kind: "ready-pr", prs: [{ repo: "nbl-ui-netbox", url }] } as Outcome;
  fixture.store.set({ ...queue, entries: [{ ...queue.entries[0], phase: "finished", rounds, ...(held ? { outcome } : {}) }] });
  const pool = fixture.restart({ codeHost: host, reviewer });
  const pull = host.pullAt(url)!;
  const ref = { pr: url, head: HEAD };
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1, "the first review of the head starts");
  reviewer.wrote(ref, null);
  clock.ms = 20 * MINUTE;
  pull.reviews = [{ author: REVIEWER_LOGIN, state: "CHANGES_REQUESTED", commit: HEAD, at: clock.ms }];
  pool.reviewNewHeads();
  assert.equal(reviewer.closed.length, 1, "and the reviewer closes once it has posted its block");
  clock.ms = 30 * MINUTE;
  const reply = (text: string, minute: number) => { pull.replies = [...pull.replies, { author: "worker-bot", at: minute * MINUTE, url: `${url}#c${minute}`, text }]; };
  const entry = () => fixture.store.get().entries[0];
  /** The reviewer of a re-review ends having posted nothing, as the door refuses a second `not convinced` at an equal patch. */
  const settleRereview = () => { reviewer.wrote(ref, null); pool.reviewNewHeads(); };
  return { fixture, host, reviewer, pool, pull, url, ref, reply, entry, settleRereview };
}

test("A11-235: a body-only fix starts a re-review on the same head, with the description's changed lines in its brief and no replies, and it counts as one of the run's rounds", async () => {
  const { reviewer, pool, pull, url, entry } = await blockedRun();
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1, "a block nobody answered starts nothing");
  pull.body = FIXED;
  pool.reviewNewHeads();
  assert.deepEqual(reviewer.started, [{ pr: url, head: HEAD }, { pr: url, head: HEAD }], "the second start is for the same head: no commit");
  assert.deepEqual(reviewer.briefs[1]?.rereview, { replies: [], body: [{ kind: "added", text: "Outside-Region: src/a.ts — the type moved with it" }] }, "told what changed: the added line, and no reply");
  assert.equal(entry().rounds, 1, "counted in the round cap");
  assert.equal(pull.head, HEAD, "and the head did not move");
});

test("A11-235: a body fix that also removes lines tells the reviewer which lines are gone and which are new, and a reply posted with it is quoted beside them", async () => {
  const { reviewer, pool, pull, reply } = await blockedRun();
  pull.body = "Closes NBF-1\n\n## Outside-Region\n\nsrc/a.ts — the type moved with it\n";
  reply("Fixed in the description.", 25);
  pool.reviewNewHeads();
  assert.deepEqual(reviewer.briefs[1]?.rereview?.body, [{ kind: "removed", text: "none" }, { kind: "added", text: "src/a.ts — the type moved with it" }]);
  assert.deepEqual(reviewer.briefs[1]?.rereview?.replies.map(({ text }) => text), ["Fixed in the description."]);
});

test("A11-235: a reply with no change and no body edit starts one re-review and does not loop, before or after a restart", async () => {
  const { fixture, host, reviewer, pool, reply, entry, settleRereview } = await blockedRun();
  reply("This is not a defect in this diff.", 25);
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 2, "the reply starts one re-review");
  assert.equal(reviewer.briefs[1]?.rereview?.body, undefined, "with no description lines to tell: the body did not change");
  settleRereview();
  for (let sweep = 0; sweep < 3; sweep += 1) {
    clock.ms += 10 * MINUTE;
    pool.reviewNewHeads();
  }
  fixture.restart({ codeHost: host, reviewer }).reviewNewHeads();
  assert.equal(reviewer.started.length, 2, "the same reply, the same body and the standing block start nothing more");
  assert.equal(entry().rounds, 1, "and the run was charged for the one");
});

test("A11-235: a description edit that only changes spacing is no answer", async () => {
  const { reviewer, pool, pull } = await blockedRun();
  pull.body = `${BODY}\n\n   \n`.replace("none", "none  ");
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 1);
});

test("A11-235: the cap holds: each re-review is a round, a run with none left is handed to a person and starts no reviewer, and a run below the cap is re-reviewed again by a second edit", async () => {
  const { reviewer, pool, pull, entry, settleRereview } = await blockedRun({ rounds: MAX_FEEDBACK_ROUNDS - 2 });
  const edit = (n: number) => { pull.body = `${BODY}Outside-Region: edit ${n}\n`; clock.ms += 10 * MINUTE; };
  edit(1);
  pool.reviewNewHeads();
  settleRereview();
  edit(2);
  pool.reviewNewHeads();
  settleRereview();
  assert.deepEqual([reviewer.started.length, entry().rounds, entry().handedBack], [3, MAX_FEEDBACK_ROUNDS, undefined], "two answered edits are two re-reviews, and use the last round");
  edit(3);
  pool.reviewNewHeads();
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 3, "a third edit starts no reviewer");
  assert.equal(entry().rounds, MAX_FEEDBACK_ROUNDS, "and counts no round");
  assert.match(entry().handedBack ?? "", /^The pull requests keep getting feedback: the board answered 3 rounds on its own and stopped\. Respond to review starts another\. The latest: a11ign-reviewer's block on .*pull\/1 at h1 was answered by editing the description/);
});

test("A11-235: a run that is still in its round is not re-reviewed until the round has ended, and a pull request no run holds has no round to wait for and no cap", async () => {
  const mid = await blockedRun();
  mid.fixture.store.set({ ...mid.fixture.store.get(), entries: [{ ...mid.entry(), phase: "running" }] });
  mid.pull.body = FIXED;
  mid.pool.reviewNewHeads();
  assert.equal(mid.reviewer.started.length, 1, "the worker may still be editing the description");
  mid.fixture.store.set({ ...mid.fixture.store.get(), entries: [{ ...mid.entry(), phase: "finished" }] });
  mid.pool.reviewNewHeads();
  assert.equal(mid.reviewer.started.length, 2, "and the round's end releases it");
  const orphan = await blockedRun({ held: false, rounds: MAX_FEEDBACK_ROUNDS });
  orphan.pull.body = FIXED;
  orphan.pool.reviewNewHeads();
  assert.equal(orphan.reviewer.started.length, 2, "a pull request a person opened is re-reviewed whatever rounds a run of the board has had");
  assert.equal(orphan.entry().handedBack, undefined);
});

test("A11-235: a refused re-review start is asked again on the next sweep against the same old body, and is charged one round when it starts", async () => {
  const { reviewer, pool, pull, entry } = await blockedRun();
  pull.body = FIXED;
  reviewer.refuseWith("another instance holds the review");
  pool.reviewNewHeads();
  pool.reviewNewHeads();
  assert.deepEqual([reviewer.started.length, entry().rounds ?? 0], [1, 0], "nothing started, nothing charged");
  reviewer.refuseWith(null);
  pool.reviewNewHeads();
  assert.deepEqual([reviewer.started.length, entry().rounds], [2, 1], "the description change was not forgotten by the refusal");
  assert.deepEqual(reviewer.briefs[1]?.rereview?.body, [{ kind: "added", text: "Outside-Region: src/a.ts — the type moved with it" }]);
});

test("A11-235: the look survives a restart, so a body change is found by a pool that did not start the first review; a head re-reviewed before looks were kept is never re-reviewed again", async () => {
  const { fixture, host, reviewer, pull, url } = await blockedRun();
  const path = reviewerMemoryPath(fixture.settings.stateDir);
  assert.equal(readReviewerMemory(path).memory.looks.get(`${url}@${HEAD}`)?.body, BODY, "the body the first review saw is on disk");
  pull.body = FIXED;
  fixture.restart({ codeHost: host, reviewer }).reviewNewHeads();
  assert.equal(reviewer.started.length, 2);
  const legacy = await blockedRun();
  const legacyPath = reviewerMemoryPath(legacy.fixture.settings.stateDir);
  const { memory } = readReviewerMemory(legacyPath);
  memory.looks.clear();
  memory.rereviewed.add(`${legacy.url}@${HEAD}`);
  writeReviewerMemory(legacyPath, { ...noReviewerMemory(), started: memory.started, rereviewed: memory.rereviewed });
  legacy.pull.body = FIXED;
  legacy.reply("a reply", 25);
  legacy.fixture.restart({ codeHost: legacy.host, reviewer: legacy.reviewer }).reviewNewHeads();
  assert.equal(legacy.reviewer.started.length, 1, "no look to compare with, and its one re-review by reply already spent");
});

test("A11-235: a new head is a first review with no description lines in its brief, and a merged pull request's look is forgotten", async () => {
  const { fixture, reviewer, pool, pull } = await blockedRun();
  pull.head = "h2";
  pull.reviews = [];
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 2);
  assert.equal(reviewer.briefs[1]?.rereview, undefined, "a first review, not a re-review");
  pull.state = "merged";
  pool.releaseReviewers();
  assert.deepEqual([...readReviewerMemory(reviewerMemoryPath(fixture.settings.stateDir)).memory.looks.keys()], [], "the looks of the pull request are dropped with it");
});
