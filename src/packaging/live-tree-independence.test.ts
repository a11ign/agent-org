// no-token: none -- clones a local repository, copies files and runs `node --test` children; nothing here reaches `gh`, and the children it runs are the converted files, which read no `gh` either
/**
 * (#3233) NO LISTED TEST CHANGES ITS VERDICT WHEN A11IGN'S `main` MOVES.
 *
 * agent-org's `gate` job reads a11ign at `PROJECT_REF: main`, so a11ign merging between a pull request's own run and its queue run turned the queue
 * red for a change that did not touch it (agent-org #77 and #79: 16 tests, run 37083070668 and 37083324475, at a11ign `95cb57e3`, where the pull
 * requests' own runs had read `fa359250` and were green). The cause was 18 test files that asserted a11ign's LIVE checkout.
 *
 * THE PROPERTY, MEASURED: this checkout's tool is laid into a clone of a11ign at each of a durable pair of commits (#3097, which repointed every
 * workflow to `agent-org <command>`, lies between them), exactly as `ci.yml`'s `gate` job lays it out, and each converted file runs from the project's
 * root. Both runs must give the SAME verdict for every test, and every verdict must be green.
 *
 * THE POSITIVE CONTROL: `UNCONVERTED_CONTROL` is a test that DOES name a11ign's tree. It is written into each laid-out project and must be green at the
 * first commit and red at the second. Without it a pair that reads nothing, or a runner that finds no tests, would pass for independence.
 *
 * HAND-RUN: the pair needs a clone of a11ign on the host (`HOST_CLONE`), which CI's `gate` job here has none of, so the file skips there and says why.
 */
import { TSX_IMPORT } from "../tsx-import.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sandboxGitEnv } from "../lib/git-env.mjs";

const run = promisify(execFile);

const TOOL_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** This file is excluded from the laid-out copy: a copy that ran itself would clone a11ign again inside each clone. */
const SELF = "live-tree-independence.test.ts";
const HOST_CLONE = "/home/agent/repos/a11y-witness";
/** a11ign before #3097, which every pull request's own run in the incident had read. */
const FIRST_REF = "fa359250ee9ba58545960978f2f8bc4df1ebcdbf";
/** a11ign at #3097's merge: the workflows run `agent-org <command>` and the project holds the tool as a dependency. */
const SECOND_REF = "95cb57e333eb06b8c4b5b8637ed1f10382811f18";

/** The files #3233 converted, by basename. A file deleted outright is removed from this list and its assertions were filed to a11ign. */
const CONVERTED_FILES: readonly string[] = [
  "a-hold-means-cannot-merge",
  "board-discussion",
  "board-liveness",
  "close-rows-sweep",
  "host-units",
  "pre-push-armed-pr",
  "trunk-revert-guard",
  "trunk-revert",
  "trunk-sweep",
  "wake-drain",
  "workflow-run-liveness",
  "row-claim-file-overlap-rule",
  "host-project-paths",
  "org-health",
  "org-health-fleet-and-copies",
  "acceptance-commands",
  "gh-token-jobs",
  "keyed-repo-review",
];

/**
 * A test that NAMES a11ign's tree, as the 18 files did: the trunk workflow runs the close-rows sweep from the monorepo path. #3097 repointed it to
 * `agent-org close-rows-sweep`, so it is green at `FIRST_REF` and red at `SECOND_REF`.
 */
const UNCONVERTED_CONTROL = {
  basename: "unconverted-control",
  source: `import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_CHECKOUT } from "../project-config.ts";

test("the trunk workflow runs the close-rows sweep from the monorepo path", () => {
  const text = readFileSync(join(HOME_CHECKOUT, ".github/workflows/trunk.yml"), "utf8");
  assert.match(text, /node packages\\/agent-org\\/src\\/close-rows-sweep\\.mjs/);
});
`,
} as const;

