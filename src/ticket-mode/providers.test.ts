// no-token: none -- pure: each host file is parsed here, and nothing is read from disk or the tracker
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALIASES_REFUSED_FROM, isActive, providersOfText, resolveProviders } from "./providers.ts";
import type { Catalog } from "../plugins/manifest.ts";
import { buildCatalog } from "../plugins/registry.ts";
import { parseTicketSettings } from "./settings.ts";
import { TicketSettingsRefusal } from "./settings-refusal.ts";

const clones = { netbox: "/r/netbox" };
const LINEAR = "^mcp__linear__(get|list)_";
const SAVE = "^mcp__linear__save_comment$";
const DESIGN = "^mcp__design__read_";
const PLAN = "-plan-[^/]*\\.md$";
const RUN = "publish {prs} into {dir}";
const TERMINAL = "http://127.0.0.1:7318/?ws={workspace}&pane={pane}";

/** A host file as an agent-org install from before A11-144 writes it: loose keys, one per concern. */
const OLD_KEYS = {
  clones,
  tickets: {
    linearKey: { path: "/k/linear" }, connectors: [LINEAR, SAVE, DESIGN], workingState: "In Progress", plan: PLAN,
    planner: { run: "plan {keys} into {dir}", state: "Planned" }, publish: { run: RUN, connectors: ["^mcp__slack__send"] }, reviewer: "atomic",
    port: 4800, uiPort: 4801, terminal: TERMINAL, serve: "tailscale", servePorts: { ui: 9443, terminal: 9444 },
  },
  github: { identity: { scheduler: { mode: "github-apps", appId: 123, keyPath: "/k/app.pem" }, workers: { mode: "user-accounts" } } },
  gh: { workers: "/gh/workers", leads: "/gh/leads", leadsHeader: ["h"], leadsWorkspaces: [{ id: "lead1", role: "lead" }] },
};

test("a host file with no provider block takes every provider's default, and each block says so", () => {
  const providers = resolveProviders({ tickets: {} });
  assert.deepEqual(Object.values(providers.blocks).map(({ from }) => from), ["default", "default", "default", "default", "default"]);
  assert.deepEqual(Object.fromEntries(Object.entries(providers.blocks).map(([name, { provider }]) => [name, provider])), {
    tracker: "linear", codeHost: "github", publish: "none", reviewer: "none", exposure: "local",
  });
  assert.deepEqual(providers.aliases, [], "no old key is read");
});

test("a block reads its own settings, and the settings another block holds do not reach it", () => {
  const providers = resolveProviders({ tickets: { providers: { exposure: { provider: "tailscale", port: 5000 }, tracker: { provider: "linear" } } } });
  assert.equal(providers.blocks.exposure.from, "block");
  assert.equal(providers.blocks.exposure.settings.port?.value, 5000);
  assert.equal(providers.blocks.tracker.settings.workingState?.value, undefined, "exposure's port is not the tracker's state");
  assert.equal(providers.blocks.publish.from, "default", "a block left out is the default");
});

test("the old keys still read, each to its new place, in the order the readers take them", () => {
  const { aliases } = resolveProviders(OLD_KEYS);
  assert.deepEqual(aliases.map(({ old, new: place, stale }) => [old, place, stale]), [
    ["tickets.linearKey", "tickets.providers.tracker.key", false],
    ["tickets.connectors", "tickets.providers.tracker.connectors", false],
    ["tickets.workingState", "tickets.providers.tracker.workingState", false],
    ["tickets.planner.state", "tickets.providers.tracker.plannedState", false],
    ["github.identity", "tickets.providers.codeHost.identity", false],
    ["gh", "tickets.providers.codeHost.gh", false],
    ["tickets.publish", "tickets.providers.publish", false],
    ["tickets.reviewer", "tickets.providers.reviewer", false],
    ["tickets.serve", "tickets.providers.exposure.provider", false],
    ["tickets.port", "tickets.providers.exposure.port", false],
    ["tickets.uiPort", "tickets.providers.exposure.uiPort", false],
    ["tickets.terminal", "tickets.providers.exposure.terminal", false],
    ["tickets.servePorts", "tickets.providers.exposure.tailnetPorts", false],
  ]);
  assert.deepEqual(resolveProviders(OLD_KEYS).blocks.tracker.settings.connectors?.value, [LINEAR, SAVE], "only the Linear patterns are the tracker's");
  assert.equal(resolveProviders(OLD_KEYS).blocks.exposure.provider, "tailscale", "tickets.serve names the exposure");
});

