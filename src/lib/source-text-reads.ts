// no-token: none -- reads source files from disk; nothing here reaches `gh`, `herdr` or `git`
/**
 * A MODULE'S SOURCE AS ONE TEXT, FOR THE TESTS THAT PIN IT.
 *
 * A module that a split moves into a directory of its own (`src/wake.ts` and `src/wake/`) keeps its text here: the module file followed by every
 * non-test file under its directory, sorted so the order is the same on every machine and every run. A pin on the module is then a pin on the
 * module's set of files, as `work-gate-source.ts` does for the gate, and a declaration, a slice or an occurrence count is found wherever it now lives.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `src/`, found from this file (`src/lib/`), so a test reads the checkout it runs in. */
const SRC = fileURLToPath(new URL("..", import.meta.url));

/**
 * `src/<file>` (`file` is relative to `src/`, such as `wake.ts`), then each non-test file under `src/<stem>/`, joined with a newline. `srcDir` is for a
 * test that builds a fixture tree; every caller of the real checkout passes nothing.
 */
export function moduleSource(file: string, srcDir: string = SRC): string {
  const stemDir = join(srcDir, file.replace(/\.ts$/, ""));
  const moved = existsSync(stemDir)
    ? readdirSync(stemDir, { recursive: true, encoding: "utf8" })
        .map((entry) => entry.split("\\").join("/"))
        .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    : [];
  return [readFileSync(join(srcDir, file), "utf8"), ...moved.map((entry) => readFileSync(join(stemDir, entry), "utf8"))].join("\n");
}
