#!/usr/bin/env node
// @ts-check
// command: update -- move this install to the newest release (or `--version vX.Y.Z`, or `--channel main`), and restart the instance and the ui; it applies within minutes, and a BREAKING release drains first unless `--force`
//
// EACH RELEASE IS ITS OWN FOLDER (A11-169, ADR 0001). `update` fetches the release tags into the bare mirror `<tool>/repo.git`, builds the target as `<tool>/versions/<tag>` (`git archive` and the pinned
// pnpm install, renamed into place only when whole), points `<tool>/current` at it, and restarts the services that were RUNNING and run the tool's code (`TOOL_SERVICES`: the instance and the ui). The
// terminal runs herdr web ui's code, herdr runs in its own service, and the auto-update timer is what runs this command, so none of them is restarted. Nothing under a live run changes: a run's hooks
// and commands name the version folder it started on (`tool-versions.ts`), and the folder is pruned only once no run that still has a workspace names it.
//
// AN UPDATE APPLIES WHATEVER IS LIVE, because a restart of the instance reaches no worker: herdr holds every pane in a service of its own. The one exception is a BREAKING release, whose changeset's
// first line starts `Breaking:` (`breaking-release.ts`): a run that started before it may not be resumable on it, so with runs live `update` builds the folder, writes the drain record
// (`update-drain.ts`) and swaps nothing. The instance starts no run while the record exists, stops and re-queues the live runs once `tickets.updateMaxDeferHours` has passed, and runs this command
// again; it applies when no run is live, and deletes the record. `--force` applies a breaking release at once, past the drain.
//
// THE FIRST UPDATE FROM A CHECKOUT INSTALL MIGRATES: the checkout `install.sh` made (or the agents host's clone) is not under `versions/`, so the mirror is seeded from its remote, the units, the
// launcher and the host file's `tool` are rewritten once to run through `<tool>/current`, and the services restart on it. The checkout itself is left untouched: runs that started on it keep calling it.
// Each run writes the status file `doctor` reads.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand } from "./command-exit.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { chooseReleaseTag, compareReleaseTags, isReleaseTag, isToolVersion, LATEST } from "../lib/release-tag.ts";
import { defaultServiceDeps, reloadService, restartService, serviceState, TOOL_SERVICES, type ServiceDeps, type ServiceName, type ServiceState } from "./service.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { hostFilePath, readOrNull, TOOL_ROOT } from "./paths.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { hostSettings, readLiveRuns, readQueue } from "./instance-queue.ts";
// eslint-disable-next-line clean-code/no-duplication -- import list: the rule matches statement shape, and imports are not duplicated logic
import { toolRootsInUse } from "../ticket-mode/queue/queue-pins.ts";
import type { TicketSettings } from "../ticket-mode/settings.ts";
import { pinnedPnpm } from "./pnpm.ts";
import { runProgram, stateOfRecord, updateConventions, type ConventionsUpdate, type Run } from "./plugin-install.ts";
import { readUpdateStatus, updateStatusPath, writeUpdateStatus, type UpdateStatus } from "./update-safety.ts";
import { clearDrain, drainPath, readDrain, writeDrain, type Drain, type DrainRecord } from "./update-drain.ts";
import { breakingLines } from "./breaking-release.ts";
import { toolDir, toolVersionAt } from "./tool-versions.ts";
import { buildVersion, completeUiBuild, withUpdateLock, currentVersionName, fetchMirror, mainVersionName, mirrorGit, mirrorTags, pruneVersions, seedMirror, swapCurrent, type Build, type Exec, type Git } from "./tool-install.ts";
import { migrateInstall } from "./tool-migrate.ts";
import { pluginUpkeep } from "./plugin-upkeep.ts";
import { HOUR_MS } from "./update-safety.ts";
import type { StepResult } from "../plugins/manifest.ts";
import { findBun } from "./bun.ts";
import { gitRemoteTags, fetchHerdrNewest, herdrStatusPath, herdrUpkeep, runHerdr, writeHerdrStatus, type HerdrNewest, type HerdrRun, type HerdrUpkeep } from "./herdr-upkeep.ts";
import { herdrConfigDir } from "./terminal.ts";

