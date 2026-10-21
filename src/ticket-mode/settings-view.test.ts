// no-token: gh -- the view is pure: its inputs are objects written in the test, and a secret's file is written to a temporary folder only to prove its text never shows
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GROUPS } from "./config-schema.ts";
import { defaultSchema } from "../plugins/schema.ts";

/** The schema the page and the readers use: core's entries and the bundled plugins' settings (A11-159). */
const SCHEMA = defaultSchema();
import { tmpDir } from "../lib/tmp-fixture.ts";
import { PAGE_ORDER, settingsView, type Row, type Section, type View, type ViewInput } from "./settings-view.ts";
import type { PluginState } from "./plugins.ts";

const read = (file: string, raw: Record<string, unknown>): Section => ({ file, raw, refusal: null });
const refused = (file: string, message: string): Section => ({ file, raw: null, refusal: message });
const absent = (file: string): Section => ({ file, raw: null, refusal: null });
const NO_PLUGINS = { readable: true, plugins: [] as PluginState[] };

/** The view of a host file and a project, with the defaults every test shares: no saved choice, and a queue of three from the built-in default. */
type Overrides = Omit<Partial<ViewInput>, "host" | "tickets" | "project"> & { host?: Record<string, unknown> | null; tickets?: Record<string, unknown> | null; project?: Record<string, unknown> };
function viewOf(overrides: Overrides = {}): View {
  const hostRaw = overrides.host ?? {};
  const ticketsRaw = overrides.tickets ?? (hostRaw.tickets as Record<string, unknown> | undefined) ?? {};
  return settingsView({
    entries: SCHEMA,
    host: overrides.host === null ? refused("host.json", "host.json refused") : read("host.json", hostRaw),
    tickets: overrides.tickets === null ? refused("host.json (tickets)", "tickets refused") : read("host.json (tickets)", ticketsRaw),
    project: overrides.project === undefined ? absent("project.json") : read("project.json", overrides.project),
    notes: overrides.notes ?? [],
    choice: overrides.choice ?? { saved: {}, host: {} },
    queue: overrides.queue ?? { max: 3, source: "built-in default" },
    plugins: overrides.plugins ?? NO_PLUGINS,
    exists: overrides.exists ?? (() => false),
  });
}

const rowsOf = (view: View) => view.groups.flatMap((group) => group.rows);
const row = (view: View, key: string): Row => {
  const found = rowsOf(view).find((candidate) => candidate.key === key);
  assert.ok(found, `a row for ${key}`);
  return found;
};

test("every group the view draws is one the page names, in the page's order, and the page's order names each group once", () => {
  assert.deepEqual([...PAGE_ORDER].sort(), [...GROUPS].sort(), "the page's order names every group, once");
  const view = viewOf({ host: { tickets: { reviewer: "atomic" } } });
  const order = view.groups.map((group) => group.group);
  assert.deepEqual(order, PAGE_ORDER);
  for (const group of view.groups) for (const candidate of group.rows) assert.equal(candidate.group, group.group);
});

test("a switch that is absent is disabled, one that is set is enabled, and a false one is disabled", () => {
  assert.equal(row(viewOf({ host: { tickets: {} } }), "tickets.reviewer").state, "disabled", "absent reviewer is off");
  assert.equal(row(viewOf({ host: { tickets: { reviewer: "atomic" } } }), "tickets.reviewer").state, "enabled");
  assert.equal(row(viewOf({ host: { tickets: { drafts: false } } }), "tickets.drafts").state, "disabled");
  assert.equal(row(viewOf({ host: { tickets: { drafts: false } } }), "tickets.drafts").value, "false", "the value the file holds is the one shown");
});

test("a key with a built-in default that is absent shows that default, as the default state", () => {
  const drafts = row(viewOf({ host: { tickets: {} } }), "tickets.drafts");
  assert.deepEqual([drafts.state, drafts.value, drafts.source], ["default", "true", "built-in default"]);
  const stall = row(viewOf({ host: { tickets: { stallMinutes: 12 } } }), "tickets.stallMinutes");
  assert.deepEqual([stall.state, stall.value, stall.source], ["enabled", "12", "host.json"]);
});

test("a key nothing applies to shows not set, and a child of an absent block is not set", () => {
  const workingState = row(viewOf({ host: { tickets: {} } }), "tickets.workingState");
  assert.deepEqual([workingState.state, workingState.value], ["not set", "not set"]);
  const writerModel = row(viewOf({ host: { tickets: {} } }), "tickets.writer.model");
  assert.equal(writerModel.state, "not set", "the writer's model has a default, but no writer is set, so none applies");
});

