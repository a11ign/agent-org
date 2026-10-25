// no-token: none -- the board is made over a stub pool, a fake tracker and a temporary state directory; no socket is opened
// A11-277: an After-merge check the session runs is sent to it through `GET /api/session-asks`, with its ticket, its line and what would close it; a Needs-you check is not
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { createBoard, type QueueView } from "./server.ts";
import { parseTicketSettings } from "./settings.ts";
import { BOARD_LINES_2026_10_25 } from "./after-merge/board-lines-fixture.ts";
import { emptyChecks, seedChecks, type ChecksFile, type ListedRun, type PlannedCheck } from "./after-merge/checks.ts";
import { markOverdue, OVERDUE_MS } from "./after-merge/dispatch.ts";
import { afterMergeChecksPath, changeChecks, loadChecks, saveChecks } from "./after-merge/store.ts";
import { syncAfterMergeChecks } from "./after-merge/sweep.ts";
import { DEFAULT_CHECK_EVIDENCE, type SessionAsksView } from "./session-asks.ts";

const LINE = "Chairman session: the next major arrives as a ticket.";
const PERSON_LINE = "The chairman chooses the name and licence.";

const run = (key: string, lines: readonly string[]): ListedRun => ({ ticket: { key, url: `https://linear.app/a11ign/issue/${key}` }, finishedAt: 1_000, afterMerge: lines.map((line) => ({ line, owner: null })) });

/** A board over a stub pool whose clock `clock.at` says, and whose state directory holds the checks `file` gives. */
function board(file: ChecksFile = emptyChecks()) {
  const dir = tmpDir("session-asks-");
  const clock = { at: 9_000 };
  const settings = parseTicketSettings({ clones: { "agent-org": "/r/agent-org" }, stateDir: dir });
  const noop = () => {};
  const pool = { tick: async () => {}, stop: noop, close: noop, dismiss: async () => {}, remove: async () => {}, respond: noop, reconcile: noop, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: noop,
    releaseReviewers: noop, retargetStacked: noop, rebaseStacked: async () => {}, applyEdit: async () => {}, discardEdit: noop, stopWriterRun: noop, reviewNewHeads: noop };
  const made = createBoard({ settings, source: createFakeTracker(), codeHost: createFakeCodeHost(), key: "k".repeat(48), queuePath: join(dir, "tickets", "queue.json"), choicePath: join(dir, "choice.json"),
    pool, now: () => clock.at, version: null, next: () => null });
  const path = afterMergeChecksPath(dir);
  saveChecks(path, file);
  const asks = async (since?: number) => {
    const [status, view] = await made.api("GET", "/api/session-asks", {}, new URLSearchParams(since === undefined ? {} : { since: String(since) }));
    assert.equal(status, 200);
    return view as SessionAsksView;
  };
  const listed = async () => ((await made.api("GET", "/api/queue", {}))[1] as QueueView).afterMergeChecks;
  return { ...made, dir, path, clock, asks, listed };
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
