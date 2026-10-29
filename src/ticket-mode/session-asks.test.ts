// no-token: none -- the board is made over a stub pool, a fake tracker and a temporary state directory; no socket is opened
// A11-302: the session's queue (`GET /api/session-asks`) lists no After-merge check: the org verifies its own work. A run that waits on the session is listed (A11-275)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { createBoard } from "./server.ts";
import { emptyQueue, saveQueue } from "./queue.ts";
import { enqueue, type Queue, type WorkingNote } from "./queue/queue-entries-and-outcomes.ts";
import { sessionAnswersPath } from "./session-answers.ts";
import type { Ticket } from "./source.ts";
import { parseTicketSettings } from "./settings.ts";
import { BOARD_LINES_2026_10_25 } from "./after-merge/board-lines-fixture.ts";
import { emptyChecks, seedChecks, type CheckRecord, type ChecksFile, type ListedRun } from "./after-merge/checks.ts";
import { afterMergeChecksPath, loadChecks, saveChecks } from "./after-merge/store.ts";
import { syncAfterMergeChecks } from "./after-merge/sweep.ts";
import type { SessionAsksView } from "./session-asks.ts";

const LINE = "Chairman session: the next major arrives as a ticket.";

const run = (key: string, lines: readonly string[]): ListedRun => ({ ticket: { key, url: `https://linear.app/a11ign/issue/${key}` }, finishedAt: 1_000, afterMerge: lines.map((line) => ({ line, owner: null })) });

/** A board over a stub pool whose clock `clock.at` says, and whose state directory holds the checks `file` gives. */
function board(file: ChecksFile = emptyChecks(), queue?: Queue) {
  const dir = tmpDir("session-asks-");
  const clock = { at: 9_000 };
  const settings = parseTicketSettings({ clones: { "agent-org": "/r/agent-org" }, stateDir: dir });
  const noop = () => {};
  const pool = { tick: async () => {}, stop: noop, close: async () => {}, dismiss: async () => {}, remove: async () => {}, respond: async () => {}, reconcile: async () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: noop,
    releaseReviewers: noop, retargetStacked: noop, rebaseStacked: async () => {}, applyEdit: async () => {}, discardEdit: noop, stopWriterRun: noop, reviewNewHeads: noop };
  const queuePath = join(dir, "tickets", "queue.json");
  if (queue !== undefined) saveQueue(queuePath, queue);
  const made = createBoard({ settings, source: createFakeTracker(), codeHost: createFakeCodeHost(), key: "k".repeat(48), queuePath, choicePath: join(dir, "choice.json"),
    pool, now: () => clock.at, version: null, next: () => null });
  const path = afterMergeChecksPath(dir);
  saveChecks(path, file);
  const everyAsk = async (since?: number) => {
    const [status, view] = await made.api("GET", "/api/session-asks", {}, new URLSearchParams(since === undefined ? {} : { since: String(since) }));
    assert.equal(status, 200);
    return view as SessionAsksView;
  };
  return { ...made, dir, path, clock, everyAsk };
}

const record = (id: string, over: Partial<CheckRecord>): CheckRecord => ({ id, key: id.split("#")[0], url: null, line: LINE, owner: "Chairman session", runner: "agent", listedAt: 1_000, state: "open", ...over });

test("A11-302: the session's queue lists no After-merge check, whoever runs it and however old it is", async () => {
  const file: ChecksFile = { checks: Object.fromEntries([
    record("A11-1#1", { runner: "session", sentAt: 1_000 }), record("A11-2#1", { runner: "agent" }), record("A11-3#1", { runner: "board", observe: { spec: { kind: "wake" }, from: 1_000 } }),
    record("A11-4#1", { runner: "person", escalation: "legal" }), record("A11-5#1", { runner: "person" }), record("A11-6#1", { runner: "agent", overdueAt: 5_000, sentAt: 5_000 }),
  ].map((one) => [one.id, one])) };
  const { everyAsk, path } = board(file);
  assert.deepEqual(await everyAsk(), { at: 9_000, asks: [] });
  assert.deepEqual(loadChecks(path), file, "and reading the queue marks nothing sent");
});

