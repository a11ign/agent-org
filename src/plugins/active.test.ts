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
import { createFakeCodeHost } from "./fakes/code-host.ts";
import { createFakeTracker, fakeTicket } from "./fakes/tracker.ts";
import type { PluginModule } from "./manifest.ts";
import { buildCatalog, defaultCatalog, type PackageFiles } from "./registry.ts";

const ROOT = "/checkout";
const checkout = (concerns: Readonly<Record<string, string>>): PackageFiles => {
  const manifests = new Map(Object.entries(concerns).map(([name, concern]) => [`${ROOT}/plugins/${name}/package.json`, JSON.stringify({ agentOrg: { concern, contract: concern === "codeHost" ? "2.0" : "1.1", description: `A ${concern}.`, entry: "index.ts" } })]));
  return { directories: (path) => (path === `${ROOT}/plugins` ? Object.keys(concerns).sort() : []), text: (path) => manifests.get(path) ?? null, isFile: (path) => path.endsWith("/index.ts") };
};
const catalogOf = (concerns: Record<string, string>) => buildCatalog({ root: ROOT, files: checkout(concerns) });
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

test("a block that names a plugin with no code to run on a host (a fake) is refused when its implementation is asked for, naming the block's concern and the plugin", async () => {
  const catalog = buildCatalog({ root: "/none", files: { directories: () => [], text: () => null, isFile: () => false } });
  const refusals = { tracker: ["tracker", "fake-tracker", "tracker"], codeHost: ["code host", "fake-codeHost", "codeHost"] } as const;
  for (const [concern, [label, fake, block]] of Object.entries(refusals)) {
    const providers = resolveProviders(host({ [block]: { provider: fake } }), catalog);
    const active = await loadActive(providers, catalog, fakePluginDeps(), importing({}));
    assert.throws(() => (concern === "tracker" ? active.tracker() : active.codeHost()), (error: unknown) => error instanceof PluginActivationRefusal
      && error.message === `the ${label} is ${fake}, which has no code to run on a host: name a bundled ${label} plugin in tickets.providers.${block} (\`agent-org plugin list\`)`);
  }
});

test("this checkout's Linear, GitHub and local plugins load from disk for the default host, and activation is once per process", async () => {
  forgetActivation();
  const providers = resolveProviders({ tickets: {} });
  const deps = fakePluginDeps({ exec: () => ({ status: 0, stdout: "lin_api_x\n", stderr: "" }) });
  const first = activatePlugins(providers, defaultCatalog(), deps);
  const second = activatePlugins(resolveProviders(host({ tracker: { provider: "linear", workingState: "x" } })), defaultCatalog(), deps);
  assert.equal(first, second, "the second call returns the first's activation, whatever it is given");
  const active = await first;
  assert.deepEqual(active.loaded.map(({ plugin }) => [plugin.name, plugin.where]), [["linear", "bundled"], ["github", "bundled"], ["local", "bundled"]]);
  assert.equal(active.exposure().ports(), null, "the exposure is the bundled local's, which serves on loopback only");
  assert.equal(typeof active.tracker().assigned, "function");
  assert.equal(typeof active.codeHost().readPullFeedback, "function", "the code host is the bundled github's, built for the default host");
  forgetActivation();
  assert.notEqual(activatePlugins(providers, defaultCatalog(), deps), first, "forgetting starts again");
  forgetActivation();
});

test("the real seams: a program that runs answers its status and output, one that cannot start answers no status, and a file's mode is its permission bits", () => {
  const ran = realExec("node", ["--version"]);
  assert.deepEqual([ran.status, /^v\d+\./.test(ran.stdout)], [0, true]);
  const absent = realExec("agent-org-no-such-program", []);
  assert.equal(absent.status, null);
  assert.match(absent.stderr, /ENOENT/, "a program that cannot start says why, as the runner onboard used to");
  const dir = tmpDir("active-");
  const file = join(dir, "k");
  writeFileSync(file, "secret");
  chmodSync(file, 0o600);
  assert.equal(realMode(file), 0o600);
  assert.equal(realMode(join(dir, "absent")), null);
  const deps = realPluginDeps({ env: { A: "b" }, stateDir: dir, pick: "assigned" });
  assert.deepEqual([deps.env, deps.stateDir, deps.pick, deps.readFile(file), deps.clones], [{ A: "b" }, dir, "assigned", "secret", {}]);
  assert.deepEqual(realPluginDeps({ env: {}, stateDir: dir, pick: "assigned", clones: { netbox: "/src/netbox" } }).clones, { netbox: "/src/netbox" });
});

