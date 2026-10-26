// no-token: none -- git runs in a remote this file builds; the dependency installs and the services are stand-ins (`update-fixture.ts`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { herdrWiring, runUpdate, update, UpdateRefusal } from "./update.ts";
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
import { bsdtarLikeExec, publishUiAsset, startReleaseServer } from "./fixtures/release-server.ts";
import { swapCurrent, uiBuildReleased } from "./tool-install.ts";

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
const HERDR_LINES = { newFailures: 0, said: ["reinstalled herdr's claude integration (it was outdated (v8 < v10); now current (v10))"], failed: ["the herdr plugin devswha/herdr-web-ui is at @35bf28fa and `herdr plugin install devswha/herdr-web-ui --ref v0.4.13 -y` failed: no"] };

test("A11-184: update logs what herdr's upkeep changed as it does the plugins' and the conventions', and a failure is an error that fails nothing", () => {
  const f = installed();
  let ran = 0;
  assert.equal(update({ version: undefined, channel: "release" }, f.deps({ herdr: () => { ran += 1; return HERDR_LINES; } })), true);
  assert.equal(ran, 1);
  assert.ok(f.said.includes(`agent-org update: ${HERDR_LINES.said[0]}`));
  assert.deepEqual(f.errors, [`agent-org update: ${HERDR_LINES.failed[0]}`]);
});

test("A11-287: an update whose herdr upkeep met a new plugin failure exits 1 after the tool moved, and one with a held failure exits 0", () => {
  const f = installed();
  const failure = { said: [], failed: ["the herdr plugin devswha/herdr-web-ui is at v0.4.13 and `herdr plugin install` failed (exit 1); herdr said:\nboom"], newFailures: 1 };
  assert.equal(runUpdate({ version: undefined, channel: "release" }, f.deps({ herdr: () => failure })), 1);
  assert.equal(currentVersionName(f.tool), "v0.10.0", "the move of the tool stays applied");
  assert.deepEqual(f.errors, [`agent-org update: ${failure.failed[0]}`], "and the failure is one error line");
  const held = installed();
  assert.equal(runUpdate({ version: undefined, channel: "release" }, held.deps({ herdr: () => ({ said: [], failed: [], newFailures: 0 }) })), 0);
  assert.equal(runUpdate({ version: undefined, channel: "release" }, held.deps({ herdr: () => ({ said: [], failed: ["the terminal service did not restart"], newFailures: 0 }) })), 0, "a failure that is not new does not fail the run");
});

test("A11-184: herdr's upkeep runs when nothing is newer, when the build fails, and while a breaking release drains", () => {
  const quiet = installed();
  update({ version: undefined, channel: "release" }, quiet.deps());
  let ran = 0;
  const count = () => { ran += 1; return { said: [], failed: [], newFailures: 0 }; };
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

// A11-191: a release ships its UI build, and update fetches it, verifies it and unpacks it into the version folder before the version becomes current.
const SHIPS = { shipsUiBuild: true };

/** A UI build for `tag`, whose page says which release it is. */
function distFor(root: string, tag: string): string {
  const dist = join(root, `dist-${tag}`);
  mkdirSync(join(dist, "_astro"), { recursive: true });
  writeFileSync(join(dist, "index.html"), `<title>${tag}</title>\n`);
  writeFileSync(join(dist, "_astro", "app.js"), `console.log("${tag}");\n`);
  return dist;
}

/** An update fixture whose UI builds come from a stand-in for GitHub's downloads: `attach(tag)` is CI attaching that release's build. */
async function shipping(states: Parameters<typeof updateFixture>[0] = { states: { instance: "running" } }) {
  const f = updateFixture(states);
  const server = await startReleaseServer(join(f.root, "releases"));
  f.fetchUiFrom(server.url);
  const attach = (tag: string) => publishUiAsset(server.root, tag, distFor(f.root, tag));
  return { f, server, attach };
}

/** `shipping()` with `version` installed and current, running from its folder; it ships a UI build, attached, when `ships` is true. */
async function shippingInstalledAt(version: string, ships: boolean) {
  const made = await shipping();
  made.f.release(version, "a fix", ships ? SHIPS : {});
  if (ships) made.attach(`v${version}`);
  update({ version: undefined, channel: "release" }, made.f.deps());
  made.f.runFromVersion(`v${version}`);
  return made;
}

/** CI cutting `version` with a UI build: the release, and its build attached to it. */
function shipRelease({ f, attach }: Pick<Awaited<ReturnType<typeof shipping>>, "f" | "attach">, version: string): void {
  f.release(version, "a fix", SHIPS);
  attach(`v${version}`);
}

const versionDir = (f: { tool: string }, name: string) => join(f.tool, "versions", name);
const versionNames = (f: { tool: string }) => readdirSync(join(f.tool, "versions")).toSorted();

/** Every file under `dir` with its content's hash: what "byte-identical" compares. */
function treeOf(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { recursive: true, encoding: "utf8" }).toSorted().map((path) => {
    const file = join(dir, path);
    return [path, statSync(file).isDirectory() ? "dir" : createHash("sha256").update(readFileSync(file)).digest("hex")];
  }));
}