export type Channel = "release" | "main";

/** What the move is to: the version folder's name, and the ref in the mirror it is built from. */
type Target = Readonly<{ name: string; ref: string }>;

export type UpdateDeps = Readonly<{
  /** The folder of the code running this: a version folder, or the checkout of an install that has not migrated. */
  root: string;
  /** git in the bare mirror. */
  git: Git;
  /** Fetch the release tags (and `main`) into the mirror, making the mirror first from the checkout's remote when there is none. */
  fetch: (channel: Channel) => void;
  /** Build `versions/<name>` from `ref`, or find it built. */
  build: (name: string, ref: string) => Build;
  /** Give the version folder `name` the UI build its release declares and it lacks (A11-191). */
  completeUi: (name: string) => Build;
  /** Point `current` at `versions/<name>`. */
  swap: (name: string) => void;
  /** The version `current` names, or null when there is none (an install that has not migrated). */
  current: () => string | null;
  /** `toolVersion` of the host file when it pins a release, else undefined. */
  pinned: () => string | undefined;
  state: (name: ServiceName) => ServiceState;
  restart: (name: ServiceName) => void;
  /** How many runs the instance has live, or null when its queue cannot be read (no host file, or no ticket settings in it). */
  liveRuns: () => number | null;
  /** The version folders the queue still names (a run with a workspace, live or parked), or null when the queue cannot be read, in which case nothing is pruned. */
  inUse: () => readonly string[] | null;
  /** Remove the version folders nothing uses; returns the names removed. */
  prune: (inUse: readonly string[]) => string[];
  /** Point the units (and, from a checkout, the launcher and the host file's `tool`) at `current`; returns the lines to say, empty when everything already names it. */
  migrate: () => string[];
  /** The drain record: read, written whole, and removed. */
  drain: Readonly<{ read: () => Drain; write: (record: DrainRecord) => void; clear: () => void }>;
  /** `tickets.updateMaxDeferHours`: how long a breaking release may wait on live runs before they are stopped and re-queued. */
  maxDeferHours: number;
  now: () => number;
  /** The status file `doctor` reads, written whole after each run. */
  status: Readonly<{ write: (status: UpdateStatus) => void }>;
  /** What each enabled plugin keeps true on this machine, run at the end of every update: the code host keeps its stacking extension present (A11-106, A11-160). Never throws. */
  upkeep: () => readonly StepResult[];
  /** The conventions plugins `tickets.plugins` names, updated from their repositories (A11-145). Never throws. */
  conventions: () => ConventionsUpdate;
  /** herdr's side kept current (A11-184): its claude and codex integrations, and the herdr plugins agent-org installed, moved to their newest release tag. Never throws. */
  herdr: () => HerdrUpkeep;
  out: Pick<Console, "log" | "error">;
}>;

export class UpdateRefusal extends Error {}

/**
 * The production wiring of the conventions refresh (A11-145): the plugins of `settings` are refreshed through `claude`. It runs at every update (A11-169): a new run or round loads the new
 * copy, and a running session keeps the one it started with, since Claude Code keeps each version of a plugin in a folder of its own. Exported so the wiring is tested with a fake `claude`.
 */
export function conventionsWiring(settings: Pick<TicketSettings, "plugins"> | null, home: string, run: Run = runProgram): Pick<UpdateDeps, "conventions"> {
  return {
    conventions: () => (settings === null ? { said: [], failed: [] } : updateConventions(settings.plugins, { run, stateOf: stateOfRecord(home, { record: join(home, ".claude", "plugins", "installed_plugins.json") }) })),
  };
}

/**
 * The production wiring of herdr's upkeep (A11-184): `herdr` is run as the person, the newest release tags are read with `git ls-remote`, the terminal's unit is rewritten and restarted through the
 * service manager, and the newest versions are written to `herdr-status.json` for `doctor`. `newestHerdr` is read before the update's lock, since it is an HTTP read. Exported so the wiring is tested
 * with stand-in services, a stand-in `herdr` and a stand-in git.
 */
