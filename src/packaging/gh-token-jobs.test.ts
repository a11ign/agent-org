// A CI JOB THAT CAN REACH `gh` MUST CARRY GH_TOKEN — and reaching it is TRANSITIVE.
//
// 2026-09-07: the `board` job failed with `gh: To use GitHub CLI in a GitHub Actions workflow, set the
// GH_TOKEN environment variable`, blocking the morning board PDF. The `ts` job has carried that env for
// months, with a comment naming `board-style.test.ts` as the reason; when the board tests were split into
// their own job the env did not travel with them. Third instance of the #125 shape — a fact stated in one
// place and relied on in another, with nothing comparing them.
//
// THE OBVIOUS TEST WOULD HAVE FOUND NOTHING. Neither board test contains the string `gh` as a command:
// `board-style.test.ts` imports `scripts/board-data.mjs`, and it is `collect()` down there that shells
// out. So this walks each job's test glob AND every local import beneath it, to any depth, and asks
// whether a `gh` spawn is reachable at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const CI = join(REPO, ".github/workflows/ci.yml");

/** A `gh` invocation, not the two letters. `execFileSync("gh", …)` and `run("gh", …)` both count. */
const SPAWNS_GH = /(?:execFileSync|execSync|spawnSync|spawn|run)\s*\(\s*(['"`])gh\1/;

/** Every local (relative) import a module names. Bare specifiers are out of scope — they are packages. */
function localImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    const raw = resolve(dirname(file), m[1]);
    for (const cand of [raw, `${raw}.ts`, `${raw}.mjs`, `${raw}.js`, join(raw, "index.ts")]) {
      if (existsSync(cand) && !cand.endsWith("/")) { out.push(cand); break; }
    }
  }
  return out;
}

/** Can a `gh` spawn be reached from this file, through any depth of local imports? */
function reachesGh(entry: string, seen = new Set<string>()): boolean {
  if (seen.has(entry) || !existsSync(entry)) return false;
  seen.add(entry);
  if (SPAWNS_GH.test(readFileSync(entry, "utf8"))) return true;
  return localImports(entry).some((next) => reachesGh(next, seen));
}

/** The files a shell glob like `packages/lab/src/packaging/board-*.test.ts` would match. */
function filesMatching(glob: string): string[] {
  const dir = join(REPO, dirname(glob));
  if (!existsSync(dir)) return [];
  const pattern = new RegExp(`^${dirname(glob) === glob ? glob : glob.slice(dirname(glob).length + 1)}$`
    .replace(/\*/g, "[^/]*").replace(/\./g, "\\.").replace(/\[\^\/\]\\\*/g, "[^/]*"));
  return readdirSync(dir).filter((f) => pattern.test(f)).map((f) => join(dir, f));
}

/**
 * Each ci.yml job, its literal test globs, and whether it declares GH_TOKEN.
 *
 * Parsed by indentation rather than with a YAML library, the same way `lab-job.mjs` slices its catalogue
 * and for the same reason: this package may not take a YAML dependency (ADR 0004). The ANTI-VACUITY
 * assertion below is what makes that safe — a parse that finds no jobs FAILS rather than passing over an
 * empty set, which is this repository's most-recorded defect and the one a source scrape invites.
 */
function jobs(): { name: string; globs: string[]; hasToken: boolean }[] {
  const lines = readFileSync(CI, "utf8").split("\n");
  const found: { name: string; globs: string[]; hasToken: boolean }[] = [];
  let cur: { name: string; globs: string[]; hasToken: boolean } | null = null;
  for (const line of lines) {
    const head = line.match(/^ {2}([a-zA-Z][\w-]*):\s*$/);
    if (head) { if (cur) found.push(cur); cur = { name: head[1], globs: [], hasToken: false }; continue; }
    if (!cur) continue;
    if (/GH_TOKEN:/.test(line)) cur.hasToken = true;
    for (const m of line.matchAll(/["'](packages\/[^"']*\.test\.ts)["']/g)) cur.globs.push(m[1]);
  }
  if (cur) found.push(cur);
  return found;
}

test("ci.yml parses into real jobs — a scrape that finds nothing must FAIL, not pass vacuously", () => {
  const parsed = jobs();
  assert.ok(parsed.length >= 5, `only ${parsed.length} job(s) parsed out of ci.yml; the scrape has broken`);
  assert.ok(parsed.some((j) => j.name === "board"), "the `board` job must be found by name");
  assert.ok(parsed.some((j) => j.name === "ts"), "the `ts` job must be found by name");
});

test("board-style.test.ts reaches `gh` only TRANSITIVELY — the premise this guard rests on", () => {
  const entry = join(REPO, "packages/lab/src/packaging/board-style.test.ts");
  assert.ok(existsSync(entry), "board-style.test.ts must exist for this guard to mean anything");
  assert.doesNotMatch(readFileSync(entry, "utf8"), SPAWNS_GH,
    "board-style.test.ts names a `gh` spawn directly — if that is now true, a test grepping the test "
    + "files alone would suffice and this walker's reason for existing has changed");
  assert.ok(reachesGh(entry), "board-style.test.ts must reach a `gh` spawn through its local imports; "
    + "if it no longer does, this guard is protecting nothing and should be re-scoped");
});

test("every ci.yml job whose tests can reach a `gh` spawn declares GH_TOKEN", () => {
  const offenders: string[] = [];
  for (const job of jobs()) {
    const entries = job.globs.flatMap(filesMatching);
    if (entries.length === 0) continue;
    const reaching = entries.filter((f) => reachesGh(f));
    if (reaching.length > 0 && !job.hasToken) {
      offenders.push(`${job.name} (via ${reaching.map((f) => f.slice(REPO.length + 1)).join(", ")})`);
    }
  }
  assert.deepEqual(offenders, [],
    "these ci.yml jobs run tests that can reach a `gh` spawn and declare no GH_TOKEN. `gh` fails in "
    + "Actions without it, and the failure names the env var rather than the test, so it reads as a "
    + "broken test. Add `env: { GH_TOKEN: ${{ github.token }} }` to the job.");
});
