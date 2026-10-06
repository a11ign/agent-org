// no-token: none -- reads source text, and runs test files under `node --test` against a temp directory of its own; nothing here reaches `gh`, `herdr` or `git`
/**
 * (#3848, incident #3846 1a) A TEST THAT MAKES A TEMPORARY DIRECTORY REMOVES IT, AND THIS GUARD FAILS THE SUITE FOR ONE THAT DOES NOT.
 *
 * Measured 2026-10-06 on the agents host: `/tmp` held 121,411 entries and 14 GB, 6,448 of them `verify-stamp-test-*` from one test file that called
 * `mkdtempSync` and never removed. The kernel's soft lockup that day was a `node` in `rmdir` over that directory, so the cheapest `rmdir` is the one
 * never needed, and the next test that forgets is caught here and not by a host.
 *
 * THE RULE, as the row words it: a file that calls `mkdtemp`/`mkdtempSync` or runs `mktemp -d` holds a removal REACHABLE FROM a teardown -- an
 * `after`, `afterEach`, `afterAll`, a `.after(` (`t.after`, `test.after`) or a `finally`. Three things do not count, and each is a control below:
 *   - a removal named only in a COMMENT (the text is stripped first);
 *   - a removal at the end of a test body, which a failed assertion skips -- the directory then outlives exactly the run that needs diagnosing;
 *   - `process.on("exit")`, which is the process's and not the runner's, and a killed worker never reaches it.
 * REACHABLE means the teardown holds a removal call or calls a function of the same file that does, to a fixed point. The file is the unit, so one
 * file that removes one of its two directories counts as cleaning: a floor, as the row says.
 *
 * WHO IS READ: every `*.test.ts`/`*.test.mjs` under `src`, plus `SUPPORT_FILES`, the non-test modules a test builds its fixture with. The tool's own
 * modules are not read: `carry-branch.mjs` removes through `git worktree remove` and `reconstitution-drill.mjs --clone` leaves its clone for the
 * operator on purpose.
 *
 * THE REMEDY IS `lib/tmp-fixture.ts`: `tmpDir(prefix)` is `mkdtempSync` plus the removal in `afterEach`. A file that uses it no longer calls
 * `mkdtemp` and is out of this rule's population, which is why the helper is itself in `SUPPORT_FILES`.
 *
 * THE LIVE READING is the last test: the files this row fixed are run under `node --test` with `TMPDIR` pointing at a directory of this test's own,
 * and that directory must be EMPTY afterwards. The row asks for `/tmp` listed before and after; a directory of its own is the same reading without
 * another session's suite writing into the count. Its positive control runs a script that leaks one and expects the reading to say so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/source-text.ts";

const SRC = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = dirname(SRC);

/** The guard's own file: it holds `mkdtempSync` in fixture strings, and it is excluded in code so the decision sits where a reader meets it. */
const SELF = "src/tmp-fixtures-are-removed.test.ts";

/** Non-test modules that make a fixture directory for a test, and so are held to the same rule. */
const SUPPORT_FILES = [
  "src/lib/tmp-fixture.ts",
  "src/lib/git-sandbox.ts",
  "src/packaging/host-units-project.ts",
];

