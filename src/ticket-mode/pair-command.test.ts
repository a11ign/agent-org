// no-token: gh -- the board is a fetch handed in, and the key a file in a temporary directory
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { boardKey, boardKeyPath } from "./board-key.ts";
import { type Exposed, exposedBy, pairingCode, runPair, terminalPair, type PairDeps, type TerminalDeps } from "./pair-command.ts";
import { createFakeExposure } from "../plugins/fakes/exposure.ts";
import { parseTicketSettings, type TicketSettings } from "./settings.ts";

function machine() {
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: tmpDir("ticket-pair-"), tickets: { uiPort: 4848 } });
  return { settings, key: boardKey(boardKeyPath(settings.stateDir)) };
}

test("ticket:pair asks this machine's board page for a code with the key from its file", async () => {
  const { settings, key } = machine();
  const asked: { url: string; init?: RequestInit }[] = [];
  const answer = async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), init });
    return new Response(JSON.stringify({ code: "ABCD-EFGH", minutes: 10 }), { status: 200 });
  };
  assert.deepEqual(await pairingCode(settings, answer as typeof fetch), { code: "ABCD-EFGH", minutes: 10 });
  assert.equal(asked[0].url, "http://127.0.0.1:4848/api/pair-code");
  assert.equal(asked[0].init?.method, "POST");
  assert.deepEqual(asked[0].init?.headers, { "x-ticket-token": key });
});

test("ticket:pair says so when no board is running, or the board refuses the key", async () => {
  const { settings } = machine();
  const down = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(pairingCode(settings, down as typeof fetch), /no board page answers on 127\.0\.0\.1:4848: start it with agent-org ticket:ui/);
  const refuses = async () => new Response("{}", { status: 401 });
  await assert.rejects(pairingCode(settings, refuses as typeof fetch), /refused \(401\)/);
});

test("ticket:pair before any board has started says how to start one", async () => {
  const settings = parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: tmpDir("ticket-pair-none-") });
  await assert.rejects(pairingCode(settings, (async () => { throw new Error("not asked"); }) as typeof fetch), /does not exist: start the instance once/);
});

const TERMINAL = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal";
const PLUGINS = JSON.stringify([{ plugin_id: "devswha.herdr-web-ui", plugin_root: "/h/.config/herdr/plugins/github/devswha.herdr-web-ui-1" }]);

/** Settings with a terminal on this machine, and the tailscale exposure when `served` (the exposure itself is `pairDeps`'s: what the plugin says is its own). */
function withTerminal(served: boolean, terminal: string | null = TERMINAL): TicketSettings {
  return parseTicketSettings({ clones: { "nbl-ui-netbox": "/r/netbox" }, stateDir: tmpDir("ticket-pair-term-"), tickets: { uiPort: 4848, ...(terminal === null ? {} : { terminal }), ...(served ? { serve: "tailscale" } : {}) } });
}

const NAME = "agents.tail1234.ts.net";

/** What an exposure that serves the page and the terminal on the tailnet says (under `name`, null while it cannot be read), and what one that serves nothing says. */
const tailnet = (name: string | null = NAME): Exposed => ({ ports: { ui: 9443, terminal: 9444 }, name, terminal: (port) => (name === null ? null : `https://${name}:${port}/?ws={workspace}&pane={pane}&view=terminal`) });
const loopback: Exposed = { ports: null, name: null, terminal: () => null };

/** Deps for `runPair` that record what they print and run. The terminal's plugin is at `/h/...`, with bun installed under `~/.bun`. */
function pairDeps(over: Partial<PairDeps> = {}, exposed: Exposed = loopback) {
  const out: string[] = [];
  const err: string[] = [];
  const ran: { argv: string[]; cwd: string; env: Record<string, string> }[] = [];
  const machine: TerminalDeps = {
    env: { PATH: "/usr/bin:/bin" }, home: "/h",
    read: (path) => (path === "/h/.config/herdr/plugins.json" ? PLUGINS : null),
    exists: (path) => path === "/h/.bun/bin/bun",
  };
  const deps: PairDeps = {
    board: async () => ({ code: "ABCD-EFGH", minutes: 10 }),
    terminal: () => machine,
    run: (program) => { ran.push({ argv: program.argv, cwd: program.workingDirectory, env: program.environment }); return 0; },
    exposed: async () => exposed,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    ...over,
  };
  return { deps, out, err, ran };
}

