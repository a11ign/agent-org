// no-token: none -- `exec` answers from a table, and the real-process case puts a stub `gh` first on PATH: the real one is never reached
/**
 * A11-160 (step 9): THE RUNNER `pr-open` ASKS THE CODE HOST FOR GIVES `gh` THE TERMINAL, NO BOUND, AND THE VARIABLES THE GATE'S WRAPPER READS, ON THE CHILD ALONE. `pr:open create` is the one call whose output the author
 * reads as it is printed, and the wrapper exits 75 for a create it held for a rate limit: the status must come back, and the variable that lets the create through (#4397) must be on the child and on nothing else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult } from "../../../src/plugins/manifest.ts";
import { realExec } from "../../../src/plugins/real-seams.ts";
import { runnerWith } from "./runners.ts";

test("a runner with `inherit` and `env` hands the process the terminal and the variables, and nothing else it was not asked for", () => {
  const called: { args: readonly string[]; options: ExecOptions }[] = [];
  const exec = (_file: string, args: readonly string[], options: ExecOptions = {}): ExecResult => { called.push({ args, options }); return { status: 0, stdout: "", stderr: "", signal: null }; };
  const deps = { exec, execAsync: () => Promise.reject(new Error("not asked")), log: () => undefined, env: {} };
  runnerWith(deps, { inherit: true, env: { A11Y_PR_OPEN: "1" } })(["pr", "create"]);
  assert.deepEqual(called, [{ args: ["pr", "create"], options: { inherit: true, env: { A11Y_PR_OPEN: "1" } } }]);
  runnerWith(deps)(["pr", "list"]);
  assert.deepEqual(called[1].options, {}, "a runner that asks for neither inherits nothing");
});

test("#4898 AND #4397 THROUGH THE REAL PROCESS: the child carries the variable and this process does not; the wrapper's exit 75 comes back as a failure with that status", () => {
  const root = mkdtempSync(join(tmpdir(), "runners-inherit-"));
  const seen = join(root, "seen");
  writeFileSync(join(root, "gh"), `#!/bin/sh\necho "\${A11Y_PR_OPEN:-unset} \${A11Y_GH_QUEUED_TO:-unset} $*" > "${seen}"\nexit 75\n`, { mode: 0o755 });
  chmodSync(join(root, "gh"), 0o755);
  const { PATH, A11Y_PR_OPEN: before } = process.env;
  const logged: string[] = [];
  try {
    delete process.env.A11Y_PR_OPEN;
    process.env.PATH = `${root}:${PATH ?? ""}`;
    const run = runnerWith({ exec: realExec, execAsync: () => Promise.reject(new Error("not asked")), log: (line) => { logged.push(line); }, env: process.env },
      { inherit: true, env: { A11Y_PR_OPEN: "1", A11Y_GH_QUEUED_TO: "/tmp/entry" } });
    assert.throws(() => run(["pr", "create", "--draft"]), (error: Error & { status?: number }) => error.status === 75);
    assert.equal(readFileSync(seen, "utf8").trim(), "1 /tmp/entry pr create --draft");
    assert.equal(process.env.A11Y_PR_OPEN, undefined, "the variable is on the child only, so the row's Acceptance command never inherits it");
    assert.deepEqual(logged, [], "the terminal is the child's own: nothing is re-printed");
  } finally {
    process.env.PATH = PATH;
    if (before !== undefined) process.env.A11Y_PR_OPEN = before;
    rmSync(root, { recursive: true, force: true });
  }
});