test("A11-302: the 33 After-merge lines on the board on 2026-10-25 each get a runner of the org's after one sweep, and none of them is the session's to run", async () => {
  const byKey = new Map<string, string[]>();
  for (const [key, line] of BOARD_LINES_2026_10_25) byKey.set(key, [...(byKey.get(key) ?? []), line]);
  const { everyAsk, dir } = board();
  const entries = [...byKey].map(([key, lines]) => ({ ...run(key, lines), phase: "finished" }));
  const ctx = { settings: { stateDir: dir, plan: "-plan-[^/]*\\.md$", writer: null }, store: { get: () => ({ entries }), set: () => {} }, source: {}, codeHost: { readReviewState: () => null }, now: () => 5_000, hook: { bin: "/tool/src/bin.ts" } } as never;
  await syncAfterMergeChecks(ctx);
  const checks = Object.values(loadChecks(afterMergeChecksPath(dir)).checks);
  assert.equal(checks.length, 33);
  assert.deepEqual(checks.filter((check) => check.runner === "session").map(({ id }) => id), [], "none is on the session");
  assert.deepEqual((await everyAsk()).asks, [], "and the session's queue lists none");
});

const ASK = "On the person's Mac run `agent-org update` and quote its last line; a pass reads 'installed 0.312.0'";
const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/a11ign/issue/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "A11", project: null, priority: 0 }) as Ticket;

/** A queue whose runs wait as `notes` say, by ticket key, with the pull requests `prs` gives. */
function queueOf(notes: Record<string, WorkingNote>, prs: Record<string, string[]> = {}): Queue {
  const queued = enqueue(emptyQueue(5), Object.keys(notes).map(ticket), { model: "sonnet", effort: "high" }, 0, null);
  return { ...queued, entries: queued.entries.map((entry) => ({ ...entry, working: notes[entry.ticket.key], ...(prs[entry.ticket.key] === undefined ? {} : { review: prs[entry.ticket.key].map((url) => ({ repo: "a11ign/agent-org", url })) }) })) };
}

const waitingOn = (ask: string, at: number, over: Partial<WorkingNote> = {}): WorkingNote => ({ reason: "needs the Mac", at, waits: [{ kind: "session", ask }], ...over });

test("A11-275: a run waiting on the person's session is listed as a waiting-run ask, with its ticket, pull requests, ask, when it was declared and the route that answers it", async () => {
  const pull = "https://github.com/a11ign/agent-org/pull/1906";
  const { everyAsk } = board(emptyChecks(), queueOf({ "A11-266": waitingOn(ASK, 4_000) }, { "A11-266": [pull] }));
  assert.deepEqual(await everyAsk(), { at: 9_000, asks: [
    { kind: "waiting-run", key: "A11-266", url: "https://linear.app/a11ign/issue/A11-266", pullRequests: [pull], ask: ASK, sentAt: 4_000, answer: "/api/session-asks/A11-266/answer" },
  ] });
  assert.deepEqual((await everyAsk()).asks.map(({ kind }) => kind), ["waiting-run"], "listing it again changes nothing");
});

test("A11-275: listing a waiting run writes nothing, and an After-merge check beside it is not listed", async () => {
  const seeded = seedChecks(emptyChecks(), [run("A11-235", [LINE])], 1_000);
  const { everyAsk, dir, path } = board(seeded, queueOf({ "A11-266": waitingOn(ASK, 4_000) }));
  const view = await everyAsk();
  assert.deepEqual(view.asks.map(({ kind }) => kind), ["waiting-run"], "the run waiting on the session, and no check");
  assert.equal(existsSync(sessionAnswersPath(dir)), false, "the waiting run's listing wrote no answers file");
  assert.equal(loadChecks(path).checks["A11-235#1"].sentAt, undefined, "and no check was marked sent");
});

