// The Clean Code rules, from @george2f/eslint-plugin-clean-code's `recommended` config (ticket A11-95). One rule per line, so a follow-up
// row changes one line: each row counts its rule's hits, fixes or configures or turns them off, and raises the line to "error".
// Every rule starts at "warn" and a warning does not fail `npm run lint`. The two rules with no hits go straight to "error".
// Type-aware linting is off on purpose: no `projectService` and no `parserOptions.project`, so `tsconfig.json` is not loaded.
// This is a .ts file because a new .js file is script source to the mjs ratchet, and the repository's new code is TypeScript. ESLint loads it through `jiti`, pinned beside it.
import tseslint from "typescript-eslint";
import cleanCode from "@george2f/eslint-plugin-clean-code";

const recommended = {
  "clean-code/max-arguments": "warn",
  "clean-code/no-commented-out-code": "warn",
  "clean-code/no-dead-code": "warn",
  "clean-code/no-encodings": "error",
  "clean-code/no-flag-arguments": "warn",
  "clean-code/no-magic-numbers": "warn",
  "clean-code/no-negative-conditionals": "warn",
  "clean-code/no-overridden-safeties": "warn",
  "clean-code/no-pass-null": "warn",
  "clean-code/no-return-null": "warn",
  "clean-code/no-skipped-tests": "error",
  "clean-code/no-todo-tests": "error",
};

export default [
  { ignores: ["node_modules/**"] },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "clean-code": cleanCode },
    rules: recommended,
  },
];
