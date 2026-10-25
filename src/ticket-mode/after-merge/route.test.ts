// no-token: none -- the board is made over a stub pool, a fake tracker and a temporary state directory; no socket is opened
// A11-277: a runner closes an After-merge check with one line of evidence through the board's API, and the list leaves it
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../../plugins/fakes/tracker.ts";
import { createBoard, type QueueView } from "../server.ts";
import { parseTicketSettings } from "../settings.ts";
import { seedChecks, emptyChecks } from "./checks.ts";
import { afterMergeChecksPath, loadChecks, saveChecks } from "./store.ts";

const LINE = "Chairman session: the next major arrives as a ticket.";

/** A board over a stub pool whose state directory holds A11-235's one open check. */
function board() {
  const dir = tmpDir("after-merge-route-");
  const settings = parseTicketSettings({ clones: { "agent-org": "/r/agent-org" }, stateDir: dir });
  const noop = () => {};
  const pool = { tick: async () => {}, stop: noop, close: noop, dismiss: async () => {}, remove: async () => {}, respond: noop, reconcile: noop, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: noop,
    releaseReviewers: noop, retargetStacked: noop, rebaseStacked: async () => {}, applyEdit: async () => {}, discardEdit: noop, stopWriterRun: noop, reviewNewHeads: noop };
  const made = createBoard({ settings, source: createFakeTracker(), codeHost: createFakeCodeHost(), key: "k".repeat(48), queuePath: join(dir, "tickets", "queue.json"), choicePath: join(dir, "choice.json"),
    pool, now: () => 9_000, version: null, next: () => null });
  const path = afterMergeChecksPath(dir);
  saveChecks(path, seedChecks(emptyChecks(), [{ ticket: { key: "A11-235", url: "https://linear.app/a11ign/issue/A11-235" }, finishedAt: 1_000, afterMerge: [{ line: LINE, owner: null }] }], 1_000));
  const listed = async () => ((await made.api("GET", "/api/queue", {}))[1] as QueueView).afterMergeChecks.map(({ id, state }) => [id, state]);
  return { ...made, path, listed };
}

test("A11-277: GET /api/queue lists the open checks, each with its owner and runner", async () => {
  const { api } = board();
  const [status, view] = await api("GET", "/api/queue", {});
  assert.equal(status, 200);
  assert.deepEqual((view as QueueView).afterMergeChecks, [{
    id: "A11-235#1", key: "A11-235", url: "https://linear.app/a11ign/issue/A11-235", line: LINE, runner: "session", listedAt: 1_000, state: "open", owner: "Chairman session", role: null, followUpText: null,
  }]);
});

test("A11-277: passed and superseded each close with their evidence, and the row leaves the list", async () => {
  for (const result of ["passed", "superseded"] as const) {
    const made = board();
    const [status, answer] = await made.api("POST", "/api/after-merge/A11-235/1", { result, evidence: "A11-284 was filed by the dependency sweep", by: "session" });
    assert.equal(status, 200, result);
    assert.deepEqual(answer, { check: { ...loadChecks(made.path).checks["A11-235#1"] }, followUpText: null });
    assert.deepEqual([loadChecks(made.path).checks["A11-235#1"].state, loadChecks(made.path).checks["A11-235#1"].closedBy], [result, "session"]);
    assert.deepEqual(await made.listed(), [], `a ${result} check leaves the list`);
  }
});

test("A11-277: a failed close answers with the pre-filled follow-up, stays listed until the follow-up is decided, and a second close is refused", async () => {
  const made = board();
  const [status, answer] = await made.api("POST", "/api/after-merge/A11-235/1", { result: "failed", evidence: "no ticket arrived for @x/y@2", by: "person" });
  assert.equal(status, 200);
  assert.match((answer as { followUpText: string }).followUpText, /^Follow-up to A11-235: its after-merge check failed\.\n\nThe check: .*\nWhat was seen: no ticket arrived for @x\/y@2\n\nRelated: A11-235\.$/);
  assert.deepEqual(await made.listed(), [["A11-235#1", "failed"]]);
  assert.deepEqual(await made.api("POST", "/api/after-merge/A11-235/1", { result: "passed", evidence: "ok", by: "person" }),
    [409, { error: "A11-235#1 is already failed, closed by a person: no ticket arrived for @x/y@2" }]);
  const [decided] = await made.api("POST", "/api/after-merge/A11-235/1/follow-up", { writer: "w-3" });
  assert.equal(decided, 200);
  assert.equal(loadChecks(made.path).checks["A11-235#1"].followUp, "w-3");
  assert.deepEqual(await made.listed(), [], "the follow-up decided, the row leaves");
});

test("A11-277: empty, multi-line and too-long evidence is refused, and the check stays open", async () => {
  const made = board();
  const close = (evidence: unknown) => made.api("POST", "/api/after-merge/A11-235/1", { result: "passed", evidence, by: "person" } as never);
  assert.deepEqual(await close(""), [400, { error: "evidence must say, in one line, what was seen" }]);
  assert.deepEqual(await close("seen\non the board"), [400, { error: "evidence must be one line" }]);
  assert.deepEqual(await close("x".repeat(301)), [400, { error: "evidence must be at most 300 characters" }]);
  await assert.rejects(close(undefined), /evidence must be one line saying what was seen/, "a body with no evidence THROWS, which the handler answers with 400");
  await assert.rejects(made.api("POST", "/api/after-merge/A11-235/1", { result: "maybe", evidence: "x", by: "person" }), /result must be passed, failed or superseded/);
  await assert.rejects(made.api("POST", "/api/after-merge/A11-235/1", { result: "passed", evidence: "x", by: "board" }), /by must be session or person/, "the board closes its checks in its sweep");
  assert.deepEqual(await made.listed(), [["A11-235#1", "open"]]);
  assert.deepEqual(await made.api("POST", "/api/after-merge/A11-235/2", { result: "passed", evidence: "x", by: "person" }), [404, { error: "no After-merge check A11-235#2" }]);
});
