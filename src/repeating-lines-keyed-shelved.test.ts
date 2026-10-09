// no-token: gh -- no gh and no journalctl here: the shipped allowlist is read from disk and the ticks are text
/**
 * `repeating-lines.allowlist.json`, a11ign/a11ign#4617: A KEYED `SHELVED` ROW IS THE SAME STATE AS AN UNKEYED ONE.
 *
 * Measured 2026-10-09T18:34Z: `SHELVED row agent-org#460: blocked by #458 -- declared on the row, and it clears itself` repeated every tick and was
 * offered to the `repeating-log-line` wake. A row in a keyed repository is printed with its key, which normalises to `agent-org#N` and matched
 * nothing, because the entry read `^SHELVED row #N: `.
 *
 * THE CONTROLS GO BOTH WAYS: the keyed line IS offered at 40 ticks with an empty allowlist (so the "not offered" below could not pass on a fixture
 * that never repeated), and `SHELVED rows` with no `#N:` is still offered with the shipped one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseLine, parseTicks, loadAllowlist, repeatingLines } from "./repeating-lines.ts";

const TICKS = 40;
const TICK_MINUTES = 2;
const pad = (n: number) => String(n).padStart(2, "0");
const at = (i: number) => `2026-10-09T${pad(Math.floor((i * TICK_MINUTES) / 60))}:${pad((i * TICK_MINUTES) % 60)}:00+00:00`;
const row = (i: number, unit: string, message: string) => `${at(i)} agents ${unit}[1]: ${message}`;

/** `count` complete ticks each printing `line`, as `journalctl -o short-iso` would. */
function ticksOf(line: string) {
  return parseTicks(Array.from({ length: TICKS }, (_, i) => [
    row(i, "systemd", "Starting a11ign-work-tick.service - a11ign: ask work-gate whether there is work..."),
    row(i, "node", line),
    row(i, "systemd", "Finished a11ign-work-tick.service - a11ign: ask work-gate whether there is work."),
  ].join("\n")).join("\n"));
}

const REASON = "blocked by #458 -- declared on the row, and it clears itself";
const KEYED = `SHELVED row agent-org#460: ${REASON}`;
const UNKEYED = `SHELVED row #4617: ${REASON}`;
const NOT_A_ROW = "SHELVED rows are all gone";

test("the SHIPPED allowlist covers a SHELVED row in both spellings, and not a line with no `#N:`", () => {
  const allow = loadAllowlist();
  const allowed = (line: string) => allow.some((a) => a.pattern.test(normaliseLine(line)));
  assert.ok(allowed(UNKEYED), "the form printed for a row in this repository");
  assert.ok(allowed(KEYED), "the form printed for a row in a keyed repository");
  assert.ok(allowed(`SHELVED row a11ign/agent-org#460: ${REASON}`), "a key carrying an owner");
  assert.ok(!allowed(NOT_A_ROW), "`SHELVED rows` with no `#N:` is a different line");
  assert.ok(!allowed(`SHELVED row agent-org 460: ${REASON}`), "a key with no `#` is not a row reference");
});

test("40 ticks of the keyed line are not offered; the control: without the entry they are, and the unkeyed control stays offered", () => {
  assert.deepEqual(repeatingLines({ ticks: ticksOf(KEYED), allow: loadAllowlist() }), []);
  assert.equal(repeatingLines({ ticks: ticksOf(KEYED), allow: [] }).length, 1);
  assert.equal(repeatingLines({ ticks: ticksOf(NOT_A_ROW), allow: loadAllowlist() }).length, 1);
});
