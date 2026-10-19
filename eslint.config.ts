// The Clean Code rules, from @george2f/eslint-plugin-clean-code's `recommended` config (ticket A11-95). One rule per line, so a follow-up
// row changes one line: each row counts its rule's hits, fixes or configures or turns them off, and raises the line to "error".
// Every rule starts at "warn" and a warning does not fail `npm run lint`. The two rules with no hits go straight to "error".
// Type-aware linting is off on purpose: no `projectService` and no `parserOptions.project`, so `tsconfig.json` is not loaded.
// This is a .ts file because a new .js file is script source to the mjs ratchet, and the repository's new code is TypeScript. ESLint loads it through `jiti`, pinned beside it.
import tseslint from "typescript-eslint";
import cleanCode from "@george2f/eslint-plugin-clean-code";

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
  "clean-code/limited-public-api": "error", // a module exports at most 50 members (G8); a bigger one carries a stated reason in its own file
};

export default [
  { ignores: ["node_modules/**"] },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "clean-code": cleanCode },
    rules: { ...recommended, ...adopted },
  },
  // A test helper's boolean is the fixture's variant, which the rule cannot tell from a mode switch, and splitting it would double each fixture.
  { files: ["**/*.test.ts"], rules: { "clean-code/no-flag-arguments": "off" } },
];
