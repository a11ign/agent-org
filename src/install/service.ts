#!/usr/bin/env node
// @ts-check
// command: start, stop and status -- run an agent-org service (`instance`, `ui`, `terminal` or `auto-update`) as a launchd user agent on macOS or a systemd user unit on Linux
//
// A SERVICE IS A NAME AND THE PROGRAM IT RUNS. `instance` runs `ticket:serve` (the queue and the workers) and `ui` runs `ticket:ui` (the page), each
// looked up in `commands.ts`'s table: a service whose command the table does not hold is refused by name, so a checkout older than the split says so
// and starts nothing. `terminal` runs herdr web ui against ticket mode's herdr session (`terminal.ts`), so the board can link each run to its live
// worker (A11-66). `auto-update` runs `agent-org update` every hour: on a ticket-mode machine nothing else moves this checkout (the org's gate used
// to), so a merged fix never reached the running instance. Update restarts a service only when the checkout moved, so an hour
// with nothing new restarts nothing. `agent-org stop auto-update` is the opt-out, and the channel it follows is `<home>/update-channel`
// (`release`, or `main`), which onboard writes.
//
// A UNIT SYSTEMD REFUSES IS SAID, WITH WHY (A11-67). A unit with a setting systemd cannot read loads as `bad-setting` and never starts, and
// `systemctl is-active` says only `inactive`. `unitProblem` asks systemd for the load state and, for a bad one, asks `systemd-analyze verify` for
// the line it refused, so `status` and `doctor` print the reason, and the fix is `agent-org start`, which writes the unit again.
//
// WHY NOT `host-units.ts`: its templates are rendered from a project's declaration (a unit prefix, the project's checkout, the org's `gh` routing), and
// `host:install` installs every template it ships. A person running ticket mode on a laptop has no project, and an org host must not start a board
// because a template appeared. So the unit is written here, from the host file's path, the tool's checkout and this process's `node` and `PATH`.
//
// NO SECRET IS IN A UNIT. The unit names the host file, and the board reads the tracker key from where the host file says.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { COMMANDS } from "../commands.ts";
import { agentOrgHome, hostFilePath, hostGhConfigDir, readOrNull, TOOL_ROOT, type Env } from "./paths.ts";
import { findBun } from "./bun.ts";
import { herdrConfigDir, pluginRoot, TERMINAL_PLUGIN, terminalProgram, terminalTarget } from "./terminal.ts";
import { serveOf, TicketSettingsRefusal, uiPortOf, type ServePorts } from "../ticket-mode/settings.ts";
import { noName, notRunning, parseServeStatus, parseStatus, portState, refused, removeArgv, serveArgv, serveStatusArgv, statusArgv, TAILSCALE_MISSING } from "../ticket-mode/tailnet.ts";
import { writeAtomic } from "./write-atomic.ts";

/** Service name -> the `agent-org` command it runs, and the arguments after it. */
export const SERVICE_COMMANDS = Object.freeze({
  instance: Object.freeze({ command: "ticket:serve", args: Object.freeze(["--no-open"]) }),
  ui: Object.freeze({ command: "ticket:ui", args: Object.freeze(["--no-open"]) }),
});

export const SERVICE_NAMES = Object.freeze(["instance", "ui", "terminal", "auto-update"] as const);
export type ServiceName = (typeof SERVICE_NAMES)[number];
/** The services that run this checkout's code, which `update` restarts once the checkout has moved. The terminal runs the plugin's, and the updater is the one moving it. */
export const TOOL_SERVICES: readonly ServiceName[] = Object.freeze(["instance", "ui"]);
/** How often `auto-update` runs `agent-org update`. */
export const UPDATE_INTERVAL_SECONDS = 3600;
export type UpdateChannel = "release" | "main";
/** The file that names the channel `auto-update` follows; absent or anything else is `release`. */
export const updateChannelPath = (env: Env, home: string) => join(agentOrgHome(env, home), "update-channel");
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
  /** A file's text, or null when it cannot be read: the host file, herdr's plugin list and the update channel are read through it. */
  read: (path: string) => string | null;
  write: (path: string, text: string) => void;
  commands: Readonly<Record<string, string>>;
  /** The person who started the service, whose `tailscale` the serve step needs as the operator. */
  user: string;
}>;

