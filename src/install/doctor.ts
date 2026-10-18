#!/usr/bin/env node
// @ts-check
// command: doctor -- check an install: Node, the launcher on PATH, the host file, herdr, the tracker key, Linear's MCP and each service, each with its fix
//
// EACH CHECK SAYS WHAT IT FOUND AND, WHEN IT FAILED, THE ONE THING TO DO. `node` is the one on PATH, because that is the one the launcher runs, and
// not the one running this. The tracker key is read to prove it is there, and never printed. A service is asked twice: whether it is registered,
// and whether its port answers, because a registered service can still be a crashed one. A unit systemd refuses to load (`bad-setting`, A11-67)
// is said with the line systemd refused, because `is-active` reads it only as stopped.
//
// THE WEB TERMINAL (A11-66) is checked as the board uses it: `tickets.terminal` is set and on this machine's loopback, the terminal service is
// registered, and herdr web ui answers `/api/health` on the port that address names. A `tickets.terminal` served by another machine is that
// machine's to check. Linear's MCP (A11-71) is read from `claude mcp list`, which connects to each server, so "connected" is a real answer.
// The auto-update service is checked for being registered: it runs once an hour, so it has no port.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { readLinearKey } from "../ticket-mode/linear.ts";
import { parseTicketSettings, type KeySource, type TicketSettings } from "../ticket-mode/settings.ts";
import { parseServeStatus, parseStatus, portState, runTailscale, serveStatusArgv, statusArgv, tailnetHosts, type ServeStatus, type TailscaleResult } from "../ticket-mode/tailnet.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { compareReleaseTags, isReleaseTag } from "../lib/release-tag.ts";
import { hostFilePath, TOOL_ROOT, type Env } from "./paths.ts";
import { defaultGh } from "../lib/tool-version-agreement.ts";
import { asAccount, githubRepoOf, STACK_EXTENSION, stackExtensionIn, stacksOf, type Account, type ProgramRunner } from "../ticket-port/stack-extension.ts";
import { installCommand, workerAccount } from "./stack-account.ts";
import { pinnedPnpm, TOOL_PNPM_VERSION } from "./pnpm.ts";
import { defaultServiceDeps, serviceState, unitProblem, type ServiceName, type ServiceState } from "./service.ts";
import { HOUR_MS, hostIsolation, readUpdateStatus, updateStatusPath, type Isolation, type StatusFile } from "./update-safety.ts";
import { DEFAULT_TERMINAL_PORT, loopbackPort, PAIRING_STEPS } from "./terminal.ts";

export const MIN_NODE_MAJOR = 24;

export type Check = Readonly<{ name: string; ok: boolean; detail: string; fix: string | null }>;

/**
 * The installed `gh` wrapper, read by the host's own module (`host-units.ts`, A11-84): whether it is the one `host.json` declares, and each declared role's token
 * mint. `unchecked` is said when that module would not load or the host file would not read, which is never a pass.
 */
export type GhWrapperReport = Readonly<{ unchecked: string }> | Readonly<{ divergence: string | null; mints: readonly Readonly<{ role: string; failure: string | null }>[] }>;

