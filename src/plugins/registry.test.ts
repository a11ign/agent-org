// no-token: none -- the checkout is an in-memory fixture, except one case that writes a scratch folder
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKES } from "./built-in.ts";
import { resolveProviders } from "../ticket-mode/providers.ts";
import { blockSettings, buildCatalog, defaultCatalog, isTrackerConnector, ownsConnector, type PackageFiles, pluginNamed, pluginsOfConcern, trackerWritingOf } from "./registry.ts";

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

test("with no bundled plugin the catalog is the fakes alone, each tagged with where its code lives", () => {
  const catalog = catalogOf({});
  assert.deepEqual(catalog.plugins.map(({ name, concern, where }) => `${name}:${concern}:${where}`), FAKES.map(({ name, concern }) => `${name}:${concern}:fake`));
  assert.deepEqual(FAKES.map(({ name }) => name), ["fake-tracker", "fake-codeHost", "fake-publisher", "fake-reviewer", "fake-exposure", "fake-messaging"]);
  assert.deepEqual(catalog.refusals, []);
});

test("a bundled package with an agentOrg field is a plugin, read without importing any code, and listed before the built-ins", () => {
  const tooling = { mcpServers: ["example"], connectors: ["^mcp__example__"], skills: ["a11ign:example"] };
  const catalog = catalogOf({ example: manifest({ tooling }) });
  const plugin = pluginNamed(catalog, "example");
  assert.deepEqual({ ...plugin, settings: undefined }, { name: "example", concern: "tracker", contract: "1.0", description: "An example tracker.", entry: "index.ts", settings: undefined, tooling, where: "bundled", dir: `${ROOT}/plugins/example` });
  assert.equal(catalog.plugins[0].name, "example");
  assert.deepEqual(pluginsOfConcern(catalog, "tracker").map(({ name }) => name), ["example", "fake-tracker"]);
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
    ["messaging settings", { concern: "messaging", settings: { x: { key: "tickets.providers.tracker.x", file: "host.json", type: "t", explanation: "e", breaks: "b", edit: {} } } }, /agentOrg\.settings\.x\.key must be messaging\.x, not "tickets\.providers\.tracker\.x"/],
    ["messaging settings file", { concern: "messaging", settings: { x: { key: "messaging.x", file: "host.json", type: "t", explanation: "e", breaks: "b", edit: {} } } }, /agentOrg\.settings\.x\.file must be project\.json: messaging is configured there, not in "host\.json"/],
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
  const catalog = catalogOf({ "fake-publisher": manifest({ concern: "publisher" }) });
  assert.equal(pluginNamed(catalog, "fake-publisher")?.where, "bundled", "the bundled package is first");
  assert.match(refusalOf(catalog, "fake-publisher") ?? "", /plugin fake-publisher is named twice, and plugin names are unique: the fake plugin is refused, and the one found first stays/);
  assert.equal(catalog.plugins.filter(({ name }) => name === "fake-publisher").length, 1);
});

