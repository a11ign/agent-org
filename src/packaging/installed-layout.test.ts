// no-token: gh
//
// Nothing here reaches a real `gh`, and NOTHING here needs the network: the package is committed and tagged in a scratch git repository and
// installed from its `file://` URL, `typescript` is a fixture package installed from a directory, and `pnpm` runs `--offline`.

/**
 * #3068: THE TOOL INSTALLS AS A GIT DEPENDENCY AND SERVES THE REPOSITORY IT IS RUN IN.
 *
 * (a) The package is committed and tagged `v0.1.0` in a scratch repository and INSTALLED THROUGH `pnpm add -D` as a git dependency
 *     (`git+file://...#semver:^0.1.0`; measured 2026-10-02 on pnpm 10.34.5: pnpm resolves `#semver:` against a `file://` URL, so no `#v0.1.0`
 *     fallback is needed) into an empty project that has its own `typescript` and a `.agent-org/project.json`. A command then runs from there
 *     with no `NODE_PATH` and no `AGENT_ORG_HOST`, and `typescript` resolves to the PROJECT's.
 * (b) The same installed tool, run from a directory with no declaration, REFUSES naming `.agent-org/project.json` and the directory it looked
 *     in. It is the positive control for (a): the refusal exists, so the pass is not vacuous.
 * One table says which LAYOUT answers what (monorepo, the tool's own checkout, installed), and `$AGENT_ORG_HOST` wins in all three.
 * The installed directory is read for what a project gets: `src/bin.mjs`, `host/`, `LICENSE`, and no test file.
 *
 * THE PROBE COMMAND IS `worktrees:prune`, NOT `row-file --help` (the row's wording): `row-file` refuses without `--session=`, and every program
 * refuses `--help` as an unknown flag on purpose (`lib/cli-flags.mjs`: "an ignored flag runs the default and reports success"), so no command
 * answers `--help` with exit 0. `worktrees:prune` is a dry run that imports `project-config.mjs`, so it exits 0 exactly when the project resolved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandboxGitEnv } from "../lib/git-env.mjs";

const TOOL_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PNPM_TIMEOUT_MS = 120_000;
/** The installed `src/` holds well over this many files; a count this low means the install is empty and the "no test file" line below proves nothing. */
const MIN_INSTALLED_SRC_ENTRIES = 50;
const FIXTURE_TYPESCRIPT = "6.99.0";
const PROJECT_FILE = ".agent-org/project.json";
const HOST_VARIABLE = "AGENT_ORG_HOST";

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "installed-layout-")));
  scratchDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** The environment a project's shell has WITHOUT the two things the installed tool must not need. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = sandboxGitEnv();
  delete env.NODE_PATH;
  delete env[HOST_VARIABLE];
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", env: cleanEnv() });
}

/** The smallest declaration the tool's modules read at import: a project of nobody's, so nothing here is a11ign's. */
const DECLARATION = {
  schema: 1,
  tracker: [{ key: "", repo: "acme/widgets", board: { owner: "acme", number: 1 } }],
  code: [{ key: "", repo: "acme/widgets" }],
  units: { prefix: "acme-", boardReportWorkflow: "board.yml", own: [] },
  vocabulary: {
    labels: { backlog: "backlog", needsChairman: "needs:chairman", outOfRelease: "out-of-release", blocked: "blocked" },
    prefixes: { lane: "lane:", session: "session:", answer: "answer:" },
    milestones: { roadToVersionOne: "Road to one", outOfRelease: "Out of release" },
    lanesFile: "lanes.json",
    templateFields: { acceptance: "Acceptance", closes: "Closes", fleet: "Fleet" },
    fleetQuestion: "Does it need the fleet?",
    resources: [],
  },
};

/** A git repository that DECLARES a project. */
function projectRepository(): string {
  const dir = scratch();
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, ".agent-org"));
  writeFileSync(join(dir, PROJECT_FILE), JSON.stringify(DECLARATION));
  return dir;
}

