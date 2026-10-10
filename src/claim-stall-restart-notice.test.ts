// no-token: gh -- no `gh`, `herdr` or `git` is run; the rows, listings and clock are fixtures and the only files written are in a temporary directory (a11ign/agent-org#458)
// #458: a restarted session is told ONCE that its background tasks are lost, never repeated. The signal is the holder's agent-session id CHANGING in herdr's
// own `agent list`, not "the session started after its claim" (the row's wording): a dispatch claims FIRST and starts the process after, so every fresh start would
// read as a restart. The measurement comment on the row says so.
//
// EVERY "NO NOTICE" ASSERTION HAS A TWIN: the same fixture with ONE thing changed that DOES produce one, so a notice that never fires turns the twins red and one that
// always fires turns the controls red. The mutations, both directions, are in the pull request.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimStallTick } from "./work-gate.ts";
import { claimRecordComment } from "./row-claim.ts";
import { ledgerLine } from "./wake.ts";
import { AGENT_SESSIONS_FILE, restartNoticeKey, restartNotices, type ClaimFacts, type Reading } from "./claim-stall.ts";
import { readAgentSessions } from "./herdr-agents.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-10T09:00:00Z");
const MOVING: Reading = { kind: "moving", lastMoveAt: T0 } as Reading;
const facts = (over: Partial<ClaimFacts> = {}) => ({ row: 4001, session: "worker-9", branch: "agent/x-4001", title: "row 4001", ...over }) as ClaimFacts;
const seen = (over: Partial<ClaimFacts> = {}, reading: Reading = MOVING) => ({ facts: facts(over), reading });
const none = () => false;

// --- the decision, pure -----------------------------------------------------------------------------------------------------------

test("a first sighting is remembered and told nothing (a fresh start, or the first tick after this ships, is not a restart)", () => {
  const sessions = new Map([["worker-9", "aaa"]]);
  const first = restartNotices({ readings: [seen()], sessions, acked: {}, delivered: none });
  assert.deepEqual(first.orders, []);
  assert.deepEqual(first.after, { "worker-9/4001": "aaa" });
  const again = restartNotices({ readings: [seen()], sessions, acked: first.after, delivered: none });
  assert.deepEqual(again.orders, [], "the same id on the next tick");
  assert.equal(restartNotices({ readings: [seen()], sessions: new Map([["worker-9", "bbb"]]), acked: first.after, delivered: none }).orders.length, 1, "the twin: a new id");
});

test("a new id is ONE order: the claim-stalled cause, keyed per restart, saying the tasks are lost; re-offered until delivered, then never", () => {
  const acked = { "worker-9/4001": "aaa" };
  const restarted = new Map([["worker-9", "bbb"]]);
  const first = restartNotices({ readings: [seen()], sessions: restarted, acked, delivered: none });
  assert.equal(first.orders.length, 1);
  const [order] = first.orders;
  assert.equal(order.cause, "claim-stalled");
  assert.equal(order.session, "worker-9");
  assert.equal(order.causeKey, "worker-9/claim-stalled/row-4001/restart-bbb");
  assert.equal(order.causeKey, restartNoticeKey("worker-9", 4001, "bbb"));
  assert.equal(order.resume, true);
  assert.match(order.prompt, /RESTARTED/);
  assert.match(order.prompt, /background task you started before the restart is LOST/);
  assert.deepEqual(first.after, acked, "not remembered until it is delivered: a holder mid-turn right after a restart would otherwise lose it");
  const delivered = restartNotices({ readings: [seen()], sessions: restarted, acked, delivered: (key) => key === order.causeKey });
  assert.deepEqual(delivered.orders, [], "delivered: never again");
  assert.deepEqual(delivered.after, { "worker-9/4001": "bbb" });
  const next = restartNotices({ readings: [seen()], sessions: new Map([["worker-9", "ccc"]]), acked: delivered.after, delivered: (key) => key === order.causeKey });
  assert.equal(next.orders[0].causeKey, restartNoticeKey("worker-9", 4001, "ccc"), "a SECOND restart is its own notice");
});

