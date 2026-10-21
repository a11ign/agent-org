#!/usr/bin/env node
// @ts-check
// command: onboard -- set this machine up to run agent-org: its host file, its repositories, its services and its conventions plugin, from a profile (`--profile`) and the secrets it asks for
//
// IT ASKS FOR WHAT NO PROFILE OR FLAG GAVE, and only at a terminal. With `--profile <name>` (A11-145), onboard reads `<AGENT_ORG_HOME>/profiles/<name>.json` (or
// the path it names): a saved answer file that holds no secret. A profile that is absent is asked for at a terminal and written there, mode 600, so a copy
// of it sets up another machine; without one, it is refused by name. A profile holds the answers, the flags override them, and the ONLY questions asked of a
// complete profile are for the secrets: the Linear key, and the reviewer App's private key when its file is not there yet.
//
// WITHOUT `--profile`, onboard keeps what it did before: `--repo <name>=<path>` (repeated) names the checkouts a worker can choose from, and
// `--linear-keychain <service>` or `--linear-key-file <path>` names where the Linear key is read from. Without a terminal, what no flag gave is kept from the
// existing host file or refused by name.
//
// THE HOST FILE HAS ONE SHAPE: its providers are named blocks under `tickets.providers` (A11-144). An old key is moved into its block first, with a backup,
// as `doctor --fix` moves it. A key the host file already holds is kept as it is; onboard writes only the keys that are absent.
//
// IT SETS UP WHAT TICKET MODE NEEDS TO WORK OUT OF THE BOX:
//   - THE WEB TERMINAL (A11-66). Onboard installs bun when the machine has none (`bun.ts`), installs the plugin with
//     `herdr plugin install devswha/herdr-web-ui --yes`, writes the exposure block's `terminal` when it is absent, and starts the `terminal` service. A step
//     that fails is said with its reason and leaves `terminal` unwritten, so the board never links to a terminal nothing serves.
//   - LINEAR FOR THE WORKERS (A11-71). With a readable key and no `linear` MCP yet, onboard registers Linear's for Claude Code at user scope, authenticated by
//     that key, and lets the workers call its read and comment tools (`LINEAR_CONNECTORS`, in the tracker block). The key goes to `claude` as an argument and
//     is never printed: a message that would carry it carries `<key>` instead.
//   - THE CONVENTIONS PLUGIN (A11-145). The plugin is added from its repository as the person's own GitHub login, installed for every session, and its
//     declared contract sets the planner, the writer and the plan's file pattern (`plugin-install.ts`).
//   - THE HOUSE NOTES (A11-145): the worker's and the review's, written only where absent (`house-notes.ts`).
//   - THE REVIEWER'S APP (A11-145): its private key is copied to `<AGENT_ORG_HOME>/apps/<slug>.pem`, mode 600, and named in the host file.
//   - THE INTERIM GUARDS (A11-145) the hand-set gh-wrapper watchdog and herdr's KillMode drop-in are retired once their replacements are proven (`interim-guards.ts`).
//   - THE HOST FILE'S PATH, in `<home>/host-file` (A11-68), so a shell with no `AGENT_ORG_HOST` finds it.
//   - AUTO-UPDATE: the `auto-update` service runs `agent-org update` every hour. `--no-auto-update` leaves it unregistered, and `--update-channel main` makes it follow `main`.
//
// IT NEVER ECHOES A KEY. It stores one only when none is readable and a person is at the terminal: into the Keychain by `security`'s own prompt,
// which does not echo, or into a mode-600 file from a prompt that does not echo. It then reads the key back to check it is there, and says WHERE
// it is, never what it is. The reviewer App's key is copied and never printed.
//
// IT ENDS BY DIAGNOSING: the same checks `agent-org doctor` runs are printed, so the person sees whether the machine is ready.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { readLinearKey } from "../ticket-mode/linear.ts";
import type { KeySource } from "../ticket-mode/settings.ts";
import { resolveProviders } from "../ticket-mode/providers.ts";
import { readPluginContract, type Contract } from "../ticket-mode/plugin-contract.ts";
import { agentOrgHome, hostFilePath, hostPointerPath, readOrNull, type Env } from "./paths.ts";
import { ensureBun } from "./bun.ts";
import { chromiumProblems, chromiumReport, lacksLibraries, PLAYWRIGHT_CLI, type ChromiumReport } from "./chromium.ts";
import { defaultServiceDeps, ServiceRefusal, startService, TailnetRefusal, updateChannelPath, type RunResult, type ServiceName, type Started, type UpdateChannel } from "./service.ts";
import { DEFAULT_TERMINAL_PORT, herdrConfigDir, PAIRING_STEPS, pluginRoot, TERMINAL_PLUGIN, terminalAddress } from "./terminal.ts";
import { writeAtomic } from "./write-atomic.ts";
import { defaultGh } from "../lib/tool-version-agreement.ts";
import { asAccount, ensureStackExtension, STACK_EXTENSION, type Account, type ProgramRunner, type StackExtension } from "../ticket-port/stack-extension.ts";
import { installCommand, workerAccount } from "./stack-account.ts";
import { describeMoves, planHostFix, writeHostFix } from "./migrate-host.ts";
import { askProfile, parseProfile, profilePathOf, profileText, ProfileRefusal, providerBlocksOf, type Profile, type ProfileRepo, type ReviewerApp } from "./onboard-profile.ts";
import { installConventions, runProgram, stateOfRecord, type ConventionsStep } from "./plugin-install.ts";
import { houseNotes } from "./house-notes.ts";
import { retireGuards, type Replacements } from "./interim-guards.ts";
import { defaultDoctorDeps, diagnose, report, type Check } from "./doctor.ts";
import { hostIsolation } from "./update-safety.ts";
import { repoCloneArgs } from "../ticket-port/repo-args.ts";

