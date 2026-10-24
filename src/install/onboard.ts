#!/usr/bin/env node
// @ts-check
// command: onboard -- set this machine up to run agent-org: its host file, its repositories, its services and its conventions plugin, from a profile (`--profile`) and the secrets it asks for
//
// IT ASKS FOR WHAT NO PROFILE OR FLAG GAVE, and only at a terminal. With `--profile <name>` (A11-145), onboard reads `<AGENT_ORG_HOME>/profiles/<name>.json` (or
// the path it names): a saved answer file that holds no secret. A profile that is absent is asked for at a terminal and written there, mode 600, so a copy
// of it sets up another machine; without one, it is refused by name. A profile holds the answers, the flags override them, and the ONLY questions asked of a
// complete profile are for the secrets: the tracker's key, and the reviewer App's private key when its file is not there yet.
//
// THE REPOSITORIES ARE PICKED, NOT TYPED (A11-186), at a terminal with no `--repo`: onboard lists the code host's checkouts in the folder it runs in (matched by their remote), pre-ticked and named as the code host names them, then
// offers to add repositories not cloned there from the account's organisations and repositories, cloning each pick that has no checkout with the command shown. A summary of each repository, its path and found, cloned or kept
// comes before the host file is written (`onboard-repos.ts`). A code host without a `repositories` group, or one that cannot list while the folder holds none, is asked for paths as it always was; without a terminal nothing is asked.
//
// WITHOUT `--profile`, onboard keeps what it did before: `--repo <name>=<path>` (repeated) names the checkouts a worker can choose from, and
// `--linear-keychain <service>` or `--linear-key-file <path>` names where the Linear key is read from. Without a terminal, what no flag gave is kept from the
// existing host file or refused by name.
//
// THE HOST FILE HAS ONE SHAPE: its providers are named blocks under `tickets.providers` (A11-144). An old key is moved into its block first, with a backup,
// as `doctor --fix` moves it. A key the host file already holds is kept as it is; onboard writes only the keys that are absent.
//
// IT SETS UP WHAT TICKET MODE NEEDS TO WORK OUT OF THE BOX:
//   - THE WEB TERMINAL (A11-66). Onboard installs bun when the machine has none (`bun.ts`), installs the plugin at its newest release tag with
//     `herdr plugin install devswha/herdr-web-ui --ref <tag> --yes` (A11-184: never the default branch), writes the exposure block's `terminal` when it is absent, and starts the `terminal` service. A step
//     that fails is said with its reason and leaves `terminal` unwritten, so the board never links to a terminal nothing serves.
//   - HERDR'S AGENT INTEGRATIONS (A11-184): `herdr integration install claude` and `codex`, on every machine from the first run, `--no-terminal` or not. They are how herdr knows each agent's
//     state and resumes its session. `agent-org update` keeps them current afterwards (`herdr-upkeep.ts`).
//   - LINEAR FOR THE WORKERS (A11-71). With a readable key and no `linear` MCP yet, onboard registers Linear's for Claude Code at user scope, authenticated by
//     that key, and lets the workers call its read and comment tools (`LINEAR_CONNECTORS`, in the tracker block). The key goes to `claude` as an argument and
//     is never printed: a message that would carry it carries `<key>` instead.
//   - THE CONVENTIONS PLUGIN (A11-145). The plugin is added from its repository as the person's own GitHub login, installed for every session, and its
//     declared contract sets the planner, the writer and the plan's file pattern (`plugin-install.ts`).
//   - THE HOUSE NOTES (A11-145): the worker's and the review's, written only where absent (`house-notes.ts`).
//   - THE REVIEWER'S APP (A11-145): its private key is copied to `<AGENT_ORG_HOME>/apps/<slug>.pem`, mode 600, and named in the host file.
//   - THE INTERIM GUARDS (A11-145) the hand-set gh-wrapper watchdog and herdr's KillMode drop-in are retired once their replacements are proven (`interim-guards.ts`).
//   - THE HOST FILE'S PATH, in `<home>/host-file` (A11-68), so a shell with no `AGENT_ORG_HOST` finds it.
//   - HERDR'S OWN SERVICE (A11-169) is started first, as `agent-org start herdr` starts it; a herdr server that runs outside it is said, with the `--move` that moves it.
//   - AUTO-UPDATE: the `auto-update` service runs `agent-org update` every ten minutes. `--no-auto-update` leaves it unregistered, and `--update-channel main` makes it follow `main`.
//
// IT NEVER ECHOES A KEY. A plugin's step stores one only when none is readable and a person is at the terminal (the Linear plugin: into the Keychain by `security`'s own prompt,
// which does not echo, or into a mode-600 file from a prompt that does not echo), then reads it back to check it is there, and says WHERE it is, never what it is. The reviewer
// App's key is copied and never printed.
//
// IT ENDS BY DIAGNOSING: the same checks `agent-org doctor` runs are printed, so the person sees whether the machine is ready.
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { type BlockReport, DEFAULT_PROVIDER, type Providers, resolveProviders } from "../ticket-mode/providers.ts";
import { blockOf, CONCERN_LABEL, CONCERN_OF_BLOCK, PROVIDER_BLOCKS, type ProviderBlock } from "../plugins/concerns.ts";
import { coreRowsHelpers, realExec, realMode, realPlace, realProbe } from "../plugins/active.ts";
import { messagingHelpers } from "../messaging/plugin-helpers.ts";
import { type LoadResult, loadEnabled, settingsOfBlock } from "../plugins/loader.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import { corePolicy } from "../plugins/policy.ts";
import { publishingHelpers } from "../plugins/publishing-helpers.ts";
import { gateHelpers } from "../plugins/reviewing-gate.ts";
import type { Catalog, PluginDeps, PluginSettings } from "../plugins/manifest.ts";
import { readPluginContract, type Contract } from "../ticket-mode/plugin-contract.ts";
import { agentOrgHome, hostFilePath, hostPointerPath, readOrNull, type Env } from "./paths.ts";
import { ensureBun } from "./bun.ts";
import { chromiumProblems, chromiumReport, lacksLibraries, PLAYWRIGHT_CLI, type ChromiumReport } from "./chromium.ts";
import { defaultServiceDeps, ServiceRefusal, startService, TailnetRefusal, updateChannelPath, type RunResult, type ServiceName, type Started, type UpdateChannel } from "./service.ts";
import { DEFAULT_TERMINAL_PORT, herdrConfigDir, PAIRING_STEPS, pluginRoot, TERMINAL_PLUGIN, terminalAddress } from "./terminal.ts";
import { HERDR_INTEGRATIONS, integrationInstallCommand, newestPluginTag, type HerdrIntegration } from "./herdr-upkeep.ts";
import { writeAtomic } from "./write-atomic.ts";
import { defaultGh } from "../lib/tool-version-agreement.ts";
import { asAccount, type Account, type ProgramRunner } from "./gh-account.ts";
import { describeMoves, planHostFix, writeHostFix } from "./migrate-host.ts";
import { askProfile, parseProfile, profilePathOf, profileText, ProfileRefusal, providerBlocksOf, type Profile, type ProfileRepo } from "./onboard-profile.ts";
import { installConventions, runProgram, stateOfRecord, type ConventionsStep } from "./plugin-install.ts";
import { houseNotes } from "./house-notes.ts";
import { replacementsNow, retireGuards, type Replacements } from "./interim-guards.ts";
import { defaultDoctorDeps, diagnose, report, type Check } from "./doctor.ts";
import { defaultMoveDeps, startHerdr } from "./herdr-move.ts";
import { repoCloneArgs } from "../ticket-port/repo-args.ts";
import { loadedCodeHost } from "../plugins/code-host-slot.ts";
import type { CodeHost } from "../plugins/contracts/code-host.ts";
import { pickRepositories, type PickedRepository } from "./onboard-repos.ts";
import { clackPrompts, PromptCancelled, type Prompts } from "./prompts.ts";

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
  /** Runs a program for a plugin's onboard steps (`security`, `claude mcp`): its exit status and what it printed. `inherit` gives it this terminal, for a prompt that does not echo. */
  exec: PluginDeps["exec"];
  /** The registry's catalog (A11-158): which plugins a provider block may name. A test passes its own. */
  catalog: () => Catalog;
  /** The bundled plugins the providers enable, loaded (A11-159): a test injects its own, so no plugin module is imported. */
  loadPlugins: (providers: Providers, pluginDeps: PluginDeps) => Promise<LoadResult>;
  readFile: (path: string) => string;
  writeFile: (path: string, text: string) => void;
  /** Whether a path exists: the profile, the guards, the plugin's record. */
  exists: (path: string) => boolean;
  /** Removes a file an interim guard leaves behind, once its replacement is proven. */
  removeFile: (path: string) => void;
  isDirectory: (path: string) => boolean;
  /** The names in a directory, or [] when it cannot be read: the checkouts onboard finds in the folder it runs in (A11-186). */
  listDir: (path: string) => string[];
  /** The folder onboard runs in (A11-186): where it looks for checkouts first, and where it clones to by default. */
  cwd: string;
  /** The code host, loaded only when a person is asked for repositories at a terminal (A11-186). */
  codeHost: () => CodeHost;
  /** Picking from a list, yes or no, and a prefilled line: how a terminal is asked for repositories (A11-186). */
  prompts: Prompts;
  now: () => Date;
  /** The `bun` this machine has, installed into `~/.bun/bin` when it has none. */
  ensureBun: () => Promise<{ path: string; installed: boolean }>;
  /** The text of herdr's `plugins.json`, or null. */
  herdrPlugins: () => string | null;
  /** The newest release tag of a herdr plugin's GitHub repository (A11-184); throws with the reason when it cannot be read or the repository has none. */
  newestPluginTag: (repo: string) => string;
  /** Run a program (`herdr`, `claude`, `gh`) with `env` added to this process's, and say what it returned. */
  run: (file: string, args: string[], env?: Env) => RunResult;
  /** The first executable called `name` on PATH, or null. */
  which: (name: string) => string | null;
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
  startServices: (names: readonly ServiceName[]) => Promise<string>;
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
  const fix = await planHostFix(text, deps.catalog());
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
async function profileFor(options: OnboardOptions, held: Readonly<Record<string, string>>, deps: OnboardDeps): Promise<Profile> {
  const path = profilePathOf(options.profile ?? "", deps.env, deps.home);
  if (deps.exists(path)) {
    try {
      return parseProfile(deps.readFile(path), deps.catalog());
    } catch (err) {
      if (err instanceof ProfileRefusal) throw new OnboardRefusal(`${path}: ${err.message}`);
      throw err;
    }
  }
  if (!deps.interactive) {
    throw new OnboardRefusal(`there is no profile at ${path}. A profile is the answers onboard asks, saved as JSON with no secret in it; run \`agent-org onboard --profile ${options.profile}\` at a terminal to answer them and write it there, or copy one from another machine to ${path}.`);
  }
  const profile = await askProfile({ ask: deps.ask }, await profileRepos(options, held, deps), deps.catalog());
  deps.writeFile(path, profileText(profile));
  deps.out.log(`wrote the answers to ${path}, mode 600: a copy of it sets up another machine, and holds no secret`);
  return profile;
}

