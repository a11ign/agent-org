#!/usr/bin/env node
// @ts-check
// command: start, stop and status -- run an agent-org service (`instance` or `ui`) as a launchd user agent on macOS or a systemd user unit on Linux
//
// A SERVICE IS A NAME AND THE COMMAND IT RUNS, and the command is looked up in `commands.ts`'s table. `instance` runs `ticket:serve` today. When the
// board is split into an instance service and a UI service, that change edits `SERVICE_COMMANDS` and the table, and nothing here. A service whose
// command the table does not hold is refused by name, so `start ui` on a version without the split says so and starts nothing.
//
// WHY NOT `host-units.ts`: its templates are rendered from a project's declaration (a unit prefix, the project's checkout, the org's `gh` routing), and
// `host:install` installs every template it ships. A person running ticket mode on a laptop has no project, and an org host must not start a board
// because a template appeared. So the unit is written here, from the host file's path, the tool's checkout and this process's `node` and `PATH`.
//
// NO SECRET IS IN A UNIT. The unit names the host file, and the board reads the tracker key from where the host file says.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { COMMANDS } from "../commands.ts";
import { agentOrgHome, hostFilePath, TOOL_ROOT, type Env } from "./paths.ts";

/** Service name -> the `agent-org` command it runs, and the arguments after it. */
export const SERVICE_COMMANDS = Object.freeze({
  instance: Object.freeze({ command: "ticket:serve", args: Object.freeze(["--no-open"]) }),
  ui: Object.freeze({ command: "ui:serve", args: Object.freeze([] as string[]) }),
});

export type ServiceName = keyof typeof SERVICE_COMMANDS;
export const SERVICE_NAMES = Object.keys(SERVICE_COMMANDS) as ServiceName[];
export type ServiceState = "not-registered" | "stopped" | "running";

/** What a call to `launchctl` or `systemctl` returned. */
export type RunResult = { status: number | null; stdout: string; stderr: string };
export type Run = (file: string, args: string[]) => RunResult;

export type ServiceDeps = Readonly<{
  platform: NodeJS.Platform;
  env: Env;
  home: string;
  uid: number;
  /** The `node` the unit runs the tool with: this process's, so the service runs on the version that registered it. */
  node: string;
  toolRoot: string;
  run: Run;
  exists: (path: string) => boolean;
  write: (path: string, text: string) => void;
  commands: Readonly<Record<string, string>>;
}>;

export class ServiceRefusal extends Error {}

const defaultRun: Run = (file, args) => {
  const result = spawnSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) return { status: null, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/** Write through a temporary file and a rename, so a unit is never read half written. */
function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o644 });
  renameSync(temporary, path);
}

export function defaultServiceDeps(): ServiceDeps {
  return Object.freeze({
    platform: process.platform, env: process.env, home: homedir(), uid: userInfo().uid, node: process.execPath, toolRoot: TOOL_ROOT,
    run: defaultRun, exists: existsSync, write: writeAtomic, commands: COMMANDS,
  });
}

