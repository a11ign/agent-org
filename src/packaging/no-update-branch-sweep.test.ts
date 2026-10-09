// @ts-check
// #3047: THE UPDATE-BRANCH SWEEP IS GONE, AND NOTHING MAY IMPORT OR NAME IT. The merge queue builds every PR on
// `main` itself, so a job that pushed `main` into armed PRs only manufactured heads (a11ign#3046 has the
// measurement). Deleting the script left comments, an import and a test exemption naming it; this keeps the next
// reader from being sent to a file that does not exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxGitEnv } from "../lib/git-env.ts";

const AGENT_ORG_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT_NAME = "update-branch-sweep";
/** This file must name the script to look for it, so it is excluded in CODE, with the reason, not by a list entry. */
const SELF = relative(AGENT_ORG_ROOT, fileURLToPath(import.meta.url));
const SCANNED = /^(src|host)\//;

/** Every file under `root` that git knows -- tracked, or untracked-and-not-ignored, so a CI checkout copied in is still seen. */
function sourceFilesOf(root: string): string[] {
  const listed = (args: string[]) => execFileSync("git", ["ls-files", "-z", ...args], { cwd: root, encoding: "utf8", env: sandboxGitEnv() })
    .split("\0").filter(Boolean);
  return [...new Set([...listed([]), ...listed(["--others", "--exclude-standard"])])]
    .filter((file) => SCANNED.test(file) && existsSync(join(root, file)));
}

/** The files among `files` (relative to `root`) whose text names the sweep, minus `exclude`. */
function namingTheSweep(root: string, files: string[], exclude: string[] = []): string[] {
  return files.filter((file) => !exclude.includes(file) && readFileSync(join(root, file), "utf8").includes(SCRIPT_NAME));
}

test("#3047: no file under src/ or host/ imports or names the update-branch sweep, and the script is gone", () => {
  const files = sourceFilesOf(AGENT_ORG_ROOT);
  assert.ok(files.includes(SELF), "the population must contain this very file, or the walk found nothing");
  assert.ok(files.length > 100, `the walk found ${files.length} files; a scan over a handful is not a scan of the tree`);
  assert.deepEqual(namingTheSweep(AGENT_ORG_ROOT, files, [SELF]), [], "these files still name the deleted sweep");
  for (const gone of ["src/update-branch-sweep.mjs", "src/packaging/update-branch-sweep.test.ts",
    "src/packaging/update-branch-decision.test.ts"]) {
    assert.equal(existsSync(join(AGENT_ORG_ROOT, gone)), false, `${gone} must not exist`);
  }
});

test("#3047 POSITIVE CONTROL: the same scan over a directory holding one file that names the sweep returns exactly that file", () => {
  const fixture = mkdtempSync(join(tmpdir(), "no-sweep-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: fixture, env: sandboxGitEnv() });
    for (const dir of ["src", "host"]) execFileSync("mkdir", ["-p", join(fixture, dir)]);
    writeFileSync(join(fixture, "src", "innocent.mjs"), "export const fine = true;\n");
    writeFileSync(join(fixture, "host", "innocent.sh"), "echo fine\n");
    writeFileSync(join(fixture, "src", "offender.mjs"), `import { x } from "./${SCRIPT_NAME}.mjs";\n`);
    const files = sourceFilesOf(fixture);
    assert.deepEqual([...files].sort(), ["host/innocent.sh", "src/innocent.mjs", "src/offender.mjs"]);
    assert.deepEqual(namingTheSweep(fixture, files), ["src/offender.mjs"]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
