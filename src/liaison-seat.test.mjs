// @ts-check
// no-token: clearContext -- every herdr and gh call is the injected `run` and the roster is a temp-dir fixture; nothing here reaches a pane or a network
// A PERSISTENT SEAT IS NEVER CLEARED (a11ign/a11ign#3415, chairman messaging B1): `"persistent": true` on a roster entry is a ROLE
// fact, and `clearBeforeOrder` keeps (and, over the threshold, `/compact`s) that seat's window instead of wiping it before an order.
//
// THE ROSTER IS A FIXTURE, never the host's: this row adds no entry (B5 does) and starts no process (E2 does).
//
// POSITIVE CONTROLS, because "nothing was cleared" is also what a `clearBeforeOrder` that clears nothing reports: every test that
// asserts a seat is not cleared sits beside `ceo` -- the same fixture roster, no fact -- being cleared, and a per-row instance
// behaving as it did before.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { COMPACT_THRESHOLD_TOKENS, DRAINED_SEEN, PERSISTENT_SEEN, clearBeforeOrder, engineerEligibility, isPersistentRole,
  keepsContext, persistentRoles, route } from "./wake.mjs";
import { clearThenPrompt } from "./prompt-session.mjs";
import { claimRow, persistentReason } from "./row-claim.mjs";

