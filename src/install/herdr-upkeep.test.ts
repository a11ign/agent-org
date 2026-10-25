// no-token: none -- herdr, `git ls-remote`, herdr.dev and the service manager are stand-ins; the status file is written into a temporary directory
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import type { RunResult, ServiceState } from "./service.ts";
import {
  describeInstalled, fetchHerdrNewest, herdrBehind, herdrOutput, herdrStatusPath, herdrUpkeep, herdrVersionOf, installedPlugin, integrationStates, isBehind, newestPluginTag, newestReleaseTag, pluginEntries,
  readHerdrStatus, writeHerdrStatus, type HerdrNewest, type HerdrStatus, type HerdrStatusFile, type HerdrUpkeepDeps, type PluginFailure,
} from "./herdr-upkeep.ts";

const REPO = "devswha/herdr-web-ui";
const OK: RunResult = { status: 0, stdout: "", stderr: "" };

/** `git ls-remote --tags` of the web UI, in the order git prints it (lexical, so v0.4.10 sorts before v0.4.9), with the peeled lines an annotated tag adds. */
const TAGS = ["v0.4.9", "v0.4.10", "v0.4.11", "v0.4.12", "v0.4.13"].flatMap((tag, index) => [`${String(index).repeat(40)}\trefs/tags/${tag}`, `${"f".repeat(40)}\trefs/tags/${tag}^{}`]).join("\n");

const OLD_ID = "devswha.herdr-web-ui";
const NEW_ID = "devswha.ovis";
const OLD_ROOT = "/h/.config/herdr/plugins/github/devswha.herdr-web-ui-210f";
const NEW_ROOT = "/h/.config/herdr/plugins/github/devswha.ovis-aa47";

/** One entry of herdr's `plugins.json` as herdr 0.9.3 writes it: the web UI under manifest id `id`, asked for at `ref` (null for none), resolved to `commit` and installed at `installedAt`. */
const webUi = (id: string, ref: string | null, commit = "35bf28fa1234567890abcdef1234567890abcdef", installedAt?: number): object => ({
  plugin_id: id, version: "0.4.12", plugin_root: id === NEW_ID ? NEW_ROOT : OLD_ROOT,
  source: { kind: "github", owner: "devswha", repo: "herdr-web-ui", ...(ref === null ? {} : { requested_ref: ref }), resolved_commit: commit, ...(installedAt === undefined ? {} : { installed_unix_ms: installedAt }) },
});

/** The text of `plugins.json` holding the web UI under its old id, asked for at `ref`. */
const pluginsJson = (ref: string | null, commit = "35bf28fa1234567890abcdef1234567890abcdef", extra: object[] = []): string => JSON.stringify([webUi(OLD_ID, ref, commit), ...extra]);

/** `herdr integration status` as herdr 0.9.3 prints it. */
const statusText = (claude: string, codex: string): string => `pi: not installed (/h/.pi/herdr-agent-state.ts)\nclaude: ${claude} (/h/.claude/hooks/herdr-agent-state.sh)\ncodex: ${codex} (/h/.codex/herdr-agent-state.sh)\n`;

/** What `herdr plugin install` prints: several lines on stdout, and a warning on stderr. */
const INSTALL_STDOUT = ["building devswha/herdr-web-ui", "bun install", "installed devswha.ovis"];

type Start = {
  claude?: string; codex?: string; ref?: string | null; installed?: boolean; remote?: string; terminal?: ServiceState; bun?: string | null; newest?: HerdrNewest; fail?: string[]; unchanged?: boolean;
  extraPlugins?: object[]; plugins?: object[]; rename?: boolean; lingers?: boolean; last?: HerdrStatusFile; restartFails?: boolean;
};

/**
 * herdr and its surroundings as one upkeep run sees them. Every call is recorded; `fail` makes a command fail. `plugins` is the start of `plugins.json` (the web UI at `ref` under its old id when
 * it is not given); `rename` makes `plugin install` ADD an entry under the new manifest id, as herdr does for v0.4.16; `unchanged` makes an install exit 0, print, and change nothing; `lingers`
 * makes `plugin uninstall` exit 0 and leave the entry; `last` is the status file the last run wrote.
 */
