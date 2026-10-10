// no-token: none -- copies files and reads two JSON documents; nothing here reaches `gh`, `herdr` or `git`
/**
 * (#3057) A COPY OF THE TOOL BESIDE A COPY OF THE PROJECT, for the tests that must run an entry point in a tree of their own.
 *
 * Three tests copied "the repository" by `relative(<src up four>, file)`, which in the monorepo held the tool and the
 * project's `.agent-org/` together. They are two trees now: the tool is this checkout and the project is `HOME_CHECKOUT`.
 * So the tool's files land under `<copyRoot>/packages/agent-org/`, the project's under `<copyRoot>/`, and the copied tool is told the
 * copy is its project by a `host.json` of its own (`AGENT_ORG_HOST`), the one way it learns where a project is.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { localImports } from "@a11ign/toolchain/lib/local-import-closure";
import { HOME_CHECKOUT, HOST_ENV } from "../project-config.ts";

/** This checkout: the tool is its own tree, so `src/packaging` up two is a place the tool owns, not a project file. */
export const TOOL_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Where the project's plugin imports the tool from today (`../../packages/agent-org/src/...`), so a copy must put it there. */
const TOOL_DIR = "packages/agent-org";

const PROJECT_DECLARATION = ".agent-org/project.json";

/**
 * The project's files a copied tool reads at import: its declaration, and the plugin that declaration names (imported DYNAMICALLY, so
 * `localImports` cannot see it). The plugin is READ from the declaration rather than listed by name, so the project renaming it
 * (`causes.ts` to `causes.ts`, a11ign/a11ign#4393) cannot break a test here before this list moves.
 */
function projectFiles(): string[] {
  const declaration = JSON.parse(readFileSync(join(HOME_CHECKOUT, PROJECT_DECLARATION), "utf8")) as { causes?: { module?: string } };
  const plugin = declaration.causes?.module;
  return plugin === undefined ? [PROJECT_DECLARATION] : [PROJECT_DECLARATION, join(".agent-org", plugin)];
}

export const toolFile = (relativePath: string): string => join(TOOL_ROOT, relativePath);

/** Every file `entry` imports, itself included, plus `also` (files reached by a string the static walk cannot read). */
export function importClosure(entry: string, also: string[] = []): Set<string> {
  const files = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const next of localImports(file)) visit(next);
  };
  for (const file of [entry, ...also]) visit(file);
  return files;
}

function copyInto(target: string, source: string): void {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

/**
 * Copies `files` (absolute paths in this checkout) and the project's declaration under `copyRoot`.
 * @returns the copy of `entry`, and the environment that makes the copy its own project
 */
export function copyToolAndProject(entry: string, files: Iterable<string>, copyRoot: string): { entry: string; env: Record<string, string> } {
  for (const file of files) copyInto(join(copyRoot, TOOL_DIR, relative(TOOL_ROOT, file)), file);
  // The tool's own package.json says "type": "module"; without it the copy's `.ts` files load as CommonJS under node.
  writeFileSync(join(copyRoot, TOOL_DIR, "package.json"), '{"type":"module"}');
  for (const file of projectFiles()) copyInto(join(copyRoot, file), join(HOME_CHECKOUT, file));
  const hostSource = process.env[HOST_ENV] ?? join(HOME_CHECKOUT, ".agent-org/host.json");
  const host = JSON.parse(readFileSync(hostSource, "utf8")) as { primary: string };
  const hostPath = join(copyRoot, ".agent-org/host.json");
  writeFileSync(hostPath, JSON.stringify({ ...host, projects: [{ id: host.primary, checkout: copyRoot }] }));
  return { entry: join(copyRoot, TOOL_DIR, relative(TOOL_ROOT, entry)), env: { [HOST_ENV]: hostPath } };
}