export class ServiceRefusal extends Error {}

/** A served service that started on loopback, and whose tailnet entry was then refused: it runs, and is not on the tailnet. */
export class TailnetRefusal extends ServiceRefusal {}

/** A service the tailnet serves: `ui` or `terminal`, its tailnet HTTPS port, and the loopback port it listens on and `tailscale serve` proxies to. */
type Served = Readonly<{ name: "ui" | "terminal"; port: number; local: number }>;

/** What `startService` returns: the unit, and the tailnet address it is served at, or null when it is served on loopback only. */
export type Started = Unit & Readonly<{ address: string | null }>;

const defaultRun: Run = (file, args) => {
  const result = spawnSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) return { status: null, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

export function defaultServiceDeps(): ServiceDeps {
  return Object.freeze({
    platform: process.platform, env: process.env, home: homedir(), uid: userInfo().uid, node: process.execPath, toolRoot: TOOL_ROOT,
    run: defaultRun, exists: existsSync, read: readOrNull, write: (path, text) => writeAtomic(path, text, 0o644), commands: COMMANDS,
    user: userInfo().username,
  });
}

/** The service name a command line gives, `instance` when it gives none. REFUSES any other word. */
export function serviceName(word: string | undefined): ServiceName {
  if (word === undefined) return "instance";
  if ((SERVICE_NAMES as readonly string[]).includes(word)) return word as ServiceName;
  throw new ServiceRefusal(`\`${word}\` is not a service. Services: ${SERVICE_NAMES.join(", ")}`);
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** A systemd value in double quotes: `%` is a specifier, `$` a variable, and `\` and `"` are the quoting's own. */
const systemdQuoted = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
/** A systemd path with no quotes, as `WorkingDirectory=` takes it: systemd reads a quote as part of the path and refuses the unit. Only `%` is a specifier there. */
const systemdPath = (text: string) => text.replace(/%/g, "%%");

/**
 * The PATH a service runs with: the caller's, without a relative or empty entry and without a project's `node_modules/.bin`, which `pnpm run` and `pnpm exec`
 * put first and which would then answer for `git`, `gh` and `claude` in every run.
 */
export const servicePath = (path: string | undefined) =>
  (path ?? "").split(":").filter((dir) => dir.startsWith("/") && !/\/node_modules\/\.bin\/?$/.test(dir)).join(":") || "/usr/local/bin:/usr/bin:/bin";

/** A second file a unit needs: the oneshot service a systemd timer starts. */
export type Companion = { path: string; text: string };
export type Unit = { manager: "launchd" | "systemd"; id: string; path: string; text: string; log: string | null; companion: Companion | null; interval: boolean };

/** What a service runs, before it is written for a service manager. */
type Program = Readonly<{
  description: string;
  argv: string[];
  environment: Record<string, string>;
  workingDirectory: string;
  /** Runs `agent-org`, whose exit 2 is a refusal a restart does not mend. */
  tool: boolean;
  /** Run every this many seconds, or null to run all the time. */
  everySeconds: number | null;
}>;

/** What a unit file is written from: the program, and the log file its output is appended to. */
type UnitSource = Program & { log: string };

/**
 * The host file's JSON, which names the terminal's session and port. REFUSES, naming the file, one that cannot be read or is not a JSON object:
 * a terminal started on the defaults would serve another herdr session and port than the host file means, and say nothing.
 */
function hostJson(deps: ServiceDeps): Record<string, unknown> {
  const path = hostFilePath(deps.env, deps.home, deps.read);
  const text = deps.read(path);
  if (text === null) throw new ServiceRefusal(`the terminal service reads its herdr session and port from the host file, and ${path} cannot be read. Run \`agent-org onboard\` first.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ServiceRefusal(`the terminal service reads its herdr session and port from the host file, and ${path} is not valid JSON. Fix it, then start the terminal again.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ServiceRefusal(`${path} does not hold a JSON object, so the terminal service has no herdr session or port to serve`);
  return parsed as Record<string, unknown>;
}

/** The channel `auto-update` follows: `main` when `<home>/update-channel` says so, `release` otherwise. */
export function updateChannel(deps: Pick<ServiceDeps, "env" | "home" | "read">): UpdateChannel {
  return deps.read(updateChannelPath(deps.env, deps.home))?.trim() === "main" ? "main" : "release";
}

/** What `name` runs. PURE over `deps`. REFUSES a service the command table lacks, and a terminal whose plugin or bun is not installed. */
function programFor(name: ServiceName, deps: ServiceDeps): Program {
  const bin = join(deps.toolRoot, "src", "bin.ts");
  const toolEnvironment = (): Record<string, string> => {
    const host = hostFilePath(deps.env, deps.home, deps.read);
    // The workers' `gh` account the host file declares, else the one the person who started it named: an org host's `gh` wrapper refuses a
    // call that names none, and a service has no workspace id for it to route by.
    const gh = hostGhConfigDir(deps.read(host)) ?? (deps.env.GH_CONFIG_DIR || null);
    return {
      AGENT_ORG_HOST: host,
      AGENT_ORG_HOME: agentOrgHome(deps.env, deps.home),
      ...(gh === null ? {} : { GH_CONFIG_DIR: gh }),
      // `herdr`, `claude`, `gh` and `git` are found on the PATH of the person who started it: a service gets no login shell's.
      PATH: servicePath(deps.env.PATH),
    };
  };
  if (name === "instance" || name === "ui") {
    const { command, args } = SERVICE_COMMANDS[name];
    if (!Object.hasOwn(deps.commands, command)) {
      throw new ServiceRefusal(`the ${name} service runs \`agent-org ${command}\`, which this version of agent-org does not have. Run \`agent-org update\` for a version that does.`);
    }
    return { description: `agent-org ${name} service (agent-org ${command})`, argv: [deps.node, bin, command, ...args], environment: toolEnvironment(), workingDirectory: deps.toolRoot, tool: true, everySeconds: null };
  }
  if (name === "auto-update") {
    if (!Object.hasOwn(deps.commands, "update")) throw new ServiceRefusal("the auto-update service runs `agent-org update`, which this version of agent-org does not have");
    const channel = updateChannel(deps);
    return {
      description: `agent-org auto-update: agent-org update${channel === "main" ? " --channel main" : ""}, every hour`,
      argv: [deps.node, bin, "update", ...(channel === "main" ? ["--channel", "main"] : [])],
      environment: toolEnvironment(), workingDirectory: deps.toolRoot, tool: true, everySeconds: UPDATE_INTERVAL_SECONDS,
    };
  }
  const root = pluginRoot(deps.read(join(herdrConfigDir(deps.env, deps.home), "plugins.json")));
  if (root === null) throw new ServiceRefusal(`the terminal service runs herdr web ui, which herdr has not installed. Run \`herdr plugin install ${TERMINAL_PLUGIN} --yes\`, or \`agent-org onboard\`, which does.`);
  const path = servicePath(deps.env.PATH);
  const bun = findBun(deps.home, path, deps.exists);
  if (bun === null) throw new ServiceRefusal("the terminal service runs on bun, and this machine has none in ~/.bun/bin or on PATH. Run `agent-org onboard`, which installs it.");
  const { session, port } = terminalTarget(hostJson(deps));
  const program = terminalProgram({ env: deps.env, home: deps.home, session, port, root, bun, path });
  return { description: `herdr web terminal for the ${session} herdr session, on 127.0.0.1:${port}`, ...program, tool: false, everySeconds: null };
}

/** The unit file that runs `name`. PURE over `deps`. REFUSES a platform with neither launchd nor systemd, and a service `programFor` refuses. */
export function unitFor(name: ServiceName, deps: ServiceDeps): Unit {
  if (deps.platform !== "darwin" && deps.platform !== "linux") {
    throw new ServiceRefusal(`agent-org runs its services under launchd (macOS) or systemd (Linux), and this machine is ${deps.platform}`);
  }
  const { description, argv, environment, workingDirectory, tool, everySeconds } = programFor(name, deps);
  const log = join(agentOrgHome(deps.env, deps.home), "logs", `${name}.log`);
  if ([...argv, ...Object.values(environment), workingDirectory, log].some((value) => /[\n\r]/.test(value))) {
    throw new ServiceRefusal("a path holds a line break, which no unit file can carry");
  }
  const source: UnitSource = { description, argv, environment, workingDirectory, tool, everySeconds, log };
  if (deps.platform === "darwin") return launchdUnit(name, deps, source);
  return systemdUnit(name, deps, source);
}

/** The launchd plist for `name`. PURE over `deps`. */
function launchdUnit(name: ServiceName, deps: ServiceDeps, { argv, environment, workingDirectory, everySeconds, log }: UnitSource): Unit {
  const id = `io.github.agent-org.${name}`;
  const strings = (values: string[]) => values.map((value) => `    <string>${escapeXml(value)}</string>`).join("\n");
  const env = Object.entries(environment).map(([key, value]) => `    <key>${key}</key>\n    <string>${escapeXml(value)}</string>`).join("\n");
  // A daemon starts at load and again after a crash; an interval job runs every `everySeconds`, and not at load, so a login is not an update.
  const schedule = everySeconds === null
    ? `  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>`
    : `  <key>StartInterval</key>
  <integer>${everySeconds}</integer>
  <key>RunAtLoad</key>
  <false/>`;
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
  <string>${escapeXml(workingDirectory)}</string>
${schedule}
  <key>StandardOutPath</key>
  <string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(log)}</string>
</dict>
</plist>
`;
  return { manager: "launchd", id, path: join(deps.home, "Library", "LaunchAgents", `${id}.plist`), text, log, companion: null, interval: everySeconds !== null };
}

/** The systemd units for `name`: a service that restarts on failure, or a oneshot service with the timer that starts it. PURE over `deps`. */
function systemdUnit(name: ServiceName, deps: ServiceDeps, { description, argv, environment, workingDirectory, tool, everySeconds }: UnitSource): Unit {
  const dir = join(deps.home, ".config", "systemd", "user");
  const service = `agent-org-${name}.service`;
  const body = `WorkingDirectory=${systemdPath(workingDirectory)}
ExecStart=${argv.map(systemdQuoted).join(" ")}
${Object.entries(environment).map(([key, value]) => `Environment=${systemdQuoted(`${key}=${value}`)}`).join("\n")}`;
  if (everySeconds !== null) {
    // A timer and the oneshot service it starts. `OnCalendar` with `Persistent` runs a missed hour once the machine is up again.
    const timer = `agent-org-${name}.timer`;
    const serviceText = `[Unit]
Description=${description}

[Service]
Type=oneshot
${body}
`;
    const timerText = `[Unit]
Description=${description}

[Timer]
OnCalendar=*-*-* *:00:00
RandomizedDelaySec=600
Persistent=true
Unit=${service}

[Install]
WantedBy=timers.target
`;
    return { manager: "systemd", id: timer, path: join(dir, timer), text: timerText, log: null, companion: { path: join(dir, service), text: serviceText }, interval: true };
  }
  const text = `[Unit]
Description=${description}
After=network-online.target

[Service]
Type=simple
${body}
${tool ? "# Exit 2 is a refusal (a host file that does not parse, a port in use), which a restart does not mend.\n" : ""}Restart=on-failure
RestartSec=10
${tool ? "RestartPreventExitStatus=2\n" : ""}
[Install]
WantedBy=default.target
`;
  return { manager: "systemd", id: service, path: join(dir, service), text, log: null, companion: null, interval: false };
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
    // An interval job is between runs nearly always: loaded is as running as it gets.
    if (unit.interval) return printed.status === 0 ? "running" : "stopped";
    return printed.status === 0 && /^\s*state = running\s*$/m.test(printed.stdout) ? "running" : "stopped";
  }
  return deps.run("systemctl", ["--user", "is-active", unit.id]).stdout.trim() === "active" ? "running" : "stopped";
}

/**
 * The host file's JSON object, for the tailnet's own reads. Null when the file is absent. A file that is there but cannot be read, or is not a JSON
 * object, REFUSES, naming it: a page or terminal must not start, or be left on loopback, on a host file that cannot say whether it is served.
 */
function hostObject(deps: ServiceDeps): Record<string, unknown> | null {
  const path = hostFilePath(deps.env, deps.home, deps.read);
  const text = deps.read(path);
  if (text === null) {
    if (deps.exists(path)) throw new ServiceRefusal(`${path} exists but cannot be read, so the tailnet cannot be checked: make it readable, then run the command again`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ServiceRefusal(`${path} is not valid JSON, so the tailnet cannot be checked: fix it, then run the command again`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ServiceRefusal(`${path} does not hold a JSON object, so the tailnet cannot be checked: fix it, then run the command again`);
  return parsed as Record<string, unknown>;
}

/**
 * Which tailnet port `name` is served on, and the loopback port it listens on, from `tickets.serve`. Null when the service is not served: the instance
 * and auto-update never are, and neither is a host file without `tickets.serve`. A `tickets.serve` or `tickets.servePorts` that is not valid is refused by name.
 */
function servedAt(name: ServiceName, deps: ServiceDeps): Served | null {
  if (name !== "ui" && name !== "terminal") return null;
  const host = hostObject(deps);
  if (host === null) return null;
  const block = host.tickets ?? {};
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new ServiceRefusal(`the \`tickets\` block of ${hostFilePath(deps.env, deps.home, deps.read)} must be an object, so the tailnet cannot be checked`);
  }
  const tickets = block as Record<string, unknown>;
  let ports: ServePorts | null;
  try {
    ports = serveOf(tickets);
  } catch (err) {
    if (err instanceof TicketSettingsRefusal) throw new ServiceRefusal(err.message);
    throw err;
  }
  if (ports === null) return null;
  return { name, port: ports[name], local: name === "ui" ? uiPortOf(tickets) : terminalTarget(host).port };
}

