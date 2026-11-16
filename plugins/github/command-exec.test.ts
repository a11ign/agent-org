// no-token: gh -- every program run here is this Node running a script of the test's own: no gh runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandExecAsync } from "./command-exec.ts";

/** This Node running `script`, as a command's `deps.execAsync` runs `gh`. */
const node = (script: string, options: Parameters<typeof commandExecAsync>[2] = {}) => commandExecAsync(process.execPath, ["-e", script], options);

test("A11-433: commandExecAsync runs the program without holding the event loop, and answers its status and what it printed", async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  try {
    const result = await node("setTimeout(() => { process.stdout.write('out'); process.stderr.write('err'); process.exit(3); }, 300)");
    assert.deepEqual(result, { status: 3, stdout: "out", stderr: "err" });
    assert.ok(ticks >= 5, `the loop turned while the program ran (${ticks} ticks of 10 ms in 300 ms)`);
  } finally {
    clearInterval(timer);
  }
});

test("A11-433: commandExecAsync runs the program under the options' environment laid over this process's", async () => {
  const result = await node("process.stdout.write(`${process.env.WANT}:${process.env.PATH === undefined ? 'no PATH' : 'PATH'}`)", { env: { WANT: "given" } });
  assert.deepEqual(result, { status: 0, stdout: "given:PATH", stderr: "" });
});

test("A11-433: commandExecAsync gives the program no input, so one that reads its stdin reads its end at once", async () => {
  const result = await node("let read = ''; process.stdin.on('data', (c) => { read += c; }).on('end', () => process.stdout.write(`ended:${read.length}`))", { timeoutMs: 5_000 });
  assert.deepEqual(result, { status: 0, stdout: "ended:0", stderr: "" });
});

test("A11-433: commandExecAsync answers no status and the reason when the program cannot start", async () => {
  assert.deepEqual(await commandExecAsync("/nonexistent/gh", ["auth", "status"]), { status: null, stdout: "", stderr: "spawn /nonexistent/gh ENOENT" });
});

test("A11-433: commandExecAsync stops a program that runs past its time, and answers no status and ETIMEDOUT", async () => {
  const started = Date.now();
  const result = await node("setTimeout(() => {}, 60_000)", { timeoutMs: 200 });
  assert.deepEqual(result, { status: null, stdout: "", stderr: `spawn ${process.execPath} ETIMEDOUT` });
  assert.ok(Date.now() - started < 10_000, "the program was stopped at its time, not left to run its minute");
});

test("A11-433: commandExecAsync stops a program that prints more than it reads, and answers no status and ENOBUFS", async () => {
  const result = await node("const chunk = 'x'.repeat(1 << 20); let left = 80; const more = () => { while (left > 0) { left -= 1; if (!process.stdout.write(chunk)) return process.stdout.once('drain', more); } }; more();", { timeoutMs: 30_000 });
  assert.deepEqual(result, { status: null, stdout: "", stderr: `spawn ${process.execPath} ENOBUFS` });
});

test("A11-433: commandExecAsync answers at its time even when a grandchild still holds the program's output, as spawnSync returned", async () => {
  const grandchild = "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', 'inherit', 'inherit'] }); setTimeout(() => {}, 60_000)";
  const started = Date.now();
  const result = await node(grandchild, { timeoutMs: 300 });
  assert.deepEqual(result, { status: null, stdout: "", stderr: `spawn ${process.execPath} ETIMEDOUT` });
  assert.ok(Date.now() - started < 3_000, `answered ${Date.now() - started} ms after the start, not when the grandchild let go of the pipes`);
});

test("A11-433: commandExecAsync bounds stdout and stderr together, as spawnSync did: 40 MiB on each is more than it reads", async () => {
  const both = "const chunk = 'x'.repeat(1 << 20); let left = 40; const more = () => { while (left > 0) { left -= 1; const out = process.stdout.write(chunk); const err = process.stderr.write(chunk); if (!out || !err) { let wait = (out ? 0 : 1) + (err ? 0 : 1); const go = () => { wait -= 1; if (wait === 0) more(); }; if (!out) process.stdout.once('drain', go); if (!err) process.stderr.once('drain', go); return; } } }; more();";
  assert.deepEqual(await node(both, { timeoutMs: 30_000 }), { status: null, stdout: "", stderr: `spawn ${process.execPath} ENOBUFS` });
});

test("A11-433: commandExecAsync answers no status when a signal ends the program, with what it printed", async () => {
  assert.deepEqual(await node("process.stdout.write('before'); process.kill(process.pid, 'SIGKILL')"), { status: null, stdout: "before", stderr: "" });
});
