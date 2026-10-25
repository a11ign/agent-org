// no-token: none -- install.sh runs against a bare repository this file builds, in a temporary HOME; nothing reaches the network, `gh`, the real home or a real terminal
/**
 * AN INSTALL ENDS BY CHECKING THE `agent-org` THE PERSON'S SHELL RUNS (A11-285).
 *
 * The case that happened on 2026-10-25: `agent-org` was an alias in `~/.zshrc` to an old checkout. Here `install.sh` runs for real against a fixture release, with a stand-in `zsh` that answers
 * `type agent-org` from the files in the home the way zsh would, and ends with the shim in place and the alias line replaced and backed up. The fixture release's `src/bin.ts` hands every command to
 * this checkout's own bin, so the check that runs is the one under test. The run has no controlling terminal (`detached`), so nobody is asked: the unattended path, which replaces and says so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { launcherText } from "./launcher.ts";

const INSTALL_SH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "install.sh");
const REAL_BIN = join(dirname(INSTALL_SH), "src", "bin.ts");
const GIT_ENV = sandboxGitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
const PROGRAMS = ["git", "tar", "gzip", "curl", "grep", "sed", "sort", "tail", "head", "dirname", "mktemp", "mv", "rm", "mkdir", "cat", "chmod", "uname", "readlink", "date", "basename"];
/** spawnSync takes `detached` at run time though its types omit it: the child becomes a session leader, so it has no controlling terminal and `/dev/tty` cannot be opened. */
const NO_CONTROLLING_TERMINAL: object = { detached: true };
const ORIGINAL_ALIAS = "alias agent-org='node ~/old/agent-org/src/bin.ts'";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=f", "-c", "user.email=f@example.invalid", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
const programPath = (name: string): string => execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();

/** A stand-in `zsh`: `type agent-org` answered from the start-up file and the shim's folder, as zsh would, with the file's own noise first. */
const STAND_IN_ZSH = `#!/bin/sh
rc="\${ZDOTDIR:-$HOME}/.zshrc"
echo "welcome back"
if [ -f "$rc" ] && grep -q '^alias agent-org=' "$rc"; then
  printf 'agent-org is an alias for %s\\n' "$(sed -n "s/^alias agent-org='\\(.*\\)'$/\\1/p" "$rc")"
elif [ -x "$HOME/.local/bin/agent-org" ]; then
  printf 'agent-org is %s\\n' "$HOME/.local/bin/agent-org"
else
  echo "agent-org not found"
fi
`;

