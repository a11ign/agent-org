// no-token: none -- `launchctl` and `systemctl` are a recording stand-in, and every unit is written into a temporary HOME
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../commands.ts";
import { createFakeExposure } from "../plugins/fakes/exposure.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { activeForMs, main, reapplyServes, registerService, reloadService, runWithin, ServiceRefusal, servicePath, serviceState, startService, stopService, unitFor, unitProblem, type RunResult, type ServiceDeps } from "./service.ts";
import { TAILSCALE_UNDER_TESTS } from "../plugins/real-seams.ts";
import { TAILSCALE_MISSING } from "../../plugins/tailscale/tailnet.ts";

type Answer = (args: string[]) => RunResult;
const done = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const absent: RunResult = { status: 113, stdout: "", stderr: "Could not find service" };

function deps(platform: NodeJS.Platform, answers: Record<string, Answer> = {}, overrides: Partial<ServiceDeps> = {}) {
  const home = tmpDir("service-");
  const files = new Map<string, string>([[join(home, ".agent-org", "host.json"), "{}"]]);
  const calls: string[] = [];
  const value: ServiceDeps = {
    platform, env: { PATH: "/opt/bin:/usr/bin" }, home, uid: 501, node: "/opt/node/bin/node", toolRoot: "/opt/agent-org", commands: COMMANDS, user: "alice",
    exists: (path) => files.has(path), read: (path) => files.get(path) ?? null, write: (path, text) => { files.set(path, text); },
    run: (file, args) => {
      calls.push([file, ...args].join(" "));
      return (answers[`${file} ${args[0]}`] ?? (() => done()))(args);
    },
    ...overrides,
  };
  return { deps: value, files, calls, home };
}

test("the instance service's systemd unit runs ticket:serve with the host file, from this node", () => {
  const { deps: d, home } = deps("linux");
  const unit = unitFor("instance", d);
  assert.equal(unit.path, join(home, ".config", "systemd", "user", "agent-org-instance.service"));
  assert.match(unit.text, /^ExecStart="\/opt\/node\/bin\/node" "\/opt\/agent-org\/src\/bin\.ts" "ticket:serve" "--no-open"$/m);
  assert.match(unit.text, new RegExp(`^Environment="AGENT_ORG_HOST=${join(home, ".agent-org", "host.json")}"$`, "m"));
  assert.match(unit.text, /^Environment="PATH=\/opt\/bin:\/usr\/bin"$/m);
});

test("the launchd agent carries the same command, and a path is escaped for XML", () => {
  const { deps: d, home } = deps("darwin", {}, { toolRoot: "/opt/a&b" });
  const unit = unitFor("instance", d);
  assert.equal(unit.path, join(home, "Library", "LaunchAgents", "io.github.agent-org.instance.plist"));
  assert.match(unit.text, /<string>\/opt\/a&amp;b\/src\/bin\.ts<\/string>\n {4}<string>ticket:serve<\/string>/);
  assert.equal(unit.log, join(home, ".agent-org", "logs", "instance.log"));
});

test("a service whose command the table lacks is refused by name, and is not registered", () => {
  const commands = { ...COMMANDS } as Record<string, string>;
  delete commands["ticket:ui"];
  const { deps: d } = deps("linux", {}, { commands });
  assert.throws(() => unitFor("ui", d), /runs `agent-org ticket:ui`, which this version of agent-org does not have/);
  assert.equal(serviceState("ui", d), "not-registered");
});

test("start ui writes a unit that runs ticket:ui, and start instance one that runs ticket:serve", async () => {
  const { deps: d, files } = deps("linux");
  const ui = await startService("ui", d);
  assert.equal(ui.id, "agent-org-ui.service");
  assert.match(files.get(ui.path) ?? "", /^ExecStart="\/opt\/node\/bin\/node" "\/opt\/agent-org\/src\/bin\.ts" "ticket:ui" "--no-open"$/m);
  assert.match(files.get((await startService("instance", d)).path) ?? "", /"ticket:serve" "--no-open"$/m);
});

test("start writes the unit and enables and starts it; status reads running; stop disables it", async () => {
  const { deps: d, files, calls } = deps("linux", { "systemctl --user": (args) => done(args[1] === "is-active" ? "active\n" : "") });
  await startService("instance", d);
  assert.ok(files.has(unitFor("instance", d).path));
  assert.deepEqual(calls, ["systemctl --user daemon-reload", "systemctl --user enable agent-org-instance.service", "systemctl --user restart agent-org-instance.service"]);
  assert.equal(serviceState("instance", d), "running");
  calls.length = 0;
  await stopService("instance", d);
  assert.deepEqual(calls, ["systemctl --user disable --now agent-org-instance.service"]);
});

test("on launchd, start boots a loaded agent out before bootstrapping the new plist", async () => {
  // Loaded when start looks, gone when the wait after the bootout looks, running once it is bootstrapped.
  const prints = [done("state = running\n"), absent];
  const { deps: d, calls } = deps("darwin", { "launchctl print": () => prints.shift() ?? done("state = running\n") }, { pause: () => {} });
  await startService("instance", d);
  assert.deepEqual(calls, [
    "launchctl enable gui/501/io.github.agent-org.instance", "launchctl print gui/501/io.github.agent-org.instance",
    "launchctl bootout gui/501/io.github.agent-org.instance", "launchctl print gui/501/io.github.agent-org.instance",
    `launchctl bootstrap gui/501 ${unitFor("instance", d).path}`,
  ]);
  assert.equal(serviceState("instance", d), "running");
});

