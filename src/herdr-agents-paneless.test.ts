// no-token: gh -- every `herdr` call here is an injected seam, and the rows a release strips and comments on are the fake code host's (A11-160, step 9); nothing imported reaches the real one
/**
 * agent-org#1413: A HERDR AGENT WITH NO PANE IS ENDED, NOT A LIVE HOLDER.
 *
 * `herdr workspace list` keeps a workspace whose pane is gone, in status `unknown`, so a `worker-<n>` whose pane was closed read as a live holder: a
 * closed row kept its claim labels, and an order addressed to it was retried forever. The pane is the authority (`herdr pane read` answers
 * `pane_not_found`; `pane list` still carries the pane, so it cannot say so). Every case goes through the real release path (`stripClosedClaims`) or
 * the real order drop (`dropUnknownHandoffs`), never a copy of either.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgents, type ListedAgent } from "./herdr-agents.ts";
import { stripClosedClaims } from "./work-gate.ts";
import { dropUnknownHandoffs, UNKNOWN_SESSION_MS } from "./wake/session-endings.ts";
import { queueHandoff, readHandoffs, HANDOFF_QUEUE_FILE } from "./wake/seat-reset.ts";
import { WAKEABLE } from "./wake/exit-and-limits.ts";
import { IDLE_STATUSES } from "./idle-claimant.ts";
import { forgetActivation, substituteCodeHost } from "./plugins/active.ts";
import { createFakeCodeHost } from "./plugins/fakes/code-host.ts";
import { fakeRow } from "./plugins/fakes/code-host-rows.ts";

afterEach(() => forgetActivation());

const NOW = Date.parse("2026-10-15T09:00:00Z");

type Pane = { name: string; status: string; pane: string };

/** The org as herdr lists it: the two standing panes, then `others`. `gone` are the panes herdr no longer has (`pane read` answers `pane_not_found`). */
function herdr(others: Pane[], gone: string[] = [], readFails: Record<string, Error> = {}) {
  const panes = [{ name: "ceo", status: "idle", pane: "w6:p1" }, { name: "orchestrator", status: "idle", pane: "w5:p1" }, ...others];
  const reads: string[] = [];
  const run = (args: string[]) => {
    const verb = args.slice(2).join(" ");
    if (verb === "workspace list") return JSON.stringify({ result: { workspaces: panes.map((p) => ({ label: p.name, agent_status: p.status, workspace_id: p.pane.split(":")[0] })) } });
    if (verb === "agent list") return JSON.stringify({ result: { agents: panes.map((p) => ({ name: p.name, agent_status: p.status, pane_id: p.pane })) } });
    if (args[2] === "pane" && args[3] === "read") {
      const pane = args[4];
      reads.push(pane);
      if (pane in readFails) throw readFails[pane];
      if (gone.includes(pane)) throw paneNotFound(pane);
      return "a readable screen\n";
    }
    throw new Error(`unexpected herdr call: ${args.join(" ")}`);
  };
  return { run, reads };
}

/** `herdr pane read` on a pane that is gone: a non-zero exit whose stderr is herdr's JSON error, as `execFileSync` reports it. */
function paneNotFound(pane: string) {
  const json = `{"error":{"code":"pane_not_found","message":"pane ${pane} not found"}}`;
  return Object.assign(new Error(`Command failed: herdr --session org pane read ${pane}\n${json}`), { stderr: `${json}\n` });
}

/** The `post` runner an order's drop is handed: the fake code host acts on its own rows, so a call to it would be a call to a `gh` nobody has. */
const noGh = (args: string[]): string => { throw new Error(`no gh is run here: ${args.join(" ")}`); };

/** A CLOSED row carrying the claim labels of `holder`, as the close left it. */
const closedRow = (number: number, holder: string, minutesBeforeNow: number) => ({ number, closedAt: new Date(NOW - minutesBeforeNow * 60_000).toISOString(),
  labels: [{ name: "in-progress" }, { name: "started" }, { name: `session:${holder}` }] });

/** The fake code host holding `rows` as the tracker's rows, closed and carrying the labels each lists: what a release strips is the world's row, and what it did is read off it. */
function trackerOf(...rows: ReturnType<typeof closedRow>[]) {
  const host = createFakeCodeHost();
  for (const row of rows) host.rowsWorld.rows.set(row.number, fakeRow(host.rowsWorld, row.number, { state: "CLOSED", closedAt: row.closedAt, labels: row.labels.map(({ name }) => name) }));
  substituteCodeHost(host);
  return host.rowsWorld;
}

