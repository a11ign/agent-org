#!/usr/bin/env node
// @ts-check
// command: update -- move this install to the newest release (or `--version vX.Y.Z`, or `--channel main`), and restart each service that was running; it waits while a run is live unless `--force`
//
// THE MOVE IS `update-tool.ts`'s, not a second one. `updateTool` fetches the tags, refuses a dirty checkout, picks the newest release tag or the pinned
// one, puts the release's dependencies in place first and detaches at the tag. `--channel main` follows `origin/main` instead, for a person testing what
// has merged and not been released. Only this command moves the checkout `install.sh` made, so a running service holds the old modules until it restarts:
// each service that was RUNNING before the move is restarted after it, and a stopped one is left stopped. Only the services that run this checkout's
// code are (`TOOL_SERVICES`): the terminal runs herdr web ui's, and the auto-update timer is what runs this command.
//
// AN UPDATE WAITS ONLY WHEN A RESTART WOULD INTERRUPT A WORKER (A11-78, A11-90). While the instance service runs and its queue holds a live run (a worker
// starting or mid-turn, or the publish run), update first asks whether anything is newer. When nothing is, it says nothing about deferring and records
// that the install is current. Otherwise the move goes ahead when herdr's server is OUTSIDE the instance's cgroup (checked from /proc and systemd, since
// #1731 starts herdr in its own scope), or when no agent is mid-tool-call (`update-safety.ts`). If neither holds, update moves nothing and restarts
// nothing: it says `deferred: N runs live` and exits 0, and the next hourly run tries again. It defers BEFORE the move, not just the restart: a checkout
// moved under a running instance would leave the next run with nothing to move, so it would never restart, and the instance would load the new
// version's modules into the old one's process. A deferral lasts at most `tickets.updateMaxDeferHours` from its first deferral for that release, and then
// the move goes ahead. `--force` updates and restarts anyway, past every check. Each run writes the status file `doctor` reads.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { chooseReleaseTag, isReleaseTag, LATEST } from "../lib/release-tag.ts";
import { installDependencies, updateTool, type DependencyInstall } from "../update-tool.ts";
import { defaultServiceDeps, restartService, serviceState, TOOL_SERVICES, type ServiceName, type ServiceState } from "./service.ts";
import { hostFilePath, TOOL_ROOT } from "./paths.ts";
import { liveRunCount, type Queue } from "../ticket-mode/queue/queue-entries-and-outcomes.ts";
import { loadQueue } from "../ticket-mode/queue.ts";
import { HOST_FILE_ENV, readTicketSettings, type TicketSettings } from "../ticket-mode/settings.ts";
import { readAgents, herdrRun } from "../herdr-agents.ts";
import { pinnedPnpm } from "./pnpm.ts";
import { clearDeferral, deferralPath, runProgram, stateOfRecord, updateConventions, writeDeferral, type ConventionsUpdate, type Run } from "./plugin-install.ts";
import { hostIsolation, midToolCall, readUpdateStatus, restartDecision, updateStatusPath, writeUpdateStatus, type Isolation, type MidToolCall, type UpdateStatus } from "./update-safety.ts";
import { pluginUpkeep } from "./plugin-upkeep.ts";
import type { StepResult } from "../plugins/manifest.ts";

export type Channel = "release" | "main";
export type Git = (args: string[]) => string;