test("the source is the file a set key came from, and the built-in default otherwise", () => {
  const view = viewOf({ host: { tickets: { max: 5 } }, project: { schema: 1 } });
  assert.equal(row(view, "tickets.max").source, "built-in default", "the queue names no max here, so the view reads the queue's own source");
  assert.equal(row(viewOf({ host: { schema: 1 } }), "schema").source, "host.json", "a key of the host file's top level");
});

test("the workers at once number says whether the queue file or the host file gives it", () => {
  const fromQueue = row(viewOf({ queue: { max: 4, source: "queue.json" } }), "tickets.max");
  assert.deepEqual([fromQueue.value, fromQueue.source, fromQueue.state], ["4", "queue.json", "enabled"]);
  const fromHost = row(viewOf({ host: { tickets: { max: 5 } }, queue: { max: 5, source: "host.json" } }), "tickets.max");
  assert.deepEqual([fromHost.source, fromHost.state], ["host.json", "enabled"]);
  const fromBuiltIn = row(viewOf({ queue: { max: 3, source: "built-in default" } }), "tickets.max");
  assert.deepEqual([fromBuiltIn.source, fromBuiltIn.state], ["built-in default", "default"]);
});

test("a saved choice is in force from choice.json, and the host file's writer choice is the fallback before it", () => {
  const saved = rowsOf(viewOf({ choice: { saved: { model: "sonnet" }, host: {} } })).find((candidate) => candidate.key === "model");
  assert.deepEqual([saved?.value, saved?.source, saved?.state], ["sonnet", "choice.json", "enabled"]);
  const fallback = rowsOf(viewOf({ choice: { saved: {}, host: { writerModel: "sonnet" } } })).find((candidate) => candidate.key === "writerModel");
  assert.deepEqual([fallback?.value, fallback?.source, fallback?.state], ["sonnet", "host.json", "default"]);
  const built = rowsOf(viewOf()).find((candidate) => candidate.key === "planEffort");
  assert.deepEqual([built?.value, built?.source], ["high", "built-in default"]);
});

test("a refused file shows its refusal and no rows of its own, and the other sections still render", () => {
  const view = viewOf({ host: { tickets: { drafts: "yes" } }, tickets: null });
  assert.deepEqual(view.refusals, [{ file: "host.json (tickets)", message: "tickets refused" }]);
  assert.equal(rowsOf(view).some((candidate) => candidate.key.startsWith("tickets.") && candidate.file === "host.json"), false, "no ticket key is drawn from the refused block");
  assert.ok(rowsOf(view).some((candidate) => candidate.key === "workers.haikuBrief"), "the host file's own keys still draw when the block is refused");
  assert.ok(rowsOf(view).some((candidate) => candidate.key === "schema" && candidate.file === "host.json"), "and so does its top level");
});

test("a host file that is refused draws none of its own keys, and names the refusal as its message", () => {
  const view = viewOf({ host: null, tickets: {} });
  assert.deepEqual(view.refusals.map((r) => r.file), ["host.json"]);
  assert.equal(rowsOf(view).some((candidate) => candidate.file === "host.json" && (candidate.key === "gh" || candidate.key.startsWith("gh.") || candidate.key.startsWith("github"))), false,
    "the host file's own gh and github keys are not drawn, though the tickets block's code host keys are");
});

test("a machine with no project declaration says so as a note, not as a refusal", () => {
  const view = viewOf({ notes: ["This machine declares no project"] });
  assert.deepEqual(view.refusals, []);
  assert.deepEqual(view.notes, ["This machine declares no project"]);
  assert.equal(rowsOf(view).some((candidate) => candidate.file === "project.json"), false);
});

test("a secret shows its path and whether the file is there, and none of its text", () => {
  const dir = tmpDir("settings-view-secret-");
  const keyFile = join(dir, "linear.key");
  writeFileSync(keyFile, "lin_api_SECRET_TEXT_DO_NOT_SHOW\n");
  const view = viewOf({ host: { tickets: { linearKey: { path: keyFile } }, events: { receiver: { port: 8787, secretPath: join(dir, "hook.secret"), tunnel: "cloudflare" } } },
    exists: (path) => path === keyFile });
  const path = row(view, "tickets.linearKey.path");
  assert.equal(path.secret, true);
  assert.equal(path.value, `${keyFile} (the file exists)`);
  assert.equal(row(view, "events.receiver.secretPath").value, `${join(dir, "hook.secret")} (the file is missing)`);
  assert.equal(JSON.stringify(view).includes("SECRET_TEXT"), false, "the key's text is not in the answer");
});

test("a Keychain key names its service, and says the page does not read the key", () => {
  const view = viewOf({ host: { tickets: { linearKey: { keychain: "agent-org-linear" } } } });
  assert.equal(row(view, "tickets.linearKey.keychain").value, "the Keychain service agent-org-linear; this page does not read the key");
  assert.equal(row(view, "tickets.linearKey").value, "a Keychain service, named below");
});

