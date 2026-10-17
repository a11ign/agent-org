// no-token: none -- `launchctl` and `systemctl` are a recording stand-in, and every unit is written into a temporary HOME
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../commands.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { main, servicePath, serviceState, startService, stopService, unitFor, unitProblem, type RunResult, type ServiceDeps } from "./service.ts";

type Answer = (args: string[]) => RunResult;
const done = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const absent: RunResult = { status: 113, stdout: "", stderr: "Could not find service" };

function deps(platform: NodeJS.Platform, answers: Record<string, Answer> = {}, overrides: Partial<ServiceDeps> = {}) {
  const home = tmpDir("service-");
  const files = new Map<string, string>([[join(home, ".agent-org", "host.json"), "{}"]]);
  const calls: string[] = [];
  const value: ServiceDeps = {
    platform, env: { PATH: "/opt/bin:/usr/bin" }, home, uid: 501, node: "/opt/node/bin/node", toolRoot: "/opt/agent-org", commands: COMMANDS,
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

test("start ui writes a unit that runs ticket:ui, and start instance one that runs ticket:serve", () => {
  const { deps: d, files } = deps("linux");
  const ui = startService("ui", d);
  assert.equal(ui.id, "agent-org-ui.service");
  assert.match(files.get(ui.path) ?? "", /^ExecStart="\/opt\/node\/bin\/node" "\/opt\/agent-org\/src\/bin\.ts" "ticket:ui" "--no-open"$/m);
  assert.match(files.get(startService("instance", d).path) ?? "", /"ticket:serve" "--no-open"$/m);
});

test("start writes the unit and enables and starts it; status reads running; stop disables it", () => {
  const { deps: d, files, calls } = deps("linux", { "systemctl --user": (args) => done(args[1] === "is-active" ? "active\n" : "") });
  startService("instance", d);
  assert.ok(files.has(unitFor("instance", d).path));
  assert.deepEqual(calls, ["systemctl --user daemon-reload", "systemctl --user enable agent-org-instance.service", "systemctl --user restart agent-org-instance.service"]);
  assert.equal(serviceState("instance", d), "running");
  calls.length = 0;
  stopService("instance", d);
  assert.deepEqual(calls, ["systemctl --user disable --now agent-org-instance.service"]);
});

test("on launchd, start boots a loaded agent out before bootstrapping the new plist", () => {
  const { deps: d, calls } = deps("darwin", { "launchctl print": () => done("state = running\n") });
  startService("instance", d);
  assert.deepEqual(calls, [
    "launchctl enable gui/501/io.github.agent-org.instance", "launchctl print gui/501/io.github.agent-org.instance",
    "launchctl bootout gui/501/io.github.agent-org.instance", `launchctl bootstrap gui/501 ${unitFor("instance", d).path}`,
  ]);
  assert.equal(serviceState("instance", d), "running");
});

test("status tells registered-and-stopped from not registered, and exits 3 for both", () => {
  const { deps: d, files } = deps("darwin", { "launchctl print": () => absent });
  const lines: string[] = [];
  const out = { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
  assert.equal(main(["status"], d, out), 3);
  files.set(unitFor("instance", d).path, "");
  assert.equal(main(["status", "instance"], d, out), 3);
  assert.deepEqual(lines, ["instance: not registered (launchd io.github.agent-org.instance)", "instance: stopped (launchd io.github.agent-org.instance)"]);
});

test("start refuses without a host file, and an unknown service or platform, with exit 2", () => {
  const { deps: d, files, home } = deps("linux");
  files.delete(join(home, ".agent-org", "host.json"));
  const errors: string[] = [];
  const out = { log: () => {}, error: (line: string) => errors.push(line) };
  assert.equal(main(["start"], d, out), 2);
  assert.equal(main(["start", "board"], d, out), 2);
  assert.equal(main(["status"], { ...d, platform: "win32" }, out), 2);
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
  assert.throws(() => unitFor("terminal", noPlugin.deps), /herdr plugin install devswha\/herdr-web-ui --yes/);
  assert.equal(serviceState("terminal", noPlugin.deps), "not-registered");
  const noBun = withTerminal("linux");
  noBun.files.delete(join(noBun.home, ".bun", "bin", "bun"));
  assert.throws(() => unitFor("terminal", noBun.deps), /runs on bun, and this machine has none/);
  const bunOnPath = withTerminal("linux");
  bunOnPath.files.delete(join(bunOnPath.home, ".bun", "bin", "bun"));
  bunOnPath.files.set("/opt/bin/bun", "");
  assert.match(unitFor("terminal", bunOnPath.deps).text, /^ExecStart="\/opt\/bin\/bun" /m);
});

test("start, stop and status take the terminal by name", () => {
  const { deps: d, calls } = withTerminal("linux", {}, { "systemctl --user": (args) => done(args[1] === "is-active" ? "active\n" : "") });
  const lines: string[] = [];
  const out = { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
  assert.equal(main(["start", "terminal"], d, out), 0);
  assert.ok(calls.includes("systemctl --user restart agent-org-terminal.service"));
  assert.equal(main(["status", "terminal"], d, out), 0);
  assert.equal(main(["stop", "terminal"], d, out), 0);
  assert.ok(calls.includes("systemctl --user disable --now agent-org-terminal.service"));
  assert.match(lines[1], /^terminal: running \(systemd agent-org-terminal\.service\)$/);
});

// AUTO-UPDATE: `agent-org update` every hour, so a merged fix reaches the instance without a person.
test("auto-update on systemd is a timer and the oneshot service it starts; start writes both and enables the timer", () => {
  const { deps: d, files, calls, home } = deps("linux");
  const unit = startService("auto-update", d);
  assert.equal(unit.id, "agent-org-auto-update.timer");
  assert.match(unit.text, /^OnCalendar=\*-\*-\* \*:00:00$/m);
  assert.match(unit.text, /^Unit=agent-org-auto-update\.service$/m);
  assert.match(unit.text, /^WantedBy=timers\.target$/m);
  const service = files.get(join(home, ".config", "systemd", "user", "agent-org-auto-update.service")) ?? "";
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^ExecStart="\/opt\/node\/bin\/node" "\/opt\/agent-org\/src\/bin\.ts" "update"$/m);
  assert.match(service, /^Environment="AGENT_ORG_HOST=/m);
  assert.deepEqual(calls, ["systemctl --user daemon-reload", "systemctl --user enable agent-org-auto-update.timer", "systemctl --user restart agent-org-auto-update.timer"]);
});

test("auto-update follows main when the update-channel file says so, and on launchd runs every hour, not at load", () => {
  const linux = deps("linux");
  linux.files.set(join(linux.home, ".agent-org", "update-channel"), "main\n");
  assert.match(unitFor("auto-update", linux.deps).companion?.text ?? "", /"update" "--channel" "main"$/m);
  const { deps: d, files, home } = deps("darwin", { "launchctl print": () => done("state = not running\n") });
  files.set(join(home, ".agent-org", "update-channel"), "nonsense");
  const plist = unitFor("auto-update", d);
  assert.match(plist.text, /<key>StartInterval<\/key>\n {2}<integer>3600<\/integer>\n {2}<key>RunAtLoad<\/key>\n {2}<false\/>/);
  assert.doesNotMatch(plist.text, /KeepAlive|--channel/);
  files.set(plist.path, plist.text);
  assert.equal(serviceState("auto-update", d), "running", "a loaded interval job is between runs, not stopped");
});

// A11-67: a unit systemd loads as bad-setting is said, with the line it refused, and start is the fix.
test("a unit systemd reads as bad-setting is said with the line systemd-analyze refused, and status names start as the fix", () => {
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
  assert.equal(main(["status"], d, { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) }), 3);
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

test("the terminal refuses, naming the host file, one it cannot read or that is not a JSON object, and never falls back to tickets on 7318", () => {
  for (const [text, reason] of [[null, /cannot be read/], ["{ not json", /is not valid JSON/], ["[1]", /does not hold a JSON object/]] as const) {
    const made = withTerminal("linux");
    const hostFile = join(made.home, ".agent-org", "host.json");
    if (text === null) made.files.delete(hostFile);
    else made.files.set(hostFile, text);
    assert.throws(() => unitFor("terminal", made.deps), (err: Error) => reason.test(err.message) && err.message.includes(hostFile));
    const errors: string[] = [];
    assert.equal(main(["start", "terminal"], made.deps, { log: () => {}, error: (line: string) => errors.push(line) }), 2);
    assert.ok(!made.files.has(join(made.home, ".config", "systemd", "user", "agent-org-terminal.service")), "no unit is written on the defaults");
    assert.equal(serviceState("terminal", made.deps), "not-registered");
  }
});