/** The service name a command line gives, `instance` when it gives none. REFUSES any other word. */
export function serviceName(word: string | undefined): ServiceName {
  if (word === undefined) return "instance";
  if (Object.hasOwn(SERVICE_COMMANDS, word)) return word as ServiceName;
  throw new ServiceRefusal(`\`${word}\` is not a service. Services: ${SERVICE_NAMES.join(", ")}`);
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A systemd value in double quotes: `%` is a specifier, and `\` and `"` are the quoting's own. */
const systemdQuoted = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%")}"`;

export type Unit = { manager: "launchd" | "systemd"; id: string; path: string; text: string; log: string | null };

/** The unit file that runs `name`. PURE over `deps`. REFUSES a platform with neither launchd nor systemd, and a service the command table lacks. */
export function unitFor(name: ServiceName, deps: ServiceDeps): Unit {
  const { command, args } = SERVICE_COMMANDS[name];
  if (!Object.hasOwn(deps.commands, command)) {
    throw new ServiceRefusal(`the ${name} service runs \`agent-org ${command}\`, which this version of agent-org does not have. Run \`agent-org update\` for a version that does.`);
  }
  if (/[\n\r]/.test([deps.node, deps.toolRoot, hostFilePath(deps.env, deps.home), deps.env.PATH ?? ""].join(""))) {
    throw new ServiceRefusal("a path holds a line break, which no unit file can carry");
  }
  const argv = [deps.node, join(deps.toolRoot, "src", "bin.ts"), command, ...args];
  const environment: Record<string, string> = {
    AGENT_ORG_HOST: hostFilePath(deps.env, deps.home),
    AGENT_ORG_HOME: agentOrgHome(deps.env, deps.home),
    // `herdr`, `claude`, `gh` and `git` are found on the PATH of the person who started it: a service gets no login shell's.
    PATH: deps.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };
  if (deps.platform === "darwin") {
    const id = `io.github.agent-org.${name}`;
    const log = join(agentOrgHome(deps.env, deps.home), "logs", `${name}.log`);
    const strings = (values: string[]) => values.map((value) => `    <string>${escapeXml(value)}</string>`).join("\n");
    const env = Object.entries(environment).map(([key, value]) => `    <key>${key}</key>\n    <string>${escapeXml(value)}</string>`).join("\n");
    const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${id}</string>
  <key>ProgramArguments</key>
  <array>
${strings(argv)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>WorkingDirectory</key>
  <string>${escapeXml(deps.toolRoot)}</string>
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
  <string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(log)}</string>
</dict>
</plist>
`;
    return { manager: "launchd", id, path: join(deps.home, "Library", "LaunchAgents", `${id}.plist`), text, log };
  }
  if (deps.platform === "linux") {
    const id = `agent-org-${name}.service`;
    const text = `[Unit]
Description=agent-org ${name} service (agent-org ${command})
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdQuoted(deps.toolRoot)}
ExecStart=${argv.map(systemdQuoted).join(" ")}
${Object.entries(environment).map(([key, value]) => `Environment=${systemdQuoted(`${key}=${value}`)}`).join("\n")}
# Exit 2 is a refusal (a host file that does not parse, a port in use), which a restart does not mend.
Restart=on-failure
RestartSec=10
RestartPreventExitStatus=2

[Install]
WantedBy=default.target
`;
    return { manager: "systemd", id, path: join(deps.home, ".config", "systemd", "user", id), text, log: null };
  }
  throw new ServiceRefusal(`agent-org runs its services under launchd (macOS) or systemd (Linux), and this machine is ${deps.platform}`);
}

/** The unit's place in the manager's namespace: `gui/<uid>/<label>` for launchd. */
const launchdTarget = (unit: Unit, deps: ServiceDeps) => `gui/${deps.uid}/${unit.id}`;

function must(result: RunResult, what: string) {
  if (result.status !== 0) throw new ServiceRefusal(`${what} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`);
}

/** Whether `name` is registered, and if so whether it runs. A service this version or this platform cannot run is not registered. */
export function serviceState(name: ServiceName, deps: ServiceDeps): ServiceState {
  let unit: Unit;
  try {
    unit = unitFor(name, deps);
  } catch (err) {
    if (err instanceof ServiceRefusal) return "not-registered";
    throw err;
  }
  if (!deps.exists(unit.path)) return "not-registered";
  if (unit.manager === "launchd") {
    const printed = deps.run("launchctl", ["print", launchdTarget(unit, deps)]);
    return printed.status === 0 && /^\s*state = running\s*$/m.test(printed.stdout) ? "running" : "stopped";
  }
  return deps.run("systemctl", ["--user", "is-active", unit.id]).stdout.trim() === "active" ? "running" : "stopped";
}

/** Write the unit, register it to start at login, and start it. Starting a service that runs already leaves it running. */
export function startService(name: ServiceName, deps: ServiceDeps): Unit {
  const unit = unitFor(name, deps);
  const hostFile = hostFilePath(deps.env, deps.home);
  if (!deps.exists(hostFile)) throw new ServiceRefusal(`there is no host file at ${hostFile}. Run \`agent-org onboard\` first.`);
  deps.write(unit.path, unit.text);
  if (unit.manager === "launchd") {
    mkdirSync(dirname(unit.log as string), { recursive: true });
    const target = launchdTarget(unit, deps);
    must(deps.run("launchctl", ["enable", target]), `launchctl enable ${target}`);
    // A loaded agent keeps the plist it was loaded with, so it is booted out and in again to read the one just written.
    if (deps.run("launchctl", ["print", target]).status === 0) deps.run("launchctl", ["bootout", target]);
    must(deps.run("launchctl", ["bootstrap", `gui/${deps.uid}`, unit.path]), `launchctl bootstrap ${unit.path}`);
  } else {
    must(deps.run("systemctl", ["--user", "daemon-reload"]), "systemctl --user daemon-reload");
    must(deps.run("systemctl", ["--user", "enable", unit.id]), `systemctl --user enable ${unit.id}`);
    must(deps.run("systemctl", ["--user", "restart", unit.id]), `systemctl --user restart ${unit.id}`);
  }
  return unit;
}

