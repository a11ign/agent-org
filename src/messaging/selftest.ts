#!/usr/bin/env node
// @ts-check
// command: messaging:selftest -- send ONE synthetic inbound through the chairman's path (listen, queue, seat, back) and judge the result.
// THE ORGANISATION CHECKS THE CHAIRMAN'S PATH ITSELF (a11ign/a11ign#3540). His first real message on it, at 19:44Z on 2026-10-04, was refused because the seat was absent,
// and every test of the path had run against a fake queue, a fake roster or a fake provider. This sends one update through the REAL `createInbound(...).handle()`, the REAL
// `converse.forward`, the real queue port and herdr's real roster, and reads the ledger line back.
//
//   pnpm exec agent-org messaging:selftest            (waits for the seat, prints the stages, exits 0 pass / 3 degraded / 1 red / 2 refused)
//   pnpm exec agent-org messaging:selftest --tick     (the work tick's call: never waits, remembers a queued entry in the state file, prints one JSON line)
//
// **IT NEVER REACHES THE CHAT, AND NOTHING IN HERE CAN.** This file imports no provider and no `fetch`; the only `send` the converse module is given is `createRecorder().send`, which
// appends to an array. A caller that hands `runSelftest` a provider (under any name) is ignored, and `selftest.test.mjs` shows it with a provider that fails on any send.
// **IT NEVER TOUCHES THE CHAIRMAN'S LEDGER.** Its lines go to `selftest-ledger.jsonl` beside it, so `measure.mjs` (which reads `ledger.jsonl` only) never counts a check as a message.
// **IT NEVER QUEUES ANYTHING ITSELF.** `converse.mjs` is the one file under `src/messaging/` that may name the queue (its scan test pins that), so the order goes through
// `createConverse` and the queue port is `converse.mjs`'s own `realQueue`. A red result is delivered to `ceo` by the TICK STEP in `wake.ts`, which owns the queue's writers.
//
// THE FOUR STAGES, in the order a message meets them, and a red names the FIRST that failed:
//   listen -- `createInbound(...).handle` said "forward" for an update shaped as the provider's;
//   queue  -- a queue took the order (the liaison's, else `ceo`'s), and a queued entry is in the queue file as `converse` says;
//   seat   -- the seat took it: typed in at once (an idle seat) or the entry LEFT the queue within `TAKEN_WITHIN_MS`;
//   back   -- the acknowledgement came back through the recorder, and the ledger line says so (`ackRef`).
// **AN ORDER THAT WENT TO `ceo` IS A DEGRADED PASS, never green** (#3538): the chairman's message was not dropped, and the liaison did not take it.
//
// THE BOUND, MEASURED AND NOT GUESSED: a queued entry is taken by the next work tick. `~/.cache/a11ign/tick-cost.jsonl`, 385 ticks over 13.6 h ending 2026-10-05, read with `node`:
// tick wall time p50 73 s, p95 166 s, max 408 s; start-to-start gap p50 123 s, p95 195 s, max 411 s. So an entry waits at most about one gap (411 s) before its tick starts and then
// the tick's own run to the queue phase (p50 73 s): 484 s, rounded up to 10 minutes. The number is a reading at a moment; re-derive it before moving it.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { gitIn, liveToolVersion } from "../lib/tool-version.ts";
import { ACKNOWLEDGEMENT, FALLBACK_RECIPIENT, RECIPIENT, createConverse, realQueue } from "./converse.ts";
import { createInbound } from "./inbound.ts";
import { createLedger, describeError } from "./ledger.ts";
import { defaultLedgerPath } from "./state.ts";

export const EXIT = Object.freeze({ ok: 0, red: 1, refused: 2, degraded: 3 });
export const TAKEN_WITHIN_MS = 10 * 60_000;
/** After a red run the next is not started sooner than the bound: a stuck seat must not be handed one more order per two-minute tick. */
export const RETRY_AFTER_MS = TAKEN_WITHIN_MS;
const POLL_MS = 5000;
export const SELFTEST_LEDGER_FILE = "selftest-ledger.jsonl";
export const SELFTEST_STATE_FILE = "selftest-state.json";

