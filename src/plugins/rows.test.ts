// no-token: gh -- the code host is loaded from this checkout and every operation is handed a stub `run`; the children print what they read and nothing reaches GitHub
/**
 * A11-160 (step 4): HOW CORE REACHES THE CODE HOST'S `rows`, from a program that cannot await an activation first.
 *
 * Five claims, each with a case that can fail:
 *   1. with nothing activated, the host file's code host is loaded once, by `require`, and its rows answer; a plugin the loader would refuse is refused here by name;
 *   2. what a test substituted, and then what an activation built, are the ones row mode uses, in that order, and forgetting both starts over;
 *   3. a code host with no `rows` refuses a row-mode program by name;
 *   4. a program that only reads rows by label loads none of the project's declaration, so it runs on a host with no project (`provider-low-confidence --question` is one);
 *   5. the delegates whose operations read the project are given it, and read what the project's vocabulary says.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { codeHostForRows, forgetActivation, substituteCodeHost } from "./active.ts";
import { loadCodeHostSync } from "./activate-host-sync.ts";
import { createFakeCodeHost } from "./fakes/code-host.ts";
import { fakePluginDeps } from "./fakes/deps.ts";
import { defaultCatalog, pluginNamed } from "./registry.ts";
import { rows } from "./rows.ts";

const SRC = fileURLToPath(new URL("../", import.meta.url));
const DEPS = () => fakePluginDeps();
const PROJECT = join(SRC, "packaging", "fixtures", "row-claim-file-overlap-rule", "project");

const hostText = (providers: Record<string, unknown>): string => JSON.stringify({ tickets: { providers } });

// --- 1. loaded by require --------------------------------------------------------------------------------------------------------------

test("the GitHub plugin's module graph can be required, because it has no top-level `await`, and its rows are the ones a delegate calls", () => {
  const module = createRequire(import.meta.url)(join(SRC, "..", "plugins", "github", "index.ts"));
  assert.deepEqual(Object.keys(module).sort(), ["create", "doctorChecks", "keep", "onboardSteps"], "a graph with a top-level await is refused by require, and the load below would throw");
  const host = loadCodeHostSync(null, {}, DEPS);
  assert.equal(host.rows?.tracker, "github", "no host file names the default, which is the bundled GitHub plugin, built with its rows");
  assert.equal(typeof host.rows?.readRowsByLabel, "function");
});

test("a checkout with no bundled plugin says its plugins folder is missing, and not that the host file names the wrong plugin", () => {
  assert.throws(() => loadCodeHostSync(null, {}, DEPS, { plugins: [], refusals: [] }), /this tool's checkout holds no bundled plugin: its plugins\/ folder is missing/);
});

test("a code host that is a fake, or a plugin of a contract major this agent-org does not read, is refused by name", () => {
  assert.throws(() => loadCodeHostSync(hostText({ codeHost: { provider: "fake-codeHost" } }), {}, DEPS), /the code host is fake-codeHost, which has no code to run on a host: name a bundled code host plugin in tickets\.providers\.codeHost/);
  const github = pluginNamed(defaultCatalog(), "github")!;
  const catalog = { plugins: [{ ...github, contract: "2.0" }], refusals: [] };
  assert.throws(() => loadCodeHostSync(null, {}, DEPS, catalog), /the code host plugin github was refused: .*2\.0/);
  const broken = { plugins: [{ ...github, entry: "package.json" }], refusals: [] };
  assert.throws(() => loadCodeHostSync(null, {}, DEPS, broken), /the code host plugin github was refused/, "an entry that is not a plugin's module is refused too, and by name");
});

// --- 2. what row mode uses, in order ----------------------------------------------------------------------------------------------------

test("row mode uses the substituted code host, then the activated one, then the host file's, each once, and forgetting starts over", () => {
  forgetActivation();
  try {
    const loaded = codeHostForRows({});
    assert.equal(codeHostForRows({}), loaded, "the host file's code host is loaded once per process");
    const fake = createFakeCodeHost();
    substituteCodeHost(fake);
    assert.equal(codeHostForRows({}), fake, "a test's substitute comes first");
    forgetActivation();
    assert.notEqual(codeHostForRows({}), fake, "forgetting takes the substitute away");
    assert.notEqual(codeHostForRows({}), loaded, "and the one loaded on row mode's own, which is loaded again");
  } finally {
    forgetActivation();
  }
});

// --- 3. a code host with no rows ---------------------------------------------------------------------------------------------------------

test("a code host with no rows refuses a row-mode program by name, and the real one serves it", () => {
  forgetActivation();
  try {
    substituteCodeHost(createFakeCodeHost());
    assert.throws(() => rows(), /row mode needs a code host that implements rows: .+ does not/);
  } finally {
    forgetActivation();
  }
  assert.equal(rows().tracker, "github", "CONTROL: with the substitute gone the host file's code host serves them");
  forgetActivation();
});

// --- 4 and 5. what a program loads ----------------------------------------------------------------------------------------------------------

const PROJECT_FILES = ["project-config.ts", "board-snapshot-scope.ts", "project-vocabulary.ts", "wait-condition.ts"];

/** A module run as an ES module in a child with `AGENT_ORG_HOST` set to `host`, after a preload that records the project's files it resolves. */
function runChild(code: string, root: string, host: string): Promise<{ code: number | null; stdout: string; stderr: string; loads: string[] }> {
  const loads = join(root, "loads.txt");
  const preload = join(root, "record-loads.mjs");
  writeFileSync(preload, `import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
const PROJECT = ${JSON.stringify(PROJECT_FILES.map((file) => `/src/${file}`))};
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (PROJECT.some((suffix) => resolved.url.endsWith(suffix))) appendFileSync(${JSON.stringify(loads)}, resolved.url.split("/src/")[1] + "\\n");
  return resolved;
} });
`);
  const args = ["--import", pathToFileURL(preload).href, "--input-type=module", "-e", code];
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, AGENT_ORG_HOST: host }, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (exitCode) => done({ code: exitCode, stdout, stderr, loads: existsSync(loads) ? [...new Set(readFileSync(loads, "utf8").split("\n").filter(Boolean))].sort() : [] }));
  });
}

