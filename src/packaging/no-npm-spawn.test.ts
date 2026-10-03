/**
 * NOTHING IN THE TOOL'S `src/` SPAWNS `npm` OR `npx` BUT THE FILES NAMED BELOW (a11ign/a11ign#2889, row 2 of 10 of "Finish the move to pnpm";
 * PORTED from a11ign/a11ign `packages/lab/src/packaging/no-npm-spawn.test.ts` at 95cb57e33 by a11ign/a11ign#3106, where it walked this tool's
 * source as `PENDING: packages/agent-org/` and so never held it to anything).
 *
 * The package manager is `pnpm`. A script that runs `npm run x` inside node is the same defect as one in a brief, and the one nobody sees by
 * reading a manifest, so the programs this tool ships are held to it by a walk of their source. This asks whether a spawn should be of npm at
 * all; whether it is safe on Windows is `lib/npm-cli-executable.mjs`'s question.
 *
 * TWO NAMED FILES, AND THEY ARE NOT THE SAME KIND:
 *
 *   - `ALLOWED`, `src/lib/isolation-gate.mjs`: the CONSUMER half of the isolation gate installs the packed tarballs with npm into a directory
 *     that is not a workspace, because that is the install a user gets. npm is the point. It carries a one-line `STAYS npm` comment, pinned here.
 *   - `DEBT`, `src/update-primary.mjs`: runs `npm run build` in the project's primary checkout. That is a leftover of the npm days, not a
 *     reason, so it is exempt BY NAME with the row that removes it and the entry is deleted with that row. Nothing else is exempt.
 *
 * WHAT THIS CANNOT SEE: a command assembled at run time (`spawn(tool, ...)` with `tool = "npm"`), or `npm` handed to a shell as part of a
 * longer string such as `sh -c "npm run x"`. It reads the literal at the call. `update-primary.mjs` builds its argv as `["npm", "run", "build"]`
 * and reaches `npmCliInvocation("npm", args)` through `runTool`, which is why that one IS seen: the callee-and-literal shape is at the spawn.
 *
 * Test files are not scanned: a fixture is a STRING holding a spawn, as this file's own are. This file READS source as text and spawns nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripComments } from "../lib/source-text.ts";
import { toolSources, type ToolFile } from "./tool-source.ts";

/** The named files that keep npm, and why. The reason is for a reader; the test pins the FILE NAMES. */
const ALLOWED: Record<string, string> = {
  "src/lib/isolation-gate.mjs": "the consumer half installs the packed tarballs with npm, outside any workspace",
};

/** Exempt until the row that owns it lands, and deleted with it. */
const DEBT: Record<string, string> = {
  "src/update-primary.mjs": "`npm run build` in the primary checkout: the project builds with pnpm now; removal is a11ign/a11ign#3108",
};

/** Every comment in an allowlisted file that says why, matched by this exact opening. */
const STAYS_MARKER = /\/\/ STAYS npm\b/;

/**
 * Callee and literal, in the two shapes a spawn of the old tool takes in this tree:
 *   - the argv shape, `anything("npm", ...)` / `npmCliInvocation("npx", ...)`, which catches the helper and a local `run`;
 *   - the command-string shape, `execSync("npm run x")`, on the `child_process` names only, so an error message that begins
 *     with the word `npm` is not mistaken for one;
 *   - the argv shape in a LATER position, `stage(label, "npm", ["run", "x"])`, which a wrapper around `spawnSync` takes
 *     (`lab-pipeline.mjs` did, and the first version of this guard missed it). The literal must be followed by an argv array,
 *     so `join(dir, "node_modules", "npm", "bin")` is not mistaken for one.
 * And a bare `pnpm`, which is the Windows hazard the helper exists for, spelled the new way.
 */
