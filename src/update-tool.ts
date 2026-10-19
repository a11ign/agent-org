#!/usr/bin/env node
// @ts-check
// command: the one way to move the tool's own checkout: fetch the release tags, refuse a dirty tree, detach at the newest tag (or the pinned one)
// THE ANALOGUE OF `primary:update` FOR THE TOOL'S CHECKOUT -- #2793 (child 5b of #2623; ADR 0040, decision 3), changed by #3443 to follow RELEASES. Once
// `host.json` names a `tool`, the `work-tick` unit runs from a checkout of the tool's own repository and its first `ExecStartPre` is this command.
//
// THE HOST RUNS ONE AGENT-ORG VERSION, THE NEWEST RELEASE TAG (chairman, 2026-10-04, #3443). This used to detach at `origin/main`, so every merge was live within
// two minutes whether or not it was released, while a project that pins `github:a11ign/agent-org#semver:^0.7.0` ran the last RELEASE: two versions of one tool on
// one host, and the older one ran everything the chairman touches. Now `host.json`'s `toolVersion` is `"latest"` (the newest tag) or `"vX.Y.Z"` (that tag: the
// whole of a rollback), and a fix goes forward in the next tag. `release.yml` tags the merge that carries a changeset about nine minutes after it lands (measured
// from the tag history, #3443), so a shipped-code merge is live then; a merge with NO changeset is never tagged and never live, which is the point.
//
//   node src/update-tool.ts
//
// A RELEASE TAG IS NOT AN ANCESTOR OF `main`: the release workflow commits the version bump on top of the merge and pushes that commit as the tag alone, so it is
// reachable from no branch, and a plain `git fetch origin` does not bring it down. The fetch here NAMES TAGS (`--tags`), and the checkout is of the tag.
//
// A ROLLBACK TARGET MUST ITSELF FOLLOW TAGS: the checkout is a tag's tree, so the NEXT run is that tag's own `update-tool.ts`. Pin a release cut after #3443; a
// pin to an older one is held for exactly one run and then moved to `origin/main` by that release's own code (measured in a scratch clone, 2026-10-04).
//
// NO TAG, NO MOVE, AND NO FALLBACK TO `origin/main`. With no `vX.Y.Z` tag, or a pinned one that is absent, it refuses by name and leaves the checkout where it is.
// The unit's `-` prefix means the tick then runs the last good version, and the refusal is in the journal. A fallback would put a second version back on the host.
//
// IT UPDATES THE CHECKOUT THIS FILE LIVES IN, and no other. Not the working directory and not a path it is handed: a command that
// took a path could be pointed at a project's checkout, and "never touches a project's checkout" is the one promise it makes. The
// root is `git rev-parse --show-toplevel` of this file's own directory, and it refuses outside a primary checkout (a real `.git`
// directory) for the reason `update-primary.ts` does: detaching a linked worktree takes it off the branch it is for.
//
// A DIRTY TREE IS REFUSED, NOT STASHED AND NOT RESET. The tool's checkout is read-only except fast-forward, so a modified tracked file
// is somebody's edit made where none belongs, and moving under it would either lose it or fail half way. Untracked files are not
// "dirty": git itself refuses a checkout that would overwrite one, and a build product in the tree must not stop the tool updating.
//
// A PROCESS THAT KEEPS ITS OLD MODULES LOADED IS A SECOND VERSION AGAIN, so when the checkout MOVES this command restarts the long-running units
// (`LONG_RUNNING_TEMPLATES`: the chairman listener) with `systemctl --user try-restart`, which does nothing to a unit that is not running. It is done HERE, in the
// work-tick's `ExecStartPre`, because that is the one place that knows the checkout moved; a path unit would have been a unit class of its own.
//
// A MOVE THAT WOULD DELETE A PROGRAM AN INSTALLED UNIT RUNS IS HELD, NOT MADE (a11ign/a11ign#4392). On 2026-10-09 agent-org#435 renamed `work-tick.mjs` and `update-tool.mjs`;
// this command moved the checkout under the INSTALLED `a11ign-work-tick.service`, which still named them, and the tick crashed (exit 70). The tick is the only thing that
// wakes `orchestrator`, whose job is to run `host:install`, so the break kept the one session that could mend it asleep. The programs are read off the installed units
// and the installed `agent-org` launcher (a copy that `exec`s `src/bin.ts`: a rename of THAT breaks the command for every agent, not one unit); a tracked file at HEAD
// that the release tag does not have is "lost by the move". With any lost the checkout STAYS, `host-units.ts` reports `host-install-pending` for the holders (the
// gate's `hostDriftOrders` wakes `orchestrator` with their names), and once the install has rewritten them to name programs the tag HAS the same check passes and the
// checkout advances. A program already missing at HEAD is not "lost": the move cannot make it worse, and holding for it would hold for ever.
//
// NO BUILD, AND AN INSTALL ONLY WHEN THE RELEASE'S `dependencies` ARE NOT WHAT `node_modules` HOLDS (a11ign/agent-org#714). This mover used to install nothing, on the ground that the tool
// imported no third-party module (ADR 0040, decision 1) and its `.ts` files run as they are. agent-org#522 made `@a11ign/toolchain` a `dependency` at `^0.7.0` and imports it from the
// programs of the tick, the gate and the launcher, while the host's checkout held toolchain 0.1.2: advancing onto a `node_modules` that lacks it is the tick crash of 2026-10-09
// again, with the one session that mends it asleep. So the dependencies of the release's `package.json` are read BEFORE the move, and when `node_modules` does not hold them they are
// installed first, IN A FRESH TREE BESIDE THE CHECKOUT (a worktree at the release, as the remedy of `host-install-pending` is): the live `node_modules` is never half-written under a
// running tick, and there is no lockfile, so it is `pnpm install --prod --no-frozen-lockfile`, never a frozen install. Only when that install has succeeded is the finished `node_modules` renamed into
// the checkout, and only then does the checkout move. An install that fails HOLDS the move (nothing advances, the tick runs the last good version) and `host:check` reports it as
// `host-install-pending` with the command, through the same `dependencyDrift` the move asks. THIS FILE'S OWN IMPORTS MUST STAY `node:*` AND LOCAL: it has to run on the host that lacks the
// dependency, which is the only host it is needed on. It checks on EVERY run, the checkout already being at the release included: an older mover that advanced without installing leaves
// exactly that host, and an update that only looked when it moved would never mend it.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "./lib/cli-flags.ts";
import { pnpmCliInvocation } from "./lib/npm-cli-executable.ts";
import { LATEST, chooseReleaseTag, compareReleaseTags, isReleaseTag } from "./lib/release-tag.ts";
import { gitIn } from "./lib/tool-version.ts";
import { isPrimaryWorktree } from "./lib/primary-worktree.ts";

