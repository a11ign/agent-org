// @ts-check
// module: the one-time move of an install from a git checkout to version folders (A11-169) -- the units, the launcher and the host file's `tool` are rewritten to run through `<tool>/current`
//
// WHAT RUNS THE TOOL NAMES THE CHECKOUT: each service's unit, the `agent-org` launcher, and the host file's `tool`. The first `update` that runs from a checkout (its root is not under `versions/`)
// builds the first version folder, points `current` at it, and then calls this, so none of the three is written again by an update: they name `current`, and an update moves the link.
// IT IS IDEMPOTENT, judged by the files and not by what is loaded: a unit already equal to the one it would write is left alone, so a second run, such as the old checkout's own timer firing
// again before the timer was re-armed, rewrites and restarts nothing. The checkout is left untouched: runs that started on it keep calling it.
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { reloadRewrittenLaunchd, SERVICE_NAMES, ServiceRefusal, unitFor, type ServiceDeps, type ServiceName, type Unit } from "./service.ts";
import { agentOrgHome } from "./paths.ts";
import { currentLink, versionNameOf } from "./tool-versions.ts";
import { writeAtomic } from "./write-atomic.ts";

/** The unit `name` would be written as when the tool runs through `entry`, or null when this version or machine cannot run it. */
function wanted(name: (typeof SERVICE_NAMES)[number], services: ServiceDeps): Unit | null {
  try {
    return unitFor(name, services);
  } catch (err) {
    if (err instanceof ServiceRefusal) return null;
    throw err;
  }
}

/** A unit that was rewritten, with the name of the service it runs. */
type Rewritten = Readonly<{ name: ServiceName; unit: Unit }>;

/** Rewrite each registered unit whose text differs from what it would be now. @returns the units rewritten */
function rewriteUnits(services: ServiceDeps): Rewritten[] {
  const changed: Rewritten[] = [];
  for (const name of SERVICE_NAMES) {
    const unit = wanted(name, services);
    // herdr's unit is registered here too (written, not enabled or started): the instance's unit `Want=`s it and `ensureSession` starts it, so a herdr that dies or a machine that reboots never has the
    // instance spawn a server inside its own cgroup. Starting it is `agent-org start herdr`'s, which refuses to start beside a server that runs outside it.
    if (unit === null || (!services.exists(unit.path) && name !== "herdr")) continue;
    const files = [{ path: unit.path, text: unit.text }, ...(unit.companion === null ? [] : [unit.companion])];
    const stale = files.filter((file) => services.read(file.path) !== file.text);
    if (stale.length === 0) continue;
    for (const file of stale) services.write(file.path, file.text);
    changed.push({ name, unit });
  }
  return changed;
}

/** Whether the host file declares a `primary` project: an org host, whose tool is a checkout that `update-tool` moves. */
function declaresProject(hostPath: string): boolean {
  try {
    return Object.hasOwn(JSON.parse(readFileSync(hostPath, "utf8")) as object, "primary");
  } catch {
    return false;
  }
}

/** Replace each spelling of `oldRoot` (as given, and real-pathed) in `text` with `entry`. */
function pointAt(text: string, oldRoot: string, entry: string): string {
  const spellings = new Set([oldRoot]);
  try {
    spellings.add(realpathSync(oldRoot));
  } catch {
    // an old checkout that is gone is named by the spelling the file has
  }
  return [...spellings].reduce((rewritten, spelling) => rewritten.replaceAll(spelling, entry), text);
}

/**
 * A launchd job holds the plist it was loaded with, so each rewritten job that is loaded is loaded again from the new one (A11-266): left alone, it would keep running the checkout or the folder it was
 * loaded for, and an auto-update job on old code does the updates. The auto-update job that is running THIS update is not booted out, because that kills the update in flight: it is said on `warn`
 * instead, and `agent-org start auto-update` loads it. A job launchd refuses to load again is said on `warn` too, and the others go on. @returns the lines to say
 */