test("a publish block that holds the four settings the old object held reads an extra key beside them as no second value", () => {
  const providers = resolveProviders({ tickets: {
    providers: { publish: { provider: "slack", run: RUN } }, publish: { run: RUN, _note: "prose the old reader never took" },
  } });
  assert.deepEqual(providers.aliases, [{ old: "tickets.publish", new: "tickets.providers.publish", stale: true }]);
});

test("the release that refuses the old keys is recorded as a version, and until it the old keys still parse", () => {
  assert.match(ALIASES_REFUSED_FROM, /^\d+\.\d+\.\d+$/);
  assert.equal(parseTicketSettings({ clones, tickets: { port: 4800 } }).port, 4800, "an old key is still read");
});

test("the old keys parse to the settings they parsed to before, under the new names", () => {
  const settings = parseTicketSettings({ ...OLD_KEYS, tickets: { ...OLD_KEYS.tickets, max: 2 } });
  assert.deepEqual(settings.providers.blocks.tracker.settings.key, { value: { path: "/k/linear" }, at: "tickets.linearKey" });
  assert.deepEqual(settings.connectors, [LINEAR, SAVE, DESIGN]);
  assert.equal(settings.workingState, "In Progress");
  assert.equal(settings.planner?.state, "Planned");
  assert.deepEqual([settings.providers.blocks.exposure.provider, settings.providers.blocks.exposure.enabled, settings.providers.blocks.exposure.settings.tailnetPorts], ["tailscale", true, { value: { ui: 9443, terminal: 9444 }, at: "tickets.servePorts" }],
    "tickets.serve and tickets.servePorts name the exposure and its ports, which the Tailscale plugin serves on");
  assert.equal(settings.reviewer, "atomic");
  assert.deepEqual(settings.publish, { run: RUN, model: "haiku", effort: "low", connectors: ["^mcp__slack__send"] });
  assert.equal(settings.port, 4800);
  assert.equal(settings.stackRequired, true, "no stack setting, so the extension is required");
});

test("a block that agrees with its alias reads the alias as stale, and a block that differs refuses the file naming both keys", () => {
  const agreeing = resolveProviders({ tickets: { linearKey: { path: "/k" }, providers: { tracker: { provider: "linear", key: { path: "/k" } } } } });
  assert.deepEqual(agreeing.aliases, [{ old: "tickets.linearKey", new: "tickets.providers.tracker.key", stale: true }]);
  assert.equal(agreeing.blocks.tracker.from, "block");
  assert.throws(() => resolveProviders({ tickets: { linearKey: { path: "/k" }, providers: { tracker: { provider: "linear", key: { path: "/other" } } } } }), (err: unknown) =>
    err instanceof TicketSettingsRefusal && err.field === "tickets.linearKey" && /tickets\.providers\.tracker\.key/.test(err.message));
});

test("a provider is refused by name when it is not one its concern names, or the block is not one of the five", () => {
  const refuses = (tickets: Record<string, unknown>, field: string) => assert.throws(() => parseTicketSettings({ clones, tickets }), (err: unknown) =>
    err instanceof TicketSettingsRefusal && err.field === field, JSON.stringify(tickets));
  refuses({ providers: { tracker: { provider: "jira" } } }, "tickets.providers.tracker.provider");
  refuses({ providers: { publish: { provider: "linear" } } }, "tickets.providers.publish.provider");
  refuses({ providers: { exposure: { provider: "funnel" } } }, "tickets.providers.exposure.provider");
  refuses({ providers: { jira: { provider: "jira" } } }, "tickets.providers.jira");
  refuses({ providers: { tracker: "linear" } }, "tickets.providers.tracker");
  refuses({ providers: { tracker: { key: { path: "/k" } } } }, "tickets.providers.tracker.provider");
  refuses({ providers: { exposure: { port: 5000 } } }, "tickets.providers.exposure.provider");
});

