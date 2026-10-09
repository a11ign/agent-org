/**
 * a11ign/a11ign#4407: A PROJECT REACHES AGENT-ORG BY A DECLARED NAME, NEVER BY A PATH UNDER `src/`.
 *
 * v0.88.0 renamed `src/*.mjs` to `.ts` (#435) and every a11ign pull request's `acceptance / run` threw
 * `ERR_MODULE_NOT_FOUND`, because `reusable-acceptance.yml` imported `src/acceptance-commands.mjs` by path. The sweep is still
 * renaming files, so a project that holds a path repeats the failure with each release. `package.json` therefore carries an
 * `exports` map (subpath -> file) and a `bin`; this file pins WHAT IS DECLARED, which is the only contract.
 *
 * Three things are pinned, and each has its own control:
 *   1. the `exports` subpaths are exactly `DECLARED_EXPORTS`' keys, and Node itself resolves each one to the file the map names;
 *   2. each subpath, imported, carries every name a11ign's callers use (`DECLARED_EXPORTS`' values);
 *   3. the `bin` subcommands a project runs are in the command table and name a program that exists (`DECLARED_COMMANDS`).
 *
 * A source file the declaration does not name may be renamed or moved and nothing here moves; removing a declared name fails.
 * To add a name to the interface, add it to the lists below AND to `package.json`: the test refuses either alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { COMMANDS } from "./commands.mjs";

/** subpath -> the names a project's callers import from it (counted in a11ign/a11ign on origin/main, 2026-10-09). */
const DECLARED_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  "./acceptance-commands": ["extractClosesDeclaration", "closesReferences", "hasFullHistoryDeclaration", "acceptanceSourceOfThisPullRequest"],
  "./acceptance-file": ["resolveAcceptanceSource", "sectionsTextOf", "sourceLine", "acceptanceFileForBranch", "isAcceptancePath"],
  "./board-data": ["REPO", "gh"],
  "./board-document": ["resolveChromeBinary"],
  "./leak-patterns": ["assertNoLeakInArgv", "leakRefusalReason"],
  "./merge-guard-lookups": ["gh"],
  "./newest-check-run": ["newestPerName", "newestConclusionOf"],
  "./pr-open": ["checkBody"],
  "./project-config": ["homeProjectDeclaration"],
  "./tree-wide-guard": ["declareTreeWideGuard"],
};
/** `./package.json` is declared too, but it is data and has no names to carry. */
const DATA_EXPORTS = ["./package.json"];
/** the `bin` subcommands a project runs, and so the ones a rename of their program must not remove. */
const DECLARED_COMMANDS = ["acceptance-commands", "owned-path-signoff", "board:document", "worktree:whose", "worktree:stamp"];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Manifest = { name: string; exports?: Record<string, string> };

function readManifest(root: string): Manifest {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest;
}

/**
 * The names `file` exports, READ and not run: importing `project-config.ts` resolves the project at import and refuses outside one, and this
 * file's job is the declaration, not any module's behaviour. `noResolve` keeps the program to the one file; a re-exported binding
 * (`export { REPO }`) is still an export of it. A module built on `export *` would under-read, which fails loudly rather than passing.
 */
