// no-token: GH_TOKEN
// #1449: this file reads ci.yml's TEXT for the key `GH_TOKEN:` and never uses a token; that regex is what charged it.
// A CI JOB THAT CAN REACH `gh` MUST CARRY GH_TOKEN — and reaching it is TRANSITIVE.
//
// 2026-09-07: the `board` job failed with `gh: To use GitHub CLI in a GitHub Actions workflow, set the
// GH_TOKEN environment variable`, blocking the morning board PDF. The `ts` job has carried that env for
// months, with a comment naming `board-style.test.ts` (retired 2026-09-10, guard triage 4 of 6 -- see
// docs/operational-lessons.md) as the reason; when the board tests were split into their own job the env
// did not travel with them. Third instance of the #125 shape — a fact stated in one place and relied on
// in another, with nothing comparing them.
//
// THE OBVIOUS TEST WOULD HAVE FOUND NOTHING. Neither board test contains the string `gh` as a command:
// `board-style.test.ts` imported `packages/agent-org/src/board-data.ts`, and it was `collect()` down there that shelled
// out. So this walks each job's test glob AND every local import beneath it, to any depth, and asks
// whether a `gh` spawn is reachable at all.
// #621: `localImports` moved to `packages/guards/src/local-import-closure.ts`, SHARED with `acceptance-commands.ts`
// -- which derives a test's requirements (token/corpus/history) from the identical closure walk. Two
// independently-drifting copies of "what does this file import, one hop, locally" is this repo's own
// most-recorded shape; see that module's header for why `pre-install-import-graph.test.ts` keeps its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { localImports } from "../lib/local-import-closure.ts";
import { SPAWNS_GH } from "../acceptance-commands.ts";

/** Can a `gh` spawn be reached from this file, through any depth of local imports? */
function reachesGh(entry: string, seen = new Set<string>()): boolean {
  if (seen.has(entry) || !existsSync(entry)) return false;
  seen.add(entry);
  if (SPAWNS_GH.test(readFileSync(entry, "utf8"))) return true;
  return localImports(entry).some((next) => reachesGh(next, seen));
}

/** The files a shell glob like `packages/lab/src/packaging/board-*.test.ts` would match, under `root`. */
function filesMatching(root: string, glob: string): string[] {
  const dir = join(root, dirname(glob));
  if (!existsSync(dir)) return [];
  const pattern = new RegExp(`^${dirname(glob) === glob ? glob : glob.slice(dirname(glob).length + 1)}$`
    .replace(/\*/g, "[^/]*").replace(/\./g, "\\.").replace(/\[\^\/\]\\\*/g, "[^/]*"));
  return readdirSync(dir).filter((f) => pattern.test(f)).map((f) => join(dir, f));
}

type Job = { name: string; globs: string[]; hasToken: boolean };

/**
 * Each job of a ci.yml, its literal test globs, and whether it declares GH_TOKEN.
 *
 * Parsed by indentation rather than with a YAML library, the same way `lab-job.mjs` slices its catalogue
 * and for the same reason: this package may not take a YAML dependency (ADR 0004). The ANTI-VACUITY
 * assertion below is what makes that safe — a parse that finds no jobs FAILS rather than passing over an
 * empty set, which is this repository's most-recorded defect and the one a source scrape invites.
 */
function jobs(ciText: string): Job[] {
  const found: Job[] = [];
  let cur: Job | null = null;
  for (const line of ciText.split("\n")) {
    const head = line.match(/^ {2}([a-zA-Z][\w-]*):\s*$/);
    if (head) { if (cur) found.push(cur); cur = { name: head[1], globs: [], hasToken: false }; continue; }
    if (!cur) continue;
    if (/GH_TOKEN:/.test(line)) cur.hasToken = true;
    for (const m of line.matchAll(/["'](packages\/[^"']*\.test\.ts)["']/g)) cur.globs.push(m[1]);
  }
  if (cur) found.push(cur);
  return found;
}