/** The directory this file is in, real-pathed: the tool is reached through a symlink on some hosts, and git resolves the real one. */
const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));

/**
 * The tracked files a checkout has modified, staged or not: what makes it dirty. A list, so a refusal can name them.
 * @param {(args: string[]) => string} run @returns {string[]}
 */
function dirtyPaths(run: (args: string[]) => string): string[] {
  return run(["status", "--porcelain", "--untracked-files=no"]).split("\n").filter((line) => line !== "");
}

/** @param {(args: string[]) => string} run @returns {string[]} */
const tagNames = (run: (args: string[]) => string): string[] => run(["tag", "--list"]).split("\n").filter((name) => name !== "");

/** @param {LostPrograms} lost @param {{ tag: string, tool: string }} where @returns {{ unit: string, problem: string, detail: string }} */
function hostInstallPendingFinding({ holder, programs }: LostPrograms, { tag, tool }: { tag: string; tool: string }): { unit: string; problem: string; detail: string } {
  const fresh = `${tool}-install-${tag}`;
  return { unit: holder, problem: "host-install-pending",
    detail: `it runs ${programs.join(", ")}, which release ${tag} deletes or renames, so \`update-tool\` HOLDS the tool's checkout (${tool}) where it is and the unit still works. `
      + "THE CHECKOUT MAY NOT BE ADVANCED FIRST: that is the tick crash of 2026-10-09. Install from a fresh tree at the release, then advance, as ONE command line: "
      + `\`git -C ${tool} worktree add --detach ${fresh} refs/tags/${tag} && (cd ${fresh} && node src/host-units.ts --install) && (cd ${tool} && node src/update-tool.ts)\`, `
      + `then \`git -C ${tool} worktree remove --force ${fresh}\`. Post whether a REMOVED line appeared. This finding clears when the installed units and launcher name programs the release has.` };
}