/** A named reason when the pair cannot be run here, `false` when it can: a skip that fires always is a check that never runs. */
export function skipReason(hostClone: string, refs: readonly string[]): string | false {
  if (!existsSync(join(hostClone, ".git"))) return `no a11ign clone at ${hostClone} (hand-run on the host: CI's gate job here has none)`;
  for (const ref of refs) {
    const known = (() => {
      try {
        execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], { cwd: hostClone, env: sandboxGitEnv(), stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();
    if (!known) return `the clone at ${hostClone} does not hold ${ref.slice(0, 8)} (fetch it first)`;
  }
  return false;
}

export type Verdicts = ReadonlyMap<string, boolean>;

/** Every `ok`/`not ok` line of a TAP stream, keyed by file, nesting depth, title and the ordinal of repeats, so two runs compare test by test. */
export function parseTap(file: string, tap: string): Map<string, boolean> {
  const verdicts = new Map<string, boolean>();
  const seen = new Map<string, number>();
  for (const line of tap.split("\n")) {
    const match = /^(\s*)(not ok|ok) \d+ - (.*?)(?: # (?:SKIP|TODO).*)?$/.exec(line);
    if (!match) continue;
    const [, indent, status, title] = match;
    const base = `${file} | ${indent.length / 4} | ${title}`;
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    verdicts.set(`${base} | #${ordinal}`, status === "ok");
  }
  return verdicts;
}

/** The tests whose verdict differs between two runs, or exists in one only. Empty means the two agree. */
export function differences(first: Verdicts, second: Verdicts): string[] {
  const keys = new Set([...first.keys(), ...second.keys()]);
  const show = (verdict: boolean | undefined): string => (verdict === undefined ? "absent" : verdict ? "green" : "RED");
  return [...keys].filter((key) => first.get(key) !== second.get(key)).map((key) => `${key}: ${show(first.get(key))} -> ${show(second.get(key))}`);
}

const scratchDirs: string[] = [];
after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** What the laid-out project's tests import beyond Node itself: `typescript` is read by the classifier's scan and `yaml` by the workflow readers. */
const DEPENDENCIES: readonly string[] = ["tsx", "typescript", "yaml"];

/**
 * Links each dependency into the project's `node_modules` from wherever THIS checkout resolves it. CI's `gate` job moves the tool's flat
 * `node_modules` to the project's root, so one directory held all three; under pnpm (the agent host, and `pnpm run verify`'s staged copy) `tsx` sits
 * alone in `.pnpm/tsx@x/node_modules`, so linking that directory's parent gave a project with no `typescript`, and the four `acceptance-commands`
 * tests that parse a source with it were red at both commits (#3329).
 */
function linkDependencies(project: string): void {
  const modules = join(project, "node_modules");
  if (existsSync(modules)) return;
  mkdirSync(modules);
  const require = createRequire(import.meta.url);
  for (const name of DEPENDENCIES) symlinkSync(realpathSync(dirname(require.resolve(`${name}/package.json`))), join(modules, name));
}

function cloneAt(ref: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "live-tree-independence-")));
  scratchDirs.push(dir);
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: dir, env: sandboxGitEnv(), stdio: "ignore" });
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", HOST_CLONE, dir], { env: sandboxGitEnv(), stdio: "ignore" });
  git("checkout", "--quiet", ref);
  return dir;
}

const isTest = (path: string): boolean => /\.test\.(ts|mjs)$/.test(path);

/**
 * Leaves a project of the pair imports by their `.mjs` name. `FIRST_REF`'s `.agent-org/plugins/causes.mjs` imports `cause-shape.mjs`; a11ign/a11ign#4272
 * renamed the leaf to `.ts`, so the laid-out copy keeps the old name as a re-export, and the pair still reads what a11ign held at each commit.
 */
const RENAMED_LEAVES: readonly string[] = ["cause-shape"];

function keepOldLeafNames(tool: string): void {
  for (const leaf of RENAMED_LEAVES) writeFileSync(join(tool, "src", `${leaf}.mjs`), `export * from "./${leaf}.ts";\n`);
}

/** The tool at `packages/agent-org` and the project's own helper modules beside the tests, as `ci.yml`'s `gate` job lays them out. */
function layOutTool(project: string): void {
  const tool = join(project, "packages/agent-org");
  rmSync(tool, { recursive: true, force: true });
  cpSync(join(TOOL_ROOT, "src"), join(tool, "src"), { recursive: true, filter: (path) => !path.endsWith(SELF) });
  for (const entry of ["host", ".github", "CHANGELOG.md", "package.json", "LICENSE", "README.md"]) cpSync(join(TOOL_ROOT, entry), join(tool, entry), { recursive: true });
  const siblings = join(project, "packages/lab/src/packaging");
  if (existsSync(siblings)) cpSync(siblings, join(tool, "src/packaging"), { recursive: true, force: false, filter: (path) => !isTest(path) });
  keepOldLeafNames(tool);
  linkDependencies(project);
  execFileSync("git", ["add", "--force", "--intent-to-add", "packages/agent-org"], { cwd: project, env: sandboxGitEnv(), stdio: "ignore" });
}

function writeControl(project: string): void {
  const path = join(project, "packages/agent-org/src/packaging", `${UNCONVERTED_CONTROL.basename}.test.ts`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, UNCONVERTED_CONTROL.source);
}

