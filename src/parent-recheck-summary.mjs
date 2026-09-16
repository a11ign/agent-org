#!/usr/bin/env node
// @ts-check
// command: read a node:test TAP log and print its failing subtests by name -- #744, never a fixed tail
//
// `trunk.yml`'s #616 parent re-check used to print `tail -40 /tmp/parent-test.log` when the parent
// failed. The last forty lines of a `node:test` run are the TAP SUMMARY -- trailing PASSING subtests,
// never the failing ones, which are wherever they happen to sit in a run of thousands. Measured live on
// #718 (2026-09-09): a genuine failure produced a step output of nothing but `ok 4180`, `ok 4181`, `ok
// 4182` -- twenty-eight lines, not one of them a failure -- and `decideRevert` correctly refused to act on
// a verdict with no named cause, so a real revert was declined and main stayed red for ninety minutes.
//
// `node:test`'s TAP output ends with `# fail N` and names every failing subtest as its own `not ok <n>`
// line, wherever it falls. Both survive to the end of the log regardless of length, so this never needs
// to know how long a run is or where in it a failure landed.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";

/**
 * Pure. `text` is a `node:test` TAP log (`npm test`'s own stdout+stderr, redirected). Returns `fail` only
 * when a real failing subtest can be NAMED; anything else -- a log with no TAP summary at all, a `# fail
 * N` line with N > 0 but no matching `not ok` (a truncated or malformed capture) -- is `unknown`, never
 * `fail`, because a verdict this function cannot back up must not be fed to `decideRevert` as though it
 * could. See `trunk-revert.mjs`'s own `revertVerdict`: `parentRecheck !== "fail"` (including `unknown`,
 * which resolves to `null`) is CANNOT_ASK, never a refusal to revert on false grounds.
 *
 * @param {string} text
 * @returns {{ verdict: "fail" | "unknown", notOkLines: string[], failCount: number | null, reason: string | null }}
 */
export function summarizeTestLog(text) {
  const notOkLines = text.split("\n").filter((line) => /^not ok \d+/.test(line));
  const failMatch = /^# fail (\d+)/m.exec(text);
  const failCount = failMatch ? Number(failMatch[1]) : null;

  if (notOkLines.length > 0) {
    return { verdict: "fail", notOkLines, failCount, reason: null };
  }
  if (failCount !== null && failCount > 0) {
    return { verdict: "unknown", notOkLines: [], failCount,
      reason: `the log states "# fail ${failCount}" but names no "not ok" line -- the summary line and `
        + "the detail lines disagree, so neither is trusted alone" };
  }
  return { verdict: "unknown", notOkLines: [], failCount,
    reason: "no \"not ok\" line or \"# fail N > 0\" summary found in the log -- this is not a node:test TAP "
      + "failure this function recognises, so the cause cannot be named" };
}

function main() {
  refuseUnknownFlags([], { entry: import.meta.url, command: "node packages/agent-org/src/parent-recheck-summary.mjs <log-file>" });
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("usage: node packages/agent-org/src/parent-recheck-summary.mjs <log-file>\n");
    process.exitCode = 2;
    return;
  }
  const text = readFileSync(path, "utf8");
  const { verdict, notOkLines, failCount, reason } = summarizeTestLog(text);
  if (verdict === "fail") {
    process.stdout.write(`# fail ${failCount ?? notOkLines.length}\n`);
    for (const line of notOkLines) process.stdout.write(`${line}\n`);
  } else {
    process.stdout.write(`UNKNOWN: ${reason}\n`);
  }
  // The workflow step captures this exact line to decide `result=fail` vs `result=unknown` -- see
  // `trunk.yml`'s own re-check step, and `parent-recheck-summary.test.ts`'s CLI test pinning it.
  process.stdout.write(`RECHECK_RESULT=${verdict}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  main();
}
