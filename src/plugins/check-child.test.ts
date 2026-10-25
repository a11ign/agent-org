// no-token: none -- a scratch host file that enables the local exposure plugin, whose checks probe loopback ports: no tracker or code host is asked
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { type CheckRequest, foundInChild, foundOf, runInGroup } from "./check-child.ts";

/** A request for `plugin`'s checks over a scratch host file whose exposure is the local plugin. */
function requestOf(plugin: string | null, hostPath?: string): CheckRequest {
  const dir = tmpDir("check-child-");
  const path = hostPath ?? join(dir, "host.json");
  if (hostPath === undefined) writeFileSync(path, JSON.stringify({ stateDir: dir, tickets: { providers: { exposure: { provider: "local", enabled: true } } } }));
  return { hostPath: path, plugin, stateDir: dir, pick: "assigned", clones: {} };
}

test("A11-270: a plugin's checks run in a process of their own say what they say in this one", async () => {
  const request = requestOf("local");
  const here = await foundOf(request);
  assert.ok(here.checks.length > 0, "the local plugin has checks");
  assert.deepEqual(await foundInChild(request, 60_000), here);
});

test("A11-270: the messaging plugin is read in the child too: a host that declares no project enables none, and has no checks", async () => {
  const request = requestOf(null);
  assert.deepEqual(await foundInChild(request, 60_000), { provider: null, checks: [] });
  assert.deepEqual(await foundOf(request), { provider: null, checks: [] });
});

test("A11-270: checks that throw in the child are thrown here with their own message", async () => {
  const program = join(tmpDir("check-child-throws-"), "throws.mjs");
  writeFileSync(program, `process.stdout.write(JSON.stringify({ error: "no keychain" }));`);
  await assert.rejects(foundInChild(requestOf("local"), 60_000, program), (error: Error) => error.message === "no keychain");
});

test("A11-270: a child still running at its limit is stopped, and the reason says so", async () => {
  await assert.rejects(foundInChild(requestOf("local"), 1), /^Error: the checks were stopped after 0\.001 seconds$/);
});

/** Waits up to two seconds for `pid` to end, and answers whether it is still alive. */
async function stillAlive(pid: number): Promise<boolean> {
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i += 1) await new Promise((done) => { setTimeout(done, 40); });
  return alive();
}

/** A check that starts a program and then waits on another, as `spawnSync` does: neither ends by itself. The program's pid is written to `pidFile`. */
function hangingCheck(dir: string, pidFile: string): string {
  const program = join(dir, "hangs.mjs");
  writeFileSync(program, `import { spawn, spawnSync } from "node:child_process"; import { writeFileSync } from "node:fs";
const started = spawn("sleep", ["30"], { stdio: "ignore" }); writeFileSync(${JSON.stringify(pidFile)}, String(started.pid)); spawnSync("sleep", ["30"]);`);
  return program;
}

test("A11-270: a board that exits leaves no check behind it: its running children, and the programs they started, are stopped with it", async () => {
  const dir = tmpDir("check-child-exit-");
  const pidFile = join(dir, "pid");
  const board = join(dir, "board.mjs");
  writeFileSync(board, `import { existsSync } from "node:fs"; import { runInGroup } from ${JSON.stringify(new URL("./check-child.ts", import.meta.url).href)};
void runInGroup([${JSON.stringify(hangingCheck(dir, pidFile))}], 60_000);
const wait = setInterval(() => { if (existsSync(${JSON.stringify(pidFile)})) { clearInterval(wait); process.exit(0); } }, 20);`);
  const exited = spawnSync(process.execPath, [board], { timeout: 30_000, encoding: "utf8" });
  assert.equal(exited.status, 0, exited.stderr);
  assert.equal(await stillAlive(Number(readFileSync(pidFile, "utf8"))), false, "the program the check started ended with the board");
});

test("A11-270: stopping a child at its limit stops the programs its checks started too", async () => {
  const dir = tmpDir("check-child-group-");
  const pidFile = join(dir, "pid");
  const result = await runInGroup([hangingCheck(dir, pidFile)], 1_000);
  assert.equal(result.stopped, true);
  assert.equal(await stillAlive(Number(readFileSync(pidFile, "utf8"))), false, "the program the check started is stopped with it");
});