/**
 * THE INSTALL THE HELD CHECKOUT IS WAITING FOR, as `host:check` findings (`host-units.ts` adds them to `hostUnitDrift`, so the gate's `hostDriftOrders` wakes `orchestrator` with the
 * unit names from a tick that still runs). The SAME `programsLostByMove` and `dependencyDrift` the move asks, of the release it would pick, so the hold and the report cannot disagree. It
 * clears itself: once the install has rewritten the holders to name programs the release HAS, or `node_modules` holds the dependencies it declares, the next update advances.
 * A dependency finding is one `package.json` finding naming the command; `update-tool` runs that install itself on every tick, so it stands only after that install failed.
 *
 * THE REMEDY NAMES A FRESH TREE AT THE RELEASE because the installer must render from the NEW units and the checkout is the OLD tree; advancing first is the incident. The install and the
 * advance are ONE command line, the second only if the first succeeded, to keep the window in which the units name programs the old tree lacks to seconds with a session awake.
 *
 * `[]` ALSO WHEN IT COULD NOT LOOK (a checkout git cannot read), SAID on stderr: this finding is raised on evidence, and its absence is not a clean reading.
 * @param {{ tool: string, toolVersion: string, binDir: string, prefix: string, installedDir: string, read?: typeof readFileSync, readDir?: typeof readdirSync, run?: (args: string[]) => string }} where
 * @returns {{ unit: string, problem: string, detail: string }[]}
 */
export function installPendingFindings({ tool, toolVersion, binDir, prefix, installedDir, read, readDir, run = gitIn(tool) }: {
  tool: string; toolVersion: string; binDir: string; prefix: string; installedDir: string;
  read?: typeof readFileSync; readDir?: typeof readdirSync; run?: (args: string[]) => string;
}): { unit: string; problem: string; detail: string }[] {
  try {
    const tag = chooseReleaseTag(tagNames(run), toolVersion);
    if (tag === null) return [];
    const holders = readProgramHolders({ installedDir, prefix, launcher: join(binDir, "agent-org") }, { read, readDir });
    const drift = dependencyDrift({ root: tool, tag, run });
    return [...programsLostByMove({ tag, holders, root: tool, run }).map((lost) => hostInstallPendingFinding(lost, { tag, tool })),
      ...(drift.length > 0 ? [dependenciesPendingFinding(drift, { tag, tool })] : [])];
  } catch (err) {
    process.stderr.write(`CANNOT TELL whether a host install is pending (${String((err as any)?.message ?? err).split("\n")[0]}).\n`);
    return [];
  }
}

/**
 * WHY NO TAG WAS CHOSEN, naming the pin or the missing release, and saying that nothing moved and that `origin/main` was not used instead.
 * @param {string} root @param {string} toolVersion @param {string[]} tags
 */
function noTagRefusal(root: string, toolVersion: string, tags: string[]) {
  const why = toolVersion === LATEST
    ? `it holds no release tag (v<major>.<minor>.<patch>) after fetching them; the tags it has: ${tags.join(", ") || "none"}`
    : `\`toolVersion\` pins ${toolVersion} and no such release tag exists after fetching them; the release tags it has: ${tags.filter(isReleaseTag).join(", ") || "none"}`;
  return new Error(`${root} was NOT moved: ${why}. It stays where it is and does NOT fall back to origin/main: the host runs a release, or the last one it ran.`);
}

/** A file a command line can run: what the installed units and the launcher name. */
const PROGRAM_FILE = /\.(?:[cm]?[jt]s|sh)$/;

/** Where a relative path in a unit resolves when the unit names no `WorkingDirectory`: nowhere under a checkout. */
const NO_DIRECTORY = "/";

/** A unit file or the launcher, with the text the service manager or the shell will read. */
export type ProgramHolder = { holder: string; text: string };

/**
 * The tracked files, relative to `root`, that a unit's `Exec*=` lines or the launcher's `exec` line name. Read by SHAPE (a token ending in a source extension, resolved against
 * the unit's last `WorkingDirectory=`), because this file must not import `host-units.ts` (see `longRunningUnits`); `node_modules/...` and the like are named by the same
 * tokens and are dropped later by `programsLostByMove`, which asks git rather than the disk.
 * @param {string} text @param {string} root @returns {string[]}
 */