test("A11-191: update downloads the UI build of the release it moves to, verifies it, and has it in the version folder BEFORE current moves", async () => {
  const made = await shippingInstalledAt("0.1.0", false);
  const { f, server } = made;
  shipRelease(made, "0.2.0");
  f.said.length = 0;
  const atSwap: boolean[] = [];
  assert.equal(update({ version: undefined, channel: "release" }, f.deps({ swap: (name) => { atSwap.push(existsSync(join(versionDir(f, name), "ui-build", "index.html"))); swapCurrent(f.tool, name); } })), true);
  assert.deepEqual(atSwap, [true], "the build was in the folder when current was pointed at it");
  assert.equal(currentVersionName(f.tool), "v0.2.0");
  assert.equal(readFileSync(join(versionDir(f, "v0.2.0"), "ui-build", "index.html"), "utf8"), "<title>v0.2.0</title>\n");
  assert.ok(f.said.includes("agent-org update: ✓ UI build for v0.2.0 installed (2 files)"), f.said.join("\n"));
  assert.deepEqual(server.requests(), ["/v0.2.0/agent-org-ui-v0.2.0.tar.gz.sha256", "/v0.2.0/agent-org-ui-v0.2.0.tar.gz.sha256", "/v0.2.0/agent-org-ui-v0.2.0.tar.gz"], "the checksum is asked for once to see the release is released, then fetched with its tarball");
});

test("A11-191: a release before the marker installs as it always did: no request is made and no ui-build is made", async () => {
  const { f, server } = await shipping();
  f.release("0.1.0");
  f.release("0.2.0");
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), true);
  assert.equal(currentVersionName(f.tool), "v0.2.0");
  assert.deepEqual(server.requests(), []);
  assert.equal(existsSync(join(versionDir(f, "v0.2.0"), "ui-build")), false);
  update({ version: undefined, channel: "release" }, f.deps());
  assert.deepEqual(server.requests(), [], "and the update that finds nothing newer asks for nothing either");
});

/** v0.1.0 installed, v0.2.0 released with its build, and v0.3.0 cut with no build attached yet. */
async function installedWithLateRelease() {
  const made = await shippingInstalledAt("0.1.0", false);
  shipRelease(made, "0.2.0");
  made.f.release("0.3.0", "a fix", SHIPS);
  return made;
}

test("A11-284: a release whose declared build is not attached yet is not released: the update stays on the current version without an error, restarts nothing, and moves once the build is attached", async () => {
  const { f, server, attach } = await shippingInstalledAt("0.1.0", false);
  f.states.ui = "running";
  f.release("0.2.0", "a fix", SHIPS);
  for (const record of [f.installs, f.restarted, f.said, f.statuses]) record.length = 0;
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), false);
  assert.equal(currentVersionName(f.tool), "v0.1.0");
  assert.deepEqual(versionNames(f), ["v0.1.0"], "no v0.2.0 and no .partial is left");
  assert.deepEqual(f.installs, [], "the dependency install is not spent on it");
  assert.deepEqual(f.restarted, [], "no service restarts onto a version without its build");
  assert.ok(f.said.includes("agent-org update: v0.2.0 has not attached its UI build yet, so it is not released until it has; agent-org stays at v0.1.0 and the next update tries again"), f.said.join("\n"));
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.statuses.map(({ installed, latest }) => [installed, latest]), [["v0.1.0", "v0.1.0"]], "the status reports no release newer than the installed one");
  assert.deepEqual(server.requests(), ["/v0.2.0/agent-org-ui-v0.2.0.tar.gz.sha256"], "one probe, and no download");
  attach("v0.2.0");
  f.said.length = 0;
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), true);
  assert.equal(currentVersionName(f.tool), "v0.2.0");
  assert.deepEqual(f.restarted, ["instance", "ui"], "the services restart once, after the build is in place");
  assert.equal(readFileSync(join(versionDir(f, "v0.2.0"), "ui-build", "index.html"), "utf8"), "<title>v0.2.0</title>\n");
  assert.equal(f.said.some((line) => /not released/.test(line)), false);
});

