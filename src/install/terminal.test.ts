// no-token: none -- pure functions over strings; nothing is read or run
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveTerminal, herdrConfigDir, herdrSocket, localTerminalPort, loopbackPort, PAIRING_STEPS, pluginConfigDir, pluginRoot, terminalAddress, terminalPairProgram, terminalProgram, terminalTarget } from "./terminal.ts";

test("on the tailnet, the board's terminal address is the tailnet's, unless the stored one names another machine", () => {
  const tailnet = "https://agents.tail1234.ts.net:9444/?ws={workspace}&pane={pane}&view=terminal";
  const other = "https://other.example.ts.net:9444/?ws={workspace}&pane={pane}&view=terminal";
  assert.equal(effectiveTerminal(null, tailnet), tailnet);
  assert.equal(effectiveTerminal(terminalAddress(7318), tailnet), tailnet);
  assert.equal(effectiveTerminal("http://localhost:7400/?ws={workspace}&pane={pane}&view=terminal", tailnet), tailnet);
  assert.equal(effectiveTerminal(other, tailnet), other);
  assert.equal(effectiveTerminal(terminalAddress(7318), null), terminalAddress(7318), "without a tailnet address, the stored one is handed over");
  assert.equal(terminalTarget({ tickets: { terminal: "http://127.0.0.1:7400/?ws={workspace}&pane={pane}&view=terminal" } }).port, 7400, "the stored loopback port is still the terminal's");
});

test("herdr web ui's directory is read from herdr's plugins.json, and an absent or foreign file gives none", () => {
  const root = "/home/agent/.config/herdr/plugins/github/devswha.herdr-web-ui-210f619d6b7b";
  assert.equal(pluginRoot(JSON.stringify([{ plugin_id: "other" }, { plugin_id: "devswha.herdr-web-ui", plugin_root: root }])), root);
  assert.equal(pluginRoot(null), null);
  assert.equal(pluginRoot("not json"), null);
  assert.equal(pluginRoot(JSON.stringify({ plugin_id: "devswha.herdr-web-ui" })), null);
  assert.equal(pluginRoot(JSON.stringify([{ plugin_id: "devswha.herdr-web-ui", plugin_root: "relative" }])), null);
});

test("the address onboard writes names the run's workspace and pane, and its port is read back as loopback", () => {
  assert.equal(terminalAddress(7318), "http://127.0.0.1:7318/?ws={workspace}&pane={pane}&view=terminal");
  assert.equal(loopbackPort(terminalAddress(7318)), 7318);
  assert.equal(loopbackPort("http://localhost:9000?pane={pane}"), 9000);
  assert.equal(loopbackPort("https://agents.example.ts.net/?pane={pane}"), null);
  assert.equal(loopbackPort("http://127.0.0.1.evil.example:80/"), null);
  assert.equal(loopbackPort(undefined), null);
});

test("the terminal serves tickets.herdrSession on tickets.terminal's port, and tickets on 7318 by default", () => {
  assert.deepEqual(terminalTarget({}), { session: "tickets", port: 7318 });
  assert.deepEqual(terminalTarget({ tickets: { providers: { exposure: { provider: "local", terminal: "http://127.0.0.1:7410/?ws={workspace}" } } } }).port, 7410,
    "the exposure block's address is the one the service serves, after doctor --fix moved it (A11-144)");
  assert.deepEqual(terminalTarget({ tickets: { herdrSession: "work", terminal: "http://127.0.0.1:7400/?ws={workspace}" } }), { session: "work", port: 7400 });
  assert.deepEqual(terminalTarget({ tickets: { herdrSession: "../x", terminal: "https://elsewhere/?ws={workspace}" } }), { session: "tickets", port: 7318 });
});

test("the supervisor gets HERDR_SOCKET for its session, which the plugin reads, and bun's directory first on PATH", () => {
  const program = terminalProgram({ env: { XDG_CONFIG_HOME: "/x" }, home: "/h", session: "tickets", port: 7318, root: "/r", bun: "/h/.bun/bin/bun", path: "/usr/bin" });
  assert.deepEqual(program.argv, ["/h/.bun/bin/bun", "/r/server/supervisor.ts"]);
  assert.equal(program.environment.HERDR_SOCKET, "/x/herdr/sessions/tickets/herdr.sock");
  assert.equal(program.environment.HERDR_SOCKET_PATH, undefined);
  assert.equal(program.environment.PATH, "/h/.bun/bin:/usr/bin");
  assert.equal(herdrConfigDir({ XDG_CONFIG_HOME: "relative" }, "/h"), "/h/.config/herdr");
  assert.equal(herdrSocket({}, "/h", "work"), "/h/.config/herdr/sessions/work/herdr.sock");
});

test("ticket:pair's plugin command runs under the service's own environment, so the plugin reads the directories the service runs with", () => {
  const options = { env: { XDG_CONFIG_HOME: "/x" }, home: "/h", session: "work", port: 7400, root: "/r", bun: "/h/.bun/bin/bun", path: "/usr/bin" };
  const pair = terminalPairProgram(options);
  assert.deepEqual(pair.argv, ["/h/.bun/bin/bun", "/r/scripts/plugin.ts", "pair"]);
  assert.equal(pair.workingDirectory, "/r");
  assert.deepEqual(pair.environment, terminalProgram(options).environment, "the same environment the service is started with, so the two cannot drift");
  assert.equal(pair.environment.HERDR_PLUGIN_CONFIG_DIR, pluginConfigDir("/h", "work"));
  assert.equal(pair.environment.HERDR_PLUGIN_CONFIG_DIR, "/h/.config/herdr-web-ui-work");
});

test("the pairing steps name both codes, the board's and the terminal's, and the flag that prints the terminal's", () => {
  assert.match(PAIRING_STEPS, /agent-org ticket:pair`/);
  assert.match(PAIRING_STEPS, /agent-org ticket:pair --terminal`/);
});

test("the worker terminal on this machine is its loopback port, or its own tailnet address's default port, and another machine's address is none", () => {
  const own = "https://agents.tail1234.ts.net:9444/?ws={workspace}&pane={pane}&view=terminal";
  assert.equal(localTerminalPort(terminalAddress(7400), "agents.tail1234.ts.net"), 7400, "a loopback address names its own port");
  assert.equal(localTerminalPort(own, "agents.tail1234.ts.net"), 7318, "the tailnet address of this machine is served on the default port");
  assert.equal(localTerminalPort(own, "other.tail1234.ts.net"), null, "another machine's tailnet address is not this machine's");
  assert.equal(localTerminalPort(own, null), null, "a name that cannot be read is not this machine's");
  assert.equal(localTerminalPort(null, "agents.tail1234.ts.net"), null, "no terminal is set");
  assert.equal(localTerminalPort("not a web address {pane}", "agents.tail1234.ts.net"), null);
});
