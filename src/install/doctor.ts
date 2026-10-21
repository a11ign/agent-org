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
import { homedir } from "node:os";
import { messagingHelpers } from "../messaging/plugin-helpers.ts";
import { delimiter, join } from "node:path";
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
import { publishingHelpers } from "../plugins/publishing-helpers.ts";
import { gateHelpers } from "../plugins/reviewing-gate.ts";
import { enableReviewerCommand } from "../ticket-mode/concern-states.ts";
import { type MessagingState, sourceWords } from "../plugins/view.ts";
import { describeMoves, planHostFix, writeHostFix } from "./migrate-host.ts";
import { runPreflights, shellPreflight, type PreflightExec } from "../ticket-mode/preflight.ts";
import { hostFactsOf, type HostFacts, notProvidedWhy, providesSkill, type SkillRef, skillRefs } from "../ticket-mode/plugin-contract.ts";
import { pluginProblems, type PluginContract, type PluginProblems } from "../ticket-mode/plugins.ts";
import { deferralPath, readDeferral, type Deferral } from "./plugin-install.ts";
import { hostFilePath, readOrNull, TOOL_ROOT, type Env } from "./paths.ts";
import { ticketFolder } from "../ticket-mode/ticket-paths.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { compareReleaseTags, isReleaseTag } from "../lib/release-tag.ts";
import { pinnedPnpm, TOOL_PNPM_VERSION } from "./pnpm.ts";
import { defaultServiceDeps, serviceState, unitProblem, type ServiceName, type ServiceState } from "./service.ts";
import { HOUR_MS, hostIsolation, readUpdateStatus, updateStatusPath, type Isolation, type StatusFile } from "./update-safety.ts";
import { DEFAULT_TERMINAL_PORT, loopbackPort, PAIRING_STEPS } from "./terminal.ts";
import { BUILD_LABELS, buildStarts, chromiumReport, PLAYWRIGHT_CLI, type ChromiumReport } from "./chromium.ts";
import { realExec, realPlace, realProbe } from "../plugins/active.ts";
import { corePolicy } from "../plugins/policy.ts";

export const MIN_NODE_MAJOR = 24;

/**
 * One row of the report. `section` heads the rows of one agent-org plugin (A11-163): consecutive rows with the same section are printed under it, indented, so each plugin has a
 * section of its own. A row with no section is a machine check.
 */
export type Check = Readonly<{ name: string; ok: boolean; detail: string; fix: string | null; section?: string }>;

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
  /** What `--version` the pinned pnpm prints, run as install and update run it, or null when it cannot run. */
  pnpmVersion: () => string | null;
  /** GETs `/` of a host and port for a plugin's checks (an exposure asks whether a served port answers): the status, or null when nothing answered. */
  probe: (request: ProbeRequest) => Promise<number | null>;
  /** Where the host file says the machine keeps what the code host's `gh` wrapper is rendered from, or why there is none (A11-160). Loaded by the caller, so this file stays import-light. */
  hostPlace: () => Promise<HostPlaceReading>;
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
   * What a reviewer plugin's checks ask of core (A11-161): the gate's loader, and its refusal when its modules do not load (A11-144). Asked only of an enabled reviewer, so a machine with none
   * loads no gate. A test injects one, so no module is loaded.
   */
  reviewing: ReviewerHelpers;
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
  const source = sourceWords(settings.providers, block);
  const failing = wrapped.filter((check) => !check.ok);
  if (failing.length === 0) return ok(name, wrapped.length === 0 ? source : `${source}, and its checks pass`);
  return failed(name, `${source}: ${failing.map((check) => check.detail).join("; ")}`, failing[0].fix ?? "fix the check it summarises");
}

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
  const pluginDeps: PluginDeps = { env: deps.env, stateDir: settings?.stateDir ?? "", log: () => undefined, fetch: (input, init) => fetch(input, init), exec: deps.exec, readFile: deps.readFile, mode: deps.mode, probe: deps.probe, messaging: messagingHelpers(),
    pick: settings?.pick ?? "assigned", clones: settings?.clones ?? {}, policy: corePolicy(), publishing: publishingHelpers(), reviewing: deps.reviewing, place: () => Promise.resolve(place) };
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
    ...concernSections(concernOf(health, "reviewer"), summarise("reviewer")),
    ...concernSections(concernOf(health, "exposure"), summarise("exposure", terminal)),
    ...messagingSections(health),
    ...registrySection(health),
  ];
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
  const place: HostPlaceReading = noProject ? { kind: "no-project" } : await deps.hostPlace();
  const terminal = await terminalChecks(settings, deps);
  const health = await pluginHealthOf(settings, deps, place);
  const sections = settings === null ? hostlessSections(health) : pluginSections(settings, health, { terminal }, deps);
  return [
    nodeCheck(deps),
    pnpmCheck(deps),
    launcher === null
      ? failed("launcher", "`agent-org` is not on PATH", `add its directory to PATH: export PATH="$HOME/.local/bin:$PATH" in your shell's rc file`)
      : ok("launcher", launcher),
    host,
    ...aliasChecks(settings),
    herdr === null ? failed("herdr", "`herdr` is not on PATH", "install herdr, which runs the workers' terminals, and put it on PATH") : ok("herdr", herdr),
    writerCheck(settings, plugins),
    ...pluginChecks(settings, plugins),
    ...await preflightChecks(settings, deps),
    ...instance,
    ...herdrScopeChecks(settings, instanceState, deps),
    ...ui,
    ...terminal,
    // One section per agent-org plugin, in concern order, each with the plugin's own rows and then the concern's row that summarises them (A11-163).
    ...sections,
    ok("pairing", PAIRING_STEPS),
    registeredCheck("auto-update", deps, "it runs `agent-org update` every hour"),
    updateLagCheck(settings?.updateMaxDeferHours ?? 2, deps),
    ...pluginRefreshChecks(deps),
    ...chromiumChecks(deps),
  ];
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

/** A row as the report prints it: `ok` or `FAIL`, its name and detail, and a failing row's fix on the line below. */
const rowText = ({ name, ok: passed, detail, fix }: Check): string => (passed ? `ok    ${name}: ${detail}` : `FAIL  ${name}: ${detail}\n      fix: ${fix}`);

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
    which: (name) => which(name), readFile: (path) => readFileSync(path, "utf8"), exec: realExec,
    mode: (path) => { try { return statSync(path).mode & 0o777; } catch { return null; } },
    serviceState: (name) => serviceState(name, services), answers: (port) => answers(port),
    healthy: (port) => answers(port, "/api/health", { healthy: true }),
    unitProblem: (name) => unitProblem(name, services),
    pnpmVersion: () => {
      const { command, args } = pinnedPnpm(["--version"]);
      const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } });
      return result.status === 0 ? result.stdout.trim() : null;
    },
    probe: realProbe,
    hostPlace: realPlace,
    platform: process.platform,
    isolation: (session) => hostIsolation(services, session),
    updateStatus: () => readUpdateStatus(updateStatusPath(process.env, homedir())),
    pluginRefresh: () => readDeferral(deferralPath(process.env, homedir())),
    releaseTags: localReleaseTags,
    plugins: (input) => pluginProblems(input),
    reviewing: gateHelpers(),
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
