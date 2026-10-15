// no-token: gh -- no `gh`, `herdr` or `git` is run; the rows, comments and listing are fixtures (a11ign/agent-org#1536)
// agent-org#1536: THE GATE ORDERS A VERIFIED ROW CLOSED. `verifiedCloseOrder` was a pure function no tick called, so an idle claimant's VERIFIED note never
// reached `product-manager`. This drives the claim-stall tick itself and reads the order it returns, so the wiring is what is tested.
//
// EVERY "NOTHING IS ORDERED" ASSERTION HAS A TWIN: the same fixture with ONE thing changed that IS ordered.
import assert from "node:assert/strict";
import { test } from "node:test";
import { claimStallTick } from "./work-gate.ts";
import { claimRecordComment } from "./row-claim.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-11T09:00:00Z");
const CLAIMANT_ACCOUNT = "a11ign-ai-workers";
const SESSION = "worker-agent-org-4001";
const noGit = { git: () => ({ status: 0, out: "" }), exists: () => false, mtime: () => null };

/** The row, its one claim record (made `claimedMinutes` before T0), and one VERIFIED note by the claimant's account `noteMinutes` before T0. */
function fixture({ noteMinutes = 16, note = "VERIFIED: the tests pass and the row's Done-when 1 is met.", noteAuthor = CLAIMANT_ACCOUNT, status = "idle" } = {}) {
  const row = { number: 4001, title: "row 4001", body: "", blockedBy: { nodes: [] }, labels: [{ name: "in-progress" }, { name: `session:${SESSION}` }, { name: "started" }] };
  const comments = [
    { id: "IC_claim", body: claimRecordComment({ session: SESSION, branch: "agent/x-4001", worktree: "../wt-4001" }),
      createdAt: new Date(T0 - 60 * MIN).toISOString(), author: { login: CLAIMANT_ACCOUNT } },
    { id: "IC_note", body: note, createdAt: new Date(T0 - noteMinutes * MIN).toISOString(), author: { login: noteAuthor } },
  ];
  return { rows: [row], claimedComments: [{ number: 4001, comments }], listing: [{ label: "ceo", status: "done" }, { label: "orchestrator", status: "done" }, { label: SESSION, status }] };
}

/** One gate tick at T0 over the fixture, the orders it returns as the gate hands them on. */
function tick(f: ReturnType<typeof fixture>, io: object = noGit, log: string[] = []) {
  return claimStallTick({ rows: f.rows, claimedComments: f.claimedComments, openPrs: [], mergedPrs: null, io, repo: "/repo", now: T0, restartAt: null,
    agents: f.listing, agentSessions: null, stateDir: "/state", ledger: () => "", log: (line: string) => log.push(line), trackers: [],
    read: () => ({}), write: () => {} } as never) as unknown as { session: string; cause: string; subject: string; causeKey: string; prompt: string }[];
}

const closesOf = (orders: ReturnType<typeof tick>) => orders.filter((o) => o.cause === "verified-close");

test("POSITIVE CONTROL (d): an idle claimant's VERIFIED note 16 minutes old makes the gate order the row closed, to product-manager, naming the row and the note", () => {
  const closes = closesOf(tick(fixture({ noteMinutes: 16 })));
  assert.equal(closes.length, 1, "the gate's tick orders the close (the population is not empty)");
  assert.equal(closes[0].session, "product-manager");
  assert.equal(closes[0].causeKey, "verified-close:4001");
  assert.match(closes[0].subject, /4001/, "the order names the row");
  assert.match(closes[0].prompt, /IC_note/, "the order names the note by its id");
  assert.match(closes[0].prompt, /16 MINUTES AGO/);
});

test("TWIN (d) at 14 minutes: the same claimant and note, 14 minutes old, orders nothing", () => {
  assert.deepEqual(closesOf(tick(fixture({ noteMinutes: 14 }))), []);
});

// git that will not answer `rev-parse` (the same break `claim-stall-git-reads.test.ts` makes): the row's commit cannot be dated, so it is held, not ordered closed
const brokenRevParse = { git: (_dir: string, args: string[]) => (args[0] === "rev-parse" ? { status: null, out: "" } : { status: 0, out: "" }), exists: () => false, mtime: () => null };

test("TWIN: a commit git will not answer does not order the row closed, and does not stop the tick (the row is held)", () => {
  const log: string[] = [];
  assert.deepEqual(closesOf(tick(fixture({ noteMinutes: 16 }), brokenRevParse, log)), []);
  // an empty result is also what a tick that threw returns, so the tick's own "could not run" line is the proof it did not
  assert.equal(log.some((line) => line.includes("could not run")), false, `the tick ran to its end: ${log.join("")}`);
});

test("TWIN: a claimant still WORKING is not idle, so its 16-minute VERIFIED note orders nothing", () => {
  assert.deepEqual(closesOf(tick(fixture({ status: "working" }))), []);
});

test("TWIN: a note by someone other than the claimant's account orders nothing", () => {
  assert.deepEqual(closesOf(tick(fixture({ noteAuthor: "someone-else" }))), []);
});

test("TWIN: a note that does not say VERIFIED or Done-when met orders nothing", () => {
  assert.deepEqual(closesOf(tick(fixture({ note: "Looking at the diff now." }))), []);
});

test("the bound is the detector's 15 minutes, inclusive: a note exactly 15 minutes old orders the close", () => {
  assert.equal(closesOf(tick(fixture({ noteMinutes: 15 }))).length, 1);
});
