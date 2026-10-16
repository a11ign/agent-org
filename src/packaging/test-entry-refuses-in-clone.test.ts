// no-token: none -- runs node on copies of `scripts/test-entry.ts` in temporary directories, with a stub `rstest` first on PATH, and reads package.json and ci.yml; nothing here reaches `gh` or `herdr`
/**
 * (agent-org#1549) `pnpm test` is the entry `scripts/test-entry.ts`, and the entry refuses outside a laid project. The refusal names the command CI runs,
 * read from `.github/workflows/ci.yml` and not retyped here, so a change to CI's command fails this test rather than leaving a stale message.
 *
 * THE CONTROLS RUN THE ENTRY BOTH WAYS. A stub `rstest` that prints its arguments and exits 3 stands in for the suite: the refusal must never reach it,
 * and a laid run must reach it with the same arguments as before and pass its exit status through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = join(TOOL_ROOT, "scripts", "test-entry.ts");
const CI = join(TOOL_ROOT, ".github", "workflows", "ci.yml");
const SUITE_ARGS = "run --config scripts/rstest/rstest.config.ts";
const STUB_EXIT = 3;

/** The laid-out command, copied from the line of `ci.yml` that runs the suite, so the refusal is checked against CI and not against this file's own copy. */
const ciCommand = (readFileSync(CI, "utf8").match(/node_modules\/\.bin\/rstest run --config packages\/agent-org\/scripts\/rstest\/rstest\.config\.ts/) ?? [])[0];

/** Copies the entry to `<root>/scripts/test-entry.ts`, under a `package.json` that makes it an ES module the way this tool's own is. */
function entryAt(root: string): string {
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  copyFileSync(ENTRY, join(root, "scripts", "test-entry.ts"));
  return join(root, "scripts", "test-entry.ts");
}

/** A stub `rstest` on PATH: it prints the arguments it was given and exits with `STUB_EXIT`. */
function stubDir(scratch: string): string {
  const dir = join(scratch, "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rstest"), `#!/bin/sh\necho STUB rstest "$@"\nexit ${STUB_EXIT}\n`);
  chmodSync(join(dir, "rstest"), 0o755);
  return dir;
}

function runEntry(entry: string, scratch: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = { ...process.env, PATH: `${stubDir(scratch)}${delimiter}${process.env.PATH ?? ""}`, ...extra } as Record<string, string>;
  if (!("AGENT_ORG_TOOL_REPO" in extra)) delete env.AGENT_ORG_TOOL_REPO;
  const child = spawnSync(process.execPath, [entry], { env, encoding: "utf8" });
  return { status: child.status, output: `${child.stdout}${child.stderr}` };
}

test("pnpm test is the entry, not the suite's command", () => {
  const pkg = JSON.parse(readFileSync(join(TOOL_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.test, "node scripts/test-entry.ts");
});

test("outside a laid project the entry refuses: non-zero, names CI's command and the narrow form, and never starts the suite", () => {
  assert.ok(ciCommand, "ci.yml no longer carries the laid-out suite command this test reads");
  const scratch = mkdtempSync(join(tmpdir(), "test-entry-clone-"));
  try {
    const entry = entryAt(join(scratch, "clone"));
    const { status, output } = runEntry(entry, scratch);
    assert.notEqual(status, 0, output);
    assert.ok(output.includes(ciCommand), `the refusal must name CI's command, read from ci.yml:\n${output}`);
    assert.ok(output.includes(`AGENT_ORG_HOST=<host.json> pnpm exec rstest ${SUITE_ARGS}`), `the refusal must name the narrow form:\n${output}`);
    assert.ok(!output.includes("STUB"), `the suite must not start from a clone:\n${output}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a laid project by AGENT_ORG_TOOL_REPO starts the suite as before, with the same arguments, and passes its exit status through", () => {
  const scratch = mkdtempSync(join(tmpdir(), "test-entry-env-"));
  try {
    const entry = entryAt(join(scratch, "clone"));
    const { status, output } = runEntry(entry, scratch, { AGENT_ORG_TOOL_REPO: join(scratch, "checkout") });
    assert.equal(status, STUB_EXIT, output);
    assert.ok(output.includes(`STUB rstest ${SUITE_ARGS}`), output);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a tool at packages/agent-org under a project is laid even without AGENT_ORG_TOOL_REPO, and starts the suite", () => {
  const scratch = mkdtempSync(join(tmpdir(), "test-entry-path-"));
  try {
    const entry = entryAt(join(scratch, "project", "packages", "agent-org"));
    const { status, output } = runEntry(entry, scratch);
    assert.equal(status, STUB_EXIT, output);
    assert.ok(output.includes(`STUB rstest ${SUITE_ARGS}`), output);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
