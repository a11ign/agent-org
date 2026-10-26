// module: the ESLint run `npm run lint` and `npm run check:changed` share, with a cache that cannot hide an error (A11-307)
//
// ESLint's `--cache` is a file of results keyed by each file's content and by the ESLint version and the config it computed. A change to a PLUGIN'S CODE under the same
// version string, or to a rule's behaviour behind an unchanged config, is not something that file can see, and a cache that serves a pass for a file a changed rule
// would now fail hides a lint error. So the cache lives in a directory NAMED BY ITS INPUTS: the text of `eslint.config.ts`, the text of the lockfile, and the installed
// version of every package that is ESLint, a plugin of it, its config loader or the TypeScript the parser reads. Any of them changes, the key changes, the old cache is not
// read (and is removed), and the next run lints every file it is given. The cache is under `node_modules/.cache/eslint`, which no commit carries.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

/**
 * Whether the module at `metaUrl` is the script node was started on. Compared as URLs through the real path, as the repository's other entries do: `file://${argv[1]}` is false for a path that
 * needs URL encoding (a space), which made an entry run nothing and exit 0. Not an entry when `argv[1]` is no file (`node -e`, a REPL).
 */
export function isEntryScript(metaUrl: string): boolean {
  const started = process.argv[1];
  return started !== undefined && existsSync(started) && metaUrl === pathToFileURL(realpathSync(started)).href;
}

/** What `npm run lint` lints: the scope `eslint.config.ts` covers, `plugins/` and `ui/` included (`ci-lint-job.test.ts` and `ci-ui-job.test.ts` hold it). */
export const LINT_TARGETS = ["src", "scripts", "plugins", "ui"] as const;

const CACHE_ROOT = join("node_modules", ".cache", "eslint");
const KEY_LENGTH = 16;
/** The packages whose installed version is part of the key: ESLint itself, every plugin and config of it, the loader for `eslint.config.ts`, and TypeScript. */
const KEYED_PACKAGE = /eslint|^jiti$|^typescript$/;

const readTextOrMissing = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "<missing>");

/** The name of every dependency the manifest declares, of either kind. */
function declaredPackages(root: string): string[] {
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies?: object; devDependencies?: object };
  return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
}

/** The ESLint entry script installed for `root`, which `node` runs. */
export const eslintEntryOf = (root: string): string => join(dirname(createRequire(join(root, "package.json")).resolve("eslint/package.json")), "bin", "eslint.js");

/** The installed version of `name` under `root`'s `node_modules`, or `<missing>`. */
function installedVersion(root: string, name: string): string {
  try {
    return (JSON.parse(readTextOrMissing(join(root, "node_modules", name, "package.json"))) as { version?: string }).version ?? "<no version>";
  } catch {
    return "<unreadable>";
  }
}

/** The text every input of the cache key contributes, in a fixed order. Exported so a test can show what the key is made of. */
export function lintCacheInputs(root: string): string[] {
  const versions = declaredPackages(root).filter((name) => KEYED_PACKAGE.test(name)).sort().map((name) => `${name}@${installedVersion(root, name)}`);
  return [`eslint.config.ts\n${readTextOrMissing(join(root, "eslint.config.ts"))}`, `pnpm-lock.yaml\n${readTextOrMissing(join(root, "pnpm-lock.yaml"))}`, ...versions];
}

/** The key the cache directory is named by: a hash of `lintCacheInputs`. */
export function lintCacheKey(root: string): string {
  const hash = createHash("sha256");
  for (const input of lintCacheInputs(root)) hash.update(`${input.length}:${input}\n`);
  return hash.digest("hex").slice(0, KEY_LENGTH);
}

/** The directory ESLint is given as `--cache-location`: a trailing slash makes ESLint keep its cache file inside it. */
export const lintCacheDirectory = (root: string, key: string): string => join(root, CACHE_ROOT, key);

/** Remove every cache directory under `node_modules/.cache/eslint` that is not `key`'s: its inputs changed, so nothing reads it again. */
export function removeStaleLintCaches(root: string, key: string): void {
  const cacheRoot = join(root, CACHE_ROOT);
  if (!existsSync(cacheRoot)) return;
  for (const entry of readdirSync(cacheRoot)) {
    if (entry !== key) rmSync(join(cacheRoot, entry), { recursive: true, force: true });
  }
}

/** What a lint run needs: the repository, the ESLint to run, what to lint, and anything else to pass ESLint. */
export interface LintRun { root: string; eslintEntry: string; targets: readonly string[]; extraArgs?: readonly string[]; output?: "terminal" | "captured"; env?: NodeJS.ProcessEnv }

/** How a lint run ended: ESLint's exit status, and what it printed when the run asked for it to be captured instead of shown. */
export interface LintResult { status: number; output: string }

/** The ESLint arguments for a run: the keyed cache, content-hashed so a checkout that touches every mtime still hits it. */
export function eslintArguments(run: LintRun, key: string): string[] {
  return [run.eslintEntry, "--cache", "--cache-strategy", "content", "--cache-location", `${lintCacheDirectory(run.root, key)}/`,
    "--no-warn-ignored", "--no-error-on-unmatched-pattern", ...(run.extraArgs ?? []), ...run.targets];
}

/** Run ESLint over `targets` with the cache keyed by the current inputs. Its output goes to the caller's terminal unless the run asks for it captured. */
export function runKeyedEslint(run: LintRun): LintResult {
  const key = lintCacheKey(run.root);
  removeStaleLintCaches(run.root, key);
  const captured = run.output === "captured";
  const result = spawnSync(process.execPath, eslintArguments(run, key), { cwd: run.root, env: run.env ?? process.env, stdio: captured ? "pipe" : "inherit", encoding: "utf8" });
  return { status: result.status ?? 1, output: captured ? `${result.stdout}${result.stderr}` : "" };
}
