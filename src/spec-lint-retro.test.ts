// no-token: gh -- `buildReport` takes every read as a value, so nothing here reaches `gh`
/**
 * agent-org#1056 (follow-up to #1017): THE RETRO PRINTS THE ROWS THE SPEC LINT REFUSED IN 24H, beside the underspecified-stops line. The lint's refusals were one
 * ledger line each (`recordSpecLintRefusals`) and nothing read them, so a lint that was too strict was invisible.
 *
 * Every figure is checked by hand against the fixture below. Inside the window (`NOW - 1h`), three lines for two rows:
 *   #1001 files  a-rule
 *   #1002 run    b-rule
 *   #1002 files  c-rule      (a second finding on #1002: the rows are distinct, the lines are not)
 * One line OUTSIDE it (`NOW - 25h`), on #1003, which is nobody's. So the report reads 2 rows and 3 findings: files 2, run 1.
 */
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as retro_0 from "./org-retro/journal-stats-and-verdicts.ts";
import * as retro_1 from "./org-retro.ts";
import { recordSpecLintRefusals } from "./row-file/roadmap-without-parent-refusal.ts";
import { FAILURE_LEDGER_FILE, SPEC_LINT_REFUSED_KIND } from "./failure-ledger.ts";
import { underspecifiedReading } from "./spec-lint.ts";
import { tmpDir } from "./lib/tmp-fixture.ts";

const NOW = Date.parse("2026-10-05T00:22:00Z");
const HOUR = 3_600_000;
const LINE = "- Rows refused by the spec lint (24h)";

/** Everything `buildReport` needs besides the ledger, so a test varies only the ledger and the stops read. */
const rest = { merged: [], openPrs: [], journal: "", ledger: "", turns: [], handFixes: null, underspecified: underspecifiedReading([]) };
const reportOf = (failureLedger: string | null | undefined) => retro_0.buildReport({ ...rest, failureLedger } as any, NOW);
const lineOf = (failureLedger: string | null | undefined) => retro_1.renderReport(reportOf(failureLedger)).split("\n").find((line) => line.startsWith(LINE));

/** The ledger the spec lint's own writer produces: the fixture goes through `recordSpecLintRefusals`, so the reader is tested against the real bytes. */
function fixtureLedger(): string {
  const logPath = join(tmpDir("spec-lint-retro-"), FAILURE_LEDGER_FILE);
  recordSpecLintRefusals(1001, [{ field: "files", rule: "a-rule" }], { logPath, now: NOW - HOUR });
  recordSpecLintRefusals(1002, [{ field: "run", rule: "b-rule" }, { field: "files", rule: "c-rule" }], { logPath, now: NOW - HOUR });
  recordSpecLintRefusals(1003, [{ field: "files", rule: "d-rule" }], { logPath, now: NOW - 25 * HOUR });
  return readFileSync(logPath, "utf8");
}

test("the retro prints the distinct rows and the field counts of the 24 hours, on the line after the stops line", () => {
  const report = retro_1.renderReport(reportOf(fixtureLedger()));
  assert.match(report, /^- Underspecified stops by field: none in the 24 hours\n- Rows refused by the spec lint \(24h\): 2 rows \(3 findings refused: files 2, run 1\)$/m,
    "two rows, three lines in the window, the line outside it counted nowhere; the field counts are of the lines");
});

test("the window is 24 hours from the report's own `now`: a line at exactly 24 hours before counts, one a second older does not", () => {
  const logPath = join(tmpDir("spec-lint-retro-edge-"), FAILURE_LEDGER_FILE);
  recordSpecLintRefusals(2001, [{ field: "run", rule: "x" }], { logPath, now: NOW - 24 * HOUR });
  recordSpecLintRefusals(2002, [{ field: "run", rule: "x" }], { logPath, now: NOW - 24 * HOUR - 1000 });
  assert.equal(lineOf(readFileSync(logPath, "utf8")), `${LINE}: 1 row (1 finding refused: run 1)`);
});

test("a ledger nobody read, or one that does not parse, prints `unknown`, never 0", () => {
  assert.equal(lineOf(null), `${LINE}: unknown (the failure ledger could not be read)`, "a read nobody made");
  assert.equal(lineOf(undefined), `${LINE}: unknown (the failure ledger could not be read)`, "a read absent from the reads");
  assert.equal(lineOf(`${SPEC_LINT_REFUSED_KIND}\tnot-a-time\t#1001 files a-rule\n`), `${LINE}: unknown (the failure ledger could not be read)`,
    "a line that does not parse is a ledger read wrong, and a count read wrong is not a quiet day");
});

test("a readable ledger with no spec-lint refusal in it prints 0, and so does an empty one", () => {
  assert.equal(lineOf(""), `${LINE}: 0`, "readable and empty");
  const other = `claim-refused\t${NOW - HOUR}\tsome reason\n`;
  assert.equal(lineOf(other), `${LINE}: 0`, "readable, holding only another kind");
});

test("a line of another kind with the same shape is not a refusal: the kind is what makes it one", () => {
  const text = `claim-refused\t${NOW - HOUR}\t#1001 files a-rule\n${SPEC_LINT_REFUSED_KIND}\t${NOW - HOUR}\t#1001 files a-rule\n`;
  assert.equal(lineOf(text), `${LINE}: 1 row (1 finding refused: files 1)`);
});

test("SPEC_LINT_REFUSED_KIND is DEFINED in failure-ledger.ts and nowhere else in the source", () => {
  const src = fileURLToPath(new URL(".", import.meta.url));
  const definitions = readdirSync(src).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .filter((name) => /export const SPEC_LINT_REFUSED_KIND\b/.test(readFileSync(join(src, name), "utf8")));
  assert.deepEqual(definitions, ["failure-ledger.ts"], "one definition, so the writer and the reader cannot name it two ways");
  assert.equal(SPEC_LINT_REFUSED_KIND, "spec-lint-refused");
});
