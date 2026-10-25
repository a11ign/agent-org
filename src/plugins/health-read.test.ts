// no-token: none -- an injected loader and stand-in plugin modules: no plugin is imported and no program runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_BLOCKS, providersOfText } from "../ticket-mode/providers.ts";
import { type HealthSources, readPluginHealth } from "./health-read.ts";
import type { PluginCheck, PluginDeps, PluginModule } from "./manifest.ts";
import { defaultCatalog } from "./registry.ts";

const catalog = defaultCatalog();
const HOST = JSON.stringify({ tickets: { providers: { tracker: { provider: "linear", enabled: true }, codeHost: { provider: "github", enabled: true }, exposure: { provider: "tailscale", port: 5000 } } } });
const later = <T>(ms: number, value: T) => new Promise<T>((done) => { setTimeout(() => done(value), ms); });
const NEVER = new Promise<readonly PluginCheck[]>(() => undefined);

/** The health sources over the host above, with each named plugin loaded as a module whose checks are `checks`. */
function sourcesOf(checks: Record<string, () => Promise<readonly PluginCheck[]> | readonly PluginCheck[]>, over: Partial<HealthSources> = {}): HealthSources {
  const unbuilt = Object.entries(checks).map(([name, doctorChecks]) => ({ plugin: catalog.plugins.find((plugin) => plugin.name === name)!, module: { doctorChecks } as unknown as PluginModule }));
  return { catalog, providers: providersOfText(HOST, catalog), blocks: PROVIDER_BLOCKS, deps: {} as PluginDeps, load: async () => ({ loaded: [], unbuilt, refusals: [] }), version: "v1.2.3", ...over };
}

const checksOfPlugin = (health: Awaited<ReturnType<typeof readPluginHealth>>, name: string) => health.concerns.flatMap(({ plugins }) => plugins).find((plugin) => plugin.name === name)!.checks;
const row = (name: string): PluginCheck => ({ name, ok: true, detail: `${name} is fine`, fix: null });

test("A11-270: with a time limit (the board's page), the plugins' checks run together, so three that take 300 ms each are read in about 300 ms, not 900", async () => {
  const sources = sourcesOf({ linear: () => later(300, [row("token")]), github: () => later(300, [row("app")]), tailscale: () => later(300, [row("serve")]) }, { limitMs: 10_000 });
  const started = Date.now();
  const health = await readPluginHealth(sources);
  const took = Date.now() - started;
  assert.ok(took < 600, `took ${took} ms`);
  assert.deepEqual(["linear", "github", "tailscale"].map((name) => checksOfPlugin(health, name).map(({ name: check }) => check)), [["token"], ["app"], ["serve"]]);
});

test("A11-270: a plugin whose checks never finish is one failing row of its own after the time limit, and the others are read as usual", async () => {
  const started = Date.now();
  const health = await readPluginHealth(sourcesOf({ linear: () => NEVER, github: () => [row("app")] }, { limitMs: 200 }));
  assert.ok(Date.now() - started < 1000, "the hung check does not hold the read");
  assert.deepEqual(checksOfPlugin(health, "linear"), [{ name: "plugin linear", ok: false, detail: "its checks did not finish within 0.2 seconds", fix: "run agent-org doctor to see them" }]);
  assert.deepEqual(checksOfPlugin(health, "github"), [row("app")]);
});

test("A11-163: a plugin whose checks throw is still the one failing row it was, beside the rows of the others", async () => {
  const health = await readPluginHealth(sourcesOf({ linear: () => { throw new Error("no keychain"); }, github: () => [row("app")] }));
  assert.deepEqual(checksOfPlugin(health, "linear"), [{ name: "plugin linear", ok: false, detail: "its checks could not run: no keychain", fix: "update agent-org, or the plugin" }]);
  assert.deepEqual(checksOfPlugin(health, "github"), [row("app")]);
});

test("A11-270: the messaging plugin's checks run within the time limit too, and checks that throw are still the messaging failure, not a row", async () => {
  const state = async () => ({ provider: "slack", enabled: true, settings: {} }) as const;
  const hung = await readPluginHealth(sourcesOf({}, { limitMs: 200, messaging: { state, checks: () => NEVER } }));
  assert.deepEqual(checksOfPlugin(hung, "slack"), [{ name: "plugin slack", ok: false, detail: "its checks did not finish within 0.2 seconds", fix: "run agent-org doctor to see them" }]);
  assert.equal(hung.messagingFailure, null);
  const thrown = await readPluginHealth(sourcesOf({}, { messaging: { state, checks: async () => { throw new Error("project.json is malformed"); } } }));
  assert.deepEqual(thrown.messagingFailure, { why: "project.json is malformed", fix: "fix the messaging key of project.json: `agent-org messaging:check` says what is wrong with it" });
});

test("A11-163: without a time limit (doctor), the checks run one after another and to the end, however long they take", async () => {
  let running = 0;
  let most = 0;
  const slow = (name: string) => async () => {
    running += 1;
    most = Math.max(most, running);
    await later(150, null);
    running -= 1;
    return [row(name)];
  };
  const health = await readPluginHealth(sourcesOf({ linear: slow("token"), github: slow("app"), tailscale: slow("serve") }));
  assert.equal(most, 1, "one plugin's checks at a time");
  assert.deepEqual(["linear", "github", "tailscale"].map((name) => checksOfPlugin(health, name).map(({ name: check }) => check)), [["token"], ["app"], ["serve"]]);
});
