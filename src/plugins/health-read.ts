// @ts-check
// module: reads the plugins' health for doctor and for the Settings page's `GET /api/plugins` (A11-163)
//
// THE CALLER NAMES WHAT IS READ. Loading imports only the bundled plugins the host enables, and asking each for its doctor checks runs programs (`security`, `claude mcp list`, `gh`), so
// this is async and is its own call on the page: the rest of the page must not wait on it. ONE PLUGIN'S FAILURE NEVER STOPS THE OTHERS: a plugin whose checks throw is one failing
// row of its own, and the rest are read as usual. What comes back is `pluginHealth`'s account, which doctor and the page both draw.
//
// THE PAGE'S CHECKS RUN TOGETHER, EACH WITHIN A TIME LIMIT (A11-270). On a loaded host one after another took 13 s. With `limitMs` (the board's page sets it), every plugin's checks start at
// once, and a plugin whose checks do not finish in time is one failing row of its own, as one whose checks throw is, so one hung program never holds up the rest. A plugin's checks are
// synchronous (`spawnSync`), so the board runs each out of its process (`checkEnabled`, with a child per plugin, `check-child.ts`), naming the plugins from the host file and importing none
// here. Without a limit (doctor) they run here one after another, to the end, as they always have. Loading and checking are separate calls too, so the page can answer from loading alone
// while the checks run.
import { liveToolVersion } from "../lib/tool-version.ts";
import { TOOL_ROOT } from "../install/paths.ts";
import { versionNameOf } from "../install/tool-versions.ts";
import type { Providers } from "../ticket-mode/providers.ts";
import { blockOf, type ProviderBlock } from "./concerns.ts";
import { type Failure, pluginHealth, type PluginHealth } from "./health.ts";
import { type LoadResult, settingsOfBlock } from "./loader.ts";
import type { Catalog, PluginCheck, PluginDeps } from "./manifest.ts";
import { pluginNamed } from "./registry.ts";
import type { MessagingState } from "./view.ts";

export type HealthSources = Readonly<{
  catalog: Catalog;
  providers: Providers;
  /** The blocks to load: all of them, or the code host alone for a host file the reader refused. */
  blocks: readonly ProviderBlock[];
  deps: PluginDeps;
  load: (providers: Providers, catalog: Catalog, deps: PluginDeps, blocks: readonly ProviderBlock[]) => Promise<LoadResult>;
  /** The project's `messaging` key, and the checks of the plugin it names. Absent: messaging is not read. */
  messaging?: Readonly<{ state: () => Promise<MessagingState>; checks: () => Promise<readonly PluginCheck[]> }>;
  version: string;
  /** How long one plugin's checks may run, all of them at once, before they are reported as not finished (the board's page: `CHECK_MS`). Absent: they run one after another, to the end. */
  limitMs?: number;
}>;

/**
 * How the board runs the checks out of its process: one plugin's by its name, and the messaging plugin's, which answers the plugin the project enables (null for none) with its checks:
 * the project's declaration is read there too.
 */
export type OutOfProcess = Readonly<{
  checkOf: (plugin: string) => Promise<readonly PluginCheck[]>;
  messagingOf: () => Promise<Readonly<{ provider: string | null; checks: readonly PluginCheck[] }>>;
}>;

/** A plugin whose checks are asked for, and how they are run. */
type Target = Readonly<{ name: string; run: () => PluginCheck[] | readonly PluginCheck[] | Promise<readonly PluginCheck[]> }>;

/** What loading read: the plugins and the project's messaging key. Cheap: no plugin's checks have run. */
export type Loaded = Readonly<{ load: LoadResult; messaging: MessagingState }>;

/** What the checks found: each plugin's rows, by name, and why the messaging plugin's checks could not run, or null. */
export type Checked = Readonly<{ checks: Readonly<Record<string, readonly PluginCheck[]>>; messagingFailure: Failure | null }>;

export const CHECK_MS = 10_000;

const NOT_READ: MessagingState = { provider: null, why: "the host file is refused, so project.json is not read" };
const MESSAGING_FIX = "fix the messaging key of project.json: `agent-org messaging:check` says what is wrong with it";
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * agent-org's own release, `vX.Y.Z`: the name of the version folder it runs from (A11-169), else read off the checkout's tags. A checkout at no release says so, and one whose version cannot be
 * read says that: it never throws.
 */
export function toolVersionOf(): string {
  try {
    const folder = versionNameOf(TOOL_ROOT);
    if (folder !== null) return folder;
    return liveToolVersion() ?? "no release tag";
  } catch {
    return "version unreadable";
  }
}

const LATE = Symbol("late");

