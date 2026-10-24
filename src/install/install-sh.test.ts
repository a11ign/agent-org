// no-token: none -- install.sh runs against a bare repository this file builds, in a temporary HOME; nothing reaches the network, `gh` or the real home
/**
 * `install.sh` IN A TEMPORARY HOME, FROM A LOCAL BARE REPOSITORY WITH FAKE RELEASE TAGS.
 *
 * The tags are v0.2.0, v0.9.0, v0.10.0 and v0.11.0-rc1, so the newest release is v0.10.0 only when the order is numeric (a text sort says v0.9.0)
 * and a pre-release is not a release. Each tag's `src/bin.ts` prints its own tag, so the launcher's output says which release it runs.
 *
 * THE PATH IS BUILT, NOT INHERITED (A11-185). Whether npm or corepack is found is the point of several cases, so the PATH holds node, the programs
 * install.sh itself runs, and whatever stubs a case adds: never `/usr/bin`, which can hold an npm of its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { publishUiAsset, startReleaseServer } from "./fixtures/release-server.ts";

const INSTALL_SH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "install.sh");
const TAGS = ["v0.2.0", "v0.9.0", "v0.10.0", "v0.11.0-rc1"];
const BASH = "/bin/bash";
const GIT_ENV = sandboxGitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
const PINNED_PNPM = "pnpm@10.34.5";
const INSTALL_FLAGS = "install --prod --no-frozen-lockfile --ignore-scripts --ignore-workspace --silent";
/** Every program install.sh runs, other than node, npm and corepack, which a case chooses. */
const TOOLS = ["git", "tar", "gzip", "curl", "grep", "sed", "sort", "tail", "head", "dirname", "mktemp", "mv", "rm", "mkdir", "cat", "chmod", "uname", "readlink"];

/** A CI runner sets NVM_DIR, which would make every Node fix `nvm install`: the fix a case expects is for the Node it builds, so these start empty. */
const NO_VERSION_MANAGER = { NVM_DIR: "", FNM_DIR: "", FNM_MULTISHELL_PATH: "" };

const programPath = (name: string) => execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();

const gitIn = (cwd: string) => (args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" });

/** Commit and tag `tag` in the working repository `work`, with `manifest` as its package.json and `bin` as its `src/bin.ts`. */
function commitRelease(work: string, tag: string, manifest: Record<string, unknown>, bin: string): void {
  const git = gitIn(work);
  writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "agent-org", type: "module", ...manifest })}\n`);
  writeFileSync(join(work, "src", "bin.ts"), bin);
  git(["add", "-A"]);
  git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", tag]);
  git(["tag", tag]);
}

/** A bare repository holding one commit per tag. */
function releaseRepo(root: string): string {
  const work = join(root, "work");
  const bare = join(root, "agent-org.git");
  mkdirSync(join(work, "src"), { recursive: true });
  gitIn(work)(["init", "--quiet", "--initial-branch=main"]);
  for (const tag of TAGS) commitRelease(work, tag, {}, `console.log("fixture ${tag}", process.env.AGENT_ORG_HOME, process.argv.slice(2).join(" "));\n`);
  gitIn(root)(["clone", "--quiet", "--bare", work, bare]);
  return bare;
}

/** A further release `tag`, whose package.json is `manifest` and whose `src/bin.ts` prints the tag, pushed to the bare repository. */
function pushRelease(root: string, repo: string, tag: string, manifest: Record<string, unknown>): void {
  const work = join(root, "work");
  commitRelease(work, tag, manifest, `console.log("fixture ${tag}");\n`);
  gitIn(work)(["push", "--quiet", repo, tag]);
}

/** A release, v0.12.0, whose package.json declares a dependency, pushed to the bare repository. */
const dependencyRelease = (root: string, repo: string): void => pushRelease(root, repo, "v0.12.0", { dependencies: { leftpad: "^1.0.0" } });

/** A folder holding only the programs install.sh runs, linked in, so a PATH made of it finds no npm and no corepack. */
function toolsDir(root: string): string {
  const dir = join(root, "tools");
  if (!existsSync(dir)) {
    mkdirSync(dir);
    for (const name of TOOLS) symlinkSync(programPath(name), join(dir, name));
  }
  return dir;
}

/** A folder holding `node`, a link to the node running this test. */
function nodeDir(root: string): string {
  const bin = join(root, "path-bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  return bin;
}

/** A folder holding one stub program that records its arguments in `<root>/<name>-args`, and makes `node_modules` when it is not told to fail. */
function stub(root: string, folder: string, name: "npm" | "corepack", fails = false): string {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\necho "$@" > "${join(root, `${name}-args`)}"\n${fails ? "exit 1\n" : "mkdir -p node_modules\nexit 0\n"}`, { mode: 0o755 });
  return dir;
}

/** A folder holding a `node` that says it is v22.11.0. */
function oldNodeDir(root: string): string {
  const dir = join(root, "old-node");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "node"), "#!/bin/sh\necho v22.11.0\n", { mode: 0o755 });
  return dir;
}

