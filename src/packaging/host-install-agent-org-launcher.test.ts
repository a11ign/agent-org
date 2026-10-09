// no-token: gh -- nothing here reaches a real `gh`, `herdr` or the network: every host, tool, project and bin directory is a temp directory this
// file builds and deletes, and the one program the launcher is made to start under a probe exits before it runs.
/**
 * #3532: `host:install` PUTS AN `agent-org` COMMAND IN `binDir`, AND IT RUNS THE TOOL'S CHECKOUT.
 *
 * Measured 2026-10-04T19:35Z at `v0.22.0`: `command -v agent-org` was empty in an agent session and `~/.local/bin` held `gh` and no `agent-org`. The
 * 40 `agent-org <cmd>` aliases in a project's `package.json` worked only because pnpm puts `node_modules/.bin` on the path of `pnpm run`, so removing
 * the dependency would leave every brief that says `agent-org <cmd>` with nothing to run.
 *
 *  1. `hostIdentityInstall` writes an executable `agent-org` into `binDir` whose bytes are the rendered shipped launcher. READ AGAINST the owned
 *     list, which on the unchanged tool has no such entry: that is the positive control, and the host with no `tool` is the other branch.
 *  2. The installed launcher, RUN as a child process from a scratch directory, executes THE `tool` THE HOST NAMES, with its arguments and its exit
 *     code. The control is a launcher rendered for a different checkout, which the same reader must tell apart.
 *  3. `host:check` (`hostUnitDrift`) reports it NOT INSTALLED when absent and DIVERGED when edited, by its path, and nothing when it is current.
 *  4. From a linked worktree the launcher and the project's own bin resolve the same project root, and this says WHICH rule each one answered by.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "../lib/git-env.mjs";
import { PROJECT_ROOT, TOOL_ROOT } from "./host-units-project.ts"; // FIRST of the tool imports: it makes a fixture project the tool's before `host-units.mjs` resolves one (#3233)

const { hostIdentityDrift, hostIdentityInstall, hostUnitDrift, ownedIdentityFiles, shippedScriptText } = await import("../host-units.ts");
const { homeHostConfig } = await import("../host-config.ts");

const HOST_VARIABLE = "AGENT_ORG_HOST";
const NO_SYSTEMD_USER_LINES = "LANG=C\n";
const UNKNOWN_COMMAND_EXIT = 2;
const NODE_DIR = fileURLToPath(new URL(".", `file://${process.execPath}`));

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-org-launcher-")));
  scratchDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** A `tool` that is only a `src/bin.mjs`: it says which checkout it is and exits with 2 for `unknown-command`, as the real one does. */
function stubTool(name: string): string {
  const tool = join(scratch(), name);
  mkdirSync(join(tool, "src"), { recursive: true });
  writeFileSync(join(tool, "src/bin.mjs"),
    `const [name, ...rest] = process.argv.slice(2);\nprocess.stdout.write(JSON.stringify({ tool: ${JSON.stringify(name)}, name, rest }) + "\\n");\n`
    + `process.exit(name === "unknown-command" ? ${UNKNOWN_COMMAND_EXIT} : 0);\n`);
  return tool;
}

/** The fixture host, with a scratch `binDir` and, when given, a `tool`: everything else the install reads is injected below. */
function hostWith(binDir: string, tool?: string) {
  return { ...homeHostConfig(), binDir, ...(tool === undefined ? {} : { tool }) };
}

function where(binDir: string, tool?: string) {
  const root = scratch();
  return { host: hostWith(binDir, tool), scriptDir: binDir, workersDir: join(root, "workers"), leadsDir: join(root, "leads"), out: () => {} };
}

function installInto(tool: string): { binDir: string, launcher: string, deps: ReturnType<typeof where> } {
  const binDir = join(scratch(), "bin");
  const deps = where(binDir, tool);
  hostIdentityInstall(deps as never);
  return { binDir, launcher: join(binDir, "agent-org"), deps };
}