export function programsNamedBy(text: string, root: string): string[] {
  const directory = [...text.matchAll(/^WorkingDirectory=-?(.*)$/gm)].map((m) => m[1].trim()).at(-1) || NO_DIRECTORY;
  const commands = [...text.matchAll(/^(?:Exec[A-Za-z]*=|exec\s)(.*)$/gm)].map((m) => m[1]);
  const named = commands.flatMap((command) => command.split(/[\s=]+/))
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter((token) => PROGRAM_FILE.test(token))
    .map((token) => relative(root, resolve(directory, token)));
  return [...new Set(named.filter((path) => path !== "" && !path.startsWith("..") && !isAbsolute(path)))];
}

/**
 * Every installed service of the project's prefix and the installed launcher, as text. A launcher that is not there is skipped (a host without one has nothing to break);
 * any other read failure is thrown, so the caller says it could not look rather than reading "no holders" as "nothing at risk".
 * @param {{ installedDir: string, prefix: string, launcher: string }} where
 * @param {{ read?: typeof readFileSync, readDir?: typeof readdirSync }} [deps] @returns {ProgramHolder[]}
 */
export function readProgramHolders({ installedDir, prefix, launcher }: { installedDir: string; prefix: string; launcher: string },
  { read = readFileSync, readDir = readdirSync }: { read?: typeof readFileSync; readDir?: typeof readdirSync } = {}): ProgramHolder[] {
  const units = (readDir(installedDir) as string[]).map(String).filter((name) => name.startsWith(prefix) && name.endsWith(".service"))
    .map((name) => ({ holder: name, text: String(read(join(installedDir, name), "utf8")) }));
  try {
    return [...units, { holder: "the agent-org launcher", text: String(read(launcher, "utf8")) }];
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return units;
    throw new Error(`cannot read the installed launcher ${launcher}`, { cause: err });
  }
}

/** What a move to `tag` would take from one holder: the programs it runs that HEAD has and the tag does not. */
export type LostPrograms = { holder: string; programs: string[] };

/**
 * The programs the holders run that the tracked tree has at HEAD and `tag` lacks. Git's tree, not the disk: an untracked `node_modules/tsx/...` is named by the same unit
 * line and is not the release's to keep. Empty when the move takes nothing a holder runs, which includes a program that is already absent (nothing left to lose).
 * @param {{ tag: string, holders: ProgramHolder[], root: string, run: (args: string[]) => string }} move @returns {LostPrograms[]}
 */
export function programsLostByMove({ tag, holders, root, run }: { tag: string; holders: ProgramHolder[]; root: string; run: (args: string[]) => string }): LostPrograms[] {
  const filesAt = (ref: string) => new Set(run(["ls-tree", "-r", "--name-only", ref]).split("\n"));
  const [now, then] = [filesAt("HEAD"), filesAt(`refs/tags/${tag}`)];
  return holders
    .map(({ holder, text }) => ({ holder, programs: programsNamedBy(text, root).filter((path) => now.has(path) && !then.has(path)) }))
    .filter(({ programs }) => programs.length > 0);
}

/** `dependencies` of the `package.json` git holds at `ref`: `{}` when that tree has no `package.json` or names none. A git that cannot be read throws, and the caller says it could not look. */
export function dependenciesAt(run: (args: string[]) => string, ref: string): Record<string, string> {
  if (run(["ls-tree", "--name-only", ref, "--", "package.json"]).trim() === "") return {};
  return (JSON.parse(run(["show", `${ref}:package.json`])) as { dependencies?: Record<string, string> }).dependencies ?? {};
}

/**
 * Whether `version` satisfies `range`, for the shapes this tool's `dependencies` take (an exact version, `^x.y.z`, `~x.y.z` and `*`); `null` for any other (a union, a URL, a pre-release) or a
 * version that is no `x.y.z`, which is "could not tell" and never "no". There is no `semver` to import: this file runs before the install that would bring one.
 */
