// no-token: none -- runs this tree's ESLint over text it hands it, reads JSON and source off disk, and runs `git` in a sandbox repository; nothing reaches `gh`, `herdr` or the network
/**
 * (A11-433, R1 of A11-429) NO NEW SYNCHRONOUS SPAWN OR HERDR CALL IN THE BOARD, AND THE FILES THAT STILL MAKE ONE ONLY SHRINK.
 *
 * `eslint.config.ts` refuses `spawnSync`, `execFileSync`, `execSync` and herdr's synchronous runners in `src/ticket-mode/` and `plugins/`, except in the files
 * `blocking-calls.baseline.json` lists: `files`, the ones not yet converted, and `commands`, the CLI entry points a person runs, by name. This file holds that list true:
 *   - THE BAN IS REAL: the real config, run by the real ESLint, refuses each form in a file of either folder and names it, and passes a test file, a file outside the folders,
 *     a baselined file and a named command. A ban that passes everything would pass the tree too.
 *   - THE BASELINE ONLY SHRINKS: it may list no file its base did not (read as `pin-ratchet.ts` reads a base: the first parent on `merge_group`, the merge-base with
 *     `origin/main` on a pull request), and no file the first baseline did not, which holds where no base can be read too. A rise has no door: no declaration excuses one.
 *   - THE BASELINE SAYS ONLY WHAT IS TRUE: every listed file still makes such a call, so the pull request that converts a file drops it, and the lint guards it from then on.
 *   - A COMMAND IS A COMMAND: `blocking-calls-commands.test.ts` holds each named one to a `src/commands.ts` program that no module imports. It reads the whole tree,
 *     so it is a file of its own: `check:changed` selects a tree reader for every source change, and this file starts ESLint.
 *
 * `board-thread-sync-guard.test.ts` keeps each remaining call's loop and rate; this keeps the list of files from growing, and the lint names a new call on the line it is written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eslintEntryOf } from "../../scripts/lint-cache.ts";
import { withGitSandbox, type GitSandbox } from "../lib/git-sandbox.ts";
import { resolveBase, TOOL_REPO_ENV } from "../lib/pin-ratchet.ts";
import { sandboxGitEnv } from "../lib/git-env.ts";
import { tmpDir } from "../lib/tmp-fixture.ts";

/** The tree judged: the checkout `AGENT_ORG_TOOL_REPO` names where it is set, as `gh-call-inventory.ts` reads it (not imported: it walks the tree), else this one. */
const ROOT = process.env[TOOL_REPO_ENV] || fileURLToPath(new URL("../../", import.meta.url));
const BASELINE_FILE = "blocking-calls.baseline.json";
/** ESLint loads the whole config (TypeScript, Astro, the Clean Code plugin) once per process: a few seconds on a loaded runner. */
const ESLINT_TIMEOUT_MS = 120_000;
/** ESLint loads `eslint.config.ts` through jiti, which caches the compiled config under TMPDIR: each run gets a directory the test removes. */
const eslintEnv = (): NodeJS.ProcessEnv => ({ ...process.env, TMPDIR: tmpDir("blocking-calls-jiti-") });
/** The reports of every case come back as one JSON text; node's 1 MiB default would cut it. */
const REPORT_BUFFER_BYTES = 16 * 1024 * 1024;
/** What the ban's message starts with, so its reports are told from every other rule's. */
const BAN = /^A11-433: a synchronous spawn or herdr call holds the board loop/;

type BlockingBaseline = { files: string[]; commands: Record<string, string> };

/** THE FIRST BASELINE (A11-433, step 1), as it was written. The list may only lose files: a file not here is refused wherever no base can be read. */
const FIRST_BASELINE: readonly string[] = [
  "plugins/github/command-exec.ts",
  "plugins/linear/key.ts",
  "src/ticket-mode/hook.ts",
  "src/ticket-mode/pair-command.ts",
  "src/ticket-mode/plugin-contract.ts",
  "src/ticket-mode/pool-herdr.ts",
  "src/ticket-mode/pool-resume.ts",
  "src/ticket-mode/reviewer-port.ts",
  "src/ticket-mode/ui-server.ts",
];