export function herdrWiring(newestHerdr: HerdrNewest, services: ServiceDeps, seams: { herdr?: HerdrRun; remoteTags?: (repo: string) => string } = {}): Pick<UpdateDeps, "herdr"> {
  const { env, home } = services;
  return {
    herdr: () => herdrUpkeep({
      herdr: seams.herdr ?? runHerdr,
      pluginsJson: () => services.read(join(herdrConfigDir(env, home), "plugins.json")),
      remoteTags: seams.remoteTags ?? gitRemoteTags,
      bunDir: () => {
        const bun = findBun(home, env.PATH, services.exists);
        return bun === null ? null : dirname(bun);
      },
      path: env.PATH ?? "/usr/bin:/bin",
      terminalState: () => serviceState("terminal", services),
      restartTerminal: () => reloadService("terminal", services),
      newestHerdr,
      writeStatus: (status) => writeHerdrStatus(herdrStatusPath(env, home), status),
      now: () => Date.now(),
    }),
  };
}

/**
 * Move to the newest release and restart what ran, unless the release is breaking and a run is live and `force` is not given: then the folder is built, the drain record written, and nothing
 * else changes. What the plugins keep true is kept whatever the move did (the code host's stacking extension, A11-106), and the conventions plugins are refreshed: a failure to do either is said, never raised.
 * @returns whether `current` moved
 */
export function update(options: { version: string | undefined; channel: Channel; force?: boolean }, deps: UpdateDeps): boolean {
  try {
    return moveTool(options, deps);
  } finally {
    keepPlugins(deps);
    keepConventions(deps);
    keepHerdr(deps);
  }
}

/** What the plugins keep true, said as each says it: an error for one that failed, and nothing for one with nothing to say. */
function keepPlugins(deps: UpdateDeps): void {
  for (const { ok, detail } of deps.upkeep()) {
    if (detail === "") continue;
    (ok ? deps.out.log : deps.out.error)(`agent-org update: ${detail}`);
  }
}

/** The conventions plugins, refreshed from their repositories at every update: a plugin that moved is said with its versions, and a step that failed is said as an error. Neither fails the update. */
function keepConventions(deps: UpdateDeps): void {
  sayUpkeep(deps, deps.conventions());
}

/** What an upkeep step did, in the update's log: a line for each change, an error line for each step that failed. */
function sayUpkeep(deps: UpdateDeps, { said, failed }: ConventionsUpdate): void {
  for (const line of said) deps.out.log(`agent-org update: ${line}`);
  for (const line of failed) deps.out.error(`agent-org update: ${line}`);
}

/**
 * herdr's integrations and plugins, kept current at every update (A11-184): what it changed is said, and a step that failed is an error. It runs whatever the move did, a drain included: none
 * of it reaches a live run (ADR 0004), and only the terminal service restarts, when the web UI moved. Neither fails the update.
 */
function keepHerdr(deps: UpdateDeps): void {
  sayUpkeep(deps, deps.herdr());
}

/** The release the move is to, or the main build. REFUSES when the mirror holds no such release: no fallback to `origin/main`, the host runs a release or the last one it ran. */
function targetOf(deps: UpdateDeps, version: string | undefined, channel: Channel): Target {
  if (channel === "main") return { name: mainVersionName(deps.git), ref: "refs/heads/main" };
  const wanted = version ?? deps.pinned() ?? LATEST;
  const tags = mirrorTags(deps.git);
  const tag = chooseReleaseTag(tags, wanted);
  if (tag === null) {
    const why = wanted === LATEST ? `it holds no release tag after fetching them; the tags it has: ${tags.join(", ") || "none"}` : `${wanted} is not a release it holds; the release tags it has: ${tags.filter(isReleaseTag).join(", ") || "none"}`;
    throw new UpdateRefusal(`agent-org was not moved: ${why}. It stays where it is and does not fall back to main.`);
  }
  return { name: tag, ref: `refs/tags/${tag}` };
}

/** The version this install is at: the folder `current` names, else the version of the code running this (an install that has not migrated). */
const installedName = (deps: UpdateDeps): string | null => deps.current() ?? toolVersionAt(deps.root);

