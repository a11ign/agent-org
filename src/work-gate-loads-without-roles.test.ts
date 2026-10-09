// no-token: none -- copies the gate's import closure into a throwaway tree and imports it in a child process; nothing here reaches `gh`, `herdr` or `git`
/**
 * #3675: THE WORK GATE REQUIRES THE PROJECT'S ROSTER, AND SAYS SO WHEN IT IS ABSENT.
 *
 * #2174 once wanted the gate to load with no `.agent-org/roles`. It no longer can, and the ruling on #3675 is that it need not: `work-gate.ts` reaches
 * `arm-pr.ts` through `auto-arm-sweep.ts` and `work-gate/org-health.ts`, and `arm-pr.ts` reads `sessions.json` at import. `project-roles.ts` refuses a missing
 * roles directory on purpose (#2621: nothing is defaulted to another project's value). What matters is that the refusal is the NAMED one, so this pins the
 * outcome rather than leaving it to three comments.
 *
 * The tree is built as `packaging/work-gate.test.ts` builds its own (`copyToolAndProject`: the gate's import closure, the project's declaration and the plugin it names).
 * Direction one leaves the roles directory out and expects the `roles.dir` refusal; direction two is the SAME copy plus the smallest `sessions.json` `arm-pr.ts` accepts and
 * expects a clean load, which is the control for the first: a copy that failed for any other reason would fail here too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { copyToolAndProject, importClosure, toolFile } from "./packaging/copied-tool-fixture.ts";

/** Imports the gate from a fresh copy of the tool, with the roles directory written only when `roster` is given. */
function loadGate({ roster }: { roster?: object }) {
  const entry = toolFile("src/work-gate.ts");
  const closure = importClosure(entry);
  assert.ok(closure.size > 10 && closure.has(toolFile("src/waiting-condition.ts")),
    `the control: the closure must really be the gate's, got ${closure.size} file(s)`);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-org-roles-")));
  try {
    const copy = copyToolAndProject(entry, closure, root);
    assert.ok(existsSync(join(root, ".agent-org/project.json")) && !existsSync(join(root, ".agent-org/roles")),
      "the premise: a declaration, and no roles directory yet");
    if (roster !== undefined) {
      mkdirSync(join(root, ".agent-org/roles"), { recursive: true });
      writeFileSync(join(root, ".agent-org/roles/sessions.json"), JSON.stringify(roster));
    }
    const run = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import(${JSON.stringify(pathToFileURL(copy.entry).href)}).then(m => { if (typeof m.decide !== 'function') throw new Error('decide missing'); })`],
    { encoding: "utf8", cwd: root, env: { ...process.env, ...copy.env } });
    return { status: run.status, stderr: run.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("#3675: work-gate.ts with NO .agent-org/roles refuses, naming roles.dir", () => {
  const { status, stderr } = loadGate({});
  assert.notEqual(status, 0, "the gate loaded with no roster; the requirement this file pins is gone");
  assert.match(stderr, /field `roles\.dir` REFUSED/, `it must fail with the named refusal and not for another reason: ${stderr}`);
});

test("#3675 CONTROL: the same copy with a roster loads", () => {
  const { status, stderr } = loadGate({ roster: { live: [{ name: "ceo" }], retired: [] } });
  assert.equal(status, 0, `the gate must load once the roster exists: ${stderr}`);
});
