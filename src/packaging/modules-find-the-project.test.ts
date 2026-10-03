// no-token: gh
//
// Nothing here reaches the network or a real `gh`: the project each child reads is a scratch directory this file builds and deletes (its `.agent-org/` is a copy of the ambient project's).

/**
 * #3074: THE THREE MODULES THAT ONCE COUNTED DIRECTORIES UP FROM `src` FIND THE PROJECT THROUGH `HOME_CHECKOUT`.
 *
 * `lib/product-home.mjs`, `lib/walk-scope.mjs` and `ready-label-audit.mjs` each reached a project file (the product's manifest, the tree a
 * declared scope is relative to, `docs/row-filing.md`) by `src` up three or four, which is `packages/agent-org/src`'s root in the monorepo and
 * the HOME directory in this repository. A test that reads the project the host file names cannot tell the two apart when the tool also sits
 * in that project, so each child here runs against a SCRATCH project, one whose files are the only ones carrying the marker below: a module
 * that resolved anything else would fail naming the file it read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME_CHECKOUT } from "../project-config.mjs";
import { hostConfigPath } from "../host-config.mjs";

const MARKER = "https://scratch-project.example/marker";
const HERE = dirname(fileURLToPath(import.meta.url));

/** The tool's own `src`, which these tests live one level inside. */
const SRC = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

const scratchDirs: string[] = [];
test.after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** A project checkout carrying a copy of `.agent-org/` and the three files the modules read, each saying the marker; and the host file naming it. */
function scratchProject(): { checkout: string; hostFile: string } {
  const root = mkdtempSync(join(tmpdir(), "modules-find-the-project-"));
  scratchDirs.push(root);
  const checkout = join(root, "project");
  for (const dir of ["docs", "packages/cli"]) mkdirSync(join(checkout, dir), { recursive: true });
  // The ambient project's whole `.agent-org/` (declaration, role briefs, plugins): the modules read all of it at import, and a hand-built one drifts from the schema.
  cpSync(join(HOME_CHECKOUT, ".agent-org"), join(checkout, ".agent-org"), { recursive: true });
  writeFileSync(join(checkout, "packages/cli/package.json"), JSON.stringify({ homepage: MARKER }));
  writeFileSync(join(checkout, "docs/row-filing.md"), `${MARKER}\n`);
  // The project's plugins name the tool where the monorepo kept it (`packages/agent-org`), so the scratch project has it there too.
  symlinkSync(dirname(SRC), join(checkout, "packages/agent-org"));
  const hostFile = join(root, "host.json");
  // The ambient host file with the primary project moved to the scratch checkout: the modules read the rest of it (the home, the units) at import.
  const ambient = JSON.parse(readFileSync(hostConfigPath(), "utf8"));
  const projects = ambient.projects.map((project: { id: string }) => (project.id === ambient.primary ? { ...project, checkout } : project));
  writeFileSync(hostFile, JSON.stringify({ ...ambient, projects }));
  return { checkout, hostFile };
}

/** Runs `expression` (which may await an import of the module) in a child whose project is `hostFile`'s, and returns what it printed as JSON. */
function inChild(hostFile: string, expression: string): unknown {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `console.log(JSON.stringify(await (${expression})))`],
    { cwd: HERE, encoding: "utf8", env: { ...process.env, AGENT_ORG_HOST: hostFile } });
  assert.equal(result.status, 0, `the child died:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("product-home reads the PROJECT's manifest: the scratch project's homepage, not the file at some depth above the tool", () => {
  const { hostFile } = scratchProject();
  assert.equal(inChild(hostFile, `import(${JSON.stringify(`${SRC}/lib/product-home.mjs`)}).then((m) => m.productHome())`), MARKER);
});

test("walk-scope's REPO_ROOT is the PROJECT's checkout, the tree every declared scope is relative to", () => {
  const { checkout, hostFile } = scratchProject();
  assert.equal(inChild(hostFile, `import(${JSON.stringify(`${SRC}/lib/walk-scope.mjs`)}).then((m) => m.REPO_ROOT)`), realpathSync(checkout));
});

test("ready-label-audit reads the PROJECT's docs/row-filing.md, the guidance a filer reads", () => {
  const { hostFile } = scratchProject();
  assert.equal(inChild(hostFile, `import(${JSON.stringify(`${SRC}/ready-label-audit.mjs`)}).then((m) => m.readRowFilingDoc())`), `${MARKER}\n`);
});

test("POSITIVE CONTROL: a project that lacks the file makes the module FAIL naming it, so the three readings above are the project's and not a default", () => {
  const { checkout, hostFile } = scratchProject();
  rmSync(join(checkout, "packages/cli/package.json"));
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `(await import(${JSON.stringify(`${SRC}/lib/product-home.mjs`)})).productHome()`],
  { cwd: HERE, encoding: "utf8", env: { ...process.env, AGENT_ORG_HOST: hostFile } });
  assert.notEqual(result.status, 0, "productHome answered with the project's manifest gone");
  assert.ok(result.stderr.includes(join(checkout, "packages/cli/package.json")), `the missing file is not named:\n${result.stderr}`);
});
