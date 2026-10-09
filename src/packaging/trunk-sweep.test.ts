/**
 * #417: THE INTERIM COVER WHILE THE TRUNK IS UNGUARDED AFTER EVERY PIPELINE MERGE.
 *
 * `needsGateSweep` is the whole gate-side decision, as one pure function. The row-closing half reuses
 * `close-rows-sweep.mjs`'s own `mergedPrsInWindow`/`closurePlan` wiring (already tested in that file) --
 * this file does not repeat those. How the project's `nightly.yml`/`trunk.yml` schedule and trigger the
 * two halves is the project's to assert, and left this file with #3233.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { needsGateSweep, EXIT } from "../trunk-sweep.ts";

// The tool's own script, `src` up one.
const SCRIPT = fileURLToPath(new URL("../trunk-sweep.ts", import.meta.url));

// --- needsGateSweep: the pure decision ---

test("needsGateSweep: zero check runs needs a sweep", () => {
  assert.equal(needsGateSweep(0), true);
});

test("needsGateSweep: MUTATION TARGET -- any check run at all means no sweep is needed", () => {
  assert.equal(needsGateSweep(1), false);
  assert.equal(needsGateSweep(9), false);
});

// --- the CLI, guarded like every other argv-reading script here ---

test("trunk-sweep.mjs refuses an unknown flag rather than silently ignoring it", () => {
  let threw = false;
  try {
    execFileSync("node", [SCRIPT, "--bogus"], { encoding: "utf8", stdio: "pipe" });
  } catch (cause) {
    threw = true;
    const err = cause as { status?: number, stderr?: string };
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /unknown flag --bogus/);
  }
  assert.ok(threw);
});

test("trunk-sweep.mjs refuses to run without GITHUB_REPOSITORY -- CANNOT ASK, never a guessed repo", () => {
  let threw = false;
  try {
    const env = { ...process.env };
    delete env.GITHUB_REPOSITORY;
    execFileSync("node", [SCRIPT], { encoding: "utf8", stdio: "pipe", env });
  } catch (cause) {
    threw = true;
    const err = cause as { status?: number, stderr?: string };
    assert.equal(err.status, EXIT.CANNOT_ASK);
    assert.match(String(err.stderr), /GITHUB_REPOSITORY is unset/);
  }
  assert.ok(threw);
});
