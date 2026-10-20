// no-token: gh -- the view is pure: its inputs are objects written in the test, and a secret's file is written to a temporary folder only to prove its text never shows
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GROUPS, SCHEMA } from "./config-schema.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { settingsView, type Row, type Section, type View, type ViewInput } from "./settings-view.ts";
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

test("every group the view draws is one the page names, in the page's order", () => {
  const view = viewOf({ host: { tickets: { reviewer: "atomic" } } });
  const order = view.groups.map((group) => group.group);
  assert.deepEqual(order, GROUPS.filter((group) => order.includes(group)));
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
  assert.equal(rowsOf(view).some((candidate) => candidate.file === "host.json" && candidate.group === "GitHub"), false);
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
