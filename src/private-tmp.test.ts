/**
 * #3854 (incident a11ign/a11ign#3846): every test run gets a private `TMPDIR`, removed when the run ends, and a test file that leaves anything in it is named.
 *
 * Two layers. The library functions are read directly, and the BEHAVIOUR is read by running real `rstest` children over fixture files (a leaker, a clean file,
 * a failing file), because a teardown that "also runs on a failed run" is a claim about rstest that no unit test of ours can make. The children keep their
 * runs under this file's own private TMPDIR through `A11Y_PRIVATE_TMP_BASE`, so the test never touches `~/.cache/a11ign/tmp`.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BASE_ENV,
  LEAK_POLICY_ENV,
  RUN_ROOT_ENV,
  createRunRoot,
  describeEntry,
  enterFileDir,
  fileDirName,
  findLeaks,
  finishRun,
  leakReport,
  privateBase,
  removeRunRoot,
  requirePrivate,
  testFileOf,
} from "./private-tmp.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SETUP = fileURLToPath(new URL("./private-tmp.ts", import.meta.url));
const FILE_SETUP = fileURLToPath(new URL("./private-tmp-setup.ts", import.meta.url));

// The nearest `node_modules/.bin/rstest` above the package: CI checks the tool out inside a monorepo whose `node_modules` is at the root, not beside `src/`.
function findRstest(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ".bin", "rstest");
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error(`no node_modules/.bin/rstest in ${from} or any directory above it`);
  }
}
const RSTEST = findRstest(REPO);

// The real config is read only when it is there: ci.yml's `agentOrg` job lays the tool out WITHOUT `scripts/` (a11ign/a11ign#3872), so a static import
// of it would fail this whole file at load (and the config is imported only where it exists), and under `tsx --test` (what `pnpm run verify` runs) the file's other tests are still worth running.
const CONFIG_PATH = join(REPO, "scripts", "rstest", "rstest.config.ts");
const config: { globalSetup?: string[]; setupFiles?: string[] } | undefined = existsSync(CONFIG_PATH)
  ? (await import(pathToFileURL(CONFIG_PATH).href)).default
  : undefined;

// `os.tmpdir()` is already this file's private directory when the suite runs under its own config, which is what the LIVE test below asserts.
const scratch = mkdtempSync(join(tmpdir(), "private-tmp-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function freshBase(name: string): string {
  const base = join(scratch, name);
  mkdirSync(base, { recursive: true });
  return base;
}

test("requirePrivate refuses empty, unset, relative and shared paths, and accepts a run root and what is inside it", () => {
  const base = freshBase("guard");
  assert.throws(() => requirePrivate("", base), /empty or unset/);
  assert.throws(() => requirePrivate(undefined, base), /empty or unset/);
  assert.throws(() => requirePrivate("run-x/a", base), /relative/);
  assert.throws(() => requirePrivate("/tmp", base), /not a run root/);
  assert.throws(() => requirePrivate(base, base), /not a run root/);
  assert.throws(() => requirePrivate(join(base, "not-a-run", "a"), base), /not a run root/);
  assert.throws(() => requirePrivate(join(base, "run-1", "..", ".."), base), /not a run root/);
  assert.throws(() => requirePrivate(`${base}-sibling/run-1`, base), /not a run root/);
  assert.equal(requirePrivate(join(base, "run-1"), base), join(base, "run-1"));
  assert.equal(requirePrivate(join(base, "run-1", "a", "b"), base), join(base, "run-1", "a", "b"));
});

test("removeRunRoot with the TMPDIR-shaped inputs the incident came from: an empty value and the shared directory both refuse and delete nothing", async () => {
  const base = freshBase("refuse");
  const witness = join(base, "witness.txt");
  writeFileSync(witness, "x");
  for (const bad of ["", base, "/tmp"]) await assert.rejects(removeRunRoot(bad, base), /private-tmp: refusing/);
  assert.ok(existsSync(witness), "a refused removal leaves the base alone");
});

test("a file's directory is named from its path and read back out of it, and TMPDIR is pointed at it", async () => {
  const base = freshBase("enter");
  const runRoot = await createRunRoot({ base, now: new Date("2026-10-06T12:00:00.000Z"), pid: 7 });
  assert.match(runRoot, /\/run-20261006T120000Z-7-[0-9a-f]{6}$/);
  const env: NodeJS.ProcessEnv = {};
  const dir = await enterFileDir({ runRoot, testPath: "/p/src/a/b.test.ts", projectRoot: "/p", env, base });
  assert.equal(env.TMPDIR, dir);
  assert.equal(dir, join(runRoot, fileDirName("/p/src/a/b.test.ts", "/p")));
  assert.equal(testFileOf(fileDirName("/p/src/a/b.test.ts", "/p")), "src/a/b.test.ts");
  // The name goes into `file:` URLs and systemd unit lines in the tests that build them from TMPDIR, so it stays in host-config's UNIT_SAFE_PATH alphabet (no `%`).
  for (const path of ["src/a/b.test.ts", "src/x@y/c@-d.test.mjs", "src/@/@@-/z.test.ts"]) {
    assert.match(fileDirName(`/p/${path}`, "/p"), /^[A-Za-z0-9_.@-]+$/);
    assert.equal(testFileOf(fileDirName(`/p/${path}`, "/p")), path);
  }
  await assert.rejects(enterFileDir({ runRoot: undefined, testPath: "/p/x.test.ts", projectRoot: "/p", env, base }), /empty or unset/);
  await assert.rejects(enterFileDir({ runRoot: "", testPath: "/p/x.test.ts", projectRoot: "/p", env, base }), /empty or unset/);
  await removeRunRoot(runRoot, base);
  assert.equal(existsSync(runRoot), false);
});

test("findLeaks names a file whose directory holds something, not one whose directory is empty or absent; leakReport says so and is silent otherwise", async () => {
  const base = freshBase("leaks");
  const runRoot = await createRunRoot({ base });
  const env: NodeJS.ProcessEnv = {};
  await enterFileDir({ runRoot, testPath: "/p/src/clean.test.ts", projectRoot: "/p", env, base });
  const leakerDir = await enterFileDir({ runRoot, testPath: "/p/src/leaker.test.ts", projectRoot: "/p", env, base });
  for (const name of ["a", "b", "c", "d", "e", "f", "g"]) mkdirSync(join(leakerDir, name, "deep"), { recursive: true });
  const cacheOnlyDir = await enterFileDir({ runRoot, testPath: "/p/src/cache-only.test.ts", projectRoot: "/p", env, base });
  for (const name of ["tsx-1000", "v8-compile-cache-1000", "node-compile-cache"]) mkdirSync(join(cacheOnlyDir, name));
  mkdirSync(join(leakerDir, "tsx-1000-mine"));
  mkdirSync(join(leakerDir, "node-compile-cache-mine"));
  const leaks = await findLeaks(runRoot, base);
  assert.deepEqual(leaks.map(({ file }) => file), ["src/leaker.test.ts"], "the runtime's own caches are not a leak, and a look-alike name still is");
  assert.deepEqual(leaks[0]?.entries, ["a", "b", "c", "d", "e", "f", "g", "node-compile-cache-mine", "tsx-1000-mine"]);
  const [headline, line] = leakReport(leaks);
  assert.match(headline ?? "", /1 test file\(s\) left something/);
  assert.match(line ?? "", /src\/leaker\.test\.ts left 9 in its TMPDIR: a, b, c, d, e, \.\.\. and 4 more/);
  assert.deepEqual(leakReport([]), []);
  await removeRunRoot(runRoot, base);
  assert.equal(existsSync(runRoot), false, "a run root with a nested tree is gone");
});

// ---- what each leaked entry is (agent-org#939: main went red twice on one `a11y-git-sandbox-*` and the report could not say what made it) --------------------

/** The report line as it was before the details were appended: the new line must begin with it, so the log greps that read it keep matching. */
const earlierLine = (file: string, names: string[]) => `  ${file} left ${names.length} in its TMPDIR: ${names.join(", ")}`;

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const touch = (path: string, msBeforeNow: number) => utimesSync(path, new Date(NOW - msBeforeNow), new Date(NOW - msBeforeNow));