function world(start: Start = {}) {
  const ref = start.ref === undefined ? "v0.4.13" : start.ref;
  const state = { claude: start.claude ?? "current (v10)", codex: start.codex ?? "current (v8)", ref, plugins: start.plugins ?? (start.installed === false ? [] : [webUi(OLD_ID, ref)]) };
  const calls: string[] = [];
  const envs: Record<string, string | undefined>[] = [];
  const restarts: string[] = [];
  const statuses: HerdrStatus[] = [];
  const fail = new Set(start.fail ?? []);
  const isWebUi = (plugin: object) => (plugin as { source?: { repo?: string } }).source?.repo === "herdr-web-ui";
  const install = (asked: string) => {
    state.ref = asked;
    const commit = "d5a35b7a44ad864ec75581457bfcaa144b22a9e5";
    if (start.rename === true) state.plugins.push(webUi(NEW_ID, asked, commit, 2000));
    else state.plugins = state.plugins.map((plugin) => (isWebUi(plugin) ? webUi(OLD_ID, asked, commit, 2000) : plugin));
  };
  const deps: HerdrUpkeepDeps = {
    herdr: (args, env) => {
      const line = args.join(" ");
      calls.push(line);
      if (env !== undefined) envs.push(env);
      if (fail.has(line)) return { status: 1, stdout: "", stderr: `herdr: ${line} refused\nmore` };
      if (line === "integration status") return { status: 0, stdout: statusText(state.claude, state.codex), stderr: "" };
      if (args[0] === "integration" && args[1] === "install") {
        if (start.unchanged !== true) state[args[2] as "claude" | "codex"] = args[2] === "claude" ? "current (v10)" : "current (v8)";
        return OK;
      }
      if (args[0] === "plugin" && args[1] === "install") {
        if (start.unchanged !== true) install(args[args.indexOf("--ref") + 1]);
        return { status: 0, stdout: `${INSTALL_STDOUT.join("\n")}\n`, stderr: "warning: the manifest id changed\n" };
      }
      if (args[0] === "plugin" && args[1] === "uninstall") {
        if (start.lingers !== true) state.plugins = state.plugins.filter((plugin) => (plugin as { plugin_id?: string }).plugin_id !== args[2]);
        return OK;
      }
      return { status: 1, stdout: "", stderr: `unexpected herdr ${line}` };
    },
    pluginsJson: () => (state.plugins.length === 0 && start.extraPlugins === undefined ? null : JSON.stringify([...state.plugins, ...(start.extraPlugins ?? [])])),
    remoteTags: (repo) => {
      calls.push(`git ls-remote --tags ${repo}`);
      return start.remote ?? TAGS;
    },
    bunDir: () => (start.bun === undefined ? "/h/.bun/bin" : start.bun),
    path: "/usr/bin:/bin",
    lastStatus: () => start.last ?? { kind: "absent" },
    terminalState: () => start.terminal ?? "running",
    restartTerminal: () => {
      if (start.restartFails === true) throw new Error("the service manager refused the restart\nmore");
      restarts.push(`terminal after ${state.ref}`);
      calls.push("terminal restarted");
    },
    newestHerdr: start.newest ?? { version: "0.9.5" },
    writeStatus: (status) => { statuses.push(status); },
    now: () => Date.parse("2026-10-24T10:00:00.000Z"),
  };
  return { deps, state, calls, envs, restarts, statuses, run: () => herdrUpkeep(deps) };
}

test("A11-184: the integration status is read per agent: current, outdated (v8 < v10), not installed, no line, and a line that is not a state", () => {
  const states = (text: string) => integrationStates(text).map(({ name, state, detail }) => [name, state, detail]);
  assert.deepEqual(states(statusText("current (v10)", "current (v8)")), [["claude", "current", "current (v10)"], ["codex", "current", "current (v8)"]]);
  assert.deepEqual(states("claude: outdated (v8 < v10)\ncodex: current (v8) (/h/.codex/x.sh)\n"), [["claude", "outdated", "outdated (v8 < v10)"], ["codex", "current", "current (v8)"]]);
  assert.deepEqual(states("claude: not installed (/h/.claude/hooks/x.sh)\n"), [["claude", "missing", "not installed"], ["codex", "missing", "not listed by herdr"]]);
  assert.deepEqual(states("claude: currently broken\ncodex: ???\n"), [["claude", "missing", "currently broken"], ["codex", "missing", "???"]], "unknown is never read as current: an install is idempotent");
  assert.deepEqual(states("pi: current (v3)\n").map(([, state]) => state), ["missing", "missing"], "only claude and codex are read");
});

test("A11-184: an installed plugin is read from plugins.json by its source, and is where its release tag or its commit says", () => {
  const pinned = installedPlugin(pluginsJson(null), REPO);
  assert.deepEqual(pinned, { pluginId: OLD_ID, ref: null, commit: "35bf28fa1234567890abcdef1234567890abcdef", root: OLD_ROOT });
  assert.equal(describeInstalled(pinned!), "@35bf28fa");
  assert.equal(describeInstalled(installedPlugin(pluginsJson("v0.4.13"), REPO)!), "v0.4.13");
  assert.equal(describeInstalled(installedPlugin(pluginsJson("main"), REPO)!), "@35bf28fa", "a branch is not where it is: the commit is");
  assert.equal(installedPlugin(pluginsJson(null), "someone/else"), null);
  assert.equal(installedPlugin(null, REPO), null);
  assert.equal(installedPlugin("not json", REPO), null);
  assert.equal(installedPlugin("{}", REPO), null);
});