export type DoctorDeps = Readonly<{
  env: Env;
  home: string;
  /** `node --version` of the `node` on PATH, or null when there is none. */
  nodeVersion: () => string | null;
  /** The first executable called `name` on PATH, or null. */
  which: (name: string) => string | null;
  readFile: (path: string) => string;
  readKey: (source: KeySource) => string;
  /** A file's permission bits, or null when it cannot be read. */
  mode: (path: string) => number | null;
  serviceState: (name: ServiceName) => ServiceState;
  /** Whether something answers HTTP on 127.0.0.1:`port`. */
  answers: (port: number) => Promise<boolean>;
  /** Whether 127.0.0.1:`port` answers `/api/health` with a 2xx: herdr web ui's own health route. */
  healthy: (port: number) => Promise<boolean>;
  /** Why the service manager will not load `name`'s unit, or null when it loads. */
  unitProblem: (name: ServiceName) => string | null;
  /** What `claude mcp list` printed, or null when it could not run. */
  mcpList: () => string | null;
  /** What `--version` the pinned pnpm prints, run as install and update run it, or null when it cannot run. */
  pnpmVersion: () => string | null;
  /** `tailscale` with `args`: its status is null when it cannot start. Asked only when `tickets.serve` puts the board on the tailnet. */
  tailscale: (args: string[]) => TailscaleResult;
  /** Whether the tailnet address `ip` answers HTTPS for `name` on `port`. */
  tailnetAnswers: (ip: string, name: string, port: number) => Promise<boolean>;
  /** The installed `gh` wrapper and each declared role's mint (A11-84). Loaded by the caller, so this file stays import-light. */
  ghWrapper: () => Promise<GhWrapperReport>;
  /** The GitHub CLI as `account` (A11-106): the gh stack extension is listed, and stacked pull requests asked for each repository, through it. */
  ghAs: (account: Account) => ProgramRunner;
  /** The address of a clone's `origin` remote, or null when it has none. */
  originOf: (path: string) => string | null;
  platform: NodeJS.Platform;
  /** Whether a restart of the instance reaches herdr's server of `session` (A11-90). */
  isolation: (session: string) => Isolation;
  /** What the auto-update last saw: nothing yet, a status, or a file that cannot be read (A11-90). */
  updateStatus: () => StatusFile;
  /** The release tags this checkout holds, with no network (A11-90). */
  releaseTags: () => string[];
  now: () => number;
}>;

const ok = (name: string, detail: string): Check => ({ name, ok: true, detail, fix: null });
const failed = (name: string, detail: string, fix: string): Check => ({ name, ok: false, detail, fix });

function nodeCheck(deps: DoctorDeps): Check {
  const version = deps.nodeVersion();
  const install = `install Node ${MIN_NODE_MAJOR} or newer from https://nodejs.org, or with your version manager (\`fnm install ${MIN_NODE_MAJOR}\`, \`nvm install ${MIN_NODE_MAJOR}\`)`;
  if (version === null) return failed("node", "no `node` on PATH", install);
  const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
  return major >= MIN_NODE_MAJOR ? ok("node", version) : failed("node", `${version} is older than ${MIN_NODE_MAJOR}`, install);
}

/** Install and update run one pinned pnpm through Node's corepack; a machine whose corepack cannot start it can install nothing. */
function pnpmCheck(deps: DoctorDeps): Check {
  const version = deps.pnpmVersion();
  return version === TOOL_PNPM_VERSION
    ? ok("pnpm", `${version}, which install and update use`)
    : failed("pnpm", version === null ? `pnpm ${TOOL_PNPM_VERSION} cannot run through the corepack beside node` : `pnpm ${TOOL_PNPM_VERSION} was asked for and ${version} answered`,
      `run \`corepack pnpm@${TOOL_PNPM_VERSION} --version\` to see why: Node ${MIN_NODE_MAJOR} ships corepack beside node, and reinstalling Node brings it back`);
}

function hostCheck(deps: DoctorDeps): { check: Check; settings: TicketSettings | null } {
  const path = hostFilePath(deps.env, deps.home, (file) => {
    try {
      return deps.readFile(file);
    } catch {
      return null;
    }
  });
  let text: string;
  try {
    text = deps.readFile(path);
  } catch {
    return { check: failed("host file", `${path} cannot be read`, "run `agent-org onboard`"), settings: null };
  }
  try {
    const settings = parseTicketSettings(JSON.parse(text), deps.home);
    return { check: ok("host file", `${path}: ${Object.keys(settings.clones).length} repositories`), settings };
  } catch (err) {
    return { check: failed("host file", `${path}: ${(err as Error).message}`, `fix the field it names, or run \`agent-org onboard\``), settings: null };
  }
}

