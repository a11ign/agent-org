// @ts-check
// module: whether the plugins a worker runs with are installed where its session will find them
//
// A PLUGIN INSTALLED FOR ONE FOLDER IS NOT A WORKER'S. Claude Code installs a plugin for the user, or for one project folder, and a worker starts in
// its ticket's own folder, which is a project of its own. The worker's settings enable each plugin by name, but only an install for the user, or
// for that very folder, gives the session a plugin to enable. Measured 2026-10-14: with the plugin installed for the folder above, `claude plugin
// list` run in a ticket's folder reported it enabled, while the worker's session loaded none of its skills. So this reads the install record.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code's record of which plugins are installed, for whom, and where each install's files are. */
const INSTALLED_PLUGINS = join(homedir(), ".claude", "plugins", "installed_plugins.json");

type Install = Readonly<{ scope?: unknown; projectPath?: unknown; installPath?: unknown }>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Each plugin's raw installs from the record's text, or null for a record this cannot read, which proves nothing either way. PURE. */
function installsIn(text: string): Readonly<Record<string, unknown>> | null {
  try {
    const record: unknown = JSON.parse(text);
    return isObject(record) && isObject(record.plugins) ? record.plugins : null;
  } catch {
    return null;
  }
}

/**
 * Why a session in `folder` would not get `plugin`, as one sentence naming the fix, or null when it would, or when its entry is not the shape
 * this knows, which proves nothing either way.
 */
function whyUnreachable(plugin: string, raw: unknown, folder: string, exists: (path: string) => boolean): string | null {
  const userInstall = `install it for every folder with \`claude plugin install ${plugin} --scope user\`.`;
  if (raw === undefined) return `${plugin} is not installed: ${userInstall}`;
  if (!Array.isArray(raw) || !raw.every(isObject)) return null;
  const installs = raw as Install[];
  if (installs.length === 0) return `${plugin} is not installed: ${userInstall}`;
  const forFolder = installs.filter(({ scope, projectPath }) => scope === "user" || projectPath === folder);
  if (forFolder.length === 0) {
    const where = installs.map(({ projectPath }) => projectPath).filter((path): path is string => typeof path === "string" && path !== "");
    return `${plugin} is installed only for ${where.length > 0 ? where.join(", ") : "another folder"}, so a worker in ${folder} runs without it: ${userInstall}`;
  }
  if (!forFolder.some(({ installPath }) => typeof installPath === "string" && exists(installPath))) {
    return `${plugin}'s files are missing from Claude Code's plugin cache: run /plugin and update it.`;
  }
  return null;
}

/**
 * Why a session in `folder` would not get each plugin in `wanted` that it would not, one sentence each, naming the fix. Empty when every one is
 * reachable, and when the record cannot be read: an unreadable record is no reason to refuse a run.
 */
export function unreachablePlugins(wanted: readonly string[], folder: string,
  { read = (path: string) => readFileSync(path, "utf8"), exists = existsSync, record = INSTALLED_PLUGINS }:
  { read?: (path: string) => string; exists?: (path: string) => boolean; record?: string } = {}): string[] {
  if (wanted.length === 0) return [];
  let text: string;
  try {
    text = read(record);
  } catch {
    return [];
  }
  const installs = installsIn(text);
  if (installs === null) return [];
  return wanted.map((plugin) => whyUnreachable(plugin, installs[plugin], folder, exists)).filter((why): why is string => why !== null);
}
