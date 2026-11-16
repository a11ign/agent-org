/**
 * This repository's lint: eslint-plugin-clean-code-book's own `recommended`, `typescript`, `ai` and `jsdoc` configs, the same ones that plugin lints
 * itself with, vendored as `vendor/eslint-plugin-clean-code-book-*.tgz` while the plugin has no published home. No rule is turned off or weakened here.
 * What the tree already breaks is recorded in `eslint-suppressions.json` (ESLint's bulk suppressions): new code must pass every rule, and that file only
 * shrinks, as each rule's reports are fixed. Type-aware linting stays off, as before: no `projectService`, so `tsconfig.json` is not loaded.
 * This is a .ts file because a new .js file is script source to the mjs ratchet, and the repository's new code is TypeScript. ESLint loads it through `jiti`, pinned beside it.
 */
import tseslint from "typescript-eslint";
import cleanCode from "eslint-plugin-clean-code-book";
import astro from "eslint-plugin-astro";
import { readFileSync } from "node:fs";
import type { Linter } from "eslint";

/** The plugin's configs this repository takes. `recommended-type-checked` is not among them, because type-aware linting is off. */
const CLEAN_CODE: Linter.Config[] = [...cleanCode.configs.recommended, ...cleanCode.configs.typescript, ...cleanCode.configs.ai, ...cleanCode.configs.jsdoc];

/** A11-188: an `.astro` file's frontmatter takes the same rules as a `.ts` file: every entry that applies to all source files also applies to `.astro`. */
const withAstro = (entry: Linter.Config): Linter.Config =>
  entry.files?.some((pattern) => typeof pattern === "string" && pattern.includes("{js,")) ? { ...entry, files: [...entry.files, "**/*.astro"] } : entry;

// A11-433: NO NEW SYNCHRONOUS SPAWN OR HERDR CALL IN THE BOARD. Such a call holds the board loop for as long as it takes, the most-fixed bug class since August (A11-282, A11-377, A11-395).
// The files that still make one are `blocking-calls.baseline.json`'s `files`, which only shrinks, and its `commands`, the CLI entry points a person runs, by name; both are read here, so
// the list has one home. src/packaging/blocking-calls-ratchet.test.ts holds the list to the tree and to its base. `scripts/lint-cache.ts` keys the cache on the JSON too.
const blockingCalls = JSON.parse(readFileSync(new URL("./blocking-calls.baseline.json", import.meta.url), "utf8")) as { files: string[]; commands: Record<string, string> };
// A spawn reached by a computed name (`cp["execSync"]`) or through an alias (`const s = cp.spawnSync`) is not seen here; the run-time ledger (`blocking-ledger.ts`) still times it.
const SYNC_SPAWN = "/^(?:spawnSync|execFileSync|execSync)$/";
const SYNC_HERDR = "/^(?:herdrRun|readAgents|readAgentSessions|openPane|closedNote)$/";
const BLOCKING_CALL = "A11-433: a synchronous spawn or herdr call holds the board loop for as long as it takes. Use the asynchronous form (`realExecAsync`, `ctx.herdrCall`, the code host's promise "
  + "operations). blocking-calls.baseline.json lists the files that still may, and it only shrinks: do not add this file to it";
const blockingCallBan = {
  files: ["src/ticket-mode/**/*.ts", "plugins/**/*.ts"],
  ignores: ["**/*.test.ts", "**/*.test.support.ts", "**/fixtures/**", ...blockingCalls.files, ...Object.keys(blockingCalls.commands)],
  rules: {
    "no-restricted-syntax": ["error",
      { selector: `ImportDeclaration[source.value=/^(?:node:)?child_process$/] > ImportSpecifier[imported.name=${SYNC_SPAWN}]`, message: BLOCKING_CALL },
      { selector: `CallExpression[callee.name=${SYNC_SPAWN}]`, message: BLOCKING_CALL },
      { selector: `CallExpression[callee.property.name=${SYNC_SPAWN}]`, message: BLOCKING_CALL },
      { selector: `VariableDeclarator > ObjectPattern > Property[key.name=${SYNC_SPAWN}]`, message: BLOCKING_CALL },
      { selector: `ImportSpecifier[imported.name=${SYNC_HERDR}]`, message: BLOCKING_CALL },
      { selector: `CallExpression[callee.name=${SYNC_HERDR}]`, message: BLOCKING_CALL },
      { selector: `CallExpression[callee.property.name=${SYNC_HERDR}]`, message: BLOCKING_CALL },
      { selector: "CallExpression[callee.property.name='herdr']", message: BLOCKING_CALL },
    ],
  },
};

export default [
  // The UI package's build and its generated types are not source (A11-188).
  { ignores: ["node_modules/**", "ui/dist/**", "ui/.astro/**", "vendor/**"] },
  // A11-188: the UI package's `.astro` files, through eslint-plugin-astro's parser (its `recommended` config sets the parser and the Astro rules).
  // The last entry of `recommended` names no `files`, so it is scoped here: the Astro rules judge `.astro` files and no `.ts` file.
  ...astro.configs["flat/recommended"].map((entry) => ({ ...entry, files: entry.files ?? ["**/*.astro"] })),
  ...CLEAN_CODE.map(withAstro),
  // A11-188: `.tsx` is the UI package's React islands; it takes the same parser as `.ts`.
  { files: ["**/*.ts", "**/*.tsx"], languageOptions: { parser: tseslint.parser } },
  blockingCallBan,
];