function keyCheck(settings: TicketSettings | null, deps: DoctorDeps): Check {
  if (settings === null) return failed("tracker key", "not checked: the host file did not parse", "fix the host file first");
  const source = settings.linearKey;
  const where = "keychain" in source ? `Keychain service ${source.keychain}` : source.path;
  try {
    deps.readKey(source);
    const file = "keychain" in source ? null : source.path;
    const mode = file === null ? null : deps.mode(file);
    if (mode !== null && (mode & 0o077) !== 0) {
      return failed("tracker key", `${file} can be read by other users (mode ${(mode & 0o777).toString(8)})`, `chmod 600 ${file}`);
    }
    return ok("tracker key", `readable from ${where}`);
  } catch {
    return failed("tracker key", `nothing readable at ${where}`, "keychain" in source
      ? `security add-generic-password -a "$USER" -s ${source.keychain} -w`
      : `write your Linear personal API key to ${source.path} with mode 600, or run \`agent-org onboard\``);
  }
}

/** Linear's MCP, which workers and planners read their tickets through, connected for Claude Code. */
function linearMcpCheck(deps: DoctorDeps): Check {
  const listed = deps.mcpList();
  const add = "run `agent-org onboard`, which registers it with the Linear key, or `claude mcp add --scope user --transport http linear https://mcp.linear.app/mcp --header \"Authorization: Bearer <key>\"`";
  if (listed === null) return failed("linear mcp", "`claude mcp list` could not run", "install Claude Code and put `claude` on PATH, then run `agent-org onboard`");
  const line = listed.split("\n").find((entry) => entry.startsWith("linear:"));
  if (line === undefined) return failed("linear mcp", "Claude Code has no `linear` MCP, so workers cannot read their tickets", add);
  return /Connected/.test(line) ? ok("linear mcp", line.trim())
    : failed("linear mcp", line.trim(), "`claude mcp get linear` says why; a key that changed is fixed by `claude mcp remove linear --scope user`, then `agent-org onboard`");
}

/** The Linear tools a writer checks for duplicates with: either connector's read of a ticket, which a `tickets.connectors` entry must allow. */
const LINEAR_READS = ["mcp__linear__get_issue", "mcp__claude_ai_Linear__get_issue"];

/**
 * The ticket writer (A11-94). Always informational when `tickets.writer` is absent, which hides New ticket on the board. When it is named, it fails
 * if no `tickets.connectors` entry lets a worker read a Linear ticket, since the writer checks for duplicates that way, and says whether Grill is on.
 */
function writerCheck(settings: TicketSettings | null): Check {
  if (settings === null) return ok("ticket writer", "not checked: the host file did not parse");
  if (settings.writer === null) return ok("ticket writer", "no: New ticket is hidden, since tickets.writer is not named");
  const reads = settings.connectors.some((pattern) => LINEAR_READS.some((tool) => new RegExp(pattern).test(tool)));
  if (!reads) {
    return failed("ticket writer", "yes, but no tickets.connectors entry lets it read a Linear ticket, so it cannot check a new ticket for duplicates",
      "run `agent-org onboard`, which names the Linear reads in tickets.connectors");
  }
  return ok("ticket writer", settings.terminal === null ? "yes: New ticket is shown, and Grill is off until tickets.terminal is named" : "yes: New ticket is shown, and Grill is on");
}

/**
 * The `gh` wrapper's checks (A11-84): the installed copy is the one `host.json` declares, and each declared role mints. A role whose mint fails names the reason the
 * minter printed first, so a key that moved or an App that was removed is the one thing to fix.
 */
function ghWrapperChecks(report: GhWrapperReport): Check[] {
  if ("unchecked" in report) return [failed("gh wrapper", `cannot be checked: ${report.unchecked}`, "run `agent-org doctor` from the checkout that host.json's `tool` names")];
  const wrapper = report.divergence === null ? ok("gh wrapper", "the installed wrapper is the one host.json declares")
    : failed("gh wrapper", report.divergence, "run `agent-org host:install`, which renders the wrapper from host.json and writes it, or start the instance, which re-renders it");
  const mints = report.mints.map(({ role, failure }) => failure === null ? ok(`app token ${role}`, `the ${role} App mints a token`)
    : failed(`app token ${role}`, `the ${role} App's token mint failed: ${failure}`, `fix the key or the App host.json declares for ${role}, then run \`agent-org host:install\``));
  return [wrapper, ...mints];
}

