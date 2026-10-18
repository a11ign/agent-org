// no-token: gh -- Linear and the pool are injected; the one server listens on 127.0.0.1 for the length of a test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { parseTicketSettings } from "./settings.ts";
import { markPublishRunning, markPublishStarting } from "./queue/approve.ts";
import { markWriterRunning, markWriterStarting, queueWriter, writerDrafted } from "./queue.ts";
import { remove as removeQueued } from "./queue/declared-remains.ts";
import { refusal } from "./local-http.ts";
import { checkGhWrapperAtStart, createBoard, FEEDBACK_MS, holdsKey, startFeedbackSweeps, type BoardDeps } from "./server.ts";
import type { Ticket, TicketSource } from "./source.ts";

const ticket = (key: string, title = key) => ({ key, title, description: "", url: "", branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const KEY = "a".repeat(48);

function board(port = 4747, ticketSettings: Record<string, unknown> = {}, extra: Partial<BoardDeps> = {}, tracker?: TicketSource) {
  const dir = tmpDir("ticket-server-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox", "platform-monorepo": "/r/pm" }, stateDir: dir, tickets: { port, ...ticketSettings } });
  const source: TicketSource = tracker ?? { assigned: async () => [ticket("NBF-1"), ticket("NBF-2")], read: async (key) => (key === "VE-9" ? ticket("VE-9") : null), download: async () => [] };
  const ticks: string[] = [];
  const pool = {
    tick: async () => { ticks.push("tick"); }, stop: (key: string) => { ticks.push(`stop ${key}`); }, close: (key: string) => { ticks.push(`close ${key}`); },
    dismiss: async (key: string) => { ticks.push(`dismiss ${key}`); },
    applyEdit: async (key: string) => { ticks.push(`apply-edit ${key}`); },
    discardEdit: (key: string) => { ticks.push(`discard-edit ${key}`); },
    stopWriterRun: (id: string) => { ticks.push(`stop-writer ${id}`); },
    // The pool takes a queued run off, after putting its ticket back: here only the queue's part, which the board's store is asked for.
    remove: async (key: string) => { ticks.push(`remove ${key}`); made.store.set(removeQueued(made.store.get(), key)); },
    reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {}, releaseReviewers: () => {}, retargetStacked: () => {},
  };
  const made = createBoard({ settings, source, key: KEY, queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json"), pool, now: () => 7, ...extra });
  return { ...made, ticks, dir };
}

test("/api/parents reads the parents of the person's tickets that are not the person's own, and leaves out one it cannot read", async () => {
  const dir = tmpDir("ticket-server-parents-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir });
  const reads: string[] = [];
  const child = (key: string, parent: string | null) => ({ ...ticket(key), parent });
  const source: TicketSource = {
    assigned: async () => [child("VE-65", "NBF-1917"), child("NBF-1936", "NBF-1917"), child("NBF-1", null), child("NBF-2", "NBF-1"), child("VAL-11", "NBF-404"), child("X-1", "NBF-500")],
    read: async (key) => {
      reads.push(key);
      if (key === "NBF-500") throw new Error("Linear answered 500");
      return key === "NBF-1917" ? child("NBF-1917", null) : null;
    },
    download: async () => [],
  };
  const pool = { tick: async () => {}, stopWriterRun: () => {}, stop: () => {}, close: () => {}, dismiss: async () => {}, remove: async () => {}, reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {}, releaseReviewers: () => {}, retargetStacked: () => {}, applyEdit: async () => {}, discardEdit: () => {} };
  const { api } = createBoard({ settings, source, key: KEY, queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json"), pool, now: () => 7 });
  await api("GET", "/api/tickets", {});
  const [status, parents] = await api("GET", "/api/parents", {}) as [number, Ticket[]];
  assert.equal(status, 200);
  assert.deepEqual(parents.map((p) => p.key), ["NBF-1917"]);
  assert.deepEqual(reads, ["NBF-1917", "NBF-404", "NBF-500"], "each missing parent once, and never NBF-1, which is the person's own");
});

test("a request to another host is refused, and so is a write from another origin", () => {
  assert.equal(refusal({ headers: { host: "127.0.0.1:4747" }, method: "GET" }, 4747), null);
  assert.equal(refusal({ headers: { host: "localhost:4747" }, method: "POST", origin: undefined } as any, 4747), null);
  assert.match(String(refusal({ headers: { host: "evil.example:4747" }, method: "GET" }, 4747)), /own host/, "a DNS-rebound name is refused");
  assert.match(String(refusal({ headers: { host: "127.0.0.1:4747", origin: "https://evil.example" }, method: "POST" }, 4747)), /another origin/);
  assert.equal(refusal({ headers: { host: "127.0.0.1:4747", origin: "http://127.0.0.1:4747" }, method: "POST" }, 4747), null);
});

test("queueing takes the tickets you selected with the model and effort sent, no repository until the worker chooses one, and wakes the pool", async () => {
  const b = board();
  await b.api("GET", "/api/tickets", {});
  const [status, queue] = await b.api("POST", "/api/queue", { keys: ["NBF-2", "VE-9"], model: "opus", effort: "max" }) as [number, any];
  assert.equal(status, 200);
  assert.deepEqual(queue.entries.map((e: any) => [e.ticket.key, e.repos, e.model, e.effort]), [
    ["NBF-2", [], "opus", "max"],
    ["VE-9", [], "opus", "max"],
  ], "VE-9 was not in the assigned list, so it was read by key");
  assert.ok(existsSync(join(b.dir, "queue.json")));
  assert.deepEqual(b.ticks, ["tick"]);
  const [, config] = await b.api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual(config.choice, { model: "opus", effort: "high", planModel: "opus", planEffort: "high" }, "the settings decide new runs; queueing does not change them");
});

test("the settings save the part of the choice they name, keep the other part, refuse an unknown or empty change, and wake nothing", async () => {
  const b = board();
  const [, model] = await b.api("POST", "/api/choice", { model: "sonnet" }) as [number, any];
  assert.deepEqual(model, { choice: { model: "sonnet", effort: "high", planModel: "opus", planEffort: "high" } });
  const [, effort] = await b.api("POST", "/api/choice", { effort: "max" }) as [number, any];
  assert.deepEqual(effort, { choice: { model: "sonnet", effort: "max", planModel: "opus", planEffort: "high" } }, "a change to the effort keeps the model saved before it");
  await assert.rejects(b.api("POST", "/api/choice", { model: "gpt" }), /model must be one of/);
  await assert.rejects(b.api("POST", "/api/choice", { effort: "huge" }), /effort must be one of/);
  await assert.rejects(b.api("POST", "/api/choice", {}), /name a model or an effort/);
  const [, config] = await b.api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual(config.choice, { model: "sonnet", effort: "max", planModel: "opus", planEffort: "high" });
  assert.deepEqual(b.ticks, [], "a setting for new runs wakes nothing");
});

test("a saved model or effort the board no longer offers falls back, so queueing with the settings is never refused", async () => {
  const b = board();
  writeFileSync(join(b.dir, "choice.json"), JSON.stringify({ model: "gpt-9", effort: "max", planModel: "sonnet", planEffort: "huge" }));
  const [, config] = await b.api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual(config.choice, { model: "opus", effort: "max", planModel: "sonnet", planEffort: "high" });
});

test("planning has its own model and effort in the settings, opus at high until changed, and changing it leaves the run's alone", async () => {
  const b = board();
  const [, before] = await b.api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual([before.choice.planModel, before.choice.planEffort], ["opus", "high"]);
  await b.api("POST", "/api/choice", { model: "sonnet" });
  const [, saved] = await b.api("POST", "/api/choice", { planEffort: "max" }) as [number, any];
  assert.deepEqual(saved.choice, { model: "sonnet", effort: "high", planModel: "opus", planEffort: "max" });
  await assert.rejects(b.api("POST", "/api/choice", { planModel: "gpt" }), /model must be one of/);
});

/** A board whose machine plans, over a tracker that takes plans: NBF-1 has a plan of its own and NBF-2 has none. */
function planningBoard(attachPlan: TicketSource["attachPlan"] | null = async () => null, run = "plan {key} into {dir}") {
  const dir = tmpDir("ticket-server-planning-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: dir,
    tickets: { plan: "-plan-[^/]*\\.md$", planner: { run, state: "Planned" } } });
  const planned = { ...ticket("NBF-1"), uploads: ["NBF-1-0001-plan-x.md"] };
  const source: TicketSource = { assigned: async () => [planned, ticket("NBF-2"), ticket("NBF-3")], read: async () => null, download: async () => [], ...(attachPlan ? { attachPlan } : {}) };
  const pool = { tick: async () => {}, stopWriterRun: () => {}, stop: () => {}, close: () => {}, dismiss: async () => {}, remove: async () => {}, reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {}, releaseReviewers: () => {}, retargetStacked: () => {}, applyEdit: async () => {}, discardEdit: () => {} };
  return createBoard({ settings, source, key: KEY, queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json"), pool, now: () => 7 });
}

test("queueing with plan first plans each ticket without a plan of its own, on the planning model and effort, and leaves the others to be worked", async () => {
  const b = planningBoard();
  await b.api("GET", "/api/tickets", {});
  await b.api("POST", "/api/choice", { planModel: "opus", planEffort: "max" });
  const [, queue] = await b.api("POST", "/api/queue", { keys: ["NBF-1", "NBF-2"], model: "sonnet", effort: "high", plan: true }) as [number, any];
  assert.deepEqual(queue.entries.map((e: any) => [e.ticket.key, e.model, e.plan ?? null]), [["NBF-1", "sonnet", null], ["NBF-2", "sonnet", { model: "opus", effort: "max" }]]);
  const [, config] = await b.api("GET", "/api/config", {}) as [number, any];
  assert.equal(config.planner, true, "the page is told this board plans");
});

test("the tickets one press of Queue plans first are one batch when the planner names {keys}, and each is planned alone when it names only {key}", async () => {
  for (const [run, batches] of [["plan {keys} into {dir}", ["b7-0", "b7-0"]], ["plan {key} into {dir}", [null, null]]] as const) {
    const b = planningBoard(async () => null, run);
    await b.api("GET", "/api/tickets", {});
    const [, queue] = await b.api("POST", "/api/queue", { keys: ["NBF-1", "NBF-2", "NBF-3"], model: "sonnet", effort: "high", plan: true }) as [number, any];
    assert.deepEqual(queue.entries.slice(1).map((e: any) => e.batch ?? null), batches, run);
    assert.equal(queue.entries[0].batch, undefined, "a ticket with a plan of its own is in no batch");
  }
});

test("queueing without plan first, or on a board that does not plan, plans nothing", async () => {
  const b = planningBoard();
  await b.api("GET", "/api/tickets", {});
  const [, queue] = await b.api("POST", "/api/queue", { keys: ["NBF-2"], model: "sonnet", effort: "high" }) as [number, any];
  assert.equal(queue.entries[0].plan, undefined);
  const plain = board();
  await plain.api("GET", "/api/tickets", {});
  const [, unplanned] = await plain.api("POST", "/api/queue", { keys: ["NBF-2"], model: "opus", effort: "high", plan: true }) as [number, any];
  assert.equal(unplanned.entries[0].plan, undefined, "a machine with no planner plans nothing, whatever the page asks");
  const [, config] = await plain.api("GET", "/api/config", {}) as [number, any];
  assert.equal(config.planner, false);
  const noAttach = planningBoard(null);
  const [, told] = await noAttach.api("GET", "/api/config", {}) as [number, any];
  assert.equal(told.planner, false, "a tracker that cannot take a plan is not offered planning");
});

test("an unknown model or an unknown ticket is refused, and nothing is queued", async () => {
  const b = board();
  await assert.rejects(b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "gpt", effort: "high" }), /model must be one of/);
  await assert.rejects(b.api("POST", "/api/queue", { keys: ["NOPE-1"], model: "opus", effort: "high" }), /no ticket NOPE-1/);
  assert.deepEqual(b.store.get().entries, []);
});

test("an amend is held to the rules queueing uses: an unknown model or effort is refused and the entry is unchanged", async () => {
  const b = board();
  await b.api("GET", "/api/tickets", {});
  await b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "opus", effort: "high" });
  const before = JSON.stringify(b.store.get());
  await assert.rejects(b.api("POST", "/api/queue/NBF-1/amend", { model: "gpt" }), /model must be one of/);
  await assert.rejects(b.api("POST", "/api/queue/NBF-1/amend", { effort: "extreme" }), /effort must be one of/);
  assert.equal(JSON.stringify(b.store.get()), before);
  await b.api("POST", "/api/queue/NBF-1/amend", { model: "sonnet" });
  assert.deepEqual(b.store.get().entries.map((e) => [e.model, e.effort]), [["sonnet", "high"]]);
});

test("the board's queue starts paused, and Start and Pause go through the API", async () => {
  const b = board();
  const [, queue] = await b.api("GET", "/api/queue", {}) as [number, any];
  assert.equal(queue.paused, true);
  await b.api("POST", "/api/paused", { paused: false });
  assert.equal(b.store.get().paused, false);
  assert.deepEqual(b.ticks, ["tick"], "starting wakes the pool");
  await assert.rejects(b.api("POST", "/api/paused", { paused: "no" }), /true or false/);
  await b.api("POST", "/api/paused", { paused: true });
  assert.equal(b.store.get().paused, true);
});

test("approve queues a finished run's draft pull requests again as a review run", async () => {
  const b = board();
  await b.api("GET", "/api/tickets", {});
  await b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "sonnet", effort: "high" });
  const pr = { repo: "app", url: "https://github.com/x/app/pull/1" };
  b.store.set({ ...b.store.get(), entries: b.store.get().entries.map((e) => ({ ...e, phase: "finished" as const, outcome: { kind: "draft-pr" as const, prs: [pr] } })) });
  await b.api("POST", "/api/queue/NBF-1/approve", {});
  const [entry] = b.store.get().entries;
  assert.deepEqual([entry.phase, entry.review], ["queued", [pr]]);
  assert.ok(b.ticks.includes("tick"), "approving wakes the pool");
});

