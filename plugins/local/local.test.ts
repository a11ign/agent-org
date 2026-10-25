// no-token: none -- the plugin serves nothing and asks nothing of the machine; its checks are handed a probe that answers from a list
//
// THE LOCAL EXPOSURE (A11-162): the concern's default. It passes the exposure contract's suite as a loopback-only exposure, answers nothing a network would need, refuses to serve, and has
// the rows doctor shows for a board on loopback. It never calls Tailscale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runExposureConformance } from "../../src/plugins/conformance/exposure.ts";
import { loadActive } from "../../src/plugins/active.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import type { ProbeRequest } from "../../src/plugins/manifest.ts";
import { defaultCatalog, pluginNamed } from "../../src/plugins/registry.ts";
import { resolveProviders } from "../../src/ticket-mode/providers.ts";
import { localChecks } from "./checks.ts";
import { createExposure, LOOPBACK_ONLY } from "./exposure.ts";
import { create, doctorChecks, onboardSteps } from "./index.ts";

test("the local exposure passes the exposure contract suite as a loopback-only exposure, serving nothing, and every check runs", async () => {
  const { passed, skipped } = await runExposureConformance(createExposure(), { sandboxed: true });
  assert.deepEqual(skipped, []);
  assert.equal(passed.length, 9);
});

test("it answers no name, no hosts, no origins, no ports and no terminal address, and refuses to serve or unserve, saying why", async () => {
  const exposure = create({}, fakePluginDeps());
  assert.equal(await exposure.machineName(), null);
  assert.deepEqual([exposure.hosts({ name: "x", port: 1 }), exposure.origins({ name: "x", port: 1 }), exposure.terminal({ name: "x", port: 1 }), exposure.ports(), exposure.served()], [[], [], null, null, []]);
  for (const result of [exposure.serve(9443, 4748), exposure.unserve(9443), exposure.serve(443, 8787, { path: "/webhook", funnel: true })]) {
    assert.deepEqual([result.status, result.refusal], [1, LOOPBACK_ONLY]);
  }
  assert.equal(LOOPBACK_ONLY, "local serves on loopback only");
  assert.deepEqual([exposure.readiness(), exposure.claim(9443, 4748, "ui"), exposure.portState(9443, 4748)], [null, null, { kind: "free", proxy: null, funnel: false }]);
});

test("the registry finds the plugin as the bundled exposure local, and the manifest brings port, uiPort and terminal, which tailscale declares too", () => {
  const plugin = pluginNamed(defaultCatalog(), "local");
  assert.ok(plugin !== undefined);
  assert.deepEqual([plugin.concern, plugin.where, plugin.contract, plugin.entry], ["exposure", "bundled", "1.1", "index.ts"]);
  assert.deepEqual(Object.keys(plugin.settings), ["port", "uiPort", "terminal"]);
  const shared = pluginNamed(defaultCatalog(), "tailscale")!;
  for (const name of ["port", "uiPort", "terminal"]) assert.deepEqual(plugin.settings[name], shared.settings[name], `${name} is described once, and the same for both exposures`);
  assert.deepEqual(onboardSteps, [], "loopback needs nothing installed");
});

test("a host that names no exposure, or switches it off, runs this plugin: an exposure always resolves", async () => {
  for (const host of [{}, { tickets: { providers: { exposure: { provider: "tailscale", enabled: false, tailnetPorts: { ui: 9500, terminal: 9501 } } } } }]) {
    const active = await loadActive(resolveProviders(host), defaultCatalog(), fakePluginDeps(), undefined, ["exposure"]);
    assert.equal(active.exposure().ports(), null, JSON.stringify(host));
    assert.equal(await active.exposure().machineName(), null);
  }
});

/** Deps whose probe answers for the ports in `answering`, and records what it was asked. */
function probing(answering: readonly number[]) {
  const asked: ProbeRequest[] = [];
  return { asked, deps: fakePluginDeps({ probe: async (request) => { asked.push(request); return answering.includes(request.port) ? 200 : null; } }) };
}

test("the instance and the page answer on 127.0.0.1, by the ports the block names or the defaults", async () => {
  const defaults = probing([4747, 4748]);
  const rows = await localChecks({}, defaults.deps);
  assert.deepEqual(rows.map(({ name, ok }) => [name, ok]), [["local ports", true], ["local terminal", true]]);
  assert.equal(rows[0].detail, "instance answers on 127.0.0.1:4747, ui answers on 127.0.0.1:4748");
  assert.deepEqual(defaults.asked.map(({ host, port, tls }) => [host, port, tls]), [["127.0.0.1", 4747, false], ["127.0.0.1", 4748, false]]);
  const named = probing([4800, 4801]);
  assert.equal((await localChecks({ port: 4800, uiPort: 4801 }, named.deps))[0].ok, true);
});

test("a port that does not answer is the failure, naming it and the service to start", async () => {
  const [ports] = await localChecks({ port: 4800, uiPort: 4801 }, probing([4800]).deps);
  assert.equal(ports.ok, false);
  assert.equal(ports.detail, "nothing answers on 127.0.0.1 for the ui (port 4801)");
  assert.equal(ports.fix, "run `agent-org start ui`");
  const [both] = await localChecks({}, probing([]).deps);
  assert.equal(both.detail, "nothing answers on 127.0.0.1 for the instance (port 4747) and the ui (port 4748)");
  assert.equal(both.fix, "run `agent-org start instance`");
});

test("the terminal address is this machine's loopback, unset, or another machine's, and each is said", async () => {
  const row = async (terminal: unknown) => (await localChecks({ terminal }, probing([4747, 4748]).deps))[1];
  assert.equal((await row("http://127.0.0.1:7318/?ws={workspace}&pane={pane}")).detail, "the terminal address is on this machine's loopback, port 7318");
  assert.equal((await row(undefined)).detail, "no terminal address is set, so the board links no run to a terminal");
  assert.equal((await row("https://other.example/?ws={workspace}")).detail, "the terminal address is https://other.example/?ws={workspace}, served by another machine");
});

test("the plugin never calls a program: not tailscale, not any other", async () => {
  const deps = fakePluginDeps({ exec: () => { throw new Error("the local plugin ran a program"); }, probe: async () => 200 });
  create({}, deps);
  await doctorChecks({}, deps);
});