export function satisfies(version: string, range: string): boolean | null {
  const spec = range.trim();
  const named = /^([\^~]?)(\d+\.\d+\.\d+)$/.exec(spec);
  const isUnusableSpec = !isReleaseTag(`v${version}`) || (spec !== "*" && (named === null || !isReleaseTag(`v${named[2]}`)));
  if (isUnusableSpec) return null;
  if (named === null) return true;
  const [operator, wanted] = [named[1], named[2]];
  const order = compareReleaseTags(`v${version}`, `v${wanted}`);
  if (operator === "") return order === 0;
  if (order < 0) return false;
  const [have, want] = [version.split(".").map(Number), wanted.split(".").map(Number)];
  if (operator === "~") return have[0] === want[0] && have[1] === want[1];
  if (want[0] > 0) return have[0] === want[0];
  return want[1] > 0 ? have[0] === 0 && have[1] === want[1] : order === 0;
}

/** The version `node_modules` holds for `name`, or `null` when it holds none (or one with no `version`). Any other read failure throws. */
function installedVersion(root: string, name: string, read: typeof readFileSync): string | null {
  try {
    const { version } = JSON.parse(String(read(join(root, "node_modules", name, "package.json"), "utf8"))) as { version?: unknown };
    return typeof version === "string" ? version : null;
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return null;
    throw err;
  }
}

/** One dependency the release declares that `node_modules` does not hold: the range wanted and the version found there (`null` when none). */
export type DependencyDrift = { name: string; wanted: string; installed: string | null };

/**
 * THE DEPENDENCIES OF RELEASE `tag` THAT `node_modules` IN `root` DOES NOT HOLD. Asked by the move before it advances and by `host:check` (through `installPendingFindings`), so the hold and the
 * report cannot disagree. A range `satisfies` cannot read is judged by what it CAN tell: absent is drift, and a range that differs from the one the checkout's own HEAD declares is drift; an
 * unchanged one that has something installed is not, or an exotic range would reinstall on every tick.
 * @param {{ root: string, tag: string, run: (args: string[]) => string, read?: typeof readFileSync }} where @returns {DependencyDrift[]}
 */
export function dependencyDrift({ root, tag, run, read = readFileSync }: { root: string; tag: string; run: (args: string[]) => string; read?: typeof readFileSync }): DependencyDrift[] {
  const wanted = dependenciesAt(run, `refs/tags/${tag}`);
  if (Object.keys(wanted).length === 0) return [];
  const before = dependenciesAt(run, "HEAD");
  return Object.entries(wanted).flatMap(([name, range]) => {
    const installed = installedVersion(root, name, read);
    const held = installed !== null && (satisfies(installed, range) ?? range === before[name]);
    return held ? [] : [{ name, wanted: range, installed }];
  });
}

/** What `installDependencies` did: nothing was needed, the release's dependencies are now in `node_modules`, or the install failed and the move must be held. */
export type DependencyInstall =
  | { state: "current" }
  | { state: "installed"; names: string[] }
  | { state: "failed"; names: string[]; command: string; reason: string };

/**
 * The package manager is pnpm (this repository's `no-npm-spawn` guard: a spawn of `npm` from `src/` is refused), reached through `pnpmCliInvocation`. The release carries no lockfile, so
 * `--no-frozen-lockfile` (a frozen install is pnpm's default under CI and would refuse); `--prod` is the production `dependencies` only; `--ignore-workspace` keeps a
 * `pnpm-workspace.yaml` in a parent directory of the host's checkout from turning this into a workspace install. Nothing installed has a lifecycle script, and none runs unattended on the host.
 */
const PNPM_INSTALL = ["install", "--prod", "--no-frozen-lockfile", "--ignore-scripts", "--ignore-workspace"];

/** Inside the tick unit's `TimeoutStartSec=600`, which this runs in the `ExecStartPre` of. */
const INSTALL_TIMEOUT_MS = 240_000;

/** The fresh tree: BESIDE the checkout, so the finished `node_modules` is renamed into it on one filesystem and never copied. */
const freshTreeFor = (root: string, tag: string): string => join(dirname(root), `${basename(root)}-deps-${tag}`);

/** The command the install runs, as one line a person can run to read pnpm's own error. */
export const installCommand = (root: string, tag: string): string =>
  `git -C ${root} worktree add --detach ${freshTreeFor(root, tag)} refs/tags/${tag} && (cd ${freshTreeFor(root, tag)} && pnpm ${PNPM_INSTALL.join(" ")})`;

