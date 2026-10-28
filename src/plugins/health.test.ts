// no-token: none -- pure: a host object, the real catalog and the loader's result as data
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { resolveProviders } from "../ticket-mode/providers.ts";
import { fillCommand, type PluginHealth, pluginHealth, sectionHeader, sectionPlugins } from "./health.ts";
import type { LoadResult } from "./loader.ts";
import type { CatalogPlugin, PluginCheck } from "./manifest.ts";
import { buildCatalog, defaultCatalog } from "./registry.ts";
import type { MessagingState } from "./view.ts";

const NO_LOAD: Pick<LoadResult, "loaded" | "unbuilt" | "refusals"> = { loaded: [], unbuilt: [], refusals: [] };
const NO_MESSAGING: MessagingState = { provider: null, why: "project.json has no messaging key, so messaging is off" };
const VERSION = "v9.9.9";

/** What a fresh machine's onboard writes: explicit tracker and code host blocks. */
const FRESH = { tickets: { providers: { tracker: { provider: "linear", enabled: true }, codeHost: { provider: "github", enabled: true } } } };

function healthOf(host: unknown, over: Partial<Parameters<typeof pluginHealth>[0]> = {}): PluginHealth {
  const catalog = over.catalog ?? defaultCatalog();
  return pluginHealth({ catalog, providers: resolveProviders(host, catalog), messaging: NO_MESSAGING, load: NO_LOAD, checks: {}, version: VERSION, ...over });
}

const concernOf = (health: PluginHealth, concern: string) => health.concerns.find((entry) => entry.concern === concern)!;
const pluginOf = (health: PluginHealth, name: string) => health.concerns.flatMap((entry) => entry.plugins).find((entry) => entry.name === name)!;

test("A11-163: the health lists every concern in the order tracker, code host, publisher, reviewer, exposure, messaging, and never a fake", () => {
  const health = healthOf(FRESH);
  assert.deepEqual(health.concerns.map(({ concern }) => concern), ["tracker", "codeHost", "publisher", "reviewer", "exposure", "messaging"]);
  assert.deepEqual(health.concerns.map(({ label }) => label), ["tracker", "code host", "publisher", "reviewer", "exposure", "messaging"]);
  assert.deepEqual(health.concerns.flatMap(({ plugins }) => plugins.map(({ name }) => name)), ["linear", "github", "slack", "atomic", "local", "tailscale", "telegram"]);
  assert.equal(health.concerns.flatMap(({ plugins }) => plugins).some(({ name }) => name.startsWith("fake-")), false);
});

test("A11-163: a row shows the name, agent-org's own version, the contract version and the state, and where its code lives", () => {
  const health = healthOf(FRESH);
  const linear = pluginOf(health, "linear");
  assert.deepEqual([linear.name, linear.version, linear.contract, linear.state, linear.where], ["linear", VERSION, "1.9", "enabled", "plugins/linear"]);
  assert.deepEqual([pluginOf(health, "github").state, pluginOf(health, "github").version], ["enabled", VERSION], "the bundled package.json's 0.0.0 is not shown");
  assert.equal(pluginOf(health, "slack").where, "plugins/slack", "the publisher is a bundled package");
  assert.equal(pluginOf(health, "atomic").where, "plugins/atomic-reviewer", "the reviewer's folder is not its name: it is `atomic`, which live host files name");
  assert.equal(pluginOf(health, "slack").state, "not installed");
});

test("A11-163: enabled, disabled and not installed are told apart by the block that names the plugin", () => {
  const host = { tickets: { providers: { ...FRESH.tickets.providers, exposure: { provider: "tailscale", enabled: false }, reviewer: { provider: "atomic" } } } };
  const health = healthOf(host);
  assert.deepEqual(["tailscale", "local", "atomic", "linear"].map((name) => pluginOf(health, name).state), ["disabled", "not installed", "enabled", "enabled"]);
  assert.deepEqual([pluginOf(health, "tailscale").installed, pluginOf(health, "local").installed], [true, false]);
  assert.equal(concernOf(health, "exposure").enabled, null, "a disabled exposure runs no plugin");
  assert.equal(concernOf(health, "reviewer").enabled, "atomic");
});

