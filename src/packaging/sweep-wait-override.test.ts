// no-token: auto-arm-sweep -- `confirmArmed` and `mergedMeanwhile` are driven with an injected `read` and `sleep`; nothing here reaches `gh`
/**
 * #3768: THE SWEEP'S RE-READ WAIT IS SHORTENED BY ONE VARIABLE, AND ONLY A TEST SETS IT.
 *
 * The three process-form sweep tests (`arm-refuses-an-ejected-pr`, `arm-refuses-open-blocker`, `pipeline-lane-authorship`) spawn the whole
 * sweep against a fake `gh` that never changes its answer, so every re-read exhausted its retries in real time: 33 waits of 2 s, measured,
 * about 65 s. They now set `AGENT_ORG_SWEEP_WAIT_MS=0` in the spawned sweep's environment. What keeps that honest is here:
 *
 *  1. THE DEFAULT IS REAL, driven through both re-reads: with the variable unset the sweep sleeps `CONFIRM_ARMED_WAIT_MS` and
 *     `MERGED_MEANWHILE_WAIT_MS` between reads, and both are still `2_000`. A default that quietly became zero would make every
 *     test fast and the production race window silently empty.
 *  2. A VALUE THAT IS NOT A WHOLE NUMBER OF MILLISECONDS IS THE REAL WAIT, never zero.
 *  3. NOTHING BUT A TEST SETS IT: no shipped unit, no project unit, no workflow and no non-test source names the variable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { confirmArmed, mergedMeanwhile, waitBetweenReads, SWEEP_WAIT_ENV, CONFIRM_ARMED_READS, CONFIRM_ARMED_WAIT_MS,
  MERGED_MEANWHILE_READS, MERGED_MEANWHILE_WAIT_MS } from "../auto-arm-sweep.mjs";
import { HOME_CHECKOUT } from "../project-config.mjs";

const SRC = fileURLToPath(new URL("../", import.meta.url));
/** Read from the paths, not through `host-units.mjs`, which wants git history that the acceptance job does not have. */
const SHIPPED_DIR = fileURLToPath(new URL("../../host/", import.meta.url));
const PROJECT_UNITS_DIR = join(HOME_CHECKOUT, ".agent-org/units");
const WORKFLOWS = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));

/** Drives a re-read that never succeeds and returns what the sweep slept between reads. */
function sleptBy(reread: typeof confirmArmed): number[] {
  const slept: number[] = [];
  reread("1", "o/r", { read: () => false, sleep: (ms: number) => { slept.push(ms); }, log: () => undefined });
  return slept;
}

function withEnv<T>(value: string | undefined, body: () => T): T {
  const before = process.env[SWEEP_WAIT_ENV];
  if (value === undefined) delete process.env[SWEEP_WAIT_ENV]; else process.env[SWEEP_WAIT_ENV] = value;
  try { return body(); } finally {
    if (before === undefined) delete process.env[SWEEP_WAIT_ENV]; else process.env[SWEEP_WAIT_ENV] = before;
  }
}

test("the production waits are 2 s, pinned where a fast test cannot move them", () => {
  assert.equal(CONFIRM_ARMED_WAIT_MS, 2_000);
  assert.equal(MERGED_MEANWHILE_WAIT_MS, 2_000);
});

test("CONTROL: with the zero wait NOT supplied, both re-reads still sleep their real wait between every read", () => {
  assert.deepEqual(withEnv(undefined, () => sleptBy(confirmArmed)), Array(CONFIRM_ARMED_READS - 1).fill(CONFIRM_ARMED_WAIT_MS));
  assert.deepEqual(withEnv(undefined, () => sleptBy(mergedMeanwhile)), Array(MERGED_MEANWHILE_READS - 1).fill(MERGED_MEANWHILE_WAIT_MS));
});

test("the zero wait, supplied, reaches both re-reads: same reads, no waiting", () => {
  assert.deepEqual(withEnv("0", () => sleptBy(confirmArmed)), Array(CONFIRM_ARMED_READS - 1).fill(0));
  assert.deepEqual(withEnv("0", () => sleptBy(mergedMeanwhile)), Array(MERGED_MEANWHILE_READS - 1).fill(0));
});

test("a value that is not a whole number of milliseconds is the real wait, never zero", () => {
  for (const bad of ["", " ", "abc", "-1", "1.5", " 0", "0 ", "0x0", "1e3"]) {
    assert.equal(waitBetweenReads(2_000, { [SWEEP_WAIT_ENV]: bad }), 2_000, JSON.stringify(bad));
  }
  assert.equal(waitBetweenReads(2_000, {}), 2_000);
  assert.equal(waitBetweenReads(2_000, { [SWEEP_WAIT_ENV]: "0" }), 0);
  assert.equal(waitBetweenReads(2_000, { [SWEEP_WAIT_ENV]: "50" }), 50);
});

/** Every regular file under `dir`, recursively; a missing directory is empty. */
function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]);
  } catch { return []; }
}

/** The files among `files` whose text names the variable, by its value or by the exported constant a source would import to set it. */
const namingTheVariable = (files: string[]) => files.filter((file) => {
  const text = readFileSync(file, "utf8");
  return text.includes(SWEEP_WAIT_ENV) || text.includes("SWEEP_WAIT_ENV");
});

const isTest = (file: string) => /\.test\.(ts|mjs)$/.test(file);
const OWNER = join(SRC, "auto-arm-sweep.mjs");

test("nothing sets the override but the tests: no shipped unit, project unit, workflow or non-test source names it", () => {
  const units = [...filesUnder(SHIPPED_DIR), ...filesUnder(PROJECT_UNITS_DIR), ...filesUnder(WORKFLOWS)];
  assert.ok(units.length > 0, "the scan found no unit or workflow files at all, so its emptiness would mean nothing");
  assert.deepEqual(namingTheVariable(units), []);
  const sources = filesUnder(SRC).filter((file) => !isTest(file) && !file.includes("/fixtures/") && file !== OWNER);
  assert.ok(sources.length > 0);
  assert.deepEqual(namingTheVariable(sources), []);
});

test("CONTROL: the scan notices the variable in a unit, and in a source, when one is planted", () => {
  const dir = mkdtempSync(join(tmpdir(), "sweep-wait-3768-"));
  try {
    mkdirSync(join(dir, "units"));
    writeFileSync(join(dir, "units", "a.service"), `[Service]\nEnvironment=${SWEEP_WAIT_ENV}=0\n`);
    writeFileSync(join(dir, "clean.service"), "[Service]\nExecStart=/bin/true\n");
    assert.deepEqual(namingTheVariable(filesUnder(dir)), [join(dir, "units", "a.service")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the owner, this file and the three spawning tests are the only files that name it: the discovery is real, not vacuous", () => {
  const named = namingTheVariable(filesUnder(SRC)).map((file) => file.slice(SRC.length)).sort();
  assert.deepEqual(named, ["auto-arm-sweep.mjs", "packaging/arm-refuses-an-ejected-pr.test.ts",
    "packaging/arm-refuses-open-blocker.test.ts", "packaging/pipeline-lane-authorship.test.ts",
    "packaging/sweep-wait-override.test.ts"]);
});
