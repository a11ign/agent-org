// no-token: none -- the checkout is an in-memory fixture, except one case that writes a scratch folder
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN, CORE_RUNS, FAKES } from "./built-in.ts";
import { buildCatalog, defaultCatalog, type PackageFiles, pluginNamed, pluginsOfConcern } from "./registry.ts";

const ROOT = "/checkout";

/** An in-memory checkout: `packages` maps a plugin's directory to its package.json (an object, or text for one that is not JSON); `files` lists the other files in it. */
function checkout(packages: Readonly<Record<string, unknown>>, files: readonly string[] = ["index.ts"]): PackageFiles {
  const texts = new Map(Object.entries(packages).map(([name, manifest]) => [`${ROOT}/plugins/${name}/package.json`, typeof manifest === "string" ? manifest : JSON.stringify(manifest)]));
  return {
    directories: (path) => (path === `${ROOT}/plugins` ? Object.keys(packages).sort() : []),
    text: (path) => texts.get(path) ?? null,
    isFile: (path) => files.some((file) => Object.keys(packages).some((name) => path === `${ROOT}/plugins/${name}/${file}`)),
  };
}

const manifest = (over: Record<string, unknown> = {}) => ({ name: "@agent-org/plugin-example", private: true, agentOrg: { concern: "tracker", contract: "1.0", description: "An example tracker.", entry: "index.ts", ...over } });
const catalogOf = (packages: Record<string, unknown>, files?: readonly string[]) => buildCatalog({ root: ROOT, files: checkout(packages, files) });
const refusalOf = (catalog: ReturnType<typeof buildCatalog>, plugin: string) => catalog.refusals.find((refusal) => refusal.plugin === plugin)?.why;

test("with no bundled plugin the catalog is today's providers and the fakes, each tagged with where its code lives", () => {
  const catalog = catalogOf({});
  assert.deepEqual(catalog.plugins.map(({ name, concern, where }) => `${name}:${concern}:${where}`), [
    ...BUILT_IN.map(({ name, concern }) => `${name}:${concern}:core`), ...FAKES.map(({ name, concern }) => `${name}:${concern}:fake`)]);
  assert.deepEqual(BUILT_IN.map(({ name, concern, movedBy }) => [name, concern, movedBy]), [
    ["linear", "tracker", "A11-159"], ["github", "codeHost", "A11-160"], ["slack", "publisher", "A11-161"], ["atomic", "reviewer", "A11-161"],
    ["local", "exposure", "A11-162"], ["tailscale", "exposure", "A11-162"], ["telegram", "messaging", "A11-162"]]);
  assert.deepEqual(FAKES.map(({ name }) => name), ["fake-tracker", "fake-codeHost", "fake-publisher", "fake-reviewer", "fake-exposure", "fake-messaging"]);
  assert.deepEqual(catalog.refusals, []);
  assert.equal(catalog.pins, CORE_RUNS);
});

test("a bundled package with an agentOrg field is a plugin, read without importing any code, and listed before the built-ins", () => {
  const tooling = { mcpServers: ["example"], connectors: ["^mcp__example__"], skills: ["a11ign:example"] };
  const catalog = catalogOf({ example: manifest({ tooling }) });
  const plugin = pluginNamed(catalog, "example");
  assert.deepEqual({ ...plugin, settings: undefined }, { name: "example", concern: "tracker", contract: "1.0", description: "An example tracker.", entry: "index.ts", settings: undefined, tooling, where: "bundled", dir: `${ROOT}/plugins/example`, movedBy: null });
  assert.equal(catalog.plugins[0].name, "example");
  assert.deepEqual(pluginsOfConcern(catalog, "tracker").map(({ name }) => name), ["example", "linear", "fake-tracker"]);
});

test("a package with no agentOrg field is not a plugin and is skipped, and a folder with no package.json too", () => {
  const catalog = catalogOf({ tools: { name: "tools" }, empty: "{}" });
  assert.equal(pluginNamed(catalog, "tools"), undefined);
  assert.deepEqual(catalog.refusals, []);
});

test("a bundled plugin declares its settings as schema entries, keyed under its block", () => {
  const entry = { key: "tickets.providers.tracker.token", file: "host.json", group: "Tracker", type: "text", absent: "unset", default: null, explanation: "The token.", breaks: "Nothing reads.", edit: { editable: false, why: "secret" } };
  const catalog = catalogOf({ example: manifest({ settings: { token: entry } }) });
  assert.deepEqual(Object.keys(pluginNamed(catalog, "example")?.settings ?? {}), ["token"]);
  const wrongKey = catalogOf({ example: manifest({ settings: { token: { ...entry, key: "tickets.providers.codeHost.token" } } }) });
  assert.match(refusalOf(wrongKey, "example") ?? "", /agentOrg\.settings\.token\.key must be tickets\.providers\.tracker\.token/);
  assert.equal(pluginNamed(wrongKey, "example"), undefined, "a refused package is not in the catalog");
});