function install(home: string, path: string, repo: string, args: string[] = [], extra: Record<string, string> = {}) {
  return spawnSync(BASH, [INSTALL_SH, ...args], {
    encoding: "utf8",
    env: { ...GIT_ENV, ...NO_VERSION_MANAGER, HOME: home, PATH: path, AGENT_ORG_REPO: repo, AGENT_ORG_HOME: "", AGENT_ORG_HOST: "", ...extra },
  });
}

/**
 * `AGENT_ORG_HOME: ""` above is the variable unset as far as `${AGENT_ORG_HOME:-...}` reads it, so the default home is what is tested.
 * `path` holds node, the tools and an `npm` (so preflight finds a way to run pnpm); `bare` holds node and the tools only, with no way to run pnpm.
 */
function fixture() {
  const root = tmpDir("install-sh-");
  const home = join(root, "home");
  mkdirSync(home);
  const bare = `${nodeDir(root)}:${toolsDir(root)}`;
  return { root, home, repo: releaseRepo(root), bare, path: `${stub(root, "default-npm", "npm")}:${bare}` };
}

const launch = (home: string, path: string, args: string[] = []) =>
  execFileSync(join(home, ".local", "bin", "agent-org"), args, { encoding: "utf8", env: { HOME: home, PATH: path } }).trim();

/** The folder `current` names, by its name under `versions/`. */
const currentOf = (home: string, agentOrgHome = join(home, ".agent-org")) => readlinkSync(join(agentOrgHome, "tool", "current"));

const lastLine = (text: string) => text.trimEnd().split("\n").at(-1) ?? "";
const ESCAPE = "\u001b[";

/** What a terminal shows of `text`: no carriage returns, no colour codes. */
const shown = (text: string) => text.replaceAll("\r", "").replace(/\u001b\[[0-9;]*m/g, "");

/** install.sh with a terminal for stdout, through util-linux `script`; null where this machine's `script` is not that one. */
const SCRIPT_IS_UTIL_LINUX = /util-linux/.test(spawnSync("script", ["--version"], { encoding: "utf8" }).stdout ?? "");
function installOnTerminal(home: string, path: string, repo: string, extra: Record<string, string> = {}) {
  return spawnSync(programPath("script"), ["-qec", `${BASH} ${INSTALL_SH}`, "/dev/null"], {
    encoding: "utf8",
    env: { ...GIT_ENV, ...NO_VERSION_MANAGER, HOME: home, PATH: path, AGENT_ORG_REPO: repo, AGENT_ORG_HOME: "", AGENT_ORG_HOST: "", TERM: "xterm", ...extra },
  });
}

test("install.sh installs the newest release by numeric order into its own folder, points current at it, and the launcher runs through current", () => {
  const { home, repo, path } = fixture();
  const result = install(home, path, repo);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(launch(home, path, ["doctor"]), `fixture v0.10.0 ${join(home, ".agent-org")} doctor`);
  const tool = join(home, ".agent-org", "tool");
  assert.equal(currentOf(home), join("versions", "v0.10.0"));
  assert.equal(lstatSync(join(tool, "current")).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(join(tool, "versions")), ["v0.10.0"], "one folder, built whole: no .partial is left");
  assert.equal(existsSync(join(tool, "repo.git", "HEAD")), true, "the bare mirror update fetches into");
  assert.equal(statSync(join(home, ".local", "bin", "agent-org")).mode & 0o777, 0o755);
  assert.equal(statSync(join(home, ".agent-org")).mode & 0o777, 0o700);
  assert.match(readFileSync(join(home, ".local", "bin", "agent-org"), "utf8"), new RegExp(`exec node '${join(tool, "current", "src", "bin.ts").replace(/[.]/g, "\\.")}'`));
  assert.match(result.stdout, /is not on your PATH/);
  assert.match(result.stdout, new RegExp(`export PATH="${join(home, ".local", "bin")}:\\$PATH"`));
});

test("install.sh --version installs that release, and running it again builds the newest beside it and moves current", () => {
  const { home, repo, path } = fixture();
  assert.equal(install(home, path, repo, ["--version", "v0.2.0"]).status, 0);
  assert.equal(launch(home, path), `fixture v0.2.0 ${join(home, ".agent-org")}`);
  const again = install(home, path, repo, ["--verbose"]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /updated ~\/\.agent-org\/tool\/repo\.git/);
  assert.equal(launch(home, path), `fixture v0.10.0 ${join(home, ".agent-org")}`);
  assert.deepEqual(readdirSync(join(home, ".agent-org", "tool", "versions")).toSorted(), ["v0.10.0", "v0.2.0"], "the older folder stays: a run that started on it keeps calling it, and update prunes it");
  const third = install(home, path, repo, ["--verbose"]);
  assert.match(third.stdout, /v0\.10\.0 was built already/);
});

test("install.sh refuses a --version that is not a release, and one the repository lacks, and ends each with the FAILED line", () => {
  const { home, repo, path } = fixture();
  const rc = install(home, path, repo, ["--version", "v0.11.0-rc1"]);
  assert.equal(rc.status, 1);
  assert.match(rc.stdout, /not a release tag/);
  assert.equal(lastLine(rc.stdout).startsWith("agent-org install FAILED: "), true, rc.stdout);
  const absent = install(home, path, repo, ["--version", "v9.9.9"]);
  assert.equal(absent.status, 1);
  assert.match(absent.stdout, /there is no release v9\.9\.9/);
  assert.equal(lastLine(absent.stdout), "agent-org install FAILED: there is no release v9.9.9. Its download was kept in ~/.agent-org/tool, so the next run is faster. Nothing is installed yet.");
  assert.equal(existsSync(join(home, ".local", "bin", "agent-org")), false);
});

test("install.sh honours AGENT_ORG_HOME, and the launcher exports it and the host file beside it", () => {
  const { root, home, repo, path } = fixture();
  const custom = join(root, "custom-home");
  assert.equal(install(home, path, repo, [], { AGENT_ORG_HOME: custom }).status, 0);
  assert.ok(existsSync(join(custom, "tool", "versions", "v0.10.0", "src", "bin.ts")));
  assert.equal(launch(home, path), `fixture v0.10.0 ${custom}`);
  const launcher = readFileSync(join(home, ".local", "bin", "agent-org"), "utf8");
  assert.match(launcher, new RegExp(`AGENT_ORG_HOST="\\$AGENT_ORG_HOME/host.json"`));
});

test("install.sh says nothing about PATH when the launcher's directory is on it", () => {
  const { home, repo, path } = fixture();
  const result = install(home, `${join(home, ".local", "bin")}:${path}`, repo);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /not on your PATH/);
});

