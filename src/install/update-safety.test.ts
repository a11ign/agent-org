// no-token: none -- the status file is a temporary one
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { readUpdateStatus, writeUpdateStatus, type UpdateStatus } from "./update-safety.ts";

test("A11-90: the status file is written whole and read back; an absent one is no status, and an unreadable or corrupt one is never read as clean", () => {
  const path = join(tmpDir("update-status-"), "update-status.json");
  const status: UpdateStatus = { checkedAt: "2026-10-18T10:00:00.000Z", channel: "release", installed: "v0.243.0", latest: "v0.248.0", latestSince: "2026-10-17T08:00:00.000Z" };
  writeUpdateStatus(path, status);
  assert.deepEqual(readUpdateStatus(path), { kind: "status", status });
  assert.deepEqual(readUpdateStatus(join(tmpDir("update-status-"), "none.json")), { kind: "absent" }, "a file that is not there is no status yet");
  assert.deepEqual(readUpdateStatus("unused", () => null), { kind: "absent" });
  const denied = readUpdateStatus("unused", () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); });
  assert.deepEqual(denied, { kind: "unreadable", why: "EACCES: permission denied" }, "a file that cannot be read is not an absent one");
  assert.equal(readUpdateStatus("unused", () => "{ not json").kind, "unreadable");
  assert.deepEqual(readUpdateStatus("unused", () => JSON.stringify({ ...status, channel: "nightly" })), { kind: "unreadable", why: "it is not an update status" });
});

test("A11-169: a status file an earlier version wrote, with a deferral in it, reads as a status without the deferral, and is written again without it", () => {
  const path = join(tmpDir("update-status-"), "update-status.json");
  const status: UpdateStatus = { checkedAt: "2026-10-18T10:00:00.000Z", channel: "release", installed: "v0.243.0", latest: "v0.248.0", latestSince: "2026-10-17T08:00:00.000Z" };
  const old = readUpdateStatus("unused", () => JSON.stringify({ ...status, deferredSince: "2026-10-18T09:00:00.000Z", deferredReason: "herdr is inside" }));
  assert.deepEqual(old, { kind: "status", status });
  writeUpdateStatus(path, old.kind === "status" ? old.status : status);
  assert.equal(readFileSync(path, "utf8").includes("deferred"), false);
});