export const DEFAULT_KEYCHAIN_SERVICE = "agent-org-linear";
export const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";
/** Linear's MCP tools a worker may call: its reads, and a comment on its own ticket. Never a save of an issue, a state or a relation. */
export const LINEAR_CONNECTORS = Object.freeze(["^mcp__linear__(get|list|search|extract)_", "^mcp__linear__save_comment$"]);

export type OnboardOptions = Readonly<{
  repos: readonly string[];
  keychain: string | undefined;
  keyFile: string | undefined;
  /** The profile to set up from: a name under `<AGENT_ORG_HOME>/profiles`, or a path with a `/` (`--profile`). Undefined keeps the flags-only path. */
  profile: string | undefined;
  start: boolean;
  /** Set up the web terminal (`--no-terminal` leaves it alone). */
  terminal: boolean;
  /** Register the auto-update service (`--no-auto-update` does not). */
  autoUpdate: boolean;
  /** The channel auto-update follows, written to `<home>/update-channel`; undefined leaves the file as it is. */
  updateChannel: UpdateChannel | undefined;
}>;

export type OnboardDeps = Readonly<{
  env: Env;
  home: string;
  platform: NodeJS.Platform;
  /** A person is at the terminal, so what no flag gave can be asked. */
  interactive: boolean;
  ask: (question: string) => Promise<string>;
  /** Ask without echoing what is typed. */
  askHidden: (question: string) => Promise<string>;
  readKey: (source: KeySource) => string;
  /** Store a key in the Keychain under `service`, by `security`'s own prompt. */
  storeInKeychain: (service: string) => void;
  readFile: (path: string) => string;
  writeFile: (path: string, text: string) => void;
  /** Whether a path exists: the profile, the guards, the plugin's record. */
  exists: (path: string) => boolean;
  /** Removes a file an interim guard leaves behind, once its replacement is proven. */
  removeFile: (path: string) => void;
  isDirectory: (path: string) => boolean;
  now: () => Date;
  /** The `bun` this machine has, installed into `~/.bun/bin` when it has none. */
  ensureBun: () => Promise<{ path: string; installed: boolean }>;
  /** The text of herdr's `plugins.json`, or null. */
  herdrPlugins: () => string | null;
  /** Run a program (`herdr`, `claude`, `gh`) with `env` added to this process's, and say what it returned. */
  run: (file: string, args: string[], env?: Env) => RunResult;
  /** The first executable called `name` on PATH, or null. */
  which: (name: string) => string | null;
  /** The exit status of `codex login status`, or null when it cannot run. */
  codexStatus: () => number | null;
  /** The GitHub CLI as `account` (A11-106): the gh stack extension is listed and installed through it. */
  ghAs: (account: Account) => ProgramRunner;
  /** Which replacements of the interim guards hold, read now (A11-145). */
  replacements: () => Promise<Replacements>;
  /** The checks `agent-org doctor` runs, read now: printed as onboard's last report (A11-145). */
  diagnose: () => Promise<Check[]>;
  /** The Chromium builds this machine has, read now: onboard installs what is missing, and says what it cannot (A11-151). */
  chromium: () => ChromiumReport;
  /** Whether this process runs as root, so the system libraries are installed without `sudo` (A11-151). */
  isRoot: () => boolean;
  /** Start the named services, in order. @returns one line per service */
  startServices: (names: readonly ServiceName[]) => string;
  out: Pick<Console, "log">;
}>;

export class OnboardRefusal extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const expandHome = (path: string, home: string) => (path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path);
const firstLine = (result: RunResult) => (result.stderr || result.stdout).trim().split("\n")[0] || `exit ${result.status}`;

/** `name=/path`, or a bare path named after its last directory. REFUSES a relative path and one that is not a directory. */
function parseRepo(text: string, deps: OnboardDeps): [string, string] {
  const at = text.indexOf("=");
  const [name, raw] = at > 0 ? [text.slice(0, at), text.slice(at + 1)] : [basename(text.replace(/\/+$/, "")), text];
  const path = expandHome(raw.trim(), deps.home);
  if (!isAbsolute(path)) throw new OnboardRefusal(`--repo ${text}: the checkout must be an absolute path`);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new OnboardRefusal(`--repo ${text}: a repository name is letters, digits, \`.\`, \`_\` and \`-\``);
  if (!deps.isDirectory(path)) throw new OnboardRefusal(`--repo ${text}: ${path} is not a directory`);
  return [name, resolve(path)];
}

/**
 * A profile's repository, as `[name, path]`. A checkout that is not there is cloned as the person's own GitHub login, when the profile names its repository;
 * one that is not there and has no repository to clone is refused by name.
 */