/** A bare repository with one release, v0.10.0, whose bin forwards to this checkout's, and a working copy of an older one (v0.2.0) as the checkout the alias names. */
function world() {
  const root = tmpDir("install-sh-command-");
  const home = join(root, "home");
  mkdirSync(join(home, "old"), { recursive: true });
  const work = join(root, "work");
  mkdirSync(join(work, "src", "install"), { recursive: true });
  git(work, "init", "--quiet", "--initial-branch=main");
  const release = (tag: string, bin: string, withCheck = true): void => {
    writeFileSync(join(work, "package.json"), `${JSON.stringify({ name: "agent-org", type: "module", version: tag.slice(1) })}\n`);
    writeFileSync(join(work, "src", "bin.ts"), bin);
    const check = join(work, "src", "install", "shell-command-cli.ts");
    if (withCheck) writeFileSync(check, `// the release carries the command check: install.sh looks for this file\n`);
    else rmSync(check, { force: true });
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", tag);
    git(work, "tag", tag);
  };
  release("v0.2.0", `console.log("old");\n`, false);
  release("v0.10.0", `import { spawnSync } from "node:child_process";\nprocess.exit(spawnSync(process.execPath, [${JSON.stringify(REAL_BIN)}, ...process.argv.slice(2)], { stdio: "inherit" }).status ?? 1);\n`);
  git(root, "clone", "--quiet", "--bare", work, "agent-org.git");
  git(home, "clone", "--quiet", work, join(home, "old", "agent-org"));
  git(join(home, "old", "agent-org"), "checkout", "--quiet", "v0.2.0");
  const bin = join(root, "path-bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  for (const name of PROGRAMS) symlinkSync(programPath(name), join(bin, name));
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nmkdir -p node_modules\n", { mode: 0o755 });
  const zshDir = join(root, "shell");
  mkdirSync(zshDir);
  writeFileSync(join(zshDir, "zsh"), STAND_IN_ZSH, { mode: 0o755 });
  /** Runs install.sh with `args`, no terminal to ask on, the stand-in zsh as the login shell, and `extra` added to its environment. */
  const install = (extra: Record<string, string> = {}, args: string[] = []) => spawnSync("/bin/bash", [INSTALL_SH, ...args], {
    encoding: "utf8", ...NO_CONTROLLING_TERMINAL,
    env: { ...GIT_ENV, NVM_DIR: "", FNM_DIR: "", FNM_MULTISHELL_PATH: "", HOME: home, PATH: bin, SHELL: join(zshDir, "zsh"), AGENT_ORG_REPO: join(root, "agent-org.git"), AGENT_ORG_HOME: "", AGENT_ORG_HOST: "", ...extra },
  });
  return { root, home, install, shim: join(home, ".local", "bin", "agent-org"), agentOrgHome: join(home, ".agent-org") };
}

/** An install over a home whose `.zshrc` holds `rcText`. */
function installOver(rcText: string) {
  const w = world();
  writeFileSync(join(w.home, ".zshrc"), rcText);
  const result = w.install();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return { w, result };
}

test("an install on a machine with an alias to an old checkout ends with the shim in place, and the alias line replaced and backed up", () => {
  const rcText = `export A=1\n${ORIGINAL_ALIAS}\nexport B=2\n`;
  const { w, result } = installOver(rcText);
  assert.equal(readFileSync(w.shim, "utf8"), launcherText({ agentOrgHome: w.agentOrgHome, current: join(w.agentOrgHome, "tool", "current") }), "the shim is in place");
  const lines = readFileSync(join(w.home, ".zshrc"), "utf8").split("\n");
  assert.deepEqual(lines.slice(0, 2), ["export A=1", `# agent-org (A11-285): replaced by the installed command ~/.local/bin/agent-org on ${new Date().toISOString().slice(0, 10)}; was:`]);
  assert.equal(lines[2], `# ${ORIGINAL_ALIAS}`, "the alias line is commented out, not deleted");
  assert.equal(lines[3], "export B=2");
  const [backup, ...more] = readdirSync(w.home).filter((name) => name.startsWith(".zshrc.before-agent-org-"));
  assert.deepEqual(more, []);
  assert.equal(readFileSync(join(w.home, backup), "utf8"), rcText, "the backup holds the original file");
  assert.match(result.stdout, /Checked the agent-org command/);
  assert.match(result.stdout, /agent-org: commented out ~\/\.zshrc:2 \(the whole file is kept as ~\/\.zshrc\.before-agent-org-/);
  assert.match(result.stdout, /no terminal to ask on, so it is replaced without asking/);
  assert.match(result.stdout, /agent-org install OK/);
});

test("an install whose shell already runs the shim changes no start-up file and reports success", () => {
  const rcText = "export A=1\n";
  const { w, result } = installOver(rcText);
  assert.equal(readFileSync(join(w.home, ".zshrc"), "utf8"), rcText);
  assert.deepEqual(readdirSync(w.home).filter((name) => name.includes("before-agent-org")), []);
  assert.match(result.stdout, /agent-org install OK/);
});

test("an alias the install cannot replace (its file is outside the home folder) ends in failure, never in success", () => {
  const w = world();
  const system = join(w.root, "system-zsh");
  mkdirSync(system);
  writeFileSync(join(system, ".zshrc"), `${ORIGINAL_ALIAS}\n`);
  const result = w.install({ ZDOTDIR: system });
  assert.equal(result.status, 1, result.stdout);
  assert.doesNotMatch(result.stdout, /agent-org install OK/);
  for (const said of [/agent-org install FAILED: /, /is an alias, defined at .*\.zshrc:1; it runs ~\/old\/agent-org \(v0\.2\.0, against the installed v0\.10\.0\)/, /is outside your home folder, so it is left as it is/]) {
    assert.match(result.stdout, said);
  }
  assert.equal(readFileSync(join(system, ".zshrc"), "utf8"), `${ORIGINAL_ALIAS}\n`, "a file outside home is never edited");
  assert.equal(existsSync(join(w.agentOrgHome, "tool", "current")), true, "agent-org itself is installed; only the shell's command is wrong");
});

test("a release that has no command check is installed as it always was, without comparing the shell's agent-org", () => {
  const w = world();
  const old = w.install({}, ["--version", "v0.2.0"]);
  assert.equal(old.status, 0, old.stdout + old.stderr);
  assert.doesNotMatch(old.stdout, /Checked the agent-org command/);
});
