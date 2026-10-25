// no-token: none -- the only program run is a stand-in `tailscale` in this file's own temporary directory, first on PATH; the real one is never reached
/**
 * A11-279: A TEST NEVER RUNS THE REAL `tailscale`. On 2026-10-25 a test reached the real Tailscale plugin's `release` through `realExec`, and the agents host's live serves (:9443, :9444) went
 * off twice. The stand-in here records every call it is given, so "refused" means nothing was spawned at all, not that the call failed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_ROOT_ENV } from "../private-tmp.ts";
import { runWithin } from "../install/service.ts";
import { realExec, realExecAsync, refuseUnderTests, TAILSCALE_OPT_IN_ENV, TAILSCALE_UNDER_TESTS } from "./real-seams.ts";

/** A directory holding a `tailscale` and an `other` that append their arguments to `calls.log`, and the env that puts it first on PATH. */
function standIn() {
  const dir = mkdtempSync(join(tmpdir(), "real-seams-"));
  const log = join(dir, "calls.log");
  for (const name of ["tailscale", "other"]) {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n`);
    chmodSync(join(dir, name), 0o755);
  }
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { dir, calls, env: { PATH: `${dir}:${process.env.PATH ?? ""}` }, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the premise: this test runs under the test runner's run root, which only rstest's globalSetup sets", () => {
  assert.ok(process.env[RUN_ROOT_ENV], `${RUN_ROOT_ENV} is set`);
});

test("A11-279: under the test runner `tailscale` is refused before anything is spawned, by realExec, realExecAsync and the service's own run", async () => {
  const shim = standIn();
  try {
    const sync = realExec("tailscale", ["serve", "--https=9443", "off"], { env: shim.env });
    assert.deepEqual(sync, { status: null, stdout: "", stderr: TAILSCALE_UNDER_TESTS, spawnError: TAILSCALE_UNDER_TESTS, signal: null });
    const async = await realExecAsync("tailscale", ["serve", "--https=9444", "off"], { env: shim.env });
    assert.equal(async.status, null);
    assert.equal(async.spawnError, TAILSCALE_UNDER_TESTS);
    const previousPath = process.env.PATH;
    process.env.PATH = shim.env.PATH;
    try {
      assert.deepEqual(runWithin("tailscale", ["serve", "status", "--json"], 5_000), { status: null, stdout: "", stderr: TAILSCALE_UNDER_TESTS });
    } finally {
      process.env.PATH = previousPath;
    }
    assert.deepEqual(shim.calls(), [], "the stand-in first on PATH recorded no call");
  } finally {
    shim.done();
  }
});

test("A11-279: a test that opts in on purpose runs its stand-in, and so does a process outside the test runner", async () => {
  const shim = standIn();
  try {
    assert.equal(realExec("tailscale", ["status"], { env: { ...shim.env, [TAILSCALE_OPT_IN_ENV]: "1" } }).status, 0);
    assert.equal((await realExecAsync("tailscale", ["version"], { env: { ...shim.env, [TAILSCALE_OPT_IN_ENV]: "1" } })).status, 0);
    assert.equal(realExec("tailscale", ["serve", "status"], { env: shim.env, withoutEnv: [RUN_ROOT_ENV] }).status, 0);
    assert.deepEqual(shim.calls(), ["tailscale status", "tailscale version", "tailscale serve status"]);
  } finally {
    shim.done();
  }
});

test("A11-279: only `tailscale` is refused: another program runs under the test runner", () => {
  const shim = standIn();
  try {
    assert.equal(realExec("other", ["x"], { env: shim.env }).status, 0);
    assert.deepEqual(shim.calls(), ["other x"]);
  } finally {
    shim.done();
  }
});

test("A11-279: refuseUnderTests reads the program's base name, the run root and the opt-in, and nothing else", () => {
  const run = { [RUN_ROOT_ENV]: "/home/x/.cache/a11ign/tmp/run-1" };
  assert.equal(refuseUnderTests("/usr/bin/tailscale", run), TAILSCALE_UNDER_TESTS);
  assert.equal(refuseUnderTests("tailscale", { ...run, [TAILSCALE_OPT_IN_ENV]: "1" }), null);
  assert.equal(refuseUnderTests("tailscale", { ...run, [TAILSCALE_OPT_IN_ENV]: "yes" }), TAILSCALE_UNDER_TESTS, "only `1` opts in");
  assert.equal(refuseUnderTests("tailscale", { A11Y_PRIVATE_TMP_BASE: "/x" }), null, "a base alone is any shell's, where doctor must still read the real serves");
  assert.equal(refuseUnderTests("tailscale", { [RUN_ROOT_ENV]: "" }), null);
  assert.equal(refuseUnderTests("tailscaled", run), null);
});