function repoOfProfile(repo: ProfileRepo, deps: OnboardDeps): [string, string] {
  const path = resolve(expandHome(repo.path, deps.home));
  if (!isAbsolute(path)) throw new OnboardRefusal(`repos ${repo.name}: the checkout must be an absolute path, or start with ~/`);
  if (!deps.isDirectory(path)) {
    if (repo.remote === undefined) throw new OnboardRefusal(`repos ${repo.name}: ${path} is not a directory, and the profile names no repository to clone it from`);
    const cloned = deps.ghAs({})(repoCloneArgs(repo.remote, path));
    if (cloned.status !== 0) throw new OnboardRefusal(`could not clone ${repo.remote} to ${path}: ${firstLine(cloned)}. Run \`gh auth login\`, then onboard again.`);
    deps.out.log(`cloned ${repo.remote} to ${path}`);
  }
  return [repo.name, path];
}

/** The host file's text, or null when it does not exist. */
function readHostText(path: string, deps: OnboardDeps): string | null {
  try {
    return deps.readFile(path);
  } catch {
    return null;
  }
}

/**
 * The host file as an object, moved to the one shape first: an old key is moved into its provider block with a backup beside the file, exactly as
 * `doctor --fix` moves it. A file that would read differently after the move is refused, and nothing is written.
 */
async function currentHost(path: string, deps: OnboardDeps): Promise<Record<string, unknown>> {
  const text = readHostText(path, deps);
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OnboardRefusal(`${path} is not valid JSON, so onboard will not write over it. Fix or move it, then run onboard again.`);
  }
  if (!isObject(parsed)) throw new OnboardRefusal(`${path} does not hold a JSON object`);
  const fix = await planHostFix(text);
  if (fix.kind === "refused") throw new OnboardRefusal(`${path}: ${fix.reason}`);
  if (fix.kind === "nothing") return parsed;
  const backup = writeHostFix(path, text, fix.text, 0o600, deps.now(), (file, body) => deps.writeFile(file, String(body)));
  deps.out.log(`moved the old keys in ${path} into its provider blocks, and kept the old file at ${backup}:\n  ${describeMoves(fix.moves).join("\n  ")}`);
  return JSON.parse(fix.text) as Record<string, unknown>;
}

/** The host file's `tickets` object, or `{}` when it has none. */
const ticketsOf = (host: Record<string, unknown>): Record<string, unknown> => (isObject(host.tickets) ? host.tickets : {});

/** `block` with each of `values` it does not hold yet: a key the block already holds is kept as it is (A11-145). */
function fill(block: unknown, values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const current = isObject(block) ? block : {};
  const missing = Object.entries(values).filter(([key, value]) => value !== undefined && current[key] === undefined);
  return { ...current, ...Object.fromEntries(missing) };
}

/**
 * The profile to set up from: read when its file is there, else asked for at a terminal and written there (mode 600), else refused by name. The questions
 * are asked of the repositories `--repo` names, or asked for when none was given.
 */
async function profileFor(options: OnboardOptions, deps: OnboardDeps): Promise<Profile> {
  const path = profilePathOf(options.profile ?? "", deps.env, deps.home);
  if (deps.exists(path)) {
    try {
      return parseProfile(deps.readFile(path));
    } catch (err) {
      if (err instanceof ProfileRefusal) throw new OnboardRefusal(`${path}: ${err.message}`);
      throw err;
    }
  }
  if (!deps.interactive) {
    throw new OnboardRefusal(`there is no profile at ${path}. A profile is the answers onboard asks, saved as JSON with no secret in it; run \`agent-org onboard --profile ${options.profile}\` at a terminal to answer them and write it there, or copy one from another machine to ${path}.`);
  }
  const repos = options.repos.length > 0 ? options.repos : await askRepositories(deps);
  const pairs = repos.map((text) => parseRepo(text, deps));
  const profile = await askProfile({ ask: deps.ask }, pairs.map(([name, repoPath]) => ({ name, path: repoPath })));
  deps.writeFile(path, profileText(profile));
  deps.out.log(`wrote the answers to ${path}, mode 600: a copy of it sets up another machine, and holds no secret`);
  return profile;
}

/** The repositories a person names at a terminal, one per line, until an empty line. */
async function askRepositories(deps: OnboardDeps): Promise<string[]> {
  deps.out.log("Name the repositories a worker can choose from: one checkout path per line, or name=path. An empty line finishes.");
  const repos: string[] = [];
  for (let line = (await deps.ask("Repository: ")).trim(); line !== ""; line = (await deps.ask("Repository: ")).trim()) repos.push(line);
  return repos;
}

/** The key source a flag or the host file names, or undefined when neither does. */
function explicitKeySource(options: OnboardOptions, existing: unknown, deps: OnboardDeps): KeySource | undefined {
  if (options.keychain !== undefined && options.keyFile !== undefined) throw new OnboardRefusal("give --linear-keychain or --linear-key-file, not both");
  if (options.keychain !== undefined) return { keychain: keychainService(options.keychain) };
  if (options.keyFile !== undefined) {
    const path = expandHome(options.keyFile, deps.home);
    if (!isAbsolute(path)) throw new OnboardRefusal("--linear-key-file must be an absolute path");
    return { path };
  }
  return typeof existing === "object" && existing !== null ? (existing as KeySource) : undefined;
}