/**
 * Paths whose change in a release makes the chairman's path worth walking again: the messaging code, the queue's writer (`prompt-session`) and its reader (`wake`, whose tick drains
 * the queue, so the "seat" stage depends on it), the roster's readers. Tests do not ship, so they do not count. `wake` is the wide one: measured with `git diff --name-only` over the
 * 12 release intervals v0.46.1 to v0.49.2, it changed in 3 and the narrower four paths in 2 (the 3 share one), so it costs one extra seat turn in about twelve releases.
 * A PATTERN AND NOT A LIST OF FILE NAMES, because `converse.test.mjs` scans this directory for any non-comment line that names the queue's modules, and this is data about a diff, not a path to a worker.
 */
export const MESSAGING_PATH = /^src\/(messaging\/|(prompt-session|wake|herdr-agents|project-roles)\.ts$)/;
const TEST_FILE = /\.test\.(mjs|ts)$/;

/** Ids no real chairman has to share: the self-test pairs with nobody, it only has to match ITSELF. */
const SYNTHETIC_CHAIRMAN = Object.freeze({ userId: 1, chatId: 1 });

/** @param {readonly string[]} files @returns {boolean} some shipped file under a messaging path changed */
export function touchesMessaging(files: readonly string[]): boolean {
  return files.some((file) => !TEST_FILE.test(file) && MESSAGING_PATH.test(file));
}

/**
 * WHETHER THE TICK RUNS THE SELF-TEST, a pure function of what it is told. `changedFiles` is `git diff --name-only <lastPassed> <current>`, or null when that could not be read:
 * not-knowing is a reason to run and never a reason not to. `settled` says the answer cannot change for this version (it passed, or it changed no messaging path), so the tick may
 * remember it and stop asking; a no-run for any other reason (a run waiting for the seat, a back-off) is not settled.
 *
 * @param {{ lastPassed: string | null, current: string | null, changedFiles: readonly string[] | null, pending: boolean, lastAttemptAt: number | null, now: number }} reading
 * @returns {{ run: boolean, settled: boolean, reason: string }}
 */
export function selftestDue({ lastPassed, current, changedFiles, pending, lastAttemptAt, now }: { lastPassed: string | null; current: string | null; changedFiles: readonly string[] | null; pending: boolean; lastAttemptAt: number | null; now: number; }): { run: boolean; settled: boolean; reason: string; } {
  if (current === null) return { run: false, settled: false, reason: "the checkout is at no release tag, so there is no release to check" };
  if (pending) return { run: false, settled: false, reason: "a run is waiting for the seat to take its entry" };
  if (lastPassed === current) return { run: false, settled: true, reason: `${current} already passed` };
  if (lastPassed !== null && changedFiles !== null && !touchesMessaging(changedFiles)) return { run: false, settled: true, reason: `${lastPassed} to ${current} touches no messaging path` };
  if (lastAttemptAt !== null && now - lastAttemptAt < RETRY_AFTER_MS) return { run: false, settled: false, reason: "the last run was red and its back-off has not passed" };
  if (lastPassed === null) return { run: true, settled: false, reason: `no run is recorded as passed, so ${current} is checked` };
  return { run: true, settled: false, reason: changedFiles === null ? `the change from ${lastPassed} could not be read` : `${lastPassed} to ${current} touches a messaging path` };
}

/**
 * THE TICK'S OWN QUESTION, before it spends a child process: is there anything for `--tick` to do? A quiet tick (every tick but the first after a release that matters) answers from the
 * state file and the tag alone, with no `node` started. `line` is the one line a red repeats on every tick until the retry, which is how a failure stays in the journal between runs.
 *
 * @param {{ state: ReturnType<typeof readState>, current: string | null, now: number }} reading @returns {{ spawn: boolean, line: string | null }}
 */
export function worthAChild({ state, current, now }: { state: ReturnType<typeof readState>; current: string | null; now: number; }): { spawn: boolean; line: string | null; } {
  if (state.pending !== null) return { spawn: true, line: null };
  if (current === null || state.lastPassed === current || state.decidedFor === current) return { spawn: false, line: null };
  if (state.lastAttemptAt !== null && now - state.lastAttemptAt < RETRY_AFTER_MS) {
    return { spawn: false, line: `messaging selftest still RED${state.lastRed ? ` at ${state.lastRed}` : ""} for ${current}; retrying after ${Math.ceil((RETRY_AFTER_MS - (now - state.lastAttemptAt)) / 1000)} s` };
  }
  return { spawn: true, line: null };
}