function exportedNames(file: string): Set<string> {
  const program = ts.createProgram([file], { allowJs: true, noResolve: true, noEmit: true, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  return new Set((moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol)).map((symbol) => symbol.getName()));
}

/** Every way the declaration at `root` fails to deliver `declared`: the subpath missing, its file missing, or a name not exported. */
function interfaceProblems(root: string, declared: Readonly<Record<string, readonly string[]>>): string[] {
  const problems: string[] = [];
  const map = readManifest(root).exports ?? {};
  for (const [subpath, names] of Object.entries(declared)) {
    const target = map[subpath];
    if (target === undefined) {
      problems.push(`${subpath}: not in "exports"`);
      continue;
    }
    if (!existsSync(join(root, target))) {
      problems.push(`${subpath}: "exports" names ${target}, which is no file`);
      continue;
    }
    const exported = exportedNames(join(root, target));
    for (const name of names) if (!exported.has(name)) problems.push(`${subpath}: ${target} does not export ${name}`);
  }
  return problems;
}

test("the exports map holds exactly the declared subpaths", () => {
  const actual = Object.keys(readManifest(ROOT).exports ?? {}).sort();
  assert.deepEqual(actual, [...Object.keys(DECLARED_EXPORTS), ...DATA_EXPORTS].sort());
});

test("Node resolves each declared subpath, through the package name, to the file the map names", () => {
  const map = readManifest(ROOT).exports ?? {};
  // `createRequire`, not `import.meta.resolve`: rstest replaces the latter with an object that has no `resolve`, and Node's own resolver is the point.
  const resolveFromPackage = createRequire(join(ROOT, "package.json")).resolve;
  for (const subpath of Object.keys(DECLARED_EXPORTS)) {
    assert.equal(resolveFromPackage(`agent-org${subpath.slice(1)}`), join(ROOT, map[subpath] as string), subpath);
  }
});

test("every declared subpath carries every name a project's callers use", () => {
  assert.deepEqual(interfaceProblems(ROOT, DECLARED_EXPORTS), []);
  // POSITIVE CONTROL for the emptiness above: the walk visited every subpath and every name, so `[]` is a verdict and not a skipped loop.
  assert.equal(Object.values(DECLARED_EXPORTS).flat().length, 20);
});

test("every declared subcommand is in the command table and names a program that exists", () => {
  const table = COMMANDS as Record<string, string>;
  for (const command of DECLARED_COMMANDS) {
    assert.ok(command in table, `${command} is not an agent-org subcommand`);
    assert.ok(existsSync(join(ROOT, "src", table[command] as string)), `${command} names ${table[command]}, which is no file`);
  }
});

// ---- the controls, on a fixture package, so that the real one is never mutated -------------------------------------------------

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "public-interface-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", exports: { "./thing": "./src/thing.mjs" } }));
  writeFileSync(join(root, "src", "thing.mjs"), "export const kept = 1;\nexport const alsoKept = 2;\n");
  writeFileSync(join(root, "src", "internal.mjs"), "export const unrelated = 3;\n");
  return root;
}
const FIXTURE_DECLARES = { "./thing": ["kept", "alsoKept"] } as const;

test("CONTROL: the fixture as built passes", () => {
  const root = fixture();
  try {
    assert.deepEqual(interfaceProblems(root, FIXTURE_DECLARES), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CONTROL (the row's positive): renaming a source file the declaration does not name leaves the declared list passing", () => {
  const root = fixture();
  try {
    renameSync(join(root, "src", "internal.mjs"), join(root, "src", "renamed-internal.mjs"));
    assert.deepEqual(interfaceProblems(root, FIXTURE_DECLARES), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CONTROL (the row's negative): removing a declared name, or a declared subpath, fails", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "src", "thing.mjs"), "export const kept = 1;\n");
    assert.deepEqual(interfaceProblems(root, FIXTURE_DECLARES), ["./thing: ./src/thing.mjs does not export alsoKept"]);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", exports: {} }));
    assert.deepEqual(interfaceProblems(root, FIXTURE_DECLARES), ["./thing: not in \"exports\""]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CONTROL: renaming a DECLARED target without moving the map entry with it fails, naming the file", () => {
  const root = fixture();
  try {
    renameSync(join(root, "src", "thing.mjs"), join(root, "src", "moved.mjs"));
    assert.deepEqual(interfaceProblems(root, FIXTURE_DECLARES), ['./thing: "exports" names ./src/thing.mjs, which is no file']);
    // ... and moving the map entry with it is the whole remedy: the name a project holds does not change.
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", exports: { "./thing": "./src/moved.mjs" } }));
    assert.deepEqual(interfaceProblems(root, FIXTURE_DECLARES), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