test("A11-163: a concern a host file leaves to its default runs the default, which is enabled but not installed until a block names it", () => {
  const health = healthOf({});
  const linear = pluginOf(health, "linear");
  assert.deepEqual([linear.state, linear.installed, linear.enabled], ["enabled", false, true]);
  assert.equal(concernOf(health, "tracker").enabled, "linear");
});

test("A11-163: a required concern with no plugin running says the board cannot run, with the command; an optional one says None and how to add one", () => {
  const catalog = defaultCatalog();
  // The reader refuses a disabled tracker, so the state is built from the report directly: the page must still say it in these words if it ever reads one.
  const providers = resolveProviders(FRESH, catalog);
  const off = { ...providers, blocks: { ...providers.blocks, tracker: { ...providers.blocks.tracker, enabled: false } } };
  const health = pluginHealth({ catalog, providers: off, messaging: NO_MESSAGING, load: NO_LOAD, checks: {}, version: VERSION });
  assert.deepEqual(concernOf(health, "tracker").empty, { text: "No tracker enabled: the board cannot run", commands: ["agent-org plugin enable linear"] });
  assert.equal(concernOf(health, "codeHost").empty, null);
  const none = concernOf(healthOf(FRESH), "publisher").empty;
  assert.deepEqual(none, { text: "None", commands: ["agent-org plugin install slack"] });
  assert.deepEqual(concernOf(healthOf(FRESH), "messaging").empty, { text: "None", commands: ["agent-org plugin install telegram"] });
  const empty = healthOf({ tickets: { providers: { ...FRESH.tickets.providers, publish: { provider: "slack", enabled: false, run: "post {prs} into {dir}" } } } });
  assert.deepEqual(concernOf(empty, "publisher").empty, { text: "None", commands: ["agent-org plugin enable slack"] }, "a disabled plugin is enabled, not installed again");
});

test("A11-163: disabling the only tracker or code host is offered disabled, with the reason by name; an optional plugin may be disabled", () => {
  const health = healthOf({ tickets: { providers: { ...FRESH.tickets.providers, exposure: { provider: "tailscale" } } } });
  const linear = pluginOf(health, "linear");
  assert.deepEqual(linear.controls.offered, ["disable", "uninstall", "configure"]);
  assert.equal(linear.controls.refused.disable, "linear is the only tracker, and exactly one tracker must be enabled: it cannot be disabled");
  assert.match(linear.controls.refused.uninstall ?? "", /linear is the only tracker.*cannot be uninstalled/);
  assert.equal(pluginOf(health, "github").controls.refused.disable, "github is the only code host, and exactly one code host must be enabled: it cannot be disabled");
  const tailscale = pluginOf(health, "tailscale");
  assert.deepEqual(tailscale.controls.offered, ["disable", "uninstall", "configure"]);
  assert.deepEqual(tailscale.controls.refused, {}, "nothing refuses an optional plugin");
});

test("A11-163: a disabled plugin is offered Enable, and Uninstall asks to be confirmed", () => {
  const health = healthOf({ tickets: { providers: { ...FRESH.tickets.providers, exposure: { provider: "tailscale", enabled: false } } } });
  const tailscale = pluginOf(health, "tailscale");
  assert.deepEqual(tailscale.controls.offered, ["enable", "uninstall", "configure"]);
  assert.match(tailscale.controls.confirm.uninstall ?? "", /^Uninstall tailscale\? Its block is removed, with its settings, so the exposure takes its default\.$/);
});