/** The recording provider: what the chairman WOULD have received, in an array. Its `send` is the only one `runSelftest` gives `converse`. */
export function createRecorder() {
  /** @type {{ messageRef: string, text: string, replyTo?: string }[]} */
  const sent: { messageRef: string; text: string; replyTo?: string; }[] = [];
  return {
    sent,
    /** @param {{ text: string, replyTo?: string }} message */
    async send({ text, replyTo }: { text: string; replyTo?: string; }) {
      const messageRef = `selftest-${sent.length + 1}`;
      sent.push({ messageRef, text, replyTo });
      return { messageRef };
    },
  };
}

/** @param {number} runId @returns {string} the words the seat reads: synthetic first, and a request to do nothing at all */
export function selftestText(runId: number): string {
  return `SYNTHETIC SELF-TEST ${runId}, NOT THE CHAIRMAN: agent-org messaging:selftest is checking the path from his chat to you. Take no action, send nothing to the chat and answer nobody; end your turn at once.`;
}

/** @param {{ updateId: number, text: string, at: number }} fields @returns {Record<string, any>} an update shaped as Telegram's `getUpdates` entry, from the synthetic chairman */
export function syntheticUpdate({ updateId, text, at }: { updateId: number; text: string; at: number; }): Record<string, any> {
  const { userId, chatId } = SYNTHETIC_CHAIRMAN;
  return { update_id: updateId, message: { message_id: updateId, from: { id: userId, is_bot: false, first_name: "selftest" }, chat: { id: chatId, type: "private" }, date: Math.floor(at / 1000), text } };
}

/** @param {string} home @returns {{ ledger: string, state: string }} */
export function selftestPaths(home: string): { ledger: string; state: string; } {
  const directory = dirname(defaultLedgerPath(home));
  return { ledger: join(directory, SELFTEST_LEDGER_FILE), state: join(directory, SELFTEST_STATE_FILE) };
}

/**
 * Send one synthetic update through the real path and return what happened, unjudged. `queue`, `agents` and `recorder` are for a test; left out they are the real queue, herdr's roster and
 * a fresh recorder. **Any other key in `deps` (a provider under any name) is not read.**
 *
 * @param {{ home?: string, now?: () => number, queue?: import("./converse.ts").QueuePort, queuePath?: string, agents?: () => {label: string, status: string}[] | null, recorder?: ReturnType<typeof createRecorder> }} [deps]
 */
export async function sendSelftest({ home = homedir(), now = Date.now, queue, queuePath, agents, recorder = createRecorder() }: { home?: string; now?: () => number; queue?: import("./converse.ts").QueuePort; queuePath?: string; agents?: () => { label: string; status: string; }[] | null; recorder?: ReturnType<typeof createRecorder>; } = {}) {
  const ledger = createLedger({ path: selftestPaths(home).ledger, now });
  const updateId = 1 + Math.max(0, ...ledger.read().map((line) => (Number.isSafeInteger(line.updateId) ? line.updateId : 0)));
  const port = queue ?? (await realQueue());
  const where = queuePath ?? port.defaultQueuePath?.();
  const handled = createInbound({ ledger, chairman: SYNTHETIC_CHAIRMAN }).handle(syntheticUpdate({ updateId, text: selftestText(updateId), at: now() }));
  /** @type {string | null} */
  let thrown: string | null = null;
  if (handled.action === "forward") {
    const converse = createConverse({ chairman: SYNTHETIC_CHAIRMAN, queuePath: where, ledger, send: recorder.send, now, agents, queue: port });
    // `forward` throws AFTER writing its line when the acknowledgement could not be sent; the line is what is judged, the throw is only kept as a word.
    await converse.forward(handled.accepted).catch((error) => { thrown = describeError(error); });
  }
  const line = ledger.read().findLast((candidate) => candidate.origin === "converse" && candidate.updateId === updateId) ?? null;
  return { updateId, handled: { action: handled.action, reason: "reason" in handled ? handled.reason : null }, thrown, line, recorded: recorder.sent, queue: port, queuePath: where, ledgerPath: ledger.path };
}

/** @typedef {{ name: string, ok: boolean | null, note: string }} Stage  ok null is "not reached" */

