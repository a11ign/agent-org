// no-token: none -- the plugin is handed a stand-in for `tailscale` and fake deps
//
// THE PLUGIN AS CORE USES IT (A11-162): its manifest is read by the registry without importing it, the loader builds its exposure from the block's settings, and its rows, steps and release
// are what the code half exports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { loadActive } from "../../src/plugins/active.ts";
import { defaultCatalog, pluginNamed } from "../../src/plugins/registry.ts";
import { resolveProviders } from "../../src/ticket-mode/providers.ts";
import { create, doctorChecks, onboardSteps, release } from "./index.ts";
import { createTailscale, freshState } from "./stub.ts";

test("the registry finds the plugin as the bundled exposure tailscale, from its manifest alone, and the manifest brings the settings the Settings page drew", () => {
  const plugin = pluginNamed(defaultCatalog(), "tailscale");
  assert.ok(plugin !== undefined);
  assert.deepEqual([plugin.concern, plugin.where, plugin.contract, plugin.entry], ["exposure", "bundled", "1.1", "index.ts"]);
  assert.deepEqual(Object.keys(plugin.settings), ["port", "uiPort", "terminal", "tailnetPorts", "tailnetPorts.ui", "tailnetPorts.terminal"]);
  for (const [name, entry] of Object.entries(plugin.settings)) assert.equal(entry.key, `tickets.providers.exposure.${name}`);
});

test("the tailnet ports' entries name the services that read them: the page and the terminal, and not the instance", () => {
  const plugin = pluginNamed(defaultCatalog(), "tailscale")!;
  for (const name of ["tailnetPorts", "tailnetPorts.ui", "tailnetPorts.terminal"]) {
    const { edit } = plugin.settings[name];
    assert.ok(edit.editable);
    assert.equal(edit.unit, "agent-org-ui.service and agent-org-terminal.service", name);
  }
});

test("the plugin has no dependencies and its entry exports what the loader needs, and release", () => {
  assert.equal(typeof create, "function");
  assert.equal(typeof doctorChecks, "function");
  assert.equal(typeof release, "function");
  assert.deepEqual(onboardSteps.map(({ name }) => name), ["tailscale installed", "tailscale operator", "tailnet ports"]);
});

test("the loader builds the plugin's exposure for a host that names it, with the block's own ports", async () => {
  const providers = resolveProviders({ tickets: { providers: { exposure: { provider: "tailscale", tailnetPorts: { ui: 9500, terminal: 9501 } } } } });
  const active = await loadActive(providers, defaultCatalog(), fakePluginDeps({ exec: createTailscale(freshState()), env: { USER: "agent" } }), undefined, ["exposure"]);
  const exposure = active.exposure();
  assert.deepEqual(exposure.ports(), { ui: 9500, terminal: 9501 });
  assert.equal(await exposure.machineName(), "agents.tail1234.ts.net");
});

test("the doctor rows are the plugin's, and a host that names a stopped Tailscale fails its row", async () => {
  const rows = await doctorChecks({ uiPort: 4748 }, fakePluginDeps({ exec: createTailscale(freshState({ backend: "Stopped" })) }));
  assert.deepEqual(rows.map(({ name, ok }) => [name, ok]), [["tailscale", false]]);
});