/**
 * Refuses before anything starts, when this machine cannot be served on the tailnet: tailscale is installed, Running and has a DNS name. Returns the
 * name the board answers to. Each refusal names its fix.
 */
function tailnetName(deps: ServiceDeps): string {
  const status = deps.run("tailscale", statusArgv());
  if (status.status === null) throw new ServiceRefusal(TAILSCALE_MISSING);
  const self = status.status === 0 ? parseStatus(status.stdout) : null;
  if (self === null) throw new ServiceRefusal(refused(status, statusArgv(), deps.user));
  if (!self.running) throw new ServiceRefusal(notRunning(self));
  if (self.name === null) throw new ServiceRefusal(noName);
  return self.name;
}

/** Refuses a tailnet port that is public (Funnel is on for it) or that another entry serves: the board never replaces either. */
function refuseTakenPort(served: Served, dns: string, deps: ServiceDeps): void {
  const args = serveStatusArgv();
  const result = deps.run("tailscale", args);
  const entries = result.status === 0 ? parseServeStatus(result.stdout) : null;
  if (entries === null) throw new ServiceRefusal(refused(result, args, deps.user));
  const state = portState(entries, dns, served.port, served.local);
  const setting = `tickets.servePorts.${served.name}`;
  if (state.funnel) throw new ServiceRefusal(`port ${served.port} is on Funnel, which makes it public, and the board is never served on Funnel: set \`${setting}\` to a port nothing serves`);
  if (state.kind === "foreign") throw new ServiceRefusal(`port ${served.port} already serves ${state.proxy ?? "another entry"} on the tailnet, and the board will not replace it: set \`${setting}\` to a port nothing serves`);
}

