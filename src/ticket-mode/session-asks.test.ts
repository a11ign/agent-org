// no-token: none -- the board is made over a stub pool, a fake tracker and a temporary state directory; no socket is opened
// A11-277: an After-merge check the session runs is sent to it through `GET /api/session-asks`, with its ticket, its line and what would close it; a Needs-you check is not
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { createBoard, type QueueView } from "./server.ts";
import { emptyQueue, saveQueue } from "./queue.ts";
import { enqueue, type Queue, type WorkingNote } from "./queue/queue-entries-and-outcomes.ts";
import { sessionAnswersPath } from "./session-answers.ts";
import type { Ticket } from "./source.ts";
import { parseTicketSettings } from "./settings.ts";
import { BOARD_LINES_2026_10_25 } from "./after-merge/board-lines-fixture.ts";
import { emptyChecks, seedChecks, type ChecksFile, type ListedRun, type PlannedCheck } from "./after-merge/checks.ts";
import { markOverdue, OVERDUE_MS } from "./after-merge/dispatch.ts";
import { afterMergeChecksPath, changeChecks, loadChecks, saveChecks } from "./after-merge/store.ts";
import { syncAfterMergeChecks } from "./after-merge/sweep.ts";
import { DEFAULT_CHECK_EVIDENCE, type AfterMergeAsk, type SessionAsksView } from "./session-asks.ts";

const LINE = "Chairman session: the next major arrives as a ticket.";
const PERSON_LINE = "The chairman chooses the name and licence.";

const run = (key: string, lines: readonly string[]): ListedRun => ({ ticket: { key, url: `https://linear.app/a11ign/issue/${key}` }, finishedAt: 1_000, afterMerge: lines.map((line) => ({ line, owner: null })) });

