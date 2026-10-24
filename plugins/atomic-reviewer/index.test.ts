// no-token: none -- the gate, `which` and `codex` are injected: nothing is loaded from the gate, no program runs
//
// THE PLUGIN AS CORE USES IT (A11-161): the registry finds it from its manifest under the name `atomic`, its doctor rows are the gate's check, Codex's and Codex's trust of the host file's repositories, and its onboard steps say what is left of Codex (asking nothing) and trust the host file's repositories (A11-221).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import type { ExecResult, OnboardStepDeps, PluginDeps, ReviewerHelpers } from "../../src/plugins/manifest.ts";
import { gateHelpers } from "../../src/plugins/reviewing-gate.ts";
import { defaultCatalog, pluginNamed } from "../../src/plugins/registry.ts";
import * as plugin from "./index.ts";
import { doctorChecks, onboardSteps } from "./index.ts";

/** The gate as doctor sees it: it loads, or refuses with `refusal`, and no module is read. */
const gate = (refusal: string | null = null): ReviewerHelpers => ({ ...gateHelpers(), loadGate: async () => undefined, gateRefusal: () => refusal });

/** `which codex` finds `path` (or nothing), and `codex login status` exits `status` (or cannot run). Any other program cannot start. */
const exec = ({ path = "/home/me/.local/bin/codex", status = 0 }: { path?: string | null; status?: number | null } = {}) => (file: string, args: readonly string[]): ExecResult => {
  if (file === "which" && args[0] === "codex") return path === null ? { status: 1, stdout: "", stderr: "" } : { status: 0, stdout: `${path}\n`, stderr: "" };
  if (file === "codex" && args.join(" ") === "login status") return { status, stdout: "", stderr: "" };
  return { status: null, stdout: "", stderr: `${file} cannot start` };
};

const depsOf = (over: Partial<PluginDeps> = {}): PluginDeps => fakePluginDeps({ reviewing: gate(), exec: exec(), ...over });

test("the registry finds the plugin as the bundled reviewer `atomic`, from the folder atomic-reviewer, by its manifest's agentOrg.name, with no setting and no tooling", () => {
  const found = pluginNamed(defaultCatalog(), "atomic");
  assert.ok(found !== undefined);
  assert.deepEqual([found.concern, found.where, found.contract, found.entry], ["reviewer", "bundled", "1.5", "index.ts"]);
  assert.match(found.dir ?? "", /\/plugins\/atomic-reviewer$/);
  assert.equal(pluginNamed(defaultCatalog(), "atomic-reviewer"), undefined, "the folder's name is not the plugin's");
  assert.deepEqual(Object.keys(found.settings), [], "`required` is the reviewer concern's, which core holds, and not the plugin's");
  assert.deepEqual([found.tooling.mcpServers, found.tooling.connectors, found.tooling.skills], [[], [], []], "the reviewer runs Codex through the gate, not an MCP server");
});

test("the plugin has no release: disabling the reviewer stops new starts only, and a reviewer still running finishes and posts", () => {
  assert.equal("release" in plugin, false);
  assert.equal("restore" in plugin, false);
});

test("doctor: the gate loads and Codex is installed and logged in are two passing rows, in the words doctor always used", async () => {
  const rows = await doctorChecks({}, depsOf());
  assert.deepEqual(rows.map(({ name, ok, detail }) => [name, ok, detail]), [["reviewer gate", true, "the gate's modules load"], ["codex", true, "/home/me/.local/bin/codex, logged in"], ["codex trust", true, "the host file names no repositories, so Codex has none to trust"]]);
});

test("doctor: a gate that does not load fails its row, with what it names, and the reviewer starts none until it does", async () => {
  const [row] = await doctorChecks({}, depsOf({ reviewing: gate("the gate's modules do not load") }));
  assert.deepEqual([row.name, row.ok, row.detail, row.fix], ["reviewer gate", false, "the gate's modules do not load", "fix what it names: no reviewer starts while the gate does not load"]);
});

test("doctor: Codex missing from PATH, logged out, or unable to run `codex login status` each fails the codex row with the one thing to do", async () => {
  const [, missing] = await doctorChecks({}, depsOf({ exec: exec({ path: null }) }));
  assert.deepEqual([missing.ok, missing.detail, missing.fix], [false, "`codex` is not on PATH, so the atomic reviewer cannot run", "install Codex (`npm install -g @openai/codex`), then run `codex login`"]);
  const [, loggedOut] = await doctorChecks({}, depsOf({ exec: exec({ status: 1 }) }));
  assert.deepEqual([loggedOut.ok, loggedOut.detail, loggedOut.fix], [false, "Codex is not logged in", "run `codex login`, then `agent-org doctor` again"]);
  const [, cannot] = await doctorChecks({}, depsOf({ exec: exec({ status: null }) }));
  assert.deepEqual([cannot.ok, cannot.detail], [false, "/home/me/.local/bin/codex could not run `codex login status`"]);
});

/** What an onboard step is given: no prompt answers, since the step asks nothing. */
function stepDeps(over: Partial<PluginDeps> = {}): OnboardStepDeps {
  const refused = async (): Promise<string> => { throw new Error("the Codex step asks nothing"); };
  return { ...depsOf(over), interactive: true, answered: false, ask: refused, askSecret: refused, writeFile: () => undefined, platform: "linux", home: "/home/me", agentOrgHome: "/home/me/.agent-org", flags: {} };
}

test("onboard: the codex step, which never prompts, says Codex is installed and logged in as done, and answers ok", async () => {
  assert.deepEqual(onboardSteps.map(({ name }) => name), ["codex", "codex trust"]);
  const answer = await onboardSteps[0].run({}, stepDeps());
  assert.deepEqual(answer, { ok: true, detail: "Codex is installed: done\nCodex is logged in: done" });
});

test("onboard: Codex missing, or installed and logged out, answers ok false and says what is left, in onboard's own words", async () => {
  const missing = await onboardSteps[0].run({}, stepDeps({ exec: exec({ path: null }) }));
  assert.deepEqual(missing, { ok: false, detail: "install Codex, which the atomic reviewer runs on: `npm install -g @openai/codex`\nlog in to Codex: `codex login`, with the account the reviewer should use" });
  const loggedOut = await onboardSteps[0].run({}, stepDeps({ exec: exec({ status: 1 }) }));
  assert.deepEqual(loggedOut, { ok: false, detail: "Codex is installed: done\nlog in to Codex: `codex login`, with the account the reviewer should use" });
});

test("a bundled plugin declares no dependencies", () => {
  assert.equal(readFileSync(new URL("./package.json", import.meta.url), "utf8").includes('"dependencies"'), false);
});
