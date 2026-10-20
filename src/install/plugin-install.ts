// module: the conventions plugin a worker's session loads, installed from its repository and kept current (A11-145)
//
// THE PLUGIN IS ADDED FROM ITS REPOSITORY, AS THE PERSON (A11-143 Decision 3). A conventions plugin may be private, so the first step is `gh repo view` as the
// person's own GitHub login: when that fails, the step stops and says `gh auth login`. Then the marketplace is added from the repository unless one with the
// plugin's marketplace name is listed already. A listed marketplace from ANOTHER source (the agents host's directory) is left as it is and said, never
// replaced: replacing a working install is not a change onboard can prove safe. The plugin is installed at USER scope, so every session gets it, unless
// the install record already lists it for every folder. Finally it is read back the way a worker's session gets it (`pluginStates`), and the install's
// declared contract is returned for the host file's keys.
//
// THE UPDATE IS `agent-org update`'s (A11-145): for each plugin `tickets.plugins` names whose marketplace is a repository, the marketplace is updated and
// then the plugin. A failure is said and never fails the agent-org update, and the version the plugin moved from and to is said when it moved.
//
// Every program runs through the `Run` seam, so a test sees each command and answers it; none is run here.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentOrgHome, readOrNull, type Env } from "./paths.ts";
import { writeAtomic } from "./write-atomic.ts";
import { pluginStates, type PluginState } from "../ticket-mode/plugins.ts";
import type { RunResult } from "./service.ts";
import type { ProgramRunner } from "../ticket-port/stack-extension.ts";
import { repoViewArgs } from "../ticket-port/github-adapter.ts";

/** A program run with its arguments, as a `RunResult`. `claude` and `gh` are run through it. */
export type Run = (file: string, args: string[]) => RunResult;

/** Where the install record is read from: the plugins' state is asked of it through `pluginStates`. */
export type PluginRecord = Readonly<{ read?: (path: string) => string; exists?: (path: string) => boolean; record?: string }>;

/** One marketplace `claude plugin marketplace list --json` names: its name, where it came from, and its repository when it came from GitHub. */
export type MarketplaceEntry = Readonly<{ name: string; source: string; repo: string | null }>;

export type ConventionsDeps = Readonly<{
  run: Run;
  /** The plugin's state for a session, as the install record gives it, and the folder a session in it would run from. */
  stateOf: (plugin: string) => PluginState;
  /** A file's text, for a plugin's manifest; defaults to reading the file. */
  read?: (path: string) => string;
}>;

/** What installing the conventions plugin did: each step, one line, and the install's files when a session can load them. */
export type ConventionsStep = Readonly<{ lines: readonly string[]; installPath: string | null }>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const firstLine = (result: RunResult) => (result.stderr || result.stdout).trim().split("\n")[0] || `exit ${result.status}`;
const marketplaceOf = (plugin: string) => plugin.slice(plugin.indexOf("@") + 1);

/** The marketplaces `claude plugin marketplace list --json` printed, or null when its text is not that list. */
export function marketplacesOf(text: string): MarketplaceEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter(isObject).map((entry) => ({
    name: String(entry.name ?? ""),
    source: String(entry.source ?? ""),
    repo: typeof entry.repo === "string" ? entry.repo : null,
  }));
}

/** The marketplaces listed now, or null when `claude` cannot list them. */
function listed(run: Run): MarketplaceEntry[] | null {
  const result = run("claude", ["plugin", "marketplace", "list", "--json"]);
  return result.status === 0 ? marketplacesOf(result.stdout) : null;
}

/** The sentence for a marketplace that is listed with another source: it is left, and said. */
const otherSource = (entry: MarketplaceEntry, repo: string) => `the marketplace ${entry.name} is listed from ${entry.repo ?? entry.source}, not from ${repo}: it is left as it is, and not replaced`;

/**
 * The plugin installed for every session, from its repository, and read back. Stops at the first step that cannot be done: a repository the person cannot
 * read, a marketplace `claude` cannot add, or an install that fails. Each step says its result; a step already done says so, and runs nothing.
 */
