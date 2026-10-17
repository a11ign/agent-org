// no-token: none -- `launchctl` and `systemctl` are a recording stand-in, and every unit is written into a temporary HOME
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../commands.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { main, servicePath, serviceState, startService, stopService, unitFor, type RunResult, type ServiceDeps } from "./service.ts";

type Answer = (args: string[]) => RunResult;
const done = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const absent: RunResult = { status: 113, stdout: "", stderr: "Could not find service" };

function deps(platform: NodeJS.Platform, answers: Record<string, Answer> = {}, overrides: Partial<ServiceDeps> = {}) {
  const home = tmpDir("service-");
  const files = new Map<string, string>([[join(home, ".agent-org", "host.json"), "{}"]]);
  const calls: string[] = [];
  const value: ServiceDeps = {
    platform, env: { PATH: "/opt/bin:/usr/bin" }, home, uid: 501, node: "/opt/node/bin/node", toolRoot: "/opt/agent-org", commands: COMMANDS,
    exists: (path) => files.has(path), write: (path, text) => { files.set(path, text); },
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