/** A git repository that declares NOTHING. */
function bareRepository(): string {
  const dir = scratch();
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

/** The package as a project would get it: its files at a commit tagged `v0.1.0`, in a scratch repository a `file://` URL names. */
function taggedTool(): string {
  const repository = scratch();
  for (const entry of ["package.json", "README.md", "LICENSE", "src", "host"]) cpSync(join(TOOL_ROOT, entry), join(repository, entry), { recursive: true });
  git(repository, "init", "-q", "-b", "main");
  git(repository, "add", "-A");
  git(repository, "commit", "-q", "-m", "release v0.1.0");
  git(repository, "tag", "v0.1.0");
  return repository;
}

/** A `typescript` package that is nothing but a version, so "which one did the tool read" has an answer no real compiler could give. */
function fixtureTypescript(): string {
  const dir = scratch();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "typescript", version: FIXTURE_TYPESCRIPT, main: "index.js" }));
  writeFileSync(join(dir, "index.js"), `module.exports = { version: ${JSON.stringify(FIXTURE_TYPESCRIPT)} };\n`);
  return dir;
}

function pnpm(cwd: string, ...args: string[]) {
  return spawnSync("pnpm", [...args], { cwd, encoding: "utf8", env: cleanEnv(), timeout: PNPM_TIMEOUT_MS });
}

/** An empty project, with or without its own `typescript`, that has `agent-org` installed from the tagged repository. */
function installedProject({ withTypescript }: { withTypescript: boolean }) {
  const project = projectRepository();
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "acme-widgets", version: "1.0.0", private: true }));
  const typescript = withTypescript ? [`typescript@file:${fixtureTypescript()}`] : [];
  const added = pnpm(project, "add", "--offline", "-D", ...typescript, `agent-org@git+file://${taggedTool()}#semver:^0.1.0`);
  return { project, added };
}

/** `project-config.mjs` resolves its checkout when it is IMPORTED, so a tree with no project cannot import it: seed a host for the import alone.
 * It is done BEFORE any test is registered: a top-level `await` after a `test(` lets the first tests finish, and `test.after` delete the seeded host, mid-import. */
if (process.env[HOST_VARIABLE] === undefined || process.env[HOST_VARIABLE] === "") {
  const seeded = projectRepository();
  const hostFile = join(scratch(), "host.json");
  writeFileSync(hostFile, JSON.stringify({ schema: 1, primary: "p", projects: [{ id: "p", checkout: seeded }] }));
  process.env[HOST_VARIABLE] = hostFile;
}
const { ProjectDeclarationRefusal, resolveHomeCheckout } = await import("../project-config.mjs");

const installed = installedProject({ withTypescript: true });
const toolDir = (project: string) => join(project, "node_modules", "agent-org");
const binOf = (project: string) => join(toolDir(project), "src", "bin.mjs");

function runInstalled(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [binOf(installed.project), ...args], { cwd, encoding: "utf8", env: cleanEnv() });
}

test("(a) the tool installs through `pnpm add -D` as a git dependency pinned by `#semver:`", () => {
  assert.equal(installed.added.status, 0, `${installed.added.stdout}\n${installed.added.stderr}`);
  assert.ok(existsSync(binOf(installed.project)), "the installed package has no src/bin.mjs");
});

test("(a) a command runs from the installed tool with no NODE_PATH and no AGENT_ORG_HOST, serving the repository it is run in", () => {
  const run = pnpm(installed.project, "exec", "agent-org", "worktrees:prune");
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.doesNotMatch(run.stderr, /REFUSED/);
});

test("(a) a subdirectory of the project is the same project: the repository, not the directory, is what is served", () => {
  const sub = join(installed.project, "docs", "deep");
  mkdirSync(sub, { recursive: true });
  const run = runInstalled(sub, "worktrees:prune");
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

test("(a) `typescript` resolves to the PROJECT's, through the installed tool, with no NODE_PATH", () => {
  const url = pathToFileURL(join(toolDir(installed.project), "src", "lib", "resolve-typescript.mjs")).href;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `const { resolveTypescript } = await import(${JSON.stringify(url)}); console.log(resolveTypescript().version);`],
    { cwd: installed.project, encoding: "utf8", env: cleanEnv() });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), FIXTURE_TYPESCRIPT);
});