/**
 * Removes this service's own tailnet entry, once the service has stopped. Only that port's entry is removed, and only when it still proxies to this
 * service: no other entry, Funnel or not, is named in any command.
 */
function removeServe(served: Served, deps: ServiceDeps): void {
  const left = `the ${served.name} service is stopped, but its tailscale serve entry on port ${served.port} was not removed`;
  const status = deps.run("tailscale", statusArgv());
  const self = status.status === 0 ? parseStatus(status.stdout) : null;
  if (self === null || self.name === null) throw new ServiceRefusal(`${left}: ${self === null ? refused(status, statusArgv(), deps.user) : noName}`);
  const serve = deps.run("tailscale", serveStatusArgv());
  const entries = serve.status === 0 ? parseServeStatus(serve.stdout) : null;
  if (entries === null) throw new ServiceRefusal(`${left}: ${refused(serve, serveStatusArgv(), deps.user)}`);
  if (portState(entries, self.name, served.port, served.local).kind !== "ours") return;
  const args = removeArgv(served.port);
  const removed = deps.run("tailscale", args);
  if (removed.status !== 0) throw new ServiceRefusal(`${left}: ${refused(removed, args, deps.user)}. \`tailscale serve --https=${served.port} off\` removes it`);
}

/**
 * Write the unit, register it to start at login, and start it. Starting a service that runs already leaves it running. A page or terminal that
 * `tickets.serve` puts on the tailnet is checked first (nothing starts on a refusal), then started, then given its tailnet entry.
 */