/** One tick of the release, as the gate makes it: how many rows it reports stripped. What it did to the rows is the world's. */
function releaseTick(rows: ReturnType<typeof closedRow>[], agents: ListedAgent[]) {
  return stripClosedClaims({ rows, unread: [], agents } as never, { say: () => {}, repo: "fake/tracker", nowMs: NOW });
}

test("(1) a closed row held by a PANELESS listed worker loses its claim labels on the next tick, through the release path", () => {
  const { run } = herdr([{ name: "worker-5470", status: "unknown", pane: "w4N1:p1" }], ["w4N1:p1"]);
  const row = closedRow(5413, "worker-5470", 2);
  const world = trackerOf(row);
  const stripped = releaseTick([row], readAgents(run)!);
  assert.equal(stripped, 1);
  assert.deepEqual(world.calls.filter((call) => call.startsWith("removeLabelsFromRow")), ["removeLabelsFromRow #5413"], "one strip, of that row");
  assert.deepEqual(world.rows.get(5413)!.labels, [], "in-progress, started and session:worker-5470 are all off the row");
});

test("(1) the same closed row, its holder listed with a READABLE pane and `unknown` status, keeps its labels (the pin for (3))", () => {
  const { run } = herdr([{ name: "worker-5471", status: "unknown", pane: "w4N2:p1" }]);
  const agents = readAgents(run)!;
  assert.equal(agents.find((a) => a.label === "worker-5471")?.paneless, undefined, "a readable pane is never marked");
  const row = closedRow(5414, "worker-5471", 2);
  const world = trackerOf(row);
  const stripped = releaseTick([row], agents);
  assert.equal(stripped, 0, "unknown status with a live pane still holds the row: nothing is stripped");
  assert.deepEqual(world.calls.filter((call) => call.startsWith("removeLabelsFromRow")), []);
  assert.deepEqual(world.rows.get(5414)!.labels, ["in-progress", "started", "session:worker-5471"], "and the row keeps its claim labels");
});

test("(1) a listed agent that is NOT unknown is not asked for its pane, so a working seat whose pane is gone is not marked", () => {
  const { run, reads } = herdr([{ name: "worker-5472", status: "working", pane: "w4N3:p1" }], ["w4N3:p1"]);
  const agents = readAgents(run)!;
  assert.deepEqual(reads, [], "no `pane read` for a status other than unknown");
  assert.equal(agents.find((a) => a.label === "worker-5472")?.paneless, undefined);
});

test("(1) only `pane_not_found` marks: a pane that cannot be read for another reason is UNKNOWN, never ended", () => {
  const timeout = Object.assign(new Error("spawnSync herdr ETIMEDOUT"), { code: "ETIMEDOUT" });
  const { run } = herdr([{ name: "worker-5473", status: "unknown", pane: "w4N4:p1" }], [], { "w4N4:p1": timeout });
  const agents = readAgents(run)!;
  assert.equal(agents.find((a) => a.label === "worker-5473")?.paneless, undefined);
  assert.deepEqual(agents.map((a) => a.label), ["ceo", "orchestrator", "worker-5473"], "the entry is still listed");
});

test("(1) a paneless agent stays LISTED, in its own status: presence still means the seat exists, so a start is not repeated", () => {
  const { run } = herdr([{ name: "worker-5470", status: "unknown", pane: "w4N1:p1" }], ["w4N1:p1"]);
  const agents = readAgents(run)!;
  assert.deepEqual(agents.find((a) => a.label === "worker-5470"), { label: "worker-5470", status: "unknown", paneless: true });
});