const baselineIn = (root: string): BlockingBaseline => JSON.parse(readFileSync(join(root, BASELINE_FILE), "utf8"));

/** The files `current` lists that `earlier` did not: what a change added to the baseline, which nothing excuses. */
const grownFrom = (current: readonly string[], earlier: readonly string[]): string[] => current.filter((file) => !earlier.includes(file));

/** The baseline's files at the base `repo`'s change merges into, `[]` where the base has no baseline yet, or why the base cannot be read. */
function filesAtBase(repo: string, env: NodeJS.ProcessEnv): { files: string[] } | { unreadable: string } {
  const base = resolveBase(repo, env);
  if ("unreadable" in base) return base;
  const git = (args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: sandboxGitEnv(), stdio: ["ignore", "pipe", "pipe"] });
  // Only a base with no baseline file is "none yet"; any other failure of git throws, so a broken read is never judged as the weaker form under the stronger one's name.
  const listed = git(["ls-tree", "--name-only", base.ref, "--", BASELINE_FILE]).trim();
  if (listed === "") return { files: [] };
  return { files: (JSON.parse(git(["show", `${base.ref}:${BASELINE_FILE}`])) as BlockingBaseline).files };
}

/** One line per file the baseline gained against `repo`'s base; empty when it held or shrank. A base with no baseline yet is judged against the first one. */
function growthAgainstBase(repo: string, env: NodeJS.ProcessEnv = process.env): { grown: string[]; judged: string } {
  const atBase = filesAtBase(repo, env);
  const current = baselineIn(repo).files;
  if ("unreadable" in atBase) return { grown: grownFrom(current, FIRST_BASELINE), judged: `against the first baseline only (${atBase.unreadable})` };
  const earlier = atBase.files.length === 0 ? FIRST_BASELINE : atBase.files;
  return { grown: grownFrom(current, earlier), judged: "against the base" };
}

type LintCase = { filePath: string; text: string };

/** The ban's reports for each case, linted by this tree's ESLint with its real `eslint.config.ts`, in one process so the config loads once. */
function banReports(cases: readonly LintCase[]): string[][] {
  const api = pathToFileURL(createRequire(join(ROOT, "package.json")).resolve("eslint")).href;
  const runner = [
    `const { ESLint } = await import(${JSON.stringify(api)});`,
    "const { readFileSync } = await import('node:fs');",
    "const cases = JSON.parse(readFileSync(0, 'utf8'));",
    "const eslint = new ESLint({ cwd: process.cwd() });",
    "const out = [];",
    "for (const { filePath, text } of cases) out.push((await eslint.lintText(text, { filePath }))[0].messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.message));",
    "process.stdout.write(JSON.stringify(out));",
  ].join("\n");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", runner], { cwd: ROOT, env: eslintEnv(), input: JSON.stringify(cases), encoding: "utf8", maxBuffer: REPORT_BUFFER_BYTES });
  return JSON.parse(out) as string[][];
}

const IMPORTED_CALL = 'import { execFileSync } from "node:child_process";\nexport const head = (): string => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });\n';

/** Each way the ban is written for: a named import (renamed too), a call through the module object, a destructured one, and herdr's synchronous runners. */
const FORMS: Readonly<Record<string, string>> = {
  "a named import and its call": IMPORTED_CALL,
  "a renamed import": 'import { spawnSync as run } from "child_process";\nexport const ls = () => run("ls");\n',
  "a call through the module object": 'import childProcess from "node:child_process";\nexport const ls = () => childProcess.execSync("ls");\n',
  "a destructured one": 'export async function ls() {\n  const { execFileSync } = await import("node:child_process");\n  return execFileSync("ls");\n}\n',
  "herdr's synchronous runner": 'import { herdrRun } from "../herdr-agents.ts";\nexport const list = () => herdrRun(["agent", "list"], 30_000);\n',
  "the context's synchronous herdr": 'export const list = (ctx: { herdr: (args: string[]) => string }) => ctx.herdr(["agent", "list"]);\n',
  "another object's synchronous herdr": 'export const list = (context: { herdr: (args: string[]) => string }) => context.herdr(["agent", "list"]);\n',
  "a herdr runner handed on as a member": 'export const list = (deps: { herdr: { readAgents: (s: string) => unknown } }) => deps.herdr.readAgents("tickets");\n',
  "a renamed herdr import": 'import { readAgentSessions as sessions } from "../herdr-agents.ts";\nexport const list = () => sessions();\n',
};