test("status tells registered-and-stopped from not registered, and exits 3 for both", async () => {
  const { deps: d, files } = deps("darwin", { "launchctl print": () => absent });
  const lines: string[] = [];
  const out = { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
  assert.equal(await main(["status"], d, out), 3);
  files.set(unitFor("instance", d).path, "");
  assert.equal(await main(["status", "instance"], d, out), 3);
  assert.deepEqual(lines, ["instance: not registered (launchd io.github.agent-org.instance)", "instance: stopped (launchd io.github.agent-org.instance)"]);
});

test("start refuses without a host file, and an unknown service or platform, with exit 2", async () => {
  const { deps: d, files, home } = deps("linux");
  files.delete(join(home, ".agent-org", "host.json"));
  const errors: string[] = [];
  const out = { log: () => {}, error: (line: string) => errors.push(line) };
  assert.equal(await main(["start"], d, out), 2);
  assert.equal(await main(["start", "board"], d, out), 2);
  assert.equal(await main(["status"], { ...d, platform: "win32" }, out), 2);
  assert.match(errors[0], /Run `agent-org onboard` first/);
  assert.match(errors[1], /`board` is not a service/);
  assert.match(errors[2], /this machine is win32/);
});

test("a unit escapes $ and % for systemd, and refuses a line break in any value it carries", () => {
  const { deps: d } = deps("linux", {}, { toolRoot: "/opt/a$b%c" });
  assert.match(unitFor("instance", d).text, /^ExecStart="\/opt\/node\/bin\/node" "\/opt\/a\$\$b%%c\/src\/bin\.ts"/m);
  const broken = deps("linux", {}, { env: { AGENT_ORG_HOME: "/x\n[Service]\nExecStartPre=/bin/false" } }).deps;
  assert.throws(() => unitFor("instance", broken), /line break/);
});

test("the service's PATH keeps absolute entries and drops a project's node_modules/.bin", () => {
  assert.equal(servicePath("/p/node_modules/.bin::relative:/opt/bin:/usr/bin"), "/opt/bin:/usr/bin");
  assert.equal(servicePath(undefined), "/usr/local/bin:/usr/bin:/bin");
});

test("the linux unit writes WorkingDirectory unquoted, while ExecStart and Environment keep their quotes", () => {
  const { deps: d } = deps("linux");
  const unit = unitFor("instance", d);
  assert.match(unit.text, /^WorkingDirectory=\/opt\/agent-org$/m);
  assert.match(unit.text, /^ExecStart="\/opt\/node\/bin\/node" /m);
  assert.match(unit.text, /^Environment="PATH=\/opt\/bin:\/usr\/bin"$/m);
});

test("a tool root with a space is written as is, and one with % is written %%, both unquoted", () => {
  const spaced = unitFor("instance", deps("linux", {}, { toolRoot: "/opt/my agent" }).deps);
  assert.match(spaced.text, /^WorkingDirectory=\/opt\/my agent$/m);
  const percent = unitFor("instance", deps("linux", {}, { toolRoot: "/opt/a%b" }).deps);
  assert.match(percent.text, /^WorkingDirectory=\/opt\/a%%b$/m);
});

// systemd-analyze is the reader systemd itself uses: it refuses a quoted WorkingDirectory as "path is not absolute", so a grep for the quotes alone would not prove the unit starts.
const systemdAnalyze = spawnSync("systemd-analyze", ["--version"]);
test("systemd-analyze reads the written unit and reports no WorkingDirectory finding", { skip: systemdAnalyze.error && "systemd-analyze is not on this machine" }, () => {
  const { deps: d } = deps("linux", {}, { toolRoot: "/opt/a b%c" });
  const path = join(tmpDir("unit-"), "agent-org-instance.service");
  writeFileSync(path, unitFor("instance", d).text);
  const verify = spawnSync("systemd-analyze", ["verify", path], { encoding: "utf8" });
  assert.equal(verify.error, undefined);
  assert.doesNotMatch(`${verify.stdout}${verify.stderr}`, /WorkingDirectory/);
});

test("the launchd plist is byte-identical to before the linux unit changed", () => {
  const { deps: d } = deps("darwin", {}, { home: "/home/tester", toolRoot: "/opt/agent-org" });
  assert.equal(unitFor("instance", d).text, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.github.agent-org.instance</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/node/bin/node</string>
    <string>/opt/agent-org/src/bin.ts</string>
    <string>ticket:serve</string>
    <string>--no-open</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_ORG_HOST</key>
    <string>/home/tester/.agent-org/host.json</string>
    <key>AGENT_ORG_HOME</key>
    <string>/home/tester/.agent-org</string>
    <key>PATH</key>
    <string>/opt/bin:/usr/bin</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>/opt/agent-org</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/home/tester/.agent-org/logs/instance.log</string>
  <key>StandardErrorPath</key>
  <string>/home/tester/.agent-org/logs/instance.log</string>
</dict>
</plist>
`);
});

// THE WEB TERMINAL (A11-66): herdr web ui's supervisor under bun, on loopback, attached to the tickets session's own socket.
const ROOT = "/u/.config/herdr/plugins/github/devswha.herdr-web-ui-210f619d6b7b";
function withTerminal(platform: NodeJS.Platform, host: Record<string, unknown> = {}, answers: Record<string, Answer> = {}) {
  const made = deps(platform, answers);
  made.files.set(join(made.home, ".agent-org", "host.json"), JSON.stringify({ clones: { a: "/src/a" }, ...host }));
  made.files.set(join(made.home, ".config", "herdr", "plugins.json"), JSON.stringify([{ plugin_id: "devswha.herdr-web-ui", plugin_root: ROOT }]));
  made.files.set(join(made.home, ".bun", "bin", "bun"), "");
  return made;
}

test("the terminal unit runs the plugin's supervisor with bun, on 127.0.0.1:7318, attached by HERDR_SOCKET to the tickets session", () => {
  const { deps: d, home } = withTerminal("linux");
  const unit = unitFor("terminal", d);
  assert.equal(unit.id, "agent-org-terminal.service");
  assert.match(unit.text, new RegExp(`^ExecStart="${home}/\\.bun/bin/bun" "${ROOT}/server/supervisor\\.ts"$`, "m"));
  assert.match(unit.text, new RegExp(`^WorkingDirectory=${ROOT}$`, "m"));
  for (const line of [
    "PORT=7318", "HOST=127.0.0.1", `HERDR_SOCKET=${home}/.config/herdr/sessions/tickets/herdr.sock`, `HERDR_PLUGIN_ROOT=${ROOT}`,
    `HERDR_PLUGIN_STATE_DIR=${home}/.local/state/herdr-web-ui-tickets`, `HERDR_PLUGIN_CONFIG_DIR=${home}/.config/herdr-web-ui-tickets`, "HERDR_WEB_TELEMETRY=0",
    `PATH=${home}/.bun/bin:/opt/bin:/usr/bin`,
  ]) assert.ok(unit.text.includes(`Environment="${line}"`), `missing ${line}`);
  assert.doesNotMatch(unit.text, /HERDR_SOCKET_PATH/, "the plugin reads HERDR_SOCKET; HERDR_SOCKET_PATH alone attached to herdr's default session");
  assert.doesNotMatch(unit.text, /RestartPreventExitStatus/, "exit 2 is agent-org's refusal, not bun's");
});

test("the terminal serves the host file's herdr session, on the port its tickets.terminal names, and the launchd agent carries the same", () => {
  const host = { tickets: { herdrSession: "work", terminal: "http://127.0.0.1:7400/?ws={workspace}&pane={pane}&view=terminal" } };
  const { deps: d, home } = withTerminal("linux", host);
  const text = unitFor("terminal", d).text;
  assert.ok(text.includes(`Environment="HERDR_SOCKET=${home}/.config/herdr/sessions/work/herdr.sock"`));
  assert.ok(text.includes(`Environment="PORT=7400"`));
  assert.ok(text.includes(`Environment="HERDR_PLUGIN_STATE_DIR=${home}/.local/state/herdr-web-ui-work"`));
  const plist = unitFor("terminal", withTerminal("darwin", host).deps);
  assert.equal(plist.id, "io.github.agent-org.terminal");
  assert.match(plist.text, /<key>HERDR_SOCKET<\/key>\n {4}<string>[^<]*\/sessions\/work\/herdr\.sock<\/string>/);
  assert.match(plist.text, /<key>RunAtLoad<\/key>\n {2}<true\/>/);
});

test("the terminal is refused, naming the fix, without the plugin or without bun, and then reads as not registered", () => {
  const noPlugin = withTerminal("linux");
  noPlugin.files.delete(join(noPlugin.home, ".config", "herdr", "plugins.json"));
  assert.throws(() => unitFor("terminal", noPlugin.deps), /Run `agent-org onboard`, which installs it at its newest release tag/);
  assert.equal(serviceState("terminal", noPlugin.deps), "not-registered");
  const noBun = withTerminal("linux");
  noBun.files.delete(join(noBun.home, ".bun", "bin", "bun"));
  assert.throws(() => unitFor("terminal", noBun.deps), /runs on bun, and this machine has none/);
  const bunOnPath = withTerminal("linux");
  bunOnPath.files.delete(join(bunOnPath.home, ".bun", "bin", "bun"));
  bunOnPath.files.set("/opt/bin/bun", "");
  assert.match(unitFor("terminal", bunOnPath.deps).text, /^ExecStart="\/opt\/bin\/bun" /m);
});

test("start, stop and status take the terminal by name", async () => {
  const { deps: d, calls } = withTerminal("linux", {}, { "systemctl --user": (args) => done(args[1] === "is-active" ? "active\n" : "") });
  const lines: string[] = [];
  const out = { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
  assert.equal(await main(["start", "terminal"], d, out), 0);
  assert.ok(calls.includes("systemctl --user restart agent-org-terminal.service"));
  assert.equal(await main(["status", "terminal"], d, out), 0);
  assert.equal(await main(["stop", "terminal"], d, out), 0);
  assert.ok(calls.includes("systemctl --user disable --now agent-org-terminal.service"));
  assert.match(lines[1], /^terminal: running \(systemd agent-org-terminal\.service\)$/);
});

test("A11-184: reloading the terminal writes its unit from the plugin_root installed now and restarts it: on systemd after a daemon-reload, on launchd by booting the agent out and in", () => {
  const moved = (made: ReturnType<typeof withTerminal>) => made.files.set(join(made.home, ".config", "herdr", "plugins.json"), JSON.stringify([{ plugin_id: "devswha.herdr-web-ui", plugin_root: "/h/plugins/devswha.herdr-web-ui-NEW" }]));
  const linux = withTerminal("linux");
  moved(linux);
  const unit = unitFor("terminal", linux.deps);
  linux.files.set(unit.path, "old");
  reloadService("terminal", linux.deps);
  assert.match(linux.files.get(unit.path) ?? "", /devswha\.herdr-web-ui-NEW/);
  assert.deepEqual(linux.calls, ["systemctl --user daemon-reload", "systemctl --user restart agent-org-terminal.service"]);
  const prints = [done("state = running\n"), absent];
  const mac = withTerminal("darwin", {}, { "launchctl print": () => prints.shift() ?? absent });
  moved(mac);
  const plist = unitFor("terminal", mac.deps);
  reloadService("terminal", { ...mac.deps, pause: () => {} });
  assert.match(mac.files.get(plist.path) ?? "", /devswha\.herdr-web-ui-NEW/);
  assert.deepEqual(mac.calls.map((call) => call.split(" ").slice(0, 2).join(" ")), ["launchctl print", "launchctl bootout", "launchctl print", "launchctl bootstrap"]);
  assert.throws(() => reloadService("terminal", { ...linux.deps, run: () => ({ status: 1, stdout: "", stderr: "Failed to restart" }) }), /systemctl --user daemon-reload failed: Failed to restart/);
});

// AUTO-UPDATE: `agent-org update` every ten minutes (A11-169), so a merged fix reaches the instance without a person.
test("auto-update on systemd is a timer that fires every ten minutes; start writes it and enables the timer", async () => {
  const { deps: d, calls } = deps("linux");
  const unit = await startService("auto-update", d);
  assert.equal(unit.id, "agent-org-auto-update.timer");
  assert.match(unit.text, /^OnCalendar=\*:0\/10$/m);
  assert.match(unit.text, /^RandomizedDelaySec=60$/m);
  assert.deepEqual(calls, ["systemctl --user daemon-reload", "systemctl --user enable agent-org-auto-update.timer", "systemctl --user restart agent-org-auto-update.timer"]);
});

test("auto-update on systemd: the timer names its oneshot service, which runs the update command with the host file", async () => {
  const { deps: d, files, home } = deps("linux");
  const unit = await startService("auto-update", d);
  assert.match(unit.text, /^Unit=agent-org-auto-update\.service$/m);
  assert.match(unit.text, /^WantedBy=timers\.target$/m);
  const service = files.get(join(home, ".config", "systemd", "user", "agent-org-auto-update.service")) ?? "";
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^ExecStart="\/opt\/node\/bin\/node" "\/opt\/agent-org\/src\/bin\.ts" "update"$/m);
  assert.match(service, /^Environment="AGENT_ORG_HOST=/m);
});

test("auto-update follows main when the update-channel file says so, and on launchd runs every ten minutes, not at load", () => {
  const linux = deps("linux");
  linux.files.set(join(linux.home, ".agent-org", "update-channel"), "main\n");
  assert.match(unitFor("auto-update", linux.deps).companion?.text ?? "", /"update" "--channel" "main"$/m);
  const { deps: d, files, home } = deps("darwin", { "launchctl print": () => done("state = not running\n") });
  files.set(join(home, ".agent-org", "update-channel"), "nonsense");
  const plist = unitFor("auto-update", d);
  assert.match(plist.text, /<key>StartInterval<\/key>\n {2}<integer>600<\/integer>\n {2}<key>RunAtLoad<\/key>\n {2}<false\/>/);
  assert.doesNotMatch(plist.text, /KeepAlive|--channel/);
  files.set(plist.path, plist.text);
  assert.equal(serviceState("auto-update", d), "running", "a loaded interval job is between runs, not stopped");
});

// WATCHDOG (A11-363): `agent-org ticket:watchdog` every minute, which restarts the instance when it is stalled.
test("the watchdog on systemd is a timer that fires every minute, on the minute, and not a catch-up; its oneshot service runs ticket:watchdog and is ended by systemd if it hangs", async () => {
  const { deps: d, files, home, calls } = deps("linux");
  const unit = await startService("watchdog", d);
  assert.equal(unit.id, "agent-org-watchdog.timer");
  for (const line of [/^OnCalendar=minutely$/m, /^Persistent=false$/m, /^Unit=agent-org-watchdog\.service$/m]) assert.match(unit.text, line);
  assert.deepEqual(calls, ["systemctl --user daemon-reload", "systemctl --user enable agent-org-watchdog.timer", "systemctl --user restart agent-org-watchdog.timer"]);
  const service = files.get(join(home, ".config", "systemd", "user", "agent-org-watchdog.service")) ?? "";
  const wanted = [/^Type=oneshot$/m, /^TimeoutStartSec=90$/m, /^ExecStart="\/opt\/node\/bin\/node" "\/opt\/agent-org\/src\/bin\.ts" "ticket:watchdog"$/m, /^Environment="AGENT_ORG_HOST=/m];
  for (const line of wanted) assert.match(service, line);
});

test("the watchdog on launchd is an interval job of 60 s that does not run at load, and the auto-update timer is unchanged by it", () => {
  const { deps: d } = deps("darwin");
  assert.match(unitFor("watchdog", d).text, /<key>StartInterval<\/key>\n {2}<integer>60<\/integer>\n {2}<key>RunAtLoad<\/key>\n {2}<false\/>/);
  const linux = deps("linux").deps;
  assert.match(unitFor("auto-update", linux).text, /^OnCalendar=\*:0\/10$/m);
  assert.doesNotMatch(unitFor("auto-update", linux).companion?.text ?? "", /TimeoutStartSec/);
});

test("a version without the watchdog's command refuses the service by name, and registerService writes both units, enables and restarts the timer without any exposure", () => {
  const commands = { ...COMMANDS } as Record<string, string>;
  delete commands["ticket:watchdog"];
  assert.throws(() => unitFor("watchdog", deps("linux", {}, { commands }).deps), /runs `agent-org ticket:watchdog`, which this version of agent-org does not have/);
  const { deps: d, files, calls, home } = deps("linux");
  registerService("watchdog", d);
  assert.ok(files.has(join(home, ".config", "systemd", "user", "agent-org-watchdog.timer")) && files.has(join(home, ".config", "systemd", "user", "agent-org-watchdog.service")));
  assert.deepEqual(calls, ["systemctl --user daemon-reload", "systemctl --user enable agent-org-watchdog.timer", "systemctl --user restart agent-org-watchdog.timer"]);
});

test("activeForMs is how long the instance's unit has been active against the machine's uptime, and null for a unit that is not running", () => {
  const running = deps("linux", { "systemctl --user": (args) => (args[1] === "is-active" ? done("active\n") : done("3000000000\n")) });
  running.files.set(unitFor("instance", running.deps).path, "x");
  assert.equal(activeForMs("instance", running.deps, 3_090_000), 90_000, "active since 3000 s of uptime, now 3090 s: 90 s");
  const stopped = deps("linux", { "systemctl --user": () => done("inactive\n") });
  stopped.files.set(unitFor("instance", stopped.deps).path, "x");
  assert.equal(activeForMs("instance", stopped.deps, 3_090_000), null);
  assert.equal(activeForMs("instance", deps("linux").deps, 3_090_000), null, "not registered");
});

// A11-67: a unit systemd loads as bad-setting is said, with the line it refused, and start is the fix.
test("a unit systemd reads as bad-setting is said with the line systemd-analyze refused, and status names start as the fix", async () => {
  const refused = "/u/.config/systemd/user/agent-org-instance.service:6: WorkingDirectory= path is not absolute, ignoring: \"/home/agent/repos/agent-org\"";
  const { deps: d, files } = deps("linux", {
    "systemctl --user": (args) => done(args[1] === "show" ? "bad-setting\n" : args[1] === "is-active" ? "inactive\n" : ""),
    "systemd-analyze --user": () => ({ status: 1, stdout: "", stderr: `${refused}\nagent-org-instance.service: Unit configuration has fatal error, unit will not be started.\nunrelated line\n` }),
  });
  assert.equal(unitProblem("instance", d), null, "an unregistered unit has no load state to report");
  files.set(unitFor("instance", d).path, "[Service]\nWorkingDirectory=\"/home/agent/repos/agent-org\"\n");
  const problem = unitProblem("instance", d) ?? "";
  assert.match(problem, /^systemd reads agent-org-instance\.service as bad-setting: /);
  assert.ok(problem.includes("WorkingDirectory= path is not absolute"));
  assert.ok(!problem.includes("unrelated line"));
  const lines: string[] = [];
  assert.equal(await main(["status"], d, { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) }), 3);
  assert.match(lines[0], /^instance: stopped \(systemd agent-org-instance\.service\)\. systemd reads .* as bad-setting: .*`agent-org start instance` writes the unit again$/);
});

test("a loaded unit, and any unit under launchd, has no load problem", () => {
  const { deps: d, files } = deps("linux", { "systemctl --user": () => done("loaded\n") });
  files.set(unitFor("instance", d).path, "");
  assert.equal(unitProblem("instance", d), null);
  const mac = deps("darwin");
  mac.files.set(unitFor("instance", mac.deps).path, "");
  assert.equal(unitProblem("instance", mac.deps), null);
});

test("the terminal refuses, naming the host file, one it cannot read or that is not a JSON object, and never falls back to tickets on 7318", async () => {
  for (const [text, reason] of [[null, /cannot be read/], ["{ not json", /is not valid JSON/], ["[1]", /does not hold a JSON object/]] as const) {
    const made = withTerminal("linux");
    const hostFile = join(made.home, ".agent-org", "host.json");
    if (text === null) made.files.delete(hostFile);
    else made.files.set(hostFile, text);
    assert.throws(() => unitFor("terminal", made.deps), (err: Error) => reason.test(err.message) && err.message.includes(hostFile));
    const errors: string[] = [];
    assert.equal(await main(["start", "terminal"], made.deps, { log: () => {}, error: (line: string) => errors.push(line) }), 2);
    assert.ok(!made.files.has(join(made.home, ".config", "systemd", "user", "agent-org-terminal.service")), "no unit is written on the defaults");
    assert.equal(serviceState("terminal", made.deps), "not-registered");
  }
});

// THE EXPOSURE (A11-162; `tickets.serve` is its alias for tailscale): the page and the terminal are served by the Tailscale plugin with `tailscale serve`, never Funnel, and nothing else on the host is named.
const STATUS = JSON.stringify({ BackendState: "Running", Self: { DNSName: "agents.tail1234.ts.net.", TailscaleIPs: ["100.64.0.7"] } });
/** The agents host's serve config: Funnel on :443 for `/webhook`, a plain serve on :8443, and this board's own entry on :9443. */
const AGENTS_HOST = JSON.stringify({
  TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true }, 9443: { HTTPS: true } },
  Web: {
    "agents.tail1234.ts.net:443": { Handlers: { "/webhook": { Proxy: "http://127.0.0.1:8787" } } },
    "agents.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8788" } } },
    "agents.tail1234.ts.net:9443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4748" } } },
  },
  AllowFunnel: { "agents.tail1234.ts.net:443": true },
});

/** A machine on a tailnet: its `tailscale` answers as `answers` says, a host file with `tickets`, and every call made, in order. */
function onTailnet(tickets: Record<string, unknown>, answers: { status?: RunResult; serve?: string; put?: RunResult; remove?: RunResult } = {}) {
  const calls: string[] = [];
  const run = (file: string, args: string[]): RunResult => {
    calls.push([file, ...args].join(" "));
    if (file !== "tailscale") return done();
    if (args[0] === "status") return answers.status ?? done(STATUS);
    if (args[1] === "status") return done(answers.serve ?? "{}");
    if (args.includes("off")) return answers.remove ?? done();
    return answers.put ?? done();
  };
  const made = deps("linux", {}, { run });
  made.files.set(join(made.home, ".agent-org", "host.json"), JSON.stringify({ clones: { a: "/src/a" }, tickets }));
  made.files.set(join(made.home, ".config", "herdr", "plugins.json"), JSON.stringify([{ plugin_id: "devswha.herdr-web-ui", plugin_root: ROOT }]));
  made.files.set(join(made.home, ".bun", "bin", "bun"), "");
  return { ...made, calls, tailscale: () => calls.filter((call) => call.startsWith("tailscale")) };
}

const SERVED = { serve: "tailscale", uiPort: 4748 };

test("start ui with tickets.serve checks the tailnet, starts the unit, then serves its loopback port on the tailnet's 9443", async () => {
  const t = onTailnet(SERVED);
  const started = await startService("ui", t.deps);
  assert.equal(started.address, "https://agents.tail1234.ts.net:9443/");
  assert.deepEqual(t.tailscale(), [
    "tailscale status --json",
    "tailscale serve status --json",
    "tailscale serve --bg --https=9443 http://127.0.0.1:4748",
  ]);
  assert.ok(t.calls.indexOf("systemctl --user restart agent-org-ui.service") < t.calls.indexOf("tailscale serve --bg --https=9443 http://127.0.0.1:4748"), "the serve call comes after the unit starts");
});

test("start terminal serves the port tickets.terminal names on loopback, not the default 7318", async () => {
  const t = onTailnet({ ...SERVED, terminal: "http://127.0.0.1:7400/?ws={workspace}&pane={pane}&view=terminal" });
  const started = await startService("terminal", t.deps);
  assert.equal(started.address, "https://agents.tail1234.ts.net:9444/");
  assert.equal(t.tailscale().at(-1), "tailscale serve --bg --https=9444 http://127.0.0.1:7400");
});

test("with tickets.serve absent, start of ui and terminal touches no tailscale", async () => {
  const plain = onTailnet({});
  assert.equal((await startService("ui", plain.deps)).address, null);
  assert.equal((await startService("terminal", plain.deps)).address, null);
  assert.deepEqual(plain.tailscale(), []);
});

test("with tickets.serve absent, stop touches no tailscale", async () => {
  const plain = onTailnet({});
  plain.files.set(unitFor("ui", plain.deps).path, "");
  await stopService("ui", plain.deps);
  assert.deepEqual(plain.tailscale(), []);
});

test("the instance and auto-update never touch tailscale, even with tickets.serve set", async () => {
  const served = onTailnet(SERVED);
  assert.equal((await startService("instance", served.deps)).address, null);
  assert.equal((await startService("auto-update", served.deps)).address, null);
  served.files.set(unitFor("instance", served.deps).path, "");
  await stopService("instance", served.deps);
  assert.deepEqual(served.tailscale(), []);
});

test("a port that is on Funnel, or that another entry serves, is refused before anything starts, and the fix is named", async () => {
  const funnel = onTailnet(SERVED, { serve: JSON.stringify({ Web: { "agents.tail1234.ts.net:9443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4748" } } } }, AllowFunnel: { "agents.tail1234.ts.net:9443": true } }) });
  await assert.rejects(startService("ui", funnel.deps), (err: unknown) => err instanceof ServiceRefusal
    && /on Funnel, which makes it public/.test(err.message) && /tickets\.providers\.exposure\.tailnetPorts\.ui/.test(err.message));
  assert.ok(!funnel.calls.some((call) => call.includes("--bg") || call.startsWith("systemctl")), "no unit was started and nothing was served");
  const foreign = onTailnet(SERVED, { serve: JSON.stringify({ Web: { "agents.tail1234.ts.net:9443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } } }) });
  await assert.rejects(startService("ui", foreign.deps), /already serves http:\/\/127\.0\.0\.1:9999 on the tailnet/);
  assert.ok(!foreign.calls.some((call) => call.includes("--bg")));
});

test("a missing tailscale, a node that is not Running and a serve call the user may not make each say what to do", async () => {
  const missing = onTailnet(SERVED, { status: { status: null, stdout: "", stderr: "spawnSync tailscale ENOENT" } });
  await assert.rejects(startService("ui", missing.deps), (err: unknown) => err instanceof ServiceRefusal && err.message === TAILSCALE_MISSING);
  const stopped = onTailnet(SERVED, { status: done(JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "agents.tail1234.ts.net." } })) });
  await assert.rejects(startService("ui", stopped.deps), /is not Running on this machine \(BackendState Stopped\): run `sudo tailscale up`/);
  const denied = onTailnet(SERVED, { put: { status: 1, stdout: "", stderr: "Access denied: serve config denied" } });
  await assert.rejects(startService("ui", denied.deps), (err: unknown) => err instanceof ServiceRefusal
    && err.message.startsWith("the ui service started on 127.0.0.1, but the exposure does not reach it:")
    && err.message.includes("run `sudo tailscale set --operator=alice`, then start the service again"));
  assert.ok(denied.calls.includes("systemctl --user restart agent-org-ui.service"), "the unit started before the serve call was refused, and the refusal says so");
});

test("stop ui removes its own entry and no other: the agents host's Funnel on :443 and its :8443 are never named", async () => {
  const t = onTailnet(SERVED, { serve: AGENTS_HOST });
  t.files.set(unitFor("ui", t.deps).path, "");
  await stopService("ui", t.deps);
  assert.deepEqual(t.tailscale(), [
    "tailscale status --json",
    "tailscale serve status --json",
    "tailscale serve status --json",
    "tailscale serve --https=9443 off",
  ]);
  assert.ok(!t.calls.some((call) => /funnel|reset/.test(call)), "no funnel and no reset");
});

test("stop leaves an entry that is not this board's, and says so when its own removal fails after the service stopped", async () => {
  const foreign = onTailnet(SERVED, { serve: JSON.stringify({ Web: { "agents.tail1234.ts.net:9443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } } } }) });
  foreign.files.set(unitFor("ui", foreign.deps).path, "");
  await stopService("ui", foreign.deps);
  assert.ok(!foreign.calls.some((call) => call.includes(" off")), "another's entry is not removed");
  const failing = onTailnet(SERVED, { serve: AGENTS_HOST, remove: { status: 1, stdout: "", stderr: "tailscaled is not running" } });
  failing.files.set(unitFor("ui", failing.deps).path, "");
  await assert.rejects(stopService("ui", failing.deps), (err: unknown) => err instanceof ServiceRefusal
    && err.message === "the ui service is stopped, but its entry on port 9443 was not removed: `tailscale serve --https=9443 off` failed: tailscaled is not running");
  assert.ok(failing.calls.includes("systemctl --user disable --now agent-org-ui.service"), "the service was stopped first");
});

test("a host file the tailnet cannot be checked from refuses before anything starts, and names the file", async () => {
  const hostPath = (t: ReturnType<typeof onTailnet>) => join(t.home, ".agent-org", "host.json");
  const notJson = onTailnet({});
  notJson.files.set(hostPath(notJson), "{ not json");
  await assert.rejects(startService("ui", notJson.deps), (err: unknown) => err instanceof ServiceRefusal && err.message.includes(`${hostPath(notJson)} is not valid JSON, so the exposure cannot be checked`));
  const list = onTailnet({});
  list.files.set(hostPath(list), "[]");
  await assert.rejects(startService("ui", list.deps), /does not hold a JSON object, so the exposure cannot be checked/);
  const badTickets = onTailnet({});
  badTickets.files.set(hostPath(badTickets), JSON.stringify({ tickets: "tailscale" }));
  await assert.rejects(startService("ui", badTickets.deps), /the `tickets` block of .* must be an object, so the exposure cannot be checked/);
  assert.deepEqual([...notJson.calls, ...list.calls, ...badTickets.calls], [], "no unit was written and no tailscale was asked");
  const unreadable = deps("linux", {}, { read: () => null, exists: () => true });
  await assert.rejects(startService("ui", unreadable.deps), /exists but cannot be read, so the exposure cannot be checked/);
});

test("stop refuses, after it has stopped the unit, when the host file cannot be checked", async () => {
  const t = onTailnet({});
  t.files.set(unitFor("ui", t.deps).path, "");
  t.files.set(join(t.home, ".agent-org", "host.json"), "{ not json");
  await assert.rejects(stopService("ui", t.deps), /is not valid JSON, so the exposure cannot be checked/);
  assert.ok(t.calls.includes("systemctl --user disable --now agent-org-ui.service"), "the unit was stopped first");
});

// ---- A11-162: the exposure is a plugin, so a block that names `local` serves nothing, and an injected exposure serves whatever it says

const LOCAL_BLOCK = { providers: { exposure: { provider: "local", uiPort: 4748 } } };

test("A11-162: with the exposure block on local, a start serves nothing and asks tailscale nothing, and a stop removes nothing: the restart after a switch from tailscale", async () => {
  const t = onTailnet(LOCAL_BLOCK, { serve: AGENTS_HOST });
  const addresses = [(await startService("ui", t.deps)).address, (await startService("terminal", t.deps)).address];
  t.files.set(unitFor("ui", t.deps).path, "");
  await stopService("ui", t.deps);
  assert.deepEqual(addresses, [null, null]);
  assert.deepEqual(t.tailscale(), [], "the entries a tailscale exposure served were taken off the tailnet by `agent-org plugin enable local`, not by a restart");
  assert.ok(t.calls.includes("systemctl --user restart agent-org-ui.service"), "and the services did start");
});

test("A11-162: a disabled tailscale block serves nothing either, and keeps its ports for `enable`", async () => {
  const t = onTailnet({ providers: { exposure: { provider: "tailscale", enabled: false, tailnetPorts: { ui: 9500, terminal: 9501 } } } });
  assert.equal((await startService("ui", t.deps)).address, null);
  assert.deepEqual(t.tailscale(), []);
});

test("A11-162: the tailnet ports the block names are the ones served on, and the address says where", async () => {
  const t = onTailnet({ providers: { exposure: { provider: "tailscale", uiPort: 4748, tailnetPorts: { ui: 9500, terminal: 9501 } } } });
  const started = await startService("ui", t.deps);
  assert.equal(started.address, "https://agents.tail1234.ts.net:9500/");
  assert.equal(t.tailscale().at(-1), "tailscale serve --bg --https=9500 http://127.0.0.1:4748");
});

test("A11-162: a tailnetPorts that names two equal ports refuses the start by name, before anything starts", async () => {
  const t = onTailnet({ providers: { exposure: { provider: "tailscale", tailnetPorts: { ui: 9500, terminal: 9500 } } } });
  await assert.rejects(startService("ui", t.deps), (err: unknown) => err instanceof ServiceRefusal && /tickets\.providers\.exposure\.tailnetPorts.*ui and terminal must be different ports, and both are 9500/.test(err.message));
  assert.deepEqual(t.calls, [], "no unit was written and nothing was asked");
});

test("A11-162: an exposure handed in serves the port it names, with the readiness and claim it gives, and the address is its own origin", async () => {
  const exposure = createFakeExposure("board.example.net", { ui: 8443, terminal: 8444 });
  const t = onTailnet({ uiPort: 4748 });
  const served = { ...t.deps, exposure: async () => exposure };
  assert.equal((await startService("ui", served)).address, "https://board.example.net:8443/");
  assert.deepEqual(exposure.calls, ["machineName", "serve 8443"]);
  assert.equal(exposure.entries.get("8443")?.local, 4748);
  t.files.set(unitFor("ui", t.deps).path, "");
  await stopService("ui", served);
  assert.equal(exposure.entries.size, 0, "stop removed the one entry that was this service's");
  const refusing = Object.assign(createFakeExposure("board.example.net"), { readiness: () => "the fake is not ready: run the fake" });
  await assert.rejects(startService("ui", { ...t.deps, exposure: async () => refusing }), (err: unknown) => err instanceof ServiceRefusal && err.message === "the fake is not ready: run the fake");
  assert.deepEqual(refusing.calls, [], "and nothing was claimed or served");
});

test("A11-279: the service's own run refuses `tailscale` under the test runner, so a stand-in first on PATH is never started", () => {
  const dir = tmpDir("run-within-");
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "tailscale"), `#!/bin/sh\necho "$*" >> "${log}"\n`);
  chmodSync(join(dir, "tailscale"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath ?? ""}`;
  try {
    assert.deepEqual(runWithin("tailscale", ["serve", "status", "--json"], 5_000), { status: null, stdout: "", stderr: TAILSCALE_UNDER_TESTS });
  } finally {
    process.env.PATH = previousPath;
  }
  assert.equal(existsSync(log) ? readFileSync(log, "utf8") : "", "", "the stand-in recorded no call");
});

// ---- A11-279: the serves are checked and put back after a start, not only at `agent-org start`

const BOARD_ENTRY = { Handlers: { "/": { Proxy: "http://127.0.0.1:4748" } } };
const TERMINAL_ENTRY = { Handlers: { "/": { Proxy: "http://127.0.0.1:7400" } } };
const serveConfig = (web: Record<string, unknown>) => JSON.stringify({ Web: Object.fromEntries(Object.entries(web).map(([port, entry]) => [`agents.tail1234.ts.net:${port}`, entry])) });
const TERMINAL_TICKETS = { ...SERVED, terminal: "http://127.0.0.1:7400/?ws={workspace}&pane={pane}&view=terminal" };

/** A tailnet machine whose ui and terminal units are registered and `running` as systemd says (`running` false: stopped), and whose serve config is `serve`. */
function registered(serve: string, tickets: Record<string, unknown> = TERMINAL_TICKETS, answers: Parameters<typeof onTailnet>[1] = {}, running = true) {
  const t = onTailnet(tickets, { ...answers, serve });
  for (const name of ["ui", "terminal"] as const) t.files.set(unitFor(name, t.deps).path, "");
  const run = t.deps.run;
  const deps: ServiceDeps = { ...t.deps, run: (file, args) => (file === "systemctl" && args[1] === "is-active" ? done(running ? "active\n" : "inactive\n") : run(file, args)) };
  return { ...t, deps };
}
const serveCalls = (t: ReturnType<typeof onTailnet>) => t.tailscale().filter((call) => call.includes("--bg") || call.includes(" off") || call.includes("reset"));

test("A11-279: after the host restarts with the board's and the terminal's serves gone, both are served again, each to its own loopback port", async () => {
  const t = registered(serveConfig({}));
  const checks = await reapplyServes(t.deps);
  assert.deepEqual(checks, [{ service: "ui", state: "reapplied", port: 9443 }, { service: "terminal", state: "reapplied", port: 9444 }]);
  assert.deepEqual(serveCalls(t), ["tailscale serve --bg --https=9443 http://127.0.0.1:4748", "tailscale serve --bg --https=9444 http://127.0.0.1:7400"]);
});

test("A11-279: a serve that is in place is left as it is, and only the missing one is put back", async () => {
  const both = registered(serveConfig({ 9443: BOARD_ENTRY, 9444: TERMINAL_ENTRY }));
  assert.deepEqual((await reapplyServes(both.deps)).map(({ state }) => state), ["present", "present"]);
  assert.deepEqual(serveCalls(both), [], "nothing is served again");
  const onlyTerminalGone = registered(serveConfig({ 9443: BOARD_ENTRY }));
  assert.deepEqual((await reapplyServes(onlyTerminalGone.deps)).map(({ service, state }) => `${service} ${state}`), ["ui present", "terminal reapplied"]);
  assert.deepEqual(serveCalls(onlyTerminalGone), ["tailscale serve --bg --https=9444 http://127.0.0.1:7400"]);
});

test("A11-279: a port another entry holds, or that is open to the internet, is reported and never replaced or removed", async () => {
  const other = registered(serveConfig({ 9443: { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } }, 9444: TERMINAL_ENTRY }));
  const [ui, terminal] = await reapplyServes(other.deps);
  assert.deepEqual([ui.state, terminal.state], ["foreign", "present"]);
  assert.match(ui.why ?? "", /port 9443 already serves http:\/\/127\.0\.0\.1:9999 on the tailnet/);
  assert.deepEqual(serveCalls(other), []);
  const open = registered(JSON.stringify({ Web: { "agents.tail1234.ts.net:9443": BOARD_ENTRY, "agents.tail1234.ts.net:9444": TERMINAL_ENTRY }, AllowFunnel: { "agents.tail1234.ts.net:9443": true } }));
  const [funnel] = await reapplyServes(open.deps);
  assert.match(funnel.why ?? "", /on Funnel, which makes it public/);
  assert.equal(funnel.state, "foreign");
  assert.deepEqual(serveCalls(open), []);
});

test("A11-279: a service `agent-org stop` stopped keeps its unit file and its serve stays off: it is not served again", async () => {
  const t = registered(serveConfig({}), TERMINAL_TICKETS, {}, false);
  assert.deepEqual(await reapplyServes(t.deps), []);
  assert.deepEqual(t.tailscale(), [], "and tailscale is not asked");
});

test("A11-279: a service that is not registered, and a host whose exposure serves nothing, are not checked", async () => {
  const unregistered = onTailnet(TERMINAL_TICKETS, { serve: serveConfig({}) });
  assert.deepEqual(await reapplyServes(unregistered.deps), []);
  assert.deepEqual(unregistered.tailscale(), [], "and tailscale is not asked");
  const local = registered(serveConfig({}), LOCAL_BLOCK);
  assert.deepEqual(await reapplyServes(local.deps), []);
  assert.deepEqual(local.tailscale(), []);
});

test("A11-279: a tailscale that is not running is a refused check for each service, with the sentence to act on, and nothing is served", async () => {
  const stopped = registered(serveConfig({}), TERMINAL_TICKETS, { status: done(JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "agents.tail1234.ts.net." } })) });
  assert.deepEqual((await reapplyServes(stopped.deps)).map(({ state }) => state), ["refused", "refused"]);
  assert.match((await reapplyServes(stopped.deps))[0].why ?? "", /is not Running on this machine \(BackendState Stopped\)/);
  assert.deepEqual(serveCalls(stopped), []);
});

test("A11-279: a serve tailscale refuses is a refused check that says how to allow it, and a host file that cannot be read refuses the board's serve, and nothing is thrown", async () => {
  const denied = registered(serveConfig({}), TERMINAL_TICKETS, { put: { status: 1, stdout: "", stderr: "Access denied: serve config denied" } });
  const [refusedUi] = await reapplyServes(denied.deps);
  assert.equal(refusedUi.state, "refused");
  assert.match(refusedUi.why ?? "", /tailscale set --operator=alice/);
  const unreadable = registered(serveConfig({}));
  unreadable.files.set(join(unreadable.home, ".agent-org", "host.json"), "{ not json");
  assert.deepEqual((await reapplyServes(unreadable.deps)).map(({ service, state }) => `${service} ${state}`), ["ui refused"], "the terminal's unit cannot even be worked out from it, so it counts as not registered");
});
