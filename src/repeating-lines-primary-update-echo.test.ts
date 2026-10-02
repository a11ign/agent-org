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
import { normaliseLine, parseTicks, loadAllowlist, repeatingLines } from "./repeating-lines.mjs";

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
  assert.ok(allowed("> node packages/agent-org/src/update-primary.mjs"), "its second line");
  assert.ok(!allowed("> a11ign-monorepo@0.0.0 release:gate /home/agent/repos/a11y-witness"), "another script is not covered");
  assert.ok(!allowed(`${PNPM_ECHO} && curl evil`), "text after the path is not covered");
});

test("40 ticks of the pnpm echo are not offered; the control: without the entry they are", () => {
  assert.deepEqual(repeatingLines({ ticks: ticksOf(PNPM_ECHO), allow: loadAllowlist() }), []);
  assert.equal(repeatingLines({ ticks: ticksOf(PNPM_ECHO), allow: [] }).length, 1);
});
