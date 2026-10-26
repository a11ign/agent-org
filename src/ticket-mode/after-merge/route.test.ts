// no-token: none -- the board is made over a stub pool, a fake tracker and a temporary state directory; no socket is opened
// A11-277: a runner closes an After-merge check with one line of evidence through the board's API, and the list leaves it
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../../plugins/fakes/tracker.ts";
import { createBoard, type QueueEntryView, type QueueView } from "../server.ts";
import { emptyQueue } from "../queue.ts";
import { enqueue } from "../queue/queue-entries-and-outcomes.ts";
import { ticketOf } from "../kept-pulls-fixture.ts";
import { parseTicketSettings } from "../settings.ts";
import { seedChecks, emptyChecks } from "./checks.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { afterMergeChecksPath, loadChecks, saveChecks } from "./store.ts";

const LINE = "Chairman session: the next major arrives as a ticket.";
const PERSON_LINE = "The chairman chooses the licence.";
const DAY = 24 * 60 * 60 * 1000;

/**
 * A board over a stub pool whose state directory holds A11-235's open check, an agent's (from a line no plan names a runner for), and A11-233's, which waits on the person for an item of the escalation list; a ticket with a run on
 * the queue shows its checks on its Run detail.
 */
function board(now = 9_000) {
  const dir = tmpDir("after-merge-route-");
  const settings = parseTicketSettings({ clones: { "agent-org": "/r/agent-org" }, stateDir: dir });
  const noop = () => {};
  const pool = { tick: async () => {}, stop: noop, close: noop, dismiss: async () => {}, remove: async () => {}, respond: noop, reconcile: noop, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: noop,
    releaseReviewers: noop, retargetStacked: noop, rebaseStacked: async () => {}, applyEdit: async () => {}, discardEdit: noop, stopWriterRun: noop, reviewNewHeads: noop };
  const made = createBoard({ settings, source: createFakeTracker(), codeHost: createFakeCodeHost(), key: "k".repeat(48), queuePath: join(dir, "tickets", "queue.json"), choicePath: join(dir, "choice.json"),
    pool, now: () => now, version: null, next: () => null });
  const path = afterMergeChecksPath(dir);
  const seeded = seedChecks(emptyChecks(), [{ ticket: { key: "A11-235", url: "https://linear.app/a11ign/issue/A11-235" }, finishedAt: 1_000, afterMerge: [{ line: LINE, owner: null }] },
    { ticket: { key: "A11-233", url: "https://linear.app/a11ign/issue/A11-233" }, finishedAt: 2_000, afterMerge: [{ line: PERSON_LINE, owner: "The chairman" }] }], 1_000);
  saveChecks(path, { checks: { ...seeded.checks, "A11-233#1": { ...seeded.checks["A11-233#1"], runner: "person", escalation: "legal" } } });
  const listed = async () => ((await made.api("GET", "/api/queue", {}))[1] as QueueView).afterMergeChecks?.map(({ id, state }) => [id, state]);
  return { ...made, path, listed };
}

test("A11-302: GET /api/queue lists only the checks that wait on the person, each with its owner, and not the org's", async () => {
  const { api } = board();
  const [status, view] = await api("GET", "/api/queue", {});
  assert.equal(status, 200);
  assert.deepEqual((view as QueueView).afterMergeChecks, [{
    id: "A11-233#1", key: "A11-233", url: "https://linear.app/a11ign/issue/A11-233", line: PERSON_LINE, runner: "person", listedAt: 2_000, state: "open", owner: "The chairman", followUpText: null, needsYou: "legal or licensing", overdue: false,
  }], "A11-235's agent check is not the person's, though it is open");
});

