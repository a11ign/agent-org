// @ts-check
// THE TOOL'S OWN BARE SPECIFIERS, FOLLOWED -- a11ign/a11ign#3103. After the cut-over a project test reaches the tool as
// `import { x } from "agent-org/src/<module>.mjs"`, which `localImports` (relative specifiers only) does not see. A test whose only route to
// `gh`, `git log` or `runs/` is through the tool was then derived as needing NOTHING: the walk stopped at the package boundary and "found
// nothing" read as "needs nothing". Measured: `work-gate.test.ts` fell out of the pinned `history` population when its imports were repointed.
//
// ONLY THE TOOL'S OWN NAME, deliberately. Following every installed package would scan third-party code for `gh` and `git log` and charge the
// project for what a dependency does; the tool is the one package whose code reaches those readers by design. Any other bare specifier stays out
// of scope, as `localImports` documents.
//
// NOT a change to `local-import-closure.ts`: that file is a pinned copy of the project's, and one walk of the identical shape is enough, so this
// module adds the one edge kind it does not have and leaves its resolution of relative specifiers to it.
import { readFileSync, statSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { stripComments } from "./local-import-closure.ts";

const TOOL_PACKAGE = "agent-org";
const TOOL_IMPORT = new RegExp(String.raw`import\s+(?:([^;]*?)\s+from\s+)?['"](${TOOL_PACKAGE}/[^'"]+)['"]`
  + String.raw`|(?:from|import)\s*\(\s*['"](${TOOL_PACKAGE}/[^'"]+)['"]`, "g");

/**
 * The file `specifier` (`agent-org/src/x.mjs`) names under the nearest `node_modules` above `from`, or `null` when no installed copy holds it.
 * Walks up the way node does, so a worktree with its own `node_modules` and a project with a hoisted one both resolve. `from` is made absolute first:
 * callers pass entries relative to the cwd, and `dirname` of a relative path reaches `.` and stays there, which is a loop with no exit (#3103, the hung gate).
 * @param {string} from directory of the importing file
 * @param {string} specifier
 * @returns {string | null}
 */
function installedFile(from: string, specifier: string): string | null {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", specifier);
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
    if (dir === parse(dir).root) return null;
  }
}

/**
 * The names an import clause binds: `{ a, b as c }`, a default, or `* as ns`. Same reading as `importedNamesFor`'s, for the one specifier shape
 * it does not handle.
 * @param {string} clause
 * @returns {string[]}
 */
function boundNames(clause: string): string[] {
  const names = /** @type {string[]} */ ([]);
  const braces = /\{([^}]*)\}/.exec(clause);
  for (const part of (braces ? braces[1].split(",") : [])) {
    const trimmed = part.trim();
    if (trimmed) names.push(/\bas\s+(\S+)/.exec(trimmed)?.[1] ?? trimmed.split(/\s+/)[0]);
  }
  const outside = clause.split("{")[0].replace(/,\s*$/, "").trim();
  if (outside) names.push(/^\*\s+as\s+(\S+)/.exec(outside)?.[1] ?? outside);
  return names;
}

/**
 * Every `agent-org/...` import `file` makes that resolves to an installed file, with the local names it binds (empty for a side-effect or dynamic
 * import, exactly as `importedNamesFor` answers for a relative one). An import no installed copy holds is absent from the result: with the package
 * not installed there is no tool code to run, so the test could not reach a reader through it either.
 * @param {string} file
 * @returns {{ target: string, names: string[] }[]}
 */
export function toolImports(file: string): { target: string; names: string[]; }[] {
  const src = stripComments(readFileSync(file, "utf8"));
  const out = /** @type {{ target: string, names: string[] }[]} */ ([]);
  for (const m of src.matchAll(TOOL_IMPORT)) {
    const target = installedFile(dirname(file), m[2] ?? m[3]);
    if (target !== null) out.push({ target, names: m[1] ? boundNames(m[1]) : [] });
  }
  return out;
}
