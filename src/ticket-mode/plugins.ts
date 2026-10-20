// @ts-check
// module: whether the plugins a worker runs with are installed where its session will find them
//
// A PLUGIN INSTALLED FOR ONE FOLDER IS NOT A WORKER'S. Claude Code installs a plugin for the user, or for one project folder, and a worker starts in
// its ticket's own folder, which is a project of its own. The worker's settings enable each plugin by name, but only an install for the user, or
// for that very folder, gives the session a plugin to enable. Measured 2026-10-14: with the plugin installed for the folder above, `claude plugin
// list` run in a ticket's folder reported it enabled, while the worker's session loaded none of its skills. So this reads the install record.
//
// ONE PATH FOR TWO READERS. `unreachablePlugins` is the run-start check, and `pluginStates` is what the Settings page shows of the same record. Both
// read `reachability`, so the page and the check cannot disagree about whether a session loads a plugin.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentOrgVersionDefault, type Contract, type ContractRead, type ContractRow, contractRows, type HostFacts, onPathDefault, readPluginContract, readsContract } from "./plugin-contract.ts";

/** Claude Code's record of which plugins are installed, for whom, and where each install's files are. */
const INSTALLED_PLUGINS = join(homedir(), ".claude", "plugins", "installed_plugins.json");

type Install = Readonly<{ scope?: unknown; projectPath?: unknown; installPath?: unknown }>;

/** One install of a plugin: `user` for every folder, or `project` for the one folder `projectPath` names. */
export type PluginInstall = Readonly<{ scope: "user" | "project"; projectPath: string | null }>;

/**
 * What the record says of one plugin for a session in one folder. `loads` is true when that session gets the plugin, false when it does not, and null
 * when this cannot tell (an entry of a shape this does not know). `why` is the sentence that names the fix when `loads` is false, else null.
 * `installPath` is the install's files, the one a session loads, when `loads` is true; else null.
 */
export type PluginState = Readonly<{ plugin: string; installs: readonly PluginInstall[]; loads: boolean | null; why: string | null; installPath: string | null }>;

/** A plugin the record cannot tell about: no installs known, whether it loads unknown, and nothing to say. */
const unknownStates = (wanted: readonly string[]): PluginState[] => wanted.map((plugin) => ({ plugin, installs: [], loads: null, why: null, installPath: null }));

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

/** The installs of a plugin's raw entry, as the page names them. Only an entry of the known shape has any. */
function installsOf(raw: unknown): PluginInstall[] {
  if (!Array.isArray(raw) || !raw.every(isObject)) return [];
  return (raw as Install[]).map(({ scope, projectPath }) => ({
    scope: scope === "user" ? "user" : "project",
    projectPath: typeof projectPath === "string" && projectPath !== "" ? projectPath : null,
  }));
}

/** Whether a session in `folder` gets `plugin`, the sentence that names the fix when it does not, and the files it loads from. PURE, given the plugin's raw entry. */
function reachability(plugin: string, raw: unknown, where: Readonly<{ folder: string; exists: (path: string) => boolean }>): Pick<PluginState, "loads" | "why" | "installPath"> {
  const { folder, exists } = where;
  const userInstall = `install it for every folder with \`claude plugin install ${plugin} --scope user\`.`;
  const notLoaded = (why: string) => ({ loads: false, why, installPath: null });
  if (raw === undefined) return notLoaded(`${plugin} is not installed: ${userInstall}`);
  if (!Array.isArray(raw) || !raw.every(isObject)) return { loads: null, why: null, installPath: null };
  const installs = raw as Install[];
  if (installs.length === 0) return notLoaded(`${plugin} is not installed: ${userInstall}`);
  const forFolder = installs.filter(({ scope, projectPath }) => scope === "user" || projectPath === folder);
  if (forFolder.length === 0) {
    const where = installs.map(({ projectPath }) => projectPath).filter((path): path is string => typeof path === "string" && path !== "");
    return notLoaded(`${plugin} is installed only for ${where.length > 0 ? where.join(", ") : "another folder"}, so a worker in ${folder} runs without it: ${userInstall}`);
  }
  const loaded = forFolder.map(({ installPath }) => installPath).find((path): path is string => typeof path === "string" && exists(path));
  if (loaded === undefined) return notLoaded(`${plugin}'s files are missing from Claude Code's plugin cache: run /plugin and update it.`);
  return { loads: true, why: null, installPath: loaded };
}

type RecordOptions = { read?: (path: string) => string; exists?: (path: string) => boolean; record?: string };