/** @param {Awaited<ReturnType<typeof sendSelftest>>} reading @returns {Stage} */
function listenStage({ handled }: Awaited<ReturnType<typeof sendSelftest>>): Stage {
  return handled.action === "forward"
    ? { name: "listen", ok: true, note: "createInbound.handle forwarded the update" }
    : { name: "listen", ok: false, note: `createInbound.handle answered "${handled.action}"${handled.reason ? ` (${handled.reason})` : ""}, not forward` };
}

/** @param {Awaited<ReturnType<typeof sendSelftest>>} reading @returns {Stage} */
function queueStage({ line, thrown }: Awaited<ReturnType<typeof sendSelftest>>): Stage {
  if (line === null) return { name: "queue", ok: false, note: `converse wrote no ledger line${thrown === null ? "" : `: ${thrown}`}` };
  if (line.verdict === "refused") return { name: "queue", ok: false, note: `neither ${RECIPIENT}'s queue nor ${FALLBACK_RECIPIENT}'s took it: ${line.refusals.join(" | ")}` };
  if (line.verdict === "unverified") return { name: "queue", ok: false, note: `a queue said it held the message and its entry is not in the queue file: ${line.refusals.join(" | ")}` };
  const how = line.delivery === "delivered" ? "typed into an idle seat" : `queued, handoff ${line.handoff}`;
  return { name: "queue", ok: true, note: `${line.taker} took it (${how})` };
}

/** @param {Record<string, any> | null} line @param {boolean | null} taken whether the queued entry has left the queue: null when that is not known yet @param {number} boundMs @returns {Stage} */
export function seatStage(line: Record<string, any> | null, taken: boolean | null, boundMs: number = TAKEN_WITHIN_MS): Stage {
  if (line?.delivery === "delivered") return { name: "seat", ok: true, note: `${line.taker} was between tasks and was typed into at once` };
  if (line?.delivery !== "queued") return { name: "seat", ok: null, note: "no queue took the order, so no seat could" };
  if (taken === true) return { name: "seat", ok: true, note: `the entry left ${line.taker}'s queue` };
  if (taken === false) return { name: "seat", ok: false, note: `entry ${line.handoff} was still in ${line.taker}'s queue after ${Math.round(boundMs / 1000)} s` };
  return { name: "seat", ok: null, note: `entry ${line.handoff} is waiting for ${line.taker} to take it` };
}

/** @param {Awaited<ReturnType<typeof sendSelftest>>} reading @returns {Stage} */
function backStage({ line, recorded }: Awaited<ReturnType<typeof sendSelftest>>): Stage {
  const heard = recorded.some((message) => message.text === ACKNOWLEDGEMENT);
  if (line !== null && line.ackRef !== null && line.ackRef !== undefined && heard) return { name: "back", ok: true, note: `the acknowledgement came back through the recorder (${line.ackRef})` };
  return { name: "back", ok: false, note: `the acknowledgement did not come back${line?.error ? `: ${line.error}` : ""}` };
}

/**
 * THE JUDGE, pure: the first stage that failed is the red, and an order that `ceo` took and not the liaison is a DEGRADED pass naming `ceo`. `taken` is null when the entry is
 * still queued and the bound has not passed: the result is then `pending`, which only the tick's two-phase run ever sees.
 *
 * @param {Awaited<ReturnType<typeof sendSelftest>>} reading @param {boolean | null} taken
 * @returns {{ result: "pass" | "degraded" | "red" | "pending", stage: string | null, detail: string, stages: Stage[], degraded: boolean }}
 */
export function judge(reading: Awaited<ReturnType<typeof sendSelftest>>, taken: boolean | null): { result: "pass" | "degraded" | "red" | "pending"; stage: string | null; detail: string; stages: Stage[]; degraded: boolean; } {
  const stages = [listenStage(reading), queueStage(reading), seatStage(reading.line, taken), backStage(reading)];
  const failed = stages.find((stage) => stage.ok === false);
  const degraded = reading.line?.taker === FALLBACK_RECIPIENT;
  if (failed) return { result: "red", stage: failed.name, detail: failed.note, stages, degraded };
  if (stages.some((stage) => stage.ok === null)) return { result: "pending", stage: "seat", detail: stages.find((stage) => stage.ok === null)?.note ?? "", stages, degraded };
  const result = degraded ? "degraded" : "pass";
  return { result, stage: null, detail: degraded ? `the ${RECIPIENT} did not take it; ${FALLBACK_RECIPIENT} did (${reading.line?.refusals?.[0] ?? "no reason recorded"})` : "all four stages", stages, degraded };
}