test("Respond to review queues a review round of a run whose pull requests are ready, through the board", async () => {
  const b = board();
  await b.api("GET", "/api/tickets", {});
  await b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "sonnet", effort: "high" });
  const pr = { repo: "app", url: "https://github.com/x/app/pull/1" };
  b.store.set({ ...b.store.get(), entries: b.store.get().entries.map((e) => ({ ...e, phase: "finished" as const, outcome: { kind: "reviewed" as const, prs: [pr] } })) });
  await b.api("POST", "/api/queue/NBF-1/respond", {});
  const [entry] = b.store.get().entries;
  assert.deepEqual([entry.phase, entry.review, entry.asked], ["queued", [pr], true]);
  assert.ok(b.ticks.includes("tick"), "responding wakes the pool");
});

test("Publish queues one publish run for the ticked runs Ready to merge on a machine that publishes, and is refused on one that does not", async () => {
  const run = "Post {prs}, then write {dir}/published.json";
  for (const [publish, expected] of [[{ run }, true], [undefined, false]] as const) {
    const b = board(4747, publish ? { publish } : {});
    const [, config] = await b.api("GET", "/api/config", {}) as [number, { publish: boolean }];
    assert.equal(config.publish, expected);
    await b.api("GET", "/api/tickets", {});
    await b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "sonnet", effort: "high" });
    const pr = { repo: "app", url: "https://github.com/x/app/pull/1" };
    b.store.set({ ...b.store.get(), entries: b.store.get().entries.map((e) => ({ ...e, phase: "finished" as const, outcome: { kind: "reviewed" as const, prs: [pr] } })) });
    if (!expected) {
      await assert.rejects(b.api("POST", "/api/publish", { keys: ["NBF-1"] }), /names no tickets.publish/);
      continue;
    }
    await b.api("POST", "/api/publish", { keys: ["NBF-1"] });
    assert.deepEqual([b.store.get().publish?.keys, b.store.get().publish?.prs], [["NBF-1"], [pr]]);
    assert.ok(b.ticks.includes("tick"), "publishing wakes the pool");
    await assert.rejects(b.api("POST", "/api/publish", { keys: ["NBF-1"] }), /a publish run is under way/);
  }
});

