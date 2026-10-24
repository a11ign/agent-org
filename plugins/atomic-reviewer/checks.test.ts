// no-token: none -- a temporary CODEX_HOME and temporary clones; nothing reads the real ~/.codex
//
// DOCTOR'S `codex trust` ROW (A11-221): it lists every host-file repository Codex does not trust, with the fix, and only reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../../src/lib/tmp-fixture.ts";
import { trustChecks } from "./checks.ts";

/** Two clones the host file names, and the config Codex holds. */
function machine(config: ((clones: { alpha: string; beta: string }) => string) | null) {
  const root = tmpDir("codex-trust-doctor-");
  const clones = { alpha: join(root, "repos", "alpha"), beta: join(root, "repos", "beta") };
  for (const clone of Object.values(clones)) mkdirSync(clone, { recursive: true });
  const file = join(root, "codex", "config.toml");
  if (config !== null) { mkdirSync(join(root, "codex")); writeFileSync(file, config(clones)); }
  return { clones, file, deps: { env: { CODEX_HOME: join(root, "codex") }, clones } };
}

const trusted = (path: string) => `[projects."${path}"]\ntrust_level = "trusted"\n`;

test("doctor flags a missing entry: with two clones, one trusted and one absent, the codex trust row fails, names the absent root and gives the fix", () => {
  const m = machine((clones) => trusted(clones.alpha));
  const [row] = trustChecks(m.deps);
  assert.deepEqual([row.name, row.ok], ["codex trust", false]);
  assert.equal(row.detail, `Codex does not trust ${m.clones.beta} (no entry): a review there stops on its "Trust this folder?" dialog`);
  assert.equal(row.fix, `run \`agent-org onboard\` again, or add \`[projects."${m.clones.beta}"]\` with \`trust_level = "trusted"\` to ${m.file}`);
  assert.equal(row.detail.includes(m.clones.alpha), false, "the trusted clone is not named");
  assert.equal(row.fix?.includes(m.clones.alpha), false, "nor in the fix");
});

test("doctor passes when every host repository is trusted", () => {
  const m = machine((clones) => trusted(clones.alpha) + trusted(clones.beta));
  const [row] = trustChecks(m.deps);
  assert.deepEqual([row.name, row.ok, row.fix], ["codex trust", true, null]);
});

test("doctor names every untrusted repository, an absent config counting as all of them, and an entry that says untrusted gets the fix for a person's entry", () => {
  const none = machine(null);
  const [all] = trustChecks(none.deps);
  assert.equal(all.ok, false);
  assert.ok(all.detail.includes(`${none.clones.alpha} (no entry), ${none.clones.beta} (no entry)`), all.detail);
  assert.equal(all.fix, `run \`agent-org onboard\` again, or add \`[projects."${none.clones.alpha}"]\` and \`[projects."${none.clones.beta}"]\` with \`trust_level = "trusted"\` to ${none.file}`);
  const set = machine((clones) => `[projects."${clones.alpha}"]\ntrust_level = "untrusted"\n${trusted(clones.beta)}`);
  const [row] = trustChecks(set.deps);
  assert.equal(row.ok, false);
  assert.ok(row.detail.includes(`${set.clones.alpha} (untrusted)`), row.detail);
  assert.equal(row.fix, `set \`trust_level = "trusted"\` in \`[projects."${set.clones.alpha}"]\` of ${set.file} (it says \`untrusted\`, which agent-org leaves as a person set it)`);
  assert.ok((row.fix ?? "").startsWith(`set \`trust_level = "trusted"\` in \`[projects."${set.clones.alpha}"]\` of ${set.file}`), row.fix ?? "");
});

test("doctor fails, naming the file, when the config cannot be parsed, and leaves it as it was", () => {
  const m = machine(() => "[[[");
  const [row] = trustChecks(m.deps);
  assert.equal(row.ok, false);
  assert.ok(row.detail.includes(m.file) && row.detail.includes("does not parse"), row.detail);
  assert.equal(readFileSync(m.file, "utf8"), "[[[");
});

test("doctor only reads: a config with no entry is as it was after the row", () => {
  const m = machine(() => "model = \"x\"\n");
  trustChecks(m.deps);
  assert.equal(readFileSync(m.file, "utf8"), "model = \"x\"\n");
});