export type UpdateDeps = Readonly<{
  root: string;
  git: Git;
  /** The release path's dependency install, before the checkout moves. */
  installForTag: (tag: string) => DependencyInstall;
  /** `--channel main`'s dependency install, in the checkout once it has moved. */
  installInPlace: () => void;
  state: (name: ServiceName) => ServiceState;
  restart: (name: ServiceName) => void;
  /** How many runs the instance has live, or null when its queue cannot be read (no host file, or no ticket settings in it). */
  liveRuns: () => number | null;
  /** Whether a restart of the instance reaches herdr's server. Read only while a run is live (A11-90). */
  isolation: () => Isolation;
  /** Whether a run is mid-tool-call, read only when the isolation check does not decide the move first (A11-90). */
  busy: () => MidToolCall;
  /** `tickets.updateMaxDeferHours`: how long a deferral may last, from its first. */
  maxDeferHours: number;
  now: () => number;
  /** The status file `doctor` reads: read for the deferral's start, and written whole after each run. */
  status: Readonly<{ read: () => UpdateStatus | null; write: (status: UpdateStatus) => void }>;
  /** What each enabled plugin keeps true on this machine, run at the end of every update: the code host keeps its stacking extension present (A11-106, A11-160). Never throws. */
  upkeep: () => readonly StepResult[];
  /** The conventions plugins `tickets.plugins` names, updated from their repositories when no run is live (A11-145). Never throws. */
  conventions: () => ConventionsUpdate;
  /** The refresh a live run holds back, recorded for `doctor` to say so, and cleared once the refresh has run (A11-145). */
  conventionsDeferral: Readonly<{ defer: (live: number) => void; clear: () => void }>;
  out: Pick<Console, "log" | "error">;
}>;

export class UpdateRefusal extends Error {}

/**
 * The production wiring of the conventions refresh (A11-145): the plugins of `settings` are refreshed through `claude`, and a wait is recorded under the
 * agent-org home of `home`. A host with no conventions plugin has nothing to wait for, so it records nothing for doctor to say. Exported so the wiring is
 * tested with a fake `claude`, not only the update around it.
 */
export function conventionsWiring(settings: Pick<TicketSettings, "plugins"> | null, env: NodeJS.ProcessEnv, home: string, run: Run = runProgram): Pick<UpdateDeps, "conventions" | "conventionsDeferral"> {
  const record = deferralPath(env, home);
  return {
    conventions: () => (settings === null ? { said: [], failed: [] } : updateConventions(settings.plugins, { run, stateOf: stateOfRecord(home, { record: join(home, ".claude", "plugins", "installed_plugins.json") }) })),
    conventionsDeferral: {
      defer: (live) => {
        if (settings !== null && settings.plugins.length > 0) writeDeferral(record, live, new Date());
      },
      clear: () => clearDeferral(record),
    },
  };
}

/**
 * Move the checkout and restart what ran, unless the running instance has a live run and `force` is not given: then nothing moves, and it says so.
 * What the plugins keep true is kept whatever the move did (the code host's stacking extension, A11-106): a deferred or unmoved update still runs it, and a failure to do so is said, never raised.
 * @returns whether the checkout moved
 */
export function update(options: { version: string | undefined; channel: Channel; force?: boolean }, deps: UpdateDeps): boolean {
  try {
    return moveCheckout(options, deps);
  } finally {
    keepPlugins(deps);
    keepConventions(deps);
  }
}

/** What the plugins keep true, said as each says it: an error for one that failed, and nothing for one with nothing to say. */
function keepPlugins(deps: UpdateDeps): void {
  for (const { ok, detail } of deps.upkeep()) {
    if (detail === "") continue;
    (ok ? deps.out.log : deps.out.error)(`agent-org update: ${detail}`);
  }
}

/**
 * The conventions plugins, refreshed from their repositories when no run is live (A11-145): a live run holds the refresh back, as it holds back a release, since
 * a skill is read when it is invoked and a refresh would change a running worker's instructions. A plugin that moved is said with its versions, and a step that
 * failed is said as an error. Neither fails the update, since the checkout has moved, or stays, either way.
 */
function keepConventions(deps: UpdateDeps): void {
  const live = deps.liveRuns();
  if (live !== null && live > 0) {
    deps.conventionsDeferral.defer(live);
    deps.out.log(`agent-org update: the conventions plugin refresh waits while ${live} ${live === 1 ? "run is" : "runs are"} live, and runs at the next update with none live`);
    return;
  }
  deps.conventionsDeferral.clear();
  const { said, failed } = deps.conventions();
  for (const line of said) deps.out.log(`agent-org update: ${line}`);
  for (const line of failed) deps.out.error(`agent-org update: ${line}`);
}