export function startService(name: ServiceName, deps: ServiceDeps): Started {
  const unit = unitFor(name, deps);
  const hostFile = hostFilePath(deps.env, deps.home, deps.read);
  if (!deps.exists(hostFile)) throw new ServiceRefusal(`there is no host file at ${hostFile}. Run \`agent-org onboard\` first.`);
  const served = servedAt(name, deps);
  const dns = served === null ? null : tailnetName(deps);
  if (served !== null && dns !== null) refuseTakenPort(served, dns, deps);
  if (unit.companion !== null) deps.write(unit.companion.path, unit.companion.text);
  deps.write(unit.path, unit.text);
  if (unit.manager === "launchd") {
    mkdirSync(dirname(unit.log as string), { recursive: true, mode: 0o700 });
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
  if (served === null || dns === null) return { ...unit, address: null };
  const args = serveArgv(served.port, served.local);
  const result = deps.run("tailscale", args);
  if (result.status !== 0) throw new TailnetRefusal(`the ${name} service started on 127.0.0.1, but the tailnet does not reach it: ${refused(result, args, deps.user)}`);
  return { ...unit, address: `https://${dns}:${served.port}/` };
}

/**
 * Stop the service and keep it from starting at login. The unit file stays, so `start` and `doctor` still find it. A page or terminal that
 * `tickets.serve` puts on the tailnet then loses its own tailnet entry, and nothing else.
 */
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
  const served = servedAt(name, deps);
  if (served !== null) removeServe(served, deps);
}

