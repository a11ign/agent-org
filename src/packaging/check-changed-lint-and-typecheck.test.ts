// no-token: none -- runs `eslint` and `tsc` from this tree's node_modules over projects this file builds in temporary directories; nothing reaches `gh`, `herdr` or the network
/**
 * THE LINT CACHE CANNOT HIDE A LINT ERROR, AND THE TYPECHECK STAYS WHOLE-PROGRAM (A11-307).
 *
 * `scripts/lint-cache.ts` keeps ESLint's cache in a directory named by the config's text, the lockfile's text and the installed version of every ESLint package. Each case builds a project in a
 * temporary directory, lints a file that passes, changes ONE input so the file must now fail, and expects the failure:
 *   - `eslint.config.ts` turns a rule on;
 *   - a plugin's version changes and its rule now reports (the config text is the same);
 *   - the lockfile changes (the key changes, and the cache of the old key is removed).
 * And the cache is used when nothing changed. The typecheck cases run `package.json`'s own `typecheck` flags: the build info lands under `node_modules/.cache/tsc`, and a change to one file makes
 * `tsc` fail on a file that did not change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../lib/tmp-fixture.ts";
import { eslintEntryOf, lintCacheDirectory, lintCacheKey, runKeyedEslint } from "../../scripts/lint-cache.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const ESLINT_ENTRY = eslintEntryOf(REPO);
const TSC_ENTRY = join(REPO, "node_modules", "typescript", "bin", "tsc");
const ESLINT_TIMEOUT_MS = 60_000;

type Tree = Record<string, string>;

function write(root: string, files: Tree): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const configWith = (rule: string): string => `export default [{ files: ["**/*.ts"], rules: { "no-debugger": ${JSON.stringify(rule)} } }];\n`;

