// The Clean Code rules, from @george2f/eslint-plugin-clean-code's `recommended` config (ticket A11-95). One rule per line, so a follow-up
// row changes one line: each row counts its rule's hits, fixes or configures or turns them off, and raises the line to "error".
// Every rule starts at "warn" and a warning does not fail `npm run lint`. The two rules with no hits go straight to "error".
// Type-aware linting is off on purpose: no `projectService` and no `parserOptions.project`, so `tsconfig.json` is not loaded.
// This is a .ts file because a new .js file is script source to the mjs ratchet, and the repository's new code is TypeScript. ESLint loads it through `jiti`, pinned beside it.
import tseslint from "typescript-eslint";
import cleanCode from "@george2f/eslint-plugin-clean-code";
import astro from "eslint-plugin-astro";
import { readFileSync } from "node:fs";

const recommended = {
  "clean-code/max-arguments": "warn",
  "clean-code/no-commented-out-code": "error",
  "clean-code/no-dead-code": "warn",
  "clean-code/no-encodings": "error",
  "clean-code/no-flag-arguments": "error", // production is fixed (A11-101); test files are off, see the block below
  "clean-code/no-magic-numbers": "warn",
  "clean-code/no-negative-conditionals": "error",
  "clean-code/no-overridden-safeties": ["error", { allowEmptyCatch: true, allowTsIgnore: true, requireDisableReason: true }], // A11-107: allowEmptyCatch and allowTsIgnore keep this from duplicating no-empty and ban-ts-comment, which this repo does not enable, so an empty catch, an undescribed @ts-ignore or @ts-nocheck passes; an eslint-disable with no "--" reason fails (G4)
  "clean-code/no-pass-null": "warn",
  "clean-code/no-return-null": "warn",
  "clean-code/no-skipped-tests": "error",
  "clean-code/no-todo-tests": "error",
};

// Rules from the plugin's `strict` config, adopted one at a time (A11-107). One rule per line, each with its reason.
const adopted = {
  "clean-code/be-precise": "error", // a float compared with === or !== depends on exact rounding; parseInt without a radix guesses (G26)
  "clean-code/names-describe-side-effects": "error", // a function that mutates or does I/O must say so in its name; get/is/has/find must be pure (N7)
  "clean-code/encapsulate-conditionals": "error", // a condition with more than two logical operators is named, so the branch reads as intent (G28)
  "clean-code/limited-public-api": "error", // a module exports at most 50 members (G8); a bigger one carries a stated reason in its own file
  "clean-code/prefer-exceptions-over-error-codes": "error", // flags only a `return -1;` statement (Ch3): throw instead; write a sort comparator as `(a, b) => (a < b ? -1 : 1)`, which is not flagged; a block-bodied `return -1` that is not an error code takes an eslint-disable-next-line with a `-- reason`
  "clean-code/no-duplication": "error", // A11-113: a block of 4 statements that repeats an earlier block of its file by shape is a copy to extract (G5); repeated test cases are one table through testEach, and an import list, which the shape match reads as a copy, is disabled line by line with its reason
};

// The rules every source block takes, `.ts`, `.tsx` and `.astro` alike.
const cleanCodeRules = {
  ...recommended,
  ...adopted,
  "max-lines-per-function": ["error", { max: 70, skipComments: true, skipBlankLines: true }], // A11-115: a function over 70 code lines does more than one thing; comments and blank lines are not counted, because the policy is comment-dense
};

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
  { ignores: ["node_modules/**", "ui/dist/**", "ui/.astro/**"] },
  // A11-188: the UI package's `.astro` files, through eslint-plugin-astro's parser (its `recommended` config sets the parser and the Astro rules). The Clean Code rules are added to the
  // `.astro` file itself, whose frontmatter this parser reads, and the `<script>` of a page reaches the `.ts` block below as a virtual `.ts` file.
  // The last entry of `recommended` names no `files`, so it is scoped here: the Astro rules judge `.astro` files and no `.ts` file.
  ...astro.configs["flat/recommended"].map((entry) => ({ ...entry, files: entry.files ?? ["**/*.astro"] })),
  {
    files: ["**/*.astro"],
    plugins: { "clean-code": cleanCode },
    rules: cleanCodeRules,
  },
  {
    // A11-188: `.tsx` is the UI package's React islands; it takes the same rules and the same parser as `.ts`.
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "clean-code": cleanCode },
    rules: cleanCodeRules,
  },
  // A test helper's boolean is the fixture's variant, which the rule cannot tell from a mode switch, and splitting it would double each fixture.
  { files: ["**/*.test.ts", "**/*.test.tsx"], rules: { "clean-code/no-flag-arguments": "off" } },
  // A COPY of packages/guards' walk-scope.ts: copies-drifted (src/org-health/sweep-readings.ts) reads any change to its body as drift, so its one
  // condition stays as the original writes it. The fix belongs in the original, in a11ign, as a follow-up.
  { files: ["src/lib/walk-scope.ts"], rules: { "clean-code/encapsulate-conditionals": "off" } },
  // A11-113: the fixture project is a copy of project code on purpose (its files repeat the project's own on purpose), so only this rule is off there; a global ignore would also drop every other rule
  { files: ["src/packaging/fixtures/**"], rules: { "clean-code/no-duplication": "off" } },
  blockingCallBan,
];
