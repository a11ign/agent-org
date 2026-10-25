// no-token: none -- the plugin is handed fake deps: no GitHub CLI, program, file or network is touched
//
// THE PLUGIN AS CORE USES IT (A11-160): its manifest is read by the registry without importing it, and brings the settings the Settings page drew for the code host when they were core's;
// the loader builds its code host for the default host; and its entry exports what the loader needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA } from "../../src/ticket-mode/config-schema.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { importEnabled, loadEnabled } from "../../src/plugins/loader.ts";
import { defaultCatalog, pluginNamed } from "../../src/plugins/registry.ts";
import { defaultSchema } from "../../src/plugins/schema.ts";
import { resolveProviders } from "../../src/ticket-mode/providers.ts";
import { create, doctorChecks, keep, onboardSteps } from "./index.ts";

test("the registry finds the plugin as the bundled code host github, from its manifest alone", () => {
  const plugin = pluginNamed(defaultCatalog(), "github");
  assert.ok(plugin !== undefined);
  assert.deepEqual([plugin.concern, plugin.where, plugin.contract, plugin.entry], ["codeHost", "bundled", "1.22", "index.ts"]);
  assert.deepEqual(plugin.tooling, { mcpServers: [], connectors: [], skills: [] }, "workers need nothing beyond the gh they already have");
  assert.deepEqual(defaultCatalog().refusals, []);
});

test("the manifest brings the settings the Settings page drew for the code host, in the order it drew them, and core's schema holds none of them", () => {
  const plugin = pluginNamed(defaultCatalog(), "github")!;
  assert.deepEqual(Object.keys(plugin.settings), [
    "identity", "identity.<role>", "identity.<role>.mode", "identity.<role>.appId", "identity.<role>.keyPath", "identity.<role>.installationId", "identity.<role>.slug",
    "gh", "gh.workers", "gh.leads", "gh.leadsHeader", "gh.leadsWorkspaces", "gh.leadsWorkspaces[].id", "gh.leadsWorkspaces[].role", "stack",
  ]);
  for (const [name, entry] of Object.entries(plugin.settings)) assert.equal(entry.key, `tickets.providers.codeHost.${name}`);
  const coreKeys = new Set(SCHEMA.map(({ key }) => key));
  for (const { key } of Object.values(plugin.settings)) assert.equal(coreKeys.has(key), false, `${key} is still in core's schema`);
  const keys = defaultSchema().map(({ key }) => key);
  const enabled = keys.indexOf("tickets.providers.codeHost.enabled");
  assert.deepEqual(keys.slice(enabled + 1, enabled + 1 + 15), Object.values(plugin.settings).map(({ key }) => key), "the page draws them straight after the block's own switch");
  assert.equal(plugin.settings.identity.group, "Code host");
  assert.equal(plugin.settings["identity.<role>.keyPath"].secret, "path", "a key file's path is a secret the page does not read");
});

test("the plugin has no dependencies and its entry exports what the loader needs", () => {
  assert.equal(typeof create, "function");
  assert.equal(typeof doctorChecks, "function");
  assert.equal(typeof keep, "function");
  assert.deepEqual(onboardSteps.map(({ name }) => name), ["gh stack extension", "App keys"]);
});

test("the loader loads the plugin for the default host, which names no code host block, and builds its code host without running anything", async () => {
  const providers = resolveProviders({ tickets: {} });
  assert.deepEqual([providers.blocks.codeHost.provider, providers.blocks.codeHost.enabled], ["github", true], "a host file with no code host block is the bundled github, enabled");
  const started: string[] = [];
  const result = await loadEnabled(providers, defaultCatalog(), fakePluginDeps({ exec: (file) => { started.push(file); return { status: 0, stdout: "", stderr: "" }; } }));
  const github = result.loaded.find(({ plugin }) => plugin.name === "github");
  assert.ok(github !== undefined, "the loader loaded the code host");
  assert.equal(typeof (github.implementation as { readPullFeedback: unknown }).readPullFeedback, "function");
  assert.equal(started.includes("gh"), false, "creating the code host runs no gh: a host with no gh still starts");
});

test("a host file that names provider github with settings reads them, and one that names another provider is refused, naming the choices", () => {
  const named = resolveProviders({ tickets: { providers: { codeHost: { provider: "github", stack: false, gh: { workers: "/w", leads: "/l" } } } } });
  assert.deepEqual([named.blocks.codeHost.settings.stack.value, named.blocks.codeHost.settings.gh.value], [false, { workers: "/w", leads: "/l" }]);
  assert.throws(() => resolveProviders({ tickets: { providers: { codeHost: { provider: "gitlab" } } } }), /tickets\.providers\.codeHost\.provider.*"github"/);
  assert.throws(() => resolveProviders({ tickets: { providers: { codeHost: { provider: "github", bogus: 1 } } } }), /`tickets\.providers\.codeHost\.bogus` in the host file is not a setting of github: its settings are provider, enabled, identity, gh, stack/);
});

test("the old gh and github.identity keys are read as the plugin's settings, as before the move", () => {
  const providers = resolveProviders({ gh: { workers: "/w", leads: "/l" }, github: { identity: { reviewer: { mode: "user-accounts" } } }, tickets: {} });
  assert.deepEqual([providers.blocks.codeHost.settings.gh.value, providers.blocks.codeHost.settings.identity.value], [{ workers: "/w", leads: "/l" }, { reviewer: { mode: "user-accounts" } }]);
  assert.deepEqual(providers.aliases.map(({ old }) => old).sort(), ["gh", "github.identity"]);
});

test("github is the only code host: disabling it is refused by name, and importing the enabled plugins builds none of them", async () => {
  assert.throws(() => resolveProviders({ tickets: { providers: { codeHost: { provider: "github", enabled: false } } } }), /github is the only code host, and exactly one code host must be enabled/);
  let created = 0;
  const imported = await importEnabled(resolveProviders({ tickets: {} }), defaultCatalog(), async (url) => {
    created += 1;
    return import(url);
  });
  assert.deepEqual(imported.refusals, []);
  assert.deepEqual(imported.modules.map(({ plugin }) => plugin.name).sort(), ["github", "linear", "local"], "the default host also enables the bundled exposure (A11-162), which an update imports to ask what it keeps");
  assert.equal(created, 3);
});
