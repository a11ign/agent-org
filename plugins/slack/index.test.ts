// no-token: none -- the plugin posts nothing: the registry reads its manifest, `create` builds the publisher over core's publish protocol, and its doctor rows and onboard step read settings
//
// THE PLUGIN AS CORE USES IT (A11-161): the registry finds it from its manifest, `create` builds the publisher with the block's run, connectors, model and effort, and its doctor rows and onboard step say what a
// person must set, each with the exact `agent-org plugin config slack` command that sets it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { publishingHelpers } from "../../src/plugins/publishing-helpers.ts";
import { defaultCatalog, pluginNamed } from "../../src/plugins/registry.ts";
import type { OnboardStepDeps } from "../../src/plugins/manifest.ts";
import * as plugin from "./index.ts";
import { create, DEFAULT_EFFORT, DEFAULT_MODEL, doctorChecks, onboardSteps } from "./index.ts";

const SETTINGS = { run: "Post these: {prs}. Write into {dir}.", connectors: ["^mcp__chat__send"] };
const deps = fakePluginDeps({ publishing: publishingHelpers() });
const [step] = onboardSteps;

test("the registry finds the plugin as the bundled publisher slack, from its manifest alone: the settings the page draws, and the skill its run uses", () => {
  const plugin = pluginNamed(defaultCatalog(), "slack");
  assert.ok(plugin !== undefined);
  assert.deepEqual([plugin.concern, plugin.where, plugin.contract, plugin.entry], ["publisher", "bundled", "1.1", "index.ts"]);
  assert.deepEqual(Object.keys(plugin.settings), ["run", "model", "effort", "connectors"]);
  for (const [name, entry] of Object.entries(plugin.settings)) assert.deepEqual([entry.key, entry.file], [`tickets.providers.publish.${name}`, "host.json"]);
  assert.deepEqual(plugin.tooling.skills, ["post-pr-to-slack"], "the hook reads the skill from the manifest, as data");
  assert.deepEqual([plugin.tooling.mcpServers, plugin.tooling.connectors], [[], []], "the connectors are the block's, which a host names");
});

