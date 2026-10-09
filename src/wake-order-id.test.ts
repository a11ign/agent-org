// no-token: clearContext -- every herdr call is the injected `run`; nothing here reaches gh
/**
 * #4068 (#4055 move 5): A FOLLOW-UP ORDER OPENS WITH AN ORDER ID, NOT AN IDENTITY LINE, and the transcript's session is read from that id.
 *
 * The identity sentence was not only decoration: `token-audit`'s `sessionOf` attributed a transcript to a session by that exact phrase, so the
 * attribution moves first (the header carries `session:`, the reader reads both spellings) and only then is the sentence dropped. Each claim
 * below has its negative control beside it: a header given to every order would pass the follow-up half by removing the first-contact
 * preamble, and a reader that accepted anything would pass the attribution half.
 *
 * DRIVEN THROUGH `deliver`, the path that types an order, because a check over `addressed` alone passes with `deliver` never handing it an id.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressed, deliver, ledgerLine, wakeIdOf, CONTEXT_ACTION } from "./wake.ts";
import { sessionOf } from "./token-audit.ts";

const AT = 1_791_000_000_000;
const LATER = AT + 60_000;
const SEAT = "worker-tooling";
const INSTANCE = "worker-4068";
const ROSTER = ["worker-capture", "worker-judge", SEAT];
const BODY = "#2537 at `b778b0cb` has FAILING checks and is blocked.";
/** An EMPTY transcript root, so a real org label this file reuses is never compacted by a coincidence of a live session's own transcript. */
const NO_TRANSCRIPTS = join(tmpdir(), "a11y-4068-no-transcripts");
const order = (session, extra = {}) => ({ session, cause: "pr-checks-failing", causeKey: `${session}/pr-checks-failing/pr-2537/b778b0cb`, prompt: BODY, ...extra });

/** A `run` that records every herdr call; `ordered(label)` is what was TYPED to `label` as the order, the `/clear` not being one. */
function recorder() {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return "{}";
  };
  const ordered = (label) => calls.filter((c) => c[2] === "agent" && c[3] === "prompt" && c[4] === label && c[5] !== "/clear").map((c) => c[5]);
  return { run, ordered };
}

/** One delivery through `deliver`, with the clock fixed and every ledger write collected rather than made. */
function delivered(orderToSend, label, { now = () => AT } = {}) {
  const r = recorder();
  const recorded = [];
  const got = deliver([orderToSend], [{ label, status: "idle" }], ROSTER,
    { run: r.run, now, sleep: () => {}, contextRoot: NO_TRANSCRIPTS, record: (key, recipient, noClear, at) => recorded.push({ key, noClear, at }) });
  assert.deepEqual(got.refused, [], `${label}: the order was delivered`);
  const [typed] = r.ordered(label);
  assert.ok(typed, `${label}: the order WAS typed, so the assertions below are not about an empty run`);
  return { typed, recorded };
}

// --- (1) the follow-up opens on the order header, restates no identity, and its id is the ledger's -------------------------------------------

test("#4068 a standing seat's follow-up begins with the order header and contains no `You are` sentence", () => {
  const { typed } = delivered(order(SEAT, { resume: true }), SEAT);
  assert.ok(typed.startsWith(`[order:wake:${SEAT}:${AT} session:${SEAT} cause:pr-checks-failing]`), typed.slice(0, 160));
  assert.ok(typed.endsWith(`\n\n${BODY}`), "and the order follows (a kept seat's staleness clause sits between, pinned below)");
  assert.ok(!typed.includes("You are"), "no identity sentence");
  assert.ok(!typed.includes("a follow-up order to your session"), "and not the old header's wording either");
});

