// no-token: none -- starts and stops local node processes; nothing here reaches `gh`, `herdr` or `git`
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { isRunning, stopChild, stopGroup } from "./stop-child.ts";

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


/** Starts a group leader that starts a program of its own (a `sleep`), and answers both, once the program runs. */
async function leaderWithProgram(ignoreTerm: boolean): Promise<Readonly<{ leader: ReturnType<typeof spawn>; program: number }>> {
  const script = `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ""} const p = require('node:child_process').spawn('sleep', ['60'], { stdio: 'ignore' }); console.log(p.pid); setInterval(() => {}, 1000);`;
  const leader = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  const program = await new Promise<number>((done) => { leader.stdout?.once("data", (chunk: Buffer) => done(Number(chunk.toString().trim()))); });
  return { leader, program };
}

test("A11-449: stopGroup resolves only once the program the child started is gone too: stopChild leaves it running", async () => {
  const { leader, program } = await leaderWithProgram(false);
  await stopChild(leader, 10_000);
  assert.equal(isRunning(program), true, "stopChild waits for the child alone, and its program outlives it");
  assert.equal(await stopGroup(leader, 10_000), true, "stopGroup answers that the group is gone");
  assert.equal(isRunning(program), false, "stopGroup kills what is left of the group, and waits for it");
});

test("A11-449: stopGroup stops a group whose leader ignores SIGTERM, with the program it started", async () => {
  const { leader, program } = await leaderWithProgram(true);
  assert.equal(await stopGroup(leader, 300), true);
  assert.equal(leader.signalCode, "SIGKILL");
  assert.equal(isRunning(program), false);
});
