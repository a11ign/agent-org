// no-token: none -- every program is a stand-in that answers from a list; the install record is an in-memory file, and no `claude` or `gh` is run
import { test } from "node:test";
import assert from "node:assert/strict";
import { installConventions, marketplacesOf, pluginVersion, type Run, updateConventions } from "./plugin-install.ts";
import type { PluginState } from "../ticket-mode/plugins.ts";
import type { RunResult } from "./service.ts";

const PLUGIN = "example@example-marketplace";
const REPO = "example-org/example-plugin";
const OK: RunResult = { status: 0, stdout: "", stderr: "" };
const FAILED = (stderr: string): RunResult => ({ status: 1, stdout: "", stderr });
const INSTALL_PATH = "/home/me/.claude/plugins/cache/example-marketplace/example/1.0.0";

/**
 * A stand-in for `claude` and `gh`: it records each call, answers the marketplace list from `marketplaces`, and when `claude plugin install` runs it adds the
 * plugin to the install record, which `stateOf` reads back. `answers` overrides a call by its words.
 */
function world({ marketplaces = [] as unknown[], record = {} as Record<string, unknown>, answers = {} as Record<string, RunResult> } = {}) {
  const calls: string[] = [];
  const state = { marketplaces: [...marketplaces], record: { ...record }, files: new Map<string, string>() };
  const run: Run = (file, args) => {
    const line = [file, ...args].join(" ");
    calls.push(line);
    const answer = Object.entries(answers).find(([words]) => line.startsWith(words));
    if (answer !== undefined) return answer[1];
    if (line === "claude plugin marketplace list --json") return { status: 0, stdout: JSON.stringify(state.marketplaces), stderr: "" };
    if (line === `claude plugin marketplace add ${REPO}`) {
      state.marketplaces.push({ name: "example-marketplace", source: "github", repo: REPO });
    }
    if (line === `claude plugin install ${PLUGIN} --scope user`) {
      state.record[PLUGIN] = [{ scope: "user", installPath: INSTALL_PATH, version: "1.0.0" }];
    }
    return OK;
  };
  const stateOf = (plugin: string): PluginState => {
    const installs = (state.record[plugin] as { scope: "user" | "project"; projectPath?: string; installPath: string }[] | undefined) ?? [];
    const loaded = installs.find((install) => install.scope === "user");
    return {
      plugin,
      installs: installs.map(({ scope, projectPath }) => ({ scope, projectPath: projectPath ?? null })),
      loads: loaded === undefined ? false : true,
      why: loaded === undefined ? `${plugin} is not installed: install it for every folder` : null,
      installPath: loaded === undefined ? null : loaded.installPath,
    };
  };
  return { calls, state, deps: { run, stateOf, read: (path: string) => state.files.get(path) ?? "" } };
}

test("a fresh machine adds the marketplace from its repository and installs the plugin for every session, then reads it back", () => {
  const { calls, deps } = world();
  const step = installConventions({ plugin: PLUGIN, repo: REPO }, deps);
  assert.deepEqual(calls, [
    `gh repo view ${REPO}`,
    "claude plugin marketplace list --json",
    `claude plugin marketplace add ${REPO}`,
    `claude plugin install ${PLUGIN} --scope user`,
  ]);
  assert.equal(step.installPath, INSTALL_PATH);
  assert.deepEqual(step.lines, [
    `added the marketplace from ${REPO}`,
    `installed ${PLUGIN} for every folder`,
    `${PLUGIN} loads for a worker's session`,
  ]);
});

test("a second run changes nothing: the marketplace and the install are there, so no add and no install runs", () => {
  const { calls, deps } = world({
    marketplaces: [{ name: "example-marketplace", source: "github", repo: REPO }],
    record: { [PLUGIN]: [{ scope: "user", installPath: INSTALL_PATH }] },
  });
  const step = installConventions({ plugin: PLUGIN, repo: REPO }, deps);
  assert.deepEqual(calls, [`gh repo view ${REPO}`, "claude plugin marketplace list --json"]);
  assert.ok(step.lines.includes(`the marketplace example-marketplace is from ${REPO} already: unchanged`));
  assert.ok(step.lines.includes(`${PLUGIN} is installed for every folder already: unchanged`));
});

test("a marketplace listed from another source is left as it is and said, never replaced", () => {
  const { calls, deps } = world({ marketplaces: [{ name: "example-marketplace", source: "directory", repo: null }] });
  const step = installConventions({ plugin: PLUGIN, repo: REPO }, deps);
  assert.ok(!calls.some((line) => line.startsWith("claude plugin marketplace add")), "no marketplace is added over it");
  assert.ok(step.lines.includes("the marketplace example-marketplace is listed from directory, not from example-org/example-plugin: it is left as it is, and not replaced"));
});