/** The host file's text, or null when it cannot be read: the file a worker's `gh` account is named in. */
function hostText(deps: DoctorDeps): string | null {
  try {
    return deps.readFile(hostFilePath(deps.env, deps.home, (file) => {
      try {
        return deps.readFile(file);
      } catch {
        return null;
      }
    }));
  } catch {
    return null;
  }
}

const STACK_DOCS = "https://github.github.com/gh-stack/";

/**
 * The `github/gh-stack` extension a worker's `gh stack link` needs (A11-106), listed for the workers' account: a failure with the install command when it is
 * missing. Once it is listed, each GitHub repository a clone names is asked whether GitHub makes stacked pull requests available to it.
 */
function stackChecks(settings: TicketSettings | null, deps: DoctorDeps): Check[] {
  const name = "gh stack";
  const account = workerAccount(hostText(deps), deps.env);
  const listing = deps.ghAs(account)(["extension", "list"]);
  if (listing.status !== 0) {
    const why = listing.stderr.trim().split("\n")[0] || `exit ${listing.status}`;
    return [failed(name, `\`gh\` could not list its extensions, so the extension a worker links a stacked pull request with is not checked: ${why}`,
      "install the GitHub CLI and put `gh` on PATH, then run `agent-org onboard`")];
  }
  const found = stackExtensionIn(listing.stdout);
  if (found === null) {
    return [failed(name, "`gh stack` is not installed, so a worker cannot link a stacked pull request", `${installCommand(account)}, or run \`agent-org onboard\``)];
  }
  const scope = account.GH_CONFIG_DIR === undefined ? "this machine's gh account" : `GH_CONFIG_DIR=${account.GH_CONFIG_DIR}`;
  return [ok(name, `${STACK_EXTENSION} ${found.version} (for ${scope})`), ...stacksChecks(settings, account, deps)];
}

/** Whether GitHub makes stacked pull requests available to each GitHub repository a clone names. A host file with no GitHub clone adds no check. */
function stacksChecks(settings: TicketSettings | null, account: Account, deps: DoctorDeps): Check[] {
  const name = "stacked pull requests";
  if (settings === null) return [];
  const repos = [...new Set(Object.values(settings.clones).flatMap((path) => {
    const remote = deps.originOf(path);
    const repo = remote === null ? null : githubRepoOf(remote);
    return repo === null ? [] : [repo];
  }))];
  if (repos.length === 0) return [];
  const run = deps.ghAs(account);
  const readings = repos.map((repo) => [repo, stacksOf(run, repo)] as const);
  const refused = readings.filter(([, reading]) => reading.kind === "refused").map(([repo]) => repo);
  if (refused.length > 0) {
    return [failed(name, `GitHub refuses stacked pull requests for ${refused.join(", ")}`,
      `stacked pull requests are a GitHub preview that must be available to each repository: confirm ${refused.join(", ")} has access, or, where your organization controls previews, the organization, and that the workers' account can see it; see ${STACK_DOCS}`)];
  }
  const unread = readings.flatMap(([repo, reading]) => (reading.kind === "unknown" ? [`${repo}: ${reading.reason}`] : []));
  if (unread.length > 0) {
    return [failed(name, `GitHub's answer could not be read for ${unread.join("; ")}`, "run `gh api repos/<owner>/<repo>/stacks` with the workers' GH_CONFIG_DIR to see why")];
  }
  return [ok(name, `available for ${repos.join(", ")}`)];
}