test("install.sh refuses without Node, and with a Node older than 24, ends with the FAILED line, and installs nothing", () => {
  const { root, home, repo } = fixture();
  const none = install(home, toolsDir(root), repo);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /no `node` on PATH/);
  assert.match(none.stdout, /https:\/\/nodejs\.org\/en\/download/);
  assert.equal(lastLine(none.stdout).startsWith("agent-org install FAILED: "), true, none.stdout);
  const tooOld = install(home, `${oldNodeDir(root)}:${toolsDir(root)}`, repo);
  assert.equal(tooOld.status, 1);
  assert.match(tooOld.stdout, /node is v22\.11\.0/);
  assert.equal(existsSync(join(home, ".agent-org")), false);
});

test("install.sh leaves an earlier install's checkout alone, and says agent-org update moves its services onto this install", () => {
  const { home, repo, path } = fixture();
  const checkout = join(home, ".agent-org", "agent-org");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  writeFileSync(join(checkout, "marker"), "an earlier checkout\n");
  const result = install(home, path, repo);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(checkout, "marker"), "utf8"), "an earlier checkout\n");
  assert.match(result.stdout, /An earlier install's checkout at ~\/\.agent-org\/agent-org is left as it is\. agent-org update moves its services onto this install\./);
});

test("install.sh installs a release's dependencies with the pinned pnpm through the corepack beside node, not the pnpm on PATH, and leaves current where it was when that install fails", () => {
  const { root, home, repo, path } = fixture();
  assert.equal(install(home, path, repo).status, 0);
  dependencyRelease(root, repo);
  const failing = join(stub(root, "failing-pnpm", "corepack", true), "corepack");
  const failed = install(home, path, repo, [], { AGENT_ORG_COREPACK: failing });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /installing the dependencies failed/);
  assert.match(failed.stdout, /^ {2}FAILED Install its dependencies$/m);
  assert.equal(lastLine(failed.stdout), "agent-org install FAILED: installing the dependencies failed, so current stays where it was. Fix what pnpm printed above, then run this again. Its download was kept in ~/.agent-org/tool, so the next run is faster. Your earlier install, v0.10.0, still works.");
  assert.match(launch(home, path), /^fixture v0\.10\.0 /);
  assert.deepEqual(readdirSync(join(home, ".agent-org", "tool", "versions")), ["v0.10.0"], "no half folder is left for the failed release");
  const passing = join(stub(root, "passing-pnpm", "corepack"), "corepack");
  const passed = install(home, path, repo, [], { AGENT_ORG_COREPACK: passing });
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.equal(readFileSync(join(root, "corepack-args"), "utf8").trim(), `${PINNED_PNPM} ${INSTALL_FLAGS}`);
  assert.match(passed.stdout, /^ {2}ok Installed its dependencies$/m, "the usual runner is not named: the line stays as short as the ticket's example");
  assert.equal(launch(home, path), "fixture v0.12.0");
  assert.equal(currentOf(home), join("versions", "v0.12.0"));
});

test("with no corepack beside node or on PATH, the dependencies install through `npm exec` at the pinned version, and the line says so", () => {
  const { root, home, repo, bare } = fixture();
  dependencyRelease(root, repo);
  const npm = stub(root, "npm-bin", "npm");
  const result = install(home, `${npm}:${bare}`, repo);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(root, "npm-args"), "utf8").trim(), `exec --yes ${PINNED_PNPM} -- ${INSTALL_FLAGS}`);
  assert.match(result.stdout, /^ {2}ok Installed its dependencies {2}\(pnpm 10\.34\.5 through npm exec\)$/m);
  assert.equal(launch(home, bare), "fixture v0.12.0");
});

