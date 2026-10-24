// no-token: none -- a stand-in process, and one `node` child that runs a fixture file written to a temporary directory
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { runCommand, type CommandProcess } from "./command-exit.ts";

function fakeProcess() {
  const written: string[] = [];
  const proc: CommandProcess = Object.assign(new EventEmitter(), { exitCode: undefined as number | undefined, stderr: { write: (text: string) => written.push(text) } });
  return { proc, written };
}

test("a process that exits before the body settles gets one line that names the command", async () => {
  const { proc, written } = fakeProcess();
  const running = runCommand("start herdr --move", () => new Promise<number>(() => undefined), proc);
  proc.emit("exit", 13);
  assert.equal(written.length, 1);
  assert.match(written[0], /^agent-org start herdr --move: ended before it finished, waiting on something nothing could finish \(Node exit 13\)\. This is a bug in agent-org: what it printed above was done, and nothing after it was\.\n$/);
  assert.equal(proc.exitCode, undefined, "the wrapper does not change the exit code Node chose");
  void running;
});

test("a body that settles sets the exit code, says nothing, and leaves no listener on the process", async () => {
  const { proc, written } = fakeProcess();
  await runCommand("stop ui", async () => 3, proc);
  assert.equal(proc.exitCode, 3);
  assert.equal(proc.listenerCount("exit"), 0);
  proc.emit("exit", 0);
  assert.deepEqual(written, []);
});

test("a body that throws leaves no listener, and its error reaches the caller", async () => {
  const { proc } = fakeProcess();
  await assert.rejects(() => runCommand("update", async () => { throw new Error("boom"); }, proc), { message: "boom" });
  assert.equal(proc.listenerCount("exit"), 0);
});

test("a real process whose body never settles exits 13, as Node does, and names the command on stderr", () => {
  const dir = tmpDir("command-exit-");
  const fixture = join(dir, "never.ts");
  const wrapper = new URL("./command-exit.ts", import.meta.url).href;
  writeFileSync(fixture, `import { runCommand } from ${JSON.stringify(wrapper)};\nawait runCommand("fixture", () => new Promise<number>(() => {}));\n`);
  const result = spawnSync(process.execPath, [fixture], { encoding: "utf8" });
  assert.equal(result.status, 13);
  assert.match(result.stderr, /agent-org fixture: ended before it finished/);
});
