// no-token: gh -- `buildReport` takes every read as a value, so nothing here reaches `gh`
/**
 * agent-org#990 (follow-up to a11ign/a11ign#5032 / agent-org#988): THE RETRO PRINTS THE EMERGENCY-PRIORITY LEDGER LINES OF 24H. The gate writes
 * `emergency-priority-used` once per honoured use and `emergency-priority-not-honoured` once per misuse, and nothing read them, so the chairman's
 * retro could not show how often the emergency path was used or misused.
 *
 * Every figure is checked by hand against the fixture below. Inside the window (`NOW - 1h` unless said otherwise):
 *   used        #300:INC-1          (counted)
 *   used        #301:INC-1          (counted: a second row)
 *   used        #300:INC-1          (a repeated ref at `NOW - 3h`: the same use, counted once)
 *   not-honoured #300:ceo:why       (a misuse: counted apart from the uses)
 * One use OUTSIDE it (`NOW - 25h`, on #302), counted nowhere. So the report reads 2 uses and 1 misuse.
 */
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import * as retro_0 from "./org-retro/journal-stats-and-verdicts.ts";
import * as retro_1 from "./org-retro.ts";
import { EMERGENCY_PRIORITY_NOT_HONOURED_KIND, EMERGENCY_PRIORITY_USED_KIND, FAILURE_LEDGER_FILE, SPEC_LINT_REFUSED_KIND, recordFailure } from "./failure-ledger.ts";
import { underspecifiedReading } from "./spec-lint.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";

const NOW = Date.parse("2026-10-12T00:22:00Z");
const HOUR = 3_600_000;
const USES = "- Emergency-priority honoured uses (24h)";
const MISUSES = "- Emergency-priority misuses (24h)";

/** Everything `buildReport` needs besides the ledger, so a test varies only the ledger. */
const rest = { merged: [], openPrs: [], journal: "", ledger: "", turns: [], handFixes: null, underspecified: underspecifiedReading([]) };
const reportOf = (failureLedger: string | null | undefined) => retro_0.buildReport({ ...rest, failureLedger } as any, NOW);
const linesOf = (failureLedger: string | null | undefined) => {
  const lines = retro_1.renderReport(reportOf(failureLedger)).split("\n");
  return [lines.find((line) => line.startsWith(USES)), lines.find((line) => line.startsWith(MISUSES))];
};

/** The ledger the gate's own writer produces, so the reader is tested against the real bytes. */
function fixtureLedger(): string {
  const logPath = join(tmpDir("emergency-priority-retro-"), FAILURE_LEDGER_FILE);
  recordFailure({ logPath, classKey: EMERGENCY_PRIORITY_USED_KIND, ref: "agent-org#300:INC-1", now: NOW - HOUR });
  recordFailure({ logPath, classKey: EMERGENCY_PRIORITY_USED_KIND, ref: "agent-org#301:INC-1", now: NOW - 2 * HOUR });
  recordFailure({ logPath, classKey: EMERGENCY_PRIORITY_USED_KIND, ref: "agent-org#300:INC-1", now: NOW - 3 * HOUR });
  recordFailure({ logPath, classKey: EMERGENCY_PRIORITY_USED_KIND, ref: "agent-org#302:INC-1", now: NOW - 25 * HOUR });
  recordFailure({ logPath, classKey: EMERGENCY_PRIORITY_NOT_HONOURED_KIND, ref: "agent-org#300:ceo:why", now: NOW - HOUR });
  return readFileSync(logPath, "utf8");
}

test("the retro prints the distinct honoured uses and the misuses of the 24 hours, each ref once, the line outside the window counted nowhere", () => {
  assert.deepEqual(linesOf(fixtureLedger()), [`${USES}: 2`, `${MISUSES}: 1`],
    "two distinct uses inside the window (the repeated ref is one), the use at 25 hours is not counted, the misuse is counted apart from the uses");
});

test("a use at exactly 24 hours counts, and one a second older does not", () => {
  const logPath = join(tmpDir("emergency-priority-retro-edge-"), FAILURE_LEDGER_FILE);
  recordFailure({ logPath, classKey: EMERGENCY_PRIORITY_USED_KIND, ref: "agent-org#400:INC-2", now: NOW - 24 * HOUR });
  recordFailure({ logPath, classKey: EMERGENCY_PRIORITY_USED_KIND, ref: "agent-org#401:INC-2", now: NOW - 24 * HOUR - 1000 });
  assert.deepEqual(linesOf(readFileSync(logPath, "utf8")), [`${USES}: 1`, `${MISUSES}: 0`]);
});

test("a day with no emergency-priority line prints 0 on both lines, not a missing line", () => {
  assert.deepEqual(linesOf(""), [`${USES}: 0`, `${MISUSES}: 0`], "readable and empty");
  const other = `${SPEC_LINT_REFUSED_KIND}\t${NOW - HOUR}\t#1001 files a-rule\n`;
  assert.deepEqual(linesOf(other), [`${USES}: 0`, `${MISUSES}: 0`], "readable, holding only another kind");
});

test("a ledger nobody read, or one that does not parse, prints `unknown` on both lines, never 0", () => {
  const unknown = "(the failure ledger could not be read)";
  assert.deepEqual(linesOf(null), [`${USES}: unknown ${unknown}`, `${MISUSES}: unknown ${unknown}`], "a read nobody made");
  assert.deepEqual(linesOf(undefined), [`${USES}: unknown ${unknown}`, `${MISUSES}: unknown ${unknown}`], "a read absent from the reads");
  assert.deepEqual(linesOf(`${EMERGENCY_PRIORITY_USED_KIND}\tnot-a-time\tagent-org#300:INC-1\n`), [`${USES}: unknown ${unknown}`, `${MISUSES}: unknown ${unknown}`],
    "a line that does not parse is a ledger read wrong, and a count read wrong is not a quiet day");
});

test("a misuse is not a use, and a use is not a misuse", () => {
  const logPath = join(tmpDir("emergency-priority-retro-kinds-"), FAILURE_LEDGER_FILE);
  recordFailure({ logPath, classKey: EMERGENCY_PRIORITY_NOT_HONOURED_KIND, ref: "agent-org#500:ceo:why", now: NOW - HOUR });
  assert.deepEqual(linesOf(readFileSync(logPath, "utf8")), [`${USES}: 0`, `${MISUSES}: 1`], "only a misuse in the window");
});