test("a list's items show under the list, one row per field", () => {
  const view = viewOf({ host: { tickets: { deny: [{ pattern: "rm -rf", reason: "it deletes" }, { pattern: "chmod 777", reason: "it opens files" }] } } });
  assert.equal(row(view, "tickets.deny").value, "2 items");
  assert.equal(row(view, "tickets.deny[].pattern").value, "rm -rf; chmod 777");
  assert.equal(row(view, "tickets.deny[].reason").depth, 2);
});

test("a plugin's installs, and whether a worker's session loads it, are said in words, with the fix", () => {
  const plugins: PluginState[] = [
    { plugin: "a@m", installs: [{ scope: "user", projectPath: null }], loads: true, why: null, installPath: "/cache/a" },
    { plugin: "b@m", installs: [{ scope: "project", projectPath: "/x" }], loads: false, why: "b@m is installed only for /x: install it for every folder.", installPath: null },
    { plugin: "c@m", installs: [], loads: null, why: null, installPath: null },
  ];
  const lines = viewOf({ plugins: { readable: true, plugins } }).plugins;
  assert.deepEqual(lines.map((line) => line.loads), ["a worker's session loads it", "only a worker in /x loads it; to load it for every worker, install it for every folder with `claude plugin install b@m --scope user`.",
    "not checked: its entry in the install record is not one this page knows"]);
  assert.equal(lines[0].installed, "installed for every folder");
  assert.equal(lines[1].installed, "installed for the folder /x");
});

test("an unreadable install record is not checked, never loaded", () => {
  const lines = viewOf({ plugins: { readable: false, plugins: [{ plugin: "a@m", installs: [], loads: null, why: null, installPath: null }] } }).plugins;
  assert.deepEqual(lines, [{ plugin: "a@m", installed: "not installed", loads: "not checked: Claude Code's install record cannot be read" }]);
});

test("the connectors and deny rules say in plain words what a worker may call and what it is refused, and why", () => {
  const view = viewOf({ host: { tickets: { connectors: ["^mcp__linear__(get|list|search|extract)_"], deny: [{ pattern: "rm -rf", reason: "it deletes" }],
    publish: { run: "publish {prs} {dir}", connectors: ["^mcp__slack__send"] } } } });
  assert.deepEqual(view.words, [
    "A worker may call any tool of the connector `linear` whose name matches `^mcp__linear__(get|list|search|extract)_`.",
    "A command matching `rm -rf` is refused, because it deletes.",
    "The publish run may call any tool of the connector `slack` whose name matches `^mcp__slack__send`.",
  ]);
});

test("the explanation and what breaks are carried on every row, so the page can say both", () => {
  for (const candidate of rowsOf(viewOf({ host: { tickets: { reviewer: "atomic", drafts: false } } }))) {
    assert.ok(candidate.explanation.length > 0 && candidate.breaks.length > 0, candidate.key);
  }
});

test("a plugin installed only for one folder is not said to be missing from every worker: only a worker in that folder gets it", () => {
  const plugins: PluginState[] = [{ plugin: "p@m", installs: [{ scope: "project", projectPath: "/work/NBF-1" }], loads: false, why: "p@m is installed only for /work/NBF-1, so a worker in <ticket> runs without it", installPath: null }];
  const [line] = viewOf({ plugins: { readable: true, plugins } }).plugins;
  assert.equal(line.loads, "only a worker in /work/NBF-1 loads it; to load it for every worker, install it for every folder with `claude plugin install p@m --scope user`.");
});

test("the rows say which keys the page changes in place, and for a key it does not, why not", () => {
  const view = viewOf({ host: { tickets: { providers: { tracker: { provider: "linear" } } } } });
  const provider = row(view, "tickets.providers.tracker.provider");
  assert.deepEqual([provider.editable, provider.input], [false, null]);
  assert.match(provider.why ?? "", /Plugins section.s controls, or `agent-org plugin`/, "a provider is changed by the Plugins section or the CLI, which says why");
  const path = row(view, "tickets.providers.tracker.key.path");
  assert.deepEqual([path.editable, path.why], [true, null], "an editable key has no reason not to be");
  assert.match(row(view, "tickets.providers.tracker.key").why ?? "", /tickets\.providers\.tracker\.key\.path/, "a container says which key changes it");
});

test("the choices and the number of workers, which the controls below the sections change, are read-only rows that say so", () => {
  const view = viewOf({ host: { tickets: { max: 4 } } });
  for (const key of ["model", "effort", "tickets.max"]) {
    const found = row(view, key);
    assert.deepEqual([found.editable, found.input], [false, null], `${key} is not changed in place`);
    assert.match(found.why ?? "", /controls below the sections/, `${key} says the controls below change it`);
  }
});