/** A project whose only lint input is `eslint.config.ts`, and one file that fails `no-debugger` when the rule is on. */
function lintProject(config: string): string {
  const root = tmpDir("check-changed-lint-");
  write(root, {
    "eslint.config.ts": config,
    "package.json": JSON.stringify({ name: "fixture", type: "module", devDependencies: { "eslint-plugin-fake": "1.0.0", "left-pad": "1.0.0" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "node_modules/eslint-plugin-fake/package.json": JSON.stringify({ name: "eslint-plugin-fake", version: "1.0.0" }),
    "src/a.ts": "debugger;\n",
  });
  return root;
}

/** ESLint's config loader (jiti) writes its transpile cache to TMPDIR, so each run gets one of this test's own, which the runner removes. */
const lintAndExpectFailure = (root: string, message: RegExp): void => {
  const failed = lint(root);
  assert.equal(failed.status, 1, failed.output);
  assert.match(failed.output, message);
};

const lint = (root: string) => runKeyedEslint({ root, eslintEntry: ESLINT_ENTRY, targets: ["src/a.ts"], output: "captured", env: { ...process.env, TMPDIR: tmpDir("check-changed-jiti-") } });

test("a file that passes is served from the cache, and the cache is written under node_modules/.cache/eslint", { timeout: ESLINT_TIMEOUT_MS }, () => {
  const root = lintProject(configWith("off"));
  assert.equal(lint(root).status, 0);
  const directory = lintCacheDirectory(root, lintCacheKey(root));
  assert.ok(directory.includes(join("node_modules", ".cache", "eslint")), directory);
  assert.ok(readdirSync(directory).some((name) => name.startsWith(".cache_")), `no cache file in ${directory}`);
  assert.equal(lint(root).status, 0);
  assert.equal(lintCacheDirectory(root, lintCacheKey(root)), directory);
});

test("changing eslint.config.ts to make a cached file fail shows the failure, and drops the old cache", { timeout: ESLINT_TIMEOUT_MS }, () => {
  const root = lintProject(configWith("off"));
  assert.equal(lint(root).status, 0);
  const passingKey = lintCacheKey(root);
  write(root, { "eslint.config.ts": configWith("error") });
  assert.notEqual(lintCacheKey(root), passingKey);
  lintAndExpectFailure(root, /no-debugger/);
  assert.equal(existsSync(lintCacheDirectory(root, passingKey)), false);
});

test("changing a plugin's version, with the config text the same, shows the failure the new plugin finds", { timeout: ESLINT_TIMEOUT_MS }, () => {
  const rule = (reports: boolean): string => `export default { rules: { "needs-no-debugger": { create: (context) => ({ DebuggerStatement: (node) => { if (${reports}) context.report({ node, message: "plugin says no" }); } }) } } };\n`;
  const config = 'import fake from "eslint-plugin-fake";\nexport default [{ files: ["**/*.ts"], plugins: { fake }, rules: { "fake/needs-no-debugger": "error" } }];\n';
  const root = lintProject(config);
  const plugin = (version: string, reports: boolean): Tree => ({
    "node_modules/eslint-plugin-fake/package.json": JSON.stringify({ name: "eslint-plugin-fake", version, type: "module", main: "index.js" }),
    "node_modules/eslint-plugin-fake/index.js": rule(reports),
  });
  write(root, plugin("1.0.0", false));
  assert.equal(lint(root).status, 0);
  const before = lintCacheKey(root);
  write(root, plugin("1.1.0", true));
  assert.notEqual(lintCacheKey(root), before);
  lintAndExpectFailure(root, /plugin says no/);
});

test("the key moves with the config, the lockfile and an ESLint package's version, and stays put for anything else", () => {
  const root = lintProject(configWith("off"));
  const key = lintCacheKey(root);
  assert.equal(lintCacheKey(root), key);
  write(root, { "src/a.ts": "const changedSource = 1;\n", "node_modules/left-pad/package.json": JSON.stringify({ name: "left-pad", version: "9.9.9" }) });
  assert.equal(lintCacheKey(root), key, "a source file and a package that is not ESLint's are not inputs");
  write(root, { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n# resolved a new plugin\n" });
  const afterLockfile = lintCacheKey(root);
  assert.notEqual(afterLockfile, key);
  write(root, { "node_modules/eslint-plugin-fake/package.json": JSON.stringify({ name: "eslint-plugin-fake", version: "2.0.0" }) });
  const afterPlugin = lintCacheKey(root);
  assert.notEqual(afterPlugin, afterLockfile);
  write(root, { "eslint.config.ts": configWith("error") });
  assert.notEqual(lintCacheKey(root), afterPlugin);
});

test("a change to the lockfile removes the cache of the old key and lints the file again", { timeout: ESLINT_TIMEOUT_MS }, () => {
  const root = lintProject(configWith("error"));
  assert.equal(lint(root).status, 1);
  const oldKey = lintCacheKey(root);
  write(root, { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n# a plugin moved\n" });
  const again = lint(root);
  assert.equal(again.status, 1, "the error is reported again, not served from a cache of the old inputs");
  assert.equal(existsSync(lintCacheDirectory(root, oldKey)), false);
  assert.ok(existsSync(lintCacheDirectory(root, lintCacheKey(root))));
});

/** The flags of this repository's `typecheck` script, which the cases below run as written. */
function typecheckFlags(): string[] {
  const script = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts.typecheck;
  assert.match(script, /^tsc /);
  return script.split(" ").slice(1);
}

function typecheckProject(files: Tree): string {
  const root = tmpDir("check-changed-tsc-");
  write(root, { "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", allowImportingTsExtensions: true, skipLibCheck: true }, include: ["*.ts"] }), ...files });
  return root;
}

const typecheck = (root: string) => spawnSync("node", [TSC_ENTRY, ...typecheckFlags()], { cwd: root, encoding: "utf8" });

test("the typecheck script runs incrementally and keeps its build info under node_modules/.cache", () => {
  const flags = typecheckFlags();
  assert.ok(flags.includes("--incremental"), flags.join(" "));
  const location = flags[flags.indexOf("--tsBuildInfoFile") + 1];
  assert.ok(location.startsWith("node_modules/.cache/"), location);
  const root = typecheckProject({ "a.ts": "export const a: number = 1;\n" });
  assert.equal(typecheck(root).status, 0);
  assert.ok(existsSync(join(root, location)), `no build info at ${location}`);
});

test("the typecheck is whole-program: changing one file fails a file that did not change, with the build info already written", () => {
  const root = typecheckProject({ "lib.ts": "export const value: number = 1;\n", "user.ts": 'import { value } from "./lib.ts";\nexport const doubled: number = value * 2;\n' });
  assert.equal(typecheck(root).status, 0);
  write(root, { "lib.ts": 'export const value: string = "1";\n' });
  const failed = typecheck(root);
  assert.equal(failed.status, 2, failed.stdout);
  assert.match(failed.stdout, /user\.ts/);
  write(root, { "lib.ts": "export const value: number = 3;\n" });
  assert.equal(typecheck(root).status, 0);
});
