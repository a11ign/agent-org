// no-token: none -- pure: a host object, the real catalog and the loader's result as data
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProviders } from "../ticket-mode/providers.ts";
import { attentionOf, type ClaudePlugin, type ClaudePlugins } from "./attention.ts";
import { type PluginHealth, pluginHealth } from "./health.ts";
import type { LoadResult } from "./loader.ts";
import type { PluginCheck } from "./manifest.ts";
import { defaultCatalog } from "./registry.ts";

const NO_LOAD: Pick<LoadResult, "loaded" | "unbuilt" | "refusals"> = { loaded: [], unbuilt: [], refusals: [] };
const FRESH = { tickets: { providers: { tracker: { provider: "linear", enabled: true }, codeHost: { provider: "github", enabled: true }, exposure: { provider: "tailscale", enabled: true } } } };
const PASS: PluginCheck = { name: "key", ok: true, detail: "found", fix: null };
const FAIL: PluginCheck = { name: "token", ok: false, detail: "no token", fix: "run agent-org doctor" };

function healthOf(host: unknown, over: Partial<Parameters<typeof pluginHealth>[0]> = {}): PluginHealth {
  const catalog = over.catalog ?? defaultCatalog();
  return pluginHealth({ catalog, providers: resolveProviders(host, catalog), messaging: { provider: null, why: "off" }, load: NO_LOAD, checks: {}, version: "v9.9.9", ...over });
}

const NO_CLAUDE: ClaudePlugins = { readable: true, plugins: [] };
const claudePlugin = (over: Partial<ClaudePlugin> = {}): ClaudePlugin => ({ entry: "a11ign@m", name: "a11ign", loads: true, why: null, installs: [{ scope: "user", projectPath: null }], contract: null, rows: [], ...over });
const claudeOf = (...plugins: ClaudePlugin[]): ClaudePlugins => ({ readable: true, plugins });

test("A11-201: a board whose plugins all pass needs no attention", () => {
  assert.equal(attentionOf(healthOf(FRESH, { checks: { linear: [PASS], github: [PASS] } }), claudeOf(claudePlugin())), 0);
});

test("A11-201: an agent-org plugin with a failing check counts once, however many of its checks fail", () => {
  assert.equal(attentionOf(healthOf(FRESH, { checks: { linear: [FAIL, { ...FAIL, name: "scope" }, PASS] } }), NO_CLAUDE), 1);
});

test("A11-201: an agent-org plugin the loader refused counts, and a failing check on it does not count it twice", () => {
  const load = { ...NO_LOAD, refusals: [{ plugin: "tailscale", concern: "exposure" as const, why: "plugin tailscale: index.ts must export create" }] };
  assert.equal(attentionOf(healthOf(FRESH, { load, checks: { tailscale: [FAIL] } }), NO_CLAUDE), 1);
});

test("A11-201: a package the registry refused counts, one each", () => {
  const catalog = { ...defaultCatalog(), refusals: [{ plugin: "broken", why: "package.json has no contract" }, { plugin: "worse", why: "package.json is not JSON" }] };
  assert.equal(attentionOf(healthOf(FRESH, { catalog }), NO_CLAUDE), 2);
});

test("A11-201: a plugin that is disabled or not installed, and whole, is not counted", () => {
  const host = { tickets: { providers: { ...FRESH.tickets.providers, exposure: { provider: "tailscale", enabled: false } } } };
  const health = healthOf(host);
  assert.deepEqual(health.concerns.flatMap(({ plugins }) => plugins).filter(({ state }) => state === "disabled" || state === "not installed").length > 0, true, "the fixture holds both kinds");
  assert.equal(attentionOf(health, NO_CLAUDE), 0);
});

test("A11-201: a Claude plugin counts when a worker would not get it, when its health is unknown, and when its contract disagrees with the host", () => {
  const notLoaded = claudePlugin({ entry: "a@m", name: "a", loads: false, why: "a@m is not installed" });
  const unknown = claudePlugin({ entry: "b@m", name: "b", loads: null });
  const mismatch = claudePlugin({ entry: "c@m", name: "c", rows: [{ plugin: "c@m", kind: "command-need", why: "c@m needs gh on the path" }] });
  assert.equal(attentionOf(healthOf(FRESH), claudeOf(notLoaded)), 1);
  assert.equal(attentionOf(healthOf(FRESH), claudeOf(unknown)), 1);
  assert.equal(attentionOf(healthOf(FRESH), claudeOf(mismatch)), 1);
  assert.equal(attentionOf(healthOf(FRESH), claudeOf(notLoaded, unknown, mismatch, claudePlugin({ entry: "d@m", name: "d" }))), 3, "a loading plugin with no row is not counted");
});

test("A11-201: a Claude plugin with two rows counts once, and the count spans agent-org and Claude plugins", () => {
  const rows = [{ plugin: "c@m", kind: "command-need" as const, why: "one" }, { plugin: "c@m", kind: "connector-need" as const, why: "two" }];
  assert.equal(attentionOf(healthOf(FRESH, { checks: { linear: [FAIL] } }), claudeOf(claudePlugin({ entry: "c@m", name: "c", rows }))), 2);
});
