// no-token: gh -- the tracker and herdr are injected; the one server listens on 127.0.0.1 for the length of a test
import { createSettledPool } from "./pool-settled-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { createFakeCodeHost } from "../plugins/fakes/code-host.ts";
import { createFakeTracker } from "../plugins/fakes/tracker.ts";
import { createPool } from "./pool.ts";
import { fakeHerdr } from "./pool-fixture.ts";
import { enqueue, type Outcome } from "./queue/queue-entries-and-outcomes.ts";
import { emptyQueue } from "./queue.ts";
import { createBoard } from "./server.ts";
import { parseTicketSettings } from "./settings.ts";
import type { Ticket, TicketSource } from "./source.ts";

const KEY = "a".repeat(48);
const QUESTION = "Which wording should the round cap use?";
const base = createFakeTracker();
const ticket = (key: string, description: string) => ({ key, title: key, description, url: `https://linear.app/x/${key}`, branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/** A board over a real pool whose NBF-1 run is parked on `outcome` with its workspace open, a tracker that holds its description, and a herdr that records what it is sent. */
function parkedBoard(port: number, outcome: Outcome = { kind: "needs-human", reason: QUESTION }) {
  const dir = tmpDir("ticket-answer-server-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir, tickets: { port } });
  const held = { description: "Fix the toast." };
  const source: TicketSource = { assigned: base.assigned, download: base.download, keywords: base.keywords, viewer: async () => "Dana Beck",
    read: async (key) => ticket(key, held.description),
    updateTicketText: async (_key, text) => { held.description = text.description ?? held.description; } };
  const herdr = fakeHerdr(new Map());
  const refuse = { on: false };
  const run = (args: string[]): string => {
    if (refuse.on && args.includes("prompt")) throw Object.assign(new Error("herdr exited 1"), { stdout: JSON.stringify({ error: { message: "agent_blocked" } }) });
    return herdr.run(args);
  };
  const lazy: { pool?: ReturnType<typeof createPool> } = {};
  const noop = () => {};
  const pool = { tick: async () => {}, stop: noop, close: noop, dismiss: async () => {}, remove: async () => {}, respond: async () => {}, reconcile: noop, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: noop,
    releaseReviewers: noop, retargetStacked: noop, rebaseStacked: async () => {}, applyEdit: async () => {}, discardEdit: noop, stopWriterRun: noop, reviewNewHeads: noop,
    answer: (key: string, given: { answer: string; who?: string }) => lazy.pool!.answer(key, given) };
  const made = createBoard({ settings, source, codeHost: createFakeCodeHost(), key: KEY, queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json"), pool, now: () => 7 });
  lazy.pool = createSettledPool(made.store, { settings, source, codeHost: createFakeCodeHost(), hook: { node: "/node", bin: "/b" }, herdr: run, now: () => new Date(2026, 9, 25, 12).getTime(), wait: async () => {}, transcriptsRoot: dir });
  made.store.set({ ...enqueue(emptyQueue(1), [ticket("NBF-1", "Fix the toast.")], { model: "sonnet", effort: "high" }, 0),
    entries: [{ ...enqueue(emptyQueue(1), [ticket("NBF-1", "Fix the toast.")], { model: "sonnet", effort: "high" }, 0).entries[0], phase: "finished", workspace: "w1", pane: "w1:p1", outcome }] });
  const prompts = () => herdr.calls.filter((args) => args.includes("prompt"));
  return { ...made, held, refuse, prompts };
}

/** A board listening on a free port, for `run`, then closed. */
async function overHttp(run: (base: string, made: ReturnType<typeof parkedBoard>) => Promise<void>, outcome?: Outcome) {
  const port = await freePort();
  const made = parkedBoard(port, outcome);
  const server = createServer((req, res) => { void made.handle(req, res); });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  try {
    await run(`http://127.0.0.1:${port}`, made);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}
/** A POST with every header as given, `host` and `origin` included, which `fetch` does not let a caller set. */
const rawPost = (base: string, headers: Record<string, string>): Promise<number> => new Promise((resolve, reject) => {
  const url = new URL(`${base}/api/queue/NBF-1/answer`);
  const sent = request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json", ...headers } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
  sent.on("error", reject);
  sent.end(JSON.stringify({ answer: "Yes." }));
});
const post = (base: string, body: unknown, headers: Record<string, string> = { "x-ticket-token": KEY }) =>
  fetch(`${base}/api/queue/NBF-1/answer`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("A11-250: POST /api/queue/<KEY>/answer with the instance's key writes the answer into the ticket's Decisions, tells the run, and answers the queue with what happened", async () => {
  await overHttp(async (base, made) => {
    const response = await post(base, { answer: "Keep the current wording.", who: "the chairman" });
    assert.equal(response.status, 200);
    const body = await response.json() as { written: boolean; delivered: boolean; entries: { ticket: { key: string; description: string } }[] };
    assert.deepEqual([body.written, body.delivered], [true, true]);
    assert.equal(body.entries[0].ticket.key, "NBF-1", "the queue is the answer, as the other verbs give");
    assert.equal(made.held.description, `Fix the toast.\n\n## Decisions (the chairman, 2026-10-25)\n\n* **Question:** ${QUESTION}\n* **Answer:** Keep the current wording.\n`);
    assert.equal(made.prompts().length, 1);
    const own = await (await fetch(`${base}/api/queue/NBF-1`, { headers: { "x-ticket-token": KEY } })).json() as { entry: { ticket: { description: string } } };
    assert.equal(own.entry.ticket.description, made.held.description, "the run's copy of the ticket, which its own read sends, is the text written");
  });
});

test("A11-250: a request without the key, from another origin, or to another host writes nothing and tells no run", async () => {
  await overHttp(async (base, made) => {
    assert.equal((await post(base, { answer: "Yes." }, {})).status, 401);
    assert.equal((await post(base, { answer: "Yes." }, { "x-ticket-token": "b".repeat(48) })).status, 401);
    assert.equal(await rawPost(base, { "x-ticket-token": KEY, origin: "http://evil.example" }), 403);
    assert.equal(await rawPost(base, { "x-ticket-token": KEY, host: "evil.example" }), 403);
    assert.equal((await fetch(`${base}/api/queue/NBF-1/answer`, { headers: { "x-ticket-token": KEY } })).status, 404, "only a POST answers");
    assert.equal(made.held.description, "Fix the toast.");
    assert.equal(made.prompts().length, 0);
    assert.equal(await rawPost(base, { "x-ticket-token": KEY, origin: base }), 200, "POSITIVE CONTROL: the board's own origin, with the key, is taken");
    assert.equal(made.prompts().length, 1);
  });
});

test("A11-250: a body with no answer text, or a run that is not waiting, is a 400 with the reason, and nothing is written", async () => {
  await overHttp(async (base, made) => {
    for (const [body, reason] of [[{}, /answer must be the text/], [{ answer: 5 }, /answer must be the text/], [{ answer: "ok", who: 3 }, /who must be the name/], [{ answer: "   " }, /the answer is empty/]] as const) {
      const response = await post(base, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.match((await response.json() as { error: string }).error, reason);
    }
    assert.equal(made.held.description, "Fix the toast.");
  });
  await overHttp(async (base, made) => {
    const response = await post(base, { answer: "Yes." });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /NBF-1 is not waiting on a person: its run ended checked/);
    assert.equal(made.held.description, "Fix the toast.");
  }, { kind: "checked", reason: "nothing to change" });
});

test("A11-250: an answer herdr will not take is a 502 that says it is in the ticket, and sending it again does not write it twice", async () => {
  await overHttp(async (base, made) => {
    made.refuse.on = true;
    const refused = await post(base, { answer: "Keep it.", who: "the chairman" });
    assert.equal(refused.status, 502);
    const body = await refused.json() as { error: string; written: boolean; delivered: boolean };
    assert.match(body.error, /answer is in the ticket, but herdr would not take it to the run \(agent_blocked\)/);
    assert.deepEqual([body.written, body.delivered], [true, false]);
    made.refuse.on = false;
    assert.equal((await post(base, { answer: "Keep it.", who: "the chairman" })).status, 200);
    assert.equal(made.held.description.match(/\* \*\*Answer:\*\*/g)?.length, 1);
  });
});
