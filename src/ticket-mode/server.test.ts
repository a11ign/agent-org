// no-token: gh -- Linear and the pool are injected; the one server listens on 127.0.0.1 for the length of a test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { parseTicketSettings } from "./settings.ts";
import { markPublishRunning, markPublishStarting } from "./queue.ts";
import { boardViewScript, createBoard, pairedBy, refusal } from "./server.ts";
import type { Ticket, TicketSource } from "./source.ts";

const ticket = (key: string, title = key) => ({ key, title, description: "", url: "", branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const KEY = "a".repeat(48);

function board(port = 4747, ticketSettings: Record<string, unknown> = {}) {
  const dir = tmpDir("ticket-server-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox", "platform-monorepo": "/r/pm" }, stateDir: dir, tickets: { port, ...ticketSettings } });
  const source: TicketSource = { assigned: async () => [ticket("NBF-1"), ticket("NBF-2")], read: async (key) => (key === "VE-9" ? ticket("VE-9") : null), download: async () => [] };
  const ticks: string[] = [];
  const pool = {
    tick: async () => { ticks.push("tick"); }, stop: (key: string) => { ticks.push(`stop ${key}`); }, close: (key: string) => { ticks.push(`close ${key}`); },
    reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {},
  };
  const made = createBoard({ settings, source, key: KEY, queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json"), pool, now: () => 7 });
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
  const pool = { tick: async () => {}, stop: () => {}, close: () => {}, reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {} };
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

test("a request is paired by the board's key in its header, or by a session the board opened in its cookie, and never by the key as a cookie", () => {
  const sessions = { holds: (value: string) => value === "s".repeat(48) };
  assert.equal(pairedBy({ headers: { "x-ticket-token": KEY } }, KEY, sessions), "key");
  assert.equal(pairedBy({ headers: { cookie: `x=1; ticket_session=${"s".repeat(48)}` } }, KEY, sessions), "browser");
  assert.equal(pairedBy({ headers: { cookie: `ticket_session=${KEY}` } }, KEY, sessions), null, "the key never pairs a browser");
  assert.equal(pairedBy({ headers: { "x-ticket-token": "wrong", cookie: `ticket_session=${"s".repeat(48)}` } }, KEY, sessions), null, "a header, once sent, decides");
  assert.equal(pairedBy({ headers: {} }, KEY, sessions), null);
  assert.equal(pairedBy({ headers: { "x-ticket-token": `${"a".repeat(47)}é` } }, KEY, sessions), null, "a header of the key's length but more bytes is refused, not thrown");
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
  const pool = { tick: async () => {}, stop: () => {}, close: () => {}, reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {}, watchFeedback: () => {} };
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

test("the page's logic is served as JavaScript the browser can import, and it is the tested module, types stripped", async () => {
  const script = boardViewScript();
  assert.doesNotMatch(script, /:\s*readonly ViewTicket\[\]|export type /, "no type annotation reaches the browser");
  const file = join(tmpDir("ticket-board-view-"), "board-view.mjs");
  writeFileSync(file, script);
  const view = await import(pathToFileURL(file).href);
  const tickets = [{ key: "A-1", title: "x", status: "Backlog", statusOrder: 0, priority: 2, project: "P" }];
  assert.deepEqual(view.visibleTickets(tickets, { projects: new Set(["P"]) }).map((t: any) => t.key), ["A-1"], "the browser's copy filters as the tested one does");
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

test("remove, stop, close and max go through the board", async () => {
  const b = board();
  await b.api("GET", "/api/tickets", {});
  await b.api("POST", "/api/queue", { keys: ["NBF-1", "NBF-2"], model: "sonnet", effort: "high" });
  await b.api("POST", "/api/queue/NBF-1/remove", {});
  await b.api("POST", "/api/queue/NBF-2/stop", {});
  await b.api("POST", "/api/queue/NBF-2/close", {});
  await b.api("POST", "/api/max", { max: 5 });
  assert.deepEqual(b.store.get().entries.map((e) => e.ticket.key), ["NBF-2"]);
  assert.ok(b.ticks.includes("stop NBF-2"));
  assert.ok(b.ticks.includes("close NBF-2"), "a parked run's workspace is the pool's to close");
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
async function overHttp(run: (base: string) => Promise<void>) {
  const probe: Server = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const b = board(port);
  const server = createServer((req, res) => { void b.handle(req, res); });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}
const pairWith = (base: string, code: string) => fetch(`${base}/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });

test("over HTTP: a browser that has not paired gets the pairing page and no API, and a code from ticket:pair gets it a cookie that lasts a year", async () => {
  await overHttp(async (base) => {
    assert.equal((await fetch(`${base}/api/queue`)).status, 401);
    const unpaired = await fetch(`${base}/`);
    assert.equal(unpaired.status, 200);
    assert.match(await unpaired.text(), /<title>Pair this browser<\/title>/);
    assert.equal((await fetch(`${base}/?token=${KEY}`, { redirect: "manual" })).headers.get("set-cookie"), null, "the key in a URL no longer pairs anything");
    const { code } = await (await fetch(`${base}/api/pair-code`, { method: "POST", headers: { "x-ticket-token": KEY } })).json() as { code: string };
    const paired = await pairWith(base, code);
    assert.equal(paired.status, 200);
    const cookie = String(paired.headers.get("set-cookie"));
    assert.match(cookie, /^ticket_session=[0-9a-f]{48}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=31536000$/);
    assert.equal(cookie.includes(KEY), false, "the browser gets a session of its own, not the board's key");
    const queue = await fetch(`${base}/api/queue`, { headers: { cookie: cookie.split(";")[0] } });
    assert.equal(queue.status, 200);
    const page = await fetch(`${base}/`, { headers: { cookie: cookie.split(";")[0] } });
    assert.match(await page.text(), /<title>Ticket queue<\/title>/);
    assert.equal((await pairWith(base, code)).status, 401, "a code pairs one browser");
  });
});

test("over HTTP: a wrong code is refused with what to do", async () => {
  await overHttp(async (base) => {
    const wrong = await pairWith(base, "ABCD-EFGH");
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("set-cookie"), null);
    assert.match((await wrong.json() as { error: string }).error, /wrong, used or out of date\. Run agent-org ticket:pair/);
  });
});

test("over HTTP: a pairing request that is too big, or not a JSON object, is a 400 that spends none of the code's tries, and the board keeps answering", async () => {
  await overHttp(async (base) => {
    const { code } = await (await fetch(`${base}/api/pair-code`, { method: "POST", headers: { "x-ticket-token": KEY } })).json() as { code: string };
    const bad = ["null", "[]", "7", "{", JSON.stringify({ code, pad: "x".repeat(2048) })];
    for (const body of bad) {
      const refused = await fetch(`${base}/pair`, { method: "POST", body });
      assert.equal(refused.status, 400, body.slice(0, 20));
      assert.equal(refused.headers.get("set-cookie"), null);
    }
    assert.equal((await pairWith(base, code)).status, 200, "five bad requests left the code live");
  });
});

test("over HTTP: a key header of the key's length in more bytes is refused, and the board keeps answering", async () => {
  await overHttp(async (base) => {
    assert.equal((await fetch(`${base}/api/queue`, { headers: { "x-ticket-token": `${"a".repeat(47)}\u00e9` } })).status, 401);
    assert.equal((await fetch(`${base}/api/queue`, { headers: { "x-ticket-token": KEY } })).status, 200);
  });
});


test("over HTTP: a body that is not JSON is a 400, and the board keeps answering", async () => {
  await overHttp(async (base) => {
    const bad = await fetch(`${base}/api/paused`, { method: "POST", headers: { "x-ticket-token": KEY }, body: "{" });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${base}/api/queue`, { headers: { "x-ticket-token": KEY } })).status, 200);
  });
});

test("over HTTP: a request body over 64 KB is refused, even from what has paired", async () => {
  await overHttp(async (base) => {
    const big = await fetch(`${base}/api/queue`, { method: "POST", headers: { "x-ticket-token": KEY }, body: JSON.stringify({ keys: ["x".repeat(70_000)] }) });
    assert.equal(big.status, 400);
    assert.match((await big.json() as { error: string }).error, /over 65536 bytes/);
  });
});

test("only a request that carries the key can make a pairing code: not one with no credential, and not a paired browser", async () => {
  await overHttp(async (base) => {
    const refused = await fetch(`${base}/api/pair-code`, { method: "POST" });
    assert.equal(refused.status, 401);
    assert.match((await refused.json() as { error: string }).error, /not paired: open http:\/\/127\.0\.0\.1:\d+\/ and type the code agent-org ticket:pair prints/);
    const { code } = await (await fetch(`${base}/api/pair-code`, { method: "POST", headers: { "x-ticket-token": KEY } })).json() as { code: string };
    const cookie = String((await pairWith(base, code)).headers.get("set-cookie")).split(";")[0];
    assert.equal((await fetch(`${base}/api/queue`, { headers: { cookie } })).status, 200, "the browser is paired");
    const browser = await fetch(`${base}/api/pair-code`, { method: "POST", headers: { cookie } });
    assert.equal(browser.status, 403);
    assert.match((await browser.json() as { error: string }).error, /made with the board's key: run agent-org ticket:pair/);
  });
});