/** Stop the service and keep it from starting at login. The unit file stays, so `start` and `doctor` still find it. */
export function stopService(name: ServiceName, deps: ServiceDeps): void {
  const unit = unitFor(name, deps);
  if (!deps.exists(unit.path)) throw new ServiceRefusal(`the ${name} service is not registered. \`agent-org start ${name}\` registers and starts it.`);
  if (unit.manager === "launchd") {
    const target = launchdTarget(unit, deps);
    if (deps.run("launchctl", ["print", target]).status === 0) must(deps.run("launchctl", ["bootout", target]), `launchctl bootout ${target}`);
    must(deps.run("launchctl", ["disable", target]), `launchctl disable ${target}`);
  } else {
    must(deps.run("systemctl", ["--user", "disable", "--now", unit.id]), `systemctl --user disable --now ${unit.id}`);
  }
}

/** Restart a registered service, so it loads the tool's checkout again. */
export function restartService(name: ServiceName, deps: ServiceDeps): void {
  const unit = unitFor(name, deps);
  if (unit.manager === "launchd") must(deps.run("launchctl", ["kickstart", "-k", launchdTarget(unit, deps)]), `launchctl kickstart -k ${unit.id}`);
  else must(deps.run("systemctl", ["--user", "restart", unit.id]), `systemctl --user restart ${unit.id}`);
}

const STATE_WORDS: Readonly<Record<ServiceState, string>> = { "not-registered": "not registered", stopped: "stopped", running: "running" };
/** `status`'s exit code when the service does not run, as an init script's `status` answers. */
const NOT_RUNNING = 3;
const REFUSED = 2;

/** `agent-org start|stop|status [instance|ui]`. @returns the exit code */
export function main(argv: string[], deps: ServiceDeps = defaultServiceDeps(), out: Pick<Console, "log" | "error"> = console): number {
  try {
    const { positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true });
    const [action, word, ...extra] = positionals;
    if (extra.length > 0) throw new ServiceRefusal(`one service at a time, and \`${extra.join(" ")}\` is extra`);
    const name = serviceName(word);
    if (action === "start") {
      const unit = startService(name, deps);
      out.log(`started the ${name} service (${unit.manager} ${unit.id})${unit.log ? `, logging to ${unit.log}` : `, logging to \`journalctl --user -u ${unit.id}\``}`);
      return 0;
    }
    if (action === "stop") {
      stopService(name, deps);
      out.log(`stopped the ${name} service; it will not start at login until \`agent-org start ${name}\``);
      return 0;
    }
    if (action === "status") {
      const state = serviceState(name, deps);
      const unit = unitFor(name, deps);
      out.log(`${name}: ${STATE_WORDS[state]} (${unit.manager} ${unit.id})`);
      return state === "running" ? 0 : NOT_RUNNING;
    }
    throw new ServiceRefusal(`\`${action ?? ""}\` is not start, stop or status`);
  } catch (err) {
    out.error(`agent-org: ${(err as Error).message}`);
    return REFUSED;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) process.exitCode = main(process.argv.slice(2));
