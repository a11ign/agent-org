// command: `npm run lint` -- ESLint over `src/`, `scripts/`, `plugins/` and `ui/`, through the keyed cache of `lint-cache.ts` (A11-307)
//
// What `eslint --no-error-on-unmatched-pattern src scripts plugins ui` was, with `--cache` in a directory named by the config, the lockfile and the plugin versions. On a fresh checkout
// (CI's `lint` job) there is no cache and every file is linted, so the result is the one the plain command gave. Extra arguments go to ESLint.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eslintEntryOf, runKeyedEslint } from "./lint-cache.ts";

export const LINT_TARGETS = ["src", "scripts", "plugins", "ui"] as const;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runKeyedEslint({ root, eslintEntry: eslintEntryOf(root), targets: LINT_TARGETS, extraArgs: process.argv.slice(2) }).status);
}