test("an old key that is set shows where its new key is, in place of its value, with the names its segments carry", () => {
  const view = viewOf({ host: { tickets: { linearKey: { keychain: "agent-org-linear" } }, github: { identity: { scheduler: { mode: "github-apps" } } } } });
  assert.equal(row(view, "tickets.linearKey").alias, "Alias of tickets.providers.tracker.key: run agent-org doctor --fix");
  assert.equal(row(view, "github.identity.scheduler.mode").alias, "Alias of tickets.providers.codeHost.identity.scheduler.mode: run agent-org doctor --fix");
  assert.equal(row(view, "github.identity.scheduler.mode").editable, false, "an alias is shown, not changed");
});

test("an old key that is not set shows no alias, and its value is as it was; an old key that is set is in use", () => {
  const view = viewOf({ host: { tickets: {} } });
  assert.deepEqual([row(view, "tickets.linearKey").alias ?? "no alias", row(view, "tickets.linearKey").state], ["no alias", "default"], "its built-in default still says so");
  assert.equal(row(view, "tickets.linearKey").inUse, false, "an old key nothing sets is not in use");
  assert.equal(row(viewOf({ host: { tickets: { linearKey: { keychain: "x" } } } }), "tickets.linearKey").inUse, true, "an old key that is set is in use");
});

test("a provider whose block is missing says so, and says it is set by aliases while an old key of its block is set", () => {
  const missing = row(viewOf({ host: { tickets: {} } }), "tickets.providers.tracker.provider");
  assert.deepEqual([missing.value, missing.state], ["linear", "default"]);
  const byAlias = row(viewOf({ host: { tickets: { linearKey: { keychain: "agent-org-linear" } } } }), "tickets.providers.tracker.provider");
  assert.deepEqual([byAlias.value, byAlias.state, byAlias.source], ["set by aliases", "enabled", "host.json"], "in force from the file, through its old key");
  const held = row(viewOf({ host: { tickets: { providers: { tracker: { provider: "linear" } }, linearKey: { keychain: "agent-org-linear" } } } }), "tickets.providers.tracker.provider");
  assert.equal(held.value, "linear", "a block the file holds keeps its own provider");
});

test("a role's App fields matter only while the role uses a GitHub App, and are not in use until they are set; the role and its mode always are", () => {
  const host = { tickets: { providers: { codeHost: { identity: { scheduler: { mode: "user-accounts" }, reviewer: { mode: "github-apps" } } } } } };
  const view = viewOf({ host });
  const app = "tickets.providers.codeHost.identity";
  assert.equal(row(view, `${app}.scheduler.appId`).inUse, false, "a user-accounts role's App id is not in use");
  assert.equal(row(view, `${app}.reviewer.appId`).inUse, true, "a github-apps role's App id is in use");
  assert.equal(row(view, `${app}.scheduler.mode`).inUse, true);
  assert.equal(row(view, `${app}.scheduler`).inUse, true);
  const stray = viewOf({ host: { tickets: { providers: { codeHost: { identity: { scheduler: { mode: "user-accounts", appId: 7 } } } } } } });
  assert.equal(row(stray, `${app}.scheduler.appId`).inUse, true, "an App id that is set is in use, so a refusal for it is seen");
});

test("a role is one row that shows its mode, and its own keys sit inside it; the routing gh's keys sit inside gh", () => {
  const view = viewOf({ host: { tickets: { providers: { codeHost: { identity: { scheduler: { mode: "github-apps" } }, gh: { workers: "/w" } } } } } });
  const role = row(view, "tickets.providers.codeHost.identity.scheduler");
  assert.deepEqual([role.value, role.nest], ["github-apps", null], "the role shows its mode, and sits at the top");
  assert.equal(row(view, "tickets.providers.codeHost.identity.scheduler.mode").nest, "tickets.providers.codeHost.identity.scheduler");
  assert.equal(row(view, "tickets.providers.codeHost.gh.workers").nest, "tickets.providers.codeHost.gh");
  assert.equal(row(view, "tickets.providers.codeHost.gh").nest, null);
});

test("the machine's plumbing is in Machine alone, and each provider's settings are in that provider's own section", () => {
  const view = viewOf({});
  const groupOf = (key: string) => view.groups.find((group) => group.rows.some((candidate) => candidate.key === key))?.group;
  for (const key of ["schema", "home", "binDir", "projects", "tool"]) assert.equal(groupOf(key), "Machine", `${key} is machine plumbing`);
  assert.equal(groupOf("tickets.providers.tracker.provider"), "Tracker");
  assert.equal(groupOf("tickets.providers.exposure.port"), "Exposure");
  assert.equal(groupOf("tickets.providers.codeHost.gh.workers"), "Code host");
  assert.equal(groupOf("tickets.providers.publish.run"), "Publisher");
  assert.equal(groupOf("tickets.providers.reviewer.provider"), "Reviewer");
});