test("A11-275: a run whose ask has an answer is not listed, nor is one already woken, stalled or waiting on something else", async () => {
  const { everyAsk, dir } = board(emptyChecks(), queueOf({
    "A11-1": waitingOn(ASK, 1_000), "A11-2": waitingOn(ASK, 2_000, { woke: { at: 3_000, why: "late" } }), "A11-3": waitingOn(ASK, 2_000, { stalled: true }),
    "A11-4": { reason: "r", at: 2_000, waits: [{ kind: "fleetJob", id: "fj-1" }] }, "A11-5": waitingOn(ASK, 2_000, { repeat: true }),
  }));
  assert.deepEqual((await everyAsk()).asks.map((ask) => ask.kind === "waiting-run" && ask.key), ["A11-1"]);
  writeFileSync(sessionAnswersPath(dir), JSON.stringify({ answers: [{ key: "A11-1", ask: ASK, at: 1_000, result: "ok", answeredAt: 1_500 }] }));
  assert.deepEqual((await everyAsk()).asks, [], "answered for this declaration");
  writeFileSync(sessionAnswersPath(dir), JSON.stringify({ answers: [{ key: "A11-1", ask: ASK, at: 500, result: "ok", answeredAt: 600 }] }));
  assert.equal((await everyAsk()).asks.length, 1, "an answer to an earlier declaration of the same words is not this one's");
});

test("A11-275: waiting runs are listed oldest first, and ?since does not hide one: its sentAt is when the worker wrote, which can be before a read that had not yet seen it", async () => {
  const { everyAsk } = board(emptyChecks(), queueOf({ "A11-1": waitingOn(ASK, 3_000), "A11-2": waitingOn("another ask", 1_000), "A11-3": waitingOn(ASK, 8_000) }));
  assert.deepEqual((await everyAsk()).asks.map((ask) => ask.kind === "waiting-run" && ask.key), ["A11-2", "A11-1", "A11-3"]);
  assert.deepEqual((await everyAsk(8_500)).asks.map((ask) => ask.kind === "waiting-run" && ask.key), ["A11-2", "A11-1", "A11-3"], "a read at 8,500 still lists the run that wrote at 3,000 and was first seen later");
});

test("A11-275: a batch is one run, listed once under its first ticket; one run with two asks lists both", async () => {
  const { everyAsk } = board(emptyChecks(), queueOf({ "A11-1": { reason: "r", at: 1_000, waits: [{ kind: "session", ask: "first" }, { kind: "session", ask: "second" }] }, "A11-2": waitingOn("third", 2_000) }));
  assert.deepEqual((await everyAsk()).asks.map((ask) => ask.kind === "waiting-run" && [ask.key, ask.ask]), [["A11-1", "first"], ["A11-1", "second"], ["A11-2", "third"]]);
  const queued = queueOf({ "A11-1": waitingOn(ASK, 1_000), "A11-2": waitingOn(ASK, 1_000) });
  const batched: Queue = { ...queued, entries: queued.entries.map((entry) => ({ ...entry, batch: "b1" })) };
  const { everyAsk: batchAsks, dir } = board(emptyChecks(), batched);
  assert.deepEqual((await batchAsks()).asks.map((ask) => ask.kind === "waiting-run" && ask.key), ["A11-1"]);
  writeFileSync(sessionAnswersPath(dir), JSON.stringify({ answers: [{ key: "A11-2", ask: ASK, at: 1_000, result: "ok", answeredAt: 1_500 }] }));
  assert.deepEqual((await batchAsks()).asks, [], "an answer posted under another ticket of the batch answers the batch's ask");
});

test("A11-275: a file of answers that cannot be read makes the queue throw, not list nothing", async () => {
  const { dir, api } = board(emptyChecks(), queueOf({ "A11-1": waitingOn(ASK, 1_000) }));
  writeFileSync(sessionAnswersPath(dir), "not json");
  await assert.rejects(async () => api("GET", "/api/session-asks", {}, new URLSearchParams()), SyntaxError);
});

test("A11-275: with no run waiting on the session the answers file is never read, so a bad one cannot break the queue", async () => {
  const { dir, everyAsk } = board(emptyChecks(), queueOf({ "A11-4": { reason: "r", at: 2_000, waits: [{ kind: "fleetJob", id: "fj-1" }] } }));
  writeFileSync(sessionAnswersPath(dir), "not json");
  assert.deepEqual((await everyAsk()).asks, []);
});

test("A11-277: a since that is not a time is refused with the words that say what it is", async () => {
  const { api } = board();
  await assert.rejects(api("GET", "/api/session-asks", {}, new URLSearchParams({ since: "yesterday" })), /since must be the `at` of an earlier read/);
});