/** Every check, in the order a person fixes them. */
export async function diagnose(deps: DoctorDeps): Promise<Check[]> {
  const { check: host, settings } = hostCheck(deps);
  const launcher = deps.which("agent-org");
  const herdr = deps.which("herdr");
  const instanceState = deps.serviceState("instance");
  const instance = await serviceChecks("instance", settings?.port ?? 4747, instanceState, deps);
  const ui = await serviceChecks("ui", settings?.uiPort ?? 4748, deps.serviceState("ui"), deps);
  return [
    nodeCheck(deps),
    pnpmCheck(deps),
    launcher === null
      ? failed("launcher", "`agent-org` is not on PATH", `add its directory to PATH: export PATH="$HOME/.local/bin:$PATH" in your shell's rc file`)
      : ok("launcher", launcher),
    host,
    ...ghWrapperChecks(await deps.ghWrapper()),
    ...stackChecks(settings, deps),
    herdr === null ? failed("herdr", "`herdr` is not on PATH", "install herdr, which runs the workers' terminals, and put it on PATH") : ok("herdr", herdr),
    keyCheck(settings, deps),
    linearMcpCheck(deps),
    writerCheck(settings),
    ...instance,
    ...herdrScopeChecks(settings, instanceState, deps),
    ...ui,
    ...await terminalChecks(settings, deps),
    ...await tailnetChecks(settings, deps),
    ok("pairing", PAIRING_STEPS),
    registeredCheck("auto-update", deps, "it runs `agent-org update` every hour"),
    updateLagCheck(settings?.updateMaxDeferHours ?? 2, deps),
  ];
}

/**
 * Whether a restart of the instance would interrupt the herdr server of its session (A11-90). A server still inside the instance's cgroup, started before
 * herdr got its own scope, is a failure with both fixes. Checked only when the instance is registered, and a host file names the session.
 */
function herdrScopeChecks(settings: TicketSettings | null, instanceState: ServiceState, deps: DoctorDeps): Check[] {
  if (settings === null || instanceState === "not-registered") return [];
  const session = settings.herdrSession;
  const name = "herdr scope";
  const isolation = deps.isolation(session);
  if (isolation.kind === "unknown") return [ok(name, `could not be checked, so a restart's reach into herdr is not known: ${isolation.why}`)];
  if (isolation.kind === "outside") {
    return [ok(name, isolation.scope === null ? `no herdr server runs for session ${session}, so a restart interrupts none`
      : `the herdr server for session ${session} is in ${isolation.scope}, outside the instance's cgroup`)];
  }
  const restart = `restart herdr when no run is working (\`herdr --session ${session} server stop\`; the next instance start launches it in its own scope)`;
  const fix = deps.platform === "linux"
    ? `${restart}, or add \`KillMode=process\` under \`[Service]\` in the instance unit, then \`systemctl --user daemon-reload\``
    : restart;
  return [failed(name, `the herdr server for session ${session} is in ${isolation.cgroup}, the same place as the instance (${isolation.unit}): a restart of the instance interrupts every worker`, fix)];
}

/** The hour the hourly update has to move a deferred install in, beyond `tickets.updateMaxDeferHours`, before `doctor` calls it late (A11-90). */
const UPDATE_GRACE_HOURS = 1;

/**
 * How far behind the newest release the install is, and since when (A11-90). It fails once the install has waited past `updateMaxDeferHours` plus an hour
 * of grace: the hourly update should have moved it by then. The status file is what the update last saw, and the local tags count the releases between.
 */