test("A11-163: Install is offered on a bundled plugin that is not installed, and one that replaces another asks to be confirmed, naming the plugin and the settings dropped", () => {
  const free = healthOf(FRESH);
  assert.deepEqual(pluginOf(free, "local").controls.offered, ["install", "configure"], "the default exposure, in force but named by no block: Install writes the block");
  assert.equal(pluginOf(free, "local").controls.confirm.install, undefined, "a default replaced drops nothing");
  const host = { tickets: { providers: { ...FRESH.tickets.providers, exposure: { provider: "tailscale", port: 5000, tailnetPorts: { ui: 8443 } } } } };
  const replacing = pluginOf(healthOf(host), "local");
  assert.deepEqual(replacing.controls.offered, ["install"]);
  assert.match(replacing.controls.confirm.install ?? "", /^Install local\? It replaces tailscale as the exposure: its settings tailnetPorts are dropped, since local does not declare them\.$/);
});

test("A11-163: a plugin that needs a secret offers no Install button, but the install command and the command for each secret", () => {
  const health = healthOf(FRESH);
  const telegram = pluginOf(health, "telegram");
  assert.equal(telegram.controls.offered.includes("install"), false);
  assert.equal(telegram.installCommand, "agent-org plugin install telegram");
  assert.deepEqual(telegram.secrets.map(({ setting }) => setting), ["tokenFile", "chairmanFile", "announcementsFile"]);
  assert.match(telegram.secrets[0].command, /telegram-token/);
  assert.equal(telegram.secrets[1].command, "agent-org messaging:pair");
});

test("A11-163: a secret's command is filled from the setting's value, and from the plugin's default when the file holds none", () => {
  assert.equal(fillCommand("security add-generic-password -a \"$USER\" -s {value|agent-org-linear} -w", undefined), "security add-generic-password -a \"$USER\" -s agent-org-linear -w");
  assert.equal(fillCommand("security add-generic-password -s {value|agent-org-linear} -w", "my-service"), "security add-generic-password -s my-service -w");
  assert.equal(fillCommand("cp key {value}", undefined), "cp key <value>", "no value and no fallback names the blank");
  const named = healthOf({ tickets: { providers: { tracker: { provider: "linear", key: { keychain: "work-linear" } }, codeHost: { provider: "github" } } } });
  const commands = Object.fromEntries(pluginOf(named, "linear").secrets.map(({ setting, command }) => [setting, command]));
  assert.equal(commands["key.keychain"], "security add-generic-password -a \"$USER\" -s work-linear -w");
  assert.match(commands["key.path"], /linear\.key/, "the other source keeps its fallback");
  const bare = pluginOf(healthOf(FRESH), "linear");
  assert.equal(bare.secrets.find(({ setting }) => setting === "key.keychain")?.command, "security add-generic-password -a \"$USER\" -s agent-org-linear -w");
});

test("A11-163: no secret is in an entry: the commands carry the setting's place and never what a key file holds", () => {
  const host = { tickets: { providers: { tracker: { provider: "linear", key: { path: "/home/me/.config/agent-org/linear.key" } }, codeHost: { provider: "github" } } } };
  const text = JSON.stringify(healthOf(host));
  assert.match(text, /linear\.key/);
  assert.doesNotMatch(text, /lin_api_/);
});

test("A11-163: a plugin the loader refused is failed, with doctor's reason and fix, and the other plugins are not", () => {
  const load = { ...NO_LOAD, refusals: [{ plugin: "tailscale", concern: "exposure" as const, why: "plugin tailscale: index.ts must export create, doctorChecks and onboardSteps" }] };
  const health = healthOf({ tickets: { providers: { ...FRESH.tickets.providers, exposure: { provider: "tailscale" } } } }, { load });
  const tailscale = pluginOf(health, "tailscale");
  assert.deepEqual([tailscale.state, tailscale.failure], ["failed", { why: "plugin tailscale: index.ts must export create, doctorChecks and onboardSteps", fix: "update agent-org, or the plugin" }]);
  assert.deepEqual(["linear", "github"].map((name) => pluginOf(health, name).state), ["enabled", "enabled"]);
  assert.deepEqual(tailscale.controls.offered, ["disable", "uninstall", "configure"], "a failed plugin can still be switched off");
});