test("A11-160: a program runs with the environment it is given laid over this process's, for that run only, and a long answer is not cut off as a failure", () => {
  const seen = realExec("node", ["-e", "process.stdout.write(process.env.AGENT_ORG_EXEC_PROBE ?? 'unset')"], { env: { AGENT_ORG_EXEC_PROBE: "set-for-the-run" } });
  assert.deepEqual([seen.status, seen.stdout], [0, "set-for-the-run"]);
  assert.equal(process.env.AGENT_ORG_EXEC_PROBE, undefined, "this process's environment is untouched");
  assert.equal(realExec("node", ["-e", "process.stdout.write(process.env.AGENT_ORG_EXEC_PROBE ?? 'unset')"]).stdout, "unset");
  const long = realExec("node", ["-e", "process.stdout.write('x'.repeat(5 * 1024 * 1024))"]);
  assert.deepEqual([long.status, long.stdout.length], [0, 5 * 1024 * 1024], "five megabytes is more than the default buffer of one, and a listing that long is an answer");
});

test("A11-160 (step 5): the variables a program is told to run without are taken off its environment for that run, and only those", () => {
  const probe = ["-e", "process.stdout.write(`${process.env.AGENT_ORG_EXEC_GONE ?? 'unset'}/${process.env.AGENT_ORG_EXEC_KEPT ?? 'unset'}`)"];
  process.env.AGENT_ORG_EXEC_GONE = "present";
  process.env.AGENT_ORG_EXEC_KEPT = "present";
  try {
    assert.equal(realExec("node", probe, { withoutEnv: ["AGENT_ORG_EXEC_GONE"] }).stdout, "unset/present", "the merge queue's gh runs without the git variables a hook sets, and with the rest");
    assert.equal(realExec("node", probe).stdout, "present/present", "and a run that names none keeps them all");
    assert.equal(process.env.AGENT_ORG_EXEC_GONE, "present", "this process's environment is untouched");
  } finally {
    delete process.env.AGENT_ORG_EXEC_GONE;
    delete process.env.AGENT_ORG_EXEC_KEPT;
  }
});

test("A11-160: an activation narrowed to the code host builds it alone: the tracker's create, which reads a key, is never called, and a start that asks for everything is refused by it", async () => {
  const catalog = catalogOf({ "my-tracker": "tracker", "my-host": "codeHost" });
  const providers = resolveProviders(host({ tracker: { provider: "my-tracker" }, codeHost: { provider: "my-host" } }), catalog);
  const codeHost = createFakeCodeHost();
  const built: string[] = [];
  const modules = importing({
    [urlOf("my-tracker")]: moduleOf(() => { built.push("tracker"); throw new Error("no Linear key in the Keychain"); }),
    [urlOf("my-host")]: moduleOf(() => { built.push("code host"); return codeHost; }),
  });
  const narrowed = await loadActive(providers, catalog, fakePluginDeps(), modules, ["codeHost"]);
  assert.equal(narrowed.codeHost(), codeHost);
  assert.deepEqual(built, ["code host"], "the tracker was not built, so its key was not read");
  await assert.rejects(loadActive(providers, catalog, fakePluginDeps(), modules), /the tracker plugin my-tracker was refused: no Linear key in the Keychain/);
});

test("A11-162: an exposure always resolves: a block that is switched off runs the default, `local`, and a block that names a plugin with no code to run is refused by name", async () => {
  const off = resolveProviders(host({ exposure: { provider: "tailscale", enabled: false, tailnetPorts: { ui: 9500, terminal: 9501 } } }));
  const active = await loadActive(off, defaultCatalog(), fakePluginDeps(), undefined, ["exposure"]);
  assert.deepEqual(active.loaded.map(({ plugin }) => plugin.name), ["local"], "the default is loaded, and tailscale's code is not");
  assert.equal(active.exposure().ports(), null);
  const fake = resolveProviders(host({ exposure: { provider: "fake-exposure" } }));
  const refused = await loadActive(fake, defaultCatalog(), fakePluginDeps(), undefined, ["exposure"]);
  assert.throws(() => refused.exposure(), (error: unknown) => error instanceof PluginActivationRefusal
    && error.message === "the exposure is fake-exposure, which has no code to run on a host: name a bundled exposure plugin in tickets.providers.exposure (`agent-org plugin list`)");
});

test("A11-162: an activation narrowed to the tracker and the code host builds no exposure, and says so when asked for one", async () => {
  const providers = resolveProviders(host({}));
  const active = await loadActive(providers, defaultCatalog(), fakePluginDeps({ exec: () => ({ status: 0, stdout: "lin_api_x\n", stderr: "" }) }), undefined, ["tracker", "codeHost"]);
  assert.throws(() => active.exposure(), /the exposure was not built by this process: it asked for the other plugins only/);
});