test("a corepack on PATH, with none beside node, runs the pinned pnpm before npm exec does, and the line says so", () => {
  const { root, home, repo, bare } = fixture();
  dependencyRelease(root, repo);
  const npm = stub(root, "npm-bin", "npm");
  const corepack = stub(root, "corepack-bin", "corepack");
  const result = install(home, `${corepack}:${npm}:${bare}`, repo);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(root, "corepack-args"), "utf8").trim(), `${PINNED_PNPM} ${INSTALL_FLAGS}`);
  assert.equal(existsSync(join(root, "npm-args")), false, "npm exec was not needed");
  assert.match(result.stdout, /^ {2}ok Installed its dependencies {2}\(pnpm 10\.34\.5 through corepack on PATH\)$/m);
});

test("with neither corepack nor npm, install.sh fails in preflight with both commands, ends with the FAILED line, and writes nothing", () => {
  const { home, repo, bare } = fixture();
  const result = install(home, bare, repo);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^ {2}pnpm 10\.34\.5 cannot run: there is no corepack beside node or on PATH, and no npm to run `npm exec` with\. To fix it, run one of:$/m);
  for (const fix of ["brew install corepack", "npm install -g corepack"]) assert.ok(result.stdout.includes(`\n    ${fix}\n`), `${fix} on its own indented line`);
  assert.equal(lastLine(result.stdout), "agent-org install FAILED: pnpm 10.34.5 cannot run: there is no corepack beside node or on PATH, and no npm to run `npm exec` with. Nothing was changed.");
  assert.equal(existsSync(join(home, ".agent-org")), false, "no clone, no folder");
  assert.equal(existsSync(join(home, ".local")), false);
  assert.equal(result.stdout.includes(ESCAPE), false, "no colour when stdout is not a terminal");
});

test("an AGENT_ORG_COREPACK that is not an executable file is refused by name in preflight, not replaced by a download through npm", () => {
  const { home, repo, path } = fixture();
  const result = install(home, path, repo, [], { AGENT_ORG_COREPACK: "/nonexistent/corepack" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /AGENT_ORG_COREPACK names \/nonexistent\/corepack, which is not an executable file/);
  assert.equal(lastLine(result.stdout), "agent-org install FAILED: AGENT_ORG_COREPACK names /nonexistent/corepack, which is not an executable file. Nothing was changed.");
  assert.equal(existsSync(join(home, ".agent-org")), false);
});

test("a Node older than 24 fails in preflight, before any clone, and lists the Node problem and the missing runner together", () => {
  const { root, home, repo } = fixture();
  const result = install(home, `${oldNodeDir(root)}:${toolsDir(root)}`, repo);
  assert.equal(result.status, 1);
  for (const line of [/^ {2}Node\.js 24 or newer is needed, and node is v22\.11\.0\./m, /^ {2}pnpm 10\.34\.5 cannot run/m, /^ {2}FAILED Check what agent-org needs$/m]) assert.match(result.stdout, line);
  assert.equal(lastLine(result.stdout), "agent-org install FAILED: 2 things agent-org needs are missing (listed above). Nothing was changed.");
  assert.equal(existsSync(join(home, ".agent-org")), false, "preflight ran before the first mkdir, so no clone ran");
  assert.equal(existsSync(join(root, "agent-org.git")), true);
});

test("the Node fix is the command for how node was installed: Homebrew, nvm, fnm, or a plain download", () => {
  const { root, home, repo } = fixture();
  const path = `${oldNodeDir(root)}:${toolsDir(root)}`;
  const fixes = (onPath: string, extra: Record<string, string> = {}) => install(home, onPath, repo, [], extra).stdout;
  assert.match(fixes(path, { NVM_DIR: "/x/.nvm" }), /^ {4}nvm install 24 && nvm use 24$/m);
  assert.match(fixes(path, { FNM_DIR: "/x/fnm" }), /^ {4}fnm install 24 && fnm use 24$/m);
  assert.match(fixes(path), /Download Node\.js 24 or newer from https:\/\/nodejs\.org\/en\/download, or with a version manager, run:/);
  // Homebrew: node sits in `brew --prefix`/bin.
  const prefix = join(root, "homebrew");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(join(prefix, "bin", "node"), "#!/bin/sh\necho v22.11.0\n", { mode: 0o755 });
  writeFileSync(join(prefix, "bin", "brew"), `#!/bin/sh\n[ "$1" = "--prefix" ] && echo "${prefix}"\nexit 0\n`, { mode: 0o755 });
  const brewed = fixes(`${join(prefix, "bin")}:${toolsDir(root)}`);
  assert.match(brewed, /^ {4}brew upgrade node$/m);
  assert.match(brewed, /^ {4}brew install corepack$/m);
  assert.ok(brewed.indexOf("brew install corepack") < brewed.indexOf("npm install -g corepack"), "on Homebrew the brew command is first");
  const brewOnly = join(root, "brew-only");
  mkdirSync(brewOnly);
  symlinkSync(join(prefix, "bin", "brew"), join(brewOnly, "brew"));
  assert.match(fixes(`${oldNodeDir(root)}:${brewOnly}:${toolsDir(root)}`), /or run:\n {4}brew install node$/m, "a node that is not brew's, with brew on PATH, offers the download first and then brew");
});

test("a success ends with the OK line, and its whole report is the plain form: no colour, no marks, no repeated prefix", () => {
  const { root, home, repo, path } = fixture();
  dependencyRelease(root, repo);
  const corepack = join(stub(root, "pnpm-bin", "corepack"), "corepack");
  const result = install(home, `${join(home, ".local", "bin")}:${path}`, repo, [], { AGENT_ORG_COREPACK: corepack });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, [
    "Installing agent-org",
    "",
    "  ok Downloaded agent-org v0.12.0",
    "  ok Installed its dependencies",
    "  ok Added the agent-org command  (~/.local/bin/agent-org)",
    "",
    "agent-org install OK: v0.12.0 installed, command at ~/.local/bin/agent-org",
    "",
    "Next:",
    "  agent-org onboard     set up this machine",
    "  agent-org doctor      check everything works",
    "",
  ].join("\n"));
  assert.equal(result.stdout.includes(ESCAPE) || result.stdout.includes("✓"), false);
});

