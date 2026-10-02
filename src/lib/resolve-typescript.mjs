// @ts-check
// #3068: WHERE THE TOOL FINDS `typescript`. It is a PEER dependency: the tool parses the PROJECT's code, so it must read the project's own
// version of the compiler, and the project already has one. Resolution is from the project's directory FIRST and the tool's own tree second.
// The second is what a project that did not install it gets from pnpm's auto-installed peer, and what the tool's own checkout and CI (which
// install it beside the tool) rely on. `acceptance-commands.mjs` reads it through here. `lib/tree-wide-guard.mjs` still says
// `createRequire(import.meta.url)("typescript")`: it is a declared COPY of a product file whose drift is checked, so it is not edited here, and in an
// installed tree pnpm links the peer beside the tool, which that call finds (measured 2026-10-02, pnpm 10.34.5). The row named four modules; only
// these two load `typescript` (the other two use `createRequire` for something else).
//
// "The project's directory" is the directory the command is run in (the same project `resolveHomeCheckout` names in the installed layout), and this
// module imports nothing from the project-config chain, so reading `typescript` never reads, or is refused by, a declaration.
import { createRequire } from "node:module";
import { join } from "node:path";

/** @typedef {typeof import("typescript")} TypeScript */

/**
 * @param {{ from?: string }} [where] `from` is the project's directory; the directory the command is run in by default
 * @returns {TypeScript}
 * @throws {Error} naming both places it looked, when neither holds `typescript`
 */
export function resolveTypescript({ from = process.cwd() } = {}) {
  const projectRequire = createRequire(join(from, "noop.cjs"));
  const toolRequire = createRequire(import.meta.url);
  /** @type {unknown[]} */
  const failures = [];
  for (const load of [projectRequire, toolRequire]) {
    try {
      return /** @type {TypeScript} */ (load("typescript"));
    } catch (cause) {
      failures.push(cause);
    }
  }
  throw new Error(`\`typescript\` is a peer dependency of agent-org and neither the project (\`${from}\`) nor the tool's own tree holds it: add it with \`pnpm add -D typescript\``,
    { cause: new AggregateError(failures, "each place `typescript` was looked for") });
}
