// no-token: none -- every command runs against a scratch copy of a host file, in a scratch folder
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseTicketSettings } from "../ticket-mode/settings.ts";
import { loadOutgoing, type Outgoing, runPlugin } from "./cli.ts";
import { buildCatalog } from "./registry.ts";
import type { CatalogPlugin, PluginSettings, StepResult } from "./manifest.ts";

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

/** What loading the plugin a change leaves records, so a test reads which plugins were released, with which settings, and in what order against the write. */
type Left = { plugin: string; settings: PluginSettings; hostBefore: string };

/** A plugin that is left: it answers `machineName`, and releases as `release` says (nothing to release by default). */
const leaving = (over: Partial<Outgoing> = {}, left: Left[] = [], hostPath = ""): ((plugin: CatalogPlugin, settings: PluginSettings) => Promise<Outgoing>) => async (plugin, settings) => {
  left.push({ plugin: plugin.name, settings, hostBefore: hostPath === "" ? "" : readFileSync(hostPath, "utf8") });
  return { machineName: null, release: () => ({ ok: true, detail: "" }), ...over };
};

/** A scratch host file holding `initial`, and a runner of one command against it that captures what it says. `outgoing` answers for a plugin the command leaves. */
function scratch(initial: string = HOST, project?: string, outgoing?: (hostPath: string, left: Left[]) => ReturnType<typeof leaving>) {
  const dir = mkdtempSync(join(tmpdir(), "plugin-cli-"));
  made.push(dir);
  const hostPath = join(dir, "host.json");
  writeFileSync(hostPath, initial);
  const left: Left[] = [];
  const run = async (...argv: string[]): Promise<Run> => {
    const out: string[] = [];
    const err: string[] = [];
    const status = await runPlugin(argv, { hostPath, catalog: buildCatalog(), log: (line) => out.push(line), error: (line) => err.push(line), projectPath: project, outgoing: (outgoing ?? ((path, seen) => leaving({}, seen, path)))(hostPath, left) });
    return { status, out: out.join("\n"), err: err.join("\n") };
  };
  const text = () => readFileSync(hostPath, "utf8");
  const backup = () => (existsSync(`${hostPath}.bak`) ? readFileSync(`${hostPath}.bak`, "utf8") : null);
  return { dir, hostPath, run, text, backup, left };
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
  assert.match(out, /^ {2}fake-reviewer +available +contract 1\.4 +fake/m);
  for (const fake of ["fake-publisher", "fake-exposure", "fake-messaging"]) assert.match(out, new RegExp(`^  ${fake} +available +contract 1\\.1 +fake`, "m"), fake);
  assert.match(out, /^ {2}slack +enabled +contract 1\.1 +plugins\/slack$/m, "the publisher is a bundled package since A11-161");
  assert.match(out, /^ {2}atomic +available +contract 1\.4 +plugins\/atomic-reviewer$/m, "and so is the reviewer, whose folder is not its name");
  assert.match(out, /^ {2}fake-tracker +available +contract 1\.7 +fake/m);
  assert.match(out, /^ {2}fake-codeHost +available +contract 1\.15 +fake/m);
  assert.match(out, /^ {2}linear +enabled +contract 1\.7 +plugins\/linear$/m);
  assert.match(out, /^ {2}github +enabled +contract 1\.15 +plugins\/github$/m, "the code host is the bundled github, enabled by the default");
  assert.match(out, /^ {2}local +available +contract 1\.1 +plugins\/local$/m, "local is a bundled plugin since A11-162");
  assert.match(out, /^ {2}tailscale +enabled +contract 1\.1 +plugins\/tailscale$/m);
  assert.match(out, /^ {2}telegram +available +contract 1\.1 +plugins\/telegram$/m, "and so is telegram, which no project here enables");
  assert.match(out, /^ {2}fake-tracker +available.*refused: fake-tracker is an in-memory tracker for core's tests: it runs no host, so it cannot be installed or enabled/m);
});

