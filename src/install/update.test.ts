// no-token: none -- git runs in a remote this file builds; the dependency installs and the services are stand-ins (`update-fixture.ts`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { herdrWiring, update } from "./update.ts";
import { readLiveRuns } from "./instance-queue.ts";
import { currentVersionName } from "./tool-install.ts";
import { pluginUpkeep } from "./plugin-upkeep.ts";
import { fakePluginDeps } from "../plugins/fakes/deps.ts";
import type { PluginDeps } from "../plugins/manifest.ts";
import { parseTicketSettings } from "../ticket-mode/settings.ts";
import { stubServices, updateFixture } from "./update-fixture.ts";
import { herdrStatusPath, readHerdrStatus } from "./herdr-upkeep.ts";
import { unitFor, type RunResult } from "./service.ts";
import { herdrConfigDir } from "./terminal.ts";

/** An install at v0.1.0 in version folders, running from it, with v0.2.0 and v0.10.0 cut since. */
function installed(states: Parameters<typeof updateFixture>[0] = { states: { instance: "running" } }) {
  const f = updateFixture(states);
  f.release("0.1.0");
  update({ version: "v0.1.0", channel: "release" }, f.deps());
  f.runFromVersion("v0.1.0");
  f.release("0.2.0");
  f.release("0.10.0");
  f.said.length = 0;
  f.restarted.length = 0;
  f.statuses.length = 0;
  return f;
}

test("update moves to the newest release by numeric order, and restarts only the service that was running", () => {
  const f = installed({ states: { instance: "running", ui: "stopped" } });
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), true);
  assert.equal(currentVersionName(f.tool), "v0.10.0", "v0.10.0 is newer than v0.2.0, which a lexical sort gets backwards");
  assert.deepEqual(f.restarted, ["instance"]);
});

test("update --version moves to that release, and restarts nothing when no service runs", () => {
  const f = installed({ states: { instance: "stopped" } });
  update({ version: "v0.2.0", channel: "release" }, f.deps());
  assert.equal(currentVersionName(f.tool), "v0.2.0");
  assert.deepEqual(f.restarted, []);
});

test("update at the release it is at restarts nothing, builds nothing, and says nothing is newer", () => {
  const f = installed();
  update({ version: undefined, channel: "release" }, f.deps());
  f.restarted.length = 0;
  f.installs.length = 0;
  f.said.length = 0;
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), false);
  assert.deepEqual([f.restarted, f.installs], [[], []]);
  assert.deepEqual(f.said, ["agent-org is at v0.10.0: nothing newer"]);
});

test("a host.json toolVersion pins the release when no --version is given, and --version wins", () => {
  const f = installed();
  update({ version: undefined, channel: "release" }, f.deps({ pinned: () => "v0.2.0" }));
  assert.equal(currentVersionName(f.tool), "v0.2.0");
  update({ version: "v0.10.0", channel: "release" }, f.deps({ pinned: () => "v0.2.0" }));
  assert.equal(currentVersionName(f.tool), "v0.10.0");
});

test("update refuses a tag that is not a release, --version with --channel main, a release the remote does not hold, and says it does not fall back to main", () => {
  const f = installed();
  assert.throws(() => update({ version: "v0.2", channel: "release" }, f.deps()), /not a release tag/);
  assert.throws(() => update({ version: "v0.2.0", channel: "main" }, f.deps()), /give one of them/);
  assert.throws(() => update({ version: "v9.9.9", channel: "release" }, f.deps()), /v9\.9\.9 is not a release it holds.*does not fall back to main/);
  assert.equal(currentVersionName(f.tool), "v0.1.0");
});