/**
 * Whether a queued entry has left the queue. An entry the file does not hold is TAKEN, so a queue file that cannot be read is an error and never "taken".
 *
 * @param {{ queue: import("./converse.ts").QueuePort, queuePath?: string }} where @param {string} handoff @returns {boolean}
 */
export function entryLeft({ queue, queuePath }: { queue: import("./converse.ts").QueuePort; queuePath?: string; }, handoff: string): boolean {
  const path = queuePath ?? queue.defaultQueuePath?.();
  if (path === undefined) throw new Error("selftest: the queue port names no queue file to read back");
  return !queue.readHandoffs(path).some((entry) => entry.id === handoff);
}

/**
 * Judge a reading, waiting for a queued entry to be taken. `sleep` and `now` are injected so a test owns the clock.
 *
 * @param {Awaited<ReturnType<typeof sendSelftest>>} reading
 * @param {{ now?: () => number, sleep?: (ms: number) => Promise<void>, boundMs?: number }} [clock]
 */
export async function judgeWaiting(reading: Awaited<ReturnType<typeof sendSelftest>>, { now = Date.now, sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }), boundMs = TAKEN_WITHIN_MS }: { now?: () => number; sleep?: (ms: number) => Promise<void>; boundMs?: number; } = {}) {
  const handoff = reading.line?.delivery === "queued" ? reading.line.handoff : null;
  const started = now();
  let taken = handoff === null ? null : entryLeft(reading, handoff);
  while (handoff !== null && !taken && now() - started < boundMs) {
    await sleep(POLL_MS);
    taken = entryLeft(reading, handoff);
  }
  return { ...judge(reading, handoff === null ? null : taken), waitedMs: now() - started };
}

