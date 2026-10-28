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
// The auto-update service is checked for being registered: it runs every ten minutes, so it has no port.
// HERDR HAS A SERVICE OF ITS OWN (A11-169): "herdr scope" passes when the server of the tickets session runs in it, and fails when it is inside the instance's cgroup or the old transient scope, with `agent-org start herdr --move`.
// Each live or parked run is listed with the version of agent-org it started on, beside the instance's.
// EACH PLUGIN `tickets.plugins` NAMES (A11-140) is checked as a worker's session gets it: it loads, and its declared contract matches the host's keys.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { messagingHelpers } from "../messaging/plugin-helpers.ts";
import { delimiter, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { parseTicketSettings, type TicketSettings } from "../ticket-mode/settings.ts";
import { PROVIDER_BLOCKS, type ProviderBlock, type Providers, providersOfText } from "../ticket-mode/providers.ts";
import type { Concern } from "../plugins/concerns.ts";
import { type ConcernEntry, type PluginEntry, type PluginHealth, sectionHeader, sectionPlugins } from "../plugins/health.ts";
import { readPluginHealth, toolVersionOf } from "../plugins/health-read.ts";
import { type LoadResult, loadEnabled } from "../plugins/loader.ts";
import { messagingChecksOfFile, messagingStateOfFile } from "../plugins/messaging-state.ts";
import type { Catalog, HostPlaceReading, PluginDeps, ProbeRequest, ReviewerHelpers } from "../plugins/manifest.ts";
import { defaultCatalog, trackerWritingOf } from "../plugins/registry.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { publishingHelpers } from "../plugins/publishing-helpers.ts";
import { gateHelpers } from "../plugins/reviewing-gate.ts";
import { enableReviewerCommand } from "../ticket-mode/concern-states.ts";
import { readReviewerMemory, reviewerMemoryPath, splitHeadKey } from "../ticket-mode/reviewer-port.ts";
import { type FlakesView, flakesPath, flakesViewOf } from "../ticket-mode/flakes.ts";
import { pullLabel } from "../ticket-mode/board-view/pull-label.ts";
import { longWaits, longWaitSentence, type LongWait } from "../ticket-mode/board-view/long-waits.ts";
import type { HealthFigures } from "../ticket-mode/health-figures.ts";
import { CALL_FAILURES_WARN_PER_100, healthFlags, type HealthFlag } from "../ticket-mode/health-flags.ts";
import { reliabilityRows } from "../ticket-mode/reliability/rows.ts";
import { loadWatches, reliabilityWatchesPath } from "../ticket-mode/reliability/store.ts";
import type { Watch } from "../ticket-mode/reliability/watch.ts";
import { readRecordOrEmpty, watchdogPath, watchdogView, type WatchdogView } from "../ticket-mode/watchdog-record.ts";
import { type MessagingState, sourceWords } from "../plugins/view.ts";
import { describeMoves, planHostFix, writeHostFix } from "./migrate-host.ts";
import { runPreflights, shellPreflight, type PreflightExec } from "../ticket-mode/preflight.ts";
import { hostFactsOf, type HostFacts, notProvidedWhy, providesSkill, type SkillRef, skillRefs } from "../ticket-mode/plugin-contract.ts";
import { pluginProblems, type PluginContract, type PluginProblems } from "../ticket-mode/plugins.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { hostFilePath, readOrNull, TOOL_ROOT, type Env } from "./paths.ts";
import { existsSync as pathExists } from "node:fs";
import { ticketFolder } from "../ticket-mode/ticket-paths.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { compareReleaseTags, isReleaseTag } from "../lib/release-tag.ts";
import { COREPACK_FIXES, pinnedPnpm, type PnpmRunner, TOOL_PNPM_VERSION } from "./pnpm.ts";
import { defaultServiceDeps, serviceState, unitProblem, type RunResult, type ServiceName, type ServiceState } from "./service.ts";
import { HERDR_INTEGRATIONS, HERDR_PLUGINS, herdrBehind, herdrStatusPath, herdrVersionOf, integrationInstallCommand, integrationStates, isBehind, describeInstalled, pluginEntries, pluginInstallCommand, pluginUninstallCommand, readHerdrStatus, runHerdr, type HerdrStatusFile, type InstalledPlugin } from "./herdr-upkeep.ts";
import { HOUR_MS, readUpdateStatus, updateStatusPath, type StatusFile } from "./update-safety.ts";
import { hostHerdrPlace, type HerdrPlace } from "./herdr-place.ts";
import { handInstallCommand, TOOL_HERDR_VERSION } from "./herdr-install.ts";
import { guardsPresent } from "./interim-guards.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { drainPath, readDrain, type Drain } from "./update-drain.ts";
import { judgeShellCommand, readShellCommand, realShellDeps, shellContext, type ShellReading } from "./shell-command.ts";
import { runningToolVersion, toolDir, versionNameOf } from "./tool-versions.ts";
import { buildCandidates, findBuild, UI_BUILD_DIR } from "../ticket-mode/ui-build.ts";
import { declaresUiBuild, type UiSource } from "./ui-asset.ts";
import { fetchMissingUiBuild, mirrorGit, mirrorTags } from "./tool-install.ts";
import { readQueue } from "./instance-queue.ts";
import { pluginCopiesOf } from "../ticket-mode/pool-pin.ts";
import { runVersions, type PluginCopy, type RunVersion } from "../ticket-mode/queue/queue-pins.ts";
import { DEFAULT_TERMINAL_PORT, herdrConfigDir, loopbackPort, PAIRING_STEPS } from "./terminal.ts";
import { BUILD_LABELS, buildStarts, chromiumReport, PLAYWRIGHT_CLI, type ChromiumReport } from "./chromium.ts";
import { coreRowsHelpers, realExec, realPlace, realProbe } from "../plugins/active.ts";
import { corePolicy, reviewClaimIdentities } from "../plugins/policy.ts";
import { cloneOfDeclared, type DeclaredRepository } from "../declared-clone.ts";
import { reviewerInstance, reviewerSeat } from "../review-attribution.ts";

export const MIN_NODE_MAJOR = 24;

/**
 * One row of the report. `section` heads the rows of one agent-org plugin (A11-163): consecutive rows with the same section are printed under it, indented, so each plugin has a
 * section of its own. A row with no section is a machine check. A `warning` row (A11-184) is `ok`, so the exit code and every reader of `ok` are unchanged; the report prints it as `WARN`
 * with its fix, for something to do at a person's moment that is not broken.
 */
export type Check = Readonly<{ name: string; ok: boolean; detail: string; fix: string | null; section?: string; warning?: true }>;

/** The board UI's build as this machine has it (A11-191): the folder `/` is served from, or null; whether the running version's release ships one; and where it is looked for. */
export type UiBuildReading = Readonly<{ found: string | null; declared: boolean; looked: string; version: string | null }>;

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
  /** A file's permission bits, or null when it cannot be read. */
  mode: (path: string) => number | null;
  serviceState: (name: ServiceName) => ServiceState;
  /** Whether something answers HTTP on 127.0.0.1:`port`. */
  answers: (port: number) => Promise<boolean>;
  /** Whether 127.0.0.1:`port` answers `/api/health` with a 2xx: herdr web ui's own health route. */
  healthy: (port: number) => Promise<boolean>;
  /** Why the service manager will not load `name`'s unit, or null when it loads. */
  unitProblem: (name: ServiceName) => string | null;
  /** Runs a program for a plugin's checks (`security` for a key, `claude mcp list`): its exit status, and what it printed. */
  exec: PluginDeps["exec"];
  /** What `--version` the pinned pnpm prints, run as install and update run it, and the runner it went through: both null when no runner exists, the version null when the runner cannot start it. */
  pnpmVersion: () => { version: string | null; via: PnpmRunner | null };
  /** GETs `/` of a host and port for a plugin's checks (an exposure asks whether a served port answers): the status, or null when nothing answered. */
  probe: (request: ProbeRequest) => Promise<number | null>;
  /** Where the host file says the machine keeps what the code host's `gh` wrapper is rendered from, or why there is none (A11-160). Loaded by the caller, so this file stays import-light. */
  hostPlace: () => Promise<HostPlaceReading>;
  platform: NodeJS.Platform;
  /** Where the herdr server of `session` runs: its own service, the instance's cgroup, or elsewhere (A11-169). */
  herdrPlace: (session: string) => HerdrPlace;
  /** Which interim guards are still on disk: the gh-wrapper watchdog and the `keep-herdr.conf` and `gh-read-cache-off.conf` drop-ins (A11-145, A11-169, A11-172). */
  guards: () => Readonly<{ watchdog: boolean; dropIn: boolean; readCacheDropIn: boolean }>;
  /** What the auto-update last saw: nothing yet, a status, or a file that cannot be read (A11-90). */
  updateStatus: () => StatusFile;
  /** `herdr integration status` run now (A11-184): its exit status and text. */
  herdrIntegrations: () => RunResult;
  /** What the person's login shell runs for `agent-org`: an alias, a function or a file, and the copy of the tool that ends in (A11-285). A test injects one, so no shell is started. */
  shellCommand: () => ShellReading;
  /** The CPU (`process.arch`): which herdr build the hand command downloads (A11-223). */
  arch: string;
  /** The text of `herdr --version` (`herdr 0.9.3`), or null when herdr cannot run. */
  herdrVersion: () => string | null;
  /** The text of herdr's `plugins.json`, or null. */
  herdrPlugins: () => string | null;
  /** The newest herdr version and plugin tags the last `agent-org update` saw: nothing yet, a status, or a file that cannot be read (A11-184). */
  herdrStatus: () => HerdrStatusFile;
  /** The record of a breaking update that is draining: none, a drain, or a file that cannot be read (A11-169). */
  drain: () => Drain;
  /** Each live or parked run with the version of agent-org it started on, or null when the queue cannot be read (A11-169). */
  runs: () => readonly RunVersion[] | null;
  /** The queued runs that have waited more than two hours on the same ticket, read from the queue now, or null when the queue cannot be read (A11-298). */
  longWaits: () => readonly LongWait[] | null;
  /** The rolling health figures the instance on `port` serves at `/api/health` (A11-363), or null when it does not answer or is a version from before them. */
  boardFigures: (port: number) => Promise<HealthFigures | null>;
  /** The reliability watches in `stateDir` (A11-366): the board-reliability tickets and the figures they name, or null when the board has none on record or the record cannot be read. */
  reliabilityWatches: (stateDir: string) => readonly Watch[] | null;
  /** The watchdog's record in `stateDir`, as `/api/health` serves it (A11-363): null when it has restarted nothing. */
  watchdog: (stateDir: string) => WatchdogView | null;
  /** The board UI's build, read now (A11-191). */
  uiBuild: () => UiBuildReading;
  /** The version this instance runs: its version folder's name, else its package's. */
  instanceVersion: () => string | null;
  /** The conventions plugins' installs now, as a session started now gets them (A11-169). */
  pluginCopies: (wanted: readonly string[]) => readonly PluginCopy[];
  /** The release tags this install holds, with no network (A11-90). */
  releaseTags: () => string[];
  /**
   * What a reviewer plugin's checks ask of core (A11-161): the gate's loader, and its refusal when its modules do not load (A11-144). Asked only of an enabled reviewer, so a machine with none
   * loads no gate. A test injects one, so no module is loaded.
   */
  reviewing: ReviewerHelpers;
  /** The code repositories the project declares (`code` in `project.json`). REJECTS with the reader's refusal when the declaration cannot be read, which a machine with no project does as it is imported (A11-292). */
  declaredRepositories: () => Promise<readonly DeclaredRepository[]>;
  /** The starts of a reviewer herdr has refused, as the pool's reviewer memory in `stateDir` holds them (A11-241). A test injects them, so no file is read. */
  reviewerRefusals: (stateDir: string) => readonly RefusedStart[];
  /** The tests the flake log in `stateDir` lists as needing a fix (A11-300): flaked three times in seven days. A test injects them, so no file is read. */
  flakes: (stateDir: string) => FlakesView;
  /** The Chromium builds this machine has, read now: each build is a check, and `ticket:capture` needs both (A11-151). */
  chromium: () => ChromiumReport;
  /** Each plugin `tickets.plugins` names, as a session in `folder` gets it, and what is wrong with its contract (A11-140). A test injects one, so no install record, plugin file, version or `PATH` is read. */
  plugins: (input: { wanted: readonly string[]; folder: string; host: HostFacts }) => PluginProblems;
  /**
   * The agent-org plugins (A11-158): the registry's catalog, the loader (which imports only the bundled plugins the host enables), and what the project's `messaging` key says. A
   * test injects each, so no plugin module is imported and no `project.json` is read.
   */
  agentOrgPlugins: Readonly<{
    catalog: () => Catalog;
    load: (providers: Providers, catalog: Catalog, deps: PluginDeps, blocks?: readonly ProviderBlock[]) => Promise<LoadResult>;
    messaging: () => Promise<MessagingState>;
    /** The rows the enabled messaging plugin declares, for the files the project's `messaging` key resolves to (A11-162). THROWS the reader's or the loader's refusal. */
    messagingChecks: () => Promise<readonly Check[]>;
  }>;
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

/** The command that shows why a runner cannot start the pinned pnpm, as a person types it. */
const RUNNER_COMMAND: Record<PnpmRunner, string> = {
  "corepack beside node": `corepack pnpm@${TOOL_PNPM_VERSION} --version`,
  "corepack on PATH": `corepack pnpm@${TOOL_PNPM_VERSION} --version`,
  "npm exec": `npm exec --yes pnpm@${TOOL_PNPM_VERSION} -- --version`,
};

/** Install and update run one pinned pnpm through corepack beside node, a corepack on PATH, or `npm exec`; a machine where none can start it can install nothing. */
function pnpmCheck(deps: DoctorDeps): Check {
  const { version, via } = deps.pnpmVersion();
  if (version === TOOL_PNPM_VERSION) return ok("pnpm", `${version} through ${via}, which install and update use`);
  const addCorepack = `or add corepack with \`${COREPACK_FIXES[0]}\` or \`${COREPACK_FIXES[1]}\``;
  if (via === null) return failed("pnpm", `pnpm ${TOOL_PNPM_VERSION} cannot run: there is no corepack beside node or on PATH, and no npm to run \`npm exec\` with`, `run \`${COREPACK_FIXES[0]}\` or \`${COREPACK_FIXES[1]}\``);
  const detail = version === null ? `pnpm ${TOOL_PNPM_VERSION} cannot run through ${via}` : `pnpm ${TOOL_PNPM_VERSION} was asked for and ${version} answered`;
  return failed("pnpm", detail, `run \`${RUNNER_COMMAND[via]}\` to see why, ${addCorepack}`);
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
    const settings = parseTicketSettings(parsed, deps.home, undefined, deps.agentOrgPlugins.catalog());
    return { check: ok("host file", `${path}: ${Object.keys(settings.clones).length} repositories`), settings, noProject: !Object.hasOwn(parsed as object, "primary") };
  } catch (err) {
    return { check: failed("host file", `${path}: ${(err as Error).message}`, `fix the field it names, or run \`agent-org onboard\``), settings: null, noProject: false };
  }
}

