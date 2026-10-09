// #3068: WHERE THE TOOL FINDS `typescript`. It is a PEER dependency: the tool parses the PROJECT's code, so it must read the project's own
// version of the compiler, and the project already has one. Resolution is from the project's directory FIRST and the tool's own tree second.
// A candidate is accepted only if it has the JS compiler API (TypeScript 7 does not, #3729), else the next place is tried. The second is what a project that did not install it gets from pnpm's auto-installed peer, and what the tool's own checkout and CI (which
// install it beside the tool) rely on. `acceptance-commands.mjs` reads it through here. `lib/tree-wide-guard.ts` still says
// `createRequire(import.meta.url)("typescript")`: it is a declared COPY of a product file whose drift is checked, so it is not edited here, and in an
// installed tree pnpm links the peer beside the tool, which that call finds (measured 2026-10-02, pnpm 10.34.5). The row named four modules; only
// these two load `typescript` (the other two use `createRequire` for something else).
//
// "The project's directory" is the directory the command is run in (the same project `resolveHomeCheckout` names in the installed layout), and this
// module imports nothing from the project-config chain, so reading `typescript` never reads, or is refused by, a declaration.
import { createRequire } from "node:module";
import { join } from "node:path";

export type TypeScript = typeof import("typescript");

/**
 * TypeScript 7 is the native compiler: its `typescript` entry point resolves and loads, and has no JS compiler API (`ts.ScriptTarget` is `undefined`).
 * A module is accepted only if it exposes the members `acceptance-commands.mjs` calls (`ScriptTarget.Latest`, `createSourceFile`, `forEachChild`), each by
 * the TYPE it is used as: a bare object for `ScriptTarget` would pass while `ScriptTarget.Latest` was still `undefined` (#280's review). So a project on 7.x
 * falls through to the tool's own copy rather than crashing at the first use.
 */
function exposesCompilerApi(candidate: unknown): candidate is TypeScript {
  const api = candidate as Partial<TypeScript> | null | undefined;
  return typeof api?.createSourceFile === "function" && typeof api?.forEachChild === "function" && typeof api?.ScriptTarget?.Latest === "number";
}

/**
 * @param [where] `from` is the project's directory; the directory the command is run in by default
 * @throws {Error} naming each place it looked and why it was rejected, when none holds a `typescript` with the JS compiler API
 */
export function resolveTypescript({ from = process.cwd() }: { from?: string; } = {}): TypeScript {
  const places = [
    { name: `the project (\`${from}\`)`, load: createRequire(join(from, "noop.cjs")) },
    { name: "the tool's own tree", load: createRequire(import.meta.url) },
  ];
  const failures: Error[] = [];
  for (const { name, load } of places) {
    try {
      const candidate = load("typescript");
      if (exposesCompilerApi(candidate)) return candidate;
      failures.push(new Error(`${name}: \`${load.resolve("typescript")}\` loads but has no JS compiler API (\`ScriptTarget\`, \`createSourceFile\`), as in TypeScript 7`));
    } catch (cause) {
      failures.push(new Error(`${name}: ${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}`, { cause }));
    }
  }
  throw new Error(`\`typescript\` with the JS compiler API is a peer dependency of agent-org and none was usable: add it with \`pnpm add -D typescript\` (5 or 6). Rejected: ${failures.map((failure) => failure.message).join("; ")}`,
    { cause: new AggregateError(failures, "each place `typescript` was looked for") });
}