test("A11-284: only the release whose build is late is skipped: the update moves to the newest release that has its build", async () => {
  const { f } = await installedWithLateRelease();
  f.said.length = 0;
  f.statuses.length = 0;
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), true);
  assert.equal(currentVersionName(f.tool), "v0.2.0");
  assert.ok(f.said.includes("agent-org update: v0.3.0 has not attached its UI build yet, so it is not released until it has; the next update tries again"), f.said.join("\n"));
  assert.deepEqual(f.statuses.map(({ installed, latest }) => [installed, latest]), [["v0.2.0", "v0.2.0"]]);
});

test("A11-284: the walk stops at the installed version and never asks about it, and a release before the marker is released without a request", async () => {
  const { f, server } = await shippingInstalledAt("0.1.0", true);
  const before = server.requests().length;
  f.release("0.2.0", "a fix", SHIPS);
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), false);
  assert.deepEqual(server.requests().slice(before), ["/v0.2.0/agent-org-ui-v0.2.0.tar.gz.sha256"], "v0.2.0 is asked about, and the installed v0.1.0 is not");
  f.release("0.3.0");
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), true);
  assert.equal(currentVersionName(f.tool), "v0.3.0");
  assert.equal(server.requests().length, before + 1, "v0.3.0 declares no build, so no request was made for it");
});

test("A11-284: every 404 is not released, however long ago the tag was cut: the update stays put and exits 0 until the build is attached", async () => {
  const { f, attach } = await shippingInstalledAt("0.1.0", false);
  f.release("0.2.0", "a fix", SHIPS);
  f.state.now = Date.now() + 48 * 3600e3;
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), false);
  assert.equal(currentVersionName(f.tool), "v0.1.0");
  assert.deepEqual(f.errors, []);
  attach("v0.2.0");
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), true);
  assert.equal(currentVersionName(f.tool), "v0.2.0");
});

test("A11-284: an installed version that is not one of the tags is not walked: the newest tag is targeted, and a missing build fails as before, never a move to an older release", async () => {
  const { f } = await installedWithLateRelease();
  f.runFromVersion("v0.9.9");
  rmSync(join(f.tool, "current"), { force: true });
  f.said.length = 0;
  assert.throws(() => update({ version: undefined, channel: "release" }, f.deps()), (err: Error) => err instanceof UpdateRefusal && /not moved to v0\.3\.0, because building it failed/.test(err.message));
  assert.equal(f.said.some((line) => /not released/.test(line)), false);
});

test("A11-284: a version folder that already holds its build is released whatever the release answers now", async () => {
  const { f, server } = await shippingInstalledAt("0.1.0", true);
  const ui = { releases: () => server.url, exec: execFileSync };
  assert.equal(uiBuildReleased({ tool: f.tool, tag: "v0.1.0", ui }), "attached");
  rmSync(join(server.root, "v0.1.0"), { recursive: true });
  assert.equal(uiBuildReleased({ tool: f.tool, tag: "v0.1.0", ui }), "attached", "the asset is gone, the folder has its build");
  assert.equal(uiBuildReleased({ tool: f.tool, tag: "v0.7.0", ui }), "not-yet", "a folder that is not there is asked for");
});