/** What the profile records of the repositories: `--repo`'s, else those picked from the folder and the code host (each with its repository, so a copy of the profile clones them), else those named by path. */
async function profileRepos(options: OnboardOptions, held: Readonly<Record<string, string>>, deps: OnboardDeps): Promise<ProfileRepo[]> {
  const byPath = (repos: readonly string[]): ProfileRepo[] => repos.map((text) => parseRepo(text, deps)).map(([name, path]) => ({ name, path }));
  if (options.repos.length > 0) return byPath(options.repos);
  const picked = await pickedRepositories(held, deps);
  if (picked !== null) return picked.map(({ name, path, fullName }) => ({ name, remote: fullName, path: pathInHome(path, deps.home) }));
  return byPath(await askRepositories(deps));
}

/** `path` as `~/…` when it is under the home folder, so a profile copied to another machine finds it there. */
const pathInHome = (path: string, home: string): string => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/**
 * The repositories a person picks at a terminal (A11-186): the checkouts in the folder onboard runs in, and more from the code host's organisations. `held` is the host file's clones, kept as they are.
 * @returns null when the code host lists no repositories or nothing was found to pick from: the caller asks for paths, as it always did
 * @throws OnboardRefusal when the person stops a prompt
 */
async function pickedRepositories(held: Readonly<Record<string, string>>, deps: OnboardDeps): Promise<PickedRepository[] | null> {
  const repositories = deps.codeHost().repositories;
  if (repositories === undefined) return null;
  try {
    return await pickRepositories(held, { cwd: deps.cwd, home: deps.home, repositories, prompts: deps.prompts, out: deps.out, isDirectory: deps.isDirectory, exists: deps.exists, readFile: deps.readFile, listDir: deps.listDir });
  } catch (error) {
    if (error instanceof PromptCancelled) throw new OnboardRefusal("onboard was stopped at the repositories, and nothing was written");
    throw error;
  }
}

