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
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { realPluginDeps } from "../plugins/active.ts";
import type { PluginCliDeps } from "../plugins/cli.ts";
import { type ActionDone, actionRequestOf, runAction } from "../plugins/page-actions.ts";
import { attentionOf, type ClaudePlugins } from "../plugins/attention.ts";
import { type PluginHealth } from "../plugins/health.ts";
import { readPluginHealth, toolVersionOf } from "../plugins/health-read.ts";
import { type LoadResult, loadEnabled } from "../plugins/loader.ts";
import type { Catalog, PluginCheck, PluginDeps } from "../plugins/manifest.ts";
import { messagingChecksOfFile, messagingStateOfFile } from "../plugins/messaging-state.ts";
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
}>;

/**
 * What the page is sent: the account of every plugin, the Claude Code plugins the host file lists, how many plugins need attention, a note when the host file is one the reader refuses (the
 * plugins are then shown as their defaults, and the page offers no control over them), and the `base` of each file a change would write.
 */
export type PluginsAnswer = PluginHealth & Readonly<{ claude: ClaudePlugins; attention: number; note: string | null; bases: Readonly<Partial<Record<EditFile, string>>> }>;

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
  // The page runs no machine probes of the code host's wrapper (a token mint per App on every load): `agent-org doctor` shows those rows.
  const deps = seam.deps ?? { ...realPluginDeps({ env: process.env, stateDir: settings.stateDir, pick: settings.pick, clones: settings.clones }), log: () => undefined, place: async (): ReturnType<PluginDeps["place"]> => ({ kind: "skipped" }) };
  const load = seam.load ?? ((providers, cat, pluginDeps) => loadEnabled(providers, cat, pluginDeps));
  const messaging = seam.messaging ?? { state: () => messagingStateOfFile(hostPath, seam.projectPath), checks: () => messagingChecksOfFile(hostPath, { env: process.env, home: homedir() }) };

  /** The account of every plugin, read fresh from the host file. */
  async function read(): Promise<PluginsAnswer> {
    const text = readText(hostPath);
    // The bases are the files as they were when the plugins were read: a file that changes while the checks run is then refused by the next action, not passed on stale information.
    const bases = await basesOf({ hostPath, projectPath: seam.projectPath });
    const health = await readPluginHealth({ catalog, providers: providersOfText(text, catalog), blocks: PROVIDER_BLOCKS, deps, load: (providers, cat, pluginDeps) => load(providers, cat, pluginDeps), messaging,
      version: seam.version ?? toolVersionOf() });
    const current = settingsOfText(text, settings, catalog);
    const claude = claudePluginsOf(pluginProblems({ wanted: current.plugins, folder: ticketFolder(current, "<ticket>"), host: hostFactsOf(current) }, seam.claude));
    return { ...health, claude, attention: attentionOf(health, claude), note: hostNote(text, catalog), bases };
  }

  /** Does what the body asks, and answers what it did. A refusal is thrown with the CLI's sentence, and nothing is written. */
  async function act(body: Json): Promise<ActionDone> {
    const cliDeps: PluginCliDeps = { hostPath, catalog, log: () => undefined, error: () => undefined, projectPath: seam.projectPath, outgoing: seam.outgoing };
    return runAction(actionRequestOf(body), cliDeps);
  }

  return { read, act };
}

export type PluginsApi = ReturnType<typeof pluginsApi>;