test("A11-302: the queue carries a count of the org's open checks older than three days, and the person's checks are not in it", async () => {
  const young = board(2_000 + 2 * DAY);
  assert.deepEqual(((await young.api("GET", "/api/queue", {}))[1] as QueueView).afterMergeOrg, { open: 1, stale: 0 });
  const old = board(1_000 + 3 * DAY + 1);
  assert.deepEqual(((await old.api("GET", "/api/queue", {}))[1] as QueueView).afterMergeOrg, { open: 1, stale: 1 }, "A11-235 listed at 1000 is just over three days old; A11-233 waits on the person and is not counted");
  const closed = board(1_000 + 9 * DAY);
  await closed.api("POST", "/api/after-merge/A11-235/1", { result: "passed", evidence: "seen", by: "agent" });
  assert.deepEqual(((await closed.api("GET", "/api/queue", {}))[1] as QueueView).afterMergeOrg, { open: 0, stale: 0 }, "a closed check is not counted");
});

test("A11-302: a ticket's Run detail lists its checks of every runner, with who closed them", async () => {
  const made = board();
  made.store.set(enqueue(emptyQueue(1), [ticketOf("A11-235")], { model: "sonnet", effort: "high" }, 1));
  const before = (await made.api("GET", "/api/queue/A11-235", {}))[1] as QueueEntryView;
  assert.deepEqual(before.afterMergeChecks?.map(({ id, runner, state, watching }) => [id, runner, state, watching]), [["A11-235#1", "agent", "open", null]]);
  await made.api("POST", "/api/after-merge/A11-235/1", { result: "failed", evidence: "no ticket arrived", by: "agent" });
  const after = (await made.api("GET", "/api/queue/A11-235", {}))[1] as QueueEntryView;
  assert.deepEqual(after.afterMergeChecks?.map(({ id, state, result, closedBy }) => [id, state, result, closedBy]), [["A11-235#1", "failed", "no ticket arrived", "agent"]]);
  assert.deepEqual(((await made.api("GET", "/api/queue/A11-233", {}))[1] as { error: string }).error, "no run A11-233 on the queue", "a ticket with no run has no Run detail");
});

test("A11-302: a verifier run closes its check through the route, and the row it never had does not appear in the person's list", async () => {
  for (const result of ["passed", "superseded"] as const) {
    const made = board();
    const [status, answer] = await made.api("POST", "/api/after-merge/A11-235/1", { result, evidence: "A11-284 was filed by the dependency sweep", by: "agent" });
    assert.equal(status, 200, result);
    assert.deepEqual(answer, { check: { ...loadChecks(made.path).checks["A11-235#1"] }, followUpText: null });
    assert.deepEqual([loadChecks(made.path).checks["A11-235#1"].state, loadChecks(made.path).checks["A11-235#1"].closedBy], [result, "agent"]);
    assert.deepEqual(await made.listed(), [["A11-233#1", "open"]], `a ${result} check was never in the person's list`);
  }
});