/**
 * Each `plugin:skill` the writer's run names, of a plugin the session loads with a contract, with that contract (A11-139). Empty when the run names no such
 * skill, since a plugin that declares nothing is not checked.
 */
function namedWriters(settings: TicketSettings, plugins: PluginProblems | null): (PluginContract & { ref: SkillRef })[] {
  const contracts = plugins?.contracts ?? [];
  const named = skillRefs(hostFactsOf(settings)).filter(({ key }) => key === "writer");
  return named.flatMap((ref) => contracts.filter(({ name }) => name === ref.plugin).map((contract) => ({ ...contract, ref })));
}

/** What the tracker plugin files a new-ticket run's tickets with, or the reason it declares none. */
function writingOf(settings: TicketSettings): ReturnType<typeof trackerWritingOf> | string {
  try {
    return trackerWritingOf(settings.providers);
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * The ticket writer (A11-94). Always informational when `tickets.writer` is absent, which hides New ticket on the board. When it is named, it fails
 * if no `tickets.connectors` entry lets a worker read a ticket of the tracker plugin (its `readTools`), since the writer checks for duplicates that way, and says whether Grill is on.
 * Its skill is checked against the contract of the plugin that provides it (A11-139), never against the words of the instruction: a plugin's contract
 * that does not provide the skill fails it, and one that provides it says which plugin does.
 */
function writerCheck(settings: TicketSettings | null, plugins: PluginProblems | null): Check {
  if (settings === null) return ok("ticket writer", "not checked: the host file did not parse");
  if (settings.writer === null) return ok("ticket writer", "no: New ticket is hidden, since tickets.writer is not named");
  const writing = writingOf(settings);
  if (typeof writing === "string") return failed("ticket writer", `yes, but ${writing}`, "name a tracker plugin that declares writer tooling in tickets.providers.tracker");
  const reads = settings.connectors.some((pattern) => writing.readTools.some((tool) => new RegExp(pattern).test(tool)));
  if (!reads) {
    return failed("ticket writer", `yes, but no tickets.connectors entry lets it read a ${writing.label} ticket, so it cannot check a new ticket for duplicates`,
      `run \`agent-org onboard\`, which names the ${writing.label} reads in tickets.connectors`);
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

/**
 * The plugins as a worker's session gets them, asked once a run for both the plugin checks and the ticket writer's (A11-139). Null when the host file did not
 * parse or names no plugin, so the install record is not asked of a host with none to check.
 */
function pluginsOf(settings: TicketSettings | null, deps: DoctorDeps): PluginProblems | null {
  if (settings === null || settings.plugins.length === 0) return null;
  return deps.plugins({ wanted: settings.plugins, folder: ticketFolder(settings, "<ticket>"), host: hostFactsOf(settings) });
}

const PROVIDER_LABEL: Readonly<Record<ProviderBlock, string>> = {
  tracker: "tracker",
  codeHost: "code host",
  publish: "publisher",
  reviewer: "reviewer",
  exposure: "exposure",
};

/** What a concern does with its plugin disabled, in the words of a row's detail. */
const WITHOUT_PLUGIN: Readonly<Record<ProviderBlock, string>> = {
  tracker: "reads no tickets",
  codeHost: "reads no pull requests",
  publish: "publishes nothing",
  reviewer: "starts no reviewer",
  exposure: "serves the board on loopback only",
};

/** A pull request's reviewer that herdr refused to start for `count` starts in a row, with herdr's reason for the last (A11-241). */
export type RefusedStart = Readonly<{ url: string; head: string; count: number; reason: string }>;

/**
 * The `reviewer starts` row (A11-241): green while herdr refuses no start, red naming each pull request, its head, how many starts in a row it refused, and herdr's reason, which is the fix. Null where there is no reviewer to
 * start: the provider is none or switched off. The board tries again on every sweep, so a refusal that is mended elsewhere (a herdr upgrade, a codex trust entry) clears by itself.
 */
function reviewerStartsCheck(settings: TicketSettings, deps: DoctorDeps): Check | null {
  const { provider, enabled } = settings.providers.blocks.reviewer;
  if (!enabled || provider === "none") return null;
  const refused = deps.reviewerRefusals(settings.stateDir);
  if (refused.length === 0) return ok("reviewer starts", "herdr has refused no reviewer start");
  const times = (count: number) => (count === 1 ? "once" : `${count} times`);
  const detail = refused.map(({ url, head, count, reason }) => `${pullLabel(url)} at ${head.slice(0, 8)} refused ${times(count)}: ${reason}`).join("; ");
  return failed("reviewer starts", detail, `${refused[0].reason}: fix what herdr says, and the board starts the reviewer again on its next sweep`);
}

/**
 * The `flaky tests` row (A11-300): green while no test has flaked three times in seven days, and otherwise a WARNING (not a failure: the install works) that names each test with how many times it flaked and the fix. The chairman's
 * session files a ticket for each from this list; a worker never does. An unreadable flake log FAILS the row: it is not "nothing flaked". Null where there is no host file to name the board's state.
 */
function flakyTestsCheck(settings: TicketSettings | null, deps: DoctorDeps): Check | null {
  if (settings === null) return null;
  const { limit, days, tests, unreadable } = deps.flakes(settings.stateDir);
  // An unreadable log is not an empty one: no flake is recorded over it, so it is mended by hand (A11-300).
  if (unreadable !== undefined) return failed("flaky tests", unreadable, `mend or move ${flakesPath(settings.stateDir)}: the board records no flake while it cannot be read, and the list of flaky tests is unknown`);
  if (tests.length === 0) return ok("flaky tests", `no test has flaked ${limit} times in ${days} days`);
  const detail = tests.map(({ test, count, check }) => `${test} (${check}) flaked ${count} times`).join("; ");
  return warned("flaky tests", detail, `a test that flakes ${limit} times in ${days} days needs a fix: the chairman's session files a ticket for each one listed (${flakesPath(settings.stateDir)} holds the runs)`);
}

/**
 * One check per provider (A11-144), named for it and its plugin and whether the plugin is disabled (A11-158), ok when every check it summarises passes. Its detail says where its settings came
 * from, so a block a machine does not have is said to take the default, and a disabled plugin says what the board does without it.
 */
function providerRow(settings: TicketSettings, block: ProviderBlock, wrapped: readonly Check[], catalog: Catalog): Check {
  const { provider, enabled } = settings.providers.blocks[block];
  const name = `${PROVIDER_LABEL[block]} (${provider}${enabled || provider === "none" ? "" : ", disabled"})`;
  // Reviews required and no reviewer to do them (none, or switched off) is a failure that names the command that puts one back (A11-161); not required, the machine says nothing more of it.
  if (block === "reviewer" && settings.reviewer === null && settings.reviewerRequired) {
    return failed(name, `reviews are required and the reviewer is off: ${WITHOUT_PLUGIN[block]}`, enableReviewerCommand(settings.providers, catalog));
  }
  if (!enabled && provider !== "none") return ok(name, `disabled: ${WITHOUT_PLUGIN[block]}`);
  const source = `${sourceWords(settings.providers, block)}${block === "publish" ? publishWhenWords(settings) : ""}`;
  const failing = wrapped.filter((check) => !check.ok);
  if (failing.length === 0) return ok(name, wrapped.length === 0 ? source : `${source}, and its checks pass`);
  return failed(name, `${source}: ${failing.map((check) => check.detail).join("; ")}`, failing[0].fix ?? "fix the check it summarises");
}

/** What the publisher row adds when this machine publishes before review (`tickets.providers.publish.when`), so a person reading doctor sees that the channel hears of pull requests no reviewer has passed. */
const publishWhenWords = (settings: TicketSettings): string => (settings.publishWhen === "awaiting-review" ? ", publishing a run once it awaits only its review (when: awaiting-review)" : "");

const pluginFailed = (plugin: string, why: string, fix: string): Check => failed(`plugin ${plugin}`, why, fix);

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

/**
 * The account of every agent-org plugin (A11-163), read once and drawn as the report's plugin sections: the same account the Settings page draws, so a failed plugin's reason and fix
 * are the page's word for word. A host file the reader refused cannot say which plugins it enables, and its row already says why; the code host's rows are shown all the same, for the
 * providers the file names or the defaults: they ran on whatever the host file said (the stacking extension is the person's own `gh` account's), and they are asked alone, since nothing
 * else of the plugins is built for a file that does not read. Nothing here prints a secret: a plugin's rows are its own.
 */
async function pluginHealthOf(settings: TicketSettings | null, deps: DoctorDeps, place: HostPlaceReading): Promise<PluginHealth> {
  const { catalog, load, messaging, messagingChecks } = deps.agentOrgPlugins;
  const pluginDeps: PluginDeps = { env: deps.env, stateDir: settings?.stateDir ?? "", log: () => undefined, fetch: (input, init) => fetch(input, init), exec: deps.exec, execAsync: (file, args, options) => Promise.resolve(deps.exec(file, args, options)), readFile: deps.readFile, mode: deps.mode, probe: deps.probe, messaging: messagingHelpers(),
    pick: settings?.pick ?? "assigned", clones: settings?.clones ?? {}, policy: corePolicy(undefined, settings === null ? [] : reviewClaimIdentities(settings)), publishing: publishingHelpers(), reviewing: deps.reviewing, rows: coreRowsHelpers, place: () => Promise.resolve(place) };
  return readPluginHealth({ catalog: catalog(), providers: settings?.providers ?? providersOfText(hostText(deps)), blocks: settings === null ? ["codeHost"] : PROVIDER_BLOCKS, deps: pluginDeps, load,
    version: toolVersionOf(), messaging: { state: messaging, checks: messagingChecks } });
}

/** A plugin's own rows: the checks it reported, then the row that says it failed, unless one of the checks already says it (a key that cannot be read says why `create` threw, with its own fix). */
function pluginRowsOf(entry: PluginEntry): Check[] {
  const { failure } = entry;
  const said = failure !== null && entry.checks.some((check) => !check.ok && check.detail === failure.why);
  return [...entry.checks, ...(failure === null || said ? [] : [pluginFailed(entry.name, failure.why, failure.fix)])];
}

/** The plugin a block names, if the concern has one in force: the one section its provider row summarises. */
const namedEntry = (concern: ConcernEntry): PluginEntry | undefined => concern.plugins.find((plugin) => plugin.enabled || plugin.installed);

/** Rows under a section's header. */
const under = (section: string, rows: readonly Check[]): Check[] => rows.map((row) => ({ ...row, section }));

/**
 * One concern's sections, each plugin under a header that names the concern, the plugin, its state and contract and where its code lives. The plugin the block names is followed by the
 * concern's provider row, which summarises its checks and the machine checks that feed the same row; a disabled one says what the board does without it. A concern with no plugin
 * is `<concern>: none`, with its provider row. A plugin that failed has its FAIL row, named and with the fix.
 */
function concernSections(concern: ConcernEntry, summary: (named: PluginEntry | undefined, rows: readonly Check[]) => Check[], extra: readonly Check[] = []): Check[] {
  const named = namedEntry(concern);
  const sections = sectionPlugins(concern).flatMap((entry) => {
    const rows = pluginRowsOf(entry);
    return under(sectionHeader(concern.label, entry), entry === named ? [...rows, ...summary(entry, rows)] : rows);
  });
  // A concern no plugin runs still has its row (the provider is none, or names a plugin the registry does not hold), whether or not another plugin of it failed.
  return named === undefined ? [...sections, ...under(`${concern.label}: none`, [...extra, ...summary(undefined, extra)])] : sections;
}

const concernOf = (health: PluginHealth, concern: Concern): ConcernEntry => health.concerns.find((entry) => entry.concern === concern)!;

/**
 * The messaging section (A11-158, A11-162): what the project's `messaging` key says, and for a plugin that is on, the checks it declares, which its row summarises. Messaging is configured in
 * `project.json`'s `messaging` key (not a provider block); a key the messaging reader refuses is the row's failure.
 */
function messagingSections(health: PluginHealth): Check[] {
  const { messaging, messagingFailure } = health;
  const named = namedEntry(concernOf(health, "messaging"));
  // A key that names a plugin the registry does not hold has no entry to fail: its refusal is the row.
  const unknown = named === undefined && messagingFailure !== null && messaging.provider !== null ? [pluginFailed(messaging.provider, messagingFailure.why, messagingFailure.fix)] : [];
  return concernSections(concernOf(health, "messaging"), (_entry, rows) => {
    if (messaging.provider === null) return [ok("messaging (none)", messaging.why)];
    const { provider } = messaging;
    if (!messaging.enabled) return [ok(`messaging (${provider}, disabled)`, "disabled: nothing is sent to the chairman and nothing is asked, and its settings are kept for `agent-org plugin enable`")];
    const failing = rows.filter((check) => !check.ok);
    const name = `messaging (${provider})`;
    const where = "configured in project.json's messaging key";
    return [failing.length === 0 ? ok(name, rows.length === 0 ? where : `${where}, and its checks pass`)
      : failed(name, `${where}: ${failing.map((check) => check.detail).join("; ")}`, failing[0].fix ?? "fix the check it summarises")];
  }, unknown);
}

/** The machine checks a provider's row summarises beside its plugin's own rows. */
type Machine = Readonly<{ terminal: readonly Check[] }>;

/** The registry's refusals, in a section of their own: they name no concern, so no plugin's section holds them. */
const registrySection = (health: PluginHealth): Check[] => under("refused by the registry", health.refused.map(({ plugin, failure }) => pluginFailed(plugin, failure.why, failure.fix)));

/**
 * The sections of a host file the reader refused: its row says why, and nothing of the plugins is built but the code host's, whose rows are shown as they always were, with no provider row
 * to summarise them. The registry's refusals are still said.
 */
function hostlessSections(health: PluginHealth): Check[] {
  const codeHost = concernOf(health, "codeHost").plugins.filter((plugin) => plugin.enabled || plugin.installed);
  return [...codeHost.flatMap(pluginRowsOf), ...messagingSections(health), ...registrySection(health)];
}

/** Every plugin section, in the order tracker, code host, publisher, reviewer, exposure, messaging, then what the registry refused. */
function pluginSections(settings: TicketSettings, health: PluginHealth, { terminal }: Machine, deps: DoctorDeps): Check[] {
  const summarise = (block: ProviderBlock, machine: readonly Check[] = []) => (_entry: PluginEntry | undefined, rows: readonly Check[]): Check[] => [providerRow(settings, block, [...machine, ...rows], deps.agentOrgPlugins.catalog())];
  return [
    ...concernSections(concernOf(health, "tracker"), summarise("tracker")),
    ...concernSections(concernOf(health, "codeHost"), summarise("codeHost")),
    ...concernSections(concernOf(health, "publisher"), summarise("publish")),
    ...concernSections(concernOf(health, "reviewer"), (entry, rows) => {
      const starts = reviewerStartsCheck(settings, deps);
      return [...(starts === null ? [] : [starts]), ...summarise("reviewer", starts === null ? [] : [starts])(entry, rows)];
    }),
    ...concernSections(concernOf(health, "exposure"), summarise("exposure", terminal)),
    ...messagingSections(health),
    ...registrySection(health),
  ];
}

/**
 * One row for each repository the project declares (A11-292): a reviewer of its pull requests must find its clone. The reviewer's seat is named for the repository's KEY (`reviewer-<key>-<n>`) and
 * the clone is found from what that label reads back as, so a key the label cannot carry (`.github`, a key ending in `-<digits>`) is a repository whose pull requests are never reviewed, and a
 * declared repository with no clone under its key or its name is the same. The primary is reviewed from the tick's own checkout and needs no clone, so it has no row. A machine with no project
 * (a ticket-only host, `diagnose` asks nothing of it) declares no repository, so it has none; a declaration that cannot be read is one row that says so.
 */
async function repositoryCloneChecks(settings: TicketSettings | null, deps: DoctorDeps): Promise<Check[]> {
  if (settings === null) return [];
  let code: readonly DeclaredRepository[];
  try {
    code = await deps.declaredRepositories();
  } catch (err) {
    return [failed("repository clones", `the project's repositories cannot be read (${String((err as Error)?.message ?? err).split("\n")[0]})`, "fix project.json, or set AGENT_ORG_HOST to the host file of the project")];
  }
  return code.filter(({ key }) => key !== "").map((declared) => cloneCheckOf(declared, code, settings.clones));
}

/** The row for one declared repository: its key must read back from the reviewer's label, and a clone must be listed under the key or the repository's name. */
function cloneCheckOf({ key, repo }: DeclaredRepository, code: readonly DeclaredRepository[], clones: TicketSettings["clones"]): Check {
  const name = `clone of ${repo}`;
  const label = reviewerSeat({ repoKey: key, number: 1 });
  const read = reviewerInstance(label)?.key;
  if (read !== key) {
    return failed(name, `its key \`${key}\` does not survive a reviewer's label: \`${label}\` reads back as ${read === undefined ? "no reviewer" : `the key \`${read}\``}, so no pull request of ${repo} is reviewed`,
      `give ${repo} a key of lower-case letters, digits and hyphens that does not end in \`-<digits>\`, in \`code\` of project.json`);
  }
  const found = cloneOfDeclared(clones, key, code);
  if ("tried" in found) return failed(name, `host.json \`clones\` has no clone for ${repo} under ${found.tried.map((tried) => `\`${tried}\``).join(" or ")}, so a reviewer of it has no checkout`, `add \`"${found.tried[found.tried.length - 1]}": "<absolute path of the clone>"\` to \`clones\` in the host file`);
  if (!isAbsolute(found.clone)) return failed(name, `${found.clone} is not an absolute path`, "name the clone by its absolute path in `clones` of the host file");
  return ok(name, `${found.clone}, found from the reviewer label \`${label}\``);
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
  const place: HostPlaceReading = noProject ? { kind: "no-project" } : await deps.hostPlace().catch((cause: unknown): HostPlaceReading => ({ kind: "unreadable", reason: String((cause as Error)?.message ?? cause).split("\n")[0] }));
  const terminal = await terminalChecks(settings, deps);
  const health = await pluginHealthOf(settings, deps, place);
  const sections = settings === null ? hostlessSections(health) : pluginSections(settings, health, { terminal }, deps);
  return [
    nodeCheck(deps),
    pnpmCheck(deps),
    launcher === null
      ? failed("launcher", "`agent-org` is not on PATH", `add its directory to PATH: export PATH="$HOME/.local/bin:$PATH" in your shell's rc file`)
      : ok("launcher", launcher),
    judgeShellCommand(deps.shellCommand(), shellContext(deps.env, deps.home, hostText(deps))),
    host,
    ...aliasChecks(settings),
    ...(noProject ? [] : await repositoryCloneChecks(settings, deps)),
    herdr === null ? failed("herdr", "`herdr` is not on PATH", `run \`agent-org onboard\`, which installs herdr ${TOOL_HERDR_VERSION}, or by hand: \`${handInstallCommand(deps.platform, deps.arch, deps.env)}\``) : ok("herdr", herdr),
    ...(herdr === null ? [] : herdrUpkeepChecks(deps)),
    writerCheck(settings, plugins),
    ...pluginChecks(settings, plugins),
    ...await preflightChecks(settings, deps),
    ...instance,
    ...await boardHealthChecks(settings, instanceState, deps),
    ...await reliabilityChecks(settings, instanceState, deps),
    ...herdrScopeChecks(settings, instanceState, deps),
    ...readCacheGuardChecks(deps),
    ...ui,
    uiBuildCheck(deps),
    ...terminal,
    // One section per agent-org plugin, in concern order, each with the plugin's own rows and then the concern's row that summarises them (A11-163).
    ...sections,
    ok("pairing", PAIRING_STEPS),
    registeredCheck("auto-update", deps, "it runs `agent-org update` every ten minutes"),
    watchdogCheck(deps),
    updateLagCheck(settings?.updateMaxDeferHours ?? 2, deps),
    ...drainChecks(deps),
    ...longWaitChecks(deps),
    ...runVersionChecks(settings, deps),
    ...[flakyTestsCheck(settings, deps)].filter((check): check is Check => check !== null),
    ...chromiumChecks(deps),
  ];
}

/**
 * The board UI's build (A11-191). It is `ok` when the build `/` serves is there (A11-190's own lookup, so the two cannot disagree), and `ok` when this version ships none; it FAILS when the running
 * version's release ships one and none is found (A11-266): `/` shows its missing-build page, which is a broken board whatever the instance's calls answer. A version folder is fixed by `agent-org update`,
 * which fetches the build the release carries; the main channel has no release to fetch from; a checkout builds it.
 */
function uiBuildCheck(deps: DoctorDeps): Check {
  const { found, declared, looked, version } = deps.uiBuild();
  if (found !== null) return ok("ui build", `/ is served from ${found}`);
  if (!declared) return ok("ui build", "this version ships no UI build");
  const detail = `${version ?? "this version"} should have a UI build and none is in ${looked}, so / shows the missing-build page`;
  if (version === null) return failed("ui build", detail, "run `pnpm ui:build`");
  if (!isReleaseTag(version)) return failed("ui build", detail, "main has no release to fetch a UI build from: run `agent-org update --channel release`, which moves to the newest release");
  return failed("ui build", detail, "run `agent-org doctor --fix`, which fetches it now (or `agent-org update`)");
}

/** `doctor --fix`'s repair of the board UI's build (2026-10-26): the running release's missing build, fetched now. Returns the line to print and whether it failed. */
export function fixUiBuild(root: string = TOOL_ROOT, ui?: UiSource): { line: string; failed: boolean } {
  const fetched = fetchMissingUiBuild(root, ui);
  return { line: `ui build: ${fetched.line}`, failed: fetched.failed };
}

/**
 * One check per Chromium build, so each names what it lacks. A missing binary is fixed by the browser install, which the person runs; missing libraries by
 * `install-deps`, which runs as root and is never run from here (A11-151). `ticket:capture` needs both builds, so each is checked.
 */
function chromiumChecks(deps: DoctorDeps): Check[] {
  const report = deps.chromium();
  if (report.unchecked !== null) return [failed("chromium", `cannot be checked: ${report.unchecked}`, "run `agent-org update`, which installs this checkout's dependencies")];
  return report.builds.map((build) => {
    const label = BUILD_LABELS[build.build];
    if (buildStarts(build)) return ok(label, build.binary ?? "");
    if (build.binary === null) return failed(label, "no browser is installed", `run \`node ${PLAYWRIGHT_CLI} install chromium\``);
    return failed(label, `lacks ${build.missing.join(", ")}`, `run \`sudo node ${PLAYWRIGHT_CLI} install-deps chromium\``);
  });
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

/** The fix for a herdr server that runs outside its service, or a service that is not registered. */
const MOVE_HERDR = "run `agent-org start herdr --move` at a quiet moment: it stops the server that runs outside the unit and starts the unit (every pane restarts once), and retires the interim guards";

/** The "herdr scope" row for where the server of `session` runs. */
function herdrScopeRow(place: HerdrPlace, { session, registered }: { session: string; registered: boolean }): Check {
  const name = "herdr scope";
  if (place.kind === "unknown") return ok(name, `could not be checked, so where herdr runs is not known: ${place.why}`);
  if (place.kind === "none") {
    return registered ? ok(name, `no herdr server runs for session ${session} yet; the herdr service is registered and starts it`)
      : failed(name, `no herdr server runs for session ${session}, and the herdr service is not registered`, "run `agent-org start herdr`");
  }
  if (place.kind === "unit") return ok(name, `the herdr server for session ${session} is in agent-org-herdr.service (${place.where}), so a restart of the instance, the ui or the terminal never reaches it`);
  const where = place.kind === "instance" ? `the instance's cgroup (${place.where}), the same place as the instance: a restart of the instance interrupts every worker`
    : `${place.where}, a scope the instance started: it survives a restart but is not the service, and carries the instance's working directory`;
  return failed(name, `the herdr server for session ${session} is in ${where}`, MOVE_HERDR);
}

/**
 * Where the herdr server of the tickets session runs (A11-169). It passes in `agent-org-herdr.service`, where a restart of the instance, the ui or the terminal never reaches it. It fails inside
 * the instance's cgroup (a restart of the instance ends every worker) and in the old transient scope, with the `--move` that fixes both. Checked only when the instance is registered and a host file
 * names the session. The two interim guards are rows of their own, failing while either stands on a host whose herdr runs in its unit.
 */
function herdrScopeChecks(settings: TicketSettings | null, instanceState: ServiceState, deps: DoctorDeps): Check[] {
  if (settings === null || instanceState === "not-registered") return [];
  const session = settings.herdrSession;
  const place = deps.herdrPlace(session);
  const service = registeredCheck("herdr", deps, "it holds every worker's pane");
  const scope = herdrScopeRow(place, { session, registered: service.ok });
  const present = deps.guards();
  const retire = "run `agent-org start herdr --move`, or `agent-org onboard`, which retires it on its proof";
  const guards = place.kind === "unit" ? [
    ...(present.dropIn ? [failed("keep-herdr.conf", "the instance unit still has the KillMode drop-in, which herdr's own service replaced", retire)] : []),
    ...(present.watchdog ? [failed("gh-wrapper watchdog", "the hand-set gh-wrapper watchdog is still installed, and the start-time wrapper check replaced it", retire)] : []),
  ] : [];
  return [service, scope, ...guards];
}

/**
 * The hand-set `gh-read-cache-off.conf` drop-in turns the gh read cache off for every call the instance makes (A11-172). It stood in for the review claim reading past the cache, which the claim's read now
 * does, so it fails while it stands, with the command that retires it. Absent where the drop-in is.
 */
function readCacheGuardChecks(deps: DoctorDeps): Check[] {
  return deps.guards().readCacheDropIn ? [failed("gh-read-cache-off.conf", "the instance unit still turns the gh read cache off, which the review claim no longer needs", "run `agent-org onboard`, which retires it")] : [];
}

/**
 * A queued run that has waited more than two hours on the same ticket (A11-298): one warning row each, saying what it waits on and whether that ticket can move by itself. A wait is not a failure, so the row is `ok`, and
 * the fix is what ends the wait. Nothing when no run has waited that long, or the queue cannot be read.
 */
function longWaitChecks(deps: DoctorDeps): Check[] {
  const now = deps.now();
  return (deps.longWaits() ?? []).map((wait) => warned(`long wait ${wait.key}`, longWaitSentence(wait, now), longWaitFix(wait)));
}

/** What ends a long wait: the ticket it waits on moving, or, when that ticket cannot move by itself, a person finishing or removing it, or the relation or run that holds the wait. */
function longWaitFix({ kind, on, holder }: LongWait): string {
  const ends = kind === "files" ? `remove the run holding the files` : `remove the blocker relation in the tracker`;
  if (!holder.moves) return `${on} cannot move by itself: finish it, or ${ends}`;
  return kind === "files" ? `it ends when ${on} lets go of the files; press Start anyway on the run's card to run it beside ${on}` : `it ends when ${on} is done; if it should not block, ${ends}`;
}

/** The watchdog service is registered, or a warning that a stalled board will wait for a person: the update registers it, and `--no-auto-update` or a ui-only machine leaves it to `agent-org start watchdog` (A11-363). */
function watchdogCheck(deps: DoctorDeps): Check {
  const registered = registeredCheck("watchdog", deps, "it restarts the instance when it stalls, checking every minute");
  if (registered.ok) return registered;
  return registered.detail.includes("not registered") ? warned("watchdog service", "the watchdog service is not registered, so a stalled board waits for a person to restart it", "run `agent-org start watchdog`") : registered;
}

/**
 * The board's health figures and the watchdog's record (A11-363): one WARN row for each thing `healthFlags` flags, or one `ok` row that says the figures read well. Asked only of a running instance, and nothing is said when it
 * serves no figures (a version from before them): the instance's own rows say it does not answer.
 */
async function boardHealthChecks(settings: TicketSettings | null, state: ServiceState, deps: DoctorDeps): Promise<Check[]> {
  const watchdog = settings === null ? null : deps.watchdog(settings.stateDir);
  const figures = state === "running" ? await deps.boardFigures(settings?.port ?? 4747) : null;
  if (figures === null && watchdog === null) return [];
  const flags = healthFlags(figures, watchdog);
  if (flags.length === 0) return [ok("board health", figures === null ? "the watchdog has restarted nothing" : `loop p99 ${figures.loop.lastMinute.p99Ms} ms over the last minute and ${figures.loop.lastHour.p99Ms} ms over the last hour, and no call failure rate over ${CALL_FAILURES_WARN_PER_100}%`)];
  const fixes: Readonly<Record<HealthFlag["figure"], string>> = {
    loop: "`GET /api/health` names the calls that held the loop (`blocking`); a synchronous `gh` or `git` on the board's thread is the usual one",
    calls: "a service that fails one call in a hundred is sick or unreachable from this machine; `ticket:serve` says each failure in its log",
    watchdog: "the watchdog's record is `tickets/watchdog.json` in the state directory; each restart is a line of the watchdog's log (`journalctl --user -u agent-org-watchdog` on Linux, `~/.agent-org/logs/watchdog.log` on macOS) with the figure that tripped it",
  };
  return flags.map((flag) => warned(`board ${flag.figure}`, flag.text, fixes[flag.figure]));
}

/**
 * The open board-reliability tickets with their current figures (A11-366): one row each, a warning for a ticket whose figure is at its threshold now, one the board owes a reopen, or one that names no figure. The figures are asked only of a
 * running instance, and only when a ticket is listed.
 */
async function reliabilityChecks(settings: TicketSettings | null, state: ServiceState, deps: DoctorDeps): Promise<Check[]> {
  const watches = settings === null ? null : deps.reliabilityWatches(settings.stateDir);
  if (watches === null || watches.every(({ state: each }) => each === "held")) return [];
  const figures = state === "running" ? await deps.boardFigures(settings?.port ?? 4747) : null;
  return reliabilityRows(watches, figures).map((row) => (row.warning ? warned(row.name, row.detail, row.fix ?? "") : ok(row.name, row.detail)));
}

/** The versions of agent-org the live and parked runs started on, beside the instance's (A11-169): one row each, or one line when they all agree. Nothing when no run holds a workspace. */
function runVersionChecks(settings: TicketSettings | null, deps: DoctorDeps): Check[] {
  const runs = deps.runs();
  if (runs === null || runs.length === 0) return [];
  const instance = deps.instanceVersion();
  const checks: Check[] = [];
  const versionOf = (run: RunVersion) => run.toolVersion ?? "a version not recorded";
  if (instance !== null && runs.every((run) => run.toolVersion === instance)) {
    checks.push(ok("run versions", `all ${runs.length === 1 ? "1 run is" : `${runs.length} runs are`} on ${instance}`));
  } else {
    for (const run of runs) checks.push(ok(`run ${run.key}`, `${versionOf(run)} (instance ${instance ?? "unknown"})`));
  }
  const rewritten = rewrittenCopies(runs, deps.pluginCopies(settings?.plugins ?? []));
  checks.push(rewritten.length === 0 ? ok("plugin copy", "no refresh rewrote the folder a live run's session uses")
    : failed("plugin copy", `a refresh rewrote the plugin folder ${rewritten.map(({ key, path }) => `${path} under ${key}`).join(", ")} in place: those sessions now read the new copy`,
      "bump the plugin's version so a refresh lands in a new folder"));
  return checks;
}

/** Whether `current` is the folder `copy` started with at another commit: the same install path, a new commit, both known. */
const rewroteInPlace = (copy: PluginCopy, current: PluginCopy | undefined): boolean => {
  if (current === undefined || copy.commit === null || current.commit === null) return false;
  return current.commit !== copy.commit;
};

/** The runs whose plugin folder now holds another commit than the one they started with: the same install path, a new commit. */
function rewrittenCopies(runs: readonly RunVersion[], now: readonly PluginCopy[]): { key: string; path: string }[] {
  return runs.flatMap((run) => run.pluginCopy.flatMap((copy) => {
    const current = now.find((entry) => entry.plugin === copy.plugin && entry.path === copy.path);
    return rewroteInPlace(copy, current) ? [{ key: run.key, path: copy.path }] : [];
  }));
}

/** A breaking update waiting on live runs (A11-169): said as it is, since a wait is not a failure. A record that cannot be read fails, because the instance starts no run while it stands. */
function drainChecks(deps: DoctorDeps): Check[] {
  const drain = deps.drain();
  if (drain.kind === "none") return [];
  if (drain.kind === "unreadable") return [failed("update drain", drain.why, "run `agent-org update`, which writes or removes it: the instance starts no run while it stands")];
  const { target, since, deadline, forcedAt } = drain.record;
  return [ok("update drain", forcedAt === undefined ? `draining to ${target} since ${since}: no new run starts, the live runs finish, and any still live at ${deadline} are stopped and re-queued`
    : `draining to ${target} since ${since}: the live runs were stopped and re-queued at ${forcedAt}, and the update applies next`)];
}

/** The hour beyond `tickets.updateMaxDeferHours` a breaking update has to apply in before `doctor` calls the install late (A11-90, A11-169). */
const warned = (name: string, detail: string, fix: string): Check => ({ name, ok: true, detail, fix, warning: true });

/**
 * What a person does to bring herdr to the version this release pins: restarting it ends every pane, so `agent-org update` never does it (A11-184, ADR 0004). Not `herdr update`, which installs the
 * newest version and not the pin (A11-223).
 */
const pinnedHerdrStep = (deps: DoctorDeps): string =>
  `at a quiet moment, with no live run on the board, run \`${handInstallCommand(deps.platform, deps.arch, deps.env)}\`, then \`agent-org stop herdr\` and \`agent-org start herdr\`: every pane restarts once`;

/**
 * herdr's side of the install (A11-184), asked only when `herdr` is on PATH. The `claude` and `codex` integrations FAIL when outdated or missing: they are how herdr knows each agent's state and
 * resumes its session. herdr itself and each plugin agent-org installed WARN when behind the newest release the last `agent-org update` recorded; the installed side is read now, so a hand fix shows
 * at once, and no row makes a network call. An unreadable status file fails.
 */
function herdrUpkeepChecks(deps: DoctorDeps): Check[] {
  const status = deps.herdrStatus();
  const rows = [...herdrIntegrationChecks(deps), ...herdrVersionCheck(deps, status), ...herdrPluginChecks(deps, status)];
  return status.kind === "unreadable"
    ? [...rows, failed("herdr status", `the herdr status file cannot be read: ${status.why}`, "run `agent-org update`, which writes the file again, or check its permissions")]
    : rows;
}

function herdrIntegrationChecks(deps: DoctorDeps): Check[] {
  const installAll = `run ${HERDR_INTEGRATIONS.map((name) => `\`${integrationInstallCommand(name)}\``).join(" and ")}`;
  const read = deps.herdrIntegrations();
  if (read.status !== 0) {
    const why = (read.stderr || read.stdout).trim().split("\n")[0] || `exit ${read.status}`;
    return [failed("herdr integrations", `\`herdr integration status\` cannot be read: ${why}`, installAll)];
  }
  return integrationStates(read.stdout).map(({ name, state, detail }) => {
    const row = `herdr ${name} integration`;
    return state === "current" ? ok(row, detail) : failed(row, detail, `run \`${integrationInstallCommand(name)}\`, which \`agent-org update\` also runs`);
  });
}

