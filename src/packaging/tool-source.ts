/**
 * THE TOOL'S OWN SOURCE, READ OFF DISK -- the one population the census guards in this directory walk (a11ign/a11ign#3106).
 *
 * WHY THE FILESYSTEM AND NOT `git ls-files`: `ci.yml` copies this checkout into `project/packages/agent-org` of a project checkout and runs
 * the suite from the project's root, where the copy is UNTRACKED, so a `git ls-files` walk (`lib/tree-wide-guard.ts`) finds the project's
 * files and none of the tool's. Resolved from `import.meta.url`, `TOOL_SRC` is this tool's `src/` in both layouts.
 *
 * `packaging/` IS LEFT OUT of the non-test population: in the project layout `ci.yml` rsyncs the project's own non-test helpers into it, and
 * those are the project's code, not the tool's. The tests in it are the tool's and stay.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The tool's `src/`, absolute and with a trailing slash. */
export const TOOL_SRC = fileURLToPath(new URL("../", import.meta.url));

/** `path` is relative to the tool's root and starts `src/`, the same spelling in both layouts. */
export type ToolFile = { path: string; text: string };

const SOURCE = /\.(mjs|cjs|js|ts)$/;
const TEST = /\.test\.(mjs|ts)$/;

/** Every `.mjs`/`.cjs`/`.js`/`.ts` file under `dir`, recursively and sorted, never `node_modules`. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : filesUnder(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

const read = (absolute: string): ToolFile => ({
  path: `src/${relative(TOOL_SRC, absolute).split("\\").join("/")}`,
  text: readFileSync(absolute, "utf8"),
});

/** The tool's own non-test source: never a test, never `src/packaging/` (see the header). */
export function toolSources(): ToolFile[] {
  return filesUnder(TOOL_SRC).filter((path) => !TEST.test(path))
    .filter((path) => !relative(TOOL_SRC, path).startsWith("packaging/")).map(read);
}

/** The tool's own test files. */
export function toolTests(): ToolFile[] {
  return filesUnder(TOOL_SRC).filter((path) => TEST.test(path)).map(read);
}
