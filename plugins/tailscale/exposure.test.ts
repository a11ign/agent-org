// no-token: none -- `tailscale` is a stand-in that holds a serve config in memory
import { test } from "node:test";
import assert from "node:assert/strict";
import { createExposure, tailnetPortsOf } from "./exposure.ts";
import { createTailscale, freshState, type TailscaleState } from "./stub.ts";

const NAME = "agents.tail1234.ts.net";

const exposureOf = (state: TailscaleState, settings: Record<string, unknown> = {}) => createExposure(settings, { exec: createTailscale(state), env: { USER: "agent" } });

test("the ports are 9443 and 9444 unless tailnetPorts names others, and a value no exposure could serve on is refused by name", () => {
  assert.deepEqual(exposureOf(freshState()).ports(), { ui: 9443, terminal: 9444 });
  assert.deepEqual(exposureOf(freshState(), { tailnetPorts: { ui: 9500 } }).ports(), { ui: 9500, terminal: 9444 });
  assert.throws(() => tailnetPortsOf({ ui: 1, terminal: 1 }), /tickets\.providers\.exposure\.tailnetPorts ui and terminal must be different ports, and both are 1/);
  assert.throws(() => tailnetPortsOf({ ui: 0 }), /tailnetPorts\.ui must be a port from 1 to 65535, not 0/);
  assert.throws(() => tailnetPortsOf({ other: 1 }), /tailnetPorts must be \{ "ui": <port>, "terminal": <port> \}/);
  assert.throws(() => tailnetPortsOf("9443"), /tailnetPorts must be/);
});

test("the machine's name, hosts, origins and terminal address are the tailnet's", async () => {
  const exposure = exposureOf(freshState());
  assert.equal(await exposure.machineName(), NAME);
  assert.deepEqual(exposure.hosts({ name: NAME, port: 9443 }), [`${NAME}:9443`]);
  assert.deepEqual(exposure.origins({ name: NAME, port: 9443 }), [`https://${NAME}:9443`]);
  assert.equal(exposure.terminal({ name: NAME, port: 9444 }), `https://${NAME}:9444/?ws={workspace}&pane={pane}&view=terminal`);
});

test("the board's own serve names one HTTPS port and no funnel, and its removal names that one port with off", () => {
  const state = freshState();
  const exposure = exposureOf(state);
  assert.equal(exposure.serve(9443, 4748).status, 0);
  assert.equal(exposure.unserve(9443).status, 0);
  assert.deepEqual(state.calls, [["serve", "--bg", "--https=9443", "http://127.0.0.1:4748"], ["serve", "--https=9443", "off"]]);
});

test("a path open to the internet is served and removed with funnel commands for that one path (the event receiver's)", () => {
  const state = freshState();
  const exposure = exposureOf(state);
  assert.equal(exposure.serve(443, 8787, { path: "/webhook", funnel: true }).status, 0);
  assert.deepEqual(state.calls[0], ["funnel", "--bg", "--yes", "--https=443", "--set-path=/webhook", "http://127.0.0.1:8787"]);
  assert.deepEqual(exposure.portState(443, 8787, { path: "/webhook" }), { kind: "ours", proxy: "http://127.0.0.1:8787", funnel: true });
  assert.equal(exposure.portState(443, 9999, { path: "/webhook" }).kind, "foreign", "the same path proxying to another loopback port is not the receiver");
  assert.equal(exposure.portState(443, 8787, { path: "/other" }).kind, "free");
  assert.equal(exposure.unserve(443, { path: "/webhook", funnel: true }).status, 0);
  assert.deepEqual(state.calls.filter((args) => args.includes("off")), [["funnel", "--yes", "--https=443", "--set-path=/webhook", "off"]]);
  assert.equal(exposure.portState(443, 8787, { path: "/webhook" }).kind, "free");
});

test("a user who is not the operator is refused with Tailscale's words and the fix, in the result's refusal", () => {
  const exposure = exposureOf(freshState({ operator: false }));
  const result = exposure.serve(9443, 4748);
  assert.equal(result.status, 1);
  assert.equal(result.refusal, "`tailscale serve --bg --https=9443 http://127.0.0.1:4748` was refused for agent, who is not the operator of this machine's Tailscale: run `sudo tailscale set --operator=agent`, then start the service again");
});

test("readiness says why this machine cannot serve: Tailscale missing, stopped, or with no name; and null when it can", () => {
  assert.equal(exposureOf(freshState()).readiness(), null);
  const missing = createExposure({}, { exec: () => ({ status: null, stdout: "", stderr: "ENOENT" }), env: {} });
  assert.equal(missing.readiness(), "tailscale is not on PATH: install Tailscale, then run `tailscale up`");
  assert.match(String(exposureOf(freshState({ backend: "Stopped" })).readiness()), /Tailscale is not Running on this machine \(BackendState Stopped\): run `sudo tailscale up`/);
  assert.match(String(exposureOf(freshState({ name: null })).readiness()), /Tailscale has no DNS name for this machine/);
});

test("claim refuses a port on Funnel and a port another entry holds, naming the setting to change, and frees one the board holds", () => {
  const state = freshState();
  const exposure = exposureOf(state);
  assert.equal(exposure.claim(9443, 4748, "ui"), null, "a free port");
  exposure.serve(9443, 4748);
  assert.equal(exposure.claim(9443, 4748, "ui"), null, "the board's own entry");
  assert.equal(exposure.claim(9443, 4747, "ui"), "port 9443 already serves http://127.0.0.1:4748 on the tailnet, and the board will not replace it: set `tickets.providers.exposure.tailnetPorts.ui` to a port nothing serves");
  state.web[`${NAME}:9444`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:7318" } } };
  state.funnel[`${NAME}:9444`] = true;
  assert.equal(exposure.claim(9444, 7318, "terminal"), "port 9444 is on Funnel, which makes it public, and the board is never served on Funnel: set `tickets.providers.exposure.tailnetPorts.terminal` to a port nothing serves");
});

test("claim says why it cannot tell when Tailscale cannot answer, and portState throws that sentence", () => {
  const exposure = exposureOf(freshState({ backend: "Stopped" }));
  assert.match(String(exposure.claim(9443, 4748, "ui")), /Tailscale is not Running/);
  assert.throws(() => exposure.portState(9443, 4748), /Tailscale is not Running/);
});

test("served lists the entries the machine holds, as host:port, in the order Tailscale lists them", () => {
  const state = freshState();
  const exposure = exposureOf(state);
  assert.deepEqual(exposure.served(), []);
  exposure.serve(9443, 4748);
  exposure.serve(8443, 8788);
  assert.deepEqual(exposure.served(), [`${NAME}:9443`, `${NAME}:8443`]);
});
