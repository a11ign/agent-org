// no-token: none -- a temporary CODEX_HOME and temporary clones; nothing reads or writes the real ~/.codex
//
// ONBOARD'S `codex trust` STEP (A11-221): it trusts every chosen repository in Codex, leaves what a person set, and never prompts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { tmpDir } from "../../src/lib/tmp-fixture.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import type { OnboardStepDeps } from "../../src/plugins/manifest.ts";
import { ONBOARD_STEPS } from "./onboard.ts";

const step = ONBOARD_STEPS.find(({ name }) => name === "codex trust")!;

function machine(config: ((clones: Record<string, string>) => string) | null = null) {
  const root = tmpDir("codex-trust-onboard-");
  const clones = { alpha: join(root, "repos", "alpha"), beta: join(root, "repos", "beta"), gamma: join(root, "repos", "gamma") };
  for (const clone of Object.values(clones)) mkdirSync(clone, { recursive: true });
  const codexHome = join(root, "codex");
  const file = join(codexHome, "config.toml");
  if (config !== null) { mkdirSync(codexHome); writeFileSync(file, config(clones)); }
  const refused = async (): Promise<string> => { throw new Error("the Codex trust step asks nothing"); };
  const deps: OnboardStepDeps = { ...fakePluginDeps({ env: { CODEX_HOME: codexHome }, clones }), interactive: true, answered: false, ask: refused, askSecret: refused, writeFile: () => undefined, platform: "linux", home: join(root, "home"), agentOrgHome: join(root, "home", ".agent-org"), flags: {} };
  return { clones, file, deps, root };
}

test("the plugin's onboard steps are the codex step, then the codex trust step", () => {
  assert.deepEqual(ONBOARD_STEPS.map(({ name }) => name), ["codex", "codex trust"]);
});

test("onboard trusts every chosen repository: it adds an entry for each clone missing one and leaves the others alone", async () => {
  const m = machine((clones) => `# mine\n[projects."${clones.alpha}"]\ntrust_level = "trusted"\n\n[projects."${clones.beta}"]\ntrust_level = "untrusted"\n`);
  const before = readFileSync(m.file, "utf8");
  const answer = await step.run({}, m.deps);
  assert.deepEqual(answer, { ok: true, detail: [`Codex trusts ${m.clones.alpha}: done`, `Codex trusts ${m.clones.beta}: left as set (untrusted)`, `Codex trusts ${m.clones.gamma}: trusted now`].join("\n") });
  const after = readFileSync(m.file, "utf8");
  assert.equal(after, `${before}\n[projects."${m.clones.gamma}"]\ntrust_level = "trusted"\n`, "only the missing entry is added, at the end");
  assert.deepEqual(Object.entries(parse(after).projects as Record<string, { trust_level: string }>).map(([root, { trust_level }]) => [root, trust_level]),
    [[m.clones.alpha, "trusted"], [m.clones.beta, "untrusted"], [m.clones.gamma, "trusted"]]);
});

test("onboard on a machine with no Codex config creates it with every chosen repository trusted, and a second run changes nothing", async () => {
  const m = machine();
  const first = await step.run({}, m.deps);
  assert.equal(first.ok, true);
  const text = readFileSync(m.file, "utf8");
  assert.deepEqual(Object.keys(parse(text).projects as object), [m.clones.alpha, m.clones.beta, m.clones.gamma]);
  const second = await step.run({}, m.deps);
  assert.equal(second.detail.includes("trusted now"), false);
  assert.equal(readFileSync(m.file, "utf8"), text);
});

test("onboard answers ok false and names the file when Codex's config cannot be parsed, and writes nothing", async () => {
  const m = machine(() => "[[[");
  const answer = await step.run({}, m.deps);
  assert.equal(answer.ok, false);
  assert.ok(answer.detail.includes(m.file) && answer.detail.includes(`Codex could not be told to trust ${m.clones.alpha}`), answer.detail);
  assert.equal(readFileSync(m.file, "utf8"), "[[[");
});

test("onboard with no clones says so and writes nothing", async () => {
  const m = machine();
  const answer = await step.run({}, { ...m.deps, clones: {} });
  assert.deepEqual(answer, { ok: true, detail: "the host file names no repositories, so Codex has none to trust" });
});

test("with no CODEX_HOME, onboard writes under the home it is given", async () => {
  const m = machine();
  const answer = await step.run({}, { ...m.deps, env: {} });
  assert.equal(answer.ok, true);
  assert.deepEqual(Object.keys(parse(readFileSync(join(m.root, "home", ".codex", "config.toml"), "utf8")).projects as object).length, 3);
});