/** What the launcher printed and exited with, run from a directory that is no repository and with no `AGENT_ORG_HOST`. */
function runFromElsewhere(launcher: string, args: string[]) {
  const env = { ...sandboxGitEnv(), PATH: `${NODE_DIR}:/usr/bin:/bin` } as NodeJS.ProcessEnv;
  delete env[HOST_VARIABLE];
  const ran = spawnSync(launcher, args, { cwd: scratch(), env, encoding: "utf8" });
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

// --- 1. the install writes the rendered launcher ---------------------------------------------------------------------

test("1. `host:install` writes an executable agent-org into binDir whose bytes are the rendered shipped launcher", () => {
  const tool = stubTool("tool-a");
  const { launcher, deps } = installInto(tool);
  const rendered = shippedScriptText("agent-org", deps as never);
  assert.ok(rendered !== null && rendered.includes(tool) && !rendered.includes("@@"), "the shipped launcher renders with the host's tool and no placeholder left");
  assert.equal(readFileSync(launcher, "utf8"), rendered);
  assert.ok((statSync(launcher).mode & 0o111) === 0o111, "executable by everyone who has it on PATH");
});

test("1. the positive control: the owned list HAS the launcher for a host with a tool and has NONE for a host without one", () => {
  const withTool = ownedIdentityFiles(where("/nonexistent-bin", "/nonexistent-tool") as never).map((f) => f.label);
  const without = ownedIdentityFiles(where("/nonexistent-bin") as never).map((f) => f.label);
  assert.ok(withTool.includes("agent-org launcher"), `the launcher is owned on a host that names a tool: ${withTool}`);
  assert.deepEqual(without.filter((label) => /agent-org/.test(label)), [], "a host with no tool has no checkout to launch, so it owns no launcher");
  assert.ok(without.includes("gh"), "and the list is the same list otherwise: the control reads the gh wrapper in both");
});

// --- 2. it runs THE host's tool, with arguments and exit code ---------------------------------------------------------

test("2. the launcher, RUN from a scratch directory, executes the tool the host names and passes arguments and the exit code through", () => {
  const tool = stubTool("tool-a");
  const { launcher } = installInto(tool);
  const ok = runFromElsewhere(launcher, ["row-claim", "check", "3532", "two words"]);
  assert.deepEqual([ok.status, JSON.parse(ok.stdout)], [0, { tool: "tool-a", name: "row-claim", rest: ["check", "3532", "two words"] }], ok.stderr);
  const refused = runFromElsewhere(launcher, ["unknown-command"]);
  assert.equal(refused.status, UNKNOWN_COMMAND_EXIT, "an exit of 2 for an unknown command stays 2");
});

test("2. the control: a launcher that execs a DIFFERENT checkout's bin.mjs is told apart by the same reading", () => {
  const { launcher: ofB } = installInto(stubTool("tool-b"));
  const ranTool = (launcher: string) => JSON.parse(runFromElsewhere(launcher, ["row-claim"]).stdout).tool;
  assert.equal(ranTool(ofB), "tool-b");
  assert.notEqual(ranTool(ofB), "tool-a", "the launcher of B does not satisfy the question 'does it run A'");
});

// --- 3. host:check reports it ----------------------------------------------------------------------------------------

/** `host:check`'s own drift, with systemd stubbed and the fixture project's shipped directory, narrowed to the launcher's path. */
function launcherFindings(deps: ReturnType<typeof where>, launcher: string) {
  const asked = { ...deps, systemctl: () => NO_SYSTEMD_USER_LINES, shippedDir: join(TOOL_ROOT, "host") };
  return (hostUnitDrift(asked as never) as { unit: string, problem: string }[]).filter((d) => d.unit === launcher);
}

test("3. an absent launcher is NOT INSTALLED, an edited one DIVERGED, an installed one neither, each by its path", () => {
  const { binDir, launcher, deps } = installInto(stubTool("tool-a"));
  assert.deepEqual(launcherFindings(deps, launcher), [], "the installed one is current");
  writeFileSync(launcher, `${readFileSync(launcher, "utf8")}# edited by hand\n`);
  assert.deepEqual(launcherFindings(deps, launcher).map((d) => d.problem), ["DIVERGED"]);
  rmSync(launcher);
  assert.deepEqual(launcherFindings(deps, launcher).map((d) => d.problem), ["NOT INSTALLED"]);
  assert.ok(!existsSync(join(binDir, "agent-org")));
  assert.deepEqual(hostIdentityDrift(deps as never).filter((d: { unit: string }) => d.unit === launcher).length, 1, "and the identity drift alone names it too");
});

// --- 4. from a linked worktree, the same project as the project's own bin ---------------------------------------------

/**
 * A preload for every node process of the command: it records which project the tool resolved (or that it refused) and ends the process BEFORE the
 * program runs, so the command asked about is never executed. `bin.mjs` itself is skipped because the program it starts is the one that resolves.
 */
const PROBE = `import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const program = process.argv[1] ?? "";
if (!program.endsWith("bin.mjs")) {
  const config = pathToFileURL(program.slice(0, program.lastIndexOf("/src/") + "/src/".length) + "project-config.mjs").href;
  let line;
  try { line = "ROOT " + (await import(config)).HOME_CHECKOUT; } catch (cause) { line = "REFUSED " + cause.name; }
  appendFileSync(process.env.PROBE_OUT, line + "\\n");
  process.exit(0);
}
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", env: sandboxGitEnv() });
}

/** A project (its main checkout and a LINKED worktree of it) with the tool installed in its own `node_modules`, as a project's `pnpm run` finds it. */
function projectWithLinkedWorktree() {
  const root = scratch();
  const main = join(root, "project");
  mkdirSync(join(main, ".agent-org"), { recursive: true });
  cpSync(join(PROJECT_ROOT, ".agent-org/project.json"), join(main, ".agent-org/project.json"));
  // The launcher's tool is a COPY of the sources laid out STANDALONE (`<root>/agent-org/src`, nothing declaring a project within three levels up),
  // whatever layout this suite runs in: the gate runs it from a monorepo whose `src` up three IS a declared project, which would answer first.
  const standalone = join(root, "agent-org");
  cpSync(join(TOOL_ROOT, "src"), join(standalone, "src"), { recursive: true });
  cpSync(join(TOOL_ROOT, "package.json"), join(standalone, "package.json"));
  const hostFile = join(root, "host.json");
  writeFileSync(hostFile, JSON.stringify({ ...JSON.parse(readFileSync(join(PROJECT_ROOT, ".agent-org/host.json"), "utf8")),
    binDir: join(root, "bin"), primary: "p", projects: [{ id: "p", checkout: main }], tool: standalone }));
  git(main, "init", "-q", "-b", "main");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "project");
  const linked = join(root, "project-wt");
  git(main, "worktree", "add", "-q", "-b", "agent/x", linked);
  const probe = join(root, "probe.mjs");
  writeFileSync(probe, PROBE);
  const installed = join(linked, "node_modules/agent-org");
  cpSync(join(TOOL_ROOT, "src"), join(installed, "src"), { recursive: true });
  cpSync(join(TOOL_ROOT, "package.json"), join(installed, "package.json"));
  return { root, main, linked, standalone, hostFile, probe, ownBin: join(installed, "src/bin.mjs") };
}

/** What the command resolved when run from the linked worktree, one line per node process that got as far as asking; `env` is added to a clean one. */
function resolvedRoot(project: ReturnType<typeof projectWithLinkedWorktree>, argv: string[], env: Record<string, string> = {}): string {
  const out = join(scratch(), "probe.out");
  const clean = { ...sandboxGitEnv(), PATH: `${NODE_DIR}:/usr/bin:/bin`, NODE_OPTIONS: `--import ${project.probe}`, PROBE_OUT: out } as NodeJS.ProcessEnv;
  delete clean[HOST_VARIABLE];
  Object.assign(clean, env);
  const [command, ...args] = argv;
  spawnSync(command, args, { cwd: project.linked, env: clean, encoding: "utf8" });
  return existsSync(out) ? readFileSync(out, "utf8").trim() : "(the command never asked)";
}

/**
 * #3532 POINT 4: FROM A LINKED WORKTREE THE LAUNCHER RESOLVES THE PROJECT THE WAY `pnpm run <alias>` DID, AND THE RULE IT ANSWERS BY IS NAMED HERE.
 *
 * Measured 2026-10-04 before `resolveHomeCheckout` gave the standalone layout the installed layout's rule, the launcher refused (unset) or answered the
 * main checkout (`AGENT_ORG_HOST` set), and the row's ruling (`product-manager`, option (a)) widened the Region to close it. The three readings now:
 *
 *   - the project's own bin (the tool in `node_modules`): the INSTALLED layout, the git repository of the working directory, the LINKED worktree;
 *   - the launcher, `AGENT_ORG_HOST` unset: the STANDALONE layout, which now answers by THE SAME RULE: the working directory's repository, when it holds
 *     the declaration (and still refuses by name when it does not: `installed-layout.test.ts` and `home-checkout-refusal.test.ts` pin that);
 *   - the launcher, `AGENT_ORG_HOST` set: the OTHER rule, that host file's PRIMARY project's checkout, the main checkout and not the worktree. It is
 *     the explicit override and it wins; no value of it can name a linked worktree, so it is not what `agent-org <cmd>` is run with from one.
 */
test("4. from a linked worktree the launcher and the project's own bin resolve the same project root, by the working directory's repository", () => {
  const project = projectWithLinkedWorktree();
  hostIdentityInstall(where(join(project.root, "bin"), project.standalone) as never);
  const launcher = join(project.root, "bin/agent-org");
  const command = "worktrees:prune";
  const own = resolvedRoot(project, [process.execPath, project.ownBin, command]);
  const unset = resolvedRoot(project, [launcher, command]);
  const declared = resolvedRoot(project, [launcher, command], { [HOST_VARIABLE]: project.hostFile });
  assert.equal(own, `ROOT ${project.linked}`, "the rule `pnpm run` answered by: the working directory's repository");
  assert.equal(unset, own, "the launcher with no AGENT_ORG_HOST: the same rule, so the same root");
  assert.equal(declared, `ROOT ${project.main}`, "POSITIVE CONTROL: the other rule, AGENT_ORG_HOST's primary, is a different root, so the equality above is not vacuous");
  assert.notEqual(declared, unset, "the two rules are told apart by this reading");
});