test("create builds the publisher from the block: its connectors, its model and effort (haiku and low by default), and the brief and the outcome through core's protocol", () => {
  const publisher = create(SETTINGS, deps);
  assert.deepEqual(publisher.connectors(), ["^mcp__chat__send"]);
  assert.deepEqual(publisher.agent(), { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT });
  assert.deepEqual([DEFAULT_MODEL, DEFAULT_EFFORT], ["haiku", "low"]);
  assert.deepEqual(create({ ...SETTINGS, model: "sonnet", effort: "medium" }, deps).agent(), { model: "sonnet", effort: "medium" });
  assert.deepEqual(create({ run: SETTINGS.run }, deps).connectors(), [], "a block with no connectors offers none");
  const brief = publisher.briefText({ dir: "/runs/p1", prs: [{ repo: "owner/one", url: "https://github.com/owner/one/pull/1" }], run: SETTINGS.run });
  assert.ok(brief.includes("https://github.com/owner/one/pull/1") && brief.includes("Write into /runs/p1."));
  const dir = mkdtempSync(join(tmpdir(), "slack-plugin-"));
  try {
    writeFileSync(join(dir, "published.json"), JSON.stringify({ links: ["https://x.slack.com/archives/C1/p1"] }));
    assert.deepEqual(publisher.result(JSON.stringify({ kind: "published" }), dir), { links: ["https://x.slack.com/archives/C1/p1"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: a run that names {prs} and {dir} and a list of ^mcp__ connectors are two passing rows", () => {
  const rows = doctorChecks(SETTINGS, deps);
  assert.deepEqual(rows.map(({ name, ok }) => [name, ok]), [["slack run", true], ["slack connectors", true]]);
  assert.match(rows[1].detail, /one connector pattern, \^mcp__chat__send/);
});

test("doctor: a run that does not name {prs} and {dir} fails its row, with the command that sets it", () => {
  for (const run of ["Post the pull requests.", "Post {prs}.", "Write into {dir}.", undefined]) {
    const [row] = doctorChecks({ ...SETTINGS, run }, deps);
    assert.equal(row.ok, false, String(run));
    assert.match(row.fix ?? "", /^agent-org plugin config slack run='.*\{prs\} and \{dir\}.*'$/, String(run));
  }
  assert.match(doctorChecks({ connectors: SETTINGS.connectors }, deps)[0].detail, /names no run/);
});

test("doctor: no connectors, or one that is not anchored at ^mcp__ or does not compile, fails its row, with the command that sets them", () => {
  for (const connectors of [undefined, [], ["mcp__chat__send"], ["^mcp__chat__("], "^mcp__chat__send", [7]]) {
    const row = doctorChecks({ ...SETTINGS, connectors }, deps)[1];
    assert.equal(row.ok, false, JSON.stringify(connectors));
    assert.match(row.fix ?? "", /^agent-org plugin config slack connectors='\["\^mcp__<server>__<send tool>"\]'$/);
  }
  assert.match(doctorChecks({ run: SETTINGS.run }, deps)[1].detail, /names no connector, so the publish run has no tool to post with/);
});

/** What an onboard step is given: the prompts answer from `answers`, in order, and the flags say whether a terminal and a profile are there. */
function stepDeps(answers: string[], { interactive, answered }: { interactive: boolean; answered: boolean }): OnboardStepDeps & { asked: string[] } {
  const asked: string[] = [];
  return { ...deps, interactive, answered, asked, ask: async (question) => { asked.push(question); return answers.shift() ?? ""; }, askSecret: async () => "", writeFile: () => undefined,
    platform: "linux", home: "/home/me", agentOrgHome: "/home/me/.agent-org", flags: {} };
}

test("onboard: a publish block with a run and connectors asks nothing, and says nothing", async () => {
  const given = stepDeps([], { interactive: true, answered: false });
  assert.deepEqual(await step.run(SETTINGS, given), { ok: true, detail: "" });
  assert.deepEqual(given.asked, []);
});

test("onboard: with a terminal and no profile, a block that lacks the run or the connectors is asked for both, and the answers are the block's", async () => {
  const given = stepDeps(["Post {prs} into {dir}.", "^mcp__chat__send ^mcp__chat__post"], { interactive: true, answered: false });
  const answer = await step.run({}, given);
  assert.deepEqual(answer, { ok: true, detail: "the publish run is set", settings: { run: "Post {prs} into {dir}.", connectors: ["^mcp__chat__send", "^mcp__chat__post"] } });
  assert.equal(given.asked.length, 2, "both are asked");
  const keeps = await step.run({ run: SETTINGS.run }, stepDeps(["", "^mcp__chat__send"], { interactive: true, answered: false }));
  assert.deepEqual(keeps.settings, { run: SETTINGS.run, connectors: ["^mcp__chat__send"] }, "an empty answer keeps the run the block holds");
});

test("onboard: answers that are still no run or no connectors answer not ok with the config command, and write nothing", async () => {
  const answer = await step.run({}, stepDeps(["no placeholders", "^mcp__chat__send"], { interactive: true, answered: false }));
  assert.equal(answer.ok, false);
  assert.equal(answer.settings, undefined);
  assert.match(answer.detail, /run `agent-org plugin config slack run='.*' connectors='.*'`/);
});

test("onboard: without a terminal, or when a profile answered, it asks nothing and answers not ok with the command that sets run and connectors (A11-145: a Slack publisher is the profile's by hand)", async () => {
  for (const flags of [{ interactive: false, answered: false }, { interactive: true, answered: true }]) {
    const given = stepDeps([], flags);
    const answer = await step.run({ run: SETTINGS.run }, given);
    assert.equal(answer.ok, false, JSON.stringify(flags));
    assert.match(answer.detail, /^the Slack publisher has no run or no connectors: run `agent-org plugin config slack run=.* connectors=.*`$/);
    assert.deepEqual(given.asked, [], JSON.stringify(flags));
  }
});

test("the plugin has no release: disabling the publisher takes nothing off the machine, since a publish run is the board's and ends on its own", () => {
  assert.equal("release" in plugin, false);
});

test("the step is one, named for what it asks", () => {
  assert.deepEqual(onboardSteps.map(({ name }) => name), ["the publish run"]);
  assert.equal(readFileSync(new URL("./package.json", import.meta.url), "utf8").includes('"dependencies"'), false, "a bundled plugin declares none");
});