const SPAWN_SHAPES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "an npm/npx spawn", pattern: /\b[\w$.]+\(\s*["'`](npm|npx)["'`]\s*[,)]/g },
  { name: "an npm/npx command with an argv array", pattern: /(?<=,\s*)["'`](npm|npx)["'`]\s*,\s*\[/g },
  { name: "an npm/npx command string", pattern: /\b(?:execSync|exec|execFileSync|execFile|spawnSync|spawn)\(\s*["'`](npm|npx)\s/g },
  { name: "a bare pnpm spawn", pattern: /\b(?:execFileSync|execFile|spawnSync|spawn)\(\s*["'`](pnpm)["'`]/g },
];

type Hit = { line: number; spelling: string; shape: string };

/** Every spawn of the old tool in `source` (comments stripped first, so prose cannot trip it), with its line. */
function spawnsOf(source: string): Hit[] {
  const code = stripComments(source);
  return SPAWN_SHAPES.flatMap(({ name, pattern }) =>
    [...code.matchAll(pattern)].map((match) => ({
      line: code.slice(0, match.index).split("\n").length,
      spelling: match[1],
      shape: name,
    })));
}

/** `file:line: shape` for every spawn in a file that is neither allowlisted nor named debt. */
function refusals(
  sources: Record<string, string>,
  exempt: readonly string[] = [...Object.keys(ALLOWED), ...Object.keys(DEBT)],
): string[] {
  return Object.entries(sources)
    .filter(([path]) => !exempt.includes(path))
    .flatMap(([path, source]) => spawnsOf(source).map((hit) => `${path}:${hit.line}: ${hit.shape} (\`${hit.spelling}\`)`));
}

// ---- the detector, on fixtures ---------------------------------------------------------------------------------------------

test("a fixture spawnSync(\"npm\", ...) is REFUSED, naming the file and the line", () => {
  const source = 'import { spawnSync } from "node:child_process";\n\nspawnSync("npm", ["run", "build"]);\n';
  assert.deepEqual(refusals({ "src/new-script.mjs": source }), ["src/new-script.mjs:3: an npm/npx spawn (`npm`)"]);
});

test("the same spelling in an allowlisted file passes, and in the same file under another name it does not", () => {
  const source = 'spawnSync("npm", ["view", "a11ign"]);\n';
  assert.deepEqual(refusals({ "src/lib/isolation-gate.mjs": source }), []);
  assert.equal(refusals({ "src/lib/isolation-gate-copy.mjs": source }).length, 1);
});

test("an npx call is REFUSED, whether through the helper or a child_process call or a command string", () => {
  assert.deepEqual(refusals({ "src/a.mjs": 'const x = npmCliInvocation("npx", ["tsx", f]);' }), ["src/a.mjs:1: an npm/npx spawn (`npx`)"]);
  assert.deepEqual(refusals({ "src/b.mjs": 'execFileSync("npx", ["tsx"]);' }), ["src/b.mjs:1: an npm/npx spawn (`npx`)"]);
  assert.deepEqual(refusals({ "src/c.mjs": 'execSync("npm run x");' }), ["src/c.mjs:1: an npm/npx command string (`npm`)"]);
  assert.deepEqual(refusals({ "src/d.mjs": "execSync(`npx tsx ${f}`);" }), ["src/d.mjs:1: an npm/npx command string (`npx`)"]);
});

test("an npm spawn handed to a wrapper in a LATER argument is REFUSED (the `stage()` shape), and a path join is not one", () => {
  const wrapped = 'const labJob = (job) => stage(job, "npm", ["run", "lab:job", "--", "-e", `job=${job}`]);';
  assert.deepEqual(refusals({ "src/h.mjs": wrapped }), ["src/h.mjs:1: an npm/npx command with an argv array (`npm`)"]);
  assert.deepEqual(refusals({ "src/i.mjs": 'run(label, "npx", ["tsc"]);' }), ["src/i.mjs:1: an npm/npx command with an argv array (`npx`)"]);
  assert.deepEqual(refusals({ "src/j.mjs": 'join(nodeDir, "node_modules", "npm", "bin", script);' }), []);
  assert.equal(refusals({ "src/k.mjs": 'spawnSync("npm", ["ci"]);' }).length, 1, "a first-argument spawn is one hit, not two");
});

test("a bare pnpm spawn is REFUSED too: it is `pnpm.cmd` on Windows, which CVE-2024-27980 refuses, and the helper is the way", () => {
  assert.deepEqual(refusals({ "src/e.mjs": 'spawnSync("pnpm", ["run", "x"]);' }), ["src/e.mjs:1: a bare pnpm spawn (`pnpm`)"]);
  assert.deepEqual(refusals({ "src/f.mjs": 'const p = pnpmCliInvocation(["run", "x"]); spawnSync(p.command, p.args);' }), []);
});

test("prose and messages that merely name npm are not spawns", () => {
  const source = [
    '// run `spawnSync("npm", ["run", "x"])` -- a comment',
    'const message = "npm run build failed";',
    'warn("npm run build is retired");',
    'throw new Error(`npm ${what} failed`);',
    "",
  ].join("\n");
  assert.deepEqual(refusals({ "src/g.mjs": source }), []);
});

// ---- the real tree ------------------------------------------------------------------------------------------------------------

/** The tool's own non-test source, keyed by path (`tool-source.ts` says what that leaves out). */
const scannedSources = (): Record<string, string> =>
  Object.fromEntries(toolSources().map(({ path, text }: ToolFile) => [path, text]));

test("the real tree: no spawn of npm or npx outside the named files", () => {
  assert.deepEqual(refusals(scannedSources()), []);
});

test("positive control: the walk is not empty, and finds the spawns that ARE exempt, in each named file", () => {
  const sources = scannedSources();
  assert.ok(Object.keys(sources).length > 100, "too few files scanned: the walk is broken, and an empty walk passes everything");
  for (const path of [...Object.keys(ALLOWED), ...Object.keys(DEBT)]) {
    assert.ok(path in sources, `${path} is not in the scanned population`);
    assert.ok(spawnsOf(sources[path]).length > 0, `${path} no longer spawns npm: it is a stale entry, delete it`);
  }
});

test("the exemptions are EXACTLY these named files, so a new one is a decision made here and not a convenience", () => {
  assert.deepEqual(Object.keys(ALLOWED), ["src/lib/isolation-gate.mjs"]);
  assert.deepEqual(Object.keys(DEBT), ["src/update-primary.mjs"]);
});

test("the allowlisted file says in a `STAYS npm` comment why it does", () => {
  const sources = scannedSources();
  for (const path of Object.keys(ALLOWED)) assert.match(sources[path], STAYS_MARKER, `${path} keeps npm without saying why`);
  assert.doesNotMatch("// stays a normal comment", STAYS_MARKER, "the marker is not satisfied by any comment");
});
