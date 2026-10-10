/**
 * #4505 PHASE 0 (agent-org#485): `docs/gh-call-inventory.json` is what `gh-call-inventory.ts` prints, and this file is what makes it hold.
 *
 * THE COMPLETENESS CHECK READS THE TREE A SECOND WAY. The generator walks the AST; `filesSpawningGh` below is a comment-stripped text match for "a call
 * whose first argument is the literal command, with more arguments after it", which shares no code with it. A file one finds and the other does not is a disagreement this test
 * reports, rather than a generator that can only ever agree with itself.
 *
 * THE FIXTURE TREES NAME THE COMMAND THROUGH `COMMAND`, never as a literal call in this file's own source: `acceptance-commands.ts` reads a spawn of
 * the quoted name as "this test needs a token", and nothing here spawns anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripComments } from "@a11ign/toolchain/lib/local-import-closure";
import { TOOL_REPO_ENV } from "../lib/pin-ratchet.ts";
import { buildInventory, judgedRoot, render, sourceFiles, INVENTORY_PATH, REPO_ROOT, type Inventory } from "./gh-call-inventory.ts";

const COMMAND = "gh";

/** The independent reader: every non-test source file with a call whose FIRST argument is the quoted command, comments stripped. */
const CALL_NAMING_COMMAND = new RegExp(`\\b\\w+\\(\\s*(['"\`])${COMMAND}\\1\\s*,`);
function filesSpawningGh(root: string): string[] {
  return sourceFiles(root).filter((file) => CALL_NAMING_COMMAND.test(stripComments(readFileSync(join(root, file), "utf8"))));
}

/** Files the independent reader finds that `inventory` does not list. */
function missingFromInventory(root: string, inventory: Inventory): string[] {
  return filesSpawningGh(root).filter((file) => !Object.hasOwn(inventory.files, file));
}

const spawn = (callee: string, args: string[]): string =>
  `${callee}("${COMMAND}", [${args.map((arg) => JSON.stringify(arg)).join(", ")}]);\n`;

/** A throwaway tree, `files` keyed by path under it, removed by the caller through the returned `done`. */
function tree(files: Record<string, string>): { root: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "gh-call-inventory-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("the committed inventory equals the regenerated one", () => {
  const root = judgedRoot();
  const committed = readFileSync(join(root, INVENTORY_PATH), "utf8");
  assert.equal(committed, render(buildInventory(root)),
    `${INVENTORY_PATH} is stale: run \`node --import tsx src/packaging/gh-call-inventory.ts\` and commit the result`);
});

test("every non-test file that spawns the command is listed, and the reading is not vacuous", () => {
  const root = judgedRoot();
  const inventory = buildInventory(root);
  const found = filesSpawningGh(root);
  assert.ok(found.length > 20, `the independent reader found ${found.length} files: a reader that finds none proves nothing`);
  assert.deepEqual(missingFromInventory(root, inventory), []);
  // The other direction, so the inventory cannot quietly grow files the independent reader would not call spawners: a file that is listed with
  // spawn sites must be one it found too. (Shape-only files, `spawns: 0`, call through an injected runner and are not in this population.)
  const spawners = Object.entries(inventory.files).filter(([, entry]) => entry.spawns > 0).map(([file]) => file);
  assert.deepEqual(spawners.filter((file) => !found.includes(file)), []);
});

test("negative control: a fixture tree with one extra file that spawns the command makes the check report that file as missing", () => {
  const base = { "src/a.ts": spawn("execFileSync", ["issue", "list"]), "src/b.ts": "export const none = 1;\n" };
  const without = tree(base);
  const withExtra = tree({ ...base, "src/extra.ts": spawn("spawnSync", ["pr", "view"]) });
  try {
    const inventory = buildInventory(without.root);
    assert.deepEqual(Object.keys(inventory.files), ["src/a.ts"], "the base tree lists its one spawner");
    assert.deepEqual(missingFromInventory(without.root, inventory), [], "positive control: the base tree is complete against itself");
    assert.deepEqual(missingFromInventory(withExtra.root, inventory), ["src/extra.ts"]);
    assert.deepEqual(missingFromInventory(withExtra.root, buildInventory(withExtra.root)), [], "and regenerating lists it again");
  } finally {
    without.done();
    withExtra.done();
  }
});

test("test files are not listed, and neither are fixtures", () => {
  const { root, done } = tree({
    "src/real.ts": spawn("execFileSync", ["issue", "view"]),
    "src/real.test.ts": spawn("execFileSync", ["issue", "view"]),
    "src/real.test.mjs": spawn("execFileSync", ["issue", "view"]),
    "src/packaging/fixtures/host-units/scripts/release.ts": spawn("execFileSync", ["release", "create"]),
  });
  try {
    assert.deepEqual(Object.keys(buildInventory(root).files), ["src/real.ts"]);
    assert.deepEqual(sourceFiles(root), ["src/real.ts"]);
  } finally {
    done();
  }
  const listed = Object.keys(buildInventory(judgedRoot()).files);
  assert.deepEqual(listed.filter((file) => /\.test\.(?:ts|mjs)$/.test(file) || file.includes("/fixtures/")), []);
});

