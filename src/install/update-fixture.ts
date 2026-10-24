// no-token: none -- a git repository this file builds in a temporary directory stands for the remote; the services, `systemctl` and the dependency install are stand-ins
// module: what the update tests share (A11-169) -- a remote that has cut releases, a throwaway home, and the real install steps wired to stand-in services
//
// The REAL steps run: the bare mirror, `git archive`, the rename into place, the `current` link, the prune and the migration. What is stubbed is what is machine-wide: `systemctl`/`launchctl` (a
// recording `run`), the services' state, the pinned pnpm (a function that makes `node_modules`), and the queue the prune and the drain read.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../commands.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { clearDrain, drainPath, readDrain, writeDrain, type Drain } from "./update-drain.ts";
import { migrateInstall } from "./tool-migrate.ts";
import type { RunResult, ServiceDeps, ServiceName, ServiceState } from "./service.ts";
import { toolVersionAt, versionNameOf } from "./tool-versions.ts";
import { buildVersion, currentVersionName, fetchMirror, mainVersionName, mirrorGit, pruneVersions, seedMirror, swapCurrent } from "./tool-install.ts";
import type { UpdateDeps } from "./update.ts";
import type { UpdateStatus } from "./update-safety.ts";

const ENV = sandboxGitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
export const gitIn = (cwd: string) => (args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export const NOW = Date.parse("2026-10-21T10:00:00.000Z");
export const HOUR = 3600e3;

/** A remote repository that cuts releases: each `release` commits `src/bin.ts`, a `package.json` that declares a dependency, and the changelog, and tags it. */
export function releaseRemote() {
  const root = tmpDir("update-");
  const work = join(root, "remote");
  mkdirSync(work);
  const git = gitIn(work);
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "gc.auto", "0"]);
  let changelog = "# agent-org\n";
  const commit = (message: string) => {
    git(["add", "-A"]);
    git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", message]);
  };
  /** Cut `version`: a summary starting `Breaking: ` marks it breaking. */
  const release = (version: string, summary = "a fix") => {
    mkdirSync(join(work, "src"), { recursive: true });
    writeFileSync(join(work, "src", "bin.ts"), `// agent-org ${version}\n`);
    writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "agent-org", version, dependencies: { "left-pad": "1.0.0" } })}\n`);
    changelog = changelog.replace("# agent-org\n", `# agent-org\n\n## ${version}\n\n### Minor Changes\n\n- 1a2b3c4: ${summary}\n`);
    writeFileSync(join(work, "CHANGELOG.md"), changelog);
    commit(`v${version}`);
    git(["tag", `v${version}`]);
  };
  const onMain = (label: string) => {
    writeFileSync(join(work, "src", "main.txt"), `${label}\n`);
    commit(label);
  };
  return { root, work, release, onMain };
}

/** The services as a machine has them: units on disk (a map), `systemctl` recorded, and a state for each service. */
export function stubServices(home: string, states: Partial<Record<ServiceName, ServiceState>> = {}) {
  const files = new Map<string, string>([[join(home, ".agent-org", "host.json"), "{}"], ["/opt/bin/herdr", ""]]);
  const calls: string[] = [];
  const services: ServiceDeps = {
    platform: "linux", env: { PATH: "/opt/bin:/usr/bin" }, home, uid: 1000, node: "/opt/node/bin/node", toolRoot: "/unset", commands: COMMANDS, user: "alice",
    exists: (path) => files.has(path), read: (path) => files.get(path) ?? null, write: (path, text) => { files.set(path, text); },
    run: (file, args): RunResult => { calls.push([file, ...args].join(" ")); return { status: 0, stdout: "", stderr: "" }; },
  };
  return { services, files, calls, states };
}

/** Everything `update` is given, real where it touches files and git, with the machine-wide parts stubbed. */
export function updateFixture(options: { states?: Partial<Record<ServiceName, ServiceState>>; live?: number | null; inUse?: readonly string[] | null } = {}) {
  const remote = releaseRemote();
  const home = join(remote.root, "home");
  const tool = join(home, ".agent-org", "tool");
  mkdirSync(join(home, ".agent-org"), { recursive: true });
  const stub = stubServices(home, options.states);
  const restarted: ServiceName[] = [];
  const said: string[] = [];
  const errors: string[] = [];
  const statuses: UpdateStatus[] = [];
  const installs: string[] = [];
  const git = mirrorGit(tool);
  const env = { AGENT_ORG_HOME: join(home, ".agent-org"), HOME: home } as NodeJS.ProcessEnv;
  const checkout = join(remote.root, "agent-org");
  const state = { failBuild: false, live: options.live ?? 0, inUse: options.inUse === undefined ? [] as readonly string[] | null : options.inUse, now: NOW, root: checkout };
  const drainFile = drainPath(env, home);
  const hostPath = join(home, ".agent-org", "host.json");
  const binDir = join(home, ".local", "bin");
  const deps = (over: Partial<UpdateDeps> = {}): UpdateDeps => ({
    root: state.root, git,
    fetch: (channel) => {
      if (!existsSync(join(tool, "repo.git", "HEAD"))) seedMirror(tool, remote.work);
      fetchMirror(git, channel);
    },
    build: (name, ref) => {
      if (state.failBuild) return { state: "failed", folder: join(tool, "versions", name), reason: "pnpm could not reach the registry" };
      return buildVersion({ tool, name, ref, exec: (_file, _args, run) => { installs.push(name); mkdirSync(join((run as { cwd: string }).cwd, "node_modules"), { recursive: true }); } });
    },
    swap: (name) => swapCurrent(tool, name),
    current: () => currentVersionName(tool),
    pinned: () => undefined,
    state: (name) => stub.states[name] ?? "not-registered",
    restart: (name) => { restarted.push(name); },
    liveRuns: () => state.live,
    inUse: () => state.inUse,
    prune: (inUse) => pruneVersions({ tool, inUse, self: state.root }),
    migrate: () => migrateInstall({ oldRoot: checkout, tool, home, env, services: stub.services, hostPath, binDir }),
    drain: { read: (): Drain => readDrain(drainFile), write: (record) => writeDrain(drainFile, record), clear: () => clearDrain(drainFile) },
    maxDeferHours: 2,
    now: () => state.now,
    status: { write: (status) => { statuses.push(status); } },
    upkeep: () => [],
    conventions: () => ({ said: [], failed: [] }),
    herdr: () => ({ said: [], failed: [] }),
    out: { log: (line: string) => { said.push(line); }, error: (line: string) => { errors.push(line); } },
    ...over,
  });
  /** Pretend the code now runs from a version folder, as the instance restarted on `current` does. */
  const runFromVersion = (name: string) => { state.root = join(tool, "versions", name); };
  return { ...remote, ...stub, home, tool, checkout, deps, restarted, said, errors, statuses, installs, state, drainFile, hostPath, binDir, env, runFromVersion, mainName: () => mainVersionName(git), versionOf: toolVersionAt, versionNameOf };
}
