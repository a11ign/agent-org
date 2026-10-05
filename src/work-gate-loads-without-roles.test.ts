// no-token: none -- copies the gate's import closure into a throwaway tree and imports it in a child process; nothing here reaches `gh`, `herdr` or `git`
/**
 * #3675: THE WORK GATE LOADS IN A TREE WITH NO `.agent-org/roles`.
 *
 * #2174 wrote the gate to load there. When `org-health.mjs` began importing `arm-pr.mjs` (v0.30.5), which reads `.agent-org/roles/sessions.json`
 * at import, nothing went red: the constraint lived in three comments and no assertion, and `packaging/work-gate.test.ts`'s copied tree carries
 * the whole `.agent-org/`, roles included.
 *
 * The tree here is built the way that test builds it (`copyToolAndProject`: the gate's import closure, the project's declaration and the plugin it
 * names) and the roles directory is simply not copied. THE POSITIVE CONTROL is that same copy WITH the roster, which `work-gate.test.ts`'s
 * "#2174: work-gate.mjs loads in a tree with NO node_modules" is: the one directory is the only difference between a load that passes there and
 * one that is asserted here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { copyToolAndProject, importClosure, toolFile } from "./packaging/copied-tool-fixture.ts";

test("#3675: work-gate.mjs loads in a tree with NO .agent-org/roles", () => {
  const entry = toolFile("src/work-gate.mjs");
  const closure = importClosure(entry);
  assert.ok(closure.size > 10 && closure.has(toolFile("src/waiting-condition.mjs")),
    `the control: the closure must really be the gate's, got ${closure.size} file(s)`);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-org-no-roles-")));
  try {
    const copy = copyToolAndProject(entry, closure, root);
    assert.ok(existsSync(join(root, ".agent-org/project.json")) && !existsSync(join(root, ".agent-org/roles")),
      "the premise: a declaration, and no roles directory");
    const run = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import(${JSON.stringify(pathToFileURL(copy.entry).href)}).then(m => { if (typeof m.decide !== 'function') throw new Error('decide missing'); })`],
    { encoding: "utf8", cwd: root, env: { ...process.env, ...copy.env } });
    assert.equal(run.status, 0, `the gate must load with no roles directory: ${run.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
