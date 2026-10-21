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
// A CHANGE TAKES EFFECT WHEN THE BOARD RESTARTS (activation runs once per process), and the answer to an action says so, with the sentences `settings-edit.ts` gives each key.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { realPluginDeps } from "../plugins/active.ts";
import type { PluginCliDeps } from "../plugins/cli.ts";
import { type ActionDone, actionRequestOf, runAction } from "../plugins/page-actions.ts";
import { type PluginHealth } from "../plugins/health.ts";
import { readPluginHealth, toolVersionOf } from "../plugins/health-read.ts";
import { type LoadResult, loadEnabled } from "../plugins/loader.ts";
import type { Catalog, PluginCheck, PluginDeps } from "../plugins/manifest.ts";
import { messagingChecksOfFile, messagingStateOfFile } from "../plugins/messaging-state.ts";
import { defaultCatalog } from "../plugins/registry.ts";
import type { MessagingState } from "../plugins/view.ts";
import { PROVIDER_BLOCKS, type Providers, providersOfText, resolveProviders } from "./providers.ts";
import { baseOf, type EditFile } from "./settings-edit.ts";
import type { Json } from "./local-http.ts";
import type { TicketSettings } from "./settings.ts";

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
}>;

/**
 * What the page is sent: the account of every plugin, a note when the host file is one the reader refuses (the plugins are then shown as their defaults, and the page offers no control
 * over them), and the `base` of each file a change would write.
 */
export type PluginsAnswer = PluginHealth & Readonly<{ note: string | null; bases: Readonly<Partial<Record<EditFile, string>>> }>;

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

export function pluginsApi(options: Readonly<{ hostPath: string; settings: TicketSettings; seam?: PluginsSeam }>) {
  const { hostPath, settings, seam = {} } = options;
  const catalog = seam.catalog ?? defaultCatalog();
  const deps = seam.deps ?? { ...realPluginDeps({ env: process.env, stateDir: settings.stateDir, pick: settings.pick, clones: settings.clones }), log: () => undefined };
  const load = seam.load ?? ((providers, cat, pluginDeps) => loadEnabled(providers, cat, pluginDeps));
  const messaging = seam.messaging ?? { state: () => messagingStateOfFile(hostPath, seam.projectPath), checks: () => messagingChecksOfFile(hostPath, { env: process.env, home: homedir() }) };

  /** The account of every plugin, read fresh from the host file. */
  async function read(): Promise<PluginsAnswer> {
    const text = readText(hostPath);
    // The bases are the files as they were when the plugins were read: a file that changes while the checks run is then refused by the next action, not passed on stale information.
    const bases = await basesOf({ hostPath, projectPath: seam.projectPath });
    const health = await readPluginHealth({ catalog, providers: providersOfText(text, catalog), blocks: PROVIDER_BLOCKS, deps, load: (providers, cat, pluginDeps) => load(providers, cat, pluginDeps), messaging,
      version: seam.version ?? toolVersionOf() });
    return { ...health, note: hostNote(text, catalog), bases };
  }

  /** Does what the body asks, and answers what it did. A refusal is thrown with the CLI's sentence, and nothing is written. */
  async function act(body: Json): Promise<ActionDone> {
    const cliDeps: PluginCliDeps = { hostPath, catalog, log: () => undefined, error: () => undefined, projectPath: seam.projectPath, outgoing: seam.outgoing };
    return runAction(actionRequestOf(body), cliDeps);
  }

  return { read, act };
}

export type PluginsApi = ReturnType<typeof pluginsApi>;