test("(b) POSITIVE CONTROL: the same installed tool, run where no declaration is, REFUSES naming the file and the directory it looked in", () => {
  const bare = bareRepository();
  const run = runInstalled(bare, "worktrees:prune");
  assert.notEqual(run.status, 0, "it served a repository that declares no project");
  assert.ok(run.stderr.includes(PROJECT_FILE), run.stderr);
  assert.ok(run.stderr.includes(bare), `the directory looked in (${bare}) is not named:\n${run.stderr}`);
  assert.doesNotMatch(run.stderr, /ENOENT/);
});

test("(b) outside any git repository it REFUSES naming the working directory and that it is not a repository", () => {
  const outside = scratch();
  const run = runInstalled(outside, "worktrees:prune");
  assert.notEqual(run.status, 0);
  assert.ok(run.stderr.includes(PROJECT_FILE) && run.stderr.includes(outside) && run.stderr.includes("not inside a git repository"), run.stderr);
});

test("(c) `agent-org no-such-command` from the installed tool REFUSES and lists the commands", () => {
  const run = pnpm(installed.project, "exec", "agent-org", "no-such-command");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /`no-such-command` is not a command/);
  assert.ok(run.stderr.includes("  row-file\n"), run.stderr);
});

test("what a project gets: src/bin.mjs, host/, LICENSE, README.md and no test file, and why none is needed at run time", () => {
  const dir = toolDir(installed.project);
  for (const entry of ["src/bin.mjs", "src/commands.mjs", "host", "LICENSE", "README.md", "package.json"]) assert.ok(existsSync(join(dir, entry)), `${entry} is not installed`);
  const tests = (readdirSync(dir, { recursive: true }) as string[]).filter((path) => /\.test\.(ts|mjs)$/.test(path));
  assert.deepEqual(tests, [], "a test file was installed: they read the project's tree and run in this repository's CI, so a project has no use for them");
  assert.ok(existsSync(join(dir, "src")) && readdirSync(join(dir, "src")).length > MIN_INSTALLED_SRC_ENTRIES, "the installed src/ is nearly empty: the positive control for the line above");
});

// ---- the layout table ------------------------------------------------------------------------------------------------------------------

/** A host file whose primary project is `checkout`. */
function hostNaming(checkout: string): string {
  const hostFile = join(scratch(), "host.json");
  writeFileSync(hostFile, JSON.stringify({ schema: 1, primary: "p", projects: [{ id: "p", checkout }] }));
  return hostFile;
}

/** What the resolver's `beside` is for a tool in `toolDir`: `src` up three, which is the checkout in the monorepo and a directory in the store when installed. */
const upThree = (toolDir: string) => resolve(toolDir, "../../..");

const monorepo = projectRepository();
const monorepoTool = join(monorepo, "packages", "agent-org", "src");
const standaloneParent = scratch();
const standaloneTool = join(standaloneParent, "agent-org", "src");
const installedTool = join(installed.project, "node_modules", ".pnpm", "agent-org@git+file+x", "node_modules", "agent-org", "src");
const hostsProject = projectRepository();

/** One row per layout and where the command is run: what answers when `$AGENT_ORG_HOST` is unset. */
const UNSET_TABLE = [
  { layout: "monorepo (packages/agent-org/src)", toolDir: monorepoTool, cwd: scratch(), answers: monorepo },
  { layout: "installed (node_modules/.pnpm/.../agent-org/src), run in the project", toolDir: installedTool, cwd: installed.project, answers: installed.project },
  { layout: "installed, run in a subdirectory of the project", toolDir: installedTool, cwd: join(installed.project, "docs"), answers: installed.project },
  { layout: "installed, run in a repository that declares another project", toolDir: installedTool, cwd: monorepo, answers: monorepo },
] as const;

for (const row of UNSET_TABLE) {
  test(`layout table, ${HOST_VARIABLE} unset: ${row.layout} answers the project`, () => {
    mkdirSync(row.cwd, { recursive: true });
    assert.equal(resolveHomeCheckout({ env: {}, toolDir: row.toolDir, beside: upThree(row.toolDir), cwd: row.cwd }), row.answers);
  });
}

