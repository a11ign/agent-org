// no-token: none -- modules are imported through an injected `import`; the one real program is `node --version`, and the one real file is a scratch file
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { resolveProviders } from "../ticket-mode/providers.ts";
import { activatePlugins, forgetActivation, loadActive, PluginActivationRefusal, realExec, realMode, realPluginDeps } from "./active.ts";
import { fakePluginDeps } from "./fakes/deps.ts";
import { createFakeTracker, fakeTicket } from "./fakes/tracker.ts";
import type { PluginModule } from "./manifest.ts";
import { buildCatalog, defaultCatalog, type PackageFiles } from "./registry.ts";

const ROOT = "/checkout";
const checkout = (concerns: Readonly<Record<string, string>>): PackageFiles => {
  const manifests = new Map(Object.entries(concerns).map(([name, concern]) => [`${ROOT}/plugins/${name}/package.json`, JSON.stringify({ agentOrg: { concern, contract: "1.1", description: `A ${concern}.`, entry: "index.ts" } })]));
  return { directories: (path) => (path === `${ROOT}/plugins` ? Object.keys(concerns).sort() : []), text: (path) => manifests.get(path) ?? null, isFile: (path) => path.endsWith("/index.ts") };
};
const catalogOf = (concerns: Record<string, string>) => buildCatalog({ root: ROOT, files: checkout(concerns), pins: {} });
const host = (providers: Record<string, unknown>) => ({ tickets: { providers } });
const urlOf = (name: string) => pathToFileURL(`${ROOT}/plugins/${name}/index.ts`).href;
const moduleOf = (create: PluginModule["create"]): PluginModule => ({ create, doctorChecks: () => [], onboardSteps: [] });
const importing = (modules: Readonly<Record<string, unknown>>) => async (url: string) => modules[url];

test("the tracker core runs is the enabled tracker plugin's source, built with the deps core gives it", async () => {
  const catalog = catalogOf({ "my-tracker": "tracker" });
  const providers = resolveProviders(host({ tracker: { provider: "my-tracker" } }), catalog);
  const tracker = createFakeTracker([fakeTicket("MY-1")]);
  const seen: unknown[] = [];
  const deps = fakePluginDeps({ pick: { team: "MY" } });
  const active = await loadActive(providers, catalog, deps, importing({ [urlOf("my-tracker")]: moduleOf((settings, given) => { seen.push([settings, given.pick]); return tracker; }) }));
  assert.equal(active.tracker(), tracker);
  assert.deepEqual(seen, [[{}, { team: "MY" }]], "create is given the block's settings, and the board's pick scope through the deps");
  assert.deepEqual(active.loaded.map(({ plugin }) => plugin.name), ["my-tracker"]);
});

test("a plugin the loader refuses refuses the start, naming the concern, the plugin and why; a create that throws is one of them", async () => {
  const catalog = catalogOf({ "my-tracker": "tracker" });
  const providers = resolveProviders(host({ tracker: { provider: "my-tracker" } }), catalog);
  await assert.rejects(loadActive(providers, catalog, fakePluginDeps(), importing({ [urlOf("my-tracker")]: moduleOf(() => { throw new Error("ticket mode: no Linear key in the Keychain under agent-org-linear"); }) })),
    (error: unknown) => error instanceof PluginActivationRefusal && error.message === "the tracker plugin my-tracker was refused: ticket mode: no Linear key in the Keychain under agent-org-linear");
  await assert.rejects(loadActive(providers, catalog, fakePluginDeps(), importing({ [urlOf("my-tracker")]: { create: () => ({}) } })),
    /the tracker plugin my-tracker was refused: plugin my-tracker: index\.ts must export create, doctorChecks and onboardSteps/);
});

test("a tracker block that names a plugin with no code to run on a host (a fake) is refused when the tracker is asked for, naming it", async () => {
  const catalog = buildCatalog({ root: "/none", files: { directories: () => [], text: () => null, isFile: () => false }, pins: {} });
  const providers = resolveProviders(host({ tracker: { provider: "fake-tracker" } }), catalog);
  const active = await loadActive(providers, catalog, fakePluginDeps(), importing({}));
  assert.throws(() => active.tracker(), (error: unknown) => error instanceof PluginActivationRefusal
    && error.message === "the tracker is fake-tracker, which has no code to run on a host: name a bundled tracker plugin in tickets.providers.tracker (`agent-org plugin list`)");
});

test("this checkout's Linear plugin loads from disk for the default host, and activation is once per process", async () => {
  forgetActivation();
  const providers = resolveProviders({ tickets: {} });
  const deps = fakePluginDeps({ exec: () => ({ status: 0, stdout: "lin_api_x\n", stderr: "" }) });
  const first = activatePlugins(providers, defaultCatalog(), deps);
  const second = activatePlugins(resolveProviders(host({ tracker: { provider: "linear", workingState: "x" } })), defaultCatalog(), deps);
  assert.equal(first, second, "the second call returns the first's activation, whatever it is given");
  const active = await first;
  assert.deepEqual(active.loaded.map(({ plugin }) => [plugin.name, plugin.where]), [["linear", "bundled"]]);
  assert.equal(typeof active.tracker().assigned, "function");
  forgetActivation();
  assert.notEqual(activatePlugins(providers, defaultCatalog(), deps), first, "forgetting starts again");
  forgetActivation();
});

test("the real seams: a program that runs answers its status and output, one that cannot start answers no status, and a file's mode is its permission bits", () => {
  const ran = realExec("node", ["--version"]);
  assert.deepEqual([ran.status, /^v\d+\./.test(ran.stdout)], [0, true]);
  assert.equal(realExec("agent-org-no-such-program", []).status, null);
  const dir = tmpDir("active-");
  const file = join(dir, "k");
  writeFileSync(file, "secret");
  chmodSync(file, 0o600);
  assert.equal(realMode(file), 0o600);
  assert.equal(realMode(join(dir, "absent")), null);
  const deps = realPluginDeps({ env: { A: "b" }, stateDir: dir, pick: "assigned" });
  assert.deepEqual([deps.env, deps.stateDir, deps.pick, deps.readFile(file)], [{ A: "b" }, dir, "assigned", "secret"]);
});