test("the status the update leaves says what is installed and what is newest, with the date it was cut", () => {
  const f = installed();
  update({ version: undefined, channel: "release" }, f.deps());
  const status = f.statuses.at(-1);
  assert.deepEqual([status?.channel, status?.installed, status?.latest], ["release", "v0.10.0", "v0.10.0"]);
  assert.match(status?.latestSince ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

// A11-90: a status that cannot be written must not leave a moved install's services on the old modules.
test("A11-90: a status that cannot be written after the move still restarts the services that ran the old version", () => {
  const f = installed({ states: { instance: "running", ui: "running" } });
  assert.throws(() => update({ version: undefined, channel: "release" }, f.deps({ status: { write: () => { throw new Error("EACCES: status"); } } })), /EACCES: status/);
  assert.equal(currentVersionName(f.tool), "v0.10.0");
  assert.deepEqual(f.restarted, ["instance", "ui"]);
});

test("update restarts the services that run the tool, not herdr, the web terminal or the auto-update timer that ran it", () => {
  const f = installed({ states: { herdr: "running", instance: "running", ui: "running", terminal: "running", "auto-update": "running" } });
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), true);
  assert.deepEqual(f.restarted, ["instance", "ui"]);
});

test("the live runs are read from the queue file in the state directory the host file names, and none is null without a host file", () => {
  const root = tmpDir("update-live-");
  const host = join(root, "host.json");
  const stateDir = join(root, "state");
  writeFileSync(host, JSON.stringify({ clones: { a: "/r/a" }, stateDir }));
  mkdirSync(join(stateDir, "tickets"), { recursive: true });
  const entry = (key: string, phase: string, batch?: string) => ({ ticket: { key }, repos: [], model: "opus", effort: "high", phase, queuedAt: 0, ...(batch ? { batch } : {}) });
  writeFileSync(join(stateDir, "tickets", "queue.json"), JSON.stringify({ max: 3, paused: false,
    entries: [entry("A-1", "running"), entry("A-2", "starting"), entry("A-3", "queued"), entry("A-4", "finished"), entry("A-5", "running", "b1"), entry("A-6", "running", "b1")] }));
  assert.equal(readLiveRuns({ AGENT_ORG_HOST: host, HOME: root }), 3, "two runs and one batch's run; queued and finished are not live");
  assert.equal(readLiveRuns({ AGENT_ORG_HOST: join(root, "none.json"), HOME: root }), null);
});

test("A11-106: update keeps what the plugins keep true, the stacking extension among it, whether `current` moved or did not, with runs live or none", () => {
  for (const [live, moved] of [[0, true], [3, true]] as const) {
    const f = installed();
    f.state.live = live;
    const ensured: string[] = [];
    assert.equal(update({ version: undefined, channel: "release" }, f.deps({ upkeep: () => { ensured.push("ensured"); return []; } })), moved);
    assert.deepEqual(ensured, ["ensured"], `live ${live}, moved ${moved}`);
    assert.equal(update({ version: undefined, channel: "release" }, f.deps({ upkeep: () => { ensured.push("again"); return []; } })), false);
    assert.equal(ensured.length, 2, "and when nothing moved");
  }
});

test("A11-106: an extension that was installed is said, and one that could not be installed is said as missing, without failing the update", () => {
  const installedNow = installed();
  assert.equal(update({ version: undefined, channel: "release" }, installedNow.deps({ upkeep: () => [{ ok: true, detail: "installed the github/gh-stack extension (v0.2.1)" }] })), true);
  assert.ok(installedNow.said.includes("agent-org update: installed the github/gh-stack extension (v0.2.1)"));

  const missing = installed({});
  assert.equal(update({ version: undefined, channel: "release" }, missing.deps({ upkeep: () => [{ ok: false, detail: "the github/gh-stack extension is missing and could not be installed: could not reach github.com" }] })), true, "the move still happens: a failed extension does not stop it");
  assert.deepEqual(missing.errors, ["agent-org update: the github/gh-stack extension is missing and could not be installed: could not reach github.com"]);
});

test("A11-106: what the plugins keep is kept even when the update refuses, and its failure never replaces the refusal", () => {
  const refused = installed({});
  assert.throws(() => update({ version: "v0.2", channel: "release" }, refused.deps({ upkeep: () => [{ ok: false, detail: "the github/gh-stack extension is missing and could not be installed: no network" }] })), /not a release tag/);
  assert.equal(refused.errors.length, 1);
});

// A11-160: what the plugins keep true is asked of each enabled plugin that says it keeps something, from the code loaded before the checkout moves.
const settingsFor = (tickets: Record<string, unknown> = {}) => parseTicketSettings({ clones: { netbox: "/src/netbox" }, stateDir: "/state", tickets });

test("A11-160: the upkeep asks the code host plugin to keep the stacking extension, as the workers' account, and reads no tracker key for it", async () => {
  const programs: { file: string; args: readonly string[]; env: unknown }[] = [];
  const exec: PluginDeps["exec"] = (file, args, options) => {
    programs.push({ file, args, env: options?.env });
    return { status: 0, stdout: "", stderr: "" };
  };
  const upkeep = await pluginUpkeep(settingsFor(), {}, { deps: fakePluginDeps({ exec }) });
  assert.equal(programs.length, 0, "nothing runs until the update is done: the modules are imported, not built");
  const said = upkeep();
  assert.deepEqual([...new Set(programs.map(({ file }) => file))], ["gh"], "only gh is run: the Linear key is not read from the Keychain to ask what it keeps");
  assert.deepEqual(programs.map(({ args }) => args.join(" ")), ["extension list", "extension install github/gh-stack", "extension list"], "the extension is missing, so it is installed, and read back");
  assert.deepEqual(said.map(({ ok }) => ok), [false], "and the read-back found none, which is said as an error");
  assert.match(said[0].detail, /the github\/gh-stack extension is missing and could not be installed: the install succeeded, but the extension list does not show github\/gh-stack/);
});

test("A11-160: a host whose extension is listed keeps nothing to say, and one that names the workers' account runs gh as it", async () => {
  const programs: { args: readonly string[]; env: unknown }[] = [];
  const exec: PluginDeps["exec"] = (_file, args, options) => {
    programs.push({ args, env: options?.env });
    return { status: 0, stdout: "gh stack  github/gh-stack  v0.2.1\n", stderr: "" };
  };
  const upkeep = await pluginUpkeep(settingsFor({ providers: { codeHost: { provider: "github", gh: { workers: "/home/agent/workers" } } } }), {}, { deps: fakePluginDeps({ exec }) });
  assert.deepEqual(upkeep(), []);
  assert.deepEqual(programs, [{ args: ["extension", "list"], env: { GH_CONFIG_DIR: "/home/agent/workers/gh" } }]);
});

test("A11-160: a host file that does not read as ticket settings still has the extension kept, for the account it names or the person's own, as update always kept it", async () => {
  const runs: { args: readonly string[]; env: unknown }[] = [];
  const exec: PluginDeps["exec"] = (_file, args, options) => {
    runs.push({ args, env: options?.env });
    return { status: 0, stdout: "x  github/gh-" + "stack  v0.2.1\n", stderr: "" };
  };
  const keepFor = async (hostText: string | null) => (await pluginUpkeep(null, {}, { deps: fakePluginDeps({ exec }), hostText }))();
  runs.length = 0;
  assert.deepEqual(await keepFor(JSON.stringify({ gh: { workers: "/home/agent/workers" }, tickets: { providers: { codeHost: { provider: "github" } } } })), []);
  assert.deepEqual(runs, [{ args: ["extension", "list"], env: { GH_CONFIG_DIR: "/home/agent/workers/gh" } }], "a file with no clones, which the settings reader refuses, still names the workers' account");
  for (const text of [null, "{ not json", JSON.stringify({ tickets: { providers: { codeHost: { provider: "gitlab" } } } })]) {
    runs.length = 0;
    await keepFor(text);
    assert.deepEqual(runs, [{ args: ["extension", "list"], env: {} }], `${text}: no host file, one that is not JSON, and one the reader refuses are the person's own gh account`);
  }
});

test("A11-160: a plugin that cannot be imported, and a keep that throws, are said as errors and never raised", async () => {
  const importing = async (url: string): Promise<unknown> => {
    if (url.endsWith("/plugins/linear/index.ts")) throw new Error("cannot import");
    return { create: () => ({}), doctorChecks: () => [], onboardSteps: [], keep: () => { throw new Error("gh exploded"); } };
  };
  const said = (await pluginUpkeep(settingsFor(), {}, { deps: fakePluginDeps(), importModule: importing }))();
  assert.deepEqual(said.map(({ ok, detail }) => [ok, detail]), [
    [false, "the tracker plugin linear was refused: cannot import"],
    [false, "the github plugin could not be kept up: gh exploded"],
    [false, "the local plugin could not be kept up: gh exploded"],
  ], "and the exposure the host enables is imported to ask what it keeps too");
});

// A11-184: herdr's integrations and plugins are kept current at the end of every update, whatever the move did.
const HERDR_LINES = { said: ["reinstalled herdr's claude integration (it was outdated (v8 < v10); now current (v10))"], failed: ["the herdr plugin devswha/herdr-web-ui is at @35bf28fa and `herdr plugin install devswha/herdr-web-ui --ref v0.4.13 -y` failed: no"] };

test("A11-184: update logs what herdr's upkeep changed as it does the plugins' and the conventions', and a failure is an error that fails nothing", () => {
  const f = installed();
  let ran = 0;
  assert.equal(update({ version: undefined, channel: "release" }, f.deps({ herdr: () => { ran += 1; return HERDR_LINES; } })), true);
  assert.equal(ran, 1);
  assert.ok(f.said.includes(`agent-org update: ${HERDR_LINES.said[0]}`));
  assert.deepEqual(f.errors, [`agent-org update: ${HERDR_LINES.failed[0]}`]);
});

test("A11-184: herdr's upkeep runs when nothing is newer, when the build fails, and while a breaking release drains", () => {
  const quiet = installed();
  update({ version: undefined, channel: "release" }, quiet.deps());
  let ran = 0;
  const count = () => { ran += 1; return { said: [], failed: [] }; };
  update({ version: undefined, channel: "release" }, quiet.deps({ herdr: count }));
  assert.equal(ran, 1, "nothing newer");
  const broken = installed();
  broken.state.failBuild = true;
  assert.throws(() => update({ version: undefined, channel: "release" }, broken.deps({ herdr: count })), /building it failed/);
  assert.equal(ran, 2, "a failed build");
  const draining = updateFixture({ states: { instance: "running" }, live: 0 });
  draining.release("0.1.0");
  update({ version: undefined, channel: "release" }, draining.deps());
  draining.runFromVersion("v0.1.0");
  draining.release("0.2.0", "Breaking: the queue file moves");
  draining.state.live = 2;
  assert.equal(update({ version: undefined, channel: "release" }, draining.deps({ herdr: count })), false, "the breaking release waits on the live runs");
  assert.equal(ran, 3, "a drain");
});

test("A11-184: the production wiring moves the web UI, rewrites the terminal's unit from the new plugin_root, restarts only the terminal, and records the newest versions", () => {
  const f = updateFixture({ states: { instance: "running", ui: "running" } });
  f.release("0.1.0");
  const stub = stubServices(f.home);
  const plugins = join(herdrConfigDir(stub.services.env, f.home), "plugins.json");
  const entry = (root: string, ref: string | null) => JSON.stringify([{ plugin_id: "devswha.herdr-web-ui", plugin_root: root, source: { kind: "github", owner: "devswha", repo: "herdr-web-ui", ...(ref === null ? {} : { requested_ref: ref }), resolved_commit: "35bf28fa1234" } }]);
  stub.files.set(plugins, entry("/h/herdr/plugins/old", null));
  stub.files.set("/opt/bin/bun", "");
  const calls: string[] = [];
  const services = { ...stub.services, run: (file: string, args: string[]): RunResult => { calls.push([file, ...args].join(" ")); return { status: 0, stdout: args[1] === "is-active" ? "active\n" : "", stderr: "" }; } };
  const unit = unitFor("terminal", services);
  stub.files.set(unit.path, "the old unit");
  assert.match(unit.text, /\/h\/herdr\/plugins\/old/);
  const herdr = (args: string[], env?: Record<string, string | undefined>): RunResult => {
    calls.push(`herdr ${args.join(" ")}${env?.PATH === undefined ? "" : ` [PATH ${env.PATH}]`}`);
    if (args[0] === "plugin") stub.files.set(plugins, entry("/h/herdr/plugins/new", args[args.indexOf("--ref") + 1]));
    return { status: 0, stdout: "", stderr: "" };
  };
  const remoteTags = () => `${"a".repeat(40)}\trefs/tags/v0.4.12\n${"b".repeat(40)}\trefs/tags/v0.4.13\n`;
  const wiring = herdrWiring({ version: "0.9.5" }, services, { herdr, remoteTags });
  update({ version: undefined, channel: "release" }, f.deps({ ...wiring }));
  assert.ok(f.said.includes("agent-org update: moved the herdr plugin devswha/herdr-web-ui from @35bf28fa to v0.4.13"), f.said.join("\n"));
  assert.ok(f.said.includes("agent-org update: restarted the terminal service so it runs herdr web ui v0.4.13"));
  assert.ok(calls.includes("herdr plugin install devswha/herdr-web-ui --ref v0.4.13 -y [PATH /opt/bin:/opt/bin:/usr/bin]"), calls.join("\n"));
  assert.match(stub.files.get(unit.path) ?? "", /\/h\/herdr\/plugins\/new/, "the unit names the plugin_root that is installed now");
  assert.ok(calls.includes("systemctl --user daemon-reload") && calls.includes("systemctl --user restart agent-org-terminal.service"));
  assert.deepEqual(calls.filter((call) => /restart|stop|kill/.test(call) && !call.includes("agent-org-terminal")), [], "herdr, the instance and the ui are not restarted by upkeep");
  const status = readHerdrStatus(herdrStatusPath(services.env, f.home));
  assert.deepEqual(status.kind === "status" ? [status.status.herdr, status.status.plugins] : status, [{ newest: "0.9.5" }, [{ repo: "devswha/herdr-web-ui", newest: "v0.4.13" }]]);
});