function reloadLaunchdJobs(changed: readonly Rewritten[], { env, services, warn }: { env: NodeJS.ProcessEnv; services: ServiceDeps; warn: (line: string) => void }): string[] {
  const lines: string[] = [];
  for (const { name, unit } of changed) {
    if (unit.id === env.XPC_SERVICE_NAME) {
      // The plist on disk is now current, so a later update finds nothing to rewrite and loads nothing: only `agent-org start` loads this job again.
      warn(`agent-org update: ${unit.id} is the job running this update, so it was not loaded again and still runs the code it was loaded with. Run \`agent-org start ${name}\` to load the plist just written.`);
      continue;
    }
    try {
      if (reloadRewrittenLaunchd(name, unit, services)) lines.push(`loaded ${unit.id} again from its new plist`);
    } catch (err) {
      // A job launchd would not load again must not stop the update half-done: the refusal names the command that fixes it by hand.
      warn(`agent-org update: ${unit.id} was not loaded again: ${(err as Error).message}`);
    }
  }
  return lines;
}

/**
 * Point the units, the launcher and the host file's `tool` at `<tool>/current`. @returns one line per thing rewritten; none when everything already names `current`. A systemd manager is told to reload,
 * and the auto-update timer is restarted to take its new cadence; a launchd job's plist is rewritten and the job, when it is loaded, is loaded again from it (A11-266).
 */
export function migrateInstall({ oldRoot, tool, home, env, services, hostPath, binDir, warn = console.error }: {
  oldRoot: string; tool: string; home: string; env: NodeJS.ProcessEnv; services: ServiceDeps; hostPath: string; binDir: string; warn?: (line: string) => void;
}): string[] {
  const entry = currentLink(tool);
  const lines: string[] = [];
  const changed = rewriteUnits({ ...services, toolRoot: entry });
  if (changed.length > 0) {
    if (services.platform === "linux") {
      services.run("systemctl", ["--user", "daemon-reload"]);
      if (changed.some(({ unit }) => unit.interval)) services.run("systemctl", ["--user", "try-restart", "agent-org-auto-update.timer"]);
    }
    lines.push(`rewrote ${changed.map(({ unit }) => unit.id).join(", ")} to run through ${entry}`);
    if (services.platform === "darwin") lines.push(...reloadLaunchdJobs(changed, { env, services, warn }));
  }
  // The launcher and the host file name the checkout this process runs from, so they are rewritten only when it is one; from a version folder, install.sh wrote the launcher already. A host that declares
  // a project (`primary`) is an org host: its `tool` is the git checkout `update-tool` moves, and stays one.
  if (versionNameOf(oldRoot) !== null || declaresProject(hostPath)) return lines;
  const launcher = join(binDir, "agent-org");
  if (rewriteFile(launcher, oldRoot, entry, (path) => (existsSync(path) ? statSync(path).mode & 0o777 : 0o755))) lines.push(`pointed ${launcher} at ${entry}`);
  if (rewriteHostTool(hostPath, oldRoot, entry)) lines.push(`set the host file's tool to ${entry} (${hostPath})`);
  rmSync(join(agentOrgHome(env, home), "plugins-deferred.json"), { force: true });
  return lines;
}

/** Replace `oldRoot` with `entry` in the file at `path`, keeping its mode. False when there is no such file or it does not name `oldRoot`. */
function rewriteFile(path: string, oldRoot: string, entry: string, modeOf: (path: string) => number): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  const next = pointAt(text, oldRoot, entry);
  if (next === text) return false;
  writeAtomic(path, next, modeOf(path));
  return true;
}

/** The host file's top-level `"tool": "<oldRoot>"`, set to `entry` in the text as it is written (the file's formatting is kept). False when the file names another tool or none. */
function rewriteHostTool(hostPath: string, oldRoot: string, entry: string): boolean {
  if (!existsSync(hostPath)) return false;
  const text = readFileSync(hostPath, "utf8");
  const quoted = (value: string) => JSON.stringify(value);
  const next = text.replace(new RegExp(`("tool"\\s*:\\s*)${quoted(oldRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `$1${quoted(entry)}`);
  if (next === text) return false;
  writeAtomic(hostPath, next, statSync(hostPath).mode & 0o777);
  return true;
}