function moveCheckout({ version, channel, force = false }: { version: string | undefined; channel: Channel; force?: boolean }, deps: UpdateDeps): boolean {
  if (version !== undefined && channel === "main") throw new UpdateRefusal("--version picks a release, and --channel main follows main: give one of them");
  if (version !== undefined && !isReleaseTag(version)) throw new UpdateRefusal(`--version ${version} is not a release tag such as v0.3.0`);
  // Read BEFORE the move: a restart is for a service that ran the old version, and nothing else.
  const running = TOOL_SERVICES.filter((name) => deps.state(name) === "running");
  if (running.includes("instance") && !force) {
    const live = deps.liveRuns();
    if (live !== null && live > 0 && waitsForRuns(live, { version, channel }, deps)) return false;
  }
  const before = deps.git(["rev-parse", "HEAD"]).trim();
  if (channel === "main") {
    if (deps.git(["status", "--porcelain", "--untracked-files=no"]).trim() !== "") {
      throw new UpdateRefusal(`${deps.root} has changes to tracked files, so it was not moved. Discard them, or run update where they belong.`);
    }
    deps.git(["fetch", "--quiet", "origin", "main"]);
    deps.git(["checkout", "--detach", "--quiet", "FETCH_HEAD"]);
    try {
      deps.installInPlace();
    } catch (err) {
      // Back where it was, so the services and the launcher keep running a tree whose dependencies are in place.
      deps.git(["checkout", "--detach", "--quiet", before]);
      throw new UpdateRefusal(`installing main's dependencies failed, so the checkout stays at ${before}: ${(err as Error).message}`);
    }
    deps.out.log(`agent-org main (${deps.git(["rev-parse", "HEAD"]).trim()})`);
  } else {
    // A failed install is caught where it happens, not read back out of updateTool's message.
    let failed: { tag: string; reason: string } | null = null;
    const installForTag = (tag: string) => {
      const install = deps.installForTag(tag);
      if (install.state === "failed") failed = { tag, reason: install.reason };
      return install;
    };
    const moved = updateTool(deps.root, deps.git, version ?? LATEST, () => [], installForTag);
    if (failed !== null) throw installRefusal(failed, before, deps.git);
    deps.out.log(moved);
  }
  const moved = deps.git(["rev-parse", "HEAD"]).trim() !== before;
  // Restarts come before the status file: a status that cannot be written must not leave a moved install's services on the old modules.
  if (moved) {
    for (const name of running) {
      deps.restart(name);
      deps.out.log(`restarted the ${name} service so it runs the version above`);
    }
  }
  recordStatus(deps, channel);
  return moved;
}

/** The line a run that waits says, as it has since A11-78. */
function deferredLine(live: number): string {
  return `agent-org update deferred: ${live} ${live === 1 ? "run" : "runs"} live on the instance, which a restart would interrupt. `
    + "The next hourly update tries again; `agent-org update --force` updates and restarts now.";
}

/**
 * With a run live on a running instance, whether the move waits (A11-90). It asks first whether anything is newer: an install at the newest release says
 * nothing about deferring. A move that is newer goes ahead when a restart cannot interrupt anyone (`restartDecision`), and otherwise waits and says until
 * when, for at most `tickets.updateMaxDeferHours` from its first deferral for that release.
 */
function waitsForRuns(live: number, { version, channel }: { version: string | undefined; channel: Channel }, deps: UpdateDeps): boolean {
  let commit: string | null;
  try {
    commit = fetchTarget(deps, version, channel);
  } catch {
    // Offline, so nothing is known to be newer: the run waits, as it did before this check existed.
    deps.out.log(deferredLine(live));
    return true;
  }
  // No release to move to: the run waits as it always has, and the move says why, if the remote later holds one it cannot take.
  if (commit === null) {
    deps.out.log(deferredLine(live));
    return true;
  }
  if (commit === deps.git(["rev-parse", "HEAD"]).trim()) {
    recordStatus(deps, channel);
    return true;
  }
  const latest = newest(deps, channel);
  const decision = restartDecision({
    isolation: deps.isolation(), busy: deps.busy,
    deferredSince: latest === null ? undefined : deferredSinceOf(deps.status.read(), latest.name, channel),
    now: deps.now(), maxDeferHours: deps.maxDeferHours,
  });
  if (decision.go) {
    deps.out.log(`agent-org update: ${decision.reason}`);
    return false;
  }
  deps.out.log(`agent-org update deferred: ${live} ${live === 1 ? "run" : "runs"} live on the instance, which a restart would interrupt: ${decision.reason}. `
    + `It updates anyway at ${new Date(decision.giveUpAt).toISOString()}; the next hourly update tries again, and \`agent-org update --force\` updates and restarts now.`);
  recordStatus(deps, channel, decision.reason);
  return true;
}

