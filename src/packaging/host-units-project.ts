// no-token: none -- copies fixture files into a temp directory and sets one environment variable; nothing here reaches `gh`, `herdr` or `git`
/**
 * (#3233) THE PROJECT `host-units.test.ts` RUNS AGAINST: a temp directory built from `fixtures/host-units/`, made the tool's project BEFORE
 * the tool is imported.
 *
 * The tool resolves its project once, at import (`HOME_CHECKOUT`, from `$AGENT_ORG_HOST`), and `host-units.mjs` derives its unit directory,
 * its `package.json` scripts and its declared keys from it. In CI that was a11ign's live checkout, so the file's verdict moved whenever a11ign
 * merged a unit, a script or a workflow -- and the file had four tests that failed outright anywhere the tool is not laid at
 * `<project>/packages/agent-org`. A fixture project makes both true at once: the tool's own templates are the only a11ign-independent input
 * left, and the layout is one this file builds.
 *
 * IMPORT THIS FIRST. ES modules evaluate in import order, so the environment variable is set before `host-units.mjs` (and `project-config.mjs`
 * beneath it) are evaluated; it imports nothing from the tool for the same reason.
 */
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDirForFile } from "../lib/tmp-fixture.ts";

/** This checkout: the tool is its own tree, whatever the project it serves looks like. */
export const TOOL_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/host-units/", import.meta.url));

/** The placeholder `fixtures/host-units/host.json` carries where the project's checkout goes: a temp path is only known once it exists. */
const CHECKOUT_PLACEHOLDER = "@@PROJECT@@";

function buildProject(): string {
  const root = tmpDirForFile("host-units-project-");
  const declaration = join(root, ".agent-org");
  mkdirSync(declaration);
  cpSync(join(FIXTURE_DIR, "units"), join(declaration, "units"), { recursive: true });
  cpSync(join(FIXTURE_DIR, "scripts"), join(root, "scripts"), { recursive: true });
  cpSync(join(FIXTURE_DIR, "package.json"), join(root, "package.json"));
  cpSync(join(FIXTURE_DIR, "project.json"), join(declaration, "project.json"));
  writeFileSync(join(declaration, "host.json"),
    readFileSync(join(FIXTURE_DIR, "host.json"), "utf8").replace(CHECKOUT_PLACEHOLDER, root));
  // The monorepo's shape, which the shipped templates' `ExecStart=... packages/agent-org/...` paths are written against: the project holds the
  // tool at `packages/agent-org`. A link to THIS checkout, so those paths read the tool under test and not whatever sits at that path elsewhere.
  mkdirSync(join(root, "packages"));
  symlinkSync(TOOL_ROOT, join(root, "packages/agent-org"), "dir");
  return root;
}

/** The fixture project's root, and the process's `$AGENT_ORG_HOST` for as long as this file runs. */
export const PROJECT_ROOT = buildProject();
process.env.AGENT_ORG_HOST = join(PROJECT_ROOT, ".agent-org/host.json");
