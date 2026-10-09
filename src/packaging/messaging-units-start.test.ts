// no-token: none -- the children this file starts run against a scratch project with no `messaging` key and a scratch HOME, so they stop before any secret, lock, `gh` or network call

/**
 * #3485: THE CHAIRMAN-MESSAGING UNITS IN TOOL FORM START, AND ARE NOT ONLY READ.
 *
 * #3443 rendered `chairman-listen` and `chairman-watch` in tool form (`WorkingDirectory=<tool checkout>`, `ExecStart=/usr/bin/node src/messaging/<x>.mjs`),
 * but both programs took the project root from `process.cwd()`, and the tool's checkout holds no `.agent-org/`: exit 2, which `Restart=on-failure` with
 * `RestartPreventExitStatus=2` does not restart. Its property test walked the shipped templates as TEXT, so nothing ran a rendered unit until the host act did.
 *
 * So this file does what a unit does: it renders the shipped template with the real `toolForm`, reads the unit's `WorkingDirectory`, `ExecStart` and
 * `Environment=` lines BACK, and starts that `ExecStart` as a child process from that directory with exactly that environment. The mutant is the
 * pre-fix tool: a copy of the tool whose root is `process.cwd()` again, which must exit 2 and name the declaration it looked for under the tool directory.
 *
 * `toolForm` is rendered in a child (see `RENDER`) so this file does not import `host-units.ts`, which would charge it with a `history` requirement it has no use for.
 */
import { TSX_IMPORT } from "../tsx-import.ts";
import { toolNodeModules } from "./tool-node-modules.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TOOL_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NODE = "/usr/bin/node";
const CHILD_TIMEOUT_MS = 30_000;
const REFUSED = 2;

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "messaging-units-start-"));
  scratchDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** The smallest declaration the tool's modules read at import, and NO `messaging` key: messaging is switched off, so a started program stops at once. */
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

type Scratch = { home: string; project: string; hostFile: string };

/** A scratch HOME and a scratch project holding `.agent-org/project.json` and `host.json`: the host the units are rendered for. */
function scratchHost(): Scratch {
  const root = scratch();
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(join(project, ".agent-org"), { recursive: true });
  writeFileSync(join(project, ".agent-org/project.json"), JSON.stringify(DECLARATION));
  const hostFile = join(project, ".agent-org/host.json");
  writeFileSync(hostFile, JSON.stringify({
    schema: 1, home, binDir: join(home, "bin"), primary: "widgets", projects: [{ id: "widgets", checkout: project }],
    gh: { workers: join(home, "workers"), leads: join(home, "leads"), leadsHeader: ["acme leads"], leadsWorkspaces: [{ id: "w1", role: "lead" }] },
  }));
  return { home, project, hostFile };
}

const { localImports } = await import("../lib/local-import-closure.ts");

const SRC = fileURLToPath(new URL("..", import.meta.url));

/**
 * Run in a CHILD, not imported: `host-units.ts` calls `git log --all`, so a test that imports it derives a `history` requirement (#2174, `work-gate.test.ts`'s
 * ratchet) and its pull request owes `History: full` (#497). This file never reaches git: it needs only `toolForm`'s rendering, which is the real one run here.
 * The child resolves the tool's modules at import, so `AGENT_ORG_HOST` is the scratch host's.
 */
const RENDER = `
const [, , hostUnits, hostConfig, name, hostFile, project, tool] = process.argv;
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { SHIPPED_DIR, toolForm } = await import(hostUnits);
const { parseHostConfig, renderTemplate, templateValues } = await import(hostConfig);
const host = parseHostConfig(readFileSync(hostFile, "utf8"), "scratch host.json");
const template = readFileSync(join(SHIPPED_DIR, name + ".service.in"), "utf8");
const values = templateValues(host, { prefix: "acme-", boardReportWorkflow: "board.yml", own: [] });
process.stdout.write(toolForm(name + ".service.in", renderTemplate(template, values, name), { tool, checkout: project, beforeTicks: [] }));
`;

