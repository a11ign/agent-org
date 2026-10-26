// command: `npm run lint` -- ESLint over `src/`, `scripts/`, `plugins/` and `ui/`, through the keyed cache of `lint-cache.ts` (A11-307)
//
// What `eslint --no-error-on-unmatched-pattern src scripts plugins ui` was, with `--cache` in a directory named by the config, the lockfile and the plugin versions. On a fresh checkout
// (CI's `lint` job) there is no cache and every file is linted, so the result is the one the plain command gave. Extra arguments go to ESLint.
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eslintEntryOf, LINT_TARGETS, runKeyedEslint } from "./lint-cache.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The same test the repository's other entries use: a path with a space in it, which `file://${argv[1]}` would not match, still runs.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(runKeyedEslint({ root, eslintEntry: eslintEntryOf(root), targets: LINT_TARGETS, extraArgs: process.argv.slice(2) }).status);
}
