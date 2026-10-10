// no-token: gh -- every `gh` and `git` call here is an injected seam, and the clock is a constant; nothing imported reaches the network or a worktree
/**
 * #4789: A HAND-STARTED ENGINEER IS NOT RELEASED FOR THE PREVIOUS HOLDER'S MERGED PULL REQUEST.
 *
 * A hand start adds the `session:` label and writes no claim record, so the newest record on the row is the PREVIOUS holder's, and a pull request merged
 * for that holder read as the new one's landed work. a11ign#4524: `worker-4524` started 08:28Z and was released 08:32:05Z for agent-org#562, merged at
 * 22:01Z the evening before, against a record of 21:29:49Z.
 *
 * THE FIXTURE IS THAT SHAPE (times shifted): the previous holder's record at T0, the pull request merged at T0+30m, the hand start (label only) at T0+10h.
 * THE CONTROLS: the same row with the pull request merged AFTER the label is released as before, a row-claim claim (record and label together) is released
 * as before, and the same fixture with NO `labelEvents` seam is the unfixed reading and releases the first.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimRecordComment } from "./row-claim.ts";
import { claimFactsFrom, claimStalledOrders, readClaim, readLabelEvents, sessionLabelAddedAt, type HostReads, type MergedPr, type Reading } from "./claim-stall.ts";
import { LIVE_HOST_READS } from "./work-gate/claim-stall-tick.ts";
import type { LabelEvent } from "./claim-provenance.ts";

const ROW = 4524;
const SESSION = "worker-4524";
const BRANCH = "agent/the-anchor-4524";
const MIN = 60_000;
const T0 = Date.parse("2026-10-09T21:29:49Z");
const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();
const START = 10 * 60; // the hand start, ten hours after the previous holder's record
const NOW = T0 + START * MIN + 4 * MIN;
const REPO = "/home/agent/repos/agent-org";

const record = (minutes: number) => ({ id: `r${minutes}`, body: claimRecordComment({ session: SESSION, branch: BRANCH, worktree: "../wt-4524" }), createdAt: at(minutes),
  author: { login: "a11ign-ai-workers" } });
const labelled = (minutes: number, session = SESSION): LabelEvent => ({ event: "labeled", label: `session:${session}`, at: at(minutes) });
const mergedAt = (minutes: number) => [{ number: 562, headRefName: BRANCH, mergedAt: at(minutes), title: "the previous holder's work", labels: [] }];

const base: Pick<HostReads, "git" | "exists" | "mtime"> = { git: () => ({ status: 0, out: "" }), exists: () => false, mtime: () => null };

/** What the pass makes of the row: the reading, and whether an order releases it. */
function readingOf({ comments, merged, labelEvents }: { comments: object[]; merged: MergedPr[]; labelEvents?: HostReads["labelEvents"] }) {
  const io: HostReads = labelEvents === undefined ? base : { ...base, labelEvents };
  const facts = claimFactsFrom({ row: ROW, session: SESSION, waiting: null, blockedBy: [], comments, openPrs: [], mergedPrs: merged, repo: REPO,
    trackerRepo: "a11ign/a11ign", sessionRows: 1 }, io);
  if ("skip" in facts) throw new Error(`skipped: ${facts.skip}`);
  const reading: Reading = readClaim(facts, { now: NOW, restartAt: null, agents: null, nudge: null, goneSince: null, idleSince: null });
  const [order] = claimStalledOrders([{ facts, reading }], NOW);
  return { reading, released: order?.release?.why };
}

const PREVIOUS = [record(0)];

test("#4524's case: a pull request merged BEFORE the session label was added is not this holder's landed work", () => {
  const { reading, released } = readingOf({ comments: PREVIOUS, merged: mergedAt(30), labelEvents: () => [labelled(0), labelled(START)] });
  assert.equal(released, undefined, JSON.stringify(reading));
  assert.notEqual(reading.kind, "release");
});

test("negative control: the unfixed reading (no label dating) releases the same row for the previous holder's pull request", () => {
  const { reading, released } = readingOf({ comments: PREVIOUS, merged: mergedAt(30) });
  assert.equal(released, "merged", JSON.stringify(reading));
});