/**
 * INSTALL THE RELEASE'S DEPENDENCIES BEFORE THE CHECKOUT MOVES, in a fresh tree, and swap the finished `node_modules` in. The live `node_modules` is touched only by two renames after an install
 * that succeeded, so a failed or killed install leaves the host exactly as it was (the fresh tree is removed at the start of the next run). The superseded `node_modules` is removed, not kept:
 * the long-running units are restarted by the caller. A failed install is the returned `failed`, with pnpm's last lines as the reason; only a git that cannot be read throws, as it does
 * for every other step of the move.
 * @param {{ root: string, tag: string, run: (args: string[]) => string, exec?: (file: string, args: string[], options: object) => unknown, pnpm?: (args: string[]) => { command: string, args: string[] }, read?: typeof readFileSync }} where @returns {DependencyInstall}
 */
export function installDependencies({ root, tag, run, exec = execFileSync, pnpm = pnpmCliInvocation, read }: {
  root: string; tag: string; run: (args: string[]) => string; exec?: (file: string, args: string[], options: object) => unknown;
  pnpm?: (args: string[]) => { command: string; args: string[] }; read?: typeof readFileSync;
}): DependencyInstall {
  const drift = dependencyDrift({ root, tag, run, read });
  if (drift.length === 0) return { state: "current" };
  const [fresh, command, names] = [freshTreeFor(root, tag), installCommand(root, tag), drift.map(({ name }) => name)];
  /** A tree that will not go is left for the next run's `discard`, which is why this says nothing: it cannot change what the install did. */
  const discard = () => {
    try { run(["worktree", "remove", "--force", fresh]); } catch { /* not registered, or already gone */ }
    try { rmSync(fresh, { recursive: true, force: true }); run(["worktree", "prune"]); } catch { /* the next run starts with this too */ }
  };
  try {
    discard();
    run(["worktree", "add", "--detach", fresh, `refs/tags/${tag}`]);
    // pnpm's shim is `#!/usr/bin/env node`, and a systemd unit's PATH need not hold the node this process runs on: put its directory first.
    const env = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH ?? ""].filter((dir) => dir !== "").join(delimiter) };
    const invocation = pnpm(PNPM_INSTALL);
    exec(invocation.command, invocation.args, { cwd: fresh, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: INSTALL_TIMEOUT_MS });
    const [finished, live] = [join(fresh, "node_modules"), join(root, "node_modules")];
    if (!existsSync(finished)) throw new Error(`\`pnpm ${PNPM_INSTALL.join(" ")}\` finished and left no node_modules in ${fresh}`);
    const superseded = `${live}.superseded`;
    rmSync(superseded, { recursive: true, force: true });
    if (existsSync(live)) renameSync(live, superseded);
    try {
      renameSync(finished, live);
    } catch (err) {
      if (existsSync(superseded)) renameSync(superseded, live);
      throw err;
    }
    rmSync(superseded, { recursive: true, force: true });
    discard();
    return { state: "installed", names };
  } catch (err) {
    discard();
    const text = String((err as any)?.stderr || (err as any)?.message || err).trim();
    return { state: "failed", names, command, reason: text.split("\n").filter((line) => line.trim() !== "").slice(-3).join(" | ") || "no output" };
  }
}

/** @param {{ name: string, wanted: string, installed: string | null }[]} drift @returns {string} */
const describeDrift = (drift: DependencyDrift[]): string => drift.map(({ name, wanted, installed }) => `${name}@${wanted} (node_modules holds ${installed ?? "none"})`).join(", ");

/** @param {DependencyDrift[]} drift @param {{ tag: string, tool: string }} where @returns {{ unit: string, problem: string, detail: string }} */
function dependenciesPendingFinding(drift: DependencyDrift[], { tag, tool }: { tag: string; tool: string }): { unit: string; problem: string; detail: string } {
  return { unit: "package.json", problem: "host-install-pending",
    detail: `release ${tag} declares dependencies the tool's \`node_modules\` (${tool}) does not hold: ${describeDrift(drift)}, so \`update-tool\` HOLDS the checkout where it is and the tick runs the last good version. `
      + "THE CHECKOUT MAY NOT BE ADVANCED FIRST: that is the tick crash of 2026-10-09. \`update-tool\` installs into a fresh tree and advances on every run, so this stands because that install failed. "
      + `Run \`${installCommand(tool, tag)}\` to read pnpm's own error, fix its cause (network, registry, disk), then \`git -C ${tool} worktree remove --force ${freshTreeFor(tool, tag)}\` and \`cd ${tool} && node src/update-tool.ts\`, `
      + "which repeats the install, renames the finished node_modules in and advances. This finding clears when node_modules holds what the release declares." };
}

