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
// EACH PLUGIN `tickets.plugins` NAMES (A11-140) is checked as a worker's session gets it: it loads, and its declared contract matches the host's keys.
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
import type { ProviderBlock } from "../ticket-mode/providers.ts";
import { describeMoves, planHostFix, writeHostFix } from "./migrate-host.ts";
import { parseServeStatus, parseStatus, portState, runTailscale, serveStatusArgv, statusArgv, tailnetHosts, type ServeStatus, type TailscaleResult } from "../ticket-mode/tailnet.ts";
import { runPreflights, shellPreflight, type PreflightExec } from "../ticket-mode/preflight.ts";
import { hostFactsOf, type HostFacts, notProvidedWhy, providesSkill, type SkillRef, skillRefs } from "../ticket-mode/plugin-contract.ts";
import { pluginProblems, type PluginContract, type PluginProblems } from "../ticket-mode/plugins.ts";
import { deferralPath, readDeferral, type Deferral } from "./plugin-install.ts";
import { ticketFolder } from "../ticket-mode/ticket-paths.ts";
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
  /** Runs one `tickets.preflight` command; a shell when absent. A test injects one so no process runs. */
  preflight?: PreflightExec;
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
  /** The record of a conventions plugin refresh that a live run held back: none, a wait, or a record that cannot be read (A11-145). */
  pluginRefresh: () => Deferral;
  /** The release tags this checkout holds, with no network (A11-90). */
  releaseTags: () => string[];
  /**
   * The reviewer gate's refusal, or null when its modules load (A11-144): asked only when the reviewer is `atomic`. A test injects one, so no module is
   * loaded.
   */
  reviewerGate: () => Promise<string | null>;
  /** The exit status of `codex login status`, or null when it cannot run (A11-145): asked only when the reviewer is `atomic`. */
  codexStatus: () => number | null;
  /** Each plugin `tickets.plugins` names, as a session in `folder` gets it, and what is wrong with its contract (A11-140). A test injects one, so no install record, plugin file, version or `PATH` is read. */
  plugins: (input: { wanted: readonly string[]; folder: string; host: HostFacts }) => PluginProblems;
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

/**
 * `noProject` is true only for a host file that read, parsed and was accepted, and that declares no `primary` project: a machine that runs only the ticket
 * board keeps `clones` and `tickets` and installs no `gh` wrapper, which is rendered from the project's `host.json`. A file that failed any step is not that:
 * the check says why.
 */