test("A11-284: a probe that cannot tell (HTTP 503, no server) is not 'not released': the tag is targeted and the build fails the update as before, with current unchanged", async () => {
  for (const breakServer of [({ f, server }: Awaited<ReturnType<typeof shipping>>) => f.fetchUiFrom(server.url, () => "503"), ({ f }: Awaited<ReturnType<typeof shipping>>) => f.fetchUiFrom("http://127.0.0.1:1/dl")]) {
    const made = await shippingInstalledAt("0.1.0", false);
    made.f.release("0.2.0", "a fix", SHIPS);
    breakServer(made);
    assert.throws(() => update({ version: undefined, channel: "release" }, made.f.deps()), (err: Error) => err instanceof UpdateRefusal && /^agent-org stays at v0\.1\.0, not moved to v0\.2\.0, because building it failed: UI build download failed/.test(err.message));
    assert.equal(currentVersionName(made.f.tool), "v0.1.0");
  }
});

test("A11-284: a version named with --version is not walked: an unattached one is refused as before and current stays", async () => {
  const { f } = await shippingInstalledAt("0.1.0", false);
  f.release("0.2.0", "a fix", SHIPS);
  f.installs.length = 0;
  assert.throws(() => update({ version: "v0.2.0", channel: "release" }, f.deps()), (err: Error) => err instanceof UpdateRefusal && /stays at v0\.1\.0, not moved to v0\.2\.0.*v0\.2\.0 has not attached its UI build yet \(CI attaches it a few minutes after the release\)/.test(err.message));
  assert.equal(currentVersionName(f.tool), "v0.1.0");
  assert.deepEqual(versionNames(f), ["v0.1.0"], "no v0.2.0 and no .partial is left");
  assert.deepEqual(f.installs, [], "the missing build is found before pnpm runs");
});

test("A11-191: a checksum that does not match fails the move, leaves current where it was, and leaves no folder", async () => {
  const { f, attach } = await shippingInstalledAt("0.1.0", false);
  f.release("0.2.0", "a fix", SHIPS);
  const { checksum } = attach("v0.2.0");
  writeFileSync(checksum, `${"0".repeat(64)}  agent-org-ui-v0.2.0.tar.gz\n`);
  assert.throws(() => update({ version: undefined, channel: "release" }, f.deps()), /because building it failed: UI build checksum failed: agent-org-ui-v0\.2\.0\.tar\.gz did not match its checksum, so it was not installed/);
  assert.equal(currentVersionName(f.tool), "v0.1.0");
  assert.deepEqual(versionNames(f), ["v0.1.0"]);
});

test("A11-191: the update that finds nothing newer completes the current folder's missing build, which is how the first release that ships one gets it (its install was made by an update that did not know)", async () => {
  const made = await shippingInstalledAt("0.1.0", false);
  const { f, server } = made;
  shipRelease(made, "0.2.0");
  f.state.inUse = [versionDir(f, "v0.1.0")];
  update({ version: undefined, channel: "release" }, f.deps());
  rmSync(join(versionDir(f, "v0.2.0"), "ui-build"), { recursive: true });
  const others = treeOf(versionDir(f, "v0.1.0"));
  f.said.length = 0;
  assert.equal(update({ version: undefined, channel: "release" }, f.deps()), false);
  assert.deepEqual(f.said.slice(0, 2), ["agent-org is at v0.2.0: nothing newer", "agent-org update: ✓ UI build for v0.2.0 installed (2 files)"]);
  assert.equal(readFileSync(join(versionDir(f, "v0.2.0"), "ui-build", "index.html"), "utf8"), "<title>v0.2.0</title>\n");
  assert.deepEqual(treeOf(versionDir(f, "v0.1.0")), others, "no other folder was touched");
  assert.equal(currentVersionName(f.tool), "v0.2.0");
  const asked = server.requests().length;
  f.said.length = 0;
  update({ version: undefined, channel: "release" }, f.deps());
  assert.deepEqual(f.said, ["agent-org is at v0.2.0: nothing newer", "agent-org update: the UI build of v0.2.0 is in place"], "once it has its build, an update asks for nothing, and says the build is in place");
  assert.equal(server.requests().length, asked);
});