test("(2) an order addressed to a PANELESS worker with an open row is dropped at the bound; the queue no longer holds it", () => {
  const dir = mkdtempSync(join(tmpdir(), "paneless-order-"));
  try {
    const queuePath = join(dir, HANDOFF_QUEUE_FILE);
    const prompt = "Sent to you by `ceo` (reply on the row):\n\nThe review of #5470 is still owed.";
    const order = queueHandoff(queuePath, { session: "worker-5470", prompt, now: NOW });
    const { run } = herdr([{ name: "worker-5470", status: "unknown", pane: "w4N1:p1" }], ["w4N1:p1"]);
    const agents = readAgents(run)!;
    // THE ROW IS OPEN: an open row's instance may yet start, so the holder's facts alone would keep this order for ever.
    const holder = (ref: number) => (ref === 5470 ? { open: true, sessions: ["worker-5470"] } : null);
    // The row the order carried is the fake code host's: the drop tells it by a comment there, and the `post` runner it is handed is never used.
    const host = createFakeCodeHost();
    host.rowsWorld.rows.set(5470, fakeRow(host.rowsWorld, 5470, { title: "row 5470" }));
    substituteCodeHost(host);
    const tick = (now: number) => dropUnknownHandoffs(readHandoffs(queuePath), { agents, roster: [], isLead: () => false, holder,
      post: noGh, queuePath, paused: false, now });

    const first = tick(NOW);
    assert.deepEqual(first.kept.map((h) => h.id), [order.id], "the first tick that sees it starts the clock and keeps it");
    const dropped = tick(NOW + UNKNOWN_SESSION_MS);
    assert.deepEqual(dropped.kept, [], "at the bound it is dropped");
    assert.equal(dropped.lines.length, 1, "one line says so");
    assert.match(dropped.lines[0], /^DROPPED /);
    assert.deepEqual(readHandoffs(queuePath).map((h) => h.id), [], "the queue no longer holds it");
    const told = host.rowsWorld.rows.get(5470)!.comments;
    assert.equal(told.length, 1, "the row the order carried is told once");
    assert.match(told[0].body, new RegExp(`Order ${order.id} was written for "worker-5470"`), "and the comment names the order and the session it was for");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(1) a paneless seat is not read as idle: `unknown` is in neither the statuses that may receive a prompt nor the statuses that mean nobody is working", () => {
  assert.equal(WAKEABLE.includes("unknown"), false);
  assert.equal(IDLE_STATUSES.includes("unknown"), false);
});

test("(2) the one line says what was treated as ended, ONCE per change in the paneless set, and says nothing for a readable org", () => {
  const said: string[] = [];
  const say = (line: string) => { said.push(line); };
  const one = herdr([{ name: "worker-5470", status: "unknown", pane: "w4N1:p1" }], ["w4N1:p1"]);
  readAgents(one.run, { say });
  readAgents(one.run, { say });
  assert.deepEqual(said, ["treated 1 listed agents with no pane as ended: worker-5470"], "two reads of the same set say it once");

  const two = herdr([{ name: "worker-5470", status: "unknown", pane: "w4N1:p1" }, { name: "worker-5472", status: "unknown", pane: "w4N5:p1" }], ["w4N1:p1", "w4N5:p1"]);
  readAgents(two.run, { say });
  assert.equal(said[1], "treated 2 listed agents with no pane as ended: worker-5470, worker-5472", "a new member is a change, so it is said");

  const reordered = herdr([{ name: "worker-5472", status: "unknown", pane: "w4N5:p1" }, { name: "worker-5470", status: "unknown", pane: "w4N1:p1" }], ["w4N1:p1", "w4N5:p1"]);
  readAgents(reordered.run, { say });
  assert.equal(said.length, 2, "the same paneless set in another listing order is not a change, so it is not said again");

  const none = herdr([{ name: "worker-5471", status: "unknown", pane: "w4N2:p1" }]);
  readAgents(none.run, { say });
  assert.equal(said.length, 2, "a live `unknown` agent with a readable pane says nothing");

  readAgents(one.run, { say });
  assert.equal(said.length, 3, "a set that comes back after a readable org is said again");
  assert.equal(said[2], "treated 1 listed agents with no pane as ended: worker-5470");
});

test("(3) a LIVE agent with `unknown` status and a readable pane is NOT treated as ended: its order with an open row is kept at the bound", () => {
  const dir = mkdtempSync(join(tmpdir(), "live-unknown-order-"));
  try {
    const queuePath = join(dir, HANDOFF_QUEUE_FILE);
    const order = queueHandoff(queuePath, { session: "worker-5471", prompt: "Sent to you by `ceo` (reply on the row):\n\nKeep going on #5471.", now: NOW });
    const { run } = herdr([{ name: "worker-5471", status: "unknown", pane: "w4N2:p1" }]);
    const agents = readAgents(run)!;
    assert.equal(agents.find((a) => a.label === "worker-5471")?.paneless, undefined);
    const holder = (ref: number) => (ref === 5471 ? { open: true, sessions: ["worker-5471"] } : null);
    const later = dropUnknownHandoffs(readHandoffs(queuePath), { agents, roster: [], isLead: () => false, holder, post: noGh, queuePath, paused: false, now: NOW });
    const bound = dropUnknownHandoffs(readHandoffs(queuePath), { agents, roster: [], isLead: () => false, holder, post: noGh, queuePath, paused: false, now: NOW + UNKNOWN_SESSION_MS });
    assert.deepEqual([later.kept.map((h) => h.id), bound.kept.map((h) => h.id), bound.lines], [[order.id], [order.id], []], "kept, and not dropped, past the bound");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