test("`plugin list` reads messaging from the project's project.json, and says it is configured there", async () => {
  const project = scratch(JSON.stringify({ messaging: { provider: "telegram", tokenFile: "~/t", chairmanFile: "~/c" } }));
  const host = scratch(HOST, project.hostPath);
  const { out } = await host.run("list");
  assert.match(out, /^messaging: telegram \(configured in project\.json's messaging key\)$/m);
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

test("a fake is neither installed nor enabled on a host, though the reader would accept it: it has no code to run, so the start would be refused", async () => {
  const host = scratch();
  for (const argv of [["install", "fake-tracker", "--replace"], ["enable", "fake-tracker"]]) {
    const { status, err } = await host.run(...argv);
    assert.equal(status, 1, argv.join(" "));
    assert.match(err, /fake-tracker is an in-memory tracker for core's tests: it runs no host, so it cannot be installed or enabled/);
  }
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

/** A project's declaration with a messaging key (paths under the scratch home's `.config/agent-org/`), written beside a host file whose `primary` project it is. */
const TOKEN = join(homedir(), ".config", "agent-org", "telegram-token");
const CHAIRMAN = join(homedir(), ".config", "agent-org", "telegram-chairman.json");
const MESSAGING = { provider: "telegram", tokenFile: TOKEN, chairmanFile: CHAIRMAN, summary: { at: "08:00" } };
const projectOf = (messaging?: Record<string, unknown>) => `${JSON.stringify({ schema: 1, tracker: [{ key: "", repo: "a11ign/agent-org", board: { owner: "a11ign", number: 1 } }], code: [{ key: "", repo: "a11ign/agent-org" }], ...(messaging === undefined ? {} : { messaging }) }, null, 2)}\n`;

test("A11-162: messaging is written to the project's project.json through the Settings page's path, and enable, disable and config keep every setting", async () => {
  const project = scratch(projectOf(MESSAGING));
  const host = scratch(HOST, project.hostPath);
  const disabled = await host.run("disable", "telegram");
  assert.equal(disabled.status, 0, disabled.err);
  assert.match(disabled.out, /disabled telegram: nothing is sent to the chairman and nothing is asked, and its settings are kept for `enable`/);
  assert.deepEqual(JSON.parse(project.text()).messaging, { ...MESSAGING, enabled: false }, "the settings stay, the switch is off");
  assert.equal(project.backup(), projectOf(MESSAGING), "project.json.bak is the file as it was");
  assert.equal(host.text(), HOST, "and the host file is not touched");
  assert.match((await host.run("list")).out, /^messaging: none \(configured in project\.json's messaging key\)$\n {2}telegram +disabled/m);
  assert.match((await host.run("disable", "telegram")).out, /telegram is already disabled/);
  const enabled = await host.run("enable", "telegram");
  assert.equal(enabled.status, 0, enabled.err);
  assert.deepEqual(JSON.parse(project.text()).messaging, { ...MESSAGING, enabled: true });
  assert.match((await host.run("enable", "telegram")).out, /telegram is already enabled/);
  const config = await host.run("config", "telegram", `announcementsFile=${join(homedir(), ".config", "agent-org", "channel")}`);
  assert.equal(config.status, 0, config.err);
  assert.equal(JSON.parse(project.text()).messaging.announcementsFile, join(homedir(), ".config", "agent-org", "channel"));
  const shown = await host.run("config", "telegram");
  assert.match(shown.out, new RegExp(`^messaging\\.tokenFile: ${JSON.stringify(TOKEN).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), "a secret file is shown by its path");
  assert.doesNotMatch(shown.out, /summary/, "summary is the core's, not a setting of the plugin");
});

test("A11-162: installing the messaging plugin writes the provider, enabled and the settings given, and the messaging reader refuses what it does not accept", async () => {
  const project = scratch(projectOf());
  const host = scratch(HOST, project.hostPath);
  const missing = await host.run("install", "telegram");
  assert.equal(missing.status, 1);
  assert.match(missing.err, /messaging\.tokenFile: it must be a non-empty string/, "the reader's words: a token file is needed");
  assert.equal(project.text(), projectOf());
  const outside = await host.run("install", "telegram", "--set", "tokenFile=/etc/shadow", "--set", `chairmanFile=${CHAIRMAN}`);
  assert.match(outside.err, /messaging\.tokenFile: .*is not a file under ~\/\.config\/agent-org\//);
  assert.equal(project.text(), projectOf());
  const installed = await host.run("install", "telegram", "--set", `tokenFile=${TOKEN}`, "--set", `chairmanFile=${CHAIRMAN}`);
  assert.equal(installed.status, 0, installed.err);
  assert.match(installed.out, /installed telegram as the messaging/);
  assert.deepEqual(JSON.parse(project.text()).messaging, { provider: "telegram", enabled: true, tokenFile: TOKEN, chairmanFile: CHAIRMAN });
  assert.match(installed.out, /in force after you reinstall and restart the units that run messaging:listen and messaging:watch/);
});

test("A11-162: uninstalling the messaging plugin removes the whole messaging key, says its summary goes too, and leaves the host file alone", async () => {
  const project = scratch(projectOf(MESSAGING));
  const host = scratch(HOST, project.hostPath);
  const { status, out } = await host.run("uninstall", "telegram");
  assert.equal(status, 0);
  assert.match(out, /uninstalled telegram: the messaging falls back to its default, none, and the whole messaging key goes with it \(its summary and milestones too; project\.json\.bak holds it\)/);
  assert.equal(JSON.parse(project.text()).messaging, undefined);
  assert.equal(project.backup(), projectOf(MESSAGING));
  assert.equal(host.text(), HOST);
  assert.equal((await host.run("uninstall", "telegram")).err, "agent-org plugin: telegram is not installed: run `agent-org plugin install telegram`");
});

test("A11-162: the messaging plugin cannot be changed on a machine that declares no project, and a fake is not installable", async () => {
  const host = scratch();
  const disabled = await host.run("disable", "telegram");
  const fake = await host.run("install", "fake-messaging");
  assert.equal(disabled.status, 1);
  assert.match(disabled.err, /telegram is not installed: run `agent-org plugin install telegram`/);
  assert.match(fake.err, /fake-messaging is an in-memory messaging for core's tests: it runs no host, so it cannot be installed or enabled/);
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

// ---- A11-162: `enable` switches within a concern, and the plugin it leaves is released first

const TAILNET = "agents.tail1234.ts.net";
const TERMINAL_ON_TAILNET = `https://${TAILNET}:9444/?ws={workspace}&pane={pane}&view=terminal`;
const RELEASED = "took this board's tailscale serve entries off the tailnet: ui (port 9500), terminal (port 9501)";
const SWITCHED = `{
  "clones": { "app": "/tmp/app" },
  "tickets": {
    "providers": {
      "exposure": { "provider": "tailscale", "port": 5000, "uiPort": 5001, "terminal": "${TERMINAL_ON_TAILNET}", "tailnetPorts": { "ui": 9500, "terminal": 9501 } }
    }
  }
}
`;

/** The plugin a command leaves, as the CLI loads it: it answers `machineName`, records the host file as it was when it was released, and releases as `outcome` says. */
function leavingTailscale(seen: string[], { machineName = TAILNET as string | null, outcome = { ok: true, detail: RELEASED } as { ok: boolean; detail: string } } = {}) {
  return (hostPath: string, left: Left[]) => async (plugin: CatalogPlugin, settings: PluginSettings): Promise<Outgoing> => {
    left.push({ plugin: plugin.name, settings, hostBefore: readFileSync(hostPath, "utf8") });
    return { machineName, release: () => { seen.push(readFileSync(hostPath, "utf8")); return outcome; } };
  };
}

test("A11-162: `enable local` on a host whose exposure is tailscale switches the block, keeps the settings both declare, drops tailnetPorts and the tailnet's own terminal, and says so", async () => {
  const released: string[] = [];
  const host = scratch(SWITCHED, undefined, leavingTailscale(released));
  const result = await host.run("enable", "local");
  assert.equal(result.status, 0, result.err);
  assert.deepEqual(JSON.parse(host.text()).tickets.providers.exposure, { provider: "local", enabled: true, port: 5000, uiPort: 5001 });
  assert.match(result.out, /switched the exposure from tailscale to local, keeping port, uiPort, terminal and dropping tailnetPorts, which local does not declare/);
  assert.match(result.out, /dropped tickets\.providers\.exposure\.terminal, which named tailscale's own address \(https:\/\/agents\.tail1234\.ts\.net:9444\//);
  assert.match(result.out, /took this board's tailscale serve entries off the tailnet/);
  assert.match(result.out, /in force after the instance, the page and the terminal restart: run `agent-org start instance`, `agent-org start ui` and `agent-org start terminal`\./, "the line names the terminal, which A11-158's line left out");
  assert.deepEqual(released, [SWITCHED], "tailscale was released while it was still the enabled exposure: the host file was not yet written");
  assert.deepEqual(host.left.map(({ plugin, settings }) => [plugin, settings]), [["tailscale", { port: 5000, uiPort: 5001, terminal: TERMINAL_ON_TAILNET, tailnetPorts: { ui: 9500, terminal: 9501 } }]],
    "it was given the settings the block held that it declares");
  assert.equal(settingsOf(host.text()).port, 5000);
});

test("A11-162: a terminal on this machine's loopback, or on another machine, survives a switch: only the outgoing plugin's own address is dropped", async () => {
  for (const [terminal, kept] of [["http://127.0.0.1:7318/?ws={workspace}&pane={pane}", true], ["https://elsewhere.example:9444/?ws={workspace}&pane={pane}", true], [TERMINAL_ON_TAILNET, false]] as const) {
    const host = scratch(SWITCHED.replace(TERMINAL_ON_TAILNET, terminal), undefined, leavingTailscale([]));
    const result = await host.run("enable", "local");
    assert.equal(result.status, 0, result.err);
    assert.equal(JSON.parse(host.text()).tickets.providers.exposure.terminal, kept ? terminal : undefined, terminal);
  }
});

test("A11-162: a terminal is kept when the outgoing plugin has no name to compare it with", async () => {
  const host = scratch(SWITCHED, undefined, leavingTailscale([], { machineName: null }));
  assert.equal((await host.run("enable", "local")).status, 0);
  assert.equal(JSON.parse(host.text()).tickets.providers.exposure.terminal, TERMINAL_ON_TAILNET, "nothing proves it is the outgoing plugin's, so nothing is dropped");
});

test("A11-162: a release that cannot refuses the switch by name, and nothing is written: the host file and the machine agree", async () => {
  const released: string[] = [];
  const host = scratch(SWITCHED, undefined, leavingTailscale(released, { outcome: { ok: false, detail: "cannot take the ui entry on tailnet port 9500 off: Tailscale is not Running on this machine (BackendState Stopped): run `sudo tailscale up`" } }));
  const result = await host.run("enable", "local");
  assert.deepEqual([result.status, host.text() === SWITCHED, host.backup(), released.length], [1, true, null, 1], "refused, the file as it was, no backup, and the release asked once");
  assert.match(result.err, /^agent-org plugin: tailscale could not be released, so nothing was changed: cannot take the ui entry on tailnet port 9500 off: Tailscale is not Running/);
});

test("A11-162: disable and uninstall of the enabled tailscale release it first, and enabling it back after a disable releases nothing", async () => {
  for (const command of ["disable", "uninstall"]) {
    const released: string[] = [];
    const host = scratch(SWITCHED, undefined, leavingTailscale(released));
    const result = await host.run(command, "tailscale");
    assert.equal(result.status, 0, result.err);
    assert.deepEqual(released, [SWITCHED], `${command}: released before the file changed`);
    assert.match(result.out, /took this board's tailscale serve entries off the tailnet/);
  }
  const released: string[] = [];
  const host = scratch(SWITCHED, undefined, leavingTailscale(released));
  await host.run("disable", "tailscale");
  assert.equal(JSON.parse(host.text()).tickets.providers.exposure.enabled, false);
  released.length = 0;
  host.left.length = 0;
  const again = await host.run("enable", "tailscale");
  assert.equal(again.status, 0, again.err);
  assert.deepEqual([released, host.left], [[], []], "enabling a plugin leaves none");
});

test("A11-162: switching away from a tailscale that is already disabled releases nothing, since it released when it was disabled", async () => {
  const released: string[] = [];
  const host = scratch(SWITCHED.replace('"provider": "tailscale",', '"provider": "tailscale", "enabled": false,'), undefined, leavingTailscale(released));
  const result = await host.run("enable", "local");
  assert.equal(result.status, 0, result.err);
  assert.deepEqual([released, host.left], [[], []]);
  assert.deepEqual(JSON.parse(host.text()).tickets.providers.exposure, { provider: "local", enabled: true, port: 5000, uiPort: 5001, terminal: TERMINAL_ON_TAILNET }, "and with no machine name to compare, the terminal stays");
});

test("A11-162: install --replace releases the plugin it replaces, as the switch does", async () => {
  const released: string[] = [];
  const host = scratch(SWITCHED, undefined, leavingTailscale(released));
  const result = await host.run("install", "local", "--replace");
  assert.equal(result.status, 0, result.err);
  assert.deepEqual(released, [SWITCHED]);
  assert.deepEqual(JSON.parse(host.text()).tickets.providers.exposure, { provider: "local", enabled: true }, "install --replace keeps its meaning: the replaced plugin's settings go");
});

test("A11-162: enabling a plugin of a concern whose block names none is still refused as not installed: the switch is for a block that names another plugin", async () => {
  const host = scratch(HOST.replace(/,\n\s+"exposure": \{ "provider": "tailscale", "port": 5000 \}/, ""));
  assert.doesNotMatch(host.text(), /"exposure"/);
  const result = await host.run("enable", "tailscale");
  assert.equal(result.status, 1);
  assert.equal(result.err, "agent-org plugin: tailscale is not installed: run `agent-org plugin install tailscale`");
});

test("A11-162: the plugin a command leaves is loaded from its entry module, asked its name, and a release that throws is a refusal with its words, not a crash", async () => {
  const catalog = buildCatalog();
  const tailscale = catalog.plugins.find(({ name }) => name === "tailscale")!;
  const urls: string[] = [];
  const throwing = async (url: string) => { urls.push(url); return { create: () => ({ machineName: async () => TAILNET }), doctorChecks: () => [], onboardSteps: [], release: () => { throw new Error("tickets.providers.exposure.tailnetPorts ui and terminal must be different ports"); } }; };
  const outgoing = await loadOutgoing(tailscale, { tailnetPorts: { ui: 1, terminal: 1 } }, throwing);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/plugins\/tailscale\/index\.ts$/);
  assert.equal(outgoing.machineName, TAILNET);
  assert.deepEqual(outgoing.release(), { ok: false, detail: "tickets.providers.exposure.tailnetPorts ui and terminal must be different ports" });
  const quiet = await loadOutgoing(tailscale, {}, async () => ({ create: () => ({}), doctorChecks: () => [], onboardSteps: [] }));
  assert.deepEqual([quiet.machineName, quiet.release()], [null, { ok: true, detail: "" }], "a plugin with no release has nothing to release, and one that cannot be built has no name");
  const fake = await loadOutgoing(catalog.plugins.find(({ name }) => name === "fake-publisher")!, {}, async () => { throw new Error("a fake's code is not imported"); });
  assert.deepEqual([fake.machineName, fake.release()], [null, { ok: true, detail: "" }]);
});

test("A11-162: a write that the dangerous-key rule will refuse is refused BEFORE the plugin is released, so the board is not taken off the tailnet by a change that is not written", async () => {
  const released: string[] = [];
  const host = scratch(SWITCHED, undefined, leavingTailscale(released));
  const refused = await host.run("install", "local", "--replace", "--set", "port=6100");
  assert.equal(refused.status, 1);
  assert.match(refused.err, /tickets\.providers\.exposure\.port is dangerous and needs a second confirmation.*Run it again with --confirm/);
  assert.deepEqual([released, host.text()], [[], SWITCHED], "nothing was released and nothing was written");
  const confirmed = await host.run("install", "local", "--replace", "--set", "port=6100", "--confirm");
  assert.equal(confirmed.status, 0, confirmed.err);
  assert.deepEqual(released, [SWITCHED]);
});

test("A11-162: a plugin with nothing to release is not built to be left: a messaging plugin does not read its secret files to be disabled", async () => {
  const telegram = buildCatalog().plugins.find(({ name }) => name === "telegram")!;
  const outgoing = await loadOutgoing(telegram, { tokenFile: "~/not-resolved" }, async () => ({ create: () => { throw new Error("create reads the token file"); }, doctorChecks: () => [], onboardSteps: [] }));
  assert.deepEqual([outgoing.machineName, outgoing.release()], [null, { ok: true, detail: "" }]);
});

/** The plugin a command leaves, when the host file is changed by someone else while it is being released: `restored` records what it was asked to put back. */
function leavingWhileTheFileChanges(restored: StepResult[], putBack: StepResult = { ok: true, detail: "put back" }) {
  const released: StepResult = { ok: true, detail: RELEASED, settings: { released: [{ service: "ui", port: 9500, local: 5001 }] } };
  return (hostPath: string, left: Left[]) => async (plugin: CatalogPlugin, settings: PluginSettings): Promise<Outgoing> => {
    left.push({ plugin: plugin.name, settings, hostBefore: readFileSync(hostPath, "utf8") });
    return {
      machineName: TAILNET,
      release: () => { writeFileSync(hostPath, readFileSync(hostPath, "utf8").replace('"app"', '"other"')); return released; },
      restore: (given) => { restored.push(given); return putBack; },
    };
  };
}

test("A11-162: a save refused after the release (the file changed since the readers looked) puts the released plugin back and says so, so the file and the machine agree", async () => {
  const restored: StepResult[] = [];
  const host = scratch(SWITCHED, undefined, leavingWhileTheFileChanges(restored));
  const result = await host.run("enable", "local");
  assert.equal(result.status, 1);
  assert.match(result.err, /the file changed since you looked: read it again\. tailscale had been released, so it was put back: put back/);
  assert.deepEqual(restored.map(({ settings }) => settings), [{ released: [{ service: "ui", port: 9500, local: 5001 }] }], "it was handed what its own release answered");
  assert.equal(JSON.parse(host.text()).tickets.providers.exposure.provider, "tailscale", "the file still names tailscale, which is served again");
});

test("A11-162: a plugin that cannot be put back is named as not put back, with its words", async () => {
  const host = scratch(SWITCHED, undefined, leavingWhileTheFileChanges([], { ok: false, detail: "run `agent-org start ui`" }));
  const result = await host.run("enable", "local");
  assert.equal(result.status, 1);
  assert.match(result.err, /tailscale had been released, so it could NOT be put back: run `agent-org start ui`/);
});

test("A11-162: a plugin whose release removed nothing is not asked to put anything back", async () => {
  const restored: StepResult[] = [];
  const host = scratch(SWITCHED, undefined, (hostPath, left) => async (plugin, settings) => {
    const outgoing = await leavingWhileTheFileChanges(restored)(hostPath, left)(plugin, settings);
    return { ...outgoing, release: () => { outgoing.release(); return { ok: true, detail: "" }; } };
  });
  const result = await host.run("enable", "local");
  assert.equal(result.status, 1);
  assert.deepEqual([restored.length, /put back/.test(result.err)], [0, false]);
});

test("A11-162: a plugin whose restore throws is named as not put back, with the error's words, and the refusal still comes", async () => {
  const host = scratch(SWITCHED, undefined, (hostPath, left) => async (plugin, settings) => {
    const outgoing = await leavingWhileTheFileChanges([])(hostPath, left)(plugin, settings);
    return { ...outgoing, restore: () => { throw new Error("tailscale is gone"); } };
  });
  const result = await host.run("enable", "local");
  assert.equal(result.status, 1);
  assert.match(result.err, /the file changed since you looked: read it again\. tailscale had been released, so it could NOT be put back: tailscale is gone/);
});

// A11-161: the publisher and the reviewer are plugins like the rest: installed, enabled, disabled, configured and uninstalled with `agent-org plugin`, and the reviewer's `required` is the concern's own setting.
const WITH_REVIEWER = HOST.replace('"exposure"', '"reviewer": { "provider": "atomic" },\n      "exposure"');

test("A11-161: `plugin list` shows slack and atomic as bundled plugins, from the folders plugins/slack and plugins/atomic-reviewer, with the state their blocks give them", async () => {
  const host = scratch(WITH_REVIEWER);
  const { out } = await host.run("list");
  for (const line of [/^publisher: slack \(from tickets\.providers\.publish\)$/m, /^reviewer: atomic \(from tickets\.providers\.reviewer\)$/m, /^ {2}slack +enabled +contract 1\.1 +plugins\/slack$/m,
    /^ {2}atomic +enabled +contract 1\.4 +plugins\/atomic-reviewer$/m]) assert.match(out, line);
});

test("A11-161: the publisher is switched off and on, keeping its settings, and each change is read back from the file", async () => {
  const host = scratch();
  const off = await host.run("disable", "slack");
  assert.equal(off.status, 0, off.err);
  assert.match(off.out, /disabled slack: the board publishes nothing, and its settings are kept for `enable`/);
  const disabled = JSON.parse(host.text()).tickets.providers.publish;
  assert.deepEqual([disabled.provider, disabled.enabled, disabled.run, disabled.connectors], ["slack", false, RUN, ["^mcp__slack__send"]]);
  assert.equal(settingsOf(host.text()).publish, null, "the board has no publisher while it is off");
  const on = await host.run("enable", "slack");
  assert.equal(on.status, 0, on.err);
  assert.notEqual(settingsOf(host.text()).publish, null);
  assert.equal(JSON.parse(host.text()).tickets.providers.publish.enabled, true);
  assert.ok(host.text().includes(NOTE), "the person's note stays");
});

test("A11-161: slack is installed with its run and its connectors, and refused by the reader without them, naming the setting", async () => {
  const host = scratch(HOST.replace(/\n      "publish": \{[^\n]*\},/, ""));
  const refused = await host.run("install", "slack");
  assert.equal(refused.status, 1);
  assert.match(refused.err, /tickets\.providers\.publish\.run/);
  assert.equal(host.text().includes('"publish"'), false, "nothing was written");
  const installed = await host.run("install", "slack", "--set", `run=${RUN}`, "--set", 'connectors=["^mcp__chat__send"]', "--confirm");
  assert.equal(installed.status, 0, installed.err);
  assert.deepEqual(JSON.parse(host.text()).tickets.providers.publish, { provider: "slack", enabled: true, run: RUN, connectors: ["^mcp__chat__send"] });
  assert.deepEqual(settingsOf(host.text()).publish?.connectors, ["^mcp__chat__send"]);
});

test("A11-161: the reviewer is installed, switched off and on, and the board's reviewer follows each: settings.reviewer is the plugin's name, or null", async () => {
  const host = scratch();
  assert.equal(settingsOf(host.text()).reviewer, null);
  const installed = await host.run("install", "atomic");
  assert.equal(installed.status, 0, installed.err);
  assert.deepEqual(JSON.parse(host.text()).tickets.providers.reviewer, { provider: "atomic", enabled: true });
  assert.equal(settingsOf(host.text()).reviewer, "atomic");
  const off = await host.run("disable", "atomic");
  assert.match(off.out, /disabled atomic: the board starts no reviewer/);
  assert.deepEqual([settingsOf(host.text()).reviewer, settingsOf(host.text()).reviewerRequired], [null, true], "no reviewer, and reviews are still required: the block names one");
  await host.run("enable", "atomic");
  assert.equal(settingsOf(host.text()).reviewer, "atomic");
});

test("A11-161: `required` is the reviewer concern's setting: `plugin config atomic required=false` sets it while a reviewer is installed, reads back, and the reader refuses a value that is not true or false", async () => {
  const host = scratch(WITH_REVIEWER);
  assert.equal(settingsOf(host.text()).reviewerRequired, true, "absent, a reviewer plugin makes it true");
  const set = await host.run("config", "atomic", "--set", "required=false");
  assert.equal(set.status, 0, set.err);
  assert.equal(JSON.parse(host.text()).tickets.providers.reviewer.required, false);
  assert.equal(settingsOf(host.text()).reviewerRequired, false);
  const read = await host.run("config", "atomic", "required");
  assert.equal(read.out, "tickets.providers.reviewer.required: false");
  const listed = await host.run("config", "atomic");
  assert.equal(listed.out, "tickets.providers.reviewer.required: false", "the plugin declares no setting, and the concern's is the one listed");
  const refused = await host.run("config", "atomic", "--set", "required=sometimes");
  assert.equal(refused.status, 1);
  assert.match(refused.err, /tickets\.providers\.reviewer\.required.*must be true or false/);
  assert.equal(JSON.parse(host.text()).tickets.providers.reviewer.required, false, "nothing was written");
});

test("A11-161: uninstalling the reviewer keeps an explicit `required`: the block becomes none with it, since the setting is the concern's and not the plugin's", async () => {
  const host = scratch(WITH_REVIEWER.replace('"reviewer": { "provider": "atomic" }', '"reviewer": { "provider": "atomic", "required": false }'));
  const gone = await host.run("uninstall", "atomic");
  assert.equal(gone.status, 0, gone.err);
  assert.match(gone.out, /uninstalled atomic: the reviewer falls back to its default, none, keeping required: false, which is the reviewer's and not atomic's/);
  assert.deepEqual(JSON.parse(host.text()).tickets.providers.reviewer, { provider: "none", required: false });
  assert.deepEqual([settingsOf(host.text()).reviewer, settingsOf(host.text()).reviewerRequired], [null, false]);
  const plain = scratch(WITH_REVIEWER);
  await plain.run("uninstall", "atomic");
  assert.equal(JSON.parse(plain.text()).tickets.providers.reviewer, undefined, "with no required to keep, the block goes whole");
  assert.deepEqual([settingsOf(plain.text()).reviewer, settingsOf(plain.text()).reviewerRequired], [null, false], "and a machine with no reviewer block is not required");
});
