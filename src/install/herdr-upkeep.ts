// @ts-check
// module: keep herdr's side of an install current -- its claude and codex integrations, and the herdr plugins agent-org installed (A11-184)
//
// HERDR'S INTEGRATIONS ARE HOW IT KNOWS AN AGENT'S STATE (working, done, blocked) AND RESUMES ITS SESSION AFTER A RESTART, and the board reads agent status from herdr. They are versioned by
// herdr, so a herdr upgrade leaves them `outdated (v8 < v10)` until `herdr integration install <name>` runs again; nothing did, until this module. Likewise `devswha/herdr-web-ui` was
// installed with no `--ref`, which pinned a commit of its default branch, and nothing moved it afterwards.
//
// ONE MODULE, THREE CALLERS: `onboard` installs the integrations and the web UI at its newest release tag; `update` runs `herdrUpkeep` at the end of every run, beside the plugin upkeep; `doctor`
// reads the same parsers and the status file `herdrUpkeep` writes. PURE over injected seams, as `terminal.ts` and `plugin-install.ts` are: no test runs `herdr`, `git ls-remote` or the network.
//
// A PLUGIN IS FOUND IN `plugins.json` BY ITS SOURCE REPOSITORY, never by its manifest id (`herdr-plugins.ts`, A11-287): at v0.4.16 the web UI renamed its id, herdr added a second entry beside the old one, and
// a reader that took the first match read the old copy for ever. Of the copies of one repository the newest release is current; the others are STALE, and upkeep removes them once the terminal service
// runs the current one. A step that does not take (an install that fails or leaves plugins.json unchanged, an uninstall that leaves the entry) is said ONCE, with herdr's own output, recorded in
// `herdr-status.json` and held: later runs add no line and run nothing for that tag, `doctor` fails on the record, and a newer tag, or a hand fix, ends the hold.
//
// A PLUGIN MOVES ONLY TO A RELEASE TAG (`vX.Y.Z`, `release-tag.ts`), never to a branch, so a broken upstream `main` is never pulled; a remote with no release tag is a refusal, not a fall-back.
// Only a plugin on `HERDR_PLUGINS` is touched: one a person installed into herdr by hand is theirs. A herdr UPGRADE is a person's step: restarting herdr ends every live pane (ADR 0004), so
// this module only reports the newest version for `doctor` to warn about, and never runs `herdr update`.
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { chooseReleaseTag, compareReleaseTags, isReleaseTag, LATEST } from "../lib/release-tag.ts";
import { installedPlugin, pluginEntries, type InstalledPlugin, type PluginEntries } from "./herdr-plugins.ts";
import { agentOrgHome, type Env } from "./paths.ts";
import type { RunResult, ServiceState } from "./service.ts";
import { TERMINAL_PLUGIN } from "./terminal.ts";
import { readStatusText } from "./update-safety.ts";
import { writeAtomic } from "./write-atomic.ts";

/** The herdr integrations agent-org needs: the two agents it runs. */
export const HERDR_INTEGRATIONS = ["claude", "codex"] as const;
export type HerdrIntegration = (typeof HERDR_INTEGRATIONS)[number];

/** The herdr plugins agent-org installs and keeps current (today only the web terminal). Each builds with bun, so a move runs with bun's directory leading `PATH`. */
export const HERDR_PLUGINS: readonly string[] = [TERMINAL_PLUGIN];

/** Where herdr publishes its newest version, by channel (`herdr channel show`). */
const LATEST_URL: Readonly<Record<string, string>> = { stable: "https://herdr.dev/latest.json", preview: "https://herdr.dev/preview.json" };

const firstLine = (result: RunResult): string => (result.stderr || result.stdout).trim().split("\n")[0] || `exit ${result.status}`;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The command that installs (or reinstalls) one integration: what a failure and a failing doctor row name. */
export const integrationInstallCommand = (name: HerdrIntegration): string => `herdr integration install ${name}`;