const noSettle = () => {};
const SEAT = "liaison";
const scratch = mkdtempSync(join(tmpdir(), "liaison-seat-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const SESSIONS = join(scratch, "sessions.json");
writeFileSync(SESSIONS, JSON.stringify({ live: [
  { name: SEAT, role: "liaison", persistent: true },
  { name: "ceo", role: "ceo" },
  { name: "worker-tooling", role: "engineer", drain: true },
] }));
/** A transcript root holding no transcript at all: "cannot tell". */
const NO_TRANSCRIPTS = join(scratch, "no-transcripts");

/** A transcript root whose newest turn for `label` read `cacheRead` tokens (`instanceCacheRead`'s own reader). @param {string} label @param {number} cacheRead */
function transcriptRootFor(label, cacheRead) {
  const dir = mkdtempSync(join(scratch, "t-"));
  writeFileSync(join(dir, "t.jsonl"), `${[
    JSON.stringify({ type: "user", message: { role: "user", content: `You are \`${label}\`, an org session in this repository.` } }),
    JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-sonnet-5",
      usage: { input_tokens: 5, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: 12 } } }),
  ].join("\n")}\n`);
  return dir;
}

/** A `run` recording every herdr call; `typed()` is what each session was sent, in order. */
function recorder() {
  /** @type {string[][]} */
  const calls = [];
  return { calls,
    run: (/** @type {string[]} */ args) => { calls.push(args); return "{}"; },
    typed: () => calls.filter((c) => c[2] === "agent" && c[3] === "prompt").map((c) => `${c[4]}: ${c[5]}`) };
}

describe("the roster fact", () => {
  test("persistentRoles reads the mark from the file, whatever the role, and only the mark", () => {
    assert.deepEqual(persistentRoles(SESSIONS), [SEAT]);
    assert.equal(isPersistentRole(SEAT, SESSIONS), true);
    assert.equal(isPersistentRole("ceo", SESSIONS), false, "CONTROL: an entry without the fact is not persistent");
    assert.equal(isPersistentRole("worker-4", SESSIONS), false, "CONTROL: an address the roster does not list is not persistent");
  });

  test("keepsContext is true for a persistent seat and a per-row instance, false for a standing seat", () => {
    assert.equal(keepsContext(SEAT, SESSIONS), true);
    assert.equal(keepsContext("worker-11", SESSIONS), true, "a per-row instance, as before");
    assert.equal(keepsContext("ceo", SESSIONS), false, "CONTROL");
  });
});

describe("clearBeforeOrder", () => {
  test("(1) a persistent seat is sent no /clear and `sent` is false", () => {
    const r = recorder();
    assert.deepEqual(clearBeforeOrder(r.run, SEAT, noSettle, NO_TRANSCRIPTS, SESSIONS), { sent: false, refusal: null });
    assert.deepEqual(r.calls, []);
  });

  test("(2) over the threshold it is sent /compact and not /clear", () => {
    const r = recorder();
    const root = transcriptRootFor(SEAT, COMPACT_THRESHOLD_TOKENS + 1);
    assert.deepEqual(clearBeforeOrder(r.run, SEAT, noSettle, root, SESSIONS), { sent: false, refusal: null });
    assert.deepEqual(r.typed(), [`${SEAT}: /compact`]);
  });

  test("(2) CONTROL: AT the threshold, nothing is sent", () => {
    const r = recorder();
    clearBeforeOrder(r.run, SEAT, noSettle, transcriptRootFor(SEAT, COMPACT_THRESHOLD_TOKENS), SESSIONS);
    assert.deepEqual(r.calls, []);
  });

  test("(3) with no readable transcript it sends nothing -- cannot tell is never assumed big", () => {
    const r = recorder();
    clearBeforeOrder(r.run, SEAT, noSettle, NO_TRANSCRIPTS, SESSIONS);
    assert.deepEqual(r.calls, []);
  });

  test("(5) CONTROL: the same fixture roster still /clears a standing seat without the fact", () => {
    const r = recorder();
    assert.deepEqual(clearBeforeOrder(r.run, "ceo", noSettle, NO_TRANSCRIPTS, SESSIONS), { sent: true, refusal: null });
    assert.deepEqual(r.typed(), ["ceo: /clear"]);
    // ... and a standing seat is cleared however large it is: the compact branch is for a seat that keeps its window.
    const big = recorder();
    clearBeforeOrder(big.run, "ceo", noSettle, transcriptRootFor("ceo", COMPACT_THRESHOLD_TOKENS * 2), SESSIONS);
    assert.deepEqual(big.typed(), ["ceo: /clear"]);
  });

  test("(5) CONTROL: a per-row instance behaves as before -- no clear, compacted over the threshold", () => {
    const quiet = recorder();
    assert.deepEqual(clearBeforeOrder(quiet.run, "worker-11", noSettle, NO_TRANSCRIPTS, SESSIONS), { sent: false, refusal: null });
    assert.deepEqual(quiet.calls, []);
    const big = recorder();
    clearBeforeOrder(big.run, "worker-11", noSettle, transcriptRootFor("worker-11", COMPACT_THRESHOLD_TOKENS + 1), SESSIONS);
    assert.deepEqual(big.typed(), ["worker-11: /compact"]);
  });

  test("a refused /compact is passed through, and the order is still not preceded by a /clear", () => {
    const refusing = () => { throw new Error("herdr: no such agent"); };
    const got = clearBeforeOrder(refusing, SEAT, noSettle, transcriptRootFor(SEAT, COMPACT_THRESHOLD_TOKENS + 1), SESSIONS);
    assert.equal(got.sent, false);
    assert.match(String(got.refusal), /no such agent/);
  });
});

describe("clearThenPrompt (the prompt:session path goes through the same function)", () => {
  test("a persistent seat's order is typed with no /clear, as a follow-up; `ceo`'s is typed after a /clear", () => {
    const seat = recorder();
    assert.equal(clearThenPrompt(seat.run, SEAT, "the chairman says hello", { sleep: noSettle, contextRoot: NO_TRANSCRIPTS, sessions: SESSIONS }), null);
    assert.equal(seat.typed().length, 1, "one prompt and no /clear");
    assert.match(seat.typed()[0], /^liaison: .*the chairman says hello/s);
    assert.ok(!seat.typed().some((t) => t.endsWith(": /clear")));

    const ceo = recorder();
    clearThenPrompt(ceo.run, "ceo", "the chairman says hello", { sleep: noSettle, contextRoot: NO_TRANSCRIPTS, sessions: SESSIONS });
    assert.equal(ceo.typed()[0], "ceo: /clear", "CONTROL: the clear is the first thing a standing seat is sent");
    assert.equal(ceo.typed().length, 2);
  });
});

describe("the seat is never offered a row, and cannot claim one", () => {
  const eligibility = () => engineerEligibility({ persistent: (label) => isPersistentRole(label, SESSIONS), drained: ["worker-tooling"],
    lookup: () => [] });

  test("(4) `route` skips an idle persistent seat for the pool and names why", () => {
    const agents = [{ label: SEAT, status: "idle" }];
    const got = route("engineers", agents, [SEAT], eligibility());
    assert.ok("refusal" in got, "no engineer is free");
    assert.match(got.refusal, new RegExp(PERSISTENT_SEEN.replace(/[()#]/g, "\\$&")));
  });

  test("(4) CONTROL: the same pool offers an idle engineer, and the seat is skipped in favour of it", () => {
    const agents = [{ label: SEAT, status: "idle" }, { label: "worker-4", status: "idle" }];
    assert.deepEqual(route("engineers", agents, [SEAT, "worker-4"], eligibility()), { label: "worker-4" });
    assert.equal(eligibility()("worker-tooling"), DRAINED_SEEN, "CONTROL: the drain's refusal is unchanged beside it");
  });

  test("(4) an order addressed to the seat BY NAME still reaches it: deliberate orders are the only ones that do", () => {
    assert.deepEqual(route(SEAT, [{ label: SEAT, status: "idle" }], [], eligibility()), { label: SEAT });
  });

  test("(4) row-claim refuses it, naming `persistent`, before a single write", () => {
    const calls = /** @type {string[][]} */ ([]);
    const run = (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
      calls.push([cmd, ...args]);
      return JSON.stringify({ number: 3415, title: "t", state: "OPEN", labels: [{ name: "ready" }] });
    };
    const got = claimRow(3415, SEAT, { run, persistent: true });
    assert.equal(got.claimed, false);
    assert.match(String(/** @type {any} */ (got).reason), /persistent/);
    assert.deepEqual(calls.map((c) => c[1]), ["issue"], "one read of the row and nothing written");
  });

  test("(4) CONTROL: the refusal is the fact's, not every session's", () => {
    assert.equal(persistentReason("worker-4", false), null);
    assert.match(String(persistentReason(SEAT, true)), /persistent/);
  });
});