test("#4068 the order id IS the wake id the ledger records for that delivery, and moves with the delivery", () => {
  const first = delivered(order(SEAT, { resume: true }), SEAT);
  const [line] = first.recorded;
  assert.equal(line.at, AT, "`deliver` hands the ledger writer the instant it named in the header");
  assert.equal(first.typed.match(/^\[order:(\S+) /)?.[1], wakeIdOf(SEAT, line.at), "the header's id is the wake id of that very instant");
  assert.equal(ledgerLine(line.at, line.key).split("\t")[0], String(AT), "and that instant is the ledger line's first field, the number `wake:<session>:<ms>` is made of");
  const second = delivered(order(SEAT, { resume: true }), SEAT, { now: () => LATER });
  assert.notEqual(second.typed.match(/^\[order:(\S+) /)?.[1], first.typed.match(/^\[order:(\S+) /)?.[1], "CONTROL: a later delivery names a different id, so the match above is not a constant");
});

test("#4068 a per-row instance's follow-up carries the same header (the instance form, not only the standing seat's)", () => {
  const { typed, recorded } = delivered(order(INSTANCE), INSTANCE);
  assert.ok(typed.startsWith(`[order:wake:${INSTANCE}:${AT} session:${INSTANCE} cause:pr-checks-failing]`));
  assert.equal(recorded[0].at, AT);
});

// --- (2) sessionOf, both directions -------------------------------------------------------------------------------------------------------

test("#4068 sessionOf attributes a transcript opening on the new header AND one opening on the old phrase", () => {
  const { typed } = delivered(order(SEAT, { resume: true }), SEAT);
  assert.equal(sessionOf(typed), SEAT, "the new header, as a delivery really writes it");
  assert.equal(sessionOf(`[order:wake:${INSTANCE}:${AT} session:${INSTANCE} cause:none]\n\nx`), INSTANCE);
  assert.equal(sessionOf(`[session:${INSTANCE} cause:none]\n\nx`), INSTANCE, "a header with no order id (a `prompt:session` order)");
  assert.equal(sessionOf(`You are \`${INSTANCE}\` -- a follow-up order to your session.\n\nx`), INSTANCE, "the OLD follow-up phrase, from a transcript written before this change");
  assert.equal(sessionOf(addressed(order(SEAT), SEAT)), SEAT, "and a first-contact order's own sentence");
});

test("#4068 sessionOf: a text with neither form is null, and the earlier of two forms is the delivery's own", () => {
  assert.equal(sessionOf(BODY), null, "CONTROL: an order with no name is NOT attributed, so the attributions above prove the header");
  assert.equal(sessionOf("session:worker-9 is a phrase, not a header"), null, "CONTROL: the bare words without the header's brackets");
  assert.equal(sessionOf("[order:wake:x session:Bad_Name cause:none]"), null, "CONTROL: a name outside the session alphabet");
  assert.equal(sessionOf(`[order:wake:a:1 session:worker-1 cause:none]\n\nquoting: You are \`worker-2\``), "worker-1", "the header comes first");
  assert.equal(sessionOf(`You are \`worker-2\`, an org session.\n\nquoting: [session:worker-1 cause:none]`), "worker-2", "and so does the sentence");
});

// --- (3) the staleness clause is a fact about the delivery, and is untouched -----------------------------------------------------------------

const STALE = " Your window was NOT cleared, so what it holds from earlier turns is a reading at a moment: re-read the row, the PR and the API before acting on it.";

test("#4068 the staleness clause of a kept or compacted standing seat's delivery is present, byte for byte, right after the header", () => {
  for (const context of [CONTEXT_ACTION.KEPT, CONTEXT_ACTION.COMPACTED]) {
    const text = addressed(order(SEAT), SEAT, { followUp: true, context, orderId: wakeIdOf(SEAT, AT) });
    assert.ok(text.startsWith(`[order:wake:${SEAT}:${AT} session:${SEAT} cause:pr-checks-failing]${STALE}\n\n${BODY}`), `${context}: ${text.slice(0, 120)}`);
  }
});

test("#4068 the clause is still absent where it was: a per-row instance, and a standing seat that was cleared", () => {
  const instance = addressed(order(INSTANCE), INSTANCE, { followUp: true, context: CONTEXT_ACTION.KEPT, orderId: wakeIdOf(INSTANCE, AT) });
  assert.ok(!instance.includes("Your window was NOT cleared"), "an instance's window is its one row (#2483)");
  const cleared = addressed(order(SEAT), SEAT, { followUp: true, context: CONTEXT_ACTION.CLEARED, orderId: wakeIdOf(SEAT, AT) });
  assert.ok(!cleared.includes("Your window was NOT cleared"));
});

// --- (4) a first-contact order is unchanged -------------------------------------------------------------------------------------------------

test("#4068 a first-contact order (the preamble form) still opens on the identity sentence and carries no order header", () => {
  const { typed } = delivered(order(SEAT), SEAT);
  assert.ok(typed.startsWith(`You are \`${SEAT}\`, an org session in this repository. Use that name wherever a command asks which session you are (\`--session=${SEAT}\`).\n\n`), typed.slice(0, 200));
  assert.ok(typed.includes("Work autonomously to the end"), "and the preamble that follows the order is still there");
  assert.ok(!typed.includes("[order:"), "CONTROL: the order header is the follow-up's alone, so the tests above are not met by giving it to everyone");
  assert.equal(sessionOf(typed), SEAT);
});