test("ACCEPTANCE: an execFileSync added to src/ticket-mode/pool-start.ts fails `eslint` and the output names the file", { timeout: ESLINT_TIMEOUT_MS }, () => {
  let failed: { status: number; stdout: string } | undefined;
  try {
    execFileSync(process.execPath, [eslintEntryOf(ROOT), "--stdin", "--stdin-filename", "src/ticket-mode/pool-start.ts"], { cwd: ROOT, env: eslintEnv(), input: IMPORTED_CALL, encoding: "utf8" });
  } catch (error) {
    failed = error as { status: number; stdout: string };
  }
  assert.ok(failed !== undefined, "eslint passed a synchronous spawn in pool-start.ts");
  assert.equal(failed.status, 1, "a lint error, not a crash");
  assert.match(failed.stdout, /src\/ticket-mode\/pool-start\.ts/);
  assert.match(failed.stdout, /A11-433: a synchronous spawn or herdr call holds the board loop/);
});

test("every form is refused in a file of src/ticket-mode/ and of plugins/, and none is refused in a test file, outside the folders, in a baselined file or in a named command", { timeout: ESLINT_TIMEOUT_MS }, () => {
  const baseline = baselineIn(ROOT);
  const command = Object.keys(baseline.commands)[0]!;
  const where = { board: "src/ticket-mode/pool-start.ts", plugin: "plugins/github/pull-view.ts", test: "src/ticket-mode/pool-start.test.ts", outside: "src/lib/pool-start.ts", baselined: baseline.files[0]!, command };
  const cases = Object.entries(FORMS).flatMap(([form, text]) => Object.entries(where).map(([place, filePath]) => ({ form, place, filePath, text })));
  const reports = banReports(cases);
  for (const [index, { form, place, filePath }] of cases.entries()) {
    const refused = reports[index]!.some((message) => BAN.test(message));
    assert.equal(refused, place === "board" || place === "plugin", `${form} in ${filePath} (${place}): ${refused ? "refused" : "allowed"}`);
  }
  const asynchronous = banReports([{ filePath: where.board, text: 'import { execFile } from "node:child_process";\nexport const list = (ctx: { herdrCall: (a: string[]) => Promise<string> }) => { execFile("ls"); return ctx.herdrCall(["agent", "list"]); };\n' }]);
  assert.deepEqual(asynchronous, [[]], "CONTROL: the asynchronous forms pass, so the ban is on the synchronous names and not on child_process or herdr");
  const injected = banReports([{ filePath: where.board, text: "type Deps = { execSync: () => string };\nexport const named = ({ execSync }: Deps): number => (execSync === undefined ? 0 : 1);\n" }]);
  assert.deepEqual(injected, [[]], "CONTROL: a parameter that only names the seam is not a call, so a function handed one is not refused");
});

test("the baseline says only what is true: every listed file and every named command still makes a call the ban refuses", { timeout: ESLINT_TIMEOUT_MS }, () => {
  const baseline = baselineIn(ROOT);
  const listed = [...baseline.files, ...Object.keys(baseline.commands)];
  // Each file's own text, linted as an unlisted file beside it: the ban's verdict on it if it were not excused.
  const reports = banReports(listed.map((file) => ({ filePath: join(dirname(file), "blocking-calls-probe.ts"), text: readFileSync(join(ROOT, file), "utf8") })));
  const clean = listed.filter((_, index) => !reports[index]!.some((message) => BAN.test(message)));
  assert.deepEqual(clean, [], `these files make no synchronous spawn or herdr call any more: take them out of ${BASELINE_FILE}`);
  assert.deepEqual(baseline.files, baseline.files.toSorted(), "the files are sorted, so two pull requests that each drop one merge without a conflict");
});