test("A11-161: agentOrg.name gives a package's plugin its name, the directory's is the default, a name that cannot be one is refused, and a clash is refused by name", () => {
  const catalog = catalogOf({ "atomic-reviewer": manifest({ concern: "reviewer", name: "atomic" }), slack: manifest({ concern: "publisher" }) });
  const atomic = pluginNamed(catalog, "atomic");
  assert.deepEqual([atomic?.where, atomic?.dir, pluginNamed(catalog, "atomic-reviewer")], ["bundled", `${ROOT}/plugins/atomic-reviewer`, undefined], "the plugin is `atomic`, from a folder that is not named so");
  assert.equal(pluginNamed(catalog, "slack")?.dir, `${ROOT}/plugins/slack`, "with no name, the directory's is the plugin's");
  assert.match(refusalOf(catalogOf({ other: manifest({ name: "Atomic" }) }), "Atomic") ?? "", /its agentOrg\.name must be lower-case letters, digits and hyphens/);
  assert.match(refusalOf(catalogOf({ other: manifest({ name: 7 }) }), "other") ?? "", /agentOrg\.name must be the plugin's name as text/);
  const clash = catalogOf({ "atomic-reviewer": manifest({ concern: "reviewer", name: "atomic" }), "atomic-two": manifest({ concern: "reviewer", name: "atomic" }) });
  assert.match(refusalOf(clash, "atomic") ?? "", /plugin atomic is named twice, and plugin names are unique: the bundled plugin is refused, and the one found first stays/);
  assert.equal(pluginNamed(clash, "atomic")?.dir, `${ROOT}/plugins/atomic-reviewer`, "the one found first stays");
});

test("a plugin's name is its directory name, and a name that cannot be one is refused", () => {
  assert.match(refusalOf(catalogOf({ Example: manifest() }), "Example") ?? "", /its directory name must be lower-case letters, digits and hyphens/);
});

test("this checkout's catalog is read once, holds no refusal, and reads a real plugins folder from disk", () => {
  assert.equal(defaultCatalog(), defaultCatalog());
  assert.deepEqual(defaultCatalog().refusals, []);
  const linear = pluginNamed(defaultCatalog(), "linear");
  assert.deepEqual([linear?.concern, linear?.where, linear?.contract, linear?.dir?.endsWith("/plugins/linear")], ["tracker", "bundled", "1.3", true], "linear is the bundled package, found on disk");
  assert.deepEqual(["local", "tailscale", "telegram"].map((name) => { const found = pluginNamed(defaultCatalog(), name); return [name, found?.concern, found?.where, found?.contract]; }),
    [["local", "exposure", "bundled", "1.1"], ["tailscale", "exposure", "bundled", "1.1"], ["telegram", "messaging", "bundled", "1.1"]], "A11-162: the exposures and the messaging provider are bundled packages too, not rows in core");
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

const writing = {
  label: "Example", createTool: "mcp__example__create", attachTools: ["mcp__example__attach"], filingTools: "^mcp__example__(?:create|attach)$",
  refusedInputs: [{ input: "id", refusal: "is called with an id" }], attachTicketInput: "ticket", createdKey: { wrapper: null, fields: ["key"] },
  priorities: { urgent: 1, high: 2, medium: 3, low: 4, none: 0 }, readTools: ["mcp__example__get"], briefNote: "Use the example tools.",
};

test("a tracker declares what a new-ticket run files with as manifest data (contract 1.1), and a malformed declaration is refused by name", () => {
  const catalog = catalogOf({ example: manifest({ contract: "1.1", tooling: { mcpServers: ["example"], connectors: ["^mcp__example__get"], skills: [], connectorServers: ["example", "example_app"], writer: writing } }) });
  const tooling = pluginNamed(catalog, "example")?.tooling;
  assert.deepEqual(tooling?.writer, writing);
  assert.deepEqual(tooling?.connectorServers, ["example", "example_app"]);
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["a writer that is not an object", { writer: "yes" }, /agentOrg\.tooling\.writer must be an object/],
    ["a create tool that is no tool name", { writer: { ...writing, createTool: "create" } }, /writer\.createTool must be a tool name starting "mcp__"/],
    ["a filing pattern that does not cover a granted tool", { writer: { ...writing, filingTools: "^mcp__example__create$" } }, /writer\.filingTools must match every tool the writer is granted, and does not match mcp__example__attach/],
    ["a filing pattern that is not anchored", { writer: { ...writing, filingTools: "mcp__example__" } }, /writer\.filingTools must be a regular expression anchored with \^ and \$/],
    ["a priority left out", { writer: { ...writing, priorities: { urgent: 1 } } }, /writer\.priorities must give a number for each of urgent, high, medium, low, none/],
    ["no created-key fields", { writer: { ...writing, createdKey: { wrapper: null, fields: [] } } }, /writer\.createdKey must be \{ wrapper, fields \}/],
    ["server names that are not a list", { connectorServers: "example" }, /agentOrg\.tooling\.connectorServers must be a list of server names/],
  ];
  for (const [what, tooling, pattern] of cases) assert.match(refusalOf(catalogOf({ bad: manifest({ tooling }) }), "bad") ?? "", pattern, what);
  assert.match(refusalOf(catalogOf({ bad: manifest({ concern: "publisher", tooling: { writer: writing } }) }), "bad") ?? "", /agentOrg\.tooling\.writer is a tracker's: publisher plugins file no tickets/);
});

test("a setting named with a dot is a part of the setting before it, which the manifest must declare, and the block does not hold it", () => {
  const entry = (key: string) => ({ key, file: "host.json", group: "Tracker", type: "text", absent: "unset", default: null, explanation: "e", breaks: "b", edit: { editable: false, why: "w" } });
  const settings = { key: entry("tickets.providers.tracker.key"), "key.path": entry("tickets.providers.tracker.key.path") };
  const catalog = catalogOf({ example: manifest({ settings }) });
  const plugin = pluginNamed(catalog, "example");
  assert.deepEqual(Object.keys(plugin?.settings ?? {}), ["key", "key.path"], "both are drawn on the Settings page");
  assert.deepEqual(blockSettings(plugin!), ["key"], "and the block takes only the first");
  assert.match(refusalOf(catalogOf({ bad: manifest({ settings: { "key.path": settings["key.path"] } }) }), "bad") ?? "", /agentOrg\.settings\.key\.path is a part of key, which the manifest does not declare/);
});

test("a connector pattern is a tracker's when it names a server its tooling declares, and the catalog's tracker plugins are asked", () => {
  const catalog = catalogOf({ example: manifest({ tooling: { mcpServers: ["example"], connectors: [], skills: [], connectorServers: ["example", "example_app"] } }) });
  assert.equal(isTrackerConnector(catalog, "^mcp__example__(get|list)_"), true);
  assert.equal(isTrackerConnector(catalog, "^mcp__example_app__get_"), true);
  assert.equal(isTrackerConnector(catalog, "^mcp__example_other__get_"), false, "a longer server name is another server");
  assert.equal(isTrackerConnector(catalog, "^mcp__slack__send_"), false);
  assert.equal(isTrackerConnector(catalog, 7), false, "and a value that is no pattern is nobody's");
  assert.equal(ownsConnector({ tooling: { mcpServers: ["solo"], connectors: [], skills: [] } }, "^mcp__solo__get_"), true, "with no connectorServers a plugin's own MCP servers are the ones");
});

test("the writer a host names is the tracker plugin's, and a tracker that declares none is refused by name", () => {
  const catalog = catalogOf({ example: manifest({ contract: "1.1", tooling: { mcpServers: [], connectors: [], skills: [], writer: writing } }), bare: manifest() });
  const providers = (name: string) => resolveProviders({ tickets: { providers: { tracker: { provider: name } } } }, { ...catalog });
  assert.deepEqual(trackerWritingOf(providers("example"), catalog), writing);
  assert.throws(() => trackerWritingOf(providers("bare"), catalog), /the tracker bare declares no writer tooling \(tracker contract 1\.1\), so a new-ticket run cannot file a ticket with it/);
});

test("A11-163: a manifest's secret setting must declare the command that sets it, since the Settings page shows it and never takes a secret", () => {
  const entry = { key: "tickets.providers.tracker.token", file: "host.json", group: "Tracker", type: "text", absent: "unset", default: null, secret: "path", explanation: "e", breaks: "b", edit: { editable: false, why: "w" } };
  assert.match(refusalOf(catalogOf({ bad: manifest({ settings: { token: entry } }) }), "bad") ?? "",
    /agentOrg\.settings\.token is a secret \(path\) and must declare setCommand, the exact command that sets it/);
  assert.match(refusalOf(catalogOf({ bad: manifest({ settings: { token: { ...entry, setCommand: "" } } }) }), "bad") ?? "", /must declare setCommand/, "an empty command is none");
  assert.match(refusalOf(catalogOf({ bad: manifest({ settings: { token: { ...entry, secret: undefined, setCommand: 7 } } }) }), "bad") ?? "", /agentOrg\.settings\.token\.setCommand must be the command as text/);
  const good = pluginNamed(catalogOf({ ok: manifest({ settings: { token: { ...entry, setCommand: "pass insert example" } } }) }), "ok");
  assert.equal(good?.settings.token.setCommand, "pass insert example");
});

test("A11-163: every secret setting of this checkout's bundled plugins declares its command", () => {
  const secrets = defaultCatalog().plugins.flatMap((plugin) => Object.entries(plugin.settings).filter(([, entry]) => entry.secret !== undefined).map(([name, entry]) => [plugin.name, name, entry.setCommand]));
  assert.ok(secrets.length >= 6, "linear, github and telegram each declare secrets");
  for (const [plugin, name, command] of secrets) assert.equal(typeof command === "string" && command !== "", true, `${plugin} ${name} declares setCommand`);
});