const importOf = (file: string): string => JSON.stringify(pathToFileURL(join(SRC, "ticket-port", file)).href);

test("a program that reads rows by label loads none of the project's declaration, so it runs on a host with no project", async () => {
  const root = tmpDir("rows-no-project-");
  const host = join(root, "host.json");
  writeFileSync(host, JSON.stringify({ clones: { demo: join(root, "demo") }, tickets: {} }));
  const page = JSON.stringify({ data: { repository: { issues: { nodes: [{ number: 7 }], pageInfo: { hasNextPage: false } } } } });
  const outcome = await runChild(`const { readRowsByLabel } = await import(${importOf("rows-by-label.ts")});
    process.stdout.write(JSON.stringify(readRowsByLabel({ label: "in-progress", state: "OPEN", select: "number", run: () => ${JSON.stringify(page)} })));`, root, host);
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.stdout, '[{"number":7}]', "the row came back through the plugin's reader, which the host file's code host (the default) loaded");
  assert.deepEqual(outcome.loads, [], "no file that evaluates the project's declaration was loaded");
});

test("a delegate whose operation reads the project is given its vocabulary: the adapter reads a `ready` row as ready", async () => {
  const root = tmpDir("rows-project-");
  const checkout = join(root, "project");
  cpSync(PROJECT, checkout, { recursive: true });
  const host = join(root, "host.json");
  writeFileSync(host, JSON.stringify({ schema: 1, home: root, binDir: join(root, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout }], gh: { workers: join(root, "w"), leads: join(root, "l"), leadsHeader: [], leadsWorkspaces: [] } }));
  const issue = { number: 5, title: "A row", body: "", state: "OPEN", createdAt: "2026-10-09T10:00:00Z", author: { login: "a" }, labels: { nodes: [{ name: "ready" }] }, projectItems: { nodes: [] },
    parent: null, subIssues: { nodes: [] }, blockedBy: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] }, timelineItems: { nodes: [] } };
  const outcome = await runChild(`const { githubTicketAdapter } = await import(${importOf("github-adapter.ts")});
    const adapter = githubTicketAdapter({ scope: "a/b", run: () => ${JSON.stringify(JSON.stringify({ data: { repository: { issue } } }))} });
    process.stdout.write(String(adapter.readItem({ tracker: "github", scope: "a/b", id: 5 })?.state));`, root, host);
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.stdout, "ready");
  assert.ok(outcome.loads.includes("project-config.ts") && outcome.loads.includes("project-vocabulary.ts"), "and it is the project's own vocabulary it read");
});