function updateLagCheck(maxDeferHours: number, deps: DoctorDeps): Check {
  const name = "update lag";
  const file = deps.updateStatus();
  if (file.kind === "absent") return ok(name, "no update has checked this install yet, so how far behind the latest release it is not known");
  if (file.kind === "unreadable") return failed(name, `the update status file cannot be read: ${file.why}`, "run `agent-org update`, which writes the file again, or check its permissions");
  const status = file.status;
  if (status.channel === "main") return ok(name, `follows main at ${status.installed}, which has no release to lag behind`);
  const { installed, latest } = status;
  if (!isReleaseTag(installed)) {
    return failed(name, `installed at ${installed}, which is not a release`, "run `agent-org update` to move it to the newest release");
  }
  if (!isReleaseTag(latest)) return failed(name, `latest is ${latest}, which is not a release`, "run `agent-org update` to check for the newest release again");
  if (compareReleaseTags(latest, installed) <= 0) return ok(name, `installed ${installed}, which is the latest release`);
  // The newest release may not be among the tags this checkout holds yet, so it is counted in either way.
  const releases = new Set([...deps.releaseTags(), latest]);
  const behind = [...releases].filter((tag) => compareReleaseTags(tag, installed) > 0 && compareReleaseTags(tag, latest) <= 0).length;
  const deferred = status.deferredSince === undefined ? "" : `; update deferred since ${status.deferredSince}: ${status.deferredReason ?? "a run is live"}`;
  const detail = `installed ${installed}, latest ${latest}: ${behind} ${behind === 1 ? "release" : "releases"} behind, since ${status.latestSince}${deferred}`;
  const waitedSince = Date.parse(status.deferredSince ?? status.latestSince);
  const limit = (maxDeferHours + UPDATE_GRACE_HOURS) * HOUR_MS;
  return deps.now() - waitedSince > limit
    ? failed(name, `${detail}; the hourly update should have moved it by now`, "run `agent-org update` (with `--force` to restart a live run too), then check `agent-org status auto-update`")
    : ok(name, detail);
}

/** The checks of one port `tickets.serve` puts on the tailnet: its entry, that it is not on Funnel, and that it answers under the machine's name. */
async function servedChecks(served: { service: string; port: number; local: number }, tailnet: { name: string; ip: string | null }, entries: ServeStatus, deps: DoctorDeps): Promise<Check[]> {
  const { service, port, local } = served;
  const { name, ip } = tailnet;
  const state = portState(entries, name, port, local);
  const url = `https://${name}:${port}/`;
  const setting = `tickets.servePorts.${service}`;
  const entry = state.kind === "ours" ? ok(`${service} tailnet entry`, `${url} serves 127.0.0.1:${local}`)
    : state.kind === "free" ? failed(`${service} tailnet entry`, `nothing serves port ${port} on the tailnet`, `run \`agent-org start ${service}\``)
      : failed(`${service} tailnet entry`, `port ${port} serves ${state.proxy ?? "another entry"} instead`, `set \`${setting}\` to a port nothing serves, then run \`agent-org start ${service}\``);
  const only = state.funnel
    ? failed(`${service} tailnet only`, `Funnel is on for port ${port}, which makes it public`, `turn Funnel off for port ${port} with \`tailscale funnel --https=${port} off\`, which leaves the other entries alone`)
    : ok(`${service} tailnet only`, `port ${port} is not on Funnel`);
  const answers = ip === null ? false : await deps.tailnetAnswers(ip, name, port);
  const answering = answers ? ok(`${service} tailnet answering`, `${url} answers`)
    : failed(`${service} tailnet answering`, `nothing answers ${url}`, state.kind === "ours" ? `read the service's log, then run \`agent-org start ${service}\` to restart it` : `run \`agent-org start ${service}\``);
  return [entry, only, answering];
}

/**
 * With `tickets.serve` set, the tailnet is checked as the board uses it: this machine is Running with a DNS name, and each served port has its entry,
 * is not on Funnel, and answers under the name. With it absent, no check is added, so the list is exactly today's.
 */
