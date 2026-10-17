// no-token: none -- pure functions over strings; nothing is read or run
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveTerminal, herdrConfigDir, herdrSocket, loopbackPort, pluginRoot, terminalAddress, terminalProgram, terminalTarget } from "./terminal.ts";

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
