// @ts-check
// module: the Settings page's Plugins section on the instance: `GET /api/plugins` and `POST /api/plugins/action` (A11-163)
//
// THE SECTION IS ITS OWN CALL. A plugin's doctor checks run programs (`security`, `claude mcp list`, `gh`), and the rest of the page must not wait on them or fail with them, so the
// plugins are not part of `/api/settings`. One plugin's failure never stops the others' rows (`health-read.ts`), and the answer says when the host file the plugins were read from is one the
// reader refuses.
//
// THE ANSWER IS `pluginHealth`'s: the same account doctor prints, so a failed plugin's reason and fix are doctor's word for word. It adds the `base` of each file a change would write,
// which the next action sends back so a file that changed since is refused. NO SECRET IS IN IT: a secret is a command that sets it.
//
// THE CLAUDE CODE PLUGINS (`tickets.plugins`) ARE IN THE ANSWER TOO (A11-201), read from the host file as it is now, so a save that changed the list is seen at once. They are the page's second tab, and
// with the agent-org plugins they make the `attention` count: the plugins whose checks fail or whose health is unknown, from this one read.
//
// A CHANGE TAKES EFFECT WHEN THE BOARD RESTARTS (activation runs once per process), and the answer to an action says so, with the sentences `settings-edit.ts` gives each key.
//
// THE CHECKS ARE ANSWERED FROM MEMORY (A11-270). They took 13 s on a loaded host, so a read never waits on them: it answers the last checks with the time they finished (`checkedAt`, null before
// the first have), and starts them again behind the page when they are older than `FRESH_MS`, the host file changed since, an action was taken, or the read asks (`check`: the page's
// Retry and "Read the plugins again", which a person clicks after fixing something elsewhere). One run of the checks at a time; a read
// meanwhile says `checking`. Everything else (loading, the Claude plugins, the bases, the note) is read fresh on every read, as before: it is cheap, and an action must see the files as they are.
// Each plugin's checks run in a child process of their own (`check-child.ts`), all at once: they run programs synchronously, which in this process would hold every other request still.
import { readFileSync } from "node:fs";
import { checksInChild, type CheckScope, pageDeps } from "../plugins/check-child.ts";
import type { PluginCliDeps } from "../plugins/cli.ts";
import { type ActionDone, actionRequestOf, runAction } from "../plugins/page-actions.ts";
import { attentionOf, type ClaudePlugins } from "../plugins/attention.ts";
import { type PluginHealth } from "../plugins/health.ts";
import { CHECK_MS, type Checked, checkPlugins, healthOf, type HealthSources, loadPlugins, toolVersionOf } from "../plugins/health-read.ts";
import { type LoadResult, loadEnabled } from "../plugins/loader.ts";
import type { Catalog, PluginCheck, PluginDeps } from "../plugins/manifest.ts";
import { messagingStateOfFile } from "../plugins/messaging-state.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import type { MessagingState } from "../plugins/view.ts";
import { hostFactsOf, pluginName } from "./plugin-contract.ts";
import { pluginProblems, type PluginProblems, type ProblemOptions } from "./plugins.ts";
import { PROVIDER_BLOCKS, type Providers, providersOfText, resolveProviders } from "./providers.ts";
import { baseOf, type EditFile } from "./settings-edit.ts";
import type { Json } from "./local-http.ts";
import { parseTicketSettings, type TicketSettings } from "./settings.ts";
import { ticketFolder } from "./ticket-paths.ts";

/** What the section reads and runs through, each replaceable by a test so no plugin is imported and no program is run. */
export type PluginsSeam = Readonly<{
  catalog?: Catalog;
  /** Loads the plugins the host enables; the default imports their modules. */
  load?: (providers: Providers, catalog: Catalog, deps: PluginDeps) => Promise<LoadResult>;
  deps?: PluginDeps;
  messaging?: Readonly<{ state: () => Promise<MessagingState>; checks: () => Promise<readonly PluginCheck[]> }>;
  version?: string;
  /** The project's declaration, when it is not the primary's (a test's). */
  projectPath?: string;
  outgoing?: PluginCliDeps["outgoing"];
  /** What the Claude Code plugins are read through: the install record and the machine's commands. The defaults are this machine's. */
  claude?: ProblemOptions;
  /** How long one plugin's checks may run (`CHECK_MS`), and the clock the checks' age is read on. A test's. */
  limitMs?: number;
  now?: () => number;
}>;