const MAKES_A_DIRECTORY = /\bmkdtemp(?:Sync)?\b|\bmktemp\s+-d\b/;
const REMOVAL_CALL = /\b(?:rmSync|rmdirSync|rmdir|removeSync|rimraf|rm)\s*\(/;
/** A teardown's opening: the region that follows is the hook's callback, or the `finally` block. */
const TEARDOWN_OPEN = /\b(?:afterEach|afterAll|after)\s*\(|\.after\s*\(|\bfinally\s*\{/g;
const NAMED_FUNCTION = /\bfunction\s+(\w+)\s*\(|\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)|\b(\w+)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>/g;

/** The index just past the bracket that closes the one at `open`, reading past string and template literals. Undefined when unbalanced. */
function closeOf(code: string, open: number): number | undefined {
  const closer: Record<string, string> = { "(": ")", "{": "}" };
  const opener = code[open];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = endOfLiteral(code, i);
    } else if (ch === opener) {
      depth++;
    } else if (ch === closer[opener]) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

function endOfLiteral(code: string, start: number): number {
  const quote = code[start];
  for (let i = start + 1; i < code.length; i++) {
    if (code[i] === "\\") i++;
    else if (code[i] === quote) return i;
  }
  return code.length;
}

/** The text a named function stands for, read from just after its match: braces after any parameter list, or for an arrow the rest of its line. */
function bodyOf(code: string, from: number, matched: string): string {
  const rest = code.slice(from);
  const arrow = matched.endsWith("=>");
  const start = arrow ? rest.search(/\S/) : rest.search(/\{/);
  if (start === -1) return "";
  if (rest[start] !== "{") return rest.slice(start).split("\n")[0];
  const end = closeOf(code, from + start);
  return end === undefined ? "" : code.slice(from + start, end);
}

/** The functions of this file that remove something, directly or by calling one that does. */
function removingFunctions(code: string): Set<string> {
  const bodies = new Map<string, string>();
  for (const match of code.matchAll(NAMED_FUNCTION)) bodies.set(match[1] ?? match[2] ?? match[3], bodyOf(code, match.index + match[0].length, match[0]));
  const removing = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, body] of bodies) {
      if (!removing.has(name) && removes(body, removing)) { removing.add(name); grew = true; }
    }
  }
  return removing;
}

function removes(text: string, removingNames: Set<string>): boolean {
  if (REMOVAL_CALL.test(text)) return true;
  return [...removingNames].some((name) => new RegExp(`\\b${name}\\s*\\(`).test(text));
}

function teardownRegions(code: string): string[] {
  const regions: string[] = [];
  for (const match of code.matchAll(TEARDOWN_OPEN)) {
    const open = match.index + match[0].length - 1;
    const end = closeOf(code, open);
    if (end !== undefined) regions.push(code.slice(open, end));
  }
  return regions;
}

/** Why this file's temporary directories are not reliably removed, or undefined when it makes none or does remove them. */
function unremovedReason(source: string): string | undefined {
  const code = stripComments(source);
  if (!MAKES_A_DIRECTORY.test(code)) return undefined;
  const removing = removingFunctions(code);
  if (teardownRegions(code).some((region) => removes(region, removing))) return undefined;
  return "makes a temporary directory and holds no removal reachable from an after/afterEach/afterAll/.after/finally";
}

function sourceFiles(): string[] {
  const isTest = (path: string) => /\.test\.(?:ts|mjs)$/.test(path);
  const tests = readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((path) => isTest(path) && !path.split("/").includes("node_modules"))
    .map((path) => `src/${path}`);
  return [...tests, ...SUPPORT_FILES].filter((path) => path !== SELF);
}

const read = (path: string) => readFileSync(join(TOOL_ROOT, path), "utf8");

// ---- the controls: the marker, then the remedy it must stop complaining about ----

const LEAKS = `import { mkdtempSync } from "node:fs";\nconst dir = () => mkdtempSync(join(tmpdir(), "x-"));\ntest("a", () => { dir(); });\n`;

test("POSITIVE CONTROL: a file with mkdtempSync and no removal is reported", () => {
  assert.match(unremovedReason(LEAKS) ?? "", /no removal reachable/);
});

test("the same file with a removal in an afterEach, a t.after, an after or a finally is not reported", () => {
  const remedies = [
    `${LEAKS}\nafterEach(() => { rmSync(made, { recursive: true }); });\n`,
    `${LEAKS}\ntest("b", (t) => { t.after(() => rmSync(made, { recursive: true })); });\n`,
    `${LEAKS}\nafter(() => rmSync(made, { recursive: true }));\n`,
    `${LEAKS}\ntest("b", () => { try { dir(); } finally { rmSync(made, { recursive: true }); } });\n`,
    `${LEAKS}\nfunction cleanup() { for (const d of dirs) rmSync(d); }\nfunction teardown() { cleanup(); }\nafterEach(() => teardown());\n`,
    `${LEAKS}\nafterEach(async () => { await rm(made, { recursive: true }); });\n`,
  ];
  for (const source of remedies) assert.equal(unremovedReason(source), undefined, source);
});

test("a removal NAMED in a comment, at the end of a test body, or on process exit does not count", () => {
  const notRemedies = [
    `${LEAKS}\n// afterEach(() => rmSync(made))\n/* after(() => rmSync(made)) */\n`,
    `${LEAKS}\ntest("b", () => { dir(); rmSync(made, { recursive: true }); });\n`,
    `${LEAKS}\nprocess.on("exit", () => rmSync(made, { recursive: true }));\n`,
  ];
  for (const source of notRemedies) assert.match(unremovedReason(source) ?? "", /no removal reachable/, source);
});

test("a shell `mktemp -d` is a directory too, and a file that makes none is out of the population", () => {
  assert.match(unremovedReason("const script = 'd=$(mktemp -d); echo $d';") ?? "", /no removal reachable/);
  assert.equal(unremovedReason("const x = 1; test('a', () => {});"), undefined);
});

test("a file that takes its directory from the shared helper no longer calls mkdtemp, so it is out of the population", () => {
  assert.equal(unremovedReason(`import { tmpDir } from "./lib/tmp-fixture.ts";\ntest("a", () => { tmpDir("x-"); });\n`), undefined);
});

// ---- the population, and the verdict on it ----

test("POPULATION CONTROL: the walk reads many test files, the support files, and the ones that make a directory", () => {
  const files = sourceFiles();
  const makers = files.filter((path) => MAKES_A_DIRECTORY.test(stripComments(read(path))));
  assert.ok(files.length > 300, `read ${files.length} files`);
  assert.ok(makers.length > 100, `${makers.length} of them make a directory`);
  for (const path of SUPPORT_FILES) assert.ok(files.includes(path) && read(path).length > 0, path);
});

test("every test and support file that makes a temporary directory removes it from a teardown", () => {
  const offenders = sourceFiles().flatMap((path) => {
    const reason = unremovedReason(read(path));
    return reason === undefined ? [] : [`${path}: ${reason}`];
  });
  assert.deepEqual(offenders, [], `use lib/tmp-fixture.ts's tmpDir, or register the removal with the runner's own teardown:\n${offenders.join("\n")}`);
});

// ---- the live reading ----

/** tsx's own transform cache (`--import tsx` makes `tsx-<uid>` under `TMPDIR`): one directory per user, reused by every run, and not a test's. */
const TSX_CACHE = /^tsx-\d+$/;

/** What a run left in `dir`: the names, sorted, so a failure says which prefix leaked. */
const leftIn = (dir: string) => readdirSync(dir).filter((name) => !TSX_CACHE.test(name)).sort();

/**
 * The environment the fixed files run in. They import tool modules that REFUSE at import when `AGENT_ORG_HOST` names no project (#3233), so a checkout
 * whose caller exports none -- a reviewer's, or the bare Acceptance command -- failed the live reading on `ingest-state.test.mjs` and not on a leak.
 * The caller's own declaration wins; otherwise the recorded org-health project (the one `clock-feed.test.mjs` runs against) is declared in `scratch`.
 */
function envWithHost(scratch: string, own: string): NodeJS.ProcessEnv {
  const env = { ...process.env, TMPDIR: own };
  if (process.env.AGENT_ORG_HOST) return env;
  const project = join(scratch, "project");
  cpSync(join(SRC, "packaging/fixtures/org-health/project"), project, { recursive: true });
  const hostFile = join(scratch, "host.json");
  writeFileSync(hostFile, JSON.stringify({ schema: 1, home: scratch, binDir: join(scratch, "bin"), primary: "fixture", projects: [{ id: "fixture", checkout: project }],
    gh: { workers: join(scratch, "workers"), leads: join(scratch, "leads"), leadsHeader: [], leadsWorkspaces: [] } }));
  return { ...env, AGENT_ORG_HOST: hostFile };
}

function runUnderOwnTmp(args: string[]): { left: string[], status: number | null, output: string } {
  const own = mkdtempSync(join(tmpdir(), "tmp-fixtures-live-"));
  const scratch = mkdtempSync(join(tmpdir(), "tmp-fixtures-host-"));
  try {
    const run = spawnSync(process.execPath, args, { cwd: TOOL_ROOT, env: envWithHost(scratch, own), encoding: "utf8" });
    return { left: leftIn(own), status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(own, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The families that leaked on 2026-10-06 and are fixed by this row: each is run for real, so a regression to a bare `mkdtempSync` shows as a name. */
const FIXED_FILES = [
  "src/packaging/pr-open-requires-verify-stamp.test.ts",
  "src/packaging/closes-mismatch-check.test.ts",
  "src/packaging/review-attribution.test.ts",
  "src/packaging/trace-weekly-post.test.ts",
  "src/trace/ingest-state.test.mjs",
  "src/packaging/prune-tmp.test.ts",
  "src/packaging/host-units.test.ts",
];

test("LIVE POSITIVE CONTROL: a script that makes a directory and never removes it leaves one, and the reading says so", () => {
  const { left } = runUnderOwnTmp(["-e", 'require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "leaky-"))']);
  assert.equal(left.length, 1);
  assert.match(left[0], /^leaky-/);
});

test("LIVE: running the files this row fixed leaves no entry in the temp directory they were given", { timeout: 600_000 }, () => {
  for (const file of FIXED_FILES) assert.ok(relative(TOOL_ROOT, join(TOOL_ROOT, file)) === file, file);
  const { left, status, output } = runUnderOwnTmp(["--import", "tsx", "--test", ...FIXED_FILES]);
  assert.equal(status, 0, `the fixed files did not pass under node --test, so what they left is not a reading:\n${output.slice(-2000)}`);
  assert.deepEqual(left, []);
});
