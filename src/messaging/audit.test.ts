// @ts-check
// THE AUDIENCE AUDIT (a11ign/a11ign#4746, row 4 of 5 of #928): an announcement that asks the chairman something, and an ask with no row or record, are ledger incidents.
//
// POSITIVE CONTROLS: every "flagged" has a twin over the same line with the one offending part changed, so a check that never fires turns the first red and one that always
// fires turns the twin red. The last describe drives the REAL core, so the lines the audit reads are the ones the messenger writes and not ones this file imagined; its
// stall tick is the case that would be a false positive if the audit read an `edited` line. The mutations, both directions, are pasted in the pull request.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { MESSAGING_AUDIENCE_MISUSE_KIND, parseFailureLedger } from "../failure-ledger.ts";
import { EXCERPT_LENGTH, HALF, REQUEST_MARKERS, asksSomething, auditLines, auditMessaging, misuseOf } from "./audit.ts";
import { createMessenger } from "./core.ts";
import { createFakeProvider } from "./fake-provider.ts";
import { createLedger } from "./ledger.ts";

const START = Date.parse("2026-10-10T09:00:00Z");
const MINUTE = 60_000;
const TS = new Date(START).toISOString();

const scratch = mkdtempSync(join(tmpdir(), "messaging-audit-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextDir = 0;

type Line = Record<string, any>;

/** An announcement line as the core writes it; `over` is what a case changes. */
const announcement = (over: Line = {}): Line => ({
  key: "release:a11ign/agent-org@v0.1.0", status: "sent", kind: "first", audience: "announcement", providerMessageId: "m-1",
  text: "agent-org v0.1.0 is released", ts: TS, ...over,
});
/** An ask line as the core writes it for a row. */
const ask = (over: Line = {}): Line => ({
  key: "request:a11ign/a11ign#7", status: "sent", kind: "first", audience: "ask", providerMessageId: "m-2",
  text: "Ask: switch worker 4 on", askId: "request:a11ign/a11ign#7:1", row: "a11ign/a11ign#7", rowLess: null, ts: TS, ...over,
});

function paths() {
  const dir = join(scratch, `run-${nextDir += 1}`);
  return { dir, ledgerPath: join(dir, "ledger.jsonl"), failureLogPath: join(dir, "failure-ledger"), cursorPath: join(dir, "audit-cursor") };
}

function appendTo(path: string, lines: Line[]) {
  const ledger = createLedger({ path, now: () => START });
  for (const { ts: _ts, ...line } of lines) ledger.append(line);
}

const halvesOf = (line: Line) => misuseOf(line).map((misuse) => misuse.half);
const entriesOf = (path: string) => (existsSync(path) ? parseFailureLedger(readFileSync(path, "utf8"), path) : []);

describe("an announcement that asks the chairman something is flagged", () => {
  test("a line ending in `?` is flagged, and the same sentence stated is not", () => {
    assert.deepEqual(halvesOf(announcement({ text: "Worker 4 is off.\nShould I switch it on?" })), [HALF.question]);
    assert.deepEqual(halvesOf(announcement({ text: "Worker 4 is off.\nI switched it on." })), [], "the twin: no question, no flag");
  });

  test("each request marker is flagged on its own, and the control is the text without it", () => {
    for (const marker of REQUEST_MARKERS) {
      assert.deepEqual(halvesOf(announcement({ text: `Row 7 is waiting: ${marker}worker-4` })), [HALF.question], marker);
    }
    assert.deepEqual(halvesOf(announcement({ text: "Reply with yes to switch it on" })), [HALF.question], "a request to reply");
    assert.deepEqual(halvesOf(announcement({ text: "Row 7 is waiting on worker-4" })), [], "the twin: none of the markers");
  });

  test("the SAME question in an ask is not this half's: an ask may ask", () => {
    assert.deepEqual(halvesOf(ask({ text: "Switch worker 4 on?" })), []);
    assert.equal(asksSomething("Switch worker 4 on?"), true, "positive control: the text IS a question");
  });

  test("a line from before `audience` existed is classified by its kind", () => {
    const { audience: _audience, ...legacy } = announcement({ text: "Ready to ship?" });
    assert.deepEqual(halvesOf(legacy), [HALF.question]);
  });
});

describe("an ask with no row or no record is flagged", () => {
  test("an ask naming no row and no reason is flagged `ask-row`; with a row it is not", () => {
    assert.deepEqual(halvesOf(ask({ row: null, rowLess: null })), [HALF.row]);
    assert.deepEqual(halvesOf(ask()), [], "the twin: it has its row and its record");
  });

  test("an ask whose kind declares why it has no row is not flagged: that is the declared exception", () => {
    assert.deepEqual(halvesOf(ask({ key: "stall:no-merge", row: null, rowLess: "a stall is the whole org not moving" })), []);
  });

  test("an ask with no `askId` is flagged `ask-record`, and one with it is not", () => {
    assert.deepEqual(halvesOf(ask({ askId: undefined })), [HALF.record]);
    assert.deepEqual(halvesOf(ask({ askId: "" })), [HALF.record], "an empty record is no record");
  });

  test("an ask missing both halves is flagged twice, each half on its own entry", () => {
    assert.deepEqual(halvesOf(ask({ row: null, askId: undefined })), [HALF.row, HALF.record]);
  });
});

describe("only what reached the chairman is audited", () => {
  const offending = { text: "Switch it on?" };
  const cases: [string, Line][] = [
    ["a failed send", announcement({ ...offending, status: "failed" })],
    ["a message held for the digest", announcement({ ...offending, status: "digested" })],
    ["the digest line", announcement({ ...offending, kind: "digest" })],
    ["the open-asks list", ask({ key: "asks:list", kind: "asks-list", row: undefined, askId: undefined })],
    ["a tick of an ask in place", ask({ edited: true, row: null, rowLess: undefined })],
    ["an inbound line", announcement({ ...offending, direction: "in" })],
  ];
  for (const [name, line] of cases) {
    test(`${name} is not audited`, () => {
      assert.deepEqual(halvesOf(line), []);
      assert.equal(auditLines([line]).checked, 0);
    });
  }

  test("the control: the same offending announcement, delivered, is audited and flagged", () => {
    assert.deepEqual(auditLines([announcement(offending)]).misuses.length, 1);
  });
});

describe("the entry names the message and the half, and quotes at most 80 characters", () => {
  test("one flagged announcement is one failure-ledger line of the class, naming ref and half, tab-free", () => {
    const p = paths();
    const text = `Secret check\tgh${"a".repeat(36)} ${"word ".repeat(40)}?`;
    appendTo(p.ledgerPath, [announcement({ key: "release:a", providerMessageId: "m-0" })]);
    auditMessaging({ ...p, now: START, report: () => {}, print: () => {} });
    appendTo(p.ledgerPath, [announcement({ text, providerMessageId: "m-9" })]);
    const result = auditMessaging({ ...p, now: START + MINUTE, report: () => {}, print: () => {} });
    const [entry, ...rest] = entriesOf(p.failureLogPath);
    assert.equal(result.flagged, 1);
    assert.equal(rest.length, 0);
    assert.equal(entry.classKey, MESSAGING_AUDIENCE_MISUSE_KIND);
    assert.match(entry.ref, /^m-9 announcement-question "/);
    const quoted = JSON.parse(entry.ref.slice(entry.ref.indexOf('"')));
    assert.ok(quoted.length <= EXCERPT_LENGTH, `${quoted.length} characters quoted`);
    assert.ok(!entry.ref.includes("a".repeat(36)), "a token-shaped string is redacted before the cut");
    assert.equal(entry.at, START, "dated by the line, not by the tick that found it");
  });
});

describe("the cursor: a pass writes only what it has not seen, and says how many it checked", () => {
  test("the first run baselines at the end: what was sent before the record existed is not an incident", () => {
    const p = paths();
    appendTo(p.ledgerPath, [ask({ row: undefined, askId: undefined, rowLess: undefined })]);
    const said: string[] = [];
    const result = auditMessaging({ ...p, now: START, report: () => {}, print: (line) => said.push(line) });
    assert.equal(result.flagged, 0);
    assert.deepEqual(entriesOf(p.failureLogPath), []);
    assert.deepEqual(said, [], "a baseline pass found nothing and says nothing (agent-org#699)");
    assert.equal(result.line, "messaging audit: 0 checked, 0 flagged", "the reading is still on the result");
    assert.equal(readFileSync(p.cursorPath, "utf8").trim(), "1");
  });

  test("a second pass over the same ledger writes nothing; a new offending line is the only new entry", () => {
    const p = paths();
    appendTo(p.ledgerPath, [announcement()]);
    auditMessaging({ ...p, now: START, report: () => {}, print: () => {} });
    appendTo(p.ledgerPath, [announcement({ text: "Ready?", providerMessageId: "m-5" }), ask({ providerMessageId: "m-6" })]);
    const said: string[] = [];
    const first = auditMessaging({ ...p, now: START + MINUTE, report: () => {}, print: (line) => said.push(line) });
    assert.deepEqual({ checked: first.checked, flagged: first.flagged, appended: first.appended }, { checked: 2, flagged: 1, appended: 1 });
    const second = auditMessaging({ ...p, now: START + 2 * MINUTE, report: () => {}, print: (line) => said.push(line) });
    assert.deepEqual({ checked: second.checked, flagged: second.flagged, appended: second.appended }, { checked: 0, flagged: 0, appended: 0 });
    assert.equal(entriesOf(p.failureLogPath).length, 1, "100 ticks would still be one entry");
    assert.deepEqual(said, ["messaging audit: 2 checked, 1 flagged"], "the pass that flagged says so; the clean one after it says nothing");
    assert.equal(second.line, "messaging audit: 0 checked, 0 flagged", "the silent pass still carries its count");
  });

  test("a refused append leaves the cursor, so the next pass tries again and reports why", () => {
    const p = paths();
    appendTo(p.ledgerPath, [announcement()]);
    auditMessaging({ ...p, now: START, report: () => {}, print: () => {} });
    appendTo(p.ledgerPath, [announcement({ text: "Ready?", providerMessageId: "m-5" })]);
    const reported: string[] = [];
    const blocked = auditMessaging({ ...p, failureLogPath: join(p.dir, "no-such", "\0bad"), now: START, report: (line) => reported.push(line), print: () => {} });
    assert.notEqual(blocked.refused, null);
    assert.ok(reported.some((line) => line.includes("NOT RECORDED")), "the refusal is reported, never swallowed");
    assert.equal(readFileSync(p.cursorPath, "utf8").trim(), "1", "the cursor did not move past the unwritten line");
    const retried = auditMessaging({ ...p, now: START, report: () => {}, print: () => {} });
    assert.equal(retried.flagged, 1);
    assert.equal(entriesOf(p.failureLogPath).length, 1);
  });

  test("an unreadable cursor is reported and the pass does not run, never read as start-over", () => {
    const p = paths();
    appendTo(p.ledgerPath, [announcement({ text: "Ready?" })]);
    writeFileSync(p.cursorPath, "not a count");
    const reported: string[] = [];
    const result = auditMessaging({ ...p, now: START, report: (line) => reported.push(line), print: () => {} });
    assert.notEqual(result.refused, null);
    assert.ok(reported[0].startsWith("messaging audit: NOT RUN"));
    assert.deepEqual(entriesOf(p.failureLogPath), []);
  });
});

describe("the count line is printed only when something was flagged (agent-org#699)", () => {
  /** One pass over `p`, with what it printed and what it reported. */
  function pass(p: ReturnType<typeof paths>, now: number) {
    const said: string[] = [];
    const reported: string[] = [];
    const result = auditMessaging({ ...p, now, report: (line) => reported.push(line), print: (line) => said.push(line) });
    return { result, said, reported };
  }
  /** A scratch host whose cursor is already at the end of one earlier line, so the next pass audits only what is appended after. */
  function baselined() {
    const p = paths();
    appendTo(p.ledgerPath, [announcement({ key: "release:earlier", providerMessageId: "m-0" })]);
    pass(p, START);
    return p;
  }

  test("a clean pass prints nothing: lines were checked, none flagged, and the result still carries the count", () => {
    const p = baselined();
    appendTo(p.ledgerPath, [announcement({ text: "Worker 4 is off. I switched it on.", providerMessageId: "m-1" })]);
    const clean = pass(p, START + MINUTE);
    assert.equal(clean.result.checked, 1, "positive control: the pass did read a line, so nothing printed is not nothing read");
    assert.equal(clean.result.flagged, 0);
    assert.deepEqual(clean.said, []);
    assert.equal(clean.result.line, "messaging audit: 1 checked, 0 flagged");
    assert.deepEqual(clean.reported, [], "and it reports nothing on stderr either");

    const q = baselined();
    appendTo(q.ledgerPath, [announcement({ text: "Worker 4 is off. Should I switch it on?", providerMessageId: "m-1" })]);
    assert.deepEqual(pass(q, START + MINUTE).said, ["messaging audit: 1 checked, 1 flagged"], "the twin with the one offending part: the same pass is loud");
  });

  test("a pass that flags one still prints `messaging audit: n checked, 1 flagged`", () => {
    const p = baselined();
    appendTo(p.ledgerPath, [
      announcement({ text: "Ready to ship?", providerMessageId: "m-1" }),
      announcement({ text: "Shipped.", providerMessageId: "m-2" }),
    ]);
    const flagged = pass(p, START + MINUTE);
    assert.equal(flagged.result.flagged, 1);
    assert.deepEqual(flagged.said, ["messaging audit: 2 checked, 1 flagged"]);
    assert.equal(flagged.result.line, flagged.said[0], "what is printed is what the result carries");

    const q = baselined();
    appendTo(q.ledgerPath, [
      announcement({ text: "Ready to ship.", providerMessageId: "m-1" }),
      announcement({ text: "Shipped.", providerMessageId: "m-2" }),
    ]);
    assert.deepEqual(pass(q, START + MINUTE).said, [], "the twin with the question stated: the same two lines, nothing printed");
  });

  test("the first-run baseline pass prints nothing and still writes the cursor", () => {
    const p = paths();
    appendTo(p.ledgerPath, [announcement({ text: "Something earlier?", providerMessageId: "m-0" }), ask({ providerMessageId: "m-1" })]);
    const first = pass(p, START);
    assert.deepEqual(first.said, []);
    assert.equal(readFileSync(p.cursorPath, "utf8").trim(), "2", "the cursor is at the end of the ledger");
    assert.ok(first.reported.some((line) => line.startsWith("messaging audit: first run, baseline at 2")), "the baseline is still said once, on the report channel");
    assert.deepEqual(entriesOf(p.failureLogPath), [], "what was sent before the record is not audited");

    appendTo(p.ledgerPath, [announcement({ text: "Ready to ship?", providerMessageId: "m-2" })]);
    assert.deepEqual(pass(p, START + MINUTE).said, ["messaging audit: 1 checked, 1 flagged"], "the control: the pass after the baseline is not silenced by it");
  });

  test("a clean pass that could not write its cursor is still reported, though it prints nothing", { skip: process.getuid?.() === 0 && "root writes through a read-only file, so the write cannot be made to fail" }, () => {
    const p = baselined();
    appendTo(p.ledgerPath, [announcement({ text: "All quiet.", providerMessageId: "m-1" })]);
    chmodSync(p.cursorPath, 0o444);
    const blocked = pass(p, START + MINUTE);
    assert.equal(blocked.result.checked, 1, "positive control: a line was read and the pass ran");
    assert.equal(blocked.result.flagged, 0);
    assert.notEqual(blocked.result.refused, null);
    assert.deepEqual(blocked.said, []);
    assert.ok(blocked.reported.some((line) => line.startsWith("messaging audit: cursor NOT WRITTEN")), "silence on stdout must not hide a pass that did not finish");
  });
});

describe("against the real core: the lines the messenger writes are the lines the audit reads", () => {
  test("a release whose text asks is flagged; a request, a row-less stall and a stall's tick are not", async () => {
    const p = paths();
    let at = START;
    const provider = createFakeProvider();
    const ledger = createLedger({ path: p.ledgerPath, now: () => at });
    const messenger = createMessenger({ provider, ledger, now: () => at });
    auditMessaging({ ...p, now: at, report: () => {}, print: () => {} });
    const event = (over: Record<string, unknown>) => ({ severity: "warning", firstSeenAt: START, text: "x", ...over });
    await messenger.tick([
      event({ key: "request:a11ign/a11ign#7", kind: "request", text: "Ask: switch worker 4 on" }),
      event({ key: "stall:no-merge", kind: "stall", text: "Nothing merged for 3 hours" }),
      event({ key: "release:a11ign/agent-org@v0.7.8", kind: "release", text: "v0.7.8 is out. Shall I tell the fleet?" }),
    ]);
    at += MINUTE;
    await messenger.tick([event({ key: "stall:no-merge", kind: "stall", text: "Merged again", resolved: true })]);
    const said: string[] = [];
    const result = auditMessaging({ ...p, now: at, report: () => {}, print: (line) => said.push(line) });
    const written = JSON.parse(`[${readFileSync(p.ledgerPath, "utf8").trim().split("\n").join(",")}]`);
    assert.ok(written.some((line: Line) => line.edited === true), "positive control: the stall WAS ticked in place, so the skip is exercised");
    assert.equal(result.checked, 3, said.join());
    assert.equal(result.flagged, 1);
    const [entry] = entriesOf(p.failureLogPath);
    assert.match(entry.ref, /announcement-question "v0\.7\.8 is out\. Shall I tell the fleet\?"$/);
  });
});