test("on a terminal the report is the ticket's example, in colour, and NO_COLOR keeps the marks and drops the colour", { skip: !SCRIPT_IS_UTIL_LINUX && "util-linux `script` gives a pseudo-terminal; this machine's `script` is not that one" }, () => {
  const { root, home, repo, path } = fixture();
  dependencyRelease(root, repo);
  const corepack = join(stub(root, "pnpm-bin", "corepack"), "corepack");
  const withBin = `${join(home, ".local", "bin")}:${path}`;
  const expected = [
    "Installing agent-org",
    "",
    "  ✓ Downloaded agent-org v0.12.0",
    "  ✓ Installed its dependencies",
    "  ✓ Added the agent-org command  (~/.local/bin/agent-org)",
    "",
    "agent-org v0.12.0 is installed.",
    "",
    "Next:",
    "  agent-org onboard     set up this machine",
    "  agent-org doctor      check everything works",
    "",
  ].join("\n");
  const coloured = installOnTerminal(home, withBin, repo, { AGENT_ORG_COREPACK: corepack });
  assert.equal(coloured.status, 0, coloured.stdout);
  assert.equal(shown(coloured.stdout), expected);
  assert.equal(coloured.stdout.includes(`${ESCAPE}32m`), true, "green marks and outcome");
  rmSync(join(home, ".agent-org"), { recursive: true, force: true });
  const plainColour = installOnTerminal(home, withBin, repo, { AGENT_ORG_COREPACK: corepack, NO_COLOR: "1" });
  assert.equal(plainColour.status, 0, plainColour.stdout);
  assert.equal(plainColour.stdout.includes(ESCAPE), false, "NO_COLOR removes every colour code");
  assert.equal(plainColour.stdout.replaceAll("\r", ""), expected);
});

test("on a terminal a failure marks the failed step, says agent-org was not installed, then the reasons and the fix commands, indented", { skip: !SCRIPT_IS_UTIL_LINUX && "util-linux `script` gives a pseudo-terminal; this machine's `script` is not that one" }, () => {
  const { root, home, repo } = fixture();
  const result = installOnTerminal(home, `${oldNodeDir(root)}:${toolsDir(root)}`, repo);
  assert.equal(result.status, 1);
  const text = shown(result.stdout);
  assert.equal(text.startsWith("Installing agent-org\n\n  ✗ Check what agent-org needs\n\nagent-org was not installed.\n\n  Node.js 24 or newer is needed, and node is v22.11.0."), true, text);
  assert.match(text, /\n {2}pnpm 10\.34\.5 cannot run: .* To fix it, run one of:\n {4}npm install -g corepack\n {4}brew install corepack\n\n {2}Nothing was changed\.\n$/);
  assert.equal(text.includes("agent-org install FAILED"), false, "the plain form's last line is not on a terminal");
  assert.equal(result.stdout.includes(`${ESCAPE}31m`), true, "red mark and outcome");
});

test("a step that fails under set -e still ends with the FAILED line, and the failed step is marked", () => {
  const { root, home, path } = fixture();
  const result = install(home, path, join(root, "no-such-repository.git"));
  assert.equal(result.status, 128);
  assert.match(result.stdout, /^ {2}FAILED Download agent-org$/m);
  assert.equal(lastLine(result.stdout), "agent-org install FAILED: a step failed; the message above says why. Nothing is installed yet.");
  assert.equal(result.stdout.includes(ESCAPE), false);
});