test("A11-163: a plugin whose create threw is failed with its own failing check's words, and a loaded plugin whose checks fail stays enabled with them on its row", () => {
  const down: PluginCheck = { name: "tracker key", ok: false, detail: "the Keychain holds no key for agent-org-linear", fix: "security add-generic-password -a \"$USER\" -s agent-org-linear -w" };
  const load = { ...NO_LOAD, refusals: [{ plugin: "linear", concern: "tracker" as const, why: "create broke" }] };
  const unbuilt = pluginOf(healthOf(FRESH, { load, checks: { linear: [down] } }), "linear");
  assert.deepEqual([unbuilt.state, unbuilt.failure], ["failed", { why: down.detail, fix: down.fix }]);
  const noCheck = pluginOf(healthOf(FRESH, { load, checks: { linear: [{ ...down, ok: true }] } }), "linear");
  assert.deepEqual(noCheck.failure, { why: "create broke", fix: "update agent-org, or the plugin" }, "when no check says why, the loader's words do");
  const loaded = pluginOf(healthOf(FRESH, { checks: { github: [{ name: "gh", ok: false, detail: "not logged in", fix: "gh auth login" }] } }), "github");
  assert.deepEqual([loaded.state, loaded.failure, loaded.checks.map(({ detail }) => detail)], ["enabled", null, ["not logged in"]]);
});

test("A11-163: a plugin that implements a contract major this agent-org does not read is failed by name, and cannot be installed", () => {
  const unread: CatalogPlugin = { ...defaultCatalog().plugins.find(({ name }) => name === "local")!, name: "far-future", contract: "2.0", dir: "/checkout/plugins/far-future", where: "bundled" };
  const base = defaultCatalog();
  const catalog = { ...base, plugins: [...base.plugins, unread] };
  const health = healthOf(FRESH, { catalog });
  const entry = pluginOf(health, "far-future");
  assert.deepEqual([entry.state, entry.failure?.why, entry.failure?.fix], ["failed", "plugin far-future implements exposure contract 2.0; this agent-org reads exposure 1.x: update agent-org, or use a plugin of a major it reads", "update agent-org, or update the plugin to a contract major agent-org reads"]);
  assert.match(entry.controls.refused.install ?? "", /implements exposure contract 2\.0/);
});

test("A11-163: a package the registry refused is a failed entry of its own, in the registry's words", () => {
  const refused = buildCatalog({ root: "/checkout", files: { directories: (path) => (path === "/checkout/plugins" ? ["broken"] : []), text: (path) => (path.endsWith("broken/package.json") ? "not json" : null), isFile: () => false } });
  assert.equal(refused.refusals.length, 1);
  const health = healthOf(FRESH, { catalog: { ...defaultCatalog(), refusals: refused.refusals } });
  assert.deepEqual(health.refused, [{ plugin: "broken", failure: { why: "plugin broken: package.json is not valid JSON", fix: "fix the plugin's package.json, or remove the plugin" } }]);
  assert.equal(health.concerns.flatMap(({ plugins }) => plugins).some(({ name }) => name === "broken"), false);
});

test("A11-163: messaging is read from the project's key: a plugin it names is installed, and its settings are not in the host block", () => {
  const messaging: MessagingState = { provider: "telegram", enabled: true, settings: { tokenFile: "~/.config/agent-org/bot.token" } };
  const health = healthOf(FRESH, { messaging });
  const telegram = pluginOf(health, "telegram");
  assert.deepEqual([telegram.state, telegram.installed, concernOf(health, "messaging").enabled], ["enabled", true, "telegram"]);
  assert.equal(telegram.secrets[0].command, "( umask 077; printf 'bot token: ' >&2; stty -echo; read -r SECRET; stty echo; printf '\\n' >&2; printf '%s' \"$SECRET\" > ~/.config/agent-org/bot.token )");
  const off = pluginOf(healthOf(FRESH, { messaging: { ...messaging, enabled: false } }), "telegram");
  assert.deepEqual([off.state, off.controls.offered], ["disabled", ["enable", "uninstall", "configure"]]);
});