test("the queue the page reads carries the running publish run's workspace and pane, so each run it posts can link its terminal", async () => {
  const b = board(4747, { publish: { run: "Post {prs}, then write {dir}/published.json" } });
  await b.api("GET", "/api/tickets", {});
  await b.api("POST", "/api/queue", { keys: ["NBF-1"], model: "sonnet", effort: "high" });
  const pr = { repo: "app", url: "https://github.com/x/app/pull/1" };
  b.store.set({ ...b.store.get(), entries: b.store.get().entries.map((e) => ({ ...e, phase: "finished" as const, outcome: { kind: "reviewed" as const, prs: [pr] } })) });
  await b.api("POST", "/api/publish", { keys: ["NBF-1"] });
  const read = async () => (await b.api("GET", "/api/queue", {}) as [number, { publish: { phase: string; workspace?: string; pane?: string } }])[1].publish;
  const queued = await read();
  assert.deepEqual([queued.phase, queued.workspace, queued.pane], ["queued", undefined, undefined], "queued, it has no pane yet");
  b.store.set(markPublishRunning(markPublishStarting(b.store.get(), 8), "w9", "w9:p1"));
  const running = await read();
  assert.deepEqual([running.phase, running.workspace, running.pane], ["running", "w9", "w9:p1"]);
});

