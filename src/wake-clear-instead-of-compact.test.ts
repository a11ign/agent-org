// no-token: clearContext -- every herdr call is the injected `run`; the clock, the transcripts, the roster and the state directory are injected, so nothing here reaches gh
/**
 * #4072 (#4055 move 6): A RECENT ORDER TO A STANDING LEAD WHOSE WINDOW IS OVER THE FILL LINE IS CLEARED, NOT COMPACTED, ONCE A STATE FILE IT CAN BE
 * REHYDRATED FROM EXISTS WITHIN ITS SIZE CAP.
 *
 * Each claim has its negative control beside it. A policy that clears every over-full window passes the "cleared" half and fails "no state file is
 * compacted"; one that never clears passes the opposite; a recent order under the line must still be KEPT and an old one still CLEARED, so a change
 * that rewrote the whole decision shows up in the two rows it was not meant to touch. The size cap is read both ways: a file at the cap is used,
 * a file one byte over is refused WITH ITS SIZE and not truncated (the file on disk is the same bytes afterwards).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareContext, stateFileVerdict, orderClockIn, CONTEXT_ACTION, KEEP_WITHIN_MS, KEEP_FILL_TOKENS, STATE_FILE_MAX_BYTES } from "./wake.ts";

const MINUTE = 60_000;
const NOW = 20 * 60 * 60 * 1000;
const LEAD = "ceo";
const scratch = mkdtempSync(join(tmpdir(), "wake-clear-instead-4072-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
const fresh = (prefix: any) => { const dir = join(scratch, `${prefix}-${counter++}`); mkdirSync(dir, { recursive: true }); return dir; };

/** A transcript root whose newest turn for `LEAD` read `cacheRead` tokens (the shape `instanceCacheRead` reads). */
function transcriptRoot(cacheRead: any) {
  const dir = fresh("t");
  writeFileSync(join(dir, "t.jsonl"), `${[
    JSON.stringify({ type: "user", message: { role: "user", content: `You are \`${LEAD}\`, an org session in this repository.` } }),
    JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-sonnet-5",
      usage: { input_tokens: 5, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: 12 } } }),
  ].join("\n")}\n`);
  return dir;
}

/** A state directory holding `bytes` bytes for `LEAD`, or no file at all when `bytes` is null. */
function stateDirWith(bytes: any) {
  const dir = fresh("state");
  if (bytes !== null) writeFileSync(join(dir, `${LEAD}.md`), "x".repeat(bytes));
  return dir;
}

/** The real clock factory, at {@link NOW}, whose record says the previous order landed `agoMs` earlier. */
function clockWith(agoMs: any, stateDir: any) {
  const base = orderClockIn(fresh("clock"), () => NOW, stateDir);
  return { ...base, lastOrderAt: () => NOW - agoMs };
}

/** `prepareContext` against a recording herdr; `commands` is what was typed to the window before the order. */
function decide({ agoMs, tokens, stateBytes }) {
  const calls: any[] = [];
  const run = (args: any) => { calls.push(args); return "{}"; };
  const result = prepareContext(run, LEAD, { sleep: () => {}, contextRoot: transcriptRoot(tokens), sessions: ROSTER,
    clock: clockWith(agoMs, stateDirWith(stateBytes)) });
  const commands = calls.filter((c) => c[3] === "prompt").map((c) => String(c[5]));
  return { ...result, commands };
}

const OVER = KEEP_FILL_TOKENS + 1;
/** A roster in which `ceo` is a standing seat that is NOT persistent, so the recent-order decision is the one that runs. */
const ROSTER = join(scratch, "sessions.json");
writeFileSync(ROSTER, JSON.stringify({ live: [{ name: LEAD, role: "ceo" }] }));

test("recent, over the line, state file present and under its cap: CLEARED, not compacted", () => {
  const got = decide({ agoMs: 10 * MINUTE, tokens: OVER, stateBytes: 1_000 });
  assert.equal(got.action, CONTEXT_ACTION.CLEARED);
  assert.deepEqual(got.commands, ["/clear"]);
  assert.equal(got.stateRefusal, undefined);
});

test("recent, over the line, NO state file: COMPACTED as before (the safe fallback), and silently, since absent is the ordinary state", () => {
  const got = decide({ agoMs: 10 * MINUTE, tokens: OVER, stateBytes: null });
  assert.equal(got.action, CONTEXT_ACTION.COMPACTED);
  assert.deepEqual(got.commands, ["/compact"]);
  assert.equal(got.stateRefusal, undefined);
});

test("recent, under the line: still KEPT, with or without a state file", () => {
  for (const stateBytes of [null, 1_000]) {
    const got = decide({ agoMs: 10 * MINUTE, tokens: KEEP_FILL_TOKENS, stateBytes });
    assert.equal(got.action, CONTEXT_ACTION.KEPT, `state ${stateBytes}`);
    assert.deepEqual(got.commands, []);
  }
});

test("an old order: still CLEARED, with or without a state file; the state file changes nothing here", () => {
  for (const stateBytes of [null, 1_000]) {
    const got = decide({ agoMs: KEEP_WITHIN_MS + 1, tokens: OVER, stateBytes });
    assert.equal(got.action, CONTEXT_ACTION.CLEARED, `state ${stateBytes}`);
    assert.deepEqual(got.commands, ["/clear"]);
  }
});

test("the size cap: a file AT the cap is used, one byte over is refused with its size and the window is compacted", () => {
  const at = decide({ agoMs: 10 * MINUTE, tokens: OVER, stateBytes: STATE_FILE_MAX_BYTES });
  assert.equal(at.action, CONTEXT_ACTION.CLEARED);

  const over = decide({ agoMs: 10 * MINUTE, tokens: OVER, stateBytes: STATE_FILE_MAX_BYTES + 1 });
  assert.equal(over.action, CONTEXT_ACTION.COMPACTED);
  assert.deepEqual(over.commands, ["/compact"]);
  assert.match((over.stateRefusal as any), new RegExp(`is ${STATE_FILE_MAX_BYTES + 1} bytes, over the ${STATE_FILE_MAX_BYTES}-byte cap`));
  assert.match((over.stateRefusal as any), /not truncated/);
});

test("an oversized file is not truncated: its bytes on disk are the same after the verdict", () => {
  const dir = stateDirWith(STATE_FILE_MAX_BYTES + 5);
  const file = join(dir, `${LEAD}.md`);
  const before = readFileSync(file);
  const verdict = stateFileVerdict(LEAD, orderClockIn(fresh("clock"), () => NOW, dir));
  assert.equal(verdict.usable, false);
  assert.deepEqual(readFileSync(file), before);
});

test("an EMPTY state file is not a state to rehydrate from: compacted, and it says why", () => {
  const got = decide({ agoMs: 10 * MINUTE, tokens: OVER, stateBytes: 0 });
  assert.equal(got.action, CONTEXT_ACTION.COMPACTED);
  assert.match((got.stateRefusal as any), /is empty/);
});

test("a clock that names no state directory (a caller with no record) compacts, and its file in another directory is not read", () => {
  const stray = stateDirWith(1_000);
  assert.ok(stray);
  const calls = [];
  const clock = { now: () => NOW, lastOrderAt: () => NOW - 10 * MINUTE, recordOrder: () => {} };
  const got = prepareContext((args) => { calls.push(args); return "{}"; }, LEAD,
    { sleep: () => {}, contextRoot: transcriptRoot(OVER), sessions: ROSTER, clock });
  assert.equal(got.action, CONTEXT_ACTION.COMPACTED);
});

test("the default state directory is `state/` beside the record directory, one file per label", () => {
  const ledgerDir = fresh("ledger");
  const clock = orderClockIn(join(ledgerDir, "last-order"));
  assert.equal(clock.stateFile(LEAD), join(ledgerDir, "state", `${LEAD}.md`));
});

test("a DIRECTORY at the state file's path is not a state: compacted, and it says it is not a regular file", () => {
  const dir = fresh("state");
  mkdirSync(join(dir, `${LEAD}.md`));
  const clock = clockWith(10 * MINUTE, dir);
  const calls: any[] = [];
  const got = prepareContext((args) => { calls.push(args); return "{}"; }, LEAD,
    { sleep: () => {}, contextRoot: transcriptRoot(OVER), sessions: ROSTER, clock });
  assert.equal(got.action, CONTEXT_ACTION.COMPACTED);
  assert.deepEqual(calls.filter((c) => c[3] === "prompt").map((c) => String(c[5])), ["/compact"]);
  assert.match((got.stateRefusal as any), /is not a regular file/);
});

test("a file that cannot be opened is not a state either (skipped when the process can read anything, as root)", { skip: process.getuid?.() === 0 ? "running as root: mode 000 does not stop the read" : false }, () => {
  const dir = stateDirWith(1_000);
  chmodSync(join(dir, `${LEAD}.md`), 0o000);
  const verdict = stateFileVerdict(LEAD, orderClockIn(fresh("clock"), () => NOW, dir));
  assert.equal(verdict.usable, false);
  assert.match((verdict.refusal as any), /could not be read/);
});