async function leakerDir(name: string, testPath = "/p/src/leaker.test.ts"): Promise<{ base: string; runRoot: string; dir: string }> {
  const base = freshBase(name);
  const runRoot = await createRunRoot({ base });
  const dir = await enterFileDir({ runRoot, testPath, projectRoot: "/p", env: {}, base });
  return { base, runRoot, dir };
}

test("a leaked directory is reported as a directory with its entry count, its first three names and its age; the earlier line is a prefix of the new one", async () => {
  const { base, runRoot, dir } = await leakerDir("detail-dir");
  const sandbox = join(dir, "a11y-git-sandbox-bhoTMu");
  mkdirSync(join(sandbox, ".git"), { recursive: true });
  writeFileSync(join(sandbox, "a.txt"), "x");
  writeFileSync(join(sandbox, "b.txt"), "x");
  touch(sandbox, 120);
  const wide = join(dir, "wide");
  mkdirSync(wide);
  for (const name of ["a", "b", "c", "d", "e"]) writeFileSync(join(wide, name), "x");
  touch(wide, 185_000);
  const leaks = await findLeaks(runRoot, base, { now: NOW });
  assert.deepEqual(leaks[0]?.details, [
    { name: "a11y-git-sandbox-bhoTMu", kind: "directory", count: 3, first: [".git", "a.txt", "b.txt"], ageMs: 120 },
    { name: "wide", kind: "directory", count: 5, first: ["a", "b", "c"], ageMs: 185_000 },
  ]);
  const [, line = ""] = leakReport(leaks);
  assert.ok(line.startsWith(earlierLine("src/leaker.test.ts", ["a11y-git-sandbox-bhoTMu", "wide"])), line);
  assert.match(line, /a11y-git-sandbox-bhoTMu: directory of 3 entries \(\.git, a\.txt, b\.txt\), modified 120ms before the teardown/);
  assert.match(line, /wide: directory of 5 entries \(a, b, c, \.\.\.\), modified 3m05s before the teardown/);
  await removeRunRoot(runRoot, base);
});

