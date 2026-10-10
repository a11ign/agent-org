/**
 * #3366: `trackedTopLevelDirs()` ASKS ABOUT THE PROJECT, WHICHEVER DIRECTORY THE PROCESS IS IN. It ran `git ls-files` with no `cwd`, and the
 * tick's `WorkingDirectory` is the TOOL's checkout, so a Region path such as `packages/...` was not recognised as a path (`pathInProse`) and
 * the gate's claim/blocked decisions were made on a Region that declared less than it said. The effect on those decisions was not measured.
 *
 *   (1) BEHAVIOUR -- the process is in repository A (the tool) and `HOME_CHECKOUT` stands for repository B (the project): B's top-level
 *       directories come back and none only A has.
 *   (2) THE DEFAULT is the project's `HOME_CHECKOUT`, which is what the tick's call sites rely on (they pass nothing).
 *   (3) CONTROLS -- the answer is per checkout (a second checkout is not served from the first one's cache), and a Region path in B's
 *       directory is recognised from A. The positive control that the census marker notices the remedy is in
 *       `git-reads-name-their-checkout.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withGitSandbox, type GitSandbox } from "@a11ign/toolchain/lib/git-sandbox";
import { HOME_CHECKOUT } from "../project-config.ts";
import { regionPathsFromBody, trackedTopLevelDirs } from "../region-paths.ts";

/** Commit `files` (paths with a directory) into `box`. */
function seed(box: GitSandbox, files: string[]): void {
  for (const file of files) {
    mkdirSync(dirname(join(box.dir, file)), { recursive: true });
    writeFileSync(join(box.dir, file), "x\n");
  }
  box.run(["add", "."]);
  box.commit("seed");
}

/** Run `body` with the process working directory in `dir`, restored after. */
function inDirectory<T>(dir: string, body: () => T): T {
  const before = process.cwd();
  process.chdir(dir);
  try { return body(); } finally { process.chdir(before); }
}

const TOOL_FILES = ["src/a.mjs", "host/b.json", "onlyTool/c.txt"];
const PROJECT_FILES = ["packages/lab/d.ts", "scripts/e.mjs", "onlyProject/f.txt"];

test("#3366 (1) BEHAVIOUR: the process is in the TOOL's repository and `trackedTopLevelDirs` lists the PROJECT's directories", () => {
  withGitSandbox((tool) => withGitSandbox((project) => {
    seed(tool, TOOL_FILES);
    seed(project, PROJECT_FILES);
    const dirs = inDirectory(tool.dir, () => trackedTopLevelDirs({ checkout: project.dir }));
    assert.deepEqual(dirs, ["onlyProject", "packages", "scripts"]);
    assert.deepEqual(dirs.filter((d) => ["src", "host", "onlyTool"].includes(d)), [], "no directory only the tool has");
  }));
});

test("#3366 (3) CONTROL: the answer is per checkout -- asking about the tool afterwards is not served from the project's cache", () => {
  withGitSandbox((tool) => withGitSandbox((project) => {
    seed(tool, TOOL_FILES);
    seed(project, PROJECT_FILES);
    assert.deepEqual(trackedTopLevelDirs({ checkout: project.dir }), ["onlyProject", "packages", "scripts"]);
    assert.deepEqual(trackedTopLevelDirs({ checkout: tool.dir }), ["host", "onlyTool", "src"]);
    assert.equal(trackedTopLevelDirs({ checkout: project.dir }), trackedTopLevelDirs({ checkout: project.dir }), "memoised: the same array twice");
  }));
});

test("#3366 (2) THE DEFAULT is `HOME_CHECKOUT`, from whichever directory the process is in", () => {
  withGitSandbox((elsewhere) => {
    seed(elsewhere, TOOL_FILES);
    const fromElsewhere = inDirectory(elsewhere.dir, () => trackedTopLevelDirs());
    assert.deepEqual(fromElsewhere, trackedTopLevelDirs({ checkout: HOME_CHECKOUT }));
    assert.deepEqual(fromElsewhere.filter((d) => d === "onlyTool"), [], "not the directory the process stood in");
    assert.ok(fromElsewhere.length > 0, "positive control: the project has tracked directories, so the comparison above compared something");
  });
});

test("#3366 (3) CONTROL: a Region path in a directory only the project has is recognised from the tool's directory", () => {
  withGitSandbox((tool) => {
    seed(tool, TOOL_FILES);
    const dir = trackedTopLevelDirs({ checkout: HOME_CHECKOUT })[0];
    assert.ok(dir, "the project has a top-level directory to name");
    const found = inDirectory(tool.dir, () => regionPathsFromBody(`Region: \`${dir}/x.mjs\``));
    assert.deepEqual(found, [`${dir}/x.mjs`]);
  });
});
