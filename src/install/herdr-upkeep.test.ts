// no-token: none -- herdr, `git ls-remote`, herdr.dev and the service manager are stand-ins; the status file is written into a temporary directory
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpDir } from "../lib/tmp-fixture.ts";
import type { RunResult, ServiceState } from "./service.ts";
import {
  describeInstalled, fetchHerdrNewest, herdrBehind, herdrStatusPath, herdrUpkeep, herdrVersionOf, installedPlugin, integrationStates, isBehind, newestPluginTag, newestReleaseTag, readHerdrStatus,
  writeHerdrStatus, type HerdrNewest, type HerdrStatus, type HerdrUpkeepDeps,
} from "./herdr-upkeep.ts";

const REPO = "devswha/herdr-web-ui";
const OK: RunResult = { status: 0, stdout: "", stderr: "" };

/** `git ls-remote --tags` of the web UI, in the order git prints it (lexical, so v0.4.10 sorts before v0.4.9), with the peeled lines an annotated tag adds. */
const TAGS = ["v0.4.9", "v0.4.10", "v0.4.11", "v0.4.12", "v0.4.13"].flatMap((tag, index) => [`${String(index).repeat(40)}\trefs/tags/${tag}`, `${"f".repeat(40)}\trefs/tags/${tag}^{}`]).join("\n");

/** One entry of herdr's `plugins.json` as herdr 0.9.3 writes it: the web UI, asked for at `ref` (null for none) and resolved to `commit`. */
const pluginsJson = (ref: string | null, commit = "35bf28fa1234567890abcdef1234567890abcdef", extra: object[] = []): string => JSON.stringify([
  { plugin_id: "devswha.herdr-web-ui", version: "0.4.12", plugin_root: "/h/.config/herdr/plugins/github/devswha.herdr-web-ui-210f", source: { kind: "github", owner: "devswha", repo: "herdr-web-ui", ...(ref === null ? {} : { requested_ref: ref }), resolved_commit: commit } },
  ...extra,
]);

/** `herdr integration status` as herdr 0.9.3 prints it. */
const statusText = (claude: string, codex: string): string => `pi: not installed (/h/.pi/herdr-agent-state.ts)\nclaude: ${claude} (/h/.claude/hooks/herdr-agent-state.sh)\ncodex: ${codex} (/h/.codex/herdr-agent-state.sh)\n`;

/** herdr and its surroundings as one upkeep run sees them. Every call is recorded; `fail` makes a command fail. */
function world(start: { claude?: string; codex?: string; ref?: string | null; installed?: boolean; remote?: string; terminal?: ServiceState; bun?: string | null; newest?: HerdrNewest; fail?: string[]; unchanged?: boolean; extraPlugins?: object[] } = {}) {
  const state = {
    claude: start.claude ?? "current (v10)", codex: start.codex ?? "current (v8)", ref: start.ref === undefined ? "v0.4.13" : start.ref, installed: start.installed ?? true,
    commit: "35bf28fa1234567890abcdef1234567890abcdef",
  };
  const calls: string[] = [];
  const envs: Record<string, string | undefined>[] = [];
  const restarts: string[] = [];
  const statuses: HerdrStatus[] = [];
  const fail = new Set(start.fail ?? []);
  const deps: HerdrUpkeepDeps = {
    herdr: (args, env) => {
      const line = args.join(" ");
      calls.push(line);
      if (env !== undefined) envs.push(env);
      if (fail.has(line)) return { status: 1, stdout: "", stderr: `herdr: ${line} refused\nmore` };
      if (line === "integration status") return { status: 0, stdout: statusText(state.claude, state.codex), stderr: "" };
      if (args[0] === "integration" && args[1] === "install") {
        // `unchanged`: the install exits 0 and leaves the integration as it was.
        if (start.unchanged !== true) state[args[2] as "claude" | "codex"] = args[2] === "claude" ? "current (v10)" : "current (v8)";
        return OK;
      }
      if (args[0] === "plugin" && args[1] === "install") {
        if (start.unchanged !== true) {
          state.ref = args[args.indexOf("--ref") + 1];
          state.commit = "d5a35b7a44ad864ec75581457bfcaa144b22a9e5";
        }
        return OK;
      }
      return { status: 1, stdout: "", stderr: `unexpected herdr ${line}` };
    },
    pluginsJson: () => (state.installed ? pluginsJson(state.ref, state.commit, start.extraPlugins) : (start.extraPlugins === undefined ? null : JSON.stringify(start.extraPlugins))),
    remoteTags: (repo) => {
      calls.push(`git ls-remote --tags ${repo}`);
      return start.remote ?? TAGS;
    },
    bunDir: () => (start.bun === undefined ? "/h/.bun/bin" : start.bun),
    path: "/usr/bin:/bin",
    terminalState: () => start.terminal ?? "running",
    restartTerminal: () => { restarts.push(`terminal after ${state.ref}`); },
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
  assert.deepEqual(pinned, { ref: null, commit: "35bf28fa1234567890abcdef1234567890abcdef" });
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
  assert.deepEqual(quiet.run(), { said: [], failed: [] }, "a quiet ten-minute run adds no line to the log");
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
  assert.deepEqual(w.run(), { said: [], failed: [] });
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

test("A11-184: a plugin that fails to install stays where it is, and nothing restarts; so does one whose plugins.json does not show the tag afterwards", () => {
  const refused = world({ ref: null, fail: ["plugin install devswha/herdr-web-ui --ref v0.4.13 -y"] });
  assert.deepEqual(refused.run().failed, ["the herdr plugin devswha/herdr-web-ui is at @35bf28fa and `herdr plugin install devswha/herdr-web-ui --ref v0.4.13 -y` failed: herdr: plugin install devswha/herdr-web-ui --ref v0.4.13 -y refused"]);
  assert.deepEqual(refused.restarts, []);
  const unlisted = world({ ref: null, unchanged: true });
  assert.deepEqual(unlisted.run().failed, ["`herdr plugin install devswha/herdr-web-ui --ref v0.4.13 -y` ran, but herdr's plugins.json does not list devswha/herdr-web-ui at v0.4.13"]);
  assert.deepEqual(unlisted.restarts, []);
});

test("A11-184: with no bun the plugin is not moved, and the failure says how to get one", () => {
  const w = world({ ref: null, bun: null });
  const { failed } = w.run();
  assert.match(failed[0], /^the herdr plugin devswha\/herdr-web-ui is at @35bf28fa, and v0\.4\.13 is out; it builds with bun, which this machine has none of.*agent-org onboard/);
  assert.ok(!w.calls.some((call) => call.startsWith("plugin install")));
});

test("A11-184: a plugin that is not installed is not installed by upkeep, and a plugin a person installed by hand is never touched", () => {
  const absent = world({ installed: false });
  assert.deepEqual(absent.run(), { said: [], failed: [] });
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
  assert.deepEqual(quiet, { said: [], failed: [] });
  assert.deepEqual(w.statuses, [], "and no status file is written for it");
});

test("A11-184: upkeep never throws: a herdr that cannot start, or a status file that cannot be written, is a line", () => {
  const w = world({ ref: "v0.4.13" });
  const broken = herdrUpkeep({ ...w.deps, herdr: () => { throw new Error("spawn herdr ENOENT"); } });
  assert.deepEqual(broken, { said: [], failed: ["herdr upkeep stopped: spawn herdr ENOENT"] });
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