/** Where the OS keeps the Linear key when no one names it: the Keychain on a Mac, a mode-600 file elsewhere. */
function fallbackKeySource(deps: OnboardDeps): KeySource {
  return deps.platform === "darwin" ? { keychain: DEFAULT_KEYCHAIN_SERVICE } : { path: join(agentOrgHome(deps.env, deps.home), "linear.key") };
}

/** The place a person names at a terminal for the Linear key, or the fallback when they name none. */
async function askKeySource(deps: OnboardDeps): Promise<KeySource> {
  const fallback = fallbackKeySource(deps);
  const answer = (await deps.ask(`Where is the Linear key read from? A Keychain service name, or an absolute file path [${"keychain" in fallback ? fallback.keychain : fallback.path}]: `)).trim();
  if (answer === "") return fallback;
  const path = expandHome(answer, deps.home);
  return isAbsolute(path) ? { path } : { keychain: keychainService(answer) };
}

/** A Keychain service name is printed in a command to paste, so it is held to characters a shell reads as they are. */
function keychainService(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new OnboardRefusal(`\`${name}\` is not a Keychain service name: use letters, digits, \`.\`, \`_\` and \`-\``);
  return name;
}

const describe = (source: KeySource) => ("keychain" in source ? `the Keychain service ${source.keychain}` : `the file ${source.path}`);

function keyReadable(source: KeySource, deps: OnboardDeps): boolean {
  try {
    deps.readKey(source);
    return true;
  } catch {
    return false;
  }
}

/** Store a key where `source` says, by a prompt that does not echo. Only called with a person at the terminal. */
async function storeKey(source: KeySource, deps: OnboardDeps) {
  if ("keychain" in source) {
    deps.out.log(`Paste your Linear personal API key at the Keychain prompt (it is not shown). It is stored under ${source.keychain}.`);
    deps.storeInKeychain(source.keychain);
    return;
  }
  const key = (await deps.askHidden(`Paste your Linear personal API key (it is not shown). It is written to ${source.path}, mode 600: `)).trim();
  if (key === "") return;
  deps.writeFile(source.path, `${key}\n`);
}

/**
 * The reviewer App's identity, as the host file holds it: the one already there when its key is readable, else the App the profile names with its key copied
 * to `<AGENT_ORG_HOME>/apps/<slug>.pem` (mode 600). The key's path is asked for, and its text is never printed. Null when there is no App to name, or no key.
 */
async function reviewerIdentity(app: ReviewerApp | undefined, existing: unknown, deps: OnboardDeps): Promise<Record<string, unknown> | null> {
  const current = isObject(existing) && isObject(existing.reviewer) ? existing.reviewer : null;
  if (current !== null && typeof current.keyPath === "string" && deps.exists(current.keyPath)) return current;
  if (app === undefined) return null;
  if (!deps.interactive) {
    deps.out.log(`NO reviewer App key is set for ${app.slug}. Run \`agent-org onboard --profile <name>\` at a terminal, which asks for the path of the App's downloaded .pem file.`);
    return null;
  }
  const answer = (await deps.ask(`Path to the downloaded private key (.pem) of the reviewer App ${app.slug}, or an empty line to add it later: `)).trim();
  if (answer === "") return null;
  const source = expandHome(answer, deps.home);
  if (!isAbsolute(source)) throw new OnboardRefusal("the reviewer App's key must be an absolute path");
  let key: string;
  try {
    key = deps.readFile(source);
  } catch {
    throw new OnboardRefusal(`the reviewer App's key cannot be read at ${source}`);
  }
  const keyPath = join(agentOrgHome(deps.env, deps.home), "apps", `${app.slug}.pem`);
  deps.writeFile(keyPath, key);
  deps.out.log(`copied the reviewer App's key to ${keyPath}, mode 600; its text is not shown`);
  return { mode: "github-apps", slug: app.slug, appId: app.appId, installationId: app.installationId, keyPath };
}

/** The services onboard starts: the instance and the ui always, then the terminal when it is set up and auto-update unless opted out. */
export function onboardServices({ terminal, autoUpdate }: { terminal: boolean; autoUpdate: boolean; }): ServiceName[] {
  return ["instance", "ui", ...(terminal ? ["terminal" as const] : []), ...(autoUpdate ? ["auto-update" as const] : [])];
}

/** The services onboard REQUIRES: one of these refusing to start fails onboard, and any other is said and passed over. */
const REQUIRED: readonly ServiceName[] = ["instance", "ui"];

/** Start `names`, in order. @returns one line per service */
export function startServices(names: readonly ServiceName[], start: (name: ServiceName) => Started): string {
  return names.map((name) => {
    try {
      const unit = start(name);
      return `started the ${name} service (${unit.manager} ${unit.id})${unit.address === null ? "" : `, on the tailnet at ${unit.address}`}`;
    } catch (err) {
      if (REQUIRED.includes(name) || !(err instanceof ServiceRefusal)) throw err;
      // A service that started on loopback and that the tailnet does not reach is running: its message says so, and is said as it is.
      if (err instanceof TailnetRefusal) return err.message;
      return `did not start the ${name} service: ${err.message}`;
    }
  }).join("\n");
}