test("what a file's entry says: shapes, spawns, labels and a Closes parse; a command in a comment or a string is not a spawn", () => {
  const { root, done } = tree({
    "src/wrapper.ts": [
      `import { execFileSync } from "node:child_process";`,
      `const READY_LABEL = "ready";`,
      `const run = (args: string[]) => execFileSync("${COMMAND}", args, { encoding: "utf8" });`,
      `run(["issue", "list", "--label", READY_LABEL]);`,
      `run(["issue", "list", "--add-label=in-progress"]);`,
      `run(["api", "graphql", "-f", "query=x"]);`,
      `run(["api", "repos/o/r/issues/1"]);`,
      `run(["run", "corpus:release"]);`,
      `const closes = /^Closes #(\\d+)$/m;`,
      "",
    ].join("\n"),
    "src/prose.ts": [
      `// ${COMMAND} is spawned by execFileSync("${COMMAND}", ["issue", "list"]) elsewhere`,
      `export const text = 'execFileSync("${COMMAND}", ["issue", "list"])';`,
      "",
    ].join("\n"),
  });
  try {
    const inventory = buildInventory(root);
    assert.deepEqual(Object.keys(inventory.files), ["src/wrapper.ts"]);
    assert.deepEqual(inventory.files["src/wrapper.ts"], {
      spawns: 1,
      calls: { "api graphql": 1, "api rest": 1, "issue list": 2 },
      labels: ["$READY_LABEL", "in-progress"],
      parsesCloses: true,
    }, "`[\"run\", \"corpus:release\"]` is `pnpm run`, not a shape, and a file that only mentions the command is not listed");
    assert.deepEqual(inventory.summary.shapes, { "issue list": 2, "api graphql": 1, "api rest": 1 });
  } finally {
    done();
  }
});

test("a file a layout overlays beside the tool is not in the inventory: the judged tree is the checkout the gate names, not the copy it walks", () => {
  // The gate's laid-out copy is the checkout's `src/` plus the project's helpers rsynced into `src/packaging/` (one of which spawns `gh`).
  const own = { "src/a.ts": spawn("execFileSync", ["issue", "list"]), "src/lib/b.ts": spawn("spawnSync", ["pr", "view"]) };
  const checkout = tree(own);
  const laidOut = tree({ ...own, "src/packaging/zz-overlay.mjs": spawn("execFileSync", ["release", "download"]) });
  try {
    const env = { [TOOL_REPO_ENV]: checkout.root };
    assert.equal(judgedRoot(env), checkout.root);
    const committed = render(buildInventory(checkout.root));
    // Judged through the variable, the laid-out copy reads as the checkout does, byte for byte, and says nothing of the helper...
    assert.equal(render(buildInventory(judgedRoot(env))), committed);
    assert.deepEqual(Object.keys(JSON.parse(committed).files), ["src/a.ts", "src/lib/b.ts"], "positive control: the files the scan SHOULD count still are");
    // ...and a walk of the copy, which is what the committed file would have been checked against, does differ: the overlay is real and the variable is what removes it.
    assert.notEqual(render(buildInventory(laidOut.root)), committed);
    assert.deepEqual(Object.keys(buildInventory(laidOut.root).files), ["src/a.ts", "src/lib/b.ts", "src/packaging/zz-overlay.mjs"]);
    // Not set, or set to nothing: the tree the generator sits in, as in a checkout.
    assert.equal(judgedRoot({}), REPO_ROOT);
    assert.equal(judgedRoot({ [TOOL_REPO_ENV]: "" }), REPO_ROOT);
  } finally {
    checkout.done();
    laidOut.done();
  }
});

test("a cause is looked up through the files that name it", () => {
  const { root, done } = tree({
    "src/cause-declaration.ts": [
      `export const DECLARED = [`,
      `  declareCause("pr-green-unarmed", GROUPS.ACTION, { kind: "claude", model: "sonnet", effort: "low", why: "x" }),`,
      `  declareCause("never-emitted", GROUPS.JUDGMENT, { kind: "claude", model: "sonnet", effort: "low", why: "x" }),`,
      `];`,
      "",
    ].join("\n"),
    "src/arm.ts": `${spawn("execFileSync", ["pr", "merge"])}export const cause = "pr-green-unarmed";\n`,
  });
  try {
    assert.deepEqual(buildInventory(root).causes, {
      "pr-green-unarmed": { group: "ACTION", namedIn: ["src/arm.ts"] },
      "never-emitted": { group: "JUDGMENT", namedIn: [] },
    });
  } finally {
    done();
  }
  const real = buildInventory(judgedRoot()).causes;
  assert.ok(Object.keys(real).length >= 30, `src/cause-declaration.ts declares ${Object.keys(real).length} causes; the header counts 30`);
});
