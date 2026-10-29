// no-token: none -- the board is made over a stub pool, a fake tracker and a temporary state directory; the one socket is a loopback server that proves the key is asked for
// A11-275: an ask only the person's session can do is answered through `POST /api/session-asks/<KEY>/answer`; the answer is kept on disk and finishes the run's wait
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { createBoard } from "./server.ts";
import { emptyQueue, saveQueue } from "./queue.ts";
import { enqueue, type Queue, type WorkingNote } from "./queue/queue-entries-and-outcomes.ts";
import { MAX_RESULT_CHARS, loadAnswers, resultOf, sessionAnswersPath } from "./session-answers.ts";
import { parseTicketSettings } from "./settings.ts";
import type { Ticket } from "./source.ts";

const KEY = "a".repeat(48);
const ASK = "On the person's Mac run `agent-org update` and quote its last line; a pass reads 'installed 0.312.0'";
const AT = 5_000;
const ticket = (key: string) => ({ key, title: key, description: "", url: `https://linear.app/a11ign/issue/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "A11", project: null, priority: 0 }) as Ticket;

/** A queue holding the runs `keys` name, each with `note` as its working note. */
function queueWith(keys: readonly string[], note: WorkingNote | undefined): Queue {
  const queued = enqueue(emptyQueue(3), keys.map(ticket), { model: "sonnet", effort: "high" }, 0, null);
  return { ...queued, entries: queued.entries.map((entry) => ({ ...entry, ...(note === undefined ? {} : { working: note }) })) };
}

const waiting = (over: Partial<WorkingNote> = {}): WorkingNote => ({ reason: "needs the Mac", at: AT, waits: [{ kind: "session", ask: ASK }], ...over });

/** A board over a stub pool whose queue is `queue`, with its state in a directory of its own. */
function board(queue: Queue, port = 4747) {
  const dir = tmpDir("session-answers-");
  const clock = { at: 9_000 };
  const settings = parseTicketSettings({ clones: { "agent-org": "/r/agent-org" }, stateDir: dir, tickets: { port } });
  const noop = () => {};
  const pool = { tick: async () => {}, stop: noop, close: noop, dismiss: async () => {}, remove: async () => {}, respond: async () => {}, reconcile: noop, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: noop,
    releaseReviewers: noop, retargetStacked: noop, rebaseStacked: async () => {}, applyEdit: async () => {}, discardEdit: noop, stopWriterRun: noop, reviewNewHeads: noop };
  const queuePath = join(dir, "tickets", "queue.json");
  saveQueue(queuePath, queue);
  const made = createBoard({ settings, source: createFakeTracker(), codeHost: createFakeCodeHost(), key: KEY, queuePath, choicePath: join(dir, "choice.json"), pool, now: () => clock.at, version: null, next: () => null });
  const answer = (key: string, body: Record<string, unknown>) => made.api("POST", `/api/session-asks/${key}/answer`, body);
  return { ...made, dir, clock, answer, answers: () => loadAnswers(sessionAnswersPath(dir)) };
}

test("A11-275: the session's answer is recorded for the run's declaration, and finds it again by ticket, ask and the declaration's time", async () => {
  const { answer, answers, dir } = board(queueWith(["A11-1"], waiting()));
  assert.deepEqual(await answer("A11-1", { ask: ASK, result: "  installed 0.312.0\n" }), [200, { key: "A11-1", ask: ASK, result: "installed 0.312.0" }]);
  assert.deepEqual(answers().answers, [{ key: "A11-1", ask: ASK, at: AT, result: "installed 0.312.0", answeredAt: 9_000 }]);
  assert.equal(resultOf(answers(), ["A11-1"], ASK, AT), "installed 0.312.0");
  assert.equal(resultOf(answers(), ["A11-1"], ASK, AT + 1), null, "an answer given for an earlier declaration does not finish a later one");
  assert.equal(resultOf(answers(), ["A11-1"], `${ASK}!`, AT), null);
  assert.equal(resultOf(answers(), ["A11-2"], ASK, AT), null);
  assert.ok(sessionAnswersPath(dir).endsWith(join("tickets", "session-answers.json")), "kept beside the queue, in the board's tickets directory");
});

test("A11-275: an unknown run is a 404, and a run that is not waiting on exactly that ask is a 409", async () => {
  const { answer, answers } = board(queueWith(["A11-1"], waiting()));
  assert.deepEqual(await answer("A11-9", { ask: ASK, result: "ok" }), [404, { error: "the board has no run A11-9" }]);
  const other = await answer("A11-1", { ask: `${ASK} `.trim() + " again", result: "ok" });
  assert.equal(other[0], 409);
  assert.match((other[1] as { error: string }).error, /^A11-1 is not waiting on that ask/);
  assert.deepEqual(answers().answers, [], "nothing is recorded for either");
  const idle = board(queueWith(["A11-1"], undefined));
  assert.equal((await idle.answer("A11-1", { ask: ASK, result: "ok" }))[0], 409, "a run with no working note waits on nothing");
  const fleet = board(queueWith(["A11-1"], waiting({ waits: [{ kind: "fleetJob", id: "fj-1" }] })));
  assert.equal((await fleet.answer("A11-1", { ask: ASK, result: "ok" }))[0], 409, "a run waiting on something else waits on no ask");
});

test("A11-275: a wait that has ended is not answered: the worker was woken, and declares it again", async () => {
  for (const ended of [{ woke: { at: 6_000, why: "late" as const } }, { woke: { at: 6_000, why: "finished" as const } }, { stalled: true }]) {
    const { answer, answers } = board(queueWith(["A11-1"], waiting(ended)));
    const [status, body] = await answer("A11-1", { ask: ASK, result: "ok" });
    assert.equal(status, 409, JSON.stringify(ended));
    assert.match((body as { error: string }).error, /wait on that ask has ended/);
    assert.deepEqual(answers().answers, []);
  }
});

test("A11-275: an empty, missing or too long result, and a missing ask, are refused with the sentence", async () => {
  const { answer, answers } = board(queueWith(["A11-1"], waiting()));
  await assert.rejects(async () => answer("A11-1", { ask: ASK, result: "  " }), /^Error: result must be one line or more saying what the session saw$/);
  await assert.rejects(async () => answer("A11-1", { ask: ASK }), /result must be/);
  await assert.rejects(async () => answer("A11-1", { ask: ASK, result: "x".repeat(MAX_RESULT_CHARS + 1) }), /^Error: result takes up to 4000 characters, you wrote 4001$/);
  await assert.rejects(async () => answer("A11-1", { result: "ok" }), /^Error: ask must be the ask, exactly as GET \/api\/session-asks listed it$/);
  assert.deepEqual(answers().answers, []);
  assert.equal((await answer("A11-1", { ask: ASK, result: "x".repeat(MAX_RESULT_CHARS) }))[0], 200, "4,000 characters is the longest");
});

test("A11-275: the same answer again is accepted and changes nothing; a different result for an ask already answered is refused", async () => {
  const { answer, answers, clock } = board(queueWith(["A11-1"], waiting()));
  await answer("A11-1", { ask: ASK, result: "installed 0.312.0" });
  clock.at = 20_000;
  assert.deepEqual(await answer("A11-1", { ask: ASK, result: "installed 0.312.0" }), [200, { key: "A11-1", ask: ASK, result: "installed 0.312.0" }]);
  assert.deepEqual(answers().answers.map(({ answeredAt }) => answeredAt), [9_000], "the second post wrote nothing");
  const [status, body] = await answer("A11-1", { ask: ASK, result: "failed" });
  assert.equal(status, 409);
  assert.equal((body as { error: string }).error, "A11-1 was already answered for that ask");
  assert.equal(answers().answers[0].result, "installed 0.312.0");
});

test("A11-275: an answer given by any ticket of a batch finishes the batch's wait", async () => {
  const { answer, answers } = board(queueWith(["A11-1", "A11-2"], waiting()));
  assert.equal((await answer("A11-2", { ask: ASK, result: "ok" }))[0], 200);
  assert.equal(resultOf(answers(), ["A11-1", "A11-2"], ASK, AT), "ok", "the run's seam asks with every ticket of the run");
});

test("A11-275: a file of answers that cannot be read throws, and is never read as no answers", async () => {
  const { answer, dir } = board(queueWith(["A11-1"], waiting()));
  writeFileSync(sessionAnswersPath(dir), "{ not json");
  await assert.rejects(async () => answer("A11-1", { ask: ASK, result: "ok" }), SyntaxError);
  writeFileSync(sessionAnswersPath(dir), JSON.stringify({ answers: [{ key: "A11-1" }] }));
  await assert.rejects(async () => answer("A11-1", { ask: ASK, result: "ok" }), /is not a record of the session's answers/);
  assert.equal(JSON.parse(readFileSync(sessionAnswersPath(dir), "utf8")).answers.length, 1, "the unreadable file was not written over");
});

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

test("A11-275: the answer route answers only to the board's key", async () => {
  const port = await freePort();
  const { handle } = board(queueWith(["A11-1"], waiting()), port);
  const server = createServer((request, response) => { void handle(request, response); });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  const base = `http://127.0.0.1:${port}`;
  const post = (headers: Record<string, string>) => fetch(`${base}/api/session-asks/A11-1/answer`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ ask: ASK, result: "ok" }) });
  try {
    assert.equal((await post({})).status, 401, "no key");
    assert.equal((await post({ "x-ticket-token": "b".repeat(48) })).status, 401, "another key");
    assert.equal((await post({ "x-ticket-token": KEY })).status, 200, "the board's key");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
