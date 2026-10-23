// no-token: none -- the installer is run into a temporary directory, and the door is read, never run
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../../src/lib/tmp-fixture.ts";
import { fakePluginDeps } from "../../src/plugins/fakes/deps.ts";
import { create } from "./index.ts";

/** The door as it stood before #3030, 7,227 bytes: the very file the reviewers were running on 2026-10-03 (#3316). */
const PRE_3030 = readFileSync(fileURLToPath(new URL("../../src/packaging/fixtures/reviewer-door/pr-review-verdict.pre-3030.sh", import.meta.url)), "utf8");
const door = () => {
  const shipped = create({}, fakePluginDeps()).verdictDoor;
  assert.ok(shipped !== undefined, "the GitHub plugin ships a verdict door");
  return shipped;
};

test("the plugin ships the verdict door and the program that installs it, as absolute paths of files that are there", () => {
  const { source, installer } = door();
  assert.ok(source.endsWith("plugins/github/reviewer/pr-review-verdict.sh") && installer.endsWith("plugins/github/reviewer/install-reviewer-bin.sh"), `${source} and ${installer}`);
  for (const file of [source, installer]) assert.ok(statSync(file).size > 0, `${file} is a file with content`);
});

test("the positive control IS the incident: the pre-#3030 door is 7,227 bytes and the one the plugin ships is not", () => {
  assert.equal(Buffer.byteLength(PRE_3030), 7227);
  assert.notEqual(PRE_3030, readFileSync(door().source, "utf8"));
});

test("the plugin's installer leaves a byte-identical, executable door at the path it is given, and keeps what it replaced", () => {
  const root = tmpDir("github-verdict-door-");
  const target = join(root, "reviewer", "bin", "pr-review-verdict");
  mkdirSync(join(root, "reviewer", "bin"), { recursive: true });
  writeFileSync(target, PRE_3030);
  const printed = execFileSync("bash", [door().installer, target], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.ok(readFileSync(target).equals(readFileSync(door().source)), "byte-identical to the source");
  assert.ok((statSync(target).mode & 0o111) !== 0, "executable");
  assert.match(printed, /kept the previous door at .*\.bak-/);
});

test("the installer's default destination is the spelling every order prints: $HOME/reviewer/bin/pr-review-verdict", () => {
  const line = readFileSync(door().installer, "utf8").split("\n").find((l) => l.startsWith("dest="));
  assert.match(line ?? "", /\$\{A11Y_REVIEWER_BIN:-\$HOME\/reviewer\/bin\}\/pr-review-verdict\}?"?$/);
});

test("with GH_REPO unset the door run from the plugin's folder in a checkout reads the repository from the tool's project declaration, and refuses without one", () => {
  const run = (env: Record<string, string>) => spawnSync("bash", [door().source, "not-a-number", "convinced", "/nonexistent"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } });
  const declared = run({ AGENT_ORG_HOST: process.env.AGENT_ORG_HOST ?? "" });
  assert.match(declared.stderr, /PR number must be digits, got 'not-a-number'/, "it got past naming the repository, to the next check");
  const none = run({ AGENT_ORG_HOST: join(tmpDir("github-verdict-door-none-"), "host.json") });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /GH_REPO is unset and the project declaration cannot be read/, "POSITIVE CONTROL: a declaration that cannot be read is told");
});