/** The command that installs a plugin at a release tag. */
export const pluginInstallCommand = (repo: string, tag: string): string => `herdr plugin install ${repo} --ref ${tag} -y`;

/** The command that removes a stale copy of a plugin, by the manifest id herdr keys it by. */
export const pluginUninstallCommand = (pluginId: string): string => `herdr plugin uninstall ${pluginId}`;

/** herdr's own words for a step: stdout then stderr, trimmed, the last 20 lines and at most 2,000 characters, so a build error shows and a log is not flooded. */
export function herdrOutput(result: RunResult): string {
  const text = [result.stdout, result.stderr].map((part) => part.trim()).filter((part) => part !== "").join("\n");
  return text.split("\n").slice(-20).join("\n").slice(-2000) || `exit ${result.status}`;
}

// ---- integrations ----

export type IntegrationState = Readonly<{ name: HerdrIntegration; state: "current" | "outdated" | "missing"; detail: string }>;

/**
 * The state of each of `HERDR_INTEGRATIONS` in the text of `herdr integration status`, which prints one line per agent: `claude: current (v10) (<path>)`, `claude: outdated (v8 < v10)`,
 * `pi: not installed (<path>)`. A name with no line, or a line that is neither current nor outdated, is MISSING: an install is idempotent, so what is not known to be current is installed.
 */
export function integrationStates(statusText: string): IntegrationState[] {
  const said = new Map<string, string>();
  for (const line of statusText.split("\n")) {
    const match = /^([a-z0-9-]+):\s*(.*)$/.exec(line.trim());
    if (match !== null) said.set(match[1], match[2]);
  }
  return HERDR_INTEGRATIONS.map((name) => stateOf(name, said.get(name)));
}

function stateOf(name: HerdrIntegration, said: string | undefined): IntegrationState {
  const match = said === undefined ? null : /^(current|outdated)\b(?:\s*(\([^)]*\)))?/.exec(said);
  if (match === null) return { name, state: "missing", detail: said === undefined ? "not listed by herdr" : said.replace(/\s*\(\/[^)]*\)$/, "") || "no state given" };
  const state = match[1] as "current" | "outdated";
  return { name, state, detail: match[2] === undefined ? state : `${state} ${match[2]}` };
}

// ---- plugins ----

export { installedPlugin, pluginEntries, type InstalledPlugin, type PluginEntries };

/** Where an installed plugin is, as a person reads it: its release tag, else the commit it was pinned to (`@35bf28fa`). */
export function describeInstalled(plugin: InstalledPlugin): string {
  if (plugin.ref !== null && isReleaseTag(plugin.ref)) return plugin.ref;
  if (plugin.commit !== null) return `@${plugin.commit.slice(0, 8)}`;
  return plugin.ref ?? "its default branch";
}

/** Whether the plugin is behind `newest`: it is not on a release tag at all (a commit, a branch, none), or on an older one. */
export const isBehind = (plugin: InstalledPlugin, newest: string): boolean => plugin.ref === null || !isReleaseTag(plugin.ref) || compareReleaseTags(plugin.ref, newest) < 0;

/** The newest release tag in the text of `git ls-remote --tags`, or null when it names none. A pre-release, a branch and a moving name are never chosen. */
export const newestReleaseTag = (lsRemote: string): string | null =>
  chooseReleaseTag([...lsRemote.matchAll(/\srefs\/tags\/(\S+?)(?:\^\{\})?$/gm)].map((match) => match[1]), LATEST);

/** `git ls-remote --tags` of a GitHub repository as the update runs git: sandboxed, and bounded in time. THROWS when git fails. */
export const gitRemoteTags = (repo: string): string =>
  execFileSync("git", ["ls-remote", "--tags", `https://github.com/${repo}`], { encoding: "utf8", env: sandboxGitEnv(), timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });

/** The newest release tag of `repo`, as onboard and update read it. THROWS with the reason: git failed, or the repository has no release tag. */
export function newestPluginTag(repo: string, remoteTags: (repo: string) => string = gitRemoteTags): string {
  let listing: string;
  try {
    listing = remoteTags(repo);
  } catch (err) {
    throw new Error(`could not list the release tags of ${repo}: ${String((err as Error).message).trim().split("\n")[0]}`);
  }
  const tag = newestReleaseTag(listing);
  if (tag === null) throw new Error(`${repo} has no release tag, and agent-org installs a plugin only at a release tag, never a branch`);
  return tag;
}

// ---- herdr itself ----

/** herdr's own newest version, as `herdr.dev` publishes it, or why it is not known. */
export type HerdrNewest = Readonly<{ version: string }> | Readonly<{ why: string }>;

const BARE_VERSION = /\d+\.\d+\.\d+/;

/** The version in `herdr --version` (`herdr 0.9.3`), or null when the text holds none. */
export const herdrVersionOf = (versionText: string): string | null => BARE_VERSION.exec(versionText)?.[0] ?? null;

/** Whether herdr `installed` is behind `newest`, both bare versions (`0.9.3`). A version that is not `x.y.z` is not known, never behind. */
export function herdrBehind(installed: string, newest: string): boolean {
  const [have, want] = [`v${installed}`, `v${newest}`];
  return isReleaseTag(have) && isReleaseTag(want) && compareReleaseTags(have, want) < 0;
}

export type HerdrRun = (args: string[], env?: Env) => RunResult;

/**
 * herdr's newest version: its channel (`herdr channel show`: `stable` or `preview`) names the file `herdr.dev` publishes, whose `version` is a bare `0.9.5`. Never throws; a version that cannot be
 * read is `why`. Async because the read is HTTP: `update` reads it before it takes its lock and hands the answer to `herdrUpkeep`.
 */
