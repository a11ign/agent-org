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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sandboxGitEnv } from "@a11ign/toolchain/lib/git-env";
import { stripComments } from "../lib/local-import-closure.ts";
import { TOOL_REPO_ENV } from "../lib/pin-ratchet.ts";
import { buildInventory, judgedRoot, render, shellFiles, sourceFiles, INVENTORY_PATH, REPO_ROOT, type Inventory } from "./gh-call-inventory.ts";

const COMMAND = "gh";

/** The independent reader: every non-test source file with a call whose FIRST argument is the quoted command, comments stripped. */
const CALL_NAMING_COMMAND = new RegExp(`\\b(?!HostConfigRefusal\\b)\\w+\\(\\s*(['"\`])${COMMAND}\\1\\s*,`);
function filesSpawningGh(root: string): string[] {
  return sourceFiles(root).filter((file) => CALL_NAMING_COMMAND.test(stripComments(readFileSync(join(root, file), "utf8"))));
}

/** Files the independent reader finds that `inventory` does not list. */
function missingFromInventory(root: string, inventory: Inventory): string[] {
  return filesSpawningGh(root).filter((file) => !Object.hasOwn(inventory.files, file));
}

const spawn = (callee: string, args: string[]): string =>
  `${callee}("${COMMAND}", [${args.map((arg) => JSON.stringify(arg)).join(", ")}]);\n`;

const REMOVE_ATTEMPTS = 5;
const REMOVE_RETRIES = 3;
const REMOVE_PAUSE_MS = 50;

/** A throwaway tree, `files` keyed by path under it, removed by the caller through the returned `done`. */
function tree(files: Record<string, string>): { root: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "gh-call-inventory-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, done: () => removeTree(root) };
}

/**
 * Removes `root` and says so if it is still there. `rmSync` with `force` can leave a directory behind without throwing when something writes into it while it is
 * being removed, and the suite's private-tmp teardown then reports the leak on a passing run (agent-org#1037's first CI). A few attempts, then an assertion.
 */
function removeTree(root: string): void {
  for (let attempt = 0; attempt < REMOVE_ATTEMPTS && existsSync(root); attempt += 1) {
    rmSync(root, { recursive: true, force: true, maxRetries: REMOVE_RETRIES, retryDelay: REMOVE_PAUSE_MS });
    if (existsSync(root)) Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, REMOVE_PAUSE_MS);
  }
  assert.equal(existsSync(root), false, `${root} could not be removed`);
}

test("the inventory is generated and never committed: its path is ignored, no tracked file holds it, and two scans of one tree are byte-identical", () => {
  const root = judgedRoot();
  const ignored = readFileSync(join(root, ".gitignore"), "utf8").split("\n").map((line) => line.trim());
  assert.ok(ignored.includes(INVENTORY_PATH), `.gitignore must list ${INVENTORY_PATH}: a committed copy is rewritten by every pull request that adds a call, and they conflict (a11ign/a11ign#5126)`);
  if (existsSync(join(root, ".git"))) {
    const tracked = execFileSync("git", ["ls-files", "--", INVENTORY_PATH], { cwd: root, encoding: "utf8", env: sandboxGitEnv() });
    assert.equal(tracked.trim(), "", `${INVENTORY_PATH} is tracked: \`git rm --cached\` it; run \`node --import tsx src/packaging/gh-call-inventory.ts\` to read it on demand`);
  }
  const first = render(buildInventory(root));
  assert.equal(first, render(buildInventory(root)));
  assert.equal(JSON.parse(first).generatedBy, "src/packaging/gh-call-inventory.ts");
});

/**
 * Runs `git` in a throwaway repository, with an identity and no signing, and returns whether it exited 0. Background maintenance is off: git starts a DETACHED
 * `maintenance run --auto` after a commit, a process that can still be writing into the repository when the test removes it.
 */