/** @param {string} tag @param {string} sha @param {{ names: string[], command: string, reason: string }} install @returns {string} */
function heldOnInstall(tag: string, sha: string, { names, command, reason }: { names: string[]; command: string; reason: string }): string {
  return `agent-org HELD at ${sha}, NOT moved to ${tag} (host-install-pending): its dependencies (${names.join(", ")}) are not in node_modules and the install FAILED: ${reason}. `
    + `The command was \`${command}\`. \`host:check\` reports host-install-pending with it; the checkout advances on the next update once the install succeeds.`;
}

/** @param {string} tag @param {string} sha @param {LostPrograms[]} lost @returns {string} */
function heldRefusal(tag: string, sha: string, lost: LostPrograms[]): string {
  const holders = lost.map(({ holder, programs }) => `${holder} runs ${programs.join(", ")}`).join("; ");
  return `agent-org HELD at ${sha}, NOT moved to ${tag} (host-install-pending): the move deletes or renames programs the installed units run -- ${holders}. `
    + "`host:check` reports host-install-pending and the gate wakes the installer; the checkout advances on the next update once the install has run.";
}

/**
 * Move the tool's checkout to the release `toolVersion` names, and say which: `agent-org vX.Y.Z (<sha>)`.
 * @param {string} [root] the tool's checkout; the one holding this file when left to default
 * @param {(args: string[]) => string} [run] git, run in `root`
 * @param {string} [toolVersion] `"latest"`, or the release tag to hold the host at (`host.json`)
 * @param {(tag: string) => LostPrograms[]} [lostByMove] what moving to `tag` would take from the installed units; none by default, so a caller that cannot read them moves as before
 * @param {(tag: string) => DependencyInstall} [installDeps] puts the dependencies `tag` declares into `node_modules` BEFORE the checkout moves; nothing by default, so a caller that cannot install moves as before
 * @returns {string}
 */
export function updateTool(root: string = gitIn(HERE)(["rev-parse", "--show-toplevel"]).trim(), run: (args: string[]) => string = gitIn(root), toolVersion: string = LATEST,
  lostByMove: (tag: string) => LostPrograms[] = () => [], installDeps: (tag: string) => DependencyInstall = () => ({ state: "current" })): string {
  if (!isPrimaryWorktree(root)) {
    throw new Error(`${root} is not a primary checkout (its .git is a linked worktree's, not a real directory) -- the tool's `
      + "checkout is a plain clone, and detaching a linked worktree would take it off the branch it is for.");
  }
  const dirty = dirtyPaths(run);
  if (dirty.length > 0) {
    throw new Error(`${root} has uncommitted changes to tracked files, so it was NOT moved:\n${dirty.join("\n")}\nThe tool's `
      + "checkout is read-only except fast-forward; commit the change where the tool is developed and discard it here.");
  }
  // `--tags` NAMES THEM: a release commit is reachable from no branch, so a plain fetch never brings its tag down. `--force`, since a tag
  // the remote moved is the remote's word and this clone has no tag of its own to protect.
  run(["fetch", "--force", "--tags", "--quiet", "origin"]);
  const tags = tagNames(run);
  const tag = chooseReleaseTag(tags, toolVersion);
  if (tag === null) throw noTagRefusal(root, toolVersion, tags);
  const lost = lostByMove(tag);
  if (lost.length > 0) return heldRefusal(tag, run(["rev-parse", "HEAD"]).trim(), lost);
  // BEFORE THE CHECKOUT MOVES, and when it is already at the release too: what the new tree imports must be there before the new tree is.
  const install = installDeps(tag);
  if (install.state === "failed") return heldOnInstall(tag, run(["rev-parse", "HEAD"]).trim(), install);
  run(["checkout", "--detach", `refs/tags/${tag}`, "--quiet"]);
  return `agent-org ${tag} (${run(["rev-parse", "HEAD"]).trim()})`;
}

