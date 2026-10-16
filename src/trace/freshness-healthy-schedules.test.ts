// a11ign/agent-org#837: THE CLASS GUARD for the trace freshness check. Every other test of `storeFreshness` and `sessionsWorking` hands the check a store that a
// fixture wrote by hand; this one generates HEALTHY work, the way a session really writes it (bursts of messages, quiet between them, a session that finishes and only
// rewrites its bookkeeping, a state file lost mid-run), and drives the REAL `ingestTranscripts` with a clock that moves in five-minute ticks. A healthy schedule must never be
// reported STALE: a stale reading is the alarm that raises the incident, so a false one is an alarm for nothing.
//
// A NEW SHAPE GOES IN THE GENERATOR (`schedule()` below), not in a fixture of `freshness.test.ts`: a fixture is one hand-written store, and a fixture is not a substitute for
// the generator, which is what found the shapes that the fixtures missed. Every schedule is a seed, so a failure replays with the same seed (`SEEDS`), and the test names
// its seed. The check is not made quieter here: `OWED_AFTER_MS` and the owed rule are what `freshness.ts` says, and this file asserts `stale: false`, nothing softer.
//
// THE SHAPES: #704 (a session that finished and only rewrote `last-prompt` and `cost-state`: it is not working, so it must not be stale) and #709 (a cold start, the state
// file deleted mid-schedule: the next ingest reads from byte 0 and the store must still report the work as fresh). No shape is excluded. The #836 shape (a session that goes
// silent for ten minutes and speaks again, its new messages inside the hold-back) and the 6-to-10-minute gap shape (agent-org#842: two messages of one working session that far
// apart) were false alarms of `freshness.ts` until the hold-back fix (#836, merged as #856): with that fix every healthy schedule reads not stale, so each was excluded here and
// the exclusions came out together. Any stale reading on a healthy schedule fails this file.
//
// THE POSITIVE CONTROL: the same schedules with ingest stopped for fifteen minutes while messages keep arriving must read STALE at the fifteen-minute mark. Without it, a check
// that could never say STALE would pass every test here.
//
// MUTATION CHECK (a11ign/agent-org#837): restore the pre-#704 working test (a file's mtime, not its newest message) and the pre-#709 tail read (no going further back in
// the store) in `freshness.ts`, one at a time; this file must go red for each. The mutations are temporary and the file is restored byte-identically.
//
// Nothing here reads `~/.claude`, `~/.cache/a11ign` or GitHub: a scratch projects directory, a scratch store and a scratch state, under one temporary directory.
// no-token: gh -- no test here calls `gh`; `ingestTranscripts` is the transcript half of a run and never reaches GitHub
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stateFileFor } from "./ingest-state.ts";
import { freshnessLine, storeFreshness } from "./freshness.ts";
import type { Freshness } from "./freshness.ts";
import { ingestTranscripts } from "./trace.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";

const ROW_REPO = "a11ign/a11ign";
const MINUTE = 60 * 1000;
const TICK = 5 * MINUTE;
// The transcript starts ten minutes before the first tick, so the first burst has settled by then: a store with no turn yet is a start-up, not a healthy steady state.
const START = Date.parse("2026-10-04T23:50:00Z");
const FIRST_TICK = START + 3 * TICK;
const SEEDS = Array.from({ length: 200 }, (_, index) => index + 1);
const CYCLES = 6;

