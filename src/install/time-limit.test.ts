// no-token: none -- timers and promises only
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithin } from "./service.ts";
import { withinTime } from "./time-limit.ts";

test("a wait that never settles times out with a message that names it", async () => {
  await assert.rejects(() => withinTime(50, "waiting for x", new Promise(() => undefined)), { message: "`waiting for x` did not finish within 0.05s" });
});

test("a promise that settles first resolves with its value, and leaves no timer behind", async () => {
  const before = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  assert.equal(await withinTime(60_000, "y", Promise.resolve(7)), 7);
  assert.equal(process.getActiveResourcesInfo().filter((name) => name === "Timeout").length, before, "the 60 s timer is cleared, or it would hold the process open");
});

test("a promise that rejects first rejects with its own error, and leaves no timer behind", async () => {
  const before = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  await assert.rejects(() => withinTime(60_000, "z", Promise.reject(new Error("boom"))), { message: "boom" });
  assert.equal(process.getActiveResourcesInfo().filter((name) => name === "Timeout").length, before);
});

test("a command that does not finish is killed and answers a failed result that says so", () => {
  const result = runWithin(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], 200);
  assert.equal(result.status, null);
  assert.match(result.stderr, /^`.*node -e setTimeout\(\(\) => \{\}, 60000\)` did not finish within 0\.2s$/);
});

test("a command that finishes answers its own status and output", () => {
  assert.deepEqual(runWithin(process.execPath, ["-e", "process.stdout.write('hi'); process.exit(3)"], 20_000), { status: 3, stdout: "hi", stderr: "" });
  assert.match(runWithin("/nonexistent/agent-org-test", [], 1_000).stderr, /ENOENT/);
});
