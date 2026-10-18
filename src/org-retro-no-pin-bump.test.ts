// no-token: none -- `retroClasses` is only listed (no class's `read` is called, so no default seam reaches `gh`), and `buildReport` and `renderReport` read nothing.
// The daily retrospective no longer reads or prints the pin/bump count (agent-org#1654, after agent-org#1593 deleted the pin it served). The source grep in the row's
// Acceptance cannot see behaviour, so this is the runtime guard: a canary state that still records the retired flag ON must not bring the read back, and a reading
// handed to the report must not print a line. Positive control: the same listing holds the classes that are still read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildReport, retroClasses } from "./org-retro/readings.ts";
import { renderReport } from "./org-retro.ts";
import { CANARY_STATE_FILE } from "./org-health/claim-refusal.ts";
import { emptyCanaryState } from "./org-health/fleet-build-incident.ts";
import { withMachineryFlag } from "./org-health.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const BASE = { merged: [], openPrs: [], journal: "", ledger: "", turns: [], handFixes: null };
const RETIRED_FLAG = "retro.pinBump";

test("a canary state that still records the retired flag ON adds no retrospective class: the read is gone, not switched off", () => {
  const stateDir = tmpDir("no-pin-bump-state-");
  writeFileSync(join(stateDir, CANARY_STATE_FILE), JSON.stringify(withMachineryFlag(emptyCanaryState(), { name: RETIRED_FLAG, on: true })));
  const names = retroClasses({ now: NOW, stateDir }).map((cls) => cls.name);
  assert.ok(names.includes("dora") && names.includes("merged lists"), `positive control: the classes still read are listed (${names.join(", ")})`);
  assert.deepEqual(names.filter((name) => /pin|bump/i.test(name)), [], "no class is about the pin or a bump");
});

test("a report handed a stray pin/bump reading prints no pin/bump line, and is the report without it", () => {
  const without = renderReport(buildReport(BASE, NOW));
  const stray = { ...BASE, pinBump: { pinRows: 3, repos: [] } } as typeof BASE;
  assert.equal(renderReport(buildReport(stray, NOW)), without);
  assert.doesNotMatch(without, /pin or bump|Renovate PRs/i);
  assert.ok(without.length > 0, "positive control: the report itself is not empty");
});
