// no-token: none -- pure: each host file is parsed here, and nothing is read from disk or the tracker
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALIASES_REFUSED_FROM, resolveProviders } from "./providers.ts";
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
  assert.deepEqual(settings.linearKey, { path: "/k/linear" });
  assert.deepEqual(settings.connectors, [LINEAR, SAVE, DESIGN]);
  assert.equal(settings.workingState, "In Progress");
  assert.equal(settings.planner?.state, "Planned");
  assert.deepEqual(settings.serve, { ui: 9443, terminal: 9444 });
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
  refuses({ providers: { tracker: { provider: "linear", key: "file" } } }, "tickets.providers.tracker.key");
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
  assert.equal(settings.serve, null, "exposure local");
  assert.equal(settings.port, 4747);
  assert.equal(settings.uiPort, 4748);
  assert.equal(settings.terminal, null);
  assert.deepEqual(settings.linearKey, { keychain: "agent-org-linear" }, "tracker linear with the Keychain service");
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
  assert.deepEqual(settings.serve, { ui: 7443, terminal: 7444 });
  assert.equal(settings.port, 5000);
  assert.equal(settings.uiPort, 5001);
  assert.equal(settings.stackRequired, false);
  assert.equal(settings.reviewer, "atomic");
  assert.deepEqual(settings.publish, { run: RUN, model: "haiku", effort: "low", connectors: ["^mcp__slack__send"] });
});
