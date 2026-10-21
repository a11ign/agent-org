// no-token: none -- no module is imported: the loader is handed an import that records the address it was asked for
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolveProviders } from "../ticket-mode/providers.ts";
import { importEnabled, loadEnabled, settingsOfBlock } from "./loader.ts";
import type { PluginDeps, PluginModule } from "./manifest.ts";
import { fakePluginDeps } from "./fakes/deps.ts";
import { buildCatalog, type PackageFiles } from "./registry.ts";

const ROOT = "/checkout";
const DEPS: PluginDeps = fakePluginDeps();

/** A checkout holding bundled plugins by directory name, each of the concern named, every entry present. */
function checkout(concerns: Readonly<Record<string, string>>, contract = "1.0"): PackageFiles {
  const manifests = new Map(Object.entries(concerns).map(([name, concern]) => [`${ROOT}/plugins/${name}/package.json`,
    JSON.stringify({ agentOrg: { concern, contract, description: `A ${concern}.`, entry: "index.ts" } })]));
  return { directories: (path) => (path === `${ROOT}/plugins` ? Object.keys(concerns).sort() : []), text: (path) => manifests.get(path) ?? null, isFile: (path) => path.endsWith("/index.ts") };
}

/** The catalog of a checkout with no pins, so a bundled plugin may be enabled; and the imports a loader makes, recorded. */
const catalogOf = (concerns: Record<string, string>, contract?: string) => buildCatalog({ root: ROOT, files: checkout(concerns, contract), pins: {} });
const host = (providers: Record<string, unknown>) => ({ tickets: { providers } });

function moduleOf(create: PluginModule["create"] = () => ({})): PluginModule {
  return { create, doctorChecks: () => [], onboardSteps: [] };
}

function recorder(modules: Readonly<Record<string, unknown>>) {
  const urls: string[] = [];
  return { urls, importModule: async (url: string) => { urls.push(url); return modules[url]; } };
}

const urlOf = (name: string) => pathToFileURL(`${ROOT}/plugins/${name}/index.ts`).href;

test("the loader imports only the bundled plugins a host enables, by file URL, and calls create with the block's settings and deps", async () => {
  const catalog = catalogOf({ "my-tracker": "tracker", "my-publisher": "publisher" });
  const providers = resolveProviders(host({ tracker: { provider: "my-tracker" }, publish: { provider: "none" } }), catalog);
  const created: unknown[] = [];
  const { urls, importModule } = recorder({ [urlOf("my-tracker")]: moduleOf((settings, deps) => { created.push([settings, deps]); return "the tracker"; }) });
  const result = await loadEnabled(providers, catalog, DEPS, importModule);
  assert.deepEqual(urls, [urlOf("my-tracker")], "my-publisher is not enabled, so its code is not read");
  assert.deepEqual(created, [[{}, DEPS]]);
  assert.deepEqual(result.loaded.map(({ plugin, implementation }) => [plugin.name, implementation]), [["my-tracker", "the tracker"]]);
  assert.deepEqual(result.refusals, []);
});

test("a disabled plugin's code is never imported, though its block names it and keeps its settings", async () => {
  const catalog = catalogOf({ "my-publisher": "publisher" });
  const providers = resolveProviders(host({ publish: { provider: "my-publisher", enabled: false } }), catalog);
  const { urls, importModule } = recorder({});
  const result = await loadEnabled(providers, catalog, DEPS, importModule);
  assert.deepEqual(urls, []);
  assert.deepEqual(result, { loaded: [], unbuilt: [], refusals: [] });
});

test("a built-in is skipped, since core runs it, and so is a fake", async () => {
  const catalog = buildCatalog({ root: ROOT, files: checkout({}), pins: {} });
  const providers = resolveProviders(host({ publish: { provider: "slack" }, reviewer: { provider: "fake-reviewer" }, exposure: { provider: "tailscale" } }), catalog);
  const { urls, importModule } = recorder({});
  assert.deepEqual(await loadEnabled(providers, catalog, DEPS, importModule), { loaded: [], unbuilt: [], refusals: [] });
  assert.deepEqual(urls, []);
});

test("a plugin's settings are the values its block holds, and a setting the file does not hold is absent", () => {
  const providers = resolveProviders(host({ publish: { provider: "slack", run: "post {prs} into {dir}", model: "sonnet" } }));
  assert.deepEqual(settingsOfBlock(providers.blocks.publish), { run: "post {prs} into {dir}", model: "sonnet" });
});