/** The breaking lines between what is installed and `target`, read from the target tag's changelog; none on the main channel or when the changelog cannot be read. */
function breakingTo(deps: UpdateDeps, target: Target, installed: string | null, channel: Channel): ReturnType<typeof breakingLines> {
  if (channel === "main") return [];
  try {
    return breakingLines(deps.git(["show", `${target.ref}:CHANGELOG.md`]), installed, target.name);
  } catch (err) {
    // Not known not to be breaking, so it is treated as breaking: with runs live it waits, and a wait is bounded.
    return [{ release: target.name, summary: `Breaking: its changelog could not be read (${String((err as Error).message).split("\n")[0]})` }];
  }
}

function moveTool({ version, channel, force = false }: { version: string | undefined; channel: Channel; force?: boolean }, deps: UpdateDeps): boolean {
  if (version !== undefined && channel === "main") throw new UpdateRefusal("--version picks a release, and --channel main follows main: give one of them");
  if (version !== undefined && !isReleaseTag(version)) throw new UpdateRefusal(`--version ${version} is not a release tag such as v0.3.0`);
  // Read BEFORE the move: a restart is for a service that ran the old version, and nothing else.
  const running = TOOL_SERVICES.filter((name) => deps.state(name) === "running");
  deps.fetch(channel);
  const target = targetOf(deps, version, channel);
  const installed = installedName(deps);
  if (target.name === deps.current()) {
    // Nothing newer. A drain record for a release already applied is over (an update that stopped between its swap and its cleanup), and a unit that still names an earlier install's
    // checkout (install.sh ran over it, or the checkout's own timer ran the first update) is pointed at `current` now.
    deps.drain.clear();
    deps.out.log(`agent-org is at ${target.name}: nothing newer`);
    const noBuild = completeCurrentUi(deps, target.name);
    const migrated = deps.migrate();
    sayMigrated(deps, migrated);
    if (migrated.length > 0) restartRunning(deps, running);
    finish(deps, channel, target.name, installed);
    // After the status file and the restarts: what the update keeps true is kept, and the update still does not report success with the build missing.
    if (noBuild !== null) throw new UpdateRefusal(`agent-org is at ${target.name}, but it has no UI build, so the board shows "The UI build is missing": ${noBuild}`);
    return false;
  }
  const breaking = breakingTo(deps, target, installed, channel);
  const built = deps.build(target.name, target.ref);
  if (built.state === "failed") {
    // A drain for a release that cannot be built would hold the queue for nothing.
    deps.drain.clear();
    throw new UpdateRefusal(`agent-org stays at ${installed ?? "its current version"}, not moved to ${target.name}, because building it failed: ${built.reason}. Run \`agent-org doctor\`, then update again.`);
  }
  if (built.said !== undefined) deps.out.log(`agent-org update: ${built.said}`);
  // Read after the build, which can take minutes: a run that started meanwhile is live, and one that finished is not waited for.
  const live = running.includes("instance") ? deps.liveRuns() : null;
  if (mustDrain({ breaking: breaking.length > 0, force, live })) return drain(deps, { target, installed, channel, live: live ?? 0, lines: breaking.map((line) => `${line.release}: ${line.summary}`) });
  return apply(deps, { target, installed, running, channel });
}

/** Whether a breaking release waits on live runs: it is breaking, `--force` is not given, and the instance has a live run (a queue that cannot be read has none to wait for). */
function mustDrain({ breaking, force, live }: { breaking: boolean; force: boolean; live: number | null }): boolean {
  return breaking && !force && (live ?? 0) > 0;
}

