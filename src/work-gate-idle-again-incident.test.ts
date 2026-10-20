// no-token: gh -- no `gh`, `herdr` or `git` is run; the rows, pull requests, listing and clock are fixtures, and the only files written are a temporary directory's (agent-org#860)
// agent-org#860 (a11ign#4957 cause 3): A HOLDER IDLE AGAIN AFTER ITS NUDGE FILES A `claimed-worker-stalled` INCIDENT FROM THE TICK, on any tracker, and the idle bound for a holder
// with a pull request is 30 minutes. The ledger's only writer was a RELEASE carrying `nudgedAt`; a keyed row's release is withheld (agent-org#834) and a holder with a pull
// request is never released (#2999), so a stuck holder stayed invisible past its first nudge.
//
// EVERY "NO EVENT" ASSERTION HAS A TWIN: the same fixture with ONE thing changed that DOES write one, so a writer that never fires turns the twins red and one that always
// fires turns the controls red. The mutations, both directions, are in the pull request.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimStallTick } from "./work-gate/claim-stall-tick.ts";
import type { TrackerClaims } from "./work-gate/claim-stall-tick.ts";
import { claimRecordComment } from "./row-claim.ts";
import { CLAIMED_WORKER_STALLED } from "./claim-stall.ts";
import { STALL_INTERVAL_MS } from "./claim-stall/stall-causes-and-claim-readings.ts";
import { FAILURE_LEDGER_FILE, parseFailureLedger } from "./failure-ledger.ts";
import { IDLE_CLAIMANT_MINUTES, STOPPED_CLAIMANT_MINUTES } from "./idle-claimant.ts";
import { ledgerLine } from "./wake/ended-sessions.ts";
import { WORKER_STATE_DIR } from "./worker-state.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-11T09:00:00Z");
const M = STOPPED_CLAIMANT_MINUTES;
const N = IDLE_CLAIMANT_MINUTES;
const STANDING = [{ label: "ceo", status: "done" }, { label: "orchestrator", status: "done" }];
const SESSION = "worker-agent-org-476";
const noGit = { git: () => ({ status: 0, out: "" }), exists: () => false, mtime: () => null };

const claimedRow = (row: number, session: string) => ({ number: row, comments: [{
  body: claimRecordComment({ session, branch: `agent/x-${row}`, worktree: `../wt-${row}` }),
  createdAt: new Date(T0 - 20 * MIN).toISOString(), author: { login: "a11ign-ai-workers" } }] });
const rowOf = (number: number, session: string) => ({ number, title: `row ${number}`, body: "", blockedBy: { nodes: [] },
  labels: ["in-progress", `session:${session}`, "started"].map((name) => ({ name })) });