/** herdr's version against the one this release pins (A11-223): a different one, older or newer, warns. The newest release the last `agent-org update` saw is told for information only. */
function herdrVersionCheck(deps: DoctorDeps, status: HerdrStatusFile): Check[] {
  const name = "herdr version";
  const installed = herdrVersionOf(deps.herdrVersion() ?? "");
  if (installed === null) return [ok(name, "herdr's version could not be read")];
  if (installed !== TOOL_HERDR_VERSION) return [warned(name, `herdr ${installed}, this release pins ${TOOL_HERDR_VERSION}`, pinnedHerdrStep(deps))];
  const newest = status.kind === "status" && "newest" in status.status.herdr ? status.status.herdr.newest : null;
  const out = newest !== null && herdrBehind(installed, newest) ? ` (herdr ${newest} is out; the pin moves with an agent-org release)` : "";
  return [ok(name, `herdr ${installed}, the version this release pins${out}`)];
}

/**
 * One row for each plugin of `HERDR_PLUGINS` that herdr lists (A11-287). It FAILS while the last `agent-org update` recorded a step that did not take for the newest release (the update said so once and
 * holds it quiet), WARNS when the plugin is behind that release or an older copy of it is still listed, and is ok at the newest release with one copy. A plugin that is not installed has no row.
 */