/**
 * What the page is sent: the account of every plugin, the Claude Code plugins the host file lists, how many plugins need attention, a note when the host file is one the reader refuses (the
 * plugins are then shown as their defaults, and the page offers no control over them), and the `base` of each file a change would write. `checkedAt` is the ISO time the checks in it
 * finished, or null when none has yet (the account then has no check rows), and `checking` says the checks are running again.
 */
export type PluginsAnswer = PluginHealth & Readonly<{
  claude: ClaudePlugins; attention: number; note: string | null; bases: Readonly<Partial<Record<EditFile, string>>>; checkedAt: string | null; checking: boolean;
}>;

/** How long the last checks are answered before a read starts them again. A page left open does not run them more than once a minute. */
export const FRESH_MS = 60_000;

const UNCHECKED: Checked = { checks: {}, messagingFailure: null };

/** How long past its time limit a child running a plugin's checks is killed: the limit's own row is answered first. */
const KILL_GRACE_MS = 1_000;

/** The last checks: what they found, when they finished, the host file's text they were run on, and how many times fresh checks had been asked for before they started. */
type Held = Readonly<{ checked: Checked; at: number; text: string | null; asks: number }>;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The text of the host file, or null when it cannot be read. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Why the reader refuses the host file, or null when it reads: the plugins are then shown as their defaults, and the page says so. */
function hostNote(text: string | null, catalog: Catalog): string | null {
  if (text === null) return "the host file cannot be read, so the plugins are shown as their defaults";
  try {
    resolveProviders(JSON.parse(text), catalog);
    return null;
  } catch (error) {
    return `the host file is refused, so the plugins are shown as their defaults: ${messageOf(error)}`;
  }
}

/** The bases of the files a change may write: the host file, and the project's declaration when this machine has one. */
async function basesOf(options: Readonly<{ hostPath: string; projectPath?: string }>): Promise<Partial<Record<EditFile, string>>> {
  const bases: Partial<Record<EditFile, string>> = {};
  for (const file of ["host.json", "project.json"] as const) {
    try {
      bases[file] = await baseOf(options, file);
    } catch {
      // A file that cannot be read has no base, and nothing is written to it.
    }
  }
  return bases;
}

/**
 * What the host file says now of the keys the Claude plugins are checked against. A file that does not parse as a whole (for any key, not only the plugins') falls back to the settings the board
 * started with, so the list shown is then the one the board started with, not the file's.
 */
function settingsOfText(text: string | null, started: TicketSettings, catalog: Catalog): TicketSettings {
  try {
    return text === null ? started : parseTicketSettings(JSON.parse(text), undefined, undefined, catalog);
  } catch {
    return started;
  }
}

/** The Claude plugins as the page draws them, from what `pluginProblems` found: each one's install, its fix sentence, the contract it declares and its contract rows. */
export function claudePluginsOf({ states, contracts, rows }: PluginProblems): ClaudePlugins {
  return {
    readable: states.readable,
    plugins: states.plugins.map(({ plugin, installs, loads, why }) => {
      const declared = contracts.find(({ entry }) => entry === plugin);
      return { entry: plugin, name: declared?.name ?? pluginName(plugin), loads, why, installs, contract: declared?.contract ?? null, rows: rows.filter((row) => row.plugin === plugin) };
    }),
  };
}