test("a setting its provider does not take is refused by name, and so is a bad value of one", () => {
  const refuses = (tickets: Record<string, unknown>, field: string) => assert.throws(() => parseTicketSettings({ clones, tickets }), (err: unknown) =>
    err instanceof TicketSettingsRefusal && err.field === field, JSON.stringify(tickets));
  refuses({ providers: { reviewer: { provider: "atomic", model: "opus" } } }, "tickets.providers.reviewer.model");
  refuses({ providers: { publish: { provider: "none", run: RUN } } }, "tickets.providers.publish.run");
  refuses({ providers: { exposure: { provider: "local", tailnetPorts: { ui: 9443 } } } }, "tickets.providers.exposure.tailnetPorts");
  refuses({ providers: { exposure: { provider: "tailscale", tailnetPorts: { ui: 9443, terminal: 9443 } } } }, "tickets.providers.exposure.tailnetPorts");
  refuses({ providers: { exposure: { provider: "tailscale", port: 0 } } }, "tickets.providers.exposure.port");
  refuses({ providers: { exposure: { provider: "local" } }, servePorts: { ui: 9443 } }, "tickets.servePorts");
  refuses({ providers: { tracker: { provider: "linear", connectors: ["slack"] } } }, "tickets.providers.tracker.connectors[0]");
  refuses({ providers: { tracker: { provider: "linear", workingState: "  " } } }, "tickets.providers.tracker.workingState");
  refuses({ providers: { codeHost: { provider: "github", stack: "yes" } } }, "tickets.providers.codeHost.stack");
  refuses({ providers: { publish: { provider: "slack", run: "post" } } }, "tickets.providers.publish.run");
  refuses({ providers: { exposure: { provider: "tailscale" } }, serve: "funnel" }, "tickets.serve");
  refuses({ providers: { reviewer: { provider: "none" } }, reviewer: "atomic" }, "tickets.reviewer");
});

test("a provider's defaults are the ones a host file with no block takes, so an absent block changes nothing", () => {
  const settings = parseTicketSettings({ clones, tickets: {} });
  assert.equal(settings.publish, null, "publish none");
  assert.equal(settings.reviewer, null, "reviewer none");
  assert.deepEqual([settings.providers.blocks.exposure.provider, settings.providers.blocks.exposure.from], ["local", "default"], "exposure local");
  assert.equal(settings.port, 4747);
  assert.equal(settings.uiPort, 4748);
  assert.equal(settings.terminal, null);
  assert.equal(settings.providers.blocks.tracker.settings.key.value, undefined, "tracker linear, whose key the plugin defaults to the Keychain service");
  assert.deepEqual(settings.connectors, []);
  assert.equal(settings.stackRequired, true);
});

test("a block's settings are read in their own place: the tracker's connectors, the exposure's ports and the code host's stack", () => {
  const settings = parseTicketSettings({ clones, tickets: {
    providers: {
      tracker: { provider: "linear", connectors: [LINEAR], workingState: "In Progress", plannedState: "Planned" },
      exposure: { provider: "tailscale", port: 5000, uiPort: 5001, terminal: TERMINAL, tailnetPorts: { ui: 7443, terminal: 7444 } },
      codeHost: { provider: "github", stack: false },
      publish: { provider: "slack", run: RUN, connectors: ["^mcp__slack__send"] },
      reviewer: { provider: "atomic" },
    },
    connectors: [DESIGN],
    plan: PLAN,
  } });
  assert.deepEqual(settings.connectors, [LINEAR, DESIGN], "the tracker's, then the rest of tickets.connectors");
  assert.equal(settings.workingState, "In Progress");
  assert.equal(settings.planner, null, "no planner named");
  assert.deepEqual(settings.providers.blocks.exposure.settings.tailnetPorts.value, { ui: 7443, terminal: 7444 });
  assert.equal(settings.port, 5000);
  assert.equal(settings.uiPort, 5001);
  assert.equal(settings.stackRequired, false);
  assert.equal(settings.reviewer, "atomic");
  assert.deepEqual(settings.publish, { run: RUN, model: "haiku", effort: "low", connectors: ["^mcp__slack__send"] });
});

// A11-158: a block is an agent-org plugin's config. `provider` names a plugin of the registry, `enabled` switches it, and the rules of the registry are the reader's.
const NO_PACKAGES = { directories: () => [], text: () => null, isFile: () => false };
/** The built-ins and fakes, with no pin, so a fake may be enabled; and `pins` for a test of the pin. */
const unpinned = (): Catalog => buildCatalog({ root: "/none", files: NO_PACKAGES, pins: {} });
const refusalOf = (host: Record<string, unknown>, catalog?: Catalog): TicketSettingsRefusal => {
  try {
    resolveProviders(host, catalog);
  } catch (error) {
    if (error instanceof TicketSettingsRefusal) return error;
    throw error;
  }
  throw new assert.AssertionError({ message: `the host file was not refused: ${JSON.stringify(host)}` });
};

