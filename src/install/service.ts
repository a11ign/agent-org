// @ts-check
// module: start, stop and status -- run an agent-org service (`herdr`, `instance`, `ui`, `terminal` or `auto-update`) as a launchd user agent on macOS or a systemd user unit on Linux
//
// A SERVICE IS A NAME AND THE PROGRAM IT RUNS. `instance` runs `ticket:serve` (the queue and the workers) and `ui` runs `ticket:ui` (the page), each
// looked up in `commands.ts`'s table: a service whose command the table does not hold is refused by name, so a checkout older than the split says so
// and starts nothing. `terminal` runs herdr web ui against ticket mode's herdr session (`terminal.ts`), so the board can link each run to its live
// worker (A11-66). `auto-update` runs `agent-org update` every ten minutes: on a ticket-mode machine nothing else moves the tool (the org's gate used
// to), so a merged fix never reached the running instance. Update restarts a service only when `current` moved, so a run with nothing new restarts
// nothing. `agent-org stop auto-update` is the opt-out, and the channel it follows is `<home>/update-channel` (`release`, or `main`), which onboard writes.
//
// HERDR IS A SERVICE OF ITS OWN (A11-169). `herdr` runs `herdr --session <tickets.herdrSession> server` and holds every worker's pane. The instance and the terminal `Want=` and start `After=` it,
// so starting either starts it, and nothing `Requires=`, `BindsTo=` or `PartOf=` it, so a restart of the instance, the ui or the terminal never reaches it: that is the whole of "an update
// lands while workers run". `start herdr` starts the unit and never restarts it (a restart ends every pane); `start herdr --move` is the one move from a server started outside the
// unit (`herdr-move.ts`). Its working directory is the agent-org home, never a tool folder, because a version folder can be pruned.
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
import { existsSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { COMMANDS } from "../commands.ts";
import { agentOrgHome, hostFilePath, hostGhConfigDir, readOrNull, TOOL_ROOT, type Env } from "./paths.ts";
import { findBun } from "./bun.ts";
import { herdrConfigDir, pluginRoot, TERMINAL_PLUGIN, terminalProgram, terminalTarget } from "./terminal.ts";
import { loadActive, realPluginDeps } from "../plugins/active.ts";
import type { Exposure } from "../plugins/contracts/exposure.ts";
import type { PluginDeps } from "../plugins/manifest.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import { toolEntryOf } from "./tool-versions.ts";
import { HERDR_UNIT } from "./herdr-place.ts";
import type { MoveDeps } from "./herdr-move.ts";
import { resolveProviders } from "../ticket-mode/providers.ts";
import { uiPortOf } from "../ticket-mode/settings.ts";
import { writeAtomic } from "./write-atomic.ts";
import { MS_PER_SECOND } from "./time-limit.ts";
import { TOOL_HERDR_VERSION } from "./herdr-install.ts";

/** Service name -> the `agent-org` command it runs, and the arguments after it. */
export const SERVICE_COMMANDS = Object.freeze({
  instance: Object.freeze({ command: "ticket:serve", args: Object.freeze(["--no-open"]) }),
  ui: Object.freeze({ command: "ticket:ui", args: Object.freeze(["--no-open"]) }),
});

export const SERVICE_NAMES = Object.freeze(["herdr", "instance", "ui", "terminal", "auto-update"] as const);
export type ServiceName = (typeof SERVICE_NAMES)[number];
/** The services that run the tool's code, which `update` restarts once `current` has moved. herdr is never restarted by an update; the terminal runs the plugin's, and the updater is the one moving it. */
export const TOOL_SERVICES: readonly ServiceName[] = Object.freeze(["instance", "ui"]);
/** How often `auto-update` runs `agent-org update`: an update applies within minutes (A11-169), and one with nothing new is a tag fetch that restarts nothing. */
export const UPDATE_INTERVAL_SECONDS = 600;
/** The services the instance's unit and the terminal's `Want=` and start after: starting either starts herdr, and a restart of either leaves it alone. */
const NEEDS_HERDR: readonly ServiceName[] = ["instance", "terminal"];
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
  /** The tool path a unit runs: `<tool>/current` for an install in version folders, else the checkout itself. */
  toolRoot: string;
  run: Run;
  exists: (path: string) => boolean;
  /** A file's text, or null when it cannot be read: the host file, herdr's plugin list and the update channel are read through it. */
  read: (path: string) => string | null;
  write: (path: string, text: string) => void;
  commands: Readonly<Record<string, string>>;
  /** The person who started the service, whose exposure program the serve step needs as the operator. */
  user: string;
  /**
   * The exposure plugin the host file enables (A11-162), loaded: it says which port a served service is served on and serves it. The default loads the bundled plugin, running its
   * programs through `run`; a test passes its own.
   */
  exposure?: (host: Record<string, unknown>) => Promise<Exposure>;
  /** Waits `ms` milliseconds, synchronously (`reloadService` and `restartService` are, as `update` is): the wait for launchd to finish a bootout. The default blocks the thread; a test passes a no-op. */
  pause?: (ms: number) => void;
}>;