/**
 * Each plugin in `wanted`, as a session in `folder` would get it. `readable` is false when the record cannot be read: every plugin is then `loads: null`,
 * and the page says it was not checked. PURE apart from the reads the options name.
 */
export function pluginStates(wanted: readonly string[], folder: string,
  { read = (path: string) => readFileSync(path, "utf8"), exists = existsSync, record = INSTALLED_PLUGINS }: RecordOptions = {}): { readable: boolean; plugins: PluginState[] } {
  if (wanted.length === 0) return { readable: true, plugins: [] };
  let text: string;
  try {
    text = read(record);
  } catch {
    return { readable: false, plugins: unknownStates(wanted) };
  }
  const installs = installsIn(text);
  if (installs === null) return { readable: false, plugins: unknownStates(wanted) };
  return { readable: true, plugins: wanted.map((plugin) => ({ plugin, installs: installsOf(installs[plugin]), ...reachability(plugin, installs[plugin], { folder, exists }) })) };
}

/** The sentence that names the fix for each plugin that a session would not get. */
const unreachableOf = (plugins: readonly PluginState[]): string[] => plugins.flatMap(({ loads, why }) => (loads === false && why !== null ? [why] : []));

/**
 * Why a session in `folder` would not get each plugin in `wanted` that it would not, one sentence each, naming the fix. Empty when every one is
 * reachable, and when the record cannot be read: an unreadable record is no reason to refuse a run.
 */
export function unreachablePlugins(wanted: readonly string[], folder: string, options: RecordOptions = {}): string[] {
  return unreachableOf(pluginStates(wanted, folder, options).plugins);
}

export type ProblemOptions = RecordOptions & Readonly<{
  /** The release of agent-org this runs, as `X.Y.Z`, or null when it is no release. Defaults to the checkout's release. */
  agentOrgVersion?: () => string | null;
  /** Whether a command is on the path. Defaults to the instance's own path. */
  onPath?: (command: string) => boolean;
}>;

/** A plugin the session loads that declares a contract: its entry in `tickets.plugins`, its name (which its skills are namespaced by), and the contract. */
export type PluginContract = Readonly<{ entry: string; name: string; contract: Contract }>;

/** What the Settings page and a run start both read of the plugins: each one's state, and the refusals and rows that stop a run. */
export type PluginProblems = Readonly<{
  states: Readonly<{ readable: boolean; plugins: PluginState[] }>;
  /** The sentence for each plugin the session would not get, the same as `unreachablePlugins`. */
  unreachable: string[];
  /** The contract rows: one per mismatch, of each plugin the session gets with a contract, each row said once. */
  rows: ContractRow[];
  /** The contracts the session's loading plugins declare, as read, so a check can say which plugin provides a skill without reading the files again (A11-139). */
  contracts: PluginContract[];
}>;

/**
 * The plugins a session in `folder` would get, and what is wrong with them against the host's keys. A contract row is read only for a plugin the
 * session loads: one it does not load already has its fix sentence. The same answer for the page and for a run start, so they cannot disagree.
 */
export function pluginProblems({ wanted, folder, host }: Readonly<{ wanted: readonly string[]; folder: string; host: HostFacts }>, options: ProblemOptions = {}): PluginProblems {
  const states = pluginStates(wanted, folder, options);
  const reads = states.plugins.flatMap(({ plugin, loads, installPath }) => (loads === true && installPath !== null
    ? [{ entry: plugin, read: readPluginContract(installPath, { read: options.read }) }] : []));
  const rows = reads.flatMap((installed) => contractRowsOf(installed, host, options));
  const contracts = reads.flatMap(({ entry, read }) => (read.kind === "found" && readsContract(read.contract) ? [{ entry, name: read.name, contract: read.contract }] : []));
  return { states, unreachable: unreachableOf(states.plugins), rows: [...new Map(rows.map((row) => [row.why, row])).values()], contracts };
}

/** The rows of one installed plugin's contract: none for no contract, and one row for a contract that is present and cannot be read. */
function contractRowsOf({ entry, read }: Readonly<{ entry: string; read: ContractRead }>, host: HostFacts, options: ProblemOptions): ContractRow[] {
  if (read.kind === "none") return [];
  if (read.kind === "malformed") return [{ plugin: entry, kind: "contract-malformed", why: `${entry}'s agent-org contract is malformed: ${read.why}. Fix it in the plugin's .claude-plugin/plugin.json.` }];
  return contractRows({ entry, name: read.name, contract: read.contract, host, agentOrgVersion: options.agentOrgVersion ?? agentOrgVersionDefault, onPath: options.onPath ?? onPathDefault });
}
