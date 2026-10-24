// no-token: gh -- the tool folder is a temporary directory and the process check is injected
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { createBoard } from "./server.ts";
import { parseTicketSettings } from "./settings.ts";
import { memoryDrain } from "./pool-fixture.ts";
import { nextVersion, toolFolderReads, type UpdateReads } from "./update-next.ts";

/** An update that holds its lock (process 4242, running) and is building `v0.280.0`, from an instance on `v0.273.0`; each field can be replaced. */
const reads = (over: Partial<UpdateReads> = {}): UpdateReads => ({ lockHolder: () => 4242, alive: (pid) => pid === 4242, building: () => ["v0.280.0"], current: () => "v0.273.0", ...over });

test("A11-217: while the update holds its lock and builds a folder, the target is that folder", () => {
  assert.equal(nextVersion("v0.273.0", reads()), "v0.280.0");
});

test("A11-217: once the build is renamed into place and current is swapped, the target is the version current names", () => {
  assert.equal(nextVersion("v0.273.0", reads({ building: () => [], current: () => "v0.280.0" })), "v0.280.0");
});

test("A11-217: an update with nothing newer builds nothing and leaves current where it is, so there is no target", () => {
  assert.equal(nextVersion("v0.273.0", reads({ building: () => [], current: () => "v0.273.0" })), null);
});

test("A11-217: with no lock there is no update under way, whatever else is on disk", () => {
  assert.equal(nextVersion("v0.273.0", reads({ lockHolder: () => null })), null);
  assert.equal(nextVersion("v0.273.0", reads({ lockHolder: () => null, building: () => [], current: () => "v0.280.0" })), null, "a current that moved on, with no lock, is a restart that has happened");
});

test("A11-217: a lock whose process is gone is an update that died, and names no target", () => {
  assert.equal(nextVersion("v0.273.0", reads({ alive: () => false })), null);
});

test("A11-217: of two folders being built, the newest by name is the target", () => {
  assert.equal(nextVersion("v0.273.0", reads({ building: () => ["v0.279.0", "v0.280.0"] })), "v0.280.0");
});

test("A11-217: an install with no current link and nothing building has no target", () => {
  assert.equal(nextVersion("v0.273.0", reads({ building: () => [], current: () => null })), null);
});

test("A11-217: the tool folder's reads: the lock's process, the .partial folders and the link current", () => {
  const tool = tmpDir("update-next-");
  // The test runner refuses `process.kill`, so the process check is the one seam replaced.
  const read = { ...toolFolderReads(tool), alive: () => true };
  assert.deepEqual([read.lockHolder(), read.building(), read.current()], [null, [], null], "a tool folder that is not laid says nothing");
  mkdirSync(join(tool, "versions", "v0.280.0.partial"), { recursive: true });
  mkdirSync(join(tool, "versions", "v0.279.0.partial"), { recursive: true });
  writeFileSync(join(tool, "versions", "v0.279.0.partial.tar"), "");
  mkdirSync(join(tool, "versions", "v0.280.0.ui.partial"), { recursive: true });
  mkdirSync(join(tool, "versions", "v0.273.0"), { recursive: true });
  symlinkSync(join("versions", "v0.273.0"), join(tool, "current"), "dir");
  writeFileSync(join(tool, "update.lock"), `${process.pid}\n`);
  assert.equal(read.lockHolder(), process.pid);
  assert.deepEqual(read.building().toSorted(), ["v0.279.0", "v0.280.0"], "only the folders being built, not the tar beside one nor a UI download's staging folder");
  assert.equal(read.current(), "v0.273.0");
  assert.equal(nextVersion("v0.273.0", read), "v0.280.0");
  writeFileSync(join(tool, "update.lock"), "not a number\n");
  assert.equal(read.lockHolder(), null, "a lock that holds no process id names no one");
});

/** A board over a throwaway state folder, told the version it runs and, through `next`, where an update is moving it. */
function boardWith(next: (() => string | null) | undefined) {
  const dir = tmpDir("ticket-next-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir });
  const pool = { tick: async () => {}, reviewNewHeads: () => {}, stopWriterRun: () => {}, stop: () => {}, close: () => {}, dismiss: async () => {}, remove: async () => {}, reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {}, releaseReviewers: () => {}, retargetStacked: () => {}, rebaseStacked: async () => {}, applyEdit: async () => {}, discardEdit: () => {}, respond: () => {} };
  return createBoard({ settings, source: createFakeTracker([]), codeHost: createFakeCodeHost(), key: "a".repeat(48), queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json"), pool, poolDeps: { drain: memoryDrain() },
    version: "v0.273.0", ...(next === undefined ? {} : { next }) });
}

test("A11-217: /api/queue tells the page the version an update is moving to, beside the version the instance runs, and null when none is", async () => {
  let moving: string | null = null;
  const { api } = boardWith(() => moving);
  const [, calm] = await api("GET", "/api/queue", {}) as [number, any];
  assert.deepEqual(calm.update, { version: "v0.273.0", note: null, next: null });
  moving = "v0.280.0";
  const [, building] = await api("GET", "/api/queue", {}) as [number, any];
  assert.deepEqual(building.update, { version: "v0.273.0", note: null, next: "v0.280.0" }, "a normal update leaves no drain note, and the page learns its target from next");
});

test("A11-217: a tool folder that cannot be read leaves /api/queue answering, with no target", async () => {
  const { api } = boardWith(() => { throw new Error("EACCES: versions/ cannot be read"); });
  const [status, queue] = await api("GET", "/api/queue", {}) as [number, any];
  assert.equal(status, 200);
  assert.equal(queue.update.next, null);
});

test("A11-217: with no seam, the board reads the tool folder of its own home, and a home with no tool folder (a checkout install) names no target", async () => {
  const kept = process.env.AGENT_ORG_HOME;
  process.env.AGENT_ORG_HOME = tmpDir("ticket-next-home-");
  try {
    const { api } = boardWith(undefined);
    const [, queue] = await api("GET", "/api/queue", {}) as [number, any];
    assert.equal(queue.update.next, null);
  } finally {
    if (kept === undefined) delete process.env.AGENT_ORG_HOME;
    else process.env.AGENT_ORG_HOME = kept;
  }
});