/** Write the drain record, keeping the start of an earlier one: a release that supersedes the one being waited for does not give the live runs a fresh wait. */
function drain(deps: UpdateDeps, { target, installed, channel, live, lines }: { target: Target; installed: string | null; channel: Channel; live: number; lines: readonly string[] }): false {
  const earlier = deps.drain.read();
  const since = earlier.kind === "draining" ? earlier.record : null;
  const startedAt = since === null ? deps.now() : Date.parse(since.since);
  deps.drain.write({
    target: target.name, since: new Date(startedAt).toISOString(), deadline: new Date(startedAt + deps.maxDeferHours * HOUR_MS).toISOString(),
    stopped: since?.stopped ?? [], ...(since?.forcedAt === undefined ? {} : { forcedAt: since.forcedAt }),
  });
  deps.out.log(`agent-org update: ${target.name} is breaking (${lines.join("; ")}). ${live} ${live === 1 ? "run is" : "runs are"} live, so it is built and waits: no new run starts, the live runs finish, and any still live `
    + `${deps.maxDeferHours} ${deps.maxDeferHours === 1 ? "hour" : "hours"} after ${new Date(startedAt).toISOString()} are stopped and re-queued. \`agent-org update --force\` applies it now.`);
  recordStatus(deps, channel, target.name, installed ?? target.name);
  return false;
}

/** Swap `current`, point the units at it (the first update from a checkout rewrites them once), restart what ran, and clean up. */
function apply(deps: UpdateDeps, { target, installed, running, channel }: { target: Target; installed: string | null; running: readonly ServiceName[]; channel: Channel }): boolean {
  try {
    deps.swap(target.name);
  } catch (err) {
    throw new UpdateRefusal(`agent-org stays at ${installed ?? "its current version"}, not moved to ${target.name}, because current could not be moved to it: ${(err as Error).message}. Run \`agent-org doctor\`, then update again.`);
  }
  const migrated = deps.migrate();
  deps.out.log(`agent-org ${target.name} is current${installed !== null && installed !== target.name ? ` (it was ${installed})` : ""}`);
  sayMigrated(deps, migrated);
  // Restarts come before the status file: a status that cannot be written must not leave a moved install's services on the old modules.
  restartRunning(deps, running);
  deps.drain.clear();
  finish(deps, channel, target.name, target.name);
  return true;
}

/**
 * The folder `current` names, given the UI build its release declares when it has none (A11-191). The release that first ships the build is installed by the previous version's update, which does not
 * know of it, so this version's own update completes it. @returns why the build could not be had, or null when the folder has it (A11-266): the caller finishes the update and then refuses, because
 * an update that leaves the board without its UI build must not exit as a success.
 */
function completeCurrentUi(deps: UpdateDeps, name: string): string | null {
  const done = deps.completeUi(name);
  if (done.state === "failed") return done.reason;
  if (done.said !== undefined) deps.out.log(`agent-org update: ${done.said}`);
  return null;
}

/** Says what the migration rewrote. */
function sayMigrated(deps: UpdateDeps, migrated: readonly string[]): void {
  for (const line of migrated) deps.out.log(`agent-org update: ${line}`);
}

/** Restart the services that ran, so they run the version `current` names. */
function restartRunning(deps: UpdateDeps, running: readonly ServiceName[]): void {
  for (const name of running) {
    deps.restart(name);
    deps.out.log(`restarted the ${name} service so it runs the version above`);
  }
}

/** The status file, and the folders no run uses any more. A queue that cannot be read prunes nothing. */
function finish(deps: UpdateDeps, channel: Channel, latest: string, installed: string | null): void {
  const inUse = deps.inUse();
  if (inUse !== null) {
    const removed = deps.prune(inUse);
    if (removed.length > 0) deps.out.log(`agent-org update: removed ${removed.join(", ")}, which no run uses`);
  }
  recordStatus(deps, channel, latest, installed ?? latest);
}

/** Writes what this run saw: the install, and the newest release. `doctor` reads it. */
function recordStatus(deps: UpdateDeps, channel: Channel, latest: string, installed: string): void {
  const date = (ref: string): string => {
    try {
      return deps.git(["log", "-1", "--format=%cI", ref]).trim();
    } catch {
      return new Date(deps.now()).toISOString();
    }
  };
  const newest = channel === "main" ? { name: "main", since: date("refs/heads/main") } : releaseNewest(deps);
  deps.status.write({ checkedAt: new Date(deps.now()).toISOString(), channel, installed, latest: newest?.name ?? latest, latestSince: newest?.since ?? date(`refs/tags/${latest}`) });
}

