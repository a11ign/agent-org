// library + rstest globalSetup: every test run gets a PRIVATE `TMPDIR`, one directory per test file, removed when the run ends
//
// THE INCIDENT (a11ign/a11ign#3846, chairman's 16:55Z correction): `/tmp` held ~121,425 top-level entries under 706 name prefixes, every one a test
// temp dir that nothing removed (`pr-review-verdict-*` 17,422; `host-units-2184-*` 16,688; ...). The kernel lockup was `rmdir` -> `shrink_dcache_parent`
// -> `d_walk`: one directory with ~121k children while dozens of test processes created and deleted in it at once. #3848 fixes the files that leak, one
// family at a time, which cures the INSTANCES KNOWN; it does not stop the next test from leaking into the shared directory. This does: whatever a test
// forgets lands in a directory only this run uses, and goes with it.
//
// THE SHAPE: `<base>/run-<stamp>-<pid>-<random>/<one directory per test file>`, with `<base>` = `~/.cache/a11ign/tmp`. THE `run-*` NAME AND THE BASE ARE AN
// INTERFACE: #3849's user tmpfiles rule ages `~/.cache/a11ign/tmp/run-*` out after a day, which is what clears the run of a process that was killed before its
// teardown could. Change either and that rule stops matching.
//
//   - `setup` (the globalSetup entry, main process) makes the run root, publishes it in `A11Y_PRIVATE_TMP_RUN` for the workers, and returns the teardown.
//   - `enterFileDir` (called by `private-tmp-setup.ts` in each test file's worker) makes that file's directory and points `TMPDIR` at it.
//   - the teardown reads each file's directory, REPORTS the files that left something in it, then removes the run root. A leak is reported on a PASSING run
//     too, because a test that passes and leaves a directory behind is exactly the one nobody is looking at.
//
// EVERY REMOVAL GOES THROUGH `requirePrivate`, WHICH REFUSES AN EMPTY OR UNSET PATH AND ANYTHING NOT UNDER `<base>/run-*`. It is the `rm -f "${D:?}"/*.md`
// rule written as code (`.claude/rules/guards-and-assertions.md`): with `TMPDIR` unset the cleanup would otherwise resolve to the shared `/tmp`, which is
// the directory this file exists to stay out of.
//
// REMOVAL IS ONE ENTRY PER CALL (`unlink`, then `rmdir` of an emptied directory), NEVER ONE RECURSIVE `rm` OF A TREE. The incident WAS a large `rmdir`; a run
// root holds a few thousand entries at most, but the habit is the point and the cost is nothing.