function herdrPluginChecks(deps: DoctorDeps, status: HerdrStatusFile): Check[] {
  return HERDR_PLUGINS.flatMap((repo) => {
    const found = pluginEntries(deps.herdrPlugins(), repo);
    if (found === null) return [];
    const [name, at] = [`herdr plugin ${repo}`, describeInstalled(found.current)];
    const recorded = status.kind === "status" ? status.status.plugins.find((entry) => entry.repo === repo) : undefined;
    const stale = herdrStaleCheck(name, at, found.stale);
    if (recorded === undefined) return [stale ?? ok(name, `at ${at}; the newest release is not known until \`agent-org update\` has run`)];
    if (!("newest" in recorded)) return [stale ?? ok(name, `at ${at}; the newest release could not be read: ${recorded.why}`)];
    if (recorded.failed?.tag === recorded.newest) {
      const { command, output } = recorded.failed;
      return [failed(name, `at ${at}, the newest release is ${recorded.newest}, and \`${command}\` did not take: ${output.split("\n").at(-1)}`, `run \`${command}\` by hand and read its output; \`agent-org update\` stops reporting this once the plugin is current and no older copy is listed`)];
    }
    if (isBehind(found.current, recorded.newest)) return [warned(name, `at ${at}, the newest release is ${recorded.newest}`, `run \`agent-org update\`, which moves it, or \`${pluginInstallCommand(repo, recorded.newest)}\``)];
    return [stale ?? ok(name, `at ${at}, which is the newest release`)];
  });
}