test("A11-163: doctor's sections are the plugins a block names and any that failed, headed by concern, plugin, state, contract and where", () => {
  const health = healthOf({ tickets: { providers: { ...FRESH.tickets.providers, exposure: { provider: "tailscale", enabled: false } } } });
  const tracker = concernOf(health, "tracker");
  assert.deepEqual(sectionPlugins(tracker).map(({ name }) => name), ["linear"]);
  assert.equal(sectionHeader(tracker.label, sectionPlugins(tracker)[0]), "tracker: linear (enabled, contract 1.9, plugins/linear)");
  assert.deepEqual(sectionPlugins(concernOf(health, "exposure")).map(({ name }) => name), ["tailscale"], "a disabled plugin still has its section");
  assert.deepEqual(sectionPlugins(concernOf(health, "publisher")), [], "an optional concern with none has no plugin section");
});

test("A11-163: an entry names the schema keys of its own settings, so the page draws only those under its Configure", () => {
  const health = healthOf(FRESH);
  assert.ok(pluginOf(health, "linear").settingKeys.includes("tickets.providers.tracker.workingState"));
  assert.ok(pluginOf(health, "tailscale").settingKeys.includes("tickets.providers.exposure.tailnetPorts"));
  assert.equal(pluginOf(health, "local").settingKeys.includes("tickets.providers.exposure.tailnetPorts"), false, "a setting of another plugin of the concern is not its own");
  assert.deepEqual(pluginOf(health, "atomic").settingKeys, [], "a plugin that declares none has none");
});

test("A11-163: a value filled into a command is one word of it: a path with a space or a metacharacter is quoted, and a path with a ~ is left for the shell to expand", () => {
  assert.equal(fillCommand("cp key {value}", "/home/me/.config/agent-org/linear.key"), "cp key /home/me/.config/agent-org/linear.key");
  assert.equal(fillCommand("cp key {value}", "~/keys/linear.key"), "cp key ~/keys/linear.key");
  assert.equal(fillCommand("cp key {value}", "/home/me/my keys/linear.key"), "cp key '/home/me/my keys/linear.key'");
  assert.equal(fillCommand("cp key {value}", "/k/$(touch pwned);x"), "cp key '/k/$(touch pwned);x'", "a metacharacter is text");
  assert.equal(fillCommand("cp key {value}", "/k/it's"), "cp key '/k/it'\\''s'");
});

test("A11-163: every secret command the shipped plugins show parses in the shells a person may have: zsh reads `read -p` as a coprocess, so none uses it", () => {
  const commands = defaultCatalog().plugins.flatMap((plugin) => Object.values(plugin.settings)).flatMap((entry) => (entry.setCommand === undefined ? [] : [entry.setCommand]));
  assert.ok(commands.length >= 6);
  for (const command of commands) {
    assert.doesNotMatch(command, /\bread\b[^;)]*\s-[a-z]*[ps]/, `a prompt is printed, not read with -p: ${command}`);
    const text = command.replace(/\{value\|([^}]*)\}/g, "$1");
    const probes = { sh: spawnSync("sh", ["-n", "-c", text], { encoding: "utf8" }), bash: spawnSync("bash", ["-n", "-c", text], { encoding: "utf8" }), zsh: spawnSync("zsh", ["-n", "-c", text], { encoding: "utf8" }) };
    for (const [shell, probe] of Object.entries(probes)) if (probe.error === undefined) assert.equal(probe.status, 0, `${shell} parses ${command}: ${probe.stderr}`);
  }
});

test("A11-163: the answer sent to the page carries the plugin the messaging key names and whether it is on, and none of the key's settings", () => {
  const messaging: MessagingState = { provider: "telegram", enabled: true, settings: { tokenFile: "~/.config/agent-org/bot.token", pasted: "123:SECRET-TOKEN" } };
  const health = healthOf(FRESH, { messaging });
  assert.deepEqual(health.messaging, { provider: "telegram", enabled: true, settings: {} });
  assert.doesNotMatch(JSON.stringify(health), /SECRET-TOKEN/);
});