import { randomBytes } from "node:crypto";
import { mkdir, readdir, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** The env var the globalSetup publishes the run root in, and the workers read it from. */
export const RUN_ROOT_ENV = "A11Y_PRIVATE_TMP_RUN";
/** Where the runs live, overridable so a test can keep a fixture run out of the real base. */
export const BASE_ENV = "A11Y_PRIVATE_TMP_BASE";
/** A leak fails the run unless this is `report`, which names the leakers and passes. The row asked for red once #3848's fixes had landed (they have: 312 files, none left). */
export const LEAK_POLICY_ENV = "A11Y_PRIVATE_TMP_LEAKS";
const RUN_PREFIX = "run-";
const ENTRIES_NAMED_PER_FILE = 5;
// Caches the RUNTIME writes into `TMPDIR` for any process, which no test made and none can remove: `tsx-<uid>` (tsx's transform cache) and `v8-compile-cache-<uid>`
// (node's). Measured on the first full run after #3848: they were the ONLY entries left in 5 files, and a report that always names the same entries is a report
// people learn to ignore, which would also make a leak red on every run, whatever it was. Exact names only: `tsx-1000-x` is still a leak.
const RUNTIME_CACHE = /^(?:tsx|v8-compile-cache)-\d+$/;

/** A test file that left something behind: its path from the project root, and the names of what is in its directory. */
export type Leak = { file: string; entries: string[] };

export function privateBase(env: NodeJS.ProcessEnv = process.env): string {
  return env[BASE_ENV] || join(homedir(), ".cache", "a11ign", "tmp");
}

/**
 * Throws unless `path` is a non-empty absolute path that is, or is inside, a `<base>/run-*` directory. The one gate every removal passes: `<base>` itself,
 * a sibling of it, `..` out of it and `/tmp` all fail, because their first segment under the base is not `run-*`.
 */
export function requirePrivate(path: string | undefined, base: string): string {
  if (!path) throw new Error("private-tmp: refusing an empty or unset path; the cleanup would resolve to the shared temp directory");
  if (!isAbsolute(path)) throw new Error(`private-tmp: refusing the relative path ${JSON.stringify(path)}`);
  const resolved = resolve(path);
  const [run = ""] = relative(resolve(base), resolved).split(sep);
  if (!run.startsWith(RUN_PREFIX)) throw new Error(`private-tmp: refusing ${resolved}: not a run root or inside one under ${join(resolve(base), `${RUN_PREFIX}*`)}`);
  return resolved;
}

/**
 */
export async function createRunRoot({ base = privateBase(), now = new Date(), pid = process.pid }: { base?: string; now?: Date; pid?: number } = {}): Promise<string> {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const root = join(resolve(base), `${RUN_PREFIX}${stamp}-${pid}-${randomBytes(3).toString("hex")}`);
  await mkdir(root, { recursive: true });
  return root;
}

/**
 * A test file's directory name: its path from the project root as ONE path segment, readable back into the path. `/` is `@-` and a literal `@` is `@@`, so the
 * name stays inside `[A-Za-z0-9_.@-]`. NOT `encodeURIComponent`: its `%` broke 14 test files that build `file:` URLs and unit lines from `TMPDIR`
 * (`File URL path must not include encoded / characters`; `host-config`'s `UNIT_SAFE_PATH` refuses `%` as a systemd specifier), measured on the first full run.
 */
export function fileDirName(testPath: string, projectRoot: string): string {
  return relative(projectRoot, testPath).replace(/@/g, "@@").replace(/\//g, "@-");
}

export function testFileOf(dirName: string): string {
  return dirName.replace(/@([@-])/g, (_, mark) => (mark === "@" ? "@" : "/"));
}

/**
 * Makes this test file's own directory under the run root and points `TMPDIR` at it, so `os.tmpdir()` and every child process the test spawns land there.
 */
export async function enterFileDir({ runRoot, testPath, projectRoot, env = process.env, base = privateBase(env) }: {
  runRoot: string | undefined;
  testPath: string;
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  base?: string;
}): Promise<string> {
  const dir = join(requirePrivate(runRoot, base), fileDirName(testPath, projectRoot));
  await mkdir(dir, { recursive: true });
  env.TMPDIR = dir;
  return dir;
}

/**
 * Each test file whose directory still holds something, with what it holds. Absence of a directory is not a leak: a file whose worker never started has none. The runtime's own caches (`RUNTIME_CACHE`) are not a test's.
 */
export async function findLeaks(runRoot: string, base: string = privateBase()): Promise<Leak[]> {
  const root = requirePrivate(runRoot, base);
  const dirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const left = async (name: string) => (await readdir(join(root, name))).filter((entry) => !RUNTIME_CACHE.test(entry)).toSorted();
  const read = await Promise.all(dirs.map(async ({ name }) => ({ file: testFileOf(name), entries: await left(name) })));
  return read.filter(({ entries }) => entries.length > 0).toSorted((a, b) => a.file.localeCompare(b.file));
}

/**
 * The report's lines: one per leaking file naming the file and what it left, then a total. Empty when nothing leaked, so a clean run adds nothing to the output.
 */
export function leakReport(leaks: Leak[]): string[] {
  if (leaks.length === 0) return [];
  const lines = leaks.map(({ file, entries }) => {
    const shown = entries.slice(0, ENTRIES_NAMED_PER_FILE).join(", ");
    const more = entries.length > ENTRIES_NAMED_PER_FILE ? `, ... and ${entries.length - ENTRIES_NAMED_PER_FILE} more` : "";
    return `  ${file} left ${entries.length} in its TMPDIR: ${shown}${more}`;
  });
  return [`private-tmp: ${leaks.length} test file(s) left something in their private TMPDIR (removed with the run):`, ...lines];
}

/**
 * Removes a run root one entry at a time. Refuses anything `requirePrivate` refuses.
 */
export async function removeRunRoot(runRoot: string, base: string = privateBase()): Promise<void> {
  await removeTree(requirePrivate(runRoot, base));
}

async function removeTree(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await removeTree(path);
    else await unlink(path);
  }
  await rmdir(dir);
}

function failsOnLeak(env: NodeJS.ProcessEnv): boolean {
  return env[LEAK_POLICY_ENV] !== "report";
}

/**
 * The teardown: report, then remove. The removal is in a `finally` so a refused policy or a failed read still leaves no run root behind.
 */
export async function finishRun({ runRoot, base = privateBase(), env = process.env, write = (line) => console.error(line) }: {
  runRoot: string;
  base?: string;
  env?: NodeJS.ProcessEnv;
  write?: (line: string) => void;
}): Promise<void> {
  let leaks: Leak[] = [];
  try {
    leaks = await findLeaks(runRoot, base);
    for (const line of leakReport(leaks)) write(line);
  } finally {
    await removeRunRoot(runRoot, base);
  }
  if (leaks.length > 0 && failsOnLeak(env)) throw new Error(`private-tmp: ${leaks.length} test file(s) left something in their private TMPDIR`);
}

/**
 * rstest's globalSetup entry. Runs before the first test file and returns the teardown, which rstest also calls when a test failed.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const base = privateBase();
  const runRoot = await createRunRoot({ base });
  process.env[RUN_ROOT_ENV] = runRoot;
  return async () => {
    delete process.env[RUN_ROOT_ENV];
    await finishRun({ runRoot, base });
  };
}