/** The warning for older copies of a plugin that a renamed manifest id left listed, or undefined when there are none. */
function herdrStaleCheck(name: string, at: string, stale: readonly InstalledPlugin[]): Check | undefined {
  if (stale.length === 0) return undefined;
  const ids = stale.map(({ pluginId }) => pluginId);
  return warned(name, `at ${at}, and an older copy is still listed: ${ids.join(", ")}`, `run ${ids.map((id) => `\`${pluginUninstallCommand(id)}\``).join(" and ")}, which \`agent-org update\` also runs`);
}

const UPDATE_GRACE_HOURS = 1;

/**
 * How far behind the newest release the install is, and since when (A11-90). An update applies within minutes (A11-169), so it fails once the install has been behind past `updateMaxDeferHours` plus an
 * hour of grace while no breaking update is draining: the ten-minute update should have moved it by then. The status file is what the update last saw, and the local tags count the releases between.
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
  // The newest release may not be among the tags this install holds yet, so it is counted in either way.
  const releases = new Set([...deps.releaseTags(), latest]);
  const behind = [...releases].filter((tag) => compareReleaseTags(tag, installed) > 0 && compareReleaseTags(tag, latest) <= 0).length;
  const detail = `installed ${installed}, latest ${latest}: ${behind} ${behind === 1 ? "release" : "releases"} behind, since ${status.latestSince}`;
  const drain = deps.drain();
  if (drain.kind === "draining") return ok(name, `${detail}; draining: a breaking update waits on live runs until ${drain.record.deadline}`);
  const limit = (maxDeferHours + UPDATE_GRACE_HOURS) * HOUR_MS;
  return deps.now() - Date.parse(status.latestSince) > limit
    ? failed(name, `${detail}; the update that runs every ten minutes should have moved it by now`, "run `agent-org update`, then check `agent-org status auto-update`")
    : ok(name, detail);
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

/** A row as the report prints it: `ok`, `WARN` or `FAIL`, its name and detail, and a failing row's fix on the line below. */
const rowText = ({ name, ok: passed, detail, fix, warning }: Check): string => {
  if (warning === true) return `WARN  ${name}: ${detail}\n      fix: ${fix}`;
  return passed ? `ok    ${name}: ${detail}` : `FAIL  ${name}: ${detail}\n      fix: ${fix}`;
};

