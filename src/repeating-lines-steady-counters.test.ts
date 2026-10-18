// no-token: gh -- no gh and no journalctl here: the shipped allowlist is read from disk, the gate-rest line is the tick's own formatter, and the read memo line is written by a child process whose `gh` is a stub on PATH.
/**
 * `repeating-lines.allowlist.json`, a11ign/agent-org#1196: THE GATE'S TWO STEADY COUNTERS ARE THE ORG WORKING AS DESIGNED, NOT FAULTS.
 *
 * `orchestrator`'s repeating-lines digest measured both in `a11ign-work-tick`: `gate-rest: 15 of 21 conditional reads answered 304` for 36 to 42 consecutive
 * ticks, and `read memo: 11 identical read(s) answered from memory, 32 distinct answer(s) held at the end of the tick.` since 11:06Z. Neither reports a fault:
 * the first is the conditional-read cache answering from its kept body, the second is the read memo deduplicating an identical read within one tick. The
 * counts move every tick, but `normaliseLine` turns every number to `N`, so each is one line to the detector.
 *
 * THE LINES ARE THE WRITERS' OWN OUTPUT: `gate-rest:` comes from `tickReadingLines` (src/work-gate/tick.ts), and `read memo:` is written at exit by the
 * gate's process (src/work-gate/reads.ts), so it is read here from a child process that imports the reads AS the gate does. A change to either wording
 * fails here rather than silently stopping the match.
 *
 * THE CONTROLS GO BOTH WAYS: each counter IS offered at 40 ticks with an empty allowlist (so "not offered" below could not pass on a fixture that never
 * repeated), and the same family's other tails (`gate-rest: ... conditional reads refused`, `read memo: N read(s) refused`), which no writer prints today, are
 * still offered with the shipped allowlist, so neither pattern is a bare prefix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { budgetOf } from "./gh-conditional.ts";
import { loadAllowlist, normaliseLine, parseTicks, repeatingLines } from "./repeating-lines.ts";
import { tickReadingLines } from "./work-gate/tick/blocker-cleared-reading.ts";

const TICKS = 40;
const TICK_MINUTES = 2;
const pad = (n: number) => String(n).padStart(2, "0");
const at = (i: number) => `2026-10-12T${pad(Math.floor((i * TICK_MINUTES) / 60))}:${pad((i * TICK_MINUTES) % 60)}:00+00:00`;
const row = (i: number, unit: string, message: string) => `${at(i)} agents ${unit}[1]: ${message}`;

/** `TICKS` complete ticks each printing `line`, as `journalctl -o short-iso` would. */
function ticksOf(line: string) {
  return parseTicks(Array.from({ length: TICKS }, (_, i) => [
    row(i, "systemd", "Starting a11ign-work-tick.service - a11ign: ask work-gate whether there is work..."),
    row(i, "node", line),
    row(i, "systemd", "Finished a11ign-work-tick.service - a11ign: ask work-gate whether there is work."),
  ].join("\n")).join("\n"));
}

const shipped = () => loadAllowlist();
const entryFor = (line: string) => shipped().find((a) => a.pattern.test(normaliseLine(line)));

const WORK_GATE = fileURLToPath(new URL("./work-gate.ts", import.meta.url));
const READS = fileURLToPath(new URL("./work-gate/reads/exit.ts", import.meta.url));
// The reads module whose import holds the memo for the gate (`reads.ts`); `READS` names where `defaultRun` is.
const READS_MODULE = fileURLToPath(new URL("./work-gate/reads.ts", import.meta.url));

/** The gate gets its `gate-rest:` line from the tick's own formatter: 15 of 21 conditional reads answered 304, the figures the digest measured. */
const GATE_REST = tickReadingLines(budgetOf(), { asked: 21, notModified: 15 }).find((l) => l.startsWith("gate-rest: "));

/**
 * The gate's `read memo:` line, as its process writes it at exit. The child imports the reads with `argv[1]` set to work-gate.ts, which is what makes
 * it the gate, asks one read twice through a stub `gh` on PATH, and the line is what it says on stderr.
 */
function readMemoLine(): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), "steady-counters-"));
  try {
    writeFileSync(join(dir, "gh"), "#!/bin/sh\necho answer\n");
    chmodSync(join(dir, "gh"), 0o755);
    const code = `const [entry, readsPath, exitPath] = process.argv.slice(1);
      process.argv[1] = entry;
      await import("file://" + readsPath);
      const reads = await import("file://" + exitPath);
      const LIST = ["pr", "list", "--state", "merged", "--limit", "100"];
      reads.defaultRun(LIST);
      reads.defaultRun(LIST);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code, WORK_GATE, READS_MODULE, READS], {
      encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stderr.split("\n").find((l) => l.startsWith("read memo: "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the gate-rest line is the tick's own line, and the shipped allowlist allows it with a reason that names its writer", () => {
  assert.equal(GATE_REST, "gate-rest: 15 of 21 conditional reads answered 304", "the formatter's own line");
  const entry = entryFor(GATE_REST ?? "");
  assert.ok(entry, "an entry matches the line");
  assert.notEqual(entry.reason.trim(), "", "the entry carries its reason");
  assert.match(entry.reason, /src\/work-gate\/tick\/blocker-cleared-reading\.ts/, "the reason names the file that writes it");
});

test("the read memo line is the gate's own line, and the shipped allowlist allows it with a reason that names its writer", () => {
  const line = readMemoLine();
  assert.match(line ?? "", /^read memo: 1 identical read\(s\) answered from memory, 1 distinct answer\(s\) held at the end of the tick\.$/, "the gate's own line");
  const entry = entryFor(line ?? "");
  assert.ok(entry, "an entry matches the line");
  assert.notEqual(entry.reason.trim(), "", "the entry carries its reason");
  assert.match(entry.reason, /src\/work-gate\/reads\/exit\.ts/, "the reason names the file that writes it");
});

test("40 ticks of each counter are offered with an empty allowlist and not with the shipped one", () => {
  const READ_MEMO = readMemoLine() ?? "";
  for (const line of [GATE_REST ?? "", READ_MEMO]) {
    assert.equal(repeatingLines({ ticks: ticksOf(line), allow: [] }).length, 1, `control: offered without the entry: ${line}`);
    assert.deepEqual(repeatingLines({ ticks: ticksOf(line), allow: shipped() }), [], `not offered with the entry: ${line}`);
  }
});

test("the same family's other tails are NOT allowed by the shipped allowlist, and 40 ticks of each are still offered", () => {
  const controls = [
    "gate-rest: 15 of 21 conditional reads refused",
    "read memo: 11 read(s) refused",
  ];
  for (const line of controls) {
    assert.equal(entryFor(line), undefined, `not allowlisted: ${line}`);
    assert.equal(repeatingLines({ ticks: ticksOf(line), allow: shipped() }).length, 1, `still offered: ${line}`);
  }
});