export function pluginsApi(options: Readonly<{ hostPath: string; settings: TicketSettings; seam?: PluginsSeam }>) {
  const { hostPath, settings, seam = {} } = options;
  const catalog = seam.catalog ?? defaultCatalog();
  const scope: CheckScope = { stateDir: settings.stateDir, pick: settings.pick, clones: settings.clones };
  const deps = seam.deps ?? pageDeps(scope);
  const load = seam.load ?? ((providers, cat, pluginDeps) => loadEnabled(providers, cat, pluginDeps));
  const limitMs = seam.limitMs ?? CHECK_MS;
  const inChild = (plugin: string | null) => checksInChild({ ...scope, hostPath, plugin }, limitMs + KILL_GRACE_MS);
  const messaging = seam.messaging ?? { state: () => messagingStateOfFile(hostPath, seam.projectPath), checks: () => inChild(null) };
  // The plugins the host enables are checked in child processes; a test's stand-in modules (`seam.load`) are checked here.
  const checkOf = seam.load === undefined ? (plugin: string) => inChild(plugin) : undefined;
  const now = seam.now ?? Date.now;
  let held: Held | null = null;
  let running: Promise<void> | null = null;
  let asks = 0;

  const sourcesOf = (text: string | null): HealthSources => ({ catalog, providers: providersOfText(text, catalog), blocks: PROVIDER_BLOCKS, deps, load: (providers, cat, pluginDeps) => load(providers, cat, pluginDeps),
    messaging, version: seam.version ?? toolVersionOf(), limitMs, checkOf });

  /** Runs the checks on the host file as it is now, and keeps what they found. A run that fails keeps the last checks: the read that loads the plugins says why. */
  async function runChecks(): Promise<void> {
    const text = readText(hostPath);
    const started = asks;
    try {
      const sources = sourcesOf(text);
      held = { checked: await checkPlugins(sources, await loadPlugins(sources)), at: now(), text, asks: started };
    } catch {
      // Loading failed: every read fails on it too, with its reason.
    }
  }

  /** Starts the checks unless they are running: one run at a time, and a caller meanwhile shares it. */
  function check(): Promise<void> {
    running ??= runChecks().finally(() => { running = null; });
    return running;
  }

  const stale = (text: string | null): boolean => held === null || held.text !== text || held.asks !== asks || now() - held.at >= FRESH_MS;

  /** Asks for fresh checks: they start now, or, when a run is under way, once it ends, since it started before the ask. */
  function askAgain(): void {
    asks += 1;
    void Promise.resolve(running).then(() => (stale(readText(hostPath)) ? check() : undefined));
  }

  /**
   * The account of every plugin: loaded from the host file as it is now, with the last checks. Never waits on the checks; starts them again when they are stale, or when `check` asks for
   * fresh ones.
   */
  async function read(options: Readonly<{ check?: boolean }> = {}): Promise<PluginsAnswer> {
    if (options.check === true) askAgain();
    const text = readText(hostPath);
    // The bases are the files as they were when the plugins were read: a file that changes after is then refused by the next action, not passed on stale information.
    const bases = await basesOf({ hostPath, projectPath: seam.projectPath });
    const sources = sourcesOf(text);
    const loaded = await loadPlugins(sources);
    if (stale(text)) void check();
    const last = held;
    const health = healthOf(sources, loaded, last?.checked ?? UNCHECKED);
    const current = settingsOfText(text, settings, catalog);
    const claude = claudePluginsOf(pluginProblems({ wanted: current.plugins, folder: ticketFolder(current, "<ticket>"), host: hostFactsOf(current) }, seam.claude));
    return { ...health, claude, attention: attentionOf(health, claude), note: hostNote(text, catalog), bases, checkedAt: last === null ? null : new Date(last.at).toISOString(), checking: running !== null };
  }

  /** Does what the body asks, and answers what it did. A refusal is thrown with the CLI's sentence, and nothing is written. The checks are run again after it. */
  async function act(body: Json): Promise<ActionDone> {
    const cliDeps: PluginCliDeps = { hostPath, catalog, log: () => undefined, error: () => undefined, projectPath: seam.projectPath, outgoing: seam.outgoing };
    const done = await runAction(actionRequestOf(body), cliDeps);
    askAgain();
    return done;
  }

  return { read, act, check };
}

export type PluginsApi = ReturnType<typeof pluginsApi>;