async function tailnetChecks(settings: TicketSettings | null, deps: DoctorDeps): Promise<Check[]> {
  if (settings === null || settings.serve === null) return [];
  const status = deps.tailscale(statusArgv());
  const self = status.status === 0 ? parseStatus(status.stdout) : null;
  if (self === null || !self.running || self.name === null) {
    if (status.status === null) return [failed("tailscale", "tailscale is not on PATH", "install Tailscale, then run `tailscale up`")];
    const detail = self === null ? "`tailscale status --json` did not answer" : !self.running ? `Tailscale is ${self.state}, not Running` : "this machine has no DNS name";
    return [failed("tailscale", detail, "run `sudo tailscale up`, and turn MagicDNS on in the admin console")];
  }
  const serve = deps.tailscale(serveStatusArgv());
  const entries = serve.status === 0 ? parseServeStatus(serve.stdout) : null;
  if (entries === null) return [ok("tailscale", `Running as ${self.name}`), failed("tailscale serve", "`tailscale serve status --json` did not answer", "run `sudo tailscale up`, then `agent-org doctor` again")];
  const local = loopbackPort(settings.terminal) ?? DEFAULT_TERMINAL_PORT;
  return [
    ok("tailscale", `Running as ${self.name}`),
    ...await servedChecks({ service: "ui", port: settings.serve.ui, local: settings.uiPort }, { name: self.name, ip: self.ip }, entries, deps),
    ...await servedChecks({ service: "terminal", port: settings.serve.terminal, local }, { name: self.name, ip: self.ip }, entries, deps),
  ];
}

/** Whether the tailnet address `ip` answers HTTPS under its MagicDNS `name` on `port`: any status under 500, since a stopped service behind serve answers 502. */
function tailnetAnswers(ip: string, name: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const call = httpsRequest({ host: ip, port, servername: name, path: "/", method: "GET", headers: { Host: tailnetHosts({ name, port })[0] }, timeout: ANSWER_TIMEOUT_MS }, (response) => {
      response.resume();
      done((response.statusCode ?? 500) < 500);
    });
    call.on("timeout", () => call.destroy());
    call.on("error", () => done(false));
    call.end();
  });
}

/** Whether `name` is registered, and loads: a unit systemd refuses is said with the line it refused. */
function registeredCheck(name: ServiceName, deps: DoctorDeps, what = ""): Check {
  const problem = deps.unitProblem(name);
  if (problem !== null) return failed(`${name} service`, problem, `run \`agent-org start ${name}\`, which writes the unit again`);
  const state = deps.serviceState(name);
  return state === "not-registered"
    ? failed(`${name} service`, `the ${name} service is not registered`, `run \`agent-org start ${name}\``)
    : ok(`${name} service`, `the ${name} service is registered and ${state}${what === "" ? "" : `: ${what}`}`);
}

/** `tickets.terminal` points at this machine's terminal service, which is registered and answers its health route. */
async function terminalChecks(settings: TicketSettings | null, deps: DoctorDeps): Promise<Check[]> {
  const address = settings?.terminal ?? null;
  const onboard = "run `agent-org onboard`, which installs herdr web ui, writes `tickets.terminal` and starts the terminal service";
  if (address !== null && loopbackPort(address) === null) return [ok("terminal address", `tickets.terminal is ${address}, served by another machine`)];
  const port = loopbackPort(address) ?? DEFAULT_TERMINAL_PORT;
  const registered = registeredCheck("terminal", deps);
  const answering = await deps.healthy(port);
  return [
    address === null
      ? failed("terminal address", "tickets.terminal is not set, so the board links no run to its terminal", onboard)
      : ok("terminal address", `tickets.terminal is ${address}`),
    registered.ok ? registered : { ...registered, fix: `${registered.fix}; if it refuses, ${onboard}` },
    answering
      ? ok("terminal answering", `http://127.0.0.1:${port}/api/health answers`)
      : failed("terminal answering", `nothing answers http://127.0.0.1:${port}/api/health`, "read the terminal service's log (`journalctl --user -u agent-org-terminal` on Linux, `~/.agent-org/logs/terminal.log` on macOS), then run `agent-org start terminal`"),
  ];
}

/**
 * Whether `name` is registered, and whether its port answers. The port is asked either way: a service started by hand answers without being
 * registered, and saying nothing answers then sends the person after a problem they do not have.
 */
