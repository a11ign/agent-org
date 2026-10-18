// no-token: none -- reads test source text, and runs nothing but the check itself on strings this file holds
//
// A11-84: A TEST NEVER WRITES THE REAL HOME'S BIN DIRECTORY. The incident of 2026-10-17 was a test run with the real `binDir` (a host file copied into a scratch
// project kept it), so the wrapper `~/.local/bin/gh` was rendered from a declaration that named no App. Two things hold it: `writeGhWrapper` refuses a `gh` in the
// real bin directory while `AGENT_ORG_UNDER_TEST` is set (the tripwire, which the rstest config sets), and this file, which reads the test source and fails on a
// call to an identity writer that takes its directories from the machine and not from a fixture.
//
// THE RULE: a test file that calls one of the writers below, or spawns `host-units.ts`, must (a) pass it arguments, not nothing, so it takes the host's
// directories from the host it was given, and (b) make a temporary directory for that host, which is where a fixture's directories live. A spawn of
// `host-units.ts` must also name `AGENT_ORG_HOST`, the host file the child reads, since a child inherits the environment and the environment is the machine's.
// The guard reads source text, so a call it cannot see (through the gate, which spawns `host-units.ts` with the environment it was given) is the tripwire's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "@a11ign/toolchain/lib/source-text";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL_ROOT = dirname(SRC);

/** The writers of the host's identity files, each of which takes its directories from the host it is given. */
const WRITERS = ["hostIdentityInstall", "rerenderGhWrapper", "tickRerenderGhWrapper", "writeGhWrapper", "ownedIdentityFiles", "hostUnitsInstall", "startupGhWrapper"];
/** Something that makes a temporary directory a fixture can live in. */
const MAKES_A_FIXTURE = /\btmpDir\s*\(|\bmkdtemp(?:Sync)?\s*\(|\bscratch\s*\(/;

/** The text of the call whose opening parenthesis is at `open`, or `null` when it is not closed. Strings are read past, roughly, which is enough for call arguments. */
function argumentsOf(code: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    if (code[i] === ")") {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * The calls in one test file's code that take no fixture: an identity writer called with no arguments, or with arguments in a file that makes no temporary
 * directory, and a spawn of `host-units.ts` in a file that never names `AGENT_ORG_HOST`. Returns the offending calls, named, so a failure says where.
 */
export function unfixturedWriters(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  const fixtures = MAKES_A_FIXTURE.test(code);
  for (const name of WRITERS) {
    for (const match of code.matchAll(new RegExp(`(?<![\\w.])${name}\\(`, "g"))) {
      const args = argumentsOf(code, (match.index ?? 0) + name.length);
      if (args === null) continue;
      if (args.trim() === "" || !fixtures) found.push(`${name}(${args.trim().slice(0, 40)}${args.trim().length > 40 ? "…" : ""})`);
    }
  }
  // A spawn is a call whose arguments name the program: `host-units.ts`, or the constant a test holds it in. The file must point the child at a fixture host,
  // by naming AGENT_ORG_HOST or by importing the fixture project, which sets it.
  const pointed = /AGENT_ORG_HOST|host-units-project\.ts/.test(code);
  for (const match of code.matchAll(/(?<![\w.])(?:spawnSync|execFileSync|spawn|execFile|fork)\(/g)) {
    const args = argumentsOf(code, (match.index ?? 0) + match[0].length - 1) ?? "";
    if (/host-units\.ts|HOST_UNITS/.test(args) && !pointed) found.push("a spawn of host-units.ts that names no AGENT_ORG_HOST, so the child reads the machine's host file");
  }
  return found;
}

/** Every test file under `src`, as a path relative to the tool's root. */
function testFiles(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return testFiles(path);
    return /\.test\.(?:ts|mjs)$/.test(entry) ? [relative(TOOL_ROOT, path)] : [];
  });
}

test("A11-84: every test that calls an identity writer, or spawns host-units.ts, passes it a fixture and not the machine's directories", () => {
  const offenders = testFiles()
    .filter((path) => !path.endsWith("tests-never-write-the-real-bin-dir.test.ts"))
    .map((path) => [path, unfixturedWriters(readFileSync(join(TOOL_ROOT, path), "utf8"))] as const)
    .filter(([, found]) => found.length > 0);
  assert.deepEqual(offenders, [], "a test that writes the host's identity files must take its directories from a fixture: see the rule at the top of this file");
});

test("A11-84 POSITIVE CONTROL: a fixture that calls the writer with no directories, and one that spawns host-units with the machine's host file, are both flagged", () => {
  const bare = "import { tickRerenderGhWrapper } from \"../host-units.ts\";\ntest(\"x\", () => { tickRerenderGhWrapper(); });\n";
  assert.deepEqual(unfixturedWriters(bare), ["tickRerenderGhWrapper()"], "a bare call takes the real bin directory");
  const spawned = "import { spawnSync } from \"node:child_process\";\nspawnSync(process.execPath, [\"src/host-units.ts\", \"--json\"]);\n";
  assert.deepEqual(unfixturedWriters(spawned), ["a spawn of host-units.ts that names no AGENT_ORG_HOST, so the child reads the machine's host file"]);
});

test("A11-84 CONTROL: a test that passes its own host and makes a fixture directory is not flagged, and a comment that names a writer is not a call", () => {
  const fixture = "import { hostIdentityInstall } from \"../host-units.ts\";\nimport { tmpDir } from \"../lib/tmp-fixture.ts\";\n"
    + "test(\"x\", () => { const root = tmpDir(\"x-\"); hostIdentityInstall({ host: h, scriptDir: join(root, \"bin\"), out: () => {} }); });\n";
  assert.deepEqual(unfixturedWriters(fixture), []);
  const commented = "// tickRerenderGhWrapper() takes the real bin directory, which a test must not do\ntest(\"x\", () => {});\n";
  assert.deepEqual(unfixturedWriters(commented), []);
  const pointed = "import { spawnSync } from \"node:child_process\";\nspawnSync(process.execPath, [\"src/host-units.ts\", \"--json\"], { env: { ...process.env, AGENT_ORG_HOST: h } });\n";
  assert.deepEqual(unfixturedWriters(pointed), [], "a spawn that names its host file is the fixture's");
});

test("A11-84: the tests in this tree hold the rule now, so the guard is a reading of today's files and not a list kept by hand", () => {
  assert.ok(testFiles().length > 300, `the walk found ${testFiles().length} test files`);
});