/** The commit a move would reach, fetched the way `updateTool` fetches it. Null when the remote holds no release for `version`. */
function fetchTarget(deps: UpdateDeps, version: string | undefined, channel: Channel): string | null {
  if (channel === "main") {
    deps.git(["fetch", "--quiet", "origin", "main"]);
    return deps.git(["rev-parse", "FETCH_HEAD"]).trim();
  }
  // `--tags` NAMES them, as `updateTool` says: a release commit is reachable from no branch, so a plain fetch never brings its tag down.
  deps.git(["fetch", "--force", "--tags", "--quiet", "origin"]);
  const tag = chooseReleaseTag(tagNames(deps), version ?? LATEST);
  return tag === null ? null : deps.git(["rev-parse", `refs/tags/${tag}^{commit}`]).trim();
}

function tagNames(deps: UpdateDeps): string[] {
  return deps.git(["tag", "--list"]).split("\n").filter((name) => name !== "");
}

/** The newest release (`main` on the main channel), and the date its commit was made, as the checkout knows them now. */
function newest(deps: UpdateDeps, channel: Channel): { name: string; since: string } | null {
  if (channel === "main") return { name: "main", since: deps.git(["log", "-1", "--format=%cI", "FETCH_HEAD"]).trim() };
  const tag = chooseReleaseTag(tagNames(deps), LATEST);
  return tag === null ? null : { name: tag, since: deps.git(["log", "-1", "--format=%cI", `refs/tags/${tag}`]).trim() };
}

/** The release the checkout is at, or else its short commit: what `doctor` names as installed. */
function installedName(deps: UpdateDeps, channel: Channel): string {
  const tag = channel === "release" ? chooseReleaseTag(deps.git(["tag", "--points-at", "HEAD"]).split("\n"), LATEST) : null;
  return tag ?? deps.git(["rev-parse", "--short", "HEAD"]).trim();
}

/** When the first deferral for `latest` began, as the status file holds it: kept while that release is still the newest, and absent otherwise. */
function deferredSinceOf(previous: UpdateStatus | null, latest: string, channel: Channel): number | undefined {
  const isDifferentDeferral = previous === null || previous.latest !== latest || previous.channel !== channel || previous.deferredSince === undefined;
  if (isDifferentDeferral) return undefined;
  return Date.parse(previous.deferredSince);
}

/** Writes what this run saw: the install, the newest release, and the deferral it waits on when given one (`doctor` reads it). */
function recordStatus(deps: UpdateDeps, channel: Channel, deferredReason?: string): void {
  const latest = newest(deps, channel);
  if (latest === null) return;
  deps.status.write({
    checkedAt: new Date(deps.now()).toISOString(), channel, installed: installedName(deps, channel),
    latest: latest.name, latestSince: latest.since,
    ...(deferredReason === undefined ? {} : { deferredSince: new Date(deferredSinceOf(deps.status.read(), latest.name, channel) ?? deps.now()).toISOString(), deferredReason }),
  });
}

/** Why the checkout did not reach `tag`. It may already be there, with the dependencies it needs missing, which is not the same as being held back. */
function installRefusal({ tag, reason }: { tag: string; reason: string }, before: string, git: Git): UpdateRefusal {
  const already = git(["rev-parse", `refs/tags/${tag}^{commit}`]).trim() === before;
  const where = already ? `agent-org is already at ${tag}, but` : `agent-org stays at ${before}, not moved to ${tag}, because`;
  return new UpdateRefusal(`${where} installing its dependencies failed: ${reason}. Run \`agent-org doctor\`, then update again.`);
}

