// no-token: recordHandReroutes -- every tick here is handed the hand-fix recorder's marker as just run, so it reads nothing; the subject is the audit call, not that recorder (a11ign/agent-org#620)
// @ts-check
// THE WORK TICK RUNS THE MESSAGING AUDIT (a11ign/agent-org#620, follow-up to a11ign/a11ign#4746, #928): `auditMessaging` was exported and tested and nothing called it, so the
// detector filed no incident until a tick ran it. Every case here goes through `recordTickFailures` itself, the function the tick calls, over a scratch `home` (whose messaging
// ledger is read) and a scratch `stateDir` (where `failure-ledger` and the cursor are written), so what is read is what the tick writes and not a call this file made.
//
// POSITIVE CONTROLS: the flagged announcement has a twin with the same text stated, and the no-ledger host has a twin whose ledger holds the same line. The control the row names, the
// call removed, is run by hand and pasted in the pull request: every "flagged" below turns red.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { FAILURE_LEDGER_FILE, MESSAGING_AUDIENCE_MISUSE_KIND, parseFailureLedger } from "../failure-ledger.ts";
import { MESSAGING_AUDIT_CURSOR_FILE, recordTickFailures } from "../failure-recorders.ts";
import { createLedger } from "./ledger.ts";
import { defaultLedgerPath } from "./state.ts";

const START = Date.parse("2026-10-10T09:00:00Z");
const HOUR = 3_600_000;

const scratch = mkdtempSync(join(tmpdir(), "messaging-audit-tick-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextDir = 0;

type Line = Record<string, any>;

/** A scratch host: `home` is where the messaging ledger would be, `stateDir` is the tick's own state. */
function host() {
  const dir = join(scratch, `host-${nextDir += 1}`);
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  // The hand-fix recorder reads `gh`; the marker makes it think it ran a moment ago, so it makes no read here.
  writeFileSync(join(stateDir, `${FAILURE_LEDGER_FILE}-hand-read`), String(START));
  return { home: join(dir, "home"), stateDir, said: [] as string[] };
}

type Host = ReturnType<typeof host>;

/** One tick's recorders, as the work gate calls them, with the audit's output captured. */
function tick(on: Host, now: number) {
  recordTickFailures({ trunkRed: null, keyedTrunkReds: [], prs: [], stateDir: on.stateDir, now, ownerOf: () => ({ source: "label" }), homeRepo: "a11ign/a11ign", home: on.home, say: (line) => on.said.push(line) });
}

/** An announcement line as the core writes it; `over` is what a case changes. */
const announcement = (over: Line = {}): Line => ({
  key: "release:a11ign/agent-org@v0.1.0", status: "sent", kind: "first", audience: "announcement", providerMessageId: "m-1", text: "agent-org v0.1.0 is released", ...over,
});

function appendToLedger(on: Host, lines: Line[]) {
  const ledger = createLedger({ path: defaultLedgerPath(on.home), now: () => START });
  for (const line of lines) ledger.append(line);
}

const misuseLines = (on: Host) => {
  const path = join(on.stateDir, FAILURE_LEDGER_FILE);
  return existsSync(path) ? parseFailureLedger(readFileSync(path, "utf8"), path).filter((entry) => entry.classKey === MESSAGING_AUDIENCE_MISUSE_KIND) : [];
};

describe("the tick audits the messaging ledger", () => {
  test("a delivered announcement ending `?`, sent after the first tick, is ONE line after two ticks and none from the second", () => {
    const on = host();
    appendToLedger(on, [announcement({ key: "release:before", providerMessageId: "m-0", text: "Something earlier?" })]);
    tick(on, START);
    assert.deepEqual(misuseLines(on), [], "the first tick baselines: what was sent before it is not audited");

    appendToLedger(on, [announcement({ text: "Worker 4 is off. Should I switch it on?" })]);
    tick(on, START + HOUR);
    const afterSecond = misuseLines(on);
    assert.equal(afterSecond.length, 1);
    assert.match(afterSecond[0].ref, /^m-1 announcement-question "Worker 4 is off\. Should I switch it on\?"$/);

    tick(on, START + 2 * HOUR);
    assert.equal(misuseLines(on).length, 1, "the third tick reads past the cursor and appends nothing");
  });

  test("the twin: the same announcement stated, not asked, is no line", () => {
    const on = host();
    tick(on, START);
    appendToLedger(on, [announcement({ text: "Worker 4 is off. I switched it on." })]);
    tick(on, START + HOUR);
    assert.deepEqual(misuseLines(on), []);
    assert.deepEqual(on.said.filter((line) => line.includes("checked")), [], "a clean pass says nothing (agent-org#699), so the detector has no line to repeat");
    assert.equal(readFileSync(join(on.stateDir, MESSAGING_AUDIT_CURSOR_FILE), "utf8").trim(), "1", "the audit ran and read the line: the cursor moved past it");
  });

  test("a host with no messaging ledger files nothing, does not throw, and writes only the cursor", () => {
    const on = host();
    assert.equal(existsSync(defaultLedgerPath(on.home)), false, "no ledger here");
    tick(on, START);
    tick(on, START + HOUR);
    assert.deepEqual(misuseLines(on), []);
    assert.equal(existsSync(join(on.stateDir, FAILURE_LEDGER_FILE)), false, "no failure-ledger line, no failure-ledger file");
    assert.deepEqual(readdirSync(on.stateDir).sort(), [`${FAILURE_LEDGER_FILE}-hand-read`, MESSAGING_AUDIT_CURSOR_FILE].sort());
    assert.equal(existsSync(defaultLedgerPath(on.home)), false, "and the ledger is not created by being audited");
  });

  test("a clean tick says no count line and a tick that flags says it, so the detector sees a line only when there is something to read (agent-org#699)", () => {
    const on = host();
    const countLines = () => on.said.filter((line) => line.startsWith("messaging audit: ") && line.includes("checked"));
    tick(on, START);
    tick(on, START + HOUR);
    assert.deepEqual(countLines(), [], "two clean ticks, the first of them the baseline: no line");
    appendToLedger(on, [announcement({ text: "Ready to ship?" })]);
    tick(on, START + 2 * HOUR);
    assert.deepEqual(countLines(), ["messaging audit: 1 checked, 1 flagged"], "the control: the tick that flagged one says so");
  });

  test("the count line goes to stderr with the other recorders' lines, never to stdout, which is the tick's orders", () => {
    const on = host();
    tick(on, START);
    appendToLedger(on, [announcement({ text: "Ready to ship?" })]); // only a flagged pass prints (agent-org#699), so this one has something to say
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    const out: string[] = [];
    const err: string[] = [];
    process.stdout.write = ((chunk: unknown) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      recordTickFailures({ trunkRed: null, keyedTrunkReds: [], prs: [], stateDir: on.stateDir, now: START + HOUR, ownerOf: () => ({ source: "label" }), homeRepo: "a11ign/a11ign", home: on.home });
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    assert.deepEqual(out, [], "nothing on stdout: a line there is not an order and the consumer reads every line as one");
    assert.ok(err.some((line) => line.includes("messaging audit: 1 checked, 1 flagged")), `stderr: ${err.join("")}`);
  });
});