test("ticket:pair --terminal runs the plugin's own pair with the terminal service's environment, and types no path", async () => {
  const { deps, ran, out } = pairDeps();
  assert.equal(await runPair("terminal", withTerminal(false), deps), 0);
  assert.equal(ran.length, 1);
  assert.deepEqual(ran[0].argv, ["/h/.bun/bin/bun", "/h/.config/herdr/plugins/github/devswha.herdr-web-ui-1/scripts/plugin.ts", "pair"]);
  assert.equal(ran[0].cwd, "/h/.config/herdr/plugins/github/devswha.herdr-web-ui-1");
  const env = ran[0].env;
  assert.equal(env.PORT, "7318");
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.HERDR_SOCKET, "/h/.config/herdr/sessions/tickets/herdr.sock", "the session's socket, which the plugin reads");
  assert.equal(env.HERDR_PLUGIN_STATE_DIR, "/h/.local/state/herdr-web-ui-tickets");
  assert.equal(env.HERDR_PLUGIN_CONFIG_DIR, "/h/.config/herdr-web-ui-tickets");
  assert.equal(env.HERDR_PLUGIN_ROOT, "/h/.config/herdr/plugins/github/devswha.herdr-web-ui-1");
  assert.equal(env.PATH, "/h/.bun/bin:/usr/bin:/bin", "bun's directory first, as the service runs it");
  assert.deepEqual(out, ["  open http://127.0.0.1:7318/ within 10 minutes, and enter the code there. It works once.\n"], "the board prints its own line after the plugin's output");
});

test("ticket:pair with no flag prints the board's code alone when the terminal is not served for this instance", async () => {
  const { deps, ran, out, err } = pairDeps();
  assert.equal(await runPair("both", withTerminal(false), deps), 0);
  assert.equal(ran.length, 0, "the plugin is not run");
  assert.deepEqual(out, ["ABCD-EFGH\n  type it into http://127.0.0.1:4848/ within 10 minutes. It works once.\n"]);
  assert.deepEqual(err, []);
});

test("ticket:pair on an exposure that serves the terminal prints the board's code, then the terminal's, and the address to open", async () => {
  const { deps, ran, out } = pairDeps({}, tailnet());
  assert.equal(await runPair("both", withTerminal(true), deps), 0);
  assert.equal(ran.length, 1);
  assert.equal(out[0], "ABCD-EFGH\n  type it into http://127.0.0.1:4848/ within 10 minutes. It works once.\n");
  assert.equal(out[1], "  open https://agents.tail1234.ts.net:9444/ within 10 minutes, and enter the code there. It works once.\n");
});

test("ticket:pair --board prints the board's code and never runs the plugin, even when the terminal is served", async () => {
  const { deps, ran, out } = pairDeps({}, tailnet());
  assert.equal(await runPair("board", withTerminal(true), deps), 0);
  assert.equal(ran.length, 0);
  assert.equal(out.length, 1);
});

test("ticket:pair with the terminal down exits 1 with the fix, after the board's code is printed", async () => {
  const { deps, out, err } = pairDeps({ run: () => 1 }, tailnet());
  assert.equal(await runPair("both", withTerminal(true), deps), 1);
  assert.match(out[0], /^ABCD-EFGH/, "the board's code is still printed");
  assert.match(err.join(""), /agent-org start terminal/);
  assert.match(err.join(""), /ticket:pair --terminal/);
});

test("ticket:pair names what is missing for a terminal that cannot pair: onboard, bun, or the plugin", async () => {
  const noPlugin = pairDeps({ terminal: () => ({ env: {}, home: "/h", read: () => null, exists: () => true }) });
  assert.equal(await runPair("terminal", withTerminal(false), noPlugin.deps), 1);
  assert.match(noPlugin.err.join(""), /herdr web ui is not installed: run `agent-org onboard`/);
  const noBun = pairDeps({ terminal: () => ({ env: { PATH: "/usr/bin" }, home: "/h", read: () => PLUGINS, exists: () => false }) });
  assert.equal(await runPair("terminal", withTerminal(false), noBun.deps), 1);
  assert.match(noBun.err.join(""), /bun is not installed/);
});

test("ticket:pair --terminal refuses a terminal another machine serves, and names where to run it; a served board names it too, an unserved one says nothing", async () => {
  const remote = "https://other.example.ts.net:9444/?ws={workspace}&pane={pane}&view=terminal";
  const asked = pairDeps({}, tailnet());
  assert.equal(await runPair("terminal", withTerminal(true, remote), asked.deps), 1);
  assert.equal(asked.ran.length, 0);
  assert.match(asked.err.join(""), /another machine serves: run `agent-org ticket:pair --terminal` there/);
  const unserved = pairDeps();
  assert.equal(await runPair("both", withTerminal(false, remote), unserved.deps), 0, "a code for the board is still printed and no failure is counted");
  assert.equal(unserved.out.length, 1, "a plain board says nothing about a terminal another machine serves");
  assert.equal(unserved.ran.length, 0);
  const served = pairDeps({}, tailnet());
  assert.equal(await runPair("both", withTerminal(true, remote), served.deps), 0);
  assert.match(served.out.join(""), /which another machine serves: run `agent-org ticket:pair --terminal` there/, "a served board names where the terminal is paired");
  assert.equal(served.ran.length, 0);
});

