/**
 * #417: THE INTERIM COVER WHILE THE TRUNK IS UNGUARDED AFTER EVERY PIPELINE MERGE.
 *
 * `needsGateSweep` is the whole gate-side decision, as one pure function. The row-closing half reuses
 * `close-rows-sweep.mjs`'s own `mergedPrsInWindow`/`closurePlan` wiring (already tested in that file) --
 * this file does not repeat those, only proves the workflow wires both halves correctly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { needsGateSweep, EXIT } from "../../../../scripts/trunk-sweep.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCRIPT = `${REPO}/scripts/trunk-sweep.mjs`;

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

// --- the workflow: a SCHEDULE (deliberately, unlike every other watchdog here), both halves present ---

test("trunk-sweep.yml is scheduled every 15 minutes, and also carries a manual dispatch", () => {
  const doc = parseYaml(readFileSync(`${REPO}/.github/workflows/trunk-sweep.yml`, "utf8")) as {
    on: { schedule?: Array<{ cron: string }>, workflow_dispatch?: unknown },
  };
  assert.ok(doc.on.schedule && doc.on.schedule.length > 0,
    "this is the one workflow in this repo that MUST be scheduled -- every push/pull_request trigger it "
    + "could ride instead is exactly what GITHUB_TOKEN merges suppress (#394).");
  assert.equal(doc.on.schedule?.[0]?.cron, "*/15 * * * *");
  assert.ok("workflow_dispatch" in doc.on, "a manual kick for exercising the sweep on demand");
});

test("trunk-sweep.yml carries both gateSweep and closeRowsSweep, as independent jobs", () => {
  const doc = parseYaml(readFileSync(`${REPO}/.github/workflows/trunk-sweep.yml`, "utf8")) as {
    jobs: Record<string, { needs?: string | string[], steps: Array<Record<string, unknown>> }>,
  };
  assert.ok(doc.jobs.gateSweep, "must carry gateSweep -- the unit-3 redundancy a bot merge suppresses");
  assert.ok(doc.jobs.closeRowsSweep, "must carry closeRowsSweep -- the row-closing backstop");
  assert.ok(!doc.jobs.gateSweep.needs && !doc.jobs.closeRowsSweep.needs,
    "the two halves are independent -- one failing must not block the other from running");

  const gateRuns = (doc.jobs.gateSweep.steps ?? []).map((s) => String(s.run ?? "")).join("\n");
  assert.match(gateRuns, /node scripts\/trunk-sweep\.mjs/);

  const closeRuns = (doc.jobs.closeRowsSweep.steps ?? []).map((s) => String(s.run ?? "")).join("\n");
  assert.match(closeRuns, /node scripts\/close-rows-sweep\.mjs --window=60/,
    "the 60-minute window against a 15-minute schedule is DELIBERATE overlap -- see the workflow's own "
    + "header for why, and this pins the number so a future edit cannot silently narrow it to the schedule "
    + "interval, which would lose a row on any single missed tick");
});

test("trunk-guard.yml carries workflow_dispatch, so trunk-sweep.yml can trigger a real gate run", () => {
  const doc = parseYaml(readFileSync(`${REPO}/.github/workflows/trunk-guard.yml`, "utf8")) as {
    on: { push?: unknown, workflow_dispatch?: unknown },
  };
  assert.ok("push" in doc.on, "the original push trigger must still be there -- this ADDS a path, it "
    + "does not replace the one that works for human merges");
  assert.ok("workflow_dispatch" in doc.on,
    "without this, trunk-sweep.yml has nothing to trigger and the gate half of #417 does nothing");
});

test("trunk-guard.yml's decideRevert falls back to a computed before-sha when github.event.before is "
  + "absent -- the workflow_dispatch case this PR adds", () => {
  const text = readFileSync(`${REPO}/.github/workflows/trunk-guard.yml`, "utf8");
  assert.match(text, /git rev-parse HEAD\^1/,
    "github.event.before only exists on a real push event; without a fallback, a sweep-triggered run "
    + "would pass an empty --before-sha and trunk-revert.mjs refuses to run at all");
});
