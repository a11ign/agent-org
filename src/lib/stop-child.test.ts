// no-token: none -- starts and stops local node processes; nothing here reaches `gh`, `herdr` or `git`
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stopChild } from "./stop-child.ts";

/** Starts a node process that runs until stopped (ignoring SIGTERM when asked), stops it with `graceMs`, and returns the signal it died of. */
async function signalThatStopped(ignoreTerm: boolean, graceMs: number): Promise<NodeJS.Signals | null> {
  const child = spawn(process.execPath, ["-e", `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ""} setInterval(() => {}, 1000);`], { stdio: "ignore" });
  await new Promise((done) => setTimeout(done, 200));
  await stopChild(child, graceMs);
  return child.signalCode;
}

test("#2034: stopChild resolves only once the child has exited on SIGTERM", async () => {
  assert.equal(await signalThatStopped(false, 10_000), "SIGTERM");
});

test("#2034: a child that ignores SIGTERM is killed after the grace, and stopChild resolves once it is gone", async () => {
  assert.equal(await signalThatStopped(true, 300), "SIGKILL");
});

test("#2034: stopping a child that has already exited resolves at once", async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((done) => child.once("exit", done));
  await stopChild(child, 10_000);
  assert.equal(child.exitCode, 0);
});
