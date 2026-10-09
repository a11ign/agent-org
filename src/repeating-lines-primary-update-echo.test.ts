// no-token: gh -- no gh and no journalctl here: the shipped allowlist is read from disk and the ticks are text
/**
 * `repeating-lines.allowlist.json`, a11ign/a11ign#3037: THE TICK'S `primary:update` ECHO IS NOT A FAULT IN EITHER RUNNER'S SPELLING.
 *
 * Measured 2026-10-02: #2974's cut-over 3 moved the tick unit's `ExecStartPre` from npm to pnpm. npm echoed `> name@version script`; pnpm appends the
 * checkout path. The entry ended in `$`, stopped matching, and the line was offered to `orchestrator` as a fault after 75 consecutive ticks (about 3 hours).
 *
 * THE CONTROLS GO BOTH WAYS: the pnpm line IS offered at 40 ticks with an empty allowlist (so the "not offered" below could not pass on a fixture that
 * never repeated), and another script's echo, or this one with text after the path, is still a line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseLine, parseTicks, loadAllowlist, repeatingLines } from "./repeating-lines.ts";

const TICKS = 40;
const TICK_MINUTES = 2;
const pad = (n: number) => String(n).padStart(2, "0");
const at = (i: number) => `2026-10-02T${pad(Math.floor((i * TICK_MINUTES) / 60))}:${pad((i * TICK_MINUTES) % 60)}:00+00:00`;
const row = (i: number, unit: string, message: string) => `${at(i)} agents ${unit}[1]: ${message}`;

/** `count` complete ticks each printing `line`, as `journalctl -o short-iso` would. */
function ticksOf(line: string, count = TICKS) {
  return parseTicks(Array.from({ length: count }, (_, i) => [
    row(i, "systemd", "Starting a11ign-work-tick.service - a11ign: ask work-gate whether there is work..."),
    row(i, "node", line),
    row(i, "systemd", "Finished a11ign-work-tick.service - a11ign: ask work-gate whether there is work."),
  ].join("\n")).join("\n"));
}

const NPM_ECHO = "> a11ign-monorepo@0.0.0 primary:update";
const PNPM_ECHO = "> a11ign-monorepo@0.0.0 primary:update /home/agent/repos/a11y-witness";

test("the SHIPPED allowlist covers the tick's `primary:update` echo in BOTH runners' spellings, and its second line", () => {
  const allow = loadAllowlist();
  const allowed = (line: string) => allow.some((a) => a.pattern.test(normaliseLine(line)));
  assert.ok(allowed(NPM_ECHO), "the form npm printed until a11ign/a11ign#2974");
  assert.ok(allowed(PNPM_ECHO), "the form pnpm prints");
  assert.ok(allowed("> node packages/agent-org/src/update-primary.ts"), "its second line");
  assert.ok(allowed("> agent-org primary:update"), "its second line since a11ign/a11ign#3097's cut-over 4");
  assert.ok(!allowed("> agent-org release:gate"), "another agent-org command is not covered");
  assert.ok(!allowed("> a11ign-monorepo@0.0.0 release:gate /home/agent/repos/a11y-witness"), "another script is not covered");
  assert.ok(!allowed(`${PNPM_ECHO} && curl evil`), "text after the path is not covered");
});

test("40 ticks of the pnpm echo are not offered; the control: without the entry they are", () => {
  assert.deepEqual(repeatingLines({ ticks: ticksOf(PNPM_ECHO), allow: loadAllowlist() }), []);
  assert.equal(repeatingLines({ ticks: ticksOf(PNPM_ECHO), allow: [] }).length, 1);
});

test("30 ticks of the script-body echo `agent-org primary:update` are not offered; the control: without the entry they are", () => {
  const line = "> agent-org primary:update";
  assert.deepEqual(repeatingLines({ ticks: ticksOf(line, 30), allow: loadAllowlist() }), []);
  assert.equal(repeatingLines({ ticks: ticksOf(line, 30), allow: [] }).length, 1);
});

const TOOL_LINE = "tool checkout detached at origin/main (9ef0eaac5ad034123f8a040e838b5f877f31c491)";

test("the tool checkout's position line is not offered at 40 ticks (it moves, and the sha is one line); the control: without the entry it is", () => {
  const allow = loadAllowlist();
  assert.deepEqual(repeatingLines({ ticks: ticksOf(TOOL_LINE), allow }), []);
  assert.equal(repeatingLines({ ticks: ticksOf(TOOL_LINE), allow: [] }).length, 1, "the positive control: the line repeats and IS offered without the entry");
  const failure = "/home/agent/repos/agent-org has uncommitted changes to tracked files, so it was NOT moved:";
  assert.equal(repeatingLines({ ticks: ticksOf(failure), allow }).length, 1, "a failed update is a different line and stays a fault");
});