test("a repository the person cannot read stops the step before any claude call, and says how to sign in", () => {
  const { calls, deps } = world({ answers: { "gh repo view": FAILED("HTTP 404: Not Found\nmore") } });
  const step = installConventions({ plugin: PLUGIN, repo: REPO }, deps);
  assert.deepEqual(calls, [`gh repo view ${REPO}`]);
  assert.equal(step.installPath, null);
  assert.equal(step.lines[0], `could not read ${REPO} as your GitHub login: HTTP 404: Not Found. The plugin is private: run \`gh auth login\`, then \`agent-org onboard\` again.`);
});

test("an install that fails is said with its reason, and the plugin is not reported as loading", () => {
  const { deps } = world({ answers: { "claude plugin install": FAILED("plugin not found") } });
  const step = installConventions({ plugin: PLUGIN, repo: REPO }, deps);
  assert.equal(step.installPath, null);
  assert.equal(step.lines.at(-1), `could not install ${PLUGIN}: plugin not found`);
});

test("a marketplace list that cannot be read is said, and nothing is added", () => {
  const { calls, deps } = world({ answers: { "claude plugin marketplace list": FAILED("claude: not found") } });
  const step = installConventions({ plugin: PLUGIN, repo: REPO }, deps);
  assert.ok(!calls.some((line) => line.includes("marketplace add")));
  assert.deepEqual(step.lines, ["could not list Claude Code's marketplaces: is `claude` on PATH?"]);
});

test("the marketplace list is read from its JSON, and anything else is not a list", () => {
  assert.deepEqual(marketplacesOf(JSON.stringify([{ name: "a", source: "github", repo: "o/r" }, { name: "b", source: "directory", path: "/p" }])), [
    { name: "a", source: "github", repo: "o/r" },
    { name: "b", source: "directory", repo: null },
  ]);
  assert.equal(marketplacesOf("Configured marketplaces:"), null);
  assert.equal(marketplacesOf("{}"), null);
});

test("update refreshes each repository-sourced marketplace of the plugins and then the plugin, and says the version it moved to", () => {
  const files = new Map<string, string>([[`${INSTALL_PATH}/.claude-plugin/plugin.json`, JSON.stringify({ name: "example", version: "1.0.0" })]]);
  const { calls, deps } = world({ marketplaces: [{ name: "example-marketplace", source: "github", repo: REPO }], record: { [PLUGIN]: [{ scope: "user", installPath: INSTALL_PATH }] } });
  deps.read = (path) => files.get(path) ?? "";
  const update = updateConventions([PLUGIN], {
    ...deps,
    run: (file, args) => {
      const result = deps.run(file, args);
      if (args.join(" ") === `plugin update ${PLUGIN}`) files.set(`${INSTALL_PATH}/.claude-plugin/plugin.json`, JSON.stringify({ name: "example", version: "1.1.0" }));
      return result;
    },
  });
  assert.deepEqual(calls, ["claude plugin marketplace list --json", "claude plugin marketplace update example-marketplace", `claude plugin update ${PLUGIN}`]);
  assert.deepEqual(update.said, [`updated ${PLUGIN} from 1.0.0 to 1.1.0`]);
  assert.deepEqual(update.failed, []);
});

test("an update that moves nothing says nothing; a marketplace from another source is not refreshed here; a failed refresh is said and does not stop the next plugin", () => {
  const files = new Map<string, string>([[`${INSTALL_PATH}/.claude-plugin/plugin.json`, JSON.stringify({ version: "1.0.0" })]]);
  const { calls, deps } = world({
    marketplaces: [{ name: "example-marketplace", source: "github", repo: REPO }, { name: "local", source: "directory", repo: null }],
    record: { [PLUGIN]: [{ scope: "user", installPath: INSTALL_PATH }] },
    answers: { "claude plugin marketplace update example-marketplace": FAILED("network down") },
  });
  deps.read = (path) => files.get(path) ?? "";
  const failed = updateConventions([PLUGIN, "other@local"], deps);
  assert.deepEqual(failed.failed, ["could not update the marketplace example-marketplace: network down"]);
  assert.ok(!calls.some((line) => line.includes("other@local") || line.includes("marketplace update local")));
  const unchanged = world({ marketplaces: [{ name: "example-marketplace", source: "github", repo: REPO }], record: { [PLUGIN]: [{ scope: "user", installPath: INSTALL_PATH }] } });
  unchanged.deps.read = (path) => files.get(path) ?? "";
  assert.deepEqual(updateConventions([PLUGIN], unchanged.deps).said, []);
});

test("a plugin's version is read from its manifest, and is null when it cannot be", () => {
  assert.equal(pluginVersion("/p", () => JSON.stringify({ version: "2.0.0" })), "2.0.0");
  assert.equal(pluginVersion("/p", () => "{ not json"), null);
  assert.equal(pluginVersion(null, () => ""), null);
});
