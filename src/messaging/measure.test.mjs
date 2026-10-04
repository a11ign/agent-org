// @ts-check
// `messaging:measure` (a11ign/a11ign#3411): what a reading of the ledger says, over a FIXTURE ledger whose every number is known.
//
// **EACH CASE HAS ITS POSITIVE CONTROL, AND THE EMPTY WINDOW'S IS THE NON-EMPTY FIXTURE.** (4) asserts "no messages in the window" over a window holding no lines; the same ledger
// read over a window that holds them (1) prints numbers, so an empty answer is not the parser failing. (3) asserts a request with an `answer` line is NOT withdrawn beside the one
// with none that IS, so a counter that withdraws everything, or nothing, fails by name.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";

import { EXIT, main } from "./measure.mjs";
import { defaultLedgerPath } from "./state.mjs";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const scratch = mkdtempSync(join(tmpdir(), "messaging-measure-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let nextCase = 0;

/** @param {string} ts @param {Record<string, unknown>} fields @returns {Record<string, unknown>} */
const line = (ts, fields) => ({ ...fields, ts });

/** The chairman's message `ref`, received at `receivedAt`, acknowledged `ackAfterMs` later, and what became of it (`verdict`, and the fields that go with it). @param {{ref: string, update: number, receivedAt: string, ackAfterMs: number | null, verdict?: string, more?: Record<string, unknown>}} message */
function inbound({ ref, update, receivedAt, ackAfterMs, verdict = "queued", more = {} }) {
  const ackedAt = new Date(Date.parse(receivedAt) + (ackAfterMs ?? 0)).toISOString();
  return [
    line(receivedAt, { direction: "in", updateId: update, verdict: "forward", reason: null, kind: "message" }),
    line(ackedAt, { direction: "in", origin: "converse", updateId: update, messageRef: ref, verdict, ackRef: ackAfterMs === null ? null : `${ref}1`, ...more }),
  ];
}

/** @param {string} issue @param {string} kind @param {string} ts */
const ask = (issue, kind, ts) => line(ts, { key: `request:a11ign/a11ign#${issue}`, status: "sent", kind });
/** @param {string} issue @param {string} step @param {string} ts */
const answer = (issue, step, ts) => line(ts, { direction: "answer", request: `request:a11ign/a11ign#${issue}`, messageRef: "5", step });

/** @param {Record<string, unknown>[]} lines @param {string[]} argv @returns {{code: number, out: string, err: string}} the command run over a home whose ledger holds `lines` */
function measureOver(lines, argv = []) {
  const home = join(scratch, `case-${nextCase += 1}`);
  const path = defaultLedgerPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  const [out, err] = [/** @type {string[]} */ ([]), /** @type {string[]} */ ([])];
  const code = main(argv, { home, now: () => NOW, out: (text) => out.push(text), err: (text) => err.push(text) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const TWO_MESSAGES = [
  ...inbound({ ref: "6", update: 1, receivedAt: "2026-10-04T09:00:00.000Z", ackAfterMs: 2000 }),
  line("2026-10-04T09:09:00.000Z", { direction: "reply", replyTo: "6", status: "replied", providerMessageId: "7" }),
  ...inbound({ ref: "8", update: 2, receivedAt: "2026-10-04T10:00:00.000Z", ackAfterMs: 3000 }),
];

describe("(1b) a message the liaison's queue refused and ceo's took (a11ign/a11ign#3538) is counted, acknowledged and answered like any other", () => {
  const REROUTED = [
    ...inbound({ ref: "6", update: 1, receivedAt: "2026-10-04T09:00:00.000Z", ackAfterMs: 2000, verdict: "rerouted-to-ceo", more: { taker: "ceo", handoff: "handoff/ceo/ab12cd34", refusals: ["NOT PROMPTED, AND NOT QUEUED: no session named \"liaison\""] } }),
    line("2026-10-04T09:09:00.000Z", { direction: "reply", replyTo: "6", status: "replied", providerMessageId: "7" }),
    ...inbound({ ref: "8", update: 2, receivedAt: "2026-10-04T10:00:00.000Z", ackAfterMs: 3000, verdict: "rerouted-to-ceo", more: { taker: "ceo", handoff: "handoff/ceo/ef56ab78", refusals: [] } }),
    ...inbound({ ref: "9", update: 3, receivedAt: "2026-10-04T11:00:00.000Z", ackAfterMs: 1000, verdict: "refused", more: { taker: null, handoff: null, refusals: ["a", "b"] } }),
  ];

  test("every message is in the count whatever became of it: a rerouted one is answered when ceo replies, unanswered when he has not, and a lost one is still counted", () => {
    const { code, out } = measureOver(REROUTED);
    assert.equal(code, EXIT.ok);
    assert.match(out, /messages from the chairman: 3/, "none dropped from the count");
    assert.match(out, /message 6 received 2026-10-04T09:00:00.000Z: acknowledged after 2 s; answered after 540 s$/m, "rerouted and answered");
    assert.match(out, /message 8 received 2026-10-04T10:00:00.000Z: acknowledged after 3 s; unanswered$/m, "rerouted and not yet answered is unanswered, as any message is");
    assert.match(out, /message 9 received 2026-10-04T11:00:00.000Z: acknowledged after 1 s; unanswered$/m, "the lost one is counted too (the control: the count is by line, not by verdict)");
  });
});

describe("(1) per message: seconds to acknowledge, and seconds to the first reply that names it, or unanswered", () => {
  test("two messages, one acknowledged in 2 s and answered in 9 min, one acknowledged and never answered", () => {
    const { code, out } = measureOver(TWO_MESSAGES);
    assert.equal(code, EXIT.ok);
    assert.match(out, /messages from the chairman: 2/);
    assert.match(out, /message 6 received 2026-10-04T09:00:00.000Z: acknowledged after 2 s; answered after 540 s$/m);
    assert.match(out, /message 8 received 2026-10-04T10:00:00.000Z: acknowledged after 3 s; unanswered$/m);
  });

  test("a converse line with `ackAt` is timed from `ackAt`, not from its later `ts`; one without `ackAt` still from `ts`; one with no `ackRef` from neither", () => {
    const received = line("2026-10-04T09:00:00.000Z", { direction: "in", updateId: 1, verdict: "forward", reason: null, kind: "message" });
    const converse = (/** @type {string} */ ts, /** @type {Record<string, unknown>} */ fields) => line(ts, { direction: "in", origin: "converse", verdict: "queued", ...fields });
    const { out } = measureOver([
      received,
      converse("2026-10-04T09:00:07.000Z", { updateId: 1, messageRef: "6", ackRef: "61", ackAt: "2026-10-04T09:00:02.000Z" }),
      line("2026-10-04T10:00:00.000Z", { direction: "in", updateId: 2, verdict: "forward", reason: null, kind: "message" }),
      converse("2026-10-04T10:00:03.000Z", { updateId: 2, messageRef: "8", ackRef: "81" }),
      line("2026-10-04T11:00:00.000Z", { direction: "in", updateId: 3, verdict: "forward", reason: null, kind: "message" }),
      converse("2026-10-04T11:00:04.000Z", { updateId: 3, messageRef: "9", ackRef: null, ackAt: "2026-10-04T11:00:01.000Z" }),
    ]);
    assert.match(out, /message 6 .*: acknowledged after 2 s;/);
    assert.match(out, /message 8 .*: acknowledged after 3 s;/);
    assert.match(out, /message 9 .*: not acknowledged;/);
  });

  test("a reply that names no message (`replyTo: null`) answers none of them", () => {
    const { out } = measureOver([...TWO_MESSAGES, line("2026-10-04T10:05:00.000Z", { direction: "reply", replyTo: null, status: "replied" })]);
    assert.match(out, /message 8 .*unanswered$/m);
  });

  test("a reply that failed to send answers nothing, and a message whose acknowledgement was not sent says so", () => {
    const { out } = measureOver([
      ...inbound({ ref: "6", update: 1, receivedAt: "2026-10-04T09:00:00.000Z", ackAfterMs: null }),
      line("2026-10-04T09:01:00.000Z", { direction: "reply", replyTo: "6", status: "failed" }),
    ]);
    assert.match(out, /message 6 .*: not acknowledged; unanswered$/m);
  });
});

describe("(3) asks: sent, answered, and withdrawn (cleared with no answer before it)", () => {
  const ASKS = [
    ask("1", "first", "2026-10-04T08:00:00.000Z"), answer("1", "comment", "2026-10-04T08:30:00.000Z"), answer("1", "remove-label", "2026-10-04T08:30:01.000Z"), ask("1", "cleared", "2026-10-04T08:31:00.000Z"),
    ask("2", "first", "2026-10-04T08:00:00.000Z"), ask("2", "cleared", "2026-10-04T09:00:00.000Z"),
    ask("3", "first", "2026-10-04T08:00:00.000Z"),
  ];

  test("a request cleared after an `answer` line is answered, one cleared with none is withdrawn, one still open is neither", () => {
    const { out } = measureOver(ASKS);
    assert.match(out, /^asks sent: 3$/m);
    assert.match(out, /^asks answered by the chairman: 1$/m);
    assert.match(out, /^asks withdrawn \(cleared with no answer before it\): 1$/m);
  });

  test("an answer that failed (`step: failed`) answers nothing, so the clearing that follows is a withdrawal", () => {
    const { out } = measureOver([ask("1", "first", "2026-10-04T08:00:00.000Z"), answer("1", "failed", "2026-10-04T08:30:00.000Z"), ask("1", "cleared", "2026-10-04T08:31:00.000Z")]);
    assert.match(out, /^asks answered by the chairman: 0$/m);
    assert.match(out, /^asks withdrawn .*: 1$/m);
  });

  test("an answer belongs to the ask it was made under: a re-ask cleared with no answer is withdrawn, though an earlier ask of the same row was answered", () => {
    const { out } = measureOver([
      ask("1", "first", "2026-10-04T06:00:00.000Z"), answer("1", "comment", "2026-10-04T06:10:00.000Z"), ask("1", "cleared", "2026-10-04T06:11:00.000Z"),
      ask("1", "first", "2026-10-04T07:00:00.000Z"), ask("1", "cleared", "2026-10-04T07:30:00.000Z"),
    ]);
    assert.match(out, /^asks sent: 2$/m);
    assert.match(out, /^asks answered by the chairman: 1$/m);
    assert.match(out, /^asks withdrawn .*: 1$/m);
  });

  test("asks the brief rule refused are counted by reason, and a stall alert or summary is not an ask", () => {
    const reason = "alert not sent: the row has no brief for the chairman from an org account, so nothing says what he is to do";
    const { out } = measureOver([
      ...ASKS,
      line("2026-10-04T10:00:00.000Z", { key: "request:a11ign/a11ign#9", status: "invalid", kind: "source-note", error: reason }),
      line("2026-10-04T10:01:00.000Z", { key: "request:a11ign/a11ign#10", status: "invalid", kind: "source-note", error: reason }),
      line("2026-10-04T10:02:00.000Z", { key: "stall:all-idle", status: "sent", kind: "first" }),
    ]);
    assert.match(out, /^asks refused by the brief rule: 2$/m);
    assert.match(out, new RegExp(`^  2 x ${reason}$`, "m"));
    assert.match(out, /^asks sent: 3$/m);
  });
});

describe("the window", () => {
  test("only lines inside `--window=<n>h` are read: the same ledger over 1 h holds neither message, over 24 h both", () => {
    assert.match(measureOver(TWO_MESSAGES, ["--window=24h"]).out, /messages from the chairman: 2/);
    assert.equal(measureOver(TWO_MESSAGES, ["--window=1h"]).out, "no messages in the window");
  });

  test("a message answered after the window closed still reads as answered", () => {
    const { out } = measureOver([...inbound({ ref: "6", update: 1, receivedAt: "2026-10-04T10:00:00.000Z", ackAfterMs: 1000 }), line("2026-10-04T12:30:00.000Z", { direction: "reply", replyTo: "6", status: "replied" })], ["--window=2h"]);
    assert.match(out, /answered after 9000 s$/m);
  });

  test("anything but a whole number of hours and an `h` is refused (exit 2) and prints no reading", () => {
    for (const bad of ["--window=24", "--window=0h", "--window=1.5h", "--window=soon"]) {
      const { code, out, err } = measureOver(TWO_MESSAGES, [bad]);
      assert.equal(code, EXIT.refused, bad);
      assert.equal(out, "", bad);
      assert.match(err, /whole number of hours/, bad);
    }
  });
});

describe("(4) a window with no lines prints \"no messages in the window\", never a zero rate", () => {
  test("an empty ledger, and a ledger whose lines are all older than the window, say so and print no counts", () => {
    for (const lines of [[], [line("2026-09-01T00:00:00.000Z", { direction: "in", updateId: 1, verdict: "forward", kind: "message" })]]) {
      const { code, out } = measureOver(lines);
      assert.equal(code, EXIT.ok);
      assert.equal(out, "no messages in the window");
    }
  });

  test("positive control: the same command over a window that holds lines prints counts, so the line above is not the parser failing", () => {
    const { out } = measureOver(TWO_MESSAGES);
    assert.notEqual(out, "no messages in the window");
    assert.match(out, /^asks sent: 0$/m);
  });

  test("a missing ledger file is an empty window, not an error", () => {
    const [out, err] = [/** @type {string[]} */ ([]), /** @type {string[]} */ ([])];
    const code = main([], { home: join(scratch, "no-such-home"), now: () => NOW, out: (text) => out.push(text), err: (text) => err.push(text) });
    assert.deepEqual({ code, out, err }, { code: EXIT.ok, out: ["no messages in the window"], err: [] });
  });
});
