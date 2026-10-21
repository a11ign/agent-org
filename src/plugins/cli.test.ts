// no-token: none -- every command runs against a scratch copy of a host file, in a scratch folder
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTicketSettings } from "../ticket-mode/settings.ts";
import { runPlugin } from "./cli.ts";
import { buildCatalog } from "./registry.ts";

const RUN = "post {prs} into {dir}";
const NOTE = "a note the person wrote, which a write keeps";

/** A host file as a person writes it: a `_` note and a layout that a write must not churn. */
const HOST = `{
  "_note": "${NOTE}",
  "clones": { "app": "/tmp/app" },
  "tickets": {
    "providers": {
      "tracker": { "provider": "linear" },
      "publish": { "provider": "slack", "run": "${RUN}", "connectors": ["^mcp__slack__send"] },
      "exposure": { "provider": "tailscale", "port": 5000 }
    }
  }
}
`;

type Run = Readonly<{ status: number; out: string; err: string }>;

/** Every scratch folder a test made, removed once the file's tests are done: a test that fails leaves nothing behind. */
const made: string[] = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A scratch host file holding `initial`, and a runner of one command against it that captures what it says. */
function scratch(initial: string = HOST, project?: string) {
  const dir = mkdtempSync(join(tmpdir(), "plugin-cli-"));
  made.push(dir);
  const hostPath = join(dir, "host.json");
  writeFileSync(hostPath, initial);
  const run = async (...argv: string[]): Promise<Run> => {
    const out: string[] = [];
    const err: string[] = [];
    const status = await runPlugin(argv, { hostPath, catalog: buildCatalog(), log: (line) => out.push(line), error: (line) => err.push(line), projectPath: project });
    return { status, out: out.join("\n"), err: err.join("\n") };
  };
  const text = () => readFileSync(hostPath, "utf8");
  const backup = () => (existsSync(`${hostPath}.bak`) ? readFileSync(`${hostPath}.bak`, "utf8") : null);
  return { dir, hostPath, run, text, backup };
}

const settingsOf = (text: string) => parseTicketSettings(JSON.parse(text));

test("`plugin list` shows each concern in order with the plugin enabled for it, where its settings came from, and every plugin known for it, the fakes included", async () => {
  const host = scratch();
  const { status, out } = await host.run("list");
  assert.equal(status, 0);
  const sections = out.split("\n").filter((line) => !line.startsWith(" "));
  assert.deepEqual(sections, [
    "tracker: linear (from tickets.providers.tracker)",
    "code host: github (no block: the default, github, with every role on a user account, applies)",
    "publisher: slack (from tickets.providers.publish)",
    "reviewer: none (no block: the default, none, which starts no reviewer, applies)",
    "exposure: tailscale (from tickets.providers.exposure)",
    "messaging: none (this machine declares no project, so messaging is not configured)",
  ]);
  for (const fake of ["fake-tracker", "fake-codeHost", "fake-publisher", "fake-reviewer", "fake-exposure", "fake-messaging"]) assert.match(out, new RegExp(`^  ${fake} +available +contract 1\\.0 +fake`, "m"), fake);
  assert.match(out, /^ {2}linear +enabled +contract 1\.0 +core, until A11-159$/m);
  assert.match(out, /^ {2}local +available +contract 1\.0 +core, until A11-162$/m);
  assert.match(out, /^ {2}fake-tracker +available.*refused: fake-tracker is a tracker plugin, but this release runs the tracker in core as linear until A11-159/m);
});

