// no-token: gh -- every `gh` and `git` call here is an injected seam, and the clock is a constant; nothing imported reaches the network or a worktree
/**
 * #612: A HAND-STARTED ENGINEER'S STALL CLOCK STARTS WHEN IT TOOK THE ROW, NOT AT THE PREVIOUS HOLDER'S CLAIM RECORD.
 *
 * A hand start adds the `session:` label and writes no claim record, so `claimedAt` was the PREVIOUS holder's record and a session started ten hours
 * after it had an idle window of ten hours at its first tick: nudged at once, and released after the grace if it had not moved (#4789 fixed the merged
 * reading's half of this; its pull request named this row as the remainder).
 *
 * THE FIXTURE: the previous holder's record at T0 and the hand start (label only) at T0+10h, ticked four minutes after.
 * THE CONTROLS: the same row with NO `labelEvents` seam is the unfixed reading and nudges; a row-claim claim (record and label together) reads as before;
 * and a hand start that then sits idle for the interval is still nudged, so the label anchors the clock and does not switch it off.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimRecordComment } from "./row-claim.ts";
import { claimFactsFrom, readClaim, STALL_INTERVAL_MS, type HostReads, type Reading } from "./claim-stall.ts";
import { claimStallTick } from "./work-gate/claim-stall-tick.ts";
import type { LabelEvent } from "./claim-provenance.ts";

const ROW = 4524;
const SESSION = "worker-4524";
const BRANCH = "agent/the-anchor-4524";
const MIN = 60_000;
const T0 = Date.parse("2026-10-09T21:29:49Z");
const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();
const START = 10 * 60; // the hand start, ten hours after the previous holder's record
const NOW = T0 + (START + 4) * MIN;
const INTERVAL_MIN = STALL_INTERVAL_MS / MIN;
const REPO = "/home/agent/repos/agent-org";

const record = (minutes: number) => ({ id: `r${minutes}`, body: claimRecordComment({ session: SESSION, branch: BRANCH, worktree: "../wt-4524" }), createdAt: at(minutes),
  author: { login: "a11ign-ai-workers" } });
const labelled = (minutes: number, session = SESSION): LabelEvent => ({ event: "labeled", label: `session:${session}`, at: at(minutes) });

const base: Pick<HostReads, "git" | "exists" | "mtime"> = { git: () => ({ status: 0, out: "" }), exists: () => false, mtime: () => null };
const PREVIOUS = [record(0)];

/** What the pass makes of the row at `now`: the facts built and the reading. */
function read({ comments = PREVIOUS, labelEvents, now = NOW, withNow = true }: { comments?: object[]; labelEvents?: HostReads["labelEvents"]; now?: number; withNow?: boolean } = {}) {
  const io: HostReads = labelEvents === undefined ? base : { ...base, labelEvents };
  const facts = claimFactsFrom({ row: ROW, session: SESSION, waiting: null, blockedBy: [], comments, openPrs: [], mergedPrs: [], repo: REPO,
    trackerRepo: "a11ign/a11ign", sessionRows: 1, ...(withNow ? { now } : {}) }, io);
  if ("skip" in facts) throw new Error(`skipped: ${facts.skip}`);
  const reading: Reading = readClaim(facts, { now, restartAt: null, agents: null, nudge: null, goneSince: null, idleSince: null });
  return { facts, reading };
}

test("a hand start ten hours after the previous record reads `moving` at its first tick, from the label", () => {
  const { facts, reading } = read({ labelEvents: () => [labelled(0), labelled(START)] });
  assert.equal(facts.claimedAt, T0 + START * MIN);
  assert.equal(reading.kind, "moving", JSON.stringify(reading));
  assert.equal(facts.clockHeld, undefined);
});

test("negative control: the unfixed reading (no label dating) nudges the same row at its first tick", () => {
  for (const [name, args] of [["no seam", {}], ["a caller that gives no `now`", { labelEvents: () => [labelled(START)], withNow: false }]] as const) {
    const { facts, reading } = read(args);
    assert.equal(facts.claimedAt, T0, name);
    assert.equal(reading.kind, "nudge", `${name}: ${JSON.stringify(reading)}`);
  }
});

