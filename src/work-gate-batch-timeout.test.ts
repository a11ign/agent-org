// no-token: gh -- `gh` is never reached: a stub `gh` is put first on PATH, and the calls the batch makes are its own.
/**
 * a11ign/a11ign#3843: A BATCHED `gh` CALL IS CUT LIKE A SINGLE ONE.
 *
 * `BATCH_WORKER` started its calls with `execFile` and no `timeout`, and the `execFileSync` around the worker had none either, so one stalled `gh` held
 * the whole batch (and the tick, bounded only by its unit's `TimeoutStartSec`) where `defaultRun` cuts the same call at 30 s. Pinned:
 *   - the control: a batch whose first call never answers ends at about the bound, and the second call's answer is intact;
 *   - a cut call answers as a refused one (`failed`, `status: null`, `code: "ETIMEDOUT"`, its stderr), so a caller's fail-open verdict stands;
 *   - through `readWithFirstWaveTogether` the cut call is the throw `execFileSync` makes and its neighbour still reads;
 *   - the worker's own wait is longer than the call's: a worker that cannot report is killed, and `runBatch` throws rather than waiting on it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BATCH_OUTER_GRACE_MS, GH_READ_TIMEOUT_MS, readWithFirstWaveTogether, runBatch } from "./work-gate.mjs";

const CALL_MS = 500;
const STALL_SECONDS = 30;

/** Runs `body` with a stub `gh` first on PATH. `exec sleep` replaces the shell, so the kill reaches the sleeper and not an orphan holding the pipe. */
function withStub<T>(script: string, body: (env: NodeJS.ProcessEnv) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "batch-timeout-"));
  try {
    writeFileSync(join(dir, "gh"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, "gh"), 0o755);
    return body({ ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_REPO: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const STALLS_FIRST = `if [ "$1" = stall ]; then exec sleep ${STALL_SECONDS}; fi\necho "$1"`;

test("CONTROL: a batch whose first call never answers ends at about the bound, and the second call's answer is intact", () => {
  withStub(STALLS_FIRST, (env) => {
    const began = Date.now();
    const answers = runBatch([{ args: ["stall"], repo: undefined }, { args: ["fine"], repo: undefined }], env, CALL_MS);
    const waited = Date.now() - began;
    assert.ok(waited < STALL_SECONDS * 1000 / 3, `waited ${waited} ms for a call bounded at ${CALL_MS} ms, stalling ${STALL_SECONDS} s`);
    assert.deepEqual(answers[1], { stdout: "fine\n" });
  });
});

test("a cut call answers as a refused one: failed, no exit status, ETIMEDOUT as `ghWithin` throws it", () => {
  withStub(`if [ "$1" = stall ]; then echo "slow" >&2; exec sleep ${STALL_SECONDS}; fi`, (env) => {
    const [cut] = runBatch([{ args: ["stall"], repo: undefined }, { args: ["fine"], repo: undefined }], env, CALL_MS);
    assert.ok("failed" in cut);
    assert.equal(cut.status, null);
    assert.equal(cut.code, "ETIMEDOUT");
    assert.equal(cut.stderr, "slow\n");
  });
});

test("through readWithFirstWaveTogether the cut call is a thrown refusal and its neighbour still reads", () => {
  withStub(STALLS_FIRST, (env) => {
    const read = (run: (args: string[]) => string) => {
      const outcome = [];
      for (const word of ["stall", "fine"]) {
        try { outcome.push(run([word])); } catch (error) { outcome.push(`refused:${(error as { code?: string }).code}`); }
      }
      return outcome;
    };
    const seen = readWithFirstWaveTogether(read, () => assert.fail("a call the batch answered must not run on its own"),
      (calls) => runBatch(calls, env, CALL_MS), () => undefined);
    assert.deepEqual(seen, ["refused:ETIMEDOUT", "fine\n"]);
  });
});

test("the batch's default bound is the one a single `gh` gets, and the worker's wait is longer than it", () => {
  assert.equal(GH_READ_TIMEOUT_MS, 30_000);
  assert.ok(BATCH_OUTER_GRACE_MS > 0);
});

test("a worker that does not finish is killed at the outer bound, and `runBatch` throws rather than waiting on it", () => {
  // A preloaded timer keeps the worker alive after it has printed, standing for a worker that cannot report: only the outer bound can end it.
  const dir = mkdtempSync(join(tmpdir(), "batch-hang-"));
  try {
    const hang = join(dir, "hang.cjs");
    writeFileSync(hang, `setTimeout(() => {}, ${STALL_SECONDS * 1000});\n`);
    withStub("echo fine", (env) => {
      const began = Date.now();
      assert.throws(() => runBatch([{ args: ["x"], repo: undefined }], { ...env, NODE_OPTIONS: `--require=${hang}` }, CALL_MS), { code: "ETIMEDOUT" });
      const waited = Date.now() - began;
      assert.ok(waited < CALL_MS + BATCH_OUTER_GRACE_MS + 3000, `waited ${waited} ms`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