test("a pull request merged AFTER the session label still releases, naming the pull request, as today", () => {
  const { reading, released } = readingOf({ comments: PREVIOUS, merged: mergedAt(START + 2), labelEvents: () => [labelled(0), labelled(START)] });
  assert.equal(released, "merged");
  assert.equal((reading as { mergedPr?: number }).mergedPr, 562);
});

test("a row-claim claim (a fresh record beside its label) is unchanged: the record is the later anchor, and a merge after it releases", () => {
  const events = () => [labelled(START)];
  const claimed = [record(0), record(START + 1)];
  assert.equal(readingOf({ comments: claimed, merged: mergedAt(START + 20), labelEvents: events }).released, "merged");
  assert.equal(readingOf({ comments: claimed, merged: mergedAt(START + 20) }).released, "merged", "and the same without the seam");
  assert.equal(readingOf({ comments: claimed, merged: mergedAt(30), labelEvents: events }).released, undefined, "a merge before the record is still no release");
});

test("a label time that cannot be read is HELD with the reason in the message, never released (twins: refused read, history with no such event)", () => {
  for (const [name, labelEvents] of [["refused", () => null], ["no event for the session", () => [labelled(0, "worker-9")]]] as const) {
    const { reading, released } = readingOf({ comments: PREVIOUS, merged: mergedAt(30), labelEvents });
    assert.equal(released, undefined, name);
    assert.equal(reading.kind, "holding", name);
    assert.match((reading as { why: string }).why, /agent-org#562|#562/, name);
    assert.match((reading as { why: string }).why, /session:worker-4524 was added to #4524 could not be read/, name);
  }
});

test("the seam is asked only when a merged pull request of the holder's counts from the record (a quiet row spends no call)", () => {
  let asked = 0;
  const labelEvents = () => { asked += 1; return [labelled(START)]; };
  readingOf({ comments: PREVIOUS, merged: [], labelEvents });
  readingOf({ comments: PREVIOUS, merged: [{ number: 7, headRefName: "agent/other-1", mergedAt: at(30), title: "not this row's", labels: [] }], labelEvents });
  assert.equal(asked, 0);
  const quiet = readingOf({ comments: PREVIOUS, merged: [], labelEvents });
  assert.deepEqual(quiet.reading, readingOf({ comments: PREVIOUS, merged: [] }).reading, "a row with no merge of its own reads exactly as it did without the seam");
  assert.notEqual(quiet.reading.kind, "holding");
  readingOf({ comments: PREVIOUS, merged: mergedAt(30), labelEvents });
  assert.equal(asked, 1, "the twin: a merge that does count asks once");
});

test("sessionLabelAddedAt: the newest `labeled` event of that session's label; null for a refusal or none, never zero", () => {
  assert.equal(sessionLabelAddedAt([labelled(0), labelled(START)], SESSION), T0 + START * MIN, "a label put back dates the holder who has it now");
  assert.equal(sessionLabelAddedAt([{ event: "unlabeled", label: `session:${SESSION}`, at: at(5) }], SESSION), null, "an unlabeled event is not an addition");
  assert.equal(sessionLabelAddedAt([labelled(0, "worker-9")], SESSION), null);
  assert.equal(sessionLabelAddedAt(null, SESSION), null);
});

test("readLabelEvents: lines of events parse, and a failed or malformed read is null (never an empty history)", () => {
  const line = (e: LabelEvent) => JSON.stringify(e);
  const calls: string[][] = [];
  const ok = readLabelEvents(ROW, "a11ign/a11ign", (args) => { calls.push(args); return { status: 0, out: `${line(labelled(0))}\n${line(labelled(START))}\n` }; });
  assert.deepEqual(ok, [labelled(0), labelled(START)]);
  assert.ok(calls[0].includes("repos/a11ign/a11ign/issues/4524/events"));
  assert.equal(readLabelEvents(ROW, "a11ign/a11ign", () => ({ status: 1, out: "" })), null);
  assert.equal(readLabelEvents(ROW, "a11ign/a11ign", () => ({ status: null, out: "" })), null);
  assert.equal(readLabelEvents(ROW, "a11ign/a11ign", () => ({ status: 0, out: "not json\n" })), null);
});

test("the live tick supplies the seam (without it the fix is inert in production)", () => {
  assert.equal(typeof LIVE_HOST_READS.labelEvents, "function");
});