test("A11-158: `enabled` is absent for every host file there is, and absent is true", () => {
  const providers = resolveProviders({ tickets: { providers: { publish: { provider: "slack", run: RUN }, tracker: { provider: "linear" } } } });
  assert.deepEqual(Object.values(providers.blocks).map(({ enabled }) => enabled), [true, true, true, true, true]);
  assert.equal(isActive(providers.blocks.publish), true);
  assert.equal(isActive(providers.blocks.reviewer), false, "none runs no plugin, enabled or not");
});

test("A11-158: `enabled: false` keeps the plugin named and its settings read, and the block is no longer active", () => {
  const providers = resolveProviders({ tickets: { providers: { publish: { provider: "slack", run: RUN, enabled: false, connectors: ["^mcp__slack__send"] } } } });
  assert.equal(providers.blocks.publish.provider, "slack");
  assert.equal(providers.blocks.publish.enabled, false);
  assert.equal(isActive(providers.blocks.publish), false);
  assert.equal(providers.blocks.publish.settings.run?.value, RUN, "its settings are kept for `enable`");
});

test("A11-158: the only tracker and the only code host cannot be disabled: refused by name, saying why", () => {
  const tracker = refusalOf({ tickets: { providers: { tracker: { provider: "linear", enabled: false } } } });
  assert.equal(tracker.field, "tickets.providers.tracker.enabled");
  assert.match(tracker.message, /`tickets\.providers\.tracker\.enabled` in the host file is false, but linear is the only tracker, and exactly one tracker must be enabled: leave it enabled/);
  const codeHost = refusalOf({ tickets: { providers: { codeHost: { provider: "github", enabled: false } } } });
  assert.equal(codeHost.field, "tickets.providers.codeHost.enabled");
  assert.match(codeHost.message, /github is the only code host, and exactly one code host must be enabled/);
  for (const [block, provider] of [["publish", "slack"], ["reviewer", "atomic"], ["exposure", "tailscale"]] as const) {
    const accepted = resolveProviders({ tickets: { providers: { [block]: { provider, enabled: false, ...(block === "publish" ? { run: RUN } : {}) } } } });
    assert.equal(accepted.blocks[block].enabled, false, `${block} may be disabled`);
  }
});

test("A11-158: `enabled` that is not true or false is refused by name", () => {
  assert.equal(refusalOf({ tickets: { providers: { publish: { provider: "slack", run: RUN, enabled: "no" } } } }).field, "tickets.providers.publish.enabled");
  assert.equal(refusalOf({ tickets: { providers: { tracker: { provider: "linear", enabled: 0 } } } }).field, "tickets.providers.tracker.enabled");
});

test("A11-158: a disabled plugin's settings are still validated, so `enable` cannot restore what the reader refuses", () => {
  assert.throws(() => parseTicketSettings({ clones, tickets: { providers: { exposure: { provider: "tailscale", enabled: false, port: 0 } } } }),
    (err: unknown) => err instanceof TicketSettingsRefusal && err.field === "tickets.providers.exposure.port");
  assert.equal(refusalOf({ tickets: { providers: { reviewer: { provider: "atomic", enabled: false, model: "opus" } } } }).field, "tickets.providers.reviewer.model");
});

test("A11-158: a plugin that implements a contract major this agent-org does not read is refused by name at start, when its block enables it", () => {
  const catalog = buildCatalog({ root: "/none", files: NO_PACKAGES, pins: {} });
  const unread = { ...catalog, plugins: catalog.plugins.map((plugin) => (plugin.name === "fake-tracker" ? { ...plugin, contract: "2.0" } : plugin)) };
  const refused = refusalOf({ tickets: { providers: { tracker: { provider: "fake-tracker" } } } }, unread);
  assert.equal(refused.field, "tickets.providers.tracker.provider");
  assert.match(refused.message, /is refused: plugin fake-tracker implements tracker contract 2\.0; this agent-org reads tracker 1\.x: update agent-org, or use a plugin of a major it reads/);
  const disabled = resolveProviders({ tickets: { providers: { publish: { provider: "fake-publisher", enabled: false } } } }, unread);
  assert.equal(disabled.blocks.publish.enabled, false);
  assert.equal(resolveProviders({ tickets: { providers: { tracker: { provider: "fake-tracker", enabled: true } } } }, unpinned()).blocks.tracker.provider, "fake-tracker", "the same plugin at a major it reads is accepted");
});