/** @param {string} path @returns {{ lastPassed: string | null, decidedFor: string | null, lastAttemptAt: number | null, lastRed: string | null, lastReported: string | null, pending: Record<string, any> | null }} */
export function readState(path: string): { lastPassed: string | null; decidedFor: string | null; lastAttemptAt: number | null; lastRed: string | null; lastReported: string | null; pending: Record<string, any> | null; } {
  const empty = { lastPassed: null, decidedFor: null, lastAttemptAt: null, lastRed: null, lastReported: null, pending: null };
  try {
    return { ...empty, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return empty;
    throw new Error(`${path} is not readable as the self-test's state`, { cause: error });
  }
}

/** @param {string} path @param {Record<string, unknown>} state write whole, then rename: a tick killed mid-write leaves the old state, never half of a new one */
function writeState(path: string, state: Record<string, unknown>) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** @param {{ result: string, stage: string | null, detail: string }} verdict @param {string} version @returns {string} the report `ceo` reads; no clock in it, so a repeat of the same failure is the same words */
export function reportText(verdict: { result: string; stage: string | null; detail: string; }, version: string): string {
  const head = verdict.result === "red" ? `RED at the ${verdict.stage} stage` : `DEGRADED, not green: the ${RECIPIENT} did not take it`;
  return [
    `agent-org messaging:selftest, ${version}: the chairman's path (listen, queue, seat, back) is ${head}.`,
    verdict.detail,
    "The chairman was sent nothing and has not been told: this is a check, and the recorder took the acknowledgement.",
    "Reading: `pnpm exec agent-org messaging:selftest` walks it again and prints the stages. Row: a11ign/a11ign#3540.",
  ].join("\n");
}

/** @param {string} git @param {string} lastPassed @param {string} current @returns {string[] | null} */
function filesChanged(git: string, lastPassed: string, current: string): string[] | null {
  try {
    return gitIn(git)(["diff", "--name-only", lastPassed, current]).split("\n").filter(Boolean);
  } catch {
    // An unknown tag (pruned, never fetched) is "could not determine", which `selftestDue` answers by running.
    return null;
  }
}

/**
 * @param {Record<string, any>} state @param {{ version: string, verdict: { result: string, stage: string | null, detail: string }, at: number }} outcome
 * @returns {{ state: Record<string, any>, report: string | null }} the state after a finished run, and the one report `ceo` is owed (null when it was told this already)
 */
function afterRun(state: Record<string, any>, { version, verdict, at }: { version: string; verdict: { result: string; stage: string | null; detail: string; }; at: number; }): { state: Record<string, any>; report: string | null; } {
  const passed = verdict.result === "pass" || verdict.result === "degraded";
  const key = `${version}:${verdict.result}:${verdict.stage}`;
  const owed = verdict.result !== "pass" && state.lastReported !== key;
  return {
    state: { ...state, pending: null, lastPassed: passed ? version : state.lastPassed, lastAttemptAt: passed ? null : at, lastRed: passed ? null : verdict.stage, lastReported: verdict.result === "pass" ? null : key },
    report: owed ? reportText(verdict, version) : null,
  };
}

/**
 * THE WORK TICK'S CALL: never waits. A queued entry is remembered in the state file and settled by a later tick; everything else is judged now.
 *
 * @param {{ home?: string, now?: () => number, current?: string | null, changedFiles?: (lastPassed: string, current: string) => string[] | null, queue?: import("./converse.ts").QueuePort, queuePath?: string, agents?: () => {label: string, status: string}[] | null, recorder?: ReturnType<typeof createRecorder> }} [deps]
 * @returns {Promise<{ lines: string[], report: string | null }>}
 */
export async function tickSelftest({ home = homedir(), now = Date.now, current = liveToolVersion(), changedFiles, queue, queuePath, agents, recorder }: { home?: string; now?: () => number; current?: string | null; changedFiles?: (lastPassed: string, current: string) => string[] | null; queue?: import("./converse.ts").QueuePort; queuePath?: string; agents?: () => { label: string; status: string; }[] | null; recorder?: ReturnType<typeof createRecorder>; } = {}): Promise<{ lines: string[]; report: string | null; }> {
  const paths = selftestPaths(home);
  const state = readState(paths.state);
  const at = now();
  if (state.pending !== null) return settlePending({ paths, state, at, queue, queuePath });
  const files = state.lastPassed !== null && current !== null ? (changedFiles ?? ((a, b) => filesChanged(fileURLToPath(new URL("..", import.meta.url)), a, b)))(state.lastPassed, current) : null;
  const due = selftestDue({ lastPassed: state.lastPassed, current, changedFiles: files, pending: false, lastAttemptAt: state.lastAttemptAt, now: at });
  if (!due.run || current === null) {
    if (due.settled) writeState(paths.state, { ...state, decidedFor: current });
    return { lines: [`messaging selftest: not run, ${due.reason}`], report: null };
  }
  const reading = await sendSelftest({ home, now, queue, queuePath, agents, recorder });
  const verdict = judge(reading, null);
  if (verdict.result === "pending") {
    writeState(paths.state, { ...state, lastAttemptAt: at, pending: { version: current, handoff: reading.line?.handoff, taker: reading.line?.taker, queuedAt: at, updateId: reading.updateId, degraded: verdict.degraded } });
    return { lines: [`messaging selftest: sent for ${current} (${due.reason}); waiting for ${reading.line?.taker} to take ${reading.line?.handoff}`], report: null };
  }
  return finish({ paths, state, current, verdict, at, updateId: reading.updateId, lead: due.reason });
}

/**
 * @param {{ paths: { ledger: string, state: string }, state: Record<string, any>, current: string, verdict: { result: string, stage: string | null, detail: string }, at: number, updateId: number, lead: string }} run
 * @returns {{ lines: string[], report: string | null }}
 */
function finish({ paths, state, current, verdict, at, updateId, lead }: { paths: { ledger: string; state: string; }; state: Record<string, any>; current: string; verdict: { result: string; stage: string | null; detail: string; }; at: number; updateId: number; lead: string; }): { lines: string[]; report: string | null; } {
  const done = afterRun(state, { version: current, verdict, at });
  writeState(paths.state, done.state);
  appendFileSync(paths.ledger, `${JSON.stringify({ direction: "selftest", updateId, result: verdict.result, stage: verdict.stage, detail: verdict.detail, version: current, ts: new Date(at).toISOString() })}\n`, { mode: 0o600 });
  return { lines: [`messaging selftest ${verdict.result.toUpperCase()}${verdict.stage ? ` at ${verdict.stage}` : ""} for ${current}: ${verdict.detail} (${lead})`], report: done.report };
}

/**
 * @param {{ paths: { ledger: string, state: string }, state: Record<string, any>, at: number, queue?: import("./converse.ts").QueuePort, queuePath?: string }} run
 * @returns {Promise<{ lines: string[], report: string | null }>}
 */
async function settlePending({ paths, state, at, queue, queuePath }: { paths: { ledger: string; state: string; }; state: Record<string, any>; at: number; queue?: import("./converse.ts").QueuePort; queuePath?: string; }): Promise<{ lines: string[]; report: string | null; }> {
  const { pending } = state;
  const port = queue ?? (await realQueue());
  const taken = entryLeft({ queue: port, queuePath }, pending.handoff);
  const line = { delivery: "queued", handoff: pending.handoff, taker: pending.taker };
  if (!taken && at - pending.queuedAt < TAKEN_WITHIN_MS) return { lines: [`messaging selftest: still waiting for ${pending.taker} to take ${pending.handoff}`], report: null };
  const seat = seatStage(line, taken);
  const verdict = seat.ok ? { result: pending.degraded ? "degraded" : "pass", stage: null, detail: seat.note } : { result: "red", stage: "seat", detail: seat.note };
  return finish({ paths, state, current: pending.version, verdict, at, updateId: pending.updateId, lead: "settled" });
}

/** @param {Awaited<ReturnType<typeof judgeWaiting>>} verdict @param {Awaited<ReturnType<typeof sendSelftest>>} reading @returns {string[]} */
export function formatReading(verdict: Awaited<ReturnType<typeof judgeWaiting>>, reading: Awaited<ReturnType<typeof sendSelftest>>): string[] {
  const mark = (/** @type {boolean | null} */ ok: boolean | null) => (ok === null ? "not reached" : ok ? "ok" : "FAILED");
  return [
    `messaging:selftest ${verdict.result.toUpperCase()}${verdict.stage ? ` at the ${verdict.stage} stage` : ""}: ${verdict.detail}`,
    ...verdict.stages.map((stage) => `  ${stage.name.padEnd(6)} ${mark(stage.ok).padEnd(11)} ${stage.note}`),
    `  waited ${Math.round(verdict.waitedMs / 1000)} s for the seat; recorded ${reading.recorded.length} message(s) that were NOT sent to any chat`,
    `ledger: ${reading.ledgerPath}`,
    `line: ${JSON.stringify(reading.line)}`,
  ];
}

/**
 * @param {string[]} argv `--tick` or nothing
 * @param {{ home?: string, now?: () => number, out?: (line: string) => void, err?: (line: string) => void, sleep?: (ms: number) => Promise<void>, queue?: import("./converse.ts").QueuePort, agents?: () => {label: string, status: string}[] | null }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv: string[], { home = homedir(), now = Date.now, out = console.log, err = console.error, sleep, queue, agents }: { home?: string; now?: () => number; out?: (line: string) => void; err?: (line: string) => void; sleep?: (ms: number) => Promise<void>; queue?: import("./converse.ts").QueuePort; agents?: () => { label: string; status: string; }[] | null; } = {}): Promise<number> {
  try {
    const { values } = parseArgs({ args: argv, options: { tick: { type: "boolean" } } });
    if (values.tick) {
      out(JSON.stringify(await tickSelftest({ home, now, queue, agents })));
      return EXIT.ok;
    }
    const reading = await sendSelftest({ home, now, queue, agents });
    const verdict = await judgeWaiting(reading, { now, sleep });
    for (const text of formatReading(verdict, reading)) out(text);
    return { pass: EXIT.ok, degraded: EXIT.degraded, red: EXIT.red, pending: EXIT.red }[verdict.result];
  } catch (error) {
    err(`messaging:selftest: ${describeError(error)}`);
    return EXIT.refused;
  }
}

// NO TOP-LEVEL `await` HERE (a11ign/a11ign#3701): `main` -> `tickSelftest` -> `realQueue()` does `import("../wake.ts")`, and `wake.ts` imports THIS file, so as the entry it is a module in a
// cycle that is still evaluating. An `await` on `main` made `wake.ts` wait for this file while this file waited for `wake.ts`: Node drained the loop and exited 13 on every tick that had work.
// `main` catches everything it throws, so this `then` has no rejection to leave unhandled.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