/**
 * The report's text. A row with a `section` is printed under that section's header, indented, the header once for the rows that follow each other (A11-163): the plugins are sections,
 * and the machine's checks stand outside them.
 */
export function report(checks: readonly Check[]): string {
  const lines: string[] = [];
  let open: string | undefined;
  for (const check of checks) {
    if (check.section !== open && check.section !== undefined) lines.push(check.section);
    open = check.section;
    lines.push(...rowText(check).split("\n").map((line) => (check.section === undefined ? line : `  ${line}`)));
  }
  return lines.join("\n");
}

/** The release tags this install holds, read with git and no network: the mirror's when the install is in version folders, else the checkout's. None when git cannot be run. */
function localReleaseTags(): string[] {
  const mirror = toolDir(process.env, homedir());
  const tags = pathExists(join(mirror, "repo.git", "HEAD")) ? (() => { try { return mirrorTags(mirrorGit(mirror)); } catch { return null; } })() : null;
  if (tags !== null) return tags.filter((name) => isReleaseTag(name));
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

/** The reliability watches the board keeps in `stateDir` (A11-366), or null when it keeps none or the file cannot be read: the instance's own rows say what is wrong with its state. */
function reliabilityWatchesOf(stateDir: string): readonly Watch[] | null {
  try {
    const { watches } = loadWatches(reliabilityWatchesPath(stateDir));
    return Object.keys(watches).length === 0 ? null : Object.values(watches);
  } catch {
    return null;
  }
}

/** The figures the instance on `port` serves at `/api/health`, or null when it does not answer in time or serves none. */
async function boardFiguresOf(port: number): Promise<HealthFigures | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) });
    if (!response.ok) return null;
    return ((await response.json()) as { figures?: HealthFigures | null }).figures ?? null;
  } catch {
    return null;
  }
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
    which: (name) => which(name), readFile: (path) => readFileSync(path, "utf8"), exec: realExec,
    mode: (path) => { try { return statSync(path).mode & 0o777; } catch { return null; } },
    serviceState: (name) => serviceState(name, services), answers: (port) => answers(port),
    healthy: (port) => answers(port, "/api/health", { healthy: true }),
    unitProblem: (name) => unitProblem(name, services),
    pnpmVersion: () => {
      try {
        const { command, args, via } = pinnedPnpm(["--version"]);
        const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
        return { version: result.status === 0 ? result.stdout.trim() : null, via };
      } catch {
        return { version: null, via: null };
      }
    },
    probe: realProbe,
    hostPlace: realPlace,
    platform: process.platform,
    arch: process.arch,
    herdrPlace: (session) => hostHerdrPlace(services, session),
    guards: () => guardsPresent(process.env, homedir(), pathExists),
    updateStatus: () => readUpdateStatus(updateStatusPath(process.env, homedir())),
    herdrIntegrations: () => runHerdr(["integration", "status"]),
    shellCommand: () => readShellCommand(realShellDeps(process.env, homedir(), toolDir(process.env, homedir()))),
    herdrVersion: () => {
      const result = runHerdr(["--version"]);
      return result.status === 0 ? result.stdout.trim() : null;
    },
    herdrPlugins: () => readOrNull(join(herdrConfigDir(process.env, homedir()), "plugins.json")),
    herdrStatus: () => readHerdrStatus(herdrStatusPath(process.env, homedir())),
    drain: () => readDrain(drainPath(process.env, homedir())),
    runs: () => {
      const queue = readQueue();
      return queue === null ? null : runVersions(queue);
    },
    longWaits: () => {
      const queue = readQueue();
      return queue === null ? null : longWaits(queue.entries, Date.now());
    },
    boardFigures: boardFiguresOf, reliabilityWatches: reliabilityWatchesOf,
    watchdog: (stateDir) => {
      const record = readRecordOrEmpty(watchdogPath(stateDir));
      return record.count === 0 ? null : watchdogView(record, Date.now());
    },
    uiBuild: () => ({ found: findBuild(buildCandidates()), declared: declaresUiBuild(TOOL_ROOT), looked: join(TOOL_ROOT, UI_BUILD_DIR), version: versionNameOf(TOOL_ROOT) }),
    instanceVersion: () => runningToolVersion(),
    pluginCopies: (wanted) => pluginCopiesOf(wanted, homedir()),
    releaseTags: localReleaseTags,
    plugins: (input) => pluginProblems(input),
    reviewing: gateHelpers(),
    declaredRepositories: async () => (await import("../project-config.ts")).homeProjectDeclaration().code,
    reviewerRefusals: (stateDir) => [...readReviewerMemory(reviewerMemoryPath(stateDir)).memory.refusals].map(([key, { count, reason }]) => ({ ...splitHeadKey(key), count, reason })),
    flakes: (stateDir) => flakesViewOf(flakesPath(stateDir), Date.now()),
    chromium: () => chromiumReport(),
    agentOrgPlugins: {
      catalog: defaultCatalog,
      load: (providers, catalog, pluginDeps, blocks) => loadEnabled(providers, catalog, pluginDeps, undefined, blocks),
      messaging: () => messagingStateOfFile(hostFilePath(process.env, homedir(), readOrNull)),
      messagingChecks: () => messagingChecksOfFile(hostFilePath(process.env, homedir(), readOrNull), { env: process.env, home: homedir() }),
    },
    now: () => Date.now(),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { fix: { type: "boolean" }, "dry-run": { type: "boolean" } }, strict: true });
  if (values["dry-run"] === true && values.fix !== true) {
    console.error("doctor: --dry-run says what --fix would move, so it needs --fix");
    process.exit(2);
  }
  if (values.fix === true && values["dry-run"] !== true) {
    const ui = fixUiBuild();
    console.log(ui.line);
    if (ui.failed) process.exitCode = 1;
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