test("A11-158: while core runs a concern's built-in, any other plugin enabled for it is refused, naming the plugin, the built-in and the ticket that moves it", () => {
  const refused = refusalOf({ tickets: { providers: { reviewer: { provider: "fake-reviewer" } } } });
  assert.equal(refused.field, "tickets.providers.reviewer.provider");
  assert.match(refused.message, /is refused: fake-reviewer is a reviewer plugin, but this release runs the reviewer in core as atomic until A11-161: name "atomic"/);
  assert.equal(resolveProviders({ tickets: { providers: { exposure: { provider: "fake-exposure" } } } }).blocks.exposure.provider, "fake-exposure", "the exposure has no pin since A11-162: local and tailscale are bundled packages, and a fake is refused when a person installs or enables it, and at start");
  assert.equal(resolveProviders({ tickets: { providers: { tracker: { provider: "fake-tracker", enabled: true } } } }, unpinned()).blocks.tracker.provider, "fake-tracker", "no pin, no refusal");
  assert.equal(resolveProviders({ tickets: { providers: { tracker: { provider: "fake-tracker" } } } }).blocks.tracker.provider, "fake-tracker", "the tracker has no pin since A11-159: linear is a bundled package, and a fake is refused when a person installs or enables it, and at start");
  assert.equal(resolveProviders({ tickets: { providers: { publish: { provider: "fake-publisher", enabled: false } } } }).blocks.publish.enabled, false, "a disabled plugin is not run, so the pin has nothing to refuse");
  assert.equal(resolveProviders({ tickets: { providers: { codeHost: { provider: "fake-codeHost" } } } }).blocks.codeHost.provider, "fake-codeHost", "the code host has no pin since A11-160: github is a bundled package, and a fake is refused at start");
});

test("A11-158: a plugin of another concern, and one the registry does not hold, are refused by name listing what the block may name", () => {
  const wrongConcern = refusalOf({ tickets: { providers: { tracker: { provider: "slack" } } } });
  assert.equal(wrongConcern.field, "tickets.providers.tracker.provider");
  assert.match(wrongConcern.message, /must be one of "linear", not "slack"/, "the fake is pinned off, so it is not offered");
  assert.match(refusalOf({ tickets: { providers: { publish: { provider: "jira" } } } }).message, /must be one of "slack", "none", not "jira"/);
});

test("A11-158: a block that names a plugin the registry refused says why it was refused", () => {
  const catalog = { ...unpinned(), refusals: [{ plugin: "linear-tools", why: "plugin linear-tools: package.json declares dependencies (left-pad)" }] };
  const refused = refusalOf({ tickets: { providers: { tracker: { provider: "linear-tools" } } } }, catalog);
  assert.match(refused.message, /names a plugin that was refused: plugin linear-tools: package\.json declares dependencies \(left-pad\)/);
});

test("A11-158: a plugin takes the settings it declares and no others", () => {
  assert.equal(refusalOf({ tickets: { providers: { publish: { provider: "fake-publisher", run: RUN } } } }, unpinned()).field, "tickets.providers.publish.run");
  assert.match(refusalOf({ tickets: { providers: { tracker: { provider: "linear", port: 1 } } } }).message, /is not a setting of linear: its settings are provider, enabled, key, connectors, workingState, plannedState, takenStates/);
});

test("A11-158: a setting `none` does not take is refused naming the block, since `none` is no plugin", () => {
  assert.match(refusalOf({ tickets: { providers: { reviewer: { provider: "none", model: "x" } } } }).message, /is not a setting of reviewer: its settings are provider, enabled/);
});

test("A11-160: the providers of a host file's text are read leniently: a missing file, text that is not JSON and one the reader refuses are the defaults; a file that reads is its own", () => {
  assert.equal(providersOfText(null).blocks.codeHost.provider, "github");
  assert.equal(providersOfText("{ not json").blocks.codeHost.provider, "github");
  const refused = providersOfText(JSON.stringify({ gh: { workers: "/w" }, tickets: { providers: { codeHost: { provider: "gitlab" } } } }));
  assert.equal(refused.blocks.codeHost.settings.gh.value, undefined, "a refused file names no setting");
  const reads = providersOfText(JSON.stringify({ gh: { workers: "/w" }, tickets: {} }));
  assert.deepEqual(reads.blocks.codeHost.settings.gh.value, { workers: "/w" });
});
