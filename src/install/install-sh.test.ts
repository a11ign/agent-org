// no-token: none -- install.sh runs against a bare repository this file builds, in a temporary HOME; nothing reaches the network, `gh` or the real home
/**
 * `install.sh` IN A TEMPORARY HOME, FROM A LOCAL BARE REPOSITORY WITH FAKE RELEASE TAGS.
 *
 * The tags are v0.2.0, v0.9.0, v0.10.0 and v0.11.0-rc1, so the newest release is v0.10.0 only when the order is numeric (a text sort says v0.9.0)
 * and a pre-release is not a release. Each tag's `src/bin.ts` prints its own tag, so the launcher's output says which release it runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";

const INSTALL_SH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "install.sh");
const TAGS = ["v0.2.0", "v0.9.0", "v0.10.0", "v0.11.0-rc1"];
const BASH = "/bin/bash";

/** A bare repository holding one commit per tag. */
function releaseRepo(root: string): string {
  const work = join(root, "work");
  const bare = join(root, "agent-org.git");
  const git = (args: string[], cwd = work) => execFileSync("git", args, { cwd, env: sandboxGitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }), stdio: "pipe" });
  mkdirSync(join(work, "src"), { recursive: true });
  git(["init", "--quiet", "--initial-branch=main"]);
  for (const tag of TAGS) {
    writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "agent-org", type: "module" })}\n`);
    writeFileSync(join(work, "src", "bin.ts"), `console.log("fixture ${tag}", process.env.AGENT_ORG_HOME, process.argv.slice(2).join(" "));\n`);
    git(["add", "-A"]);
    git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", tag]);
    git(["tag", tag]);
  }
  git(["clone", "--quiet", "--bare", work, bare], root);
  return bare;
}

/** A PATH holding `node` and `git`, plus the system's own directories, and nothing from the person's shell. */
function pathWith(root: string, node: string): string {
  const bin = join(root, "path-bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(node, join(bin, "node"));
  return `${bin}:/usr/bin:/bin`;
}

function install(home: string, path: string, repo: string, args: string[] = [], extra: Record<string, string> = {}) {
  return spawnSync(BASH, [INSTALL_SH, ...args], {
    encoding: "utf8",
    env: { ...sandboxGitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }), HOME: home, PATH: path, AGENT_ORG_REPO: repo, AGENT_ORG_HOME: "", AGENT_ORG_HOST: "", ...extra },
  });
}

/** `AGENT_ORG_HOME: ""` above is the variable unset as far as `${AGENT_ORG_HOME:-...}` reads it, so the default home is what is tested. */
function fixture() {
  const root = tmpDir("install-sh-");
  const home = join(root, "home");
  mkdirSync(home);
  return { root, home, repo: releaseRepo(root), path: pathWith(root, process.execPath) };
}

const launch = (home: string, path: string, args: string[] = []) =>
  execFileSync(join(home, ".local", "bin", "agent-org"), args, { encoding: "utf8", env: { HOME: home, PATH: path } }).trim();

/** The folder `current` names, by its name under `versions/`. */
const currentOf = (home: string, agentOrgHome = join(home, ".agent-org")) => readlinkSync(join(agentOrgHome, "tool", "current"));

test("install.sh installs the newest release by numeric order into its own folder, points current at it, and the launcher runs through current", () => {
  const { home, repo, path } = fixture();
  const result = install(home, path, repo);
  assert.equal(result.status, 0, result.stderr);
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
  const again = install(home, path, repo);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /updating /);
  assert.equal(launch(home, path), `fixture v0.10.0 ${join(home, ".agent-org")}`);
  assert.deepEqual(readdirSync(join(home, ".agent-org", "tool", "versions")).toSorted(), ["v0.10.0", "v0.2.0"], "the older folder stays: a run that started on it keeps calling it, and update prunes it");
  const third = install(home, path, repo);
  assert.match(third.stdout, /v0\.10\.0 is built already/);
});

test("install.sh refuses a --version that is not a release, and one the repository lacks", () => {
  const { home, repo, path } = fixture();
  const rc = install(home, path, repo, ["--version", "v0.11.0-rc1"]);
  assert.equal(rc.status, 1);
  assert.match(rc.stderr, /not a release tag/);
  const absent = install(home, path, repo, ["--version", "v9.9.9"]);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /there is no release v9\.9\.9/);
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
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /not on your PATH/);
});

test("install.sh refuses without Node, and with a Node older than 24, and installs nothing", () => {
  const { root, home, repo } = fixture();
  // A PATH holding git and nothing else, since a system directory can hold a node of its own.
  const gitOnly = join(root, "git-only");
  mkdirSync(gitOnly);
  symlinkSync(execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(gitOnly, "git"));
  symlinkSync(execFileSync("/bin/sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim(), join(gitOnly, "tar"));
  const none = install(home, gitOnly, repo);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no `node` on PATH/);
  assert.match(none.stderr, /https:\/\/nodejs\.org/);
  const old = join(root, "old-node");
  mkdirSync(old);
  writeFileSync(join(old, "node"), "#!/bin/sh\necho v22.11.0\n", { mode: 0o755 });
  const tooOld = install(home, `${old}:/usr/bin:/bin`, repo);
  assert.equal(tooOld.status, 1);
  assert.match(tooOld.stderr, /`node` is v22\.11\.0/);
  assert.equal(existsSync(join(home, ".agent-org")), false);
});

test("install.sh leaves an earlier install's checkout alone, and says its services move onto current with `agent-org update`", () => {
  const { home, repo, path } = fixture();
  const checkout = join(home, ".agent-org", "agent-org");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  writeFileSync(join(checkout, "marker"), "an earlier checkout\n");
  const result = install(home, path, repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(checkout, "marker"), "utf8"), "an earlier checkout\n");
  assert.match(result.stdout, /an earlier install's checkout at .* is left as it is\. Its services move onto .* when you run: agent-org update/);
});

test("install.sh installs a release's dependencies with the pinned pnpm through corepack, not the pnpm on PATH, and leaves current where it was when that install fails", () => {
  const { root, home, repo, path } = fixture();
  assert.equal(install(home, path, repo).status, 0);
  const work = join(root, "work");
  const git = (args: string[]) => execFileSync("git", args, { cwd: work, env: sandboxGitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }), stdio: "pipe" });
  writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "agent-org", type: "module", dependencies: { leftpad: "^1.0.0" } })}\n`);
  writeFileSync(join(work, "src", "bin.ts"), "console.log(\"fixture v0.12.0\");\n");
  git(["add", "-A"]);
  git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "v0.12.0"]);
  git(["tag", "v0.12.0"]);
  git(["push", "--quiet", repo, "v0.12.0"]);
  const pnpm = join(root, "pnpm-bin");
  mkdirSync(pnpm);
  writeFileSync(join(pnpm, "corepack"), `#!/bin/sh\necho "$@" > "${join(root, "pnpm-args")}"\n[ -f "${join(root, "pnpm-fails")}" ] && exit 1\nmkdir -p node_modules\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(root, "pnpm-fails"), "");
  const corepack = { AGENT_ORG_COREPACK: join(pnpm, "corepack") };
  const failed = install(home, path, repo, [], corepack);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /installing the dependencies failed/);
  assert.match(launch(home, path), /^fixture v0\.10\.0 /);
  assert.deepEqual(readdirSync(join(home, ".agent-org", "tool", "versions")), ["v0.10.0"], "no half folder is left for the failed release");
  rmSync(join(root, "pnpm-fails"));
  const passed = install(home, path, repo, [], corepack);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(readFileSync(join(root, "pnpm-args"), "utf8").trim(), "pnpm@10.34.5 install --prod --no-frozen-lockfile --ignore-scripts --ignore-workspace --silent");
  assert.equal(launch(home, path), "fixture v0.12.0");
  assert.equal(currentOf(home), join("versions", "v0.12.0"));
});