test("a listing that failed is never read as a restart, and a session herdr does not list keeps its memory (twin: a listed new id)", () => {
  const acked = { "worker-9/4001": "aaa" };
  const failed = restartNotices({ readings: [seen()], sessions: null, acked, delivered: none });
  assert.deepEqual(failed.orders, []);
  assert.deepEqual(failed.after, acked);
  const absent = restartNotices({ readings: [seen()], sessions: new Map([["worker-1", "zzz"]]), acked, delivered: none });
  assert.deepEqual(absent.orders, []);
  assert.deepEqual(absent.after, acked, "`goneReading` owns an absent session");
  assert.equal(restartNotices({ readings: [seen()], sessions: new Map([["worker-9", "bbb"]]), acked, delivered: none }).orders.length, 1);
});

test("a `Claimed-nothing:` claim is never told; a row nudged or released this tick is not told twice (twin: moving)", () => {
  const acked = { "worker-9/4001": "aaa" };
  const restarted = new Map([["worker-9", "bbb"]]);
  assert.deepEqual(restartNotices({ readings: [seen({ nothing: true })], sessions: restarted, acked, delivered: none }).orders, []);
  for (const kind of ["nudge", "nudged", "release", "vacating"]) {
    assert.deepEqual(restartNotices({ readings: [seen({}, { kind } as Reading)], sessions: restarted, acked, delivered: none }).orders, [], kind);
  }
  assert.equal(restartNotices({ readings: [seen({}, { kind: "idle-watch" } as Reading)], sessions: restarted, acked, delivered: none }).orders.length, 1,
    "an idle holder not yet at the figure IS told: it restarted and is waiting for a notice that cannot come");
});

test("the memory carries only the rows still claimed, so it cannot grow", () => {
  const acked = { "worker-9/4001": "aaa", "worker-9/3999": "old", "worker-3/12": "zzz" };
  const after = restartNotices({ readings: [seen()], sessions: new Map([["worker-9", "aaa"]]), acked, delivered: none }).after;
  assert.deepEqual(after, { "worker-9/4001": "aaa" });
});

// --- through the tick: the memory is a file, the delivery is the wake ledger's ---------------------------------------------------------

const claimed = { number: 4001, comments: [{ body: claimRecordComment({ session: "worker-9", branch: "agent/x-4001", worktree: "../wt-4001" }),
  createdAt: new Date(T0 - 20 * MIN).toISOString(), author: { login: "a11ign-ai-workers" } }] };
const row = { number: 4001, title: "row 4001", body: "", blockedBy: { nodes: [] }, labels: ["in-progress", "session:worker-9"].map((name) => ({ name })) };
const LISTING = (status: string) => [{ label: "ceo", status: "done" }, { label: "orchestrator", status: "done" }, { label: "worker-9", status }];
const noGit = { git: () => ({ status: 0, out: "" }), exists: () => false, mtime: () => null };