test("ticket:pair says a terminal that is not set up is set up with onboard, and prints the board's code first", async () => {
  const { deps, out, err } = pairDeps({}, tailnet());
  assert.equal(await runPair("both", withTerminal(true, null), deps), 0);
  assert.match(out[0], /^ABCD-EFGH/);
  assert.equal(err.length, 0, "no terminal is wanted without tickets.terminal");
  const forced = pairDeps();
  assert.equal(await runPair("terminal", withTerminal(false, null), forced.deps), 1);
  assert.match(forced.err.join(""), /tickets.terminal is not set.*run `agent-org onboard`/);
});

test("ticket:pair keeps the board's code when the board is not running, and still pairs the terminal", async () => {
  const { deps, ran, err } = pairDeps({ board: async () => { throw new Error("no board page answers on 127.0.0.1:4848: start it with agent-org ticket:ui"); } }, tailnet());
  assert.equal(await runPair("both", withTerminal(true), deps), 1);
  assert.equal(ran.length, 1, "the terminal's code is still asked for");
  assert.match(err.join(""), /start it with agent-org ticket:ui/);
});

test("ticket:pair pairs this machine's own terminal when tickets.terminal is its tailnet address, which the service listens on the default port of", async () => {
  const own = "https://agents.tail1234.ts.net:9444/?ws={workspace}&pane={pane}&view=terminal";
  const { deps, ran, out } = pairDeps({}, tailnet());
  assert.equal(await runPair("both", withTerminal(true, own), deps), 0);
  assert.equal(ran.length, 1, "the plugin is run, on the port the service listens on");
  assert.equal(ran[0].env.PORT, "7318");
  assert.equal(out[1], "  open https://agents.tail1234.ts.net:9444/ within 10 minutes, and enter the code there. It works once.\n");
});

test("terminalPair finds the plugin in the root herdr's plugins.json names, under XDG's config directory when it is set", () => {
  const xdg: TerminalDeps = { env: { XDG_CONFIG_HOME: "/x", PATH: "/usr/bin" }, home: "/h", read: (path) => (path === "/x/herdr/plugins.json" ? PLUGINS : null), exists: (path) => path === "/h/.bun/bin/bun" };
  const program = terminalPair(withTerminal(false), 7318, xdg);
  assert.equal(typeof program, "object");
  assert.deepEqual((program as { argv: string[] }).argv, ["/h/.bun/bin/bun", "/h/.config/herdr/plugins/github/devswha.herdr-web-ui-1/scripts/plugin.ts", "pair"]);
  assert.equal((program as { environment: Record<string, string> }).environment.HERDR_SOCKET, "/x/herdr/sessions/tickets/herdr.sock", "the socket is under XDG's herdr directory");
});

test("ticket:pair says so, rather than blaming another machine, when the exposure cannot name this machine to tell its terminal apart", async () => {
  const own = "https://agents.tail1234.ts.net:9444/?ws={workspace}&pane={pane}&view=terminal";
  const unreadable = pairDeps({}, tailnet(null));
  assert.equal(await runPair("both", withTerminal(true, own), unreadable.deps), 0);
  assert.equal(unreadable.ran.length, 0);
  assert.match(unreadable.out.join(""), /this machine's name cannot be read from the exposure/);
  assert.doesNotMatch(unreadable.out.join(""), /another machine/);
  const pairing = pairDeps({}, tailnet(null));
  assert.equal(await runPair("terminal", withTerminal(true, own), pairing.deps), 1);
  assert.match(pairing.err.join(""), /cannot be read.*ticket:pair` again/);
});

test("A11-162: exposedBy asks the exposure for its ports first and for a name only when it serves something, so a loopback-only exposure is never asked who this machine is", async () => {
  const local = createFakeExposure();
  assert.deepEqual(await exposedBy(local)().then(({ ports, name }) => ({ ports, name })), { ports: null, name: null });
  assert.deepEqual(local.calls, [], "and nothing was asked of it");
  const named = createFakeExposure(NAME);
  const exposed = await exposedBy(named)();
  assert.deepEqual([exposed.ports, exposed.name, exposed.terminal(9444)], [{ ui: 9443, terminal: 9444 }, NAME, `https://${NAME}:9444/?ws={workspace}&pane={pane}&view=terminal`]);
  const unnamed = await exposedBy(Object.assign(createFakeExposure(NAME), { machineName: async () => null }))();
  assert.equal(unnamed.terminal(9444), null, "an exposure that cannot name this machine gives no terminal address");
});