function gitSucceeds(cwd: string, ...args: string[]): boolean {
  try {
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], { cwd, stdio: "ignore", env: sandboxGitEnv() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Two branches off one base each ADD a call in a file of their own, and are merged into `main` in each order. `committed` is the arrangement this file
 * replaced: the inventory is a tracked file, regenerated on each branch the way the old test told a pull request to. Returns whether each order merged clean.
 */
function mergesInBothOrders({ committed }: { committed: boolean }): { aThenB: boolean; bThenA: boolean } {
  const { root, done } = tree({
    ".gitignore": committed ? "" : `${INVENTORY_PATH}\n`,
    "src/base.ts": spawn("execFileSync", ["issue", "list"]),
  });
  try {
    const regenerate = (): void => {
      if (committed) {
        mkdirSync(join(root, "docs"), { recursive: true });
        writeFileSync(join(root, INVENTORY_PATH), render(buildInventory(root)));
      }
    };
    gitSucceeds(root, "init", "-q", "-b", "main");
    regenerate();
    gitSucceeds(root, "add", "-A");
    assert.ok(gitSucceeds(root, "commit", "-q", "-m", "base"), "the base commits");
    const branch = (name: string, file: string, args: string[]): void => {
      assert.ok(gitSucceeds(root, "checkout", "-q", "-b", name, "main"));
      writeFileSync(join(root, file), spawn("spawnSync", args));
      regenerate();
      gitSucceeds(root, "add", "-A");
      assert.ok(gitSucceeds(root, "commit", "-q", "-m", name), `${name} commits`);
    };
    branch("a", "src/a.ts", ["pr", "view"]);
    branch("b", "src/b.ts", ["run", "list"]);
    const merge = (first: string, second: string): boolean => {
      assert.ok(gitSucceeds(root, "checkout", "-q", "-B", `${first}-then-${second}`, "main"));
      const clean = gitSucceeds(root, "merge", "--no-edit", first) && gitSucceeds(root, "merge", "--no-edit", second);
      if (!clean) gitSucceeds(root, "merge", "--abort");
      return clean;
    };
    return { aThenB: merge("a", "b"), bThenA: merge("b", "a") };
  } finally {
    done();
  }
}

test("two pull requests that each add a gh call merge in either order with no conflict (a11ign/a11ign#5126)", () => {
  assert.deepEqual(mergesInBothOrders({ committed: false }), { aThenB: true, bThenA: true });
});

test("negative control: the same two branches conflict when the inventory is a committed file, so the experiment above can fail", () => {
  const outcome = mergesInBothOrders({ committed: true });
  assert.equal(outcome.aThenB, false, "the committed file conflicts when merged a then b");
  assert.equal(outcome.bThenA, false, "and when merged b then a");
});

test("every non-test file that spawns the command is listed, and the reading is not vacuous", () => {
  const root = judgedRoot();
  const inventory = buildInventory(root);
  const found = filesSpawningGh(root);
  assert.ok(found.length >= 3, `the independent reader found ${found.length} files: a reader that finds none proves nothing (since step 9 of A11-160 the files that spawn the command are the GitHub plugin's)`);
  assert.deepEqual(missingFromInventory(root, inventory), []);
  // The other direction, so the inventory cannot quietly grow files the independent reader would not call spawners: a file that is listed with
  // spawn sites must be one it found too. (Shape-only files, `spawns: 0`, call through an injected runner and are not in this population.)
  const shell = new Set(shellFiles(root));
  const spawners = Object.entries(inventory.files).filter(([file, entry]) => entry.spawns > 0 && !shell.has(file)).map(([file]) => file);
  assert.deepEqual(spawners.filter((file) => !found.includes(file)), []);
});

/** The independent reader of shell: a script whose comment-stripped text has `gh` where a command goes, which shares no code with the scan's word splitter. */
const COMMAND_POSITION = new RegExp(`(?:^|[;&|(\`]|\\$\\()\\s*(?:[A-Za-z_]\\w*=\\S*\\s+)*(?:\\S*/)?${COMMAND}(?=\\s)`, "m");
const shellScriptsRunningGh = (root: string): string[] => shellFiles(root).filter((file) => COMMAND_POSITION.test(readFileSync(join(root, file), "utf8").replace(/^\s*#.*$/gm, "")));

test("every shell script that runs the command is listed, and the reading of shell is not vacuous", () => {
  const root = judgedRoot();
  const inventory = buildInventory(root);
  const found = shellScriptsRunningGh(root);
  assert.ok(shellFiles(root).length >= 5, `the scan found ${shellFiles(root).length} shell scripts: a scan that finds none proves nothing`);
  assert.ok(found.length >= 3, `the independent reader found ${found.length} scripts that run the command: a reader that finds none proves nothing`);
  assert.deepEqual(found.filter((file) => !Object.hasOwn(inventory.files, file)), [], "a script the independent reader sees run the command, and the inventory does not list");
  assert.deepEqual(Object.keys(inventory.files).filter((file) => shellFiles(root).includes(file) && !found.includes(file)), [], "and the other way: a listed script the independent reader does not see run it");
});

test("shell scripts are read by their command words: a comment, a path, a different binary and a quoted word are not a spawn, and a command substitution is", () => {
  const { root, done } = tree({
    "host/runs.sh": `#!/bin/sh\n${COMMAND} issue list\nRUN="$(${COMMAND} run list)"\n/usr/bin/${COMMAND} pr view 1\n`,
    "host/mentions.sh": `#!/bin/sh\n# ${COMMAND} issue list\nB="agent/${COMMAND}-wrapper"\n${COMMAND}-real auth status\necho "${COMMAND}"\ncat docs/${COMMAND}-notes.md\n`,
    "host/no-extension": `#!/usr/bin/env bash\n${COMMAND} pr list\n`,
    "host/not-a-script.in": `${COMMAND} pr list\n`,
    "src/packaging/fixtures/x/fixture.sh": `#!/bin/sh\n${COMMAND} pr list\n`,
  });
  try {
    assert.deepEqual(shellFiles(root), ["host/mentions.sh", "host/no-extension", "host/runs.sh"], "scripts by extension or shebang; a template and a fixture are not read");
    const inventory = buildInventory(root);
    assert.deepEqual(Object.keys(inventory.files).sort(), ["host/no-extension", "host/runs.sh"]);
    assert.equal(inventory.files["host/runs.sh"]!.spawns, 3, "a plain command, a command substitution and a path to the binary");
    assert.equal(inventory.files["host/no-extension"]!.spawns, 1);
  } finally {
    done();
  }
});

test("the scan reads src/, scripts/ and plugins/, and a missing directory is not an error", () => {
  const { root, done } = tree({ "src/a.ts": spawn("execFileSync", ["issue", "list"]), "scripts/b.ts": spawn("execFileSync", ["pr", "view"]), "plugins/p/c.ts": spawn("spawnSync", ["run", "list"]), "docs/d.ts": spawn("spawnSync", ["pr", "list"]) });
  try {
    assert.deepEqual(sourceFiles(root), ["plugins/p/c.ts", "scripts/b.ts", "src/a.ts"]);
  } finally {
    done();
  }
  const bare = tree({ "src/a.ts": "export const x = 1;\n" });
  try {
    assert.deepEqual(sourceFiles(bare.root), ["src/a.ts"], "a tree with no scripts/ or plugins/ is read");
  } finally {
    bare.done();
  }
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