test("a malformed manifest is refused by name, with the field, and is a refusal in the catalog and not an error", () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["concern", { concern: "database" }, /plugin bad: agentOrg\.concern must be one of tracker, codeHost, publisher, reviewer, exposure, messaging, not "database"/],
    ["contract", { contract: "1" }, /agentOrg\.contract must be "<major>\.<minor>"/],
    ["description", { description: "" }, /agentOrg\.description must be a sentence/],
    ["entry", { entry: "../elsewhere.ts" }, /agentOrg\.entry must be the entry module's path inside the package/],
    ["entry file", { entry: "missing.ts" }, /agentOrg\.entry "missing\.ts" is not a file in the package/],
    ["tooling", { tooling: { connectors: ["mcp__no_anchor"] } }, /agentOrg\.tooling\.connectors must be a list of patterns anchored at "\^mcp__"/],
    ["settings", { settings: [] }, /agentOrg\.settings must be an object/],
    ["messaging settings", { concern: "messaging", settings: { x: { key: "x", type: "t", explanation: "e", breaks: "b", edit: {} } } }, /agentOrg\.settings must be empty: messaging is configured in project\.json/],
  ];
  for (const [what, over, pattern] of cases) assert.match(refusalOf(catalogOf({ bad: manifest(over) }), "bad") ?? "", pattern, what);
  assert.match(refusalOf(catalogOf({ bad: "not json" }), "bad") ?? "", /plugin bad: package\.json is not valid JSON/);
  assert.match(refusalOf(catalogOf({ bad: { agentOrg: "tracker" } }), "bad") ?? "", /agentOrg must be an object/);
});

test("a bundled package that declares dependencies is refused by name, since a host's install would not install them", () => {
  const catalog = catalogOf({ example: { ...manifest(), dependencies: { "left-pad": "1.3.0", zod: "3.0.0" } } });
  assert.equal(pluginNamed(catalog, "example"), undefined);
  assert.equal(refusalOf(catalog, "example"), "plugin example: package.json declares dependencies (left-pad, zod), which a host's install does not install: a bundled plugin imports core's types only and declares none (ADR 0001)");
  assert.notEqual(pluginNamed(catalogOf({ example: { ...manifest(), dependencies: {} } }), "example"), undefined, "an empty dependencies object declares none");
});

test("two plugins of one name are refused by name: the one found first stays", () => {
  const catalog = catalogOf({ linear: manifest() });
  assert.equal(pluginNamed(catalog, "linear")?.where, "bundled", "the bundled package is first");
  assert.match(refusalOf(catalog, "linear") ?? "", /plugin linear is named twice, and plugin names are unique: the core plugin is refused, and the one found first stays/);
  assert.equal(catalog.plugins.filter(({ name }) => name === "linear").length, 1);
});

test("a plugin's name is its directory name, and a name that cannot be one is refused", () => {
  assert.match(refusalOf(catalogOf({ Example: manifest() }), "Example") ?? "", /its directory name must be lower-case letters, digits and hyphens/);
});

test("pins come from core's table unless a test passes its own", () => {
  assert.deepEqual(buildCatalog({ root: ROOT, files: checkout({}), pins: {} }).pins, {});
  assert.deepEqual(Object.keys(CORE_RUNS), ["tracker", "codeHost", "publisher", "reviewer", "exposure"], "messaging has no block, so no pin");
});

test("this checkout's catalog is read once, holds no refusal, and reads a real plugins folder from disk", () => {
  assert.equal(defaultCatalog(), defaultCatalog());
  assert.deepEqual(defaultCatalog().refusals, []);
  const root = mkdtempSync(join(tmpdir(), "registry-"));
  try {
    mkdirSync(join(root, "plugins", "disk-plugin"), { recursive: true });
    writeFileSync(join(root, "plugins", "README.md"), "not a plugin");
    writeFileSync(join(root, "plugins", "disk-plugin", "index.ts"), "export {};\n");
    writeFileSync(join(root, "plugins", "disk-plugin", "package.json"), JSON.stringify(manifest({ concern: "publisher" })));
    const catalog = buildCatalog({ root });
    assert.equal(pluginNamed(catalog, "disk-plugin")?.concern, "publisher");
    assert.deepEqual(catalog.refusals, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a plugins folder or a package.json that exists and cannot be read is refused by name, never taken for an absent one", () => {
  const root = mkdtempSync(join(tmpdir(), "registry-unreadable-"));
  try {
    // `plugins` is a file, not a folder: listing it fails with ENOTDIR, which is not "no plugins here".
    writeFileSync(join(root, "plugins"), "not a folder");
    const notAFolder = buildCatalog({ root });
    assert.deepEqual(notAFolder.refusals.map(({ plugin }) => plugin), ["plugins"]);
    assert.match(notAFolder.refusals[0].why, /the plugins folder .*plugins cannot be read: /);
    rmSync(join(root, "plugins"));
    // `package.json` is a folder: reading it fails with EISDIR, which is not "this folder is no plugin".
    mkdirSync(join(root, "plugins", "broken", "package.json"), { recursive: true });
    const broken = buildCatalog({ root });
    assert.equal(pluginNamed(broken, "broken"), undefined);
    assert.match(broken.refusals.find(({ plugin }) => plugin === "broken")?.why ?? "", /^plugin broken: package\.json cannot be read: /);
    // A checkout with no plugins folder, and a folder with no package.json, are absent and refuse nothing.
    rmSync(join(root, "plugins"), { recursive: true });
    assert.deepEqual(buildCatalog({ root }).refusals, []);
    mkdirSync(join(root, "plugins", "empty"), { recursive: true });
    assert.deepEqual(buildCatalog({ root }).refusals, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