test("an empty directory, a plain file and a symlink are each reported as what they are, the file with its age and no entry count", async () => {
  const { base, runRoot, dir } = await leakerDir("detail-file");
  mkdirSync(join(dir, "a-empty"));
  writeFileSync(join(dir, "b-file"), "x");
  touch(join(dir, "b-file"), 5000);
  symlinkSync("/nonexistent-target", join(dir, "c-link"));
  const leaks = await findLeaks(runRoot, base, { now: NOW });
  const [empty, file, link] = leaks[0]?.details ?? [];
  assert.equal(empty?.kind, "directory");
  assert.deepEqual(file, { name: "b-file", kind: "file", ageMs: 5000 });
  assert.equal(link?.kind, "other", "a symlink is read as itself, and a dangling one is not 'vanished'");
  const [, line = ""] = leakReport(leaks);
  assert.match(line, /a-empty: empty directory, modified/);
  assert.match(line, /b-file: file, modified 5\.0s before the teardown(;|$)/, "a file carries no entry count");
  assert.match(line, /c-link: not a file or directory, modified/);
  await removeRunRoot(runRoot, base);
});

test("NEGATIVE CONTROL: an entry that vanishes between the directory read and the lstat, and one that cannot be read, are each reported and each still a leak", async () => {
  const { base, runRoot, dir } = await leakerDir("detail-unreadable");
  mkdirSync(join(dir, "a-gone"));
  writeFileSync(join(dir, "b-kept"), "x");
  // The race, made deterministic: the entry is removed after the directory read listed it and before it is described.
  const removingFirst: typeof describeEntry = async (parent, name, now) => {
    if (name === "a-gone") rmSync(join(parent, name), { recursive: true });
    return describeEntry(parent, name, now);
  };
  const leaks = await findLeaks(runRoot, base, { now: NOW, describe: removingFirst });
  assert.deepEqual(leaks[0]?.entries, ["a-gone", "b-kept"], "the vanished entry is still counted");
  assert.deepEqual(leaks[0]?.details[0], { name: "a-gone", kind: "vanished" });
  assert.match(leakReport(leaks)[1] ?? "", /left 2 in its TMPDIR: a-gone, b-kept; a-gone: vanished before it could be read; b-kept: file/);
  assert.deepEqual(await describeEntry(dir, "never-existed", NOW), { name: "never-existed", kind: "vanished" });

  // `chmod 000` is not a barrier to root, so as root this half cannot be read and says so rather than passing on nothing.
  if (process.getuid?.() === 0) return console.warn("private-tmp.test: the unreadable-directory half is not read, because this process is root and can read a mode-000 directory");
  const locked = join(dir, "c-locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const read = await findLeaks(runRoot, base, { now: NOW });
    assert.ok(read[0]?.entries.includes("c-locked"), "an unreadable entry is still a leak");
    const detail = read[0]?.details.find(({ name }) => name === "c-locked");
    assert.deepEqual(detail, { name: "c-locked", kind: "unreadable", reason: "EACCES" });
    assert.match(leakReport(read)[1] ?? "", /c-locked: unreadable \(EACCES\)/);
  } finally {
    chmodSync(locked, 0o700);
    await removeRunRoot(runRoot, base);
  }
});

