// no-token: gh -- the code host, the reviewer, herdr and the clock are all injected fakes; nothing is spawned
// module: a re-review that the verdict door refuses is never lost (A11-290) -- its verdict and reasons are in the run's log and on the pull request
import { test } from "node:test";
import assert from "node:assert/strict";
import { verdictAtHead, verdictBearers } from "../review-verdict.ts";
import { logOf } from "./queue/run-log.ts";
import { clock, HEAD, MINUTE, refusedFile, standoffRun } from "./pool-standoff-fixture.ts";

const REASONS = "The 200 KB limit is still exceeded: `dist/app.js` is 340 KB.";

test("A11-290: a re-review the door refused is logged as 'rereview: still not convinced' with the reasons, and commented on the pull request", async () => {
  const { fixture, host, reviewer, url, startRereview, refuseRereview } = await standoffRun();
  startRereview("The 200 KB limit cannot be met: the plan's own entry point is 300 KB.");
  assert.equal(reviewer.started.length, 2, "the reply started the re-review of the same head");
  refuseRereview();
  const rereviews = logOf(fixture.store.get(), "NBF-1").filter((event) => event.kind === "rereview");
  assert.equal(rereviews.length, 1);
  const [event] = rereviews;
  assert.ok(event.kind === "rereview" && event.verdict === "not-convinced" && event.url === url && event.head === HEAD && event.reasons.includes(REASONS), "the verdict and the reasons are on the run");
  assert.equal(host.comments.posted.length, 1, "and on the pull request");
  assert.equal(host.comments.posted[0].url, url);
  assert.match(host.comments.posted[0].comment, /^rereview: still not convinced at `h1`\n/);
  assert.ok(host.comments.posted[0].comment.includes(REASONS), "the comment carries the reasons as the re-reviewer wrote them");
});

test("A11-290: the result is recorded once, however many sweeps follow, and the board's own comment starts no re-review and is no verdict", async () => {
  const { host, reviewer, pool, pull, url, startRereview, refuseRereview } = await standoffRun();
  startRereview("Not a defect in this diff.");
  refuseRereview();
  for (let sweep = 0; sweep < 3; sweep += 1) {
    clock.ms += 10 * MINUTE;
    pool.reviewNewHeads();
  }
  assert.equal(host.comments.posted.length, 1, "one comment for one re-review");
  // The host now shows the comment as a reply of the board's own account, which starts a re-review for any other text.
  pull.replies = [...pull.replies, { author: "worker-bot", at: clock.ms, url: `${url}#c`, text: host.comments.posted[0].comment }];
  pool.reviewNewHeads();
  assert.equal(reviewer.started.length, 2, "the record answers nothing");
  const bearers = verdictBearers({ comments: [{ body: host.comments.posted[0].comment, createdAt: "2026-10-26T10:00:00Z", author: { login: "worker-bot" } }], reviews: [] });
  assert.equal(verdictAtHead({ comments: bearers, head: HEAD }).verdict, null, "and the gate reads it as no verdict");
});

test("A11-290: a re-review whose reviewer is still working, wrote nothing since it began, or wrote no file records nothing", async () => {
  const { fixture, host, reviewer, pool, ref, startRereview, refuseRereview } = await standoffRun();
  startRereview("Not a defect in this diff.");
  pool.reviewNewHeads();
  assert.equal(logOf(fixture.store.get(), "NBF-1").filter((event) => event.kind === "rereview").length, 0, "the reviewer is still working");
  refuseRereview(null);
  assert.equal(logOf(fixture.store.get(), "NBF-1").filter((event) => event.kind === "rereview").length, 0, "it ended with no file: nothing to record, and the reprompt path is the first review's");
  assert.equal(host.comments.posted.length, 0);
  assert.equal(reviewer.started.length, 2);
  assert.equal(ref.head, HEAD);
});

test("A11-290: an approval the door refused is recorded too, with no stand-off, so a lost approval is visible", async () => {
  const { fixture, host, startRereview, refuseRereview, entry } = await standoffRun();
  startRereview("Fixed: the limit is now 400 KB, by the planner's amendment.");
  refuseRereview(refusedFile("convinced", "The amended limit is met."));
  const [event] = logOf(fixture.store.get(), "NBF-1").filter((each) => each.kind === "rereview");
  assert.ok(event.kind === "rereview" && event.verdict === "convinced");
  assert.match(host.comments.posted[0].comment, /^rereview: convinced, but the verdict door refused it at `h1`/);
  assert.equal(entry().standoff, undefined, "an approval is no stand-off");
});

test("A11-290: the stand-off opens on the run with the review it answered, the reply and the re-review; a host that cannot comment still gets the log", async () => {
  const { fixture, host, startRereview, refuseRereview, entry } = await standoffRun();
  delete (host as { commentOnPull?: unknown }).commentOnPull;
  startRereview("Disputes a decision: the plan says 200 KB.");
  refuseRereview();
  assert.deepEqual({ ...entry().standoff }, {
    url: entry().standoff!.url, head: HEAD, review: "The bundle is over the plan's 200 KB limit.", reasons: refusedFile("not convinced"), reply: "Disputes a decision: the plan says 200 KB.", decisions: null, stage: "open",
  });
  assert.equal(logOf(fixture.store.get(), "NBF-1").filter((event) => event.kind === "rereview").length, 1);
});

test("A11-290: a verdict file written before the re-review began is the first review's, not the re-review's result", async () => {
  const { fixture, host, pool, startRereview, refuseRereview } = await standoffRun();
  clock.ms = Date.now() + 60 * MINUTE;
  startRereview("Not a defect in this diff.");
  refuseRereview();
  pool.reviewNewHeads();
  assert.equal(logOf(fixture.store.get(), "NBF-1").filter((event) => event.kind === "rereview").length, 0, "the file is older than the look the re-review started with");
  assert.equal(host.comments.posted.length, 0);
});

test("A11-290: a verdict file the reviewer left itself, that the door never refused, is no refused re-review", async () => {
  const { fixture, host, startRereview, refuseRereview } = await standoffRun();
  startRereview("Not a defect in this diff.");
  refuseRereview(refusedFile("not convinced"), "verdict.md");
  assert.equal(logOf(fixture.store.get(), "NBF-1").filter((event) => event.kind === "rereview").length, 0, "only the copy the door keeps of what it refused is read");
  assert.equal(host.comments.posted.length, 0);
});

test("A11-290: a pull request no run holds is recorded once on the pull request, however often the board restarts", async () => {
  const { fixture, host, reviewer, startRereview, refuseRereview } = await standoffRun({ held: false });
  startRereview("Not a defect in this diff.");
  refuseRereview();
  assert.equal(host.comments.posted.length, 1);
  fixture.restart({ codeHost: host, reviewer }).reviewNewHeads();
  fixture.restart({ codeHost: host, reviewer }).reviewNewHeads();
  assert.equal(host.comments.posted.length, 1, "the comment already on the pull request says it was recorded");
});

test("A11-290: the scan of the reviewer's checkout is made once for a re-review that is recorded, not on every sweep", async () => {
  const { reviewer, pool, startRereview, refuseRereview } = await standoffRun();
  startRereview("Not a defect in this diff.");
  refuseRereview();
  let looked = 0;
  const spied = reviewer as { verdictFileOf: (ref: { pr: string; head: string }) => string | null };
  const original = spied.verdictFileOf.bind(reviewer);
  spied.verdictFileOf = (ref) => { looked += 1; return original(ref); };
  for (let sweep = 0; sweep < 3; sweep += 1) pool.reviewNewHeads();
  assert.equal(looked, 0);
});
