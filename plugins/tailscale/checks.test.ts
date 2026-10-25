// no-token: none -- `tailscale` is a stand-in that holds a serve config in memory, and `probe` answers from a list
//
// THE ROWS DOCTOR HAD FOR THE TAILNET (A11-162): they moved out of `install/doctor.ts` with their names and words, and are asked of the plugin when a host enables it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TERMINAL_PORT as CORE_TERMINAL_PORT } from "../../src/install/terminal.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import type { PluginCheck, PluginDeps, ProbeRequest } from "../../src/plugins/manifest.ts";
import { DEFAULT_TERMINAL_PORT, loopbackPort, tailnetChecks } from "./checks.ts";
import { createTailscale, freshState, type TailscaleState } from "./stub.ts";

const NAME = "agents.tail1234.ts.net";
const SETTINGS = { port: 4800, uiPort: 4801, terminal: "http://127.0.0.1:7318/?ws={workspace}&pane={pane}" };

/** This board's entries on 9443 and 9444 and Funnel off for both, as `tailscale serve status` prints them. */
function served(state: TailscaleState): TailscaleState {
  state.web[`${NAME}:9443`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:4801" } } };
  state.web[`${NAME}:9444`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:7318" } } };
  return state;
}

/** Deps whose `tailscale` is the stand-in over `state`, and whose probe answers `status` (null: nothing answers) and records what it was asked. */
function depsOf(state: TailscaleState, status: number | null = 200): { deps: PluginDeps; probed: ProbeRequest[] } {
  const probed: ProbeRequest[] = [];
  return { probed, deps: fakePluginDeps({ exec: createTailscale(state), env: { USER: "agent" }, probe: async (request) => { probed.push(request); return status; } }) };
}

const byName = (checks: readonly PluginCheck[]) => Object.fromEntries(checks.map((check) => [check.name, check]));

test("the terminal's default port is the one core starts the terminal service on, and a loopback address is read as core reads it", () => {
  assert.equal(DEFAULT_TERMINAL_PORT, CORE_TERMINAL_PORT);
  assert.equal(loopbackPort("http://127.0.0.1:7500/?ws={workspace}"), 7500);
  assert.equal(loopbackPort("http://localhost:7500/"), 7500);
  assert.equal(loopbackPort("https://agents.tail1234.ts.net:9444/?ws={workspace}"), null);
  assert.equal(loopbackPort(undefined), null);
});

test("with the board served, each port's entry, that it is not on Funnel, and that it answers under the machine's name are checked", async () => {
  const { deps, probed } = depsOf(served(freshState()));
  const checks = byName(await tailnetChecks(SETTINGS, deps));
  for (const name of ["tailscale", "ui tailnet entry", "ui tailnet only", "ui tailnet answering", "terminal tailnet entry", "terminal tailnet only", "terminal tailnet answering"]) assert.equal(checks[name]?.ok, true, name);
  assert.equal(checks["ui tailnet entry"].detail, `https://${NAME}:9443/ serves 127.0.0.1:4801`);
  assert.deepEqual(probed.map(({ host, port, tls, servername, hostHeader }) => [host, port, tls, servername, hostHeader]),
    [["100.64.0.7", 9443, true, NAME, `${NAME}:9443`], ["100.64.0.7", 9444, true, NAME, `${NAME}:9444`]], "it connects to the address and names the machine, as a browser does by its name");
});

test("a served port with no entry, another entry, or Funnel on it fails with its fix", async () => {
  const none = byName(await tailnetChecks(SETTINGS, depsOf(freshState()).deps));
  assert.equal(none["ui tailnet entry"].ok, false);
  assert.equal(none["ui tailnet entry"].fix, "run `agent-org start ui`");
  const open = served(freshState());
  open.funnel[`${NAME}:9443`] = true;
  const funnel = byName(await tailnetChecks(SETTINGS, depsOf(open).deps));
  assert.equal(funnel["ui tailnet only"].ok, false);
  assert.match(funnel["ui tailnet only"].fix ?? "", /tailscale funnel --https=9443 off/);
  assert.equal(funnel["ui tailnet entry"].ok, true, "its entry is still there: only Funnel is wrong");
  const taken = freshState();
  taken.web[`${NAME}:9443`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } };
  const foreign = byName(await tailnetChecks(SETTINGS, depsOf(taken).deps));
  assert.match(foreign["ui tailnet entry"].detail, /serves http:\/\/127\.0\.0\.1:9999 instead/);
  assert.match(foreign["ui tailnet entry"].fix ?? "", /set `tickets\.providers\.exposure\.tailnetPorts\.ui` to a port nothing serves/);
});

test("a node that is not Running, or no tailscale at all, is the one tailscale failure, with its fix", async () => {
  const stopped = byName(await tailnetChecks(SETTINGS, depsOf(served(freshState({ backend: "Stopped" }))).deps));
  assert.equal(stopped.tailscale.ok, false);
  assert.equal(stopped.tailscale.detail, "Tailscale is Stopped, not Running");
  assert.equal(stopped.tailscale.fix, "run `sudo tailscale up`, and turn MagicDNS on in the admin console");
  assert.equal(stopped["ui tailnet entry"], undefined, "no entry is judged on a node that is not Running");
  const absent = byName(await tailnetChecks(SETTINGS, fakePluginDeps({ exec: () => ({ status: null, stdout: "", stderr: "ENOENT" }) })));
  assert.equal(absent.tailscale.detail, "tailscale is not on PATH");
  assert.equal(absent.tailscale.fix, "install Tailscale, then run `tailscale up`");
  const nameless = byName(await tailnetChecks(SETTINGS, depsOf(freshState({ name: null })).deps));
  assert.equal(nameless.tailscale.detail, "this machine has no DNS name");
});

test("a served port that does not answer under the machine's name fails", async () => {
  const silent = byName(await tailnetChecks(SETTINGS, depsOf(served(freshState()), null).deps));
  assert.equal(silent["terminal tailnet answering"].ok, false);
  assert.equal(silent["ui tailnet answering"].detail, `nothing answers https://${NAME}:9443/`);
  assert.equal(silent["ui tailnet answering"].fix, "read the service's log, then run `agent-org start ui` to restart it");
  const broken = byName(await tailnetChecks(SETTINGS, depsOf(served(freshState()), 502).deps));
  assert.equal(broken["ui tailnet answering"].ok, false, "a service that is down behind serve answers 502, which is not an answer");
  const answered = byName(await tailnetChecks(SETTINGS, depsOf(served(freshState()), 404).deps));
  assert.equal(answered["ui tailnet answering"].ok, true, "any status under 500 is an answer");
});

test("a serve config it cannot read fails the serve row and judges no entry from it", async () => {
  const state = freshState();
  const exec = createTailscale(state);
  const unreadable: PluginDeps["exec"] = (file, args) => (args[0] === "serve" && args[1] === "status" ? { status: 0, stdout: JSON.stringify({ Web: "unreadable" }), stderr: "" } : exec(file, args));
  const checks = byName(await tailnetChecks(SETTINGS, fakePluginDeps({ exec: unreadable })));
  assert.equal(checks["tailscale serve"].ok, false);
  assert.match(checks["tailscale serve"].detail, /did not answer/);
  assert.equal(checks["ui tailnet entry"], undefined, "no entry is read from a config that cannot be read");
});

test("ports the plugin could not serve on are one failure that names the setting", async () => {
  const checks = await tailnetChecks({ ...SETTINGS, tailnetPorts: { ui: 9443, terminal: 9443 } }, depsOf(freshState()).deps);
  assert.deepEqual(checks.map(({ name, ok }) => [name, ok]), [["tailscale ports", false]]);
  assert.match(checks[0].detail, /ui and terminal must be different ports/);
});

test("the terminal's loopback port is the one tickets.terminal names, else the default, and the page's is uiPort", async () => {
  const state = freshState();
  state.web[`${NAME}:9443`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:4748" } } };
  state.web[`${NAME}:9444`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:7318" } } };
  const checks = byName(await tailnetChecks({}, depsOf(state).deps));
  assert.equal(checks["ui tailnet entry"].ok, true, "uiPort defaults to 4748");
  assert.equal(checks["terminal tailnet entry"].ok, true, "no terminal address: the default 7318");
});

test("A11-279: doctor fails the row of each configured tailnet port that is not served, the other port's row staying green, and the fix names its service", async () => {
  const noTerminal = served(freshState());
  delete noTerminal.web[`${NAME}:9444`];
  const terminalGone = byName(await tailnetChecks(SETTINGS, depsOf(noTerminal).deps));
  assert.equal(terminalGone["terminal tailnet entry"].ok, false);
  assert.equal(terminalGone["terminal tailnet entry"].detail, "nothing serves port 9444 on the tailnet");
  assert.equal(terminalGone["terminal tailnet entry"].fix, "run `agent-org start terminal`");
  assert.equal(terminalGone["ui tailnet entry"].ok, true, "the board's entry is still there");
  const noBoard = served(freshState());
  delete noBoard.web[`${NAME}:9443`];
  const boardGone = byName(await tailnetChecks(SETTINGS, depsOf(noBoard).deps));
  assert.deepEqual([boardGone["ui tailnet entry"].ok, boardGone["terminal tailnet entry"].ok], [false, true]);
  const ports = { ...SETTINGS, tailnetPorts: { ui: 9500, terminal: 9501 } };
  const moved = byName(await tailnetChecks(ports, depsOf(served(freshState())).deps));
  assert.equal(moved["ui tailnet entry"].detail, "nothing serves port 9500 on the tailnet", "a configured port other than the default is the one that is checked");
  assert.equal(moved["terminal tailnet entry"].detail, "nothing serves port 9501 on the tailnet");
});