/** The host file's clones, read leniently: a file that is absent, not JSON or holds no clones holds none (the host file itself is read, and refused, later). */
function heldClones(hostFile: string, deps: OnboardDeps): Record<string, string> {
  const text = readHostText(hostFile, deps);
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    const clones = isObject(parsed) && isObject(parsed.clones) ? parsed.clones : {};
    return Object.fromEntries(Object.entries(clones).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch (error) {
    void error; // `currentHost` refuses a host file that is not JSON, by name
    return {};
  }
}

/** The repositories a person names at a terminal, one per line, until an empty line. */
async function askRepositories(deps: OnboardDeps): Promise<string[]> {
  deps.out.log("Name the repositories a worker can choose from: one checkout path per line, or name=path. An empty line finishes.");
  const repos: string[] = [];
  for (let line = (await deps.ask("Repository: ")).trim(); line !== ""; line = (await deps.ask("Repository: ")).trim()) repos.push(line);
  return repos;
}

/** The services onboard starts: herdr first, since the instance and the terminal start after it, then the instance and the ui always, the terminal when it is set up and auto-update unless opted out. */
export function onboardServices({ terminal, autoUpdate }: { terminal: boolean; autoUpdate: boolean; }): ServiceName[] {
  return ["herdr", "instance", "ui", ...(terminal ? ["terminal" as const] : []), ...(autoUpdate ? ["auto-update" as const] : [])];
}

/** The services onboard REQUIRES: one of these refusing to start fails onboard, and any other is said and passed over. */
const REQUIRED: readonly ServiceName[] = ["instance", "ui"];

/** Start `names`, in order. @returns one line per service */
export async function startServices(names: readonly ServiceName[], start: (name: ServiceName) => Promise<Started>): Promise<string> {
  const lines: string[] = [];
  for (const name of names) {
    try {
      const unit = await start(name);
      lines.push(`started the ${name} service (${unit.manager} ${unit.id})${unit.address === null ? "" : `, served at ${unit.address}`}`);
    } catch (err) {
      if (REQUIRED.includes(name) || !(err instanceof ServiceRefusal)) throw err;
      // A service that started on loopback and that the exposure does not reach is running: its message says so, and is said as it is.
      lines.push(err instanceof TailnetRefusal ? err.message : `did not start the ${name} service: ${err.message}`);
    }
  }
  return lines.join("\n");
}

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
      // At the newest RELEASE tag, never the default branch (A11-184): an install with no `--ref` pinned a commit of it, which nothing then moved. A tag that cannot be read fails this step.
      const tag = deps.newestPluginTag(TERMINAL_PLUGIN);
      const command = `herdr plugin install ${TERMINAL_PLUGIN} --ref ${tag} --yes`;
      // The plugin's build runs `bun install`, so bun's directory leads the PATH it runs with.
      const installed = deps.run("herdr", ["plugin", "install", TERMINAL_PLUGIN, "--ref", tag, "--yes"], { PATH: `${bunDir}:${deps.env.PATH ?? "/usr/bin:/bin"}` });
      if (installed.status !== 0) throw new OnboardRefusal(`\`${command}\` failed: ${firstLine(installed)}`);
      if (pluginRoot(deps.herdrPlugins()) === null) throw new OnboardRefusal(`herdr installed ${TERMINAL_PLUGIN}, but its plugins.json does not list it`);
      deps.out.log(`installed the herdr plugin ${TERMINAL_PLUGIN} ${tag}, the web terminal`);
    }
    return true;
  } catch (err) {
    deps.out.log(`the web terminal is not set up: ${(err as Error).message}. The board shows no terminal link until it is; fix that, then run \`agent-org onboard\` again.`);
    return false;
  }
}

