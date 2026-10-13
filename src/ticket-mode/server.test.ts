// no-token: gh -- Linear and the pool are injected; the one server listens on 127.0.0.1 for the length of a test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { parseTicketSettings } from "./settings.ts";
import { boardViewScript, carriesToken, createBoard, refusal } from "./server.ts";
import type { Ticket, TicketSource } from "./source.ts";

const ticket = (key: string, title = key) => ({ key, title, description: "", url: "", branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const TOKEN = "a".repeat(48);

function board(port = 4747, ticketSettings: Record<string, unknown> = {}) {
  const dir = tmpDir("ticket-server-");
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox", "platform-monorepo": "/r/pm" }, stateDir: dir, tickets: { port, ...ticketSettings } });
  const source: TicketSource = { assigned: async () => [ticket("NBF-1"), ticket("NBF-2")], read: async (key) => (key === "VE-9" ? ticket("VE-9") : null), download: async () => [] };
  const ticks: string[] = [];
  const pool = {
    tick: async () => { ticks.push("tick"); }, stop: (key: string) => { ticks.push(`stop ${key}`); }, close: (key: string) => { ticks.push(`close ${key}`); },
    reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {},
  };
  const made = createBoard({ settings, source, token: TOKEN, queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json"), pool, now: () => 7 });
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
  const pool = { tick: async () => {}, stop: () => {}, close: () => {}, reconcile: () => {}, ensureSession: async () => {}, refreshTracker: async () => {} };
  const { api } = createBoard({ settings, source, token: TOKEN, queuePath: join(dir, "queue.json"), choicePath: join(dir, "choice.json"), pool, now: () => 7 });
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

test("the token is taken from the cookie or the header, and a wrong or missing one is not", () => {
  assert.equal(carriesToken({ headers: { cookie: `x=1; ticket_token=${TOKEN}` } }, TOKEN), true);
  assert.equal(carriesToken({ headers: { "x-ticket-token": TOKEN } }, TOKEN), true);
  assert.equal(carriesToken({ headers: { cookie: "ticket_token=wrong" } }, TOKEN), false);
  assert.equal(carriesToken({ headers: {} }, TOKEN), false);
});

test("queueing takes the tickets you selected with the model and effort chosen, no repository until the worker chooses one, remembers the choice, and wakes the pool", async () => {
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
  assert.deepEqual(config.choice, { model: "opus", effort: "max" });
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
  assert.deepEqual(view.visibleTickets(tickets, new Set(["P"]), "").map((t: any) => t.key), ["A-1"], "the browser's copy filters as the tested one does");
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

test("over HTTP: no token is 401, the printed URL sets the cookie, and the cookie then reaches the API", async () => {
  const probe: Server = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const b = board(port);
  const server = createServer((req, res) => { void b.handle(req, res); });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/api/queue`)).status, 401);
    const entry = await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" });
    assert.equal(entry.status, 303);
    const cookie = String(entry.headers.get("set-cookie"));
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const queue = await fetch(`${base}/api/queue`, { headers: { cookie: cookie.split(";")[0] } });
    assert.equal(queue.status, 200);
    const page = await fetch(`${base}/`, { headers: { cookie: cookie.split(";")[0] } });
    assert.match(await page.text(), /<title>Ticket queue<\/title>/);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