/** The newest release the mirror holds, and the date its commit was made. */
function releaseNewest(deps: UpdateDeps): { name: string; since: string } | null {
  const tag = mirrorTags(deps.git).filter(isReleaseTag).toSorted(compareReleaseTags).at(-1);
  if (tag === undefined) return null;
  return { name: tag, since: deps.git(["log", "-1", "--format=%cI", `refs/tags/${tag}`]).trim() };
}

/** The `toolVersion` the host file pins, when it is a release tag (`latest` is no pin). */
export function pinnedVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const text = readOrNull(hostFilePath(env));
  if (text === null) return undefined;
  let value: unknown;
  try {
    value = (JSON.parse(text) as { toolVersion?: unknown }).toolVersion;
  } catch {
    return undefined;
  }
  if (value === undefined || value === LATEST) return undefined;
  if (!isToolVersion(value)) throw new UpdateRefusal(`the host file's toolVersion is ${JSON.stringify(value)}, which is neither "latest" nor a release tag such as v0.3.0: fix it, and the update will not follow the newest release meanwhile`);
  return String(value);
}

function defaultUpdateDeps(upkeep: UpdateDeps["upkeep"], newestHerdr: HerdrNewest): UpdateDeps {
  // Corepack fetches the pinned pnpm the first time; with no person at a prompt, it must not ask.
  process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
  const root = TOOL_ROOT;
  const home = homedir();
  const tool = toolDir(process.env, home);
  const git = mirrorGit(tool);
  const exec: Exec = execFileSync;
  const services = defaultServiceDeps();
  const settings = hostSettings();
  const statusPath = updateStatusPath(process.env, home);
  const drainFile = drainPath(process.env, home);
  return {
    root, git,
    fetch: (channel) => {
      // The first update from a checkout seeds the mirror from the checkout's own remote; an install made in version folders has its mirror already.
      if (!existsSync(join(tool, "repo.git", "HEAD"))) seedMirror(tool, execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", env: sandboxGitEnv() }).trim(), exec);
      fetchMirror(git, channel);
    },
    build: (name, ref) => buildVersion({ tool, name, ref, exec, pnpm: pinnedPnpm }),
    completeUi: (name) => completeUiBuild({ tool, name }),
    swap: (name) => swapCurrent(tool, name),
    current: () => currentVersionName(tool),
    pinned: () => pinnedVersion(),
    state: (name) => serviceState(name, services),
    restart: (name) => restartService(name, services),
    liveRuns: () => readLiveRuns(),
    inUse: () => {
      const queue = readQueue();
      return queue === null ? null : toolRootsInUse(queue);
    },
    prune: (inUse) => pruneVersions({ tool, inUse, self: root }),
    migrate: () => migrateInstall({ oldRoot: root, tool, home, env: process.env, services, hostPath: hostFilePath(process.env), binDir: settings?.binDir ?? join(home, ".local", "bin") }),
    drain: { read: () => readDrain(drainFile), write: (record) => writeDrain(drainFile, record), clear: () => clearDrain(drainFile) },
    maxDeferHours: settings?.updateMaxDeferHours ?? 2,
    now: () => Date.now(),
    status: { write: (status) => writeUpdateStatus(statusPath, status) },
    upkeep,
    ...conventionsWiring(settings, home),
    ...herdrWiring(newestHerdr, services),
    out: console,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  await runCommand("update", async () => {
    try {
      const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { version: { type: "string" }, channel: { type: "string", default: "release" }, force: { type: "boolean", default: false } } });
      if (values.channel !== "release" && values.channel !== "main") throw new UpdateRefusal(`--channel ${values.channel} is not release or main`);
      const { channel } = values;
      const upkeep = await pluginUpkeep(hostSettings(), process.env, { hostText: readOrNull(hostFilePath(process.env)) });
      const newestHerdr = await fetchHerdrNewest(runHerdr);
      withUpdateLock(toolDir(process.env, homedir()), () => update({ version: values.version, channel, force: values.force }, defaultUpdateDeps(upkeep, newestHerdr)));
      return 0;
    } catch (err) {
      console.error(`agent-org update: ${(err as Error).message}`);
      return 2;
    }
  });
}