/**
 * Why systemd will not load `name`'s unit, or null when it loads (or the service is not registered, or runs under launchd). systemd's load state
 * says only `bad-setting`; the line it refused is `systemd-analyze verify`'s, such as `WorkingDirectory= path is not absolute`.
 */
export function unitProblem(name: ServiceName, deps: ServiceDeps): string | null {
  let unit: Unit;
  try {
    unit = unitFor(name, deps);
  } catch (err) {
    if (err instanceof ServiceRefusal) return null;
    throw err;
  }
  if (unit.manager !== "systemd" || !deps.exists(unit.path)) return null;
  const state = deps.run("systemctl", ["--user", "show", "--property=LoadState", "--value", unit.id]).stdout.trim();
  if (state !== "bad-setting" && state !== "error") return null;
  const verify = deps.run("systemd-analyze", ["--user", "verify", unit.path]);
  const lines = `${verify.stderr}\n${verify.stdout}`.split("\n").map((line) => line.trim()).filter((line) => line.includes(unit.id) && line !== "");
  return `systemd reads ${unit.id} as ${state}${lines.length > 0 ? `: ${lines.join("; ")}` : ""}`;
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

/** `agent-org start|stop|status [instance|ui|terminal|auto-update]`. @returns the exit code */
export function main(argv: string[], deps: ServiceDeps = defaultServiceDeps(), out: Pick<Console, "log" | "error"> = console): number {
  try {
    const { positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true });
    const [action, word, ...extra] = positionals;
    if (extra.length > 0) throw new ServiceRefusal(`one service at a time, and \`${extra.join(" ")}\` is extra`);
    const name = serviceName(word);
    if (action === "start") {
      const unit = startService(name, deps);
      const journal = unit.companion === null ? unit.id : basename(unit.companion.path);
      const tailnet = unit.address === null ? "" : `, on the tailnet at ${unit.address}`;
      out.log(`started the ${name} service (${unit.manager} ${unit.id})${tailnet}${unit.log ? `, logging to ${unit.log}` : `, logging to \`journalctl --user -u ${journal}\``}`);
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
      const problem = unitProblem(name, deps);
      out.log(`${name}: ${STATE_WORDS[state]} (${unit.manager} ${unit.id})${problem === null ? "" : `. ${problem}. \`agent-org start ${name}\` writes the unit again`}`);
      return state === "running" ? 0 : NOT_RUNNING;
    }
    throw new ServiceRefusal(`\`${action ?? ""}\` is not start, stop or status`);
  } catch (err) {
    out.error(`agent-org: ${(err as Error).message}`);
    return REFUSED;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) process.exitCode = main(process.argv.slice(2));