/** A board over a stub pool whose clock `clock.at` says, and whose state directory holds the checks `file` gives. */
function board(file: ChecksFile = emptyChecks(), queue?: Queue) {
  const dir = tmpDir("session-asks-");
  const clock = { at: 9_000 };
  const settings = parseTicketSettings({ clones: { "agent-org": "/r/agent-org" }, stateDir: dir });
  const noop = () => {};
  const pool = { tick: async () => {}, stop: noop, close: noop, dismiss: async () => {}, remove: async () => {}, respond: noop, reconcile: noop, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: noop,
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
  /** The After-merge checks the session is asked to run: the first kind of ask. */
  const asks = async (since?: number) => {
    const view = await everyAsk(since);
    return { at: view.at, asks: view.asks.filter((ask): ask is AfterMergeAsk => ask.kind === "after-merge-check") };
  };
  const listed = async () => ((await made.api("GET", "/api/queue", {}))[1] as QueueView).afterMergeChecks;
  return { ...made, dir, path, clock, asks, everyAsk, listed };
}

const planned = (key: string, checks: readonly PlannedCheck[]) => new Map([[key, checks]]);

test("A11-277: a session check is listed in session asks with its ticket, its line and what would close it, and is sent once", async () => {
  const evidence = "the ticket the dependency sweep filed, by key";
  const seeded = seedChecks(seedChecks(emptyChecks(), [run("A11-235", [LINE])], 1_000, planned("A11-235", [{ line: LINE, runner: "session", evidence }])), [run("A11-178", ["Chairman session: the next partial step merges."])], 1_000);
  const { asks, clock, path } = board(seeded);
  const first = await asks();
  assert.deepEqual(first, { at: 9_000, asks: [
    { kind: "after-merge-check", id: "A11-235#1", key: "A11-235", url: "https://linear.app/a11ign/issue/A11-235", line: LINE, owner: "Chairman session", role: null, evidence, sentAt: 9_000, overdue: false, close: "/api/after-merge/A11-235/1" },
    { kind: "after-merge-check", id: "A11-178#1", key: "A11-178", url: "https://linear.app/a11ign/issue/A11-178", line: "Chairman session: the next partial step merges.", owner: "Chairman session", role: null,
      evidence: DEFAULT_CHECK_EVIDENCE, sentAt: 9_000, overdue: false, close: "/api/after-merge/A11-178/1" },
  ] });
  clock.at = 12_000;
  assert.deepEqual((await asks()).asks.map(({ sentAt }) => sentAt), [9_000, 9_000], "a second read keeps when each was sent");
  assert.equal(loadChecks(path).checks["A11-235#1"].sentAt, 9_000, "the board records when it sent the check");
});

test("A11-277: a person check on the escalation list shows under Needs you and is not sent to the session; one off the list is sent to the session", async () => {
  const onList = seedChecks(emptyChecks(), [run("A11-233", [PERSON_LINE])], 1_000, planned("A11-233", [{ line: PERSON_LINE, runner: "person", escalation: "legal", evidence: "the licence named on the ticket" }]));
  const offList = seedChecks(onList, [run("A11-234", [PERSON_LINE])], 1_000);
  const { asks, listed } = board(offList);
  assert.deepEqual((await asks()).asks.map(({ id, owner }) => [id, owner]), [["A11-234#1", "The chairman"]], "only the check on no escalation item goes to the session");
  assert.deepEqual((await listed()).map(({ id, needsYou }) => [id, needsYou]), [["A11-233#1", "legal or licensing"], ["A11-234#1", null]], "the one on the list waits under Needs you, with its item's label");
});

test("A11-277: a check the session closes from its ask leaves the asks", async () => {
  const { api, asks } = board(seedChecks(emptyChecks(), [run("A11-235", [LINE])], 1_000));
  const [ask] = (await asks()).asks;
  const [status] = await api("POST", ask.close, { result: "passed", evidence: "A11-284 arrived as a ticket", by: "session" });
  assert.equal(status, 200);
  assert.deepEqual((await asks()).asks, []);
});

test("A11-277: a read since the last one lists only what was sent since, and an overdue check is sent again, once, marked overdue", async () => {
  const { asks, clock, path } = board(seedChecks(emptyChecks(), [run("A11-235", [LINE])], 1_000));
  const { at } = await asks();
  clock.at = at + 1_000;
  assert.deepEqual((await asks(at)).asks, [], "nothing new since the last read");
  changeChecks(path, (file) => markOverdue(file, at + OVERDUE_MS));
  const again = await asks(at + 1_000);
  assert.deepEqual(again.asks.map(({ id, overdue, sentAt }) => [id, overdue, sentAt]), [["A11-235#1", true, at + OVERDUE_MS]]);
  changeChecks(path, (file) => markOverdue(file, at + 9 * 24 * 60 * 60 * 1000));
  assert.deepEqual((await asks(at + OVERDUE_MS)).asks, [], "it is never sent a third time");
});

test("A11-277: a since that is not a time is refused with the words that say what it is", async () => {
  const { api } = board();
  await assert.rejects(api("GET", "/api/session-asks", {}, new URLSearchParams({ since: "yesterday" })), /since must be the `at` of an earlier read/);
});

test("A11-277: the 33 After-merge lines on the board on 2026-10-25 each read an owner, and every one is listed in session asks after one sweep", async () => {
  const byKey = new Map<string, string[]>();
  for (const [key, line] of BOARD_LINES_2026_10_25) byKey.set(key, [...(byKey.get(key) ?? []), line]);
  const { asks, dir, listed } = board();
  const entries = [...byKey].map(([key, lines]) => ({ ...run(key, lines), phase: "finished" }));
  const ctx = { settings: { stateDir: dir, plan: "-plan-[^/]*\\.md$" }, store: { get: () => ({ entries }) }, source: {}, codeHost: { readReviewState: () => null }, now: () => 5_000 } as never;
  await syncAfterMergeChecks(ctx);
  assert.deepEqual((await listed()).filter(({ owner }) => owner === "owner not named").map(({ id }) => id), [], "no row says owner not named");
  const sent = (await asks()).asks;
  assert.equal(sent.length, 33);
  assert.deepEqual(new Set(sent.map(({ line }) => line)), new Set(BOARD_LINES_2026_10_25.map(([, line]) => line)), "every line is sent to the session");
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

test("A11-275: listing a waiting run writes nothing, and the After-merge checks still list as before beside it", async () => {
  const seeded = seedChecks(emptyChecks(), [run("A11-235", [LINE])], 1_000, planned("A11-235", [{ line: LINE, runner: "session", evidence: "one line" }]));
  const { everyAsk, dir, path } = board(seeded, queueOf({ "A11-266": waitingOn(ASK, 4_000) }));
  const view = await everyAsk();
  assert.deepEqual(view.asks.map(({ kind }) => kind), ["after-merge-check", "waiting-run"], "the first kind, then the second");
  assert.equal(view.asks[0].kind === "after-merge-check" && view.asks[0].sentAt, 9_000, "an After-merge check is sent when first listed");
  assert.equal(existsSync(sessionAnswersPath(dir)), false, "the waiting run's listing wrote no answers file");
  assert.equal(loadChecks(path).checks["A11-235#1"].sentAt, 9_000);
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

test("A11-275: a file of answers that cannot be read makes the queue throw, not list nothing, and marks no After-merge check sent", async () => {
  const seeded = seedChecks(emptyChecks(), [run("A11-235", [LINE])], 1_000, planned("A11-235", [{ line: LINE, runner: "session", evidence: "one line" }]));
  const { dir, api, path } = board(seeded, queueOf({ "A11-1": waitingOn(ASK, 1_000) }));
  writeFileSync(sessionAnswersPath(dir), "not json");
  await assert.rejects(async () => api("GET", "/api/session-asks", {}, new URLSearchParams()), SyntaxError);
  assert.equal(loadChecks(path).checks["A11-235#1"].sentAt, undefined, "the check was not marked sent for a listing the session never got");
});

test("A11-275: with no run waiting on the session the answers file is never read, so a bad one cannot break the After-merge queue", async () => {
  const seeded = seedChecks(emptyChecks(), [run("A11-235", [LINE])], 1_000, planned("A11-235", [{ line: LINE, runner: "session", evidence: "one line" }]));
  const { dir, asks } = board(seeded, queueOf({ "A11-4": { reason: "r", at: 2_000, waits: [{ kind: "fleetJob", id: "fj-1" }] } }));
  writeFileSync(sessionAnswersPath(dir), "not json");
  assert.deepEqual((await asks()).asks.map(({ id }) => id), ["A11-235#1"]);
});