test("A11-302: the person's session is no closer of a check: a close by it is refused, and so is a close by the board", async () => {
  const made = board();
  await assert.rejects(made.api("POST", "/api/after-merge/A11-235/1", { result: "passed", evidence: "x", by: "session" }), /by must be agent or person: the person's session runs no check, and the board closes its own/);
  await assert.rejects(made.api("POST", "/api/after-merge/A11-235/1", { result: "passed", evidence: "x", by: "board" }), /by must be agent or person/);
  assert.equal(loadChecks(made.path).checks["A11-235#1"].state, "open");
});

test("A11-277: a failed close by a person answers with the pre-filled follow-up, stays listed until the follow-up is decided, and a second close is refused", async () => {
  const made = board();
  const [status, answer] = await made.api("POST", "/api/after-merge/A11-233/1", { result: "failed", evidence: "no ticket arrived for @x/y@2", by: "person" });
  assert.equal(status, 200);
  assert.match((answer as { followUpText: string }).followUpText, /^Follow-up to A11-233: its after-merge check failed\.\n\nThe check: .*\nWhat was seen: no ticket arrived for @x\/y@2\n\nRelated: A11-233\.$/);
  assert.deepEqual(await made.listed(), [["A11-233#1", "failed"]]);
  assert.deepEqual(await made.api("POST", "/api/after-merge/A11-233/1", { result: "passed", evidence: "ok", by: "person" }),
    [409, { error: "A11-233#1 is already failed, closed by a person: no ticket arrived for @x/y@2" }]);
  const [decided] = await made.api("POST", "/api/after-merge/A11-233/1/follow-up", { writer: "w-3" });
  assert.equal(decided, 200);
  assert.equal(loadChecks(made.path).checks["A11-233#1"].followUp, "w-3");
  assert.deepEqual(await made.listed(), [], "the follow-up decided, the row leaves");
});

test("A11-277: empty, multi-line and too-long evidence is refused, and the check stays open", async () => {
  const made = board();
  const close = (evidence: unknown) => made.api("POST", "/api/after-merge/A11-233/1", { result: "passed", evidence, by: "person" } as never);
  assert.deepEqual(await close(""), [400, { error: "evidence must say, in one line, what was seen" }]);
  assert.deepEqual(await close("seen\non the board"), [400, { error: "evidence must be one line" }]);
  assert.deepEqual(await close("x".repeat(301)), [400, { error: "evidence must be at most 300 characters" }]);
  await assert.rejects(close(undefined), /evidence must be one line saying what was seen/, "a body with no evidence THROWS, which the handler answers with 400");
  await assert.rejects(made.api("POST", "/api/after-merge/A11-233/1", { result: "maybe", evidence: "x", by: "person" }), /result must be passed, failed or superseded/);
  assert.deepEqual(await made.listed(), [["A11-233#1", "open"]]);
  assert.deepEqual(await made.api("POST", "/api/after-merge/A11-233/2", { result: "passed", evidence: "x", by: "person" }), [404, { error: "no After-merge check A11-233#2" }]);
});

test("A11-302: GET /api/after-merge/audit says whether any open check is still on the retired runner or is an org check past three days outside its window", async () => {
  const fresh = board(1_000 + DAY);
  assert.deepEqual(await fresh.api("GET", "/api/after-merge/audit", {}), [200, { ok: true, unmigrated: [], stale: [] }]);
  const old = board(1_000 + 4 * DAY);
  assert.deepEqual(await old.api("GET", "/api/after-merge/audit", {}), [200, { ok: false, unmigrated: [], stale: ["A11-235#1"] }], "A11-235's agent check is four days old; A11-233 waits on the person");
  const retired = board();
  saveChecks(retired.path, { checks: { ...loadChecks(retired.path).checks, "A11-235#1": { ...loadChecks(retired.path).checks["A11-235#1"], runner: "session" } } });
  assert.deepEqual((await retired.api("GET", "/api/after-merge/audit", {}))[1], { ok: false, unmigrated: ["A11-235#1"], stale: [] });
});

test("A11-302: a checks file that cannot be read is said by the queue, the Run detail and the audit, never shown as an empty list, a zero count or a ticket with no checks", async () => {
  const made = board();
  made.store.set(enqueue(emptyQueue(1), [ticketOf("A11-235")], { model: "sonnet", effort: "high" }, 1));
  writeFileSync(made.path, "{ not json");
  const queue = (await made.api("GET", "/api/queue", {}))[1] as QueueView;
  assert.match(queue.afterMergeUnreadable ?? "", /^the After-merge checks cannot be read, so none is listed: /);
  assert.deepEqual([queue.afterMergeChecks, queue.afterMergeOrg], [undefined, undefined], "no list and no count are made up");
  const detail = (await made.api("GET", "/api/queue/A11-235", {}))[1] as QueueEntryView;
  assert.match(detail.afterMergeUnreadable ?? "", /cannot be read/);
  assert.equal(detail.afterMergeChecks, undefined);
  await assert.rejects(made.api("GET", "/api/after-merge/audit", {}), SyntaxError, "the audit throws, which the handler answers with 400: it never reports ok on a file it could not read");
  assert.equal((await made.api("GET", "/api/queue", {}))[0], 200, "the rest of the queue is still answered");
  writeFileSync(made.path, "{ not json");
  assert.equal(readFileSync(made.path, "utf8"), "{ not json", "and the file is not written over");
});