test("a row-claim claim (a fresh record beside its label) reads exactly as before", () => {
  const claimed = [record(0), record(START + 1)];
  const withSeam = read({ comments: claimed, labelEvents: () => [labelled(START)] });
  const without = read({ comments: claimed });
  assert.equal(withSeam.facts.claimedAt, T0 + (START + 1) * MIN, "the record is the later anchor, so it stays");
  assert.deepEqual(withSeam.reading, without.reading);
  assert.equal(withSeam.reading.kind, "moving");
  // and a label dated BEFORE the record never pulls the clock earlier: ticked once the record is past the interval, so the seam IS asked
  const later = T0 + (START + 1 + INTERVAL_MIN + 5) * MIN;
  assert.equal(read({ comments: claimed, labelEvents: () => [labelled(10)], now: later }).facts.claimedAt, T0 + (START + 1) * MIN);
});

test("an unreadable label time reads as the record's (never sooner), and the facts say why (twins: refused read, history with no such event)", () => {
  const unfixed = read({});
  for (const [name, labelEvents] of [["refused", () => null], ["no event for the session", () => [labelled(0, "worker-9")]]] as const) {
    const { facts, reading } = read({ labelEvents });
    assert.equal(facts.claimedAt, T0, name);
    assert.deepEqual(reading, unfixed.reading, name);
    assert.match(facts.clockHeld ?? "", /session:worker-4524 was added to #4524 could not be read, so the stall clock starts at the claim record/, name);
  }
});

test("the label anchors the clock, it does not switch it off: a hand start idle for the interval is still nudged", () => {
  const events = () => [labelled(0), labelled(START)];
  const justInside = read({ labelEvents: events, now: T0 + (START + INTERVAL_MIN - 1) * MIN });
  assert.equal(justInside.reading.kind, "moving");
  const justOutside = read({ labelEvents: events, now: T0 + (START + INTERVAL_MIN) * MIN });
  assert.equal(justOutside.reading.kind, "nudge", JSON.stringify(justOutside.reading));
});

test("the seam is asked only for a record older than the stall interval, and once per claim however many readings want the label", () => {
  let asked = 0;
  const labelEvents = () => { asked += 1; return [labelled(START)]; };
  // the record is one minute inside the interval: the label cannot move the answer, so no call
  read({ labelEvents, now: T0 + (INTERVAL_MIN - 1) * MIN });
  assert.equal(asked, 0, "a quiet row spends no call");
  // the record is exactly the interval old: it is asked, once
  read({ labelEvents, now: T0 + INTERVAL_MIN * MIN });
  assert.equal(asked, 1);
  // the same claim with a merged pull request of its own after the record needs the label for the merge's anchor too: still one read
  asked = 0;
  const io: HostReads = { ...base, labelEvents };
  const facts = claimFactsFrom({ row: ROW, session: SESSION, waiting: null, blockedBy: [], comments: PREVIOUS, openPrs: [], repo: REPO, trackerRepo: "a11ign/a11ign",
    sessionRows: 1, now: NOW, mergedPrs: [{ number: 562, headRefName: BRANCH, mergedAt: at(30), title: "the previous holder's work", labels: [] }] }, io);
  assert.ok(!("skip" in facts));
  assert.equal(asked, 1);
});

test("the live tick passes its own `now`, so the clock is dated in production (a tick over a hand-started row nudges nothing)", () => {
  const log: string[] = [];
  const row = { number: ROW, title: "a row", labels: [{ name: "in-progress" }, { name: `session:${SESSION}` }], body: "", blockedBy: { nodes: [] } };
  const tick = (labelEvents: HostReads["labelEvents"]) => claimStallTick({ rows: [row], claimedComments: [{ number: ROW, comments: PREVIOUS }], openPrs: [], mergedPrs: [],
    io: { ...base, ...(labelEvents === undefined ? {} : { labelEvents }) }, repo: REPO, now: NOW, restartAt: null, agents: null, stateDir: "/state", ledger: () => "",
    log: (l: string) => log.push(l), read: () => ({}), write: () => {} });
  assert.deepEqual(tick(() => [labelled(0), labelled(START)]), [], "dated: moving, so no order");
  assert.equal(log.filter((l) => /clock kept/.test(l)).length, 0);
  const unfixed = tick(() => [labelled(0, "worker-9")]);
  assert.equal(unfixed.length, 1, "an unreadable label time is today's reading: the nudge");
  assert.equal(log.filter((l) => /#4524 \(worker-4524\) clock kept at the claim record: .*could not be read/.test(l)).length, 1, log.join(""));
});