/** @returns the shipped template `name` as a unit of THIS host, in tool form for `tool` (the real `toolForm`, not a copy of its lines) */
function renderedToolForm(name: string, host: Scratch, tool: string): string {
  const modules = ["host-units.ts", "host-config.ts"].map((file) => pathToFileURL(join(SRC, file)).href);
  // A script FILE and not `-e`: the tool's modules guard their CLI half on `process.argv[1]` being a path, which under `-e` is the first argument.
  const script = join(dirname(host.project), "render.mjs");
  writeFileSync(script, RENDER);
  const run = spawnSync(process.execPath, [...TSX_IMPORT, script, ...modules, name, host.hostFile, host.project, tool],
    { env: { AGENT_ORG_HOST: host.hostFile }, encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
  assert.equal(run.status, 0, `rendering ${name} in tool form failed: ${run.stderr}`);
  return run.stdout;
}

type Started = { workingDirectory: string; execStart: string; env: Record<string, string>; status: number | null; stdout: string; stderr: string };

/** The unit's single value for `directive`: the test's own reading of the unit, so a unit with two (or none) is a failure of the rendering and says so. */
function directiveOf(unit: string, directive: string): string[] {
  return unit.split("\n").filter((line) => line.startsWith(`${directive}=`)).map((line) => line.slice(directive.length + 1));
}

/** `Environment=` lines as systemd reads them, with `%h` the unit's HOME: only what the unit declares, which is the point (nothing of THIS process's reaches the child). */
function environmentOf(unit: string, home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const assignment of directiveOf(unit, "Environment")) {
    const at = assignment.indexOf("=");
    env[assignment.slice(0, at)] = assignment.slice(at + 1).replaceAll("%h", home);
  }
  return env;
}

/** Starts the unit's `ExecStart` as a child from the unit's `WorkingDirectory` with the unit's environment. `/usr/bin/node` is the unit's; it is run as the node of this process. */
function startUnit(unit: string, home: string): Started {
  const [workingDirectory] = directiveOf(unit, "WorkingDirectory");
  const [execStart, ...extra] = directiveOf(unit, "ExecStart");
  assert.equal(extra.length, 0, "a unit with two ExecStart= lines is not one a test can start");
  const [program, ...args] = execStart.split(" ");
  assert.equal(program, NODE, `the unit runs ${NODE} directly, as the tool form does (it was \`pnpm run\` from the project before #3443)`);
  const env = environmentOf(unit, home);
  const run = spawnSync(process.execPath, args, { cwd: workingDirectory, env, encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
  return { workingDirectory, execStart, env, status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** What each unit does when it starts for a project with messaging off: the next real step after the declaration is read. */
const UNITS = [
  { name: "chairman-listen", entry: "src/messaging/listen.ts", stdout: /messaging: OFF/ },
  { name: "chairman-watch", entry: "src/messaging/watch.ts", stdout: /^$/ },
];

/** The tool's own files this entry imports, so a copy of the tool can run it (the files; `preFixTool` adds `node_modules` for the loader). */
function closureOf(entry: string): Set<string> {
  const files = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const next of localImports(file)) visit(next);
  };
  visit(entry);
  return files;
}

/** A copy of the tool whose messaging root is `process.cwd()` again: the shape `v0.13.0` shipped, made by undoing this row's one line in the copy. */
function preFixTool(entry: string): string {
  const tool = join(scratch(), "tool");
  for (const file of closureOf(join(TOOL_ROOT, entry))) {
    const target = join(tool, relative(TOOL_ROOT, file));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
  }
  // The unit's `--import tsx` resolves from its WorkingDirectory, so the copy is given what a checkout of the tool has: its `package.json` and `node_modules`.
  writeFileSync(join(tool, "package.json"), '{"type":"module"}');
  symlinkSync(toolNodeModules(), join(tool, "node_modules"));
  const copied = join(tool, entry);
  const fixed = readFileSync(copied, "utf8");
  const mutated = fixed.replace("root: HOME_CHECKOUT,", "root: process.cwd(),");
  assert.notEqual(mutated, fixed, `the copy of ${entry} must carry the line this row changed, or the mutant is not the pre-fix tool`);
  writeFileSync(copied, mutated);
  return tool;
}

for (const { name, entry, stdout } of UNITS) {
  test(`#3485 (1)(2): ${name}, rendered in tool form and started from its own WorkingDirectory, reads the project through AGENT_ORG_HOST and reaches its next step`, () => {
    const host = scratchHost();
    const started = startUnit(renderedToolForm(name, host, TOOL_ROOT), host.home);
    assert.equal(started.workingDirectory, TOOL_ROOT, "the unit starts in the TOOL's checkout");
    assert.ok(!existsSync(join(started.workingDirectory, ".agent-org")), "and that directory holds no declaration: the property the defect lives in");
    assert.equal(started.env.AGENT_ORG_HOST, host.hostFile, "the unit tells the tool where the project is");
    assert.equal(started.env.HOME, host.home, "a scratch HOME: the host's real ~/.config/agent-org is never read");
    assert.equal(started.status, 0, `${started.execStart}: ${started.stderr}`);
    assert.equal(started.stderr, "");
    assert.match(started.stdout.split("\n").filter((line) => line.startsWith("messaging:")).join("\n"), stdout, "messaging OFF is the step it reaches");
    // `.cache` is node's own compile cache (the unit's `NODE_COMPILE_CACHE=%h/.cache/...`); the program's secrets and state live under `.config` and `.local`.
    assert.deepEqual(readdirSync(host.home).filter((entry) => entry !== ".cache"), [], "(4) messaging off constructs nothing: no secret, lock or state directory under the scratch HOME, and no network");
    assert.equal(JSON.parse(readFileSync(join(host.project, ".agent-org/project.json"), "utf8")).messaging, undefined, "(4) the project has no `messaging` key, so nothing starts a poller");
  });

  test(`#3485 (3): the MUTANT -- ${name} reading its root from process.cwd() again -- exits 2 and names the declaration under the tool directory`, () => {
    const host = scratchHost();
    const tool = preFixTool(entry);
    const started = startUnit(renderedToolForm(name, host, tool), host.home);
    assert.equal(started.workingDirectory, tool);
    assert.equal(started.status, REFUSED, `POSITIVE CONTROL: the pre-fix tool must exit 2 here, got ${started.status}: ${started.stderr}`);
    assert.ok(started.stderr.includes(join(tool, ".agent-org/project.json")), `it names the file it looked for under the tool: ${started.stderr}`);
  });
}