test("the loader refuses an unsupported contract major by name, and imports nothing of that plugin", async () => {
  const readable = catalogOf({ "my-tracker": "tracker" });
  const providers = resolveProviders(host({ tracker: { provider: "my-tracker" } }), readable);
  const unread = catalogOf({ "my-tracker": "tracker" }, "2.0");
  const { urls, importModule } = recorder({ [urlOf("my-tracker")]: moduleOf() });
  const result = await loadEnabled(providers, unread, DEPS, importModule);
  assert.deepEqual(urls, []);
  assert.deepEqual(result.refusals, [{ plugin: "my-tracker", concern: "tracker", why: "plugin my-tracker implements tracker contract 2.0; this agent-org reads tracker 1.x: update agent-org, or use a plugin of a major it reads" }]);
});

test("a plugin whose entry lacks create, doctorChecks or onboardSteps is refused by name, and the others still load", async () => {
  const catalog = catalogOf({ "bad-tracker": "tracker", "good-publisher": "publisher" });
  const providers = resolveProviders(host({ tracker: { provider: "bad-tracker" }, publish: { provider: "good-publisher" } }), catalog);
  const { importModule } = recorder({ [urlOf("bad-tracker")]: { create: () => ({}) }, [urlOf("good-publisher")]: moduleOf(() => "the publisher") });
  const result = await loadEnabled(providers, catalog, DEPS, importModule);
  assert.deepEqual(result.loaded.map(({ plugin }) => plugin.name), ["good-publisher"]);
  assert.deepEqual(result.refusals, [{ plugin: "bad-tracker", concern: "tracker", why: "plugin bad-tracker: index.ts must export create, doctorChecks and onboardSteps" }]);
});

test("a plugin whose create throws is one refusal naming it", async () => {
  const catalog = catalogOf({ "my-tracker": "tracker" });
  const providers = resolveProviders(host({ tracker: { provider: "my-tracker" } }), catalog);
  const { importModule } = recorder({ [urlOf("my-tracker")]: moduleOf(() => { throw new Error("no key at /k/linear"); }) });
  const result = await loadEnabled(providers, catalog, DEPS, importModule);
  assert.deepEqual(result.refusals, [{ plugin: "my-tracker", concern: "tracker", why: "no key at /k/linear" }]);
  assert.deepEqual(result.unbuilt.map(({ plugin }) => plugin.name), ["my-tracker"], "its module imported, so doctor can still run its checks, which say why create threw");
  assert.deepEqual(result.loaded, []);
});

test("A11-160: importing the enabled plugins imports their entries and builds none: create is never called, a disabled plugin and a built-in are not read, and a refused one is named", async () => {
  const catalog = catalogOf({ "my-tracker": "tracker", "off-publisher": "publisher", "bad-reviewer": "reviewer" });
  const providers = resolveProviders(host({ tracker: { provider: "my-tracker" }, publish: { provider: "off-publisher", enabled: false }, reviewer: { provider: "bad-reviewer" }, exposure: { provider: "tailscale" } }), catalog);
  let built = 0;
  const { urls, importModule } = recorder({ [urlOf("my-tracker")]: moduleOf(() => { built += 1; return "the tracker"; }), [urlOf("bad-reviewer")]: { create: () => ({}) } });
  const result = await importEnabled(providers, catalog, importModule);
  assert.deepEqual(urls, [urlOf("my-tracker"), urlOf("bad-reviewer")], "the disabled publisher and the built-in exposure are not read");
  assert.equal(built, 0, "nothing is built: a tracker's key is not read to ask what it keeps");
  assert.deepEqual(result.modules.map(({ plugin }) => plugin.name), ["my-tracker"]);
  assert.deepEqual(result.refusals, [{ plugin: "bad-reviewer", concern: "reviewer", why: "plugin bad-reviewer: index.ts must export create, doctorChecks and onboardSteps" }]);
});

test("A11-160: importing an unsupported contract major is refused by name, and imports nothing of that plugin", async () => {
  const readable = catalogOf({ "my-tracker": "tracker" });
  const providers = resolveProviders(host({ tracker: { provider: "my-tracker" } }), readable);
  const { urls, importModule } = recorder({ [urlOf("my-tracker")]: moduleOf() });
  const result = await importEnabled(providers, catalogOf({ "my-tracker": "tracker" }, "2.0"), importModule);
  assert.deepEqual([urls, result.modules, result.refusals.map(({ plugin }) => plugin)], [[], [], ["my-tracker"]]);
});
