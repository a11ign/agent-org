// no-token: gh -- nothing here calls `gh`: the tree is read as text, and `host-pnpm.ts` is handed a PATH and a project of fixtures
/**
 * THE TOOL'S OWN REMEDIES SAY pnpm (a11ign/a11ign#2896, row 9 of 10 of "Finish the move to pnpm", #57).
 *
 * The tool prints `pnpm run ...` as the remedy in its orders and its refusals, and **agents copy a printed remedy literally**: a remedy that
 * says `npm run` sends the reader to the package manager the project left. This reads the tool's own source (`src/`, `host/`, test files
 * excluded) and refuses every line that names an npm command, except where npm is the point. There are three kinds, and the third is
 * decided by a header and not by a list:
 *
 *   - RECOGNISERS: a pattern that must still accept what an older PR body, unit or acceptance says (`LOOKS_LIKE_A_COMMAND` and friends).
 *   - RECORDS: a sentence about what happened (`#2376: "npx failed before execution"`) and a message that names `npm ci` as the one NOT to run.
 *
 * There was a third kind, DECLARED COPIES (a file whose header says `COPIED FROM` an a11ign original, its wording the original's). The tool holds
 * none since a11ign/agent-org#522: the toolchain's libraries are imported, so there is no file here whose wording is not ours to change.
 *
 * Both are listed BY FILE with a reason and PINNED BY COUNT, so a new npm remedy cannot hide in a file that already has one, and a
 * record that is later rewritten (the pin is now too high) is noticed rather than left as a stale exemption. `host/` is pinned the same way
 * for a different reason: the installed bytes of each unit and of the `gh` wrapper are pinned by digest in `host-project-paths.test.ts`, and
 * four comment lines are not worth moving every installed copy to `DIVERGED` until `host:install` is run.
 *
 * `pnpm run X -- --flag` is NOT the pnpm spelling of `npm run X -- --flag`: pnpm hands the literal `--` to the script, so a remedy drops it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pnpmDrift } from "./host-pnpm.ts";
import { stripComments } from "@a11ign/toolchain/lib/local-import-closure";

const TOOL_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The row's own open-check expression: what counts as a line that names an npm command. */
const NPM_COMMAND = /\bnpm (run|ci|install|test|exec)|\bnpx\b/;

/** A remedy or order is refused when it tells its reader to run an npm command. PURE, so the fixtures below can ask it. */
const sendsToNpm = (text: string): boolean => text.split("\n").some((line) => NPM_COMMAND.test(line));

const COPY_HEADER = /^\/\/ COPIED FROM `/m;

/** Where npm is the point, by file: how many lines, and why. The count is pinned, and so is every name. */
const EXEMPT: Record<string, { lines: number; why: string }> = {
  "src/acceptance-commands.ts": { lines: 2, why: "recognisers: `npx agent-org <command>` is the consumer's spelling of the bin, and an acceptance still says `npx`/`npm`" },
  "src/pr-open.ts": { lines: 1, why: "recogniser: a `Mutation:` line written `npm run mutate` in an older PR body still runs" },
  "src/row-file.ts": { lines: 1, why: "recogniser: a body line that starts with `npm`/`npx` looks like a command, whichever manager it names" },
  "src/host-units.ts": { lines: 2, why: "recognisers: an installed unit that still says `npm`/`npx` is followed to its program, as `pnpm` is" },
  "src/update-primary.ts": { lines: 2, why: "records: names `npm ci` as the one command the primary must never run (it deletes `node_modules` from under every worktree)" },
  "src/wake.ts": { lines: 3, why: "records: #2376, a reviewer's `npx` died writing `~/.npm`; the sentence is about what npx did" },
  "host/board-report.service.in": { lines: 2, why: "digest-pinned unit bytes (`host-project-paths.test.ts`): comment lines, see the header" },
  "host/gh": { lines: 1, why: "digest-pinned wrapper bytes (`host-project-paths.test.ts`): a comment line, see the header" },
  "host/work-tick.service.in": { lines: 1, why: "digest-pinned unit bytes (`host-project-paths.test.ts`): a comment line, see the header" },
};

const TEST_FILE = /\.test\.(?:ts|mjs)$/;

/**
 * `src/packaging/` holds the tests and three helpers of the tool's own, and in CI the PROJECT's `packaging/` fixtures and helpers are copied in beside
 * them (`ci.yml`: "the tests' siblings beside the tests"): a walk of it reads a11ign's files, which are not the tool's remedies. Its three own
 * helpers name no npm command at the time of writing (`git grep` over them), and a remedy a test helper prints is not one an operator reads.
 */
const NOT_THE_TOOLS = "src/packaging";

/** Every non-test file under `src/` and `host/`, repo-relative. */
function toolFiles(dir = ""): string[] {
  return readdirSync(join(TOOL_ROOT, dir || "."), { withFileTypes: true }).flatMap((entry) => {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) return (dir === "" && !["src", "host"].includes(entry.name)) || path === NOT_THE_TOOLS ? [] : toolFiles(path);
    return dir === "" || TEST_FILE.test(entry.name) ? [] : [path];
  });
}

const read = (path: string) => readFileSync(join(TOOL_ROOT, path), "utf8");
const linesNamingNpm = (text: string) => text.split("\n").filter((line) => NPM_COMMAND.test(line)).length;

test("a fixture order whose remedy says `npm run work:gate` is REFUSED, and the pnpm spelling passes", () => {
  const order = (remedy: string) => ({ session: "orchestrator", cause: "fixture", prompt: `Do the thing, then run \`${remedy}\` and read it.` });
  assert.equal(sendsToNpm(order("npm run work:gate").prompt), true, "the refusal: this is the defect the row is about");
  assert.equal(sendsToNpm(order("npx tsx --test x.test.ts").prompt), true, "`npx` is refused the same way");
  assert.equal(sendsToNpm(order("npm install --no-save tsx").prompt), true, "and so is `npm install`");
  assert.equal(sendsToNpm(order("pnpm run work:gate").prompt), false, "the pnpm spelling passes");
  assert.equal(sendsToNpm(order("pnpm exec tsx --test x.test.ts").prompt), false, "and so does `pnpm exec`, the spelling of `npx`");
  assert.equal(sendsToNpm("the next `pnpm run work:tick` delivers it"), false, "a sentence that merely contains `pnpm run` is not mistaken for npm");
});