test("a tidy run and a directory holding only the runtime's caches report nothing and stay green; a leak is red by default and green under `report`", async () => {
  const tidy = await leakerDir("policy-tidy", "/p/src/tidy.test.ts");
  const cacheOnly = await enterFileDir({ runRoot: tidy.runRoot, testPath: "/p/src/cache.test.ts", projectRoot: "/p", env: {}, base: tidy.base });
  for (const name of ["tsx-1000", "v8-compile-cache-1000", "node-compile-cache"]) mkdirSync(join(cacheOnly, name));
  const written: string[] = [];
  const write = (line: string) => written.push(line);
  assert.deepEqual(await findLeaks(tidy.runRoot, tidy.base, { now: NOW }), []);
  await finishRun({ runRoot: tidy.runRoot, base: tidy.base, env: {}, write });
  assert.deepEqual(written, [], "nothing is said");
  assert.equal(existsSync(tidy.runRoot), false);

  const leaking = await leakerDir("policy-leak");
  mkdirSync(join(leaking.dir, "left-behind"));
  await assert.rejects(finishRun({ runRoot: leaking.runRoot, base: leaking.base, env: {}, write }), /1 test file\(s\) left something/);
  assert.match(written.join("\n"), /src\/leaker\.test\.ts left 1 in its TMPDIR: left-behind; left-behind: empty directory, modified/);
  assert.equal(existsSync(leaking.runRoot), false, "the run root is removed even when the run is red");

  const reported = await leakerDir("policy-report");
  mkdirSync(join(reported.dir, "left-behind"));
  await finishRun({ runRoot: reported.runRoot, base: reported.base, env: { [LEAK_POLICY_ENV]: "report" }, write });
});

// ---- the behaviour, through real rstest runs -----------------------------------------------------------------------------------------------------------

const LEAKER = `test("leaks a directory", () => { const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  fs.mkdirSync(path.join(os.tmpdir(), "left-behind-dir")); });`;
const TIDY = `test("makes a directory and removes it", () => { const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const d = path.join(os.tmpdir(), "removed-dir"); fs.mkdirSync(d); fs.rmdirSync(d); });`;
const FAILING = `test("fails after leaving a file", () => { const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  fs.writeFileSync(path.join(os.tmpdir(), "left-by-failure"), "x"); throw new Error("this fixture fails on purpose"); });`;

const REPORT_ONLY = { [LEAK_POLICY_ENV]: "report" };

type Run = { status: number | null; output: string; base: string; runs: string[] };

function runFixture(name: string, files: Record<string, string>, extraEnv: NodeJS.ProcessEnv = {}): Run {
  const dir = join(scratch, name);
  const base = join(dir, "base");
  mkdirSync(base, { recursive: true });
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body);
  writeFileSync(
    join(dir, "rstest.config.ts"),
    `export default { root: ${JSON.stringify(dir)}, include: ["*.fixture.test.js"], globals: true, pool: { type: "forks" },
       globalSetup: [${JSON.stringify(SETUP)}], setupFiles: [${JSON.stringify(FILE_SETUP)}] };`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, [BASE_ENV]: base, RSTEST_NO_AGENT: "1" };
  delete env[RUN_ROOT_ENV];
  const result = spawnSync(RSTEST, ["run", "--config", join(dir, "rstest.config.ts")], { cwd: dir, env, encoding: "utf8" });
  assert.equal(result.error, undefined, `the child rstest did not start: ${result.error?.message}`);
  return { status: result.status, output: `${result.stdout}${result.stderr}`, base, runs: readdirSync(base) };
}

test("POSITIVE CONTROL: a file that leaves a directory is named with the entry, and under `report` the run still passes and leaves no run root", () => {
  const run = runFixture("leaker", { "leaky.fixture.test.js": LEAKER, "tidy.fixture.test.js": TIDY }, REPORT_ONLY);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /leaky\.fixture\.test\.js left 1 in its TMPDIR: left-behind-dir/);
  assert.match(run.output, /left-behind-dir: empty directory, modified \d+(ms|\.\ds) before the teardown/, "and says what it is and how old it was");
  assert.equal(run.output.includes("tidy.fixture.test.js left"), false, "the same kind of file with a removal is not named");
  assert.deepEqual(run.runs, [], "the run root is removed when the run ends");
});