test("ACCEPTANCE: the baseline only shrinks: it lists no file its base or the first baseline did not", (t) => {
  const { grown, judged } = growthAgainstBase(ROOT);
  t.diagnostic(`${BASELINE_FILE} judged ${judged}`);
  assert.deepEqual(grown, [], `${BASELINE_FILE} grew: make the call asynchronous instead of listing the file`);
  assert.deepEqual(grownFrom(baselineIn(ROOT).files, FIRST_BASELINE), [], "a file the first baseline did not list is refused wherever no base can be read too");
  // On CI the checkout is whole (`fetch-depth: 0`), so the base is there to read; a reading against the first baseline only would be a weaker check wearing this one's name.
  if (process.env.GITHUB_ACTIONS === "true") assert.equal(judged, "against the base");
});

/** `main` holds a baseline of `files` and is `origin/main`; a branch `branch` is checked out off it. Answers how to rewrite the baseline on that branch. */
function branchOffBaseline(box: GitSandbox, files: readonly string[], branch: string): (files: readonly string[]) => void {
  const writeBaseline = (listed: readonly string[]) => writeFileSync(join(box.dir, BASELINE_FILE), JSON.stringify({ files: listed, commands: {} }));
  box.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeBaseline(files);
  box.run(["add", "-A"]);
  box.commit("the baseline");
  box.run(["update-ref", "refs/remotes/origin/main", "main"]);
  box.run(["checkout", "-q", "-b", branch]);
  return writeBaseline;
}

test("NEGATIVE CONTROL: a branch that adds a file to the baseline is refused against its base, naming the file, and one that drops a file is not", () => {
  withGitSandbox((box) => {
    const writeBaseline = branchOffBaseline(box, FIRST_BASELINE, "adds");
    writeBaseline([...FIRST_BASELINE, "src/ticket-mode/pool-start.ts"]);
    const added = growthAgainstBase(box.dir, {});
    assert.equal(added.judged, "against the base", "the base was read, so the refusal is the base's and not the first baseline's");
    assert.deepEqual(added.grown, ["src/ticket-mode/pool-start.ts"]);
    writeBaseline(FIRST_BASELINE.slice(1));
    assert.deepEqual(growthAgainstBase(box.dir, {}).grown, [], "CONTROL: a file dropped is a shrink, which passes");
  });
});

test("NEGATIVE CONTROL: a file converted and dropped earlier cannot come back, though the first baseline listed it", () => {
  withGitSandbox((box) => {
    const writeBaseline = branchOffBaseline(box, FIRST_BASELINE.slice(1), "readds");
    writeBaseline(FIRST_BASELINE);
    assert.deepEqual(growthAgainstBase(box.dir, {}).grown, [FIRST_BASELINE[0]]);
    assert.deepEqual(grownFrom(FIRST_BASELINE, FIRST_BASELINE), [], "CONTROL: the first baseline alone would have let it back, which is why the base is read");
  });
});

test("a base with no baseline file yet is judged against the first baseline, as the pull request that adds the file is", () => {
  withGitSandbox((box) => {
    box.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
    writeFileSync(join(box.dir, "README"), "before the ratchet\n");
    box.run(["add", "-A"]);
    box.commit("no baseline");
    box.run(["update-ref", "refs/remotes/origin/main", "main"]);
    box.run(["checkout", "-q", "-b", "adds-the-ratchet"]);
    writeFileSync(join(box.dir, BASELINE_FILE), JSON.stringify({ files: [...FIRST_BASELINE, "src/ticket-mode/pool-start.ts"], commands: {} }));
    const first = growthAgainstBase(box.dir, {});
    assert.equal(first.judged, "against the base");
    assert.deepEqual(first.grown, ["src/ticket-mode/pool-start.ts"], "the first baseline stands in for the missing one, so even the first pull request cannot list more");
  });
});