/**
 * Install herdr's `claude` and `codex` integrations (A11-184), on every machine from the first run, whatever the profile or flags (`--no-terminal` does not skip them): they are how herdr knows each
 * agent's state and resumes its session, and the board reads agent status from herdr. One line each. A failure is said with its reason and the command to run, and does not fail onboard: `doctor`
 * fails the row until it is installed, as it does for onboard's other optional steps.
 */
function setUpHerdrIntegrations(deps: OnboardDeps): void {
  for (const name of HERDR_INTEGRATIONS) deps.out.log(installIntegration(name, deps));
}

/** The line that says what installing one integration did: it installed, or why it did not and the command to run. */
function installIntegration(name: HerdrIntegration, deps: OnboardDeps): string {
  const command = integrationInstallCommand(name);
  if (deps.which("herdr") === null) return `herdr's ${name} integration did not install: herdr is not on PATH. Install herdr, then run \`${command}\`.`;
  const result = deps.run("herdr", ["integration", "install", name]);
  return result.status === 0 ? `installed herdr's ${name} integration` : `herdr's ${name} integration did not install: ${firstLine(result)}. Run \`${command}\`.`;
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
  const asking = profile === null && options.repos.length === 0 && deps.interactive;
  const picked = asking ? await pickedRepositories(clones, deps) : null;
  for (const { name, path } of picked ?? []) clones[name] = path;
  for (const repo of picked === null && asking ? await askRepositories(deps) : options.repos) {
    const [name, path] = parseRepo(repo, deps);
    clones[name] = path;
  }
  if (Object.keys(clones).length === 0) throw new OnboardRefusal("no repository to offer: give at least one --repo <name>=<path>, or a profile that names one");
  return clones;
}