type Order = { cause: string; causeKey: string; prompt: string; release?: unknown };
/** One tick `minutes` after T0 in `dir`, the holder's agent-session id `id` (`null`: herdr could not be asked), the wake ledger's text `wakeLedger`. */
function tick(dir: string, minutes: number, id: string | null, { wakeLedger = "", status = "working", nothing = false, memory = {} as Record<string, unknown> } = {}): Order[] {
  const comments = nothing ? [{ ...claimed, comments: [{ ...claimed.comments[0], body: claimRecordComment({ session: "worker-9", nothing: "reading" }) }] }] : [claimed];
  return claimStallTick({ rows: [row], claimedComments: comments, openPrs: [], mergedPrs: null, io: noGit, repo: "/repo", now: T0 + minutes * MIN, restartAt: null,
    agents: LISTING(status), agentSessions: id === null ? null : new Map([["worker-9", id]]), stateDir: dir, ledger: () => wakeLedger, log: () => undefined,
    read: () => JSON.parse(JSON.stringify(memory)), write: () => undefined } as never) as unknown as Order[];
}
const withDir = <T>(body: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "claim-stall-restart-"));
  try { return body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const remembered = (dir: string) => JSON.parse(readFileSync(join(dir, AGENT_SESSIONS_FILE), "utf8"));

test("a restarted holder gets the notice ONCE and a second tick sends none; a fresh start gets none", () => withDir((dir) => {
  assert.deepEqual(tick(dir, 0, "aaa"), [], "the first sighting: a fresh start, whatever order the claim and the process came in");
  assert.deepEqual(remembered(dir), { "worker-9/4001": "aaa" });
  assert.deepEqual(tick(dir, 1, "aaa"), [], "the same session, the next tick");

  const [notice, ...rest] = tick(dir, 2, "bbb");
  assert.deepEqual(rest, []);
  assert.equal(notice.cause, "claim-stalled");
  assert.equal(notice.causeKey, restartNoticeKey("worker-9", 4001, "bbb"));
  assert.match(notice.prompt, /LOST/);
  assert.deepEqual(remembered(dir), { "worker-9/4001": "aaa" }, "held until the wake ledger shows it delivered");

  const delivered = ledgerLine(T0 + 3 * MIN, notice.causeKey);
  assert.deepEqual(tick(dir, 3, "bbb", { wakeLedger: delivered }), [], "delivered: the second tick sends none");
  assert.deepEqual(remembered(dir), { "worker-9/4001": "bbb" });
  for (let m = 4; m < 10; m++) assert.deepEqual(tick(dir, m, "bbb", { wakeLedger: delivered }), [], `tick ${m}: never repeated`);
  assert.equal(tick(dir, 10, "ccc", { wakeLedger: delivered }).length, 1, "the twin: a second restart is told once more");
}));

test("a notice not yet delivered is offered again under the SAME key (the wake machinery dedupes by it); an unreadable herdr changes nothing", () => withDir((dir) => {
  tick(dir, 0, "aaa");
  const first = tick(dir, 1, "bbb");
  const second = tick(dir, 2, "bbb");
  assert.deepEqual([first.length, second.length], [1, 1]);
  assert.equal(first[0].causeKey, second[0].causeKey);
  assert.deepEqual(tick(dir, 3, null), [], "herdr could not be asked: neither a restart nor a delivery");
  assert.deepEqual(remembered(dir), { "worker-9/4001": "aaa" });
}));

test("an idle holder after a restart is told too, once; a nothing-claim never (twin: the same restart on a built claim)", () => withDir((dir) => {
  tick(dir, 0, "aaa", { status: "idle" });
  assert.equal(tick(dir, 1, "bbb", { status: "idle" }).length, 1, "idle, not yet at the stopped figure: the notice is the only order");
  withDir((other) => {
    tick(other, 0, "aaa", { nothing: true });
    assert.deepEqual(tick(other, 1, "bbb", { nothing: true }), []);
  });
}));

test("an unreadable memory only ever MISSES a notice: it reads as a first sighting, never as a restart", () => withDir((dir) => {
  tick(dir, 0, "aaa");
  writeFileSync(join(dir, AGENT_SESSIONS_FILE), "{ not json");
  assert.deepEqual(tick(dir, 1, "bbb"), []);
  assert.deepEqual(remembered(dir), { "worker-9/4001": "bbb" }, "and is rewritten from this tick's reading");
}));

test("a fixture tick with no state directory writes nowhere and makes no herdr call (the hermetic default every existing test relies on)", () => {
  const orders = claimStallTick({ rows: [row], claimedComments: [claimed], openPrs: [], mergedPrs: null, io: noGit, repo: "/repo", now: T0, restartAt: null,
    agents: LISTING("working"), stateDir: "/nonexistent-state-dir-458", ledger: () => "", log: () => undefined, read: () => ({}), write: () => undefined } as never);
  assert.deepEqual(orders, []);
});

// --- the reading of herdr's `agent list` ----------------------------------------------------------------------------------------

test("readAgentSessions: name to session id, an agent without an id left out, and null (never an empty map) when herdr could not be asked", () => {
  const listing = JSON.stringify({ result: { agents: [
    { name: "worker-9", agent: "claude", agent_session: { value: "bbb" } }, { name: "ceo", agent: "claude", agent_session: { value: "ccc" } },
    { name: "worker-4", agent: "claude" }, { agent: "claude", agent_session: { value: "ddd" } },
  ] } });
  assert.deepEqual([...readAgentSessions(() => listing)!], [["worker-9", "bbb"], ["ceo", "ccc"]]);
  assert.equal(readAgentSessions(() => { throw new Error("no herdr"); }), null);
  assert.equal(readAgentSessions(() => "not json"), null);
  assert.equal(readAgentSessions(() => JSON.stringify({ result: {} })), null);
  assert.deepEqual([...readAgentSessions(() => JSON.stringify({ result: { agents: [] } }))!], [], "[] is an answer: herdr listed nobody");
});
