// no-token: gh -- the terminal is a fake `fetch` that answers as herdr web ui's pair start does, and the token a file in a temporary HOME
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { terminalLink } from "./board-view/pull-status-and-notes.ts";
import { finish, markRunning, markStarting } from "./queue/queue-transitions.ts";
import { enqueue, type PublishRun, type Queue, type WriterRun } from "./queue/queue-entries-and-outcomes.ts";
import { emptyQueue } from "./queue.ts";
import { parseTicketSettings, type TicketSettings } from "./settings.ts";
import type { Ticket } from "./source.ts";
import { mintTerminalCode, pluginToken, runOfTerminalLink, terminalRunOf, type MintDeps } from "./terminal-pair.ts";

const TERMINAL = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";
const START = "http://127.0.0.1:7318/api/devices/pair/start";

/** Settings with `terminal` on this machine's loopback, or none, and a state directory of their own. */
function machine(terminal: string | null = TERMINAL): TicketSettings {
  return parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: tmpDir("ticket-terminal-pair-"), tickets: terminal === null ? {} : { terminal } });
}

/** A fake terminal: it records each call, and answers with `answer` (a status and a body) or fails with `fail`. */
function terminal(answer: { status?: number; body?: string } | { fail: Error } | "hang" = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (answer === "hang") return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    if ("fail" in answer) throw answer.fail;
    return new Response(answer.body ?? JSON.stringify({ code: "123456", expires_at: "2026-10-18T12:00:00Z" }), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { calls, request };
}

/** Deps for `mintTerminalCode`: a temporary HOME whose plugin config directory holds the files given, and the fake terminal. */
function deps(files: Record<string, string> = {}, over: Partial<MintDeps> & { request?: typeof fetch } = {}) {
  const home = tmpDir("ticket-terminal-home-");
  const config = join(home, ".config", "herdr-web-ui-tickets");
  mkdirSync(config, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(config, name), text);
  const fake = terminal();
  return { home, config, fake, mint: { home, read: (path: string) => { try { return readFileSync(path, "utf8"); } catch { return null; } }, request: fake.request, timeoutMs: 5_000, ...over } as MintDeps };
}

test("a worker's terminal code is asked from this machine's terminal, over loopback with the pairing header and no token when none is set", async () => {
  const d = deps();
  assert.deepEqual(await mintTerminalCode(machine(), 7318, d.mint), { code: "123456" });
  assert.equal(d.fake.calls.length, 1);
  assert.equal(d.fake.calls[0].url, START);
  assert.equal(d.fake.calls[0].init.method, "POST");
  assert.deepEqual(d.fake.calls[0].init.headers, { "content-type": "application/json", "x-herdr-machine": "1" }, "no Authorization without a token");
});

test("the terminal's bearer token is read from its env file, and a .env file's value wins over it, as the plugin merges them", async () => {
  const fromEnv = deps({ env: "HERDR_WEB_TOKEN=from-env\n" });
  await mintTerminalCode(machine(), 7318, fromEnv.mint);
  assert.equal((fromEnv.fake.calls[0].init.headers as Record<string, string>).authorization, "Bearer from-env");
  const both = deps({ env: "HERDR_WEB_TOKEN=\"old\"\n", ".env": "# a comment\nHERDR_WEB_TOKEN = new\n" });
  await mintTerminalCode(machine(), 7318, both.mint);
  assert.equal((both.fake.calls[0].init.headers as Record<string, string>).authorization, "Bearer new");
});

test("pluginToken reads the token as the plugin does, and an empty one is no token at all", () => {
  const files = (map: Record<string, string>) => (path: string) => map[path.split("/").pop()!] ?? null;
  assert.equal(pluginToken("/c", files({ env: "HERDR_WEB_TOKEN=abc\n" })), "abc");
  assert.equal(pluginToken("/c", files({ env: "HERDR_WEB_TOKEN=abc\n", ".env": "HERDR_WEB_TOKEN=\n" })), null, "an empty value in .env wins, as the plugin's merge does");
  assert.equal(pluginToken("/c", files({})), null);
});

test("a terminal that refuses the request, answers something else, or names no six-digit code gives a note and no code", async () => {
  for (const answer of [{ status: 401, body: "{}" }, { status: 403, body: "{}" }, { body: "<html>not json</html>" }, { body: JSON.stringify({ code: "12 34 56" }) }, { body: JSON.stringify({ expires_at: "x" }) }]) {
    const d = deps({}, { request: terminal(answer).request });
    const minted = await mintTerminalCode(machine(), 7318, d.mint);
    assert.equal(minted.code, null, JSON.stringify(answer));
    assert.match(minted.note ?? "", /worker terminal/);
  }
});

test("a terminal that is down, or too slow, gives a note, and the link goes out plain", async () => {
  const down = deps({}, { request: terminal({ fail: new TypeError("fetch failed") }).request });
  assert.deepEqual(await mintTerminalCode(machine(), 7318, down.mint), { code: null, note: "the worker terminal did not answer on 127.0.0.1:7318" });
  const slow = deps({}, { request: terminal("hang").request, timeoutMs: 10 });
  assert.equal((await mintTerminalCode(machine(), 7318, slow.mint)).code, null, "the request is abandoned after its timeout");
});

test("with tickets.terminal absent or served by another machine, no request is made", async () => {
  const absent = deps();
  assert.deepEqual(await mintTerminalCode(machine(null), null, absent.mint), { code: null, note: "tickets.terminal is not set" });
  const remote = deps();
  assert.deepEqual(await mintTerminalCode(machine("https://other.example.ts.net:9444/?ws={workspace}"), null, remote.mint), { code: null, note: "tickets.terminal is served by another machine" });
  assert.equal(absent.fake.calls.length + remote.fake.calls.length, 0);
});

test("neither the code nor the token is ever in a note, even when the failure itself names them", async () => {
  const d = deps({ env: "HERDR_WEB_TOKEN=secret-token-value\n" }, { request: terminal({ fail: new Error("socket hang up with Bearer secret-token-value") }).request });
  const minted = await mintTerminalCode(machine(), 7318, d.mint);
  assert.equal(minted.code, null);
  assert.ok(!JSON.stringify(minted).includes("secret-token-value"));
});

const TERMINAL_WITH_KEY = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&key={key}&view=terminal";

test("A11-129: a link terminalLink built gives back the workspace, pane and key it carries; a link off the template, or a value that cannot be read, gives none", () => {
  const entry = { ticket: { key: "NBF-1" }, phase: "running", workspace: "w1", pane: "w1:p1" } as unknown as Parameters<typeof terminalLink>[1];
  assert.deepEqual(runOfTerminalLink(TERMINAL_WITH_KEY, terminalLink(TERMINAL_WITH_KEY, entry)!), { workspace: "w1", pane: "w1:p1", key: "NBF-1" });
  assert.deepEqual(runOfTerminalLink(TERMINAL, terminalLink(TERMINAL, entry)!), { workspace: "w1", pane: "w1:p1" }, "a template without a key names none");
  assert.equal(runOfTerminalLink(TERMINAL, "http://127.0.0.1:7318/?ws=w1&pane=w1%3Ap1&view=other"), null, "another view is another address");
  assert.equal(runOfTerminalLink(TERMINAL, "http://evil.example/?ws=w1&pane=w1%3Ap1&view=terminal"), null, "another site is another address");
  assert.equal(runOfTerminalLink(TERMINAL, "http://127.0.0.1:7318/?ws=%E0%A4%A&pane=w1&view=terminal"), null, "a value that cannot be decoded is none");
});

/** A ticket as the queue holds it, for a run the terminal lookup is asked about. */
const ticketOf = (key: string) => ({ key, title: key, description: "", url: "", branch: key.toLowerCase(), status: "Backlog", statusOrder: 0, team: "NBF", project: null, priority: 0 }) as Ticket;
const choice = { model: "opus", effort: "high" };
/** The address a run's terminal is at, as the board links it. */
const linkTo = (workspace: string, pane: string) => terminalLink(TERMINAL, { ticket: { key: "x" }, phase: "running", workspace, pane } as unknown as Parameters<typeof terminalLink>[1])!;

test("A11-129: a terminal a run holds is live; a run that has ended says how and why, for a ticket, a new-ticket request or a publish; and a link no run holds is unknown", () => {
  let queue = markRunning(markStarting(enqueue(emptyQueue(3), [ticketOf("NBF-1")], choice, 1), "NBF-1", 2), "NBF-1", "w1", "w1:p1");
  assert.deepEqual(terminalRunOf(queue, TERMINAL, linkTo("w1", "w1:p1")), { state: "live" });
  queue = finish(queue, "NBF-1", { kind: "crashed", reason: "its herdr workspace is gone" }, 5);
  assert.deepEqual(terminalRunOf(queue, TERMINAL, linkTo("w1", "w1:p1")), { state: "ended", outcome: "failed", run: "NBF-1", kind: "ticket", reason: "its herdr workspace is gone" });
  assert.deepEqual(terminalRunOf(queue, TERMINAL, linkTo("w9", "w9:p1")), { state: "unknown" }, "a terminal no run holds");
  assert.deepEqual(terminalRunOf(queue, TERMINAL, "http://elsewhere.example/?ws=w1&pane=w1%3Ap1&view=terminal"), { state: "unknown" }, "not this machine's terminal");

  const writing = { id: "w2", request: "r", mode: "grill", form: {}, phase: "running", queuedAt: 1, drafts: [], rejected: [], workspace: "w2", pane: "w2:p1" } as unknown as WriterRun;
  const asking = { ...emptyQueue(3), writers: [writing] };
  assert.deepEqual(terminalRunOf(asking, TERMINAL, linkTo("w2", "w2:p1")), { state: "live" }, "a new-ticket run's terminal while it runs");
  const failed = { ...asking, writers: [{ ...writing, phase: "finished", finishedAt: 5, failure: "its agent exited: its herdr workspace is gone" }] } as Queue;
  assert.deepEqual(terminalRunOf(failed, TERMINAL, linkTo("w2", "w2:p1")),
    { state: "ended", outcome: "failed", run: "w2", kind: "writer", reason: "its agent exited: its herdr workspace is gone" }, "a finished request keeps its workspace on the record, so its link says so");
  const done = { ...asking, writers: [{ ...writing, phase: "finished", finishedAt: 5 }] } as Queue;
  assert.deepEqual(terminalRunOf(done, TERMINAL, linkTo("w2", "w2:p1")), { state: "ended", outcome: "finished", run: "w2", kind: "writer" });

  const published = { ...emptyQueue(3), publish: { id: "p1", keys: [], prs: [], phase: "finished", queuedAt: 1, failure: "it stopped without writing an outcome",
    lastTerminal: { workspace: "w3", pane: "w3:p1" } } as unknown as PublishRun } as Queue;
  assert.deepEqual(terminalRunOf(published, TERMINAL, linkTo("w3", "w3:p1")), { state: "ended", outcome: "failed", run: "p1", kind: "publish", reason: "it stopped without writing an outcome" });
});