test("A11-184: a plugin is behind when it is on no release tag, or an older one", () => {
  const at = (ref: string | null) => installedPlugin(pluginsJson(ref), REPO)!;
  assert.deepEqual([null, "35bf28fa", "main", "v0.4.12", "v0.4.9", "v0.4.13", "v0.5.0"].map((ref) => isBehind(at(ref), "v0.4.13")), [true, true, true, true, true, false, false]);
});

test("A11-184: the newest release tag is numeric and release-only: a branch, a pre-release and a moving name are never chosen, and a remote with none is a refusal", () => {
  assert.equal(newestReleaseTag(TAGS), "v0.4.13", "v0.4.13 is newer than v0.4.9, which git's lexical order puts last");
  const none = "aaa\trefs/tags/v0.5.0-rc1\nbbb\trefs/tags/latest\nccc\trefs/tags/main\nddd\trefs/heads/main\n";
  assert.equal(newestReleaseTag(none), null);
  assert.throws(() => newestPluginTag(REPO, () => none), /devswha\/herdr-web-ui has no release tag, and agent-org installs a plugin only at a release tag, never a branch/);
  assert.throws(() => newestPluginTag(REPO, () => { throw new Error("fatal: could not resolve host\nmore"); }), /^Error: could not list the release tags of devswha\/herdr-web-ui: fatal: could not resolve host$/);
  assert.equal(newestPluginTag(REPO, () => TAGS), "v0.4.13");
});

test("A11-184: herdr is behind when its bare version is older than the newest; a version that is not x.y.z is not known, never behind", () => {
  assert.equal(herdrVersionOf("herdr 0.9.3\n"), "0.9.3");
  assert.equal(herdrVersionOf("no version"), null);
  assert.deepEqual([herdrBehind("0.9.3", "0.9.5"), herdrBehind("0.9.5", "0.9.5"), herdrBehind("0.10.0", "0.9.5"), herdrBehind("0.9.3", "0.9.5-rc1"), herdrBehind("x", "0.9.5")], [true, false, false, false, false]);
});

test("A11-184: auto-update re-installs an outdated claude integration, says what changed, and does not touch a current codex integration", () => {
  const w = world({ claude: "outdated (v8 < v10)" });
  const { said, failed } = w.run();
  assert.deepEqual(said, ["reinstalled herdr's claude integration (it was outdated (v8 < v10); now current (v10))"]);
  assert.deepEqual(failed, []);
  assert.ok(w.calls.includes("integration install claude"));
  assert.ok(!w.calls.includes("integration install codex"), "a current integration is left alone");
});

test("A11-184: auto-update installs a missing codex integration, and with both current runs no install and says nothing", () => {
  const missing = world({ codex: "not installed" });
  assert.deepEqual(missing.run().said, ["reinstalled herdr's codex integration (it was not installed; now current (v8))"]);
  const quiet = world();
  assert.deepEqual(quiet.run(), { said: [], failed: [], newFailures: 0 }, "a quiet ten-minute run adds no line to the log");
  assert.deepEqual(quiet.calls.filter((call) => call.includes("install")), []);
  assert.deepEqual(quiet.restarts, []);
});