export async function fetchHerdrNewest(run: HerdrRun, getJson: (url: string) => Promise<unknown> = fetchJson): Promise<HerdrNewest> {
  try {
    const channel = run(["channel", "show"]);
    if (channel.status === null) return { why: `herdr cannot run: ${firstLine(channel)}` };
    const url = LATEST_URL[channel.status === 0 ? channel.stdout.trim() : "stable"] ?? LATEST_URL.stable;
    const body = await getJson(url);
    const version = isObject(body) && typeof body.version === "string" ? body.version : "";
    return /^\d+\.\d+\.\d+$/.test(version) ? { version } : { why: `${url} gives no version of the form x.y.z` };
  } catch (err) {
    return { why: String((err as Error).message).split("\n")[0] };
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

/** `herdr` run as the person, with `env` added to this process's: a program that cannot start is a result with no status and the reason in its stderr. */
export const runHerdr: HerdrRun = (args, env) => {
  const result = spawnSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, ...(env === undefined ? {} : { env: { ...process.env, ...env } }) });
  if (result.error) return { status: null, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

// ---- the status file doctor reads ----

/** What the last upkeep run saw of the newest releases, so `doctor` compares against them with no network (as `update lag` does with `update-status.json`, A11-90). */
export type HerdrStatus = Readonly<{
  checkedAt: string;
  herdr: { newest: string } | { why: string };
  plugins: readonly PluginRecord[];
}>;

/** A plugin step that did not take at release `tag`: the command, herdr's own output (see `herdrOutput`) and when. Held until a newer tag is out or plugins.json shows the plugin fixed. */
export type PluginFailure = Readonly<{ command: string; tag: string; output: string; at: string }>;

/** What the last run saw of one plugin: its newest release (or why that is not known) and, while one holds, the step that failed. */
export type PluginRecord = Readonly<{ repo: string; failed?: PluginFailure }> & ({ readonly newest: string } | { readonly why: string });

export type HerdrStatusFile = { kind: "absent" } | { kind: "unreadable"; why: string } | { kind: "status"; status: HerdrStatus };

export const herdrStatusPath = (env: Env, home: string): string => join(agentOrgHome(env, home), "herdr-status.json");

export function writeHerdrStatus(path: string, status: HerdrStatus): void {
  writeAtomic(path, `${JSON.stringify(status, null, 2)}\n`, 0o644);
}

/** The status file: absent, a status, or `unreadable` (never read as clean: `doctor` fails on it, and the next upkeep run writes the file again). */
export function readHerdrStatus(path: string, read: (path: string) => string | null = readStatusText): HerdrStatusFile {
  let text: string | null;
  try {
    text = read(path);
  } catch (err) {
    return { kind: "unreadable", why: (err as Error).message };
  }
  if (text === null) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable", why: "it is not valid JSON" };
  }
  const status = parseHerdrStatus(parsed);
  return status === null ? { kind: "unreadable", why: "it is not a herdr status" } : { kind: "status", status };
}

/** `{ newest }` or `{ why }` of a status entry, or null when it holds neither. */
function newestOrWhy(entry: Record<string, unknown>): { newest: string } | { why: string } | null {
  if (typeof entry.newest === "string") return { newest: entry.newest };
  return typeof entry.why === "string" ? { why: entry.why } : null;
}

/** The `failed` of a plugin entry: absent (`undefined`), a failure, or `null` when it is present and not one. */
function parseFailure(value: unknown): PluginFailure | undefined | null {
  if (value === undefined) return undefined;
  return isPluginFailure(value) ? { command: value.command, tag: value.tag, output: value.output, at: value.at } : null;
}

const isPluginFailure = (value: unknown): value is PluginFailure => isObject(value) && ["command", "tag", "output", "at"].every((key) => typeof value[key] === "string");

function parsePluginEntry(entry: unknown): PluginRecord | null {
  if (!isObject(entry) || typeof entry.repo !== "string") return null;
  const known = newestOrWhy(entry);
  const failed = parseFailure(entry.failed);
  if (known === null || failed === null) return null;
  return { repo: entry.repo, ...known, ...(failed === undefined ? {} : { failed }) };
}

/** Whether `value` has the status file's three parts, each of the right kind. */
const hasStatusParts = (value: unknown): value is { checkedAt: string; herdr: Record<string, unknown>; plugins: unknown[] } =>
  isObject(value) && typeof value.checkedAt === "string" && isObject(value.herdr) && Array.isArray(value.plugins);

function parseHerdrStatus(value: unknown): HerdrStatus | null {
  if (!hasStatusParts(value)) return null;
  const herdr = newestOrWhy(value.herdr);
  const plugins = value.plugins.map(parsePluginEntry);
  return herdr === null || plugins.includes(null) ? null : { checkedAt: value.checkedAt, herdr, plugins: plugins as PluginRecord[] };
}

// ---- auto-update's upkeep ----

export type HerdrUpkeepDeps = Readonly<{
  herdr: HerdrRun;
  /** The text of herdr's `plugins.json`, or null. */
  pluginsJson: () => string | null;
  /** `git ls-remote --tags` of a GitHub repository (`owner/repo`); throws when git fails. */
  remoteTags: (repo: string) => string;
  /** The directory of the `bun` this machine has (`~/.bun/bin` or on PATH), or null: a plugin's build runs `bun install`. */
  bunDir: () => string | null;
  /** The PATH a plugin's build would otherwise run with. */
  path: string;
  /** The status file the last run wrote: what holds a failed step quiet until a newer release is out. */
  lastStatus: () => HerdrStatusFile;
  terminalState: () => ServiceState;
  /** Write the terminal's unit again and restart it, so it runs the `plugin_root` now in `plugins.json`. Throws when the service manager refuses. */
  restartTerminal: () => void;
  /** herdr's newest version, read before the run. */
  newestHerdr: HerdrNewest;
  writeStatus: (status: HerdrStatus) => void;
  now: () => number;
}>;

/**
 * What upkeep did, as `update` logs it: a line for each change, and a line for each step that failed. `newFailures` counts the plugin steps that failed for the first time in this run (each also
 * recorded in the status file): the update run that sees one exits 1, and a later run held on the same tag does not.
 */
export type HerdrUpkeep = Readonly<{ said: readonly string[]; failed: readonly string[]; newFailures: number }>;

type Lines = { said: string[]; failed: string[]; newFailures: number };

/**
 * Called at the end of every `update`. Re-installs the `claude` and `codex` integrations when herdr says either is outdated or missing, moves each installed plugin of `HERDR_PLUGINS` to its newest
 * release tag, restarts the TERMINAL service when the web UI moved (and only then, and only if it was running), and records the newest versions for `doctor`. herdr itself and the instance are never
 * restarted. Never throws. Says nothing when there is nothing to change, so a quiet ten-minute run adds no line to the log, and nothing at all on a machine where herdr cannot start.
 */
export function herdrUpkeep(deps: HerdrUpkeepDeps): HerdrUpkeep {
  const lines: Lines = { said: [], failed: [], newFailures: 0 };
  try {
    // A machine whose herdr cannot start (it is not installed here) has nothing to keep current: `doctor` fails its `herdr` row, and a line in the log every ten minutes would add nothing.
    if (deps.herdr(["--version"]).status === null) return lines;
    keepIntegrations(deps, lines);
    const plugins = keepPlugins(deps, lines);
    recordStatus(deps, lines, plugins);
  } catch (err) {
    lines.failed.push(`herdr upkeep stopped: ${String((err as Error).message).split("\n")[0]}`);
  }
  return lines;
}

/** The integrations as herdr says them now, or why `herdr integration status` could not be read. */
function integrationsNow(deps: HerdrUpkeepDeps): { states: IntegrationState[] } | { why: string } {
  const status = deps.herdr(["integration", "status"]);
  return status.status === 0 ? { states: integrationStates(status.stdout) } : { why: firstLine(status) };
}

function keepIntegrations(deps: HerdrUpkeepDeps, lines: Lines): void {
  const read = integrationsNow(deps);
  if ("why" in read) {
    lines.failed.push(`could not read \`herdr integration status\` (${read.why}), so herdr's claude and codex integrations were not checked`);
    return;
  }
  for (const before of read.states.filter(({ state }) => state !== "current")) reinstallIntegration(deps, lines, before);
}

function reinstallIntegration(deps: HerdrUpkeepDeps, lines: Lines, before: IntegrationState): void {
  const command = integrationInstallCommand(before.name);
  const installed = deps.herdr(["integration", "install", before.name]);
  if (installed.status !== 0) {
    lines.failed.push(`herdr's ${before.name} integration is ${before.detail}, and \`${command}\` failed: ${firstLine(installed)}`);
    return;
  }
  const read = integrationsNow(deps);
  const after = "states" in read ? read.states.find(({ name }) => name === before.name) : undefined;
  if (after?.state !== "current") {
    lines.failed.push(`\`${command}\` ran, but herdr's ${before.name} integration is still ${after?.detail ?? "not readable"}`);
    return;
  }
  lines.said.push(`reinstalled herdr's ${before.name} integration (it was ${before.detail}; now ${after.detail})`);
}

/** Keeps each installed plugin of `HERDR_PLUGINS` current, and returns what to record of each. */
function keepPlugins(deps: HerdrUpkeepDeps, lines: Lines): PluginRecord[] {
  const last = deps.lastStatus();
  const records: PluginRecord[] = [];
  for (const repo of HERDR_PLUGINS) {
    const found = pluginEntries(deps.pluginsJson(), repo);
    if (found === null) continue;
    const earlier = last.kind === "status" ? last.status.plugins.find((entry) => entry.repo === repo)?.failed : undefined;
    records.push(keepPlugin(deps, lines, repo, found, earlier));
  }
  return records;
}

/** A record that keeps `failed` when there is one. */
const recordOf = (repo: string, known: { newest: string } | { why: string }, failed: PluginFailure | undefined): PluginRecord => ({ repo, ...known, ...(failed === undefined ? {} : { failed }) });

/**
 * One plugin: move it to the newest release tag when it is behind, make the terminal run it, then remove the stale copies a renamed id left. A failed step is recorded for the tag and, while that
 * record stands, nothing is run for the tag and nothing is said; plugins.json showing the plugin current with no stale copy ends the record, as does a newer tag.
 */
function keepPlugin(deps: HerdrUpkeepDeps, lines: Lines, repo: string, found: PluginEntries, earlier: PluginFailure | undefined): PluginRecord {
  let tag: string;
  try {
    tag = newestPluginTag(repo, deps.remoteTags);
  } catch (err) {
    const why = (err as Error).message;
    lines.failed.push(`${why}, so the herdr plugin ${repo} stays at ${describeInstalled(found.current)}`);
    return recordOf(repo, { why }, earlier);
  }
  const known = { newest: tag };
  const behind = isBehind(found.current, tag);
  if (!behind && found.stale.length === 0) return recordOf(repo, known, undefined);
  if (earlier?.tag === tag) return recordOf(repo, known, earlier);
  const moved = behind ? movePlugin(deps, lines, repo, tag, found.current) : { entries: found, movedTo: null };
  if ("failure" in moved) return recordOf(repo, known, moved.failure);
  return recordOf(repo, known, settlePlugin(deps, lines, repo, tag, moved));
}

type Moved = Readonly<{ entries: PluginEntries; movedTo: string | null }> | Readonly<{ failure: PluginFailure | undefined }>;

/** Records a plugin step that failed, and counts it as new. */
function recordFailure(deps: HerdrUpkeepDeps, lines: Lines, failure: Omit<PluginFailure, "at">): PluginFailure {
  lines.newFailures += 1;
  return { ...failure, at: new Date(deps.now()).toISOString() };
}

/** What herdr printed, as an error line says it. */
const herdrSaid = (result: RunResult): string => `herdr said:\n${herdrOutput(result)}`;

function movePlugin(deps: HerdrUpkeepDeps, lines: Lines, repo: string, tag: string, before: InstalledPlugin): Moved {
  const command = pluginInstallCommand(repo, tag);
  const bunDir = deps.bunDir();
  if (bunDir === null) {
    lines.failed.push(`the herdr plugin ${repo} is at ${describeInstalled(before)}, and ${tag} is out; it builds with bun, which this machine has none of in ~/.bun/bin or on PATH. Run \`agent-org onboard\`, which installs bun`);
    return { failure: undefined };
  }
  const installed = deps.herdr(["plugin", "install", repo, "--ref", tag, "-y"], { PATH: `${bunDir}:${deps.path}` });
  const output = herdrOutput(installed);
  if (installed.status !== 0) {
    lines.failed.push(`the herdr plugin ${repo} is at ${describeInstalled(before)} and \`${command}\` failed (exit ${installed.status}); ${herdrSaid(installed)}`);
    return { failure: recordFailure(deps, lines, { command, tag, output }) };
  }
  const entries = pluginEntries(deps.pluginsJson(), repo);
  if (entries === null || entries.current.ref !== tag) {
    lines.failed.push(`\`${command}\` ran, but herdr's plugins.json does not list ${repo} at ${tag}; ${herdrSaid(installed)}`);
    return { failure: recordFailure(deps, lines, { command, tag, output }) };
  }
  lines.said.push(`moved the herdr plugin ${repo} from ${describeInstalled(before)} to ${tag}`);
  return { entries, movedTo: tag };
}

/** Makes the terminal run the current copy of the web UI, then removes the stale copies; the failure, if any, of the first uninstall that did not take. Other plugins have no service to restart. */
function settlePlugin(deps: HerdrUpkeepDeps, lines: Lines, repo: string, tag: string, { entries, movedTo }: { entries: PluginEntries; movedTo: string | null }): PluginFailure | undefined {
  if (repo === TERMINAL_PLUGIN && !terminalRunsCurrent(deps, lines, tag, { movedTo, staleLeft: entries.stale.length > 0 })) return undefined;
  return removeStale(deps, lines, repo, tag, entries.stale);
}

/** Whether the terminal service runs the current copy now (it restarted, or there was nothing to restart); a refusal is said, and leaves the stale copies its unit may still use. */
function terminalRunsCurrent(deps: HerdrUpkeepDeps, lines: Lines, tag: string, { movedTo, staleLeft }: { movedTo: string | null; staleLeft: boolean }): boolean {
  const refused = restartTerminal(deps, lines, tag);
  if (refused === null) return true;
  const lead = movedTo === null ? `the herdr web ui is at ${tag}, but` : "the herdr web ui moved, but";
  lines.failed.push(`${lead} the terminal service did not restart: ${refused}.${staleLeft ? " The old copy stays until it does." : ""} Run \`agent-org start terminal\``);
  return false;
}

/** Uninstalls each stale copy of `repo`; returns the failure of the first uninstall that did not take. */
function removeStale(deps: HerdrUpkeepDeps, lines: Lines, repo: string, tag: string, stale: readonly InstalledPlugin[]): PluginFailure | undefined {
  for (const old of stale) {
    const command = pluginUninstallCommand(old.pluginId);
    const removed = deps.herdr(["plugin", "uninstall", old.pluginId]);
    const stillListed = pluginEntries(deps.pluginsJson(), repo)?.stale.some((entry) => entry.pluginId === old.pluginId) ?? false;
    if (removed.status === 0 && !stillListed) {
      lines.said.push(`removed the stale herdr plugin ${old.pluginId}, which ${tag} replaced`);
      continue;
    }
    const what = removed.status === 0 ? `\`${command}\` ran, but herdr's plugins.json still lists ${old.pluginId}` : `\`${command}\` failed (exit ${removed.status})`;
    lines.failed.push(`the herdr plugin ${repo} is at ${tag}, but its stale copy ${old.pluginId} stays: ${what}; ${herdrSaid(removed)}`);
    return recordFailure(deps, lines, { command, tag, output: herdrOutput(removed) });
  }
  return undefined;
}

/**
 * The terminal service runs the web UI's code, so it restarts to run the current copy; a terminal a person stopped, or that is not registered, is left as it is (starting it writes its unit from
 * `plugins.json`). @returns why the service manager refused, or null when it restarted or had nothing to restart: a refusal leaves the stale copy its unit may use
 */
function restartTerminal(deps: HerdrUpkeepDeps, lines: Lines, tag: string): string | null {
  if (deps.terminalState() !== "running") return null;
  try {
    deps.restartTerminal();
    lines.said.push(`restarted the terminal service so it runs herdr web ui ${tag}`);
    return null;
  } catch (err) {
    return String((err as Error).message).split("\n")[0];
  }
}

/** Writes what this run saw of the newest releases, for `doctor`. A herdr version that cannot be read is said as a failure and recorded with its reason. */
function recordStatus(deps: HerdrUpkeepDeps, lines: Lines, plugins: readonly PluginRecord[]): void {
  const herdr = "version" in deps.newestHerdr ? { newest: deps.newestHerdr.version } : { why: deps.newestHerdr.why };
  if ("why" in herdr) lines.failed.push(`could not read herdr's newest version: ${herdr.why}`);
  try {
    deps.writeStatus({ checkedAt: new Date(deps.now()).toISOString(), herdr, plugins });
  } catch (err) {
    lines.failed.push(`could not write herdr-status.json: ${String((err as Error).message).split("\n")[0]}`);
  }
}