/** An open pull request of the claim's branch; `pending` is a check run still in progress, which the gate reads as a wait. */
const prOf = (row: number, { pending = false } = {}) => ({ number: 9000 + row, headRefName: `agent/x-${row}`, reviewDecision: "REVIEW_REQUIRED", labels: [],
  statusCheckRollup: [pending
    ? { name: "gate", status: "IN_PROGRESS", startedAt: "2026-10-11T08:50:00Z", completedAt: "0001-01-01T00:00:00Z" }
    : { name: "gate", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-11T08:50:00Z", completedAt: "2026-10-11T08:55:00Z" }] });

type Order = { causeKey: string; release?: { why: string } };
type Scenario = { keyed?: boolean; regimeOff?: boolean; prs?: object[]; status?: (minute: number) => string; until: number; deliverAfter?: number };

function withDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "idle-again-incident-"));
  try { return body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const eventsOf = (dir: string) => {
  try { return parseFailureLedger(readFileSync(join(dir, FAILURE_LEDGER_FILE), "utf8")).filter((e) => e.classKey === CLAIMED_WORKER_STALLED); } catch { return []; }
};

/**
 * One holder, one tick a minute from 0 to `until`, the nudge memory surviving between ticks as the state file does. The nudge is DELIVERED `deliverAfter` minutes
 * after it was ordered (the wake ledger gets its line from that tick on). Returns the minute the nudge was ordered, the minute each ledger line first appeared
 * and the release orders seen.
 */
function run(dir: string, s: Scenario) {
  const memory: Record<string, unknown> = {};
  // a state directory whose declarations cannot be READ turns the declaration regime off (absence is not proof), and a holder with a PR is then on N and not on M
  if (s.regimeOff === true) writeFileSync(join(dir, WORKER_STATE_DIR), "a file where the directory should be");
  const keyed = s.keyed ?? true;
  const row = rowOf(476, SESSION);
  const comments = [claimedRow(476, SESSION)];
  const tracker: TrackerClaims = { key: "agent-org", repo: "a11ign/agent-org", rows: [row], claimedComments: comments };
  let nudgedMinute: number | null = null;
  let ledger = "";
  const appeared: number[] = [];
  const releases: number[] = [];
  for (let m = 0; m <= s.until; m++) {
    const orders = claimStallTick({ rows: keyed ? [] : [row], claimedComments: keyed ? [] : comments, openPrs: s.prs ?? [], mergedPrs: null, io: noGit, repo: "/repo",
      now: T0 + m * MIN, restartAt: null, agents: [...STANDING, { label: SESSION, status: (s.status ?? (() => "idle"))(m) }], agentSessions: null, stateDir: dir,
      ledger: () => ledger, log: () => undefined, trackers: keyed ? [tracker] : [],
      read: () => JSON.parse(JSON.stringify(memory)), write: (_path: string, state: object) => { for (const k of Object.keys(memory)) delete memory[k]; Object.assign(memory, state); },
    } as never) as unknown as Order[];
    for (const order of orders) {
      if (order.release !== undefined) { releases.push(m); continue; }
      if (nudgedMinute === null) {
        nudgedMinute = m;
        const at = T0 + (m + (s.deliverAfter ?? 1)) * MIN;
        ledger = ledgerLine(at, order.causeKey);
      }
    }
    const count = eventsOf(dir).length;
    while (appeared.length < count) appeared.push(m);
  }
  return { nudgedMinute, appeared, releases, events: eventsOf(dir) };
}

test("the figures: the idle bound for a holder with a pull request is 30 minutes, the stopped holder's stays 10, and the release interval stays 120 (a11ign#4957 cause 3)", () => {
  assert.equal(N, 30);
  assert.equal(M, 10);
  assert.equal(STALL_INTERVAL_MS, 120 * MIN);
});

test("KEYED ROW, no PR: nudged at T, idle again one period after the nudge was DELIVERED, exactly one event; the release later adds none", () => withDir((dir) => {
  const r = run(dir, { until: 140 });
  assert.equal(r.nudgedMinute, M, "the control: the nudge IS sent, at the stopped holder's figure");
  const delivered = M + 1;
  assert.deepEqual(r.appeared, [delivered + M], "one event, the tick one period after delivery and not a tick before");
  assert.deepEqual(r.events.map((e) => e.ref), [`${SESSION}/#476/${T0 + M * MIN}`], "the ref is the one a release writes: <session>/#<row>/<nudgedAt>");
  assert.ok(r.releases.length > 0, "the control: the row IS released later (delivery + the 120-minute interval), so 'a release adds none' is tested and not vacuous");
  assert.equal(r.events.length, 1, "the release read two hours on is the same episode: the ledger's skip-if-present keeps it from counting twice");
}));

test("HOME ROW, no PR: the same, so the writer is not the second tracker's alone", () => withDir((dir) => {
  const r = run(dir, { keyed: false, until: 60 });
  assert.deepEqual(r.appeared, [M + 1 + M]);
}));

test("POSITIVE CONTROL: the same keyed row WITHOUT the second idle period writes none -- a holder that WORKED after the nudge starts the period over", () => withDir((dir) => {
  // working from the tick after delivery to the tick before one period elapsed: the run of idle ticks is broken, so the period restarts when it goes idle again
  const worked = run(dir, { until: M + 1 + M + 5, status: (m) => (m > M + 1 && m < M + 1 + M ? "working" : "idle") });
  assert.equal(worked.nudgedMinute, M);
  assert.deepEqual(worked.appeared, [], "idle again for 5 minutes only: no incident yet");
  withDir((other) => {
    const idle = run(other, { until: M + 1 + M + 5 });
    assert.deepEqual(idle.appeared, [M + 1 + M], "the twin: the same fixture idle throughout writes its one event");
  });
}));

test("a nudge the holder was NEVER TOLD of is not 'idle again': no event until it is delivered, and the period runs from the delivery", () => withDir((dir) => {
  const late = run(dir, { until: M + 30, deliverAfter: 20 });
  assert.equal(late.nudgedMinute, M);
  assert.deepEqual(late.appeared, [M + 20 + M], "delivered 20 minutes after the order: the period runs from there");
  withDir((other) => {
    const never = run(other, { until: M + 15, deliverAfter: 1000 });
    assert.deepEqual(never.appeared, [], "the twin: a delivery that has not happened inside the run writes nothing");
  });
}));

test("a holder with an open PR is never nudged, so no incident follows it, pending or not (agent-org#805); it is never released either", () => withDir((dir) => {
  const r = run(dir, { prs: [prOf(476)], until: M + 1 + M + 10 });
  assert.equal(r.nudgedMinute, null, "agent-org#805: an open PR of the holder's is never a nudge, whatever is declared or pending");
  assert.deepEqual(r.appeared, [], "so no nudge is delivered and no idle-again incident is written");
  assert.deepEqual(r.releases, [], "and it is not released");
  withDir((other) => {
    const waiting = run(other, { prs: [prOf(476, { pending: true })], until: M + 1 + M + 10 });
    assert.equal(waiting.nudgedMinute, null, "agent-org#805: the pending check changes nothing for an open PR");
    withDir((noPr) => {
      const twin = run(noPr, { until: M + 1 + M + 10 });
      assert.equal(twin.nudgedMinute, M, "CONTROL: the holder with NO open PR IS nudged at M under the regime, so the nulls above are not a holder nobody nudged");
      assert.deepEqual(twin.appeared, [M + 1 + M], "and the incident follows one period after the delivery");
    });
  });
}));

test("REGIME OFF: a holder with an open PR is never nudged (agent-org#805), on the 30-minute bound or not; with NO open PR it is nudged at 30 and an incident follows one period after delivery", () => withDir((dir) => {
  const r = run(dir, { prs: [prOf(476)], regimeOff: true, until: N + 1 + N + 10 });
  assert.equal(r.nudgedMinute, null, "agent-org#805: no nudge at the 30-minute bound or at 45 for an open PR of the holder's");
  assert.deepEqual(r.appeared, [], "so no incident");
  assert.deepEqual(r.releases, [], "never released (#2999)");
  withDir((other) => {
    const waiting = run(other, { prs: [prOf(476, { pending: true })], regimeOff: true, until: N + 1 + N + 10 });
    assert.equal(waiting.nudgedMinute, null, "the pending check changes nothing for an open PR: no nudge");
    assert.deepEqual(waiting.appeared, [], "and no incident");
    withDir((noPr) => {
      const twin = run(noPr, { regimeOff: true, until: N + 1 + N + 10 });
      assert.equal(twin.nudgedMinute, M, "CONTROL: with NO open PR the holder IS nudged (on the stopped bound, which a holder with no PR has whatever the regime), so the nulls above are not a holder nobody nudged");
      assert.deepEqual(twin.appeared, [M + 1 + M], "and the incident follows one period after the delivery");
    });
  });
}));

test("a holder that is WORKING the whole time is not nudged and writes nothing", () => withDir((dir) => {
  const r = run(dir, { until: 60, status: () => "working" });
  assert.equal(r.nudgedMinute, null);
  assert.deepEqual(r.appeared, []);
}));