test("A11-184: an integration that fails to install, or installs and is still not current, is a failure naming the command; a status that cannot be read stops the integrations only", () => {
  const refused = world({ claude: "outdated (v8 < v10)", fail: ["integration install claude"] });
  assert.deepEqual(refused.run().failed, ["herdr's claude integration is outdated (v8 < v10), and `herdr integration install claude` failed: herdr: integration install claude refused"]);
  const stuck = world({ claude: "outdated (v8 < v10)", unchanged: true });
  assert.deepEqual(stuck.run().failed, ["`herdr integration install claude` ran, but herdr's claude integration is still outdated (v8 < v10)"]);
  const unreadable = world({ fail: ["integration status"] });
  const { failed } = unreadable.run();
  assert.match(failed[0], /^could not read `herdr integration status` \(herdr: integration status refused\), so herdr's claude and codex integrations were not checked$/);
  assert.equal(unreadable.statuses.length, 1, "the plugins and the status file are still done");
});

test("A11-184: a plugin pinned to a commit moves to the newest release tag with `herdr plugin install <repo> --ref <tag> -y`, bun leading PATH, and only the terminal restarts", () => {
  const w = world({ ref: null });
  const { said, failed } = w.run();
  assert.ok(w.calls.includes("plugin install devswha/herdr-web-ui --ref v0.4.13 -y"));
  assert.deepEqual(w.envs, [{ PATH: "/h/.bun/bin:/usr/bin:/bin" }]);
  assert.deepEqual(said, ["moved the herdr plugin devswha/herdr-web-ui from @35bf28fa to v0.4.13", "restarted the terminal service so it runs herdr web ui v0.4.13"]);
  assert.deepEqual(failed, []);
  assert.deepEqual(w.restarts, ["terminal after v0.4.13"]);
  assert.ok(!w.calls.some((call) => /^(update|server|stop|start|restart)/.test(call)), "herdr itself is never upgraded or restarted");
});

test("A11-184: a plugin on an older release tag moves to the newest one", () => {
  const w = world({ ref: "v0.4.12" });
  assert.deepEqual(w.run().said[0], "moved the herdr plugin devswha/herdr-web-ui from v0.4.12 to v0.4.13");
  assert.equal(w.state.ref, "v0.4.13");
});

test("A11-184: a plugin already at the newest tag runs no install and no restart", () => {
  const w = world({ ref: "v0.4.13" });
  assert.deepEqual(w.run(), { said: [], failed: [], newFailures: 0 });
  assert.ok(!w.calls.some((call) => call.startsWith("plugin install")));
  assert.deepEqual(w.restarts, []);
});

test("A11-184: a terminal that is stopped or not registered is not started when the web UI moves", () => {
  for (const terminal of ["stopped", "not-registered"] as const) {
    const w = world({ ref: null, terminal });
    assert.deepEqual(w.run().said, ["moved the herdr plugin devswha/herdr-web-ui from @35bf28fa to v0.4.13"]);
    assert.deepEqual(w.restarts, [], terminal);
  }
});

test("A11-184: a terminal that refuses to restart is a failure with the command to run; the move stands", () => {
  const w = world({ ref: null });
  const deps = { ...w.deps, restartTerminal: () => { throw new Error("systemctl --user restart agent-org-terminal.service failed: no\nmore"); } };
  const { said, failed } = herdrUpkeep(deps);
  assert.deepEqual(said, ["moved the herdr plugin devswha/herdr-web-ui from @35bf28fa to v0.4.13"]);
  assert.deepEqual(failed, ["the herdr web ui moved, but the terminal service did not restart: systemctl --user restart agent-org-terminal.service failed: no. Run `agent-org start terminal`"]);
});

test("A11-184: a remote with only main, a pre-release and `latest` moves nothing and logs the refusal", () => {
  const w = world({ ref: null, remote: "aaa\trefs/tags/v0.5.0-rc1\nbbb\trefs/tags/latest\nccc\trefs/heads/main\n" });
  const { said, failed } = w.run();
  assert.deepEqual(said, []);
  assert.deepEqual(failed, ["devswha/herdr-web-ui has no release tag, and agent-org installs a plugin only at a release tag, never a branch, so the herdr plugin devswha/herdr-web-ui stays at @35bf28fa"]);
  assert.ok(!w.calls.some((call) => call.startsWith("plugin install")));
  assert.deepEqual(w.restarts, []);
});

test("A11-184: a plugin that fails to install stays where it is, and nothing restarts", () => {
  const refused = world({ ref: null, fail: ["plugin install devswha/herdr-web-ui --ref v0.4.13 -y"] });
  const { failed, newFailures } = refused.run();
  assert.deepEqual(failed, ["the herdr plugin devswha/herdr-web-ui is at @35bf28fa and `herdr plugin install devswha/herdr-web-ui --ref v0.4.13 -y` failed (exit 1); herdr said:\nherdr: plugin install devswha/herdr-web-ui --ref v0.4.13 -y refused\nmore"]);
  assert.equal(newFailures, 1);
  assert.deepEqual(refused.restarts, []);
});

test("A11-184: with no bun the plugin is not moved, and the failure says how to get one", () => {
  const w = world({ ref: null, bun: null });
  const { failed } = w.run();
  assert.match(failed[0], /^the herdr plugin devswha\/herdr-web-ui is at @35bf28fa, and v0\.4\.13 is out; it builds with bun, which this machine has none of.*agent-org onboard/);
  assert.ok(!w.calls.some((call) => call.startsWith("plugin install")));
});

test("A11-184: a plugin that is not installed is not installed by upkeep, and a plugin a person installed by hand is never touched", () => {
  const absent = world({ installed: false });
  assert.deepEqual(absent.run(), { said: [], failed: [], newFailures: 0 });
  assert.ok(!absent.calls.some((call) => call.startsWith("plugin install") || call.startsWith("git ls-remote")));
  const byHand = { plugin_id: "someone.else", source: { kind: "github", owner: "someone", repo: "else", resolved_commit: "abc" } };
  const w = world({ ref: "v0.4.13", extraPlugins: [byHand] });
  w.run();
  assert.deepEqual(w.calls.filter((call) => call.includes("someone")), []);
  assert.deepEqual(w.statuses[0].plugins.map((entry) => entry.repo), [REPO]);
});

test("A11-184: it records the newest versions in the status file, and a herdr version that cannot be read is a failure and a recorded reason", () => {
  const w = world({ ref: null });
  w.run();
  assert.deepEqual(w.statuses, [{ checkedAt: "2026-10-24T10:00:00.000Z", herdr: { newest: "0.9.5" }, plugins: [{ repo: REPO, newest: "v0.4.13" }] }]);
  const unread = world({ newest: { why: "https://herdr.dev/latest.json answered 503" } });
  const { failed } = unread.run();
  assert.deepEqual(failed, ["could not read herdr's newest version: https://herdr.dev/latest.json answered 503"]);
  assert.deepEqual(unread.statuses[0].herdr, { why: "https://herdr.dev/latest.json answered 503" });
});

test("A11-184: on a machine where herdr cannot start, upkeep does nothing and says nothing, run after run", () => {
  const w = world({ claude: "outdated (v8 < v10)", ref: null });
  const quiet = herdrUpkeep({ ...w.deps, herdr: () => ({ status: null, stdout: "", stderr: "spawn herdr ENOENT" }) });
  assert.deepEqual(quiet, { said: [], failed: [], newFailures: 0 });
  assert.deepEqual(w.statuses, [], "and no status file is written for it");
});

test("A11-184: upkeep never throws: a herdr that cannot start, or a status file that cannot be written, is a line", () => {
  const w = world({ ref: "v0.4.13" });
  const broken = herdrUpkeep({ ...w.deps, herdr: () => { throw new Error("spawn herdr ENOENT"); } });
  assert.deepEqual(broken, { said: [], failed: ["herdr upkeep stopped: spawn herdr ENOENT"], newFailures: 0 });
  const unwritable = herdrUpkeep({ ...w.deps, writeStatus: () => { throw new Error("EACCES: permission denied"); } });
  assert.deepEqual(unwritable.failed, ["could not write herdr-status.json: EACCES: permission denied"]);
});

test("A11-184: herdr's newest version is read from the file its channel names: stable from latest.json, preview from preview.json", async () => {
  const asked: string[] = [];
  const recordingJson = async (url: string) => { asked.push(url); return { version: "0.9.5", notes: "x" }; };
  const channel = (name: string) => (args: string[]): RunResult => (args.join(" ") === "channel show" ? { status: 0, stdout: `${name}\n`, stderr: "" } : OK);
  assert.deepEqual(await fetchHerdrNewest(channel("stable"), recordingJson), { version: "0.9.5" });
  await fetchHerdrNewest(channel("preview"), recordingJson);
  await fetchHerdrNewest(() => ({ status: 1, stdout: "", stderr: "no" }), recordingJson);
  assert.deepEqual(asked, ["https://herdr.dev/latest.json", "https://herdr.dev/preview.json", "https://herdr.dev/latest.json"]);
  assert.deepEqual(await fetchHerdrNewest(channel("stable"), async () => ({ version: "nightly" })), { why: "https://herdr.dev/latest.json gives no version of the form x.y.z" });
  assert.deepEqual(await fetchHerdrNewest(channel("stable"), async () => { throw new Error("fetch failed"); }), { why: "fetch failed" });
  const noHerdr = await fetchHerdrNewest(() => ({ status: null, stdout: "", stderr: "spawn herdr ENOENT" }), async () => { throw new Error("must not be asked"); });
  assert.deepEqual(noHerdr, { why: "herdr cannot run: spawn herdr ENOENT" }, "no HTTP call for a machine without herdr");
});

test("A11-184: the status file is written whole and read back as absent, unreadable or the status", () => {
  const path = herdrStatusPath({ AGENT_ORG_HOME: tmpDir("herdr-status-") }, "/unused");
  assert.ok(path.endsWith("/herdr-status.json"));
  assert.deepEqual(readHerdrStatus(path), { kind: "absent" });
  const status: HerdrStatus = { checkedAt: "2026-10-24T10:00:00.000Z", herdr: { newest: "0.9.5" }, plugins: [{ repo: REPO, newest: "v0.4.13" }, { repo: "a/b", why: "no release tag" }] };
  writeHerdrStatus(path, status);
  assert.deepEqual(readHerdrStatus(path), { kind: "status", status });
  assert.deepEqual(readHerdrStatus(path, () => "{"), { kind: "unreadable", why: "it is not valid JSON" });
  assert.deepEqual(readHerdrStatus(path, () => "{\"checkedAt\":\"x\",\"herdr\":{},\"plugins\":[]}"), { kind: "unreadable", why: "it is not a herdr status" });
  assert.deepEqual(readHerdrStatus(path, () => { throw new Error("EACCES"); }), { kind: "unreadable", why: "EACCES" });
});

// A11-287: the web UI's manifest id changed at v0.4.16, so an install ADDS an entry; plugins are read by their source repository, a stale copy is removed, and a step that does not take is said once.

/** The status file a run wrote, as the next run reads it. */
const afterRun = (w: ReturnType<typeof world>): HerdrStatusFile => ({ kind: "status", status: w.statuses.at(-1)! });
const installs = (calls: string[]): string[] => calls.filter((call) => call.startsWith("plugin install"));
const NEWER = `${TAGS}\n${"9".repeat(40)}\trefs/tags/v0.4.14`;

test("A11-287: an install that adds the renamed entry is read back at the new tag, the terminal restarts onto it, and then the stale entry is uninstalled", () => {
  const w = world({ ref: "v0.4.12", rename: true });
  const { said, failed, newFailures } = w.run();
  assert.deepEqual(said, [
    "moved the herdr plugin devswha/herdr-web-ui from v0.4.12 to v0.4.13",
    "restarted the terminal service so it runs herdr web ui v0.4.13",
    "removed the stale herdr plugin devswha.herdr-web-ui, which v0.4.13 replaced",
  ]);
  assert.deepEqual([failed, newFailures], [[], 0]);
  assert.deepEqual(w.calls.filter((call) => /^(plugin|terminal)/.test(call)), ["plugin install devswha/herdr-web-ui --ref v0.4.13 -y", "terminal restarted", "plugin uninstall devswha.herdr-web-ui"], "the terminal runs the new copy before the old one goes");
  assert.deepEqual(w.state.plugins.map((plugin) => (plugin as { plugin_id: string }).plugin_id), [NEW_ID]);
  const again = world({ plugins: w.state.plugins, ref: "v0.4.13" });
  assert.deepEqual(again.run(), { said: [], failed: [], newFailures: 0 });
  assert.deepEqual(installs(again.calls), [], "the second run installs nothing and adds no line");
});

test("A11-287: an install that exits 0 and leaves plugins.json unchanged is one failure with herdr's own output; later runs on that tag are quiet, and a newer tag tries once more", () => {
  const first = world({ ref: "v0.4.12", unchanged: true });
  const { said, failed, newFailures } = first.run();
  const command = "herdr plugin install devswha/herdr-web-ui --ref v0.4.13 -y";
  assert.deepEqual(said, []);
  assert.equal(failed.length, 1);
  assert.equal(failed[0], `\`${command}\` ran, but herdr's plugins.json does not list devswha/herdr-web-ui at v0.4.13; herdr said:\nbuilding devswha/herdr-web-ui\nbun install\ninstalled devswha.ovis\nwarning: the manifest id changed`);
  assert.equal(newFailures, 1);
  const failure: PluginFailure = { command, tag: "v0.4.13", output: "building devswha/herdr-web-ui\nbun install\ninstalled devswha.ovis\nwarning: the manifest id changed", at: "2026-10-24T10:00:00.000Z" };
  assert.deepEqual(first.statuses[0].plugins, [{ repo: REPO, newest: "v0.4.13", failed: failure }]);
  const held = world({ ref: "v0.4.12", unchanged: true, last: afterRun(first) });
  assert.deepEqual(held.run(), { said: [], failed: [], newFailures: 0 });
  assert.deepEqual(installs(held.calls), [], "the same tag runs nothing");
  assert.deepEqual(held.statuses[0].plugins, [{ repo: REPO, newest: "v0.4.13", failed: failure }], "and the record stands");
  const newer = world({ ref: "v0.4.12", unchanged: true, last: afterRun(first), remote: NEWER });
  const retried = newer.run();
  assert.deepEqual(installs(newer.calls), ["plugin install devswha/herdr-web-ui --ref v0.4.14 -y"]);
  assert.equal(retried.newFailures, 1);
  assert.equal(newer.statuses[0].plugins[0].failed?.tag, "v0.4.14");
});

test("A11-287: an install that exits non-zero is held the same way, and its line holds herdr's stderr", () => {
  const fail = ["plugin install devswha/herdr-web-ui --ref v0.4.13 -y"];
  const first = world({ ref: "v0.4.12", fail });
  const { failed, newFailures } = first.run();
  assert.match(failed[0], /failed \(exit 1\); herdr said:\nherdr: plugin install devswha\/herdr-web-ui --ref v0\.4\.13 -y refused\nmore$/);
  assert.equal(newFailures, 1);
  const held = world({ ref: "v0.4.12", fail, last: afterRun(first) });
  assert.deepEqual(held.run(), { said: [], failed: [], newFailures: 0 });
  assert.deepEqual(installs(held.calls), []);
});

test("A11-287: a record of a failure is cleared once plugins.json shows the plugin current with no stale copy", () => {
  const stale: PluginFailure = { command: "herdr plugin install devswha/herdr-web-ui --ref v0.4.13 -y", tag: "v0.4.13", output: "it broke", at: "2026-10-24T09:00:00.000Z" };
  const last: HerdrStatusFile = { kind: "status", status: { checkedAt: "2026-10-24T09:00:00.000Z", herdr: { newest: "0.9.5" }, plugins: [{ repo: REPO, newest: "v0.4.13", failed: stale }] } };
  const fixed = world({ ref: "v0.4.13", last });
  assert.deepEqual(fixed.run(), { said: [], failed: [], newFailures: 0 });
  assert.deepEqual(fixed.statuses[0].plugins, [{ repo: REPO, newest: "v0.4.13" }]);
  const unfixed = world({ ref: "v0.4.12", unchanged: true, last });
  unfixed.run();
  assert.deepEqual(unfixed.statuses[0].plugins, [{ repo: REPO, newest: "v0.4.13", failed: stale }], "still behind: the record stands");
});

test("A11-287: a release tag that cannot be read keeps the record of an earlier failure", () => {
  const failed: PluginFailure = { command: "herdr plugin install devswha/herdr-web-ui --ref v0.4.13 -y", tag: "v0.4.13", output: "it broke", at: "2026-10-24T09:00:00.000Z" };
  const last: HerdrStatusFile = { kind: "status", status: { checkedAt: "x", herdr: { newest: "0.9.5" }, plugins: [{ repo: REPO, newest: "v0.4.13", failed }] } };
  const w = world({ ref: "v0.4.12", last, remote: "aaa\trefs/heads/main\n" });
  w.run();
  assert.equal(w.statuses[0].plugins[0].failed, failed);
});

test("A11-287: with both entries already listed and the newest installed, no install runs: the terminal restarts onto the new root, then the stale entry is uninstalled", () => {
  const plugins = [webUi(OLD_ID, "v0.4.12", "a".repeat(40), 1000), webUi(NEW_ID, "v0.4.13", "b".repeat(40), 2000)];
  const w = world({ plugins });
  const { said, failed, newFailures } = w.run();
  assert.deepEqual(installs(w.calls), []);
  assert.deepEqual(said, ["restarted the terminal service so it runs herdr web ui v0.4.13", "removed the stale herdr plugin devswha.herdr-web-ui, which v0.4.13 replaced"]);
  assert.deepEqual([failed, newFailures], [[], 0]);
  assert.deepEqual(w.calls.filter((call) => /^(plugin|terminal)/.test(call)), ["terminal restarted", "plugin uninstall devswha.herdr-web-ui"]);
  assert.deepEqual(w.statuses[0].plugins, [{ repo: REPO, newest: "v0.4.13" }]);
});

test("A11-287: a terminal that will not restart leaves the stale entry installed, and says so without recording a failure", () => {
  const plugins = [webUi(OLD_ID, "v0.4.12", "a".repeat(40), 1000), webUi(NEW_ID, "v0.4.13", "b".repeat(40), 2000)];
  const w = world({ plugins, restartFails: true });
  const { said, failed, newFailures } = w.run();
  assert.deepEqual(w.calls.filter((call) => call.startsWith("plugin uninstall")), []);
  assert.deepEqual(said, []);
  assert.deepEqual(failed, ["the herdr web ui is at v0.4.13, but the terminal service did not restart: the service manager refused the restart. The old copy stays until it does. Run `agent-org start terminal`"]);
  assert.equal(newFailures, 0);
  assert.deepEqual(w.statuses[0].plugins, [{ repo: REPO, newest: "v0.4.13" }]);
});

test("A11-287: a stopped terminal is not started, and the stale entry is still uninstalled", () => {
  const plugins = [webUi(OLD_ID, "v0.4.12", "a".repeat(40), 1000), webUi(NEW_ID, "v0.4.13", "b".repeat(40), 2000)];
  const w = world({ plugins, terminal: "stopped" });
  assert.deepEqual(w.run().said, ["removed the stale herdr plugin devswha.herdr-web-ui, which v0.4.13 replaced"]);
  assert.deepEqual(w.restarts, []);
});

test("A11-287: an uninstall that fails, or exits 0 and leaves the entry, is one failure with herdr's output and is held", () => {
  const plugins = [webUi(OLD_ID, "v0.4.12", "a".repeat(40), 1000), webUi(NEW_ID, "v0.4.13", "b".repeat(40), 2000)];
  const command = "herdr plugin uninstall devswha.herdr-web-ui";
  const refused = world({ plugins, fail: ["plugin uninstall devswha.herdr-web-ui"] });
  const first = refused.run();
  assert.deepEqual(first.failed, ["the herdr plugin devswha/herdr-web-ui is at v0.4.13, but its stale copy devswha.herdr-web-ui stays: `herdr plugin uninstall devswha.herdr-web-ui` failed (exit 1); herdr said:\nherdr: plugin uninstall devswha.herdr-web-ui refused\nmore"]);
  assert.equal(first.newFailures, 1);
  assert.equal(refused.statuses[0].plugins[0].failed?.command, command);
  const held = world({ plugins, fail: ["plugin uninstall devswha.herdr-web-ui"], last: afterRun(refused) });
  assert.deepEqual(held.run(), { said: [], failed: [], newFailures: 0 });
  assert.deepEqual(held.calls.filter((call) => /^(plugin|terminal)/.test(call)), [], "held: no restart and no uninstall");
  const lingering = world({ plugins, lingers: true });
  assert.match(lingering.run().failed[0], /`herdr plugin uninstall devswha\.herdr-web-ui` ran, but herdr's plugins\.json still lists devswha\.herdr-web-ui; herdr said:\nexit 0$/);
});

test("A11-287: a plugin a person installed by hand is not touched when the web UI has stale copies", () => {
  const byHand = { plugin_id: "someone.else", source: { kind: "github", owner: "someone", repo: "else", resolved_commit: "abc" } };
  const plugins = [webUi(OLD_ID, "v0.4.12", "a".repeat(40), 1000), webUi(NEW_ID, "v0.4.13", "b".repeat(40), 2000), byHand];
  const w = world({ plugins });
  w.run();
  assert.deepEqual(w.calls.filter((call) => call.startsWith("plugin uninstall")), ["plugin uninstall devswha.herdr-web-ui"]);
});

test("A11-287: of several copies of a repository the current one has the highest release tag, then the latest install, then the last in the file; an entry with no source matches on its id", () => {
  const ids = (json: object[]) => {
    const found = pluginEntries(JSON.stringify(json), REPO)!;
    return [found.current.pluginId, found.stale.map(({ pluginId }) => pluginId)];
  };
  const entry = (id: string, ref: string | null, at?: number) => webUi(id, ref, "c".repeat(40), at);
  assert.deepEqual(ids([entry("a", "v0.4.16", 1), entry("b", "v0.4.13", 9)]), ["a", ["b"]], "the higher tag wins over the later install");
  assert.deepEqual(ids([entry("a", "v0.4.9", 1), entry("b", "v0.4.10", 1)]), ["b", ["a"]], "numeric, not lexical");
  assert.deepEqual(ids([entry("a", "v0.4.13", 5), entry("b", "v0.4.13", 2), entry("c", "v0.4.13", 3)]), ["a", ["b", "c"]], "a tie goes to the latest install");
  assert.deepEqual(ids([entry("a", "v0.4.13", 2), entry("b", "v0.4.13", 2)]), ["b", ["a"]], "then to the last in the file");
  assert.deepEqual(ids([entry("a", null, 9), entry("b", "v0.4.1", 1)]), ["b", ["a"]], "a release tag beats none");
  assert.deepEqual(ids([entry("a", "main", 2), entry("b", null, 5)]), ["b", ["a"]], "no release tag on either: the latest install");
  assert.deepEqual(ids([{ plugin_id: "devswha.herdr-web-ui", plugin_root: "/r" }]), ["devswha.herdr-web-ui", []], "no source: the id names the repository");
  assert.deepEqual(ids([entry("a", "v0.4.13", 1), { plugin_id: "someone.else", source: { owner: "someone", repo: "else" } }]), ["a", []]);
  assert.equal(pluginEntries(JSON.stringify([{ plugin_id: "someone.else", source: { owner: "someone", repo: "else" } }]), REPO), null);
  assert.equal(installedPlugin(JSON.stringify([entry(OLD_ID, "v0.4.12", 1), entry(NEW_ID, "v0.4.16", 2)]), REPO)?.ref, "v0.4.16");
});

test("A11-287: herdr's output is stdout then stderr, trimmed, the last 20 lines and at most 2,000 characters, and says the exit when it printed nothing", () => {
  assert.equal(herdrOutput({ status: 1, stdout: "out\n", stderr: "err\n" }), "out\nerr");
  const many = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
  assert.equal(herdrOutput({ status: 1, stdout: many, stderr: "" }).split("\n").join(","), Array.from({ length: 20 }, (_, index) => `line ${index + 11}`).join(","));
  const long = herdrOutput({ status: 1, stdout: "x".repeat(5000), stderr: "tail" });
  assert.equal(long.length, 2000);
  assert.ok(long.endsWith("x\ntail"), "the tail is kept");
  assert.equal(herdrOutput({ status: 7, stdout: "", stderr: "" }), "exit 7");
});

test("A11-287: the status file is read with and without a recorded failure, and a failure that is not one makes it unreadable", () => {
  const failed: PluginFailure = { command: "herdr plugin install devswha/herdr-web-ui --ref v0.4.13 -y", tag: "v0.4.13", output: "a\nb", at: "2026-10-24T10:00:00.000Z" };
  const path = herdrStatusPath({ AGENT_ORG_HOME: tmpDir("herdr-status-") }, "/unused");
  const status = (plugin: object) => JSON.stringify({ checkedAt: "x", herdr: { newest: "0.9.5" }, plugins: [plugin] });
  writeHerdrStatus(path, { checkedAt: "2026-10-24T10:00:00.000Z", herdr: { newest: "0.9.5" }, plugins: [{ repo: REPO, newest: "v0.4.13", failed }, { repo: "a/b", why: "no release tag", failed }] });
  const read = readHerdrStatus(path);
  assert.deepEqual(read.kind === "status" ? read.status.plugins : read, [{ repo: REPO, newest: "v0.4.13", failed }, { repo: "a/b", why: "no release tag", failed }]);
  const without = readHerdrStatus(path, () => status({ repo: REPO, newest: "v0.4.13" }));
  assert.deepEqual(without.kind === "status" ? without.status.plugins : without, [{ repo: REPO, newest: "v0.4.13" }]);
  assert.deepEqual(readHerdrStatus(path, () => status({ repo: REPO, newest: "v0.4.13", failed: { command: "x" } })), { kind: "unreadable", why: "it is not a herdr status" });
  assert.deepEqual(readHerdrStatus(path, () => status({ repo: REPO, newest: "v0.4.13", failed: "no" })), { kind: "unreadable", why: "it is not a herdr status" });
});