test("the mirror, the versions folder and the current link appear only with --verbose, and paths are shortened with ~", () => {
  const { home, repo, path } = fixture();
  const quiet = install(home, `${join(home, ".local", "bin")}:${path}`, repo);
  assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr);
  for (const internal of ["repo.git", "versions/", "/current"]) assert.equal(quiet.stdout.includes(internal), false, `${internal} is an internal`);
  assert.equal(quiet.stdout.includes(home), false, "every path under the home is written with ~");
  rmSync(join(home, ".agent-org"), { recursive: true, force: true });
  const loud = install(home, `${join(home, ".local", "bin")}:${path}`, repo, ["--verbose"]);
  assert.equal(loud.status, 0, loud.stdout + loud.stderr);
  const internals = [/cloned .* into ~\/\.agent-org\/tool\/repo\.git/, /built into ~\/\.agent-org\/tool\/versions\/v0\.10\.0/, /~\/\.agent-org\/tool\/current names versions\/v0\.10\.0/, /^ {2}ok Checked what agent-org needs$/m];
  for (const internal of internals) assert.match(loud.stdout, internal);
});

test("--help prints the usage and no report", () => {
  const { home, repo, path } = fixture();
  const result = install(home, path, repo, ["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: install\.sh \[--version vX\.Y\.Z\] \[--verbose\]/);
  assert.doesNotMatch(result.stdout, /Installing agent-org|install OK|FAILED/);
});

// A11-191: a release that ships a UI build has it downloaded from its GitHub Release, checked against its checksum, and unpacked into its version folder before current moves.
// GitHub is a static server on 127.0.0.1 (`fixtures/release-server.ts`); AGENT_ORG_RELEASES_URL points the script at it.

/** A release, v0.13.0, whose package.json declares a UI build, pushed to the bare repository. */
const uiRelease = (root: string, repo: string): void => pushRelease(root, repo, "v0.13.0", { agentOrg: { shipsUiBuild: true } });

/** A built UI whose page says `label`. */
function uiDist(root: string, label: string): string {
  const dist = join(root, `dist-${label}`);
  mkdirSync(join(dist, "_astro"), { recursive: true });
  writeFileSync(join(dist, "index.html"), `<title>${label}</title>\n`);
  writeFileSync(join(dist, "_astro", "app.js"), `console.log("${label}");\n`);
  return dist;
}

/** The fixture with the stub GitHub running, and curl on the PATH. */
async function withGithub() {
  const f = fixture();
  const server = await startReleaseServer(join(f.root, "github"));
  return { ...f, server, env: { AGENT_ORG_RELEASES_URL: server.url } };
}

/** `withGithub()` with v0.2.0 installed and current, and the UI-declaring release v0.13.0 cut after it. */
async function withEarlierInstall() {
  const github = await withGithub();
  assert.equal(install(github.home, github.path, github.repo, ["--version", "v0.2.0"], github.env).status, 0);
  uiRelease(github.root, github.repo);
  return github;
}

const versionsOf = (home: string) => readdirSync(join(home, ".agent-org", "tool", "versions")).toSorted();
const LAUNCHER_AT = "~/.local/bin/agent-org";

test("a release that ships a UI build has it downloaded, checked and unpacked into its folder before current moves, and the report has the step", async () => {
  const { root, home, repo, path, server, env } = await withEarlierInstall();
  publishUiAsset(server.root, "v0.13.0", uiDist(root, "thirteen"));
  const result = install(home, `${join(home, ".local", "bin")}:${path}`, repo, [], env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, [
    "Installing agent-org",
    "",
    "  ok Downloaded agent-org v0.13.0",
    "  ok Downloaded its UI build",
    `  ok Added the agent-org command  (${LAUNCHER_AT})`,
    "",
    `agent-org install OK: v0.13.0 installed, command at ${LAUNCHER_AT}`,
    "",
    "Next:",
    "  agent-org onboard     set up this machine",
    "  agent-org doctor      check everything works",
    "",
  ].join("\n"));
  const folder = join(home, ".agent-org", "tool", "versions", "v0.13.0");
  assert.equal(readFileSync(join(folder, "ui-build", "index.html"), "utf8"), "<title>thirteen</title>\n");
  assert.equal(readFileSync(join(folder, "ui-build", "_astro", "app.js"), "utf8"), "console.log(\"thirteen\");\n");
  assert.equal(currentOf(home), join("versions", "v0.13.0"));
  assert.deepEqual(versionsOf(home), ["v0.13.0", "v0.2.0"], "no .partial and no staging folder is left");
  assert.deepEqual(readdirSync(folder).toSorted(), ["package.json", "src", "ui-build"]);
  assert.deepEqual(server.requests(), ["/v0.13.0/agent-org-ui-v0.13.0.tar.gz.sha256", "/v0.13.0/agent-org-ui-v0.13.0.tar.gz"]);
});

test("--verbose adds the asset's address and the verified checksum under the UI step", async () => {
  const { root, home, repo, path, server, env } = await withGithub();
  uiRelease(root, repo);
  const { checksum } = publishUiAsset(server.root, "v0.13.0", uiDist(root, "thirteen"));
  const digest = readFileSync(checksum, "utf8").split(" ")[0];
  const result = install(home, path, repo, ["--version", "v0.13.0", "--verbose"], env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^ {2}ok Downloaded its UI build\\n {6}downloading ${server.url}/v0\\.13\\.0/agent-org-ui-v0\\.13\\.0\\.tar\\.gz\\.sha256\\n {6}downloading .*\\.tar\\.gz\\n {6}checksum ${digest} verified$`, "m"));
});

test("a release before the marker installs exactly as it did: no UI step, and not one request reaches GitHub", async () => {
  const { home, repo, path, server, env } = await withGithub();
  const result = install(home, path, repo, [], env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /UI build/);
  assert.deepEqual(server.requests(), []);
  assert.equal(existsSync(join(home, ".agent-org", "tool", "versions", "v0.10.0", "ui-build")), false);
});

test("a release whose UI build is not attached yet fails with the FAILED line, says to try again in a few minutes, and leaves current where it was", async () => {
  const { home, repo, path, env } = await withEarlierInstall();
  const result = install(home, path, repo, [], env);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^ {2}FAILED Download its UI build$/m);
  assert.equal(lastLine(result.stdout), "agent-org install FAILED: v0.13.0 has not attached its UI build yet (CI attaches it a few minutes after the release), so current stays where it was. Run this again in a few minutes. Its download was kept in ~/.agent-org/tool, so the next run is faster. Your earlier install, v0.2.0, still works.");
  assert.equal(currentOf(home), join("versions", "v0.2.0"));
  assert.match(launch(home, path), /^fixture v0\.2\.0 /);
  assert.deepEqual(versionsOf(home), ["v0.2.0"], "no folder for v0.13.0, finished or half");
});

test("a checksum that does not match fails the install, names it, and leaves current where it was", async () => {
  const { root, home, repo, path, server, env } = await withEarlierInstall();
  const { checksum } = publishUiAsset(server.root, "v0.13.0", uiDist(root, "thirteen"));
  writeFileSync(checksum, `${"0".repeat(64)}  agent-org-ui-v0.13.0.tar.gz\n`);
  const result = install(home, path, repo, [], env);
  assert.equal(result.status, 1);
  assert.equal(lastLine(result.stdout), "agent-org install FAILED: the UI build of v0.13.0 did not match its checksum, so current stays where it was. Run this again in a few minutes. Its download was kept in ~/.agent-org/tool, so the next run is faster. Your earlier install, v0.2.0, still works.");
  assert.equal(currentOf(home), join("versions", "v0.2.0"));
  assert.deepEqual(versionsOf(home), ["v0.2.0"]);
  publishUiAsset(server.root, "v0.13.0", uiDist(root, "thirteen"));
  const again = install(home, path, repo, [], env);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(currentOf(home), join("versions", "v0.13.0"), "once the checksum is right, the same install goes through");
});

test("a tarball changed after its checksum was made fails the install", async () => {
  const { root, home, repo, path, server, env } = await withGithub();
  uiRelease(root, repo);
  const { tarball } = publishUiAsset(server.root, "v0.13.0", uiDist(root, "thirteen"));
  writeFileSync(tarball, Buffer.concat([readFileSync(tarball), Buffer.from("tampered")]));
  const result = install(home, path, repo, ["--version", "v0.13.0"], env);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /the UI build of v0\.13\.0 did not match its checksum/);
  assert.equal(existsSync(join(home, ".agent-org", "tool", "current")), false, "nothing was ever current");
  assert.deepEqual(versionsOf(home), []);
});

test("a download that cannot reach the server fails the install naming curl's words, and a repository that is not on GitHub, with no override, names AGENT_ORG_RELEASES_URL", async () => {
  const { root, home, repo, path } = fixture();
  uiRelease(root, repo);
  const unreachable = install(home, path, repo, ["--version", "v0.13.0"], { AGENT_ORG_RELEASES_URL: "http://127.0.0.1:1/dl" });
  assert.equal(unreachable.status, 1);
  assert.match(unreachable.stdout, /^ {2}the UI build of v0\.13\.0 could not be downloaded from http:\/\/127\.0\.0\.1:1\/dl\/v0\.13\.0\/agent-org-ui-v0\.13\.0\.tar\.gz\.sha256 \(.*\), so current stays where it was\./m);
  const elsewhere = install(home, path, repo, ["--version", "v0.13.0"]);
  assert.equal(elsewhere.status, 1);
  assert.match(elsewhere.stdout, /the UI build of v0\.13\.0 cannot be fetched: .* is not a GitHub URL, so current stays where it was\. Set AGENT_ORG_RELEASES_URL to where its releases are downloaded from, then run this again/);
  assert.deepEqual(versionsOf(home), []);
});

test("a folder that was built already, and is not current, is given its build, and a failure there stops the move", async () => {
  const { root, home, repo, path, server, env } = await withEarlierInstall();
  const folder = join(home, ".agent-org", "tool", "versions", "v0.13.0");
  mkdirSync(join(folder, "src"), { recursive: true });
  writeFileSync(join(folder, "src", "bin.ts"), "console.log(\"fixture v0.13.0\");\n");
  writeFileSync(join(folder, "package.json"), JSON.stringify({ agentOrg: { shipsUiBuild: true } }));
  const refused = install(home, path, repo, ["--version", "v0.13.0"], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /v0\.13\.0 has not attached its UI build yet/);
  assert.equal(currentOf(home), join("versions", "v0.2.0"));
  assert.equal(existsSync(join(folder, "ui-build")), false);
  publishUiAsset(server.root, "v0.13.0", uiDist(root, "thirteen"));
  const completed = install(home, path, repo, ["--version", "v0.13.0"], env);
  assert.equal(completed.status, 0, completed.stdout + completed.stderr);
  assert.equal(readFileSync(join(folder, "ui-build", "index.html"), "utf8"), "<title>thirteen</title>\n");
  assert.equal(currentOf(home), join("versions", "v0.13.0"));
});

test("running it again on the release that is current completes a missing build, and when it cannot says so under the steps and still succeeds", async () => {
  const { root, home, repo, path, server, env } = await withGithub();
  uiRelease(root, repo);
  publishUiAsset(server.root, "v0.13.0", uiDist(root, "thirteen"));
  assert.equal(install(home, path, repo, ["--version", "v0.13.0"], env).status, 0);
  const folder = join(home, ".agent-org", "tool", "versions", "v0.13.0");
  rmSync(join(folder, "ui-build"), { recursive: true });
  const completed = install(home, path, repo, ["--version", "v0.13.0"], env);
  assert.equal(completed.status, 0, completed.stdout + completed.stderr);
  assert.equal(existsSync(join(folder, "ui-build", "index.html")), true);
  const asked = server.requests().length;
  const quiet = install(home, path, repo, ["--version", "v0.13.0"], env);
  assert.doesNotMatch(quiet.stdout, /UI build/);
  assert.equal(server.requests().length, asked, "a folder that has its build asks for nothing");
  rmSync(join(folder, "ui-build"), { recursive: true });
  rmSync(join(server.root, "v0.13.0"), { recursive: true });
  const warned = install(home, path, repo, ["--version", "v0.13.0"], env);
  assert.equal(warned.status, 0, "stopping would change nothing: it is current already");
  assert.match(warned.stdout, /^agent-org v0\.13\.0 is current, but its UI build could not be fetched: v0\.13\.0 has not attached its UI build yet .*\. \/next shows the missing-build page until agent-org update fetches it\.$/m);
  assert.equal(existsSync(join(folder, "ui-build")), false);
});

test("curl is checked in preflight with the other tools, before anything is written, with the command that fixes it", () => {
  const { root, home, repo } = fixture();
  const withoutCurl = join(root, "tools-without-curl");
  mkdirSync(withoutCurl);
  for (const name of TOOLS.filter((tool) => tool !== "curl")) symlinkSync(programPath(name), join(withoutCurl, name));
  symlinkSync(process.execPath, join(withoutCurl, "node"));
  const result = install(home, `${stub(root, "default-npm", "npm")}:${withoutCurl}`, repo);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^ {2}curl is not installed, and a release's UI build is downloaded with it\./m);
  assert.match(result.stdout, /^ {2}FAILED Check what agent-org needs$/m);
  assert.equal(existsSync(join(home, ".agent-org")), false, "preflight ran before the first mkdir");
});

test("on a terminal the UI step has the mark and the colour of the others", { skip: !SCRIPT_IS_UTIL_LINUX && "util-linux `script` gives a pseudo-terminal; this machine's `script` is not that one" }, async () => {
  const { root, home, repo, path, server, env } = await withGithub();
  uiRelease(root, repo);
  publishUiAsset(server.root, "v0.13.0", uiDist(root, "thirteen"));
  const result = installOnTerminal(home, `${join(home, ".local", "bin")}:${path}`, repo, env);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(shown(result.stdout), ["Installing agent-org", "", "  ✓ Downloaded agent-org v0.13.0", "  ✓ Downloaded its UI build", `  ✓ Added the agent-org command  (${LAUNCHER_AT})`, "", "agent-org v0.13.0 is installed.", "", "Next:",
    "  agent-org onboard     set up this machine", "  agent-org doctor      check everything works", ""].join("\n"));
  assert.equal(result.stdout.includes(`${ESCAPE}32m`), true);
});

test("a build that unpacks but cannot be moved into place fails the install and leaves current where it was, where the move is not a step set -e would catch", async () => {
  const { root, home, repo, path, server, env } = await withEarlierInstall();
  publishUiAsset(server.root, "v0.13.0", uiDist(root, "thirteen"));
  const failing = join(root, "failing-mv");
  mkdirSync(failing);
  writeFileSync(join(failing, "mv"), `#!/bin/sh\ncase "$2" in */ui-build) exit 1 ;; esac\nexec ${programPath("mv")} "$@"\n`, { mode: 0o755 });
  const result = install(home, `${failing}:${path}`, repo, [], env);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /the UI build of v0\.13\.0 could not be moved into .*\/ui-build, so current stays where it was/);
  assert.equal(currentOf(home), join("versions", "v0.2.0"));
  assert.deepEqual(versionsOf(home), ["v0.2.0"]);
});