test("the real source tree names no npm command outside the pinned exemptions, and the exemptions are exactly as pinned", () => {
  const files = toolFiles();
  assert.ok(files.length > 100, `POSITIVE CONTROL: the walk read ${files.length} files of src/ and host/, so an empty tree is not an empty pass`);
  assert.deepEqual(files.filter((path) => COPY_HEADER.test(read(path))), [], "a declared copy is back: its npm wording is the original's, so it would need the exemption this test no longer has");
  const offenders = files
    .map((path) => ({ path, lines: linesNamingNpm(read(path)) }))
    .filter(({ lines }) => lines > 0)
    .map(({ path, lines }) => `${path}: ${lines}`);
  const pinned = Object.entries(EXEMPT).map(([path, { lines }]) => `${path}: ${lines}`);
  assert.deepEqual(offenders.sort(), pinned.sort(),
    "every file naming an npm command is pinned with its exact count: a new one is a remedy that says npm, a lower one is a record already rewritten");
  for (const [path, { why }] of Object.entries(EXEMPT)) assert.ok(why.length > 20, `${path} says why npm stays`);
});

test("at least 50 printed remedies are found in the real tree, so a tree whose strings were lost is not an empty pass", () => {
  const remedies = toolFiles().filter((path) => /\.(mjs|ts)$/.test(path))
    .flatMap((path) => [...stripComments(read(path)).matchAll(/\bpnpm run [\w:-]+/g)].map((match) => `${path}: ${match[0]}`));
  assert.ok(remedies.length >= 50, `${remedies.length} printed \`pnpm run <script>\` commands found in code (comments stripped); the tree prints well over 50`);
  assert.ok(remedies.some((remedy) => /work-gate\.ts: pnpm run host:install/.test(remedy)), "and the sample includes the remedy the gate prints");
});

// --- host:check names a pnpm that is missing or does not match `packageManager` --------------------------------------------------------

/** A fixture project whose `package.json` declares `pnpm@<declared>` (nothing when null), and a `bin` that holds a `pnpm` printing `<printed>` (none when null). */
function fixtureHost(declared: string | null, printed: string | null) {
  const root = mkdtempSync(join(tmpdir(), "remedies-say-pnpm-"));
  const bin = join(root, "bin");
  const project = join(root, "project");
  for (const dir of [bin, project]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify(declared === null ? {} : { packageManager: `pnpm@${declared}` }));
  if (printed !== null) {
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh\necho ${printed}\n`);
    chmodSync(join(bin, "pnpm"), 0o755);
  }
  return { root, bin, project };
}

test("`host:check` with no `pnpm` on the PATH names it, naming the version `package.json` declares", () => {
  const fx = fixtureHost("10.34.5", null);
  try {
    const [finding, ...rest] = pnpmDrift({ path: fx.bin, repoRoot: fx.project });
    assert.deepEqual(rest, [], "one finding, not one per PATH entry");
    assert.equal(finding.unit, "pnpm");
    assert.equal(finding.problem, "NOT ON THE PATH");
    assert.match(finding.detail, /pnpm@10\.34\.5/, "it names what to install");
    assert.match(finding.detail, /does not fix this/, "and says the remedy every other finding ends at installs units, not programs");
    assert.equal(sendsToNpm(finding.detail), false, "and no npm spelling anywhere in what it prints");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("`host:check` reads a pnpm that does not match `packageManager`, and says nothing about one that does", () => {
  const wrong = fixtureHost("10.34.5", "9.15.0");
  const right = fixtureHost("10.34.5", "10.34.5");
  try {
    const [differs] = pnpmDrift({ path: wrong.bin, repoRoot: wrong.project });
    assert.equal(differs.problem, "VERSION DIFFERS FROM packageManager");
    assert.match(differs.detail, /is 9\.15\.0.*declares `pnpm@10\.34\.5`/);
    assert.deepEqual(pnpmDrift({ path: right.bin, repoRoot: right.project }), [], "the matched control: the same fixture at the declared version is clean");
  } finally { for (const fx of [wrong, right]) rmSync(fx.root, { recursive: true, force: true }); }
});

test("a project that declares no pnpm is not asked for one: absent is not the same as missing", () => {
  const fx = fixtureHost(null, null);
  try {
    assert.deepEqual(pnpmDrift({ path: fx.bin, repoRoot: fx.project }), [], "no `packageManager`, no finding");
    assert.deepEqual(pnpmDrift({ path: fx.bin, repoRoot: join(fx.root, "no-such-project") }), [], "and an unreadable manifest is not a finding about pnpm either");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