/** `text` with every occurrence of `secret` replaced by `<key>`, for a message a program that was handed the key may echo. */
const scrub = (text: string, secret: string) => (secret === "" ? text : text.split(secret).join("<key>"));

/**
 * Install bun and herdr web ui when they are missing. @returns whether the terminal service can run. A step that fails is said, with why,
 * and answers false: the web terminal is a convenience, and an install without it still runs tickets.
 */
async function setUpTerminal(deps: OnboardDeps): Promise<boolean> {
  try {
    const bun = await deps.ensureBun();
    if (bun.installed) deps.out.log(`installed bun at ${bun.path}, for the web terminal`);
    if (pluginRoot(deps.herdrPlugins()) === null) {
      const bunDir = bun.path.slice(0, bun.path.lastIndexOf("/"));
      // The plugin's build runs `bun install`, so bun's directory leads the PATH it runs with.
      const installed = deps.run("herdr", ["plugin", "install", TERMINAL_PLUGIN, "--yes"], { PATH: `${bunDir}:${deps.env.PATH ?? "/usr/bin:/bin"}` });
      if (installed.status !== 0) throw new OnboardRefusal(`\`herdr plugin install ${TERMINAL_PLUGIN} --yes\` failed: ${firstLine(installed)}`);
      if (pluginRoot(deps.herdrPlugins()) === null) throw new OnboardRefusal(`herdr installed ${TERMINAL_PLUGIN}, but its plugins.json does not list it`);
      deps.out.log(`installed the herdr plugin ${TERMINAL_PLUGIN}, the web terminal`);
    }
    return true;
  } catch (err) {
    deps.out.log(`the web terminal is not set up: ${(err as Error).message}. The board shows no terminal link until it is; fix that, then run \`agent-org onboard\` again.`);
    return false;
  }
}

/**
 * Install the browsers `ticket:capture` drives, as the person who runs onboard, without root, and check that both builds start. The system libraries are
 * installed only when this process is root or `sudo -n` works; otherwise the command is said, as the other steps say theirs, and onboard goes on (A11-151).
 * @returns whether both builds start, which is what sets `tickets.capture`.
 */
function setUpChromium(deps: OnboardDeps): boolean {
  const browsers = deps.run("node", [PLAYWRIGHT_CLI, "install", "chromium"]);
  if (browsers.status !== 0) deps.out.log(`the Chromium browsers did not install: ${firstLine(browsers)}`);
  let report = deps.chromium();
  if (lacksLibraries(report)) {
    const canInstall = deps.isRoot() || deps.run("sudo", ["-n", "true"]).status === 0;
    if (canInstall) {
      const libraries = deps.isRoot()
        ? deps.run("node", [PLAYWRIGHT_CLI, "install-deps", "chromium"])
        : deps.run("sudo", ["-n", "node", PLAYWRIGHT_CLI, "install-deps", "chromium"]);
      if (libraries.status !== 0) deps.out.log(`the Chromium libraries did not install: ${firstLine(libraries)}`);
      report = deps.chromium();
    }
  }
  const problems = chromiumProblems(report);
  for (const line of problems) deps.out.log(line);
  return problems.length === 0;
}

/** Register Linear's MCP for Claude Code at user scope, unless a `linear` MCP is there already. Says what it did, never the key. */
function registerLinearMcp(source: KeySource, deps: OnboardDeps) {
  if (deps.run("claude", ["mcp", "get", "linear"]).status === 0) {
    deps.out.log("Claude Code has a `linear` MCP already, so onboard left it as it is");
    return;
  }
  const key = deps.readKey(source).trim();
  const added = deps.run("claude", ["mcp", "add", "--scope", "user", "--transport", "http", "linear", LINEAR_MCP_URL, "--header", `Authorization: Bearer ${key}`]);
  deps.out.log(added.status === 0
    ? `registered Linear's MCP for Claude Code (user scope), authenticated by the key in ${describe(source)}`
    : `could not register Linear's MCP for Claude Code: ${scrub(firstLine(added), key)}. Workers cannot read Linear until it is; run \`agent-org onboard\` again, or \`claude mcp add --scope user --transport http linear ${LINEAR_MCP_URL} --header "Authorization: Bearer <key>"\``);
}

/**
 * What onboard says of the stack extension, whatever the install did. A failure is said with its reason and the command to run by hand, and is not thrown:
 * the extension serves stacked pull requests only, and doctor fails on it until it is there.
 */
function stackLine(stack: StackExtension, account: Account): string {
  if (stack.state === "present") return `the ${STACK_EXTENSION} extension is installed (${stack.version}), which a worker links a stacked pull request with`;
  if (stack.state === "installed") return `installed the ${STACK_EXTENSION} extension (${stack.version}), which a worker links a stacked pull request with`;
  return `could not install the ${STACK_EXTENSION} extension: ${stack.reason}. Run \`${installCommand(account)}\` by hand, then \`agent-org doctor\`.`;
}

