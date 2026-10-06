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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import config from "../scripts/rstest/rstest.config.mjs";
import {
  BASE_ENV,
  LEAK_POLICY_ENV,
  RUN_ROOT_ENV,
  createRunRoot,
  enterFileDir,
  fileDirName,
  findLeaks,
  leakReport,
  privateBase,
  removeRunRoot,
  requirePrivate,
  testFileOf,
} from "./private-tmp.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SETUP = fileURLToPath(new URL("./private-tmp.ts", import.meta.url));
const FILE_SETUP = fileURLToPath(new URL("./private-tmp-setup.ts", import.meta.url));
const RSTEST = join(REPO, "node_modules", ".bin", "rstest");

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
  for (const name of ["tsx-1000", "v8-compile-cache-1000"]) mkdirSync(join(cacheOnlyDir, name));
  mkdirSync(join(leakerDir, "tsx-1000-mine"));
  const leaks = await findLeaks(runRoot, base);
  assert.deepEqual(leaks.map(({ file }) => file), ["src/leaker.test.ts"], "the runtime's own caches are not a leak, and a look-alike name still is");
  assert.deepEqual(leaks[0]?.entries, ["a", "b", "c", "d", "e", "f", "g", "tsx-1000-mine"]);
  const [headline, line] = leakReport(leaks);
  assert.match(headline ?? "", /1 test file\(s\) left something/);
  assert.match(line ?? "", /src\/leaker\.test\.ts left 8 in its TMPDIR: a, b, c, d, e, \.\.\. and 3 more/);
  assert.deepEqual(leakReport([]), []);
  await removeRunRoot(runRoot, base);
  assert.equal(existsSync(runRoot), false, "a run root with a nested tree is gone");
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
    join(dir, "rstest.config.mjs"),
    `export default { root: ${JSON.stringify(dir)}, include: ["*.fixture.test.js"], globals: true, pool: { type: "forks" },
       globalSetup: [${JSON.stringify(SETUP)}], setupFiles: [${JSON.stringify(FILE_SETUP)}] };`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, [BASE_ENV]: base, RSTEST_NO_AGENT: "1" };
  delete env[RUN_ROOT_ENV];
  const result = spawnSync(RSTEST, ["run", "--config", join(dir, "rstest.config.mjs")], { cwd: dir, env, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, base, runs: readdirSync(base) };
}

test("POSITIVE CONTROL: a file that leaves a directory is named with the entry, and under `report` the run still passes and leaves no run root", () => {
  const run = runFixture("leaker", { "leaky.fixture.test.js": LEAKER, "tidy.fixture.test.js": TIDY }, REPORT_ONLY);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /leaky\.fixture\.test\.js left 1 in its TMPDIR: left-behind-dir/);
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

test("LIVE: the real config wires both entries, and this very file is running in its own directory inside a run root", () => {
  assert.deepEqual(config.globalSetup, ["src/private-tmp.ts"]);
  assert.deepEqual(config.setupFiles, ["src/private-tmp-setup.ts"]);
  assert.ok(existsSync(join(REPO, config.globalSetup[0])) && existsSync(join(REPO, config.setupFiles[0])), "both entries exist");
  const runRoot = process.env[RUN_ROOT_ENV];
  assert.ok(runRoot, `${RUN_ROOT_ENV} is published to the worker, so the globalSetup ran`);
  assert.equal(requirePrivate(runRoot, privateBase()), runRoot);
  assert.equal(tmpdir(), join(runRoot, fileDirName(fileURLToPath(import.meta.url), process.cwd())), "TMPDIR is this file's own directory");
});
