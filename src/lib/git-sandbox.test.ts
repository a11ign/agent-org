/**
 * A11-301: `withGitSandbox` (this repository's, over the toolchain's) removes a sandbox a late writer is still putting files into, and refuses, naming what
 * is in it, one that cannot be removed. `src/lib/git-sandbox.ts` says what CI saw and what was not established.
 *
 *   (1) THE LEFTOVER, REPRODUCED -- a removal that a late writer undoes (a file put back into `.git/objects` after `rmSync` returned). The toolchain's
 *       own helper is refused (CONTROL, so the leftover is the one that raises the error); this repository's removes the tree again, until it is gone.
 *       A writer that is a real process on a clock was tried first and was flaky on a loaded runner; see `lateWriter`.
 *   (2) NOTHING IS SWALLOWED -- a removal that never takes effect is still `SandboxNotRemovedError`, after the survivor has been described; a refusal
 *       that is not transient is thrown on the first try.
 *   (3) THE USUAL WRITER IS NOT STARTED -- the sandbox repository has `maintenance.auto=false` and `gc.auto=0`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withGitSandbox as toolchainWithGitSandbox } from "@a11ign/toolchain/lib/git-sandbox";
import { describeSurvivor, removeUntilSettled, withGitSandbox } from "./git-sandbox.ts";

/** How many removals a late writer undoes, in `lateWriter`. */
const UNDONE_REMOVALS = 2;

/**
 * A removal that a late writer undoes: the tree is removed, and then the writer puts a file back into `.git/objects`, as a detached `git` would. The first
 * `undone` removals are undone, so what is left after them is a directory that exists although `rmSync` returned. Driven by call count and not by a child
 * process on a clock: CI's first version of this test used a child writing for 600 ms, and on a loaded runner the child was descheduled for longer than the
 * helper waited (or ran out before the removal), so the test passed or failed with the load and not with the helper.
 */
function lateWriter(undone: number): { remove: (dir: string) => void; removals: () => number } {
  let removals = 0;
  return {
    remove: (dir) => {
      removals++;
      rmSync(dir, { recursive: true, force: true });
      if (removals <= undone) {
        mkdirSync(join(dir, ".git/objects/late"), { recursive: true });
        writeFileSync(join(dir, ".git/objects/late/f"), "x");
      }
    },
    removals: () => removals,
  };
}

test("A11-301 (1) CONTROL: after a removal that a late writer undoes, the toolchain's helper refuses with SandboxNotRemovedError", () => {
  const writer = lateWriter(UNDONE_REMOVALS);
  let dir = "";
  assert.throws(
    () => toolchainWithGitSandbox((box) => { dir = box.dir; }, undefined, { remove: writer.remove }),
    (error: unknown) => error instanceof Error && error.name === "SandboxNotRemovedError" && error.message.includes(dir),
  );
  assert.equal(writer.removals(), 1, "the toolchain's helper removes once");
  rmSync(dir, { recursive: true, force: true });
});

test("A11-301 (1) BEHAVIOUR: this repository's helper removes the whole tree again, and the directory is gone when it returns", () => {
  const writer = lateWriter(UNDONE_REMOVALS);
  let dir = "";
  withGitSandbox((box) => { dir = box.dir; }, undefined, { remove: writer.remove, pauseMs: 1, settleMs: 1 });
  assert.ok(dir.length > 0);
  assert.equal(existsSync(dir), false, "gone when the helper returns");
  assert.equal(writer.removals(), UNDONE_REMOVALS + 1, "one removal per undoing, and the one that held");
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