const iso = (ms: number) => new Date(ms).toISOString();
const usage = (output: number) => ({ input_tokens: 2, output_tokens: output, cache_read_input_tokens: 6448, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 } });
const block = (timestamp: string, id: string, output = 50) => JSON.stringify({
  type: "assistant", timestamp, requestId: `req_${id}`, message: { id, model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "text", text: "x" }], usage: usage(output) },
});
const toolResult = (timestamp: string) => JSON.stringify({ type: "user", timestamp, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
const bookkeeping = (k: number) => (k % 2 === 0 ? JSON.stringify({ type: "last-prompt", lastPrompt: "x", sessionId: "s" }) : JSON.stringify({ type: "cost-state", sessionId: "s", totalCostUSD: 1 }));

/** A mulberry32 generator: the same seed gives the same schedule on every run, so a failing seed replays. */
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One line of a transcript and the moment it is written. */
type Line = { at: number; text: string };
type Schedule = {
  seed: number;
  lines: Line[];
  /** The #704 shape: the session finished at this moment and only its bookkeeping was rewritten after it. */
  finishedAt: number | null;
  /** The #709 shape: the state file and the store are lost just before the ingest at this tick, and the rebuild ends with an old Codex rollout. */
  coldAt: number | null;
  /** The start of each burst after the first, with the silence before it. */
  restarts: { at: number; silence: number }[];
  end: number;
};

/**
 * The healthy schedule of one seed: `CYCLES` bursts of 1 to 100 messages over up to ten minutes, each after a quiet of up to thirty minutes. With probability 0.3 the session
 * finishes after its last burst and rewrites its bookkeeping every two to five minutes for the next half hour (#704). With probability 0.3 the state file and the store are lost at a tick in the
 * middle of the schedule (#709). Every number comes from the seed.
 */
function schedule(seed: number): Schedule {
  const rand = prng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const lines: Line[] = [];
  const restarts: { at: number; silence: number }[] = [];
  let clock = START;
  let id = 0;
  let last = START;
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    if (cycle > 0) {
      const quiet = int(0, 30 * 60) * 1000;
      clock = last + quiet;
      restarts.push({ at: clock, silence: quiet });
    }
    const count = int(1, 100);
    const span = int(0, 10 * 60) * 1000;
    const offsets = Array.from({ length: count }, () => int(0, span)).sort((a, b) => a - b);
    for (const [index, offset] of offsets.entries()) {
      const at = clock + offset;
      id += 1;
      // Every tool result follows the assistant message that called the tool, as Claude Code writes it: a result with no message before it is not a turn. And a burst ends on
      // an assistant message: Claude Code answers every tool result, so a result that ends a burst would be a quiet of up to thirty minutes after an unanswered tool call, which is
      // a stall and not healthy work. The result lands a second after its call, so it is written only when the next message comes after that second: a result in the same
      // second as the burst's last message would sort after it and end the burst on a user record (seed 183).
      lines.push({ at, text: block(iso(at), `msg_${seed}_${id}`) });
      last = Math.max(last, at);
      if (id % 4 === 0 && index < offsets.length - 1 && offsets[index + 1] > offset + 1000) {
        lines.push({ at: at + 1000, text: toolResult(iso(at + 1000)) });
        last = Math.max(last, at + 1000);
      }
    }
    clock = last;
  }
  const finishedAt = rand() < 0.3 ? last : null;
  if (finishedAt !== null) {
    let at = finishedAt;
    for (let k = 0; (at += int(2, 5) * MINUTE) <= finishedAt + 30 * MINUTE; k += 1) lines.push({ at, text: bookkeeping(k) });
  }
  const end = Math.max(...lines.map((line) => line.at));
  const tickCount = Math.ceil((end - FIRST_TICK) / TICK) + 1;
  const coldAt = rand() < 0.3 ? FIRST_TICK + TICK * int(0, tickCount - 1) : null;
  lines.sort((a, b) => a.at - b.at);
  return { seed, lines, finishedAt, coldAt, restarts, end };
}

/**
 * THE #709 SHAPE's other half: an old Codex reviewer rollout. The ingest reads the Claude sessions first and the Codex rollouts after them, so when the store is rebuilt from
 * nothing its END holds these two-day-old turns. More than a mebibyte of them, because the reader looks at a one-mebibyte tail first.
 */
function oldRollout(codexRoot: string) {
  const dir = join(codexRoot, "2026", "10", "02");
  mkdirSync(dir, { recursive: true });
  const base = Date.parse("2026-10-02T00:00:00Z");
  const lines = Array.from({ length: 4000 }, (_, k) => JSON.stringify({ type: "token_usage_record", timestamp: iso(base + k * 1000), payload: { response_id: `resp_old_${k}`, usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 50 } } }));
  appendFileSync(join(dir, "rollout-old.jsonl"), `${lines.join("\n")}\n`);
}