/** The lines of Codex the atomic reviewer needs, each with whether it is done already (A11-145). Onboard installs and logs in to neither. */
function codexChecklist(deps: OnboardDeps): string[] {
  const installed = deps.which("codex") !== null;
  const loggedIn = installed && deps.codexStatus() === 0;
  return [
    installed ? "Codex is installed: done" : "install Codex, which the atomic reviewer runs on: `npm install -g @openai/codex`",
    loggedIn ? "Codex is logged in: done" : "log in to Codex: `codex login`, with the account the reviewer should use",
  ];
}

/** The conventions plugin's install, as onboard runs it: from its repository, for every session, and read back (`plugin-install.ts`). */
function installPlugin(conventions: NonNullable<Profile["conventions"]>, deps: OnboardDeps): ConventionsStep {
  return installConventions({ plugin: conventions.plugin, repo: conventions.marketplace }, {
    run: deps.run,
    stateOf: stateOfRecord(deps.home, { read: deps.readFile, exists: deps.exists, record: join(deps.home, ".claude", "plugins", "installed_plugins.json") }),
  }, deps.ghAs({}));
}

/** The contract the plugin declares in its installed manifest, or null when it declares none this reads; a malformed one is said, and not used. */
function contractOf(installPath: string, deps: OnboardDeps): Contract | null {
  const read = readPluginContract(installPath, { read: deps.readFile });
  if (read.kind === "found") return read.contract;
  if (read.kind === "malformed") deps.out.log(`the plugin's declared contract is malformed, so its skills are not set: ${read.why}`);
  return null;
}

/** `connectors` with Linear's read and comment tools added where absent. A value that is not a list is left for the host reader to refuse. */
function withLinearConnectors(connectors: unknown): unknown {
  if (connectors === undefined) return [...LINEAR_CONNECTORS];
  if (!Array.isArray(connectors)) return connectors;
  return [...connectors, ...LINEAR_CONNECTORS.filter((pattern) => !connectors.includes(pattern))];
}

/** The keys a conventions plugin sets: the plugin, and the plan's file pattern with the planner and writer runs its contract provides (A11-137). */
function conventionKeys(plugin: string, contract: Contract | null): Record<string, unknown> {
  const planner = contract?.provides.planner;
  const writer = contract?.provides.writer;
  return {
    plugins: [plugin],
    ...(planner === undefined ? {} : {
      plan: "-plan-[^/]*\\.md$",
      planner: { run: `Run the ${planner.skill} skill with this request: unattended: plan {keys} into {dir}` },
    }),
    ...(writer === undefined ? {} : { writer: { run: `Run the ${writer.skill} skill for this request: {request}. Write each draft under {dir}/drafts.` } }),
  };
}

type PlannedBlocks = ReturnType<typeof providerBlocksOf>;

/** The clone map: the profile's repositories, then the `--repo` flags, which override them by name. A checkout a profile names that is missing is cloned. */
async function clonesOf(options: OnboardOptions, profile: Profile | null, host: Record<string, unknown>, deps: OnboardDeps): Promise<Record<string, string>> {
  const clones: Record<string, string> = isObject(host.clones) ? { ...(host.clones as Record<string, string>) } : {};
  for (const repo of profile?.repos ?? []) {
    const [name, path] = repoOfProfile(repo, deps);
    clones[name] = path;
  }
  const repos = profile === null && options.repos.length === 0 && deps.interactive ? await askRepositories(deps) : options.repos;
  for (const repo of repos) {
    const [name, path] = parseRepo(repo, deps);
    clones[name] = path;
  }
  if (Object.keys(clones).length === 0) throw new OnboardRefusal("no repository to offer: give at least one --repo <name>=<path>, or a profile that names one");
  return clones;
}

/** The provider blocks onboard fills: the profile's, with the Linear key's place, the reviewer's identity and the terminal the exposure takes. */
function blocksOf({ planned, source, identity, terminal }: Readonly<{ planned: PlannedBlocks | null; source: KeySource; identity: Record<string, unknown> | null; terminal: boolean }>): Record<string, Record<string, unknown> | undefined> {
  return {
    tracker: { ...(planned?.tracker ?? { provider: "linear" }), key: source },
    codeHost: planned === null ? undefined : { ...planned.codeHost, identity: identity === null ? undefined : { reviewer: identity } },
    publish: planned?.publish,
    reviewer: planned?.reviewer,
    exposure: { ...(planned?.exposure ?? { provider: "local" }), terminal: terminal ? terminalAddress(DEFAULT_TERMINAL_PORT) : undefined },
  };
}

/**
 * The providers block by block. Each planned block is filled, never overwritten: a key the host file holds is kept, and a block a profile does not name is left
 * alone.
 */
function providersWith(tickets: Record<string, unknown>, blocks: Record<string, Record<string, unknown> | undefined>): Record<string, unknown> {
  const providers: Record<string, unknown> = isObject(tickets.providers) ? { ...tickets.providers } : {};
  for (const [name, values] of Object.entries(blocks)) {
    if (values !== undefined) providers[name] = fill(providers[name], values);
  }
  return providers;
}

/** The tracker block with Linear's read and comment tools in its connectors where absent: a list an old key moved into it still lacks them. */
function withLinearReads(tracker: unknown): Record<string, unknown> {
  const block = fill(tracker, {});
  return { ...block, connectors: withLinearConnectors(block.connectors) };
}