test("a run in which a test FAILS still names the leaker and still removes the run root", () => {
  const run = runFixture("failing", { "failing.fixture.test.js": FAILING, "tidy.fixture.test.js": TIDY }, REPORT_ONLY);
  assert.notEqual(run.status, 0, "the fixture failure is the run's failure");
  assert.match(run.output, /failing\.fixture\.test\.js left 1 in its TMPDIR: left-by-failure/);
  assert.deepEqual(run.runs, []);
});

test("a run with only tidy files says nothing about TMPDIR and leaves no run root", () => {
  const run = runFixture("tidy", { "tidy.fixture.test.js": TIDY });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.output.includes("private-tmp:"), false);
  assert.deepEqual(run.runs, []);
});

test("BY DEFAULT a leaking run is red, names the leaker, and still removes the run root; the same files tidy are green", () => {
  const leaky = runFixture("policy", { "leaky.fixture.test.js": LEAKER, "tidy.fixture.test.js": TIDY });
  assert.notEqual(leaky.status, 0, leaky.output);
  assert.match(leaky.output, /leaky\.fixture\.test\.js left 1/);
  assert.deepEqual(leaky.runs, []);
  assert.equal(runFixture("policy-tidy", { "tidy.fixture.test.js": TIDY }).status, 0);
});

// ---- the wiring, read on THIS run ----------------------------------------------------------------------------------------------------------------------

/**
 * Why the LIVE test cannot be read here, or `undefined` when it can. The test reads a run of agent-org's OWN rstest config: the config must be on disk, and the
 * run root its globalSetup publishes must be in the environment. Under another runner there is nothing to read, so the test is skipped with its reason
 * and not failed (a11ign/a11ign#3872); the wiring is still read by every `rstest run` of this repository, which is the run that matters.
 */
function liveSkipReason(input: { config: unknown; env: NodeJS.ProcessEnv }): string | undefined {
  if (input.config === undefined) return "scripts/rstest/rstest.config.ts is not laid out beside this file (ci.yml's agentOrg job copies no scripts/)";
  if (!input.env[RUN_ROOT_ENV]) return `${RUN_ROOT_ENV} is unset: this run is not agent-org's own rstest config, whose globalSetup publishes it`;
  return undefined;
}

test("liveSkipReason skips for an absent config and for an unset run root, and names each reason; it does NOT skip when both are present", () => {
  const present = { config: {}, env: { [RUN_ROOT_ENV]: "/run-x" } };
  assert.equal(liveSkipReason(present), undefined, "positive control: the LIVE test runs when the config is wired and the run root is published");
  assert.match(liveSkipReason({ ...present, config: undefined }) ?? "", /scripts\/rstest\/rstest\.config\.ts is not laid out/);
  assert.match(liveSkipReason({ ...present, env: {} }) ?? "", new RegExp(`${RUN_ROOT_ENV} is unset`));
  assert.match(liveSkipReason({ ...present, env: { [RUN_ROOT_ENV]: "" } }) ?? "", /is unset/, "an empty value is unset");
});

test(
  "LIVE: the real config wires both entries, and this very file is running in its own directory inside a run root",
  { skip: liveSkipReason({ config, env: process.env }) },
  () => {
    assert.deepEqual(config?.globalSetup, ["src/private-tmp.ts"]);
    assert.equal(config?.setupFiles?.[0], "src/private-tmp-setup.ts", "first, so a later setup file already has the private TMPDIR");
    assert.ok(existsSync(join(REPO, "src/private-tmp.ts")) && existsSync(join(REPO, "src/private-tmp-setup.ts")), "both entries exist");
    const runRoot = process.env[RUN_ROOT_ENV];
    assert.ok(runRoot, `${RUN_ROOT_ENV} is published to the worker, so the globalSetup ran`);
    assert.equal(requirePrivate(runRoot, privateBase()), runRoot);
    assert.equal(tmpdir(), join(runRoot, fileDirName(fileURLToPath(import.meta.url), process.cwd())), "TMPDIR is this file's own directory");
  },
);