test(`layout table, ${HOST_VARIABLE} unset: the tool's own checkout REFUSES naming the variable (#3039), and the installed form never answers inside node_modules`, () => {
  assert.throws(() => resolveHomeCheckout({ env: {}, toolDir: standaloneTool, beside: upThree(standaloneTool), cwd: installed.project }), (error: unknown) => {
    assert.ok(error instanceof ProjectDeclarationRefusal);
    assert.equal(error.field, HOST_VARIABLE);
    return true;
  });
  const answer = resolveHomeCheckout({ env: {}, toolDir: installedTool, beside: upThree(installedTool), cwd: installed.project });
  assert.ok(!answer.split("/").includes("node_modules"), `the installed form answered a directory inside node_modules: ${answer}`);
});

test("layout table, installed, run where no declaration is: REFUSES naming the file and the directory, never a guess", () => {
  const bare = bareRepository();
  assert.throws(() => resolveHomeCheckout({ env: {}, toolDir: installedTool, beside: upThree(installedTool), cwd: bare }), (error: unknown) => {
    assert.ok(error instanceof ProjectDeclarationRefusal);
    assert.equal(error.field, PROJECT_FILE);
    assert.ok(error.message.includes(bare) && error.message.includes(PROJECT_FILE), error.message);
    return true;
  });
});

for (const [layout, tool, cwd] of [
  ["monorepo", monorepoTool, monorepo],
  ["the tool's own checkout", standaloneTool, standaloneParent],
  ["installed", installedTool, installed.project],
] as const) {
  test(`layout table, ${HOST_VARIABLE} set: ${layout} answers the host file's primary project, whatever the layout would have said`, () => {
    assert.equal(resolveHomeCheckout({ env: { [HOST_VARIABLE]: hostNaming(hostsProject) }, toolDir: tool, beside: upThree(tool), cwd }), hostsProject);
  });
}

// ---- where `typescript` is looked for ------------------------------------------------------------------------------------------------------

/** `resolve-typescript.mjs` copied into a scratch tool tree (so its own `node_modules` is the one this test lays out), and imported. */
async function resolverIn(toolTree: string) {
  mkdirSync(join(toolTree, "lib"), { recursive: true });
  cpSync(join(TOOL_ROOT, "src", "lib", "resolve-typescript.mjs"), join(toolTree, "lib", "resolve-typescript.mjs"));
  const module = await import(pathToFileURL(join(toolTree, "lib", "resolve-typescript.mjs")).href);
  return module.resolveTypescript as (where?: { from?: string }) => { version: string };
}

/** A directory whose `node_modules/typescript` is a package that is only `version`. */
function directoryHolding(version: string): string {
  const dir = scratch();
  const home = join(dir, "node_modules", "typescript");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "package.json"), JSON.stringify({ name: "typescript", version, main: "index.js" }));
  writeFileSync(join(home, "index.js"), `module.exports = { version: ${JSON.stringify(version)} };\n`);
  return dir;
}

test("typescript: the PROJECT's is read before the tool's own, so the tool parses the project's code with the project's compiler", async () => {
  const resolve = await resolverIn(directoryHolding("1.0.0-tool"));
  assert.equal(resolve({ from: directoryHolding("2.0.0-project") }).version, "2.0.0-project");
});

test("typescript: a project without one gets the tool's own (what pnpm's linked peer is)", async () => {
  const resolve = await resolverIn(directoryHolding("1.0.0-tool"));
  assert.equal(resolve({ from: scratch() }).version, "1.0.0-tool");
});

test("typescript: with neither, it REFUSES naming the peer dependency, the project's directory and the remedy -- never a bare MODULE_NOT_FOUND", async () => {
  const resolve = await resolverIn(scratch());
  const project = scratch();
  assert.throws(() => resolve({ from: project }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /peer dependency/);
    assert.ok(error.message.includes(project), error.message);
    assert.match(error.message, /pnpm add -D typescript/);
    assert.ok(error.cause instanceof AggregateError, "the two underlying failures are not carried as the cause");
    return true;
  });
});