test("A11-162: a plugin that cannot be built for the exposure refuses the start, naming it: a tailscale block with ports no exposure could serve on", async () => {
  const providers = resolveProviders(host({ exposure: { provider: "tailscale" } }));
  const broken = { ...providers, blocks: { ...providers.blocks, exposure: { ...providers.blocks.exposure, settings: { ...providers.blocks.exposure.settings, tailnetPorts: { value: { ui: 1, terminal: 1 }, at: "tickets.providers.exposure.tailnetPorts" } } } } };
  await assert.rejects(loadActive(broken, defaultCatalog(), fakePluginDeps(), undefined, ["exposure"]), /the exposure plugin tailscale was refused: tickets\.providers\.exposure\.tailnetPorts ui and terminal must be different ports/);
});

// A11-161: the publisher and the reviewer are optional concerns. "None" is the absence of an enabled plugin, so each accessor answers null for a block that names none and for one that is disabled, and
// a disabled plugin's code is not even imported.
const PUBLISHING = { provider: "slack", run: "post {prs} into {dir}", connectors: ["^mcp__chat__send"] };

/** An import that records each module it is asked for and then imports it for real. */
const recording = () => {
  const urls: string[] = [];
  return { urls, importModule: async (url: string) => { urls.push(url); return import(url); } };
};

test("A11-161: with no publisher and no reviewer, or with each switched off, the accessors answer null and the plugins' code is not imported: none is the absence of an enabled plugin", async () => {
  for (const providers of [host({}), host({ publish: { ...PUBLISHING, enabled: false }, reviewer: { provider: "atomic", enabled: false } }), host({ publish: { provider: "none" }, reviewer: { provider: "none" } })]) {
    const { urls, importModule } = recording();
    const active = await loadActive(resolveProviders(providers), defaultCatalog(), fakePluginDeps({ exec: () => ({ status: 0, stdout: "lin_api_x\n", stderr: "" }) }), importModule);
    assert.deepEqual([active.publisher(), active.reviewer()], [null, null], JSON.stringify(providers));
    assert.deepEqual(urls.filter((url) => /slack|atomic/.test(url)), [], "a plugin that is off is not imported");
  }
});

test("A11-161: an enabled publisher and an enabled reviewer are the bundled plugins' implementations, built with the deps core gives them", async () => {
  const providers = resolveProviders(host({ publish: PUBLISHING, reviewer: { provider: "atomic" } }));
  const active = await loadActive(providers, defaultCatalog(), fakePluginDeps({ exec: () => ({ status: 0, stdout: "lin_api_x\n", stderr: "" }) }));
  assert.deepEqual(active.loaded.map(({ plugin }) => plugin.name), ["linear", "github", "slack", "atomic", "local"]);
  assert.deepEqual(active.publisher()?.connectors(), ["^mcp__chat__send"]);
  assert.deepEqual(active.publisher()?.agent(), { model: "haiku", effort: "low" });
  assert.equal(typeof active.reviewer()?.start, "function");
  assert.equal(typeof active.reviewer()?.load, "function");
});

test("A11-161: a block that is on and names a plugin with no code to run on a host (a fake) is refused when its implementation is asked for, and an activation that did not build it says so", async () => {
  const catalog = buildCatalog({ root: "/none", files: { directories: () => [], text: () => null, isFile: () => false } });
  for (const [block, label, fake, ask] of [["publish", "publisher", "fake-publisher", (active: Awaited<ReturnType<typeof loadActive>>) => active.publisher()], ["reviewer", "reviewer", "fake-reviewer", (active: Awaited<ReturnType<typeof loadActive>>) => active.reviewer()]] as const) {
    const active = await loadActive(resolveProviders(host({ [block]: { provider: fake } }), catalog), catalog, fakePluginDeps(), importing({}));
    assert.throws(() => ask(active), (error: unknown) => error instanceof PluginActivationRefusal
      && error.message === `the ${label} is ${fake}, which has no code to run on a host: name a bundled ${label} plugin in tickets.providers.${block} (\`agent-org plugin list\`)`);
    const narrowed = await loadActive(resolveProviders(host({ [block]: { provider: fake } }), catalog), catalog, fakePluginDeps(), importing({}), ["codeHost"]);
    assert.throws(() => ask(narrowed), new RegExp(`the ${label} was not built by this process: it asked for the other plugins only`));
  }
});