export class ServiceRefusal extends Error {}

/** A served service that started on loopback, and whose entry on the network was then refused: it runs, and the exposure does not reach it. */
export class TailnetRefusal extends ServiceRefusal {}

/** A service the exposure serves: `ui` or `terminal`, the port it is served on, the loopback port it listens on and the exposure proxies to, and the exposure that serves it. */
type Served = Readonly<{ name: "ui" | "terminal"; port: number; local: number; exposure: Exposure }>;

/** What `startService` returns: the unit, and the address it is served at, or null when it is served on loopback only. */
export type Started = Unit & Readonly<{ address: string | null }>;

/** The longest one `launchctl`, `systemctl` or `herdr` call may take: the limit `agent-tool-update.ts` gives herdr. A call that passes it is killed and answers a non-zero result that says so. */
const RUN_TIMEOUT_MS = 120_000;

/** `spawnSync` with a time limit (A11-225): a call that does not finish in `timeoutMs` is a failed result whose `stderr` names it, never a wait without an end. */
export function runWithin(file: string, args: readonly string[], timeoutMs: number): RunResult {
  const result = spawnSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") return { status: null, stdout: "", stderr: `\`${[file, ...args].join(" ")}\` did not finish within ${timeoutMs / MS_PER_SECOND}s` };
  if (result.error) return { status: null, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const defaultRun: Run = (file, args) => runWithin(file, args, RUN_TIMEOUT_MS);

export function defaultServiceDeps(): ServiceDeps {
  return Object.freeze({
    platform: process.platform, env: process.env, home: homedir(), uid: userInfo().uid, node: process.execPath, toolRoot: toolEntryOf(TOOL_ROOT),
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
function hostJson(deps: ServiceDeps, service: "terminal" | "herdr" = "terminal"): Record<string, unknown> {
  const path = hostFilePath(deps.env, deps.home, deps.read);
  const text = deps.read(path);
  const reads = service === "herdr" ? "its herdr session" : "its herdr session and port";
  if (text === null) throw new ServiceRefusal(`the ${service} service reads ${reads} from the host file, and ${path} cannot be read. Run \`agent-org onboard\` first.`);
  return parseHostObject(text, `the ${service} service reads ${reads} from the host file, and ${path} is not valid JSON. Fix it, then start the ${service} service again.`,
    `${path} does not hold a JSON object, so the ${service} service has no herdr session${service === "terminal" ? " or port to serve" : ""}`);
}

/** The herdr session ticket mode runs in, from the host file: `tickets.herdrSession`, `tickets` when it names none. REFUSES a host file that cannot be read. */
export function herdrSessionOfHost(deps: ServiceDeps): string {
  return terminalTarget(hostJson(deps, "herdr")).session;
}

/** The first `herdr` in `path` that exists: a unit's `ExecStart` is an absolute path, and a service gets no login shell's PATH to find it by. Null when there is none. */
function herdrBinary(path: string, exists: (path: string) => boolean): string | null {
  return path.split(":").map((dir) => join(dir, "herdr")).find((candidate) => exists(candidate)) ?? null;
}

/** The host file's text as a JSON object. `notJson` and `notObject` are the refusals for text that is not JSON and for JSON that is not an object. */
function parseHostObject(text: string, notJson: string, notObject: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ServiceRefusal(notJson);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ServiceRefusal(notObject);
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
  if (name === "herdr") {
    const herdr = herdrBinary(servicePath(deps.env.PATH), deps.exists);
    if (herdr === null) throw new ServiceRefusal(`the herdr service runs \`herdr\`, and this machine has none on PATH. Run \`agent-org onboard\`, which installs herdr ${TOOL_HERDR_VERSION}, then start the herdr service again.`);
    const session = herdrSessionOfHost(deps);
    // The workers' panes inherit this environment (they inherited the instance's), and its working directory is the home: a version folder can be pruned under a server that sat in it.
    return { description: `herdr server for the ${session} herdr session (the workers' terminals)`, argv: [herdr, "--session", session, "server"], environment: toolEnvironment(),
      workingDirectory: agentOrgHome(deps.env, deps.home), tool: false, everySeconds: null };
  }
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
      description: `agent-org auto-update: agent-org update${channel === "main" ? " --channel main" : ""}, every ten minutes`,
      argv: [deps.node, bin, "update", ...(channel === "main" ? ["--channel", "main"] : [])],
      environment: toolEnvironment(), workingDirectory: deps.toolRoot, tool: true, everySeconds: UPDATE_INTERVAL_SECONDS,
    };
  }
  const root = pluginRoot(deps.read(join(herdrConfigDir(deps.env, deps.home), "plugins.json")));
  if (root === null) throw new ServiceRefusal(`the terminal service runs herdr web ui, which herdr has not installed. Run \`agent-org onboard\`, which installs it at its newest release tag.`);
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
    // A timer and the oneshot service it starts. `OnCalendar` with `Persistent` runs a missed run once the machine is up again.
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
OnCalendar=*:0/10
RandomizedDelaySec=60
Persistent=true
Unit=${service}

[Install]
WantedBy=timers.target
`;
    return { manager: "systemd", id: timer, path: join(dir, timer), text: timerText, log: null, companion: { path: join(dir, service), text: serviceText }, interval: true };
  }
  // `Wants=` plus `After=` and nothing stronger: starting the instance or the terminal starts herdr, and restarting either leaves it running (systemd carries a restart only through `Requires=`, `BindsTo=` and `PartOf=`).
  const herdr = NEEDS_HERDR.includes(name) ? `Wants=${HERDR_UNIT.systemd}\n` : "";
  const text = `[Unit]
Description=${description}
${herdr}After=network-online.target${herdr === "" ? "" : ` ${HERDR_UNIT.systemd}`}

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

const BOOTOUT_WAIT_SECONDS = 25;
/** How long a bootout is waited for: launchd gives a job `ExitTimeOut` (20 s by default) to exit before it kills it, so a little longer than that. */
const BOOTOUT_WAIT_MS = BOOTOUT_WAIT_SECONDS * 1000;
const BOOTOUT_POLL_MS = 250;
/** `launchctl bootout` exits with these when the label is not loaded (3: no such process, 113: could not find service): the state it was asked for. */
const LABEL_NOT_LOADED: readonly (number | null)[] = [3, 113];
/** The line launchctl ends a failed bootstrap with, which sends a person to `sudo` for what a user agent never needs it for. */
const ROOT_ADVICE = /^Try re-running the command as root for richer errors\.?$/im;

const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** The service a launchctl step acts on: its name, its plist, and the machine's seams. */
type LaunchdAgent = Readonly<{ name: ServiceName; unit: Unit; deps: ServiceDeps }>;

/** What a launchd failure was doing, which picks the sentence that says what did not happen and the one command that undoes the failure. */
type LaunchdStep = "enable" | "disable" | "stop" | "restart" | "register";
const LAUNCHD_PROBLEM: Readonly<Record<LaunchdStep, string>> = { enable: "could not be enabled", disable: "could not be disabled", stop: "did not stop", restart: "did not restart", register: "did not load" };

/** A launchctl command that failed: the step it was part of, the command line, and what launchctl said. */
type LaunchdFailure = Readonly<{ step: LaunchdStep; command: string; said: string }>;

/** The refusal for a failed launchctl step: which service, what launchctl said, and the one line that fixes it by hand. Never "re-run as root". PURE. */
function launchdRefusal({ name, unit, deps }: LaunchdAgent, { step, command, said }: LaunchdFailure): ServiceRefusal {
  const target = launchdTarget(unit, deps);
  const byHand = `launchctl bootout ${target}; launchctl bootstrap gui/${deps.uid} ${unit.path}`;
  const fix = {
    enable: `launchctl enable ${target}`,
    disable: `launchctl disable ${target}`,
    stop: `launchctl bootout ${target}`,
    restart: byHand,
    register: byHand,
  }[step];
  return new ServiceRefusal(`the ${name} service (${unit.id}) ${LAUNCHD_PROBLEM[step]}: ${command}: ${said.replace(/\.$/, "")}. To fix it by hand, run: ${fix}`);
}

/** What launchctl said to a command that failed, without the advice to run as root, or its exit status when it said nothing. */
function failureOf(step: LaunchdStep, args: string[], result: RunResult): LaunchdFailure {
  const said = (result.stderr || result.stdout).replace(ROOT_ADVICE, "").trim();
  return { step, command: `launchctl ${args.join(" ")} failed`, said: said || `exit ${result.status}` };
}

/** Runs `launchctl <args>`. REFUSES, in {@link launchdRefusal}'s words, any exit but 0. */
function launchctlMust(agent: LaunchdAgent, step: LaunchdStep, args: string[]): void {
  const result = agent.deps.run("launchctl", args);
  if (result.status !== 0) throw launchdRefusal(agent, failureOf(step, args, result));
}

const isLoaded = ({ unit, deps }: LaunchdAgent) => deps.run("launchctl", ["print", launchdTarget(unit, deps)]).status === 0;

/** Boots the label out and waits until launchd no longer lists it, because a bootstrap sent while it is listed fails with `Bootstrap failed: 5`. REFUSES a label still listed after the wait. */
function bootoutAndWait(agent: LaunchdAgent): void {
  const { unit, deps } = agent;
  const target = launchdTarget(unit, deps);
  const args = ["bootout", target];
  const booted = deps.run("launchctl", args);
  if (booted.status !== 0 && !LABEL_NOT_LOADED.includes(booted.status)) throw launchdRefusal(agent, failureOf("register", args, booted));
  const pause = deps.pause ?? sleepSync;
  for (let waited = 0; isLoaded(agent); waited += BOOTOUT_POLL_MS) {
    if (waited >= BOOTOUT_WAIT_MS) throw launchdRefusal(agent, { step: "register", command: `launchctl bootout ${target} did not finish`, said: `the service is still loaded after ${BOOTOUT_WAIT_SECONDS} s` });
    pause(BOOTOUT_POLL_MS);
  }
}

const bootstrap = (agent: LaunchdAgent) => launchctlMust(agent, "register", ["bootstrap", `gui/${agent.deps.uid}`, agent.unit.path]);

/**
 * Loads the agent's plist into the user's launchd domain, whatever is there already (A11-224): `launchctl bootstrap` refuses a label that is loaded. A label not loaded is bootstrapped. A loaded
 * one is booted out, waited for, and bootstrapped when its plist differs from the `previous` text on disk (a loaded agent keeps the plist it was loaded with; a plist that was not there is
 * different), and kickstarted with `-k` when it does not. herdr is the exception: it is only kickstarted without `-k`, because a restart ends every worker's pane.
 */
function loadLaunchd(agent: LaunchdAgent, previous: string | null): void {
  const { name, unit, deps } = agent;
  const target = launchdTarget(unit, deps);
  if (isLoaded(agent)) {
    // A loaded herdr job that exited (a `server stop` is a successful exit, which `KeepAlive` leaves alone) is started again; one that runs is left running by a kickstart without `-k`.
    if (name === "herdr") launchctlMust(agent, "restart", ["kickstart", target]);
    else if (previous === unit.text) launchctlMust(agent, "restart", ["kickstart", "-k", target]);
    else {
      bootoutAndWait(agent);
      bootstrap(agent);
    }
  } else bootstrap(agent);
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
 * The host file's JSON object, for the exposure's own reads. Null when the file is absent. A file that is there but cannot be read, or is not a JSON
 * object, REFUSES, naming it: a page or terminal must not start, or be left on loopback, on a host file that cannot say whether it is served.
 */
function hostObject(deps: ServiceDeps): Record<string, unknown> | null {
  const path = hostFilePath(deps.env, deps.home, deps.read);
  const text = deps.read(path);
  if (text === null) {
    if (deps.exists(path)) throw new ServiceRefusal(`${path} exists but cannot be read, so the exposure cannot be checked: make it readable, then run the command again`);
    return null;
  }
  return parseHostObject(text, `${path} is not valid JSON, so the exposure cannot be checked: fix it, then run the command again`,
    `${path} does not hold a JSON object, so the exposure cannot be checked: fix it, then run the command again`);
}

/** The exposure plugin a host file enables, loaded with every program it runs going through `deps.run`. REFUSES, naming it, a host file the readers refuse and a plugin the loader refuses. */
async function exposureOf(host: Record<string, unknown>, deps: ServiceDeps): Promise<Exposure> {
  if (deps.exposure !== undefined) return deps.exposure(host);
  try {
    const stateDir = typeof host.stateDir === "string" ? host.stateDir : join(deps.home, ".local", "state", "agent-org");
    const exec: PluginDeps["exec"] = (file, args) => deps.run(file, [...args]);
    // The person who started the service is the operator Tailscale's refusal names, so their name goes in the environment the plugin reads it from.
    const env = { ...deps.env, USER: deps.user };
    const active = await loadActive(resolveProviders(host), defaultCatalog(), { ...realPluginDeps({ env, stateDir, pick: "assigned" }), exec }, undefined, ["exposure"]);
    return active.exposure();
  } catch (err) {
    // The readers' refusals and the loader's both name what is wrong; the service says them as its own.
    throw err instanceof Error ? new ServiceRefusal(err.message) : err;
  }
}

/**
 * Which port `name` is served on by the exposure, and the loopback port it listens on. Null when the service is not served: the instance and auto-update never are, and neither is a
 * host whose exposure serves nothing (`local`). A host file the readers refuse, or an exposure whose settings are not valid, is refused by name.
 */
async function servedAt(name: ServiceName, deps: ServiceDeps): Promise<Served | null> {
  if (name !== "ui" && name !== "terminal") return null;
  const host = hostObject(deps);
  if (host === null) return null;
  const block = host.tickets ?? {};
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new ServiceRefusal(`the \`tickets\` block of ${hostFilePath(deps.env, deps.home, deps.read)} must be an object, so the exposure cannot be checked`);
  }
  const exposure = await exposureOf(host, deps);
  const ports = exposure.ports();
  if (ports === null) return null;
  return { name, port: ports[name], local: name === "ui" ? uiPortOf(block as Record<string, unknown>) : terminalTarget(host).port, exposure };
}

/** The name the exposure answers to: refuses before anything starts when this machine cannot be served, with the exposure's own sentence and its fix. */
async function machineName(served: Served): Promise<string> {
  const { exposure } = served;
  const why = exposure.readiness();
  if (why !== null) throw new ServiceRefusal(why);
  const name = await exposure.machineName();
  if (name === null) throw new ServiceRefusal("the exposure has no name for this machine, so there is no name for the board to answer to");
  return name;
}

/** Removes this service's own entry from the exposure, once the service has stopped. Only that port's entry is removed, and only when it still proxies to this service. */
function removeServe(served: Served): void {
  const left = `the ${served.name} service is stopped, but its entry on port ${served.port} was not removed`;
  let state;
  try {
    state = served.exposure.portState(served.port, served.local);
  } catch (err) {
    throw new ServiceRefusal(`${left}: ${(err as Error).message}`);
  }
  if (state.kind !== "ours") return;
  const removed = served.exposure.unserve(served.port);
  if (removed.status !== 0) throw new ServiceRefusal(`${left}: ${removed.refusal ?? removed.stderr}`);
}

/**
 * Write the unit, register it to start at login, and start it. Starting a service that runs already leaves it running. A page or terminal that
 * the exposure serves is checked first (nothing starts on a refusal), then started, then given its entry.
 */
export async function startService(name: ServiceName, deps: ServiceDeps): Promise<Started> {
  const unit = unitFor(name, deps);
  const hostFile = hostFilePath(deps.env, deps.home, deps.read);
  if (!deps.exists(hostFile)) throw new ServiceRefusal(`there is no host file at ${hostFile}. Run \`agent-org onboard\` first.`);
  const served = await servedAt(name, deps);
  const dns = served === null ? null : await machineName(served);
  if (served !== null) {
    const taken = served.exposure.claim(served.port, served.local, served.name);
    if (taken !== null) throw new ServiceRefusal(taken);
  }
  const previous = deps.read(unit.path);
  if (unit.companion !== null) deps.write(unit.companion.path, unit.companion.text);
  deps.write(unit.path, unit.text);
  if (unit.manager === "launchd") {
    mkdirSync(dirname(unit.log as string), { recursive: true, mode: 0o700 });
    const agent = { name, unit, deps };
    launchctlMust(agent, "enable", ["enable", launchdTarget(unit, deps)]);
    loadLaunchd(agent, previous);
  } else {
    must(deps.run("systemctl", ["--user", "daemon-reload"]), "systemctl --user daemon-reload");
    must(deps.run("systemctl", ["--user", "enable", unit.id]), `systemctl --user enable ${unit.id}`);
    // herdr is STARTED, never restarted: a start leaves a running server alone, and a restart ends every worker's pane and agent.
    const verb = name === "herdr" ? "start" : "restart";
    must(deps.run("systemctl", ["--user", verb, unit.id]), `systemctl --user ${verb} ${unit.id}`);
  }
  if (served === null || dns === null) return { ...unit, address: null };
  const result = served.exposure.serve(served.port, served.local);
  if (result.status !== 0) throw new TailnetRefusal(`the ${name} service started on 127.0.0.1, but the exposure does not reach it: ${result.refusal ?? result.stderr}`);
  // The address says the port it is served on, as a browser is given it: the origin that names it, else the first one the exposure gives.
  const origins = served.exposure.origins({ name: dns, port: served.port });
  return { ...unit, address: `${origins.find((origin) => origin.endsWith(`:${served.port}`)) ?? origins[0]}/` };
}

/**
 * Stop the service and keep it from starting at login. The unit file stays, so `start` and `doctor` still find it. A page or terminal that
 * the exposure serves then loses its own entry, and nothing else.
 */
export async function stopService(name: ServiceName, deps: ServiceDeps): Promise<void> {
  const unit = unitFor(name, deps);
  if (!deps.exists(unit.path)) throw new ServiceRefusal(`the ${name} service is not registered. \`agent-org start ${name}\` registers and starts it.`);
  if (unit.manager === "launchd") {
    const target = launchdTarget(unit, deps);
    const agent = { name, unit, deps };
    if (isLoaded(agent)) launchctlMust(agent, "stop", ["bootout", target]);
    launchctlMust(agent, "disable", ["disable", target]);
  } else {
    must(deps.run("systemctl", ["--user", "disable", "--now", unit.id]), `systemctl --user disable --now ${unit.id}`);
  }
  const served = await servedAt(name, deps);
  if (served !== null) removeServe(served);
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

/**
 * Write a registered service's unit again from what is installed now, and restart it (A11-184). The terminal's unit names the `plugin_root` of herdr web ui, so a plugin that moved is run only
 * once the unit is rewritten; `restartService` alone would start the old folder again. Synchronous, as `update` is: it does not touch the exposure's entry, which is the service's port, not its process.
 */
export function reloadService(name: ServiceName, deps: ServiceDeps): void {
  const unit = unitFor(name, deps);
  const previous = deps.read(unit.path);
  if (unit.companion !== null) deps.write(unit.companion.path, unit.companion.text);
  deps.write(unit.path, unit.text);
  if (unit.manager === "launchd") {
    loadLaunchd({ name, unit, deps }, previous);
  } else {
    must(deps.run("systemctl", ["--user", "daemon-reload"]), "systemctl --user daemon-reload");
    must(deps.run("systemctl", ["--user", "restart", unit.id]), `systemctl --user restart ${unit.id}`);
  }
}

/**
 * Restart a registered service, so it loads the tool's `current` version again. Writes no unit: the plist names `<tool>/current`, which an update does not change. On launchd a service that
 * is registered but not loaded is bootstrapped, and one that is not registered is refused.
 */
export function restartService(name: ServiceName, deps: ServiceDeps): void {
  const unit = unitFor(name, deps);
  if (unit.manager === "launchd") {
    const agent = { name, unit, deps };
    if (isLoaded(agent)) launchctlMust(agent, "restart", ["kickstart", "-k", launchdTarget(unit, deps)]);
    else if (deps.exists(unit.path)) bootstrap(agent);
    else throw new ServiceRefusal(`the ${name} service is not registered. \`agent-org start ${name}\` registers and starts it.`);
  } else must(deps.run("systemctl", ["--user", "restart", unit.id]), `systemctl --user restart ${unit.id}`);
}

/**
 * Run the auto-update job now, rather than at its next timer (A11-169): a draining update applies the moment the last run has been stopped. Systemd starts the oneshot service the timer
 * starts, and launchd kickstarts the interval job. Throws a {@link ServiceRefusal} when the manager refuses.
 */
export function runAutoUpdateNow(deps: ServiceDeps): void {
  const unit = unitFor("auto-update", deps);
  if (unit.manager === "launchd") launchctlMust({ name: "auto-update", unit, deps }, "restart", ["kickstart", launchdTarget(unit, deps)]);
  // `--no-block`: the oneshot service runs `update`, which restarts the instance that asked for it, so waiting for it would hold the instance's loop while it is stopped.
  else must(deps.run("systemctl", ["--user", "start", "--no-block", unit.companion?.path ? basename(unit.companion.path) : unit.id]), "systemctl --user start --no-block agent-org-auto-update.service");
}

const STATE_WORDS: Readonly<Record<ServiceState, string>> = { "not-registered": "not registered", stopped: "stopped", running: "running" };
/** `status`'s exit code when the service does not run, as an init script's `status` answers. */
const NOT_RUNNING = 3;
const REFUSED = 2;

/** `agent-org start|stop|status [herdr|instance|ui|terminal|auto-update]`, and `start herdr --move`. @returns the exit code */
export async function main(argv: string[], deps: ServiceDeps = defaultServiceDeps(), out: Pick<Console, "log" | "error"> = console, moveDeps?: MoveDeps): Promise<number> {
  try {
    const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { move: { type: "boolean", default: false } } });
    const [action, word, ...extra] = positionals;
    if (extra.length > 0) throw new ServiceRefusal(`one service at a time, and \`${extra.join(" ")}\` is extra`);
    const name = serviceName(word);
    if (values.move && !(action === "start" && name === "herdr")) throw new ServiceRefusal("--move is for `agent-org start herdr`, which moves a herdr server that runs outside its unit");
    if (action === "start" && name === "herdr") {
      // Its own path: a server outside the unit is refused unless `--move`, and a start never restarts the one in the unit.
      // A DYNAMIC import, and `herdr-move.ts` imports this file: this file must never be an entry module again (`service-cli.ts` is), or the import waits on the entry's own `await main()` and nothing settles (A11-225).
      const { defaultMoveDeps, startHerdr } = await import("./herdr-move.ts");
      const started = await startHerdr({ move: values.move }, moveDeps ?? defaultMoveDeps(deps), (line) => out.log(line));
      // `--move` ends on its own result line, said by `startHerdr` after its four steps.
      if (!values.move) out.log(`started the herdr service (${started.manager} ${started.id}), logging to ${started.log ?? "`journalctl --user -u agent-org-herdr`"}`);
      return 0;
    }
    if (action === "start") {
      const unit = await startService(name, deps);
      const journal = unit.companion === null ? unit.id : basename(unit.companion.path);
      const where = unit.address === null ? "" : `, served at ${unit.address}`;
      out.log(`started the ${name} service (${unit.manager} ${unit.id})${where}${unit.log ? `, logging to ${unit.log}` : `, logging to \`journalctl --user -u ${journal}\``}`);
      return 0;
    }
    if (action === "stop") {
      await stopService(name, deps);
      const panes = name === "herdr" ? "; every pane and agent it held ended" : "";
      out.log(`stopped the ${name} service${panes}; it will not start at login until \`agent-org start ${name}\``);
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