function hostCheck(deps: DoctorDeps): { check: Check; settings: TicketSettings | null; noProject: boolean } {
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
    return { check: failed("host file", `${path} cannot be read`, "run `agent-org onboard`"), settings: null, noProject: false };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const settings = parseTicketSettings(parsed, deps.home);
    return { check: ok("host file", `${path}: ${Object.keys(settings.clones).length} repositories`), settings, noProject: !Object.hasOwn(parsed as object, "primary") };
  } catch (err) {
    return { check: failed("host file", `${path}: ${(err as Error).message}`, `fix the field it names, or run \`agent-org onboard\``), settings: null, noProject: false };
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
 * Each `plugin:skill` the writer's run names, of a plugin the session loads with a contract, with that contract (A11-139). Empty when the run names no such
 * skill, since a plugin that declares nothing is not checked.
 */
function namedWriters(settings: TicketSettings, plugins: PluginProblems | null): (PluginContract & { ref: SkillRef })[] {
  const contracts = plugins?.contracts ?? [];
  const named = skillRefs(hostFactsOf(settings)).filter(({ key }) => key === "writer");
  return named.flatMap((ref) => contracts.filter(({ name }) => name === ref.plugin).map((contract) => ({ ...contract, ref })));
}

/**
 * The ticket writer (A11-94). Always informational when `tickets.writer` is absent, which hides New ticket on the board. When it is named, it fails
 * if no `tickets.connectors` entry lets a worker read a Linear ticket, since the writer checks for duplicates that way, and says whether Grill is on.
 * Its skill is checked against the contract of the plugin that provides it (A11-139), never against the words of the instruction: a plugin's contract
 * that does not provide the skill fails it, and one that provides it says which plugin does.
 */
function writerCheck(settings: TicketSettings | null, plugins: PluginProblems | null): Check {
  if (settings === null) return ok("ticket writer", "not checked: the host file did not parse");
  if (settings.writer === null) return ok("ticket writer", "no: New ticket is hidden, since tickets.writer is not named");
  const reads = settings.connectors.some((pattern) => LINEAR_READS.some((tool) => new RegExp(pattern).test(tool)));
  if (!reads) {
    return failed("ticket writer", "yes, but no tickets.connectors entry lets it read a Linear ticket, so it cannot check a new ticket for duplicates",
      "run `agent-org onboard`, which names the Linear reads in tickets.connectors");
  }
  const grill = settings.terminal === null ? "Grill is off until tickets.terminal is named" : "Grill is on";
  const writers = namedWriters(settings, plugins);
  if (writers.length === 0) return ok("ticket writer", `yes: New ticket is shown, and ${grill}; its skill is not checked against a plugin's contract`);
  const unprovided = writers.find(({ contract, ref }) => !providesSkill(contract, ref));
  if (unprovided !== undefined) {
    const why = notProvidedWhy(unprovided.entry, unprovided.ref);
    return failed("ticket writer", why, fixOf(why));
  }
  return ok("ticket writer", `yes: New ticket is shown, and ${grill}; its skill is provided by ${writers[0].entry}`);
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
  if (settings !== null && !settings.stackRequired) return [];
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

/** The contract mismatch's fix, as `preflight`'s: the board refuses a run while one stands. */
const CONTRACT_FIX = "fix what the row says: the board refuses a run while a mismatch stands";
const NOT_CHECKED = "not checked: Claude Code's install record cannot be read for it";

/** The fix a `why` sentence ends with: what follows its last colon, since each one says what is wrong and then how to fix it (A11-140). */
function fixOf(why: string): string {
  const colon = why.lastIndexOf(": ");
  return colon < 0 ? why : why.slice(colon + 2);
}

/**
 * Each plugin `tickets.plugins` enables, as a worker's session gets it (A11-140): one check per entry, ok when it loads and its contract matches the host's
 * keys, else the sentence that names the mismatch. A contract row about a plugin that is not enabled belongs to no entry, so it is listed in `plugin contract`.
 * Nothing on a host file that did not parse or names no plugin, as `preflightChecks` says nothing on a host that names none. An unreadable record is not
 * checked and is no failure, since a run start is not refused by it either.
 */
function pluginChecks(settings: TicketSettings | null, plugins: PluginProblems | null): Check[] {
  if (settings === null || plugins === null) return [];
  const { states, rows } = plugins;
  const checks = states.plugins.map(({ plugin, loads, why }): Check => {
    const name = `plugin ${plugin}`;
    if (loads === false && why !== null) return failed(name, why, fixOf(why));
    if (loads !== true) return ok(name, NOT_CHECKED);
    const mismatches = rows.filter((row) => row.plugin === plugin);
    return mismatches.length === 0 ? ok(name, "loads for a worker's session, and no contract mismatch")
      : failed(name, mismatches.map((row) => row.why).join(" "), CONTRACT_FIX);
  });
  const unowned = rows.filter((row) => !settings.plugins.includes(row.plugin));
  return unowned.length === 0 ? checks : [...checks, failed("plugin contract", unowned.map((row) => row.why).join(" "), CONTRACT_FIX)];
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

/**
 * The plugins as a worker's session gets them, asked once a run for both the plugin checks and the ticket writer's (A11-139). Null when the host file did not
 * parse or names no plugin, so the install record is not asked of a host with none to check.
 */
function pluginsOf(settings: TicketSettings | null, deps: DoctorDeps): PluginProblems | null {
  if (settings === null || settings.plugins.length === 0) return null;
  return deps.plugins({ wanted: settings.plugins, folder: ticketFolder(settings, "<ticket>"), host: hostFactsOf(settings) });
}

/** What a block's settings came from, in the words a row gives: its block, the old keys it still reads, or the default it takes with no block. */
function sourceOf(settings: TicketSettings, block: ProviderBlock): string {
  const report = settings.providers.blocks[block];
  if (report.from === "block") return `from tickets.providers.${block}`;
  if (report.from === "default") return `no block: the default, ${DEFAULT_TEXT[block]}, applies`;
  const aliases = settings.providers.aliases.filter(({ new: place }) => place === `tickets.providers.${block}` || place.startsWith(`tickets.providers.${block}.`));
  return `from aliases (${aliases.map(({ old }) => old).join(", ")})`;
}

/** The default each block takes with no block and no alias, in the words doctor says it with. */
const DEFAULT_TEXT: Readonly<Record<ProviderBlock, string>> = {
  tracker: "linear, with the Keychain service agent-org-linear",
  codeHost: "github, with every role on a user account",
  publish: "none, which publishes nothing",
  reviewer: "none, which starts no reviewer",
  exposure: "local, on loopback with ports 4747 and 4748",
};

const PROVIDER_LABEL: Readonly<Record<ProviderBlock, string>> = {
  tracker: "tracker",
  codeHost: "code host",
  publish: "publisher",
  reviewer: "reviewer",
  exposure: "exposure",
};

/**
 * One check per provider (A11-144), named for it and its provider, ok when every check it summarises passes. Its detail says where its settings came
 * from, so a block a machine does not have is said to take the default.
 */
function providerRow(settings: TicketSettings, block: ProviderBlock, wrapped: readonly Check[]): Check {
  const name = `${PROVIDER_LABEL[block]} (${settings.providers.blocks[block].provider})`;
  const source = sourceOf(settings, block);
  const failing = wrapped.filter((check) => !check.ok);
  if (failing.length === 0) return ok(name, wrapped.length === 0 ? source : `${source}, and its checks pass`);
  return failed(name, `${source}: ${failing.map((check) => check.detail).join("; ")}`, failing[0].fix ?? "fix the check it summarises");
}

/**
 * Codex, which the atomic reviewer runs on (A11-145): on the path, and logged in. Onboard installs neither, since that needs the person's account, so each
 * failure names the one thing to do.
 */
function codexChecks(deps: DoctorDeps): Check[] {
  const path = deps.which("codex");
  if (path === null) return [failed("codex", "`codex` is not on PATH, so the atomic reviewer cannot run", "install Codex (`npm install -g @openai/codex`), then run `codex login`")];
  const status = deps.codexStatus();
  if (status === 0) return [ok("codex", `${path}, logged in`)];
  return [failed("codex", status === null ? `${path} could not run \`codex login status\`` : "Codex is not logged in", "run `codex login`, then `agent-org doctor` again")];
}

/**
 * The reviewer's row (A11-144), with the gate's check when the reviewer is `atomic`: the gate's modules must load, or no reviewer starts a run, and Codex
 * must be installed and logged in (A11-145). With no reviewer, the row says so and asks nothing.
 */
async function reviewerChecks(settings: TicketSettings, deps: DoctorDeps): Promise<Check[]> {
  if (settings.reviewer === null) return [providerRow(settings, "reviewer", [])];
  const refusal = await deps.reviewerGate();
  const gate = refusal === null ? ok("reviewer gate", "the gate's modules load") : failed("reviewer gate", refusal, "fix what it names: no reviewer starts while the gate does not load");
  const codex = codexChecks(deps);
  return [gate, ...codex, providerRow(settings, "reviewer", [gate, ...codex])];
}

/**
 * One FAIL row per old key the file still reads (A11-144): the key, and its place under `tickets.providers`. A host file with none is green here. The
 * fix is the same for every row, so the person runs it once.
 */
function aliasChecks(settings: TicketSettings | null): Check[] {
  if (settings === null) return [];
  return settings.providers.aliases.map(({ old, new: place, stale }) => failed(`alias ${old}`,
    `${old} is read as an alias; its place is ${place}${stale ? ", where its value already is, so it only needs removing" : ""}`, "agent-org doctor --fix"));
}

/** Every check, in the order a person fixes them. */
export async function diagnose(deps: DoctorDeps): Promise<Check[]> {
  const { check: host, settings, noProject } = hostCheck(deps);
  const launcher = deps.which("agent-org");
  const herdr = deps.which("herdr");
  const instanceState = deps.serviceState("instance");
  const instance = await serviceChecks("instance", settings?.port ?? 4747, instanceState, deps);
  const ui = await serviceChecks("ui", settings?.uiPort ?? 4748, deps.serviceState("ui"), deps);
  const plugins = pluginsOf(settings, deps);
  const gh = noProject ? [ok("gh wrapper", "not applicable: host.json declares no project, so this machine installs no wrapper")] : ghWrapperChecks(await deps.ghWrapper());
  const stack = stackChecks(settings, deps);
  const terminal = await terminalChecks(settings, deps);
  const tailnet = await tailnetChecks(settings, deps);
  const key = keyCheck(settings, deps);
  const linear = linearMcpCheck(deps);
  const codeHost = settings === null ? [] : [providerRow(settings, "codeHost", [...gh, ...stack])];
  const tracker = settings === null ? [] : [providerRow(settings, "tracker", [key, linear])];
  const exposure = settings === null ? [] : [providerRow(settings, "exposure", [...terminal, ...tailnet])];
  const publisher = settings === null ? [] : [providerRow(settings, "publish", [])];
  const reviewer = settings === null ? [] : await reviewerChecks(settings, deps);
  return [
    nodeCheck(deps),
    pnpmCheck(deps),
    launcher === null
      ? failed("launcher", "`agent-org` is not on PATH", `add its directory to PATH: export PATH="$HOME/.local/bin:$PATH" in your shell's rc file`)
      : ok("launcher", launcher),
    host,
    ...aliasChecks(settings),
    ...gh,
    ...stack,
    ...codeHost,
    herdr === null ? failed("herdr", "`herdr` is not on PATH", "install herdr, which runs the workers' terminals, and put it on PATH") : ok("herdr", herdr),
    key,
    linear,
    ...tracker,
    writerCheck(settings, plugins),
    ...pluginChecks(settings, plugins),
    ...await preflightChecks(settings, deps),
    ...instance,
    ...herdrScopeChecks(settings, instanceState, deps),
    ...ui,
    ...terminal,
    ...tailnet,
    ...exposure,
    ...publisher,
    ...reviewer,
    ok("pairing", PAIRING_STEPS),
    registeredCheck("auto-update", deps, "it runs `agent-org update` every hour"),
    updateLagCheck(settings?.updateMaxDeferHours ?? 2, deps),
    ...pluginRefreshChecks(deps),
  ];
}

/**
 * Each command of `tickets.preflight`, run now as the pool runs it before a start: a pass, or a failure with what the command printed, since a run starts only
 * while all of them pass. Nothing is run, and nothing said, on a host that names none. One command at a time, each its own line.
 */
async function preflightChecks(settings: TicketSettings | null, deps: DoctorDeps): Promise<Check[]> {
  const exec = deps.preflight ?? shellPreflight;
  const checks: Check[] = [];
  for (const command of settings?.preflight ?? []) {
    const result = await runPreflights([command], exec);
    checks.push(result.ok ? ok(`preflight ${command.name}`, "passes, so runs may start")
      : failed(`preflight ${command.name}`, result.reason, "fix what it says: the board starts no run while it fails"));
  }
  return checks;
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
  const fix = `restart herdr when no run is working (\`herdr --session ${session} server stop\`; the next instance start launches it in its own scope)`;
  return [failed(name, `the herdr server for session ${session} is in ${isolation.cgroup}, the same place as the instance (${isolation.unit}): a restart of the instance interrupts every worker`, fix)];
}

/** The conventions plugin refresh a live run held back (A11-145): one row while it waits, said as it is, since a wait is not a failure. */
function pluginRefreshChecks(deps: DoctorDeps): Check[] {
  const state = deps.pluginRefresh();
  if (state.kind === "none") return [];
  if (state.kind === "unreadable") return [failed("plugin refresh", state.why, "run `agent-org update` once no run is live: a refresh that runs removes the record")];
  return [ok("plugin refresh", `the conventions plugin refresh has waited since ${state.since}, with ${state.live} ${state.live === 1 ? "run" : "runs"} live, and runs at the next update with no run live`)];
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
    const detail = self === null ? "`tailscale status --json` did not answer" : self.running ? "this machine has no DNS name" : `Tailscale is ${self.state}, not Running`;
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

/**
 * `doctor --fix` (A11-144): moves the host file's old keys into the provider blocks, with a backup beside it. `--dry-run` says what it would move and
 * writes nothing. Returns the lines to print, and whether the run was refused, so the caller sets the exit code.
 */
async function fixHostFile(path: string, { dryRun, now }: { dryRun: boolean; now: Date }): Promise<{ lines: string[]; refused: boolean }> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { lines: [`${path} cannot be read`], refused: true };
  }
  let fix: Awaited<ReturnType<typeof planHostFix>>;
  try {
    fix = await planHostFix(text);
  } catch (err) {
    return { lines: [`${path} is not a host file doctor can migrate: ${(err as Error).message}`], refused: true };
  }
  if (fix.kind === "nothing") return { lines: [`${path}: ${fix.reason}; nothing is written`], refused: false };
  if (fix.kind === "refused") return { lines: [`${path}: ${fix.reason}`], refused: true };
  const moves = describeMoves(fix.moves).map((line) => `  ${line}`);
  if (dryRun) return { lines: [`${path}: would move, and nothing is written:`, ...moves, "diff:", ...fix.lines], refused: false };
  const backup = writeHostFix(path, text, fix.text, statSync(path).mode & 0o777, now);
  return { lines: [`${path}: moved, and the old file is kept at ${backup}:`, ...moves], refused: false };
}

/** The doctor's readings of this machine, each the real one: what `agent-org doctor` asks, and what onboard asks when it ends (A11-145). */
export function defaultDoctorDeps(): DoctorDeps {
  const services = defaultServiceDeps();
  return {
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
        const { ghWrapperReport } = await import("../host-units/gh-wrapper-and-notes.ts");
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
    pluginRefresh: () => readDeferral(deferralPath(process.env, homedir())),
    releaseTags: localReleaseTags,
    plugins: (input) => pluginProblems(input),
    reviewerGate: async () => {
      const port = await import("../ticket-mode/reviewer-port.ts");
      await port.loadReviewerGate();
      return port.reviewerRefusal();
    },
    codexStatus: () => spawnSync("codex", ["login", "status"], { encoding: "utf8", timeout: 60_000 }).status,
    now: () => Date.now(),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { fix: { type: "boolean" }, "dry-run": { type: "boolean" } }, strict: true });
  if (values["dry-run"] === true && values.fix !== true) {
    console.error("doctor: --dry-run says what --fix would move, so it needs --fix");
    process.exit(2);
  }
  if (values.fix === true) {
    const hostPath = hostFilePath(process.env, homedir(), (file) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return null;
      }
    });
    const fixed = await fixHostFile(hostPath, { dryRun: values["dry-run"] === true, now: new Date() });
    console.log(fixed.lines.join("\n"));
    if (fixed.refused || values["dry-run"] === true) process.exit(fixed.refused ? 1 : 0);
  }
  const checks = await diagnose(defaultDoctorDeps());
  console.log(report(checks));
  process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
}