test("`plugin list` reads messaging from the project's project.json, and says it is configured there", async () => {
  const project = scratch(JSON.stringify({ messaging: { provider: "telegram", tokenFile: "~/t", chairmanFile: "~/c" } }));
  const host = scratch(HOST, project.hostPath);
  const { out } = await host.run("list");
  assert.match(out, /^messaging: telegram \(configured in project\.json's messaging key, which agent-org plugin does not write until A11-162 moves it\)$/m);
  assert.match(out, /^ {2}telegram +enabled/m);
  assert.match(out, /^ {2}fake-messaging +available/m);
});

test("disabling the only tracker or the only code host is refused by name, and the file is not touched", async () => {
  const host = scratch();
  for (const [name, sentence] of [["linear", "linear is the only tracker, and exactly one tracker must be enabled"], ["github", "github is the only code host, and exactly one code host must be enabled"]]) {
    const { status, err } = await host.run("disable", name);
    assert.equal(status, 1, name);
    assert.ok(err.includes(sentence), err);
  }
  assert.equal(host.text(), HOST);
  assert.equal(host.backup(), null, "a refused command leaves no backup");
});

test("disabling the publisher works: the file keeps the person's layout and settings, the board then publishes nothing, and enabling restores it", async () => {
  const host = scratch();
  assert.notEqual(settingsOf(HOST).publish, null);
  const disabled = await host.run("disable", "slack");
  assert.equal(disabled.status, 0, disabled.err);
  assert.match(disabled.out, /disabled slack: the board publishes nothing, and its settings are kept for `enable`/);
  assert.equal(host.text(), HOST.replace(`"run": "${RUN}", "connectors": ["^mcp__slack__send"] }`, `"run": "${RUN}", "connectors": ["^mcp__slack__send"], "enabled": false }`));
  assert.equal(host.backup(), HOST, "host.json.bak is the file as it was");
  assert.equal(settingsOf(host.text()).publish, null, "the board publishes nothing");
  assert.match(host.text(), new RegExp(NOTE));
  const enabled = await host.run("enable", "slack");
  assert.equal(enabled.status, 0, enabled.err);
  assert.equal(JSON.parse(host.text()).tickets.providers.publish.enabled, true);
  assert.deepEqual(settingsOf(host.text()).publish?.connectors, ["^mcp__slack__send"], "the settings it kept are back");
});

test("enabling a plugin that is on, or disabling one that is off, says so and writes nothing", async () => {
  const host = scratch();
  assert.match((await host.run("enable", "slack")).out, /slack is already enabled/);
  assert.equal(host.backup(), null);
  await host.run("disable", "slack");
  const before = host.text();
  assert.match((await host.run("disable", "slack")).out, /slack is already disabled/);
  assert.equal(host.text(), before);
});

test("enable and disable are refused by name for a plugin no block names", async () => {
  const host = scratch();
  for (const command of ["enable", "disable"]) {
    const { status, err } = await host.run(command, "atomic");
    assert.equal(status, 1);
    assert.equal(err, "agent-org plugin: atomic is not installed: run `agent-org plugin install atomic`");
  }
  assert.equal((await host.run("enable", "no-such-plugin")).err, "agent-org plugin: no plugin is named no-such-plugin: `agent-org plugin list` shows the plugins");
});

test("install writes the plugin's block with enabled true and the settings given, and the reader's own message refuses what is missing", async () => {
  const host = scratch(JSON.stringify({ clones: { app: "/tmp/app" } }));
  const missing = await host.run("install", "slack");
  assert.equal(missing.status, 1);
  assert.match(missing.err, /`tickets\.providers\.publish\.run` in the host file must be \{ "run": "<the publish run's instruction, naming \{prs\} and \{dir\}>"/);
  assert.equal(host.backup(), null, "nothing the reader refuses is written");
  const unconfirmed = await host.run("install", "slack", "--set", `run=${RUN}`);
  assert.match(unconfirmed.err, /tickets\.providers\.publish\.run is dangerous and needs a second confirmation.*Run it again with --confirm/, "the publish run is a dangerous key, so installing it asks for the second step");
  assert.equal(host.backup(), null);
  const installed = await host.run("install", "slack", "--set", `run=${RUN}`, "--set", 'connectors=["^mcp__slack__send"]', "--confirm");
  assert.equal(installed.status, 0, installed.err);
  assert.deepEqual(JSON.parse(host.text()).tickets.providers.publish, { provider: "slack", enabled: true, run: RUN, connectors: ["^mcp__slack__send"] });
  assert.equal(settingsOf(host.text()).publish?.run, RUN);
});

test("install over a block that names another plugin is refused unless --replace, which names the plugin it replaces and drops its settings", async () => {
  const host = scratch();
  const refused = await host.run("install", "local");
  assert.equal(refused.status, 1);
  assert.match(refused.err, /the exposure is tailscale \(tickets\.providers\.exposure\) and exactly one exposure plugin is installed: use --replace to replace tailscale with local, which drops tailscale's settings/);
  assert.equal(host.text(), HOST);
  const replaced = await host.run("install", "local", "--replace");
  assert.equal(replaced.status, 0, replaced.err);
  assert.match(replaced.out, /installed local as the exposure, replacing tailscale/);
  assert.deepEqual(JSON.parse(host.text()).tickets.providers.exposure, { provider: "local", enabled: true });
});

test("install is refused by the reader for a plugin core is pinned off, naming the plugin and the ticket that moves the concern", async () => {
  const host = scratch();
  const { status, err } = await host.run("install", "fake-tracker", "--replace");
  assert.equal(status, 1);
  assert.match(err, /fake-tracker is a tracker plugin, but this release runs the tracker in core as linear until A11-159/);
  assert.equal(host.text(), HOST);
});

test("uninstall removes the block, the concern falls back to its default, and the output says so", async () => {
  const host = scratch();
  const { status, out } = await host.run("uninstall", "slack");
  assert.equal(status, 0);
  assert.match(out, /uninstalled slack: the publisher falls back to its default, none/);
  assert.equal(JSON.parse(host.text()).tickets.providers.publish, undefined);
  assert.equal(settingsOf(host.text()).publish, null);
  assert.equal((await host.run("uninstall", "slack")).err, "agent-org plugin: slack is not installed: run `agent-org plugin install slack`");
});

test("uninstalling the only tracker or code host is refused by name, since its default would put it back", async () => {
  const host = scratch();
  const refusals = await Promise.all([host.run("uninstall", "linear"), host.run("uninstall", "github")]);
  assert.deepEqual(refusals.map(({ status }) => status), [1, 1]);
  assert.match(refusals[0].err, /linear is the only tracker, and exactly one tracker must be enabled: it cannot be uninstalled, since its default would put linear back/);
  assert.match(refusals[1].err, /github is the only code host/);
  assert.equal(host.text(), HOST);
});

test("config shows a plugin's settings, a key file by its path, and reads no file", async () => {
  const host = scratch(HOST.replace('"provider": "linear"', '"provider": "linear", "key": { "path": "/nonexistent/linear.key" }'));
  const { status, out } = await host.run("config", "linear");
  assert.equal(status, 0);
  assert.match(out, /^tickets\.providers\.tracker\.key: \{"path":"\/nonexistent\/linear\.key"\}$/m);
  assert.match(out, /^tickets\.providers\.tracker\.workingState: not set$/m);
  assert.equal((await host.run("config", "linear", "workingState")).out, "tickets.providers.tracker.workingState: not set");
  assert.equal((await host.run("config", "linear", "port")).err, "agent-org plugin: port is not a setting of linear: its settings are key, connectors, workingState, plannedState, takenStates");
});

test("config sets and unsets a setting through the same path, and the reader refuses a setting the plugin does not declare", async () => {
  const host = scratch();
  const set = await host.run("config", "slack", "model=sonnet");
  assert.equal(set.status, 0, set.err);
  assert.equal(JSON.parse(host.text()).tickets.providers.publish.model, "sonnet");
  const unset = await host.run("config", "slack", "--unset", "model");
  assert.equal(unset.status, 0, unset.err);
  assert.equal(JSON.parse(host.text()).tickets.providers.publish.model, undefined);
  const unknown = await host.run("config", "slack", "colour=red");
  assert.equal(unknown.status, 1);
  assert.match(unknown.err, /`tickets\.providers\.publish\.colour` in the host file is not a setting of slack/);
  assert.equal((await host.run("config", "slack", "enabled=false")).err, "agent-org plugin: enabled is not a setting to set here: `agent-org plugin install` names the plugin and `enable` and `disable` switch it");
});

test("a dangerous key needs --confirm, as the Settings page's second step does", async () => {
  const host = scratch();
  const refused = await host.run("config", "slack", "run=publish {prs} elsewhere {dir}");
  assert.equal(refused.status, 1);
  assert.match(refused.err, /tickets\.providers\.publish\.run is dangerous and needs a second confirmation.*Run it again with --confirm/);
  assert.equal(host.text(), HOST);
  const confirmed = await host.run("config", "slack", "run=publish {prs} elsewhere {dir}", "--confirm");
  assert.equal(confirmed.status, 0, confirmed.err);
  assert.equal(JSON.parse(host.text()).tickets.providers.publish.run, "publish {prs} elsewhere {dir}");
});

test("a write is refused while the concern is read from an old key, naming `agent-org doctor --fix`", async () => {
  const old = JSON.stringify({ clones: { app: "/tmp/app" }, tickets: { publish: { run: RUN } } });
  const host = scratch(old);
  assert.match((await host.run("list")).out, /^publisher: slack \(from aliases \(tickets\.publish\)\)$/m);
  for (const argv of [["disable", "slack"], ["enable", "slack"], ["uninstall", "slack"], ["install", "slack", "--set", `run=${RUN}`], ["config", "slack", "model=sonnet"]]) {
    const { status, err } = await host.run(...argv);
    assert.equal(status, 1, argv.join(" "));
    assert.match(err, /publisher settings are still read from old keys: run `agent-org doctor --fix` to move them to tickets\.providers\.publish, then try again/);
  }
  assert.equal(host.text(), old);
});

test("messaging is configured in project.json, so every write to it is refused, naming the file and A11-162", async () => {
  const host = scratch();
  for (const argv of [["install", "telegram"], ["enable", "telegram"], ["disable", "telegram"], ["uninstall", "telegram"], ["config", "telegram", "x=1"], ["install", "fake-messaging"]]) {
    const { status, err } = await host.run(...argv);
    assert.equal(status, 1, argv.join(" "));
    assert.match(err, /project\.json's messaging key configures: agent-org plugin does not write it until A11-162 moves messaging onto the registry/);
  }
  assert.equal(host.text(), HOST);
});

test("a host file the reader refuses cannot be changed, and the command says why in the reader's words", async () => {
  const host = scratch(JSON.stringify({ clones: { app: "/tmp/app" }, tickets: { providers: { tracker: { provider: "jira" } } } }));
  const { status, err } = await host.run("list");
  assert.equal(status, 1);
  assert.match(err, /the host file is refused, so no plugin can be changed: ticket mode: `tickets\.providers\.tracker\.provider` in the host file must be one of "linear", not "jira"/);
});

test("a command that is not one, and one with no plugin name, are usage errors and change nothing", async () => {
  const host = scratch();
  for (const argv of [[], ["frobnicate"], ["install"], ["list", "--nope"]]) assert.equal((await host.run(...argv)).status, 2, argv.join(" "));
  assert.match((await host.run("install")).err, /`install` needs a plugin name/);
  assert.match((await host.run()).err, /no command given/);
  assert.equal(host.text(), HOST);
});

test("the plugin command is in the command table, so `agent-org plugin` runs it", async () => {
  const { COMMANDS } = await import("../commands.ts");
  assert.equal(COMMANDS.plugin, "plugins/cli.ts");
});