export function installConventions({ plugin, repo }: Readonly<{ plugin: string; repo: string }>, deps: ConventionsDeps, gh: ProgramRunner): ConventionsStep {
  const marketplace = marketplaceOf(plugin);
  const visible = gh(repoViewArgs(repo));
  if (visible.status !== 0) {
    return { lines: [`could not read ${repo} as your GitHub login: ${firstLine(visible)}. The plugin is private: run \`gh auth login\`, then \`agent-org onboard\` again.`], installPath: null };
  }
  const lines: string[] = [];
  const marketplaces = listed(deps.run);
  if (marketplaces === null) return { lines: ["could not list Claude Code's marketplaces: is `claude` on PATH?"], installPath: null };
  const entry = marketplaces.find(({ name }) => name === marketplace);
  if (entry === undefined) {
    const added = deps.run("claude", ["plugin", "marketplace", "add", repo]);
    if (added.status !== 0) return { lines: [`could not add the marketplace from ${repo}: ${firstLine(added)}`], installPath: null };
    lines.push(`added the marketplace from ${repo}`);
  } else if (entry.source === "github" && entry.repo === repo) {
    lines.push(`the marketplace ${marketplace} is from ${repo} already: unchanged`);
  } else {
    lines.push(otherSource(entry, repo));
  }
  const state = deps.stateOf(plugin);
  if (state.installs.some(({ scope }) => scope === "user")) {
    lines.push(`${plugin} is installed for every folder already: unchanged`);
  } else {
    const installed = deps.run("claude", ["plugin", "install", plugin, "--scope", "user"]);
    if (installed.status !== 0) return { lines: [...lines, `could not install ${plugin}: ${firstLine(installed)}`], installPath: null };
    lines.push(`installed ${plugin} for every folder`);
  }
  const read = deps.stateOf(plugin);
  if (read.loads !== true || read.installPath === null) {
    return { lines: [...lines, `${plugin} does not load for a worker's session: ${read.why ?? "its install record cannot be read"}`], installPath: null };
  }
  return { lines: [...lines, `${plugin} loads for a worker's session`], installPath: read.installPath };
}

/** The version a plugin's manifest declares, or null when it has none it can read. */
export function pluginVersion(installPath: string | null, read: (path: string) => string = (path) => readFileSync(path, "utf8")): string | null {
  if (installPath === null) return null;
  try {
    const manifest: unknown = JSON.parse(read(join(installPath, ".claude-plugin", "plugin.json")));
    return isObject(manifest) && typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

/** What updating the conventions plugins said: each line, and each step that failed (which never fails `agent-org update`). */
export type ConventionsUpdate = Readonly<{ said: readonly string[]; failed: readonly string[] }>;

/**
 * The repository-sourced marketplaces of `plugins` (each `name@marketplace`) are updated, then each plugin in them. A marketplace from another source is not
 * updated here: its own refresh is not this install's to make. Says the version a plugin moved from and to; says nothing when it did not move.
 */
export function updateConventions(plugins: readonly string[], deps: ConventionsDeps): ConventionsUpdate {
  const said: string[] = [];
  const failed: string[] = [];
  const marketplaces = listed(deps.run);
  if (marketplaces === null) return { said, failed: ["could not list Claude Code's marketplaces, so the conventions plugins were not updated"] };
  for (const plugin of plugins) {
    const name = marketplaceOf(plugin);
    const entry = marketplaces.find((listedEntry) => listedEntry.name === name);
    if (entry === undefined || entry.source !== "github" || entry.repo === null) continue;
    const refreshed = deps.run("claude", ["plugin", "marketplace", "update", name]);
    if (refreshed.status !== 0) {
      failed.push(`could not update the marketplace ${name}: ${firstLine(refreshed)}`);
      continue;
    }
    const before = pluginVersion(deps.stateOf(plugin).installPath, deps.read);
    const updated = deps.run("claude", ["plugin", "update", plugin]);
    if (updated.status !== 0) {
      failed.push(`could not update ${plugin}: ${firstLine(updated)}`);
      continue;
    }
    const after = pluginVersion(deps.stateOf(plugin).installPath, deps.read);
    if (before !== after) said.push(`updated ${plugin} from ${before ?? "an unknown version"} to ${after ?? "an unknown version"}`);
  }
  return { said, failed };
}

/**
 * The plugin's state a conventions step reads, from an install record and a folder, through `pluginStates`, so onboard and update read the record the
 * same way.
 */
export function stateOfRecord(folder: string, record: PluginRecord = {}): (plugin: string) => PluginState {
  return (plugin) => {
    const { plugins } = pluginStates([plugin], folder, record);
    return plugins[0];
  };
}

/** A program run as the person, with its output read back: a program that cannot start is a result with no status, and the reason in its stderr. */
export const runProgram: Run = (file, args) => {
  const result = spawnSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 });
  if (result.error) return { status: null, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/** Where a held-back refresh is recorded, beside the update status file, for `doctor` to say so. */
export const deferralPath = (env: Env, home: string): string => join(agentOrgHome(env, home), "plugins-deferred.json");

/** The refresh a live run held back: since when (kept from the first deferral), and how many runs were live, or null when none is recorded. */
export function readDeferral(path: string): Readonly<{ since: string; live: number }> | null {
  const text = readOrNull(path);
  if (text === null) return null;
  try {
    const record: unknown = JSON.parse(text);
    return isObject(record) && typeof record.since === "string" && typeof record.live === "number" ? { since: record.since, live: record.live } : null;
  } catch {
    return null;
  }
}

/** Records the held-back refresh, keeping the time of the first deferral, so `doctor` can say how long it has waited. */
export function writeDeferral(path: string, live: number, now: Date): void {
  writeAtomic(path, `${JSON.stringify({ since: readDeferral(path)?.since ?? now.toISOString(), live })}\n`, 0o600);
}

/** Removes the record once the refresh has run, so `doctor` says nothing of a deferral that is over. */
export const clearDeferral = (path: string): void => rmSync(path, { force: true });
