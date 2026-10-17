// no-token: gh -- Linear and the pool are injected; the one server listens on 127.0.0.1 for the length of a test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { parseTicketSettings } from "./settings.ts";
import { markPublishRunning, markPublishStarting, remove as removeQueued } from "./queue.ts";
import { refusal } from "./local-http.ts";
import { createBoard, holdsKey, type BoardDeps } from "./server.ts";
import type { Ticket, TicketSource } from "./source.ts";

const ticket = (key: string, title = key) => ({ key, title, description: "", url: "", branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const KEY = "a".repeat(48);

function board(port = 4747, ticketSettings: Record<string, unknown> = {}, extra: Partial<BoardDeps> = {}) {
  const dir = tmpDir("ticket-server-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox", "platform-monorepo": "/r/pm" }, stateDir: dir, tickets: { port, ...ticketSettings } });
  const source: TicketSource = { assigned: async () => [ticket("NBF-1"), ticket("NBF-2")], read: async (key) => (key === "VE-9" ? ticket("VE-9") : null), download: async () => [] };
  const ticks: string[] = [];
  const pool = {
    tick: async () => { ticks.push("tick"); }, stop: (key: string) => { ticks.push(`stop ${key}`); }, close: (key: string) => { ticks.push(`close ${key}`); },
    dismiss: async (key: string) => { ticks.push(`dismiss ${key}`); },
    // The pool takes a queued run off, after putting its ticket back: here only the queue's part, which the board's store is asked for.
    remove: async (key: string) => { ticks.push(`remove ${key}`); made.store.set(removeQueued(made.store.get(), key)); },
    reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {},
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
  const pool = { tick: async () => {}, stop: () => {}, close: () => {}, dismiss: async () => {}, remove: async () => {}, reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {} };
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
  const pool = { tick: async () => {}, stop: () => {}, close: () => {}, dismiss: async () => {}, remove: async () => {}, reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {} };
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