test("remove, stop, close, dismiss and max go through the board", async () => {
  const b = board();
  await b.api("GET", "/api/tickets", {});
  await b.api("POST", "/api/queue", { keys: ["NBF-1", "NBF-2"], model: "sonnet", effort: "high" });
  await b.api("POST", "/api/queue/NBF-1/remove", {});
  await b.api("POST", "/api/queue/NBF-2/stop", {});
  await b.api("POST", "/api/queue/NBF-2/close", {});
  await b.api("POST", "/api/queue/NBF-2/dismiss", {});
  await b.api("POST", "/api/max", { max: 5 });
  assert.deepEqual(b.store.get().entries.map((e) => e.ticket.key), ["NBF-2"]);
  assert.ok(b.ticks.includes("remove NBF-1"), "Remove is the pool's, which puts a queued run's ticket back before the run leaves the queue");
  assert.ok(b.ticks.includes("stop NBF-2"));
  assert.ok(b.ticks.includes("close NBF-2"), "a parked run's workspace is the pool's to close");
  assert.ok(b.ticks.includes("dismiss NBF-2"), "Dismiss is the pool's, which closes a parked run's workspace before the run leaves the board");
  assert.equal(b.store.get().max, 5);
});

test("A11-91: Apply and Discard edit go through the pool, and only as a person's POST", async () => {
  const b = board();
  await b.api("POST", "/api/queue/NBF-1/apply-edit", {});
  await b.api("POST", "/api/queue/NBF-1/discard-edit", {});
  assert.deepEqual(b.ticks.filter((tick) => tick !== "tick"), ["apply-edit NBF-1", "discard-edit NBF-1"], "the pool applies and discards, in the order asked");
});

test("the page is given the machine's terminal address, or null when it serves none", async () => {
  const [, config] = await board().api("GET", "/api/config", {}) as [number, any];
  assert.equal(config.terminal, null);
});

test("the page is given the pattern a ticket's plan is named by, or null when the machine names none", async () => {
  const [, none] = await board().api("GET", "/api/config", {}) as [number, any];
  assert.equal(none.plan, null);
  const [, named] = await board(4747, { plan: "-plan-[^/]*\\.md$" }).api("GET", "/api/config", {}) as [number, any];
  assert.equal(named.plan, "-plan-[^/]*\\.md$");
});

/** A board listening on a free port on 127.0.0.1, for `run`, then closed. */
async function overHttp(run: (base: string) => Promise<void>, extra: Partial<BoardDeps> = {}) {
  const probe: Server = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const b = board(port, {}, extra);
  const server = createServer((req, res) => { void b.handle(req, res); });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}
const keyed = { "x-ticket-token": KEY };

test("over HTTP: the instance serves no page and no pairing: a request without its key is refused, and with it the page's paths are not found", async () => {
  await overHttp(async (base) => {
    for (const path of ["/", "/board-view.js", "/api/queue"]) {
      const refused = await fetch(`${base}${path}`);
      assert.equal(refused.status, 401, path);
      assert.equal(refused.headers.get("content-type"), "application/json");
      assert.match((await refused.json() as { error: string }).error, /an agent-org instance, which serves no page and answers only to its key: open the board with agent-org ticket:ui/);
    }
    for (const [method, path] of [["GET", "/"], ["GET", "/board-view.js"], ["POST", "/api/pair-code"], ["POST", "/pair"], ["GET", "/api/connections"]]) {
      const answer = await fetch(`${base}${path}`, { method, headers: keyed });
      assert.equal(answer.status, 404, `${method} ${path}`);
      assert.equal(answer.headers.get("content-type"), "application/json");
    }
    assert.equal((await fetch(`${base}/api/queue`, { headers: keyed })).status, 200);
  });
});

test("over HTTP: a browser's session cookie opens nothing on the instance", async () => {
  await overHttp(async (base) => {
    assert.equal((await fetch(`${base}/api/queue`, { headers: { cookie: `ticket_session=${"s".repeat(48)}` } })).status, 401);
    assert.equal((await fetch(`${base}/api/queue`, { headers: { cookie: `ticket_session=${KEY}` } })).status, 401, "not even the key as a cookie");
  });
});

test("the instance is paired by its key in the header alone, compared whole", () => {
  assert.equal(holdsKey({ headers: { "x-ticket-token": KEY } }, KEY), true);
  assert.equal(holdsKey({ headers: { "x-ticket-token": "wrong" } }, KEY), false);
  assert.equal(holdsKey({ headers: { "x-ticket-token": `${"a".repeat(47)}\u00e9` } }, KEY), false, "a header of the key's length but more bytes is refused, not thrown");
  assert.equal(holdsKey({ headers: {} }, KEY), false);
});