/** What `run` answers, or `LATE` when it has not answered within `ms`, when there is a limit. A throw is passed on. */
async function within<T>(run: () => T | Promise<T>, ms: number | undefined): Promise<T | typeof LATE> {
  if (ms === undefined) return run();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((done) => { timer = setTimeout(() => done(LATE), ms); });
  try {
    return await Promise.race([Promise.resolve().then(run), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The one failing row of a plugin whose checks did not finish in time. */
const lateRow = (name: string, ms: number): PluginCheck => ({ name: `plugin ${name}`, ok: false, detail: `its checks did not finish within ${ms / 1000} seconds`, fix: "run agent-org doctor to see them" });

/** A plugin's doctor checks, or the one failing row a plugin whose checks threw, or did not finish within `ms`, is. */
async function checksOf(name: string, run: () => PluginCheck[] | readonly PluginCheck[] | Promise<readonly PluginCheck[]>, ms: number | undefined): Promise<readonly PluginCheck[]> {
  try {
    const checks = await within(run, ms);
    return checks === LATE ? [lateRow(name, ms ?? 0)] : checks;
  } catch (error) {
    return [{ name: `plugin ${name}`, ok: false, detail: `its checks could not run: ${messageOf(error)}`, fix: "update agent-org, or the plugin" }];
  }
}

type MessagingChecked = Readonly<{ provider: string; checks: readonly PluginCheck[] }> | Readonly<{ failure: Failure }> | null;

/** The checks of the messaging plugin the project enables, or why they could not run; null when none is enabled. */
async function messagingChecksOf(sources: HealthSources, state: MessagingState, ms: number | undefined): Promise<MessagingChecked> {
  if (sources.messaging === undefined || state.provider === null || !state.enabled) return null;
  try {
    const checks = await within(sources.messaging.checks, ms);
    return { provider: state.provider, checks: checks === LATE ? [lateRow(state.provider, ms ?? 0)] : checks };
  } catch (error) {
    return { failure: { why: messageOf(error), fix: MESSAGING_FIX } };
  }
}

const messagingStateOf = async (sources: HealthSources): Promise<MessagingState> => (sources.messaging === undefined ? NOT_READ : sources.messaging.state());

/** The messaging plugin's checks, run out of this process: the provider it names keys them, and checks that throw, or do not finish in time, are the messaging failure. */
async function messagingFoundOf(run: OutOfProcess["messagingOf"], ms: number | undefined): Promise<MessagingChecked> {
  try {
    const found = await within(run, ms);
    if (found === LATE) return { failure: { why: `its checks did not finish within ${(ms ?? 0) / 1000} seconds`, fix: "run agent-org doctor to see them" } };
    return found.provider === null ? null : { provider: found.provider, checks: found.checks };
  } catch (error) {
    return { failure: { why: messageOf(error), fix: MESSAGING_FIX } };
  }
}

/** Loads the plugins the host enables and reads the project's messaging key, running no plugin's checks. */
export async function loadPlugins(sources: HealthSources): Promise<Loaded> {
  const load = await sources.load(sources.providers, sources.catalog, sources.deps, sources.blocks);
  return { load, messaging: await messagingStateOf(sources) };
}

/** Runs `tasks` all at once. */
const together = <T>(tasks: readonly (() => Promise<T>)[]): Promise<T[]> => Promise.all(tasks.map((task) => task()));

/** Runs `tasks` one after another. */
async function inTurn<T>(tasks: readonly (() => Promise<T>)[]): Promise<T[]> {
  const done: T[] = [];
  for (const task of tasks) done.push(await task());
  return done;
}

/** Asks each target, then the messaging plugin, for its checks: all at once, each within the limit, when there is one. */
async function checkTargets(sources: HealthSources, targets: readonly Target[], messagingOf: () => Promise<MessagingChecked>): Promise<Checked> {
  const { limitMs } = sources;
  const own = targets.map(({ name, run }) => () => checksOf(name, run, limitMs).then((checks) => [name, checks] as const));
  const [rows, messaging] = limitMs === undefined ? [await inTurn(own), await messagingOf()] : await Promise.all([together(own), messagingOf()]);
  const checks: Record<string, readonly PluginCheck[]> = Object.fromEntries(rows);
  if (messaging !== null && "checks" in messaging) checks[messaging.provider] = messaging.checks;
  return { checks, messagingFailure: messaging !== null && "failure" in messaging ? messaging.failure : null };
}

/** Asks every loaded plugin, then the messaging plugin, for its checks, run here. */
export function checkPlugins(sources: HealthSources, loaded: Loaded): Promise<Checked> {
  const { providers, deps } = sources;
  const targets = [...loaded.load.loaded, ...loaded.load.unbuilt].flatMap(({ plugin, module }): Target[] => {
    const block = blockOf(plugin.concern);
    return block === null ? [] : [{ name: plugin.name, run: () => module.doctorChecks(settingsOfBlock(providers.blocks[block]), deps) }];
  });
  return checkTargets(sources, targets, () => messagingChecksOf(sources, loaded.messaging, sources.limitMs));
}

/**
 * Asks every bundled plugin the host file enables, then the messaging plugin, for its checks, each run out of this process. The plugins are named from the host file alone, as the
 * loader names them, and the messaging plugin is read out of it too, so no plugin's module and no project reader is loaded here: the board can run them at its start (A11-270).
 */
export function checkEnabled(sources: HealthSources, outOfProcess: OutOfProcess): Promise<Checked> {
  const targets = sources.blocks.flatMap((block): Target[] => {
    const report = sources.providers.blocks[block];
    const plugin = report.enabled ? pluginNamed(sources.catalog, report.provider) : undefined;
    return plugin?.where === "bundled" ? [{ name: plugin.name, run: () => outOfProcess.checkOf(plugin.name) }] : [];
  });
  return checkTargets(sources, targets, () => messagingFoundOf(outOfProcess.messagingOf, sources.limitMs));
}

/** The account of every concern and plugin from what loading read and what the checks found. */
export const healthOf = (sources: HealthSources, loaded: Loaded, checked: Checked): PluginHealth =>
  pluginHealth({ catalog: sources.catalog, providers: sources.providers, messaging: loaded.messaging, load: loaded.load, checks: checked.checks, messagingFailure: checked.messagingFailure, version: sources.version });

/** Loads the plugins the host enables, asks each for its checks, and answers the account of every concern and plugin. */
export async function readPluginHealth(sources: HealthSources): Promise<PluginHealth> {
  const loaded = await loadPlugins(sources);
  return healthOf(sources, loaded, await checkPlugins(sources, loaded));
}