/**
 * The long-running units' rendered names, read BEFORE the checkout moves: after it, `import()` would load the NEW tree's modules into this old process, and a
 * module that changed its exports would fail the restart this exists for. A host that cannot name them (no `units` declaration) is TOLD so and restarts none; the
 * move itself stands.
 * @returns {Promise<string[]>}
 */
async function longRunningUnits(): Promise<string[]> {
  try {
    const { LONG_RUNNING_TEMPLATES, renderedName, readUnitsDeclaration } = await import("./host-config.ts");
    const { prefix } = readUnitsDeclaration();
    return LONG_RUNNING_TEMPLATES.map((template) => renderedName(template, prefix));
  } catch (err) {
    console.error(`CANNOT NAME THE LONG-RUNNING UNITS (${String((err as any)?.message ?? err).split("\n")[0]}): none will be restarted if the checkout moves.`);
    return [];
  }
}

/**
 * The installed units and launcher, read BEFORE the checkout moves (for `longRunningUnits`' reason). A host that cannot name them is TOLD so and moves as it always did:
 * holding on a read that failed would hold for ever.
 * @returns {Promise<ProgramHolder[]>}
 */
async function installedProgramHolders(): Promise<ProgramHolder[]> {
  try {
    const { homeHostConfig, readUnitsDeclaration } = await import("./host-config.ts");
    return readProgramHolders({ installedDir: `${process.env.HOME ?? ""}/.config/systemd/user`, prefix: readUnitsDeclaration().prefix, launcher: join(homeHostConfig().binDir, "agent-org") });
  } catch (err) {
    console.error(`CANNOT NAME THE INSTALLED PROGRAMS (${String((err as any)?.message ?? err).split("\n")[0]}): the checkout moves without checking them.`);
    return [];
  }
}

/** `systemctl`'s exit status for a unit it has no file for. */
const NOT_INSTALLED = 5;

/**
 * `try-restart` EACH LONG-RUNNING UNIT, because a process holding the old modules is a second version. It does nothing to a unit that is not running (a host
 * with no `messaging` key has no listener). A restart that fails is SAID on stderr and does not undo the move: the checkout is the version, and the listener
 * keeps running the old one until somebody reads this line.
 * @param {string[]} units
 * @param {{ exec?: (file: string, args: string[], options: object) => unknown, out?: Pick<Console, "log" | "error"> }} [deps] `systemctl` and where the lines go
 */
export function restartLongRunning(units: string[], { exec = execFileSync, out = console }: { exec?: (file: string, args: string[], options: object) => unknown; out?: Pick<Console, "log" | "error">; } = {}) {
  for (const unit of units) {
    try {
      exec("systemctl", ["--user", "try-restart", unit], { encoding: "utf8", stdio: ["ignore", "inherit", "pipe"] });
      out.log(`restarted ${unit} (try-restart) so it runs the version above`);
    } catch (err) {
      // systemctl's exit 5 is "unit not found": a host with no `messaging` key has no listener, and there is nothing running the old version to restart.
      if ((err as any)?.status === NOT_INSTALLED) { out.log(`${unit} is not installed; nothing to restart`); continue; }
      out.error(`COULD NOT RESTART ${unit}: ${String((err as any)?.message ?? err)}. It still runs the PREVIOUS agent-org version.`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  // Guarded per #164: takes no flags -- a root argument is exactly what this command must not accept.
  refuseUnknownFlags([], { entry: import.meta.url, command: "node src/update-tool.ts" });
  const root = gitIn(HERE)(["rev-parse", "--show-toplevel"]).trim();
  const run = gitIn(root);
  const before = run(["rev-parse", "HEAD"]).trim();
  const { homeHostConfig } = await import("./host-config.ts");
  const restartable = await longRunningUnits();
  const holders = await installedProgramHolders();
  let installed = false;
  const installDeps = (tag: string): DependencyInstall => {
    const result = installDependencies({ root, tag, run });
    if (result.state === "installed") {
      installed = true;
      console.log(`installed ${result.names.join(", ")} for ${tag} into ${root}/node_modules before moving the checkout`);
    }
    return result;
  };
  console.log(updateTool(root, run, homeHostConfig().toolVersion, (tag) => programsLostByMove({ tag, holders, root, run }), installDeps));
  // A swapped `node_modules` is a new version for a process that holds the old one, though the checkout did not move.
  if (installed || run(["rev-parse", "HEAD"]).trim() !== before) restartLongRunning(restartable);
}