/** The host file, its pointer and, when one is given, the update channel: each written whole, and the repositories it offers said. */
function writeHostFiles({ hostFile, next, updateChannel }: Readonly<{ hostFile: string; next: Record<string, unknown>; updateChannel: UpdateChannel | undefined }>, deps: OnboardDeps) {
  deps.writeFile(hostFile, `${JSON.stringify(next, null, 2)}\n`);
  deps.writeFile(hostPointerPath(deps.env, deps.home), `${hostFile}\n`);
  if (updateChannel !== undefined) deps.writeFile(updateChannelPath(deps.env, deps.home), `${updateChannel}\n`);
  const names = Object.keys(next.clones as Record<string, string>).sort();
  deps.out.log(`wrote ${hostFile}: ${names.length} repositories (${names.join(", ")})`);
}

/** Where the Linear key is, once it reads. Says where, never what. */
const keyFoundLine = (source: KeySource) => `the Linear key is readable from ${describe(source)}`;

/** The command that stores a Linear key the machine cannot read yet, said with where it goes. */
function keyMissingLine(source: KeySource): string {
  const store = "keychain" in source ? `Store one with: security add-generic-password -a "$USER" -s ${source.keychain} -w` : `Write it to ${source.path} with mode 600`;
  return `NO LINEAR KEY is readable from ${describe(source)}. ${store}, then run \`agent-org doctor\`.`;
}

/** What onboard does once the host file is written: the stack extension, the key, Linear's MCP, Codex, the guards, the services, and the doctor's report. */
async function finishOnboard({ next, options, source, terminal }: Readonly<{ next: Record<string, unknown>; options: OnboardOptions; source: KeySource; terminal: boolean }>, deps: OnboardDeps) {
  const written = resolveProviders(next).blocks;
  if (written.exposure.provider === "tailscale" && deps.which("tailscale") === null) {
    deps.out.log("tailscale is not on PATH: the board and the terminal are served on the tailnet once Tailscale is installed and `tailscale up` has run. `agent-org doctor` says what is missing");
  }
  const account = workerAccount(JSON.stringify(next), deps.env);
  if (written.codeHost.settings.stack.value !== false) deps.out.log(stackLine(ensureStackExtension(deps.ghAs(account)), account));
  const readable = keyReadable(source, deps);
  deps.out.log(readable ? keyFoundLine(source) : keyMissingLine(source));
  if (readable) registerLinearMcp(source, deps);
  if (written.reviewer.provider === "atomic") for (const line of codexChecklist(deps)) deps.out.log(line);
  const guards = await retireGuards({ platform: deps.platform, env: deps.env, home: deps.home, exists: deps.exists, remove: deps.removeFile, run: deps.run, replacements: deps.replacements });
  for (const line of guards) deps.out.log(line);
  if (options.start) deps.out.log(deps.startServices(onboardServices({ terminal, autoUpdate: options.autoUpdate })));
  deps.out.log(report(await deps.diagnose()));
  deps.out.log(PAIRING_STEPS);
}

/** Write the host file and the notes, install the conventions plugin, and start the services. @returns the host file's path */
export async function onboard(options: OnboardOptions, deps: OnboardDeps): Promise<string> {
  const hostFile = hostFilePath(deps.env, deps.home, (path) => readHostText(path, deps));
  const profile = options.profile === undefined ? null : await profileFor(options, deps);
  const host = await currentHost(hostFile, deps);
  const tickets = ticketsOf(host);
  const clones = await clonesOf(options, profile, host, deps);

  const existing = resolveProviders(host).blocks;
  const source = explicitKeySource(options, existing.tracker.settings.key.value, deps) ?? (profile === null && deps.interactive ? await askKeySource(deps) : fallbackKeySource(deps));
  if (!keyReadable(source, deps) && deps.interactive) await storeKey(source, deps);
  const readable = keyReadable(source, deps);

  const planned = profile === null ? null : providerBlocksOf(profile);
  const identity = await reviewerIdentity(planned?.reviewerApp, existing.codeHost.settings.identity.value, deps);
  const terminal = options.terminal && await setUpTerminal(deps);
  const capture = setUpChromium(deps);
  const plugin = profile?.conventions === undefined ? null : installPlugin(profile.conventions, deps);
  for (const line of plugin?.lines ?? []) deps.out.log(line);
  const contract = plugin?.installPath === null || plugin === null ? null : contractOf(plugin.installPath, deps);
  const notes = profile === null ? null : houseNotes({ env: deps.env, home: deps.home, keys: tickets, exists: deps.exists, read: deps.readFile, profile: profile.notes });
  for (const line of notes?.lines ?? []) deps.out.log(line);
  for (const write of notes?.writes ?? []) deps.writeFile(write.path, write.text);

  const providers = providersWith(tickets, blocksOf({ planned, source, identity, terminal }));
  // A flag names the key outright, as it always did: it replaces the one the host file holds. Without a flag, the host file's key is kept.
  if (options.keychain !== undefined || options.keyFile !== undefined) providers.tracker = { ...fill(providers.tracker, {}), key: source };
  if (readable) providers.tracker = withLinearReads(providers.tracker);
  const pluginKeys = plugin?.installPath === null || plugin === null ? {} : conventionKeys(profile?.conventions?.plugin ?? "", contract);
  const prReview = profile?.conventions?.prReview === true ? contract?.provides.prReview?.skill : undefined;
  // `tickets.capture` is written only where it is absent, and only as true: a machine whose browsers do not start keeps what the host file says, or nothing.
  const next = { ...host, clones, tickets: fill({ ...tickets, providers }, { pick: planned?.pick, ...pluginKeys, prReview, ...(notes?.keys ?? {}), capture: capture || undefined }) };
  writeHostFiles({ hostFile, next, updateChannel: options.updateChannel }, deps);
  await finishOnboard({ next, options, source, terminal }, deps);
  return hostFile;
}