async function serviceChecks(name: ServiceName, port: number, state: ServiceState, deps: DoctorDeps): Promise<Check[]> {
  const problem = deps.unitProblem(name);
  const answering = await deps.answers(port);
  const start = `run \`agent-org start ${name}\``;
  const notRegistered = answering
    ? failed(`${name} service`, `the ${name} service is not registered, but something answers on port ${port}: probably one started by hand`,
      `stop the one started by hand, then ${start}, so it starts at login and restarts after a crash`)
    : failed(`${name} service`, `the ${name} service is not registered`, start);
  return [
    problem !== null ? failed(`${name} service`, problem, `${start}, which writes the unit again`)
      : state === "not-registered" ? notRegistered : ok(`${name} service`, `the ${name} service is registered and ${state}`),
    answering
      ? ok(`${name} answering`, `http://127.0.0.1:${port} answers`)
      : failed(`${name} answering`, `nothing answers on http://127.0.0.1:${port}`, state === "running" ? `read the service's log, then ${start} to restart it` : start),
  ];
}

export function report(checks: readonly Check[]): string {
  return checks.map(({ name, ok: passed, detail, fix }) => (passed ? `ok    ${name}: ${detail}` : `FAIL  ${name}: ${detail}\n      fix: ${fix}`)).join("\n");
}

/** The release tags this checkout holds, read with git and no network: none when git cannot be run. */
function localReleaseTags(): string[] {
  const result = spawnSync("git", ["-C", TOOL_ROOT, "tag", "--list"], { encoding: "utf8", env: sandboxGitEnv() });
  return result.status === 0 ? result.stdout.split("\n").filter((name) => isReleaseTag(name)) : [];
}

function which(name: string, env: Env = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir !== "" && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

const ANSWER_TIMEOUT_MS = 2000;

/** Whether 127.0.0.1:`port` answers `path`: with anything, or with a 2xx when `healthy`. */
function answers(port: number, path = "/", { healthy = false }: { healthy?: boolean; } = {}): Promise<boolean> {
  return new Promise((done) => {
    const call = request({ host: "127.0.0.1", port, path, method: "GET", timeout: ANSWER_TIMEOUT_MS }, (response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      done(!healthy || (status >= 200 && status < 300));
    });
    call.on("timeout", () => call.destroy());
    call.on("error", () => done(false));
    call.end();
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  parseArgs({ args: process.argv.slice(2), strict: true });
  const services = defaultServiceDeps();
  const checks = await diagnose({
    env: process.env, home: homedir(),
    nodeVersion: () => {
      const result = spawnSync("node", ["--version"], { encoding: "utf8" });
      return result.status === 0 ? result.stdout.trim() : null;
    },
    which: (name) => which(name), readFile: (path) => readFileSync(path, "utf8"), readKey: (source) => readLinearKey(source),
    mode: (path) => { try { return statSync(path).mode & 0o777; } catch { return null; } },
    serviceState: (name) => serviceState(name, services), answers: (port) => answers(port),
    healthy: (port) => answers(port, "/api/health", { healthy: true }),
    unitProblem: (name) => unitProblem(name, services),
    mcpList: () => {
      const result = spawnSync("claude", ["mcp", "list"], { encoding: "utf8", timeout: 60_000 });
      return result.status === 0 ? result.stdout : null;
    },
    pnpmVersion: () => {
      const { command, args } = pinnedPnpm(["--version"]);
      const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
      return result.status === 0 ? result.stdout.trim() : null;
    },
    tailscale: (args) => runTailscale(args),
    tailnetAnswers,
    ghWrapper: async () => {
      try {
        const { ghWrapperReport } = await import("../host-units.ts");
        return ghWrapperReport();
      } catch (cause) {
        return { unchecked: String((cause as Error)?.message ?? cause).split("\n")[0] };
      }
    },
    ghAs: (account) => asAccount(defaultGh, account),
    originOf: (path) => {
      const result = spawnSync("git", ["-C", path, "remote", "get-url", "origin"], { encoding: "utf8" });
      return result.status === 0 ? result.stdout.trim() : null;
    },
    platform: process.platform,
    isolation: (session) => hostIsolation(services, session),
    updateStatus: () => readUpdateStatus(updateStatusPath(process.env, homedir())),
    releaseTags: localReleaseTags,
    now: () => Date.now(),
  });
  console.log(report(checks));
  process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
}
