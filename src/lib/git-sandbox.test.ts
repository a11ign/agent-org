/**
 * A11-301: `withGitSandbox` (this repository's, over the toolchain's) removes a sandbox a late writer is still putting files into, and refuses, naming what
 * is in it, one that cannot be removed. `src/lib/git-sandbox.ts` says what CI saw and what was not established.
 *
 *   (1) THE LEFTOVER, REPRODUCED -- a child process writes into the sandbox's `.git/objects` in a tight loop for 600 ms, starting before the removal.
 *       The toolchain's own helper is refused (CONTROL, so the writer really does defeat one removal); this repository's returns, with the directory gone
 *       and still gone when the writer has exited.
 *   (2) NOTHING IS SWALLOWED -- a removal that never takes effect is still `SandboxNotRemovedError`, after the survivor has been described; a refusal
 *       that is not transient is thrown on the first try.
 *   (3) THE USUAL WRITER IS NOT STARTED -- the sandbox repository has `maintenance.auto=false` and `gc.auto=0`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withGitSandbox as toolchainWithGitSandbox } from "@a11ign/toolchain/lib/git-sandbox";
import { describeSurvivor, pause, removeUntilSettled, withGitSandbox, type GitSandbox } from "./git-sandbox.ts";

const WRITER_MS = 600;
const WRITER_POLL_MS = 5;
const WRITER_START_LIMIT_MS = 5000;
const WRITER = `
const { mkdirSync, writeFileSync } = require("node:fs");
const [dir, ms] = process.argv.slice(1);
const end = Date.now() + Number(ms);
writeFileSync(dir + "/.writer-started", "");
for (let n = 0; Date.now() < end; n++) {
  try { mkdirSync(dir + "/.git/objects/late", { recursive: true }); writeFileSync(dir + "/.git/objects/late/f" + (n % 50), "x"); } catch {}
}
`;

/** Start the writer in `box` and return once it is writing, so the removal that follows is the removal it is racing. */
function startWriter(box: GitSandbox, started: ChildProcess[]): void {
  const child = spawn(process.execPath, ["-e", WRITER, box.dir, String(WRITER_MS)], { stdio: "ignore" });
  started.push(child);
  for (let waited = 0; !existsSync(join(box.dir, ".writer-started")); waited += WRITER_POLL_MS) {
    assert.ok(waited < WRITER_START_LIMIT_MS, "the writer started");
    pause(WRITER_POLL_MS);
  }
}

const exited = (child: ChildProcess): Promise<void> => new Promise((done) => { child.once("exit", () => done()); });

test("A11-301 (1) CONTROL: the writer defeats the toolchain's helper -- it is refused, or the directory is back once the writer is done", async () => {
  const started: ChildProcess[] = [];
  let dir = "";
  let refused: unknown;
  try {
    toolchainWithGitSandbox((box) => { dir = box.dir; startWriter(box, started); });
  } catch (error) {
    refused = error;
  }
  await Promise.all(started.map(exited));
  const back = existsSync(dir);
  rmSync(dir, { recursive: true, force: true });
  assert.ok(refused !== undefined || back, "one removal, one writer: either the helper threw, or the writer's last file put the directory back after the helper's existence check");
});

test("A11-301 (1) BEHAVIOUR: this repository's helper waits out the same writer, and the directory is gone when it has finished", async () => {
  const started: ChildProcess[] = [];
  let dir = "";
  withGitSandbox((box) => { dir = box.dir; startWriter(box, started); });
  assert.ok(dir.length > 0);
  assert.equal(existsSync(dir), false, "gone when the helper returns");
  await Promise.all(started.map(exited));
  assert.equal(existsSync(dir), false, "and still gone when the writer has exited: nothing was left for the file's own cleanup");
});

test("A11-301 (2) CONTROL: a removal that never takes effect is still SandboxNotRemovedError, and the survivor is described first", () => {
  const lines: string[] = [];
  let dir = "";
  assert.throws(
    () => withGitSandbox((box) => { dir = box.dir; }, undefined, { remove: () => {}, attempts: 3, pauseMs: 1, report: (line) => lines.push(line) }),
    (error: unknown) => error instanceof Error && error.name === "SandboxNotRemovedError" && error.message.includes(dir),
  );
  assert.equal(lines.length, 1);
  assert.ok(lines[0]?.includes(dir) && lines[0].includes(".git"), `the report names the directory and what is in it: ${lines[0]}`);
  rmSync(dir, { recursive: true, force: true });
});

test("A11-301 (2) BEHAVIOUR: the last transient refusal is named in the report, so its errno is not lost when the directory survives", () => {
  const lines: string[] = [];
  let dir = "";
  assert.throws(
    () => withGitSandbox((box) => { dir = box.dir; }, undefined, {
      remove: () => { throw Object.assign(new Error("busy"), { code: "ENOTEMPTY" }); },
      attempts: 2,
      pauseMs: 1,
      report: (line) => lines.push(line),
    }),
    (error: unknown) => error instanceof Error && error.name === "SandboxNotRemovedError",
  );
  assert.match(lines[0] ?? "", /last refusal: ENOTEMPTY/);
  rmSync(dir, { recursive: true, force: true });
});

test("A11-301 (2) BEHAVIOUR: a refusal that is not transient is thrown on the first try, not retried", () => {
  const dir = join(process.env.TMPDIR ?? "/tmp", "never-made");
  let calls = 0;
  const refusal = Object.assign(new Error("denied"), { code: "EACCES" });
  assert.throws(() => removeUntilSettled(dir, { remove: () => { calls++; throw refusal; }, attempts: 5, pauseMs: 1 }), refusal);
  assert.equal(calls, 1);
});

test("A11-301 (2) BEHAVIOUR: a transient refusal is run again, and a directory that comes back during the settle is removed again", () => {
  const dir = join(process.env.TMPDIR ?? "/tmp", "a11-301-settle");
  mkdirSync(dir, { recursive: true });
  try {
    let calls = 0;
    removeUntilSettled(dir, {
      remove: (target) => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("busy"), { code: "ENOTEMPTY" });
        rmSync(target, { recursive: true, force: true });
        if (calls === 2) mkdirSync(target); // the writer's mkdir, between the removal and the settle check
      },
      attempts: 5,
      pauseMs: 1,
      settleMs: 1,
    });
    assert.equal(calls, 3);
    assert.equal(existsSync(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A11-301 (2) describeSurvivor names the entries, and says so when it cannot list", () => {
  const dir = join(process.env.TMPDIR ?? "/tmp", "a11-301-survivor");
  mkdirSync(join(dir, ".git/objects"), { recursive: true });
  try {
    writeFileSync(join(dir, ".git/objects/maintenance.lock"), "");
    const line = describeSurvivor(dir);
    assert.match(line, /holds 3 entries/);
    assert.match(line, /\.git\/objects\/maintenance\.lock/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(describeSurvivor(dir), /could not be listed after its removal \(ENOENT\)/);
});

test("A11-301 (3) BEHAVIOUR: the sandbox repository is made with automatic maintenance off", () => {
  withGitSandbox((box) => {
    assert.equal(box.run(["config", "--get", "maintenance.auto"]).trim(), "false");
    assert.equal(box.run(["config", "--get", "gc.auto"]).trim(), "0");
  });
});