/** A scratch world: a projects directory with one transcript, a store and (beside it) a state, all under one temporary directory. */
function world(seed: number) {
  const dir = tmpDir(`freshness-healthy-${seed}-`);
  const root = join(dir, "projects");
  mkdirSync(join(root, "-proj"), { recursive: true });
  const transcript = join(root, "-proj", "session.jsonl");
  const storePath = join(dir, "events.ndjson");
  return { root, codexRoot: join(dir, "codex"), transcript, storePath, statePath: stateFileFor(storePath) };
}

/** Drives one schedule: the writer appends every line written by `now`, the ingest runs, and the check reads the store with the same `now`. */
function driver(s: Schedule) {
  const w = world(s.seed);
  if (s.coldAt !== null) oldRollout(w.codexRoot);
  let pending = [...s.lines];
  let written = START;
  /** Appends every line written by `now` to the transcript, and sets its mtime to the newest of them, as a real write does. */
  const write = (now: number) => {
    const due: Line[] = [];
    while (pending.length > 0 && pending[0].at <= now) due.push(pending.shift() as Line);
    if (due.length === 0) return;
    appendFileSync(w.transcript, `${due.map((line) => line.text).join("\n")}\n`);
    written = Math.max(written, ...due.map((line) => line.at));
    utimesSync(w.transcript, new Date(written), new Date(written));
  };
  const queue = (lines: Line[]) => {
    pending = [...pending, ...lines].sort((a, b) => a.at - b.at);
  };
  const ingest = (now: number) => ingestTranscripts({ root: w.root, codexRoot: w.codexRoot, since: 0, ledger: [], rowRepo: ROW_REPO, storePath: w.storePath, now });
  const check = (now: number): Freshness => storeFreshness({ storePath: w.storePath, now, roots: [{ dir: w.root, depth: 1 }] });
  return { w, write, queue, ingest, check };
}

for (const seed of SEEDS) {
  test(`seed ${seed}: a healthy schedule read through the real ingest is never STALE at a post-ingest tick`, () => {
    const s = schedule(seed);
    const d = driver(s);
    for (let now = FIRST_TICK; now <= s.end + TICK; now += TICK) {
      if (now === s.coldAt) {
        rmSync(d.w.statePath, { force: true });
        rmSync(d.w.storePath, { force: true });
      }
      d.write(now);
      d.ingest(now);
      const reading = d.check(now);
      assert.equal(reading.stale, false, `seed ${seed}, tick ${iso(now)}${s.coldAt === now ? " (cold start)" : ""}: ${freshnessLine(reading)}`);
    }
  });
}

test("POSITIVE CONTROL: with ingest stopped for fifteen minutes while messages keep arriving, every schedule is STALE at the fifteen-minute mark", () => {
  for (const seed of SEEDS) {
    const s = schedule(seed);
    const d = driver(s);
    const stop = FIRST_TICK + 3 * TICK;
    d.write(stop);
    d.ingest(stop);
    // a message every two minutes after the stop: at stop+15m the newest message at least ten minutes old is the one written at stop+4m (or a schedule's message just after it), which is
    // owed a turn and has none, and the ones from stop+6m to stop+10m are past the hold-back, so the session is working
    const keepAlive: Line[] = Array.from({ length: 8 }, (_, k) => ({ at: stop + (k + 1) * 2 * MINUTE, text: block(iso(stop + (k + 1) * 2 * MINUTE), `keep_${seed}_${k}`) }));
    d.queue(keepAlive);
    d.write(stop + 15 * MINUTE);
    const reading = d.check(stop + 15 * MINUTE);
    assert.equal(reading.working, true, `seed ${seed}: messages kept arriving, so a session is working at the fifteen-minute mark`);
    assert.equal(reading.stale, true, `seed ${seed}: ingest was stopped for fifteen minutes, and messages written after the stop are owed turns: ${freshnessLine(reading)}`);
    assert.equal(reading.unmet.length, 1, `seed ${seed}: one transcript, so one owed message`);
    assert.ok(reading.unmet[0].at >= stop + 4 * MINUTE && reading.unmet[0].at <= stop + 5 * MINUTE, `seed ${seed}: the owed message is the newest ten minutes old, written after the stop: ${reading.unmet[0].at - stop}ms after it`);
  }
});