/** One `node --test` child per file, from the project's root, with no `AGENT_ORG_HOST`: the layout alone says where the project is. */
async function verdictsOf(project: string, basename: string): Promise<Map<string, boolean>> {
  const file = join("packages/agent-org/src/packaging", `${basename}.test.ts`);
  // NODE_TEST_CONTEXT is how a `node --test` child learns it is nested and writes a binary stream instead of the TAP asked for.
  const { AGENT_ORG_HOST: _host, NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const child = await run("node", [...TSX_IMPORT, "--test", "--test-reporter=tap", file], { cwd: project, env, maxBuffer: 1 << 28 }).catch((failed: { stdout?: string }) => failed);
  return parseTap(basename, String((child as { stdout?: string }).stdout ?? ""));
}

const CONCURRENCY = 4;

async function verdictsOfAll(project: string, basenames: readonly string[]): Promise<Map<string, boolean>> {
  const all = new Map<string, boolean>();
  const queue = [...basenames];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const found = await verdictsOf(project, next);
      assert.ok(found.size > 0, `${next} produced no verdicts at all: a runner that finds no tests cannot show independence`);
      for (const [key, verdict] of found) all.set(key, verdict);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return all;
}

const projects = new Map<string, string>();
function projectAt(ref: string): string {
  let project = projects.get(ref);
  if (project === undefined) {
    project = cloneAt(ref);
    layOutTool(project);
    writeControl(project);
    projects.set(ref, project);
  }
  return project;
}

const SKIP = skipReason(HOST_CLONE, [FIRST_REF, SECOND_REF]);
const RUN_MS = 30 * 60_000;

test("#3233: the converted files take the same verdicts at the two a11ign commits, and every one is green", { skip: SKIP, timeout: RUN_MS }, async () => {
  const [first, second] = await Promise.all([FIRST_REF, SECOND_REF].map((ref) => verdictsOfAll(projectAt(ref), CONVERTED_FILES)));
  assert.deepEqual(differences(first, second), [], "a converted file still reads a11ign's tree");
  const red = [...first].filter(([, verdict]) => !verdict).map(([key]) => key);
  assert.deepEqual(red, [], "a converted file is red at both commits");
});

test("#3233 POSITIVE CONTROL: a test that names a11ign's tree is green at the first commit and red at the second", { skip: SKIP, timeout: RUN_MS }, async () => {
  const [first, second] = await Promise.all([FIRST_REF, SECOND_REF].map((ref) => verdictsOf(projectAt(ref), UNCONVERTED_CONTROL.basename)));
  assert.equal(first.size, 1, "the control is one test");
  assert.deepEqual([...first.values()], [true], `the control is green at ${FIRST_REF.slice(0, 8)}`);
  assert.deepEqual([...second.values()], [false], `the control is RED at ${SECOND_REF.slice(0, 8)}, or a pair that reads nothing passes for independence`);
  assert.equal(differences(first, second).length, 1, "the comparison notices the control's verdict moving");
});

test("#3233: the comparison flags a verdict that moves and a test that exists at one commit only, and agrees on two equal runs", () => {
  const tap = "# Subtest: a\n    ok 1 - inner\nok 1 - a\nnot ok 2 - b\nok 3 - c # SKIP why\n";
  const parsed = parseTap("f", tap);
  assert.deepEqual([...parsed.values()], [true, true, false, true], "nested and skipped lines are read, none is dropped");
  assert.deepEqual(differences(parsed, new Map(parsed)), []);
  const moved = new Map(parsed);
  moved.set("f | 0 | b | #0", true);
  moved.delete("f | 0 | c | #0");
  assert.deepEqual(differences(parsed, moved), ["f | 0 | b | #0: RED -> green", "f | 0 | c | #0: green -> absent"]);
});

test("#3233: the pair is skipped only for a stated reason, and runs when the clone and both commits exist", () => {
  const missing = skipReason(join(tmpdir(), "no-such-a11ign-clone"), [FIRST_REF]);
  assert.match(String(missing), /no a11ign clone at .*no-such-a11ign-clone/);
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "live-tree-independence-skip-")));
  scratchDirs.push(repo);
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, env: sandboxGitEnv(), encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "one");
  assert.match(String(skipReason(repo, [FIRST_REF])), /does not hold fa359250/, "a clone without the commit is refused by name, not run");
  assert.equal(skipReason(repo, [git("rev-parse", "HEAD")]), false, "a clone that holds what is asked is not skipped");
});