test("A11-266: a build that cannot be fetched for the folder that is already current fails the update, after the status is written and the upkeep has run", async () => {
  const { f } = await shippingInstalledAt("0.1.0", true);
  rmSync(join(versionDir(f, "v0.1.0"), "ui-build"), { recursive: true });
  rmSync(join(f.root, "releases", "v0.1.0"), { recursive: true });
  f.statuses.length = 0;
  const upkeep: string[] = [];
  const refusal = (err: Error) => err instanceof UpdateRefusal && err.message === "agent-org is at v0.1.0, but it has no UI build, so the board shows \"The UI build is missing\": UI build download failed: v0.1.0 has not attached its UI build yet (CI attaches it a few minutes after the release), so it is not installed; the next update tries again";
  assert.throws(() => update({ version: undefined, channel: "release" }, f.deps({ upkeep: () => { upkeep.push("ran"); return []; } })), refusal);
  assert.equal(currentVersionName(f.tool), "v0.1.0");
  assert.equal(f.statuses.length, 1, "the status file was written before the refusal");
  assert.deepEqual(upkeep, ["ran"], "the plugins' upkeep ran");
  assert.deepEqual(versionNames(f), ["v0.1.0"], "no staging folder is left");
});

// A11-266: a declared build that cannot be fetched fails the update, naming the step and the error, and leaves current where it was.
const DOWNLOADS: readonly (readonly [string, (f: Awaited<ReturnType<typeof shipping>>) => void, RegExp])[] = [
  ["a 503", ({ f, server }) => f.fetchUiFrom(server.url, () => "503"), /because building it failed: UI build download failed: .*agent-org-ui-v0\.2\.0\.tar\.gz\.sha256 could not be downloaded \(HTTP 503\)/],
  ["no server", ({ f }) => f.fetchUiFrom("http://127.0.0.1:1/dl"), /because building it failed: UI build download failed: http:\/\/127\.0\.0\.1:1\/dl\/v0\.2\.0\/agent-org-ui-v0\.2\.0\.tar\.gz\.sha256 could not be downloaded \(.*[Cc]onnect/],
];

for (const [label, breakServer, message] of DOWNLOADS) {
  test(`A11-266: ${label} fails the update, naming the step and the error, and leaves current, the folders and the services alone`, async () => {
    const made = await shippingInstalledAt("0.1.0", false);
    made.f.release("0.2.0", "a fix", SHIPS);
    breakServer(made);
    made.f.restarted.length = 0;
    assert.throws(() => update({ version: undefined, channel: "release" }, made.f.deps()), (err: Error) => err instanceof UpdateRefusal && message.test(err.message));
    assert.equal(currentVersionName(made.f.tool), "v0.1.0");
    assert.deepEqual(versionNames(made.f), ["v0.1.0"], "no v0.2.0, no .partial, no ui-build");
    assert.deepEqual(made.f.restarted, [], "nothing was restarted on a version that did not become current");
  });
}

test("A11-266: a nothing-newer update whose build is missing and whose server cannot be reached fails too", async () => {
  const { f } = await shippingInstalledAt("0.1.0", true);
  rmSync(join(versionDir(f, "v0.1.0"), "ui-build"), { recursive: true });
  f.fetchUiFrom("http://127.0.0.1:1/dl");
  assert.throws(() => update({ version: undefined, channel: "release" }, f.deps()), (err: Error) => err instanceof UpdateRefusal && /^agent-org is at v0\.1\.0, but it has no UI build.*UI build download failed: http:\/\/127\.0\.0\.1:1\/dl\/v0\.1\.0\//.test(err.message));
  assert.equal(currentVersionName(f.tool), "v0.1.0");
});

test("A11-266: a folder that is built and in place, but declares a UI build and has none, is never pointed at by current", async () => {
  const { f } = await shippingInstalledAt("0.1.0", false);
  f.release("0.2.0", "a fix", SHIPS);
  const folder = versionDir(f, "v0.2.0");
  mkdirSync(join(folder, "src"), { recursive: true });
  writeFileSync(join(folder, "src", "bin.ts"), "// agent-org 0.2.0\n");
  writeFileSync(join(folder, "package.json"), `${JSON.stringify({ name: "agent-org", version: "0.2.0", agentOrg: SHIPS })}\n`);
  assert.throws(() => swapCurrent(f.tool, "v0.2.0"), /^Error: versions\/v0\.2\.0 declares a UI build and has none, so current stays where it is$/);
  assert.equal(currentVersionName(f.tool), "v0.1.0");
});

test("A11-266: a swap that is refused fails the update as a refusal that says current stayed, and nothing restarts", async () => {
  const { f } = await shippingInstalledAt("0.1.0", false);
  f.release("0.2.0");
  f.restarted.length = 0;
  const refusing = f.deps({ swap: () => { throw new Error("versions/v0.2.0 declares a UI build and has none, so current stays where it is"); } });
  assert.throws(() => update({ version: undefined, channel: "release" }, refusing), (err: Error) => err instanceof UpdateRefusal && /^agent-org stays at v0\.1\.0, not moved to v0\.2\.0, because current could not be moved to it: versions\/v0\.2\.0 declares a UI build and has none/.test(err.message));
  assert.deepEqual(f.restarted, []);
  assert.equal(currentVersionName(f.tool), "v0.1.0");
});

test("A11-266: on macOS (launchd services, bsdtar), an update installs ui-build/ before current moves, and prints the line for it with its file count", async () => {
  const { f, server, attach } = await shipping({ states: { instance: "running", ui: "running" }, platform: "darwin" });
  f.fetchUiFrom(server.url, bsdtarLikeExec());
  f.release("0.1.0");
  update({ version: undefined, channel: "release" }, f.deps());
  f.runFromVersion("v0.1.0");
  f.release("0.2.0", "a fix", SHIPS);
  attach("v0.2.0");
  f.said.length = 0;
  f.restarted.length = 0;
  const atSwap: boolean[] = [];
  assert.equal(f.services.platform, "darwin");
  assert.equal(update({ version: undefined, channel: "release" }, f.deps({ swap: (name) => { atSwap.push(existsSync(join(versionDir(f, name), "ui-build", "index.html"))); swapCurrent(f.tool, name); } })), true);
  assert.deepEqual(atSwap, [true], "ui-build/index.html was in the folder when current was pointed at it");
  assert.equal(readFileSync(join(versionDir(f, "v0.2.0"), "ui-build", "_astro", "app.js"), "utf8"), "console.log(\"v0.2.0\");\n");
  assert.deepEqual(f.said.filter((line) => /UI build/.test(line)), ["agent-org update: ✓ UI build for v0.2.0 installed (2 files)"]);
  assert.ok(f.said.indexOf("agent-org update: ✓ UI build for v0.2.0 installed (2 files)") < f.said.findIndex((line) => line.startsWith("agent-org v0.2.0 is current")), "the UI line comes before 'is current'");
  assert.deepEqual(f.restarted, ["instance", "ui"]);
  assert.deepEqual(f.errors, []);
});

test("A11-191 pinning: a folder a run still names keeps its own build across an update, byte for byte, and the new folder has its own", async () => {
  const made = await shippingInstalledAt("0.1.0", true);
  const { f } = made;
  const pinned = treeOf(versionDir(f, "v0.1.0"));
  shipRelease(made, "0.2.0");
  f.state.inUse = [versionDir(f, "v0.1.0")];
  update({ version: undefined, channel: "release" }, f.deps());
  assert.deepEqual(versionNames(f), ["v0.1.0", "v0.2.0"], "the pruned set keeps the folder a run names");
  assert.deepEqual(treeOf(versionDir(f, "v0.1.0")), pinned);
  assert.equal(readFileSync(join(versionDir(f, "v0.1.0"), "ui-build", "index.html"), "utf8"), "<title>v0.1.0</title>\n");
  assert.equal(readFileSync(join(versionDir(f, "v0.2.0"), "ui-build", "index.html"), "utf8"), "<title>v0.2.0</title>\n");
  f.runFromVersion("v0.2.0");
  f.state.inUse = [];
  f.release("0.3.0");
  update({ version: undefined, channel: "release" }, f.deps());
  assert.deepEqual(versionNames(f), ["v0.2.0", "v0.3.0"], "v0.1.0, which no run names any more, is pruned with its build");
});

test("A11-191: the main channel has no Release, so it asks for nothing and says so", async () => {
  const { f, server } = await shipping();
  f.release("0.1.0", "a fix", SHIPS);
  f.onMain("a commit on main");
  assert.equal(update({ version: undefined, channel: "main" }, f.deps()), true);
  assert.equal(currentVersionName(f.tool), f.mainName());
  assert.deepEqual(server.requests(), []);
  assert.ok(f.said.some((line) => /^agent-org update: main-[0-9a-f]{8} is not a release, so it has no UI build to fetch/.test(line)), f.said.join("\n"));
});
