// no-token: none -- the code host and the tracker are the contracts' in-memory fakes; nothing reaches GitHub or Linear
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCodeHostConformance } from "../../plugins/conformance/code-host.ts";
import { createFakeCodeHost, fakePullUrl } from "../../plugins/fakes/code-host.ts";
import { createFakeTracker, fakeTicket } from "../../plugins/fakes/tracker.ts";
import { FIXTURE_REPOSITORY, groupCommitOf, pullWorld, QUEUE_ACTOR } from "./fault-pulls.ts";

const NOW = Date.UTC(2026, 10, 1, 9, 0, 0);

/** A pull world over fresh fakes, with FIX-1 and FIX-2 queued on the tracker. */
function world() {
  const host = createFakeCodeHost("fixture-worker");
  const tracker = createFakeTracker([fakeTicket("FIX-1"), fakeTicket("FIX-2")]);
  return { host, tracker, pulls: pullWorld(host, tracker) };
}

/** What the tracker links on `key`, as the board reads it. */
const linked = async (tracker: ReturnType<typeof createFakeTracker>, key: string) => (await tracker.pullStates!([key])).get(key);

test("the code host a scenario seeds with a cancelled check and a removal from the merge queue is the fake that passes the code host contract suite, reading back what was seeded", async () => {
  const { host, pulls } = world();
  const cancelled = pulls.open("FIX-1", NOW);
  const ejected = pulls.open("FIX-2", NOW);
  pulls.cancelCheck(cancelled, "always");
  pulls.eject(ejected, { reason: "failed_checks", actor: QUEUE_ACTOR }, NOW);
  const job = host.pullAt(cancelled)!.feedback.cancelledRequired![0].detailsUrl!;
  const probe = { pull: ejected, repository: FIXTURE_REPOSITORY, missing: fakePullUrl(FIXTURE_REPOSITORY, 404), self: "fixture-worker", queueFailure: { groupCommit: groupCommitOf(2), job: "install" } };
  const { passed } = await runCodeHostConformance(host, probe);
  assert.ok(passed.includes("readQueueFailure answers null for what it cannot read, and reads the failing job behind a removal"), "the removal's failing run is read as the contract says");
  assert.ok(passed.includes("readPullFeedback reads a pull request"));
  const read = await host.readPullFeedback(cancelled, "fixture-worker");
  assert.deepEqual([read?.blocked, read?.armed, read?.verdictAtHead, read?.cancelledRequired], [true, true, "approved", [{ name: "gate", detailsUrl: job }]]);
  const removed = await host.readPullFeedback(ejected, "fixture-worker");
  assert.deepEqual(removed?.queue, { queued: false, removals: [{ at: NOW, groupCommit: groupCommitOf(2), reason: "failed_checks", actor: QUEUE_ACTOR }] });
});

test("GitHub merges an approved, armed pull request once the board's rerun of its cancelled run went green, and the tracker links it merged; one whose every run is cancelled stays blocked", async () => {
  const { host, tracker, pulls } = world();
  const once = pulls.open("FIX-1", NOW);
  const always = pulls.open("FIX-2", NOW);
  pulls.cancelCheck(once, "once");
  pulls.cancelCheck(always, "always");
  pulls.step();
  assert.deepEqual([host.pullAt(once)!.state, host.pullAt(always)!.state], ["open", "open"], "nothing moves until the board asks");
  for (const url of [once, always]) await host.rerunRuns!([host.pullAt(url)!.feedback.cancelledRequired![0].detailsUrl!]);
  pulls.step();
  assert.deepEqual([host.pullAt(once)!.state, host.pullAt(always)!.state], ["merged", "open"]);
  assert.deepEqual(await linked(tracker, "FIX-1"), { [once]: "merged" });
  assert.deepEqual(await linked(tracker, "FIX-2"), { [always]: "open" });
  assert.equal(pulls.allMerged(), false);
});

test("a pull request removed from the merge queue is back in it, and merges, only once the board asks the arm bot to arm it again", async () => {
  const { host, pulls } = world();
  const url = pulls.open("FIX-1", NOW);
  pulls.eject(url, { reason: "manual", actor: "fixture-maintainer" }, NOW);
  pulls.step();
  assert.equal(host.pullAt(url)!.state, "open");
  await host.requestStackMerge!({ repo: FIXTURE_REPOSITORY, number: 1 });
  pulls.step();
  assert.equal(host.pullAt(url)!.state, "merged");
  assert.ok(pulls.allMerged());
});
