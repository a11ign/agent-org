/**
 * #1539: THE RELEASE GATE'S CONFORMANCE STAGE IS A CONFORMANCE READING -- and nothing else it prints is.
 *
 * The appendix's "Most recent conformance check result" row selects by `isConformanceGate`, which named only
 * `-e job=rules-real-pages`. On 2026-09-14 the lab release gate at `8efe61c413ba` read `PASS — all 86 of 86` in
 * its stage 11 (`rules:real-pages`), and `9d1d3114` recorded it as `-e job=release-gate`: the slot could not
 * select it, so a release-gate PASS would have lost to the 2026-09-07 FAIL had no standalone run followed.
 *
 * THE FIXTURE IS THE RECORDS THEMSELVES, read from `docs/board/reported/gates/` as `9d1d3114` committed them --
 * the 2026-09-07 `rules-real-pages` FAIL, the 2026-09-14 release-gate stage and standalone run, and the real
 * `promote` and capture-only entries. Variants are built from the release-gate record by the one change each
 * names. `board-gates.mjs` reads no file and starts no process, so this runs in CI's acceptance job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { gateVerdicts, isConformanceGate, latestVerdictGate, worstVerdict } from "../../../../scripts/board-gates.mjs";

type Gate = { command: string; at: string; output: string; reportedBy?: string };
const GATES = new URL("../../../../docs/board/reported/gates/", import.meta.url);
const record = (name: string): Gate => JSON.parse(readFileSync(fileURLToPath(new URL(name, GATES)), "utf8"));

const FAIL_0907 = record("npm-run-lab-job-e-job-rules-real-pages-e-ref-main-b43b4151.json");
const RELEASE_GATE_0914 = record("npm-run-lab-job-e-job-release-gate-e-ref-8efe61c413bab57a3b0-97866055.json");
const RULES_0914 = record("npm-run-lab-job-e-job-rules-real-pages-e-ref-0d9655dbbf243c6-59906942.json");
const PROMOTE = record("npm-run-lab-job-e-job-promote-e-ref-main-65e81af4.json");
const CAPTURE_ONLY = record("npm-run-lab-job-e-job-capture-only-e-only-7-families-e-captu-a620f9d7.json");

const STAGE_PASS = /^PASS — all 86 of 86 from conformant real pages scored against the baseline/;
/** A time after every recorded entry, so a variant is always the NEWEST candidate. */
const LATER = "2026-09-15T00:00:00Z";

test("#1539 FIXTURE: the records are the ones 9d1d3114 committed, and say what the row quotes", () => {
  assert.match(FAIL_0907.command, /-e job=rules-real-pages -e ref=main$/);
  assert.equal(FAIL_0907.at, "2026-09-07T12:26:00Z");
  assert.equal(worstVerdict(FAIL_0907.output)?.verdict, "FAIL");
  assert.match(RELEASE_GATE_0914.command, /-e job=release-gate -e ref=8efe61c413ba/);
  assert.equal(RELEASE_GATE_0914.at, "2026-09-14T04:42:23Z");
  assert.deepEqual(gateVerdicts(RELEASE_GATE_0914.output).map((v: { line: string }) => STAGE_PASS.test(v.line)), [true],
    "the release-gate record carries exactly one verdict line, the stage's PASS 86 of 86");
  assert.equal(RULES_0914.at, "2026-09-14T07:56:07Z");
  assert.match(worstVerdict(RULES_0914.output)?.line ?? "", STAGE_PASS);
});

test("#1539 ACCEPTANCE, MUTATION TARGET: only the release-gate record newer than the 09-07 FAIL -- the row reads PASS 86 of 86", () => {
  // THE CONTROL FIRST: without it, the 09-07 FAIL holds the slot, which is the state this row exists to change.
  assert.equal(latestVerdictGate([FAIL_0907]), FAIL_0907);
  const selected = latestVerdictGate([FAIL_0907, RELEASE_GATE_0914]);
  assert.equal(selected, RELEASE_GATE_0914,
    `a release-gate record of the rules:real-pages stage is a conformance reading; selected ${selected?.command}`);
  assert.match(worstVerdict(selected?.output)?.line ?? "", STAGE_PASS);
});

test("#1539: with both 14 September readings, the newer of the two holds the slot", () => {
  assert.equal(latestVerdictGate([FAIL_0907, RELEASE_GATE_0914, RULES_0914]), RULES_0914);
  assert.equal(isConformanceGate(RELEASE_GATE_0914), true);
  assert.equal(isConformanceGate(RULES_0914), true);
});

test("#1539 NEGATIVES: promote, capture-only and rules-real-pages-update never take the slot, however new", () => {
  const promote = { ...PROMOTE, at: LATER };
  const captureOnly = { ...CAPTURE_ONLY, at: LATER };
  const update = { ...RULES_0914, command: "npm run lab:job -- -e job=rules-real-pages-update -e ref=main", at: LATER };
  assert.equal(worstVerdict(promote.output)?.verdict, "PASS", "the promote entry DOES print a verdict -- so kind decides");
  for (const entry of [promote, captureOnly, update]) {
    assert.equal(isConformanceGate(entry), false, entry.command);
    assert.equal(latestVerdictGate([FAIL_0907, entry]), FAIL_0907, entry.command);
  }
});

test("#1539 NEGATIVES: a release-gate record that is not exactly one rules:real-pages stage with a verdict is excluded", () => {
  const banner = "> a11ign-monorepo@0.0.0 rules:real-pages";
  assert.ok(RELEASE_GATE_0914.output.includes(banner), "the variants below change this banner, so it must be there");
  const variants: Record<string, Gate> = {
    "no verdict line": { ...RELEASE_GATE_0914, at: LATER,
      output: RELEASE_GATE_0914.output.split("\n").filter((line) => !STAGE_PASS.test(line.trim())).join("\n") },
    "another stage's banner": { ...RELEASE_GATE_0914, at: LATER,
      output: RELEASE_GATE_0914.output.replace(banner, "> a11ign-monorepo@0.0.0 lint") },
    "the baseline-rewriting script's banner": { ...RELEASE_GATE_0914, at: LATER,
      output: RELEASE_GATE_0914.output.replace(banner, "> a11ign-monorepo@0.0.0 rules:real-pages-update") },
    "a multi-stage journal": { ...RELEASE_GATE_0914, at: LATER,
      output: `> a11ign-monorepo@0.0.0 typecheck\nFAIL — 3 errors\n${RELEASE_GATE_0914.output}` },
  };
  assert.equal(gateVerdicts(variants["no verdict line"].output).length, 0, "the stripped variant really prints no verdict");
  for (const [name, entry] of Object.entries(variants)) {
    assert.equal(latestVerdictGate([FAIL_0907, entry]), FAIL_0907, `${name} must not take the slot`);
  }
  assert.equal(isConformanceGate(variants["another stage's banner"]), false);
  assert.equal(isConformanceGate(variants["a multi-stage journal"]), false,
    "a whole journal is refused: the appendix renders the WORST verdict of the output, here another stage's FAIL");
});