/** The jobs of the project at `root` whose tests can reach a `gh` spawn and declare no GH_TOKEN. */
function offendersAt(root: string): string[] {
  const offenders: string[] = [];
  for (const job of jobs(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"))) {
    const entries = job.globs.flatMap((glob) => filesMatching(root, glob));
    const reaching = entries.filter((f) => reachesGh(f));
    if (reaching.length > 0 && !job.hasToken) {
      offenders.push(`${job.name} (via ${reaching.map((f) => f.slice(root.length + 1)).join(", ")})`);
    }
  }
  return offenders;
}

/** The spawn of `command`, spelled so that THIS file does not itself contain a charged `gh` spawn. */
const spawnOf = (command: string[]) =>
  `import { execFile } from "node:child_process";\nexecFile("${command[0]}", ${JSON.stringify(command.slice(1))}, () => {});\n`;
const GH = ["g", "h"].join("");

/** (#3233) A project built here, not a11ign's checkout: the verdict is about the walker, not about a11ign's jobs. */
function fixtureProject(boardEnv: string): string {
  const root = mkdtempSync(join(tmpdir(), "gh-token-jobs-project-"));
  const tests = join(root, "packages/lab/src/packaging");
  mkdirSync(tests, { recursive: true });
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  // `board-x.test.ts` names no spawn itself; the one in `deep.mjs` is two local imports away.
  writeFileSync(join(tests, "board-x.test.ts"), 'import "./helper.mjs";\n');
  writeFileSync(join(tests, "helper.mjs"), 'import "./deep.mjs";\n');
  writeFileSync(join(tests, "deep.mjs"), spawnOf([GH, "issue", "list"]));
  writeFileSync(join(tests, "plain.test.ts"), spawnOf(["git", "status"]));
  writeFileSync(join(root, ".github/workflows/ci.yml"), [
    "jobs:",
    "  board:",
    ...boardEnv ? ["    env:", `      ${boardEnv}`] : [],
    "    steps:",
    "      - run: node --test \"packages/lab/src/packaging/board-*.test.ts\"",
    "  ts:",
    "    steps:",
    "      - run: node --test \"packages/lab/src/packaging/plain.test.ts\"",
    "",
  ].join("\n"));
  return root;
}

/** Runs `check` against a fixture project and removes it, whatever `check` does. */
function withFixture(boardEnv: string, check: (root: string) => void): void {
  const root = fixtureProject(boardEnv);
  try { check(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a ci.yml parses into its real jobs — a scrape that finds nothing must FAIL, not pass vacuously", () => {
  withFixture("", (root) => {
    const parsed = jobs(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
    assert.deepEqual(parsed.map((j) => j.name), ["board", "ts"], "both jobs are found by name");
    assert.deepEqual(parsed[0].globs, ["packages/lab/src/packaging/board-*.test.ts"]);
    assert.equal(parsed[0].hasToken, false);
  });
});

test("a test reaches `gh` only TRANSITIVELY — the premise this guard rests on", () => {
  // A test file naming no `gh` spawn, whose imports do: grepping the test files alone would find nothing,
  // which is why the walk follows local imports to any depth. (The same shape, in a11ign's own
  // board-document-chrome-resolver.test.ts, was the premise of this guard; its home is a11ign's #3233 row.)
  withFixture("", (root) => {
    const entry = join(root, "packages/lab/src/packaging/board-x.test.ts");
    assert.doesNotMatch(readFileSync(entry, "utf8"), SPAWNS_GH, "the entry names no spawn directly");
    assert.ok(reachesGh(entry), "the spawn two imports away must be reached");
  });
});

test("a job whose tests can reach a `gh` spawn is an offender until it declares GH_TOKEN", () => {
  withFixture("", (root) => {
    assert.deepEqual(offendersAt(root), ["board (via packages/lab/src/packaging/board-x.test.ts)"],
      "`ts` reaches no spawn and is not named; `board` reaches one and declares nothing");
  });
  // POSITIVE CONTROL, same fixture but for the one env line: the emptiness below is the walker's verdict, not a
  // walk that found nothing, because the run above found `board`.
  withFixture("GH_TOKEN: ${{ github.token }}", (root) => {
    assert.deepEqual(offendersAt(root), []);
  });
});

test("#1449: the walker reaches a gh spawn made through `execFile`, and not an `execFile` of another command", () => {
  // The spawns this guard reads are the token charge's (acceptance-commands.ts): a job whose tests spawn gh through a
  // spelling only one of the two recognised would be missed by the other.
  const dir = mkdtempSync(join(tmpdir(), "gh-token-jobs-"));
  try {
    const entry = join(dir, "spawns.mjs");
    writeFileSync(entry, `import { execFile } from "node:child_process";\nexecFile("${["g", "h"].join("")}", ["issue", "list"], () => {});\n`);
    assert.ok(reachesGh(entry), "an execFile spawn of gh must count, or a job running it is missed");
    const control = join(dir, "other.mjs");
    writeFileSync(control, `import { execFile } from "node:child_process";\nexecFile("${["gi", "t"].join("")}", ["status"], () => {});\n`);
    assert.equal(reachesGh(control), false, "CONTROL: an execFile spawn of another command does not");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#1449: this guard reads the token charge's ONE spawn regex -- it imports SPAWNS_GH and declares none of its own", () => {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const code = source.split("\n").filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join("\n");
  // Two spellings of the same module: `agent-org/src/...` where the tool sat in the monorepo, `../...` since this file lives beside it.
  assert.match(code, /import\s*\{\s*SPAWNS_GH\s*\}\s*from\s*"(?:[^"]*agent-org\/src\/|\.\.\/)acceptance-commands\.ts"/,
    "SPAWNS_GH must come from acceptance-commands.ts, the regex the token charge itself uses");
  assert.doesNotMatch(code, /\b(?:const|let|var)\s+SPAWNS_GH\b/,
    "a local SPAWNS_GH is a second copy of the charge's list -- the drift #1449 was filed about");
});