/** A readline whose output can be muted, so what is typed after the question is not echoed. */
async function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done(); } });
  const lines = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = lines.question(question);
    muted = true;
    return await answer;
  } finally {
    process.stdout.write("\n");
    lines.close();
  }
}

async function ask(question: string): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await lines.question(question);
  } finally {
    lines.close();
  }
}

/** The first executable called `name` on PATH, or null. */
const whichOn = (name: string, env: Env): string | null => (env.PATH ?? "").split(delimiter).filter((dir) => dir !== "")
  .map((dir) => join(dir, name)).find((path) => existsSync(path)) ?? null;

/** Which replacements of the interim guards hold now: the installed gh wrapper is the one host.json declares, and herdr is outside the instance's cgroup. */
/** The herdr session the host file names, or `tickets` when it names none or cannot be read. */
function herdrSessionOf(env: Env, home: string): string {
  try {
    const named = (JSON.parse(readFileSync(hostFilePath(env, home), "utf8")) as { tickets?: { herdrSession?: unknown } }).tickets?.herdrSession;
    return typeof named === "string" ? named : "tickets";
  } catch {
    return "tickets";
  }
}

async function replacementsNow(env: Env, home: string): Promise<Replacements> {
  const { ghWrapperReport } = await import("../host-units/gh-wrapper-and-notes.ts");
  const wrapper: { divergence?: unknown } = await ghWrapperReport();
  return {
    ghWrapperDeclared: "divergence" in wrapper && wrapper.divergence === null,
    herdrOutsideInstance: hostIsolation(defaultServiceDeps(), herdrSessionOf(env, home)).kind === "outside",
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2), strict: true,
      options: {
        repo: { type: "string", multiple: true, default: [] }, "linear-keychain": { type: "string" }, "linear-key-file": { type: "string" },
        profile: { type: "string" }, "no-start": { type: "boolean", default: false }, "no-terminal": { type: "boolean", default: false },
        "no-auto-update": { type: "boolean", default: false }, "update-channel": { type: "string" },
      },
    });
    const channel = values["update-channel"];
    if (channel !== undefined && channel !== "release" && channel !== "main") throw new OnboardRefusal(`--update-channel ${channel} is not release or main`);
    const services = defaultServiceDeps();
    const home = homedir();
    await onboard({
      repos: values.repo, keychain: values["linear-keychain"], keyFile: values["linear-key-file"], profile: values.profile, start: !values["no-start"],
      terminal: !values["no-terminal"], autoUpdate: !values["no-auto-update"], updateChannel: channel,
    }, {
      env: process.env, home, platform: process.platform, interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      ask, askHidden, readKey: (source) => readLinearKey(source),
      storeInKeychain: (service) => {
        // `security` prompts for the password itself when `-w` is last and has no value, and does not echo it.
        const result = spawnSync("security", ["add-generic-password", "-U", "-a", process.env.USER ?? "", "-s", service, "-w"], { stdio: "inherit" });
        if (result.status !== 0) throw new OnboardRefusal(`security add-generic-password exited ${result.status}`);
      },
      readFile: (path) => readFileSync(path, "utf8"), writeFile: (path, text) => writeAtomic(path, text, 0o600),
      exists: (path) => existsSync(path), removeFile: (path) => rmSync(path, { force: true }),
      isDirectory: (path) => existsSync(path) && statSync(path).isDirectory(), now: () => new Date(),
      ensureBun: () => ensureBun({
        home, env: process.env, platform: process.platform, arch: process.arch, exists: existsSync,
        download: async (url) => {
          const response = await fetch(url);
          if (!response.ok) throw new OnboardRefusal(`${url} answered ${response.status}`);
          return Buffer.from(await response.arrayBuffer());
        },
        writeExecutable: (path, data) => writeAtomic(path, data, 0o755),
      }),
      herdrPlugins: () => readOrNull(join(herdrConfigDir(process.env, home), "plugins.json")),
      run: runProgram,
      which: (name) => whichOn(name, process.env),
      codexStatus: () => spawnSync("codex", ["login", "status"], { encoding: "utf8", timeout: 60_000 }).status,
      ghAs: (account) => asAccount(defaultGh, account),
      replacements: () => replacementsNow(process.env, home),
      diagnose: () => diagnose(defaultDoctorDeps()),
      chromium: () => chromiumReport(),
      isRoot: () => process.getuid?.() === 0,
      startServices: (names) => startServices(names, (name) => startService(name, services)),
      out: console,
    });
  } catch (err) {
    console.error(`agent-org onboard: ${(err as Error).message}`);
    process.exitCode = 2;
  }
}