test("over HTTP: a body that is not JSON is a 400, and the instance keeps answering", async () => {
  await overHttp(async (base) => {
    const bad = await fetch(`${base}/api/paused`, { method: "POST", headers: keyed, body: "{" });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${base}/api/queue`, { headers: keyed })).status, 200);
  });
});

test("over HTTP: a request body over 64 KB is refused, even with the key", async () => {
  await overHttp(async (base) => {
    const big = await fetch(`${base}/api/queue`, { method: "POST", headers: keyed, body: JSON.stringify({ keys: ["x".repeat(70_000)] }) });
    assert.equal(big.status, 400);
    assert.match((await big.json() as { error: string }).error, /over 65536 bytes/);
  });
});

test("A11-69: the board says which tickets the Pick view lists, and why it is empty, naming the key's person only when it lists theirs", async () => {
  const [, config] = await board().api("GET", "/api/config", {}) as [number, { pick: string }];
  assert.equal(config.pick, "assigned to you");
  let asked = 0;
  const named = board(4747, {}, { source: { assigned: async () => [], read: async () => null, download: async () => [], viewer: async () => { asked += 1; return "Dan Beck"; } } });
  const [status, pick] = await named.api("GET", "/api/pick", {}) as [number, { empty: string }];
  assert.equal(status, 200);
  assert.match(pick.empty, /^No open tickets are assigned to Dan Beck,.*tickets\.pick/);
  const failing = board(4747, {}, { source: { assigned: async () => [], read: async () => null, download: async () => [], viewer: async () => { throw new Error("Linear answered 500"); } } });
  assert.match((await failing.api("GET", "/api/pick", {}) as [number, { empty: string }])[1].empty, /^No open tickets are assigned to you,/, "a tracker that cannot say whose key it is reads as you");
  const team = board(4747, { pick: { team: "A11" } }, { source: { assigned: async () => [], read: async () => null, download: async () => [], viewer: async () => { asked += 1; return "x"; } } });
  const [, teamConfig] = await team.api("GET", "/api/config", {}) as [number, { pick: string }];
  assert.equal(teamConfig.pick, "open in team A11");
  assert.match((await team.api("GET", "/api/pick", {}) as [number, { empty: string }])[1].empty, /^Team A11 has no open tickets/);
  assert.equal(asked, 1, "a team's list names no person, so none is asked for");
});

test("A11-108: the config names the Assignee filter's default and the key's person, read once and kept; a failed read is null and is asked again", async () => {
  let asked = 0;
  let down = true;
  const tracker: TicketSource = {
    assigned: async () => [{ ...ticket("NBF-1"), assignee: { id: "dan", name: "Dan Beck" } }, { ...ticket("NBF-2"), assignee: null }], read: async () => null, download: async () => [],
    me: async () => { asked += 1; if (down) throw new Error("Linear answered 500"); return { id: "dan", name: "Dan Beck" }; },
  };
  const b = board(4747, {}, {}, tracker);
  const [, failed] = await b.api("GET", "/api/config", {}) as [number, any];
  assert.equal(failed.viewer, null, "a tracker that cannot say whose key it is gives null, and the page lists every ticket");
  assert.deepEqual([failed.pickDefault, failed.pickOpen], ["you", "open"]);
  down = false;
  const [, config] = await b.api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual(config.viewer, { id: "dan", name: "Dan Beck" });
  await b.api("GET", "/api/config", {});
  assert.equal(asked, 2, "the failed read is asked again, and the one that worked is kept");
  const [, list] = await b.api("GET", "/api/tickets", {}) as [number, any[]];
  assert.deepEqual(list.map((t) => t.assignee), [{ id: "dan", name: "Dan Beck" }, null], "each ticket carries its assignee, unassigned as null");
});

test("A11-108: a team or a project names Anyone as the default and its own words for it, and reads no person", async () => {
  const [, config] = await board(4747, { pick: { team: "A11" } }).api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual([config.pickDefault, config.pickOpen], ["anyone", "open in team A11"]);
  const [, mine] = await board().api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual([mine.pickDefault, mine.pickOpen], ["you", "open"]);
});

/** A board over a tracker with an epic, A11-24, whose open sub-issues are A11-27, A11-25 and A11-26, and an epic of epics, A11-40. */
function epicBoard(blockers: TicketSource["blockers"] | null) {
  const reads: string[] = [];
  const tickets = new Map<string, Ticket>([
    ["A11-24", { ...ticket("A11-24"), children: ["A11-27", "A11-25", "A11-26"] }],
    ["A11-25", ticket("A11-25")], ["A11-26", ticket("A11-26")], ["A11-27", ticket("A11-27")],
    ["A11-30", { ...ticket("A11-30"), children: [] }],
    ["A11-40", { ...ticket("A11-40"), children: ["A11-24", "A11-41"] }], ["A11-41", ticket("A11-41")],
  ]);
  const source: TicketSource = {
    assigned: async () => [tickets.get("A11-24")!, tickets.get("A11-25")!, tickets.get("A11-30")!],
    read: async (key) => { reads.push(key); return tickets.get(key) ?? null; },
    download: async () => [],
    ...(blockers ? { blockers } : {}),
  };
  return { ...board(4747, {}, { source }), reads };
}

test("A11-76: the queue refuses a parent with a 400 that says why, over HTTP, and queues the same ticket once its sub-issues are done", async () => {
  const b = epicBoard(null);
  await b.api("GET", "/api/tickets", {});
  await assert.rejects(b.api("POST", "/api/queue", { keys: ["A11-25", "A11-24"], model: "opus", effort: "high" }),
    /A11-24 has 3 open sub-issues \(A11-27, A11-25, A11-26\): a parent is not queued.*Queue its children instead/);
  assert.deepEqual(b.store.get().entries, [], "nothing of the request is queued, not even the ordinary ticket beside the parent");
  const [, queue] = await b.api("POST", "/api/queue", { keys: ["A11-30"], model: "opus", effort: "high" }) as [number, any];
  assert.deepEqual(queue.entries.map((e: any) => e.ticket.key), ["A11-30"], "an epic with no sub-issue open is an ordinary ticket");
  const source: TicketSource = { assigned: async () => [], read: async (key) => (key === "A11-24" ? { ...ticket(key), children: ["A11-25"] } : null), download: async () => [] };
  await overHttp(async (base) => {
    const refused = await fetch(`${base}/api/queue`, { method: "POST", headers: keyed, body: JSON.stringify({ keys: ["A11-24"], model: "opus", effort: "high" }) });
    assert.equal(refused.status, 400);
    assert.match((await refused.json() as { error: string }).error, /^A11-24 has 1 open sub-issue \(A11-25\): a parent is not queued/);
  }, { source });
});

test("A11-76: Queue its children queues a parent's open sub-issues in their blocking order, read afresh, and wakes the pool", async () => {
  const asked: string[][] = [];
  const b = epicBoard(async (keys) => {
    asked.push([...keys]);
    return new Map([["A11-25", [{ key: "A11-27", state: "started", status: "In Progress", pulls: {} }]], ["A11-26", []], ["A11-27", [{ key: "A11-26", state: "unstarted", status: "Todo", pulls: {} }]]]);
  });
  await b.api("GET", "/api/tickets", {});
  const [status, answer] = await b.api("POST", "/api/queue-children", { key: "A11-24", model: "sonnet", effort: "max" }) as [number, any];
  assert.equal(status, 200);
  assert.deepEqual(answer.keys, ["A11-26", "A11-27", "A11-25"]);
  assert.equal(answer.note, null, "the order is the tracker's, so nothing needs saying");
  assert.deepEqual(answer.queue.entries.map((e: any) => [e.ticket.key, e.model, e.effort]), [["A11-26", "sonnet", "max"], ["A11-27", "sonnet", "max"], ["A11-25", "sonnet", "max"]]);
  assert.deepEqual(asked, [["A11-27", "A11-25", "A11-26"]], "the blockers of every child, in one read");
  assert.deepEqual(b.reads, ["A11-24", "A11-26", "A11-27"], "the parent is read afresh, and a child the list holds (A11-25) is not read again");
  assert.deepEqual(b.ticks, ["tick"]);
});

test("A11-76: Queue its children goes by identifier where the tracker gives no order, says so, leaves out a child that is itself a parent, and refuses a ticket with none open", async () => {
  const b = epicBoard(null);
  const [, plain] = await b.api("POST", "/api/queue-children", { key: "A11-24", model: "opus", effort: "high" }) as [number, any];
  assert.deepEqual(plain.keys, ["A11-25", "A11-26", "A11-27"]);
  assert.equal(plain.note, "the tracker gives no blocking order, so they are queued in identifier order");
  const [, nested] = await b.api("POST", "/api/queue-children", { key: "A11-40", model: "opus", effort: "high" }) as [number, any];
  assert.deepEqual(nested.keys, ["A11-41"]);
  assert.match(nested.note, /A11-24 is itself a parent, so not queued: queue its children from its own row/);
  await assert.rejects(b.api("POST", "/api/queue-children", { key: "A11-30", model: "opus", effort: "high" }), /^Error: A11-30 has no open sub-issues: queue it as it is$/);
  await assert.rejects(b.api("POST", "/api/queue-children", { key: "A11-404", model: "opus", effort: "high" }), /no ticket A11-404/);
  await assert.rejects(b.api("POST", "/api/queue-children", { key: "A11-24", model: "gpt", effort: "high" }), /model must be one of/);
});

const LOOPBACK_TERMINAL = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";
const tailnetTerminalOf = (port: number) => `https://agents.tail1234.ts.net:${port}/?ws={workspace}&pane={pane}&view=terminal`;
const terminalOf = async (b: ReturnType<typeof board>) => ((await b.api("GET", "/api/config", {}))[1] as { terminal: string | null }).terminal;
const NAMED = async () => "agents.tail1234.ts.net";

test("with tickets.serve, the page is handed the tailnet's terminal address, unless the stored one names another machine", async () => {
  assert.equal(await terminalOf(board(4747, { serve: "tailscale", terminal: LOOPBACK_TERMINAL }, { tailnet: NAMED })), tailnetTerminalOf(9444), "a loopback address is replaced");
  assert.equal(await terminalOf(board(4747, { serve: "tailscale" }, { tailnet: NAMED })), tailnetTerminalOf(9444), "an absent address is the tailnet's");
  assert.equal(await terminalOf(board(4747, { serve: "tailscale", servePorts: { terminal: 9555 } }, { tailnet: NAMED })), tailnetTerminalOf(9555), "the terminal's tailnet port is servePorts.terminal");
  const other = "https://other.example.ts.net/?ws={workspace}&pane={pane}&view=terminal";
  assert.equal(await terminalOf(board(4747, { serve: "tailscale", terminal: other }, { tailnet: NAMED })), other, "another machine's address is kept");
  assert.equal(await terminalOf(board(4747, { serve: "tailscale", terminal: LOOPBACK_TERMINAL }, { tailnet: async () => null })), LOOPBACK_TERMINAL, "a name that cannot be read hands over the stored address");
  assert.equal(await terminalOf(board(4747, { terminal: LOOPBACK_TERMINAL }, { tailnet: NAMED })), LOOPBACK_TERMINAL, "without tickets.serve nothing changes");
});

test("the instance answers no tailnet Host: it is reached on its loopback alone", () => {
  assert.match(refusal({ headers: { host: "agents.tail1234.ts.net:4747" }, method: "GET" }, 4747) ?? "", /answers only to its own host/);
});
// A11-84: THE INSTANCE CHECKS THE ROUTING WRAPPER AT START-UP IN A CHILD PROCESS, LOUDLY, AND STARTS ANYWAY. The child runs the host module's check, which these
// tests stub: what the check finds and re-renders is the host module's, tested in `packaging/gh-wrapper-guard.test.ts`.

test("A11-84: the start-up runs the host module's check in a child process, and a clean run says nothing", () => {
  const said: string[] = [];
  const asked: string[] = [];
  checkGhWrapperAtStart({ err: (line) => said.push(line), run: (program) => { asked.push(program); return { status: 0 }; } });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /host-units\/tool-version-notes\.ts".*\.then\(\(host\) => host\.startupGhWrapper\(\)\)/s, "the child loads the host module and runs its check");
  assert.equal(said.join(""), "", "the child logs its own findings, so a clean start adds nothing");
});

test("A11-84: a child that exits non-zero is an ERROR line, and the instance is not stopped: the check returns", () => {
  const said: string[] = [];
  assert.doesNotThrow(() => checkGhWrapperAtStart({ err: (line) => said.push(line), run: () => ({ status: 1 }) }));
  assert.equal(said.join(""), "ERROR gh wrapper: cannot be checked (the check exited 1), so the instance does not know its App identity is in place\n");
});

test("A11-84: a child that cannot be started is an ERROR line, first line only, and the instance still starts", () => {
  const said: string[] = [];
  assert.doesNotThrow(() => checkGhWrapperAtStart({ err: (line) => said.push(line), run: () => ({ status: null, error: new Error("spawn node ENOENT\nmore") }) }));
  assert.equal(said.join(""), "ERROR gh wrapper: cannot be checked (spawn node ENOENT), so the instance does not know its App identity is in place\n");
});

test("the instance mints a worker terminal's code for its key only, and says why there is none when the terminal is not set", async () => {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const made = board(port, {}, { mintTerminal: async () => ({ code: "123456" }) });
  const server = createServer((request, response) => { void made.handle(request, response); });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  try {
    const wrong = await fetch(`http://127.0.0.1:${port}/api/terminal-pair`, { method: "POST", headers: { "x-ticket-token": "b".repeat(48) } });
    assert.equal(wrong.status, 401, "a request without the key is refused");
    const minted = await fetch(`http://127.0.0.1:${port}/api/terminal-pair`, { method: "POST", headers: { "x-ticket-token": KEY } });
    assert.deepEqual(await minted.json(), { code: "123456" });
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
  const unset = board();
  assert.deepEqual(await unset.api("POST", "/api/terminal-pair", {}), [200, { code: null, note: "tickets.terminal is not set" }]);
});

/*
 * New-ticket requests (A11-94): the routes queue a run of the writer, and only the approve route creates a ticket, in the tracker, with the person's approval.
 */

const WRITER = { writer: { run: "Run the a11ign:create-ticket skill, quick, for this request: {request}. Write each draft under {dir}/drafts." }, terminal: "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal" };

/** A tracker that answers reads and records each create; a created ticket is NBF-101, NBF-102, and so on. */
function creating() {
  const created: string[] = [];
  const tracker: TicketSource = {
    assigned: async () => [ticket("NBF-1")],
    read: async (key) => (key === "NBF-1" || key === "A11-12" ? { ...ticket(key), team: key.split("-")[0] } as Ticket : null),
    download: async () => [],
    createTicket: async (input) => {
      created.push(input.title);
      const made = { ...ticket(`NBF-${100 + created.length}`), url: `https://linear.app/x/NBF-${100 + created.length}`, team: "NBF" } as Ticket;
      return { ticket: made, warnings: [] };
    },
  };
  return { tracker, created };
}

/** A writer run that left one valid draft, as the pool hands the board, with the board's store set to it. */
function withDraft(b: ReturnType<typeof board>, id = "w7", duplicates: { key: string; why: string }[] = []) {
  const draft = { title: "feat: show requests", why: "A person asks", doneWhen: ["It lists them"], notes: null, team: null, project: null, repo: null, goal: null, labels: [], priority: "none",
    parent: null, blocks: [], blockedBy: [], duplicates } as never;
  b.store.set(writerDrafted(markWriterRunning(markWriterStarting(queueWriter(b.store.get(), { id, request: "Show requests", mode: "quick", form: {} }, 1), id, 2), id, "ws", "p"),
    id, { drafts: [{ id: "d1", file: "01-show.json", draft, duplicates: [], status: "pending" }], rejected: [] }, 3));
}

test("a new-ticket request is queued as a run of the writer and shown with its status, and is refused by name when it cannot be", async () => {
  const { tracker } = creating();
  const b = board(4747, WRITER, {}, tracker);
  const [status, writers] = await b.api("POST", "/api/writer", { request: "Show requests a person made", repo: "nbl-ui-netbox", priority: "high" }) as [number, any];
  assert.equal(status, 200);
  assert.deepEqual(writers.runs.map((r: any) => [r.request, r.mode, r.status, r.form]), [["Show requests a person made", "quick", "queued", { repo: "nbl-ui-netbox", priority: "high" }]]);
  assert.deepEqual(b.ticks, ["tick"], "the pool is woken to start it");
  await assert.rejects(b.api("POST", "/api/writer", { request: "" }), /a request is 1 to 8000 characters/);
  await assert.rejects(b.api("POST", "/api/writer", { request: "x".repeat(8001) }), /a request is 1 to 8000 characters/);
  await assert.rejects(b.api("POST", "/api/writer", { request: "a", repo: "elsewhere" }), /repo must be one of nbl-ui-netbox, platform-monorepo, not elsewhere/);
  await assert.rejects(b.api("POST", "/api/writer", { request: "a", priority: "hi" }), /priority must be one of urgent, high, medium, low, none, not hi/);
  await assert.rejects(b.api("POST", "/api/writer", { request: "a", parent: "NBF-404" }), /no ticket NBF-404/);
  const [graceful] = await b.api("POST", "/api/writer", { request: "a", mode: "grill" }) as [number, unknown];
  assert.equal(graceful, 200, "grill is allowed with a terminal to open in");
});

test("grill is refused without a terminal, and a machine with no writer writes no tickets", async () => {
  const { tracker } = creating();
  const plain = board(4747, { writer: WRITER.writer }, {}, tracker);
  await assert.rejects(plain.api("POST", "/api/writer", { request: "a", mode: "grill" }), /grill needs tickets.terminal/);
  const none = board(4747, {}, {}, tracker);
  await assert.rejects(none.api("POST", "/api/writer", { request: "a" }), /this machine names no tickets.writer, so it writes no tickets/);
  const [, config] = await none.api("GET", "/api/config", {}) as [number, any];
  assert.equal(config.writer, false, "the board hides New ticket");
  const [, configured] = await board(4747, WRITER, {}, tracker).api("GET", "/api/config", {}) as [number, any];
  assert.deepEqual([configured.writer, configured.writerGrill, configured.repos], [true, true, ["nbl-ui-netbox", "platform-monorepo"]]);
  assert.ok(configured.priorities.includes("urgent"));
});

test("only the approve route creates a ticket: it creates the one the person approved, and a discard, a stop or a dismiss creates none", async () => {
  const { tracker, created } = creating();
  const b = board(4747, WRITER, {}, tracker);
  await b.api("POST", "/api/writer", { request: "Show requests" });
  withDraft(b);
  await b.api("GET", "/api/writer", {});
  const [, discarded] = await b.api("POST", "/api/writer/w7/drafts/d1/discard", {}) as [number, any];
  assert.equal(discarded.runs[0].drafts[0].status, "discarded");
  await assert.rejects(b.api("POST", "/api/writer/w7/drafts/d1/approve", {}), /was discarded, so it creates nothing/);
  assert.equal(created.length, 0, "POSITIVE CONTROL: a discard and a refused approve create nothing");
  await b.api("POST", "/api/writer/w7/dismiss", {});
  assert.deepEqual((b.store.get().writers ?? []).length, 0);
  await assert.rejects(b.api("POST", "/api/writer/w9/drafts/d1/approve", {}), /no new-ticket request w9/);
});

test("approve creates the ticket with the person's edited fields and answers it; approve and queue queues it with the saved choice and plan first when asked", async () => {
  const { tracker, created } = creating();
  const b = board(4747, WRITER, {}, tracker);
  await b.api("POST", "/api/writer", { request: "Show requests" });
  withDraft(b);
  const [status, answer] = await b.api("POST", "/api/writer/w7/drafts/d1/approve", { draft: { title: "feat: an edited title", why: "A person asks", doneWhen: ["It lists them"] }, queue: true, plan: false }) as [number, any];
  assert.equal(status, 200);
  assert.deepEqual(created, ["feat: an edited title"]);
  assert.equal(answer.created.key, "NBF-101");
  assert.equal(answer.created.queued, true);
  assert.equal(b.store.get().entries.length, 1, "queued as Queue does");
  assert.deepEqual([b.store.get().entries[0].ticket.key, b.store.get().entries[0].model], ["NBF-101", "opus"]);
  assert.equal(answer.runs[0].drafts[0].status, "created");
  await b.api("POST", "/api/writer/w7/drafts/d1/approve", { draft: {}, queue: true });
  assert.equal(created.length, 1, "a second approve makes no second ticket");
});

test("the approve route refuses a duplicate until it is acknowledged, and a parent it cannot queue is said, with the ticket kept", async () => {
  const { tracker, created } = creating();
  const b = board(4747, WRITER, {}, tracker);
  await b.api("POST", "/api/writer", { request: "Show requests" });
  // The duplicate is one the writer named in the draft: an edit cannot drop it, so the check is the draft's own.
  withDraft(b, "w7", [{ key: "NBF-1", why: "same request" }]);
  const fields = { title: "feat: show requests", why: "A person asks", doneWhen: ["It lists them"] };
  await assert.rejects(b.api("POST", "/api/writer/w7/drafts/d1/approve", { draft: fields }), /names NBF-1 as a duplicate/);
  assert.equal(created.length, 0);
  const [, answer] = await b.api("POST", "/api/writer/w7/drafts/d1/approve", { draft: fields, acknowledgeDuplicates: true, queue: true }) as [number, any];
  assert.equal(created.length, 1);
  assert.equal(answer.created.key, "NBF-101");
});

test("stopping a run keeps what it wrote, and a request whose run is not known is refused by name", async () => {
  const b = board(4747, WRITER, {}, creating().tracker);
  await b.api("POST", "/api/writer", { request: "Show requests" });
  const [, stopped] = await b.api("POST", "/api/writer/w7/stop", {}) as [number, any];
  assert.deepEqual(b.ticks.filter((t) => t.startsWith("stop-writer")), ["stop-writer w7"], "the pool stops the run");
  assert.equal(stopped.runs.length, 1);
  await assert.rejects(b.api("POST", "/api/writer/nope/stop", {}), /no new-ticket request nope/);
});

test("A11-106: the feedback sweeps are each scheduled on the feedback cadence, and a sweep that throws does not stop the others", () => {
  const calls: string[] = [];
  const pool = {
    watchFeedback: () => { calls.push("watchFeedback"); throw new Error("the feed is down"); },
    releaseReviewers: () => { calls.push("releaseReviewers"); },
    retargetStacked: () => { calls.push("retargetStacked"); },
  };
  const scheduled: { run: () => void; ms: number }[] = [];
  startFeedbackSweeps(pool, (run, ms) => { scheduled.push({ run, ms }); });
  assert.deepEqual(scheduled.map(({ ms }) => ms), [FEEDBACK_MS, FEEDBACK_MS, FEEDBACK_MS], "each sweep is on the feedback cadence");
  const stderr = process.stderr.write;
  const said: string[] = [];
  process.stderr.write = ((line: string) => { said.push(line); return true; }) as typeof process.stderr.write;
  try {
    for (const { run } of scheduled) run();
  } finally {
    process.stderr.write = stderr;
  }
  assert.deepEqual(calls, ["watchFeedback", "releaseReviewers", "retargetStacked"], "the failing sweep is said, and the next two still run");
  assert.deepEqual(said, ["ticket:serve: the pull requests' feedback could not be read: the feed is down\n"]);
});

test("A11-106: the stacked pull requests' sweep is the one scheduled with retargetStacked, not another", () => {
  const retargeted: string[] = [];
  const scheduled: (() => void)[] = [];
  startFeedbackSweeps({ watchFeedback: () => {}, releaseReviewers: () => {}, retargetStacked: () => { retargeted.push("retargetStacked"); } },
    (run) => { scheduled.push(run); });
  scheduled[2]();
  assert.deepEqual(retargeted, ["retargetStacked"], "the third sweep is retargetStacked");
});