/** The host file's ticket settings, or null when they cannot be read. */
function hostSettings(env: NodeJS.ProcessEnv = process.env): TicketSettings | null {
  try {
    return readTicketSettings({ ...env, [HOST_FILE_ENV]: hostFilePath(env) });
  } catch {
    return null;
  }
}

/** The instance's queue, from the state directory the host file names, or null when that cannot be read. */
function readQueue(env: NodeJS.ProcessEnv = process.env): Queue | null {
  const settings = hostSettings(env);
  if (settings === null) return null;
  try {
    return loadQueue(join(settings.stateDir, "tickets", "queue.json"), settings.max);
  } catch {
    return null;
  }
}

/**
 * The instance's live runs, from its queue file in the state directory the host file names. Null when there is no host file or it holds no
 * ticket settings: that machine's update is not held back by a queue it cannot read.
 */
export function readLiveRuns(env: NodeJS.ProcessEnv = process.env): number | null {
  const queue = readQueue(env);
  return queue === null ? null : liveRunCount(queue);
}

/** Runs a program, as `execFileSync` does; a test passes one that records what it was asked to run. */
export type Exec = (file: string, args: string[], options: object) => unknown;

/** How update installs a release's or main's dependencies: always with the pinned pnpm, never the pnpm on PATH. */
export function dependencyInstalls(root: string, git: Git, exec: Exec = execFileSync): Pick<UpdateDeps, "installForTag" | "installInPlace"> {
  return {
    installForTag: (tag) => installDependencies({ root, tag, run: git, exec, pnpm: pinnedPnpm }),
    installInPlace: () => {
      const { command, args } = pinnedPnpm(["install", "--prod", "--no-frozen-lockfile", "--ignore-scripts", "--ignore-workspace"]);
      exec(command, args, { cwd: root, env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" }, stdio: ["ignore", "inherit", "inherit"] });
    },
  };
}

function defaultUpdateDeps(upkeep: UpdateDeps["upkeep"]): UpdateDeps {
  // Corepack fetches the pinned pnpm the first time; with no person at a prompt, it must not ask.
  process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
  const root = TOOL_ROOT;
  const git: Git = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });
  const services = defaultServiceDeps();
  const settings = hostSettings();
  // Without a host file no run is live (`liveRuns` is null), so the session below is asked for only where there is one.
  const session = settings?.herdrSession ?? "tickets";
  const statusPath = updateStatusPath(process.env, homedir());
  return {
    root, git,
    ...dependencyInstalls(root, git),
    state: (name) => serviceState(name, services),
    restart: (name) => restartService(name, services),
    liveRuns: () => readLiveRuns(),
    isolation: () => hostIsolation(services, session),
    busy: () => midToolCall({ agents: () => readAgents(herdrRun, { session }), queue: () => readQueue() }),
    maxDeferHours: settings?.updateMaxDeferHours ?? 2,
    now: () => Date.now(),
    // A status file that cannot be read is no status for the deferral clock: the run rewrites the file either way, and `doctor` is the one that fails on it.
    status: {
      read: () => {
        const file = readUpdateStatus(statusPath);
        return file.kind === "status" ? file.status : null;
      },
      write: (status) => writeUpdateStatus(statusPath, status),
    },
    upkeep,
    ...conventionsWiring(settings, process.env, homedir()),
    out: console,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), strict: true, options: { version: { type: "string" }, channel: { type: "string", default: "release" }, force: { type: "boolean", default: false } } });
    if (values.channel !== "release" && values.channel !== "main") throw new UpdateRefusal(`--channel ${values.channel} is not release or main`);
    update({ version: values.version, channel: values.channel, force: values.force }, defaultUpdateDeps(await pluginUpkeep(hostSettings())));
  } catch (err) {
    console.error(`agent-org update: ${(err as Error).message}`);
    process.exitCode = 2;
  }
}
