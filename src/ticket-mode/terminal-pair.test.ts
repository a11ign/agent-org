// no-token: gh -- the terminal is a fake `fetch` that answers as herdr web ui's pair start does, and the token a file in a temporary HOME
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { parseTicketSettings, type TicketSettings } from "./settings.ts";
import { mintTerminalCode, pluginToken, type MintDeps } from "./terminal-pair.ts";

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
