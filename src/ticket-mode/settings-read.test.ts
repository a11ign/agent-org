// no-token: gh -- reads temporary host and project files written by the test, and runs the real project reader on them; nothing outside the temporary folder
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { parseTicketSettings } from "./settings.ts";
import { readSettingsView, type SettingsReadOptions } from "./settings-read.ts";
import type { View } from "./settings-view.ts";

/** The options a page read needs, with the files the test writes in one temporary folder. */
function options(dir: string, hostPath: string, extra: Partial<SettingsReadOptions> = {}): SettingsReadOptions {
  return { hostPath, settings: parseTicketSettings({ clones: { r: "/r" }, stateDir: dir }), queuePath: join(dir, "queue.json"), queueMax: 3, choicePath: join(dir, "choice.json"), ...extra };
}
const rowsIn = (view: View) => view.groups.flatMap((group) => group.rows);
const NO_PROJECT = /declares no project/;

/** A host file that names a primary project, so the machine is not a ticket-only one. */
function primaryHost(dir: string): string {
  const path = join(dir, "host.json");
  writeFileSync(path, JSON.stringify({ schema: 1, home: dir, binDir: join(dir, "bin"), primary: "app", projects: [{ id: "app", checkout: join(dir, "app") }],
    clones: { r: "/r" }, stateDir: dir, gh: { workers: join(dir, "w"), leads: join(dir, "l"), leadsHeader: [], leadsWorkspaces: [] }, tickets: {} }));
  return path;
}

test("a project the readers cannot resolve is a refusal of the project, not the note that no project is declared", async () => {
  const dir = tmpDir("settings-read-unresolved-");
  const view = await readSettingsView(options(dir, primaryHost(dir), {
    loadProject: async () => { throw new Error("ticket mode: `AGENT_ORG_HOST` REFUSED: the project cannot be resolved"); },
  }));
  assert.deepEqual(view.refusals.filter((r) => r.file === "project.json").map((r) => r.message), ["ticket mode: `AGENT_ORG_HOST` REFUSED: the project cannot be resolved"]);
  assert.equal(view.notes.some((note) => NO_PROJECT.test(note)), false, "the failure is not reported as a machine with no project");
});

test("a project declaration that is read and refused names its field, and the rest of the page still draws", async () => {
  const dir = tmpDir("settings-read-refused-");
  const project = join(dir, "project.json");
  writeFileSync(project, JSON.stringify({ schema: 1, tracker: [], code: [{ key: "", repo: "owner/app" }] }));
  const view = await readSettingsView(options(dir, primaryHost(dir), { projectPath: project }));
  assert.equal(view.refusals.find((r) => r.file === "project.json")?.message.includes("`tracker`"), true, "the refusal names the field");
  assert.ok(rowsIn(view).some((row) => row.key === "tickets.max"), "the ticket keys still draw");
});

test("a valid project declaration draws its keys from the file as it is", async () => {
  const dir = tmpDir("settings-read-valid-");
  const project = join(dir, "project.json");
  writeFileSync(project, JSON.stringify({ schema: 1, tracker: [{ key: "", repo: "owner/app", board: { owner: "owner", number: 1 } }], code: [{ key: "", repo: "owner/app" }] }));
  const view = await readSettingsView(options(dir, primaryHost(dir), { projectPath: project }));
  assert.deepEqual(view.refusals.filter((r) => r.file === "project.json"), []);
  const tracker = rowsIn(view).find((row) => row.key === "tracker");
  assert.deepEqual([tracker?.file, tracker?.source, tracker?.state], ["project.json", "project.json", "enabled"]);
});

test("a ticket-only host, which names no primary, is a note that it declares no project, and no refusal", async () => {
  const dir = tmpDir("settings-read-ticket-only-");
  const path = join(dir, "host.json");
  writeFileSync(path, JSON.stringify({ clones: { r: "/r" }, stateDir: dir, tickets: { max: 2 } }));
  const view = await readSettingsView(options(dir, path));
  assert.equal(view.notes.some((note) => NO_PROJECT.test(note)), true);
  assert.deepEqual(view.refusals.filter((r) => r.file === "project.json"), []);
});

/** A plugin the session loads, whose install holds the manifest `metadata` names, and the install record that names it. */
function pluginWithContract(dir: string, agentOrg: unknown): string {
  const install = join(dir, "install");
  mkdirSync(join(install, ".claude-plugin"), { recursive: true });
  writeFileSync(join(install, ".claude-plugin", "plugin.json"), JSON.stringify(agentOrg === undefined ? { name: "a11ign" } : { name: "a11ign", metadata: { agentOrg } }));
  const record = join(dir, "installed_plugins.json");
  writeFileSync(record, JSON.stringify({ version: 2, plugins: { "a11ign@m": [{ scope: "user", installPath: install }] } }));
  return record;
}

/** The page's view of a plugin the session loads, declaring `agentOrg`, against a host whose `tickets` keys are `tickets`. */
function viewOfPlugin(dir: string, agentOrg: unknown, tickets: Record<string, unknown> = {}): Promise<View> {
  const record = pluginWithContract(dir, agentOrg);
  const settings = parseTicketSettings({ clones: { r: "/r" }, stateDir: dir, tickets: { plugins: ["a11ign@m"], ...tickets } });
  return readSettingsView(options(dir, primaryHost(dir), { settings, pluginRecord: record }));
}

test("the Settings page reads the same contract rows a run start refuses on, and the plugin's line says it loads", async () => {
  const dir = tmpDir("settings-read-contract-");
  const record = pluginWithContract(dir, { contract: "2.0", agentOrg: ">=0.0.0 <1.0.0", provides: {}, needs: {} });
  const settings = parseTicketSettings({ clones: { r: "/r" }, stateDir: dir, tickets: { plugins: ["a11ign@m"] } });
  const view = await readSettingsView(options(dir, primaryHost(dir), { settings, pluginRecord: record }));
  assert.deepEqual(view.contract.map(({ plugin, kind }) => [plugin, kind]), [["a11ign@m", "contract-major"]]);
  assert.deepEqual(view.plugins.map(({ plugin, loads }) => [plugin, loads]), [["a11ign@m", "a worker's session loads it"]]);
});


test("a plugin's connector need that tickets.connectors does not allow is one row, naming the plugin and the key", async () => {
  const view = await viewOfPlugin(tmpDir("settings-read-connector-"), { contract: "1.0", agentOrg: ">=0.0.0 <999.0.0", provides: {}, needs: { connectors: ["^mcp__linear__get_"] } }, { connectors: ["^mcp__other__"] });
  assert.deepEqual(view.contract.map(({ plugin, kind }) => [plugin, kind]), [["a11ign@m", "connector-need"]]);
  assert.match(view.contract[0].why, /^a11ign@m needs the connector tools matched by \^mcp__linear__get_, which tickets\.connectors does not allow/);
});

test("a connector need that tickets.connectors already allows is no row", async () => {
  const view = await viewOfPlugin(tmpDir("settings-read-allowed-"), { contract: "1.0", agentOrg: ">=0.0.0 <999.0.0", provides: {}, needs: { connectors: ["^mcp__linear__get_"] } }, { connectors: ["^mcp__linear__get_"] });
  assert.deepEqual(view.contract, [], "the host allows the connector");
});

test("a plugin with no contract has no rows", async () => {
  const view = await viewOfPlugin(tmpDir("settings-read-no-contract-"), undefined);
  assert.deepEqual(view.contract, [], "a plugin with no contract declares none");
});