/** A block that names a plugin, written enabled as `agent-org plugin install` writes it. `none` is no plugin, so a publisher or reviewer that is none is left as it is. */
const installed = (block: Record<string, unknown>): Record<string, unknown> => (block.provider === "none" ? block : { ...block, enabled: true });

/**
 * The provider blocks onboard fills (A11-163): each plugin the machine uses is INSTALLED AND ENABLED, as `agent-org plugin install` would write it: `provider` and `enabled: true`, beside
 * the profile's settings. The tracker and the code host always, so a fresh machine ends with a `linear` and a `github` block that `plugin list`, `disable` and `config` and the Settings page
 * read; each optional concern whose choice is not `none` too. The profile's reviewer identity and the terminal the exposure takes are added. The tracker's own settings are its plugin's
 * steps' (`runPluginSteps`).
 */
function blocksOf({ planned, terminal }: Readonly<{ planned: PlannedBlocks | null; terminal: boolean }>): Record<string, Record<string, unknown> | undefined> {
  return {
    tracker: installed(planned?.tracker ?? { provider: DEFAULT_PROVIDER.tracker }),
    codeHost: installed(planned?.codeHost ?? { provider: DEFAULT_PROVIDER.codeHost }),
    publish: planned === null ? undefined : installed(planned.publish),
    reviewer: planned === null ? undefined : installed(planned.reviewer),
    exposure: { ...installed(planned?.exposure ?? { provider: "local" }), terminal: terminal ? terminalAddress(DEFAULT_TERMINAL_PORT) : undefined },
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

/** The host file, its pointer and, when one is given, the update channel: each written whole, and the repositories it offers said. */
function writeHostFiles({ hostFile, next, updateChannel }: Readonly<{ hostFile: string; next: Record<string, unknown>; updateChannel: UpdateChannel | undefined }>, deps: OnboardDeps) {
  deps.writeFile(hostFile, `${JSON.stringify(next, null, 2)}\n`);
  deps.writeFile(hostPointerPath(deps.env, deps.home), `${hostFile}\n`);
  if (updateChannel !== undefined) deps.writeFile(updateChannelPath(deps.env, deps.home), `${updateChannel}\n`);
  const names = Object.keys(next.clones as Record<string, string>).sort();
  deps.out.log(`wrote ${hostFile}: ${names.length} repositories (${names.join(", ")})`);
}

/**
 * What a person named for a plugin's settings, on the command line or in the profile: the tracker's key (`--linear-keychain`, `--linear-key-file`), and the App the profile names for the reviewer
 * (`reviewerApp`, which the code host's step copies the key of).
 */
const flagsOf = (block: ProviderBlock, options: OnboardOptions, planned: PlannedBlocks | null): PluginSettings => {
  if (block === "tracker") return { keychain: options.keychain, keyFile: options.keyFile };
  return block === "codeHost" && planned?.reviewerApp !== undefined ? { reviewerApp: planned.reviewerApp } : {};
};

/** The providers the host file will hold once onboard has written it, as far as which plugin each block names: the profile's blocks beside the file's own. */
function plannedProviders({ host, tickets, planned, catalog }: Readonly<{ host: Record<string, unknown>; tickets: Record<string, unknown>; planned: PlannedBlocks | null; catalog: Catalog }>): Providers {
  const names = providersWith(tickets, { tracker: planned?.tracker ?? { provider: DEFAULT_PROVIDER.tracker }, codeHost: planned?.codeHost, publish: planned?.publish, reviewer: planned?.reviewer, exposure: planned?.exposure });
  try {
    return resolveProviders({ ...host, tickets: { ...tickets, providers: names } }, catalog);
  } catch (err) {
    throw new OnboardRefusal(`the providers onboard would write are refused, so nothing is written: ${(err as Error).message}`);
  }
}

/** What onboard says of a plugin the host file already names: it is the concern's, or it is installed and switched off, which onboard leaves as it is. */
const alreadyWords = (provider: string, label: string, held: BlockReport): string =>
  (held.enabled ? `${provider} is already the ${label}` : `${provider} is already installed as the ${label}, and disabled: onboard leaves it off`);

/**
 * Says one line per plugin onboard installs and enables, before it runs that plugin's steps (A11-163): `installed linear as the tracker`, or that the host file already names it. The plugins
 * are the ones the providers will name once onboard has written the host file: a block the file holds keeps its plugin, and a concern whose choice is `none` has no line.
 */
function sayInstalls(providers: Providers, existing: Providers["blocks"], deps: OnboardDeps): void {
  for (const block of PROVIDER_BLOCKS) {
    const { provider } = providers.blocks[block];
    if (provider === "none") continue;
    const label = CONCERN_LABEL[CONCERN_OF_BLOCK[block]];
    const held = existing[block];
    const already = held.from === "block" && held.provider === provider;
    deps.out.log(already ? alreadyWords(provider, label, held) : `installed ${provider} as the ${label}`);
  }
}

/**
 * Runs the onboard steps of each bundled plugin the host will enable (A11-159), in block order, giving each the block's settings as the steps before it left them, and says what each
 * step says. @returns the settings the steps chose, by block, for the caller to write. A plugin the loader refuses is refused by name, unless only its `create` threw (a key that is
 * not stored yet): onboard needs its module, not its implementation, and is the step that stores the key.
 */
async function runPluginSteps({ options, host, tickets, planned, answered, clones }: Readonly<{ options: OnboardOptions; host: Record<string, unknown>; tickets: Record<string, unknown>; planned: PlannedBlocks | null; answered: boolean; clones: Readonly<Record<string, string>> }>,
  deps: OnboardDeps): Promise<Record<string, Record<string, unknown>>> {
  const providers = plannedProviders({ host, tickets, planned, catalog: deps.catalog() });
  const stateDir = typeof host.stateDir === "string" ? host.stateDir : join(deps.home, ".local", "state", "agent-org");
  const pluginDeps: PluginDeps = { env: deps.env, stateDir, log: (line) => deps.out.log(line), fetch: (input, init) => fetch(input, init),
    exec: deps.exec, execAsync: (file, args, options) => Promise.resolve(deps.exec(file, args, options)), readFile: deps.readFile, mode: realMode, probe: realProbe, messaging: messagingHelpers(), pick: "assigned", clones, policy: corePolicy(),
    publishing: publishingHelpers(), reviewing: gateHelpers(), rows: coreRowsHelpers, place: realPlace };
  const result = await deps.loadPlugins(providers, pluginDeps);
  const unbuilt = new Set(result.unbuilt.map(({ plugin }) => plugin.name));
  const refused = result.refusals.filter(({ plugin }) => !unbuilt.has(plugin));
  if (refused.length > 0) throw new OnboardRefusal(refused.map(({ plugin, concern, why }) => `the ${concern} plugin ${plugin} was refused: ${why}`).join("; "));
  const chosen: Record<string, Record<string, unknown>> = {};
  for (const { plugin, module } of [...result.loaded, ...result.unbuilt]) {
    const block = blockOf(plugin.concern);
    if (block === null) continue;
    const stepDeps = { ...pluginDeps, interactive: deps.interactive, answered, ask: deps.ask, askSecret: deps.askHidden, writeFile: deps.writeFile, platform: deps.platform, home: deps.home,
      agentOrgHome: agentOrgHome(deps.env, deps.home), flags: flagsOf(block, options, planned) };
    let current = settingsOfBlock(providers.blocks[block]);
    const set: Record<string, unknown> = {};
    for (const step of module.onboardSteps) {
      // A step that THROWS refuses onboard by its sentence: it asked for something that cannot be done (a key's path that is not absolute), and nothing is written.
      const answer = await step.run(current, stepDeps).catch((error: unknown) => { throw new OnboardRefusal(error instanceof Error ? error.message : String(error)); });
      if (answer.detail !== "") deps.out.log(answer.detail);
      // A setting a step leaves `undefined` is one it has no opinion on: the block keeps what it holds.
      const decided = Object.fromEntries(Object.entries(answer.settings ?? {}).filter(([, value]) => value !== undefined));
      Object.assign(set, decided);
      current = { ...current, ...decided };
    }
    chosen[block] = set;
  }
  return chosen;
}

/** What onboard does once the host file is written: Codex, the guards, the services, and the doctor's report. */
async function finishOnboard({ next, options, terminal }: Readonly<{ next: Record<string, unknown>; options: OnboardOptions; terminal: boolean }>, deps: OnboardDeps) {
  const guards = await retireGuards({ platform: deps.platform, env: deps.env, home: deps.home, exists: deps.exists, remove: deps.removeFile, run: deps.run, replacements: deps.replacements });
  for (const line of guards) deps.out.log(line);
  if (options.start) deps.out.log(await deps.startServices(onboardServices({ terminal, autoUpdate: options.autoUpdate })));
  deps.out.log(report(await deps.diagnose()));
  deps.out.log(PAIRING_STEPS);
}

/** Write the host file and the notes, install the conventions plugin, and start the services. @returns the host file's path */
export async function onboard(options: OnboardOptions, deps: OnboardDeps): Promise<string> {
  const hostFile = hostFilePath(deps.env, deps.home, (path) => readHostText(path, deps));
  const profile = options.profile === undefined ? null : await profileFor(options, heldClones(hostFile, deps), deps);
  const host = await currentHost(hostFile, deps);
  const tickets = ticketsOf(host);
  const clones = await clonesOf(options, profile, host, deps);

  const existing = resolveProviders(host, deps.catalog()).blocks;
  const planned = profile === null ? null : providerBlocksOf(profile);
  sayInstalls(plannedProviders({ host, tickets, planned, catalog: deps.catalog() }), existing, deps);
  const stepped = await runPluginSteps({ options, host, tickets, planned, answered: profile !== null, clones }, deps);
  const terminal = options.terminal && await setUpTerminal(deps);
  setUpHerdrIntegrations(deps);
  const capture = setUpChromium(deps);
  const plugin = profile?.conventions === undefined ? null : installPlugin(profile.conventions, deps);
  for (const line of plugin?.lines ?? []) deps.out.log(line);
  const contract = plugin?.installPath === null || plugin === null ? null : contractOf(plugin.installPath, deps);
  const notes = profile === null ? null : houseNotes({ env: deps.env, home: deps.home, keys: tickets, exists: deps.exists, read: deps.readFile, profile: profile.notes });
  for (const line of notes?.lines ?? []) deps.out.log(line);
  for (const write of notes?.writes ?? []) deps.writeFile(write.path, write.text);

  const providers = providersWith(tickets, blocksOf({ planned, terminal }));
  // A plugin's step decides its settings outright: it was given the block's own, so it keeps the ones it means to keep.
  // A plugin that chose nothing leaves its block alone: the blocks onboard installs are written above (`blocksOf`), so this only adds what a plugin's steps chose.
  for (const [block, set] of Object.entries(stepped)) if (Object.keys(set).length > 0) providers[block] = { ...fill(providers[block], {}), ...set };
  const pluginKeys = plugin?.installPath === null || plugin === null ? {} : conventionKeys(profile?.conventions?.plugin ?? "", contract);
  const prReview = profile?.conventions?.prReview === true ? contract?.provides.prReview?.skill : undefined;
  // `tickets.capture` is written only where it is absent, and only as true: a machine whose browsers do not start keeps what the host file says, or nothing.
  const next = { ...host, clones, tickets: fill({ ...tickets, providers }, { pick: planned?.pick, ...pluginKeys, prReview, ...(notes?.keys ?? {}), capture: capture || undefined }) };
  writeHostFiles({ hostFile, next, updateChannel: options.updateChannel }, deps);
  await finishOnboard({ next, options, terminal }, deps);
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
      ask, askHidden, exec: realExec, catalog: defaultCatalog, loadPlugins: (providers, pluginDeps) => loadEnabled(providers, defaultCatalog(), pluginDeps),
      readFile: (path) => readFileSync(path, "utf8"), writeFile: (path, text) => writeAtomic(path, text, 0o600),
      exists: (path) => existsSync(path), removeFile: (path) => rmSync(path, { force: true }),
      isDirectory: (path) => existsSync(path) && statSync(path).isDirectory(),
      listDir: (path) => { try { return readdirSync(path); } catch { return []; } },
      cwd: process.cwd(), codeHost: () => loadedCodeHost(process.env), prompts: clackPrompts(), now: () => new Date(),
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
      newestPluginTag: (repo) => newestPluginTag(repo),
      run: runProgram,
      which: (name) => whichOn(name, process.env),
      ghAs: (account) => asAccount(defaultGh, account),
      replacements: () => replacementsNow(process.env, home, services),
      diagnose: () => diagnose(defaultDoctorDeps()),
      chromium: () => chromiumReport(),
      isRoot: () => process.getuid?.() === 0,
      // herdr is started the way `agent-org start herdr` starts it: a server that runs outside its unit is refused, and said, never started beside (`--move` moves it, at a quiet moment).
      startServices: (names) => startServices(names, async (name) => (name === "herdr" ? (await startHerdr({ move: false }, defaultMoveDeps(services))).started : startService(name, services))),
      out: console,
    });
  } catch (err) {
    console.error(`agent-org onboard: ${(err as Error).message}`);
    process.exitCode = 2;
  }
}
